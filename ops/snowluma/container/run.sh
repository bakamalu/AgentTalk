#!/bin/bash
# ============================================================
# 容器启动器 —— docker run 参数的唯一来源（不要手敲）
# ============================================================
# 为什么参数长这样：
#   --network host       Koishi 连 127.0.0.1:3001、宿主访问 127.0.0.1:5099，
#                        都用回环；bridge + -p 也能做，但 OneBot 的
#                        accessToken 之外再引一层 NAT 只会增加排障面。
#   --cap-add SYS_PTRACE SnowLuma 是靠 ptrace/dlopen 把 .so 注进 QQ 进程的
#                        （不是 LD_PRELOAD），没有这个能力连进程都读不到。
#   seccomp=unconfined   ptrace + process_vm_readv 在默认 profile 下会被拦。
#   --shm-size 512m      Electron 默认 64m 的 /dev/shm 会崩渲染进程。
#   --stop-timeout 20    默认 10s 不够 entrypoint 优雅收尾（Xvfb/QQ 都要等）。
#   --restart no         生命周期交给 bot-watchdog / systemd，两个重启器并存
#                        会互相抢容器名。
#
# 挂载：
#   /opt/snowluma        代码 + config/data/logs/run（状态层就地持久化）
#   /opt/QQ              QQ 本体，可写（QQ 会往里写临时文件）
#   /root/.config/QQ     登录态（235MB），复用宿主已有的登录，不用重扫码
#   /root/deploy/snowluma.env  600 运行时环境，只读挂进容器
#
# 扫码登录：SNOWLUMA_VNC=1 时 entrypoint 会额外起 x11vnc（只听 127.0.0.1:5900）。
# 宿主上执行 `ssh -L 5900:127.0.0.1:5900 root@<本机>` 后用 VNC 客户端连
# localhost:5900 就能看到 QQ 的登录二维码。登录完把 SNOWLUMA_VNC 改回 0 重启。
#
# 用法：
#   ./run.sh up        # 起容器（QQ 是否启动看 snowluma.env 的 SNOWLUMA_START_QQ）
#   ./run.sh down      # 停并删除容器
#   ./run.sh status    # 容器状态 + 三类进程 + 端口
#   ./run.sh logs      # 跟 entrypoint 日志
#   ./run.sh shot      # 截全屏 + 只截登录二维码（scrot 已在镜像里，不装包）
#   ./run.sh qr        # 点「刷新」换新二维码并出图（旧码过期时用）
#   ./run.sh vnc       # 打印 SSH 隧道命令（纯提示）
# ============================================================
set -euo pipefail

IMAGE="${IMAGE:-qqbot/snowluma:2.2.1}"
NAME="${NAME:-qqbot-snowluma}"
SL_DIR=/opt/snowluma
QQ_DIR=/opt/QQ
QQ_CFG=/root/.config/QQ
ENV_FILE=/root/deploy/snowluma.env

die() { echo "[run] 错误：$*" >&2; exit 1; }

[ -f "$ENV_FILE" ] || die "$ENV_FILE 不存在"
[ -d "$SL_DIR" ] || die "$SL_DIR 不存在"
[ -d "$QQ_DIR" ] || die "$QQ_DIR 不存在（QQ 没装？）"
docker image inspect "$IMAGE" >/dev/null 2>&1 || die "镜像 $IMAGE 不存在，先 docker build"

case "${1:-up}" in
  up)
    # 多账号：额外 QQ 的 HOME 必须**逐个挂进来**（宿主机路径 = 容器内路径），
    # 否则容器一重建，第二个号的登录态就丢（登录态就落在那份 HOME 里）。
    # 名单来源是 snowluma.env 的 SNOWLUMA_EXTRA_QQ_HOMES（逗号/空格分隔）。
    EXTRA_MOUNTS=()
    EXTRA_HOMES=$(sed -n 's/^export SNOWLUMA_EXTRA_QQ_HOMES="\(.*\)"$/\1/p' "$ENV_FILE" | tr ',' ' ')
    for h in $EXTRA_HOMES; do
      [ -d "$h" ] || die "额外账号 HOME 不存在：$h（先 mkdir -p 再写进 snowluma.env）"
      EXTRA_MOUNTS+=(-v "$h:$h")
    done
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    docker run -d --name "$NAME" \
      --network host \
      --cap-add=SYS_PTRACE \
      --security-opt seccomp=unconfined \
      --shm-size=512m \
      --stop-timeout 20 \
      --restart no \
      --log-opt max-size=10m --log-opt max-file=2 \
      -v "$SL_DIR:$SL_DIR" \
      -v "$QQ_DIR:$QQ_DIR" \
      -v "$QQ_CFG:$QQ_CFG" \
      "${EXTRA_MOUNTS[@]}" \
      -v "$ENV_FILE:$ENV_FILE:ro" \
      "$IMAGE" >/dev/null
    echo "[run] 已启动容器 $NAME（镜像 $IMAGE）"
    if [ ${#EXTRA_MOUNTS[@]} -gt 0 ]; then
      echo "[run] 额外账号 HOME：$EXTRA_HOMES"
    fi
    sleep 8
    docker ps --filter "name=$NAME" --format '  {{.Names}}  {{.Status}}  {{.Image}}'
    ;;

  down)
    docker stop -t 20 "$NAME" >/dev/null 2>&1 || true
    docker rm -f "$NAME" >/dev/null 2>&1 || true
    echo "[run] 已停止并删除容器 $NAME"
    ;;

  status)
    docker ps -a --filter "name=$NAME" --format '容器: {{.Names}}  {{.Status}}  {{.Image}}' || true
    echo "--- 容器内进程 ---"
    docker exec "$NAME" ps -eo pid,etime,rss,args 2>/dev/null \
      | grep -E "Xvfb|x11vnc|/opt/QQ/qq|index\.mjs" | grep -v grep || echo "  （容器未运行）"
    echo "--- 端口 ---"
    (ss -ltnp 2>/dev/null || netstat -ltnp 2>/dev/null) | grep -E ":5099|:3001|:5900" || echo "  （5099/3001/5900 未监听）"
    ;;

  logs)
    docker logs -f --tail 50 "$NAME"
    ;;

  shot)
    # 无头机看 QQ 屏幕的唯一手段：截 Xvfb 的帧缓冲。
    # scrot/xdotool 已固化进镜像（见 Dockerfile），**不要**再 docker exec
    # apt-get install —— 那样装的东西只活在当前容器里，重建即失。
    #
    # 坐标表（Xvfb 固定 1280x800x24，见 entrypoint 的 -screen 0 1280x800x24）：
    #   全屏          : 0,0,1280,800
    #   登录二维码    : 540,310,202,208   ← 扫码窗口里的二维码矩形
    #   密码页「扫码登录」: 597,592          ← 只有真停在密码页时才需要点这里
    #   账号页「自动登录」勾选框: 613,497   ← 空心圆 → 蓝色实心勾
    #   账号页「登录」按钮      : 639,537   ← 约 15s 后上线，全程不用扫码
    # ❗ 先 `shot` 看画面再动手！容器重建后 QQ 通常停在**账号页**（头像+昵称+QQ号+
    #    「自动登录」+「登录」按钮），**不是扫码页**。此时 `qr` 点的 (639,448)
    #    什么也不是（表现为“刷码后 qq-qr.png 没变化”），误判成风控 168 会白耗很多轮。
    #    10-31 就踩过：看到日志 `awaiting login` 就当要扫码，其实点一下登录就好。
    # 二维码 2 分钟过期；过期后点二维码下方的刷新/重新加载，或用 xdotool 点：
    #   docker exec "$NAME" env DISPLAY=:99 xdotool mousemove <x> <y> click 1
    #   （点完 sleep 3~5 再 shot，Xvfb 没有 XDAMAGE，画面刷新有延迟）
    docker ps --filter "name=$NAME" --format '{{.Names}}' | grep -qx "$NAME" \
      || die "容器 $NAME 未运行，先 ./run.sh up"
    docker exec "$NAME" sh -c 'command -v scrot >/dev/null' 2>/dev/null \
      || die "容器内没有 scrot：镜像太旧，重新 docker build -t $IMAGE ops/snowluma/container/"
    docker exec "$NAME" env DISPLAY="${DISPLAY:-:99}" sh -c \
      "scrot -o $SL_DIR/logs/qq-screen.png && \
       scrot -a 540,310,202,208 -o $SL_DIR/logs/qq-qr.png"
    # 两处路径其实是同一个（/opt/snowluma 从宿主挂进容器），这里给宿主路径
    ls -l "$SL_DIR/logs/qq-screen.png" "$SL_DIR/logs/qq-qr.png" 2>/dev/null \
      | sed "s|^|  |"
    echo "[run] 宿主上直接看：$SL_DIR/logs/qq-qr.png（二维码一次性授权，用完即删）"
    ;;

  qr)
    # 刷新二维码并出图：二维码 2 分钟过期，过期后二维码矩形正中会出现「刷新」按钮。
    # 坐标 639,448 = 二维码矩形 (540,310,202,208) 的正中心，两种状态下点击都安全：
    #   - 已过期 → 命中「刷新」，换新码
    #   - 未过期 → 只是点在二维码图片上，QQ 不会做任何跳转（实测无害）
    docker ps --filter "name=$NAME" --format '{{.Names}}' | grep -qx "$NAME" \
      || die "容器 $NAME 未运行，先 ./run.sh up"
    docker exec "$NAME" sh -c 'command -v xdotool >/dev/null' 2>/dev/null \
      || die "容器内没有 xdotool：镜像太旧，重新 docker build -t $IMAGE ops/snowluma/container/"
    docker exec "$NAME" env DISPLAY="${DISPLAY:-:99}" sh -c \
      "xdotool mousemove 639 448 click 1 && sleep 4 && \
       scrot -o $SL_DIR/logs/qq-screen.png && \
       scrot -a 540,310,202,208 -o $SL_DIR/logs/qq-qr.png"
    echo "[run] 二维码已刷新：$SL_DIR/logs/qq-qr.png（约 2 分钟有效，过期再跑一次 $0 qr）"
    ;;

  vnc)
    # 打印 SSH 隧道命令（不改任何状态，纯提示）
    echo "本机执行：ssh -L 5900:127.0.0.1:5900 \${USER}@<服务器地址>"
    echo "然后在客户端连 VNC 到 localhost:5900（密码空）"
    ;;

  *)
    echo "用法：$0 {up|down|status|logs|shot|qr|vnc}" >&2
    exit 2
    ;;
esac
