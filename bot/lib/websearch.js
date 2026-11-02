'use strict';

// ===== 联网搜索模块（Bing 免 key，含查询词治理）=====
//
// 本机实测（11-02，见 docs/06 P1-11 补充）：cn.bing.com 的结果质量**高度依赖查询词长度**——
//   「苏州 今日天气 2026年11月2日」「苏州 气温 实时 天气预报 未来三天」「苏州明天天气会下雨吗」
//     → 全部退化成实体兜底页（苏州市百度百科 / 苏州市政府 / 知乎旅游攻略），三条不同 query 返回**完全相同**的 5 条，零可用信息；
//   「苏州天气」「苏州 今日天气」 → 正常返回中国天气网等气象结果。
// 所以这里不是简单地“把 HTML 解析好”，必须做三件事：
//   1) 查询词归一化：剥掉年份/日期/「实时·最新·怎么样」这类让引擎退化的词；
//   2) 结果质量闸：命中全是通用实体页时，用更短的核心词重试一次，而不是把垃圾喂给模型；
//   3) 短 TTL 结果缓存：同一会话连问/模型重复发同义 query 时不再白烧搜索轮次（默认最多 2 轮）。
//
// 为什么不用 DuckDuckGo：html/lite/api.duckduckgo.com 在这台阿里云机器上全部超时（不可达）。

const { cleanFragment } = require('./text');

const TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: '搜索互联网，获取实时或最新信息（新闻、价格、赛事、政策、近期进展、你不确定的事实）。'
      + '涉及时效性内容时必须先调用本工具，不要凭训练数据猜测。'
      + '⚠ 查询词必须短：2~4 个词、只留核心名词（例：「苏州 雾霾 预警」「CBA 总决赛 比分」），'
      + '不要写完整句子、不要加年份/日期/「实时」「最新」，那样搜索引擎会返回无关的通用页面。'
      + '天气、气温、下雨与否请改用 get_weather，别用本工具。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '短搜索词，2~4 个核心词，空格分隔；不含年份、日期、「实时/最新/怎么样」等修饰词' },
      },
      required: ['query'],
    },
  },
};

// 会让 cn.bing 退化成实体页的内容：绝对日期、时间指代、时效性修饰、疑问尾巴。
// 中文没有词边界，所以日期按“整段形状”匹配、噪声词按“子串”剔除（「今日天气」剔成「天气」正是想要的）。
const DATE_RE = /20\d{2}\s*[-/年]\s*\d{1,2}\s*[-/月]\s*\d{1,2}\s*[日号]?|20\d{2}\s*[-/年]\s*\d{1,2}\s*月?|\d{1,2}\s*月\s*\d{1,2}\s*[日号]?|\d{4}-\d{2}-\d{2}/g;
const NOISE_RE = /今天|今日|昨天|前天|明天|后天|本周|上周|本月|这周|现在|此刻|当下|目前|最近|近期|最新|实时|行情|查询|搜索|多少|怎么样|如何|请问|未来\s*\d*\s*(天|日|小时)?|第\s*\d+\s*季/g;
const STOP_TOKEN = /^(的|了|吗|呢|吧|和|与|及|是|对|在|for|the|a|an|in|on|of)$/i;

// 归一化：剥日期/时间指代/时效词 → 去停用词与重复 → 限长（最多 4 个实词）
const normalizeQuery = (raw) => {
  const cleaned = String(raw || '')
    .replace(DATE_RE, ' ')
    .replace(NOISE_RE, ' ')
    .replace(/[？！。，、；:]/g, ' ');
  const tokens = [];
  for (const t of cleaned.split(/[\s,，、;；]+/)) {
    const token = t.trim();
    if (!token || STOP_TOKEN.test(token) || token.length > 24) continue;
    if (!tokens.includes(token)) tokens.push(token);
  }
  return tokens.slice(0, 4).join(' ');
};

// 质量闸失败时的“核心词”：取归一化后的前 2 个词
const coreQuery = (normalized) => String(normalized || '').split(' ').slice(0, 2).join(' ');

// 命中全是这类页面，基本等于没搜到有用内容（不锚结尾：Bing 标题里站点后缀形式太多）
const GENERIC_TITLE = /百度百科|维基百科|人民政府|政务服务|政府网|- 知乎|知乎专栏|旅游攻略|旅游景点|景点合集|官网首页/;

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const bingSearch = async (query, { maxResults, timeoutMs }) => {
  const res = await fetch(`https://cn.bing.com/search?q=${encodeURIComponent(query)}&setlang=zh-hans`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'zh-CN,zh;q=0.9' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`search http ${res.status}`);
  const html = await res.text();
  const items = [];
  // 每条自然结果是一个 <li class="b_algo">；按它切块再取标题+摘要。
  for (const block of html.split(/<li\s+class="b_algo/).slice(1)) {
    const title = cleanFragment((block.match(/<h2[^>]*>[\s\S]*?<a[^>]*>([\s\S]*?)<\/a>/) || [, ''])[1]);
    const snippet = cleanFragment((block.match(/<p[^>]*>([\s\S]*?)<\/p>/) || [, ''])[1]);
    if (title || snippet) items.push({ title: title.slice(0, 80), snippet: snippet.slice(0, 260) });
    if (items.length >= maxResults) break;
  }
  return items;
};

// 结果质量闸：
//   1) 一个意图词都没出现 → 无效；
//   2) 全部命中都是百科/政府/旅游这类通用页 → 无效；
//   3) 多词查询里只命中了主体词（对上「苏州」却没对上「天气预报」）→ 无效。
//     第 3 条最关键：实体兜底页里主体词必然命中，光靠第 1 条根本挡不住。
const isUseful = (items, normalized) => {
  if (!items.length) return false;
  const tokens = [...new Set(String(normalized).split(' ').filter((t) => t.length >= 2))];
  if (!tokens.length) return true;
  const blob = items.map((it) => `${it.title}${it.snippet}`).join(' ');
  const matched = tokens.filter((t) => blob.includes(t));
  if (!matched.length) return false;
  if (items.every((it) => GENERIC_TITLE.test(it.title))) return false;
  if (tokens.length > 1 && matched.length < 2) return false;
  return true;
};

// 短 TTL 结果缓存（低内存机器：条目和存活时间都限死）
const CACHE_TTL_MS = 60000;
const CACHE_MAX = 32;
const cache = new Map();
const cacheGet = (key) => {
  const hit = cache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > CACHE_TTL_MS) { cache.delete(key); return null; }
  return hit.value;
};
const cacheSet = (key, value) => {
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { ts: Date.now(), value });
};

const format = (query, items) => `搜索「${query}」结果：\n`
  + items.map((it, i) => `${i + 1}. ${it.title}\n   ${it.snippet}`).join('\n');

// 返回 { text, queries, hits, cached }，text 直接作为 tool 消息内容回填给模型
const search = async (rawQuery, opts = {}) => {
  const logger = opts.logger || console;
  const maxResults = Math.max(1, Number(opts.maxResults) || 5);
  const timeoutMs = Math.max(2000, Number(opts.timeoutMs) || 8000);
  const normalized = normalizeQuery(rawQuery) || String(rawQuery || '').trim();
  if (!normalized) return { text: '搜索词为空，请换一个更短的关键词重试。', queries: [], hits: 0 };

  const cached = cacheGet(normalized);
  if (cached) {
    logger.info(`[搜索] 命中缓存 q="${normalized}"（${cached.hits} 条）`);
    return { text: cached.text, queries: [normalized], hits: cached.hits, cached: true };
  }

  const tried = [];
  let best = null;
  for (const q of [normalized, coreQuery(normalized)].filter((v, i, arr) => v && arr.indexOf(v) === i)) {
    tried.push(q);
    let items = [];
    try {
      items = await bingSearch(q, { maxResults, timeoutMs });
    } catch (error) {
      const message = String(error?.message || error).slice(0, 120);
      logger.warn(`[搜索] 失败 q="${q}": ${message}`);
      // 首轮就失败时不要再试第二轮，直接把“查不到”如实交给模型
      if (!best) return { text: `搜索失败：${message}。请如实告知用户暂时查不到，不要编造。`, queries: tried, hits: 0, error: message };
      continue;
    }
    const useful = isUseful(items, normalized);
    logger.info(`[搜索] q="${q}" 命中 ${items.length} 条 ${useful ? '有效' : '无效（通用页兜底）'}`);
    if (items.length && (!best || useful)) best = { q, items, useful };
    if (useful) break;
  }

  if (!best) {
    return { text: `搜索「${normalized}」没有返回可用结果（${tried.join(' / ')} 都是无关页面）。`
      + '请如实告知用户查不到，不要编造。', queries: tried, hits: 0 };
  }
  // 质量闸没过时不能把垃圾当正常结果喂：补一句风险提示，让模型宁可说不知道
  const header = best.useful ? ''
    : '注意：以下结果只部分命中关键词，或多为百科/政府/旅游类页面，可能答不上这个问题，不能作为事实依据；' 
      + '若得不出结论请如实告知用户查不到，绝对不要编造。\n';
  const text = header + format(best.q, best.items);
  if (best.useful) cacheSet(normalized, { text, hits: best.items.length });
  return { text, queries: tried, hits: best.items.length, useful: best.useful, usedQuery: best.q };
};

module.exports = { TOOL, search, normalizeQuery, coreQuery, isUseful, bingSearch, __test: { cache, GENERIC_TITLE } };
