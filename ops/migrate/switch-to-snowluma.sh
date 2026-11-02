#!/bin/bash
# ============================================================
# 一键切换：NapCat → SnowLuma（W2 正式窗口用）
# ============================================================
# 每一步都有断言，任一步失败立即中止（不半途而废）。
# 前置：已完成 S0（token 对齐 / 双向 127.0.0.1）与 W1 试切并记录通过。
#
# 用法：
#   ./switch-to-snowluma.sh --dry-run   # 只做前置检查 + 打印计划，不碰生产
#   ./switch-to-snowluma.sh             # 真切换
#
# 【容器模式】SnowLuma/QQ 跑在 qqbot-snowluma 容器里（宿主 glibc 2.31 装不了
# v2.2.1 的原生层）。因此本脚本不再"cd /opt/snowluma && nohup ./launcher.sh"。
# 容器的一切生命周期都走 ops/snowluma/container/run.sh。
#
# 【注意：别用 pkill 停容器内的进程】宿主 ps/pkill **能**命中容器内进程
# （PID namespace 只挡住"容器看不到宿主"这一个方向）。不能 pkill 的真正原因是
# entrypoint 里的 while 循环每 10s 判活重启，杀了立刻复活，而 run.sh up 会因容器名
# 冲突失败。所以停容器的唯一正确姿势是 `run.sh down`。
#
# 端口也不再用 sed 改：OneBot 的 wsServers[0].port 来自 config/onebot.json
# (mode=overlay) 并与登录后生成的 onebot_<uin>.json 合并，脚本只做断言。
# ============================================================
set -euo pipefail

# 断言要用 NAPCAT_WS_TOKEN，别指望交互 shell 已经 export 过：
# bot.env 里全是 export 变量（无副作用），直接 source 最省事
if [ -r /root/deploy/bot.env ]; then
  set -a; . /root/deploy/bot.env; set +a
fi

PORT=3001
KOISHI_DIR=/opt/koishi
SL_DIR=/opt/snowluma
SL_RUN=${SL_RUN:-/root/code/AgentTalk/ops/snowluma/container/run.sh}
SL_CONTAINER=${SL_CONTAINER:-qqbot-snowluma}
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
# overlay：预置的配置骨架，登录**前**就该存在
OVERLAY_CONF="$SL_DIR/config/onebot.json"
# 生成物：登录成功后由 supervisor 按 uin 产出，登录前为空属正常
UIN_CONF=$(ls "$SL_DIR"/config/onebot_*.json 2>/dev/null | head -1 || true)
GW_CONF=${UIN_CONF:-$OVERLAY_CONF}
TS=$(date +%Y%m%d-%H%M%S)

log()  { echo "[$(date '+%T')] $*"; }
# dry-run 下不中止，只累加问题数，把所有前置缺口一次报全
FAILED=0
fail() {
  if [ "$DRY" = 1 ]; then echo "  ✗ $*" >&2; FAILED=$((FAILED+1)); return 0; fi
  echo "[$(date '+%T')] ❌ $*" >&2; echo "请执行 rollback-to-napcat.sh"; exit 1
}

# ---------- 前置检查（dry-run 与真跑共用，未过不动生产）----------
preflight() {
  [ -d "$SL_DIR" ]      || fail "$SL_DIR 不存在"
  # 登录前只要求 overlay 骨架在；生成物在不在是下面单独判断的事
  [ -f "$OVERLAY_CONF" ] || fail "overlay 配置缺失：$OVERLAY_CONF（mode=overlay 的预置文件）"
  [ -x "$SL_RUN" ]      || fail "$SL_RUN 不存在或不可执行（容器启动器）"
  [ -d "$KOISHI_DIR" ]  || fail "$KOISHI_DIR 不存在"
  [ -d "$KOISHI_DIR/state/deepseek" ] || fail "$KOISHI_DIR/state/deepseek 不存在，无状态可备份"
  docker info >/dev/null 2>&1 || fail "docker 不可用（容器模式的前提）"

  # onebot_<uin>.json 由 supervisor 在**登录成功后**生成。
  # 缺它 = QQ 还没登进去 = 3001 永远不会监听，所以：
  #   dry-run  → 只提示（登录前干跑本来就会缺）
  #   真切换   → 中止
  if [ -z "$UIN_CONF" ]; then
    if [ "$DRY" = 1 ]; then
      echo "  · 提示：$SL_DIR/config/onebot_<uin>.json 尚未生成（登录未完成，dry-run 视为正常）" >&2
    else
      fail "未找到 $SL_DIR/config/onebot_<uin>.json：QQ 尚未登录成功，切过去 3001 也不会起"
    fi
  fi

  # token 必须三方一致（overlay / 生成物 / bot.env），否则切过去必然 401
  local tok=${NAPCAT_WS_TOKEN:-} f
  [ -n "$tok" ] || fail "NAPCAT_WS_TOKEN 为空（S0 token 对齐未完成）"
  for f in "$OVERLAY_CONF" ${UIN_CONF:-}; do
    [ -n "$f" ] && [ -r "$f" ] || continue
    grep -qF "$tok" "$f" || fail "$f 的 token 与 NAPCAT_WS_TOKEN 不一致"
  done

  # 守护必须支持 BOT_GATEWAY 且已容器化，否则切完 20s 后 NapCat 被拉回来抢 $PORT
  grep -q 'BOT_GATEWAY' /opt/bot-watchdog.sh \
    || fail "/opt/bot-watchdog.sh 不支持 BOT_GATEWAY，切完会被拉回 NapCat"
  grep -q 'SL_RUN' /opt/bot-watchdog.sh \
    || fail "/opt/bot-watchdog.sh 没有 SL_RUN（未容器化），拉不起 snowluma 容器"
  [ -d /root/deploy/migrate ] || fail "/root/deploy/migrate 不存在，没有回滚点"
  df -Pk /root | awk 'NR==2 {exit ($4 < 51200)}' || fail "磁盘可用 < 50MB"
  [ "$FAILED" -eq 0 ] && log "前置检查通过"
  return 0
}

preflight

if [ "$DRY" = 1 ]; then
  GW_ON=$(grep -oP '(?<=^export BOT_GATEWAY=")[^"]*' /root/deploy/bot.env 2>/dev/null || echo '(未设置)')
  LISTEN=$(ss -lnt 2>/dev/null | grep -c ":$PORT " || true)
  cat <<EOF
[dry-run] 未执行任何变更，计划如下（容器模式，端口 $PORT）：
  0. 备份 state → /root/deploy/migrate/state-backup-$TS
  1. systemctl stop qqbot-watchdog
  2. $SL_RUN down   （容器内 QQ/supervisor 由 entrypoint 托管，pkill 只会被 10s 后复活）
     宿主侧再 pkill watchdog / koishi start / koishi worker / napcat_launcher / 残留 QQ
  3. 断言 $PORT 已释放（仍占用则中止）
  4. 断言 $GW_CONF 的 wsServers[0].port = $PORT（端口来自 overlay，不再 sed 改写）
  5. $SL_RUN up 起容器（entrypoint: Xvfb → QQ → supervisor），轮询等 127.0.0.1:$PORT
  6. bot.env 的 BOT_GATEWAY → snowluma，systemctl start qqbot-watchdog
  7. 守护自动拉起 Koishi，断言日志出现 adapter connect to server
当前状态：
  - 守护：$(systemctl is-active qqbot-watchdog 2>/dev/null || true)
  - $PORT 监听条数：$LISTEN
  - 当前 BOT_GATEWAY：$GW_ON
  - 容器：$(docker inspect -f '{{.State.Status}}' "$SL_CONTAINER" 2>/dev/null || echo '不存在')
  - overlay 配置：$OVERLAY_CONF
  - 网关配置（断言用）：$GW_CONF
  - 备份根：/root/deploy/migrate
EOF
  if [ "$FAILED" -ne 0 ]; then
    echo "[dry-run] 前置未通过：$FAILED 项（上面 ✗ 行）。修完再干 W2。"
    exit 1
  fi
  echo "[dry-run] 前置全部通过，可进入 W2 窗口。"
  exit 0
fi

# ---------- 0. 备份状态 ----------
log "备份会话状态"
cp -a "$KOISHI_DIR/state/deepseek" "/root/deploy/migrate/state-backup-$TS" 2>/dev/null || true

# ---------- 1. 停守护 ----------
log "停止守护（避免 20s 后把 NapCat 拉回来）"
systemctl stop qqbot-watchdog

# ---------- 2. 停全部进程（容器内 + 宿主残留）----------
log "停止旧进程"
# 容器里的 QQ / supervisor 由 entrypoint 的 while 循环托管（每 10s 判活重启），
# 宿主 pkill 即使命中也只是让它们在 10s 后原地复活 —— 唯一正确的停法是
# run.sh down（stop -t 20 先让 entrypoint 优雅收尾再删容器）
"$SL_RUN" down || true
pkill -f "b[o]t-watchdog\.sh"        || true
pkill -f "k[o]ishi start"            || true
pkill -f "k[o]ishi/lib/worker"       || true
pkill -f "napcat_launcher"           || true
# 宿主 NapCat 的 QQ 残留（容器内的 QQ 已随 run.sh down 消失）
pkill -f "/opt/QQ/qq --no-sandbox"   || true
sleep 3

# ---------- 3. 断言端口已释放 ----------
if ss -lnt 2>/dev/null | grep -q ":$PORT "; then
  fail "端口 $PORT 仍被占用：$(ss -lntp | grep ":$PORT ")"
fi
log "端口 $PORT 已释放"

# ---------- 4. 断言网关端口（容器模式下端口来自 overlay，不改文件）----------
# OneBot 的 wsServers[0].port 是 overlay(onebot.json) 与生成物(onebot_<uin>.json)
# 合并出来的；sed 哪个文件都可能被另一份覆盖，所以这里只做断言。
log "校验网关配置端口 = $PORT"
grep -qE "\"port\"[[:space:]]*:[[:space:]]*$PORT([^0-9]|$)" "$OVERLAY_CONF" \
  || fail "$OVERLAY_CONF 的 wsServers[0].port 不是 $PORT（改 overlay 后 run.sh down && up）"
if [ -n "$UIN_CONF" ] && [ "$UIN_CONF" != "$OVERLAY_CONF" ]; then
  grep -qE "\"port\"[[:space:]]*:[[:space:]]*$PORT([^0-9]|$)" "$UIN_CONF" \
    || fail "生成物 $UIN_CONF 的 networks 段覆盖了 overlay 端口：删掉它的 networks 段再切"
fi
log "网关配置端口校验通过"

# ---------- 5. 起容器（Xvfb → QQ → supervisor 都在 entrypoint 里）----------
log "启动 SnowLuma 容器"
"$SL_RUN" up || fail "容器启动失败（看 /opt/logs/snowluma.log 与 docker logs $SL_CONTAINER）"
log "等待 127.0.0.1:$PORT 监听（最多 60s；登录态失效会超时）"
ok=0
for _ in $(seq 1 20); do
  sleep 3
  if ss -lnt 2>/dev/null | grep -qE "(127\.0\.0\.1|\[::1\]):$PORT "; then ok=1; break; fi
done
[ "$ok" = 1 ] || fail "60s 内 OneBot 未监听 127.0.0.1:$PORT（QQ 登录态可能已失效，先扫码）"
# 必须只监听回环，否则等于把 QQ 协议暴露到公网
if ss -lnt 2>/dev/null | grep -qE "(0\.0\.0\.0|\*|\[::\]):$PORT "; then
  fail "SnowLuma 监听了全部地址，应为 127.0.0.1:$PORT"
fi
log "SnowLuma 已监听 127.0.0.1:$PORT"

# ---------- 6. 切开关 + 起守护（Koishi 由守护拉起，这一层不再 nohup）----------
log "切换守护开关 → snowluma"
if grep -q '^export BOT_GATEWAY=' /root/deploy/bot.env; then
  sed -i 's/^export BOT_GATEWAY=.*/export BOT_GATEWAY="snowluma"/' /root/deploy/bot.env
else
  echo 'export BOT_GATEWAY="snowluma"' >> /root/deploy/bot.env
fi
# enable 是开机自愈的唯一入口：run.sh 用 --restart no，宿主重启后只有它能拉起容器
systemctl enable qqbot-watchdog >/dev/null 2>&1 || true
systemctl start qqbot-watchdog
log "等待 Koishi 连上网关"
ok=0
for _ in $(seq 1 15); do
  sleep 4
  if tail -80 /opt/logs/koishi.log 2>/dev/null | grep -q "adapter connect to server"; then ok=1; break; fi
done
[ "$ok" = 1 ] || fail "Koishi 未连上网关（看 /opt/logs/koishi.log 与 docker logs $SL_CONTAINER）"
log "Koishi 已连接网关"

cat <<'EOF'

================ 切换完成，请立刻人工验收 ================
1. 群里 @ 一次                          → 有回复
2. 引用一条消息再 @                     → 回复体现被引用内容
3. 撤回一条被回复的消息                 → 日志可见历史剔除
4. 发一张图片                           → 日志出现 [图片]
5. 未 @ 说两句再 @                      → 回复体现前文
6. 私聊连续 3 轮                        → 轮次递增
7. 发送 #状态                           → 正常返回
8. 改 bot.env 一行 → 5s 内热重载日志
任一项失败：执行 ops/migrate/rollback-to-napcat.sh
==========================================================
EOF
