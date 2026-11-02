#!/bin/bash
# 网关 + Koishi 守护脚本：进程不存在就重新拉起，常驻循环。
# 由 systemd 服务 qqbot-watchdog.service 托管，开机自启 + 崩溃自恢复。
#
# 网关可切换：BOT_GATEWAY=napcat|snowluma（默认 napcat）
#   → napcat = 本机直接拉 QQ（LD_PRELOAD 式，宿主 glibc 2.31）
#   → snowluma = 拉 docker 容器（QQ + supervisor 同在 ubuntu 24.04，
#     因为 SnowLuma 原生层要 glibc ≥ 2.34）。两者互斥，端口同为 3001。
#
# 容器模式必须用混合判活：容器 running ≠ 内部组件活着（QQ 崩了 entrypoint
# 会自己重启，但如果 entrypoint 自身卡死，只能从外面整个容器重建）。

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

SL_CONTAINER=${SL_CONTAINER:-qqbot-snowluma}
SL_RUN=${SL_RUN:-/root/code/AgentTalk/ops/snowluma/container/run.sh}

container_running() {
  [ "$(docker inspect -f '{{.State.Running}}' "$SL_CONTAINER" 2>/dev/null)" = "true" ]
}

# 容器内进程的宿主 PID 列表。
# ⚠ PID namespace 只挡住"容器看不到宿主"这一个方向：宿主 ps/pgrep 能命中
# 容器内进程。所以容器模式下 `pkill -f '/opt/QQ/qq'` 会把**容器里正在跑的**
# SnowLuma QQ 一起杀掉（实测：刚登录成功的账号被踢回登录页，3001 消失）。
# 凡是"停宿主 NapCat"的动作都必须先扣掉这些 PID。
sl_pids() {
  docker top "$SL_CONTAINER" -o pid 2>/dev/null | tail -n +2 | tr -d ' \r' | tr '\n' ' '
}

host_napcat_pids() {
  local sp; sp=" $(sl_pids) "
  local pid
  for pid in $(pgrep -f '/opt/QQ/qq --no-sandbox' 2>/dev/null) \
             $(pgrep -f 'xvfb-run -a /opt/QQ/qq' 2>/dev/null); do
    case "$sp" in *" $pid "*) continue ;; esac   # 容器内进程，不算宿主 NapCat
    echo "$pid"
  done
}

# 只杀真正的宿主 NapCat，绝不碰容器内 QQ
stop_host_napcat() {
  local pid n=0
  for pid in $(host_napcat_pids); do
    kill "$pid" 2>/dev/null && n=$((n+1))
  done
  [ "$n" -gt 0 ] && log "已停止宿主 NapCat/QQ $n 个进程（已排除容器内 PID）"
  return 0
}

# 三层判活：QQ 在 → supervisor 在 → 5099 真的在听。
# 单独拆出来是为了给下面的“连续失败计数”复用。
#
# ⚠ 第三层**绝不能写死 `127.0.0.1:5099`**：WebUI 的 bind 地址是可配的
#   （`SNOWLUMA_WEBUI_HOST`）。10-31 把它改成 `0.0.0.0` 开放外网后，
#   `ss` 输出变成 `0.0.0.0:5099`，字面量匹配不中 → 判活永远失败 →
#   watchdog 每 ~90s 重建一次容器，QQ 永远登不上（实际发生过）。
#   所以只匹 `:5099` 端口段，不关心理它绑在哪个地址上。
sl_components_ok() {
  docker exec "$SL_CONTAINER" pgrep -f '/opt/QQ/qq --no-sandbox' >/dev/null 2>&1 \
    && docker exec "$SL_CONTAINER" pgrep -f 'index\.mjs' >/dev/null 2>&1 \
    && (ss -ltn 2>/dev/null | grep -qE ':5099([[:space:]]|$)')
}

# ⚠ 重建容器是**有代价的动作**：会把容器内 QQ 一起重启，**登录成功后**
# 一次误判就把账号踢下线（重建会走 `run.sh down`，QQ 凭据随之失效，
# 而重登要撞风控）。所以单次探测失败绝不重建：`docker exec` 偶发超时、
# QQ 正在启动、宿主高负载都会让 pgrep 瞬时拿不到 PID
#（实测 07:59 就这样白重建了一次）。
# 必须连续 SL_LIVE_FAIL_THRESHOLD 次失败才动手；CHECK_INTERVAL=20s，
# 默认 3 次 = 真挂 60s 内仍会被拉起，不损失自愈能力。
SL_LIVE_STATE=${SL_LIVE_STATE:-/opt/logs/snowluma-live-fail}
SL_LIVE_FAIL_THRESHOLD=${SL_LIVE_FAIL_THRESHOLD:-3}

start_snowluma() {
  if container_running; then
    if sl_components_ok; then
      rm -f "$SL_LIVE_STATE" 2>/dev/null || true
      return 0
    fi
    local n
    n=$(( $(cat "$SL_LIVE_STATE" 2>/dev/null || echo 0) + 1 ))
    echo "$n" > "$SL_LIVE_STATE" 2>/dev/null || true
    if [ "$n" -lt "$SL_LIVE_FAIL_THRESHOLD" ]; then
      log "判活失败 ${n}/${SL_LIVE_FAIL_THRESHOLD} 次，暂不重建（防瞬时误判拆掉登录态）"
      return 0
    fi
    log "容器在但内部组件不完整（连续 ${n} 次），重建容器..."
    rm -f "$SL_LIVE_STATE" 2>/dev/null || true
    "$SL_RUN" down >/dev/null 2>&1
  fi

  [ -x "$SL_RUN" ] || { log "跳过：$SL_RUN 不存在"; return 1; }
  log "SnowLuma 容器未运行，正在拉起..."
  "$SL_RUN" up >> "$LOGDIR/snowluma.log" 2>&1
  sleep 25
  if container_running; then
    log "SnowLuma 容器已启动"
  else
    log "SnowLuma 容器启动失败，详见 $LOGDIR/snowluma.log 与 docker logs $SL_CONTAINER"
  fi
}

start_gateway() {
  case "$GATEWAY" in
    snowluma)
      # 互斥：容器模式独占 3001/5099，宿主侧 NapCat 必须让位，
      # 否则两个 QQ 同时在线（同号挤下线）并且 3001 会被先绑者抢占。
      # ⚠ 必须用 host_napcat_pids 排除容器内 PID，否则会把容器里的 QQ 杀掉。
      if [ -n "$(host_napcat_pids)" ]; then
        log "检测到宿主 NapCat(QQ)，先停掉（容器模式独占端口）"
        stop_host_napcat
        sleep 3
      fi
      start_snowluma
      ;;
    *)
      if container_running; then
        log "检测到 snowluma 容器，先停掉（切回 napcat）"
        "$SL_RUN" down >/dev/null 2>&1
      fi
      start_napcat
      ;;
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
