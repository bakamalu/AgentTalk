'use strict';

// ===== 群公告（入口是管理员指令 #公告，见 plugins/deepseek.js handleAdminCommand）=====
// 起因：11-04 13:47 群里有人 @机器人要它「发个公告」，机器人回「元芳没有发公告的权限哦」，
//   日志是 `工具=未调用` —— 它没试过，是代码里压根没有这个动作（工具清单见 lib/tools.js）。
//   网关侧接口其实有（docs/08 的 `_send_group_notice`），所以这不是「不支持」，是「没接」。
// 为什么不做成模型自由调用的工具：公告是**打扰全群**的操作（还会弹窗/推送给每个成员）。
//   挂进 tools.js 就等于任何一句「元芳发个公告骂某某」都可能被模型执行；这里跟 #状态/#重置
//   同一路口径：只认管理员指令，正文由人写死，模型不参与决定发不发。
// 两层权限，缺一不可：
//   ① 谁能触发：BOT_ADMIN_USERS 名单内（群里还要求 BOT_ADMIN_GROUP=1）；
//      或该群的群主/管理员 —— 后者需 BOT_NOTICE_ALLOW_GROUP_ADMIN=1，role 现查网关，默认关。
//   ② 机器人自己在那个群的 role 必须是 owner/admin。这是 QQ 的平台限制，代码绕不过：
//      11-04 实测机器人在群里 role=member，那种情况下接好工具也一定发不出去，
//      所以先查 role 再发，把「我没被提成管理员」这种人话回给用户，而不是等腾讯报错。
// 限流：正文字数上限 + 同群冷却 + 过敏感词，都是防手滑（公告撤回要靠 _del_group_notice，很显眼）。

const CMD_RE = /^[#＃]\s*(?:群公告|公告)\s*/;
const ROLE_OK = new Set(['owner', 'admin']);
const GROUP_ID_RE = /^\d{5,12}$/;
// 置顶写法：正文最前面单独一个「置顶」（后面跟空格或就到结尾，避免「置顶公告是…」这种正文被误判）
const PIN_RE = /^(置顶|不置顶)(?:[ \t　]+|$)/;

const create = ({ logger = console, hot, api } = {}) => {
  const lastSent = new Map(); // groupId -> 上次成功发布的时刻（同群冷却用）

  // 解析指令文本 → null（不是公告指令）| {kind:'help', why} | {kind:'send', groupId, content, pinned}
  // isGroup=true 时**只发当前群**、不吃群号参数：免得管理员手滑把公告打到别的群去，
  //   也让「在哪个群 @ 的」与「公告发在哪个群」永远一致。私聊必须带群号（第 1 段 5~12 位数字）。
  const parseCommand = (raw, { isGroup = false } = {}) => {
    const text = String(raw || '').trim();
    if (!CMD_RE.test(text)) return null;
    let rest = text.replace(CMD_RE, '').trim();
    let groupId = '';
    if (!isGroup) {
      const head = rest.split(/\s+/)[0] || '';
      if (!GROUP_ID_RE.test(head)) return { kind: 'help', why: head ? '群号得是 5~12 位数字' : '私聊发公告要带群号' };
      groupId = head;
      rest = rest.slice(head.length).trim();
    }
    let pinned = false;
    const pin = rest.match(PIN_RE);
    if (pin) {
      pinned = pin[1] === '置顶';
      rest = rest.slice(pin[0].length).trim();
    }
    if (!rest) return { kind: 'help', why: '公告正文是空的' };
    const max = Math.max(1, Number(hot.noticeMaxChars) || 200);
    if (rest.length > max) return { kind: 'help', why: `正文 ${rest.length} 字，超过上限 ${max} 字` };
    return { kind: 'send', groupId, content: rest, pinned };
  };

  // 查某人在某群的身份（roleOf 复用给插件那侧的「发送者是不是群主/管理员」判断）
  const roleOf = async (session, groupId, userId) => {
    const res = await api.callApi(session, 'get_group_member_info',
      { group_id: Number(groupId), user_id: Number(userId), no_cache: true });
    if (!res.ok) return { ok: false, role: '', error: res.error, ms: res.ms };
    const data = res.data || {};
    return { ok: true, role: String(data.role || ''), name: String(data.card || data.nickname || ''), ms: res.ms };
  };

  // 发一条公告。返回 { ok, why, role, ms }；why 一律是能直接念给用户的话
  const sendNotice = async ({ session, groupId, content, pinned, selfId }) => {
    if (!hot.noticeEnabled) return { ok: false, why: '公告功能没开（BOT_NOTICE_ENABLED=0）' };
    if (!api) return { ok: false, why: '网关动作助手没就绪' };
    const gid = String(groupId || (session && session.guildId) || '');
    if (!GROUP_ID_RE.test(gid)) return { ok: false, why: `群号「${gid}」不像个群号` };
    const max = Math.max(1, Number(hot.noticeMaxChars) || 200);
    if (content.length > max) return { ok: false, why: `正文 ${content.length} 字，超过上限 ${max} 字，没发` };
    const hit = (hot.sensitiveWords || []).find((w) => String(content).includes(w));
    if (hit) return { ok: false, why: `内容命中敏感词「${hit}」，没发` };
    const cooldown = Math.max(0, Number(hot.noticeCooldownMs) || 0);
    const prev = lastSent.get(gid) || 0;
    if (cooldown && Date.now() - prev < cooldown) {
      return { ok: false, why: `这个群 ${Math.ceil((cooldown - (Date.now() - prev)) / 1000)} 秒前刚发过公告，冷却中没发（上限可调 BOT_NOTICE_COOLDOWN_MS）` };
    }
    if (!selfId) return { ok: false, why: '拿不到机器人自己的号，没法查我在群里的身份' };
    const me = await roleOf(session, gid, selfId);
    if (!me.ok) return { ok: false, why: `查我在该群的身份失败：${me.error}` };
    if (!ROLE_OK.has(me.role)) {
      return { ok: false, role: me.role, why: `我在那个群里只是「${me.role || '未知身份'}」——QQ 只让群主/管理员发公告，先把我提上去才行` };
    }
    const res = await api.callApi(session, '_send_group_notice',
      { group_id: Number(gid), content, pinned: pinned ? 1 : 0 });
    if (!res.ok) return { ok: false, role: me.role, ms: res.ms, why: `网关回错了：${res.error}` };
    lastSent.set(gid, Date.now());
    logger.info(`[公告] 已发到群 ${gid}（${pinned ? '置顶' : '普通'}，${content.length} 字，role=${me.role}，耗时 ${res.ms}ms）：${content.slice(0, 40)}`);
    return { ok: true, role: me.role, ms: res.ms, pinned, groupId: gid, brief: content.slice(0, 40) };
  };

  // 各场景的用法提示（指令写法只在 parseCommand 这一处定义，帮助文案也从这儿出，免得两边说两套）
  const helpText = ({ isGroup = false } = {}) => {
    const base = isGroup
      ? '#公告 [置顶] <正文>　（在哪个群 @ 我就发那个群）'
      : '#公告 <群号> [置顶] <正文>';
    return `发公告的写法：${base}\n例：${isGroup ? '#公告 置顶 今晚八点半会议室集合' : '#公告 123456789 置顶 今晚八点半会议室集合'}\n`
      + `限制：正文≤${Math.max(1, Number(hot.noticeMaxChars) || 200)} 字、同群 ${Math.round((Number(hot.noticeCooldownMs) || 0) / 1000)}s 内只能发一条、要过敏感词；`
      + '而且得先在群里把我设成群管理员，普通成员我发不了。';
  };

  return { parseCommand, sendNotice, roleOf, helpText, ROLE_OK, __test: { lastSent, CMD_RE, PIN_RE, GROUP_ID_RE } };
};

module.exports = { create, CMD_RE, PIN_RE, GROUP_ID_RE, ROLE_OK };
