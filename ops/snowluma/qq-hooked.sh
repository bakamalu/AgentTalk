#!/bin/bash
# ============================================================
# QQ NT 拉起器（SnowLuma 注入用，部署到 /opt/snowluma/qq-hooked.sh）
# ============================================================
# 与 NapCat 的 /opt/launcher.sh 的差别只有一处：
#   NapCat  → LD_PRELOAD=libnapcat_launcher.so（进程内注入，登录前就 hook 住）
#   SnowLuma→ **不预加载任何东西**，先让 QQ 正常起来，再由 supervisor 用
#             native/snowluma-linux-x64.so 走 loadModuleManualAsync(pid, so)
#             把 hook 注进去（ptrace/dlopen 式，无需重启 QQ）
#
# 但有一件事必须两边一致：hook 管道 socket 目录。
#   supervisor 侧：读自己的 SNOWLUMA_HOOK_RUNTIME_DIR
#   QQ 侧：supervisor 会去 /proc/<pid>/environ 里找 SNOWLUMA_HOOK_RUNTIME_DIR，
#          找不到才退回 XDG_RUNTIME_DIR，再找不到才用 /tmp/snowluma-<uid>。
#   本机 XDG_RUNTIME_DIR=/run/user/0 是存在的，若不显式指定，两侧会算出不同目录
#   → WebUI 里永远看不到"已注入"。所以这里显式 export。
#
# 另外：systemd 环境没有 HOME 会让 QQ 在 prelogin 阶段 SIGILL（历史事故），
# 这里显式兜底；X 残锁清理逻辑与 NapCat 版完全一致（脏显示号同样 SIGILL）。
#
# 用法：
#   ./qq-hooked.sh            # 后台常驻，由 supervisor 在 WebUI 里点注入
#   SNOWLUMA_QUICK_LOGIN=<uin> ./qq-hooked.sh
# ============================================================
set -uo pipefail

QQ_BIN=${QQ_BIN:-/opt/QQ/qq}
RUNTIME_DIR=${SNOWLUMA_HOOK_RUNTIME_DIR:-/opt/snowluma/run}

export HOME="${HOME:-/root}"
export USER="${USER:-root}"
export LOGNAME="${LOGNAME:-root}"
export SNOWLUMA_HOOK_RUNTIME_DIR="$RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR"

# --- X 残锁清理：只碰高位显示号（>=90），绝不碰 gdm 的 Xwayland ---
clean_x11_leftovers() {
  local l n sock pids p ppid comm orphan other
  for l in /tmp/.X*-lock; do
    [ -e "$l" ] || continue
    n=${l#/tmp/.X}; n=${n%-lock}
    case "$n" in (*[!0-9]*) continue;; esac
    [ "$n" -ge 90 ] 2>/dev/null || continue
    sock="/tmp/.X11-unix/X$n"

    ss -x 2>/dev/null | grep -q "X11-unix/X$n\b" && continue

    pids=$(fuser "$sock" 2>/dev/null | tr -s ' ' '\n' | grep -E '^[0-9]+$')
    orphan=0; other=0
    for p in $pids; do
      ppid=$(awk '{print $4}' "/proc/$p/stat" 2>/dev/null)
      comm=$(cat "/proc/$p/comm" 2>/dev/null)
      if [ "$comm" = "Xvfb" ] && [ "$ppid" = "1" ]; then
        orphan=1
      else
        other=1
      fi
    done
    [ "$other" = 1 ] && continue

    if [ "$orphan" = 1 ]; then
      for p in $pids; do kill -TERM "$p" 2>/dev/null; done
      sleep 1
      for p in $pids; do kill -KILL "$p" 2>/dev/null; done
      echo "[qq-hooked] 收尸孤儿 Xvfb :$n"
    fi
    rm -f "$l" "$sock" && echo "[qq-hooked] 清理残锁 :$n"
  done
}

clean_x11_leftovers

QL=${SNOWLUMA_QUICK_LOGIN:-}
if [ -n "$QL" ]; then
  echo "[qq-hooked] 拉起 QQ（快速登录 $QL），hook 目录 $RUNTIME_DIR"
  exec xvfb-run -a "$QQ_BIN" --no-sandbox -q "$QL" "$@"
fi
echo "[qq-hooked] 拉起 QQ（交互登录/扫码），hook 目录 $RUNTIME_DIR"
exec xvfb-run -a "$QQ_BIN" --no-sandbox "$@"
