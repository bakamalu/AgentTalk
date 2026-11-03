'use strict';

// ===== 转发（合并转发的聊天记录卡片）内容解析 =====
// 背景：QQ 里“合并转发”的聊天记录，OneBot 收到时是消息里的一个 type=forward 段（带 id，
//   可能还带内联 content 节点数组）。Koishi 的 onebot adapter 只对 reply 做了原文兜底
//   （见 lib/quote.js），forward 段原样留着 → 模型根本看不到被转发的那堆话。
// 这里：优先用 adapter 内置的 internal.getForwardMsg(id) 拉子消息（复用已连的 ws）；
//   再兜底 internal.request('get_forward_msg')；再兜底临时直连网关；最后兜底段里内联的 content。
//   子消息的 content 既可能是 CQ 字符串、也可能是 segment 数组（NapCat/NTQQ 两种都见过），都归一。
//   嵌套转发按深度上限递归；节点数与总字数都有上限，防爆 token / 防刷屏。
// ⚠ 各网关返回体形状不完全一致，首次展开会把节点 keys 记一条 info，线上跑一次即可据此校准。

const { normalizeText } = require('./text');

const MAX_SEGS_PER_NODE = 20; // 单条子消息最多取几个段（防止一条里塞巨多段）

// 把一个子节点的 content（字符串 / segment 数组 / 对象）归一成人可读文本
const segText = (content) => {
  if (content == null || content === '') return '';
  if (typeof content === 'string') return normalizeText(content);
  if (Array.isArray(content)) {
    const parts = [];
    for (const seg of content.slice(0, MAX_SEGS_PER_NODE)) {
      if (!seg) continue;
      const type = seg.type;
      const data = seg.data || seg.attrs || {};
      if (type === 'text') parts.push(String(data.text ?? ''));
      else if (type === 'at') parts.push(`[@${data.qq || data.id || ''}]`);
      else if (type === 'image') parts.push('[图片]');
      else if (type === 'record') parts.push('[语音]');
      else if (type === 'video') parts.push('[视频]');
      else if (type === 'face') parts.push('[表情]');
      else if (type === 'reply' || type === 'source') parts.push('[引用]');
      else if (type === 'forward' || type === 'node') parts.push('[聊天记录]'); // 嵌套另做递归
      else parts.push(`[${type}]`);
    }
    return parts.join('').replace(/\s+/g, ' ').trim();
  }
  // 极少数网关给对象：退化成尽力而为
  return normalizeText(String(content));
};

// 从一个子节点里挖嵌套转发的 id（有则递归展开一层）
const nestedForwardId = (content) => {
  if (typeof content === 'string') {
    const m = content.match(/\[CQ:forward[^\]]*id=(-?\d+)/i) || content.match(/\[forward[^\]]*id=(-?\d+)/i);
    return m ? m[1] : '';
  }
  if (Array.isArray(content)) {
    for (const seg of content) {
      if (seg && seg.type === 'forward') {
        const id = (seg.data && seg.data.id) ?? (seg.attrs && seg.attrs.id);
        if (id != null && String(id) !== '' && String(id) !== '-1') return String(id);
      }
    }
  }
  return '';
};

// 兼容多种字段名取发送者：NapCat 是 {user_id,nickname} 或嵌在 sender 里
const senderOf = (node) => {
  const s = node.sender || node;
  const uid = s.user_id ?? s.qq ?? s.uid ?? node.user_id ?? '';
  const name = s.nickname ?? s.card ?? s.name ?? node.nickname ?? '';
  return { uid: String(uid ?? '').trim(), name: String(name ?? '').trim() };
};

// 兼容多种字段名取子消息数组：getForwardMsg 已抽取 messages，兜底时原始体可能再包一层
const asNodeArray = (data) => {
  if (Array.isArray(data)) return data.length ? data : null;
  if (Array.isArray(data?.messages)) return data.messages.length ? data.messages : null;
  if (Array.isArray(data?.data?.messages)) return data.data.messages.length ? data.data.messages : null;
  return null;
};

const create = ({ logger = console, hot, wsEndpoint = 'ws://127.0.0.1:3001' }) => {
  // 临时直连网关（get_msg 同款套路，3s 拿不到就放弃，不拖慢回复）
  const wsGetForward = (id) => new Promise((resolve) => {
    let socket;
    try {
      const WS = require('ws'); // koishi 既有依赖，惰性 require
      socket = new WS(wsEndpoint);
    } catch (_) { resolve(null); return; }
    const timer = setTimeout(() => { try { socket.close(); } catch (_) { /* 忽略 */ } resolve(null); }, 3000);
    socket.on('open', () => {
      // id 与 message_id 都带上，兼容不同网关对参数名的要求
      try { socket.send(JSON.stringify({ action: 'get_forward_msg', params: { id, message_id: id }, echo: 'fwd' })); } catch (_) { resolve(null); }
    });
    socket.on('message', (buf) => {
      try {
        const j = JSON.parse(String(buf));
        if (j && j.echo === 'fwd') { clearTimeout(timer); try { socket.close(); } catch (_) { /* 忽略 */ } resolve(j.data ?? null); }
      } catch (_) { /* 忽略非 JSON */ }
    });
    socket.on('error', () => { clearTimeout(timer); resolve(null); });
  });

  // 拉子消息：adapter 内置 → internal.request → 直连 WS
  const fetchNodes = async (session, id) => {
    const internal = session.bot?.internal;
    let nodes = null;
    try {
      if (internal?.getForwardMsg) nodes = asNodeArray(await internal.getForwardMsg(id));
      else if (internal?.request) nodes = asNodeArray(await internal.request('get_forward_msg', { message_id: id, id }));
    } catch (error) {
      logger.warn(`[转发] internal 拉取失败 id=${id}: ${String(error?.message || error).slice(0, 120)}`);
    }
    if (nodes) return nodes;
    nodes = asNodeArray(await wsGetForward(id));
    return nodes;
  };

  // 递归收集子消息进 acc.list（受深度/节点数上限约束）
  const collect = async (session, id, depth, acc) => {
    if (!hot.forwardEnabled || depth > hot.forwardMaxDepth) return acc;
    const nodes = await fetchNodes(session, id);
    if (!nodes) {
      logger.warn(`[转发] 未能获取内容 id=${id}（网关可能不支持 get_forward_msg 或已过期）`);
      return acc;
    }
    if (acc.probe === undefined) {
      // 首次记录一条结构探针（不含正文），线上据此校准字段名
      const first = nodes[0] || {};
      acc.probe = `keys=${Object.keys(first).join('/')} content=${Array.isArray(first.content) ? 'array' : typeof first.content} n=${nodes.length}`;
      logger.info(`[转发] 结构探针 id=${id} ${acc.probe}`);
    }
    for (const node of nodes) {
      if (acc.list.length >= hot.forwardMaxNodes) { acc.truncated = true; break; }
      const { uid, name } = senderOf(node);
      const rawContent = node.content ?? node.message ?? node.messages;
      acc.list.push({ uid, name, text: segText(rawContent) });
      const nid = nestedForwardId(rawContent);
      if (nid) await collect(session, nid, depth + 1, acc);
    }
    return acc;
  };

  // 渲染成喂给模型的文本块（带说话人前缀；总字数截断兜底）
  const renderBlock = (acc) => {
    if (!acc.list.length) return '';
    const lines = acc.list.map((n) => `- [${n.name || ('QQ' + n.uid) || '?'}] ${n.text || '(空)'}`);
    let block = lines.join('\n');
    if (block.length > hot.forwardMaxChars) block = block.slice(0, hot.forwardMaxChars) + '…(截断)';
    if (acc.truncated) block += `\n（以上仅取前 ${hot.forwardMaxNodes} 条，其余省略）`;
    return block;
  };

  // 从一条消息里取第一个转发段 id（element 优先，其次原始串）
  const detectForwardId = (session) => {
    for (const el of session.elements || []) {
      if (el?.type === 'forward') {
        const id = el.attrs?.id ?? el.properties?.id;
        if (id != null && String(id) !== '' && String(id) !== '-1') return String(id);
      }
    }
    const src = String(session.original || session.content || '');
    const m = src.match(/\[CQ:forward[^\]]*id=(-?\d+)/i) || src.match(/\[forward[^\]]*id=(-?\d+)/i);
    return m ? m[1] : '';
  };

  // 从一条 get_msg 返回体里挖 forward 段 id（字符串 raw_message 或 segment 数组两种形态都兼容）
  const extractForwardId = (data) => {
    if (!data) return '';
    const raw = data.raw_message || (typeof data.message === 'string' ? data.message : '');
    if (raw) {
      const m = String(raw).match(/\[CQ:forward[^\]]*id=(-?\d+)/i) || String(raw).match(/\[forward[^\]]*id=(-?\d+)/i);
      if (m && m[1] !== '-1') return m[1];
    }
    if (Array.isArray(data.message)) {
      for (const seg of data.message) {
        if (seg && seg.type === 'forward') {
          const id = (seg.data && seg.data.id) ?? seg.id;
          if (id != null && String(id) !== '' && String(id) !== '-1') return String(id);
        }
      }
    }
    return '';
  };

  // 从“被引用的那条消息”里挖转发 id：常见玩法是引用一张转发卡片再 @机器人
  //   （此时当前消息 els=[at,text] 不带 forward 段，卡片在你引用的那条消息里）
  const detectForwardIdOfMessage = async (session, msgId) => {
    if (!msgId) return '';
    const internal = session.bot?.internal;
    let data = null;
    try {
      if (internal?.getMsg) data = await internal.getMsg(msgId);
      else if (internal?.request) data = await internal.request('get_msg', { message_id: Number(msgId) || msgId });
    } catch (error) {
      logger.warn(`[转发] getMsg 取引用消息失败 id=${msgId}: ${String(error?.message || error).slice(0, 120)}`);
      return '';
    }
    const id = extractForwardId(data);
    if (id) logger.info(`[转发] 被引用消息 ${msgId} 是转发卡片 forwardId=${id}`);
    return id;
  };

  // 一步到位：检测 + 展开 + 渲染；无转发或失败返回空串
  const expand = async (session, id) => {
    if (!id) return '';
    const acc = await collect(session, id, 1, { list: [], truncated: false, probe: undefined });
    return renderBlock(acc);
  };

  return { detectForwardId, detectForwardIdOfMessage, expand, renderBlock, collect, segText };
};

module.exports = { create, segText };
