'use strict';

// ===== 热配置层：改 bot.env 秒级生效（无需重启）=====
// 从 plugins/deepseek.js 拆出。取值优先级保持不变：
//   bot.env 文件 > koishi.config.js 传入的 config > 进程环境变量 > 内置默认值
// ⚠ bot.env 的值行不能带行内注释，否则解析器匹配不到（正则要求整行 export K="v" 形式），
//   表现是“改了值却不热生效”，只能靠重启时的 process.env 兜底——10-30 踩过。

const fs = require('fs');
const persona = require('./persona');

const DEFAULTS = {
  // 唤醒关键词（BOT_AT_ONLY=1 的严格@模式下不参与判定）
  TRIGGER_KEYWORDS: ['ai', 'bot', '机器人', 'deepseek', 'deepseek机器人'],
  // 内置默认人格来自 lib/persona.js 的注册表（多行、带换行，塞不进单行 bot.env）；
  // 这里取“代码默认人格”的 prompt 作为兼容默认值，prod 里 BOT_SYSTEM_PROMPT 留空即按激活人格回落。
  SYSTEM_PROMPT: persona.systemPromptOf(persona.DEFAULT_PERSONA_ID),
  // 默认激活人格 id（代码级）；要用 bot.env 热切写 BOT_PERSONA=<id>。
  PERSONA: persona.DEFAULT_PERSONA_ID,
  // few-shot 示例注入开关（各人格自带 fewShot，见 lib/persona.js）：默认开，关掉则完全不注入示例轮。
  FEWSHOT_ENABLED: true,
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
  // 大型任务校验（纯对话级轻量拦截，见 plugins/deepseek.js flushBucket）：
  //   不看字数，看「构建意图」——命中【动作+对象】组合（如“编写…程序”“做个…游戏”），
  //   或命中整段大工程短语（如“整个项目”“从零开始”），就玩笑回绝、不进模型，避免把 token 烧穿。
  //   动作/对象/短语三张表都可热改；误伤时用户换个说法或关掉 BOT_BIGTASK_GUARD 即可。
  BIGTASK_ACTIONS: ['写', '编写', '开发', '实现', '搭建', '生成', '制作', '做', '构建', '造'],
  BIGTASK_OBJECTS: ['程序', '游戏', '软件', '系统', '网站', '网页', 'app', '小程序', '客户端', '后台', '平台', '框架', '引擎', '源码', '源代码', '脚本', '机器人', '外挂', '操作系统', '数据库'],
  BIGTASK_KEYWORDS: ['整个项目', '一整个项目', '一整套', '全套系统', '一套完整', '完整的系统', '完整的软件', '从零开始', '从0到1', '重构整个'],
  BIGTASK_REPLY: '你在开玩笑吗，做不到哈哈',
  // 转发（合并转发的聊天记录卡片）内容展开（见 lib/forward.js）：默认开。
  //   收到 type=forward 段时，拉子消息渲染成可读文本喂给模型；嵌套深度/节点数/总字数都有上限防爆 token。
  FORWARD_ENABLED: true,
  FORWARD_MAX_NODES: 60,   // 单条转发最多展开多少条子消息
  FORWARD_MAX_CHARS: 4000, // 渲染文本块总字数上限
  FORWARD_MAX_DEPTH: 2,    // 嵌套转发递归深度上限
  // 回复长度天花板兜底（见 plugins/deepseek.js 模型调用 max_tokens）：主要靠人格 prompt+few-shot 收短，
  //   这里只是一个宽松硬上限，防止极端情况下刷长篇；默认 300（足够工具调用+正常长答），设 0=不下发（不限制）。
  MAX_TOKENS: 300,
  // 非纯文本消息段（音乐/分享/文件/视频/卡片/未知类型…）备注注入 + 未知段遥测（见 lib/segments.js）：默认开。
  //   关掉则不再向模型描述“卡片/媒体”段、也不打遥测日志（但 @/图片/语音等既有行为不受影响）。
  SEG_NOTES: true,
  // 文生图（OpenAI 兼容 /images/generations，见 lib/imagegen.js + lib/tools.js 的 generate_image）：
  //   默认关（要外部 key、且花额度，必须显式开）。开且配齐 base/model/key 才下发工具，否则能力边界自动说“画不了”。
  IMAGEGEN_ENABLED: false,
  IMAGEGEN_BASE: '',
  IMAGEGEN_MODEL: '',
  IMAGEGEN_SIZE: '',          // 空=不下发 size，走服务端默认（万相默认 1024*1024）
  IMAGEGEN_TIMEOUT_MS: 90000, // 生图慢，给足超时（默认 90s）
  IMAGEGEN_MAX_PER_DAY: 30,   // 全局每日上限（0=不限）
  IMAGEGEN_MAX_PER_CHAT: 5,   // 单会话每日上限（0=不限）
  PRICE_IMAGE_PER: 0,         // 生图单价（元/张）：与 token 记账同级的独立账本；0=只记张数不计费
  IMAGE_SEARCH_ENABLED: false, // 关键词搜图（首选拿图方式，生图为兜底）；开了才下发 search_image
  IMAGE_SEARCH_MAX_CANDIDATES: 5, // 一次搜几张候选图
  IMAGE_SEARCH_VERIFY_MAX: 3,     // 最多逐张视觉核对几张（都不契合→生图兜底）
  READURL_ENABLED: false,         // 读网页正文（read_url）：默认关（会对任意 URL 发起出网请求，需显式开）
  READURL_MAX_CHARS: 4000,        // 抽出的正文最多回给模型多少字符（防烧 token）
  READURL_TIMEOUT_MS: 12000,      // 打开单个网页的超时
  // 群聊「免@活跃窗口」意图识别（见 plugins/deepseek.js flushBucket）：只作用于被@后 2 分钟窗口内的续话消息，
  //   判这条到底是不是在对机器人说。@/引用/关键词等明确信号不拦。默认开（空=开）。
  //   ①命中 NOT_MINE_WORDS 明确「没跟你说话」类短语 → 结束活跃窗口 + 回 NOT_MINE_REPLY 一句后静默（需重新@唤醒）；
  //   ②AI 语义判否 / 拿不准 / 异常 → 偏向沉默：不回，但保留窗口（只有明确短语才结束窗口）。
  REPLY_INTENT_CHECK: true,
  NOT_MINE_WORDS: ['没跟你说话', '不是跟你说话', '没跟你说', '不是跟你说', '没说你', '不是在说你', '不用你回', '不用回', '别接', '跟你没关系', '不是对你说的', '没对你讲'],
  NOT_MINE_REPLY: '好的',
  INTENT_TIMEOUT_MS: 6000,        // 意图判定这一发小请求的超时（超时即偏向沉默）
  // 引用消息周边对话检索（见 lib/quote.js retrieveAroundQuote）：仅群聊、且本轮存在引用消息时生效。
  //   群历史按锚点双向分页取（网关动作 get_group_msg_history：message_id + count + reverse_order，
  //   true=锚点及更旧、false=锚点及更新，两次并发后按 message_id 去重），再按「滑动窗口（断档截断）」圈时段：沿引用发送人自己的发言双向
  //   推进，他一超过 CHAIN_MS（默认 10 分钟）没再说话就在那儿截断，得到 [y0,y] 后首尾各垫一个 CHAIN_MS，
  //   即窗口 [y0-gap, y+gap]，并用 MAX_MS 封顶单侧（默认 15 分钟、总跨度 30 分钟）。
  //   时段内的讨论对象先按结构信号定（引用过锚点发送人的消息 / @ 过他 / 紧接其发言接话的人），
  //   一条都没命中且确有候选人时才交给 AI 补判一次；命中者的发言一并保留，
  //   拼成背景块喂模型（标注素材非指令），上限 MAX_CHARS 字、超限时优先保留靠近锚点的部分。
  QUOTE_CONTEXT_ENABLED: true,
  QUOTE_CONTEXT_CHAIN_MS: 600000,  // 断档阈值 gap：发送人超过该时长没再说话就截断窗口，同时是首尾垫的宽度
  QUOTE_CONTEXT_MAX_MS: 900000,    // 硬边界：距锚点超过该值的消息一律不要（单侧 15 分钟 = 总跨度 30 分钟）
  QUOTE_CONTEXT_MAX_CHARS: 1500,   // 背景块喂模型的总字数上限
  //   存档字数：背景块原本只喂当轮就扔，下一轮追问「这事前因后果」时模型只看到一句引用
  //   （11-04 13:12 实测：13:11 检索到 6 行背景答对了，13:12 追问就答「我只看得到一句引用」）。
  //   所以按这个字数再存一份压缩版进会话历史（靠近锚点的优先留）；0 = 不沉淀，维持老行为。
  QUOTE_CONTEXT_HISTORY_CHARS: 400,
  QUOTE_CONTEXT_FETCH_COUNT: 60,   // 单侧条数（锚点前/锚点后各拉这么多）：实测单侧 200 条要走 ~14s（撞 6s 超时），60 条约 2.3s
  // 网关动作调用（lib/onebot.js callApi）：一次调用的总预算，与「连不上」时的重试间隔。
  //   SnowLuma 那侧的 QQ 会话会周期性重登，每次把 3001 关掉 5~18 秒（11-04 实测：发作时每 1~5 分钟一次），
  //   检索撞在窗口里就会“取不到历史”，所以预算内要等重连。预算 ≥ 断窗长度才盖得住：
  //   断连变凶就调大 BOT_GW_TIMEOUT_MS（改完热生效、不用重发版），代价是撞窗时那条回复多等几秒。
  GATEWAY_TIMEOUT_MS: 6000,         // 总预算（1000~20000）；三档降级共用，不是每档各等一遍
                                    // 线上按实测断窗分位取 12000（p75=13s，盖 73% 的窗），见 config/bot.env.example
  GATEWAY_RETRY_INTERVAL_MS: 1200,  // 离线重试间隔；0=关掉重试（只想快速失败时用）
  IMAGEGEN_PROTOCOL: 'dashscope', // dashscope（百炼原生，wan/qwen 实测同步可用）| openai（标准 /images/generations）
  IMAGEGEN_ENDPOINT: '',          // 仅 dashscope 需覆盖时填完整 URL；空=由 base 推 origin 拼原生路径
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
  'BOT_QUOTE_REPLY', 'BOT_SYSTEM_PROMPT', 'BOT_PERSONA', 'BOT_FEWSHOT_ENABLED', 'BOT_AT_ONLY',
  'BOT_ACTIVE_WINDOW_MS', 'BOT_GROUP_CONTEXT_MS', 'BOT_GROUP_CONTEXT_MAX',
  'BOT_MERGE_WINDOW_MS', 'BOT_MERGE_MAX_WAIT_MS',
  'BOT_IMAGE_ENABLED', 'BOT_IMAGE_MAX', 'BOT_IMAGE_TIMEOUT_MS',
  'BOT_SEARCH_ENABLED', 'BOT_SEARCH_MAX_ROUNDS', 'BOT_SEARCH_MAX_RESULTS', 'BOT_SEARCH_TIMEOUT_MS',
  'BOT_WEATHER_ENABLED', 'BOT_WEATHER_DEFAULT_CITY', 'BOT_WEATHER_TIMEOUT_MS',
  'BOT_REMINDER_ENABLED', 'BOT_REMINDER_MAX_PER_CHAT', 'BOT_REMINDER_MAX_TOTAL',
  'BOT_REMINDER_MAX_DELAY_S', 'BOT_REMINDER_AT_REQUESTER', 'BOT_REMINDER_MAX_AT',
  'BOT_REMINDER_EXEC',
  'BOT_BIGTASK_GUARD', 'BOT_BIGTASK_ACTIONS', 'BOT_BIGTASK_OBJECTS', 'BOT_BIGTASK_KEYWORDS', 'BOT_BIGTASK_REPLY',
  'BOT_FORWARD_ENABLED', 'BOT_FORWARD_MAX_NODES', 'BOT_FORWARD_MAX_CHARS', 'BOT_FORWARD_MAX_DEPTH',
  'BOT_MAX_TOKENS', 'BOT_SEG_NOTES',
  'BOT_IMAGEGEN_ENABLED', 'BOT_IMAGEGEN_BASE', 'BOT_IMAGEGEN_MODEL', 'BOT_IMAGEGEN_KEY',
  'BOT_IMAGEGEN_SIZE', 'BOT_IMAGEGEN_TIMEOUT_MS', 'BOT_IMAGEGEN_MAX_PER_DAY', 'BOT_IMAGEGEN_MAX_PER_CHAT',
  'BOT_IMAGEGEN_PROTOCOL', 'BOT_IMAGEGEN_ENDPOINT',
  'BOT_PRICE_IMAGE_PER',
  'BOT_IMAGE_SEARCH_ENABLED', 'BOT_IMAGE_SEARCH_MAX_CANDIDATES', 'BOT_IMAGE_SEARCH_VERIFY_MAX',
  'BOT_READURL_ENABLED', 'BOT_READURL_MAX_CHARS', 'BOT_READURL_TIMEOUT_MS',
  'BOT_REPLY_INTENT_CHECK', 'BOT_NOT_MINE_WORDS', 'BOT_NOT_MINE_REPLY', 'BOT_INTENT_TIMEOUT_MS',
  'BOT_QUOTE_CONTEXT_ENABLED', 'BOT_QUOTE_CONTEXT_CHAIN_MS', 'BOT_QUOTE_CONTEXT_MAX_MS',
  'BOT_QUOTE_CONTEXT_MAX_CHARS', 'BOT_QUOTE_CONTEXT_HISTORY_CHARS', 'BOT_QUOTE_CONTEXT_FETCH_COUNT',
  'BOT_GW_TIMEOUT_MS', 'BOT_GW_RETRY_INTERVAL_MS',
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
      BOT_QUOTE_REPLY: config.quoteReply, BOT_SYSTEM_PROMPT: config.systemPrompt, BOT_PERSONA: config.persona, BOT_AT_ONLY: config.atOnly,
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
      BOT_BIGTASK_GUARD: config.bigTaskGuard, BOT_BIGTASK_ACTIONS: config.bigTaskActions,
      BOT_BIGTASK_OBJECTS: config.bigTaskObjects, BOT_BIGTASK_KEYWORDS: config.bigTaskKeywords, BOT_BIGTASK_REPLY: config.bigTaskReply,
      BOT_FORWARD_ENABLED: config.forwardEnabled, BOT_FORWARD_MAX_NODES: config.forwardMaxNodes,
      BOT_FORWARD_MAX_CHARS: config.forwardMaxChars, BOT_FORWARD_MAX_DEPTH: config.forwardMaxDepth,
      BOT_MAX_TOKENS: config.maxTokens,
      BOT_SEG_NOTES: config.segNotes,
      BOT_IMAGEGEN_ENABLED: config.imagegenEnabled, BOT_IMAGEGEN_BASE: config.imagegenBase,
      BOT_IMAGEGEN_MODEL: config.imagegenModel, BOT_IMAGEGEN_KEY: config.imagegenKey,
      BOT_IMAGEGEN_SIZE: config.imagegenSize, BOT_IMAGEGEN_TIMEOUT_MS: config.imagegenTimeoutMs,
      BOT_IMAGEGEN_MAX_PER_DAY: config.imagegenMaxPerDay, BOT_IMAGEGEN_MAX_PER_CHAT: config.imagegenMaxPerChat,
      BOT_IMAGEGEN_PROTOCOL: config.imagegenProtocol, BOT_IMAGEGEN_ENDPOINT: config.imagegenEndpoint,
      BOT_PRICE_IMAGE_PER: config.priceImagePer,
      BOT_IMAGE_SEARCH_ENABLED: config.imageSearchEnabled, BOT_IMAGE_SEARCH_MAX_CANDIDATES: config.imageSearchMaxCandidates, BOT_IMAGE_SEARCH_VERIFY_MAX: config.imageSearchVerifyMax,
      BOT_READURL_ENABLED: config.readUrlEnabled, BOT_READURL_MAX_CHARS: config.readUrlMaxChars, BOT_READURL_TIMEOUT_MS: config.readUrlTimeoutMs,
      BOT_REPLY_INTENT_CHECK: config.replyIntentCheck, BOT_NOT_MINE_WORDS: config.notMineWords, BOT_NOT_MINE_REPLY: config.notMineReply, BOT_INTENT_TIMEOUT_MS: config.intentTimeoutMs,
      BOT_QUOTE_CONTEXT_ENABLED: config.quoteContextEnabled, BOT_QUOTE_CONTEXT_CHAIN_MS: config.quoteContextChainMs,
      BOT_QUOTE_CONTEXT_MAX_MS: config.quoteContextMaxMs, BOT_QUOTE_CONTEXT_MAX_CHARS: config.quoteContextMaxChars,
      BOT_QUOTE_CONTEXT_HISTORY_CHARS: config.quoteContextHistoryChars,
      BOT_QUOTE_CONTEXT_FETCH_COUNT: config.quoteContextFetchCount,
      BOT_GW_TIMEOUT_MS: config.gatewayTimeoutMs, BOT_GW_RETRY_INTERVAL_MS: config.gatewayRetryIntervalMs,
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
    // 人格切换：BOT_PERSONA 选激活人格（非法值回落到代码默认）；必须在 systemPrompt 之前定好。
    hot.personaId = persona.resolveId(pick('BOT_PERSONA'));
    // 人格 prompt：BOT_SYSTEM_PROMPT 显式自定义（单行）优先；留空则用激活人格自带的多行 prompt。
    hot.systemPrompt = pick('BOT_SYSTEM_PROMPT') || persona.systemPromptOf(hot.personaId);
    // few-shot 注入：默认开（空=开），与其他布尔项同口径。
    hot.fewShotEnabled = pick('BOT_FEWSHOT_ENABLED') === '' ? true : truthy(pick('BOT_FEWSHOT_ENABLED'));
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
    // 大型任务校验：默认开（空=开）。不看字数，只看「构建意图」（动作+对象 / 大工程短语），命中即回绝、不进模型省 token。
    // 关掉后一切请求照常进模型；误伤时让用户换个说法或管理员关掉此闸即可。
    hot.bigTaskGuard = pick('BOT_BIGTASK_GUARD') === '' ? true : truthy(pick('BOT_BIGTASK_GUARD'));
    hot.bigTaskActions = pick('BOT_BIGTASK_ACTIONS') === '' ? DEFAULTS.BIGTASK_ACTIONS.slice() : toWordList(pick('BOT_BIGTASK_ACTIONS'));
    hot.bigTaskObjects = pick('BOT_BIGTASK_OBJECTS') === '' ? DEFAULTS.BIGTASK_OBJECTS.slice() : toWordList(pick('BOT_BIGTASK_OBJECTS'));
    hot.bigTaskKeywords = pick('BOT_BIGTASK_KEYWORDS') === '' ? DEFAULTS.BIGTASK_KEYWORDS.slice() : toWordList(pick('BOT_BIGTASK_KEYWORDS'));
    hot.bigTaskReply = pick('BOT_BIGTASK_REPLY') || DEFAULTS.BIGTASK_REPLY;
    // 转发内容展开：默认开（空=开）；三个上限都钳在合理区间，避免把 token 烧穿。
    hot.forwardEnabled = pick('BOT_FORWARD_ENABLED') === '' ? true : truthy(pick('BOT_FORWARD_ENABLED'));
    hot.forwardMaxNodes = Math.min(200, Math.max(1, numOr('BOT_FORWARD_MAX_NODES', DEFAULTS.FORWARD_MAX_NODES) || DEFAULTS.FORWARD_MAX_NODES));
    hot.forwardMaxChars = Math.max(500, numOr('BOT_FORWARD_MAX_CHARS', DEFAULTS.FORWARD_MAX_CHARS) || DEFAULTS.FORWARD_MAX_CHARS);
    hot.forwardMaxDepth = Math.min(4, Math.max(1, numOr('BOT_FORWARD_MAX_DEPTH', DEFAULTS.FORWARD_MAX_DEPTH) || DEFAULTS.FORWARD_MAX_DEPTH));
    // 回复长度天花板：0=不限制（不下发 max_tokens）；否则作为硬上限。故意给宽松值，主要靠 prompt+few-shot 收短。
    hot.maxTokens = numOr('BOT_MAX_TOKENS', DEFAULTS.MAX_TOKENS);
    // 非文本段备注+遥测开关：默认开（空=开）。
    hot.segNotes = pick('BOT_SEG_NOTES') === '' ? true : truthy(pick('BOT_SEG_NOTES'));
    // 生图：默认关（空=false，与其他默认开的项不同：要外部 key+花额度，必须显式开）。
    //   base/model/key 任一缺失 → tools.imagegenActive=false → 不下发工具且能力边界说“画不了”。
    hot.imagegenEnabled = truthy(pick('BOT_IMAGEGEN_ENABLED'));
    hot.imagegenBase = pick('BOT_IMAGEGEN_BASE').trim();
    hot.imagegenModel = pick('BOT_IMAGEGEN_MODEL').trim();
    hot.imagegenKey = pick('BOT_IMAGEGEN_KEY').trim();
    hot.imagegenSize = pick('BOT_IMAGEGEN_SIZE').trim();
    hot.imagegenTimeoutMs = Math.max(5000, numOr('BOT_IMAGEGEN_TIMEOUT_MS', DEFAULTS.IMAGEGEN_TIMEOUT_MS) || DEFAULTS.IMAGEGEN_TIMEOUT_MS);
    hot.imagegenMaxPerDay = numOr('BOT_IMAGEGEN_MAX_PER_DAY', DEFAULTS.IMAGEGEN_MAX_PER_DAY);
    hot.imagegenMaxPerChat = numOr('BOT_IMAGEGEN_MAX_PER_CHAT', DEFAULTS.IMAGEGEN_MAX_PER_CHAT);
    hot.imagegenProtocol = (pick('BOT_IMAGEGEN_PROTOCOL').trim() || DEFAULTS.IMAGEGEN_PROTOCOL).toLowerCase();
    hot.imagegenEndpoint = pick('BOT_IMAGEGEN_ENDPOINT').trim();
    hot.priceImagePer = Math.max(0, numOr('BOT_PRICE_IMAGE_PER', DEFAULTS.PRICE_IMAGE_PER));
    hot.imageSearchEnabled = truthy(pick('BOT_IMAGE_SEARCH_ENABLED'));
    hot.imageSearchMaxCandidates = Math.max(1, numOr('BOT_IMAGE_SEARCH_MAX_CANDIDATES', DEFAULTS.IMAGE_SEARCH_MAX_CANDIDATES));
    hot.imageSearchVerifyMax = Math.max(1, numOr('BOT_IMAGE_SEARCH_VERIFY_MAX', DEFAULTS.IMAGE_SEARCH_VERIFY_MAX));
    // 读网页正文（read_url，见 lib/readpage.js）：默认关（出网打任意 URL 的能力，须显式开）。
    hot.readUrlEnabled = truthy(pick('BOT_READURL_ENABLED'));
    hot.readUrlMaxChars = Math.max(500, numOr('BOT_READURL_MAX_CHARS', DEFAULTS.READURL_MAX_CHARS) || DEFAULTS.READURL_MAX_CHARS);
    hot.readUrlTimeoutMs = Math.max(2000, numOr('BOT_READURL_TIMEOUT_MS', DEFAULTS.READURL_TIMEOUT_MS) || DEFAULTS.READURL_TIMEOUT_MS);
    // 群聊免@窗口意图识别：默认开（空=开）。关掉则窗口内一律照常回应（回到旧行为）。
    hot.replyIntentCheck = pick('BOT_REPLY_INTENT_CHECK') === '' ? true : truthy(pick('BOT_REPLY_INTENT_CHECK'));
    hot.notMineWords = pick('BOT_NOT_MINE_WORDS') === '' ? DEFAULTS.NOT_MINE_WORDS.slice() : toWordList(pick('BOT_NOT_MINE_WORDS'));
    hot.notMineReply = pick('BOT_NOT_MINE_REPLY') || DEFAULTS.NOT_MINE_REPLY;
    hot.intentTimeoutMs = Math.max(1000, numOr('BOT_INTENT_TIMEOUT_MS', DEFAULTS.INTENT_TIMEOUT_MS) || DEFAULTS.INTENT_TIMEOUT_MS);
    // 引用周边对话检索：默认开（空=开），仅群聊生效；参数含义见 DEFAULTS 上方注释块。
    hot.quoteContextEnabled = pick('BOT_QUOTE_CONTEXT_ENABLED') === '' ? true : truthy(pick('BOT_QUOTE_CONTEXT_ENABLED'));
    hot.quoteContextChainMs = Math.max(60000, numOr('BOT_QUOTE_CONTEXT_CHAIN_MS', DEFAULTS.QUOTE_CONTEXT_CHAIN_MS) || DEFAULTS.QUOTE_CONTEXT_CHAIN_MS);
    hot.quoteContextMaxMs = Math.max(120000, Math.min(1800000, numOr('BOT_QUOTE_CONTEXT_MAX_MS', DEFAULTS.QUOTE_CONTEXT_MAX_MS) || DEFAULTS.QUOTE_CONTEXT_MAX_MS));
    hot.quoteContextMaxChars = Math.max(200, Math.min(6000, numOr('BOT_QUOTE_CONTEXT_MAX_CHARS', DEFAULTS.QUOTE_CONTEXT_MAX_CHARS) || DEFAULTS.QUOTE_CONTEXT_MAX_CHARS));
    hot.quoteContextFetchCount = Math.max(20, Math.min(200, numOr('BOT_QUOTE_CONTEXT_FETCH_COUNT', DEFAULTS.QUOTE_CONTEXT_FETCH_COUNT) || DEFAULTS.QUOTE_CONTEXT_FETCH_COUNT));
    // 存档字数允许填 0（=不沉淀），所以不能套 `|| DEFAULT`（0 会被吃成默认值，和 BOT_GW_RETRY_INTERVAL_MS 同坑）；
    //   填了非数字则退回默认，别拿 0 当「写错了」的兜底——0 是有语义的。
    const hcv = pick('BOT_QUOTE_CONTEXT_HISTORY_CHARS');
    hot.quoteContextHistoryChars = hcv === '' || !Number.isFinite(Number(hcv))
      ? DEFAULTS.QUOTE_CONTEXT_HISTORY_CHARS : Math.min(1500, Math.max(0, Number(hcv)));
    // 网关调用预算/重试：retry 间隔允许填 0（=关重试），所以不能用 `|| DEFAULT` 兜（0 会被吃掉）。
    hot.gatewayTimeoutMs = Math.max(1000, Math.min(20000, numOr('BOT_GW_TIMEOUT_MS', DEFAULTS.GATEWAY_TIMEOUT_MS) || DEFAULTS.GATEWAY_TIMEOUT_MS));
    hot.gatewayRetryIntervalMs = Math.min(5000, numOr('BOT_GW_RETRY_INTERVAL_MS', DEFAULTS.GATEWAY_RETRY_INTERVAL_MS));
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
