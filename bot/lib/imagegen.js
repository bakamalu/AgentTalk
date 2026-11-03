'use strict';

// ===== 文生图客户端 =====
// 支持两种协议（由 BOT_IMAGEGEN_PROTOCOL 选，默认 dashscope）：
//   dashscope（适配阿里云百炼 token-plan / 万相 wan2.7-image，实测 200 同步可用）：
//     POST {origin}/api/v1/services/aigc/multimodal-generation/generation
//     body { model, input:{ messages:[{role:'user',content:[{text:描述}]}] }, parameters:{ size? } }
//     图 URL 在 output.choices[0].message.content[].image（元素形如 {type:'image', image:'http…'}）
//   openai（标准 OpenAI 兼容，供以后换别的厂商）：
//     POST {base}/images/generations → data[0].url 或 data[0].b64_json
// 产物统一是一个能直接作 OneBot 图片段 data.file 的值（远程 URL，或 base64://<数据>）；
//   发送由 lib/tools.js 借 execCtx.sendImage（→ lib/sender.js sendImage）完成，本模块不碰 QQ。
//
// ⚠ 只有配齐 BOT_IMAGEGEN_ENABLED + BASE + MODEL + KEY 时才由 lib/tools.js 下发 generate_image；
//   没配齐时 describeCapabilities 必须同步声明“没有生图能力”，否则模型会口头答应画图、甚至谎称
//   “点了发送键/先给你手绘的”（这类幻觉是真实故障，见 11-03 记录）。

const DASHSCOPE_PATH = '/api/v1/services/aigc/multimodal-generation/generation';

const TOOL = {
  type: 'function',
  function: {
    name: 'generate_image',
    description: '按文字描述生成一张图片并直接发送给用户。当用户想要图像内容（“画个XX”“来张图”“生成一张…的照片/插画/头像”“配个表情包图”等）时调用。把要画的画面讲清楚：主体+风格+氛围，越具体越好。一次只画一张。',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: '画面描述（中文或英文皆可），尽量具体。例：“一只戴侦探猎鹿帽的橘猫，卡通风格，暖色调，手持放大镜，纯色背景”。',
        },
        size: {
          type: 'string',
          description: '可选，出图尺寸（如 1024*1024、2048*2048，或 1K/2K）；大多数情况留空即可，服务端会用默认尺寸。',
        },
      },
      required: ['prompt'],
    },
  },
};

// 从 base 推 origin：去掉结尾的 /compatible-mode(/v1)、/v1 等，取 scheme://host。
// base 解析失败时退化为字符串裁剪，保证仍能拼出原生地址。
const originOf = (base) => {
  try { const u = new URL(base); return `${u.protocol}//${u.host}`; } catch (_) {
    return String(base).replace(/\/(compatible-mode|v1|api|images).*$/i, '').replace(/\/+$/, '');
  }
};

// 从 dashscope 原生响应里挖第一张图的 URL。
const pickDashscopeImage = (j) => {
  const choices = j?.output?.choices;
  if (Array.isArray(choices)) {
    for (const ch of choices) {
      const content = ch?.message?.content;
      if (Array.isArray(content)) {
        for (const seg of content) {
          const u = seg?.image || seg?.url || (typeof seg === 'string' && /^https?:\/\//.test(seg) ? seg : '');
          if (u) return String(u);
        }
      } else if (typeof content === 'string' && /^https?:\/\//.test(content)) return content;
    }
  }
  const results = j?.output?.results;
  if (Array.isArray(results) && results[0]) return String(results[0].url || results[0].image || '');
  return '';
};

const create = ({ logger = console } = {}) => {
  // generate({ hot, prompt, size }) -> { ok, file?, via?, reason? }
  const generate = async ({ hot, prompt, size }) => {
    const base = String(hot.imagegenBase || '').trim().replace(/\/+$/, '');
    const key = String(hot.imagegenKey || '').trim();
    const model = String(hot.imagegenModel || '').trim();
    if (!base || !key || !model) return { ok: false, reason: '生图未配置（缺 base / model / key）' };
    const desc = String(prompt || '').trim();
    if (!desc) return { ok: false, reason: '缺少画面描述' };

    const protocol = String(hot.imagegenProtocol || 'dashscope').toLowerCase();
    const timeoutMs = Math.max(5000, Number(hot.imagegenTimeoutMs) || 60000);
    // 尺寸统一用 `宽*高`（阿里系习惯）；模型/配置给的 x 一律转成 *。留空则不下发走服务端默认。
    let sizeVal = (String(size || '').trim() || String(hot.imagegenSize || '').trim()).replace(/x/gi, '*');

    let url; let body;
    if (protocol === 'openai') {
      url = `${base}/images/generations`;
      body = { model, prompt: desc, n: 1 };
      if (sizeVal) body.size = sizeVal;
    } else {
      url = String(hot.imagegenEndpoint || '').trim() || `${originOf(base)}${DASHSCOPE_PATH}`;
      body = { model, input: { messages: [{ role: 'user', content: [{ text: desc }] }] }, parameters: {} };
      if (sizeVal) body.parameters.size = sizeVal;
    }

    let resp;
    try {
      resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const m = String(error?.message || error);
      const timeout = /timeout|timed out|ETIMEDOUT|AbortError/i.test(m);
      logger.warn(`[生图] 请求异常: ${m.slice(0, 160)}`);
      return { ok: false, reason: timeout ? `生图超时（${Math.round(timeoutMs / 1000)}s）` : `生图请求异常：${m.slice(0, 120)}` };
    }

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      const detail = data?.error?.message || data?.message || data?.code || `HTTP ${resp.status}`;
      logger.warn(`[生图] 接口报错 ${String(detail).slice(0, 200)}`);
      return { ok: false, reason: `生图接口报错：${String(detail).slice(0, 160)}` };
    }

    if (protocol === 'openai') {
      const item = Array.isArray(data?.data) ? data.data[0] : null;
      if (!item) return { ok: false, reason: '生图接口没返回图片（data 为空）' };
      if (item.url) return { ok: true, file: String(item.url), via: 'openai-url', count: 1 };
      if (item.b64_json) return { ok: true, file: `base64://${item.b64_json}`, via: 'openai-b64', count: 1 };
      return { ok: false, reason: 'openai 返回体里没有 url 或 b64_json' };
    }

    // dashscope：接口可能 HTTP 200 但体内带 code（内容审核等）
    if (data?.code && !data?.output) {
      logger.warn(`[生图] dashscope 业务码 code=${data.code} msg=${String(data.message || '').slice(0, 160)}`);
      return { ok: false, reason: `生图失败：${String(data.code)} ${String(data.message || '').slice(0, 120)}` };
    }
    const img = pickDashscopeImage(data);
    if (img) return { ok: true, file: img, via: 'dashscope', count: Number(data?.usage?.image_count) || 1 };
    return { ok: false, reason: 'dashscope 返回体里没找到图片 URL（看 [生图] 日志核对 output.choices.content.image）' };
  };

  return { generate };
};

module.exports = { create, TOOL, DASHSCOPE_PATH, originOf, pickDashscopeImage };
