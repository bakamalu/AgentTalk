'use strict';

// ===== 引用（回复某条消息）兜底 =====
// 从 plugins/deepseek.js 拆出。背景：OneBot adapter 只在 reply 是消息首元素时才拉原文，
// 且 getMessage 失败会静默丢掉 quote 节点，导致「引用+@机器人」时模型看不到被引用的话。
// 这里三层兜底：adapter 自带 → 网关动作助手（lib/onebot.js：internal._get → internal.request → 临时直连 WS）。

const { normalizeText } = require('./text');
const onebotLib = require('./onebot');

// 从残留的 [CQ:reply,id=xxx] 或未被 adapter 挪走的 reply 节点里取被引用消息 id
const findRawReplyId = (session) => {
  const m = String(session.original || session.content || '').match(/\[CQ:(reply|source)[^\]]*id=(-?\d+)/i);
  if (m) return m[2];
  for (const el of session.elements || []) {
    if (el?.type === 'reply' || el?.type === 'source') {
      const id = el.attrs?.id;
      if (id != null && String(id) !== '-1') return String(id);
    }
  }
  return '';
};

// get_msg 的返回体（array 或 string 两种格式）统一成 { text, userId, username }
const parseMsgPayload = (data) => {
  if (!data) return null;
  const text = data.raw_message
    || (Array.isArray(data.message)
      ? data.message.map((e) => (e && e.type === 'text' ? ((e.data && e.data.text) || '') : `[CQ:${e && e.type}]`)).join('')
      : String(data.message || ''));
  const sender = data.sender || {};
  const uid = sender.user_id != null ? sender.user_id : data.user_id;
  return {
    text: normalizeText(text),
    userId: String(uid != null ? uid : ''),
    username: String(sender.card || sender.nickname || (uid != null ? 'QQ' + uid : '')).trim(),
  };
};

// 从原始消息串里挖「引用了哪些消息 id」与「@ 了哪些人」（fallback 判讨论双方用）
const replyAtIdsOf = (raw) => {
  const s = String(raw || '');
  const replies = [];
  const rre = /\[CQ:reply[^\]]*id=(-?\d+)/gi;
  let m; while ((m = rre.exec(s)) !== null) replies.push(m[1]);
  const ats = [];
  const are = /\[CQ:at[^\]]*qq=(\d+)/gi;
  while ((m = are.exec(s)) !== null) ats.push(m[1]);
  return { replies, ats };
};

// 链式窗口（纯函数，可单测）：从锚点出发沿引用发送人的发言双向外扩——相邻发言间隔 ≤ chainMs 就延续，
//   任一侧距锚点超过 maxMs 则截断（用户规格：发一条就延续 10 分钟，整段最长 30 分钟）。
//   得到“链式相连的 seed 发言”首尾后，再各向外垫一个 chainMs（封顶 ±maxMs）：因为别人回应 seed
//   总是发生在 seed 发言之后/之前一小段，若只取 seed 自己的时刻会退化成零宽窗口而抹掉全部对话。
//   返回 { from, to }（unix 秒，含边界）。
const windowChat = (seedTimes, anchor, chainMs, maxMs) => {
  const chain = Math.floor(chainMs / 1000);
  const cap = Math.floor(maxMs / 1000);
  const list = [...new Set(seedTimes.map(Number))].filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
  // 只沿与锚点间隔不断链的 seed 发言双向推进（list 已升序，命中一条后前沿就是它）
  let lo = anchor; let hi = anchor;
  for (const t of list) { if (t > hi && t - hi <= chain && t <= anchor + cap) hi = t; }
  for (let i = list.length - 1; i >= 0; i--) { const t = list[i]; if (t < lo && lo - t <= chain && t >= anchor - cap) lo = t; }
  return { from: Math.max(lo - chain, anchor - cap), to: Math.min(hi + chain, anchor + cap) };
};

// 组装背景块（纯函数，可单测）：时段内 seed+命中参与人的发言按时间排序；超字数时优先保留靠近锚点的，
//   但输出仍按时间升序；锚点那条（被引用消息）始终保留并标注 [被引用]。
const assembleLines = (msgs, seedId, pickedIds, win, anchor, maxChars, fmtTime) => {
  const keep = new Set([String(seedId), ...pickedIds.map(String)]);
  const lines = msgs
    .filter((m) => keep.has(String(m.userId)) && m.time >= win.from && m.time <= win.to && m.text)
    .map((m) => ({
      time: m.time,
      text: String(m.text).replace(/\s+/g, ' ').trim().slice(0, 120),
      name: m.username || ('QQ' + m.userId),
      anchor: String(m.userId) === String(seedId) && m.messageId != null && String(m.messageId) === String(anchor.messageId),
    }))
    .filter((l) => l.text)
    .sort((a, b) => a.time - b.time);
  const render = (l) => `- [${fmtTime(l.time * 1000)} ${l.name}] ${l.text}${l.anchor ? ' [被引用]' : ''}`;
  let budget = lines.slice();
  if (budget.reduce((n, l) => n + render(l).length + 1, 0) > maxChars) {
    // 按距锚点时间从近到远逐条装预算；装不下的丢弃，最后恢复时间升序输出（靠近锚点的优先保留）
    const order = budget.map((l, i) => i).sort((x, y) => Math.abs(budget[x].time - anchor.time) - Math.abs(budget[y].time - anchor.time));
    const isAnchor = (i) => budget[i].anchor;
    const keepIdx = new Set();
    let used = 0;
    for (const i of order) {
      const cost = render(budget[i]).length + 1;
      if (used + cost > maxChars && !(isAnchor(i) && !keepIdx.size)) continue; // 锚点那条在预算全满给不起时也强保，它是主角
      keepIdx.add(i); used += cost;
    }
    if (!keepIdx.size && order.length) keepIdx.add(order[0]); // 单条就超限：至少保住最近锚点那条
    budget = budget.filter((l, i) => keepIdx.has(i));
  }
  const block = budget.map(render).join('\n');
  return { block, count: budget.length };
};

// api 是网关动作助手（lib/onebot.js create 的返回值）；没注入时这里自建一份，
//   这样单测和老调用点都还能跑。11-03 之前这里直接写 internal.request(...)，而 adapter 没这方法，
//   引用检索与历史拉取全线静默失效，所以“动作名 + 具名参数”的调用统一收进助手。
const create = ({ logger, api = null, wsEndpoint = 'ws://127.0.0.1:3001', wsToken = '', chatSelect = null }) => {
  const gateway = api && typeof api.callApi === 'function' ? api : onebotLib.create({ logger, wsEndpoint, wsToken });
  // adapter 的 quote 结构需要 content/messageId/userId/username，不能只回 text
  const toQuote = (data, parsed, fallbackId) => ({
    messageId: String(data?.message_id != null ? data.message_id : fallbackId),
    content: parsed.text,
    userId: parsed.userId,
    username: parsed.username,
  });

  const fetchQuoteByMsgId = async (session, quoteId) => {
    // 预算由助手读 BOT_GW_TIMEOUT_MS；撞在离线冷却窗内时助手会自动走快失败，不拖慢回复
    const res = await gateway.callApi(session, 'get_msg', { message_id: Number(quoteId) || quoteId }, {}); // 预算交给助手读 BOT_GW_TIMEOUT_MS，别在这儿各写一个数
    if (!res.ok) {
      logger.warn(`[引用] get_msg(${quoteId}) 兜底拉取失败: ` + String(res.error || '无返回').slice(0, 160));
      return null;
    }
    const parsed = parseMsgPayload(res.data);
    if (!parsed) { logger.warn(`[引用] get_msg(${quoteId}) 走 ${res.via} 有返回但没解析出正文`); return null; }
    // 引用内容是敏感信息载体，日志只记前 40 字
    logger.info(`[引用] 兜底拉取 id=${quoteId}（走 ${res.via}）内容=${parsed.text.slice(0, 40)}`);
    return parsed;
  };

  // 一次性给 bot 类的 getMessage 打补丁（原型链上打一次即可，靠构造器标记防重复）
  const maybePatchGetMessage = (session) => {
    const botObj = session.bot;
    if (!botObj || !botObj.constructor || botObj.constructor.__quotePatched) return;
    botObj.constructor.__quotePatched = true;
    const proto = Object.getPrototypeOf(botObj);
    const orig = proto.getMessage;
    if (typeof orig !== 'function') {
      logger.warn('[引用诊断] bot.getMessage 不存在，typeof=' + typeof orig);
      return;
    }
    proto.getMessage = function patched(channel, messageId) {
      return (async () => {
        let r = null;
        try {
          r = await orig.call(this, channel, messageId);
        } catch (e) {
          logger.warn('[引用诊断] getMessage(' + channel + ',' + messageId + ') 抛错: ' + String(e && e.message || e).slice(0, 120));
        }
        if (r) {
          logger.info(`[引用诊断] getMessage(${channel},${messageId}) => ok content=${String(r.content).slice(0, 40)}`);
          return r;
        }
        // 兜底：走网关动作助手（internal._get → internal.request → 临时直连 WS），失败原因带在 error 里
        const res = await gateway.callApi({ bot: this }, 'get_msg', { message_id: Number(messageId) || messageId }, {}); // 预算交给助手读 BOT_GW_TIMEOUT_MS，别在这儿各写一个数
        const q = parseMsgPayload(res.data);
        if (q) { logger.info(`[引用] getMessage 兜底成功(走 ${res.via}) id=${messageId} 内容=${q.text.slice(0, 40)}`); return toQuote(res.data, q, messageId); }
        logger.warn(`[引用] getMessage 兜底失败 id=${messageId}：` + String(res.error || '拉到了但没解析出正文').slice(0, 160));
        return r;
      })();
    };
    logger.info('[引用诊断] 已挂钩 getMessage');
  };

  // ---------- 引用周边对话检索（仅群聊）：被引用消息为锚点拉回话题小段落作背景 ----------
  //   chatSelect(prompt) 由插件注入（走接口队列的小请求），返回模型答复文本；失败/缺席时 fallback 用确定性信号。
  //   返回 { block, count, historyBlock, from, to, picked } 或 null；historyBlock 是给会话历史留的
  //   压缩存档（见 opts.historyMaxChars），本轮输入仍用全量 block，两者不叠加喂。
  //   任何环节失败都不阻断本轮主回复，但必须留一行原因日志——
  //   11-03 该特性上线后一直“看不出效果”，就是因为失败路径全部静默 return null，日志里只剩启动行，
  //   分不清“这轮压根没有引用”还是“检索跑了但没料”。
  const retrieveAroundQuote = async (session, quoteMsgId, opts = {}) => {
    const { seedId, chainMs, maxMs, maxChars, historyMaxChars, fetchCount, fmtTime, timeoutMs } = opts;
    const gid = String((session.guildId && (session.event?.group_id ?? session.guildId)) || session.guildId || '');
    if (!gid || !quoteMsgId || (seedId == null || seedId === '')) {
      logger.info(`[引用检索] 跳过：${!gid ? '拿不到群号（非群聊？）' : !quoteMsgId ? '没拿到被引用消息 id' : '没拿到引用发送人标识'}`);
      return null;
    }
    // 按网关文档的锚点分页取群历史（get_group_msg_history: group_id + message_id + count + reverse_order）：
    //   reverse_order=true 给「锚点及更旧」，=false 给「锚点及更新」，两次并发（同一条连接按 echo 复用），
    //   正好铺满滑动窗口两侧。旧口径只拉「最近 N 条」，锚点稍旧一点就整段落空
    //   （11-03 20:10 那轮 17:05 的发言被 20:10 引用，就是这个原因拿不到料）。
    const anchorNum = Number(quoteMsgId);
    // 不写死 TIMEOUT_MS：没显式给超时就交给助手读热配置默认值（BOT_GW_TIMEOUT_MS）
    const apiOpts = Number(timeoutMs) > 0 ? { timeoutMs: Number(timeoutMs) } : {};
    const pageOf = (reverseOrder) => gateway.callApi(session, 'get_group_msg_history',
      { group_id: Number(gid) || gid, message_id: anchorNum, count: fetchCount, reverse_order: reverseOrder }, apiOpts);
    let olderRes; let newerRes;
    try {
      [olderRes, newerRes] = await Promise.all([pageOf(true), pageOf(false)]);
    } catch (error) {
      logger.warn('[引用检索] get_group_msg_history 异常: ' + String(error && error.message || error).slice(0, 160));
      return null;
    }
    const listOf = (res) => (res && res.ok && res.data && Array.isArray(res.data.messages) ? res.data.messages : []);
    const merged = new Map(); // 锚点会同时出现在两次返回里，按 message_id 去重
    for (const m of [...listOf(olderRes), ...listOf(newerRes)]) {
      if (m && m.message_id != null && !merged.has(String(m.message_id))) merged.set(String(m.message_id), m);
    }
    const raws = [...merged.values()];
    if (!raws.length) {
      const failed = [olderRes, newerRes].filter((r) => r && !r.ok);
      const offline = failed.length > 0 && failed.every((r) => r.offline);
      const tries = failed.reduce((n, r) => Math.max(n, Number(r.attempts) || 1), 1);
      const why = failed.map((r) => r.error).join(' / ');
      // 分开说才看得出下一步查什么：「网关离线」= 等重连没等到（多半撞在网关断开的那几秒窗口，
      //   属正常抖动，不用改代码）；「网关未返回/业务失败」才是接口口径或参数的问题。
      logger.warn(`[引用检索] ${offline
        ? `网关离线（连不上，已在 6s 预算内重试 ${tries} 轮仍没碰上重连）`
        : '网关未返回历史消息'}：${why.slice(0, 260) || '（返回为空）'}`);
      return null;
    }
    // 覆盖时段 + 走的是哪一档，是排查“检索为什么没料”的唯一线索；单侧条数上限也一并记出，
    //   方便判断该不该调 BOT_QUOTE_CONTEXT_FETCH_COUNT（实测单侧 200 条要走 ~14s，会撞超时）
    const tsAll = raws.map((m) => Number(m && m.time)).filter(Number.isFinite);
    logger.info(`[引用检索] 历史 ${raws.length} 条（锚点前 ${listOf(olderRes).length}/锚点后 ${listOf(newerRes).length}，单侧上限 ${fetchCount}，走 ${olderRes.via || newerRes.via || '网关'}，耗时 ${Math.max(Number(olderRes.ms) || 0, Number(newerRes.ms) || 0)}ms${Math.max(Number(olderRes.attempts) || 1, Number(newerRes.attempts) || 1) > 1 ? `，重试 ${Math.max(Number(olderRes.attempts) || 1, Number(newerRes.attempts) || 1)} 轮` : ''}）`
      + `${tsAll.length && fmtTime ? `，覆盖 ${fmtTime(Math.min(...tsAll) * 1000)}~${fmtTime(Math.max(...tsAll) * 1000)}` : ''}`);
    const anchorRaw = raws.find((m) => m && Number(m.message_id) === anchorNum);
    if (!anchorRaw) { logger.info(`[引用检索] 锚点 ${quoteMsgId} 不在网关返回的 ${raws.length} 条历史内（消息过旧或引用 id 与网关不同源），跳过`); return null; }
    const anchorTime = Number(anchorRaw.time) || 0;
    if (!anchorTime) { logger.info('[引用检索] 锚点消息没有时间戳，跳过'); return null; }
    // 背景行文本：normalizeText 不抹 reply/at 段，这里手动清掉（否则 CQ 码噪声会直接喂模型）；
    //   图片等占位符保留在 text 里，由下面的“纯占位符”过滤排掉。原始 raw 另存供 fallback 挖 reply/at。
    const display = (s) => normalizeText(String(s || '')).replace(/\[CQ:(reply|at)[^\]]*\]/gi, ' ').replace(/\s+/g, ' ').trim();
    const anchor = {
      messageId: String(anchorRaw.message_id),
      userId: String(anchorRaw.sender && anchorRaw.sender.user_id != null ? anchorRaw.sender.user_id : anchorRaw.user_id || ''),
      username: String((anchorRaw.sender && (anchorRaw.sender.card || anchorRaw.sender.nickname)) || ''),
      time: anchorTime,
      text: display(anchorRaw.raw_message),
    };
    const msgs = raws
      .filter((m) => m && Number.isFinite(Number(m.time)))
      .map((m) => ({
        messageId: String(m.message_id),
        userId: String(m.sender && m.sender.user_id != null ? m.sender.user_id : m.user_id || ''),
        username: String((m.sender && (m.sender.card || m.sender.nickname)) || ''),
        time: Number(m.time),
        text: display(m.raw_message),
        raw: String(m.raw_message || ''),
      }))
      .filter((m) => m.userId && m.text && !/^(\[[^\]]*\]\s*)+$/.test(m.text));
    // 锁定“话题主角（seed）”：以历史里锚点消息的 sender 为权威（插件传的 seedId 常只有昵称、对不上 id），
    //   锚点 sender 拉不到时才用传入值兜底。
    const seed = String(anchor.userId || seedId || '');
    // ① 滑动窗口（口径 [y0-gap, y+gap]）：先沿引用发送人自己的发言双向推进，他一超过 gap 没再说话就在那儿截断
    //   得到 [y0, y]，再首尾各垫一个 gap（别人接话总晚一拍），最后用 maxMs 封顶单侧（总跨度 ≤ 2×maxMs）。
    const seedTimes = msgs.filter((m) => String(m.userId) === seed).map((m) => m.time);
    const win = windowChat(seedTimes, anchorTime, chainMs, maxMs);
    // ② 候选参与人：时段内除 seed/机器人外的发送人（按发言次数降序，至多 10 人交给 AI）
    const bots = new Set([seed, String((session.bot && session.bot.selfId) || session.selfId || '')]);
    const candMap = new Map();
    for (const m of msgs) {
      if (m.time < win.from || m.time > win.to || bots.has(m.userId)) continue;
      const c = candMap.get(m.userId) || { id: m.userId, name: m.username || ('QQ' + m.userId), n: 0, samples: [] };
      c.n += 1;
      if (c.samples.length < 2) c.samples.push(m.text.slice(0, 40));
      candMap.set(m.userId, c);
    }
    const cands = [...candMap.values()].sort((a, b) => b.n - a.n).slice(0, 10);
    // 没候选不能直接 return null：时段内只有锚点发送人自己说话时，他那几轮发言仍是有用背景
    //   （早期版本此处 return null，导致“一个人连发几条再被人引用”这种常见场景拿不到任何背景）。
    if (!cands.length) logger.info('[引用检索] 时段内没有其他人发言，只保留锚点发送人自己的上下文');
    // ③ 选人（结构信号优先，可解释且省掉一次模型请求）：命中任一条即算 seed 的讨论对象——
    //   a) 引用过 seed 在该时段内的任何一条消息；b) @ 过 seed；c) 接话：seed 发完后 gap 内紧接着的那个人。
    //   三条都没命中、且确有候选人时，才交给 AI 补判一次；AI 也判不出就只保留 seed 自己的发言。
    const seedMsgIds = new Set(msgs.filter((m) => String(m.userId) === seed).map((m) => m.messageId));
    const ordered = msgs.filter((m) => m.time >= win.from && m.time <= win.to).sort((x, y) => x.time - y.time);
    const gapSec = Math.floor(chainMs / 1000);
    const altIds = new Set();
    ordered.forEach((m, i) => {
      if (String(m.userId) !== seed) return;
      const nxt = ordered[i + 1];
      if (nxt && !bots.has(nxt.userId) && nxt.time - m.time <= gapSec) altIds.add(nxt.userId);
    });
    const struct = new Map();
    for (const m of ordered) {
      if (bots.has(m.userId) || struct.has(m.userId)) continue;
      const { replies, ats } = replyAtIdsOf(m.raw);
      const why = replies.some((id) => seedMsgIds.has(id)) ? '引用'
        : (ats.includes(seed) ? '@' : (altIds.has(m.userId) ? '接话' : ''));
      if (why) struct.set(m.userId, why);
    }
    let picked = [...struct.keys()];
    if (picked.length) logger.info(`[引用检索] 结构命中 ${picked.length} 人（${[...struct.values()].join('、')}，未调模型）`);
    // ④ 结构一个都没命中 → 才让 AI 补判一次
    if (!picked.length && cands.length && typeof chatSelect === 'function') {
      const prompt = [
        '群里发生了一段对话，下面先给出被引用的一条消息，再列出候选成员及其发言条数、例子。',
        `锚点消息（被引用）：[时间 ${fmtTime(anchorTime * 1000)} 发送人「${anchor.username || ('QQ' + seed)}」] ${anchor.text}`,
        '候选成员：',
        ...cands.map((c) => `- 编号${c.id} 昵称「${c.name}」 发言${c.n}条：${c.samples.join('；')}`),
        '',
        `问：这些候选成员里，哪些在同一时段内是与「${anchor.username || ('QQ' + seed)}」就同一话题讨论的对象？`,
        '只回答编号（逗号分隔），都不确定就回答：无。不要解释。',
      ].join('\n');
      try {
        const ans = await chatSelect(prompt);
        // 只从“真正存在的候选 id”里取（不限制位数；模型回行号/额外数字会被自然过滤掉）
        const digits = String(ans || '').match(/\d+/g) || [];
        picked = cands.filter((c) => digits.includes(c.id)).map((c) => c.id);
        if (picked.length) logger.info(`[引用检索] 结构无命中，AI 补判 ${picked.length} 人`);
      } catch (error) {
        logger.warn('[引用检索] AI 补判失败，只保留锚点发送人发言: ' + String(error && error.message || error).slice(0, 120));
      }
    }
    if (!picked.length) { logger.info('[引用检索] 未识别到讨论对象（结构与 AI 都没命中），仅保留锚点发送人发言'); }
    // ④ 组装背景块（seed + 命中参与人，超限优先留靠近锚点的）
    const res = assembleLines(msgs, seed, picked, win, anchor, maxChars, fmtTime);
    if (!res.count || !res.block) { logger.info('[引用检索] 组装后背景块为空（窗内只有锚点自身或全被占位符过滤）'); return null; }
    // 压缩存档：同一个组装函数按更小的字数上限重裁（超限时本来就是「靠近锚点的优先留」，正好适合当摘要）。
    //   不另写一套裁剪逻辑，免得两边口径漂移；存档 ≤ 全量时用全量，等于白裁。
    const hMax = Number(historyMaxChars) || 0;
    const historyBlock = hMax > 0 ? (hMax >= maxChars ? res.block : assembleLines(msgs, seed, picked, win, anchor, hMax, fmtTime).block) : '';
    return { block: res.block, count: res.count, historyBlock, from: win.from, to: win.to, picked };
  };

  return { findRawReplyId, fetchQuoteByMsgId, maybePatchGetMessage, parseMsgPayload, retrieveAroundQuote };
};

module.exports = { create, findRawReplyId, parseMsgPayload, windowChat, assembleLines, replyAtIdsOf };
