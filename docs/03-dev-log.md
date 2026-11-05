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
export BOT_ALLOWED_USERS="<UIN1>"
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
- 新 Koishi 进程（pid 230225）环境变量已带新名单：`BOT_ALLOWED_USERS=<UIN1>,<UIN2>`
- 启动日志：`adapter connect to server: ws://127.0.0.1:3001/`

### 副作用（重要）

`/root/deploy/profile` 是 `600`，**非 root 用户登录 shell 读不到**，会丢掉 `/etc/profile` 里的
`PS1` 与 `/etc/profile.d/*.sh` 逻辑。当前机器只有 root 在用，故可接受；
若以后加普通用户，应把非敏感部分放回 `/etc/profile.d/`（644）。

### 运维坑：重启服务不等于用新配置（2026-10-29 19:11 实测）

两层叠加导致 `bot.env` 改完后 `systemctl restart` 不生效：

1. 环境变量只在**进程启动时**通过 `/etc/profile → /root/deploy/profile → /root/deploy/bot.env` 加载一次，守护进程内存里缓存的是旧值
2. 服务配置了 `KillMode=process`，restart 只杀当前 systemd 主进程，**上一代旧守护/Koishi 孤儿进程不会被杀**，孤儿带着旧环境继续拉起 Koishi

实测例证：19:00 已改 `BOT_ALLOWED_GROUPS=""`，但 19:08 拉起的 Koishi 仍是 `<群A>`（由 18:54 的旧守护 230199 拉起）。

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

19:11 重启后最终生效：`[白名单] 私聊 仅 <UIN1>,<UIN2>；群聊 不限制(所有群，需 @)`

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
| `/root/deploy/bot.env`（备份 `.bak-admin`） | 新增 `export BOT_ADMIN_USERS="<UIN1>"` |

### 指令表（默认仅私聊生效；开启 BOT_ADMIN_GROUP 后群里 @机器人 也能用）

| 指令 | 作用 |
|---|---|
| `#状态` / `/status` | 模型、活跃会话/累计轮次、白名单策略、频率闸参数 |
| `#重置对话` / `/reset` | 清空当前会话多轮上下文（频率计数保留） |

### 群聊特权开关（2026-10-29 19:26 追加）

管理员指令默认**只在私聊生效**；`BOT_ADMIN_GROUP=1`（或 true/yes/on）时群里也可用，群里需 @机器人（去掉 @ 后匹配指令）。实现在 `handleAdminCommand()` 开头：`session.guildId` 存在且开关未开 → 直接返回 false，落入普通聊天流程。

涉及文件（改前已备份 .bak-admingroup*）：deepseek.js、koishi.config.js（adminGroup: process.env.BOT_ADMIN_GROUP || ''）、bot.env（export BOT_ADMIN_GROUP="" 默认关）。

冒烟测试 5/5 PASS：开关关-群里无响应；开关开-群里出状态/重置；开关关-私聊正常；群里非管理员无响应。线上日志：`[管理员] 仅 <UIN1>；生效范围 仅私聊`

### 验证

- 冒烟测试（假 API key，不碰线上）：管理员 `#状态`/`#重置对话` 有回复；非管理员 999999999 发 `#状态` 无回复
- 按第九节流程重启后，新进程（19:20:47）环境含 `BOT_ADMIN_USERS=<UIN1>`，日志：`[管理员] 仅 <UIN1>`

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

19:42:55 重启后日志：`[白名单] 私聊 仅 <UIN1>,<UIN2>；群聊 不限制(所有群，需 @)`、`[管理员] 仅 <UIN1>；生效范围 仅私聊`、`adapter connect to server: ws://127.0.0.1:3001/`

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

## 十六、S0 前置对齐 + 两起“看起来像锁残留”的真事故（2026-10-30）

### 16.1 systemd 服务缺 `HOME` → QQ 在 prelogin 阶段 SIGILL 崩溃循环

现场：`/opt/logs/napcat.log` 反复出现 `[launcher] loadNapCat.js generated` → `not mini app.` → `Illegal instruction (core dumped)`；`dmesg` 可见 `traps: qq[pid] trap invalid opcode ip:...0cf`（固定指令偏移，说明是确定性崩溃，不是随机坏内存）。诡异的是**手工 `bash /opt/launcher.sh` 或 `setsid nohup` 拉起就正常出码**。

定位：用 `systemd-run` 复现并把 `env` 落盘，发现系统级 service 的环境里**没有 `HOME` / `USER` / `LOGNAME`**（手工 shell 有）。QQ 作为 Electron 应用，拿不到 `HOME` 就找不到 `~/.config/QQ` 配置根，在 prelogin 阶段直接死。

验证：`systemd-run -p Environment=HOME=/root -p Environment=USER=root -p Environment=LOGNAME=root ...` → 一次就正常出码。

修复（`ops/systemd/qqbot-watchdog.service`）：
```ini
Environment=HOME=/root
Environment=USER=root
Environment=LOGNAME=root
Environment=SHELL=/bin/bash
WorkingDirectory=/opt
KillMode=mixed          # 原 process：只杀主进程，孤儿带旧环境继续跑
```

**教训**：以前所有“systemd 重启”其实都是**崩溃重启**，能活是因为有人手工拉起过。凡是“手工能跑、服务跑不了”的鬼故事，先 diff 两边 `env`。

### 16.2 `/tmp/.X99-lock` 残锁 → `xvfb-run -a` 拿到脏显示号

Xvfb 被 SIGKILL（`timeout` 杀、`pkill` 杀）后 `/tmp/.X99-lock` 与 `/tmp/.X11-unix/X99` 残留，下一次 `xvfb-run -a` 可能拿到脏号，QQ 同样 SIGILL。

修复：`launcher.sh` 启动前扫描**高位显示号（≥90）**的锁，仅当 `fuser` 确认无人持有时删除锁与 socket（`:1024`/`:1025` 是 gdm 的 Xwayland，切勿动）。

> 注意：`pkill -f 'xvfb-run'`、`pkill -f 'QQ/qq --no-sandbox'` 会**匹配到执行它的 shell 自身**（命令行里含同样字符串）→ 自杀式无输出。脚本里统一用 `b[o]t-watchdog` 这类括号技巧。

### 16.3 掉登录态与快速登录

`快速登录错误：登录态已失效，请重新登录` → 必须人工扫一次码。扫码成功前 WS 3001 不监听，Koishi 只能 `ECONNREFUSED`。

修复：`launcher.sh` 支持 `NAPCAT_QUICK_LOGIN`（转成 NapCat 的 `-q <uin>`），`bot.env` 已配；守护重启后不再卡在二维码页。

### 16.4 S0 其余项

- 全量备份：`/root/deploy/migrate/20261030-112901/`（bot.env、profile、koishi 配置+plugins、napcat config、watchdog/launcher/.so、systemd unit、`state-deepseek/` 快照），`MANIFEST.sha256` 校验，`migrate/current` 软链指向最新。
- WS token 两侧对齐：NapCat `onebot11_*.json` 与 `bot.env` 的 `NAPCAT_WS_TOKEN` 同值；Koishi 改为 `token: process.env.NAPCAT_WS_TOKEN`（不再空串）。
- 收回回环：NapCat WS `0.0.0.0` → `127.0.0.1`；WebUI `::` → `127.0.0.1`（公网 6099 不再可达，远程走 SSH 隧道）。
- 一键脚本：`switch-to-snowluma.sh` / `rollback-to-napcat.sh` 均支持 `--dry-run`（只做前置检查+打印计划，dry-run 会把前置缺口一次报全）；切换前置新增 token 对齐、watchdog 支持 `BOT_GATEWAY`、磁盘余量三项断言。
- 只读闸门：`ops/s0-verify.sh`（14 项静态断言 + 2 项运行时）。

### 16.5 export-from-server.sh 的密钥硬门槛修好

原实现 `grep -E '...[0-9]{1,3}(\.[0-9]{1,3}){3}...'` 把 `127.0.0.1` 也算违规——仓库里 63 行命中全是回环地址，**门槛等于永远中止，从未真正生效**。改为：

1. 先脱敏：WebUI token → `<WEBUI_TOKEN>`、WS token → `<WS_TOKEN>`、QQ 号（含 `NAPCAT_QUICK_LOGIN`）→ `<BOT_UIN>`、管理员 → `<UIN*>`；
2. 文档里 IPv4 一律占位化（先保护 `127.0.0.1`/`0.0.0.0`/`::1`，全替成 `<SERVER_IP>`，再还原）；
3. 再扫描，回环放行、其余（`sk-` 密钥 / 公网 IP / 真 token）一律中止。

首次运行就抓到 `docs/02-operations.md` 里一条真实公网 IP，已改为本机回环 + SSH 隧道写法。

## 十七、SnowLuma 正式落地：从“源码构建”改为“release 包 + 容器”（2026-10-30）

结论先写：**SnowLuma v2.2.1 的官方 linux-x64 release 包在本机 Ubuntu 20.04 上跑不起来，
原因是原生层的 glibc 门槛，不是 JS 层问题。** 最终方案是 QQ + SnowLuma 一起进 ubuntu:24.04 容器，
宿主 OS 一个包都不动。

### 17.1 硬门槛：GLIBCXX_3.4.29 + GLIBC_2.32/2.33/2.34

W0 冷启动时 WebUI 正常（5099 起得来），但每 1.5s 刷一条：

```
[Hook] process enumeration failed: /lib/x86_64-linux-gnu/libstdc++.so.6:
  version `GLIBCXX_3.4.29' not found (required by native/snowluma-linux-x64.node)
```

`ldd -r` / `objdump -T` 实测需求：

| 文件 | 需要的符号版本 |
|---|---|
| `native/snowluma-linux-x64.node` | `GLIBCXX_3.4.29`、`GLIBC_2.32`、`GLIBC_2.33`、`GLIBC_2.34` |
| `native/snowluma-linux-x64.so` | `GLIBC_2.32`、`GLIBC_2.34` |

本机 Ubuntu 20.04：glibc 2.31 / GLIBCXX 3.4.28。**换 libstdc++ 没用**（缺的是 glibc，
`dlopen`/`dladdr`/`__libc_single_threaded` 都在 2.34 才齐全）。三条路里选容器（另两条：
就地升 22.04 会牵动 QQ/NapCat/Koishi 全部运行库；暂缓等于不迁移）。

### 17.2 容器镜像的三个坑

1. **`ubuntu:24.04` 基础镜像没有 ca-certificates**。换阿里云 `https://` 源后 apt 全报
   `Certificate verification failed / No system certificates available`，而 `ca-certificates`
   本身又得靠 apt 装 —— 死循环。解法：源用 `http://mirrors.aliyun.com/ubuntu` 先把包装上。
2. **包名要对 24.04**：`libatk1.0-0t64`、`libatk-bridge2.0-0t64`、`libatspi2.0-0t64`、
   `libcups2t64`、`libasound2t64`、`libgtk-3-0t64` 是 t64 名，照抄 20.04 的 `libatk1.0-0` 会
   `Unable to locate package`（连带把后续包全判成找不到）。
3. **扫码要用 x11vnc**：SnowLuma 是 hook 式，登录二维码在 **QQ 自己的 X 窗口**里，release 包
   没有“把登录二维码推给 WebUI”的能力（WebUI 里的二维码是 2FA 用的）。无头机只能看屏，
   所以镜像带 `x11vnc`，entrypoint 在 `SNOWLUMA_VNC=1` 时以 `-localhost` 起在 5900，
   由用户走 SSH 隧道访问。

镜像与运行时参数固化在 `ops/snowluma/container/{Dockerfile,entrypoint.sh,run.sh}`，
其中 `--cap-add=SYS_PTRACE` + `seccomp=unconfined` 是必须的（注入靠 ptrace/dlopen，
不是 `LD_PRELOAD`），`--network host` 让 3001/5099 继续走回环。

### 17.3 `start.sh` 静默 exit 1：`. /etc/profile` 的 exit 拦不住

现象：`timeout 20 /opt/snowluma/start.sh` 返回 1 且**一行输出都没有**，但直接
`./node ./index.mjs` 正常。`bash -x` trace 只走到 `. /etc/profile` 就断了（因为这一行的
`>/dev/null 2>&1` 把后续 xtrace 也一起吞了）。

根因：`set -e` 下写 `[ -f /etc/profile ] && . /etc/profile || true`，`|| true` 只能兜“返回非 0”，
**兜不住 profile 内部直接 `exit`** —— 整个脚本当场结束。而容器里没有同一套 profile.d，所以同一脚本
在容器内是好的，这个坑只在宿主暴露。

修复：start.sh 不再 source 任何 profile，显式给 `PATH` / `LANG` / `HOME` / `USER` / `LOGNAME`。

### 17.4 注入链路实测（这是全流程唯一真正不确定的点）

容器内 `SNOWLUMA_HOOK_AUTOLOAD=1` 后：

```
15:27:14 INFO [App] hook auto-load enabled: every discovered QQ process will be injected
15:27:15 INFO [Hook] awaiting login: PID=19
15:27:15 INFO [Hook] pipe connected: PID=19
```

手动路径也验过（走 WebUI API，`/api/processes` → `POST /api/processes/<pid>/load`）：
返回 `injected:true, method:loadModuleManual, status:connecting`。

两个必须对齐的前提：

- `SNOWLUMA_HOOK_RUNTIME_DIR` 必须进 **QQ 进程的 environ**（supervisor 先读目标进程 environ，
  其次 `XDG_RUNTIME_DIR`，最后 `/tmp/snowluma-<uid>`）。所以 entrypoint 在拉 QQ **之前**
  就把 env 文件 source 进自己的环境，QQ 继承之。
- 容器内没有 `/run/user/0`，天然不会被 `XDG_RUNTIME_DIR` 带偏；宿主直接跑则必须显式导出。

### 17.5 WebUI 口令：`config/webui.json` 一旦存在，播种就失效

`SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD` 只在**没有** `config/webui.json` 时生效（播种后
`mustChangePassword=false`）。之前手工直接跑过一次 `./node ./index.mjs`，生成了随机口令的
`webui.json`（`mustChangePassword=true`），后续 env 里的口令就被无视了。

处理：删掉（改名备份）`config/webui.json` 再启动，日志出现
`webui credentials seeded from SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD` 才算对。

### 17.6 生产为什么停着：账号风控 168

`/opt/logs/napcat.log` 在 13:35 扫码后：

```
Login Error ... serverErrorCode: 168 你的账号近期存在安全风险，部分功能使用受限
```

这是平台侧限制，换网关不会好转，必须在手机 QQ 走申诉/验证。因此本次不把生产回拉，
SnowLuma 侧停在“注入链路已验证、等待一次合法登录”。

### 17.7 顺带：IDE 吃内存的实测口径

同一时刻宿主跑了两个 IDE 后端：`~/.vscode-server`（9 进程，PSS 368MB + swap 391MB，
其中一个 extensionHost `VmHWM 647MB / RSS 316MB / Swap 316MB`）与 `~/.qoder-server`
（9 进程，PSS 412MB + swap 178MB）。

停掉 vscode-server + 两个 21h/1d 的陈旧 CLI 后：`used 1113MB → 768MB`、
`available 574MB → 921MB`、`swap 949MB → 552MB`。1.8G 的机器上，单个 IDE 后端就该按
250–400MB 预留，长时间跑业务建议内存升到 4G。

---

## 十八、无头机扫码取码实录（2026-10-30）

### 18.1 背景

SnowLuma 不代理 QQ 登录二维码：WebUI 页面上唯一带“二维码”字样的是 **2FA 绑定**，
`index.mjs` 里没有任何 qrcode 依赖。二维码只存在于 QQ 自己的 X 窗口内，所以无头机必须
“看屏”或“截屏”。

### 18.2 手法：容器内 `scrot` + `xdotool`（已封装成 `run.sh shot`）

```bash
# ① 截全屏 + 只截二维码（scrot 已固化进镜像，不需要任何 apt-get）
./ops/snowluma/container/run.sh shot
#   → /opt/snowluma/logs/qq-screen.png（1280x800 整屏）
#   → /opt/snowluma/logs/qq-qr.png    （二维码区域 540,310,202,208）

# ② 手动点控件（xdotool 同样在镜像里）
docker exec qqbot-snowluma env DISPLAY=:99 xdotool mousemove 597 592 click 1
```

关键坐标（1280x800，2026-10-30 复核）：

| 控件 | 坐标 | 说明 |
|---|---|---|
| 底部“扫码登录”链接 | (597, 592) | `-q` 启动时停在**密码页**，点这里才切到扫码页 |
| “当前二维码已过期”里的“刷新”按钮 | (640, 448) | 过期后必须点一下才会出新码 |
| 风控弹窗“确认” | (720, 467) | 关掉弹窗，否则挡住二维码 |

点击后 `sleep 3~5` 再截（Xvfb 没有 XDAMAGE，画面刷新有延迟）。

> 启动参数 `SNOWLUMA_QUICK_LOGIN=<uin>` 会让 entrypoint 给 QQ 传 `-q <uin>`：
> 已登录过的号直达，**从没在这容器里登录过的号则停在"账号已回填 + 密码框"的页面**。
> 想扫码不是改配置，而是点上面的“扫码登录”链接。

### 18.3 两个坑

1. **二维码约 2 分钟就过期**，过期后页面显示“当前二维码已过期”，此时截出来是灰底残影，
   必须**点刷新按钮**才会出新码 —— 直接把旧图发给别人会扫失败。
2. ~~`scrot` / `xdotool` 是 `docker exec` 临时装进容器的，容器一重建就没。~~
   **已修**（P1-1）：两个包写进 `ops/snowluma/container/Dockerfile` 的 apt 列表，
   `run.sh shot` 在**干净容器**里直接可用，不再依赖"往运行中容器里装包"。
   教训：凡是 `docker exec apt-get install` 出来的能力，都会随容器重建一起消失。

### 18.4 风控复现（结论不变）

扫码后 QQ 客户端直接弹出模态框：

> 提示
> 你的账号近期存在安全风险，部分功能使用受限，请登录最新手机QQ并根据提示恢复账号使用。

与 NapCat 时代日志里的 `serverErrorCode: 168` 完全对应：风控发生在**平台侧**，与网关实现无关。
扫码链路本身是通的（`awaiting login` → 扫码 → 被拒），所以只要账号恢复，这一次扫码即可完成 W1。

安全提醒：二维码截图等同于一次性登录授权，用完即删，别入库、别发群。

---

## 十九、首次登录成功，以及一次"自己杀掉自己"的事故（2026-10-30 20:20）

### 19.1 登录成功（19:43–20:03，约 20 分钟窗口）

手机扫码后平台风控这次**没有拦**，SnowLuma 全链路一次通：

```
19:48:15 OK  [Hook] login detected: PID=20 UIN=<UIN>
19:48:17 INFO [Bridge] self info: nickname=<BOT_NICKNAME>
19:48:17 INFO [Bridge] groups loaded: count=4
19:48:18 INFO [Bridge] member warmup completed: groups=4/4 members=949 failed=0
19:48:21 OK  [OneBot.WS-Server] [koishi] listening 127.0.0.1:3001
```

`onebot_<UIN>.json` 由 supervisor 自动生成，`verify-onebot.sh` 11 项全绿
（overlay / 生成物 host=127.0.0.1、port=3001、token 与 `bot.env` 一致、
messageFormat=array、3001 只听回环）。

> 结论修正：风控 168 **不是"永久拒绝"**，而是"某段时间窗口内拒绝"。同一个账号、
> 同一个客户端，19:43 扫码成功。把 168 当成账号已死是误判。

### 19.2 事故：容器模式下的 `pkill -f '/opt/QQ/qq'` 会杀掉容器自己的 QQ

切网关时 `qqbot-watchdog` 启动，日志：

```
[20:03:10] 守护进程启动 (网关=snowluma, 检查间隔 20s)
[20:03:10] 检测到宿主 NapCat(QQ)，先停掉（容器模式独占端口）   ← 误判
```

随后容器内 QQ（PID=20）被杀，entrypoint 的 `while true` 10s 判活又把它拉起来
（新 PID），但带 `-q <UIN>` 停在快速登录页 → `127.0.0.1:3001` 消失。

**根因**：`bot-watchdog.sh` 的互斥逻辑用宿主侧
`pgrep -f '/opt/QQ/qq --no-sandbox'` 判断"宿主是否有 NapCat"。而 PID namespace
只挡住**容器看不到宿主**这一个方向，**宿主 `ps`/`pgrep` 能命中容器内进程**
（`docker top` 与宿主 `ps` 里是同一批 PID）。于是容器模式下一启动 watchdog，
就把自己容器的 QQ 当"宿主 NapCat"杀掉。

**修复**（`ops/bot-watchdog.sh`，/opt 与仓库两份已同步）：

```bash
# 容器内进程的宿主 PID 列表
sl_pids() { docker top "$SL_CONTAINER" -o pid | tail -n +2 | tr -d ' \r' | tr '\n' ' '; }

# 只挑出真正的宿主 NapCat：pgrep 命中后逐个扣掉容器内 PID
host_napcat_pids() {
  local sp; sp=" $(sl_pids) "
  for pid in $(pgrep -f '/opt/QQ/qq --no-sandbox') $(pgrep -f 'xvfb-run -a /opt/QQ/qq'); do
    case "$sp" in *" $pid "*) continue ;; esac
    echo "$pid"
  done
}
```

互斥段改为 `[ -n "$(host_napcat_pids)" ]` 判断 + `stop_host_napcat` 定点 `kill`，
不再 `pkill -f` 全量匹配。重启 watchdog 后日志不再出现该行，验证通过。

**教训**：容器化之后，任何"在宿主上按命令行特征杀进程"的代码都必须先扣掉容器
PID —— 这不只影响 watchdog，`switch-to-snowluma.sh` 里历史遗留的宿主 `pkill`
同样要审（已加注释说明"能命中但杀不干净"的原因）。

### 19.3 修复后重启撞回风控（预期内的第二道坎）

watchdog 重启 → 触发容器重建 → QQ 停在快速登录页 → 点"登录" → 又弹 168 风控。
这不是新问题，是 19.2 的连锁反应：**在很短时间里经历"登录成功→被踢下线→立刻
重新登录"**，风控把这种模式当异常。

处置原则（保持不变）：**停手等待**。同一账号短时间内连续登录失败只会延长窗口。
等 10–30 分钟后再扫一次；成功后第一件事是确认 `host_napcat_pids` 为空（即没有
"宿主 NapCat"误判），再让 watchdog 常驻。

### 19.4 顺带确认的两件事

1. **VNC 可以不停容器关掉**：`docker exec qqbot-snowluma pkill -f x11vnc` 即可，
   entrypoint 的判活循环只管 QQ、不管 x11vnc，所以不会复活；`3001` 与登录态
   都不受影响。`snowluma.env` 已同步改 `SNOWLUMA_VNC="0"`，下次重建也不会再起。
2. **`verify-onebot.sh` 存在循环依赖**：它把"Koishi 已连接"当硬条件，而 Koishi
   只在切网关（enable watchdog）后才起。已加 `-k/--skip-koishi`：切换前用 `-k`
   校验 overlay/生成物/端口，切换后再完整核验。`post-login.sh` 已按此改。

### 19.5 系统侧告警（需留意，非本次事故原因）

```
qqbot-watchdog.service: Failed to add control inotify watch descriptor
for control group ...: No space left on device
```

`inotify` 实例数耗尽（`fs.inotify.max_user_instances`），不是磁盘满。它与
"容器内进程多、watchdog 频繁重启"叠加会触发。1.8G 内存机器上
（`swap 已用 552MB`）建议连同 P3-1 一起处理：调高 `max_user_instances`
或减少同时运行的 Electron 实例。

---

## 二十、插件模块化拆分 + 天气独立数据源（2026-11-02）

> 10-31 的改动（时间注入、联网搜索、`botctl.sh`）都记在 `docs/06-snowluma-todo.md`
> 的 P1-11 / P1-12，本节之前没补录——**以后以大改动为准补录，不要两处都只记一半**。

### 20.1 触发点：`deepseek.js` 已经堆到 1014 行

一个文件里同时管着：消息解析、唤醒判定、连发合并、上下文、名单/敏感词、热配置解析、
历史与用量落盘、Bing 抓取、HTML 实体解码、分段发送、频率闸、引用兜底（含给 adapter
打 monkey-patch）、模型循环。再加上 11-02 排查“天气答不准”（根因见 `06` 的 P1-11 (c)）
发现**天气需要一个新的数据源层**，如果不拆就得变 1200 行。

### 20.2 拆分结果（行为不变，只改结构）

| 模块 | 行数 | 职责 | 拆出去的关键点 |
|---|---|---|---|
| `bot/plugins/deepseek.js` | 589（原 1014） | 只剩消息流编排 + 模型调用循环 | 新增能力不再往这里堆 |
| `lib/text.js` | 91 | CQ 码/Markdown 转纯文本、分段、HTML 实体、时间注入 | `timeLine()` 必须用本地时区，禁用 `toISOString()` |
| `lib/hotconfig.js` | 144 | `bot.env` 热配置层 | 优先级：文件 > config > 进程env > 默认；新增 `BOT_WEATHER_*` 三个键 |
| `lib/store.js` | 85 | 多轮上下文 + token 用量落盘 | 400ms 防抖；`maxTurns` 逐会话裁剪 |
| `lib/sender.js` | 96 | 频率闸 + 文本整形 + OneBot 投递路由 | `reply` 是 **message 数组元素**，不是 `send_group_msg` 的第三参数（P1-10） |
| `lib/quote.js` | 134 | 引用原文三层兜底 | `getMessage` 猴补丁必须返回完整 quote 结构（不只是 text） |
| `lib/tools.js` | 77 | 工具注册表：能力在这里挂载与分发 | `schemas()` 与 `describeCapabilities()` **必须同源**，否则能力边界与实际下发不一致 |
| `lib/weather.js` | 169 | **天气（本次新增）** | Open-Meteo 主 + wttr.in 兜底 + 地理编码缓存 |
| `lib/websearch.js` | 166 | 联网搜索 | 查询词归一化 + 质量闸 + 无效自动重试 |

三个必须记住的实现约束：

1. **`lib/` 放在 `plugins/` 之外**。线上目录是 `/opt/koishi/plugins/` + `/opt/koishi/lib/`，
   插件里写 `require('../lib/xxx')` —— 这种写法在仓库（`bot/plugins` + `bot/lib`）和线上
   两种目录结构下都能解析，**不需要任何路径映射或打包步骤**。若把 `lib` 放进 `plugins/`，
   Koishi loader 会把每个 js 都当插件装载。
2. **工具执行失败永远返回文本，不抛出**。一旦抛出，整轮会静默失败（用户看到的就是“没回复”）；
   返回“查不到，请如实告知用户”则模型会正常组织语言。天气、搜索都遵守这条。
3. **能力描述与实际下发工具同步**。`tools.js` 里 `schemas()` 根据 `hot.searchEnabled /
   hot.weatherEnabled` 决定给不给工具，`describeCapabilities(hot)` 生成拼在 system prompt 后面
   那行能力声明（含“天气必须用 get_weather、web_search 要用短查询”）。两者同库同函数，
   不会再出现“说能搜但实际关了”。

### 20.3 部署链路必须跟着改（否则上线即坏）

`scripts/botctl.sh sync plugin` 旧版**只 cp `deepseek.js` 一个文件**。拆分后如果沿用，
线上会变成“新主体 + 无 lib” → `Cannot find module '../lib/text'` → **插件直接加载失败、
机器人离线**。已改造为：

- 一次同步 `plugins/deepseek.js` + `bot/lib/*.js`（共 9 个）到 `/opt/koishi/{plugins,lib}/`；
- diff 预检覆盖全部文件（首次部署时线上无 `lib/`，会被当成“有差异”，需 `FORCE=1` 确认，属预期）；
- **逐文件备份 + 逐文件 `node --check`**，任一失败则全部回滚且不重启；
- `mkdir -p /opt/koishi/lib` 在 cp 前。

同时修了 `botctl.sh` 两个使运维判据不可信的缺陷（11-02 部署时实际踩到）：

- `restart koishi` 写死 `sleep 8` 就查 5140，而实测 Koishi 要 **~35s** 才监听
  → 报“5140 未监听”的**假失败**，很容易诱导再重启一次。改为最多 90s 轮询，并输出实际等了多久。
- `verify` 把“秒数”当成位置参数传给 `verify-onebot.sh`（它只接 `-q/-k`）
  → **永远“未知参数”直接退出**，等于部署后的只读核验闸门从来没跑过。已改为
  滤空参数 + 端口走 `PORT` 环境变量。

### 20.4 验收（全绿才算完成）

```
node --check 全部 9 个文件                          OK
bash -n scripts/botctl.sh                       OK
node scripts/smoke-plugin.js                  16 项断言全绿
/opt/koishi/lib/ 落地 9 个文件且与仓库 diff 为空     OK
启动横幅 [天气] 开（Open-Meteo 主 + wttr.in 兜底；默认城市 苏州）  OK
历史 10 个会话恢复 + [引用诊断] 已挂钩 getMessage      OK
botctl.sh verify                              12 项全通过
botctl.sh gate（s0-verify）                    39 项通过 0 失败
```

冒烟测试脚本 `scripts/smoke-plugin.js` 的三个要点（下次改插件直接跑它）：

- **先清空继承来的 `BOT_*` 环境变量**再 require 插件。登录 shell 会从 `/etc/profile` →
  `/root/deploy/profile` → `bot.env` 注入真实值，不清则白名单/管理员用的是线上配置，
  **断言会静默失真**（看着绿其实测的是旧配置）；
- 只拦 `/chat/completions`（脚本化：奇数次返 `tool_calls`、偶数次返文字），**其余 fetch 放行真实网络**，
  这样能验证工具链真的拿到了气象数值（断言 `role=tool` 内容含 `℃`）；
- 工具往返要跑两次真实 HTTP（地理编码 + 预报），**固定短等待会误判**，已改成 `waitUntil` 轮询。

### 20.5 本次写错的几处（`node --check` 全部兜住了，但都是“拆分时手抄”造成的）

- `text.js`：`.replace(/&lt;/g; '<')` —— 分号当逗号；
- `weather.js`：模板串 `【${String(city).trim())}】` 多一个括号；
  `WTTR_EN_ZH` 里 `moderate rain` / `heavy rain` **未加引号** → `SyntaxError: Unexpected identifier 'rain'`；
- `websearch.js` 质量闸首版误判垃圾为有效：旧逻辑用“**任一** token 命中”判有效，而实体兜底页
  必然命中主体词（苏州）；GENERIC_TITLE 正则又错误地锚了结尾 `$`。新规则见 P1-11 (d)；
- `quote.js` 猴补丁首版只返回 `{content, messageId}`，**丢了 adapter 需要的其余字段**；
- `deepseek.js` 里 `searchedBrief` 声明晚于使用（TDZ 靠执行顺序才能跑，很脆）；
- 自己引入的行为回退：`#状态` 里原本的“频率闸：N 条/分，间隔≥Nms”限值行被换成
  “rateState.size 个会话计数中”——**信息丢了**。现改为 `sender.rateDesc()`（必须是函数，
  存成字符串则 size 永远是 0），既保留限值也带上计数。

> 经验：`node --check` 只查语法，**查不出未定义变量、作用域错误、缺模块**；
> 拆文件后的第一道闸门应该是冒烟测试而不是它。

### 20.6 待补 / 已知风险

- ⚠ **真实 QQ 群里人工实测未做**（本轮只到插件级）。验证方式：在白名单群 <GROUP_ID>
  @机器人问“今天苏州天气”，应直接拿到温度/降水数值；日志里应出现
  `DeepSeek 回复 … 工具=get_weather(...)` 与 `[回复] …`。
- 关掉 `BOT_WEATHER_ENABLED` 后，天气类问题会回退到“让模型用 web_search”——而搜索给不出
  数值（见 P1-11 (c)），所以**不要只关天气不告知用户**。
- Open-Meteo 是区县级坐标的模型数据，与中央气象台官方播报会有 1℃ 左右差异；要完全对齐
  官方口径需换带 key 的商业气象 API。
- 新发现一条与本次无关的可靠性问题：Koishi ↔ 3001 的 WS 11-02 当日掉线 14 次（从 09:24 起，
  **早于本次部署**），已记为 `06` 的 P2-9。

---

## 二十一、"取不到历史"其实是我调了个不存在的方法：网关调用口径 + 接口速查表（2026-11-03 20:10~）

### 21.1 现象

- 20:10:16 群里「引用一条 17:05 的发言 + @机器人」，机器人回"没前情，元芳猜不出来——把事讲明白？"；
- 同一轮的三条日志连起来看，就知道检索**跑了但没料**：
  `[引用检索] 网关未返回历史消息` → `[转发] 被引用消息 382740735 未识别出 forward id` →
  `DeepSeek 回复 … @前上下文=0条 引用背景=0行 转发=0行`；
- 用户的问题："是不能主动去获取历史对讲记录？"

### 21.2 根因：不是网关不支持，是代码调了不存在的方法

- `bot/lib/quote.js` 写的是 `internal.request('get_group_msg_history', …)`，而
  `@satorijs/adapter-onebot` 的 Internal 类**根本没有 request 方法**（只有私有
  `_get(action, params)` 和 `Internal.define` 生成的驼峰方法）→ `if (internal.request)` 恒假
  → `data` 一直是 undefined → 落到"网关未返回历史消息"分支。同一坑另有 3 处：
  `quote.js` 的 get_msg 兜底、`forward.js` 的 get_forward_msg 与 get_msg。
- 第二层坑：即使改用驼峰方法也不行——adapter 里
  `Internal.define("get_group_msg_history", "group_id", "message_seq")` 的第二个参数名是
  `message_seq`，而 SnowLuma 文档要的是 `message_id`；名字对不上会被**静默忽略**（等于没给锚点）。
- 用 `/root/probe_hist2.cjs`、`/root/probe_speed.cjs` 带 access_token 直连 3001 实测：
  - `get_group_msg_history` 支持 `message_id` 锚点 + `reverse_order`（true=锚点及更旧、false=锚点及更新）；
  - `message_id` **可为负数**（见过 `-1183072755`），排序只能用 `time`；
  - 耗时与条数强相关：`count=60` ≈ 2.3s，`count=200` ≈ 13.7s；不带锚点拉 200 条只够回到当天 14:50。
  → 旧口径"拉最近 N 条"天然接不住"引用几小时前的话"这种常见玩法。

### 21.3 修法

1. 新增 `bot/lib/onebot.js`：网关动作助手。`callApi(session, action, params)` 三档降级
   （`internal._get` → `internal.request` → 带 token 的临时直连 WS），自带超时，
   返回 `{ ok, data, via, error }`，**每一档的失败原因都拼进 error**；
2. `quote.js` / `forward.js` 里那 4 处手写网关调用全部改走助手；顺带删掉两处各自实现的
   裸 WS 兜底——它们连 access_token 都没带，其实从来没连通过（这也是"兜底"最坏的形态）；
3. 引用检索的历史拉取改成**按锚点双向分页**（两页并发 + 按 message_id 去重），日志升级成
   `历史 N 条（锚点前 X/锚点后 Y，单侧上限 C，走 internal）覆盖 HH:MM~HH:MM`；
4. `QUOTE_CONTEXT_FETCH_COUNT` 语义改为**单侧条数**，默认 200 → 60（13.7s 会撞助手 6s 超时，
   调太大反而整段拿不到），`bot.env` / `bot.env.example` / `hotconfig` 三处同步；
5. `[转发] 未识别出 forward id` 改为记 `message_type` 与段类型列表：引用的常是普通文本消息，
   旧文案写得像失败，白白带偏一次排查方向；
6. 二阶修正（21:18 再部署一次）：`callApi` 的 `timeoutMs` 原来是**每档各算一遍**，最坏
   3×预算（内部档超时 → request 档超时 → WS 档再超时），而引用检索在回复主链路上；改成
   **整次调用共用一个 deadline**（`left()` 递减，兜底档至少留 300ms 好把失败原因记出来），
   返回值加 `ms`、检索日志加 `耗时 NNNms`。单测补 N8（两档永挂时总耗时贴着预算）/N9 → **36/36**；
7. 文档落地：新增 `docs/08-gateway-api.md`（调用口径 + 已接入接口 + 193 动作速查表）、
   `scripts/crawl-snowluma-docs.sh`（抓文档站到 `/root/snowluma-docs/`，仓库不 vendor 第三方文档）、
   `scripts/gen-gateway-api.js`（只重写 AUTO 标记之间的速查表，手写区不动）。

### 21.4 验收

- `node /root/qctest.cjs` → **34/34**。新增 N 组：N1 分页参数口径（`message_id` 而非
  `message_seq`、`reverse_order` 各一次）、N2 两侧重叠去重、N3 一侧失败一侧成功仍能出料、
  N4 负数锚点原样传递、N5 `get_msg` 走助手、N6/N7 助手降级顺序；
- `node --check` 全绿、IDE 无报错；
- **部署**：21:08 `FORCE=1 botctl sync plugin`（18 个文件 cp + node --check 通过，
  备份 `.bak-1103-2108`），worker 启动时间 21:08:03 是新的，开机日志出现
  `[网关] 动作助手就绪：优先复用 adapter 连接（internal._get），兜底直连 ws://127.0.0.1:3001（token 已配）`，
  线上与仓库逐文件 `cmp` 全 IDENTICAL；
- **兜底档首次实测**：`/root/probe_live_ws.cjs` 用**线上部署好的** `lib/onebot.js` 不带 session
  直连网关（即只走临时 WS 那一档），`get_group_msg_history` / `get_msg` 全部 `ok=true via=ws`，
  负数锚点 `-783997838` 分页与取单条都正常 → 证实"没带 token 所以从来没通过"的判断，
  现在这一档是真能兜底的（主档 `internal._get` 只能等群里真跑一轮才验）；
- **资料已落地**：`/root/snowluma-docs/` 现有 catalog.json(332KB) + openapi-snowluma.json(695KB)
  + llms-full.txt(320KB) + docs-mdx/(54 篇)；crawl 脚本改为本地克隆优先后不再超时被 SKIP；
- **线上人工实测待做**：群里引用一条较早的消息再 @机器人，日志应出现
  `[引用检索] 历史 N 条（锚点前 …/锚点后 …，走 internal）` 且回复行的 `引用背景=N行` 不为 0。

### 21.5 教训

- **"方法名靠猜"是这轮静默失效的源头**。`internal.request` 是我假想出来的 API；
  调第三方/适配层的内部能力前，先在依赖源码里确认方法真的存在
  （`grep -n "request\|_get" /opt/koishi/node_modules/@satorijs/adapter-onebot/lib/index.js` 一条命令就能否掉），
  参数名以对方文档为准，不要拿另一家的习惯套；
- 接口文档就在 `/root/code/SnowLumaDocs`（193 个动作含默认值），已抽成本仓库
  `docs/08-gateway-api.md`：**以后要加能力，先查这张表有没有现成动作**，用过的新动作把
  参数口径与实测注意补回该文件；
- 失败路径必须留日志这条这次救场：正因为上一批给 `[引用检索]` 每条分支都加了行，
  才一眼分清"这轮没跑"和"跑了但没料"。

## 二十二、断在窗口里的引用检索：`this._request is not a function` 其实是「这一刻没连着网关」（2026-11-04 10:05~）

### 22.1 现象

11-03 刚上线的锚点分页检索，11-04 10:05 那轮又空了（时间线取自 `/opt/logs/koishi.log`）：

```
10:05:36 [I] group [引用] getMessage 兜底成功(走 internal) id=382740735 内容=很难想象男的知道后会怎么想
10:05:43 [W] adapter normal, will retry in 5s...
10:05:45 [W] group [引用检索] 网关未返回历史消息：get_group_msg_history 各档均失败（耗时 1377ms/预算 6000ms）
             → internal: this._request is not a function | ws: ws 错误: connect ECONNREFUSED 127.0.0.1:3001
10:05:45 [W] group [转发] get_msg 取引用消息失败 id=382740735: …（耗时 26ms/预算 3000ms）→ 同样两条原因
10:05:48 [I] adapter connect to server: ws://127.0.0.1:3001/
10:05:48 [I] group DeepSeek 回复 … 引用背景=0行 转发=0行
10:05:48 [I] group [回复] …: 我猜是那个男的会炸；但没背景，纯属瞎猜。
```

引用原文是拿到了（10:05:36 那条兜底成功），但周边历史和转发内容整段落空，于是模型自己说「没背景、
纯属瞎猜」。断线只持续 5 秒（10:05:43 → 10:05:48），而我们的检索一次就放弃了。

### 22.2 根因（两层）

- **第一层是把报错读错了**。`internal: this._request is not a function` 看着像「我又猜错方法名了」，
  但读 adapter 源码（`@satorijs/adapter-onebot/lib/index.js` v6.0.2）：`Internal` 类只有私有 `_get`，
  `_request` 是传输层在**连接建立时**挂到 `bot.internal` 上的（HttpServer fork line 523 / WsServer
  accept line 647），socket close 时再 `delete bot.internal._request`（line 645）——
  所以这句等价于「这一刻没连着网关」，与 21 节那次「调根本不存在的 `request()`」是两码事；
- **第二层是没重试**。SnowLuma 侧 QQ 会话周期性重登会把 3001 关掉 5~28 秒（p50=10s，
  184 个样本，见 `docs/08-gateway-api.md` 第三节），窗口里三档同时失败（`_get` 没了、
  自建连接 `ECONNREFUSED`），旧代码一次放弃 = 撞上窗就把功能按概率关掉。11-03 全天断 88 次、
  11-04 上午 10 点后每 1~5 分钟一次，这窗口不是意外而是常态。

### 22.3 修法（`bot/lib/onebot.js` + 三处调用方）

1. `callApi` 拆成 `attempt()`（单次跑三档）+ 外层 `for(;;)`：只对 `offline` 每隔 `retryInterval`
   重试一轮，成功 / 预算见底 / 拿到业务失败才停；返回值加 `attempts, offline, business, capped`；
2. 分类规则：`OFFLINE_HINT` 词表判离线；`wsCall` 见 `retcode !== 0` 标 `business`，
   **任一档拿到业务失败就整次收手**（不拦的话 ws 档的 `ECONNREFUSED` 会把业务失败误判成离线）；
3. 离线冷却：`COOLDOWN_MS=8000` + `COLD_BUDGET_MS=1200`，一个动作判出离线后，同轮后续动作
   只给 1.2s 且不再重试，通一次立即解除——否则 `历史 ×2 → get_msg → get_forward_msg` 各等满预算；
4. 预算与间隔做成热键 `BOT_GW_TIMEOUT_MS` / `BOT_GW_RETRY_INTERVAL_MS`（`onebot.create({ defaults: () => … })`
   每次调用现取，改 `bot.env` 即生效）；线上预算按实测分位 6000 → **12000**。
   命名从 `BOT_GATEWAY_*` 改成 `BOT_GW_*`：prod env 里 `BOT_GATEWAY="snowluma"` 是守护脚本在用的
   网关开关（`ops/snowluma/post-login.sh`、`s0-verify.sh` 都在读，还有 `sed` 改它），前缀撞不得；
5. 日志分口径：离线写「网关离线（连不上，已在 N ms 预算内重试 N 轮仍没碰上重连）」、
   业务失败仍写「网关未返回历史消息」，成功行补 `耗时 …ms，重试 N 轮`；`quote.js`/`forward.js`
   里散落的 `timeoutMs: 3000/4000` 全收成 `{}`，一个热键管住全部；
6. `retryInterval=0` 必须是「关掉重试」。第一版把它当普通数值传下去，`sleep(0)` 变成
   1.2s 预算里空转 159 次（N16 抓到），改成循环里显式 `retryInterval <= 0` 就 break；
   同时 N15 原来用 400ms 预算验证「0=不重试」其实是靠 `RETRY_MIN_LEFT_MS=700` 蒙对的，改成 1500ms。

### 22.4 验收

- 单测 **46/46**：N10 断窗里重试成功（`attempts=2 via=internal`）、N10b 一直连不上则用完预算、
  N11 业务失败不换档不重试、N12 词表分类、N13/N14 两种日志口径、N15 defaults 现取与关重试、
  N16 冷却窗内 `capped=true/attempts=1/预算 ≤1.2s`、N17 通一次解除冷却、H1~H3 两个热键的解析/钳位/默认值；
- 真网关现场三判定（`/root/probe_retry.out`）：① 正常 `via=ws attempts=1`；② 打不存在的动作
  `business=true offline=false attempts=1 ms=247`（不白等）；③ 打到空端口
  `offline=true attempts=4 ms=2642`（真在等重连）；
- 断窗统计与耗时基线：`/root/gapstat2.py`（184 样本分位 + 覆盖率表）、`/root/lat.out`、`/root/lat2.out`；
- 两次部署：11:03（重试+冷却+热键+分类）、11:11（注释与实测数字）。worker 11:11:37，
  逐文件 `cmp` 全 IDENTICAL，启动日志
  `[网关] 动作助手就绪…单次预算 12000ms，连不上时每 1200ms 重试一轮…`，最近 80 行 0 个 `[E]`；
- **线上人工实测待做**：群里引用一条较早的消息再 @机器人，期望 `历史 N 条（…耗时 …ms，重试 N 轮）`
  且回复行 `引用背景=N行` 不为 0；若仍失败，日志应明确写「网关离线」而非再含糊过去。

### 22.5 教训

- **同一条报错文案可以有两种成因**：`is not a function` 上次是「方法不存在」、这次是「连接没了」。
  容错要按「现象词表」分类，而不是盯着某一个方法名争论；判据写进代码注释里（谁在什么时候
  挂上/删掉 `_request`，带源码行号），下次不用再翻一遍 `node_modules`；
- **抖动是常态**：网关每隔几分钟到几小时就断 5~28 秒，任何挂在回复主链路上的调用都必须按
  「预算内等重连」来写；一次放弃 = 按概率把功能关掉，而且日志只会留下一句像「网关没数据」的话；
- **预算 ≠ 等待时间**：只有失败时才把预算花完，正常时零成本，所以该按实测分位往大取，
  别拿「怕回复慢」当理由留个小值；同时要配冷却，免得串行动作把单个预算乘成十几秒；
- **新配置键要先查有没有撞名**：`BOT_GATEWAY_*` 差点糊掉守护脚本的 `BOT_GATEWAY`，
  改完还得确认老键没被 `sed` 类批量替换误伤（本次 20 处改名后专门 grep 复核过）。

## 二十三、引用背景只活一轮：下一轮追问就「只见一句引用」（2026-11-04 13:09~13:12）

### 23.1 现象

13:11 那轮检索和作答都是对的（引用「很难想象男的知道后会怎么想」→ 命中 6 行背景 → 答「这颗雷早晚会炸」）。
可用户紧接着（13:12，被@后的免@窗口内）问「这件事的前因后果你描述下呢」，机器人回：

```
13:12:05 [I] group [运营] 群 <群A> 唤醒（活跃窗口免@）
13:12:09 [I] group DeepSeek 回复 … @前上下文=0条 引用背景=0行 转发=0行
13:12:09 [I] group [回复] …: 我只看得到一句引用，前因后果得你补给我。
```

用户视角就是「引用关联上下文没获取成功」，但拿日志一看，**上一轮的检索根本没失败**。

### 23.2 取证（先看日志，再看落库数据，最后拿网关原始记录复核）

- `koishi.log`：13:09 / 13:11 两轮都写着 `走 internal，耗时 4144/4354ms`、`历史 80/108 条`、`引用背景=2/6行`
  —— 取历史这步是好的，别再往「网关抖动」上找（那是上一节的问题，已修）；
- `/opt/koishi/state/deepseek/histories.json` 落库内容：
  `"[引用 <成员甲>的消息] 很难想象男的知道后会怎么想\n[我的回应] 你怎么看"`
  —— **只有引用原文，没有那 6 行背景**，下一轮自然看不见；
- 用仓库 `lib/onebot.js` 直连网关复核锚点（`/root/probe_ctx.cjs` → `/root/probe_ctx.out`）：
  锚点 `382740735` 真身是 **11-02 17:05:03**，窗 16:55~17:18 里正是 `<成员乙>` 那段相亲/未婚先孕的对话
  → 窗口算法没选错时间段；
- 同一次复核顺带查清 13:09 那轮为什么只有 2 行：锚点 `-948125988` 是 **11-03 16:14:29 提问者自己发的**
  （同一个人在两个群的群内昵称不一样：`<群B>` 里是「<群内昵称1>」、`<群A>` 里是「<群内昵称2>」，故 seed 只认 user_id 不认昵称），
  窗内除他本人之外只剩机器人自己当时的三条回答，而候选参与人和背景组装都排除 selfId → 只剩
  「怎么看待他队友的发挥 [被引用]」+「你怎么看」两行。日志写「时段内没有其他人发言」是实情。

### 23.3 根因

背景块在 `bot/plugins/deepseek.js` 里只拼进 `turn`（本轮模型输入），落历史用的是 `finalPrompt`（不含背景）：

```js
if (quoteBgBlock) turn = '[被引用消息前后的对话背景…]\n' + quoteBgBlock + '\n\n' + turn;  // 喂模型
...
pushHistory(chatKey, 'user', finalPrompt, ...);   // 落历史 —— 背景不在里面
```

于是**「检索到的前因后果」是当轮耗材**：下一句追问本身没有引用（不会再触发检索），就彻底失忆。
转发全文故意只留一句标记是合理的（看完就废的素材），但引用背景常常正是追问的对象，两者性质不同。

### 23.4 修法

1. `retrieveAroundQuote` 多返回一份 `historyBlock`：**复用同一个 `assembleLines`** 按更小的字数上限重裁
   （它本来就是「超限时优先留靠近锚点的」，天生适合当摘要），不另写一套裁剪逻辑，免得两边口径漂移；
   存档字数 ≥ 全量时直接用全量，不白裁一遍；
2. 插件新增 `historyPrompt` = `finalPrompt` + 存档段，只进历史、**不进本轮输入**（本轮已有全量，叠上去是白烧
   token）。注意声明要放在 `if (hasContent)` 块**外**（`let historyPrompt = ''`），块内 `const` 会让块外的
   `pushHistory` 直接 ReferenceError；
3. 新热键 `BOT_QUOTE_CONTEXT_HISTORY_CHARS`（默认 400，0~1500，**0 = 不沉淀**）。解析同样不能套 `|| DEFAULT`
   —— 和 `BOT_GW_RETRY_INTERVAL_MS` 一个坑：`0` 会被默认值顶掉；非数字才退回默认；
4. 检索相关时间从 `HH:MM` 改成 `MM-DD HH:MM`：跨天引用是常态（11-02 发的被 11-04 引用），老口径写出的
   `覆盖 22:14~13:11`、`时段 16:55~17:18` 完全看不出是哪两天，这轮排查只能手工翻网关原始记录；
5. 可观测性补两处：`[引用检索]` 命中行加「存档 N 行」，回复行加「引用存档=N行/M字」，
   好核对沉淀到底有没有发生。

### 23.5 验收

- 单测 **50/50**：新增 D1（存档比全量短、锚点条必须保住）、D2（填 0 或不填 → 不产存档，全量背景不受影响）、
  D3（存档字数 ≥ 全量时直接用全量）、H4（新键默认 400 / `0` 保住 / 超上限钳到 1500 / 非数字退默认）；
- 部署 13:33（备份 `.bak-1104-1333`），worker 启动 13:33:22，改动的 3 个文件逐文件 `cmp` IDENTICAL，
  重启后日志 0 个 `[E]`、0 个 `[W]`；启动行
  `[引用检索] …背景块≤1500字，其中≤400字压成存档落进会话历史（…填 0=不沉淀）`；
- **线上待人工实测**：引用一条旧消息 @机器人 → 紧接着追问「这事前因后果」。期望第二次不再答「我只看得到
  一句引用」；同时日志应有 `引用存档=N行/M字`，`histories.json` 里那条 user 轮应带上存档段。

### 23.6 教训

- **「这一轮答对了」不等于功能没问题**：13:09/13:11 两轮日志全绿，毛病出在跨轮。只核对单轮会把成功误判成
  整体没问题，用户报的恰恰是下一轮；
- 中间产物要不要落历史，按「用户会不会追问它」分类：转发全文不会（一次性素材），引用背景会（就是追问对象）；
- 落历史的东西必须**另裁一份小的**，别把全量原样塞进去 —— 历史是逐轮重复计费的，32 条里挂一条 1500 字
  就是长期开销；
- 日志里的时间不带日期等于没写：这个项目里「引用几天前的消息」是常规用法。

## 二十四、机器人「发不了群公告」：一半是没接动作，一半是它在群里只是普通成员（2026-11-04 13:47~15:19）

### 24.1 现象

```
13:47:24 [I] group [运营] 群 <群B> 唤醒（被@）
13:47:29 [I] group DeepSeek 回复 … 工具=未调用 @前上下文=0条 引用背景=0行 转发=0行
13:47:29 [I] group [回复] …: 元芳没有发公告的权限哦，只能在这儿喊：……
```

用户要的是「把这句结论挂成群公告」，机器人只会用群消息喊一嗓子。它那句「没有权限」**措辞碰巧对，
但真实原因不是权限** —— 是代码里根本没这个动作。

### 24.2 取证

- `工具=未调用`：`bot/lib/tools.js` 下发给模型的工具只有 `web_search / read_url / get_weather /
  set_reminder·list·cancel / search_image / generate_image`，公告一个都没有 → 模型无从调用，
  它按 `describeCapabilities()` 的能力边界老实认了没本事；
- `docs/08-gateway-api.md` 里 `_send_group_notice` 是有的（193 动作速查表第 187 行），
  官方 catalog 参数齐全 → **不是网关不支持**；
- 直连网关只读探测（`/root/probe_notice.cjs`，**故意没调 `_send_group_notice`**，那会真往群里发）：
  - `get_group_member_info` 查机器人自己 → `role=member`；查提要求的那位 → `role=owner`；
  - `_get_group_notice` → retcode=0、`data=[]`（公告这族动作在 SnowLuma 侧是通的）；
  - `get_supported_actions` → **retcode=1404 未实现**。
    （这份输出里有真实群号/昵称/uin，只在仓库外的 `/root` 下，别提交、别外发。）

### 24.3 根因（两层，缺一不可）

1. **没接动作**：引用检索/转发展开都统一到 `lib/onebot.js` 了，公告从来没人写过；
2. **平台权限**：QQ 只让**群主/管理员**发群公告，机器人当时是 `member` —— 就算把接口接上也一定发不出去。
   这层是硬限制，代码绕不过，只能把人提上去（或换号）。

顺带一条设计判断：公告**不该做成模型工具**。它会推送/弹窗给全群，挂进 `tools.js` 就等于
任何一句「元芳发个公告骂某某」都可能被模型真的执行。所以走 `#状态`/`#重置` 同一路管理员指令，
正文由人写死，模型不参与决定发不发。

### 24.4 修法

新增 `bot/lib/notice.js`（解析 + 两层权限 + 限流），在 `handleAdminCommand` 里挂入口：

- 写法：群里 @机器人 `#公告 [置顶] <正文>` —— **只发当前群**，就算正文以群号开头也不吃
  （免得管理员手滑打到别的群，也让「在哪个群 @ 的」与「发在哪个群」永远一致）；
  私聊 `#公告 <群号> [置顶] <正文>`（5~12 位数字）；
- 触发口径两条，满足其一即可：
  A) `BOT_ADMIN_USERS` 名单内（群里还要求 `BOT_ADMIN_GROUP=1`，与其它指令同口径）；
  B) `BOT_NOTICE_ALLOW_GROUP_ADMIN=1` 时**该群的群主/管理员**也能发 —— role 现查网关，异步核验；
- 发送前先查**机器人自己**的 role，`member` 就直接回「先把我提成群管理员」，不去撞腾讯的错；
- 限流：正文 `BOT_NOTICE_MAX_CHARS`（20~500，默认 200）、同群 `BOT_NOTICE_COOLDOWN_MS`
  （默认 60s，**允许填 0=不限频**，所以解析不能套 `|| DEFAULT`，与 `BOT_GW_RETRY_INTERVAL_MS` 同一个坑）、
  再过一遍敏感词；任一拦下都**不产生任何网关调用**；
- `#状态` 加一行公告口径，排查「为什么发不出去」时第一眼看这里。

### 24.5 验收

- 单测 **62/62**（新增 NT1~NT11 + H5）：群里不吃群号、私聊必须带群号、`置顶` 只认独立词
  （`置顶公告已经更新` 这种正文不被误判）、空正文/超长给用法、非指令返回 null、
  **`member` 时断言只调了身份查询、绝没调 `_send_group_notice`**、参数按 `{group_id, content, pinned}` 原样下发、
  同群冷却与 0=不限、敏感词/关开关零调用、身份查询失败不假装成功、hotconfig 四个键的默认与钳位；
- 部署 15:19（备份 `.bak-1104-1519`），worker 启动 15:19:47，`deepseek.js / notice.js / hotconfig.js`
  逐文件 `cmp` IDENTICAL，重启后 0 个 `[E]`、0 个 `[W]`；启动行
  `[公告] 管理员指令 #公告 开（正文≤200字；同群 60s 内一条；触发：名单内或该群群主/管理员）…`；
- 群主随后把机器人提成群管理员，复查 `get_group_member_info` → **`role=admin`**（第二层限制已解除）；
- **真发一条公告尚未验证**（不该由我拿真群试），需用户在群里 `@机器人 #公告 测试一下` 看回执。

### 24.6 教训

- 用户说「没权限」时别照着查权限。这次是**两层原因叠在一起**，日志里的 `工具=未调用` 一句话就把
  「它没试过」和「它试了被拒」分开了 —— 先看有没有真的发起过调用，再谈权限；
- QQ 的平台权限模型（谁能发公告/置顶/精华）不看接口文档，只看群身份；接这类动作时**先查 role 再做**，
  比等腾讯报错更能给用户有用的话；
- 打扰全群的操作不要交给模型自由决定：管理员指令 + 字数 + 冷却 + 敏感词四道闸，
  比在 prompt 里写「你不要乱发公告」可靠得多；
- 想「自检一下网关到底支持哪些动作」是死路：`get_supported_actions` 直接 1404 未实现，
  动作可用性只能靠真调 + 记 retmsg。

### 24.7 补记：自然语言「将这句话发布公告」还是发不了（15:27 实测，属刻意保留）

提要求的人没打指令，而是**引用那句话 + @机器人说「将这句话发布公告」**。日志：

```
15:27:14 [I] group [运营] 群 <群B> 唤醒（被@）
15:27:20 [I] group [引用检索] 锚点 … 命中 3 条（讨论对象 0 人，存档 3 行）
15:27:22 [I] group DeepSeek 回复 … 工具=未调用 … 引用背景=3行 转发=0行 引用存档=3行/89字
15:27:22 [I] group [回复] …: 元芳真发不了公告啊，只能原地复读：……
```

整轮**没有一行 `[公告]`**，也没有 `get_group_member_info` / `_send_group_notice` 的调用 —— 这条消息落在
模型对话链路里，而公告不在工具清单（24.3 那条设计判断），所以它只能检索背景 + 复读一遍。不是 bug。

要不要给自然语言开一条路（意图前置识别，或按发送者身份条件下发 `send_group_notice` 工具）？
**11-04 的决定：不开**，维持「只有 `#公告` 能发」。理由：公告是全员弹窗，
「显式打字 + 指令前缀」本身就是那道确认动作，去掉它等于谁在群里嗓门大都能触发一次推送。

用户视角最容易踩的两条写法坑（已写进 docs/02 与 docs/08）：

1. **`#公告` 必须在正文最前面**。`normalizeText` 把 `[CQ:at]` 洗成空格再 trim，所以
   `@机器人 #公告 正文` 与 `#公告 正文 @机器人` 都认；`将这句话 #公告 正文` 这种前面带话的不算指令；
2. 群里 `置顶` 要单独成词（`#公告 置顶 正文`）；`#公告 置顶公告已经更新` 里的「置顶」是正文，不是开关。

验收状态更新：单测 62/62、部署 15:19、身份复查 `role=admin` 都过了，**真发一条公告仍未实测** ——
得管理员在群里打一次 `@机器人 #公告 <正文>` 看回执（开发侧不该拿真群发全员弹窗）。

## 二十五、引用链上溯：让「引用了一条自己也带引用的消息」也能拿到前因（11-04 下午）

### 25.1 日志取证

15:19 公告上线后紧接着的这一轮，暴露了引用检索的第二个盲区（时间线按 <群B> 的 11-04 记录）：

```
15:38:48 [I] group DeepSeek 回复 [onebot:<群B>:<成员甲>] 合并 1 条 历史轮次=8 工具=未调用
             @前上下文=0条 引用背景=2行 转发=0行 引用存档=2行/70字
15:38:48 [I] group [回复] …: 真没有记录——元芳手上就这几句空话！
```

`/root/probe_1538.cjs` 直连网关把锚点邻域的原始消息（带 CQ 码）打出来才看清：

| 时间 | 发送人 | 内容 | reply 指向 |
| --- | --- | --- | --- |
| 11-04 13:11:19 | <成员甲> | `你怎么看` | **382740735**（11-02 17:05） |
| 11-04 13:12:05 | <成员甲> | `这件事的前因后果你描述下呢` | 无 ← **本轮锚点** |
| 11-04 15:38:38 | <成员甲> | `再来一次` | 上面那条锚点 |

三条硬事实：

1. 锚点自身**不带引用**，是用户自己的一句元问题；窗内只有他 + 机器人（机器人被 `selfId` 排除），
   所以检索只组装出 2 行 —— 算法没错，是**那两条消息周围确实没料**。
2. 真料在**上一跳**：`382740735` 是 11-02 17:05 的一条发言，它周围 16:51~17:18 才是 <成员乙> 追问相亲/未婚先孕
   那段（13:11 那轮曾检索到 6 行并答对了，但发生在 11-04 上午「存档」上线之前，没落进历史）。
3. `382740735` **不在**本轮已拉回的 63 条池子里 → 上溯必须再问一次网关（实测 ~2.4s/批）。

顺带发现存档在漏：那 2 行「你怎么看 / 前因后果描述下」被当成背景永久沉进了会话历史
（`histories.json` 里可见），下一轮起每轮重复喂一遍，还给了模型一句「有记录」的假线索。

### 25.2 口径（用户拍板：两个都做，上溯"允许多跳，最多 10 次"）

10 跳如果每跳都问网关 = 最坏 24s，回复会被拖死，所以把「跳数」和「时间」拆成两道闸：

| 新键（bot.env，热生效） | 默认 | 含义 |
| --- | --- | --- |
| `BOT_QUOTE_CONTEXT_HOP_MAX` | 10 | 深度闸：最多换几个锚点。**0 = 不上溯**（老行为） |
| `BOT_QUOTE_CONTEXT_HOP_MIN_LINES` | 3 | 背景薄到不足几行才继续上溯；行数够或认出了讨论对象立刻停 |
| `BOT_QUOTE_CONTEXT_HOP_BUDGET_MS` | 10000 | 时间闸：只约束**第一跳之后**的开销。2000~30000 |
| `BOT_QUOTE_CONTEXT_ARCHIVE_MIN_LINES` | 3 | 存档门槛：这么薄且没讨论对象就不落历史。**0 = 不设门槛** |

关键实现选择：

- **消息池跨跳共享**（`pool` Map，按 `message_id` 去重）：上溯目标常已在上一批返回里（紧邻引用），
  那种跳零成本；只有出池的才再发一批双向分页。日志 `上溯第 N 跳` / `采用上溯第 N 跳的背景 …（共问网关 X 批/Yms）`。
- **只沿"锚点发送人自己"的引用往上游翻**，不追别人消息拉的链 —— 那是别人的话题，翻过去背景就跑偏；
  且只往**更旧**的方向翻（目标已在池内且时间不比锚点旧的直接跳过）。`visited` 集合防 A↔B 互引打转。
- **平手取更深、更薄不覆盖**：新一跳的结果行数不少于已有最佳才替换，所以上溯只会让背景变好，不会变差。
- **`[被引用]` 标记始终给"用户这次真引用的那条"**，中游那条不冒充它（裁剪的"就近"仍按当前锚点时间算），
  否则模型会把上游那段当成用户引用的内容来复述；背景块与存档的标题也按 `hops` 换成「引用链上游的群内对话」。
- **上溯的跳预算紧就不跑 AI 补判**（剩余 < 4s 直接跳过）：一次补判 0.5~6s，不如把时间留给多翻一跳。
- **单跳超时收进剩余预算**（没显式给 `timeoutMs` 时按 4s 封顶）：网关正断窗时宁可少拿一段背景，也不把整轮拖死。

### 25.3 验证

- 单测 62 → **73/73**（`/root/qctest.cjs` 新增 Q1~Q7 / X1~X3 / H6）：上溯拿到上游真对话、老调用点不传 `hopMax`
  时行为与以前逐字节一致、池内跳零网关调用、互引成环被 `visited` 挡住且不覆盖已有背景、
  hopMax=1 到不了第三跳 / 放到 10 能一路溯上去、预算 2s 时第二批网关不打、预算紧时上溯的跳不跑补判、
  两行元问题不落存档 / 认出讨论对象的两行照旧落 / 上溯拿到的背景落存档、四个新键的默认值与 0/钳位/写错退默认。
- 网关调用一律用假 api 注入（按 `message_id` 分批返回），单测不碰真网关。

## 二十六、把「谁说的」钉在 uid 上：few-shot 不再冒充用户发言（11-04 晚）

### 26.1 现象与取证

21:32:03 这轮回复被判为"把不同对象的聊天记录混在一块了"：

```
21:32:03 [回复] …: 他这几轮就干了这些事：追问元芳是什么模型、非让报型号，发了个熊猫头红框眼镜表情包，
                又追问"中间商不也是要模型回复吗"，然后一句"你好"，再问能不能按人筛记录、让元芳总结聊天记录。
                哦对，之前还让我给圆周率一万位，那段是元芳记混了，抱歉。
```

先说被排除的：`histories.json` 里这个 chatKey 16 条（8 轮）全是 <成员甲> 自己的，四轮日志都是
`@前上下文=0条 引用背景=0行 转发=0行` —— **没有跨用户串档**，按 uid 隔离的存储本来就是对的。

真凶要往前一屏：21:30:47 那轮的摘要里有 5 件事根本没人说过，逐字对上了当前人格（橘雪莉）的 few-shot：

| 21:30:47 摘要里的 | `lib/persona.js` 里的示例轮 |
| --- | --- |
| 先问元芳在不在 | `元芳，在吗` → `在——！来案子了？` |
| 点了个游戏程序（太大元芳推了） | `帮我写一个游戏程序吧` → `这案子元芳破不了啦，太大啦哈哈。` |
| 问天气（多云转小雨带伞） | `今天天气咋样` → `侦查一下……多云转小雨，带伞！` |
| 甩了道没给的题（选C还是D） | `这道题选C还是D` → `证据不够，题目拿来～` |
| 好奇元芳是谁 | `你谁啊` → `元芳，超爱推理的那种！` |

拼装时 few-shot 是 `...persona.fewShotTurns(hot)` 直接展开成一串 user/assistant 轮，**紧贴在真实历史前面、
role 完全一样、又没有任何说话人**，模型在"总结聊天记录"这类请求里就把它当成了用户真说过的话。
旁证：另一个群 <群B> 问「这一轮对话讲了什么」，答"就是你问我是谁、问天气…"，那份历史里同样没有天气。

第二个毛病是"真事否认"：`给我输出圆周率一万位` 是 <成员甲> 10-29 22:04 的原话（网关原始记录可查），
但到 21:31:27 那轮已被 8 轮上限挤出上下文，只剩元芳自己上一轮的摘要里还留着 → 21:32 再总结时核不着，
就说成"那段是元芳记混了，抱歉"。假事当真、真事否认，是同一份 prompt 里"没有归属"的两种表现。

### 26.2 口径（每条内容都要和 uid 绑定）

- **真实消息一律带「昵称(uid)」**：昵称会重名/改名，只能当人名；真当身份证的永远是 uid。
  三个通道统一：引用背景（`quote.assembleLines`）、@前群上下文（`takeGroupContext`）、转发块（`forward.renderBlock`）；
  拿不到昵称就退回 `QQ<uid>`，绝不出现无主的行。
- **示例一律带「【语气示例】」标记，且不许以 user/assistant 轮出现**：few-shot 从消息数组挪进 system prompt
  （`persona.fewShotBlock`），头一句写死"不是真实对话，谁都没说过这些话"。
- **归属规则进 system**（`persona.ATTRIBUTION_RULE`）：按 uid 归属、点名才跨界看别人的内容、
  「他/她」指代不明就反问是谁、不许把元芳自己说的话记到别人账上。
- few-shot 热开关照旧：`BOT_FEWSHOT_ENABLED=0` 时整块不注入。

### 26.3 验证

- 单测 73 → **79/79**（新增 A1/A2/P1/P2/P3/F1）：背景行必带 `昵称(uid)`、没昵称退回 `QQ+uid`、
  few-shot 只剩带标记的文字块、关开关即空、归属规则含 uid 口径、转发块多人不再并成一个人。
- 复核口径：日志里每条真实消息都能一句话说清"谁(uid)在什么时间说的"；
  串档类故障应以"该 uid 的历史里出现别人的言论"为判据，而不是凭回复里提到的人名。

### 26.4 追加：@ 段被抹掉，模型只看见空代词（11-05 14:59）

14:59 那轮 `引用背景=4行`，回复却是「"他"指的是谁？元芳这儿没有他的记录可查」。
直连网关复跑锚点（只读）取证：

- 锚点原文是 `<成员甲>` 11-04 21:31:58 发的
  `[CQ:at,qq=<元芳>] 总结一下[CQ:at,qq=<成员乙>] 他的聊天记录` —— 这里的「他」= 被 @ 的 `<成员乙>`。
- 背景行组装先过 `normalizeText`，它把 `[CQ:at,…]` 直接抹成空格（旧代码还额外 strip 掉 reply/at），
  模型看到的锚点只剩「总结一下 他的聊天记录」，指代对象整个消失。
- 另一个洞：讨论对象只从"窗内发过言的人"里挑。`<成员乙>` 这段时间一句没说，
  结构信号与 AI 补判都点不到他，日志是 `讨论对象 0 人`。

口径（`lib/quote.js`）：

- **@ 必须先于 `normalizeText` 处理**：把 `[CQ:at,qq=X]` 换成 `@昵称(uid)`，消息池里没见过这个人就退 `@QQ<uid>`，
  `@全体` 单独写 `@全体成员`。昵称表直接用本次拉回的消息池拼，不发额外网关请求。
- **锚点自己 @ 到的人一律并入讨论对象**（排除 `@全体`、机器人自己、seed 自己）：即便他这段没开口，
  模型也知道「他」就是这个人，而不是"查无此人"。
- **新增 `spoke`（这段真开口的讨论对象数）**：上溯要不要再跳、薄背景落不落存档都改看 `spoke` 而不是 `picked`，
  否则"只 @ 到人、那人没说话"会把 2 行元问题顶成"有料"，把 11-04 15:38 的坑重新踩回来。
- `ATTRIBUTION_RULE` 补两条：行里的 `@昵称(uid)`/`@QQ<uid>` 就是被点到的人，「他/她」优先对齐它；
  他这段没说话就说"这段里没见他开口"，不许当成查无此人。

验证：

- 单测 79 → **83/83**（新增 S1~S4，P3 加 `@` 断言）：@ 渲染成 `@QQ<uid>`、被 @ 的人有发言时渲成 `@昵称(uid)` 且留行、
  只 @ 到人时 `spoke=0` 且薄背景不落存档、锚点只 @ 机器人/全体时不进讨论对象。
- 直连网关按 14:59 的参数复跑：仍是 4 行，锚点行变成
  `[11-04 21:31:58 <成员甲>(<uid>)] @元芳(<机器人uid>) 总结一下 @<成员乙>(<uid>) 他的聊天记录 [被引用]`，
  讨论对象只剩 `<成员乙>`（机器人自己已被 `selfId` 排除）。
- 同一段背景做新旧对照（只调补全接口）：旧背景答"群里这段就你自己在说话呀，'他'是谁？报个名～"；
  新背景答"这段里没见「<成员乙>」开口，就这几行，查不出啥～"。
- 可观测性：检索日志补 `讨论对象 N 人/这段开口 M 人`，不用再翻 hist 猜是"没人被认出"还是"认出了但他没说话"。

### 26.5 同群按需查被 @ 的人的发言（11-05 口径：不用本人同意）

26.4 只是"认得他"，回答仍是"这段里没见他开口"。用户口径：**同一个群的可以查，不需要征得本人同意，
就走这条引用关联上下文的检索**。实测也证明有料：14:59 那个被 @ 的人在本批群历史（200 条，覆盖 10-29~11-05）
里有 47 条发言，只是 21:20~21:41 那段没有。

口径（`lib/quote.js` 的 `pickSpeakerLines`）：

- **只查本轮已拉回的群历史**（锚点前后各 `BOT_QUOTE_CONTEXT_FETCH_COUNT` 条），不额外打网关、不跨群、不查私聊。
- 触发条件：锚点自己 @ 到人（排除 `@全体`/机器人/seed）。窗口里他已经有发言的，那些行照旧由引用背景负责，
  这里只补窗口外的，并去重。
- 取最近的 12 条（`SPEAKER_MAX_LINES`）、最多 600 字（`SPEAKER_MAX_CHARS`），且总预算不超过本轮 `maxChars`；
  按时间升序输出，行首照样「昵称(uid)」。
- **本轮触发消息本身排除**：实测他自己那句也在池子里，不排除会被模型当成旧账复述。
- 补出来的这段**单独立标题、不进存档**（"下面是被点到的 X 在本群最近的 N 条发言…"）：下一轮再问可以重查，
  也避免 history 每轮膨胀；引用存档仍只放引用前后那段。
- `count` 把补的行一并算进去（日志"引用背景=N 行"与真实行数对齐），另给 `atCount` 单独计数。

验证：

- 单测 83 → **88/88**（新增 T1~T5）：窗口没他时补段并计入行数、窗口内已有的不重复、没 @ 人不补段、
  取最新/条数/预算/升序/无昵称退 QQ、本轮触发消息被排除。
- 真实网关复跑 14:59：背景 4 行 → 14 行（补 10 条，11-03 19:48~11-05 14:02），日志
  `被 @ 的人在窗口外还有 35 条群发言，补 10 条`。
- 同一份输入问模型："他指的是谁？"→ 能答出"就是他这 9 条…"；"总结一下他最近在群里聊了啥"→
  "反复 @ 元芳问'你怎么看''再来一次'，还吐槽分人功能不太行"。
- 检索日志补 `另查被@的人 N 条`。

### 26.6 正文里的 @ 也要还原（11-05 18:42 的“还是没找到”）

现象：用户发 `@元芳 总结一下 @<成员乙> 他的聊天记录`（**没有引用**），机器人回“还是没找到——元芳得先知道指的是谁。”

根因：这是**正文通道**，和 26.4/26.5 修的“引用背景行”不是一条路。`plugins/deepseek.js` 的正文是
`normalizeText(session.content)`，`[CQ:at]` 被它抹成空格；同一轮日志 `引用背景=0行`，引用检索根本没跑
（压根没引用），所以 26.4/26.5 的改法都覆盖不到这一条。

改法：

- `lib/segments.js` 新增顶层纯函数 `bodyOfElements(elements, selfId)`：text 原样、at 渲成 `@QQ<id>`（机器人自己的 @ 去掉、
  `@全体` 写 `@全体成员`），其余段沿用 body 口径占位符；插件里 `body` 改用它，拿不到 elements 才回退旧的 `rawText`。
- `@前上下文`（`pushGroupBuffer`）改存同一个 `body`：未唤醒的消息也常 @ 着人，不存就分不清“谁跟谁说话”。
- `flushBucket` 新增 `decorateMentions`：用 `lib/members.loadMembers`（`getGuildMemberList`，60s 缓存、3s 超时）
  把 `@QQ<id>` 补成 `@昵称(uid)`；拉不到就保留 `@QQ<id>`，绝不为补昵称拖死回复。日志 `[正文] @ 目标补昵称 N 人`。
- 同步补**点名检索**：本条 @ 了机器人、正文里还 @ 了别的成员时，调新增的
  `quotes.retrieveSpeakerRecent(session, ids, ...)` 现拉最近群历史（带锚点空返回就退回不带锚点；单次 120 条、6s 上限），
  用 `pickSpeakerLines` 挑「他最近的发言」单独成段。与引用检索不重复：已在引用背景讨论对象里的 id 不再拉。
- `ATTRIBUTION_RULE` 补一条：见到「被点到的 X 在本群最近的 N 条发言」就直接据此总结，不许再说“没找到/不知道指的是谁”。

验证：

- 单测 88 → **96/96**（新增 U1~U3、V1~V5）：正文 @ 渲成 `@QQ<id>`/去掉 @机器人/@全体单列/没 elements 回退；
  点名检索只取被点名人的发言、只 @ 机器人不查、没开口不补段、非群聊不查、锚点空返回退回无锚点。
- 直连网关复跑（`/root/probe_body_at.cjs`，只读）：锚点取最近一条群消息，120 条历史里补到 11 行
  （11-03 19:48 ~ 11-05 18:42），耗时 ~4.5s。
- 模型侧复跑（`/root/probe_body_at_reply.cjs`）：「总结一下他的聊天记录」→ 能总结出“反复 @ 元芳问怎么看/再来一次，
  还吐槽分人不行”；「他指的是谁」→ 能直接点名。旧输入（正文只剩空代词）只会反问“指的是谁”。

#### 补：18:42 那轮其实还叠了另一层——引用 id 在 adapter 层就丢了

回看网关原始记录：18:42:33 那条是 `[CQ:reply,id=-358080342][CQ:at,qq=<机器人>] 再来一次呢`，
也就是说用户是 **引用 14:59 那条「总结一下 @<成员乙> 他的聊天记录」再发“再来一次呢”**；被引用的正文并不在本轮消息里。
而日志里连 `[引用]` 行都没有（只有 `已挂钩 getMessage`），说明 `session.quote` 为空、`findRawReplyId` 也扫不到——
@satorijs/adapter-onebot v6.0.2 在 `adaptMessage` 里先 `elements.shift()` 摸掉 reply 元素再 `await bot.getMessage(...)`，
拉取失败就静默丢掉 quote 节点，id 也跟着消失。插件原来只在自己收到消息时才挂钩 getMessage，
**重启后的第一条带引用消息正好落在这个空档**，于是被当成“没有引用”，模型只能回“还是没找到”。

补丁：

- `quote.js` 的 `maybePatchGetMessage(session)` 拆成 `maybePatchBot(bot)`，插件在 init + `ctx.on('ready')` 就把每个 bot 的
  `getMessage` 挂上（不等第一条消息），拉取失败自动走网关 `get_msg` 兜底。
- `findRawReplyId` 加最后一层：扫平台原始 payload（`session.onebot.raw_message`，段数组格式则看 `message[]`，再兜 `event._data`），
  元素/content 都没了也能找回 reply id。

验证：单测 96 → **100/100**（新增 W1~W4）：原始 CQ 串 / 段数组取 id、找不到不误报、`maybePatchBot` 兜底且不重复包装。

还有一处同源：引用原文自己也带着 at。`parseMsgPayload` 原来直接 `normalizeText`，兜底拉回来的
「总结一下 @某人 的聊天记录」还是会被抹成「总结一下 他的聊天记录」（网关侧看到的就是这样）。
新增 `renderQuoteAt()`（CQ 串与 `<at id="..."/>` 两种形式都认，`@全体` 单独写）·先换 `@QQ<id>` 再过 `normalizeText`，
插件里再 `decorateMentions` 补昵称。单测 100 → **102/102**（Z1/Z2）。

全链路复现（`/root/probe_quote_fix.cjs`，只读）：拿事故现场那条 `[CQ:reply,id=-358080342]…再来一次呢`，
元素/content 里都没 reply → `findRawReplyId` 从 payload 找回；引用原文变成
`@QQ<元芳> 总结一下 @QQ<成员乙> 他的聊天记录`；背景 15 行（锚点行带 `@<成员乙>(uid)` + 他最近 11 条发言）；
模型回复“他这 11 条基本全是‘你怎么看’‘再来一次’”，不再是“还是没找到”。

### 26.7 「唤醒后一条日志都没有」：实例漏挂方法 + 队列吞异常（11-05 19:39）

19:39:39 那一轮日志只有四行——`getMessage 兜底成功`（引用 id 找回）、`quote=有原文`、`[引用诊断] quote=Y`、
`[运营] 群 <群号> 唤醒（被@）`，然后**什么都没有**：没有 `[引用检索]`、没有 `[正文] @ 目标补昵称`、
没有 `[用量]`/`[回复]`，也没有 `[E]`。手机上看就是“不回话”，而且事后翻日志也查不出原因。

两处叠加才造成这种「无痕静默」：

1. **实例漏挂方法**：`renderQuoteAt` 只加进了 `module.exports`，`quote.create()` 的返回对象里忘了加。
   这一轮 `session.quote` 有值（getMessage 补丁生效），插件走的是
   `quoteText = normalizeText(quotes.renderQuoteAt(quote.content))` 这条分支 →
   `quotes.renderQuoteAt is not a function` 同步抛出。
   注意：18:42 那轮是 `quote=N`、走 `fetchQuoteByMsgId` 兜底，`parseMsgPayload` 用的是模块内函数，所以没炸——
   **同一个功能的两个分支，只有“adapter 成功”那条会踩到**，这也解释了为什么上一次修复后没暴露。
2. **异常被队列吞掉**：这段代码在 `flushBucket` 的 `try` 之外（那个 try 只包住模型调用与 sendReply），
   `enqueue` 里又是 `chains.set(key, next.catch(() => {}))`——本意是“别让异常把后续轮次堵死”，
   结果把真正的原因一起吞了：不记日志、不回复、链还照常放行。

修复：

- `lib/quote.js` 的 `create()` 返回值补上 `renderQuoteAt`；注释写明「实例方法必须与插件调用一一对应」。
- `plugins/deepseek.js` 的 `enqueue` 改成链上存一份已了结副本、但**异常先落一行 `[E]`**：
  `[队列] <chatKey> 本轮处理异常（本轮不会回复）：<stack 前 600 字>`。
- 插件启动时自检 quote 实例的方法清单（与单测同一份清单），缺哪个直接 `logger.error` 喊出来——
  比事后看着“没日志”猜便宜得多。

验证：单测 102 → **104/104**（AA1 断言 `create()` 实例挂齐插件用到的 7 个方法；AA2 断言实例上的
`renderQuoteAt` 真能调用）。另只读复现 `/root/probe_adapter_quote.cjs`：按 19:39 的真实形状（`quote=Y`）
走 `renderQuoteAt → retrieveAroundQuote`，不再抛错，背景 14 行（锚点 + 被 @ 的人最近 10 条发言）。

教训（适用于所有“能力模块 + 插件”的结构）：

- 模块导出的纯函数 ≠ 实例方法。插件只拿实例，单测不能只测 `module.exports`。
- **任何 `catch(() => {})` 都必须先留一行日志再吞**，尤其是串行队列、定时器、后台任务：
  “没回复”与“没执行”在外部看起来完全一样。
