#!/usr/bin/env bash
# 把 SnowLuma 接口文档落到本地，供“加能力前先查有没有现成网关动作”用。
# 两条来源：
#   1) 本地克隆（默认优先）：/root/code/SnowLumaDocs 是文档站源码，catalog.json / openapi /
#      全部 mdx 正文都在里面 —— 离线、瞬间完成、几百 KB 的大文件不会像线上那样超时被 SKIP。
#   2) 线上站 https://snowluma.github.io：只有 llms.txt / llms-full.txt 是 Next.js route
#      运行时生成的，本地克隆里没有对应静态文件，要整站拼好的正文才得抓。
#      （llms-full.txt 本来就过滤掉了 openapi 页，不含动作详情，抓不到也不影响查接口。）
# 输出默认 /root/snowluma-docs/（仓库外，不把第三方文档 vendor 进 git；
#   仓库内只留生成的接口速查 docs/08-gateway-api.md，见 scripts/gen-gateway-api.js）。
# 用法：bash scripts/crawl-snowluma-docs.sh [输出目录]
#   GIT=1    先从文档站源码克隆 ff-only 拉一次（默认不动你的克隆）
#   ONLINE=1 强制走线上抓 catalog / openapi（本地克隆不在时用）
#   PAGES=1  顺手抓几个关键页面的 HTML（正文抽不出时人工看）
#   CURL_MAX=秒  单文件抓取上限（默认 240；线上慢，90 会把大文件掐在半路）
# 任一来源失败只记 SKIP 并保留上一次副本（排查时不至于发现场没资料）。
set -uo pipefail

OUT="${1:-/root/snowluma-docs}"
SRC="${SNOWLUMA_DOCS_SRC:-/root/code/SnowLumaDocs}"
BASE="${SNOWLUMA_DOCS_BASE:-https://snowluma.github.io}"
CURL_MAX="${CURL_MAX:-240}"
mkdir -p "$OUT"

fetch() { # $1=URL  $2=落盘文件名  $3=超时秒（可选）
  local url="$1" dst="$OUT/$2" tmp="$OUT/$2.part" max="${3:-$CURL_MAX}"
  local rc=0
  if [ -s "$tmp" ]; then
    curl -fsSL --retry 2 -m "$max" -C - -o "$tmp" "$url" || rc=$?   # 接着上次没下完的续传
  else
    curl -fsSL --retry 2 -m "$max" -o "$tmp" "$url" || rc=$?
  fi
  if [ "$rc" = "0" ] && [ -s "$tmp" ]; then
    mv "$tmp" "$dst"
    echo "OK   $(wc -c <"$dst" | tr -d ' ') 字节  $dst   <- $url"
  else
    echo "SKIP $url（拿不到，保留已有副本；半成品留在 $2.part，重跑可续传）"
  fi
}

copy_file() { # $1=克隆内相对路径  $2=落盘文件名
  local src="$SRC/$1" dst="$OUT/$2"
  [ -f "$src" ] || { echo "MISS 本地克隆没有 $1"; return 1; }
  cp "$src" "$dst.tmp" && mv "$dst.tmp" "$dst"
  echo "COPY $(wc -c <"$dst" | tr -d ' ') 字节  $dst   <- 克隆 $1"
}

if [ "${ONLINE:-0}" != "1" ] && [ -d "$SRC/.git" ]; then
  echo "== 来源：本地克隆 $SRC（$(git -C "$SRC" log -1 --format='%h %ad' --date=short 2>/dev/null)）"
  [ "${GIT:-0}" = "1" ] && { git -C "$SRC" pull --ff-only 2>&1 | tail -3; }
  # 接口目录：机器可读的动作清单（参数、默认值、返回说明），193 个动作都在里面
  copy_file public/api/catalog.json      catalog.json
  copy_file public/openapi/snowluma.json openapi-snowluma.json
  # 全部指南/配置/MCP 正文（mdx，中英双语，比线上 llms-full 还全）
  if [ -d "$SRC/content/docs" ]; then
    rm -rf "$OUT/docs-mdx.tmp" && cp -r "$SRC/content/docs" "$OUT/docs-mdx.tmp" \
      && rm -rf "$OUT/docs-mdx" && mv "$OUT/docs-mdx.tmp" "$OUT/docs-mdx" \
      && echo "COPY $(find "$OUT/docs-mdx" -name '*.mdx' | wc -l | tr -d ' ') 个 mdx  $OUT/docs-mdx/   <- 克隆 content/docs"
  fi
else
  echo "== 来源：线上 $BASE（本地克隆不可用）"
  fetch "$BASE/api/catalog.json"      catalog.json
  fetch "$BASE/openapi/snowluma.json" openapi-snowluma.json
fi

# 整站正文（fumadocs 专为 LLM 生成的单文件）
fetch "$BASE/llms.txt"      llms.txt      120
fetch "$BASE/llms-full.txt" llms-full.txt "$CURL_MAX"

if [ "${PAGES:-0}" = "1" ]; then
  for p in zh/docs/api zh/docs/guide/connect-bot zh/docs/guide/developer zh/docs/mcp/actions; do
    fetch "$BASE/$p" "page-$(echo "$p" | tr '/' '_').html"
  done
fi

echo
echo "本地目录：$OUT"
ls -la "$OUT"
echo
echo "查接口：grep -in 'get_group_msg_history' $OUT/docs-mdx/**/*.mdx ；或直接看仓库 docs/08-gateway-api.md"
