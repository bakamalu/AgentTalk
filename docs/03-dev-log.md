# ds-roobot 开发改造记录

> 依据：https://github.com/rentaoyan0628-collab/dsh-qq-bot-playbook
> 路径：README.md + AI-INSTALL-AND-TROUBLESHOOT.md
> 记录时间：2026-10-29
> 原则：保留已可用部分、改前备份、不公开密钥、不默认全放行、不默认开机自启

---

## 一、环境事实（只读核查结果）

| 项 | 实际值 |
|---|---|
| 系统 | Ubuntu 20.04.6 LTS / x86_64（无头 Linux 服务器） |
| Node | v22.11.0（playbook 要求 ≥ 22.13，未升级） |
| Node 全局包 | koishi@4.18.11、npm@10.9.0、corepack |
| 网关层 | NapCat（`/opt/napcat`）+ QQ（`/opt/QQ`），OneBot11 WS 监听 `3001` |
| WebUI | `http://127.0.0.1:6099/webui?token=***`（token 见本机 webui.json） |
| 框架层 | Koishi 4.18.11，监听 `5140` |
| 进程守护 | `qqbot-watchdog.service`（`/opt/bot-watchdog.sh`），当前 `active` / `disabled` |
| DeepSeek Harness | **未安装**（npm 上 `@deepseek/harness` 不存在，`deepseek-harness` 仅 0.0.1 占位包） |

### 与 playbook 的三层对照

| playbook 层 | 建议组件 | 本机实际 | 说明 |
|---|---|---|---|
| 第 1 层 网关 | SnowLuma | **NapCat 替代** | SnowLuma 的 QQ 注入只支持 Windows，本机为 Linux 无头，无法照搬 |
| 第 2 层 桥接 | qq-bridge → DSH | **自研 `deepseek.js` 插件** | DSH 无法在 Linux 安装，qq-bridge 失去目标；用 Koishi 插件直连模型 API |
| 第 3 层 扩展 | 记忆/心情/刷视频等 | **未安装** | 按 playbook「装之前先问主人」规则，需逐项授权 |

---

## 二、改动清单

### 1. 备份（改动前）

```
/opt/koishi/koishi.config.js.bak-20261029-172833
/opt/koishi/plugins/deepseek.js.bak-20261029-172833
/opt/koishi/plugins/deepseek.js.bak-groupsend-183634
/etc/profile.bak-20261029-172902
```

### 2. `/opt/koishi/plugins/deepseek.js`（主要改动）

| 改动点 | 内容 | 对应 playbook 要求 |
|---|---|---|
| 白名单 | 新增 `allowedUsers` / `allowedGroups`，支持数组或逗号分隔字符串，统一转 `Set` 做字符串比较；**空（或不配置）= 不设白名单，有值 = 仅名单内**，群聊与私聊同理 | 「名单语义按 owner 要求：空即放行」 |
| 私聊策略 | `privatePolicy = 'whitelist'`：`allowedUsers` 为空 → 全部放行；有值 → 非名单 QQ 私聊直接忽略（不回复、不调用模型） | 同上 |
| 群聊策略 | `allowedGroups` 为空 → 所有群生效；有值 → 群不在名单内直接忽略；`mentionOnly: true` 时仍需被 @ 才回 | 「群聊暂不设白名单（BOT_ALLOWED_GROUPS 为空）」 |
| 多轮上下文 | 新增 `histories = new Map()`，key = `platform:guildId:channelId:userId`；`maxTurns`（默认 8）控制保留轮数，超出滚动丢弃 | 「先验证普通文字连续对话」 |
| 系统提示 | 新增 `DEFAULT_SYSTEM_PROMPT`，可通过 `systemPrompt` 覆盖 | 「人格」层面可调 |
| 自消息过滤 | 新增 `session.subtype === 'self'` / `isSelf` 过滤，避免自己回自己 | 防重复回复 |
| 发送路由 | 新增 `sendReply()`：**群聊强制 `bot.internal.sendGroupMsg(channelId)`，私聊 `bot.internal.sendPrivateMsg(userId)`**，失败才回退 `session.send()` | 修复群聊 retcode 1200 |
| 失败日志 | 发送失败打印 `guildId / channelId / userId`，不再二次抛错 | 「用日志定位，不宣称成功」 |

注意：上下文为**进程内内存**，重启即清空，不写磁盘、不构建长期记忆。

### 3. `/opt/koishi/koishi.config.js`

```js
http: {},                       // 必须，否则 adapter 缺 ctx.http 启动失败
server: { port: 5140, host: '0.0.0.0' },
'adapter-onebot': {
  protocol: 'ws',               // Koishi 主动连 NapCat 的 3001（不是 ws-reverse）
  endpoint: 'ws://127.0.0.1:3001',
  selfId: '<BOT_UIN>',
  token: '',
},
'./plugins/deepseek': {
  privatePolicy: 'whitelist',
  allowedUsers: process.env.BOT_ALLOWED_USERS || '',
  allowedGroups: process.env.BOT_ALLOWED_GROUPS || '',
  maxTurns: 8,
},
```

### 4. `/etc/profile`（白名单持久化，不含密钥）

```bash
# QQ bot 白名单（空 = 不设白名单，全部放行；有值 = 仅名单内）
export BOT_ALLOWED_USERS="<ADMIN_UIN>"
export BOT_ALLOWED_GROUPS=""
```

### 5. 服务

| 项 | 改动 |
|---|---|
| `qqbot-watchdog.service` | 执行 `systemctl disable` → 状态 `disabled`；**不再开机自启**，当前仍 `active` 运行 |
| 重启方式 | `systemctl restart qqbot-watchdog`（会自动拉起 QQ + Koishi） |

---

## 三、历史修复（playbook 之前，仍在生效）

| 故障 | 根因 | 修复 |
|---|---|---|
| adapter 启动报 `Cannot read properties of undefined (reading 'extend')` | 配置丢失 `http` / `server` 插件 | 显式加载两者 |
| Session 报 `counter` / `internal` undefined | `plugin-adapter-onebot@5.8.1` 依赖 satori 2.x，与 Koishi 4.18 的 satori 4.x 冲突，出现两份 `@satorijs/core` | 升到 `adapter-onebot@6.0.2` + `@satorijs/satori@3`，npm `overrides` 锁定 `@satorijs/core@4.6.1` |
| 终端关闭后掉线 | 前台启动 | `nohup` + `bot-watchdog.sh` 循环守护 |

---

## 四、验证证据

### 已通过

1. **接入层**：`adapter connect to server: ws://127.0.0.1:3001/`，启动无报错
2. **模型接口**：`POST {DEEPSEEK_BASE_URL}/chat/completions` 返回 `HTTP=200`
3. **白名单 + 多轮（插件级，真实 API）**：
   ```
   第1轮 → BOT: 收到
   第2轮 追问“我叫什么名字” → BOT: 小明
   第3轮 非白名单用户 999999999 → 无回复
   EXIT=0
   ```
4. **私聊真实 QQ 连续对话**（日志轮次递增，证明上下文生效）：
   ```
   17:30:48 历史轮次=1
   17:31:11 历史轮次=2 ... 17:36:56 历史轮次=8
   ```

### 已定位并修复、待复测

- **群聊发送失败**：`send_private_msg user_id=0, retcode 1200`（17:32:39）
  - 根因：群消息回复被 adapter 误判为私聊
  - 修复：`sendReply()` 群聊显式走 `send_group_msg`
  - 状态：代码已加载重启，**群聊尚未复测**

---

## 五、未完成 / 阻塞

| 项 | 原因 | 后续动作 |
|---|---|---|
| DSH（DeepSeek Harness）本体 | Linux 无头 + npm 无正式发行包 | 如需，换 Windows 机器或等官方 Linux 包 |
| SnowLuma | 注入仅 Windows | 不做 |
| qq-bridge | 依赖 DSH | 不做 |
| 群聊端到端复测 | 需群内 @ 触发 | 待测试 |
| Node ≥ 22.13 | 系统级升级 | 需你同意 |
| 扩展插件（记忆/心情/刷视频等） | playbook 要求先说明再装 | 逐项报备后决定 |

---

## 六、回滚方法

```bash
# 回到 playbook 改造前
cp /opt/koishi/koishi.config.js.bak-20261029-172833 /opt/koishi/koishi.config.js
cp /opt/koishi/plugins/deepseek.js.bak-20261029-172833 /opt/koishi/plugins/deepseek.js
cp /etc/profile.bak-20261029-172902 /etc/profile
systemctl restart qqbot-watchdog

# 只回滚“群聊发送修复”
cp /opt/koishi/plugins/deepseek.js.bak-groupsend-183634 /opt/koishi/plugins/deepseek.js
```

---

## 七、常用运维命令

```bash
systemctl status qqbot-watchdog      # 守护状态
systemctl restart qqbot-watchdog     # 重启整条链路
tail -f /opt/logs/koishi.log         # 框架层日志
tail -f /opt/logs/napcat.log         # 网关层日志
ss -lntup | grep -E ':3001|:5140|:6099'
```

> 安全约定：密钥仅存于 `/etc/profile` 环境变量，文档与日志中一律脱敏；不打印完整 API Key。

---

## 八、按 playbook 优化（运营层 + 频率闸）

### 前提澄清

仓库里**没有 `deepseek.js`**：

- `dsh-qq-bot-playbook` 只有 `*.md` 文档与 `skills/*/SKILL.md`
- `qq-bridge` 是 DSH 桥接（`src/bridge.js`），也不是 `deepseek.js`

所以本节不是"照搬文件"，而是把 `playbook/08-operations-layer.md`、`playbook/10-models-and-media.md`
里的设计规则**在本地插件里实现**。

### 改动清单（改前已备份）

| # | 改动 | 出处 | 行为 |
|---|---|---|---|
| 1 | 群聊 @ 硬锁 `mentionOnly: true` | 08 第一节「只在被 @ 时醒」 | 群里没 @ 就不回，关键词也不再触发；每次唤醒写日志 `[运营] 群 xxx 被 @ 唤醒` |
| 2 | 发送限流 `ratePerMinute`（默认 6） | 10 第四节「三个闸」 | 同一会话每分钟超限直接丢弃，日志 `[频率闸] ... 已达每分钟上限` |
| 3 | 最小间隔 `minIntervalMs`（默认 1500ms） | 10 第四节 | 连发过快丢弃，日志 `[频率闸] ... 距上条仅 xms` |
| 4 | 长回复分段 `splitLimit` / `splitMaxParts` | 10 坑 5「限流调太狠长回复被截」 | 按 500 字切分、最多 3 段，日志 `[分段] 回复较长，拆成 N 条发送` |
| 5 | Markdown 转纯文本 `toPlainText()` | 10 媒体边界 | QQ 不渲染 md，发送前去掉 `**`、`` ` ``、`#`、图片语法 |
| 6 | 请求超时 `requestTimeoutMs`（默认 60s）+ 超时不重发 | 10 第二节「超时≠失败」 | 超时归类为「投递未知」，记日志后结束，不刷屏 |
| 7 | 同会话串行队列 `enqueue()` | 08「上下文交错」 | 同一会话的多条消息按顺序处理，不并发抢上下文 |

> 刻意**没有做**的：记忆落盘、峰价时段睡眠、主动唤醒、模型分流。前两项需要额外存储与配置，
> 后两项与"只在被 @"冲突，按 playbook 要求应先与你确认再开。

### 配置文件对应项

```js
'./plugins/deepseek': {
  groupPolicy: 'at',
  mentionOnly: true,        // 群聊只被 @ 才回
  privatePolicy: 'whitelist',
  // 白名单：空 = 不设白名单（放行）；有值 = 仅名单内。群聊、私聊同理
  allowedUsers: process.env.BOT_ALLOWED_USERS || '',
  allowedGroups: process.env.BOT_ALLOWED_GROUPS || '',
  maxTurns: 8,
  ratePerMinute: 6,
  minIntervalMs: 1500,
  splitLimit: 500,
  splitMaxParts: 3,
  requestTimeoutMs: 60000,
},
```

### 验收结果（真实 DeepSeek API，8/8 通过）

```
PASS  群聊未@ 不回复            sent=0
PASS  群聊@ 长回复被分段        parts=4
PASS  群聊回复走 send_group_msg ["group","group","group","group"]
PASS  每段不超过 100 字         [100,100,100,20]
PASS  白名单私聊有回复
PASS  非白名单私聊被拦截
PASS  超频消息被丢弃            r1=1 r2=0
PASS  间隔不足被丢弃            i1=1 i2=0
===== 汇总：8/8 通过 =====
```

启动日志无报错：`adapter connect to server: ws://127.0.0.1:3001/`

### 回滚

```bash
# 只回滚本次优化（保留群聊发送修复）
cp /opt/koishi/plugins/deepseek.js.bak-pre-optimize-184700 /opt/koishi/plugins/deepseek.js
systemctl restart qqbot-watchdog
```

### 仍未验证

- 群聊**真实 QQ** 端到端（需要群里 @ 一次，插件级已通过但真流量未测）
- `toPlainText` 在真实长 Markdown 回复上的效果（目前只有单元级验证）

---

## 九、配置迁移到 /root/deploy（2026-10-29 18:53）

### 为什么迁

`/etc/profile` 原权限 `644`（任何本地用户可读），里面有明文 `DEEPSEEK_API_KEY`。
按最小暴露原则，把整份配置搬到 `/root/deploy`（位于 `/root` 下，`/root` 本身是 `700`）。

### 现在的文件布局

| 路径 | 权限 | 作用 |
|---|---|---|
| `/etc/profile` | 644 | **转发桩**，只 `. /root/deploy/profile` |
| `/root/deploy/profile` | 600 | 原 `/etc/profile` 全文（系统默认 + 引导 bot.env） |
| `/root/deploy/bot.env` | 600 | 密钥与白名单（`DEEPSEEK_*`、`OPENAI_API_KEY`、`BOT_ALLOWED_*`） |

加载链：`登录 shell → /etc/profile → /root/deploy/profile → /root/deploy/bot.env`

`/etc/profile` 现内容：

```bash
# /etc/profile
# 实际配置已迁移到 /root/deploy/profile（仅 root 可读，便于集中管理）
# 回滚：cp /etc/profile.bak-full-<时间戳> /etc/profile
if [ -r /root/deploy/profile ]; then
  . /root/deploy/profile
fi
```

### 验证

- `/root/deploy/profile` 与迁移前备份 `diff` 结果：**完全一致**
- 新登录 shell：`BOT_ALLOWED_USERS / BOT_ALLOWED_GROUPS / MODEL / BASE` 均能读到，`KEY_LEN=36`（只打印长度，不打印密钥）
- 新 Koishi 进程（pid 230225）环境变量已带新名单：`BOT_ALLOWED_USERS=<ADMIN_UIN>,<USER2_UIN>`
- 启动日志：`adapter connect to server: ws://127.0.0.1:3001/`

### 副作用（重要）

`/root/deploy/profile` 是 `600`，**非 root 用户登录 shell 读不到**，会丢掉 `/etc/profile` 里的
`PS1` 与 `/etc/profile.d/*.sh` 逻辑。当前机器只有 root 在用，故可接受；
若以后加普通用户，应把非敏感部分放回 `/etc/profile.d/`（644）。

### 运维坑：重启服务不等于用新配置（2026-10-29 19:11 实测）

两层叠加导致 `bot.env` 改完后 `systemctl restart` 不生效：

1. 环境变量只在**进程启动时**通过 `/etc/profile → /root/deploy/profile → /root/deploy/bot.env` 加载一次，守护进程内存里缓存的是旧值
2. 服务配置了 `KillMode=process`，restart 只杀当前 systemd 主进程，**上一代旧守护/Koishi 孤儿进程不会被杀**，孤儿带着旧环境继续拉起 Koishi

实测例证：19:00 已改 `BOT_ALLOWED_GROUPS=""`，但 19:08 拉起的 Koishi 仍是 `<OLD_UIN>`（由 18:54 的旧守护 230199 拉起）。

改配置后的正确重启步骤：

```bash
systemctl daemon-reload                 # unit 文件有变更时
systemctl stop qqbot-watchdog
# 自动干掉残留孤儿，无需肉眼找 PID；k[o]ishi 写法不会匹配命令自身（避免误杀自身 shell）
pkill -f "b[o]t-watchdog\.sh"; pkill -f "k[o]ishi start"; pkill -f "k[o]ishi/lib/worker"
sleep 2
systemctl start qqbot-watchdog          # 等 20~30s 守护循环自动拉起 Koishi
```

验证（不能只看进程/端口存在）：

```bash
tr '\0' '\n' < /proc/<koishi_pid>/environ | grep BOT_ALLOWED   # 应为新值
grep 白名单 /opt/logs/koishi.log | tail -1                      # 应为实际生效策略
```

19:11 重启后最终生效：`[白名单] 私聊 仅 <ADMIN_UIN>,<USER2_UIN>；群聊 不限制(所有群，需 @)`

### 回滚

```bash
# 回滚 /etc/profile（含密钥版本）
cp /etc/profile.bak-full-<时间戳> /etc/profile

# 回滚只拆分 bot.env 的那一步
cp /etc/profile.bak-20261029-185329 /etc/profile
```

---

## 十、QQ 内管理员与特权指令（2026-10-29 19:20）

### 需求

给特定 QQ 号设置「机器人管理员」，可用特权指令；与 Koishi Web 控制台登录（auth 插件）无关，走环境变量。

### 改动（改前已备份）

| 文件 | 内容 |
|---|---|
| `/opt/koishi/plugins/deepseek.js`（备份 `.bak-admin-191908`） | 新增 `adminUsers = toIdSet(BOT_ADMIN_USERS)`，空 = 无管理员；`handleAdminCommand()` 在白名单判断**之前**执行，指令不走频率闸、不进模型队列 |
| `/opt/koishi/koishi.config.js`（备份 `.bak-admin-*`） | 新增 `adminUsers: process.env.BOT_ADMIN_USERS \|\| ''` |
| `/root/deploy/bot.env`（备份 `.bak-admin`） | 新增 `export BOT_ADMIN_USERS="<ADMIN_UIN>"` |

### 指令表（默认仅私聊生效；开启 BOT_ADMIN_GROUP 后群里 @机器人 也能用）

| 指令 | 作用 |
|---|---|
| `#状态` / `/status` | 模型、活跃会话/累计轮次、白名单策略、频率闸参数 |
| `#重置对话` / `/reset` | 清空当前会话多轮上下文（频率计数保留） |

### 群聊特权开关（2026-10-29 19:26 追加）

管理员指令默认**只在私聊生效**；`BOT_ADMIN_GROUP=1`（或 true/yes/on）时群里也可用，群里需 @机器人（去掉 @ 后匹配指令）。实现在 `handleAdminCommand()` 开头：`session.guildId` 存在且开关未开 → 直接返回 false，落入普通聊天流程。

涉及文件（改前已备份 .bak-admingroup*）：deepseek.js、koishi.config.js（adminGroup: process.env.BOT_ADMIN_GROUP || ''）、bot.env（export BOT_ADMIN_GROUP="" 默认关）。

冒烟测试 5/5 PASS：开关关-群里无响应；开关开-群里出状态/重置；开关关-私聊正常；群里非管理员无响应。线上日志：`[管理员] 仅 <ADMIN_UIN>；生效范围 仅私聊`

### 验证

- 冒烟测试（假 API key，不碰线上）：管理员 `#状态`/`#重置对话` 有回复；非管理员 999999999 发 `#状态` 无回复
- 按第九节流程重启后，新进程（19:20:47）环境含 `BOT_ADMIN_USERS=<ADMIN_UIN>`，日志：`[管理员] 仅 <ADMIN_UIN>`

### 回滚

```bash
cp /opt/koishi/plugins/deepseek.js.bak-admin-191908 /opt/koishi/plugins/deepseek.js
cp /opt/koishi/koishi.config.js.bak-admin-<时间戳> /opt/koishi/koishi.config.js
# 再按第九节流程重启
```

### 备份清单

```
/etc/profile.bak-20261029-172902      # 最初（含全部密钥）
/etc/profile.bak-20261029-185329      # 拆分 bot.env 之前
/etc/profile.bak-full-20261029-1853xx # 整份迁移前
```

---

## 十一、配置变量统一走环境变量（2026-10-29 19:42）

### koishi.yml 处置

/opt/koishi/koishi.yml 是废弃旧配置（内含明文 apiKey、指向已停用的 chatgpt 插件）。
启动命令 `koishi start koishi.config.js` 明确只读 js 配置，**yml 从不被加载**，但 644 明文密钥有泄露面，已移走：

- /root/deploy/koishi.yml.disabled-193906（原文件）
- /root/deploy/koishi.yml.bak-envfix-193906（备份）

### koishi.config.js 现状

全部参数只从 `process.env` 取（不做直接读 bot.env 文件的兜底，环境变量由守护脚本经 profile 链注入）：

- 新增可调项：`KOISHI_PORT`、`NAPCAT_WS_ENDPOINT`、`NAPCAT_SELF_ID`（bot.env 已补默认值）
- bot.env 格式约定：每行 `export KEY="value"`，值必须双引号包裹、行内注释会被当作值的一部分

### 验证

19:42:55 重启后日志：`[白名单] 私聊 仅 <ADMIN_UIN>,<USER2_UIN>；群聊 不限制(所有群，需 @)`、`[管理员] 仅 <ADMIN_UIN>；生效范围 仅私聊`、`adapter connect to server: ws://127.0.0.1:3001/`

### 自称/人格提示词（2026-10-29 19:51 追加）

插件 `systemPrompt` 取值优先级：`config.systemPrompt` > `BOT_SYSTEM_PROMPT` 环境变量 > `DEFAULT_SYSTEM_PROMPT`。
改自称/人格只需编辑 bot.env 的 `BOT_SYSTEM_PROMPT`（值必须双引号包裹）并按第九节重启，无需动代码。
当前示例自称「小D」。验证方式：冒烟拦截 fetch 查看发给模型的 system 内容；线上日志 DeepSeek 回复正常。
涉及文件备份后缀 `.bak-prompt-*`。

## 十二、对标 qq-bridge 的功能补齐（2026-10-29 20:08）

依据 https://github.com/Derpyu520/qq-bridge 功能图谱对比，补齐 6 项（备份后缀 `.bak-features-200255`、`.bak-features-*`）：

1. **黑名单**：`BOT_BLACKLIST_USERS/GROUPS`，在 shouldReply 与 handleAdminCommand 双入口一票否决（管理员不能豁免）。
2. **敏感词**：`BOT_SENSITIVE_WORDS`；输入命中回固定话术不进模型；输出命中拦截不发送且不记历史（防污染上下文）。
3. **用量统计**：callDeepSeek 改为返回 `{text, usage}`；按日/按会话累计 token，按 `BOT_PRICE_INPUT_PER_M/OUTPUT`(元/百万 token) 折价，落盘 usage.json；`#状态` 增加用量行。
4. **历史持久化**：histories 启动时从 `<stateDir>/histories.json` 恢复（Map(Object.entries)），写入 400ms 防抖；stateDir 由 `BOT_STATE_DIR` 控制，默认 /opt/koishi/state/deepseek。
5. **消息撤回**：监听 `message-recall`，按 messageId 在全部会话历史中定位剔除（历史条目带 msgId）。
6. **引用回复**：`BOT_QUOTE_REPLY=1` 时群聊首条回复带 `message_id`（默认关，待 NapCat 实测）。

**端口安全**：`@koishijs/plugin-server` 是 package.json 依赖、被 console 需要，从配置删除仍会被 loader 自动装载并绑 0.0.0.0；
正确做法是显式配置 `server: { host: '127.0.0.1' }`。验证：`ss -tlnp | grep 5140` 应为 127.0.0.1。

**冒烟**：10/10 PASS（黑名单压管理员/敏感词双向拦截/usage/撤回剔除/持久化往返）。注意测试脚本必须先清空继承自 bot.env 的 BOT_* 变量，否则真实白名单干扰断言。

**开发中发现的 bug**：`toWordList` 初版漏 `.split(',')` 导致整串被当一个词；已修复。

## 十三、热生效配置 + 上下文/通知/内容过滤增强（2026-10-29 20:33）

备份后缀 `.bak-hash-*`。核心是**改 bot.env 秒级生效、无需重启**。

1. **热生效配置（hot-config）**：插件内维护 `hot` 对象，用 `parseBotEnv()` 正则解析 bot.env（只认 `export KEY="value"`，值必须双引号）；`applyHotConfig()` 按优先级 `bot.env 文件值 > 插件 config > process.env > 默认` 重算全部名单/开关/敏感词/人格。两条重载通道：消息入口 `maybeReloadHot()` + `setInterval` 定时巡检（`BOT_HOT_INTERVAL_MS`，默认 5000，最小 2000）。改动检测用**文件内容 hash**（`hashText`：`h=(h*31+charCodeAt)|0`）而非 mtime——内容相同不误触发、内容变化必定检出（旧 mtime 方案在同一秒连续写入会漏检）。重载成功打日志 `[热配置] 已重新加载 <file>`。读取失败沿用上一份并 warn，不炸。`botEnvFile` 由 `BOT_ENV_FILE` 指定，默认 /root/deploy/bot.env。
2. **群聊发言人上下文**：历史条目存 `senderId`，喂模型时 user 消息加 `[QQ号 xxx]` 前缀，让模型区分群内不同说话人。
3. **内容类型过滤**：`normalizeText` 把 CQ 码占位化——`[CQ:image]`→`[图片]`、`[CQ:record]`→`[语音]`、`[CQ:video]`→`[视频]`、`[CQ:face]`→`[表情]`、`[CQ:at]`→空格（保留 @ 供唤醒判断），并去 HTML 标签/多余空白。
4. **拦截通知开关**：`BOT_SENSITIVE_NOTIFY=1` 时命中敏感词在当前会话发提示「这个话题我不太方便聊…」；空=仅记日志（`censorNotify`）。
5. **历史持久化深拷贝**：加载时 `.slice(-32)` 深拷贝，避免恢复对象与运行时引用互相污染。

**实盘验证**：重启后日志齐全（白名单/管理员/黑名单/敏感词/状态策略行 + server 绑 127.0.0.1:5140 + adapter 连 ws://127.0.0.1:3001 + 历史恢复 4 会话）；对 bot.env 追加/删除一行标记，均在 ~5s 巡检周期内打出 `[热配置] 已重新加载`，热生效链路打通。hash 逻辑单测全绿（内容相同不误触发 / 内容变化必检出）。

## 十四、读取被引用消息内容（2026-10-29 20:44）

备份后缀 `.bak-quote-*`。此前机器人只能看到用户**本轮自己敲的正文**，当用户用 QQ 的「回复/引用」某条消息时，被引用的原文开不进来（因为只取了 `session.content`）。

**实现**：`@satorijs/adapter-onebot`（lib/index.js L310）在首元素为 `reply` 时会 `bot.getMessage(...)` 异步拉取原文并挂到 `session.quote`（含 `.content/.userId/.username`）。插件消息入口新增：
- 取 `quoteText = normalizeText(session.quote.content)`、`quoteWho = quote.username || 'QQ'+userId`；
- 拼进本轮 user 输入：`[引用 <who>的消息] <quoteText>` + 若有正文再附 `\n[我的回应] <body>`；无引用时维持原行为；
- 放宽入口门槛：正文为空但带引用也算有效输入（`if (!rawText && !quoteText) return;`）；群聊仍需 @ 机器人才能唤醒（QQ 单纯“回复”不会自动 @）。

**区分**：本项是“读入”被引用内容（输入侧）；与 `BOT_QUOTE_REPLY`（机器人回复时带 `message_id` 引用原消息，输出侧）是两个不同的东西。敏感词只扫当前用户实际输入 `rawText`，不因引用旧内容误拦。

**图片识别（本次未做）**：当前端点 `https://api.deepseek.com`（`deepseek-flash`）为纯文本模型，结构上无法看图。要识别图片需额外接支持 `image_url` 的多模态端点（如火山方舟豆包 ARK 或 OpenAI 兼容视觉模型）；实现思路：从 `session.elements` 取 `type==='image'` 的 `attrs.url`，服务端下载转 base64 data URL 后嗂给视觉模型（内网地址可达），仅在消息含图时走视觉、纯文本仍走 DeepSeek。待用户提供视觉端点 base_url/model/api_key 后再接。

**实盘验证**：20:44:35 重启无报错，策略日志齐全、历史恢复 4 会话、累计调用升至 13 次（真实流量正常）。

## 十五、@前后上下文（未响应消息回收 + 被@后免@活跃窗口）（2026-10-29 21:32）

备份后缀 `.bak-ctx-*`。背景：旧逻辑群聊只处理“被 @ 那一句”，**未被 @ 的消息直接 `return`，既不响应也不进任何上下文**（多轮 history 只存被响应过的），导致用户拆成多条说完再 @、或 @ 后追问时机器人断章取义。

**机制**（均入热配置层）：
- 新增 `hot` 三项（`applyHotConfig` 里用 `numOr(key,默认)` 解析，`''`→默认、`0`→关闭）：`hot.groupContextMs`(默认120000)、`hot.groupContextMax`(默认6，上限 20)、`hot.activeWindowMs`(默认120000)。对应 `BOT_GROUP_CONTEXT_MS`/`BOT_GROUP_CONTEXT_MAX`/`BOT_ACTIVE_WINDOW_MS`。
- **key 统一**：`channelKeyOf`(不含 userId，用于全群缓冲) 与 `chatKeyOf`(含 userId，活跃窗口/串行) 两个 helper 统一定义，旧的手拼 chatKey已改为 `chatKeyOf(session)`（格式不变，不影响已持久化历史）。
- **@前缓冲**：`groupBuffer: Map(channelKey -> [{senderId,text,ts}])`；未唤醒(wake=false)的群消息 `pushGroupBuffer` 暂存（按时间窗+条数自动裁剪）；被 @ 时先 `takeGroupContext` 取快照（不含当前）、拼成 `[群内近期消息…]- [QQ x] text` 背景，仅喂模型不写 history，用完 `groupBuffer.delete(channelKey)`。
- **@后活跃窗口**：`activeUntil: Map(chatKey -> 截止ms)`；唤醒即 `activeUntil.set(chatKey, now+activeWindowMs)`。
- **唤醒判定**：`shouldReply` 群聊分支改为 `at || hasTriggerKeyword || isQuotingBot || withinActiveWindow`（`isQuotingBot`=引用了机器人的消息 userId===selfId；`withinActiveWindow`=该 chatKey 在活跃窗口内）。`activeWindowMs=0` 时等价旧的“仅 @”硬锁（原 `mentionOnly`/`groupPolicy` 分支已合并至此，变量保留未用）。
- 启动新增策略行：`[上下文] @前群聊上下文 最近 N 条/Ts；@后免@活跃窗口 Xs`。

**重要约束（本环境新发现的坑）**：写入 bot.env 的新热配置行 **不能带行内注释**（如 `export K="v" # 注释`），因为 `parseBotEnv` 正则要求 `"value"` 后立即行尾；有行内注释时该行不会被文件热解析（只能靠启动时的 process.env 兼底，后续改值不重启则热重载读不到）。已改为“注释单独成行 + 裸值行 `export K="v"`”。

**并发编辑提醒**：本次重启时发现 `deepseek.js` 被**另一个会话/编辑方并发修改**（加入了图片识别代码 `collectImages`/`downloadImageAsDataUrl`/`buildUserContent`，与 `BOT_IMAGE_MAX`/`BOT_IMAGE_TIMEOUT_MS`）。两次启动间文件内容不一致导致 21:29:23 那次启动撞上“半成品”报 `await is only valid in async functions`（当时文件正在写），21:32:50 重载完整合并版后正常。多个会话并行改同一文件风险极大：改前应 `stat` 看 mtime、改后多次 `node --check` 确认稳定再重启。

**实盘验证**：21:32:50 插件干净加载，`[上下文] @前群聊上下文 最近 6 条/120s；@后免@活跃窗口 120s` 已打出，server 绑 127.0.0.1:5140、历史恢复 6 会话、累计 23 次调用。
