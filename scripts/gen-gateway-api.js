'use strict';

// 从 SnowLuma 文档站的接口目录生成本仓库 docs/08-gateway-api.md 的「全部动作速查」区块。
//   目录来源（按顺序取第一个存在的）：
//     1) /root/snowluma-docs/catalog.json          —— scripts/crawl-snowluma-docs.sh 抓的线上副本
//     2) /root/code/SnowLumaDocs/public/api/catalog.json —— 本地克隆的文档站源码
//   只重写 AUTO-BEGIN / AUTO-END 标记之间的内容，标记之外手写的内容（已接入接口、实测注意）不受影响。
// 用法：node scripts/gen-gateway-api.js [catalog.json 路径]

const fs = require('fs');
const path = require('path');

const SOURCES = [
  '/root/snowluma-docs/catalog.json',
  '/root/code/SnowLumaDocs/public/api/catalog.json',
];
const OUT = path.join(__dirname, '..', 'docs', '08-gateway-api.md');
const BEGIN = '<!-- AUTO-BEGIN：以下由 scripts/gen-gateway-api.js 生成，别手改 -->';
const END = '<!-- AUTO-END -->';
// 我们已经真正在用的动作（表里打 ✅，并提示去看文档上方的手写小节）
const USED = new Set(['get_msg', 'get_group_msg_history', 'get_forward_msg']);

const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
};
const paramCell = (p) => {
  const flag = p.required ? '' : (p.default !== undefined && p.default !== null ? `=${p.default}` : '?');
  return `${p.name}${flag}`;
};

const src = process.argv[2] || SOURCES.find((s) => fs.existsSync(s));
if (!src) {
  console.error('找不到接口目录，先跑：bash scripts/crawl-snowluma-docs.sh');
  process.exit(1);
}
const catalog = JSON.parse(fs.readFileSync(src, 'utf8'));
const actions = Array.isArray(catalog.actions) ? catalog.actions : [];
const byCat = new Map();
for (const a of actions) {
  const cat = a.category || '未分类';
  if (!byCat.has(cat)) byCat.set(cat, []);
  byCat.get(cat).push(a);
}

const lines = [];
lines.push(BEGIN);
lines.push('');
lines.push(`## 全部动作速查（共 ${actions.length} 个，来源 ${src}）`);
lines.push('');
lines.push('带 ✅ 的是本项目已接入的（用法/参数口径见上面手写小节）。参数列里 `?` 表示可省、`=值` 表示文档给的默认值。');
lines.push('');
for (const cat of [...byCat.keys()].sort()) {
  lines.push(`### ${cat}（${byCat.get(cat).length}）`);
  lines.push('');
  lines.push('| 动作 | 说明 | 参数 | 返回 |');
  lines.push('|---|---|---|---|');
  for (const a of byCat.get(cat).slice().sort((x, y) => String(x.name).localeCompare(String(y.name)))) {
    const params = (a.params || []).map(paramCell).join(', ') || '—';
    lines.push(`| ${USED.has(a.name) ? '✅ ' : ''}\`${a.name}\` | ${clip(a.summary, 60) || '—'} | ${clip(params, 90)} | ${clip(a.returns, 70) || '—'} |`);
  }
  lines.push('');
}
lines.push(END);

const block = lines.join('\n');
if (!fs.existsSync(OUT)) {
  const head = '# 网关接口速查（OneBot11 / SnowLuma）\n\n'
    + '（这一节是手写区：记已接入接口的参数口径与实测注意。下面标记之间的速查表由脚本生成。）\n\n';
  fs.writeFileSync(OUT, `${head}\n${block}\n`, 'utf8');
  console.log(`已新建 ${OUT}`);
} else {
  const cur = fs.readFileSync(OUT, 'utf8');
  const i = cur.indexOf(BEGIN);
  const j = cur.indexOf(END);
  if (i < 0 || j < 0 || j < i) {
    console.error(`${OUT} 里找不到 AUTO-BEGIN/AUTO-END 标记，不做半截替换（避免抹掉手写内容）`);
    process.exit(1);
  }
  fs.writeFileSync(OUT, cur.slice(0, i) + block + cur.slice(j + END.length), 'utf8');
  console.log(`已更新 ${OUT} 的速查区块`);
}
console.log(`目录 ${src}：${actions.length} 个动作 / ${byCat.size} 个分类`);
