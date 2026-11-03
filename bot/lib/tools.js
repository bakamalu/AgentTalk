'use strict';

// ===== 能力工具注册表 =====
// 把“模型可以调用的外部能力”集中在这一层：新增一个能力只改这里加一行，
// plugins/deepseek.js 里的 tool_calls 往返循环完全不用动。
//
// ⚠ system prompt 里的“能力边界”必须由 describeCapabilities() 生成，和 schemas() 用同一个开关：
//   写“能搜”但实际关了 → 模型直接编造搜索结果；写“不能搜”但实际开了 → 它明明能搜却拒答。两者都是真实故障。

const weather = require('./weather');
const websearch = require('./websearch');
const timersLib = require('./timers');
const membersLib = require('./members');
const imagegenLib = require('./imagegen');

// 生图是否真正可用：必须开启且配齐 base/model/key（缺任一都不下发工具，能力边界也要同步说“不能画”）。
const imagegenActive = (hot) => Boolean(hot.imagegenEnabled && hot.imagegenBase && hot.imagegenKey && hot.imagegenModel);

// opts: { logger, hot, timers }（timers 为 lib/timers.js create 出的实例；未传则不下发提醒工具）
const create = ({ logger, hot, timers }) => {
  // 成员解析器（平台无关）：把昵称/群名片查成各平台的 opaque userId，供 set_reminder 的 at_user_names 用
  const members = membersLib.create({ logger });
  const imagegen = imagegenLib.create({ logger });
  // 生图每日限额计数（按 UTC 日切；全局 + 单会话各一条线）：用户选“只限额不加敏感词闸”。
  const imgCap = { day: '', global: 0, chat: new Map() };
  const bumpImagegenCap = (chatKey) => {
    const day = new Date().toISOString().slice(0, 10);
    if (imgCap.day !== day) { imgCap.day = day; imgCap.global = 0; imgCap.chat.clear(); }
    const ck = String(chatKey || '_');
    const rec = imgCap.chat.get(ck) || { n: 0 };
    if (hot.imagegenMaxPerDay > 0 && imgCap.global >= hot.imagegenMaxPerDay) return { ok: false, scope: `全局每日 ${hot.imagegenMaxPerDay} 张` };
    if (hot.imagegenMaxPerChat > 0 && rec.n >= hot.imagegenMaxPerChat) return { ok: false, scope: `本会话每日 ${hot.imagegenMaxPerChat} 张` };
    rec.n += 1; imgCap.global += 1; imgCap.chat.set(ck, rec);
    return { ok: true, global: imgCap.global, chat: rec.n };
  };
  return ({
  // 本轮可下发的工具：搜索总开关关掉时搜索/天气不给；提醒能单独开关（不依赖联网）。
  // excludeNames：本轮要排除的工具名（到点延迟代理轮需排除 set_reminder 等，防递归建新表）。
  schemas(excludeNames) {
    const list = [];
    if (hot.searchEnabled) {
      if (hot.weatherEnabled) list.push(weather.TOOL);
      list.push(websearch.TOOL);
    }
    // 提醒工具不依赖联网，所以不受 searchEnabled 约束；但要 timers 实例已装配
    if (hot.reminderEnabled && timers) list.push(...timersLib.REMINDER_TOOLS);
    // 生图独立于联网搜索：配齐即下发（见 imagegenActive）
    if (imagegenActive(hot)) list.push(imagegenLib.TOOL);
    if (!excludeNames || !excludeNames.length) return list;
    const ex = new Set(excludeNames);
    return list.filter((t) => !ex.has(t.function.name));
  },

  // 执行一次 tool_call。任何失败都回“文字说明”而不是抛异常——
  // 抛异常会让整轮回复崩掉（用户侧表现是机器人完全不说话），比查不到更糟。
  // execCtx: { chatKey, userId }——提醒需要知道“哪个会话、谁在设”，才能到点投回同一会话并 @ 人
  async exec(name, argsJson, execCtx = {}) {
    let args = {};
    try {
      args = JSON.parse(argsJson || '{}');
    } catch (error) {
      // 模型偶尔吐半截 JSON，按空参数处理即可，不值得为它丢掉整轮
      logger.warn(`[工具] ${name} 参数解析失败: ${String(error.message || error).slice(0, 80)}`);
    }

    if (name === 'get_weather') {
      if (!hot.weatherEnabled) return { text: '天气查询能力当前已关闭，请如实告知用户暂时查不到。', queries: ['weather:off'], hits: 0 };
      const result = await weather.lookup({
        city: args.city,
        days: args.days,
        defaultCity: hot.weatherDefaultCity,
        timeoutMs: hot.weatherTimeoutMs,
        logger,
      });
      logger.info(`[天气] 请求 city=${args.city || hot.weatherDefaultCity || '(无)'} days=${args.days || 1} ok=${result.ok} 源=${result.source || '-'}`);
      return { text: result.text, queries: [`天气:${args.city || hot.weatherDefaultCity || '-'}`], hits: result.ok ? 1 : 0 };
    }

    if (name === 'web_search') {
      const result = await websearch.search(args.query, {
        logger,
        maxResults: hot.searchMaxResults,
        timeoutMs: hot.searchTimeoutMs,
      });
      return { text: result.text, queries: result.queries, hits: result.hits };
    }

    // ---------- 定时提醒（需 timers 实例 + 会话上下文） ----------
    if (name === 'set_reminder' || name === 'list_reminders' || name === 'cancel_reminder') {
      if (!hot.reminderEnabled || !timers) {
        return { text: '定时提醒能力当前已关闭，请如实告知用户设不了提醒，不要编造“到点叫你”。', queries: [`${name}:off`], hits: 0 };
      }
      if (!execCtx.chatKey) {
        return { text: '没拿到会话标识，无法定位要提醒哪个会话；请让用户在当前对话里直接重新表达一次。', queries: [`${name}:nochat`], hits: 0 };
      }
      if (name === 'set_reminder') {
        // at_user_ids 是用户直接给的 opaque ID；at_user_names 是昵称/群名片，去成员表查成 ID 再合并。
        // 两个都是平台无关的字符串，timers.normalizeAt 会再统一做结构校验。
        const atIds = Array.isArray(args.at_user_ids) ? args.at_user_ids.slice()
          : (args.at_user_ids ? [args.at_user_ids] : []);
        const names = (Array.isArray(args.at_user_names) ? args.at_user_names : (args.at_user_names ? [args.at_user_names] : []))
          .map((n) => String(n ?? '').trim()).filter(Boolean);
        let resolveNote = '';
        if (names.length) {
          const target = timers.lookupTarget(execCtx.chatKey);
          const isGroup = target && (target.guildId || target.channelId);
          if (!isGroup) {
            resolveNote = '（@ 昵称只在群聊生效，本会话非群，已忽略昵称）';
          } else {
            const rr = await members.resolveNames(target, names);
            atIds.push(...rr.ids);
            if (rr.unavailable) resolveNote = '（当前拿不到成员表，只能按用户 ID @；若必须 @ 此人请向用户要 ID）';
            else {
              if (rr.missed.length) resolveNote += `（群里没找到「${rr.missed.join('、')}」，请向用户要准确的用户 ID 再补）`;
              if (rr.ambiguous.length) resolveNote += `（「${rr.ambiguous.join('、')}」在群里有多人同名，不能确定是谁，需用户给准确 ID）`;
            }
          }
        }
        const r = timers.create(execCtx.chatKey, {
          delaySeconds: args.delay_seconds,
          atTime: args.at_time,
          note: args.note,
          userId: execCtx.userId,
          atUserIds: atIds,
        });
        return { text: r.text + resolveNote, queries: [`提醒:${r.ok ? '已设' : '失败'}`], hits: r.ok ? 1 : 0 };
      }
      if (name === 'list_reminders') {
        const r = timers.list(execCtx.chatKey);
        return { text: r.text, queries: ['提醒:列表'], hits: r.items ? r.items.length : 0 };
      }
      const r = timers.cancel(args.id, execCtx.chatKey);
      return { text: r.text, queries: [`提醒:${r.ok ? '已取消' : '未找到'}`], hits: r.ok ? 1 : 0 };
    }

    // ---------- 生图（OpenAI 兼容端点；产物直接发图，需 execCtx.sendImage）----------
    if (name === 'generate_image') {
      if (!imagegenActive(hot)) {
        return { text: '生图能力当前未开启或未配置。请如实告知用户暂时画不了，绝对不要假装已经发过图或谎称“点了发送键”。', queries: ['生图:off'], hits: 0 };
      }
      if (typeof execCtx.sendImage !== 'function') {
        return { text: '当前会话拿不到发送通道，图片发不出去。请如实告知用户这次没画成，让用户在当前对话里再要一次。', queries: ['生图:nosend'], hits: 0 };
      }
      const cap = bumpImagegenCap(execCtx.chatKey);
      if (!cap.ok) {
        return { text: `今天生图次数已达上限（${cap.scope}）。请如实告诉用户今天画满了、明天再来，不要编造。`, queries: ['生图:限额'], hits: 0 };
      }
      const r = await imagegen.generate({ hot, prompt: args.prompt, size: args.size });
      if (!r.ok) {
        return { text: `生图失败：${r.reason}。请如实告知用户没画成功、可稍后再试，绝对不要假装发过图。`, queries: ['生图:失败'], hits: 0 };
      }
      const sent = await execCtx.sendImage(r.file, '');
      if (!sent) {
        return { text: '图片已生成但发送失败（通道被拒）。请告知用户没收到、请稍后再试一次，不要谎称已发送。', queries: ['生图:发送失败'], hits: 0 };
      }
      // 发送成功才计费（按张）；单价由 deepseek 注入的 execCtx.billImage 按当时 hot 决定
      if (typeof execCtx.billImage === 'function') { try { execCtx.billImage(r.count || 1); } catch (_) { /* 记账异常不影响回复 */ } }
      logger.info(`[生图] 已发送 chatKey=${execCtx.chatKey || '-'} via=${r.via || '-'} 张数=${r.count || 1} 今日全局=${cap.global} 本会话=${cap.chat}`);
      return { text: '图片已经生成并发送给用户了。现在只需补一句 ≤20 字的自然配文（可以直接为空）。⚠ 绝不要说“我按了发送键/我点了发送/图发过去了”这类操作 QQ 界面的话，也不要再复述图片内容。', queries: ['生图:已发'], hits: 1 };
    }

    return { text: `未知工具「${name}」，请直接文字回答，不要编造工具结果。`, queries: [name], hits: 0 };
  },
  });
};

// 注入 system prompt 的能力说明（必须与 schemas() 实际下发的工具一致）
const describeCapabilities = (hot) => {
  const parts = [];
  if (!hot.searchEnabled) {
    parts.push('你没有联网搜索能力，训练数据有截止日期；涉及实时信息（新闻、天气、股价、比赛结果、最新进展等）时请如实说明不知道，绝对不要编造。');
  } else {
    const weatherPart = hot.weatherEnabled
      ? '查天气/气温/降雨/穿什么必须用 get_weather（它直接读气象数据，比搜索准得多），不要用 web_search 搜天气；'
        + '不知道城市就先问用户在哪个城市。'
      : '';
    parts.push('你可以调用工具联网获取实时信息：web_search 搜新闻/价格/赛事/政策等时效内容。'
      + '涉及任何时效性信息时必须先调用工具再回答，'
      + '搜不到就如实说不知道，绝对不要编造；回答时若用了搜索结果，请顺带说明信息大致日期。'
      + '⚠ 给 web_search 的查询词要短（2~4 个核心词，如「苏州 雾霾 预警」），'
      + '写完整句子或加年份/日期/「实时」「最新」会让搜索引擎退化成无关页面。'
      + weatherPart);
  }
  // 提醒能力边界必须与 schemas() 一致：开了就要教会模型“必须真建表”，否则它会口头答应却不创建
  if (hot.reminderEnabled) {
    const execPart = hot.reminderExec
      ? '到点会**重新调用工具真的去执行**这条任务（如查天气/搜索/@ 人）再把结果发到会话——所以 note 要写成可执行的指令（如「查苏州今天天气并播报」「@ 张三 交周报」），而不是含糊的“提醒我一下”。'
      : '到点只会投递一条固定提醒文案，不会替你查资料；note 请写成给用户的提醒短句。';
    parts.push('你有定时提醒能力（set_reminder / list_reminders / cancel_reminder）。用户说“X分钟后/几点 提醒我做某事”时必须调用 set_reminder 真的建表，绝对不能只口头说“到点叫你”而不建（不建就根本叫不了人）。'
      + '只能提醒当前这个会话；群里到点默认 @ 设提醒的人。要 @ 别人：知道用户 ID 就填 at_user_ids，只知道昵称/群名片就填 at_user_names（系统会去成员表查 ID，查不到或多人同名会回告你，再去向用户要准确 ID）。'
      + execPart
      + '设好后把时间、内容和 @ 对象复述给用户确认。');
  } else {
    parts.push('你没有定时提醒能力，用户要你过一会儿叫他时必须如实说叫不了（建议他自己设闹钟），绝对不要假装会到点叫他。');
  }
  // 生图能力边界必须与 schemas 实际下发一致（imagegenActive）：能画就教会它必须真调用工具，
  //   不能画就禁止它谎称“点了发送键/先手绘一个”（那类幻觉正是 11-03 的真实故障）。
  if (imagegenActive(hot)) {
    parts.push('你能生成图片：用户想要图（画个XX/来张图/生成一张…插画/头像/表情包配图等）时，必须调用 generate_image 真的把图画出来发送，绝不能只口头说“画好了”而不调用工具。'
      + '调用时把画面描述写具体（主体+风格+氛围）；一次画一张，生成后系统会自动把图发给用户，你只补一句简短配文即可，'
      + '不要说“我按了发送键/我点了发送”之类操作 QQ 界面的话。工具若返回失败或已达上限，就如实说这次画不了，不要假装发过图。');
  } else {
    parts.push('你没有生成图片的能力。用户要你画图/发图/给表情包图时，必须如实说只能用文字、画不了图；'
      + '绝对不要谎称“按不了发送键所以先给你手绘的”“图已发过去”之类——你既不能操作 QQ 界面，也没有生图能力。');
  }
  return parts.join('\n');
};

module.exports = { create, describeCapabilities, imagegenActive, weather, websearch, timers: timersLib, imagegen: imagegenLib };
