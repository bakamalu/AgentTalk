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
DROP=$(mktemp)
SELF_ID=""
[ -r /root/deploy/bot.env ] && SELF_ID=$(grep -oP '(?<=^export NAPCAT_SELF_ID=")[^"]*' /root/deploy/bot.env || true)
ADMINS=$([ -r /root/deploy/bot.env ] && grep -oP '(?<=^export BOT_ADMIN_USERS=")[^"]*' /root/deploy/bot.env || true)
TOKEN=$([ -r /opt/napcat/config/webui.json ] && python3 -c "import json;print(json.load(open('/opt/napcat/config/webui.json')).get('token',''))" || true)

find . -path ./.git -prune -o -type f \
     \( -name '*.md' -o -name '*.js' -o -name '*.json' -o -name '*.example' -o -name '*.sh' \) -print0 \
| xargs -0 sed -i \
    -e "s/${TOKEN:-@@NOPE@@}/<WEBUI_TOKEN>/g" \
    -e "s/${SELF_ID:-@@NOPE@@}/<BOT_UIN>/g"

if [ -n "$ADMINS" ]; then
  IFS=',' read -ra LIST <<< "$ADMINS"
  i=0
  for u in "${LIST[@]}"; do
    [ -z "$u" ] && continue
    ph="<UIN$((++i))>"
    sed -i "s/$u/$ph/g" $(grep -rl "$u" --include='*.md' . 2>/dev/null || true)
  done
fi
rm -f "$DROP"

# ---------- 5. 硬门槛：密钥扫描 ----------
log "扫描密钥（必须为 0）"
if grep -rInE 'sk-[A-Za-z0-9]{20,}|[0-9]{1,3}(\.[0-9]{1,3}){3}|"token"[[:space:]]*:[[:space:]]*"[0-9a-f]{8,}"' \
     --exclude-dir=.git . ; then
  fail "发现疑似密钥/IP，已中止。请修正后重跑。"
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
