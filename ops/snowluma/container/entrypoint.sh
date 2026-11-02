#!/bin/bash
# ============================================================
# 容器 PID 1：Xvfb → QQ → SnowLuma supervisor（各自独立重启）
# ============================================================
# 三者的关系（与 NapCat 时代最大的不同）：
#   supervisor 不再"预加载"进 QQ，而是先有 QQ 进程，再把它注进去。
#   所以启动顺序必须是 Xvfb 先活、QQ 再起、supervisor 最后——
#   顺序反了 supervisor 只会枚举到空列表（WebUI 里看不到可注入的进程）。
#
# 为什么不复用宿主机的 qq-hooked.sh：
#   那个脚本用 xvfb-run 自带一个 Xvfb。容器里我们只想要**一个** Xvfb
#   （省内存，1.8G 的机器经不起两套 X server），所以这里直接给 DISPLAY。
#
# 环境变量（全部来自 /root/deploy/snowluma.env，由宿主挂进来）：
#   SNOWLUMA_START_QQ=0   只起 WebUI，不动 QQ（W0 冷启动就是这么跑的）
#   SNOWLUMA_QUICK_LOGIN  传给 QQ 的 -q（快速登录号）
# ============================================================
set -uo pipefail

SL_DIR=/opt/snowluma
LOG_DIR="$SL_DIR/logs"

# 必须在做任何事之前载入运行时环境：
#   - SNOWLUMA_HOOK_RUNTIME_DIR 要进 **QQ 进程的 environ**，supervisor 是靠
#     目标进程的 environ 反查 socket 目录的（其次 XDG_RUNTIME_DIR，本容器没有
#     /run/user/0），两边不对齐就会永远等不到 hook。
#   - QQ 继承的是 entrypoint 的环境，所以这里 export 一次，子进程全都对得上。
# 注：不用 docker --env-file，因为那个格式不认 `export ` 前缀。
if [ -f /root/deploy/snowluma.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /root/deploy/snowluma.env
  set +a
fi

mkdir -p "$LOG_DIR" "${SNOWLUMA_HOOK_RUNTIME_DIR:-$SL_DIR/run}"

export DISPLAY="${DISPLAY:-:99}"
export HOME="${HOME:-/root}"
export USER="${USER:-root}"
export LOGNAME="${LOGNAME:-root}"

log() { echo "[entrypoint $(date '+%F %T')] $*"; }

start_xvfb() {
  pgrep -x Xvfb >/dev/null 2>&1 && return 0
  log "启动 Xvfb $DISPLAY"
  Xvfb "$DISPLAY" -screen 0 1280x800x24 -nolisten tcp >>"$LOG_DIR/xvfb.log" 2>&1 &
  sleep 2
}

start_qq() {
  [ "${SNOWLUMA_START_QQ:-1}" = "1" ] || return 0
  pgrep -f "${QQ_BIN:-/opt/QQ/qq} --no-sandbox" >/dev/null 2>&1 && return 0
  log "启动 QQ（DISPLAY=$DISPLAY）"
  local ql="${SNOWLUMA_QUICK_LOGIN:-}"
  if [ -n "$ql" ]; then
    nohup "${QQ_BIN:-/opt/QQ/qq}" --no-sandbox --disable-gpu -q "$ql" >>"$LOG_DIR/qq.log" 2>&1 &
  else
    nohup "${QQ_BIN:-/opt/QQ/qq}" --no-sandbox --disable-gpu >>"$LOG_DIR/qq.log" 2>&1 &
  fi
  sleep 8
}

# ------------------------------------------------------------
# 多账号（多开 QQ）：每个账号一个独立 HOME，同一 DISPLAY
# ------------------------------------------------------------
# 为什么不复制一份 /opt/QQ：QQ 的单实例锁落在 $HOME/.config/QQ/SingletonLock，
# 复制二进制没用，**换 HOME** 才起得来第二个进程。
# 为什么 SnowLuma 侧不用配置：HookManager 会遍历所有 QQ 主进程，注入一个就多
# 一个 OneBotInstance，配置写到 config/onebot_<uin>.json（端口要各用各的）。
# 为什么必须带 SNOWLUMA_HOOK_RUNTIME_DIR：supervisor 是靠**目标进程的 environ**
# 反查 socket 目录的；额外 HOME 不带这个变量就会永远等不到 hook。
qq_home_alive() {
  local h="$1" p
  for p in $(pgrep -f "${QQ_BIN:-/opt/QQ/qq} --no-sandbox" 2>/dev/null); do
    grep -qa "HOME=$h" "/proc/$p/environ" 2>/dev/null && return 0
  done
  return 1
}

start_extra_qq() {
  [ "${SNOWLUMA_START_QQ:-1}" = "1" ] || return 0
  local homes="${SNOWLUMA_EXTRA_QQ_HOMES:-}" h
  [ -n "$homes" ] || return 0
  for h in ${homes//,/ }; do            # 逗号/空格分隔都吃
    if [ ! -d "$h" ]; then
      log "额外账号 HOME 不存在：$h（先在宿主 mkdir 并挂进容器）"
      continue
    fi
    qq_home_alive "$h" && continue
    log "启动额外 QQ（HOME=$h，DISPLAY=$DISPLAY）"
    # 刻意不传 -q：新号必须扫码，快速登录参数只对已登录过的号有意义
    env HOME="$h" USER="${USER:-root}" LOGNAME="${LOGNAME:-root}" \
        SNOWLUMA_HOOK_RUNTIME_DIR="${SNOWLUMA_HOOK_RUNTIME_DIR:-$SL_DIR/run}" \
        nohup "${QQ_BIN:-/opt/QQ/qq}" --no-sandbox --disable-gpu \
        >>"$LOG_DIR/qq-home-$(basename "$h").log" 2>&1 &
    sleep 6
  done
}

start_supervisor() {
  pgrep -f 'snowluma/index.mjs|\./index\.mjs' >/dev/null 2>&1 && return 0
  log "启动 SnowLuma supervisor"
  (
    cd "$SL_DIR" || exit 1
    exec ./launcher.sh
  ) >>"$LOG_DIR/supervisor.out" 2>&1 &
  sleep 5
}

start_vnc() {
  [ "${SNOWLUMA_VNC:-0}" = "1" ] || return 0
  pgrep -x x11vnc >/dev/null 2>&1 && return 0
  log "启动 x11vnc（仅回环 :${SNOWLUMA_VNC_PORT:-5900}）"
  # -localhost：只绑 127.0.0.1，外部必须走 SSH 隧道才能连，不开公网端口
  # -nopw：本地回环 + 隧道场景，再加一层 VNC 密码只会多一个要保管的凭据
  # -noxdamage：Xvfb 下 XDAMAGE 不可靠，关掉可防画面不刷新
  x11vnc -display "$DISPLAY" -localhost -rfbport "${SNOWLUMA_VNC_PORT:-5900}" \
    -nopw -forever -shared -noxdamage >>"$LOG_DIR/x11vnc.log" 2>&1 &
  sleep 1
}

shutdown() {
  log "收到退出信号，停止子进程"
  pkill -f "${QQ_BIN:-/opt/QQ/qq} --no-sandbox" 2>/dev/null
  pkill -f 'index\.mjs' 2>/dev/null
  pkill -x x11vnc 2>/dev/null
  pkill -x Xvfb 2>/dev/null
  sleep 2
  exit 0
}
trap shutdown TERM INT

start_xvfb
start_vnc
start_qq
start_extra_qq
start_supervisor

log "就绪（WebUI 127.0.0.1:${SNOWLUMA_WEBUI_PORT:-5099}，QQ=${SNOWLUMA_START_QQ:-1}，VNC=${SNOWLUMA_VNC:-0}，额外号=${SNOWLUMA_EXTRA_QQ_HOMES:-无}）"
while true; do
  start_xvfb
  start_vnc
  start_qq
  start_extra_qq
  start_supervisor
  sleep 10
done
