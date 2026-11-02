'use strict';

// ===== 成员身份解析（平台无关）=====
// 把「昵称 / 群名片」解析成该平台的**不透明 userId**——不是只有 QQ：onebot 给数字号、
// 微信给 wxid、贴吧给 uid 都能一样处理。业务层（timers/tools/deepseek）只认 userId 字符串。
//
// 为什么能跨平台：这里走 Satori 的抽象接口 `bot.getGuildMemberList(channelId)`，
// 每个适配器都必须实现它（onebot 现在就用；接微信/贴吧时各自适配器实现同一签名即可），
// 所以新增平台**不用改这个文件**，也不许在这里碰 `bot.internal.*` 这类适配器私有 API。
//
// 本模块只做「查表 + 名字匹配 + 短缓存」；到点怎么把 userId 编成各平台的 @ 段，
// 在 lib/sender.js 里按 platform 分派，不混到这儿。

const CACHE_TTL_MS = 60000; // 成员表缓存 60s：一次 @ 多人或频繁设表不重复拉全表

// 归一化用于匹配：去空白、转小写，昵称/名片大小写与全半角空格差异不影响命中
const norm = (s) => String(s ?? '').trim().toLowerCase().replace(/\s+/g, '');

const create = ({ logger = console } = {}) => {
  const warn = (...a) => logger.warn?.(...a);
  const cache = new Map(); // listKey -> { ts, members:[{ id, names:[...] }] }

  // 拉某会话的成员表（优先用缓存）。listKey 用 platform+群/频道 id 组合，跨会话不串
  const loadMembers = async (target) => {
    const bot = target && target.bot;
    const listId = String((target && (target.guildId || target.channelId)) || '');
    if (!bot || !listId) return null;
    if (typeof bot.getGuildMemberList !== 'function') return null; // 该平台/版本没实现，交给调用方兜底
    const key = `${target.platform || 'onebot'}:${listId}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return hit.members;
    try {
      const res = await bot.getGuildMemberList(listId);
      const arr = (res && Array.isArray(res.data)) ? res.data : (Array.isArray(res) ? res : []);
      const members = arr.map((m) => {
        const id = String(m?.user?.id ?? m?.id ?? '');
        // 可匹配的名字：群名片(name) + 用户昵称/用户名(user.name / user.username)
        const names = [m?.name, m?.user?.name, m?.user?.username]
          .map((n) => String(n ?? '').trim()).filter(Boolean);
        return { id, names };
      }).filter((m) => m.id);
      cache.set(key, { ts: Date.now(), members });
      return members;
    } catch (error) {
      warn(`[成员] getGuildMemberList 失败(${key}): ${String(error?.message || error).slice(0, 120)}`);
      return null;
    }
  };

  // 解析一组名字 → { ids, matched:[{name,id}], missed:[name], ambiguous:[name], unavailable }
  // 规则（宁缺勿错 @）：先全等匹配；无全等再取“包含”匹配，但**多命中一律判为歧义不猜**。
  const resolveNames = async (target, names) => {
    const uniq = [...new Set((Array.isArray(names) ? names : [names]).flat()
      .map((n) => String(n ?? '').trim()).filter(Boolean))];
    const out = { ids: [], matched: [], missed: [], ambiguous: [], unavailable: false };
    if (!uniq.length) return out;
    const members = await loadMembers(target);
    if (!members) { out.missed = uniq.slice(); out.unavailable = true; return out; }
    for (const nm of uniq) {
      const key = norm(nm);
      let cand = members.filter((m) => m.names.some((x) => norm(x) === key));
      if (!cand.length) cand = members.filter((m) => m.names.some((x) => norm(x).includes(key)));
      const ids = [...new Set(cand.map((m) => m.id))];
      if (!ids.length) { out.missed.push(nm); continue; }
      if (ids.length > 1) { out.ambiguous.push(nm); continue; } // 多人同名/多命中：不猜
      out.matched.push({ name: nm, id: ids[0] });
      out.ids.push(ids[0]);
    }
    return out;
  };

  return { resolveNames, loadMembers, __test: { cache, norm } };
};

module.exports = { create, CACHE_TTL_MS, norm };
