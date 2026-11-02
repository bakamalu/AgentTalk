#!/bin/bash
# ============================================================
# 从生产机导出 → 脱敏 → 同步回仓库
# ============================================================
# 用途：在服务器上改了 deepseek.js / 配置 / 文档后，一条命令回灌仓库，
#      并强制过一遍脱敏与密钥检查，避免把 Token 推到 GitHub。
#
# 用法：
#   ./scripts/export-from-server.sh            # 导出并检查
#   ./scripts/export-from-server.sh --commit   # 导出 + 检查 + 本地提交
# ============================================================
set -euo pipefail

REPO_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$REPO_DIR"

log()  { echo "[export] $*"; }
fail() { echo "[export] ❌ $*" >&2; exit 1; }

# ---------- 1. 代码 ----------
log "同步业务代码"
[ -f /opt/koishi/plugins/deepseek.js ] && cp /opt/koishi/plugins/deepseek.js bot/plugins/deepseek.js
[ -f /opt/koishi/koishi.config.js ]    && cp /opt/koishi/koishi.config.js    bot/koishi.config.js
[ -f /opt/koishi/package.json ]        && cp /opt/koishi/package.json        bot/package.json
[ -f /opt/bot-watchdog.sh ]            && cp /opt/bot-watchdog.sh            ops/bot-watchdog.sh

# ---------- 2. 文档 ----------
log "同步文档"
[ -f /root/deploy/ds-roobot.md ]             && cp /root/deploy/ds-roobot.md             docs/02-operations.md
[ -f /root/deploy/ds-roobot-dev.md ]         && cp /root/deploy/ds-roobot-dev.md         docs/03-dev-log.md
[ -f /root/deploy/snowluma-route-b-plan.md ] && cp /root/deploy/snowluma-route-b-plan.md docs/04-migration-snowluma.md

# ---------- 3. 网关配置样例（脱敏）----------
log "生成脱敏网关配置样例"
for f in /opt/napcat/config/onebot11_*.json; do
  [ -f "$f" ] || continue
  python3 - "$f" <<'PY'
import json, sys
src = sys.argv[1]
d = json.load(open(src))
for s in d.get('network', {}).get('websocketServers', []):
    s['token'] = '<WS_TOKEN>'
    s['host'] = '127.0.0.1'
json.dump(d, open('/root/code/AgentTalk/config/napcat/onebot11.example.json', 'w'),
          ensure_ascii=False, indent=2)
print('  → config/napcat/onebot11.example.json')
PY
done

# ---------- 4. 脱敏（防止手写文档带真实值）----------
log "执行脱敏替换"
SELF_ID=""
ADMINS=""
QUICK_LOGIN=""
WS_TOKEN=""
WEBUI_TOKEN=""
if [ -r /root/deploy/bot.env ]; then
  SELF_ID=$(grep -oP '(?<=^export NAPCAT_SELF_ID=")[^"]*' /root/deploy/bot.env || true)
  ADMINS=$(grep -oP '(?<=^export BOT_ADMIN_USERS=")[^"]*' /root/deploy/bot.env || true)
  QUICK_LOGIN=$(grep -oP '(?<=^export NAPCAT_QUICK_LOGIN=")[^"]*' /root/deploy/bot.env || true)
  WS_TOKEN=$(grep -oP '(?<=^export NAPCAT_WS_TOKEN=")[^"]*' /root/deploy/bot.env || true)
fi
[ -r /opt/napcat/config/webui.json ] && \
  WEBUI_TOKEN=$(python3 -c "import json;print(json.load(open('/opt/napcat/config/webui.json')).get('token',''))" 2>/dev/null || true)

# 逐个明文值 → 占位符（值均为字母数字，用 | 作分隔符即可）
sanitize() {
  local v=$1 ph=$2
  [ -n "$v" ] || return 0
  find . -path ./.git -prune -o -type f \
       \( -name '*.md' -o -name '*.js' -o -name '*.json' -o -name '*.example' -o -name '*.sh' \) -print0 \
  | xargs -0 sed -i "s|$v|$ph|g"
}

sanitize "$WEBUI_TOKEN" '<WEBUI_TOKEN>'
sanitize "$WS_TOKEN"    '<WS_TOKEN>'

# 文档里的 IPv4 一律占位化（本机 EIP 不在网卡上，自动探测不可靠，
# 所以用“保护回环 → 全替 → 还原”的确定做法）
log "文档 IPv4 → <SERVER_IP>"
find . -path ./.git -prune -o -type f -name '*.md' -print0 \
| xargs -0 sed -i -E \
    -e 's/127\.0\.0\.1/@@LOOPBACK@@/g' \
    -e 's/0\.0\.0\.0/@@ANYADDR@@/g' \
    -e 's/::1/@@LOOP6@@/g' \
    -e 's/([0-9]{1,3}\.){3}[0-9]{1,3}/<SERVER_IP>/g' \
    -e 's/@@LOOPBACK@@/127.0.0.1/g' \
    -e 's/@@ANYADDR@@/0.0.0.0/g' \
    -e 's/@@LOOP6@@/::1/g'
if [ -n "$SELF_ID" ]; then sanitize "$SELF_ID" '<BOT_UIN>'; fi
# 快速登录号通常就是机器人号；上面没换完的遗珠再扫一遍
if [ -n "$QUICK_LOGIN" ] && [ "$QUICK_LOGIN" != "$SELF_ID" ]; then
  sanitize "$QUICK_LOGIN" '<BOT_UIN>'
fi

if [ -n "$ADMINS" ]; then
  IFS=',' read -ra LIST <<< "$ADMINS"
  i=0
  for u in "${LIST[@]}"; do
    [ -z "$u" ] && continue
    sanitize "$u" "<UIN$((++i))>"
  done
fi

# ---------- 5. 硬门槛：密钥扫描 ----------
# 闸门口径：sk- 密钥 / 公网 IP / 真 token 一律中止；
# 127.0.0.1、0.0.0.0、::1 属回环与占位，放行（否则文档里每条 ws://127.0.0.1 都会误报）。
log "扫描密钥与公网 IP（必须为 0）"
HITS=$(grep -rInE 'sk-[A-Za-z0-9]{20,}|([0-9]{1,3}\.){3}[0-9]{1,3}|"token"[[:space:]]*:[[:space:]]*"[0-9a-fA-F]{8,}"' \
         --exclude-dir=.git . 2>/dev/null || true)
HITS=$(printf '%s\n' "$HITS" | grep -vE '127\.0\.0\.1|0\.0\.0\.0|::1|255\.255\.255\.255' || true)
if [ -n "$HITS" ]; then
  printf '%s\n' "$HITS" >&2
  fail "发现疑似密钥 / 公网 IP / 真 token，已中止。修正后重跑。"
fi
log "扫描通过"

# ---------- 6. 提交 ----------
if [ "${1:-}" = "--commit" ]; then
  log "本地提交"
  git add -A
  git -c user.name="${GIT_AUTHOR_NAME:-AgentTalk}" \
      -c user.email="${GIT_AUTHOR_EMAIL:-agenttalk@localhost}" \
      commit -m "sync: 从生产机导出 $(date '+%F %T')" || log "无变更可提交"
fi

log "完成。推送前请确认："
echo "  cd $REPO_DIR && git log --oneline -3 && git diff --stat"
