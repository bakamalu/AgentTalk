#!/bin/bash
# 网关 + Koishi 守护脚本：进程不存在就重新拉起，常驻循环。
# 由 systemd 服务 qqbot-watchdog.service 托管，开机自启 + 崩溃自恢复。
#
# 网关可切换：BOT_GATEWAY=napcat|snowluma（默认 napcat）
#   → 部署本脚本但未切到 snowluma 时，行为与原版完全一致。

export PATH=/usr/local/lib/nodejs/node-v22.11.0-linux-x64/bin:/usr/local/bin:/usr/bin:/bin
# 环境变量链：/etc/profile → /root/deploy/profile → /root/deploy/bot.env
[ -f /etc/profile ] && source /etc/profile >/dev/null 2>&1

LOGDIR=/opt/logs
mkdir -p "$LOGDIR"

CHECK_INTERVAL=${CHECK_INTERVAL:-20}
GATEWAY=${BOT_GATEWAY:-napcat}

log() { echo "[$(date '+%F %T')] $*"; }

start_napcat() {
  # QQ(NapCat) 主进程存在就跳过
  if pgrep -f '/opt/QQ/qq --no-sandbox' >/dev/null 2>&1; then
    return 0
  fi
  log "NapCat(QQ) 未运行，正在拉起..."
  cd /opt || return 1
  nohup bash ./launcher.sh >> "$LOGDIR/napcat.log" 2>&1 &
  sleep 15
  if pgrep -f '/opt/QQ/qq --no-sandbox' >/dev/null 2>&1; then
    log "NapCat(QQ) 已启动"
  else
    log "NapCat(QQ) 启动失败，详见 $LOGDIR/napcat.log"
  fi
}

start_snowluma() {
  if pgrep -f 'snowluma' >/dev/null 2>&1; then
    return 0
  fi
  [ -d /opt/snowluma ] || { log "跳过：/opt/snowluma 不存在"; return 1; }
  log "SnowLuma 未运行，正在拉起..."
  cd /opt/snowluma || return 1
  # 无人值守：否则 headless 下会卡在 EULA / 隐私同意页
  SNOWLUMA_ACCEPT_EULA=1 SNOWLUMA_ACCEPT_PRIVACY=1 \
    nohup ./launcher.sh >> "$LOGDIR/snowluma.log" 2>&1 &
  sleep 30
  if pgrep -f 'snowluma' >/dev/null 2>&1; then
    log "SnowLuma 已启动"
  else
    log "SnowLuma 启动失败，详见 $LOGDIR/snowluma.log"
  fi
}

start_gateway() {
  case "$GATEWAY" in
    snowluma) start_snowluma ;;
    *)        start_napcat ;;
  esac
}

start_koishi() {
  if pgrep -f 'koishi/lib/worker' >/dev/null 2>&1; then
    return 0
  fi
  log "Koishi 未运行，正在拉起..."
  cd /opt/koishi || return 1
  nohup node ./node_modules/.bin/koishi start koishi.config.js >> "$LOGDIR/koishi.log" 2>&1 &
  sleep 10
  if pgrep -f 'koishi/lib/worker' >/dev/null 2>&1; then
    log "Koishi 已启动"
  else
    log "Koishi 启动失败，详见 $LOGDIR/koishi.log"
  fi
}

log "守护进程启动 (网关=${GATEWAY}, 检查间隔 ${CHECK_INTERVAL}s)"
while true; do
  start_gateway
  start_koishi
  sleep "$CHECK_INTERVAL"
done
