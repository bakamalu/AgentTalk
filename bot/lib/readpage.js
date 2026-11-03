'use strict';

// ===== 网页正文读取（read_url）=====
// 为什么需要：web_search 只回标题+摘要（Bing 结构上就拿不到深度数据，如具体比分/名单/日期），
//   模型常因此说“数据没查到”。本工具让模型用搜索结果里给出的 URL 打开原始网页、抽正文喂回去，
//   补上摘要里没有的信息。
// 边界（本机实测 11-03）：对静态/新闻页有效（腾讯新闻能抽出上千字正文）；对反爬墙
//   （baike / britannica 回 403）与纯 JS 渲染 SPA（抓回来是空正文）读不到——这不是 bug，
//   是“免浏览器抓取”的固有上限，所以失败一律如实回文字、绝不硬编造。

const { decodeEntities } = require('./text');

const MAX_HTML_BYTES = 800 * 1024; // 单页最多读 800KB，防低内存机被超大页面撑爆
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const TOOL = {
  type: 'function',
  function: {
    name: 'read_url',
    description: '打开一个网页链接，抽取正文纯文本返回。用于 web_search 摘要里没有的深度信息'
      + '（具体比分、日期、名单、条款原文、人物履历等）。url 请取自 web_search 结果里给出的链接，或用户直接发来的链接。'
      + '注意：反爬站点或纯 JS 渲染的页面可能读不到正文，读不到就如实说，不要编造内容。',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: '要打开的网页完整链接（http/https），一般来自 web_search 结果里的 URL' },
      },
      required: ['url'],
    },
  },
};

// SSRF 防护：只放 http/https，且挡掉回环/私网/链路本地/元数据地址（服务端替模型发请求，不能让它够到内网）。
const PRIVATE_HOST = /^(localhost|0\.0\.0\.0|\[?::1\]?|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.)/i;

const guardUrl = (raw) => {
  const u = String(raw || '').trim();
  if (!u) return { ok: false, reason: '链接为空' };
  let parsed;
  try { parsed = new URL(u); } catch (_) { return { ok: false, reason: '链接格式不对（需要完整 http/https 地址）' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return { ok: false, reason: '只支持 http/https 链接' };
  if (PRIVATE_HOST.test(parsed.hostname)) return { ok: false, reason: '出于安全不访问内网地址' };
  return { ok: true, url: parsed.href };
};

// 从 HTML 抽正文：先删脚本/样式/导航等噪音，再取 article>main>body 容器里的结构化文本行。
// cheerio 延迟 require：只有真要解析时才加载，保持模块被 require 时零副作用。
const extractText = (html) => {
  const cheerio = require('cheerio');
  const $ = cheerio.load(html);
  $('script,style,noscript,template,nav,header,footer,aside,form,iframe,svg,button').remove();
  const title = decodeEntities($('title').text() || '').replace(/\s+/g, ' ').trim();
  const root = $('article').length ? $('article') : ($('main').length ? $('main') : $('body'));
  const lines = [];
  root.find('h1,h2,h3,h4,p,li,td,th,blockquote,dd,dt').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t && t.length > 1) lines.push(t);
  });
  let text = lines.join('\n');
  if (text.length < 40) text = root.text().replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
  text = text.replace(/\n{3,}/g, '\n\n').trim();
  return { title, text };
};

// 返回 { ok, text, url, title, reason? }；任何失败都是 ok:false + 文字原因，交回模型如实说明。
const read = async (rawUrl, opts = {}) => {
  const logger = opts.logger || console;
  const timeoutMs = Math.max(2000, Number(opts.timeoutMs) || 12000);
  const maxChars = Math.max(500, Number(opts.maxChars) || 4000);
  const g = guardUrl(rawUrl);
  if (!g.ok) return { ok: false, url: String(rawUrl || ''), reason: g.reason, text: `无法打开链接：${g.reason}。请如实告知用户读不了这个页面，不要编造内容。` };

  let res;
  try {
    res = await fetch(g.url, {
      headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      redirect: 'follow', signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const cause = (error && error.cause && (error.cause.code || error.cause.message)) || '';
    const msg = String((error && error.message) || error).slice(0, 80);
    logger.warn(`[读页] 请求失败 ${g.url.slice(0, 80)}: ${msg}${cause ? ` (${cause})` : ''}`);
    return { ok: false, url: g.url, reason: cause || msg, text: `打开网页失败（${cause || msg}）。可能对方拒绝访问或超时，请如实告知用户没读到，不要编造。` };
  }

  const ct = (res.headers.get('content-type') || '').toLowerCase();
  if (!res.ok) {
    logger.info(`[读页] HTTP ${res.status} ${g.url.slice(0, 80)}`);
    return { ok: false, url: g.url, reason: `HTTP ${res.status}`, text: `网页返回 ${res.status}（多半是反爬拦截或页面不存在），读不到正文。请如实告知用户没读到，可换一个来源，不要编造。` };
  }
  if (ct && !/html|xml|text\/plain/.test(ct)) {
    return { ok: false, url: g.url, reason: '非网页内容', text: `这个链接不是可读网页（content-type=${ct.slice(0, 30)}），没有正文可抽取。` };
  }

  let html;
  try {
    const buf = Buffer.from(await res.arrayBuffer());
    const slice = buf.length > MAX_HTML_BYTES ? buf.subarray(0, MAX_HTML_BYTES) : buf;
    html = slice.toString('utf8');
  } catch (error) {
    const msg = String((error && error.message) || error).slice(0, 80);
    logger.warn(`[读页] 读取正文失败 ${g.url.slice(0, 80)}: ${msg}`);
    return { ok: false, url: g.url, reason: msg, text: `网页内容读取失败（${msg}），请如实告知用户没读到，不要编造。` };
  }

  let title = '';
  let text = '';
  try {
    const ex = extractText(html);
    title = ex.title;
    text = ex.text;
  } catch (error) {
    const msg = String((error && error.message) || error).slice(0, 80);
    logger.warn(`[读页] 解析失败 ${g.url.slice(0, 80)}: ${msg}`);
    return { ok: false, url: g.url, reason: msg, text: `网页解析失败（${msg}），请如实告知用户没读到，不要编造。` };
  }

  if (!text || text.length < 20) {
    logger.info(`[读页] 正文为空（可能 JS 渲染/反爬）${g.url.slice(0, 80)}`);
    return { ok: false, url: g.url, reason: '正文为空', text: `打开了该链接但抽不到正文（多半是纯 JS 渲染或反爬页面）。请换一个来源，或如实告知用户这个页面读不了，不要编造。` };
  }

  const clipped = text.length > maxChars ? `${text.slice(0, maxChars)}…（正文过长已截断）` : text;
  logger.info(`[读页] ok ${g.url.slice(0, 80)} 正文${text.length}字 取${clipped.length}字`);
  const head = title ? `【网页正文：${title}】` : '【网页正文】';
  return { ok: true, url: g.url, title, text: `${head}\n${clipped}` };
};

module.exports = { TOOL, read, guardUrl, extractText, MAX_HTML_BYTES };
