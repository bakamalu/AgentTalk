'use strict';

// ===== 关键词搜图（Bing 图片，免 key）+ 服务端下载转 base64 =====
// 这是“图片输入/输出”链路里的**首选拿图方式**：用户想要“现成的图/照片/某物长啥样/表情包配图”时，
// 先按关键词搜真实图片，再由 lib/tools.js 借 execCtx.visionCheck 逐张核对是否契合当前场景，
// 契合才发；都找不到合适图时才退回 generate_image 生图兜底（省额度、避免“主动乱生图”）。
//
// 本机实测（11-03 探针）：cn.bing.com/images/search HTTP 200；直链被 HTML 实体转义塞在
//   m="{&quot;murl&quot;:&quot;http:\/\/...&quot;,...}" 里，需先解码 &quot; 再抠 "murl"；
//   解码后单页可得 ~35 条 murl，且我们服务端能直接拉回真 JPEG 字节（部分站点有防盗链，故统一下载转 base64 内联发送）。
//
// 本模块只做“搜 + 下载”，不碰模型、不碰 QQ 发送：视觉校验与发图由 tools/deepseek/sender 完成。

const { detectImageMime } = require('./text');
const { normalizeQuery } = require('./websearch');

const TOOL = {
  type: 'function',
  function: {
    name: 'search_image',
    description: '按关键词从网上搜真实图片，并**逐张核对是否契合当前场景**，契合就直接发送给用户（最多核对 3 张）。'
      + '当用户想要“现有的图/照片/某物长什么样/表情包配图/来张关于…的图”时**优先调用本工具**，而不是直接凭空生图。'
      + '只有搜不到合适的图、或用户明确要“原创/画一张不存在的东西”时，才改用 generate_image 兜底。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: '搜图关键词，2~4 个核心词、空格分隔（例：“橘猫 侦探 卡通”“苏州 园林 秋天”）；不要写完整句子、不要加年份/“最新/实时”。',
        },
        need: {
          type: 'string',
          description: '用一句话讲清用户此刻到底想要什么样的图/用在什么场景（会用来做“是否契合”的视觉核对）。留空则按 query 核对。',
        },
      },
      required: ['query'],
    },
  },
};

// HTML 实体解码（Bing 把 murl 的 JSON 用 &quot; 转义了）
const decodeEntities = (s) => String(s)
  .replace(/&quot;/g, '"').replace(/&#34;/g, '"').replace(/&amp;/g, '&')
  .replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// 从（已解码）HTML 抠 murl 直链列表，去重、只留 http(s)、去掉明显的非法/内网地址
const extractMurls = (decodedHtml) => {
  const out = [];
  const seen = new Set();
  const re = /"murl":"(https?:\\?\/\\?\/[^"]+?)"/g;
  for (const m of String(decodedHtml).matchAll(re)) {
    const url = m[1].replace(/\\\//g, '/').trim();
    if (!/^https?:\/\//i.test(url)) continue;              // 只要公网 http(s)
    if (/localhost|127\.0\.0\.1|10\.\d|192\.168|172\.1[6-9]/i.test(url)) continue; // 挡内网
    if (!seen.has(url)) { seen.add(url); out.push(url); }
  }
  return out;
};

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

// 搜图：返回 { urls, query, error? }（urls 已去重、按搜索引擎排序截到 maxCandidates）
const searchImages = async (rawQuery, { logger = console, maxCandidates = 5, timeoutMs = 8000 } = {}) => {
  const normalized = normalizeQuery(rawQuery) || String(rawQuery || '').trim();
  if (!normalized) return { urls: [], query: '', error: 'empty' };
  const url = `https://cn.bing.com/images/search?q=${encodeURIComponent(normalized)}&form=HDRSC2&first=1`;
  let html = '';
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { urls: [], query: normalized, error: `http ${res.status}` };
    html = await res.text();
  } catch (error) {
    const message = String(error?.message || error).slice(0, 120);
    logger.warn(`[搜图] 请求失败 q="${normalized}": ${message}`);
    return { urls: [], query: normalized, error: message };
  }
  const urls = extractMurls(decodeEntities(html)).slice(0, Math.max(1, Number(maxCandidates) || 5));
  logger.info(`[搜图] q="${normalized}" 抠到直链 ${urls.length} 条`);
  return { urls, query: normalized };
};

// 下载一张候选图 → base64。返回 { b64, dataUrl, mime } 或 null（失败/超限/格式不支持）
// dataUrl 供视觉校验（OpenAI image_url 用 data: 形态）；base64File 供发送（OneBot 段用 base64:// 形态）。
const fetchImageBase64 = async (url, { logger = console, timeoutMs = 8000, maxBytes = 16 * 1024 * 1024 } = {}) => {
  if (!/^https?:\/\//i.test(String(url || ''))) return null;
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Referer: 'https://cn.bing.com/' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length || buf.length > maxBytes) return null;
    const mime = detectImageMime(buf);
    if (!mime) return null; // 仅 JPEG/PNG/GIF/WebP
    const b64 = buf.toString('base64');
    return { b64, mime, bytes: buf.length, dataUrl: `data:${mime};base64,${b64}`, base64File: `base64://${b64}` };
  } catch (error) {
    const cause = error?.cause?.code || error?.cause?.message || '';
    logger.warn(`[搜图] 下载失败 ${String(url).slice(0, 90)}: ${String(error?.message || error).slice(0, 60)}${cause ? ` (${cause})` : ''}`);
    return null;
  }
};

// 视觉核对提示词：要求模型先只回一个判定词（MATCH/NO）再补短理由，便于确定性解析
const buildVerifyPrompt = (need, query) => ('你在替机器人核对一张网上搜来的配图，能不能直接发给用户。'
  + `用户想要的画面/场景是：「${String(need || query || '').trim()}」。`
  + '只看图本身判断是否切题、清晰、无明显水印/无关文字/不适宜内容。'
  + '严格按这个格式回答：第一个词只能是 MATCH（合适）或 NO（不合适），然后用不超过 15 字说明原因。')
  + `\n（搜图关键词：${String(query || '').trim()}）`;

// 从模型回答里判定是否契合：取第一个标点/空格分隔的词，等于 MATCH 才算过
const parseVerdict = (text) => {
  const head = String(text || '').trim().split(/[\s，,。.；;：:]/)[0].toUpperCase();
  return { fits: head === 'MATCH', head };
};

module.exports = { TOOL, searchImages, fetchImageBase64, extractMurls, decodeEntities, buildVerifyPrompt, parseVerdict, normalizeQuery };
