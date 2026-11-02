'use strict';
// 定时提醒（lib/timers.js）冒烟测试：不联网、不依赖 Koishi，纯逻辑校验。
// ⚠ 先清空 shell 继承的真实 BOT_* 环境变量，避免任何兜底读到线上值（见记忆「冒烟测试需先清空 BOT_*」）。
process.env.BOT_REMINDER_ENABLED = '';
process.env.BOT_ALLOWED_USERS = ''; process.env.BOT_ALLOWED_GROUPS = '';
process.env.BOT_ADMIN_USERS = ''; process.env.BOT_ADMIN_GROUP = '';
process.env.BOT_BLACKLIST_USERS = ''; process.env.BOT_BLACKLIST_GROUPS = '';

const os = require('os');
const fs = require('fs');
const path = require('path');
const timers = require('../bot/lib/timers');

let pass = 0; let failed = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')); } };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smoke-timers-'));
const mkHot = (over = {}) => Object.assign({
  reminderEnabled: true, reminderMaxPerChat: 10, reminderMaxTotal: 200,
  reminderMaxDelayS: 86400, reminderAtRequester: true, reminderMaxAt: 5,
}, over);
const fakeLogger = { info() {}, warn() {}, error() {} };
const fakeBot = { internal: { sendGroupMsg: async () => {}, sendPrivateMsg: async () => {} }, sendMessage: async () => {} };

function newTimers(hot, fires, dir) {
  const d = dir || fs.mkdtempSync(path.join(tmp, 'inst-'));
  return timers.create({
    stateDir: d,
    logger: fakeLogger,
    hot,
    readJson: (f, r) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return r; } },
    writeJson: (f, data) => { try { fs.writeFileSync(f, JSON.stringify(data)); } catch (e) {} },
    onFire: (payload) => { if (fires) fires.push(payload); return true; },
  });
}

const G = 'onebot:111:222';   // 群会话 chatKey（guildId=111 群号, channelId=222）
const P = 'onebot:private:';  // 私聊前缀

// ---------- 1. 群聊：默认 @ 设表人 ----------
{
  const fires = []; const t = newTimers(mkHot(), fires);
  t.registerTarget(G, { platform: 'onebot', guildId: '111', channelId: '222', userId: '1000000001', bot: fakeBot });
  const r = t.create(G, { delaySeconds: 120, note: '喝水', userId: '1000000001' });
  ok(r.ok, '群聊-设提醒成功', r.text);
  ok(r.reminder.at.length === 1 && r.reminder.at[0] === '1000000001', '群聊-默认@设表人', JSON.stringify(r.reminder.at));
  const delta = r.reminder.dueAt - Date.now();
  ok(delta >= 115000 && delta <= 125000, '群聊-120s→约2分钟后到期', delta);
  ok(/会 @ 1000000001/.test(r.text), '群聊-回执含@对象', r.text);
}

// ---------- 2. 群聊：显式 @ 别人 ----------
{
  const t = newTimers(mkHot());
  t.registerTarget(G, { platform: 'onebot', guildId: '111', channelId: '222', userId: '1000000001', bot: fakeBot });
  const r = t.create(G, { delaySeconds: 60, note: '交周报', userId: '1000000001', atUserIds: ['1000000002', '223344556'] });
  ok(r.ok && r.reminder.at[0] === '1000000002' && r.reminder.at[1] === '223344556', '群聊-显式@多人', JSON.stringify(r.reminder.at));
}

// ---------- 3. @ 名单结构校验（平台无关）：中文/昵称被剔除，任意合法 ID 保留 ----------
{
  const t = newTimers(mkHot());
  t.registerTarget(G, { platform: 'onebot', guildId: '111', channelId: '222', userId: '1000000001', bot: fakeBot });
  // '我'/'张三' 是中文→拒；'12'/'1380013800012345'/'777777' 作为不透明 ID→收（不再限 5~12 位）；'wxid_abc' 非 QQ 形态也应收
  const r = t.create(G, { delaySeconds: 60, note: 'x', userId: '1000000001', atUserIds: ['我', '张三', '12', '777777', 'wxid_abc001'] });
  ok(r.ok && r.reminder.at.length === 3
    && !r.reminder.at.includes('我') && !r.reminder.at.includes('张三')
    && r.reminder.at.includes('12') && r.reminder.at.includes('777777') && r.reminder.at.includes('wxid_abc001'),
    '@名单-拒中文昵称/收任意平台 ID', JSON.stringify(r.reminder.at));
}

// ---------- 4. @ 上限（防刷群） ----------
{
  const t = newTimers(mkHot({ reminderMaxAt: 2 }));
  t.registerTarget(G, { platform: 'onebot', guildId: '111', channelId: '222', userId: '1000000001', bot: fakeBot });
  const r = t.create(G, { delaySeconds: 60, note: 'x', userId: '1000000001', atUserIds: ['111111', '222222', '333333', '444444'] });
  ok(r.ok && r.reminder.at.length === 2, '@上限-截断到 MAX_AT', JSON.stringify(r.reminder.at));
}

// ---------- 5. 私聊：恒不 @ ----------
{
  const t = newTimers(mkHot());
  const ck = P + '555';
  t.registerTarget(ck, { platform: 'onebot', guildId: '', channelId: '', userId: '555', bot: fakeBot });
  const r = t.create(ck, { delaySeconds: 60, note: '私聊提醒', userId: '555' });
  ok(r.ok && r.reminder.at.length === 0, '私聊-不@任何人', JSON.stringify(r.reminder.at));
}

// ---------- 6. at_time 今天已过→明天 ----------
{
  const t = newTimers(mkHot());
  t.registerTarget(G, { platform: 'onebot', guildId: '111', channelId: '222', userId: '1000000001', bot: fakeBot });
  const r = t.create(G, { atTime: '00:01', note: '凌晨', userId: '1000000001' });
  const gap = r.ok ? r.reminder.dueAt - Date.now() : -1;
  ok(gap > 0 && gap <= 24 * 3600 * 1000, 'at_time-已过自动顺延到下一次', gap);
  ok(r.ok && /明天处理/.test(r.text), 'at_time-回执提示按明天', r.text);
}

// ---------- 7. 校验：无内容 / 无目标 / 超上限 ----------
{
  const t = newTimers(mkHot({ reminderMaxPerChat: 2 }));
  t.registerTarget(G, { platform: 'onebot', guildId: '111', channelId: '222', userId: '1000000001', bot: fakeBot });
  ok(!t.create(G, { delaySeconds: 60, note: '', userId: '1000000001' }).ok, '校验-空内容被拒');
  ok(!t.create('onebot:9:9', { delaySeconds: 60, note: 'a', userId: '1' }).ok, '校验-无投递目标被拒');
  t.create(G, { delaySeconds: 60, note: 'a', userId: '1000000001' });
  t.create(G, { delaySeconds: 70, note: 'b', userId: '1000000001' });
  ok(!t.create(G, { delaySeconds: 80, note: 'c', userId: '1000000001' }).ok, '校验-超单会话上限被拒');
}

// ---------- 8. 取消 / 列表 / 序号取消 ----------
{
  const t = newTimers(mkHot());
  t.registerTarget(G, { platform: 'onebot', guildId: '111', channelId: '222', userId: '1000000001', bot: fakeBot });
  const a = t.create(G, { delaySeconds: 60, note: '第一个', userId: '1000000001' }).reminder;
  t.create(G, { delaySeconds: 120, note: '第二个', userId: '1000000001' });
  const lst = t.list(G);
  ok(lst.items && lst.items.length === 2, '列表-2个待触发', lst.text);
  const byId = t.cancel(a.id, G);
  ok(byId.ok && t.list(G).items.length === 1, '取消-按编号');
  const bySeq = t.cancel('1', G);
  ok(bySeq.ok && t.pendingCount() === 0, '取消-按序号"1"');
}

// ---------- 9. 到点触发：文案含@、写回 onFire ----------
(async () => {
  const fires = []; const t = newTimers(mkHot(), fires);
  t.registerTarget(G, { platform: 'onebot', guildId: '111', channelId: '222', userId: '1000000001', bot: fakeBot });
  t.__test.createAt(G, Date.now() - 1000, '到点测试', ['1000000001']);
  await t.__test.tryTick();
  ok(fires.length === 1, '触发-onFire 被调用一次', fires.length);
  ok(fires[0] && fires[0].atUserIds[0] === '1000000001', '触发-带上@对象');
  ok(fires[0] && /定时提醒/.test(fires[0].text) && /到点.*叫你/.test(fires[0].text), '触发-文案含“叫你”', fires[0] && fires[0].text);
  ok(t.pendingCount() === 0, '触发-已从待触发移除');

  // ---------- 10. 目标失效（重启后未续链）→ 抛错走重试，不误删 ----------
  const fires2 = []; const t2 = newTimers(mkHot(), fires2);
  // 不 registerTarget 的 bot：直接塞一个无 bot 的目标
  t2.targets.set(G, { platform: 'onebot', guildId: '111', channelId: '222', userId: '1000000001', bot: undefined, updatedAt: Date.now() });
  const r = t2.__test.createAt(G, Date.now() - 1000, '失效测试', ['1000000001']);
  await t2.__test.tryTick();
  ok(fires2.length === 0, '失效-目标无 bot 不投递', fires2.length);
  ok(t2.pendingCount() === 1 && r.attempts === 1 && r.dueAt > Date.now(), '失效-保留并退避重试', JSON.stringify({ n: t2.pendingCount(), att: r.attempts }));

  // ---------- 11. 持久化：落盘可再加载（用独立子目录，避免与其他实例互盖） ----------
  const pdir = fs.mkdtempSync(path.join(tmp, 'persist-'));
  const t3 = newTimers(mkHot(), null, pdir);
  t3.registerTarget(G, { platform: 'onebot', guildId: '111', channelId: '222', userId: '1000000001', bot: fakeBot });
  t3.create(G, { delaySeconds: 600, note: '持久化', userId: '1000000001' });
  await new Promise((res) => setTimeout(res, 600)); // 等 400ms 防抖落盘
  const file = path.join(pdir, 'reminders.json');
  ok(fs.existsSync(file), '持久化-reminders.json 已生成');
  const t4 = newTimers(mkHot(), null, pdir); // 新实例从同一目录磁盘恢复
  ok(t4.loadedInfo.kept >= 1, '持久化-重启恢复待触发', JSON.stringify(t4.loadedInfo));

  // ---------- 12. 并发 tryTick 重入：同一条到期提醒只投一次（回归线上“重复发送”）----------
  {
    const firesC = [];
    const d = fs.mkdtempSync(path.join(tmp, 'conc-'));
    const slowOnFire = () => new Promise((res) => setTimeout(() => res(true), 20)); // 模拟投递耗时，制造 await 让出窗口
    const tc = timers.create({
      stateDir: d, logger: fakeLogger, hot: mkHot(),
      readJson: (f, r) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return r; } },
      writeJson: () => {},
      onFire: (payload) => { firesC.push(payload); return slowOnFire(); },
    });
    tc.registerTarget(G, { platform: 'onebot', guildId: '111', channelId: '222', userId: '1000000001', bot: fakeBot });
    tc.__test.createAt(G, Date.now() - 1000, '并发测试', ['1000000001']);
    const p1 = tc.__test.tryTick(); // 同步认领后派发 runFire，投递在后台 await
    const p2 = tc.__test.tryTick(); // 该提醒已 status='firing'，pending 过滤捞不到 → 不重复派发
    await Promise.all([p1, p2]);
    ok(firesC.length === 1, '并发-同一条到期提醒只投一次', firesC.length);
    ok(tc.pendingCount() === 0, '并发-触发后已从待触发移除', tc.pendingCount());
  }

  // ---------- 13. 并发派发：两条同时到期的提醒各自独立异步执行、都只投一次 ----------
  {
    const firesP = [];
    const d = fs.mkdtempSync(path.join(tmp, 'par-'));
    let maxActive = 0; let active = 0;
    const tp = timers.create({
      stateDir: d, logger: fakeLogger, hot: mkHot(),
      readJson: (f, r) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { return r; } },
      writeJson: () => {},
      onFire: (payload) => { firesP.push(payload); active += 1; if (active > maxActive) maxActive = active; return new Promise((res) => setTimeout(() => { active -= 1; res(true); }, 30)); },
    });
    const cA = 'onebot:111:222'; const cB = 'onebot:333:444';
    tp.registerTarget(cA, { platform: 'onebot', guildId: '111', channelId: '222', userId: '1000000001', bot: fakeBot });
    tp.registerTarget(cB, { platform: 'onebot', guildId: '333', channelId: '444', userId: '1000000002', bot: fakeBot });
    tp.__test.createAt(cA, Date.now() - 1000, '并发A', ['1000000001']);
    tp.__test.createAt(cB, Date.now() - 1000, '并发B', ['1000000002']);
    await tp.__test.tryTick();
    ok(firesP.length === 2, '并发派发-两条都投到', firesP.length);
    ok(maxActive === 2, '并发派发-两条同时在跑(非串行)', maxActive);
    ok(tp.pendingCount() === 0, '并发派发-两条均已移除', tp.pendingCount());
  }

  console.log(`\n结果：${pass} 通过 / ${failed} 失败`);
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) {}
  process.exit(failed ? 1 : 0);
})();
