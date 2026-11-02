'use strict';

// ===== 定时提醒（定时呼叫）=====
// 模型通过 set_reminder / list_reminders / cancel_reminder 三个工具设表；
// 本模块只维护「提醒表 + 到点回调」，到点后怎么说话由 plugins/deepseek.js 决定
// （默认直接投递固定文案，不消耗 token；投递失败按退避重试，最多 3 次）。
//
// 三个必须留意的点：
//   1) 到点触发可能发生在**重启之后**，所以提醒表和投递目标都落盘（reminders.json）。
//      bot 对象没法序列化，靠 registerTarget 在重启后的前几条消息里“续链”，
//      续不上就按失败退避重试，不要当成 bug。
//   2) 主动投递走 sender.notify（不带引用段）：残留的 quoteId 跨会话复用会被
//      SnowLuma 判 1400（见 lib/sender.js 坑 #1/#2），失败也只记日志、绝不抛回主流程。
//   3) 时间口径全用本地时区（服务器 UTC+8）：at_time「今天已过 → 视为明天」的歧义
//      交给模型结合注入的当前时间自我消歧，这里只做稳妥兜底并在结果里告知。

const pad2 = (n) => String(n).padStart(2, '0');
const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

const fmtTime = (ts) => {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
};
const fmtDateTime = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${fmtTime(ts)} ${WEEKDAY[d.getDay()]}`;
};
const dayLabel = (ts) => {
  const d = new Date(ts);
  const today = new Date();
  const diffDays = Math.floor((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
  return diffDays <= 0 ? '' : diffDays === 1 ? '明天' : diffDays === 2 ? '后天' : `${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
};

const MAX_PENDING_DEFAULT = 10;   // 单会话最多待触发的提醒数
const MAX_TOTAL_DEFAULT = 200;    // 全进程待触发总量（防堆积）
const MAX_DELAY_MS_DEFAULT = 24 * 3600 * 1000; // 最长可预约时长
const MAX_AT_DEFAULT = 5;         // 单条提醒到点最多 @ 几个人
const RETRY_BACKOFF_MS = 60000;   // 投递失败后的重试间隔（投递结果未知的不重试由 sender 层管）
const RETRY_LIMIT = 3;            // 投递失败重试上限，超过即放弃（只记日志）
const MISSED_STALE_MS = 10 * 60 * 1000; // 启动时：逾期未超过该窗口仍补发，更久的视为陈旧丢弃
const TICK_MS = 1000;

// 平台无关的用户 id 校验：不假设是“QQ 号”，QQ/wxid/贴吧 uid 等由各适配器给的 id 都能过。
// 只拒空值、拒含空白、拒纯中日韩字符（挡掉模型把“张三/我”这类昵称误填进 id 字段）；
// 长度 64 足够覆盖各平台 id 形态。真正的 @ 段编码在 sender 层按平台分派，不在这。
const isUserId = (s) => typeof s === 'string' && s.length > 0 && s.length <= 64
  && !(/\s/.test(s)) && /^[A-Za-z0-9_\-:@.]+$/.test(s);

// 模型可调的三个提醒工具（schema 跟着能力模块，与 weather.js 导出 TOOL 一致；参数语义的分发在 lib/tools.js）
const REMINDER_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'set_reminder',
      description: '设一个定时提醒，到点后机器人会在**当前会话**主动发一条消息（群聊可 @ 指定人）。'
        + '用户说“X分钟后/几点几分 提醒我做某事”时必须调本工具真的建表，绝对不要只口头答应“到点叫你”却不创建（那样根本叫不了人）。'
        + '时长用 delay_seconds（秒）；说具体时刻用 at_time（「HH:MM」，结合同样注入的当前时间判断是今天还是明天）。'
        + '只能提醒当前这个会话（群/私聊），不能跨会话；要 @ 别人必须用户明说了才填 at_user_ids。',
      parameters: {
        type: 'object',
        properties: {
          delay_seconds: { type: 'integer', description: '多少秒后提醒（与 at_time 二选一，优先用这个）；如「2分钟」=120、「1小时」=3600' },
          at_time: { type: 'string', description: '时刻「HH:MM」（24 小时本地时间），用户说“下午三点”这类明确时刻时用；今天已过会自动按明天' },
          note: { type: 'string', description: '提醒内容，简短一句话，如「喝水」「开会」「交给周报」' },
          at_user_ids: { type: 'array', items: { type: 'string' }, description: '到点 @ 谁的用户 ID（仅群聊生效，可为 QQ/wxid/贴吧 uid 等不透明 ID）。用户说“提醒我”则留空（系统默认 @ 设提醒人）；只有用户明说要 @ 某人才填，不确定就不要填' },
          at_user_names: { type: 'array', items: { type: 'string' }, description: '到点 @ 谁的昵称/群名片（仅群聊生效）。用户说“@ 某人/提醒某某”但没给 ID 时把名字填这里，系统会去成员表查对应 ID；查不到或多人在同名会告知你，再向用户要准确 ID' },
        },
        required: ['note'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_reminders',
      description: '列出当前会话还未触发的提醒（编号、时间、内容、@ 对象）。用户问“我设了哪些提醒/还有多久”时用。',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_reminder',
      description: '按编号取消一个未触发的提醒。编号来自 list_reminders 或刚设好的返回（也支持“第几个”）。用户说“不用提醒了/取消”时用。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: '提醒编号（如 rxxxx）或序号（“2”=本会话最早要触发的第 2 个）' },
        },
        required: ['id'],
      },
    },
  },
];

// opts: { stateDir, logger, hot, writeJson, readJson, onFire }
const create = (opts = {}) => {
  const { logger = console, hot, stateDir, onFire } = opts;
  const info = (...a) => logger.info?.(...a);
  const warn = (...a) => logger.warn?.(...a);
  const readJson = opts.readJson || ((file, fallback) => { try { return JSON.parse(require('fs').readFileSync(file, 'utf8')); } catch (e) { return fallback; } });
  const writeJson = opts.writeJson || ((file, data) => {
    try {
      const fs = require('fs'); const path = require('path');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
    } catch (e) { warn('[提醒] 落盘失败: ' + e.message); }
  });

  const remindersFile = stateDir ? `${stateDir.replace(/\/$/, '')}/reminders.json` : '';
  const pending = new Map();      // id -> 提醒
  const targets = new Map();      // chatKey -> { platform, guildId, channelId, userId, bot, updatedAt }
  let seq = Date.now() % 1e6;
  let tickTimer = null;
  let saveTimer = null;

  const maxPending = () => Math.min(50, Math.max(1, Number(hot?.reminderMaxPerChat) || MAX_PENDING_DEFAULT));
  const maxTotal = () => Math.min(1000, Math.max(10, Number(hot?.reminderMaxTotal) || MAX_TOTAL_DEFAULT));
  const maxDelayMs = () => Math.min(7 * 24 * 3600 * 1000, Math.max(60000, Number(hot?.reminderMaxDelayS) * 1000 || MAX_DELAY_MS_DEFAULT));

  // ---------- 持久化：reminders = { version, targets, items } ----------
  const serialize = () => ({
    version: 1,
    targets: Object.fromEntries([...targets.entries()].map(([k, t]) => [k, {
      platform: t.platform, guildId: t.guildId, channelId: t.channelId, userId: t.userId, updatedAt: t.updatedAt,
    }])),
    items: [...pending.values()].map((r) => ({ ...r, bot: undefined })),
  });
  const scheduleSave = () => {
    if (!remindersFile || saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeJson(remindersFile, serialize());
    }, 400);
  };

  // ---------- 投递目标 ----------
  // 每条进入的消息（无论是否唤醒）都续一遍，保证到点时能找回“该发到哪个会话、用哪个 bot 连接”
  const registerTarget = (chatKey, session) => {
    if (!chatKey || !session) return;
    targets.set(chatKey, {
      platform: session.platform || 'onebot',
      guildId: session.guildId || '',
      channelId: session.channelId || '',
      userId: String(session.userId ?? ''),
      bot: session.bot,
      updatedAt: Date.now(),
    });
    scheduleSave();
  };
  const lookupTarget = (chatKey) => targets.get(chatKey) || null;

  // ---------- 到点 @ 名单 ----------
  // 收“已通过 isUserId 校验的平台无关 id”（模型把昵称/“我”填进来会被挡；昵称应走 at_user_names 由解析层查）；
  // 去重、限数量（BOT_REMINDER_MAX_AT），群以外会话不 @（私聊 @ 无意义）。
  const normalizeAt = (list, requesterId, isGroup) => {
    if (!isGroup || hot?.reminderMaxAt === 0) return [];
    const raw = Array.isArray(list) ? list : (list == null ? [] : [list]);
    const ids = [];
    const cap = Math.min(10, Math.max(0, Number(hot?.reminderMaxAt) || MAX_AT_DEFAULT));
    for (const v of raw) {
      const s = String(v).trim();
      if (isUserId(s) && !ids.includes(s)) { ids.push(s); if (ids.length >= cap) break; }
    }
    if (!ids.length && requesterId && hot?.reminderAtRequester !== false) {
      const self = String(requesterId).trim();
      if (isUserId(self)) ids.push(self); // 默认 @ 设提醒的人自己，群消息才能绕开严格@模式不响应
    }
    return ids;
  };

  // ---------- 表格操作 ----------
  const describe = (r) => `${r.id}｜${fmtDateTime(r.dueAt)}｜${r.note}${r.at && r.at.length ? `｜@${r.at.join(',')}` : ''}`;

  // 分钟级取整：用户说“两分钟”而模型给 90s 这类偏差按分钟收敛，避免“1 分 30 秒”这种尴尬显示
  const roundToMinute = (ms) => Math.max(60000, Math.round(ms / 60000) * 60000);

  const createReminder = (chatKey, { delaySeconds, atTime, note, userId, atUserIds, quoteMessageId }) => {
    if (!chatKey || !lookupTarget(chatKey)) {
      return { ok: false, text: '创建失败：当前会话没有可投递的目标（请让用户在 QQ 里直接提出提醒需求）。' };
    }
    const cleanNote = String(note || '').trim();
    if (!cleanNote) return { ok: false, text: '创建失败：没有提醒内容，请反问用户要提醒什么。' };
    if (cleanNote.length > 200) return { ok: false, text: '创建失败：提醒内容过长（上限 200 字），请精简后重试。' };
    if (pending.size >= maxTotal()) return { ok: false, text: `创建失败：待触发提醒已达上限 ${maxTotal()} 个。` };
    const sameChat = [...pending.values()].filter((r) => r.chatKey === chatKey).length;
    if (sameChat >= maxPending()) return { ok: false, text: `创建失败：本会话已有 ${sameChat} 个待触发提醒（上限 ${maxPending()}），请先用 cancel_reminder 取消不需要的。` };

    const now = Date.now();
    let dueAt = 0;
    let passedMidnight = false;
    const delay = Math.floor(Number(delaySeconds) || 0);
    if (delay > 0) {
      if (delay * 1000 > maxDelayMs()) {
        return { ok: false, text: `创建失败：超出最长可预约时长（${Math.round(maxDelayMs() / 3600000)} 小时），更远的提醒建议用户设手机闹钟。` };
      }
      dueAt = now + roundToMinute(delay * 1000);
    } else {
      const m = /^(\d{1,2})[:：](\d{2})$/.exec(String(atTime || '').trim());
      if (!m) return { ok: false, text: '创建失败：没有给出有效时间（delay_seconds 秒数，或 at_time「HH:MM」），请反问用户几点或多久之后提醒。' };
      const h = Number(m[1]); const mi = Number(m[2]);
      if (h > 23 || mi > 59) return { ok: false, text: `创建失败：「${atTime}」不是有效时刻（小时 0~23、分钟 0~59）。` };
      const d = new Date(); d.setHours(h, mi, 0, 0);
      dueAt = d.getTime();
      if (dueAt <= now) { dueAt += 24 * 3600 * 1000; passedMidnight = true; } // 今天已过 → 视为明天
      if (dueAt - now > maxDelayMs()) return { ok: false, text: '创建失败：距离目标时刻超出最长可预约时长。' };
    }

    const id = `r${Date.now().toString(36)}${(seq++).toString(36)}`;
    const target = lookupTarget(chatKey) || {};
    const isGroup = Boolean(target.guildId || target.channelId);
    const at = normalizeAt(atUserIds, userId || target.userId, isGroup);
    const reminder = {
      id, chatKey, userId: String(userId || ''), note: cleanNote, dueAt, createdAt: now,
      status: 'pending', attempts: 0, lastError: '',
      at,                                             // 到点 @ 的 QQ 号（空=不 @；私聊恒为空）
      quoteMessageId: String(quoteMessageId || ''),   // 到点回复时引用哪条（可选，失败自动降级）
    };
    pending.set(id, reminder);
    // 新提醒的到期时间可能比当前排队的定时器更早，需重排到点检查；
    // 但绝不在此处直接调 tryTick()——那会与在途投递并发、导致同一提醒被投两次（线上实测重复发送的根因）。
    if (tickTimer) { clearTimeout(tickTimer); tickTimer = null; }
    scheduleTick();
    scheduleSave();
    info(`[提醒] 已设定 ${id} due=${fmtDateTime(dueAt)} chat=${chatKey} at=${at.join(',') || '-'} note=${cleanNote.slice(0, 60)}`);
    return {
      ok: true,
      reminder,
      text: `提醒已设置：编号 ${id}，${dayLabel(dueAt) ? dayLabel(dueAt) + ' ' : ''}${fmtTime(dueAt)}（约 ${Math.max(1, Math.round((dueAt - now) / 60000))} 分钟后）到点，内容「${cleanNote}」，到点${at.length ? `会 @ ${at.join('/')}` : '不 @ 任何人'}。`
        + (passedMidnight ? '（用户说的时刻今天已经过去，已按明天处理，请在回复里向用户确认）' : '')
        + '请只向用户复述一遍时间、内容和 @ 对象，不要重复调用本工具。',
    };
  };

  const listReminders = (chatKey) => {
    const mine = [...pending.values()].filter((r) => r.chatKey === chatKey).sort((a, b) => a.dueAt - b.dueAt);
    if (!mine.length) return { ok: true, text: '当前没有待触发的提醒。' };
    return { ok: true, text: `【待触发提醒 ${mine.length} 个】\n` + mine.map(describe).join('\n'), items: mine };
  };

  const findReminder = (id, chatKey) => {
    const key = String(id || '').trim();
    if (!key) return null;
    // 1) 先按完整 id 精确命中
    for (const r of pending.values()) if (r.id === key) return r;
    // 2) 纯数字→视为“第几个”序号（按本会话到期顺序）。必须先于后缀匹配，
    //    否则“1”会被某个以 1 结尾的 id（如 rxxxx1）误命中。
    if (/^\d+$/.test(key)) {
      const mine = [...pending.values()].filter((r) => r.chatKey === chatKey).sort((a, b) => a.dueAt - b.dueAt);
      return mine[Number(key) - 1] || null;
    }
    // 3) 其他情况允许 id 后缀（用户可能只报后半段编号）
    for (const r of pending.values()) if (r.id.endsWith(key)) return r;
    return null;
  };

  const cancelReminder = (id, chatKey) => {
    const r = findReminder(id, chatKey);
    if (!r) return { ok: false, text: `没找到编号「${id}」的待触发提醒，可先用 list_reminders 查看。` };
    pending.delete(r.id);
    scheduleSave();
    info(`[提醒] 已取消 ${r.id}（${fmtDateTime(r.dueAt)} ${r.note}）`);
    return { ok: true, text: `已取消提醒 ${r.id}（原定 ${fmtDateTime(r.dueAt)}，内容「${r.note}」）。` };
  };

  // ---------- 到点调度 ----------
  const persistStatus = (r, status) => {
    r.status = status;
    if (!remindersFile) return;
    // 已完成/已放弃的记录保留在文件里供审计，加载时只取 pending，量大有上限保护
    const data = readJson(remindersFile, { version: 1, targets: {}, items: [] });
    const items = Array.isArray(data.items) ? data.items : [];
    const idx = items.findIndex((it) => it && it.id === r.id);
    const plain = { ...r, bot: undefined };
    if (idx >= 0) items[idx] = plain; else items.push(plain);
    while (items.length > 500) items.shift();
    writeJson(remindersFile, { ...data, items });
  };

  const fire = async (r) => {
    const target = lookupTarget(r.chatKey);
    // 目标失效属于结构性问题（一条都没发出去），走退避重试是安全的
    if (!target || !target.bot) throw new Error('投递目标失效（重启后还没收到该会话的新消息）');
    const d = new Date(r.dueAt);
    const when = `${dayLabel(r.dueAt) ? dayLabel(r.dueAt) + ' ' : ''}${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
    const ats = Array.isArray(r.at) ? r.at.filter(Boolean) : [];
    const whom = ats.length > 1 ? `到点${when}@了 ${ats.length} 个人` : (ats.length === 1 && String(ats[0]) === String(r.userId) ? `到点${when}叫你` : `到点${when}@了 QQ ${ats[0]}`);
    const text = `⏰ 定时提醒：你${fmtTime(r.createdAt)}让我${whom}，内容是「${r.note}」。`;
    // onFire 由插件层注入（投递 + 写入上下文），返回投递结果。
    // false 意味着“可能已发出但结果未知”（超时/断连），按 sender 层同源口径不重发，
    // 只记日志放弃——宁可不叫也不能同一个提醒 @ 人三次。
    const delivered = await onFire({ reminder: r, chatKey: r.chatKey, target, text, atUserIds: ats });
    if (delivered === false) throw new Error('投递结果未知（不重发）');
  };

  // 单条提醒的到点执行：独立异步跑，不阻塞其它会话/其它提醒。
  // fire() 内部（尤其「延迟代理轮」）可能耗时很久，这里 await 它但不卡住调度循环。
  const runFire = async (r) => {
    try {
      await fire(r);
      pending.delete(r.id);
      persistStatus(r, 'fired');
      info(`[提醒] 已触发 ${r.id}（${r.note}）`);
    } catch (error) {
      r.status = 'pending'; // 交还认领，交由下面的退避重试或放弃
      r.attempts += 1;
      r.lastError = String(error?.message || error).slice(0, 120);
      // “结果未知”类不重试：可能已经 @ 过人了，再发就是刷屏；直接放弃
      const unknown = /结果未知|timeout|timed out|ETIMEDOUT|ECONNRESET|socket hang up/i.test(r.lastError);
      if (unknown || r.attempts >= RETRY_LIMIT) {
        pending.delete(r.id);
        persistStatus(r, 'failed');
        warn(`[提醒] ${unknown ? '投递结果未知，不重发' : `投递失败满 ${RETRY_LIMIT} 次`}，放弃 ${r.id}: ${r.lastError}`);
      } else {
        r.dueAt = Date.now() + RETRY_BACKOFF_MS; // 用最新时刻退避，不用快照 now（本轮可能已跑很久）
        warn(`[提醒] 投递失败（第 ${r.attempts} 次），${RETRY_BACKOFF_MS / 1000}s 后重试 ${r.id}: ${r.lastError}`);
      }
    }
    scheduleSave();
  };

  // tryTick 现在是**同步**函数：只做“快照 + 认领 + 并发派发”，不 await 任何投递，
  // 因此天然不可重入；同一提醒靠 status:'firing' 认领保证只派发一次。
  // 返回 Promise.all 仅供冒烟测试/需要时等待本轮全部完成，生产定时器不依赖它。
  const tryTick = () => {
    tickTimer = null;
    const now = Date.now();
    const due = [...pending.values()].filter((r) => r.status === 'pending' && r.dueAt <= now).sort((a, b) => a.dueAt - b.dueAt);
    // 同步认领：派发前完成，后续并发 tryTick 的 pending 过滤捞不到它
    for (const r of due) r.status = 'firing';
    const runs = due.map((r) => runFire(r)); // 每条独立异步执行（跨会话并发；单会话内部由 deepseek enqueue 串行）
    scheduleTick();
    return Promise.all(runs);
  };

  const scheduleTick = (waitOverride) => {
    if (tickTimer) return;
    let wait = waitOverride;
    if (wait == null) {
      const now = Date.now();
      const nexts = [...pending.values()].map((r) => r.dueAt).filter((t) => t > now);
      wait = nexts.length ? Math.min(Math.max(50, Math.min(...nexts) - now), 30000) : 30000;
    }
    tickTimer = setTimeout(tryTick, wait);
    if (typeof tickTimer.unref === 'function') tickTimer.unref();
  };

  // ---------- 启动加载：跨重启的提醒续命 ----------
  const loaded = { total: 0, kept: 0, missed: 0 };
  if (remindersFile) {
    const data = readJson(remindersFile, null);
    if (data && Array.isArray(data.items)) {
      loaded.total = data.items.length;
      for (const it of data.items) {
        if (!it || it.status !== 'pending' || !it.id || !it.dueAt) continue;
        if (it.dueAt < Date.now() - MISSED_STALE_MS) { loaded.missed += 1; continue; } // 陈旧的补发没意义
        if (pending.size >= maxTotal()) break;
        pending.set(it.id, { ...it, attempts: it.attempts || 0 });
        loaded.kept += 1;
      }
      for (const [k, t] of Object.entries(data.targets || {})) {
        if (!targets.has(k) && t && t.userId) targets.set(k, { ...t, bot: undefined }); // bot 靠重启后消息续链
      }
    }
  }
  if (loaded.kept) info(`[提醒] 从磁盘恢复 ${loaded.kept} 个待触发提醒${loaded.missed ? `（另丢弃 ${loaded.missed} 个逾期未补发的）` : ''}`);
  scheduleTick(1000);

  return {
    pending,
    targets,
    registerTarget,
    lookupTarget,
    create: createReminder,
    list: listReminders,
    cancel: cancelReminder,
    find: findReminder,
    pendingCount: () => pending.size,
    loadedInfo: loaded,
    // 供冒烟测试直接改表
    __test: { pending, targets, tryTick: () => tryTick(), createAt: (chatKey, dueAt, note, at) => {
      const id = `t${seq++}`;
      const r = { id, chatKey, userId: (at && at[0]) || '', note, dueAt, createdAt: Date.now(), status: 'pending', attempts: 0, lastError: '', at: at || [], quoteMessageId: '' };
      pending.set(id, r); scheduleTick(50); return r;
    } },
  };
};

module.exports = { create, REMINDER_TOOLS, fmtTime, fmtDateTime, dayLabel, WEEKDAY };
