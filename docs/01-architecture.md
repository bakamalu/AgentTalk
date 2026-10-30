# 架构与关键机制

## 1. 分层

```
QQ 用户
  │
  ▼
QQ NT 客户端（Linux，headless 需 xvfb）
  │  注入（LD_PRELOAD / native hook）
  ▼
网关层：NapCat（现）/ SnowLuma（迁移目标）
  │  OneBot v11 over WebSocket，127.0.0.1:3001
  ▼
框架层：Koishi 4.18 + @koishijs/plugin-adapter-onebot@6
  │  Session 抽象
  ▼
业务层：plugins/deepseek.js
  │  OpenAI 兼容 HTTP
  ▼
模型层：DeepSeek /chat/completions
```

**边界原则**：业务层不依赖具体网关实现，只依赖 OneBot v11 语义。
这是"换网关不动插件"的前提，也是迁移方案成立的基础。

---

## 2. 网关契约（业务层对网关的最小假设）

| 契约 | 业务层用法 | 迁移风险 |
|---|---|---|
| `send_group_msg` / `send_private_msg` | `bot.internal.sendGroupMsg/PrivateMsg`，群聊必须走前者（否则 retcode 1200） | 🔴 高 |
| `get_msg` | adapter 拉取被引用消息 → `session.quote` | 🔴 高 |
| `message-recall` 事件 | 按 `messageId` 从历史剔除 | 🟡 中 |
| 报文段格式 `array` | `[CQ:image]` → `[图片]` 占位 | 🟡 中 |
| `at` 段 | `element.type === 'at'` 唤醒判定 | 🟡 中 |
| 心跳/重连 | 30s 心跳、5s 重连 | 🟢 低 |
| `message_id` 语义 | 撤回定位；**SnowLuma 为有符号 int32（负数合法）** | 🟡 中 |

---

## 3. 关键机制

### 3.1 会话状态键

```js
const channelKeyOf = (s) => `${s.platform}:${s.guildId || 'private'}:${s.channelId}`;
const chatKeyOf    = (s) => `${channelKeyOf(s)}:${s.userId}`;
```

| 键 | 用途 |
|---|---|
| `channelKey` | 全群缓冲（@前消息）、不含用户 |
| `chatKey` | 多轮历史、活跃窗口、串行队列 |

> ⚠️ **键里没有 botId**。同一群接入两个机器人（不同 QQ 号）会互相污染：
> 历史共享、`groupBuffer` 先取先删、`activeUntil` 被任一 bot 点亮。
> 若要支持多号同群，需把 `selfId` 并入 `channelKey`，并迁移已有 `histories.json`。

### 3.2 @ 前缓冲 / @ 后活跃窗口

- 未被 @ 的群消息进 `groupBuffer`（按 `BOT_GROUP_CONTEXT_MS` / `_MAX` 裁剪）
- 被 @ 时 `takeGroupContext()` 取快照拼成背景，**用完即删**，不写历史
- 唤醒后 `activeUntil[chatKey] = now + BOT_ACTIVE_WINDOW_MS`
- `BOT_ACTIVE_WINDOW_MS=0` → 退化为"每次必须 @"

### 3.3 热配置

- 每 `BOT_HOT_INTERVAL_MS`（默认 5000，下限 2000）巡检 `BOT_ENV_FILE`
- 用**内容 hash** 判断变化（不是 mtime——同秒连续写入会漏检）
- 优先级：`bot.env 文件值 > 插件 config > process.env > 默认`
- 只认 `export KEY="value"`，**值必须双引号，且不能有行内注释**

热生效变量：`BOT_ALLOWED_*` `BOT_BLACKLIST_*` `BOT_ADMIN_*` `BOT_SENSITIVE_*`
`BOT_QUOTE_REPLY` `BOT_SYSTEM_PROMPT` `BOT_ACTIVE_WINDOW_MS` `BOT_GROUP_CONTEXT_*`

### 3.4 发送路径（含 4 道闸）

```
回复文本
  → toPlainText()      去 Markdown（QQ 不渲染）
  → splitText()        500 字 / 最多 3 段
  → 频率闸             ratePerMinute=6, minIntervalMs=1500
  → sendReply()        群聊 send_group_msg / 私聊 send_private_msg
  → 超时(60s)         归类"投递未知"，不重发
```

### 3.5 同会话串行

`chains: Map<chatKey, Promise>` 保证同一会话多条消息顺序处理，避免上下文交错。

---

## 4. 已知限制

| 限制 | 原因 | 影响 |
|---|---|---|
| 不支持图片识别 | DeepSeek 端点为纯文本 | 图片以 `[图片]` 占位进上下文 |
| 历史为进程内 + 单文件 JSON | 无数据库 | 会话多时 `histories.json` 膨胀，已做 `slice(-32)` 裁剪 |
| 状态键不含 botId | 历史设计 | 多号同群会串（见 3.1） |
| 热配置不覆盖代码类参数 | 只解析名单/开关/词表/人格 | 改逻辑仍需重启 |

---

## 5. 为什么不用别的方案

- **不用 DSH / qq-bridge**：`@deepseek/harness` 无 Linux 正式发行包（详见 `03-dev-log.md` 第一节）。
- **不把业务逻辑写进网关**：SnowLuma 明确"reply logic belongs in consumers"，网关只做协议。
- **不换掉 Koishi**：插件生态与中间件是已有资产，重写成本远大于收益。
