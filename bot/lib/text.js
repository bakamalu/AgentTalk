'use strict';

// ===== 纯文本工具（无状态、无副作用，可单独测试） =====
// 从 plugins/deepseek.js 拆出：QQ 消息整形、Bing HTML 片段清洗、图片魔数识别。

// Bing 摘要里大量 &ensp; &middot; 之类的命名实体，未识别的原样保留不丢信息。
const NAMED_ENTITIES = {
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', middot: '·', hellip: '…',
  mdash: '—', ndash: '–', bull: '•', deg: '°', times: '×', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
};

const decodeEntities = (s) => String(s)
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&([a-z]+);/gi, (m, name) => (name.toLowerCase() in NAMED_ENTITIES ? NAMED_ENTITIES[name.toLowerCase()] : m))
  .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// 去掉 HTML 标签 + 解实体 + 压空白（搜索结果标题/摘要用）
const cleanFragment = (s) => decodeEntities(String(s).replace(/<[^>]+>/g, '')).replace(/\s+/g, ' ').trim();

// CQ 码 / 富文本标签 → 人可读的纯文本占位
const normalizeText = (text = '') => String(text)
  .replace(/\[CQ:image[^\]]*\]/gi, '[图片]')
  .replace(/\[CQ:record[^\]]*\]/gi, '[语音]')
  .replace(/\[CQ:video[^\]]*\]/gi, '[视频]')
  .replace(/\[CQ:face[^\]]*\]/gi, '[表情]')
  .replace(/\[CQ:at[^\]]*\]/gi, ' ')
  .replace(/<[^>]+>/g, '')
  .replace(/[ \t]{2,}/g, ' ')
  .trim();

// QQ 不渲染 Markdown，发送前转纯文本
const toPlainText = (text = '') => String(text)
  .replace(/```[a-zA-Z0-9]*\n?/g, '')
  .replace(/`([^`]+)`/g, '$1')
  .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
  .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
  .replace(/^#{1,6}\s+/gm, '')
  .replace(/\*\*([^*]+)\*\*/g, '$1')
  .replace(/(^|[^*])\*([^*]+)\*/g, '$1$2')
  .replace(/^\s*[-*+]\s+/gm, '· ')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

// 长文本分段，避免被 QQ 单条长度上限截断（优先按换行切）
const splitText = (text, limit, maxParts) => {
  if (text.length <= limit) return [text];
  const parts = [];
  let rest = text;
  while (rest.length > limit && parts.length < maxParts - 1) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit * 0.5) cut = limit;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) parts.push(rest);
  return parts.filter(Boolean);
};

// NapCat 给的图片 MIME 常不准，按魔数判格式（DeepSeek 只看内容）
const detectImageMime = (buf) => {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8) return 'image/jpeg';
  if (buf.length >= 8 && buf.toString('hex', 0, 8) === '89504e470d0a1a0a') return 'image/png';
  if (buf.length >= 6 && 'GIF8'.includes(buf.slice(0, 4).toString('ascii').slice(0, 4)) && buf.slice(0, 3).toString('ascii') === 'GIF') return 'image/gif';
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
};

// 当前时间注入：模型自己不知道何年何月，否则“今天周几”只能瞎猜。
// ⚠ 绝不能用 toISOString()：那是 UTC，服务器在 UTC+8，直接拿去用会整整差 8 小时、
//   而且跨午夜时星期也会算错。
const timeLine = (d = new Date()) => {
  const pad = (n) => String(n).padStart(2, '0');
  const tzOffset = -d.getTimezoneOffset() / 60;
  return `当前时间：${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} `
    + `${pad(d.getHours())}:${pad(d.getMinutes())} `
    + `${['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]}`
    + `（UTC${tzOffset >= 0 ? '+' : ''}${tzOffset}）`;
};

module.exports = {
  NAMED_ENTITIES,
  decodeEntities,
  cleanFragment,
  normalizeText,
  toPlainText,
  splitText,
  detectImageMime,
  timeLine,
};
