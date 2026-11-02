#!/bin/bash
# ============================================================
# SnowLuma 落位：目录隔离 + 配置生成（幂等，可反复跑）
# ============================================================
# 发行包本身是"代码层"（node / index.mjs / native / client），升级直接覆盖；
# 下面四个目录是"状态层"，升级时**必须保留**：
#
#   /opt/snowluma/config  ← onebot.json / runtime.json / webui.json / snowluma.json
#   /opt/snowluma/data    ← 按 UIN 分目录的账号数据（sqlite 等）
#   /opt/snowluma/logs    ← 文件日志（SNOWLUMA_LOG_DIR）
#   /opt/snowluma/run     ← hook 管道 socket 目录（SNOWLUMA_HOOK_RUNTIME_DIR）
#
# 为什么配置/数据是这几个名字：SnowLuma 内部用**相对 CWD** 的
# "config" / "data" / "logs" 三个固定名字（见 index.mjs 的 CONFIG_DIR、
# dataDir: "data"、DEFAULT_DIR = "logs"），而代码层用 import.meta.url
# 定位 native/ 与 client/。所以只要 **CWD = /opt/snowluma**，代码与状态
# 就天然分层：代码在根，状态在四个子目录里。
#
# 用法：
#   sudo ./ops/snowluma/setup.sh            # 缺什么补什么，不覆盖已有配置
#   sudo ./ops/snowluma/setup.sh --force    # 重写 onebot.json / runtime.json
# ============================================================
set -euo pipefail

ROOT=/opt/snowluma
BOT_ENV=/root/deploy/bot.env
SL_ENV=/root/deploy/snowluma.env
FORCE="${1:-}"

log() { echo "[setup] $*"; }
die() { echo "[setup] 错误：$*" >&2; exit 1; }

[ -d "$ROOT" ] || die "$ROOT 不存在（先解压发行包）"
[ -x "$ROOT/node" ] || die "$ROOT/node 不存在（发行包不完整）"
[ -f "$BOT_ENV" ] || die "$BOT_ENV 不存在"

# 从 bot.env 取值（不打印，避免密钥进终端回滚缓冲）
envget() { sed -nE "s/^export $1=\"?([^\"]*)\"?$/\1/p" "$BOT_ENV" | head -1; }
TOKEN=$(envget NAPCAT_WS_TOKEN)
[ -n "$TOKEN" ] || die "bot.env 里 NAPCAT_WS_TOKEN 为空"
ENDPOINT=$(envget NAPCAT_WS_ENDPOINT)
WS_PORT=$(echo "${ENDPOINT:-ws://127.0.0.1:3001}" | sed -nE 's#^[a-z]+://[^:/]+:([0-9]+).*#\1#p')
[ -n "$WS_PORT" ] || WS_PORT=3001
# 容器 entrypoint 用：快速登录号（不写完整 QQ 密码，登录态在 /root/.config/QQ）
QUICK_LOGIN=$(envget NAPCAT_QUICK_LOGIN)

for d in config data logs run; do
  mkdir -p "$ROOT/$d"
done
chmod 700 "$ROOT/config" "$ROOT/data" "$ROOT/run"
log "目录就绪：$ROOT/{config,data,logs,run}"

# ------------------------------------------------------------
# 1) runtime.json —— WebUI 绑定、免自动注入、日志保留
# ------------------------------------------------------------
RT="$ROOT/config/runtime.json"
if [ ! -f "$RT" ] || [ "$FORCE" = "--force" ]; then
  cat > "$RT" <<'JSON'
{
  "webuiPort": 5099,
  "webuiHost": "127.0.0.1",
  "hookAutoLoad": false,
  "webuiTls": { "enabled": false },
  "trustProxy": "",
  "logRetainDays": 7,
  "logPerUin": true
}
JSON
  chmod 600 "$RT"
  log "写入 runtime.json（WebUI 127.0.0.1:5099，hookAutoLoad=false）"
else
  log "runtime.json 已存在，跳过"
fi

# ------------------------------------------------------------
# 2) onebot.json —— 全局 OneBot v11 WS 服务端（登录前就生效）
# ------------------------------------------------------------
# 字段名与 NapCat 不同，别照抄：
#   NapCat   messagePostFormat / token
#   SnowLuma messageFormat     / accessToken
# HTTP 服务端（默认 3000）故意不建：少一个暴露面，Koishi 只用 WS。
OB="$ROOT/config/onebot.json"
if [ ! -f "$OB" ] || [ "$FORCE" = "--force" ]; then
  TOKEN="$TOKEN" WS_PORT="$WS_PORT" python3 - "$OB" <<'PY'
import json, os, sys
cfg = {
    "mode": "overlay",
    "networks": {
        "httpServers": [],
        "httpClients": [],
        "wsServers": [{
            "name": "koishi",
            "enabled": True,
            "host": "127.0.0.1",
            "port": int(os.environ["WS_PORT"]),
            "path": "/",
            "role": "Universal",
            "accessToken": os.environ["TOKEN"],
            "messageFormat": "array",
            "reportSelfMessage": False,
        }],
        "wsClients": [],
    },
    "statusCommand": {
        "enabled": False,
        "swallow": True,
        "cooldownSeconds": 3,
        "trigger": "#sl",
    },
    "historySync": {"enabled": False},
    "notifications": {"channelIds": []},
}
path = sys.argv[1]
with open(path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)
    f.write("\n")
PY
  chmod 600 "$OB"
  log "写入 onebot.json（WS 127.0.0.1:$WS_PORT，token 与 bot.env 同值，format=array）"
else
  log "onebot.json 已存在，跳过（--force 可重写）"
fi

# ------------------------------------------------------------
# 3) snowluma.env —— 运行时环境（含 WebUI 初始口令，600）
# ------------------------------------------------------------
if [ ! -f "$SL_ENV" ]; then
  # 口令规则：>=10 位 + 大小写 + 特殊符号，首次启动 seed 后不再依赖它
  PW=$(openssl rand -base64 24 | tr -d '/+=' | cut -c1-20)
  PW="${PW}aA!"   # 兜底凑齐大小写与特殊符号
  umask 077
  cat > "$SL_ENV" <<EOF
# SnowLuma 运行时环境（600）—— 由 ops/snowluma/setup.sh 生成
# 首次启动时用 SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD 播种 WebUI 口令，
# 之后口令哈希落在 config/webui.json，本变量不再起作用。
export SNOWLUMA_ACCEPT_EULA="1"
export SNOWLUMA_ACCEPT_PRIVACY="1"
export SNOWLUMA_WEBUI_HOST="127.0.0.1"
export SNOWLUMA_WEBUI_PORT="5099"
export SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD="$PW"
# 日志与 hook socket 都关在自己的目录里，不污染 /tmp 与 /opt/logs
export SNOWLUMA_LOG_DIR="/opt/snowluma/logs"
export SNOWLUMA_LOG_PER_UIN="1"
export SNOWLUMA_HOOK_RUNTIME_DIR="/opt/snowluma/run"
# 无人值守：默认**不自动注入** QQ，注入由 WebUI 手动点或显式开关
export SNOWLUMA_HOOK_AUTOLOAD="0"
export SNOWLUMA_UPDATE_CHECK="0"
# 容器 entrypoint 专用：1=同时拉 QQ（W1），0=只起 supervisor（W0）
# 注：这两项不会被 docker --env-file 用（那个格式不认 export 前缀），
# 而是由 entrypoint 自己 source 本文件。
export SNOWLUMA_START_QQ="0"
export SNOWLUMA_QUICK_LOGIN="${QUICK_LOGIN}"
# 扫码登录辅助：1=容器里额外起 x11vnc（只绑 127.0.0.1，走 SSH 隧道）
# 无头机看不到 QQ 的登录二维码，首次登录临时开；登录成功后改回 0
export SNOWLUMA_VNC="0"
export SNOWLUMA_VNC_PORT="5900"
# 多账号（多开 QQ）：每个额外账号一个**独立 HOME**的宿主绝对路径，
# 逗号或空格分隔，例如 "/root/qq-acct2,/root/qq-acct3"。
# 为什么是 HOME：Linux QQ 的单实例锁在 $HOME/.config/QQ/SingletonLock，
# 复制 QQ 本体没用，换 HOME 才是官方认可的多开手段。
# 留空 = 单账号（默认）。这些路径由 run.sh 逐个 -v 挂进容器。
export SNOWLUMA_EXTRA_QQ_HOMES=""
EOF
  chmod 600 "$SL_ENV"
  log "写入 $SL_ENV（含 WebUI 初始口令，600）"
else
  log "$SL_ENV 已存在，跳过"
fi

log "完成。下一步：/opt/snowluma/start.sh（W0 冷启动，不碰 QQ）"
