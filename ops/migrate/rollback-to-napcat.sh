#!/bin/bash
# ============================================================
# 一键回滚：SnowLuma → NapCat（≤5 分钟）
# ============================================================
# 三档回滚：
#   档 1 网关异常      → 本脚本
#   档 2 Koishi 配置异常 → 见文末
#   档 3 状态异常      → 见文末
#
# 用法：
#   ./rollback-to-napcat.sh --dry-run   # 只打印计划 + 当前状态，不碰生产
#   ./rollback-to-napcat.sh             # 真回滚
# ============================================================
set -uo pipefail   # 不用 -e：清理阶段允许个别命令失败

# dry-run 的状态打印要读 NAPCAT_WS_TOKEN / BOT_GATEWAY，直接 source bot.env
if [ -r /root/deploy/bot.env ]; then
  set -a; . /root/deploy/bot.env; set +a
fi

PORT=3001
SL_DIR=/opt/snowluma
# 容器模式（SnowLuma 跑在 qqbot-snowluma 里）：回滚必须先把**容器**停掉。
# 注意：宿主 ps/pkill 其实**能**命中容器内的进程（PID namespace 只挡容器看宿主），
# 但那些进程由 entrypoint 的 while 循环每 10s 判活拉起，逐个 pkill 等于白杀。
# 历史坑：只 pkill snowluma 时容器仍在占 3001，NapCat 起不来，回滚等于又一次停机。
SL_RUN=${SL_RUN:-/root/code/AgentTalk/ops/snowluma/container/run.sh}
SL_CONTAINER=${SL_CONTAINER:-qqbot-snowluma}
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

log() { echo "[$(date '+%T')] $*"; }

if [ "$DRY" = 1 ]; then
  cat <<EOF
[dry-run] 未执行任何变更，回滚计划（SnowLuma → NapCat，容器模式）：
  1/6 systemctl stop qqbot-watchdog
  2/6 $SL_RUN down（容器内进程只能这样停）+ pkill watchdog / koishi / 宿主 snowluma / QQ
  3/6 断言 $PORT 已释放（仍占用则中止 —— 抢端口的 NapCat 起了也连不上）
  4/6 断言 NapCat 的 onebot11_*.json 指向 127.0.0.1:$PORT（容器模式不再 sed）
  5/6 bot.env 的 BOT_GATEWAY → napcat
  6/6 systemctl start qqbot-watchdog（20~30s 自动拉起 NapCat + Koishi）
当前状态：
  - 守护：$(systemctl is-active qqbot-watchdog 2>/dev/null || true)
  - BOT_GATEWAY：$(grep -oP '(?<=^export BOT_GATEWAY=")[^"]*' /root/deploy/bot.env 2>/dev/null || echo '(未设置)')
  - $PORT 监听条数：$(ss -lnt 2>/dev/null | grep -c ":$PORT " || true)
  - 容器 $SL_CONTAINER：$(docker inspect -f '{{.State.Status}}' "$SL_CONTAINER" 2>/dev/null || echo '不存在')
  - 宿主 QQ/NapCat 进程：$(pgrep -f '/opt/QQ/qq --no-sandbox' 2>/dev/null | wc -l)（宿主 ps 能看见容器内的）
  - snowluma 进程（含容器内）：$(pgrep -f 'snowluma' 2>/dev/null | wc -l)
  - NapCat ws host：$(grep -hoE '"host"[^,]*' /opt/napcat/config/onebot11_*.json 2>/dev/null | tr -d ' "' | tr '\n' ' ')
  - launcher 支持快速登录：$(grep -c NAPCAT_QUICK_LOGIN /opt/launcher.sh 2>/dev/null || echo 0)
  - WS token 环境变量：$( [ -n "${NAPCAT_WS_TOKEN:-}" ] && echo '已注入' || echo '未注入（未 source bot.env）')
EOF
  exit 0
fi

log "1/6 停守护"
systemctl stop qqbot-watchdog

log "2/6 停止全部进程（容器 + 宿主残留）"
# ★ 容器模式的关键一行：不 down 容器，3001 永远被占着，NapCat 起不来
"$SL_RUN" down 2>/dev/null || true
pkill -f "b[o]t-watchdog\.sh"      || true
pkill -f "k[o]ishi start"          || true
pkill -f "k[o]ishi/lib/worker"     || true
pkill -f "snowluma"                || true   # 容器化前宿主直跑的残留路径
pkill -f "/opt/QQ/qq --no-sandbox" || true
sleep 3

log "3/6 断言端口 $PORT 已释放"
if ss -lnt 2>/dev/null | grep -q ":$PORT "; then
  echo "[$(date '+%T')] ❌ 端口 $PORT 仍被占用，回滚中止：" >&2
  ss -lntp 2>/dev/null | grep ":$PORT " >&2 || true
  docker ps --filter "name=$SL_CONTAINER" --format '  容器仍在：{{.Names}} {{.Status}}' >&2
  echo "  处理：docker rm -f $SL_CONTAINER，或 ss -lntp 找到占用进程后手动停" >&2
  exit 1
fi
log "端口 $PORT 已释放"

log "4/6 校验 NapCat 网关配置指向 127.0.0.1:$PORT"
# 容器模式下 SnowLuma 的 onebot_*.json 与 NapCat 无关，不再 sed 它（改了也没人读）
NAP_CFG=$(ls /opt/napcat/config/onebot11_*.json 2>/dev/null | head -1 || true)
if [ -z "$NAP_CFG" ]; then
  log "⚠ 未找到 /opt/napcat/config/onebot11_*.json，跳过校验（NapCat 会用自己的默认配置）"
elif ! grep -qE "\"port\"[[:space:]]*:[[:space:]]*$PORT([^0-9]|$)" "$NAP_CFG"; then
  log "⚠ $NAP_CFG 的 port 不是 $PORT，NapCat 可能监听别的端口（Koishi 会连不上）"
else
  log "NapCat 网关配置校验通过：$NAP_CFG"
fi

log "5/6 守护开关 → napcat"
if grep -q '^export BOT_GATEWAY=' /root/deploy/bot.env; then
  sed -i 's/^export BOT_GATEWAY=.*/export BOT_GATEWAY="napcat"/' /root/deploy/bot.env
else
  echo 'export BOT_GATEWAY="napcat"' >> /root/deploy/bot.env
fi

log "6/6 启动守护（20~30s 自动拉起 NapCat + Koishi）"
systemctl start qqbot-watchdog
# 守护是异步的：NapCat 要等 QQ 起窗 + 登录态恢复才监听，最多给 60s
ok=0
for _ in $(seq 1 20); do
  sleep 3
  if ss -lnt 2>/dev/null | grep -q ":$PORT "; then ok=1; break; fi
done
if [ "$ok" = 1 ]; then
  log "NapCat 已监听 $PORT"
else
  log "⚠ 60s 内 $PORT 未监听（看 /opt/logs/napcat.log；容器是否还占着端口？）"
fi
if docker inspect -f '{{.State.Running}}' "$SL_CONTAINER" 2>/dev/null | grep -q true; then
  log "⚠ 容器 $SL_CONTAINER 又被拉起来了（检查 BOT_GATEWAY 是否仍是 snowluma）"
fi

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
