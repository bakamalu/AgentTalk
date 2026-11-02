#!/bin/bash
# ============================================================
# SnowLuma supervisor 启动器（部署到 /opt/snowluma/start.sh）
# ============================================================
# 只做三件事：切到代码目录 → 载入运行时环境 → exec 发行包自带 launcher.sh。
#
# 为什么要切目录：SnowLuma 的 config/ data/ logs/ 都是**相对 CWD** 的固定名字，
# CWD 必须 = /opt/snowluma，否则会跑到别的目录下重新生成一套空配置。
#
# 为什么不用 systemd 直接拉 launcher.sh：环境变量（EULA 同意、口令、日志目录、
# hook socket 目录）集中在一个 600 文件里，且与 bot.env 分离——SnowLuma 的
# 口令不该混进 QQ 机器人那套密钥里。
#
# 用法：
#   ./start.sh              # 前台（调试）
#   nohup ./start.sh &      # 后台（watchdog 就是这么拉的）
# ============================================================
set -euo pipefail

ROOT=/opt/snowluma
ENV_FILE=/root/deploy/snowluma.env

cd "$ROOT"

# systemd 系统级 service 不带 HOME/USER → Electron/Node 都会出怪问题（有前科）
export HOME="${HOME:-/root}"
export USER="${USER:-root}"
export LOGNAME="${LOGNAME:-root}"

# 一律不 source /etc/profile，也不依赖 bot.env：
#   1) 20.04 宿主上 `. /etc/profile` 会让整个脚本直接以 1 退出且无任何输出
#      （trace 到这一行就断），排查成本 > 收益；容器里也未必有同一套 profile.d。
#   2) SnowLuma 需要的只有 PATH/HOME/LANG 与自己那份 snowluma.env，显式给足。
# 历史教训：之前这里写了 `. /etc/profile || true`，`|| true` 拦不住 profile
# 内部的 exit，表现就是 start.sh 静默 exit 1 而 `./node ./index.mjs` 正常。
export PATH="/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:${PATH:-}"
export LANG="${LANG:-C.UTF-8}"

# 运行时环境（600）：EULA、WebUI 口令、日志目录、hook socket 目录
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi

mkdir -p "${SNOWLUMA_LOG_DIR:-$ROOT/logs}" "${SNOWLUMA_HOOK_RUNTIME_DIR:-$ROOT/run}"

exec ./launcher.sh "$@"
