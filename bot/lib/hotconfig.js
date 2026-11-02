'use strict';

// ===== 热配置层：改 bot.env 秒级生效（无需重启）=====
// 从 plugins/deepseek.js 拆出。取值优先级保持不变：
//   bot.env 文件 > koishi.config.js 传入的 config > 进程环境变量 > 内置默认值
// ⚠ bot.env 的值行不能带行内注释，否则解析器匹配不到（正则要求整行 export K="v" 形式），
//   表现是“改了值却不热生效”，只能靠重启时的 process.env 兜底——10-30 踩过。

const fs = require('fs');

const DEFAULTS = {
  // 唤醒关键词（BOT_AT_ONLY=1 的严格@模式下不参与判定）
  TRIGGER_KEYWORDS: ['ai', 'bot', '机器人', 'deepseek', 'deepseek机器人'],
  SYSTEM_PROMPT: '你是一个友好的中文助手，回答简洁自然，适合在 QQ 聊天中使用。',
  ACTIVE_WINDOW_MS: 120000,   // 被@后免@连续对话时长（0=关闭）
  GROUP_CONTEXT_MS: 120000,   // @前上下文取多久以内的群消息（0=关闭）
  GROUP_CONTEXT_MAX: 6,       // @前上下文最多几条
  MERGE_WINDOW_MS: 2000,      // 连发合并：静默多久后统一回复（0=不合并）
  MERGE_MAX_WAIT_MS: 6000,    // 连发合并：从第一条起最长等待
  IMAGE_MAX: 4,
  IMAGE_TIMEOUT_MS: 15000,
  SEARCH_MAX_ROUNDS: 2,
  SEARCH_MAX_RESULTS: 5,
  SEARCH_TIMEOUT_MS: 8000,
  WEATHER_TIMEOUT_MS: 6000,
  REMINDER_MAX_PER_CHAT: 10,   // 单会话最多待触发提醒数
  REMINDER_MAX_TOTAL: 200,     // 全进程待触发提醒总量上限
  REMINDER_MAX_DELAY_S: 86400, // 最长可预约时长（秒）
  REMINDER_MAX_AT: 5,          // 到点一条提醒最多 @ 几个人（防刷群）
};

// 名单：空 = null（语义是“不限制”，不是“全部拒绝”）
const toIdSet = (value) => {
  if (!value) return null;
  const list = Array.isArray(value) ? value : String(value).split(',');
  const set = new Set(list.map((v) => String(v).trim()).filter(Boolean));
  return set.size ? set : null;
};
const toWordList = (value) => (Array.isArray(value) ? value : String(value || '').split(','))
  .map((v) => String(v).trim()).filter(Boolean);
const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').toLowerCase());

const parseBotEnv = (text) => {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = line.match(/^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)="((?:[^"\\]|\\.)*)"\s*$/);
    if (m) out[m[1]] = m[2].replace(/\\(["\\])/g, '$1').replace(/\r$/, '');
  }
  return out;
};

const hashText = (s) => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return h; };

// 机器人自己所在的城市（天气类提问用户没说城市时用默认城市回答）与开关都在这层
const HOT_KEYS = [
  'BOT_ALLOWED_USERS', 'BOT_ALLOWED_GROUPS', 'BOT_BLACKLIST_USERS', 'BOT_BLACKLIST_GROUPS',
  'BOT_ADMIN_USERS', 'BOT_ADMIN_GROUP', 'BOT_SENSITIVE_WORDS', 'BOT_SENSITIVE_NOTIFY',
  'BOT_QUOTE_REPLY', 'BOT_SYSTEM_PROMPT', 'BOT_AT_ONLY',
  'BOT_ACTIVE_WINDOW_MS', 'BOT_GROUP_CONTEXT_MS', 'BOT_GROUP_CONTEXT_MAX',
  'BOT_MERGE_WINDOW_MS', 'BOT_MERGE_MAX_WAIT_MS',
  'BOT_IMAGE_ENABLED', 'BOT_IMAGE_MAX', 'BOT_IMAGE_TIMEOUT_MS',
  'BOT_SEARCH_ENABLED', 'BOT_SEARCH_MAX_ROUNDS', 'BOT_SEARCH_MAX_RESULTS', 'BOT_SEARCH_TIMEOUT_MS',
  'BOT_WEATHER_ENABLED', 'BOT_WEATHER_DEFAULT_CITY', 'BOT_WEATHER_TIMEOUT_MS',
  'BOT_REMINDER_ENABLED', 'BOT_REMINDER_MAX_PER_CHAT', 'BOT_REMINDER_MAX_TOTAL',
  'BOT_REMINDER_MAX_DELAY_S', 'BOT_REMINDER_AT_REQUESTER', 'BOT_REMINDER_MAX_AT',
  'BOT_REMINDER_EXEC',
];

const create = ({ config, logger, botEnvFile }) => {
  const hot = {};
  let lastHash = 0;

  const apply = () => {
    let parsed = {};
    let text = '';
    try {
      text = fs.readFileSync(botEnvFile, 'utf8');
      parsed = parseBotEnv(text);
    } catch (error) {
      logger.warn('[热配置] 读取失败，沿用上一份: ' + error.message);
      return false;
    }
    lastHash = hashText(text);
    // bot.env 里没有该项时，回落到 koishi.config.js 的 config，再回落到进程环境变量
    const fromConfig = {
      BOT_ALLOWED_USERS: config.allowedUsers, BOT_ALLOWED_GROUPS: config.allowedGroups,
      BOT_BLACKLIST_USERS: config.blacklistedUsers, BOT_BLACKLIST_GROUPS: config.blacklistedGroups,
      BOT_ADMIN_USERS: config.adminUsers, BOT_ADMIN_GROUP: config.adminGroup,
      BOT_SENSITIVE_WORDS: config.sensitiveWords, BOT_SENSITIVE_NOTIFY: config.sensitiveNotify,
      BOT_QUOTE_REPLY: config.quoteReply, BOT_SYSTEM_PROMPT: config.systemPrompt, BOT_AT_ONLY: config.atOnly,
      BOT_ACTIVE_WINDOW_MS: config.activeWindowMs, BOT_GROUP_CONTEXT_MS: config.groupContextMs,
      BOT_GROUP_CONTEXT_MAX: config.groupContextMax,
      BOT_MERGE_WINDOW_MS: config.mergeWindowMs, BOT_MERGE_MAX_WAIT_MS: config.mergeMaxWaitMs,
      BOT_IMAGE_ENABLED: config.imageEnabled, BOT_IMAGE_MAX: config.imageMax, BOT_IMAGE_TIMEOUT_MS: config.imageTimeoutMs,
      BOT_SEARCH_ENABLED: config.searchEnabled, BOT_SEARCH_MAX_ROUNDS: config.searchMaxRounds,
      BOT_SEARCH_MAX_RESULTS: config.searchMaxResults, BOT_SEARCH_TIMEOUT_MS: config.searchTimeoutMs,
      BOT_WEATHER_ENABLED: config.weatherEnabled, BOT_WEATHER_DEFAULT_CITY: config.weatherDefaultCity,
      BOT_WEATHER_TIMEOUT_MS: config.weatherTimeoutMs,
      BOT_REMINDER_ENABLED: config.reminderEnabled, BOT_REMINDER_MAX_PER_CHAT: config.reminderMaxPerChat,
      BOT_REMINDER_MAX_TOTAL: config.reminderMaxTotal, BOT_REMINDER_MAX_DELAY_S: config.reminderMaxDelayS,
      BOT_REMINDER_AT_REQUESTER: config.reminderAtRequester, BOT_REMINDER_MAX_AT: config.reminderMaxAt,
      BOT_REMINDER_EXEC: config.reminderExec,
    };
    const strOr = (v, d) => (v === undefined || v === null || v === '' ? d : String(v));
    const pick = (key) => strOr(parsed[key], strOr(fromConfig[key], strOr(process.env[key], '')));
    const numOr = (key, d) => { const v = pick(key); return v === '' ? d : Math.max(0, Number(v) || 0); };

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
    hot.systemPrompt = pick('BOT_SYSTEM_PROMPT') || DEFAULTS.SYSTEM_PROMPT;
    hot.activeWindowMs = numOr('BOT_ACTIVE_WINDOW_MS', DEFAULTS.ACTIVE_WINDOW_MS);
    hot.groupContextMs = numOr('BOT_GROUP_CONTEXT_MS', DEFAULTS.GROUP_CONTEXT_MS);
    hot.groupContextMax = Math.min(20, numOr('BOT_GROUP_CONTEXT_MAX', DEFAULTS.GROUP_CONTEXT_MAX));
    // 连发合并：把短时间内到达的多条消息合成一轮统一回复
    hot.mergeWindowMs = numOr('BOT_MERGE_WINDOW_MS', DEFAULTS.MERGE_WINDOW_MS);
    hot.mergeMaxWaitMs = Math.max(hot.mergeWindowMs, numOr('BOT_MERGE_MAX_WAIT_MS', DEFAULTS.MERGE_MAX_WAIT_MS));
    // 图片识别：默认开（deepseek-flash 原生多模态）
    hot.enableImage = pick('BOT_IMAGE_ENABLED') === '' ? true : truthy(pick('BOT_IMAGE_ENABLED')) || pick('BOT_IMAGE_ENABLED') === '1';
    hot.imageMax = Math.min(8, Math.max(1, numOr('BOT_IMAGE_MAX', DEFAULTS.IMAGE_MAX) || DEFAULTS.IMAGE_MAX));
    hot.imageTimeoutMs = Math.max(1000, numOr('BOT_IMAGE_TIMEOUT_MS', DEFAULTS.IMAGE_TIMEOUT_MS) || DEFAULTS.IMAGE_TIMEOUT_MS);
    // 联网搜索（Bing 免 key + function calling）：模型自己判断要不要搜。
    // ⚠ 关掉后 system prompt 的能力边界必须同步变化，见 lib/tools.js 的 describeCapabilities。
    hot.searchEnabled = pick('BOT_SEARCH_ENABLED') === '' ? true : truthy(pick('BOT_SEARCH_ENABLED'));
    hot.searchMaxRounds = Math.min(3, Math.max(1, numOr('BOT_SEARCH_MAX_ROUNDS', DEFAULTS.SEARCH_MAX_ROUNDS) || DEFAULTS.SEARCH_MAX_ROUNDS));
    hot.searchMaxResults = Math.min(8, Math.max(1, numOr('BOT_SEARCH_MAX_RESULTS', DEFAULTS.SEARCH_MAX_RESULTS) || DEFAULTS.SEARCH_MAX_RESULTS));
    hot.searchTimeoutMs = Math.max(2000, numOr('BOT_SEARCH_TIMEOUT_MS', DEFAULTS.SEARCH_TIMEOUT_MS) || DEFAULTS.SEARCH_TIMEOUT_MS);
    // 天气（Open-Meteo 免 key，见 lib/weather.js）：跟随搜索总开关之外可单独关，默认开
    hot.weatherEnabled = pick('BOT_WEATHER_ENABLED') === '' ? true : truthy(pick('BOT_WEATHER_ENABLED'));
    hot.weatherDefaultCity = pick('BOT_WEATHER_DEFAULT_CITY').trim();
    hot.weatherTimeoutMs = Math.max(2000, numOr('BOT_WEATHER_TIMEOUT_MS', DEFAULTS.WEATHER_TIMEOUT_MS) || DEFAULTS.WEATHER_TIMEOUT_MS);
    // 定时提醒（见 lib/timers.js）：默认开。关掉时 lib/tools.js 的能力边界必须同步变化，
    // 否则模型会口头答应“到点叫你”却根本没建表。
    hot.reminderEnabled = pick('BOT_REMINDER_ENABLED') === '' ? true : truthy(pick('BOT_REMINDER_ENABLED'));
    hot.reminderMaxPerChat = Math.min(50, Math.max(1, numOr('BOT_REMINDER_MAX_PER_CHAT', DEFAULTS.REMINDER_MAX_PER_CHAT) || DEFAULTS.REMINDER_MAX_PER_CHAT));
    hot.reminderMaxTotal = Math.min(1000, Math.max(10, numOr('BOT_REMINDER_MAX_TOTAL', DEFAULTS.REMINDER_MAX_TOTAL) || DEFAULTS.REMINDER_MAX_TOTAL));
    hot.reminderMaxDelayS = Math.min(7 * 24 * 3600, Math.max(60, numOr('BOT_REMINDER_MAX_DELAY_S', DEFAULTS.REMINDER_MAX_DELAY_S) || DEFAULTS.REMINDER_MAX_DELAY_S));
    // 到点是否 @ 设提醒的人（仅群聊生效；@ 别人由模型的 at_user_ids 显式指定）
    hot.reminderAtRequester = pick('BOT_REMINDER_AT_REQUESTER') === '' ? true : truthy(pick('BOT_REMINDER_AT_REQUESTER'));
    hot.reminderMaxAt = Math.min(10, Math.max(0, numOr('BOT_REMINDER_MAX_AT', DEFAULTS.REMINDER_MAX_AT)));
    // 到点是否走「完整延迟代理轮」（重跑模型+工具真的去执行任务）；关掉则退回便宜的固定文案投递。
    // 默认开（与 reminderEnabled 同口径：空=开）。
    hot.reminderExec = pick('BOT_REMINDER_EXEC') === '' ? true : truthy(pick('BOT_REMINDER_EXEC'));
    return true;
  };

  const maybeReload = () => {
    try {
      const text = fs.readFileSync(botEnvFile, 'utf8');
      if (hashText(text) !== lastHash) {
        if (apply()) logger.info('[热配置] 已重新加载 ' + botEnvFile);
      }
    } catch (error) { /* 文件被临时删除等，忽略 */ }
  };

  apply();
  return { hot, apply, maybeReload, HOT_KEYS };
};

module.exports = { create, DEFAULTS, HOT_KEYS, toIdSet, toWordList, truthy, parseBotEnv };
