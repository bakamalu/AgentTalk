'use strict';

// ===== 插件级冒烟测试（不发真实 QQ 消息，不碰线上状态目录）=====
// 用法：node scripts/smoke-plugin.js
// 覆盖：唤醒判定 → 连发合并 → 工具往返（get_weather 走真实气象 API）→ 发送路由 → 管理员指令
// 原理：把 DeepSeek 的 /chat/completions 拦成脚本化的两次响应（先要求调用工具，再给最终答案），
//      其余 fetch（Open-Meteo / geocoding / Bing）放行到真实网络，这样能验证工具链路真的通。
// ⚠ 登录 shell 会从 /etc/profile → /root/deploy/profile → bot.env 注入真实 BOT_* 变量，
//   必须在 require 插件前清空，否则白名单/管理员会用线上值，断言静默失真。

const fs = require('fs');
const os = require('os');
const path = require('path');

for (const key of Object.keys(process.env)) {
  if (key.startsWith('BOT_')) delete process.env[key];
}
process.env.BOT_AT_ONLY = '1';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'agentsmoke-'));
const BOT_ENV = path.join(TMP, 'bot.env');
fs.writeFileSync(BOT_ENV, [
  'export BOT_AT_ONLY="1"',
  'export BOT_SYSTEM_PROMPT="你是测试人格元芳"',
  'export BOT_ADMIN_USERS="111111"',
  'export BOT_ADMIN_GROUP="1"',
  'export BOT_ALLOWED_USERS=""',
  'export BOT_ALLOWED_GROUPS=""',
  'export BOT_SEARCH_ENABLED="1"',
  'export BOT_WEATHER_DEFAULT_CITY="苏州"',
  'export BOT_MERGE_WINDOW_MS="200"',
  'export BOT_MERGE_MAX_WAIT_MS="400"',
].join('\n') + '\n');

const PLUGIN = path.join(__dirname, '..', 'bot', 'plugins', 'deepseek.js');
const realFetch = global.fetch;
const calls = [];           // 记录发给模型的每一次请求
const sent = [];           // 记录机器人实际“发出去”的内容
const toolReqs = [];       // 记录插件实际执行过的工具名
let completionSeq = 0;
let toolPayload = '';      // 第二次请求里 role=tool 的内容，用来断言工具真的拿到了数据

global.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes('/chat/completions')) {
    const body = JSON.parse(opts.body);
    calls.push(body);
    completionSeq += 1;
    const toolMsg = (body.messages || []).filter((m) => m.role === 'tool').map((m) => m.content).join('\n');
    if (toolMsg) toolPayload = toolMsg;
    // 第 1、3 次：让模型调用工具；第 2、4 次：给出最终文字
    if (completionSeq % 2 === 1) {
      const lastUser = [...(body.messages || [])].reverse().find((m) => m.role === 'user');
      const text = typeof lastUser?.content === 'string' ? lastUser.content : '';
      const useWeather = /天气|气温|穿什么|下雨/.test(text);
      const call = useWeather
        ? { id: 'c1', type: 'function', function: { name: 'get_weather', arguments: JSON.stringify({ city: '苏州', days: 2 }) } }
        : { id: 'c1', type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: '苏州 今日天气 2026年11月2日' }) } };
      toolReqs.push(call.function.name);
      return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '', tool_calls: [call] } }], usage: { prompt_tokens: 900, completion_tokens: 30 } }) };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: '苏州今天多云转小雨，12~20℃，出门带伞。' } }], usage: { prompt_tokens: 1200, completion_tokens: 60 } }) };
  }
  return realFetch(url, opts);
};

const requirePlugin = () => { delete require.cache[require.resolve(PLUGIN)]; return require(PLUGIN); };

const handlers = {};
const logLines = [];
const logger = {
  info: (...a) => logLines.push(['I', a.join(' ')]),
  warn: (...a) => logLines.push(['W', a.join(' ')]),
  error: (...a) => logLines.push(['E', a.join(' ')]),
};
const ctx = {
  logger,
  on: (event, fn) => { (handlers[event] = handlers[event] || []).push(fn); },
};

const plugin = requirePlugin();
plugin(ctx, {
  apiKey: 'test-key-not-secret',
  model: 'deepseek-chat',
  botEnvFile: BOT_ENV,
  stateDir: path.join(TMP, 'state'),
  ratePerMinute: 60,
  minIntervalMs: 0,
  adminUsers: '111111',
  adminGroup: '1',
});

const SELF = '<UIN>';
const makeSession = (text, opts = {}) => ({
  platform: 'onebot',
  guildId: opts.private ? undefined : '<GROUP_ID>',
  channelId: opts.private ? undefined : '<GROUP_ID>',
  userId: opts.userId || '<USER_ID>',
  selfId: SELF,
  messageId: opts.messageId || 'mid-1',
  content: (opts.private ? '' : `[CQ:at,qq=${SELF}] `) + text,
  original: (opts.private ? '' : `[CQ:at,qq=${SELF}] `) + text,
  elements: [
    ...(opts.private ? [] : [{ type: 'at', attrs: { id: SELF } }]),
    { type: 'text', data: { text } },
  ],
  bot: {
    selfId: SELF,
    internal: {
      sendGroupMsg: (groupId, message) => {
        // 带引用时 message 是数组（reply 段 + text 段），这里两种都归一成纯文本记录
        const text = Array.isArray(message) ? message.filter((s) => s.type === 'text').map((s) => s.data.text).join('') : String(message);
        const quoted = Array.isArray(message) && message.some((s) => s.type === 'reply');
        sent.push({ to: 'group:' + groupId, text, quoted });
        return Promise.resolve({ message_id: 1 });
      },
      sendPrivateMsg: (userId, message) => {
        sent.push({ to: 'private:' + userId, text: String(message), quoted: false });
        return Promise.resolve({ message_id: 2 });
      },
      getMsg: () => Promise.reject(new Error('not needed')),
    },
    constructor: function () {},
  },
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// 工具往返要跑真实网络（地理编码 + 预报 两次 HTTP），固定短等待容易误判，改成轮询
const waitUntil = async (fn, ms = 15000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (fn()) return true;
    await wait(100);
  }
  return false;
};
let failed = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  →  ' + detail : ''}`);
  if (!ok) failed += 1;
};

(async () => {
  const banner = logLines.map(([, l]) => l).join('\n');
  check('启动横幅含天气模块', /\[天气\] 开（Open-Meteo/.test(banner), (banner.match(/\[天气\].*/) || [''])[0]);
  check('严格@模式生效', /\[模式\] 严格@/.test(banner));

  // 1) 群里被@问天气
  handlers.message.forEach((fn) => fn(makeSession('今日苏州天气')));
  await waitUntil(() => sent.length >= 1);
  check('调用了 get_weather', toolReqs.includes('get_weather'), toolReqs.join(','));
  const weatherText = toolPayload;
  check('工具真的拿到了气象数值', /℃/.test(weatherText), weatherText.replace(/\n/g, ' | ').slice(0, 150));
  check('未再走 web_search 搜天气', !/搜索「/.test(weatherText));
  check('群回复已发出', sent.length === 1 && /带伞/.test(sent[0].text), JSON.stringify(sent[0] || {}));

  // 2) 连发合并：同一人 200ms 内两条，应只回一次
  const before = sent.length;
  const cbefore = calls.length;
  const s1 = makeSession('再问一次天气', { messageId: 'a' });
  const s2 = makeSession('苏州气温如何', { messageId: 'b' });
  handlers.message.forEach((fn) => fn(s1));
  handlers.message.forEach((fn) => fn(s2));
  await waitUntil(() => sent.length - before >= 1);
  await wait(800); // 再等一段，确认没有“多回一次”
  check('连发两条只回一次', sent.length - before === 1, `新增 ${sent.length - before} 条`);
  check('连发两条合并成一条发模型的请求', calls.length - cbefore === 2, `新增请求 ${calls.length - cbefore} 次`);

  // 3) 管理员指令（私聊）
  const abefore = sent.length;
  handlers.message.forEach((fn) => fn(makeSession('#状态', { private: true, userId: '111111' })));
  await waitUntil(() => sent.length > abefore, 3000);
  const adminReply = sent.slice(abefore).map((s) => s.text).join('\n');
  check('管理员 #状态 可用', /【机器人状态】/.test(adminReply) && /联网能力/.test(adminReply), (adminReply.match(/联网能力.*/) || [''])[0]);
  check('状态卡带上频控闸限值', /频率闸：.*条\/分/.test(adminReply), (adminReply.match(/频率闸.*/) || [''])[0]);

  // 4) 非管理员不能用特权指令
  const bbefore = sent.length;
  completionSeq = 100; // 下面这条走正常对话路径，重置计数让下一次是“要求调用工具”
  handlers.message.forEach((fn) => fn(makeSession('#状态', { private: true, userId: '999999' })));
  await waitUntil(() => sent.length > bbefore, 12000);
  check('非管理员不返回状态卡', !/【机器人状态】/.test(sent.slice(bbefore).map((s) => s.text).join('\n')));

  // 5) web_search 链路（非天气问题）
  completionSeq = 0;
  sent.length = 0;
  toolPayload = '';
  toolReqs.length = 0;
  handlers.message.forEach((fn) => fn(makeSession('江苏 高考 政策 最近有什么变化', { messageId: 'c' })));
  await waitUntil(() => sent.length >= 1);
  check('web_search 被调用', toolReqs.includes('web_search'), toolReqs.join(','));
  check('搜索结果非空', /搜索「/.test(toolPayload), toolPayload.replace(/\n/g, ' | ').slice(0, 120));
  check('搜索走的是归一化后的短查询', !/2026年|今日|实时/.test((toolPayload.match(/搜索「([^」]+)」/) || [])[1] || ''), (toolPayload.match(/搜索「([^」]+)」/) || [])[1]);

  // 6) 历史落盘
  await wait(600);
  const histFile = path.join(TMP, 'state', 'histories.json');
  const hist = fs.existsSync(histFile) ? JSON.parse(fs.readFileSync(histFile, 'utf8')) : {};
  const keys = Object.keys(hist);
  check('历史已持久化到 state 目录', keys.length > 0, keys.join(','));
  const replyLogged = logLines.some(([, l]) => l.startsWith('[回复]'));
  check('回复正文进日志（新增可观测性）', replyLogged);

  console.log('\n失败项：' + failed);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failed ? 1 : 0);
})().catch((error) => {
  console.error('冒烟测试异常:', error);
  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(2);
});
