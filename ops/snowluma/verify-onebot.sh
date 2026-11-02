#!/bin/bash
# ============================================================
# 登录后核验：OneBot 产物 / token / 端口 三方一致（P0-2 自动化）
# ============================================================
# 为什么需要这个脚本：
#   SnowLuma 的 OneBot 配置是"overlay 预置 + 登录后按 uin 生成"两段合并：
#     config/onebot.json        mode=overlay，登录**前**就该存在（我们手写的骨架）
#     config/onebot_<uin>.json  登录**成功后**由 supervisor 生成
#   合并规则里生成物优先，所以生成物一旦覆盖了 networks 段，token/端口就可能
#   与 overlay 不一致 —— 表现是 Koishi 连不上 3001 或 401，而人肉看日志很难定位。
#   本脚本把这套核对变成一次命令，避免"登录成功那一刻"的手忙脚乱。
#
# 用法：
#   ./verify-onebot.sh               # 核验；全绿 exit 0，有 ✗ exit 1
#   ./verify-onebot.sh -q            # 只输出失败项
#   ./verify-onebot.sh -k            # 跳过「Koishi 已连接」检查（-k/--skip-koishi）
#   ./verify-onebot.sh -q -k         # 可组合
#
# 为什么需要 -k：
#   Koishi 由 qqbot-watchdog 拉起，而切换网关（--go）才会 enable watchdog。
#   切换**前**跑核验时 Koishi 必然还没起，若把它当硬条件就成了循环依赖
#   （post-login 因此永远卡在"1 项失败"）。所以切换前用 -k 校验
#   "overlay/生成物/端口"，切换后再用完整核验确认 "Koishi 真的连上了"。
#
# 退出码：
#   0 全部通过 / 2 还没登录（onebot_<uin>.json 未生成，属正常的"还差一次登录"）
# ============================================================
set -uo pipefail

SL_DIR=${SL_DIR:-/opt/snowluma}
CONF_DIR="$SL_DIR/config"
OVERLAY="$CONF_DIR/onebot.json"
PORT=${PORT:-3001}
QUIET=0
SKIP_KOISHI=0
for arg in "$@"; do
  case "$arg" in
    -q|--quiet)        QUIET=1 ;;
    -k|--skip-koishi)  SKIP_KOISHI=1 ;;
    *)                 echo "[verify-onebot] 未知参数：$arg（可用 -q -k）" >&2; exit 1 ;;
  esac
done

# NAPCAT_WS_TOKEN 是 Koishi 侧唯一凭据来源（bot/koishi.config.js 读这个变量）
if [ -r /root/deploy/bot.env ]; then
  set -a; . /root/deploy/bot.env; set +a
fi
TOKEN=${NAPCAT_WS_TOKEN:-}

say() { [ "$QUIET" = 1 ] && return 0; echo "$*"; }
ok()  { say "  ✓ $*"; }
bad() { echo "  ✗ $*" >&2; FAIL=$((FAIL+1)); }

FAIL=0

say "[verify-onebot] 检查 $CONF_DIR（端口 $PORT）"

# ---------- 1. overlay 必须存在（登录前就该在）----------
if [ -f "$OVERLAY" ]; then
  ok "overlay 存在：$OVERLAY"
else
  bad "overlay 缺失：$OVERLAY（先按 docs/04-migration-snowluma.md 的骨架恢复）"
fi

# ---------- 2. 生成物必须存在（这一步没登录就一定没有）----------
UIN_CONF=$(ls "$CONF_DIR"/onebot_*.json 2>/dev/null | head -1 || true)
if [ -z "$UIN_CONF" ]; then
  echo "[verify-onebot] 还没有 $CONF_DIR/onebot_<uin>.json：QQ 尚未登录成功。" >&2
  echo "               登录后 supervisor 会自动生成，再跑一次本脚本。" >&2
  exit 2
fi
ok "生成物存在：$UIN_CONF"

# ---------- 3. 逐个字段核对（用 python3 解析，别用 grep 猜 JSON）----------
# 覆盖目标：host 必须回环（否则等于把 QQ 协议暴露到公网）、port 与 Koishi 一致、
# accessToken 与 bot.env 一致、messageFormat=array（字段名不是 messagePostFormat）。
check_file() {
  local f="$1" label="$2"
  [ -r "$f" ] || { bad "$label 不可读：$f"; return; }
  python3 - "$f" "$PORT" "${TOKEN}" "$label" "$QUIET" <<'PY'
import json, sys
path, port, token, label, quiet = sys.argv[1], int(sys.argv[2]), sys.argv[3], sys.argv[4], sys.argv[5] == "1"
try:
    cfg = json.load(open(path))
except Exception as e:
    print(f"  ✗ {label} 不是合法 JSON：{e}", file=sys.stderr); sys.exit(1)

def find_ws(obj):
    """递归找第一个 wsServers 列表（合并后的结构层次可能变）"""
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == "wsServers" and isinstance(v, list):
                return v
            r = find_ws(v)
            if r: return r
    elif isinstance(obj, list):
        for v in obj:
            r = find_ws(v)
            if r: return r
    return None

ws = find_ws(cfg)
if not ws:
    print(f"  ✗ {label} 里找不到 wsServers", file=sys.stderr); sys.exit(1)
srv = ws[0]
fails = 0

def chk(cond, msg):
    global fails
    if cond:
        if not quiet: print(f"  ✓ {label}: {msg}")
    else:
        print(f"  ✗ {label}: {msg}", file=sys.stderr); fails += 1

host = str(srv.get("host", ""))
chk(host in ("127.0.0.1", "localhost"), f"host={host or '(空)'}（必须是 127.0.0.1）")
chk(int(srv.get("port", 0)) == port, f"port={srv.get('port')}（应为 {port}）")
got = str(srv.get("accessToken", ""))
if token:
    chk(got == token, "accessToken 与 bot.env 的 NAPCAT_WS_TOKEN 一致")
elif not quiet:
    print("  · 跳过 token 比对（bot.env 里没有 NAPCAT_WS_TOKEN）")
chk(srv.get("messageFormat") == "array", f"messageFormat={srv.get('messageFormat')}（应为 array）")
sys.exit(1 if fails else 0)
PY
  # python 的退出码才是失败计数来源（✓/✗ 行只是给人看的）
  local rc=$?
  [ "$rc" -eq 0 ] || FAIL=$((FAIL+1))
}

check_file "$OVERLAY" "overlay"
if [ "$UIN_CONF" != "$OVERLAY" ]; then
  check_file "$UIN_CONF" "生成物"
else
  say "  · 生成物与 overlay 是同一个文件，跳过二次核对"
fi

# ---------- 4. 端口必须只监听回环 ----------
if ss -lnt 2>/dev/null | grep -qE "(0\.0\.0\.0|\*|\[::\]):$PORT "; then
  bad "OneBot 监听了全部地址（应为 127.0.0.1:$PORT）"
elif ss -lnt 2>/dev/null | grep -qE "(127\.0\.0\.1|\[::1\]):$PORT "; then
  ok "OneBot 正在监听 127.0.0.1:$PORT"
else
  bad "127.0.0.1:$PORT 未监听（登录未完成？supervisor 是否在跑？）"
fi

# ---------- 5. Koishi 是否真的连上了 ----------
if [ "$SKIP_KOISHI" = 1 ]; then
  say "  · 跳过 Koishi 连接检查（-k）：切换前 Koishi 尚未由 watchdog 拉起，属预期"
elif tail -100 /opt/logs/koishi.log 2>/dev/null | grep -q "adapter connect to server"; then
  ok "Koishi 日志有 adapter connect to server"
else
  bad "Koishi 日志没有 adapter connect to server（还没起或不认 token）"
fi

echo
if [ "$FAIL" -eq 0 ]; then
  echo "[verify-onebot] 全部通过，可以切/继续回归 8 项。"
  exit 0
fi
echo "[verify-onebot] $FAIL 项失败。常见兜底：" >&2
echo "  1) 生成物覆盖了 overlay 的 networks 段 → 删掉生成物里的 networks 段（让 overlay 生效）" >&2
echo "  2) token 不一致 → 对齐 bot.env 的 NAPCAT_WS_TOKEN" >&2
echo "  3) 改完执行：ops/snowluma/container/run.sh down && ops/snowluma/container/run.sh up" >&2
exit 1
