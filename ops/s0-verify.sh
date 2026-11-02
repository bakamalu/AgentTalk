#!/bin/bash
# ============================================================
# S0 自检：只读断言，不改任何东西
# ============================================================
# 用途：迁移前置项（token 对齐 / 只监听回环 / 快速登录 / 守护开关 / 回滚点
#       / systemd 服务环境 / X11 残留）逐条检查。任何一条 ✗ 就返回非 0，
#       可直接当 W2 窗口前的闸门。
#
# 为什么有第 8、9 组：这两类故障都真实发生过，且表象都是"QQ 起不来"，
# 排查成本极高，必须固化成断言，不能靠记性。
#   8. systemd 系统级 service 默认不带 HOME → QQ(Electron) 在 prelogin
#      阶段 SIGILL 崩溃循环（见 docs/03-dev-log.md）。
#   9. xvfb-run 被杀后留下孤儿 Xvfb + 残锁 → 脏显示号同样导致 SIGILL。
#
# 用法：
#   ./ops/s0-verify.sh
# ============================================================
set -uo pipefail

PORT=${NAPCAT_WS_PORT:-3001}
ENV_FILE=/root/deploy/bot.env
NAP_WS_CONF=$(ls /opt/napcat/config/onebot11_*.json 2>/dev/null | head -1 || true)
WEBUI_CONF=/opt/napcat/config/webui.json
UNIT=/etc/systemd/system/qqbot-watchdog.service

OK=0
BAD=0
pass() { echo "  ✓ $*"; OK=$((OK + 1)); }
bad()  { echo "  ✗ $*"; BAD=$((BAD + 1)); }
skip() { echo "  - $*"; }

gwfield() {  # gwfield <json-file> <key>；key 为 @host/@port 时读顶层（WebUI）
  python3 - "$1" "$2" <<'PY' 2>/dev/null
import json, sys
f, k = sys.argv[1], sys.argv[2]
d = json.load(open(f))
if k.startswith('@'):
    print(d.get(k[1:], ''))
else:
    s = (d.get('network', {}).get('websocketServers') or [{}])[0]
    print(s.get(k, ''))
PY
}

envget() { sed -nE "s/^export $1=\"?([^\"]*)\"?$/\1/p" "$ENV_FILE" 2>/dev/null | head -1; }

echo "[S0] 1. 密钥文件"
if [ -f "$ENV_FILE" ]; then
  perm=$(stat -c '%a' "$ENV_FILE")
  [ "$perm" = "600" ] && pass "bot.env 权限 600" || bad "bot.env 权限 $perm（应为 600）"
else
  bad "$ENV_FILE 不存在"
fi

echo "[S0] 2. WS token 两侧对齐"
TOK=$(envget NAPCAT_WS_TOKEN)
if [ -z "$TOK" ]; then
  bad "NAPCAT_WS_TOKEN 为空"
else
  pass "NAPCAT_WS_TOKEN 已设置（长度 ${#TOK}）"
  if [ -n "$NAP_WS_CONF" ]; then
    gw=$(gwfield "$NAP_WS_CONF" token)
    [ "$gw" = "$TOK" ] && pass "网关侧 token 与 bot.env 一致" || bad "网关侧 token 与 bot.env 不一致（切过去必然 401）"
  else
    bad "未找到 /opt/napcat/config/onebot11_*.json"
  fi
fi
if grep -q 'token: process.env.NAPCAT_WS_TOKEN' /opt/koishi/koishi.config.js 2>/dev/null; then
  pass "Koishi adapter token 取自环境变量"
else
  bad "Koishi adapter token 未接环境变量"
fi

echo "[S0] 3. 只监听回环（不暴露公网）"
if [ -n "$NAP_WS_CONF" ]; then
  host=$(gwfield "$NAP_WS_CONF" host)
  [ "$host" = "127.0.0.1" ] && pass "NapCat WS host = 127.0.0.1" || bad "NapCat WS host = ${host:-空}（应为 127.0.0.1）"
  p=$(gwfield "$NAP_WS_CONF" port)
  [ "$p" = "$PORT" ] && pass "NapCat WS port = $PORT" || bad "NapCat WS port = ${p:-空}（应为 $PORT）"
fi
WEBUI_PORT=""
if [ -f "$WEBUI_CONF" ]; then
  whost=$(gwfield "$WEBUI_CONF" @host)
  [ "$whost" = "127.0.0.1" ] && pass "WebUI host = 127.0.0.1" || bad "WebUI host = ${whost:-空}（应为 127.0.0.1）"
  WEBUI_PORT=$(gwfield "$WEBUI_CONF" @port)
fi
if ss -lnt 2>/dev/null | grep -qE "(0\.0\.0\.0|\[::\]):$PORT "; then
  bad "有进程在 0.0.0.0/$PORT 上监听（公网暴露）"
else
  pass "没有 0.0.0.0:$PORT 监听"
fi
if [ -n "$WEBUI_PORT" ] && ss -lnt 2>/dev/null | grep -qE "(0\.0\.0\.0|\[::\]):$WEBUI_PORT "; then
  bad "WebUI 在 0.0.0.0/$WEBUI_PORT 上监听（公网暴露，应立即收回回环）"
else
  pass "WebUI 未暴露在 0.0.0.0:${WEBUI_PORT:-?}"
fi

echo "[S0] 4. 快速登录（掉登录态后能自愈）"
if grep -q 'NAPCAT_QUICK_LOGIN' /opt/launcher.sh 2>/dev/null; then
  pass "launcher 支持 NAPCAT_QUICK_LOGIN"
else
  bad "launcher 未接 NAPCAT_QUICK_LOGIN（会卡二维码）"
fi
QL=$(envget NAPCAT_QUICK_LOGIN)
[ -n "$QL" ] && pass "bot.env 已配快速登录号" || bad "bot.env 未配 NAPCAT_QUICK_LOGIN"

echo "[S0] 5. 守护与网关开关"
if grep -q 'BOT_GATEWAY' /opt/bot-watchdog.sh 2>/dev/null; then
  pass "watchdog 支持 BOT_GATEWAY"
else
  bad "watchdog 不支持 BOT_GATEWAY（切完会被拉回 NapCat）"
fi
GW=$(envget BOT_GATEWAY)
[ -n "$GW" ] && pass "BOT_GATEWAY = $GW" || skip "BOT_GATEWAY 未显式设置（默认 napcat）"

echo "[S0] 6. 回滚点"
if [ -d /root/deploy/migrate/current ]; then
  [ -f /root/deploy/migrate/current/deploy/bot.env ] && pass "回滚点含 bot.env" || bad "回滚点缺 bot.env"
  [ -d /root/deploy/migrate/current/state-deepseek ] && pass "回滚点含 state-deepseek 快照" || bad "回滚点缺 state-deepseek 快照"
else
  bad "/root/deploy/migrate/current 不存在"
fi

echo "[S0] 7. 运行时（生产在跑时才判）"
if ss -lnt 2>/dev/null | grep -q "127.0.0.1:$PORT "; then
  pass "网关监听 127.0.0.1:$PORT"
else
  skip "127.0.0.1:$PORT 未监听（NapCat 未登录 / 未启动）"
fi
KPID=$(pgrep -f 'koishi/lib/worker' | head -1)
if [ -n "$KPID" ]; then
  if tr '\0' '\n' <"/proc/$KPID/environ" 2>/dev/null | grep -q '^NAPCAT_WS_TOKEN='; then
    pass "Koishi 进程已注入 NAPCAT_WS_TOKEN"
  else
    bad "Koishi 进程没有 NAPCAT_WS_TOKEN（环境链断了，会 401）"
  fi
else
  skip "Koishi 未运行"
fi

echo "[S0] 8. systemd 服务环境（缺 HOME 会 SIGILL 崩溃循环）"
if [ -f "$UNIT" ]; then
  for v in HOME USER LOGNAME; do
    if grep -qE "^Environment=$v=" "$UNIT"; then
      pass "unit 已设 Environment=$v"
    else
      bad "unit 缺 Environment=$v（QQ 会在 prelogin 阶段 SIGILL）"
    fi
  done
  grep -qE '^KillMode=mixed' "$UNIT" && pass "unit KillMode=mixed" || bad "unit 非 KillMode=mixed（会留孤儿进程）"
  grep -qE '^WorkingDirectory=' "$UNIT" && pass "unit 设了 WorkingDirectory" || bad "unit 未设 WorkingDirectory"
else
  bad "$UNIT 不存在"
fi

echo "[S0] 9. X11 残留（脏显示号同样会让 QQ SIGILL）"
# 只统计「属主是当前用户」的锁：gdm 的 X1024/X1025 是活着的 greeter
# （gnome-shell + Xwayland 持着），既不是 root 的也不该动，必须先排掉。
dirty=""
while IFS= read -r l; do
  [ -n "$l" ] || continue
  n=${l#/tmp/.X}; n=${n%-lock}
  case "$n" in (*[!0-9]*|'') continue;; esac
  [ "$n" -ge 90 ] 2>/dev/null || continue
  # 有 X 客户端连着 → 显示号在用，不算脏
  ss -x 2>/dev/null | grep -q "X11-unix/X$n\b" && continue
  dirty="$dirty :$n"
done <<< "$(find /tmp -maxdepth 1 -name '.X*-lock' -user "$(id -u)" 2>/dev/null)"
if [ -z "$dirty" ]; then
  pass "无 root 持有者遗留的高位 X 锁"
else
  bad "高位残锁：$dirty（launcher 启动时会自清，先确认持有者）"
fi
orph=$(ps -eo pid=,ppid=,comm= | awk '$3=="Xvfb" && $2==1 {print $1}')
[ -z "$orph" ] && pass "无孤儿 Xvfb" || bad "存在孤儿 Xvfb pid=$(echo $orph | tr '\n' ' ')（占着显示号，launcher 会收尸）"

# ============================================================
# 10. SnowLuma（容器模式）
# ============================================================
# 与 1–9 的 NapCat 组并存：迁移期两套都要可判，回滚只需 docker rm。
# 这里联的重点全是“静默失效”类：token 错位/字段名错/端口错都不会报错，
# 只会表现为 Koishi 那边一直连不上。
SL_ENV=/root/deploy/snowluma.env
SL_OB=/opt/snowluma/config/onebot.json
SL_CONTAINER=${SL_CONTAINER:-qqbot-snowluma}

slfield() {  # slfield <onebot.json> <key>
  python3 - "$1" "$2" <<'PY' 2>/dev/null
import json, sys
d = json.load(open(sys.argv[1]))
print(((d.get('networks', {}).get('wsServers') or [{}])[0]).get(sys.argv[2], ''))
PY
}

if [ -f "$SL_OB" ]; then
  echo "[S0] 10. SnowLuma（容器模式）"
  perm=$(stat -c '%a' "$SL_OB")
  [ "$perm" = "600" ] && pass "onebot.json 权限 600" || bad "onebot.json 权限 $perm（应为 600）"
  [ -n "${TOK:-}" ] || TOK=$(envget NAPCAT_WS_TOKEN)
  gwtok=$(slfield "$SL_OB" accessToken)
  [ "$gwtok" = "$TOK" ] && pass "SnowLuma accessToken 与 bot.env 一致" || bad "SnowLuma accessToken 与 bot.env 不一致（Koishi 会 401）"
  h=$(slfield "$SL_OB" host)
  p=$(slfield "$SL_OB" port)
  [ "$h" = "127.0.0.1" ] && pass "SnowLuma WS host = 127.0.0.1" || bad "SnowLuma WS host = ${h:-空}（应为 127.0.0.1）"
  [ "$p" = "$PORT" ] && pass "SnowLuma WS port = $PORT" || bad "SnowLuma WS port = ${p:-空}（应为 $PORT，与 Koishi 对齐）"
  f=$(slfield "$SL_OB" messageFormat)
  [ "$f" = "array" ] && pass "messageFormat = array（字段名不是 messagePostFormat）" || bad "messageFormat = ${f:-空}（应为 array）"

  if [ -f "$SL_ENV" ]; then
    perm=$(stat -c '%a' "$SL_ENV")
    [ "$perm" = "600" ] && pass "snowluma.env 权限 600" || bad "snowluma.env 权限 $perm（应为 600）"
    if grep -qE '^export SNOWLUMA_HOOK_RUNTIME_DIR="/opt/snowluma/run"' "$SL_ENV"; then
      pass "hook runtime dir 已显式固定"
    else
      bad "SNOWLUMA_HOOK_RUNTIME_DIR 未固定（XDG_RUNTIME_DIR 存在时两侧会错位）"
    fi
    grep -qE '^export SNOWLUMA_HOOK_AUTOLOAD="1"' "$SL_ENV" \
      && pass "hook 自动注入已开（重启后自愈）" \
      || skip "hook 自动注入为关（每次重启都要手动 load）"
  else
    bad "$SL_ENV 不存在"
  fi

  docker image inspect qqbot/snowluma:2.2.1 >/dev/null 2>&1 \
    && pass "镜像 qqbot/snowluma:2.2.1 存在" \
    || bad "镜像 qqbot/snowluma:2.2.1 不存在（先 docker build）"

  if [ "$(docker inspect -f '{{.State.Running}}' "$SL_CONTAINER" 2>/dev/null)" = "true" ]; then
    glibc=$(docker exec "$SL_CONTAINER" ldd --version 2>/dev/null | head -1 | awk '{print $NF}')
    case "$glibc" in
      2.3[4-9]|2.[4-9][0-9]|2.[1-9][0-9][0-9]) pass "容器 glibc $glibc（原生层可加载）" ;;
      *) bad "容器 glibc ${glibc:-未知}（< 2.34 时注入必然失败）" ;;
    esac
    docker exec "$SL_CONTAINER" pgrep -f '/opt/QQ/qq --no-sandbox' >/dev/null 2>&1 \
      && pass "容器内 QQ 在跑" || skip "容器内 QQ 未跑（SNOWLUMA_START_QQ=0？）"
    docker exec "$SL_CONTAINER" pgrep -f 'index\.mjs' >/dev/null 2>&1 \
      && pass "容器内 supervisor 在跑" || bad "容器内 supervisor 未跑"
    # 只匹端口，不写死 bind 地址：WebUI 可被 SNOWLUMA_WEBUI_HOST 改到 0.0.0.0，
    # 写死 127.0.0.1 会让闸门在开放外网后误报“未监听”（10-31 实际踩过）。
    ss -lnt 2>/dev/null | grep -qE ':5099([[:space:]]|$)' \
      && pass "WebUI 监听 5099（$(ss -lnt 2>/dev/null | awk '$4 ~ /:5099$/ {print $4; exit}')）" \
      || bad "WebUI 5099 未监听"
    docker exec "$SL_CONTAINER" sh -c 'tr "\0" "\n" </proc/$(pgrep -f "/opt/QQ/qq --no-sandbox" | head -1)/environ | grep -q "^SNOWLUMA_HOOK_RUNTIME_DIR="' >/dev/null 2>&1 \
      && pass "QQ 进程 environ 带 SNOWLUMA_HOOK_RUNTIME_DIR" \
      || bad "QQ 进程 environ 缺 hook runtime dir（注入会找不到 socket）"
  else
    skip "容器 $SL_CONTAINER 未运行"
  fi

  if ss -lnt 2>/dev/null | grep -qE '(0\.0\.0\.0|\[::\]):5900 '; then
    bad "x11vnc 暴露在 0.0.0.0:5900（应立即收回回环）"
  else
    pass "5900 未暴露公网"
  fi
fi

echo
echo "[S0] 结果：通过 $OK 项，失败 $BAD 项"
[ "$BAD" -eq 0 ] || exit 1