#!/bin/bash
# ============================================================
# botctl.sh — QQ 机器人（SnowLuma 网关）统一运维入口
# ============================================================
# 为什么有这个脚本：2026-10-31 那次排障，动作全部散在 `docker exec`、
# `xdotool`、`systemctl`、`ss`、`grep` 的手敲命令里，敲错一条就出事
# （把 webuiHost 改成 0.0.0.0 后判活写死 "127.0.0.1:5099" 失配，watchdog
# 每 90s 重建一次容器，机器人整上午离线）。这里把**唯一正确的顺序**固化下来。
#
# 与 ops/ 下既有脚本的分工（不重复实现，能复用就复用）：
#   scripts/botctl.sh          ← 日常：看状态 / 重启 / 恢复登录 / 部署 / 验证
#   ops/snowluma/container/run.sh  容器原生操作（up/down/logs/vnc）
#   ops/snowluma/post-login.sh     登录后的核验与网关切换
#   ops/s0-verify.sh               39 项一致性闸门
#   scripts/export-from-server.sh  服务器 → 仓库回灌（含脱敏）
#
# 用法：
#   scripts/botctl.sh status                 一页看全（只读，任何时候都能跑）
#   scripts/botctl.sh restart <目标>         koishi|snowluma|watchdog|nginx|ddns|all
#   scripts/botctl.sh login                  恢复 QQ 登录（先拍画面→按账号页点→用 3001 验收）
#   scripts/botctl.sh shot [名字]            抓容器内画面到 /tmp（不自动删，看完跑 clean）
#   scripts/botctl.sh clean                   清掉截图残留（s0-verify 会查计数）
#   scripts/botctl.sh qr                     刷新二维码（需人工用手机扫）
#   scripts/botctl.sh sync <目标> [说明]     部署到线上执行副本（plugin|watchdog|env）
#                                          plugin 会连带同步 bot/lib/*.js → /opt/koishi/lib/
#   scripts/botctl.sh verify [秒] [-q|-k]    OneBot 配置一致性核验（默认 3001，只读不发消息）
#   scripts/botctl.sh gate                   s0-verify.sh 闸门
#   scripts/botctl.sh tls                    WebUI 证书信息与到期天数
#   scripts/botctl.sh logs [服务] [行数]     取日志尾部
# ============================================================
set -uo pipefail

REPO=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
SL_CONTAINER=${SL_CONTAINER:-qqbot-snowluma}
SL_DIR=${SL_DIR:-/opt/snowluma}
WORKERS=${WORKERS:-/root/.local/share/snowluma/names/v8.2-main-worker1770217831379-0}
DISPLAY_NO=${DISPLAY_NO:-:99}
SHOTS=/tmp/snowluma-shots
GATEWAY_3001=${GATEWAY_3001:-3001}
WEBUI_5099=${WEBUI_5099:-5099}
KOISHI_5140=${KOISHI_5140:-5140}
UNIT=qqbot-watchdog

# 账号页控件坐标（1280x800，2026-10-31 用 scrot 区域截图逐个像素确认）。
# 只在"容器重建后停在账号页"这一种情形下有效；若改版后布局变了，
# 必须先 `botctl.sh shot` 看真实画面，再手工 xdotool，不要盲改这里的常数。
XY_AUTOLOGIN="613 497"   # 「自动登录」勾选框（重建后默认未勾选）
XY_LOGIN="639 537"      # 「登录」按钮

# 判活**只匹端口、绝不写死 "IP:port"**：WebUI/OneBot 的 bind 地址可配，
# 一旦从 127.0.0.1 改成 0.0.0.0，写死字面量就永远匹配不中（已因此出过事故）。
listening() { ss -ltn 2>/dev/null | grep -qE ":$1([[:space:]]|\$)"; }
bind_addr() { ss -ltn 2>/dev/null | awk -v p=":$1" '$4 ~ p"$" {print $4; exit}'; }
# 日志文件名带 `snowluma-` 前缀，写成 `$(date +%F).log` 会**静默找不到文件**
# → 靠它做的判断永远为空（已导致 warmup 恒 0、页面状态恒“未知”）。
# 取最新一份而非按今日名，顺便避开跨零点写不到新文件的问题。
sl_log() { ls -t "$SL_DIR"/logs/snowluma-*.log 2>/dev/null | head -1; }
# 注意：不要用 `grep -oE '[0-9.\[:]+:5099'` 这类字符类写法取地址，
# 括号漏转义会报 "Unmatched ["（同一个坑在 s0-verify.sh 里踩过两次）。

say()  { printf '%s\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
bad()  { printf '\033[31m%s\033[0m\n' "$*"; }
ok()   { printf '\033[32m%s\033[0m\n' "$*"; }

do_status() {
  say "── 容器 ─────────────────────────────────────────"
  docker ps -a --format '{{.Names}}\t{{.Status}}' | grep -E 'snowluma|napcat' \
    | awk -F'\t' '{printf "  %-20s %s\n", $1, $2}'
  say "── QQ 与 OneBot ────────────────────────────────"
  local pid; pid=$(docker exec "$SL_CONTAINER" pgrep -f '/opt/QQ/qq --no-sandbox' 2>/dev/null | head -1)
  say "  QQ 主进程   : ${pid:-未启动}"
  if docker exec "$SL_CONTAINER" pgrep -f 'index\.mjs' >/dev/null 2>&1; then
    ok "  supervisor  : 在跑"
  else
    bad "  supervisor  : 缺失 → QQ 登不上，跑 botctl.sh restart snowluma"
  fi
  # warmup 完成是 hook 会话就绪的唯一可靠标志；实测措辞是 `member warmup completed`
  # （不是 “round complete”，写后者永远得 0）。
  local LOG warm; LOG=$(sl_log)
  warm=$(grep -ac 'member warmup completed' "$LOG" 2>/dev/null)
  say "  warmup 完成 : ${warm:-0} 次（0 = hook 会话还没就绪，发消息必失败）"
  say "── 端口 ─────────────────────────────────────────"
  for p in "$GATEWAY_3001" "$WEBUI_5099" "$KOISHI_5140"; do
    local a; a=$(bind_addr "$p")
    if [ -n "$a" ]; then ok "  :$p 监听 ${a}"; else bad "  :$p 未监听"; fi
  done
  [ "$(bind_addr "$WEBUI_5099")" != "127.0.0.1:$WEBUI_5099" ] && \
    warn "  ⚠ WebUI 未只绑回环 → 外网可达（受云安全组控制，务必确认有 TLS+口令+TOTP）"
  say "── 进程与守卫 ───────────────────────────────────"
  local main wk
  main=$(ps -eo pid,cmd | awk '/node .*[/]koishi/ && !/worker/ {print $1; exit}')
  wk=$(ps -eo pid,lstart,cmd | awk '/[/]worker/ && /koishi/ {print $1" "$2" "$3" "$4" "$5" "$6}' | head -1)
  say "  Koishi 主进程 : ${main:-无}"
  say "  Koishi worker : ${wk:-无}"
  # 端口在但主进程没了 = 只剩孤儿 worker 在跑旧代码，按端口判活的 watchdog 不会补拉
  if listening "$KOISHI_5140" && [ -z "$main" ]; then
    bad "  ⚠ 5140 在监听却无主进程 → 孤儿 worker 跑旧代码！跑 botctl.sh restart koishi"
  fi
  say "  watchdog      : $(systemctl is-active $UNIT 2>/dev/null)"
  say "  nginx / ddns  : $(systemctl is-active nginx 2>/dev/null) / $(systemctl is-active qqbot-ddns 2>/dev/null)"
  say "  截图残留       : $(find "$SHOTS" -name '*.png' 2>/dev/null | wc -l) 张（应为 0）"
  # 本机 free 是中文 locale（行首是“内存：”而不是 “Mem:”），`/^Mem/` 永远匹配不中
  # → 输出空白。按行号取才与 locale 无关（同一个坑今天实测踩过）。
  free -m | awk 'NR==2 {printf "── 内存 ────────── used %sMB / available %sMB\n", $3, $7}'
}

do_shot() {
  local name=${1:-screen-$(date +%H%M%S)}
  mkdir -p "$SHOTS"; docker exec "$SL_CONTAINER" mkdir -p "$SHOTS"
  docker exec -e DISPLAY="$DISPLAY_NO" "$SL_CONTAINER" \
    sh -c "DISPLAY=$DISPLAY_NO scrot -o $SHOTS/$name.png" >/dev/null 2>&1
  docker cp "$SL_CONTAINER:$SHOTS/$name.png" "$SHOTS/$name.png" 2>/dev/null
  if [ -s "$SHOTS/$name.png" ]; then say "$SHOTS/$name.png"; else bad "截图失败（scrot 未生成文件）"; return 1; fi
}

do_qr() {
  local f="$SHOTS/qq-qr.png"
  mkdir -p "$SHOTS"; docker exec "$SL_CONTAINER" mkdir -p "$SHOTS"
  # scrot -o 遇同名文件**不覆盖且不报错**（10-31 因此误判“刷码失败”：
  # png 的 mtime 停在上一轮，而脚本却打印了成功），故先删旧图。
  rm -f "$f"; docker exec "$SL_CONTAINER" rm -f "$f" 2>/dev/null
  docker exec -e DISPLAY="$DISPLAY_NO" -e SNOWLUMA_SHOTS="$SHOTS" -e SNOWLUMA_WORKDIR="$WORKERS" "$SL_CONTAINER" node -e '
    const x=require("xdotool"); x.search("wechat.exe").sync().activateWindow().windowsRaise();
    x.search("Nt Login").forEach(w=>{w.sync();w.click("1920",371);});
    x.sync();' >/dev/null 2>&1
  sleep 6
  docker exec -e DISPLAY="$DISPLAY_NO" "$SL_CONTAINER" \
    sh -c "DISPLAY=$DISPLAY_NO scrot -o $f" >/dev/null 2>&1
  docker cp "$SL_CONTAINER:$f" "$f" 2>/dev/null
  [ -s "$f" ] && say "二维码已刷新：$f（同名的 scrot 不会覆盖旧文件，故先删再拍）" || bad "刷码失败"
}

# 恢复登录：这是本脚本最该存在的原因——仓库里原先没有任何脚本覆盖它
#（post-login.sh 只做“登录后的核验”，不含点击登录）。
# 实测结论（10-31 两次对比）：容器被重建会丢登录态，但丢失后停在的是
# **账号选择页**，勾「自动登录」+点「登录」约 15s 上线，**不需要重新扫码**。
# 曾把日志里的 "awaiting login" 当成“必须重新扫码”，白刷了两次码、
# 还浪费一次 168 限额。另：日志**区分不了账号页与扫码页**（只有 awaiting login
# 这一种措辞），所以不靠猜页面，而是**先按账号页做、用 3001 是否起来验收**。
do_login() {
  if listening "$GATEWAY_3001"; then
    ok "QQ 已登录（:$GATEWAY_3001 在监听），无需操作"; return 0
  fi
  local LOG; LOG=$(sl_log)
  say "→ 3001 未监听。日志最近一条登录线索：$(grep -a 'awaiting login' "$LOG" 2>/dev/null | tail -1 | cut -c1-90)"
  # 先拍真实画面：坐标失效或页面出乎意料时，人能立刻看出来，脚本也能存档
  local pic; pic=$(do_shot "login-$(date +%H%M%S)") || warn "  拍不到画面，继续尝试标准流程"
  # 有 Nt Login 窗口 = 确实停在登录界面（账号页/扫码页共用此窗口，因此无法再细分）
  if ! docker exec -e DISPLAY="$DISPLAY_NO" "$SL_CONTAINER" \
       sh -c "DISPLAY=$DISPLAY_NO xdotool search Nt\ Login" 2>/dev/null | grep -q .; then
    warn "  未找到 Nt Login 窗口 → 可能不在登录页，动作仍会尝试，但请先看画面：${pic:-无}"
  fi

  say "→ 按账号页流程：勾选「自动登录」→ 点「登录」（约 15s 上线）"
  # 两个 click 之间必须 sync()，否则坐标点击会丢失（xdotool 已知坑）
  docker exec -e SNOWLUMA_WORKDIR="$WORKERS" "$SL_CONTAINER" node -e "
    const x=require('xdotool');
    const main=x.search('wechat.exe')[0]; if(!main) throw new Error('QQ 进程不存在');
    main.sync().activateWindow().windowsRaise();
    const box=x.search('Nt Login')[0];
    if (box) { box.sync(); box.click($XY_AUTOLOGIN); x.sync(); require('child_process').execSync('sleep 1'); }
    const win=box||main; win.sync(); win.click($XY_LOGIN); x.sync();" 2>&1 | grep -v '^$' | head -5

  say "  等待 :$GATEWAY_3001 ..."
  local i
  for i in $(seq 1 12); do
    sleep 5
    if listening "$GATEWAY_3001"; then
      ok "  已上线（约 $((i*5))s）；warmup 首轮约 4-5 分钟，期间发消息会失败"
      docker exec "$SL_CONTAINER" pgrep -f 'index\.mjs' >/dev/null 2>&1 \
        || warn "  ⚠ supervisor 缺失：Koishi 连不上 3001，需 restart snowluma 让 watchdog 补组件"
      return 0
    fi
  done
  bad "  60s 内 3001 仍未监听。两种可能，**不要重复盲点**："
  bad "  1) 坐标失效（页面改版）—— 再跑一次 botctl.sh shot 看真实画面，按画面手工点，"
  bad "     并考虑更新本脚本的 XY_* 常数（像素定位方法见 container/run.sh 注释）。"
  bad "  2) 实际停在**扫码页**而不是账号页 —— 跑 botctl.sh qr 刷新后用手机 QQ「扫一扫」。"
  bad "     ⚠ 二维码约 2 分钟过期；同账号一天限 3 次非首次登录，超限只会得到坏码，只能等次日。"
  return 1
}

do_restart() {
  case "${1:-}" in
    koishi)
      # ⚠ 绝不 kill `pgrep -f koishi` 拿到的 PID：那通常是 worker 子进程，
      # 且 5140 由 worker 监听，watchdog 按端口判活便不再补拉 —— 于是主进程死了、
      # 孤儿 worker 带着旧代码继续占端口，表面"已重启"实际没重启（10-31 真实踩过）。
      say "→ 经 systemd 重启（会连带重建 Koishi 主进程与 worker）"
      systemctl restart "$UNIT"
      # 11-02 实测：watchdog 重启后 Koishi 要 ~35s 才监听 5140（要拉起容器、恢复历史），
      #   写死 sleep 8 会报“5140 未监听”的**假失败**，很容易让人再重启一次。
      say "  等待 5140 就绪（最多 90s）..."
      local i
      for i in $(seq 1 18); do
        sleep 5
        listening "$KOISHI_5140" && break
      done
      local wk; wk=$(ps -eo pid,lstart,cmd | awk '/[/]worker/ && /koishi/ {print $1" "substr($0,index($0,$2))}' | head -1)
      if listening "$KOISHI_5140"; then
        say "  5140 已监听（等了约 $((i * 5))s）；worker 实际启动时间：${wk:-未取到}"
        say "  ↑ 必须核对这个时间是刚才：只有 worker 是新的，加载的才是新代码"
      else
        bad "  5140 仍未监听，查 botctl.sh logs koishi"
        return 1
      fi
      ;;
    snowluma)
      # 注：`docker restart` 能不能保住 QQ 登录态**未专项实测**（实测过的是 watchdog
      # 走 rm+run 重建 → 会丢，必须重登）。所以不下结论，一律靠下面的 3001 探测判定。
      say "→ 重启 SnowLuma 容器（若登录态没保住，接着跑 botctl.sh login）"
      docker restart "$SL_CONTAINER"
      say "  等待 WebUI/OneBot ..."
      local i
      for i in $(seq 1 20); do
        sleep 3
        listening "$WEBUI_5099" && listening "$GATEWAY_3001" && { ok "  5099 + 3001 就绪"; break; }
      done
      listening "$GATEWAY_3001" || warn "  3001 未起 → 很可能需要 botctl.sh login"
      ;;
    watchdog)
      systemctl restart "$UNIT" && say "  $UNIT 已重启"
      say "  清掉连续失败计数（避免遗留状态立刻触发重建）"
      docker exec "$SL_CONTAINER" rm -f /tmp/sl-comp-miss /tmp/sl-miss /tmp/miss-count 2>/dev/null
      ;;
    nginx) systemctl restart nginx && say "  nginx 已重启（证书换过后必须做这步）" ;;
    ddns)  systemctl restart qqbot-ddns && say "  qqbot-ddns 已重启" ;;
    all)   do_restart snowluma; do_restart koishi ;;
    *)    bad "用法: $0 restart <koishi|snowluma|watchdog|nginx|ddns|all>"; return 2 ;;
  esac
}

# sync plugin 的 cp 中途失败时用：把已经覆盖的文件退回备份
# （语法检查失败的回滚写在 do_sync 内部，因为那里还拿着 srcs 的作用域）
do_sync_rollback() {
  local ts=${1:-}
  shift
  local s d
  for s in "$@"; do
    d="/opt/koishi/${s#"$REPO/bot/"}"
    [ -f "${d}.bak-$ts" ] && cp "${d}.bak-$ts" "$d" && warn "  已回滚 $d"
  done
}

do_sync() {
  local target=${1:-} note=${2:-manual}
  local TS; TS=$(date +%m%d-%H%M)
  case "$target" in
    plugin)
      # 插件主体 + 共享模块必须一起同步：线上入口是 /opt/koishi/plugins/deepseek.js，
      # 它 require('../lib/xxx')，所以 lib 落在 /opt/koishi/lib/。
      # ⚠ lib 不能放 plugins/ 下：koishi.config.js 里插件是按路径显式声明的，
      #   但 plugins 目录仍会被 loader 扫描，多出来的 js 会被当成插件装载并报错。
      local srcs=()
      [ -f "$REPO/bot/plugins/deepseek.js" ] || { bad "仓库副本不存在：$REPO/bot/plugins/deepseek.js"; return 1; }
      srcs+=("$REPO/bot/plugins/deepseek.js")
      for f in "$REPO"/bot/lib/*.js; do [ -f "$f" ] && srcs+=("$f"); done
      # 线上还不存在的模块（首次部署 lib/）会被 diff 当成“有差异”，需 FORCE=1 确认一次，
      # 这是预期行为；备份步骤对缺失文件自动跳过（cp 失败只 || true）
      say "  待同步 ${#srcs[@]} 个文件（deepseek.js + bot/lib/）"

      # 两份是**独立文件、无自动同步**（P1-1 的遗留风险）；先全量比对再动线上
      local dirty=0 s d f
      for s in "${srcs[@]}"; do
        d="/opt/koishi/${s#"$REPO/bot/"}"
        if ! diff -q "$s" "$d" >/dev/null 2>&1; then dirty=1; break; fi
      done
      if [ "$dirty" = "1" ]; then
        say "→ 两副本有差异（含 lib/），先确认差异只含本次改动（别覆盖掉别人的线上热修）："
        for s in "${srcs[@]}"; do
          d="/opt/koishi/${s#"$REPO/bot/"}"
          diff -q "$s" "$d" >/dev/null 2>&1 || { echo "--- $d（线上）vs $s（仓库）"; diff -u "$d" "$s" 2>&1 | head -30; }
        done
        warn "   确认无误后再跑一次，并加 FORCE=1"
        [ "${FORCE:-0}" = "1" ] || return 1
      fi
      # 逐文件备份再 cp：失败回滚靠这些 .bak，不先存则回滚是空操作
      mkdir -p /opt/koishi/lib
      local synced=()
      for s in "${srcs[@]}"; do
        d="/opt/koishi/${s#"$REPO/bot/"}"
        cp "$d" "${d}.bak-$TS" 2>/dev/null || true
        cp "$s" "$d" || { bad "cp 失败：$d"; do_sync_rollback "$TS" "${synced[@]}"; return 1; }
        synced+=("$s")
        say "  已 cp → $d（备份 ${d}.bak-$TS）"
      done
      ;;
    watchdog)
      cp "$REPO/ops/bot-watchdog.sh" /opt/bot-watchdog.sh && say "  已 cp → /opt/bot-watchdog.sh"
      systemctl restart "$UNIT"
      ;;
    env)
      say "→ /root/deploy/*.env 由容器启动时读取，改动要 restart 才生效"
      ;;
    *) bad "用法: $0 sync <plugin|watchdog|env> [说明]"; return 2 ;; esac

  # 语法检查必须在部署之后立刻做，且用 `|| { }` 而非 `&& ... ||`
  # （后者会让成功路径也误报失败，这个低级错误今天也犯过一次）
  # ⚠ node --check 只查语法，查不出缺模块/未定义变量，所以只能当最低闸门，
  #   上线前还应跑 scripts/smoke-plugin.js。
  case "$target" in
    plugin)
      local bad_file=""
      for s in "${srcs[@]}"; do
        d="/opt/koishi/${s#"$REPO/bot/"}"
        node --check "$d" >/dev/null 2>&1 || { bad_file="$d"; break; }
      done
      if [ -n "$bad_file" ]; then
        bad "语法检查未通过：$bad_file，回滚本次同步的文件"
        for s in "${srcs[@]}"; do
          d="/opt/koishi/${s#"$REPO/bot/"}"
          [ -f "${d}.bak-$TS" ] && cp "${d}.bak-$TS" "$d" && say "  已回滚 $d"
        done
        return 1
      fi
      say "  node --check 通过（共 ${#srcs[@]} 个文件）"
      do_restart koishi
      ;;
    watchdog) bash -n /opt/bot-watchdog.sh || { bad "语法检查未通过"; return 1; } ;;
  esac
}

do_clean() {
  rm -f "$SHOTS"/*.png 2>/dev/null
  docker exec "$SL_CONTAINER" rm -f "$SHOTS"/*.png 2>/dev/null
  say "  已清截图（s0-verify.sh 会检查残留计数，不归 0 过不了闸门）"
}

# verify-onebot.sh 只接 -q / -k 两个选项，端口靠 PORT 环境变量传入。
# 旧写法把“秒数”当成第一个位置参数传给它 → 永远“未知参数”直接退出（11-02 踩到，
# 等于部署后的只读核验闸门从来没跑过）。
do_verify() {
  # 调度层写成 do_verify "${2:-}" "${3:-}"，会带进空串；这里先滤掉空参数，
  # 否则空串会被当成位置参数传给 verify-onebot.sh 变成“未知参数：”
  local args=() a
  for a in "$@"; do [ -n "$a" ] && args+=("$a"); done
  local sec=${args[0]:-90}
  timeout "$sec" env PORT="${PORT:-$GATEWAY_3001}" bash "$REPO/ops/snowluma/verify-onebot.sh" "${args[@]:1}" 2>&1 | tail -20
}
do_gate()   { bash "$REPO/ops/s0-verify.sh" 2>&1 | tail -25; }

do_tls() {
  local crt="$SL_DIR/config/cert.pem"
  [ -f "$crt" ] || { warn "无 $crt → WebUI 走明文 HTTP（开启 webuiTls 前必须先放证书，否则 WebUI 直接起不来）"; return 0; }
  say "证书：$(openssl x509 -noout -subject -in "$crt" | sed 's/^subject=*//')"
  say "SAN ：$(openssl x509 -noout -ext subjectAltName -in "$crt" 2>/dev/null | tail -1 | tr -d ' ')"
  local end_at left; end_at=$(openssl x509 -noout -enddate -in "$crt" | cut -d= -f2)
  left=$(( ($(date -d "$end_at" +%s) - $(date +%s)) / 86400 ))
  say "到期：$end_at（剩 ${left} 天）"
  [ "$left" -lt 30 ] && warn "  不足 30 天，需重签并同步 /etc/letsencrypt/live/mdzzjx.cn/ 与 nginx 重启"
  say "私钥权限：$(stat -c '%a %U' "$SL_DIR/config/key.pem" 2>/dev/null)（应为 600）"
  local scheme=https
  if ! listening "$WEBUI_5099"; then
    warn "WebUI 未监听，跳过登录接口自检"
    return 0
  fi
  # 必须显式带 JSON 头：curl -d 默认 form-urlencoded，SnowLuma 直接拒为 **415**，
  # 会被当成“WebUI 异常”。带头后错误口令回 401 才是预期值。
  say "登录接口自检（401=正常；000/5xx=有问题）：$(curl -s -k -o /dev/null -w '%{http_code}' -m 8 -X POST -H 'Content-Type: application/json' -d '{"password":"x"}' "$scheme://127.0.0.1:$WEBUI_5099/api/login")"
}

do_logs() {
  case "${1:-koishi}" in
    koishi)   tail -n "${2:-30}" /opt/logs/koishi.log ;;
    snowluma) tail -n "${2:-30}" "$(sl_log)" ;;
    watchdog) journalctl -u "$UNIT" --no-pager -n "${2:-30}" ;;
    *) bad "用法: $0 logs <koishi|snowluma|watchdog> [行数]"; return 2 ;;
  esac
}

case "${1:-help}" in
  status)  do_status ;;
  restart) do_restart "${2:-}" ;;
  login)   do_login ;;
  shot)    do_shot "${2:-}" ;;
  clean)   do_clean ;;
  qr)      do_qr ;;
  sync)    do_sync "${2:-}" "${3:-}" ;;
  verify)  do_verify "${2:-}" "${3:-}" ;;
  gate)    do_gate ;;
  tls)     do_tls ;;
  logs)    do_logs "${2:-}" "${3:-}" ;;
  listen)  say "  $(bind_addr "${2:-$WEBUI_5099}")" ;;
  *)
    sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
    ;;
esac
