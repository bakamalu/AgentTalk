'use strict';
// 成员身份解析（lib/members.js）+ set_reminder 昵称解析（lib/tools.js）冒烟：
// 纯逻辑、不联网、不依赖 Koishi。重点验证“昵称→不透明 userId”这条链路不绑定 QQ：
// 同一套代码既能解析 QQ 数字号，也能解析 wxid 这类非数字 ID。
// ⚠ 先清空 shell 继承的真实 BOT_* 环境变量（见记忆「冒烟测试需先清空 BOT_*」）。
process.env.BOT_REMINDER_ENABLED = '';
process.env.BOT_ALLOWED_USERS = ''; process.env.BOT_ALLOWED_GROUPS = '';
process.env.BOT_ADMIN_USERS = ''; process.env.BOT_ADMIN_GROUP = '';
process.env.BOT_BLACKLIST_USERS = ''; process.env.BOT_BLACKLIST_GROUPS = '';

const membersLib = require('../bot/lib/members');
const timers = require('../bot/lib/timers');
const toolsLib = require('../bot/lib/tools');

let pass = 0; let failed = 0;
const ok = (cond, name, extra) => { if (cond) { pass++; console.log('  ✓ ' + name); } else { failed++; console.log('  ✗ ' + name + (extra ? '  -> ' + extra : '')); } };

const fakeLogger = { info() {}, warn() {}, error() {} };
const mkHot = (over = {}) => Object.assign({
  reminderEnabled: true, reminderMaxPerChat: 10, reminderMaxTotal: 200,
  reminderMaxDelayS: 86400, reminderAtRequester: true, reminderMaxAt: 5,
}, over);

// Satori getGuildMemberList 返回的抽象成员形态（user.id 不透明；name=群名片，user.name=昵称）
const FIXTURE = [
  { user: { id: '990001', name: 'DTAE' }, name: 'DTAE' },
  { user: { id: '990003', name: 'Alice' }, name: 'Alice' },
  { user: { id: '990004', name: 'Bob' }, name: 'Bobby' },          // 名片与昵称不同
  { user: { id: 'wxid_abc', name: '小明' }, name: '小明' },         // 非 QQ 形态的 ID
  { user: { id: '880001', name: '路人甲' }, name: '路人' },         // 两人同名 → 歧义
  { user: { id: '880002', name: '路人乙' }, name: '路人' },
];
// 假 bot：getGuildMemberList 记录被调用次数，用于验证 60s 缓存
const mkBot = (counter) => ({
  getGuildMemberList: async () => { if (counter) counter.n += 1; return { data: FIXTURE }; },
  internal: { sendGroupMsg: async () => {}, sendPrivateMsg: async () => {} },
  sendMessage: async () => {},
});

const G = 'onebot:500:500:900000001';
const targetOf = (bot) => ({ platform: 'onebot', guildId: '500', channelId: '500', userId: '900000001', bot });

(async () => {
  // ---------- A. members.resolveNames 单元 ----------
  const fc = { n: 0 };
  const mc = membersLib.create({ logger: fakeLogger });
  const target = targetOf(mkBot(fc));

  const a1 = await mc.resolveNames(target, ['DTAE']);
  ok(a1.ids.length === 1 && a1.ids[0] === '990001', '解析-昵称全等', JSON.stringify(a1));

  const a2 = await mc.resolveNames(target, ['alice']);
  ok(a2.ids[0] === '990003', '解析-大小写无关', JSON.stringify(a2));

  const a3 = await mc.resolveNames(target, ['Bobby']);
  ok(a3.ids[0] === '990004', '解析-命中群名片', JSON.stringify(a3));

  const a4 = await mc.resolveNames(target, ['小 明']);   // 带空格，归一化后应命中
  ok(a4.ids[0] === 'wxid_abc', '解析-空白无关 & 非QQ形态ID(wxid)', JSON.stringify(a4));

  const a5 = await mc.resolveNames(target, ['DTA']);     // 唯一前缀/包含
  ok(a5.ids[0] === '990001', '解析-唯一包含匹配', JSON.stringify(a5));

  const a6 = await mc.resolveNames(target, ['路人']);     // 两人同名 → 歧义，不猜
  ok(a6.ids.length === 0 && a6.ambiguous.includes('路人'), '解析-多命中判歧义不猜', JSON.stringify(a6));

  const a7 = await mc.resolveNames(target, ['查无此人']);
  ok(a7.missed.includes('查无此人') && a7.ids.length === 0, '解析-查无归入 missed', JSON.stringify(a7));

  // 适配器没实现 getGuildMemberList → unavailable（业务层据此降级为按 ID @）
  const mcNoApi = membersLib.create({ logger: fakeLogger });
  const a8 = await mcNoApi.resolveNames(targetOf({ internal: {} }), ['DTAE']);
  ok(a8.unavailable === true && a8.missed.includes('DTAE'), '解析-无接口时标记 unavailable', JSON.stringify(a8));

  // 缓存：同一 members 实例短时间内多次解析只拉一次全表
  ok(fc.n === 1, `缓存-多次解析只拉一次表（实际拉取 ${fc.n} 次）`);

  // ---------- B. tools.exec set_reminder 端到端：昵称解析进 @ ----------
  const fc2 = { n: 0 };
  const t = timers.create({
    stateDir: '', logger: fakeLogger, hot: mkHot(),
    onFire: () => true,
  });
  t.registerTarget(G, targetOf(mkBot(fc2)));
  const hub = toolsLib.create({ logger: fakeLogger, hot: mkHot(), timers: t });

  const r1 = await hub.exec('set_reminder', JSON.stringify({ note: '查苏州天气并播报', delay_seconds: 120, at_user_names: ['DTAE'] }), { chatKey: G, userId: '900000001' });
  ok(r1.queries.includes('提醒:已设'), '集成-set_reminder 建成', r1.text);
  const it1 = t.list(G).items[0];
  ok(it1 && it1.at.length === 1 && it1.at[0] === '990001', '集成-昵称解析成 userId 并入 @', JSON.stringify(it1 && it1.at));

  // 查不到的昵称 → 回落默认 @ 设表人，且回执告知需向用户要 ID
  const r2 = await hub.exec('set_reminder', JSON.stringify({ note: 'x', delay_seconds: 60, at_user_names: ['查无此人'] }), { chatKey: G, userId: '900000001' });
  ok(/没找到/.test(r2.text), '集成-查无昵称在回执里提示要 ID', r2.text);
  const it2 = t.list(G).items.find((x) => x.note === 'x');
  ok(it2 && it2.at[0] === '900000001', '集成-查无时回落@设表人', JSON.stringify(it2 && it2.at));

  // 两个 set_reminder 复用同一成员表缓存（fc2 只在首个 names 请求时拉一次）
  ok(fc2.n === 1, `集成-tools 内多次解析复用缓存（拉取 ${fc2.n} 次）`);

  // ---------- C. schemas 排除集：延迟代理轮不能再拿到提醒类工具（防递归） ----------
  const allNames = hub.schemas().map((t) => t.function.name);
  const execNames = hub.schemas(['set_reminder', 'list_reminders', 'cancel_reminder']).map((t) => t.function.name);
  ok(allNames.includes('set_reminder'), 'schemas-默认下发提醒工具');
  ok(!execNames.includes('set_reminder') && !execNames.includes('cancel_reminder'), 'schemas-延迟轮排除提醒工具防递归', JSON.stringify(execNames));

  console.log(`\n结果：${pass} 通过 / ${failed} 失败`);
  process.exit(failed ? 1 : 0);
})();
