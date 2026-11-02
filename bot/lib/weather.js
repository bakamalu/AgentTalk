'use strict';

// ===== 天气能力模块（独立于搜索引擎）=====
//
// 为什么要单独做这个模块、而不是让模型 web_search 查天气：
//   1) cn.bing.com 对「苏州 今日天气 2026年11月2日」「苏州 气温 实时 天气预报 未来三天」这类
//      长查询会退化成实体兜底页（百度百科 / 政府网 / 知乎旅游攻略），标题+摘要里**没有任何气象数值**；
//      即使查询写对（「苏州天气」），摘要也只是宣传语，同样给不出温度。
//   2) 天气是结构化数值问题，正解是直接查气象数据 API，而不是抓搜索结果再猜。
//
// 数据源（都免 key，本机实测可达，见 docs/06 P1-11 补充）：
//   主：api.open-meteo.com（预报） + geocoding-api.open-meteo.com（城市→经纬度）
//   备：wttr.in（观测站口径，Open-Meteo 不可用时兜底）
// 返回给模型的是一段纯文本摘要（工具结果不需要 JSON）。失败时明确说“查不到”，
// 让模型如实转告，绝不给它编造的余地。

// WMO 天气代码 → 中文（Open-Meteo 的 weather_code 就是这套编码）
const WMO_TEXT = {
  0: '晴', 1: '大致晴', 2: '局部多云', 3: '阴',
  45: '雾', 48: '雾凇',
  51: '小毛毛雨', 53: '毛毛雨', 55: '大毛毛雨',
  56: '冻毛毛雨', 57: '强冻毛毛雨',
  61: '小雨', 63: '中雨', 65: '大雨', 66: '冻雨', 67: '强冻雨',
  71: '小雪', 73: '中雪', 75: '大雪', 77: '雪粒',
  80: '小阵雨', 81: '阵雨', 82: '强阵雨',
  85: '小阵雪', 86: '大阵雪',
  95: '雷阵雨', 96: '雷阵雨伴冰雹', 99: '强雷阵雨伴冰雹',
};
const describeCode = (code) => WMO_TEXT[code] || `天气代码${code}`;

const TOOL = {
  type: 'function',
  function: {
    name: 'get_weather',
    description: '查询某个城市的实时天气与未来几天预报（气温、体感、湿度、降水、风力）。'
      + '问天气/气温/要不要带伞/穿什么时**必须调用本工具**，不要用 web_search 搜天气（搜索结果里没有气象数据）。',
    parameters: {
      type: 'object',
      properties: {
        city: { type: 'string', description: '城市名，中文，如「苏州」「上海」；用户没说城市就填留空字符串，由系统按默认城市处理' },
        days: { type: 'integer', description: '需要几天的预报，1~3，默认 1（只看今天）' },
      },
      required: ['city'],
    },
  },
};

// 城市 → 经纬度缓存（地理编码很少变，低内存机器上限制条数）
const GEO_TTL_MS = 6 * 60 * 60 * 1000;
const GEO_MAX = 64;
const geoCache = new Map();

const fetchJson = async (url, timeoutMs) => {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'AgentTalk-bot/1.0 (+weather)', 'Accept': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) throw new Error(`http ${res.status}`);
  return res.json();
};

const geocode = async (city, timeoutMs) => {
  const key = String(city).trim();
  const hit = geoCache.get(key);
  if (hit && Date.now() - hit.ts < GEO_TTL_MS) return hit.value;
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(key)}&count=1&language=zh&format=json`;
  const data = await fetchJson(url, timeoutMs);
  const r = Array.isArray(data?.results) ? data.results[0] : null;
  if (!r) throw new Error(`找不到城市「${key}」`);
  const value = {
    name: r.name || key,
    region: r.admin1 || '',
    country: r.country || '',
    latitude: r.latitude,
    longitude: r.longitude,
    timezone: r.timezone || 'Asia/Shanghai',
  };
  if (geoCache.size >= GEO_MAX) geoCache.delete(geoCache.keys().next().value);
  geoCache.set(key, { ts: Date.now(), value });
  return value;
};

// 'YYYY-MM-DD' → 周X（按字符串拆分量算，避免 new Date(str) 走 UTC 跨时区偏移）
const weekday = (iso) => {
  const [y, m, d] = String(iso).split('-').map(Number);
  if (!y || !m || !d) return '';
  return ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][new Date(y, m - 1, d).getDay()];
};

const fetchOpenMeteo = async (place, days, timeoutMs) => {
  const params = new URLSearchParams({
    latitude: String(place.latitude),
    longitude: String(place.longitude),
    current: 'temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m',
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max',
    timezone: place.timezone || 'Asia/Shanghai',
    forecast_days: String(days),
  });
  const data = await fetchJson(`https://api.open-meteo.com/v1/forecast?${params}`, timeoutMs);
  if (!data?.current || !Array.isArray(data?.daily?.time)) throw new Error('Open-Meteo 返回结构异常');

  const c = data.current;
  const d = data.daily;
  const lines = [];
  lines.push(`【${place.name}${place.region ? '·' + place.region : ''}】天气（数据源 Open-Meteo，更新 ${c.time} ${weekday(String(c.time).slice(0, 10))}）`);
  lines.push(`当前：${describeCode(c.weather_code)} ${c.temperature_2m}℃（体感 ${c.apparent_temperature}℃），`
    + `湿度 ${c.relative_humidity_2m}%，降水 ${c.precipitation}mm，风速 ${c.wind_speed_10m}km/h`);
  for (let i = 0; i < d.time.length; i++) {
    const day = d.time[i];
    const label = i === 0 ? '今天' : i === 1 ? '明天' : i === 2 ? '后天' : day;
    const rain = d.precipitation_probability_max?.[i];
    lines.push(`${label}(${day} ${weekday(day)})：${describeCode(d.weather_code[i])}，`
      + `${d.temperature_2m_min[i]}~${d.temperature_2m_max[i]}℃，降水 ${d.precipitation_sum[i]}mm`
      + (rain == null ? '' : `，降水概率 ${rain}%`));
  }
  return { source: 'open-meteo', text: lines.join('\n') };
};

// 兜底源：wttr.in 是观测站实时报文口径，字段命名与 Open-Meteo 完全不同，这里只做归一化拼接
const WTTR_EN_ZH = { sunny: '晴', 'partly cloudy': '局部多云', cloudy: '阴', overcast: '阴', mist: '雾', 'light rain': '小雨', 'moderate rain': '中雨', 'heavy rain': '大雨', 'light rain shower': '小阵雨', 'moderate or heavy rain shower': '强阵雨', thunderstorm: '雷阵雨' };
// 本地日期的 YYYY-MM-DD（不能用 toISOString，那是 UTC，UTC+8 下跨午夜会错一天）
const localDate = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const fetchWttr = async (city, days, timeoutMs) => {
  const data = await fetchJson(`https://wttr.in/${encodeURIComponent(String(city).trim())}?format=j1`, timeoutMs);
  const c = Array.isArray(data?.current_condition) ? data.current_condition[0] : null;
  if (!c) throw new Error('wttr.in 返回结构异常');
  const raw = String(c.lang_zh?.[0]?.value || c.weatherDesc?.[0]?.value || '');
  const desc = /[\u4e00-\u9fa5]/.test(raw) ? raw : (WTTR_EN_ZH[raw.toLowerCase()] || raw);
  const lines = [];
  const cityLabel = String(city).trim();
  const today = localDate();
  lines.push(`【${cityLabel}】天气（数据源 wttr.in 观测站，观测 ${c.observation_time || ''} UTC）`);
  lines.push(`当前：${desc} ${c.temp_C}℃（体感 ${c.FeelsLikeC}℃），湿度 ${c.humidity}%，降水 ${c.precipMM}mm，风速 ${c.windspeedKmph}mph`);
  for (const day of (data.weather || []).slice(0, days)) {
    const hourly = day.hourly || [];
    const chance = Math.max(0, ...hourly.map((h) => Number(h.chanceofrain) || 0));
    lines.push(`${day.date === today ? '今天' : day.date}（${weekday(day.date)}）：`
      + `${day.mintempC}~${day.maxtempC}℃，降水概率 ${chance}%`);
  }
  return { source: 'wttr', text: lines.join('\n') };
};

// opts: { city, days, defaultCity, timeoutMs, logger }
const lookup = async (opts = {}) => {
  const days = Math.min(3, Math.max(1, Number(opts.days) || 1));
  const timeoutMs = Math.max(2000, Number(opts.timeoutMs) || 6000);
  const city = String(opts.city || '').trim() || String(opts.defaultCity || '').trim();
  if (!city) {
    return { ok: false, text: '没有提供城市名。请如实询问用户在哪个城市，不要凭猜测报天气。' };
  }
  try {
    const place = await geocode(city, timeoutMs);
    try {
      const r = await fetchOpenMeteo(place, days, timeoutMs);
      return { ok: true, ...r };
    } catch (error) {
      // 主源挂了再走兜底源，两个都失败才回“查不到”
      (opts.logger || console).warn?.(`[天气] Open-Meteo 失败，改用 wttr.in: ${String(error?.message || error).slice(0, 100)}`);
      const r = await fetchWttr(city, days, timeoutMs);
      return { ok: true, ...r };
    }
  } catch (error) {
    const message = String(error?.message || error).slice(0, 120);
    return { ok: false, text: `天气查询失败：${message}。请如实告知用户暂时查不到，绝对不要编造气温或天气状况。` };
  }
};

module.exports = { TOOL, lookup, describeCode, weekday, geocode, localDate, __test: { fetchOpenMeteo, fetchWttr, geoCache } };
