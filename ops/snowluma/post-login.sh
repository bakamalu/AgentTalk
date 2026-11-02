#!/bin/bash
# ============================================================
# 登录后一键流水线（P0-2 核验 → P0-4 切网关），把手工顺序固化成脚本
# ============================================================
# 背景：SnowLuma 这条链路"登录成功那一刻"要连做三件事，手敲容易漏：
#   1) supervisor 按 uin 生成 config/onebot_<uin>.json  → 必须核验 token/端口
#   2) OneBot 端口 127.0.0.1:3001 起监听                → 必须只监听回环
#   3) BOT_GATEWAY 切到 snowluma + 拉起 qqbot-watchdog  → 否则 Koishi 不连
# 本脚本把"等登录 → 核验 → 切换 → 复验"串成一条命令，任一步失败立即停，
# 绝不带着半成品往下走。
#
# 用法：
#   ./post-login.sh              # 只看现状：登录了就核验，没登录就提示（不等待、不切换）
#   ./post-login.sh --watch      # 轮询等登录（默认 300s），登录后核验
#   ./post-login.sh --watch --go # 等登录 → 核验 → 真切换（切到 snowluma 网关）
#   ./post-login.sh --go         # 已登录的话直接核验 + 真切换
#
# 选项：
#   --watch[=秒]  等待登录，超时秒数默认 300（0 = 一直等）
#   --go          核验通过后执行 ops/migrate/switch-to-snowluma.sh 真切换
#   --interval=秒 轮询间隔，默认 5
#
# 退出码：
#   0 成功（核验通过；带 --go 时切换也成功）
#   1 核验/切换失败（附兜底提示）
#   2 还没登录（未加 --watch 时）
# ============================================================
set -uo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO=$(cd "$HERE/../.." && pwd)
SL_DIR=${SL_DIR:-/opt/snowluma}
CONF_DIR="$SL_DIR/config"
PORT=${PORT:-3001}
VERIFY="$HERE/verify-onebot.sh"
SWITCH="$REPO/ops/migrate/switch-to-snowluma.sh"

WATCH=0
WATCH_SECS=300
INTERVAL=5
GO=0

for arg in "$@"; do
  case "$arg" in
    --watch)         WATCH=1 ;;
    --watch=*)       WATCH=1; WATCH_SECS=${arg#*=} ;;
    --interval=*)    INTERVAL=${arg#*=} ;;
    --go)            GO=1 ;;
    -h|--help)       sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *)               echo "未知参数：$arg（--help 看用法）" >&2; exit 1 ;;
  esac
done

log()  { echo "[$(date '+%T')] $*"; }
die()  { echo "[$(date '+%T')] ❌ $*" >&2; exit "${2:-1}"; }

[ -x "$VERIFY" ] || die "缺少核验脚本：$VERIFY"
[ -x "$SWITCH" ] || die "缺少切换脚本：$SWITCH"

# 登录判据：supervisor 生成 onebot_<uin>.json。只认文件名模式，不读内容
# （内容核验交给 verify-onebot.sh，这里只回答"登没登"）。
logged_in() {
  ls "$CONF_DIR"/onebot_*.json >/dev/null 2>&1
}

uin_conf() { ls "$CONF_DIR"/onebot_*.json 2>/dev/null | head -1; }

# ---------- 1. 等登录 ----------
if ! logged_in; then
  if [ "$WATCH" = 0 ]; then
    echo "[post-login] QQ 还没登录（$CONF_DIR/onebot_<uin>.json 未生成）。" >&2
    echo "            先扫码：ops/snowluma/container/run.sh qr 取二维码；" >&2
    echo "            或加 --watch 让本脚本轮询等登录。" >&2
    exit 2
  fi
  log "等待 QQ 登录（间隔 ${INTERVAL}s，超时 ${WATCH_SECS}s；0 表示一直等）"
  start=$(date +%s)
  while :; do
    if logged_in; then break; fi
    now=$(date +%s); elapsed=$(( now - start ))
    if [ "$WATCH_SECS" -ne 0 ] && [ "$elapsed" -ge "$WATCH_SECS" ]; then
      die "等待 ${WATCH_SECS}s 仍未登录（二维码约 2 分钟过期，用 run.sh qr 换新码）" 2
    fi
    # 每轮顺带确认容器还活着，避免"等了个不存在的容器"
    if ! docker ps --filter "name=${SL_CONTAINER:-qqbot-snowluma}" --format '{{.Names}}' \
         | grep -qx "${SL_CONTAINER:-qqbot-snowluma}"; then
      die "容器 ${SL_CONTAINER:-qqbot-snowluma} 不在运行，先 run.sh up" 2
    fi
    sleep "$INTERVAL"
  done
  log "检测到登录产物：$(uin_conf)"
fi

# ---------- 2. 核验（P0-2）----------
# 用 -k 跳过「Koishi 已连接」：Koishi 由 watchdog 拉起，而 watchdog 只在
# --go 阶段 enable，切换前它必然没起。把它当硬条件会造成循环依赖。
# 切换后第 4 步用完整核验再确认 Koishi 真的连上了。
log "核验 OneBot 产物 / token / 端口（-k：跳过尚未启动的 Koishi）"
if ! "$VERIFY" -k; then
  cat >&2 <<'EOF'
[post-login] ❌ 核验未通过，已中止（不切换，避免切过去连不上又得回滚）。
             常见原因与处理见 verify-onebot.sh 结尾的三条兜底。
             修完重跑：./post-login.sh
EOF
  exit 1
fi

# ---------- 3. 切换（P0-4）----------
if [ "$GO" = 0 ]; then
  cat <<EOF

[post-login] ✓ 登录产物核验通过，下一步（未执行，需显式确认）：
  1. 关 VNC（P0-3）：snowluma.env 里 SNOWLUMA_VNC="0" → run.sh down && run.sh up
  2. 切网关（P0-4）：./post-login.sh --go
     或单独执行：./ops/migrate/switch-to-snowluma.sh
  3. 切完做回归 8 项（见 docs/06-snowluma-todo.md 的 P0-5）
EOF
  exit 0
fi

log "--go：执行网关切换（NapCat → SnowLuma）"
if ! "$SWITCH"; then
  die "切换失败。按提示执行 ops/migrate/rollback-to-napcat.sh 回滚"
fi

# ---------- 4. 切完复验 ----------
log "切换后复验"
if ! "$VERIFY"; then
  die "切换后复验失败，执行 ops/migrate/rollback-to-napcat.sh"
fi

cat <<EOF

[post-login] ✓✓ 全链路就绪。现在做人工回归 8 项（docs/06-snowluma-todo.md P0-5）：
  1. 群里 @ 一次                2. 引用一条消息再 @
  3. 撤回被回复的消息           4. 发一张图片
  5. 未 @ 说两句再 @            6. 私聊连续 3 轮
  7. 发送 #状态                 8. 改 bot.env 一行看热重载
收尾：关 VNC（SNOWLUMA_VNC="0"）、删 qq-qr.png/qq-screen.png、WebUI 改密
EOF
