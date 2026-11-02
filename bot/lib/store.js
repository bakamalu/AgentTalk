'use strict';

// ===== 状态持久化（多轮上下文 + token 用量）=====
// 从 plugins/deepseek.js 拆出：这块和消息流没有耦合，只有 400ms 防抖落盘与按日统计。
// 语义保持不变：历史按「会话+用户」维度存，加载时裁到最近 32 条防止文件膨胀。

const fs = require('fs');
const path = require('path');

const create = ({ stateDir, logger, maxTurns = 8, priceIn = 1, priceOut = 2 }) => {
  const historiesFile = path.join(stateDir, 'histories.json');
  const usageFile = path.join(stateDir, 'usage.json');

  const readJson = (file, fallback) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (error) { return fallback; }
  };
  const writeJson = (file, data) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
    } catch (error) {
      logger.warn('[状态] 写入失败: ' + error.message);
    }
  };

  // JSON 往返做深拷贝，避免和磁盘数据共享引用
  const histories = new Map(Object.entries(readJson(historiesFile, {}))
    .map(([k, v]) => [k, JSON.parse(JSON.stringify(Array.isArray(v) ? v.slice(-32) : []))]));

  const getHistory = (key) => {
    if (!histories.has(key)) histories.set(key, []);
    return histories.get(key);
  };
  const pushHistory = (key, role, content, msgId, senderId) => {
    const list = getHistory(key);
    list.push({ role, content, msgId, senderId });
    const limit = Math.max(1, maxTurns) * 2;
    while (list.length > limit) list.shift();
  };

  let saveTimer = null;
  const scheduleSave = () => {
    if (saveTimer) return;
    saveTimer = setTimeout(() => {
      saveTimer = null;
      writeJson(historiesFile, Object.fromEntries(histories));
    }, 400);
  };

  // ---------- token 用量：按日/按会话累计，按官方价折算 ----------
  const usage = readJson(usageFile, { days: {}, chats: {}, total: { input: 0, output: 0, calls: 0 } });
  const recordUsage = (chatKey, u) => {
    if (!u) return;
    const day = new Date().toISOString().slice(0, 10);
    if (!usage.days[day]) usage.days[day] = { input: 0, output: 0, cost: 0 };
    if (!usage.chats[chatKey]) usage.chats[chatKey] = { input: 0, output: 0, cost: 0, calls: 0 };
    const cost = ((u.prompt_tokens || 0) * priceIn + (u.completion_tokens || 0) * priceOut) / 1e6;
    usage.days[day].input += u.prompt_tokens || 0;
    usage.days[day].output += u.completion_tokens || 0;
    usage.days[day].cost += cost;
    usage.chats[chatKey].input += u.prompt_tokens || 0;
    usage.chats[chatKey].output += u.completion_tokens || 0;
    usage.chats[chatKey].cost += cost;
    usage.chats[chatKey].calls += 1;
    usage.total.input += u.prompt_tokens || 0;
    usage.total.output += u.completion_tokens || 0;
    usage.total.calls += 1;
    writeJson(usageFile, usage);
    logger.info(`[用量] ${chatKey} in=${u.prompt_tokens} out=${u.completion_tokens} 今日成本≈${usage.days[day].cost.toFixed(4)}元`);
  };
  const usageSummary = () => {
    const day = new Date().toISOString().slice(0, 10);
    const d = usage.days[day] || { input: 0, output: 0, cost: 0 };
    return `今日 in=${d.input} out=${d.output} ≈${d.cost.toFixed(3)}元；累计 ${usage.total.calls} 次调用 in=${usage.total.input} out=${usage.total.output}`;
  };

  return {
    stateDir, historiesFile, usageFile,
    readJson, writeJson,
    histories, getHistory, pushHistory, scheduleSave,
    recordUsage, usageSummary,
  };
};

module.exports = { create };
