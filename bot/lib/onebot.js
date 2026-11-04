'use strict';

// ===== OneBot11 网关动作调用助手（SnowLuma / NapCat 通用）=====
// 为什么单独有这个模块：11-03 的引用检索每轮都报「网关未返回历史消息」，查下来是代码在调
//   internal.request('get_group_msg_history', {...})，而 @satorijs/adapter-onebot 的 Internal 类
//   根本没有 request 方法（只有私有 _get(action, params) 和 Internal.define 生成的驼峰方法），
//   于是 `if (internal.request)` 恒为假 → data 一直 undefined → 走了空数组分支。
//   特性看着上线了，其实一次都没取到过历史，而日志只留了一句像“网关没数据”的话。
// 参数名也必须按网关文档给（接口清单见 docs/08-gateway-api.md，来源 SnowLumaDocs）：
//   get_group_msg_history 的锚点参数是 message_id（配 reverse_order / count），
//   但 adapter 里 Internal.define("get_group_msg_history", "group_id", "message_seq") 生成的
//   getGroupMsgHistory(gid, seq) 传的是 message_seq —— 名字对不上会被静默忽略（等于没锚点）。
//   所以统一走“动作名 + 具名参数”的 _get 口径，不用驼峰方法。
// 三档降级，任一档成功即返回；全失败时 error 里带每一档的原因，绝不静默：
//   ① internal._get(action, params)：复用 adapter 已连上的那条 WS（retcode!==0 会抛 SenderError）；
//   ② internal.request(action, params)：兼容其它实现了 request 的适配；
//   ③ 临时直连 wsEndpoint（带 access_token）：前两档都不通时兜底。
// 再往外是「预算内重试」：SnowLuma 那侧的 QQ 会话会周期性重登（自己日志里是
//   [Bridge] session closed → session started → [OneBot] session started → WS-Server listening），
//   每轮都把 3001 关掉一小段。11-04 实测：清淡时几小时一次（01:36 / 05:36），发作时每 1~5 分钟一次，
//   单次断 5~18 秒（10:05:43→10:05:48 通，10:34:22→10:34:40 通）。这种窗口里三档同时失败，
//   而 adapter 几秒后自己就重连上了——一次放弃就等于「取不到历史」，所以要等、要重试：
//   预算给多久，最多就盖得住多长的断窗：10-30~11-04 的 koishi 日志实测 184 次「断→adapter 重连上」
//   p50=10s / p75=13s / p90=16s / p95=19s / max=28s → 6s 预算只盖得住 20% 的窗，12s 盖 73%，15s 盖 88%。
//   预算是上限而不是固定等待（网关通着时零成本，只有真断着才花时间），所以线上填 12000。
//   只对「连不上」重试；网关明确回了 retcode≠0（参数错/没权限/消息不存在）时
//   重试和换档都没意义，立刻返回。

const TIMEOUT_MS = 6000;
const RETRY_INTERVAL_MS = 1200; // 两次尝试之间隔多久（断窗 5~18s，1.2s 一次能尽早碰上重连）
const RETRY_MIN_LEFT_MS = 700;  // 预算剩余少于这个就不再开新一轮（开了也只会留下没跑完的档）
const TIER_MIN_MS = 300;        // 预算被前一档吃光时，后面各档至少留这点时间，保住降级机会
// 离线冷却：一轮回复里会串着打好几个动作（历史分页 ×2 → get_msg → get_forward_msg），
//   网关真断了让它们各自等满预算，一条回复就要拖十几秒。所以第一个调用判出离线后压一个冷却窗，
//   窗口内的后续调用只给 COLD_BUDGET_MS 且不再重试；任一调用成功就立刻解除。
const COOLDOWN_MS = 8000;
const COLD_BUDGET_MS = 1200;

// 「连不上」的特征词：命中才重试。adapter 断线时 internal._request 会被 delete
//   （见 @satorijs/adapter-onebot/lib/index.js 里 socket close 的处理），
//   于是 _get 抛的是 this._request is not a function —— 它其实是「当前没连着网关」。
const OFFLINE_HINT = /not a function|没有 _get|ECONNREFUSED|ECONNRESET|EPIPE|ENOTFOUND|ENETUNREACH|socket hang up|Channel closed|closed|超时|Timeout with request/i;
const isOffline = (text) => OFFLINE_HINT.test(String(text || ''));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const msgOf = (e) => String((e && e.message) || e || '').replace(/\s+/g, ' ').slice(0, 160);

// defaults() 在每次调用时现取（不是一次性快照），于是 BOT_GW_* 改完下一轮就生效、不用重发版：
//   { timeoutMs, retryIntervalMs }；retryIntervalMs=0 表示关掉重试。
const create = ({ logger = console, wsEndpoint = 'ws://127.0.0.1:3001', wsToken = '', defaults = () => ({}) } = {}) => {
  // 网关偶发不回包（连接在重连抖动中），必须自己带超时，否则整条回复被挂住
  const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时 ${ms}ms`)), ms);
    Promise.resolve(promise).then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });

  // 第三档：临时开一条 WS 直接问网关（要带 token，否则网关握手就拒）
  const wsCall = (action, params, timeoutMs) => new Promise((resolve) => {
    let socket;
    let echo;
    try {
      const WS = require('ws'); // koishi 既有依赖，惰性 require，避免插件加载期多一个模块
      echo = `ob-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
      const url = wsToken ? `${wsEndpoint}${wsEndpoint.includes('?') ? '&' : '?'}access_token=${wsToken}` : wsEndpoint;
      socket = new WS(url, wsToken ? { headers: { Authorization: `Bearer ${wsToken}` } } : undefined);
    } catch (error) {
      resolve({ ok: false, error: 'ws 建连失败: ' + msgOf(error) });
      return;
    }
    const timer = setTimeout(() => done({ ok: false, error: `ws 超时 ${timeoutMs}ms` }), timeoutMs);
    const done = (result) => { clearTimeout(timer); try { socket.close(); } catch (_) { /* 忽略 */ } resolve(result); };
    socket.on('open', () => {
      try { socket.send(JSON.stringify({ action, params, echo })); }
      catch (error) { done({ ok: false, error: 'ws 发送失败: ' + msgOf(error) }); }
    });
    socket.on('message', (buf) => {
      let j = null;
      try { j = JSON.parse(String(buf)); } catch (_) { return; } // 事件推送等非本请求的包，忽略
      if (!j || j.echo !== echo) return;
      if (j.retcode === 0 || j.status === 'ok') { done({ ok: true, data: j.data }); return; }
      done({ ok: false, business: true, error: `ws retcode=${j.retcode} ${String(j.message || j.msg || '').slice(0, 80)}` });
    });
    socket.on('error', (error) => done({ ok: false, error: 'ws 错误: ' + msgOf(error) }));
  });

  // 单次尝试：跑三档。返回 { ok, data, via, error, offline, business }
  //   ⚠ timeoutMs 是「整次调用的总预算」，不是每档各来一遍：引用检索/转发展开都挂在回复主链路上，
  //   三档串起来最多 3×timeoutMs 能把一条回复拖死；降级只在预算没花完时才继续。
  //   预算见底时各档仍留 TIER_MIN_MS（宁可略微超一点，也别把降级机会整个丢掉）。
  const attempt = async (session, action, params, deadline) => {
    const left = () => Math.max(TIER_MIN_MS, deadline - Date.now());
    const internal = session && session.bot && session.bot.internal;
    const why = [];
    const fail = () => ({
      ok: false,
      data: null,
      via: '',
      business: false,
      offline: isOffline(why.join(' ')),
      error: `${action} 各档均失败 → ${why.join(' | ')}`,
    });
    // 某一档拿到「业务失败」就整次收手：网关已经答了（说明连接是通的），
    //   再换档/重试都只会白等；分类也必须在这时定格，不能被后面那档的连不上带偏。
    const business = (label) => Object.assign(fail(), { business: true, offline: false, error: `${action} ${label}` });
    if (internal && typeof internal._get === 'function') {
      try {
        return { ok: true, data: await withTimeout(internal._get(action, params), left(), action), via: 'internal' };
      } catch (error) {
        const text = msgOf(error);
        why.push('internal: ' + text);
        if (!isOffline(text)) return business(`业务失败 → ${text}`);
      }
    } else {
      why.push('internal: 没有 _get 方法');
    }
    if (internal && typeof internal.request === 'function') {
      try {
        return { ok: true, data: await withTimeout(internal.request(action, params), left(), action), via: 'internal.request' };
      } catch (error) {
        const text = msgOf(error);
        why.push('internal.request: ' + text);
        if (!isOffline(text)) return business(`业务失败 → ${text}`);
      }
    }
    const ws = await wsCall(action, params, left());
    if (ws.ok) return { ok: true, data: ws.data, via: 'ws' };
    why.push('ws: ' + (ws.error || '未知失败'));
    if (ws.business) return business(`业务失败 → ${String(ws.error || '').slice(0, 160)}`);
    return fail();
  };

  // 统一入口：返回 { ok, data, via, ms, attempts, offline, business, error }
  //   调用方按 via 记走的那一档、ms 记耗时、attempts 记试了几轮、offline 决定日志怎么说。
  let offlineUntil = 0; // 冷却窗截止时间戳（create 作用域内，即每插件实例一份）
  const callApi = async (session, action, params = {}, opts = {}) => {
    const d = defaults() || {};
    const cooling = Date.now() < offlineUntil;
    let timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs)
      : (Number(d.timeoutMs) > 0 ? Number(d.timeoutMs) : TIMEOUT_MS);
    // 0 是合法值（= 关掉重试），所以这里用「有没有显式给」判断，而不是 > 0
    const pickInterval = (v, fb) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : fb);
    let retryInterval = pickInterval(opts.retryInterval, pickInterval(d.retryIntervalMs, RETRY_INTERVAL_MS));
    if (cooling) {
      // 冷却期内：短预算 + 不重试（前面已经确认过网关连不上，再等一轮只是白等）
      timeoutMs = Math.min(timeoutMs, COLD_BUDGET_MS);
      retryInterval = 0; // 0 在下面的循环里表示「不重试」
    }
    const began = Date.now();
    const deadline = began + timeoutMs;
    let attempts = 0;
    let res;
    for (;;) {
      attempts += 1;
      res = await attempt(session, action, params, deadline); // eslint-disable-line no-await-in-loop
      if (res.ok) break;
      const remaining = deadline - Date.now();
      // 不再重试只有三种情况：网关答过了（业务失败，重试没意义）、重试间隔被设成 0（=关掉重试）、
      //   预算见底（剩下时间连一轮都跑不完）。注意 retryInterval=0 若不拦在这里，
      //   sleep(0) 会变成「预算内空转几百次」——那是 11-04 加冷却时踩到的坑。
      if (!res.offline || retryInterval <= 0 || remaining < RETRY_MIN_LEFT_MS) break;
      await sleep(Math.min(retryInterval, remaining)); // eslint-disable-line no-await-in-loop
    }
    const ms = Date.now() - began;
    const out = Object.assign({}, res, { ms, attempts, capped: cooling });
    if (out.ok) offlineUntil = 0; // 通了一次就解除冷却
    else if (out.offline) offlineUntil = Date.now() + COOLDOWN_MS;
    if (!out.ok) {
      const tag = out.offline ? '，判为网关离线' : (out.business ? '，网关回了业务错误' : '');
      out.error = `${res.error}（耗时 ${ms}ms/预算 ${timeoutMs}ms，试了 ${attempts} 次${tag}${out.capped ? '，撞在离线冷却窗内故走快失败' : ''}）`.slice(0, 420);
    }
    return out;
  };

  // 启动/首次调用时自检：把 internal 上到底有哪些入口记一行。
  //   11-03 那次“方法名写错导致特性静默失效”就是因为没人把这条能力链的真实现状打在日志里。
  const selfCheck = (session) => {
    const internal = session && session.bot && session.bot.internal;
    if (!internal) return 'internal 不存在（adapter 未连接？）';
    const names = ['_get', 'request', 'getMsg', 'getGroupMsgHistory', 'getForwardMsg'];
    return names.map((n) => `${n}=${typeof internal[n]}`).join(' ');
  };

  return { callApi, wsCall, selfCheck };
};

module.exports = { create, TIMEOUT_MS, RETRY_INTERVAL_MS, RETRY_MIN_LEFT_MS, COOLDOWN_MS, COLD_BUDGET_MS, isOffline };
