'use strict';

// ===== 引用（回复某条消息）兜底 =====
// 从 plugins/deepseek.js 拆出。背景：OneBot adapter 只在 reply 是消息首元素时才拉原文，
// 且 getMessage 失败会静默丢掉 quote 节点，导致「引用+@机器人」时模型看不到被引用的话。
// 这里三层兜底：adapter 自带 → internal.getMsg → 临时开一条 WS 直接问网关。

const { normalizeText } = require('./text');

// 从残留的 [CQ:reply,id=xxx] 或未被 adapter 挪走的 reply 节点里取被引用消息 id
const findRawReplyId = (session) => {
  const m = String(session.original || session.content || '').match(/\[CQ:(reply|source)[^\]]*id=(-?\d+)/i);
  if (m) return m[2];
  for (const el of session.elements || []) {
    if (el?.type === 'reply' || el?.type === 'source') {
      const id = el.attrs?.id;
      if (id != null && String(id) !== '-1') return String(id);
    }
  }
  return '';
};

// get_msg 的返回体（array 或 string 两种格式）统一成 { text, userId, username }
const parseMsgPayload = (data) => {
  if (!data) return null;
  const text = data.raw_message
    || (Array.isArray(data.message)
      ? data.message.map((e) => (e && e.type === 'text' ? ((e.data && e.data.text) || '') : `[CQ:${e && e.type}]`)).join('')
      : String(data.message || ''));
  const sender = data.sender || {};
  const uid = sender.user_id != null ? sender.user_id : data.user_id;
  return {
    text: normalizeText(text),
    userId: String(uid != null ? uid : ''),
    username: String(sender.card || sender.nickname || (uid != null ? 'QQ' + uid : '')).trim(),
  };
};

const create = ({ logger, wsEndpoint = 'ws://127.0.0.1:3001' }) => {
  // adapter 的 quote 结构需要 content/messageId/userId/username，不能只回 text
  const toQuote = (data, parsed, fallbackId) => ({
    messageId: String(data?.message_id != null ? data.message_id : fallbackId),
    content: parsed.text,
    userId: parsed.userId,
    username: parsed.username,
  });

  const fetchQuoteByMsgId = async (session, quoteId) => {
    try {
      const internal = session.bot?.internal;
      let data = null;
      if (internal?.getMsg) {
        data = await internal.getMsg(quoteId);
      } else if (internal?.request) {
        data = await internal.request('get_msg', { message_id: Number(quoteId) || quoteId });
      }
      const parsed = parseMsgPayload(data);
      if (!parsed) return null;
      // 引用内容是敏感信息载体，日志只记前 40 字
      logger.info(`[引用] 兜底拉取 id=${quoteId} 内容=${parsed.text.slice(0, 40)}`);
      return parsed;
    } catch (error) {
      logger.warn(`[引用] get_msg(${quoteId}) 兜底拉取失败: ` + String(error.message || error).slice(0, 120));
      return null;
    }
  };

  // 直接问网关（get_msg 已验证可用），3 秒拿不到就放弃，不拖慢回复
  const wsGetMsg = (id) => new Promise((resolve) => {
    let socket;
    try {
      // ws 是 koishi 的既有依赖，惰性 require 避免插件加载期就多一个模块
      const WS = require('ws');
      socket = new WS(wsEndpoint);
    } catch (error) {
      resolve(null);
      return;
    }
    const timer = setTimeout(() => { try { socket.close(); } catch (_) { /* 忽略 */ } resolve(null); }, 3000);
    socket.on('open', () => {
      try { socket.send(JSON.stringify({ action: 'get_msg', params: { message_id: Number(id) || id }, echo: 'quote' })); } catch (_) { resolve(null); }
    });
    socket.on('message', (buf) => {
      try {
        const j = JSON.parse(String(buf));
        if (j && j.echo === 'quote') { clearTimeout(timer); try { socket.close(); } catch (_) { /* 忽略 */ } resolve(j.data || null); }
      } catch (_) { /* 忽略非 JSON */ }
    });
    socket.on('error', () => { clearTimeout(timer); resolve(null); });
  });

  // 一次性给 bot 类的 getMessage 打补丁（原型链上打一次即可，靠构造器标记防重复）
  const maybePatchGetMessage = (session) => {
    const botObj = session.bot;
    if (!botObj || !botObj.constructor || botObj.constructor.__quotePatched) return;
    botObj.constructor.__quotePatched = true;
    const proto = Object.getPrototypeOf(botObj);
    const orig = proto.getMessage;
    if (typeof orig !== 'function') {
      logger.warn('[引用诊断] bot.getMessage 不存在，typeof=' + typeof orig);
      return;
    }
    proto.getMessage = function patched(channel, messageId) {
      return (async () => {
        let r = null;
        try {
          r = await orig.call(this, channel, messageId);
        } catch (e) {
          logger.warn('[引用诊断] getMessage(' + channel + ',' + messageId + ') 抛错: ' + String(e && e.message || e).slice(0, 120));
        }
        if (r) {
          logger.info(`[引用诊断] getMessage(${channel},${messageId}) => ok content=${String(r.content).slice(0, 40)}`);
          return r;
        }
        // 第一层兜底：直连 internal.getMsg 再拉一次
        let d = null;
        try { d = await this.internal.getMsg(messageId); } catch (_) { /* 忽略 */ }
        let q = parseMsgPayload(d);
        if (q) { logger.info(`[引用] getMessage 兜底(internal)成功 id=${messageId} 内容=${q.text.slice(0, 40)}`); return toQuote(d, q, messageId); }
        // 第二层兜底：临时开一条 WS 直接问网关
        d = await wsGetMsg(messageId);
        q = parseMsgPayload(d);
        if (q) { logger.info(`[引用] getMessage 兜底(ws)成功 id=${messageId} 内容=${q.text.slice(0, 40)}`); return toQuote(d, q, messageId); }
        logger.warn(`[引用] getMessage 兜底均失败 id=${messageId}`);
        return r;
      })();
    };
    logger.info('[引用诊断] 已挂钩 getMessage');
  };

  return { findRawReplyId, fetchQuoteByMsgId, maybePatchGetMessage, parseMsgPayload };
};

module.exports = { create, findRawReplyId, parseMsgPayload };
