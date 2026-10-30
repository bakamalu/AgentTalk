const fs = require('fs');
const path = require('path');

const DEFAULT_TRIGGER_KEYWORDS = ['ai', 'bot', '机器人', 'deepseek', 'deepseek机器人'];
const DEFAULT_SYSTEM_PROMPT = '你是一个友好的中文助手，回答简洁自然，适合在 QQ 聊天中使用。';
// @前群聊上下文窗口 / @后免@活跃窗口 默认值（可被 bot.env 热覆盖；0 = 关闭）
const DEFAULT_ACTIVE_WINDOW_MS = 120000;   // 被@后免@连续对话时长
const DEFAULT_GROUP_CONTEXT_MS = 120000;   // @前上下文取多久以内的群消息
const DEFAULT_GROUP_CONTEXT_MAX = 6;       // @前上下文最多几条
const DEFAULT_MERGE_WINDOW_MS = 2000;      // 连发合并：静默多久后统一回复（0=不合并，立即处理）
const DEFAULT_MERGE_MAX_WAIT_MS = 6000;    // 连发合并：从第一条起最长等待，避免持续连发一直不回

module.exports = (ctx, config = {}) => {
  const logger = ctx.logger || console;
  const apiKey = config.apiKey || process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY;
  const baseUrl = (config.apiBase || process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
  const model = config.model || process.env.DEEPSEEK_MODEL || 'deepseek-chat';
  const triggerKeywords = (config.triggerKeyword || config.triggerKeywords || DEFAULT_TRIGGER_KEYWORDS).map(String);
  const groupPolicy = config.groupPolicy || 'at';
  const privatePolicy = config.privatePolicy || 'whitelist';
  // 人格/自称：热配置层 systemPrompt（bot.env 的 BOT_SYSTEM_PROMPT，改后秒级生效）


  // [playbook 08 运营层] 运营方硬锁：群里只允许被 @ 才说话，优先级高于 groupPolicy
  const mentionOnly = config.mentionOnly !== false;
  // [playbook 10 频率闸] 发送限流：同一会话每分钟上限 + 最小间隔（先压广度再调深度）
  const ratePerMinute = Math.min(20, Math.max(1, Number(config.ratePerMinute ?? 6)));
  const minIntervalMs = Math.max(0, Number(config.minIntervalMs ?? 1500));
  // 长回复分段：限流调太狠时单条会被截断，这里主动切分
  const splitLimit = Math.max(100, Number(config.splitLimit ?? 500));
  const splitMaxParts = Math.max(1, Math.min(5, Number(config.splitMaxParts ?? 3)));
  // 请求超时：超时属于「投递未知」，不重发、不重复刷屏
  const requestTimeoutMs = Math.max(5000, Number(config.requestTimeoutMs ?? 60000));

  // 白名单：不默认放行。数字/字符串统一转成字符串比较。
  const toIdSet = (value) => {
    if (!value) return null;
    const list = Array.isArray(value) ? value : String(value).split(',');
    const set = new Set(list.map((v) => String(v).trim()).filter(Boolean));
    return set.size ? set : null;
  };
  const toWordList = (value) => (Array.isArray(value) ? value : String(value || '').split(','))
    .map((v) => String(v).trim()).filter(Boolean);
  // 名单/开关的取值统一交给下方热配置层（语义不变：空 = 不限制/关闭）


  // ---------- 状态持久化目录（历史/用量落盘，重启不丢） ----------
  const stateDir = config.stateDir || process.env.BOT_STATE_DIR || '/opt/koishi/state/deepseek';
  const readJson = (file, fallback) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return fallback; }
  };
  const writeJson = (file, data) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
    } catch (error) {
      logger.warn('[状态] 写入失败: ' + error.message);
    }
  };

  // ---------- 多轮上下文：按 会话+用户 维护，带磁盘持久化 ----------
  const maxTurns = Number(config.maxTurns ?? 8);
  const historiesFile = path.join(stateDir, 'histories.json');
  // JSON 往返做深拷贝避免共享引用；加载时裁剪防止历史文件膨胀
  const histories = new Map(Object.entries(readJson(historiesFile, {}))
    .map(([k, v]) => [k, JSON.parse(JSON.stringify(Array.isArray(v) ? v.slice(-32) : []))]));
  const getHistory = (key) => {
    if (!histories.has(key)) histories.set(key, []);
    return histories.get(key);
  };
  const pushHistory = (key, role, content, msgId, senderId) => {
    const list = getHistory(key);
    list.push({ role, content, msgId, senderId });
    const limit = Math.max(1, maxTurns) * 2;
    while (list.length > limit) list.shift();
  };
  let saveTimer = null;
  const scheduleSave = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeJson(historiesFile, Object.fromEntries(histories));
    }, 400);
  };

  // ---------- 群上下文：@前近期未响应消息缓冲 + 被@后的“活跃窗口”（免@连续对话） ----------
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

  // 频率闸：每分钟计数 + 最小间隔；超限直接丢弃并记日志（不排队堆积）
  const rateState = new Map();
  const allowSend = (key) => {
    const now = Date.now();
    const st = rateState.get(key) || { times: [], last: 0 };
    st.times = st.times.filter((t) => now - t < 60000);
    if (st.times.length >= ratePerMinute) {
      logger.warn(`[频率闸] ${key} 已达每分钟上限 ${ratePerMinute} 条，本条丢弃`);
      rateState.set(key, st);
      return false;
    }
    if (now - st.last < minIntervalMs) {
      logger.warn(`[频率闸] ${key} 距上条仅 ${now - st.last}ms(<${minIntervalMs}ms)，本条丢弃`);
      rateState.set(key, st);
      return false;
    }
    st.times.push(now);
    st.last = now;
    rateState.set(key, st);
    return true;
  };

  // ---------- token 用量统计（参考 qq-bridge：按日/按会话累计，官方价折算） ----------
  const priceIn = Number(process.env.BOT_PRICE_INPUT_PER_M ?? 1);   // 元 / 百万 input tokens
  const priceOut = Number(process.env.BOT_PRICE_OUTPUT_PER_M ?? 2); // 元 / 百万 output tokens（未命中缓存口径）
  const usageFile = path.join(stateDir, 'usage.json');
  const usage = readJson(usageFile, { days: {}, chats: {}, total: { input: 0, output: 0, calls: 0 } });
  const recordUsage = (chatKey, u) => {
    if (!u) return;
    const day = new Date().toISOString().slice(0, 10);
    if (!usage.days[day]) usage.days[day] = { input: 0, output: 0, cost: 0 };
    if (!usage.chats[chatKey]) usage.chats[chatKey] = { input: 0, output: 0, cost: 0, calls: 0 };
    const cost = ((u.prompt_tokens || 0) * priceIn + (u.completion_tokens || 0) * priceOut) / 1e6;
    usage.days[day].input += u.prompt_tokens || 0;
    usage.days[day].output += u.completion_tokens || 0;
    usage.days[day].cost += cost;
    usage.chats[chatKey].input += u.prompt_tokens || 0;
    usage.chats[chatKey].output += u.completion_tokens || 0;
    usage.chats[chatKey].cost += cost;
    usage.chats[chatKey].calls += 1;
    usage.total.input += u.prompt_tokens || 0;
    usage.total.output += u.completion_tokens || 0;
    usage.total.calls += 1;
    writeJson(usageFile, usage);
    logger.info(`[用量] ${chatKey} in=${u.prompt_tokens} out=${u.completion_tokens} 今日成本≈${usage.days[day].cost.toFixed(4)}元`);
  };
  const usageSummary = () => {
    const day = new Date().toISOString().slice(0, 10);
    const d = usage.days[day] || { input: 0, output: 0, cost: 0 };
    return `今日 in=${d.input} out=${d.output} ≈${d.cost.toFixed(3)}元；累计 ${usage.total.calls} 次调用 in=${usage.total.input} out=${usage.total.output}`;
  };

  // [playbook 10] QQ 不渲染 Markdown，发送前转纯文本
  const toPlainText = (text = '') => String(text)
    .replace(/```[a-zA-Z0-9]*\n?/g, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
    .replace(/^\s*[-*+]\s+/gm, '· ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  // 长文本分段发送，避免被 QQ 单条长度上限截断
  const splitText = (text, limit, maxParts) => {
    if (text.length <= limit) return [text];
    const parts = [];
    let rest = text;
    while (rest.length > limit && parts.length < maxParts - 1) {
      let cut = rest.lastIndexOf('\n', limit);
      if (cut < limit * 0.5) cut = limit;
      parts.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trim();
    }
    if (rest) parts.push(rest);
    return parts.filter(Boolean);
  };

// ---------- 热配置层：改 bot.env 即可秒级生效（无需重启） ----------
// 覆盖范围：白名单/黑名单/敏感词/管理员及开关/引用回复/拦截通知/系统提示词
const botEnvFile = config.botEnvFile || process.env.BOT_ENV_FILE || '/root/deploy/bot.env';
const hotIntervalMs = Math.max(2000, Number(config.hotIntervalMs ?? process.env.BOT_HOT_INTERVAL_MS ?? 5000));
const hotConfigKeys = [
  'BOT_ALLOWED_USERS', 'BOT_ALLOWED_GROUPS', 'BOT_BLACKLIST_USERS', 'BOT_BLACKLIST_GROUPS',
  'BOT_ADMIN_USERS', 'BOT_ADMIN_GROUP', 'BOT_SENSITIVE_WORDS', 'BOT_SENSITIVE_NOTIFY',
  'BOT_QUOTE_REPLY', 'BOT_SYSTEM_PROMPT', 'BOT_AT_ONLY',
  'BOT_ACTIVE_WINDOW_MS', 'BOT_GROUP_CONTEXT_MS', 'BOT_GROUP_CONTEXT_MAX',
  'BOT_MERGE_WINDOW_MS', 'BOT_MERGE_MAX_WAIT_MS',
  'BOT_IMAGE_ENABLED', 'BOT_IMAGE_MAX', 'BOT_IMAGE_TIMEOUT_MS',
];
const hot = {};
const parseBotEnv = (text) => {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"\s*$/);
    if (m) out[m[1]] = m[2].replace(/\\(["\\])/g, '$1').replace(/\r$/, '');
  }
  return out;
};
const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());
let lastHash = 0;
const hashText = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };
const applyHotConfig = () => {
  let parsed = {};
  let text = '';
  try { text = fs.readFileSync(botEnvFile, 'utf8'); parsed = parseBotEnv(text); } catch (error) {
    logger.warn('[热配置] 读取失败，沿用上一份: ' + error.message);
    return false;
  }
  lastHash = hashText(text);
  const fromConfig = {
    BOT_ALLOWED_USERS: config.allowedUsers, BOT_ALLOWED_GROUPS: config.allowedGroups,
    BOT_BLACKLIST_USERS: config.blacklistedUsers, BOT_BLACKLIST_GROUPS: config.blacklistedGroups,
    BOT_ADMIN_USERS: config.adminUsers, BOT_ADMIN_GROUP: config.adminGroup,
    BOT_SENSITIVE_WORDS: config.sensitiveWords, BOT_SENSITIVE_NOTIFY: config.sensitiveNotify,
    BOT_QUOTE_REPLY: config.quoteReply, BOT_SYSTEM_PROMPT: config.systemPrompt, BOT_AT_ONLY: config.atOnly,
    BOT_ACTIVE_WINDOW_MS: config.activeWindowMs, BOT_GROUP_CONTEXT_MS: config.groupContextMs, BOT_GROUP_CONTEXT_MAX: config.groupContextMax,
    BOT_MERGE_WINDOW_MS: config.mergeWindowMs, BOT_MERGE_MAX_WAIT_MS: config.mergeMaxWaitMs,
    BOT_IMAGE_ENABLED: config.imageEnabled, BOT_IMAGE_MAX: config.imageMax, BOT_IMAGE_TIMEOUT_MS: config.imageTimeoutMs,
  };
  const strOr = (v, d) => (v === undefined || v === null || v === '' ? d : String(v));
  const pick = (key) => strOr(parsed[key], strOr(fromConfig[key], strOr(process.env[key], '')));
  hot.allowedUsers = toIdSet(pick('BOT_ALLOWED_USERS'));
  hot.allowedGroups = toIdSet(pick('BOT_ALLOWED_GROUPS'));
  hot.blacklistedUsers = toIdSet(pick('BOT_BLACKLIST_USERS'));
  hot.blacklistedGroups = toIdSet(pick('BOT_BLACKLIST_GROUPS'));
  hot.adminUsers = toIdSet(pick('BOT_ADMIN_USERS'));
  hot.adminGroup = truthy(pick('BOT_ADMIN_GROUP'));
  hot.sensitiveWords = toWordList(pick('BOT_SENSITIVE_WORDS'));
  hot.sensitiveNotify = truthy(pick('BOT_SENSITIVE_NOTIFY'));
  hot.quoteReply = truthy(pick('BOT_QUOTE_REPLY'));
  hot.atOnly = truthy(pick('BOT_AT_ONLY'));
  hot.systemPrompt = pick('BOT_SYSTEM_PROMPT') || DEFAULT_SYSTEM_PROMPT;
  const numOr = (key, d) => { const v = pick(key); return v === '' ? d : Math.max(0, Number(v) || 0); };
  hot.activeWindowMs = numOr('BOT_ACTIVE_WINDOW_MS', DEFAULT_ACTIVE_WINDOW_MS);
  hot.groupContextMs = numOr('BOT_GROUP_CONTEXT_MS', DEFAULT_GROUP_CONTEXT_MS);
  hot.groupContextMax = Math.min(20, numOr('BOT_GROUP_CONTEXT_MAX', DEFAULT_GROUP_CONTEXT_MAX));
  // 连发合并：把短时间内到达的多条消息合成一轮统一回复
  hot.mergeWindowMs = numOr('BOT_MERGE_WINDOW_MS', DEFAULT_MERGE_WINDOW_MS);
  hot.mergeMaxWaitMs = Math.max(hot.mergeWindowMs, numOr('BOT_MERGE_MAX_WAIT_MS', DEFAULT_MERGE_MAX_WAIT_MS));
  // 图片识别：默认开（deepseek-flash 原生多模态）；改 bot.env 秒级生效
  hot.enableImage = pick('BOT_IMAGE_ENABLED') === '' ? true : truthy(pick('BOT_IMAGE_ENABLED')) || pick('BOT_IMAGE_ENABLED') === '1';
  hot.imageMax = Math.min(8, Math.max(1, numOr('BOT_IMAGE_MAX', 4) || 4));
  hot.imageTimeoutMs = Math.max(1000, numOr('BOT_IMAGE_TIMEOUT_MS', 15000) || 15000);
  return true;
};
applyHotConfig();
const maybeReloadHot = () => {
  try {
    const text = fs.readFileSync(botEnvFile, 'utf8');
    if (hashText(text) !== lastHash) {
      if (applyHotConfig()) logger.info('[热配置] 已重新加载 ' + botEnvFile);
    }
  } catch (error) { /* 文件被临时删除等，忽略 */ }
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

  // 启动时打印生效策略，便于日志核对（不含密钥）
  const describe = (set, emptyText) => (set ? `仅 ${[...set].join(',')}` : emptyText);
  const countText = (set) => (set ? `${set.size} 个` : '未设置');
  logger.info(`[白名单] 私聊 ${describe(hot.allowedUsers, '不限制(全部放行)')}；群聊 ${describe(hot.allowedGroups, '不限制(所有群，需 @)')}`);
  logger.info(`[管理员] ${describe(hot.adminUsers, '未设置(特权指令不可用)')}；生效范围 ${hot.adminGroup ? '私聊+群聊(@机器人)' : '仅私聊'}`);
  logger.info(`[黑名单] 用户 ${countText(hot.blacklistedUsers)}；群 ${countText(hot.blacklistedGroups)}（优先于白名单，命中即拒）`);
  logger.info(`[敏感词] ${hot.sensitiveWords.length ? hot.sensitiveWords.length + ' 个词已启用' : '未启用'}；引用回复 ${hot.quoteReply ? '开' : '关'}`);
  logger.info(`[上下文] @前群聊上下文 ${hot.groupContextMax > 0 ? `最近 ${hot.groupContextMax} 条/${Math.round(hot.groupContextMs / 1000)}s` : '关'}；@后免@活跃窗口 ${hot.activeWindowMs > 0 ? Math.round(hot.activeWindowMs / 1000) + 's' : '关'}`);
  logger.info(`[模式] ${hot.atOnly ? '严格@（群里只有被@才回应）' : '常规（@/关键词/引用/活跃窗口）'}；连发合并 ${hot.mergeWindowMs > 0 ? Math.round(hot.mergeWindowMs / 1000) + 's' : '关'}`);
  logger.info(`[状态] 目录 ${stateDir}（历史 ${histories.size} 个会话已恢复；${usageSummary()}）`);

  // ---------- 图片识别：deepseek-flash 原生多模态，但要求 OpenAI 兼容的 content 块数组 ----------
  // NapCat 图片 URL 常是内网地址，云端 API 拉不到 → 服务端下载后转 base64 data URL 内联（DeepSeek 按内容识别格式，不看 MIME）
  const IMAGE_MIME = (buf) => {
    if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
    if (buf.length >= 8 && buf.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'image/png';
    if (buf.length >= 6 && 'GIF8'.includes(buf.slice(0, 4).toString('ascii').slice(0, 4)) && buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
    if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
    return '';
  };
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
      const mime = IMAGE_MIME(buf);
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

  const normalizeText = (text = '') => String(text)
    .replace(/\[CQ:image[^\]]*\]/gi, '[图片]')
    .replace(/\[CQ:record[^\]]*\]/gi, '[语音]')
    .replace(/\[CQ:video[^\]]*\]/gi, '[视频]')
    .replace(/\[CQ:face[^\]]*\]/gi, '[表情]')
    .replace(/\[CQ:at[^\]]*\]/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

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

  // 发送路由：群聊必须走 send_group_msg，私聊走 send_private_msg。
  // 直接调 OneBot 接口，避免 adapter 把群聊误判成私聊(user_id=0)导致 retcode 1200。
  // [playbook 10] 发送前转纯文本 + 长文分段；超时归类为「投递未知」，不重发。
  // messageId：开启 quoteReply 后群聊首条回复引用原消息
  const sendReply = async (session, text, messageId) => {
    const bot = session.bot;
    const parts = splitText(toPlainText(text), splitLimit, splitMaxParts);
    if (parts.length > 1) {
      logger.info(`[分段] 回复较长，拆成 ${parts.length} 条发送`);
    }

    for (const [index, part] of parts.entries()) {
      const quote = index === 0 ? (hot.quoteReply ? messageId : undefined) : undefined;
      try {
        if (session.guildId) {
          const groupId = session.channelId || session.guildId;
          if (bot?.internal?.sendGroupMsg) {
            await bot.internal.sendGroupMsg(groupId, part, quote ? { message_id: quote } : undefined);
          } else {
            await bot.sendMessage(groupId, part, session.guildId);
          }
        } else if (bot?.internal?.sendPrivateMsg) {
          await bot.internal.sendPrivateMsg(session.userId, part);
        } else {
          await session.send(part);
        }
      } catch (error) {
        const message = String(error?.message || error);
        const unknown = /timeout|timed out|ETIMEDOUT|ECONNRESET|socket hang up/i.test(message);
        logger.error(
          `发送${unknown ? '结果未知(不重发)' : '失败'} guildId=${session.guildId || '-'} ` +
          `channelId=${session.channelId || '-'} userId=${session.userId || '-'}: ${message}`,
        );
        // 投递未知：对方可能已收到，重发会刷屏，直接结束
        if (unknown) return;
        throw error;
      }
    }
  };

  const callDeepSeek = async (messages) => {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        temperature: 0.7,
        stream: false,
      }),
      // 超时不重试：避免「其实已生成/已发送」时重复刷屏
      signal: AbortSignal.timeout(requestTimeoutMs),
    });

    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = payload?.error?.message || payload?.message || 'DeepSeek request failed';
      throw new Error(detail);
    }

    const text = payload?.choices?.[0]?.message?.content || payload?.choices?.[0]?.text || '';
    if (!text) throw new Error('DeepSeek returned an empty response');
    return { text: String(text).trim(), usage: payload?.usage };
  };

  // 管理员特权指令：私聊直接发；群里被 @ 时去掉 @ 后也能触发（未 @ 收不到，无需特判）
  // 指令不走频率闸、不进模型队列，立即响应
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
        `频率闸：${ratePerMinute} 条/分，间隔≥${minIntervalMs}ms`,
        `图片识别：${hot.enableImage ? `开（单条最多 ${hot.imageMax} 张，base64 内联）` : '关'}`,
        `热配置：${botEnvFile}（2~5 秒自动生效，无需重启）`,
        `当前人格：${hot.systemPrompt.slice(0, 40)}`,
      ];
      logger.info(`[管理员] ${userId} 查询状态`);
      sendReply(session, lines.join('\n')).catch(() => {});
      return true;
    }

    return false;
  };

  // ---------- 消息撤回：把被撤回的内容从对应会话历史里剔除 ----------
  // 私聊撤回：只能撤自己的消息，按 msgId 精确删。
  // 群撤回：事件里只有被撤消息 id，按 id 在所有会话历史里定位后剔除。
  ctx.on('message-recall', (session) => {
    try {
      const platform = session.platform || 'onebot';
      const messageId = session.messageId ? String(session.messageId) : '';
      if (!messageId) return;
      // 先按 msgId 在所有会话历史里定位并剔除（群撤回也能兜住）
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
  const hotTimer = setInterval(() => maybeReloadHot(), hotIntervalMs);
  if (typeof hotTimer.unref === 'function') hotTimer.unref();

  // 引用兜底：adapter 只在 reply 是首元素时才拉取，且 getMessage 失败会静默丢弃 quote。
  // 这里从残留的 [CQ:reply,id=xxx] 或未被移走的 reply 节点里取 id，自己调 get_msg 补拉一次。
  const findRawReplyId = (session) => {
    const m = String(session.original || session.content || '').match(/\[CQ:(reply|source)[^\]]*id=(-?\d+)/i);
    if (m) return m[2];
    // 兜底：直接遍历 OneBot 原始数组（若 adapter 未挪走 reply 节点）
    const els = session.elements || [];
    for (const el of els) {
      if (el?.type === 'reply' || el?.type === 'source') {
        const id = el.attrs?.id;
        if (id != null && String(id) !== '-1') return String(id);
      }
    }
    return '';
  };
  const fetchQuoteByMsgId = async (session, quoteId) => {
    try {
      const internal = session.bot?.internal;
      let data = null;
      if (internal?.getMsg) {
        data = await internal.getMsg(quoteId);
      } else if (internal?.request) {
        data = await internal.request('get_msg', { message_id: Number(quoteId) || quoteId });
      }
      if (!data) return null;
      // OneBot11 get_msg 返回 { message_id, sender, message, raw_message, ... }（array 或 string 格式）
      const text = data.raw_message
        || (Array.isArray(data.message) ? data.message.map((e) => (e.type === 'text' ? e.data?.text ?? '' : `[CQ:${e.type}]`)).join('') : String(data.message || ''));
      const sender = data.sender || {};
      return {
        text: normalizeText(text),
        userId: String(sender.user_id || data.user_id || ''),
        username: String(sender.card || sender.nickname || sender.name || ('QQ' + (sender.user_id || ''))).trim(),
      };
    } catch (error) {
      logger.warn(`[引用] get_msg(${quoteId}) 兜底拉取失败: ` + String(error.message || error).slice(0, 120));
      return null;
    }
  };

  // ---------- 连发合并：同一会话短时间内的多条消息合成一轮，统一交给模型一次回复 ----------
  const mergeBuckets = new Map(); // chatKey -> { items:[], firstTs, timer }

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
      const fetched = await fetchQuoteByMsgId(session, quoteItem.rawReplyId);
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
    const messages = [
      { role: 'system', content: hot.systemPrompt },
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
      logger.info(`DeepSeek 回复 [${chatKey}] 合并 ${items.length} 条 历史轮次=${Math.floor(getHistory(chatKey).length / 2)}`);
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

    // 一次性诊断：包 adapter 的 bot.getMessage，观察引用原文拉取是否被调用/成功/抛错
    const botObj = session.bot;
    if (botObj && botObj.constructor && !botObj.constructor.__quotePatched) {
      botObj.constructor.__quotePatched = true;
      const proto = Object.getPrototypeOf(botObj);
      const orig = proto.getMessage;
      if (typeof orig === 'function') {
        proto.getMessage = function patched(channel, messageId) {
          const buildQuote = (d) => {
            if (!d || (!d.raw_message && !d.message)) return null;
            const raw = d.raw_message || (Array.isArray(d.message)
              ? d.message.map((e) => (e && e.type === 'text' ? ((e.data && e.data.text) || '') : '[CQ:' + (e && e.type) + ']')).join('')
              : String(d.message || ''));
            const sender = d.sender || {};
            const uid = sender.user_id != null ? sender.user_id : d.user_id;
            return {
              messageId: String(d.message_id != null ? d.message_id : messageId),
              content: normalizeText(raw),
              userId: String(uid != null ? uid : ''),
              username: String(sender.card || sender.nickname || (uid != null ? 'QQ' + uid : '')).trim(),
            };
          };
          const wsGetMsg = (id) => new Promise((resolve) => {
            let socket;
            try { socket = new (require('ws'))('ws://127.0.0.1:3001'); } catch (_) { resolve(null); return; }
            const timer = setTimeout(() => { try { socket.close(); } catch (_) { /* 忽略 */ } resolve(null); }, 3000);
            socket.on('open', () => { try { socket.send(JSON.stringify({ action: 'get_msg', params: { message_id: Number(id) || id }, echo: 'quote' })); } catch (_) { resolve(null); } });
            socket.on('message', (buf) => {
              try {
                const j = JSON.parse(String(buf));
                if (j && j.echo === 'quote') { clearTimeout(timer); try { socket.close(); } catch (_) { /* 忽略 */ } resolve(j.data || null); }
              } catch (_) { /* 忽略非 JSON */ }
            });
            socket.on('error', () => { clearTimeout(timer); resolve(null); });
          });
          return (async () => {
            let r = null;
            try { r = await orig.call(this, channel, messageId); } catch (e) { logger.warn(`[引用诊断] getMessage(${channel},${messageId}) 抛错: ` + String(e && e.message || e).slice(0, 120)); }
            if (r) { logger.info(`[引用诊断] getMessage(${channel},${messageId}) => ok content=${String(r.content).slice(0, 40)}`); return r; }
            // 第一层兜底：直连 internal.getMsg 再拉一次
            let d = null;
            try { d = await this.internal.getMsg(messageId); } catch (_) { /* 忽略 */ }
            let q = buildQuote(d);
            if (q) { logger.info(`[引用] getMessage 兜底(internal)成功 id=${messageId} 内容=${q.content.slice(0, 40)}`); return q; }
            // 第二层兜底：临时开一条 WS 直接问 NapCat（get_msg 已验证可用）
            d = await wsGetMsg(messageId);
            q = buildQuote(d);
            if (q) { logger.info(`[引用] getMessage 兜底(ws)成功 id=${messageId} 内容=${q.content.slice(0, 40)}`); return q; }
            logger.warn(`[引用] getMessage 兜底均失败 id=${messageId}`);
            return r;
          })();
        };
        logger.info('[引用诊断] 已挂钩 getMessage');
      } else {
        logger.warn('[引用诊断] bot.getMessage 不存在，typeof=' + typeof orig);
      }
    }

    maybeReloadHot();

    const rawText = normalizeText(session.content || '');

    // 引用消息：OneBot adapter 会把被引用原文异步拉取并挂到 session.quote（含 content/userId/username）
    const quote = session.quote;
    const hasAdapterQuote = Boolean(quote && typeof quote.content === 'string');

    // 诊断日志：只要事件里带有引用节点就记一笔，方便判断是没收到还是拉取失败
    const rawReplyId = hasAdapterQuote ? '' : findRawReplyId(session);
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
