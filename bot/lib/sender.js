'use strict';

// ===== 发送层：频率闸 + 文本整形 + OneBot 投递路由 =====
// 从 plugins/deepseek.js 拆出。这里有两个踩过的坑，改动前务必看注释：
//   1) 引用回复是 message 数组里的 `reply` 段，**不是** send_group_msg 的第三个参数
//      （那个位置是 auto_escape）。旧写法把对象塞给 auto_escape，NapCat 宽容忽略、
//      SnowLuma 严格校验 → retcode 1400，群聊回复全挂（10-31 实际踩到）。
//   2) 群聊必须走 send_group_msg，直接 session.send 会被 adapter 判成私聊
//      (user_id=0) 导致 retcode 1200。

const { toPlainText, splitText } = require('./text');

// @ 段的平台编码：把不透明 userId 编成各平台需要的形态。
// onebot 用 {type:'at',data:{qq}}；微信/贴吧等接进来时在此加分支即可，
// 业务层（timers/tools）始终只传不透明 userId，不关心形态。
const encodeAtSegment = (platform, id) => {
  switch (platform) {
    case 'onebot':
    default:
      return { type: 'at', data: { qq: String(id) } };
  }
};

const create = ({ logger, hot, limits = {} }) => {
  const ratePerMinute = Math.min(20, Math.max(1, Number(limits.ratePerMinute ?? 6)));
  const minIntervalMs = Math.max(0, Number(limits.minIntervalMs ?? 1500));
  const splitLimit = Math.max(100, Number(limits.splitLimit ?? 500));
  const splitMaxParts = Math.max(1, Math.min(5, Number(limits.splitMaxParts ?? 3)));

  // 频率闸：每分钟计数 + 最小间隔；超限直接丢弃并记日志（不排队堆积）
  const rateState = new Map();
  const allowSend = (key) => {
    const now = Date.now();
    const st = rateState.get(key) || { times: [], last: 0 };
    st.times = st.times.filter((t) => now - t < 60000);
    if (st.times.length >= ratePerMinute) {
      logger.warn(`[频率闸] ${key} 已达每分钟上限 ${ratePerMinute} 条，本条丢弃`);
      rateState.set(key, st);
      return false;
    }
    if (now - st.last < minIntervalMs) {
      logger.warn(`[频率闸] ${key} 距上条仅 ${now - st.last}ms(<${minIntervalMs}ms)，本条丢弃`);
      rateState.set(key, st);
      return false;
    }
    st.times.push(now);
    st.last = now;
    rateState.set(key, st);
    return true;
  };

  const sendGroupPart = (bot, groupId, text, quoteId) => (quoteId
    ? bot.internal.sendGroupMsg(groupId, [
      { type: 'reply', data: { id: String(quoteId) } },
      { type: 'text', data: { text } },
    ])
    : bot.internal.sendGroupMsg(groupId, text));

  // messageId：开启 quoteReply 时首条回复引用原消息；后续分段不带引用
  const send = async (session, text, messageId) => {
    const bot = session.bot;
    const parts = splitText(toPlainText(text), splitLimit, splitMaxParts);
    if (parts.length > 1) logger.info(`[分段] 回复较长，拆成 ${parts.length} 条发送`);

    for (const [index, part] of parts.entries()) {
      const quote = index === 0 ? (hot.quoteReply ? messageId : undefined) : undefined;
      try {
        if (session.guildId) {
          const groupId = session.channelId || session.guildId;
          if (bot?.internal?.sendGroupMsg) {
            try {
              await sendGroupPart(bot, groupId, part, quote);
            } catch (innerError) {
              // 网关不认 reply 段时不能把整条回复弄丢：降级成不带引用重发一次。
              if (!quote) throw innerError;
              logger.warn(`[引用] 带 reply 段发送失败，降级为不引用重发: ${String(innerError?.message || innerError).slice(0, 140)}`);
              await sendGroupPart(bot, groupId, part, undefined);
              hot.quoteReply = false; // 本次运行内不再尝试，避免每条都白失败一次
              logger.info('[引用] 已自动关闭本次运行的引用回复');
            }
          } else {
            await bot.sendMessage(groupId, part, session.guildId);
          }
        } else if (bot?.internal?.sendPrivateMsg) {
          await bot.internal.sendPrivateMsg(session.userId, part);
        } else {
          await session.send(part);
        }
      } catch (error) {
        const message = String(error?.message || error);
        const unknown = /timeout|timed out|ETIMEDOUT|ECONNRESET|socket hang up/i.test(message);
        logger.error(
          `发送${unknown ? '结果未知(不重发)' : '失败'} guildId=${session.guildId || '-'} ` +
          `channelId=${session.channelId || '-'} userId=${session.userId || '-'}: ${message}`,
        );
        // 投递未知：对方可能已收到，重发会刷屏，直接结束
        if (unknown) return;
        throw error;
      }
    }
  };

  // 给管理员状态卡用：限值本身要能被外部读到，否则状态卡只能显示“几个会话在计数”这种无用信息
  // 必须是函数：rateState.size 会变，创建时拼成字符串就永远是 0
  const rateDesc = () => `频率闸：${ratePerMinute} 条/分，间隔≥${minIntervalMs}ms（当前 ${rateState.size} 个会话在计数）`;

  // ---------- 主动投递（定时提醒等没有 session 的场景） ----------
  // 与 send 的两点区别：
  //   1) 默认不带 reply 段：残留 quoteId 跳会话复用会被 SnowLuma 判 1400（见文件头坑 #1/#2）；
  //   2) 允许带 at 段（到点 @ 人）。严格@模式(BOT_AT_ONLY=1)下群消息不带 @ 机器人自己
  //      也接不住后续上下文，所以群提醒默认 @ 设表人。
  // atUserIds 只在群聊生效（私聊 @ 无意义）；失败只记日志、不抛回调用方。
  const notify = async (target, text, { quoteId, atUserIds = [] } = {}) => {
    const bot = target && target.bot;
    if (!bot) { logger.warn('[投递] 目标缺少 bot 连接（重启后还没收到该会话新消息），本条不投'); return false; }
    const parts = splitText(toPlainText(text), splitLimit, splitMaxParts);
    const group = String(target.guildId || target.channelId || '');
    const ats = (group && Array.isArray(atUserIds) ? atUserIds : []).map(String).filter(Boolean).slice(0, 10);
    const unknown = (e) => /timeout|timed out|ETIMEDOUT|ECONNRESET|socket hang up/i.test(String(e?.message || e));

    for (const [index, part] of parts.entries()) {
      const withAt = index === 0 ? ats : [];   // @ 只放首条，分段不重复 @ 人刷屏
      const refs = (index === 0 && quoteId) ? [String(quoteId)] : [];
      try {
        if (group) {
          const message = [
            ...refs.map((id) => ({ type: 'reply', data: { id } })),
            ...withAt.map((qq) => encodeAtSegment(target.platform, qq)),
            { type: 'text', data: { text: part } },
          ];
          if (!bot.internal || typeof bot.internal.sendGroupMsg !== 'function') {
            await bot.sendMessage(group, part, target.guildId);
          } else {
            try {
              await bot.internal.sendGroupMsg(group, message);
            } catch (innerError) {
              // 网关不认 at/reply 段时不能把提醒弄丢：去掉这些段只发正文再试一次
              if (!withAt.length && !refs.length) throw innerError;
              logger.warn(`[投递] 带 at/reply 段失败，降级为纯文本重发: ${String(innerError?.message || innerError).slice(0, 140)}`);
              await bot.internal.sendGroupMsg(group, [{ type: 'text', data: { text: part } }]);
            }
          }
        } else if (bot.internal && bot.internal.sendPrivateMsg) {
          await bot.internal.sendPrivateMsg(String(target.userId), part);
        } else {
          await bot.sendMessage(String(target.userId), part, '');
        }
      } catch (error) {
        const message = String(error?.message || error);
        logger.warn(`[投递] 主动消息${unknown(error) ? '结果未知(不重发)' : '失败'} group=${group || '-'} user=${target.userId || '-'}: ${message.slice(0, 140)}`);
        return false;
      }
    }
    logger.info(`[投递] 主动消息已发 group=${group || '-'} user=${target.userId || '-'} at=${ats.join(',') || '-'}：${text.replace(/\s+/g, ' ').slice(0, 60)}`);
    return true;
  };

  return { send, notify, allowSend, rateState, rateDesc };
};

module.exports = { create };
