'use strict';

// ===== 消息段（元素）统一分派表 + 未知类型遥测 =====
// 背景（11-03 复盘）：Koishi 的 session.content 是 satori 元素序列化串，lib/text.normalizeText 里
//   `<[^>]+>` 会把 <语音>/<视频>/<json卡片>/<转发> 等"非纯文本段"整段抹掉 → 模型对这些是瞎的。
//   合并转发只是你先撞上的一个；同类的还有：音乐 / 小程序 / 分享 / 礼物 / 骰子(魔法表情) / 猜拳 /
//   文件 / 位置 …… 以及以后 QQ 新出的各种卡片。逐个手写兜底（像 quote.js/forward.js）不可持续。
// 这里把"一个段该渲染成什么人可读的文本"抽成一张表：
//   - 已知类型：渲染成带关键信息（标题/文件名/URL 等）的可读占位，而不是一片空白；
//   - 未知类型：退化成 [type] 占位，并把它的 attr keys 记一条遥测日志（只记类型和字段名、不记内容，避免敏感），
//     这样"下一个看不懂的卡片"会先在日志里冒出来，而不是等群里有人抱怨。
// 两种来源共用同一张表：入站 satori 元素（{type,attrs}，当前消息）、转发节点段（{type,data}，getForwardMsg 返回）。

const { normalizeText } = require('./text');

// 已知段类型（渲染规则覆盖到了；不在表里的进 default → 触发遥测）。
// 兼容 satori 名(audio) 与 OneBot 名(record)，以及现代 QQ 的 mface(骰子/魔法表情)。
const KNOWN = new Set([
  'text', 'at', 'face', 'mface', 'image', 'audio', 'record', 'video', 'file', 'contact', 'location',
  'forward', 'node', 'reply', 'quote', 'source',
  'json', 'xml', 'music', 'share', 'gift', 'dice', 'poker', 'miniapp', 'poke', 'cardimage', 'tts', 'video-card',
]);

// 取段属性：satori 用 attrs、OneBot 用 data，两者都兼容
const attrsOf = (x) => (x && (x.attrs || x.data)) || {};

const trim = (s, n = 40) => {
  s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n) + '…' : s;
};

// json/xml 卡片的 payload 常是一段 JSON 或 XML（有时是 URL）。尽力抠出可读标题/描述；
// 各网关字段不一，纯 best-effort，抠不到就返回空串（只留 [卡片] 占位，不报错）。
const cardMeta = (raw) => {
  if (raw == null) return '';
  const s = String(raw);
  if (/^https?:\/\//i.test(s.trim())) return ''; // 纯 URL 型 payload 不当文本
  try {
    const o = JSON.parse(s);
    const pick = (obj, keys) => {
      if (!obj || typeof obj !== 'object') return '';
      for (const k of keys) { const v = obj[k]; if (v != null && typeof v !== 'object') return String(v); }
      return '';
    };
    const t = pick(o, ['title', 'desc', 'prompt', 'content'])
      || pick(o.config, ['prompt'])
      || pick(o.app, ['name'])
      || pick(o.meta && o.meta.detail_1, ['txt'])
      || pick(o.preview, ['title', 'desc']);
    return trim(t, 60);
  } catch (_) { /* 非 JSON，退而抠 XML 标签 */ }
  const m = s.match(/<(?:title|desc|prompt)[^>]*>([^<]+)</i);
  return m ? trim(m[1], 60) : '';
};

// 单个段 → 人可读文本。
//   mode='body'：用于当前消息（text 交回原文；at 交回空格，与 normalizeText 既有行为一致）
//   mode='forward'：用于转发节点（at 显示成 [@qq]，便于模型看到"谁在说话/被@"）
const renderElement = (el, mode, telemetry) => {
  const type = el && el.type;
  const a = attrsOf(el);
  switch (type) {
    case 'text': return String(a.text ?? a.content ?? '');
    case 'at': return mode === 'forward' ? ('[@' + (a.qq || a.id || '') + ']') : ' ';
    case 'face': return '[' + (trim(a.name, 12) || '表情') + ']';
    case 'mface': return '[' + (trim(a.name, 16) || '表情') + ']'; // 骰子/魔法表情等
    case 'image': return '[图片]';
    case 'audio': case 'record': return '[语音]';
    case 'video': case 'video-card': return '[视频]' + (a.url ? ' ' + trim(a.url, 30) : '');
    case 'file': return '[文件]' + (a.name || a.file ? ' ' + trim(a.name || a.file) : '');
    case 'contact': return '[联系方式]';
    case 'location': return '[位置]' + (a.name || a.address || a.content ? ' ' + trim(a.name || a.address || a.content) : '');
    case 'forward': return '[聊天记录]'; // 真实内容由 lib/forward.js 递归展开
    case 'node': case 'reply': case 'quote': case 'source': return mode === 'forward' ? '' : '[引用]';
    case 'music': return '[音乐]' + (a.title || a.content ? ' ' + trim(a.title || a.content) : '') + (a.url ? ' ' + trim(a.url, 30) : '');
    case 'share': return '[分享]' + (a.title ? ' ' + trim(a.title) : '') + (a.url ? ' ' + trim(a.url, 30) : '');
    case 'gift': return '[礼物]';
    case 'dice': return '[骰子' + (a.result != null ? ':' + a.result : '') + ']';
    case 'poker': return '[猜拳]';
    case 'miniapp': return '[小程序]' + (a.appName || a.title ? ' ' + trim(a.appName || a.title) : '');
    case 'poke': return '[戳一戳]';
    case 'cardimage': return '[卡片图]';
    case 'tts': return '[文字转语音]';
    case 'json': case 'xml': { const m = cardMeta(a.data ?? a.raw ?? a.content ?? ''); return '[卡片]' + (m ? ' ' + m : ''); }
    default: {
      if (type && telemetry) telemetry(type, Object.keys(a));
      return type ? ('[' + trim(type, 16) + ']') : '';
    }
  }
};

// 当前消息正文（进模型的那份）：text 原样；at 渲染成 `@QQ<id>`（机器人自己的 @ 去掉、@全体单列）；
//   其余段沿用 body 口径的占位符。
//   ⚠ 不能直接用 normalizeText：它会把 at 段抹成空格，用户说「总结一下@某某 他的记录」时
//   模型只剩一个空代词（11-05 18:42 实测：正文分明有 @，回复却是“得先知道指的是谁”）。
const bodyOfElements = (elements, selfId) => {
  const els = Array.isArray(elements) ? elements : [];
  if (!els.length) return '';
  const self = String(selfId || '');
  const parts = [];
  for (const el of els) {
    if (!el) continue;
    if (el.type === 'at') {
      const a = attrsOf(el);
      const id = String(a.id ?? a.qq ?? '');
      if (!id || id === self) continue; // 唤醒用的 @机器人 不进正文
      if (id === 'all' || id === '全部' || id === '全体') { parts.push(' @全体成员 '); continue; }
      parts.push(' @QQ' + id + ' '); // 昵称由插件在回复前补（群成员表有缓存）
      continue;
    }
    parts.push(renderElement(el, 'body'));
  }
  return parts.join('').replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
};

const create = ({ logger = console, hot } = {}) => {
  const seen = new Set(); // 遥测去重：同一未识别 type 一个进程只记一次，避免刷屏
  const telemetry = (type, keys) => {
    if (!hot || hot.segNotes === false) return;
    if (seen.has(type)) return;
    seen.add(type);
    logger.info(`[段遥测] 未识别消息段 type=${type} keys=${(keys || []).join('/') || '(无)'}（已按 [${type}] 占位喂模型；要专门解析就在 lib/segments.js 的表里加一条 case）`);
  };

  // 转发节点里一段 content（OneBot 段数组）→ 文本；字符串则走 normalizeText
  const renderSegs = (arr) => {
    const out = [];
    for (const seg of (arr || []).slice(0, 20)) {
      const t = renderElement(seg, 'forward', telemetry);
      if (t) out.push(t);
    }
    return out.join('').replace(/\s+/g, ' ').trim();
  };

  // 当前消息：只挑"非纯文本、且未被其它专门逻辑覆盖"的段生成一句备注。
  //   跳过 text/at（会改动已验证的 rawText 链路）与 forward/node/reply/quote/source
  //   （转发由 forward.js 展开、引用由 quote.js 取原文，别在这里重复占位）。
  const SKIP = new Set(['text', 'at', 'forward', 'node', 'reply', 'quote', 'source']);
  const describeNonText = (elements) => {
    const notes = [];
    for (const el of elements || []) {
      const ty = el && el.type;
      if (!ty || SKIP.has(ty)) continue;
      const s = String(renderElement(el, 'body', telemetry)).trim();
      if (s && !notes.includes(s)) notes.push(s);
    }
    return notes.join(' ');
  };

  return { describeNonText, renderSegs, renderElement, telemetry, normalizeText };
};

module.exports = { create, KNOWN, attrsOf, renderElement, bodyOfElements, cardMeta };
