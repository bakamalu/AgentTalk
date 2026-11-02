'use strict';

// ===== DeepSeek 机器人插件主体 =====
// 这一层只做两件事：**消息流编排**（唤醒判定 / 连发合并 / 上下文 / 指令 / 撤回）
// 和 **模型调用循环**（含工具往返）。能力与基础件都在 ../lib 下，新增能力改对应模块，别往这里堆：
//   lib/text.js       纯文本工具（CQ 码、Markdown 转纯文本、分段、HTML 实体、时间注入）
//   lib/hotconfig.js  bot.env 热配置层（改值秒级生效）
//   lib/store.js      多轮上下文与 token 用量持久化
//   lib/sender.js     频率闸 + 投递路由（群走 send_group_msg，引用走 reply 段）
//   lib/quote.js      引用原文三层兜底（adapter → internal.getMsg → 直连 WS）
//   lib/tools.js      工具注册表：能力在这里挂载与分发
//   lib/weather.js    天气（Open-Meteo 免 key，兜底 wttr.in）
//   lib/websearch.js  联网搜索（Bing 免 key + 查询词治理 + 结果质量闸）
//
// 改这个文件前先看 docs/03-dev-log.md 与 scripts/OPS-NOTES.md：仓库副本与
// /opt/koishi 是两份独立文件，必须 `botctl.sh sync plugin` 才会部署。

const { normalizeText, detectImageMime, timeLine } = require('../lib/text');
const hotconfig = require('../lib/hotconfig');
const storeLib = require('../lib/store');
const senderLib = require('../lib/sender');
const quoteLib = require('../lib/quote');
const toolsLib = require('../lib/tools');

const { DEFAULTS } = hotconfig;

module.exports = (ctx, config = {}) => {
  const logger = ctx.logger || console;
  const apiKey = config.apiKey || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
  const baseUrl = (config.apiBase || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
  const model = config.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const triggerKeywords = (config.triggerKeyword || config.triggerKeywords || DEFAULTS.TRIGGER_KEYWORDS).map(String);
  const groupPolicy = config.groupPolicy || 'at';
  const privatePolicy = config.privatePolicy || 'whitelist';
  // [playbook 08 运营层] 运营方硬锁：群里只允许被 @ 才说话，优先级高于 groupPolicy
  const mentionOnly = config.mentionOnly !== false;
  // 请求超时：超时属于「投递未知」，不重发、不重复刷屏
  const requestTimeoutMs = Math.max(5000, Number(config.requestTimeoutMs ?? 60000));

  const stateDir = config.stateDir || process.env.BOT_STATE_DIR || '/opt/koishi/state/deepseek';
  const botEnvFile = config.botEnvFile || process.env.BOT_ENV_FILE || '/root/deploy/bot.env';
  const hotIntervalMs = Math.max(2000, Number(config.hotIntervalMs ?? process.env.BOT_HOT_INTERVAL_MS ?? 5000));

  // ---------- 各层装配 ----------
  const { hot, maybeReload } = hotconfig.create({ config, logger, botEnvFile });
  const store = storeLib.create({
    stateDir,
    logger,
    maxTurns: Number(config.maxTurns ?? 8),
    priceIn: Number(process.env.BOT_PRICE_INPUT_PER_M ?? 1),   // 元 / 百万 input tokens
    priceOut: Number(process.env.BOT_PRICE_OUTPUT_PER_M ?? 2), // 元 / 百万 output tokens（未命中缓存口径）
  });
  const { histories, getHistory, pushHistory, scheduleSave, recordUsage, usageSummary } = store;
  const sender = senderLib.create({
    logger,
    hot,
    limits: {
      ratePerMinute: config.ratePerMinute,
      minIntervalMs: config.minIntervalMs,
      splitLimit: config.splitLimit,
      splitMaxParts: config.splitMaxParts,
    },
  });
  const { send: sendReply, allowSend } = sender;
  const hub = toolsLib.create({ logger, hot });
  const quotes = quoteLib.create({
    logger,
    wsEndpoint: config.napcatWsEndpoint || process.env.NAPCAT_WS_ENDPOINT || 'ws://127.0.0.1:3001',
  });

  // ---------- 会话键与群上下文缓冲 ----------
  const channelKeyOf = (session) => `${session.platform || 'onebot'}:${session.guildId || 'private'}:${session.channelId || ''}`;
  const chatKeyOf = (session) => `${channelKeyOf(session)}:${session.userId}`;
  const selfBotId = (session) => String(session.bot?.selfId || session.selfId || '');
  const groupBuffer = new Map();   // channelKey -> [{ senderId, text, ts }]
  const activeUntil = new Map();   // chatKey  -> 免@可继续响应的截止时间戳
  const isQuotingBot = (session) => Boolean(session.quote && String(session.quote.userId) === selfBotId(session));
  const withinActiveWindow = (session) => hot.activeWindowMs > 0 && (activeUntil.get(chatKeyOf(session)) || 0) > Date.now();
  const pushGroupBuffer = (channelKey, item) => {
    if (hot.groupContextMs <= 0 || hot.groupContextMax <= 0) return;
    const arr = groupBuffer.get(channelKey) || [];
    arr.push(item);
    const cutoff = Date.now() - hot.groupContextMs;
    while (arr.length && (arr[0].ts < cutoff || arr.length > hot.groupContextMax)) arr.shift();
    groupBuffer.set(channelKey, arr);
  };
  const takeGroupContext = (channelKey) => {
    if (hot.groupContextMs <= 0 || hot.groupContextMax <= 0) return '';
    const cutoff = Date.now() - hot.groupContextMs;
    const recent = (groupBuffer.get(channelKey) || []).filter((m) => m.ts >= cutoff && m.text);
    return recent.map((m) => `- [QQ ${m.senderId}] ${m.text}`).join('\n');
  };

  // 同一会话串行处理，避免两轮并发导致上下文交错、回复顺序错乱
  const chains = new Map();
  const enqueue = (key, task) => {
    const prev = chains.get(key) || Promise.resolve();
    const next = prev.then(task, task);
    chains.set(key, next.catch(() => {}));
    return next;
  };

  const hitSensitive = (text) => hot.sensitiveWords.find((w) => String(text).includes(w));
  // 拦截通知策略：BOT_SENSITIVE_NOTIFY=1 当前会话发提示；空 = 仅记日志（参考 qq-bridge）
  const censorNotify = (session, messageId) => {
    if (hot.sensitiveNotify) {
      sendReply(session, '这个话题我不太方便聊，换一个吧～', messageId).catch(() => {});
    }
  };

  // API key 只在启动时读取（改密钥仍需重启，避免运行中换凭证）
  if (!apiKey) {
    logger.warn('DeepSeek API key is not configured. Set DEEPSEEK_API_KEY or pass apiKey in plugin config.');
    return;
  }

  // ---------- 启动横幅（不含密钥），便于日志核对实际生效策略 ----------
  const describe = (set, emptyText) => (set ? `仅 ${[...set].join(',')}` : emptyText);
  const countText = (set) => (set ? `${set.size} 个` : '未设置');
  logger.info(`[白名单] 私聊 ${describe(hot.allowedUsers, '不限制(全部放行)')}；群聊 ${describe(hot.allowedGroups, '不限制(所有群，需 @)')}`);
  logger.info(`[管理员] ${describe(hot.adminUsers, '未设置(特权指令不可用)')}；生效范围 ${hot.adminGroup ? '私聊+群聊(@机器人)' : '仅私聊'}`);
  logger.info(`[黑名单] 用户 ${countText(hot.blacklistedUsers)}；群 ${countText(hot.blacklistedGroups)}（优先于白名单，命中即拒）`);
  logger.info(`[敏感词] ${hot.sensitiveWords.length ? hot.sensitiveWords.length + ' 个词已启用' : '未启用'}；引用回复 ${hot.quoteReply ? '开' : '关'}`);
  logger.info(`[搜索] 联网搜索 ${hot.searchEnabled ? `开（Bing，最多 ${hot.searchMaxRounds} 轮 × ${hot.searchMaxResults} 条，含查询词归一化+质量闸）` : '关（模型会被告知自己不能联网）'}`);
  logger.info(`[天气] ${hot.weatherEnabled ? `开（Open-Meteo 主 + wttr.in 兜底；默认城市 ${hot.weatherDefaultCity || '未设置=向用户追问'}）` : '关（天气类问题会被告知查不到）'}`);
  logger.info(`[上下文] @前群聊上下文 ${hot.groupContextMax > 0 ? `最近 ${hot.groupContextMax} 条/${Math.round(hot.groupContextMs / 1000)}s` : '关'}；@后免@活跃窗口 ${hot.activeWindowMs > 0 ? Math.round(hot.activeWindowMs / 1000) + 's' : '关'}`);
  logger.info(`[模式] ${hot.atOnly ? '严格@（群里只有被@才回应）' : '常规（@/关键词/引用/活跃窗口）'}；连发合并 ${hot.mergeWindowMs > 0 ? Math.round(hot.mergeWindowMs / 1000) + 's' : '关'}；mentionOnly=${mentionOnly}`);
  logger.info(`[状态] 目录 ${stateDir}（历史 ${histories.size} 个会话已恢复；${usageSummary()}）`);

  // ---------- 图片识别：deepseek-flash 原生多模态，但要求 OpenAI 兼容的 content 块数组 ----------
  // NapCat 图片 URL 常是内网地址，云端 API 拉不到 → 服务端下载后转 base64 data URL 内联
  const collectImages = (session) => {
    if (!hot.enableImage) return [];
    const urls = [];
    const push = (u) => { if (u && !urls.includes(u)) urls.push(u); };
    for (const el of session.elements || []) {
      if (el?.type === 'image') push(el.attrs?.url || el.attrs?.file || '');
    }
    if (!urls.length && /\[CQ:image/i.test(String(session.content || ''))) {
      const m = String(session.content).match(/\[CQ:image[^\]]*url=([^\],\]]+)/i);
      push(m ? m[1] : '');
    }
    return urls.slice(0, hot.imageMax);
  };
  const downloadImageAsDataUrl = async (url) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(hot.imageTimeoutMs) });
      if (!res.ok) { logger.warn(`[图片] 下载失败 HTTP ${res.status}: ${url.slice(0, 120)}`); return ''; }
      const buf = Buffer.from(await res.arrayBuffer());
      if (!buf.length || buf.length > 16 * 1024 * 1024) { logger.warn('[图片] 大小超限或为空，跳过'); return ''; }
      const mime = detectImageMime(buf);
      if (!mime) { logger.warn('[图片] 格式不支持（仅 JPEG/PNG/GIF/WebP），跳过'); return ''; }
      return `data:${mime};base64,${buf.toString('base64')}`;
    } catch (error) {
      logger.warn(`[图片] 下载异常: ${String(error.message || error).slice(0, 120)}`);
      return '';
    }
  };
  // 当前轮 user 消息：有图则构造 content 块数组（图片只能出现在 user 消息），无图保持纯字符串
  const buildUserContent = async (text, dataUrls) => {
    if (!dataUrls.length) return text;
    return [
      { type: 'text', text },
      ...dataUrls.map((url) => ({ type: 'image_url', image_url: { url } })),
    ];
  };

  // ---------- 唤醒判定 ----------
  const isAtBot = (session) => {
    if (!session) return false;
    const selfId = String(session.bot?.selfId || session.selfId || '');
    if (!selfId) return false;
    if (Array.isArray(session.elements)) {
      for (const element of session.elements) {
        const id = element?.attrs?.id;
        if (element?.type === 'at' && String(id) === selfId) return true;
      }
    }
    return Boolean(session.content && String(session.content).includes(`@${selfId}`));
  };

  const hasTriggerKeyword = (content = '') => {
    const lower = normalizeText(content).toLowerCase();
    return triggerKeywords.some((keyword) => lower.includes(String(keyword).toLowerCase()));
  };

  const shouldReply = (session) => {
    const content = normalizeText(session.content || '');
    const isGroup = Boolean(session.guildId);
    const userId = String(session.userId ?? '');
    const channelId = String(session.channelId ?? session.guildId ?? '');

    // 黑名单一票否决：优先于白名单与所有策略（管理员也不能豁免）
    if (hot.blacklistedUsers && hot.blacklistedUsers.has(userId)) {
      logger.info(`[黑名单] 拒绝用户 ${userId}`);
      return false;
    }
    if (isGroup && hot.blacklistedGroups && hot.blacklistedGroups.has(channelId)) {
      logger.info(`[黑名单] 拒绝群 ${channelId}`);
      return false;
    }

    // 私聊：名单为空 = 不设白名单（全部放行）；有值 = 仅名单内
    if (!isGroup) {
      if (privatePolicy === 'whitelist') return !hot.allowedUsers || hot.allowedUsers.has(userId);
      if (hot.allowedUsers && !hot.allowedUsers.has(userId)) return false;
      if (privatePolicy === 'always') return true;
      if (privatePolicy === 'keyword') return hasTriggerKeyword(content);
      return false;
    }

    // 群聊：名单为空 = 不设白名单（所有群生效）；有值 = 仅名单内
    if (hot.allowedGroups && !hot.allowedGroups.has(channelId)) return false;

    const at = isAtBot(session);
    // 严格模式：群里只认 @（关键词/引用/活跃窗口都不触发）
    if (hot.atOnly) {
      if (at) logger.info(`[运营] 群 ${channelId} 唤醒（被@）`);
      return at;
    }

    // 群聊唤醒条件：被 @ / 命中关键词 / 引用机器人 / 处于被@后的活跃窗口（免@连续对话）
    const wake = at || hasTriggerKeyword(content) || isQuotingBot(session) || withinActiveWindow(session);
    if (wake) {
      const reason = at ? '被@' : isQuotingBot(session) ? '引用机器人' : withinActiveWindow(session) ? '活跃窗口' : '关键词';
      logger.info(`[运营] 群 ${channelId} 唤醒（${reason}）`);
    }
    return wake;
  };

  // ---------- 模型调用：带工具往返的多轮循环 ----------
  const callDeepSeek = async (messages) => {
    let working = messages;
    const usage = { prompt_tokens: 0, completion_tokens: 0 };
    const searched = [];
    let round = 0;

    for (;;) {
      // 最后一轮不再下发 tools，强制模型基于已拿到的内容给出文字答案，防止无限循环。
      const tools = round < hot.searchMaxRounds ? hub.schemas() : [];
      const response = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: working,
          temperature: 0.7,
          stream: false,
          ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
        }),
        // 超时不重试：避免「其实已生成/已发送」时重复刷屏
        signal: AbortSignal.timeout(requestTimeoutMs),
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = payload?.error?.message || payload?.message || 'DeepSeek request failed';
        throw new Error(detail);
      }
      // 多轮（含工具往返）的 token 要累加，否则用量统计和成本会偏低。
      if (payload?.usage) {
        usage.prompt_tokens += payload.usage.prompt_tokens || 0;
        usage.completion_tokens += payload.usage.completion_tokens || 0;
      }

      const msg = payload?.choices?.[0]?.message || {};
      const calls = Array.isArray(msg.tool_calls) ? msg.tool_calls : [];

      if (!calls.length) {
        const text = msg.content || payload?.choices?.[0]?.text || '';
        if (!text) throw new Error('DeepSeek returned an empty response');
        return { text: String(text).trim(), usage, searched };
      }

      // 模型可能一次发多个 tool_calls（实测会并行发两三个），逐个回填。
      round += 1;
      working = [...working, { role: 'assistant', content: msg.content ?? '', tool_calls: calls }];
      for (const call of calls) {
        const name = call.function?.name || 'web_search';
        let result;
        try {
          result = await hub.exec(name, call.function?.arguments);
        } catch (error) {
          // 工具本身异常不能让整轮崩掉：把失败如实交给模型，要求它说查不到
          const message = String(error?.message || error).slice(0, 120);
          logger.warn(`[工具] ${name} 执行异常: ${message}`);
          result = { text: `工具 ${name} 执行失败：${message}。请如实告知用户暂时查不到，不要编造。`, queries: [], hits: 0 };
        }
        for (const q of result.queries || []) searched.push(q);
        working.push({ role: 'tool', tool_call_id: call.id, name, content: result.text });
      }
    }
  };

  // ---------- 管理员特权指令：不进模型队列，立即响应 ----------
  // 私聊直接发；群里被 @ 时去掉 @ 后也能触发（未 @ 收不到，无需特判）
  const handleAdminCommand = (session, text) => {
    if (!hot.adminUsers) return false;
    const userId = String(session.userId ?? '');
    if (hot.blacklistedUsers && hot.blacklistedUsers.has(userId)) return false;
    if (!hot.adminUsers.has(userId)) return false;

    // 默认管理员指令仅私聊生效；adminGroup 开启后群里可用（需 @机器人，去掉 @ 后匹配指令）
    const isGroup = Boolean(session.guildId);
    if (isGroup) {
      if (!hot.adminGroup) return false;
      const selfId = String(session.bot?.selfId || session.selfId || '');
      text = text.replace(new RegExp('@' + selfId, 'g'), '').trim();
    }

    if (/^(#|＃)?重置(对话|上下文|记忆)?$/i.test(text) || /^\/reset$/i.test(text)) {
      const chatKey = `${session.platform || 'onebot'}:${session.guildId || 'private'}:${session.channelId || ''}:${session.userId}`;
      histories.delete(chatKey);
      scheduleSave();
      logger.info(`[管理员] ${userId} 重置了 ${chatKey} 的上下文`);
      sendReply(session, '已重置本会话上下文（频率计数与用量统计保留）。').catch(() => {});
      return true;
    }

    if (/^(#|＃)?状态$/i.test(text) || /^\/status$/i.test(text)) {
      const turns = [...histories.values()].reduce((n, list) => n + Math.floor(list.length / 2), 0);
      const lines = [
        '【机器人状态】',
        `模型：${model} @ ${baseUrl}`,
        `上下文：活跃会话 ${histories.size} 个，累计 ${turns} 轮（已持久化）`,
        `白名单：私聊 ${describe(hot.allowedUsers, '不限制')}；群聊 ${describe(hot.allowedGroups, '不限制')}`,
        `黑名单：用户 ${countText(hot.blacklistedUsers)}，群 ${countText(hot.blacklistedGroups)}；敏感词 ${hot.sensitiveWords.length ? hot.sensitiveWords.length + ' 个' : '未启用'}，拦截通知 ${hot.sensitiveNotify ? '开' : '仅日志'}`,
        `用量：${usageSummary()}`,
        `管理员：${[...hot.adminUsers].join(',')}`,
        sender.rateDesc(),
        `图片识别：${hot.enableImage ? `开（单条最多 ${hot.imageMax} 张，base64 内联）` : '关'}`,
        `联网能力：搜索 ${hot.searchEnabled ? `开（${hot.searchMaxRounds} 轮 × ${hot.searchMaxResults} 条）` : '关'}；天气 ${hot.weatherEnabled ? `开（默认城市 ${hot.weatherDefaultCity || '无'}）` : '关'}`,
        `热重载：${botEnvFile}（2~5 秒自动生效，无需重启）`,
        `当前人格：${hot.systemPrompt.slice(0, 40)}`,
      ];
      logger.info(`[管理员] ${userId} 查询状态`);
      sendReply(session, lines.join('\n')).catch(() => {});
      return true;
    }

    return false;
  };

  // ---------- 消息撤回：把被撤回的内容从对应会话历史里剔除 ----------
  // 私聊撤回只能撤自己的消息，按 msgId 精确删；群撤回事件里只有 id，需全量定位。
  ctx.on('message-recall', (session) => {
    try {
      const platform = session.platform || 'onebot';
      const messageId = session.messageId ? String(session.messageId) : '';
      if (!messageId) return;
      for (const [key, list] of histories) {
        const kept = list.filter((item) => String(item.msgId) !== messageId);
        if (kept.length !== list.length) {
          histories.set(key, kept);
          scheduleSave();
          logger.info(`[撤回] 从 ${key} 剔除 ${list.length - kept.length} 条被撤回消息`);
          return;
        }
      }
      if (session.guildId) return;
      const chatKey = `${platform}:private::${session.userId}`;
      const list = histories.get(chatKey);
      if (list) {
        histories.set(chatKey, list.filter((item) => String(item.msgId) !== messageId));
        scheduleSave();
        logger.info(`[撤回] 私聊 ${session.userId} 消息 ${messageId} 已从历史剔除`);
      }
    } catch (error) {
      logger.warn('[撤回] 处理异常: ' + error.message);
    }
  });

  // 空闲时也定期巡检 bot.env（纯事件驱动在长期无消息时不会检查）
  const hotTimer = setInterval(() => maybeReload(), hotIntervalMs);
  if (typeof hotTimer.unref === 'function') hotTimer.unref();

  // ---------- 连发合并：同一会话短时间内的多条消息合成一轮，统一交给模型一次回复 ----------
  const mergeBuckets = new Map(); // chatKey -> { items:[], firstTs, timer }
  const searchedBrief = (list) => (list && list.length ? list.join(' / ') : '未调用');

  const flushBucket = (chatKey, bucket) => enqueue(chatKey, async () => {
    if (!allowSend(chatKey)) return;
    const items = bucket.items;
    const last = items[items.length - 1] || {};
    const session = last.session;
    if (!session) return;

    // 合并正文 / 图片 / @前上下文
    const texts = items.map((it) => it.body).filter(Boolean);
    const imageUrls = [];
    for (const it of items) for (const u of it.imageUrls || []) if (u && !imageUrls.includes(u)) imageUrls.push(u);

    // 引用：取最后一条带引用的消息（adapter 已带原文 或 需兜底拉取）
    let quoteItem = null;
    for (const it of items) if (it.hasAdapterQuote || it.rawReplyId) quoteItem = it;
    let quoteText = '';
    let quoteWho = '';
    if (quoteItem && quoteItem.hasAdapterQuote) {
      quoteText = normalizeText((quoteItem.quote && quoteItem.quote.content) || '');
      quoteWho = String(quoteItem.quote.username || quoteItem.quote.userName || (quoteItem.quote.userId != null ? 'QQ' + quoteItem.quote.userId : '')).trim();
    } else if (quoteItem && quoteItem.rawReplyId) {
      const fetched = await quotes.fetchQuoteByMsgId(session, quoteItem.rawReplyId);
      if (fetched && fetched.text) { quoteText = fetched.text; quoteWho = fetched.username || ''; logger.info(`[引用] 兜底拉取成功 id=${quoteItem.rawReplyId}`); }
    }

    const ctxLines = [];
    for (const it of items) {
      if (!it.leadingContext) continue;
      for (const line of String(it.leadingContext).split('\n')) if (line && !ctxLines.includes(line)) ctxLines.push(line);
    }
    const groupContext = ctxLines.join('\n');

    // 图片下载（同一会话内串行）
    const imageDataUrls = [];
    if (imageUrls.length) {
      for (const url of imageUrls.slice(0, hot.imageMax)) {
        const dataUrl = await downloadImageAsDataUrl(url);
        if (dataUrl) imageDataUrls.push(dataUrl);
      }
      logger.info(`[图片] ${session.userId} 合并含图 ${imageUrls.length} 张，可识 ${imageDataUrls.length} 张（${model}）`);
    }

    const mergedBody = texts.join('\n');
    const hasContent = Boolean(mergedBody || imageDataUrls.length || quoteText);

    let finalPrompt;
    let modelInput;
    if (hasContent) {
      finalPrompt = quoteText
        ? ('[引用' + (quoteWho ? ' ' + quoteWho : '') + '的消息] ' + quoteText + (mergedBody ? '\n[我的回应] ' + mergedBody : '')).trim()
        : (mergedBody || '（用户发来图片，未附文字）');
      modelInput = groupContext
        ? ('[群内近期消息，供你判断是否是在与你对话并理解上下文]\n' + groupContext + '\n\n[本轮消息] ' + finalPrompt)
        : finalPrompt;
    } else if (groupContext) {
      // 纯 @：把上下文一并交给模型，判断有没有需要回应的信息
      finalPrompt = '[仅@，无文字]';
      modelInput = '[群内近期消息，供你判断是否是在与你对话并理解上下文]\n' + groupContext
        + '\n\n[本轮消息] 对方只 @ 了你，没有发具体内容。请结合上面的群消息判断有没有需要你回应的信息；若没有明确请求，就自然地反问一句“怎么了，有什么事？”';
    } else {
      // 纯 @ 且没有任何可参考信息：直接询问（不调用模型，省 token）
      pushHistory(chatKey, 'user', '[仅@，无文字]', session.messageId, String(session.userId));
      pushHistory(chatKey, 'assistant', '怎么了，有什么事？', null);
      scheduleSave();
      logger.info(`[合并] 纯@无上下文，询问怎么了（${chatKey}）`);
      try { await sendReply(session, '怎么了，有什么事？', session.messageId); } catch (_) { /* 忽略 */ }
      return;
    }

    const history = getHistory(chatKey);
    const currentContent = imageDataUrls.length ? await buildUserContent(modelInput, imageDataUrls) : modelInput;
    // 时间与能力边界都必须在发送时现算：时间要用本地时区（见 lib/text.timeLine），
    // 能力描述要和实际下发的工具一致（见 lib/tools.describeCapabilities）。
    const messages = [
      { role: 'system', content: `${hot.systemPrompt}\n${timeLine()}\n${toolsLib.describeCapabilities(hot)}` },
      ...history.map(({ role, content, senderId }) => ({
        role,
        content: role === 'user' && senderId ? '[QQ号 ' + senderId + '] ' + content : content,
      })),
      { role: 'user', content: currentContent },
    ];

    try {
      const result = await callDeepSeek(messages);
      const badWord = hitSensitive(result.text);
      if (badWord) {
        logger.info(`[敏感词] 输出命中「${badWord}」，回复已拦截（${chatKey}）`);
        recordUsage(chatKey, result.usage);
        censorNotify(session, session.messageId);
        return;
      }
      pushHistory(chatKey, 'user', finalPrompt, session.messageId, String(session.userId));
      pushHistory(chatKey, 'assistant', result.text, null);
      recordUsage(chatKey, result.usage);
      scheduleSave();
      // 回复正文进日志（截断），否则排查时只能去翻 histories.json
      logger.info(`DeepSeek 回复 [${chatKey}] 合并 ${items.length} 条 历史轮次=${Math.floor(getHistory(chatKey).length / 2)}`
        + ` 工具=${searchedBrief(result.searched)}`);
      logger.info(`[回复] ${chatKey}: ${result.text.replace(/\s+/g, ' ').slice(0, 120)}`);
      await sendReply(session, result.text, session.messageId);
    } catch (error) {
      logger.error('DeepSeek reply failed:', error);
      try { await sendReply(session, '抱歉，我当前无法回复。请稍后再试。'); } catch (_) { /* 已记录 */ }
    }
  });

  const enqueueMerge = (chatKey, item) => {
    const win = Math.max(0, Number(hot.mergeWindowMs) || 0);
    const maxWait = Math.max(win, Number(hot.mergeMaxWaitMs) || win);
    let bucket = mergeBuckets.get(chatKey);
    if (!bucket) {
      bucket = { items: [], firstTs: Date.now(), timer: null };
      mergeBuckets.set(chatKey, bucket);
    }
    bucket.items.push(item);

    const doFlush = () => {
      const b = mergeBuckets.get(chatKey);
      if (!b) return;
      mergeBuckets.delete(chatKey);
      if (b.timer) clearTimeout(b.timer);
      flushBucket(chatKey, b);
    };

    if (bucket.timer) clearTimeout(bucket.timer);
    if (win <= 0) { doFlush(); return; }
    const elapsed = Date.now() - bucket.firstTs;
    const wait = Math.max(150, Math.min(win, maxWait - elapsed));
    bucket.timer = setTimeout(doFlush, wait);
  };

  ctx.on('message', (session) => {
    if (!session || session.selfId === session.userId) return;
    if (session.subtype === 'self' || session.isSelf) return;

    // 一次性给 bot.getMessage 打引用兜底补丁（详见 lib/quote.js）
    quotes.maybePatchGetMessage(session);

    maybeReload();

    const rawText = normalizeText(session.content || '');

    // 引用消息：OneBot adapter 会把被引用原文异步拉取并挂到 session.quote（含 content/userId/username）
    const quote = session.quote;
    const hasAdapterQuote = Boolean(quote && typeof quote.content === 'string');

    // 诊断日志：只要事件里带有引用节点就记一笔，方便判断是没收到还是拉取失败
    const rawReplyId = hasAdapterQuote ? '' : quotes.findRawReplyId(session);
    if (hasAdapterQuote || rawReplyId) {
      logger.info(`[引用] ${session.userId} quote=${hasAdapterQuote ? '有原文' : '无'} replyId=${rawReplyId || (quote.messageId ?? '')}`);
    }

    // 诊断日志：打印本条消息的结构（元素类型+原始事件摘要），用于定位引用未生效的环节
    if (/\[CQ:(reply|source)/i.test(String(session.original || '')) || (session.elements || []).some((e) => e.type === 'reply' || e.type === 'source') || session.quote || /引用/.test(rawText)) {
      const elTypes = (session.elements || []).map((e) => e.type).join(',');
      const rawMsg = (() => { try { return JSON.stringify(session.event?.message?.['onebot']?.message || '').slice(0, 300); } catch (e) { return ''; } })();
      logger.info(`[引用诊断] from=${session.userId} quote=${session.quote ? 'Y' : 'N'} els=[${elTypes}] original=${JSON.stringify(String(session.original || '').slice(0, 120))} raw=${rawMsg}`);
    }

    if (handleAdminCommand(session, rawText)) return;

    // 群聊：未唤醒的消息先暂存为「@前上下文」；唤醒时把连发消息+上下文合并，统一回复一次
    const isGroup = Boolean(session.guildId);
    const cKey = channelKeyOf(session);
    const wake = shouldReply(session);

    const selfId = String(session.bot?.selfId || session.selfId || '');
    const body = rawText
      .replace(new RegExp(`@${selfId}`, 'g'), '')
      .trim();

    // 图片识别：提取本条消息的图片（含只发图不打字）
    const imageUrls = collectImages(session);

    // 未唤醒：群聊暂存进 @前上下文缓冲，等待下次被 @ 时一起带出
    if (!wake) {
      if (isGroup && (rawText || imageUrls.length)) {
        pushGroupBuffer(cKey, { senderId: String(session.userId), text: rawText || '[图片]', ts: Date.now() });
      }
      return;
    }

    // 敏感词输入拦截：只看当前用户实际输入的正文，引用里的旧内容不牵连
    const hitWord = hitSensitive(rawText);
    if (hitWord) {
      logger.info(`[敏感词] 输入命中「${hitWord}」，已拒绝（${session.userId}）`);
      if (hot.sensitiveNotify) sendReply(session, '这个问题我不方便回答，我们聊点别的吧。').catch(() => {});
      return;
    }

    // 私聊里既无正文也无图/引用：忽略
    if (!isGroup && !body && !imageUrls.length && !hasAdapterQuote && !rawReplyId) return;

    const chatKey = chatKeyOf(session);
    // 唤醒即刷新活跃窗口：窗口内同一人再发的消息可免@继续对话
    if (isGroup && hot.activeWindowMs > 0) activeUntil.set(chatKey, Date.now() + hot.activeWindowMs);

    // 取 @前群上下文快照并清空缓冲：与随后连发的消息合并进同一轮
    const leadingContext = isGroup ? takeGroupContext(cKey) : '';
    if (isGroup) groupBuffer.delete(cKey);

    // 入合并桶：静默窗口内到达的多条消息合成一轮，统一交给模型，只回一次
    enqueueMerge(chatKey, { session, body, imageUrls, hasAdapterQuote, quote, rawReplyId, leadingContext });
    return;
  });
};
