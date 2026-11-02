# ============================================================
# QQ NT + SnowLuma 同容器镜像（glibc ≥ 2.34 的宿主替身）
# ============================================================
# 为什么需要这个镜像：
#   SnowLuma v2.2.1 的原生层（native/snowluma-linux-x64.node 与 .so）
#   要求 GLIBC_2.32/2.33/2.34 + GLIBCXX_3.4.29；本机 Ubuntu 20.04 只有
#   glibc 2.31 / GLIBCXX_3.4.28，注入与进程枚举在内核 ABI 上就过不去。
#   于是把 **QQ + SnowLuma 一起**放进 24.04 容器：被注入方（QQ）与注入方
#   （supervisor）用同一套 glibc，宿主 OS 完全不动。
#
# 刻意不装的东西：桌面环境、浏览器、编译工具链。QQ 只要 GTK3 那一套运行库。
#
# 构建：
#   docker build -t qqbot/snowluma:2.2.1 ops/snowluma/container/
# ============================================================
FROM ubuntu:24.04

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai \
    LANG=C.UTF-8

# 国内源：默认 archive.ubuntu.com 在本机网络下经常 0 字节，换阿里云。
# 必须用 http：ubuntu:24.04 基础镜像裁掉了 ca-certificates，https 会
# 直接报 "Certificate verification failed / No system certificates available"，
# 而 ca-certificates 本身又得靠 apt 装 —— 死循环。所以先用 http 装包，
# 装完 ca-certificates 后源里已是 http，不影响后续。
RUN if [ -f /etc/apt/sources.list.d/ubuntu.sources ]; then \
      sed -i 's|http://archive.ubuntu.com/ubuntu|http://mirrors.aliyun.com/ubuntu|g; \
              s|http://security.ubuntu.com/ubuntu|http://mirrors.aliyun.com/ubuntu|g; \
              s|https://mirrors.aliyun.com/ubuntu|http://mirrors.aliyun.com/ubuntu|g' \
              /etc/apt/sources.list.d/ubuntu.sources; \
    fi

# QQ NT (Electron) 运行库 + 无头 X + 排障工具
RUN apt-get update && apt-get install -y --no-install-recommends \
      libgtk-3-0t64 libnotify4 libnss3 libxss1 libxtst6 libasound2t64 \
      libgbm1 libxkbcommon0 libdrm2 libxcomposite1 libxdamage1 libxrandr2 \
      libatk1.0-0t64 libatk-bridge2.0-0t64 libatspi2.0-0t64 libcups2t64 \
      libpango-1.0-0 libcairo2 libxfixes3 libx11-xcb1 libxcb1 \
      fonts-wqy-microhei fontconfig \
      xvfb xauth x11vnc x11-utils procps psmisc iproute2 ca-certificates curl tzdata \
      scrot xdotool \
    && rm -rf /var/lib/apt/lists/*

# scrot / xdotool 为什么必须在镜像里：
#   无头机扫码登录的唯一手段是"截 Xvfb 里的二维码"，历史上这两包是用
#   docker exec apt-get install **临时装进运行中容器**的 —— 容器一重建就没了，
#   等于扫码能力随容器生命周期漂移。固化进镜像后 run.sh shot 在任何新容器里
#   都能一次截出二维码；xdotool 用来点"刷新二维码"（2 分钟过期）。

# 预建挂载点：代码层与状态层都来自宿主，镜像里只放空目录保证权限正确
# 关于 x11vnc：SnowLuma 是 hook 式，QQ 的登录二维码/密码框在 Xvfb 里，
# 而 release 包并不提供“把登录二维码推到 WebUI”的能力（WebUI 里的二维码
# 只用于 2FA）。无头机要想扫码，必须能看到这块屏 —— 所以镜像里带 x11vnc，
# 由 entrypoint 在 SNOWLUMA_VNC=1 时以 **-localhost** 启动，只听回环，
# 由用户自己走 SSH 隧道访问（不对外开端口）。
RUN mkdir -p /opt/snowluma /root/.config/QQ

COPY entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /opt/snowluma
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
