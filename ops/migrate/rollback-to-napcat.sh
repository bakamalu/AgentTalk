#!/bin/bash
# ============================================================
# 一键回滚：SnowLuma → NapCat（≤5 分钟）
# ============================================================
# 三档回滚：
#   档 1 网关异常      → 本脚本
#   档 2 Koishi 配置异常 → 见文末
#   档 3 状态异常      → 见文末
# ============================================================
set -uo pipefail   # 不用 -e：清理阶段允许个别命令失败

PORT=3001
SL_DIR=/opt/snowluma
GW_CONF=$(ls "$SL_DIR"/config/onebot_*.json 2>/dev/null | head -1 || true)

log() { echo "[$(date '+%T')] $*"; }

log "1/6 停守护"
systemctl stop qqbot-watchdog

log "2/6 停止全部进程"
pkill -f "b[o]t-watchdog\.sh"      || true
pkill -f "k[o]ishi start"          || true
pkill -f "k[o]ishi/lib/worker"     || true
pkill -f "snowluma"                || true
pkill -f "/opt/QQ/qq --no-sandbox" || true
sleep 3

log "3/6 检查端口"
ss -lnt 2>/dev/null | grep -q ":$PORT " && log "⚠ 端口 $PORT 仍被占用" || log "端口已释放"

log "4/6 网关配置端口还原为 $PORT"
[ -n "$GW_CONF" ] && sed -i -E "s/(\"port\"[[:space:]]*:[[:space:]]*)[0-9]+/\1$PORT/" "$GW_CONF" || true

log "5/6 守护开关 → napcat"
if grep -q '^export BOT_GATEWAY=' /root/deploy/bot.env; then
  sed -i 's/^export BOT_GATEWAY=.*/export BOT_GATEWAY="napcat"/' /root/deploy/bot.env
else
  echo 'export BOT_GATEWAY="napcat"' >> /root/deploy/bot.env
fi

log "6/6 启动守护（20~30s 自动拉起 NapCat + Koishi）"
systemctl start qqbot-watchdog
sleep 35

echo
log "===== 验证（不能只看端口）====="
ss -lntp 2>/dev/null | grep -E ":$PORT|:5140" || echo "⚠ 端口未就绪，继续等待 20s"
tail -50 /opt/logs/koishi.log | grep -E "adapter connect|白名单|管理员" | tail -3

cat <<'EOF'

================ 回滚后人工确认 ================
1. 私聊发一句 → 有回复
2. 群里 @ 一次 → 有回复
若仍不通，检查 /opt/logs/{napcat,koishi}.log 尾部。
================================================
EOF

# ------------------------------------------------------------
# 档 2：Koishi 配置异常
# ------------------------------------------------------------
#   cp /root/deploy/migrate/<TS>/koishi.config.js /opt/koishi/koishi.config.js
#   再按 docs/02-operations.md「改配置重启」流程执行
#
# ------------------------------------------------------------
# 档 3：会话状态异常（历史损坏 / 串号）
# ------------------------------------------------------------
#   systemctl stop qqbot-watchdog
#   pkill -f "k[o]ishi start"; sleep 2
#   cp -a /root/deploy/migrate/<TS>/state-deepseek /opt/koishi/state/deepseek
#   systemctl start qqbot-watchdog
