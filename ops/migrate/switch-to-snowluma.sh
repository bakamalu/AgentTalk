#!/bin/bash
# ============================================================
# 一键切换：NapCat → SnowLuma（W2 正式窗口用）
# ============================================================
# 每一步都有断言，任一步失败立即中止（不半途而废）。
# 前置：已完成 W1 试切并记录通过；state 已备份。
# ============================================================
set -euo pipefail

PORT=3001
KOISHI_DIR=/opt/koishi
SL_DIR=/opt/snowluma
GW_CONF=$(ls "$SL_DIR"/config/onebot_*.json 2>/dev/null | head -1 || true)
TS=$(date +%Y%m%d-%H%M%S)

log()  { echo "[$(date '+%T')] $*"; }
fail() { echo "[$(date '+%T')] ❌ $*" >&2; echo "请执行 rollback-to-napcat.sh"; exit 1; }

[ -d "$SL_DIR" ]  || fail "$SL_DIR 不存在"
[ -n "$GW_CONF" ] || fail "未找到 $SL_DIR/config/onebot_*.json"
[ -d "$KOISHI_DIR" ] || fail "$KOISHI_DIR 不存在"

# ---------- 0. 备份状态 ----------
log "备份会话状态"
cp -a "$KOISHI_DIR/state/deepseek" "/root/deploy/migrate/state-backup-$TS" 2>/dev/null || true

# ---------- 1. 停守护 ----------
log "停止守护（避免 20s 后把 NapCat 拉回来）"
systemctl stop qqbot-watchdog

# ---------- 2. 停全部进程 ----------
log "停止旧进程"
pkill -f "b[o]t-watchdog\.sh"        || true
pkill -f "k[o]ishi start"            || true
pkill -f "k[o]ishi/lib/worker"       || true
pkill -f "/opt/QQ/qq --no-sandbox"   || true
pkill -f "napcat_launcher"           || true
sleep 3

# ---------- 3. 断言端口已释放 ----------
if ss -lnt 2>/dev/null | grep -q ":$PORT "; then
  fail "端口 $PORT 仍被占用：$(ss -lntp | grep ":$PORT ")"
fi
log "端口 $PORT 已释放"

# ---------- 4. 端口切到 3001（与 NapCat 保持一致，Koishi 无需改动）----------
log "网关配置端口 → $PORT"
sed -i -E "s/(\"port\"[[:space:]]*:[[:space:]]*)[0-9]+/\1$PORT/" "$GW_CONF"
grep -q "\"port\"[[:space:]]*:[[:space:]]*$PORT" "$GW_CONF" || fail "端口改写失败"

# ---------- 5. 起 SnowLuma ----------
log "启动 SnowLuma"
cd "$SL_DIR"
SNOWLUMA_ACCEPT_EULA=1 SNOWLUMA_ACCEPT_PRIVACY=1 \
  nohup ./launcher.sh >> /opt/logs/snowluma.log 2>&1 &
sleep 30
ss -lntp 2>/dev/null | grep -q "127.0.0.1:$PORT" || fail "SnowLuma 未监听 127.0.0.1:$PORT"
log "SnowLuma 已监听 127.0.0.1:$PORT"

# ---------- 6. 起 Koishi（配置未改）----------
log "启动 Koishi"
cd "$KOISHI_DIR"
nohup node ./node_modules/.bin/koishi start koishi.config.js >> /opt/logs/koishi.log 2>&1 &
sleep 12
grep -q "adapter connect to server" /opt/logs/koishi.log || fail "Koishi 未连上网关"
log "Koishi 已连接网关"

# ---------- 7. 切守护开关 ----------
log "切换守护开关 → snowluma"
sed -i 's/^export BOT_GATEWAY=.*/export BOT_GATEWAY="snowluma"/' /root/deploy/bot.env \
  || echo 'export BOT_GATEWAY="snowluma"' >> /root/deploy/bot.env

systemctl start qqbot-watchdog

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
