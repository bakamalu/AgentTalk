# 微信机器人接入方案说明

> 状态：**方案调研 / 待决策**（尚未实施）。选型决策留痕见
> [`decisions/ADR-0003-wechat-channel.md`](decisions/ADR-0003-wechat-channel.md)。
>
> 本文回答三个问题：**有哪几条路、哪条适配现有架构、落地要改哪些东西**。

---

## 1. 需求澄清（先回答这三个问题再选型）

"引入微信机器人"是一个模糊需求，实际上有三个完全不同的产品，接入方式、风险、成本天差地别：

| 问题 | 选项 | 对架构的影响 |
|---|---|---|
| 机器人跑在**哪种微信**上？ | 个人微信 / 企业微信 / 微信公众号 | 决定适配器选型（见第 2 节） |
| 目标用户**在哪**？ | 微信群 / 企微内部群 / 能被企微触达的微信用户 | 决定是否需要"企微↔微信互通"能力 |
| 可接受的**风险与成本**？ | 封号风险 / 月费 / 开发工作量 | 决定是否排除协议模拟类方案 |

> ⚠️ 前置事实：**个人微信没有官方机器人 API**。所有"个人微信号机器人"都是
> 协议模拟或 hook 方案，均违反微信个人号使用规范，存在**封号风险**。
> 官方合规的自动化入口只有：企业微信（自建应用 / 智能机器人）与微信公众号/小程序。

---

## 2. 候选方案对比

| # | 方案 | 形态 | 官方程度 | 封号风险 | 成本 | Koishi 生态 | 工作量 |
|---|---|---|---|---|---|---|---|
| A | **企业微信·自建应用** | 通讯录应用收发消息 | ✅ 官方 API | 无 | 免费（需一个企微组织） | ✅ 官方 `@koishijs/plugin-adapter-wecom` | **小**（配置即用） |
| B | **企业微信·智能机器人（长连接）** | API 模式机器人，WS 长连接 | ✅ 官方 API | 无 | 免费 | ❌ 需自研 adapter | 中（~1-2 周） |
| C | **Wechaty + padlocal**（个人微信） | iPad 协议云端托管 | 半灰（第三方商业服务） | 🔴 中（账号仍可能被限制） | puppet 服务费（约几十欧元/月）+ 可试用 dot/puppet 仅限测试 | ⚠️ 社区 adapter（`koishi-plugin-adapter-wechaty`，维护弱） | 中 |
| D | **Xbot / wxhook 等本机 hook** | hook Windows/Harmony 微信客户端 | ❌ 逆向 | 🔴 高 | 部分商业授权收费 | ❌ 需自研 bridge | 中高，且**与本项目 Linux headless 环境冲突** |
| E | Gewechat 等 pad 协议框架 | 协议容器 | ❌ 已停止维护 | 🔴 高 | — | ❌ | 排除，仅存档认知 |

### 逐条说明

**A. 企微自建应用（推荐 PoC 起点）**
- Koishi 官方适配器开箱即用，`session` 抽象与现有 onebot adapter 同层，业务层 `deepseek.js` 理论零改动即可跑通私聊。
- 限制：
  - 消息回调是 **Webhook 模式**，要求 Koishi 暴露一个 **HTTPS 公网回调端口**——与现有"只绑 127.0.0.1"的安全策略冲突（见 `02-operations.md`），需加反代/白名单/IP 校验兜底；
  - 自建应用的消息只能发给**企业内部成员**；外部微信用户需通过"客户联系（外部联系人）"能力触达，且该能力要求企微完成**主体认证**；
  - 群聊场景受限：自建应用**不能进普通微信群**，企微内部群可用"群机器人 webhook"（单向推送）或应用消息。

**B. 企微智能机器人·长连接（推荐的目标形态）**
- 企微 2025 年起提供的"API 模式智能机器人"：通过 **WebSocket 长连接**收发消息（`aibot_msg_callback`），
  **无需公网回调地址**——最贴合现有"全回环 + SSH 运维"的部署风格。
- 支持私聊与**群聊**（机器人可被拉入群、支持 @ 触发），与本项目"@ 唤醒"语义天然对齐。
- 代价：Koishi 无官方 adapter，需自研一个（工作量集中在报文转换与媒体下载，见第 4 节）。

**C. Wechaty + padlocal（个人微信，缓议）**
- Wechaty 框架本身活跃，padlocal puppet 是商业托管服务（iPad 协议），相对本机 hook 稳定，
  但本质仍是**非官方协议**，账号被限制/封禁的案例持续存在；
- 与 QQ 侧同理，"网关"和"框架"分离：Wechaty 进程 = 网关角色，Koishi 通过 adapter 对接；
- 社区 `koishi-plugin-adapter-wechaty` 最后停在旧版 Koishi 兼容状态，引入前需评估 fork 维护成本；
- **结论：除非需求方明确要"个人微信号"形态，否则不建议先投入。**

**D/E. 本机 hook / 停止维护的协议框架**
- D 依赖 Windows/HarmonyOS 微信客户端 + 注入，现有 Linux 容器化链路（xvfb、glibc、守护体系）全部不适用，运维成本翻倍；
- E（Gewechat 等）官方仓库已声明停止维护、镜像不再提供，仅剩教程残骸，不应作为新依赖。

---

## 3. 与现有架构的映射

现有分层（`01-architecture.md`）：**网关层 → 框架层(Koishi) → 业务层(deepseek.js) → 模型层**。
微信接入**不动模型层与业务层核心逻辑**，只在网关/框架层平行加一条通道：

```
QQ 用户 ──► NapCat/SnowLuma ──► adapter-onebot ──┐
                                                 ├─► Koishi Session ─► deepseek.js ─► DeepSeek
微信/企微用户 ─► 方案A/B/C 任选其一 ─► 对应 adapter ┘
```

### 3.1 已有的多平台基础

`deepseek.js` 的会话键**已含 `platform` 字段**：

```js
const channelKeyOf = (s) => `${s.platform || 'onebot'}:${s.guildId || 'private'}:${s.channelId || ''}`;
```

即 QQ 与微信的历史、缓冲、活跃窗口**天然隔离**，不会互相污染。这是引入第二平台的最大利好。

### 3.2 网关契约在微信侧的落实情况

业务层对网关的隐含假设（`01-architecture.md` 第 2 节），逐条对照：

| 契约 | onebot 侧现状 | 微信侧（以企微为例） | 业务层需要的改动 |
|---|---|---|---|
| 群/私发送分流 | `send_group_msg`/`send_private_msg` | `appchat/send`（群）/`message/send`（私）；客户联系另走外部接口 | 无（走 Koishi `session.send` 抽象，由 adapter 分流） |
| 引用消息 `get_msg` → `session.quote` | adapter 已实现 | 企微回调**不带被引用消息体**；个人微信无结构化引用 | `quoteReply`/`isQuotingBot` 在微信侧**优雅降级为关闭** |
| 撤回事件 | `message-recall` | 企微支持撤回回调；Wechaty 有 `message-recall` 事件 | 按事件名兼容即可，非阻塞 |
| 结构化 @ 判定 | `element.type === 'at'` | 企微智能机器人有明确 `@` 文本 + userid 可解析；个人微信**只有纯文本 @昵称** | `isAtBot()` 增加文本兜底分支（`platform` 分支处理） |
| 图片获取 | CQ 段 URL，服务端下载转 base64 | 企微 `media_id` 需调 `get_media` 下载；Wechaty 是 FileBox | 扩展 `resolveImage()` 的取图路径（见 4.3） |
| Markdown 清洗 | `toPlainText()` 去 MD（QQ 不渲染） | 微信同样不渲染 Markdown | **直接复用**，无需改 |
| 分段发送 | 500 字/最多 3 段 | 企微 text 上限约 2048 字节（UTF-8），智能机器人卡片/文本各有上限 | 按 `platform` 配置化上限 |
| 频率闸 | ratePerMinute=6 | 企微按接口有分钟级频控（应用消息约 同时在线人数相关配额）；Wechaty 建议人工节流 | 每平台独立配额，沿用现有闸结构 |
| 白名单/黑名单 | QQ 号 | 企微 userid / 微信外部联系人 ID（`wm...` 形态） | 名单**按平台加前缀**（见 4.2） |

> 结论：**约 70% 逻辑直接复用**，改动集中在 `isAtBot`、图片、quote 降级、名单键四处，
> 全部是"平台差异点加 `platform` 分支"，不破坏 OneBot 侧行为。

---

## 4. 业务层（deepseek.js）改造清单

按依赖顺序排列，每步可独立验证、独立回滚：

### 4.1 平台分支收敛
现状代码里 `platform` 只出现在键拼接。引入第二平台后，把散落假设收敛到一个查表点：

```js
const PLATFORM_CAPS = {
  onebot:   { quote: true,  atStructured: true,  imageSource: 'url',     textMax: 500 },
  wecom:    { quote: false, atStructured: true,  imageSource: 'media_id', textMax: 1600 },
  wechaty:  { quote: false, atStructured: false, imageSource: 'filebox',  textMax: 500 },
};
const caps = (s) => PLATFORM_CAPS[s.platform] || PLATFORM_CAPS.onebot;
```

- `isAtBot()`：`caps.atStructured === false` 时退化为文本匹配 `@<bot昵称>`；
- 分段：`splitText(content, caps(s).textMax)`；
- quote 相关逻辑入口先判 `caps.quote`，不支持平台直接跳过。

### 4.2 名单键按平台命名空间化
`BOT_ALLOWED_USERS` / `BOT_ADMIN_USERS` 等值支持 `platform:id` 写法，
无前缀默认 `onebot:`（**保持对现有配置的完全兼容**）：

```
export BOT_ALLOWED_USERS="onebot:10001,wecom:zhangsan,wechaty:wxid_abc"
```

匹配时对 `session.userId` 拼 `${platform}:${userId}` 后查表。群同理。

### 4.3 图片路径扩展
现有链路：CQ 图片 URL → 服务端下载 → base64 data URL → DeepSeek。
企微链路：`media_id` → `GET /cgi-bin/media/get?media_id=...`（access_token）→ 同样转 base64。
Wechaty 链路：`message.toImage().toFile()` 拿字节流。
三条路径统一汇到"拿到 buffer → 转 data URL"这一个复用点。

### 4.4 系统提示微调（可选）
`BOT_SYSTEM_PROMPT` 增加平台感知后缀（如微信侧自称与排版约定：不用 Markdown、少用空格对齐），
热配置机制不变。

### 4.5 状态持久化兼容
`histories.json` 的键自带 `platform` 前缀，**无需迁移**。唯一注意点：
微信侧用户 id 长度/字符集与 QQ 不同，确认 JSON 键无转义问题（现有实现为字符串直接拼接，无风险）。

---

## 5. 部署方案要点

### 5.1 方案 A（官方 wecom adapter，PoC）

新增环境变量（进 `bot.env.example`，真实值仍只在服务器 600 权限文件里）：

```sh
export WECOM_CORP_ID="<CORP_ID>"
export WECOM_AGENT_ID="<AGENT_ID>"
export WECOM_SECRET="<APP_SECRET>"
export WECOM_TOKEN="<CALLBACK_TOKEN>"
export WECOM_ENCODING_AES_KEY="<AES_KEY>"
```

`koishi.config.js` 增加：

```js
'@koishijs/plugin-adapter-wecom': {
  corpId: process.env.WECOM_CORP_ID,
  agentId: Number(process.env.WECOM_AGENT_ID),
  secret: process.env.WECOM_SECRET,
  token: process.env.WECOM_TOKEN,
  encodingAESKey: process.env.WECOM_ENCODING_AES_KEY,
},
```

网络与安全：
- 企微回调要求 **80/443 + HTTPS + 可验证 URL**，需在现有 5140 之外开对外端口并配 Nginx/Caddy 反代
  （参考 `02-operations.md` 中"server 插件绑回环"的既有原则：**只反代 wecom 回调路径，不暴露 Koishi API**）；
- 回调域名需 ICP 备案主体吗？——企微可信域名要求认证主体一致或授权，**采购域名前先确认**；
- 上线后沿用 `ops/s0-verify.sh` 模式补一组微信通道断言（回调 200、token 握手、收发各一条）。

### 5.2 方案 B（智能机器人长连接，自研 adapter）

- 新建 `bot/plugins/adapter-wecom-robot.js`：出站 WebSocket 连企微长连接网关，
  实现 `aibot_msg_callback`（收）与消息发送接口（发），翻译为 Koishi `session` 事件；
- **优点**：不开任何公网端口，安全模型与现状完全一致；天然支持群聊 + @ 场景；
- 参考文档：企业微信开发者中心《智能机器人长连接》（外链收进 `05-external-links.md`）；
- 工作量拆解：连接鉴权 1d / 收消息映射 2d / 发消息+媒体 2d / 群@语义 1d / 测试与守护接入 2d。

### 5.3 方案 C（Wechaty padlocal）

- 独立进程跑 Wechaty（Docker），Koishi 经社区 adapter 或自写薄 bridge 连接；
- 网关层变成"Wechaty 容器"，与 NapCat/SnowLuma 在架构中**平级**，watchdog 需扩一个 `BOT_WECHAT_GATEWAY` 巡检项；
- 登录靠扫码，**treatment 与 SnowLuma 二维码登录类似**（可复用 x11vnc/截图推送经验，见 `04-migration-snowluma.md` 附录）；
- 上线前必读第 7 节风险。

### 5.4 守护与重启

无论选哪条：
- `ops/bot-watchdog.sh` 现按 `BOT_GATEWAY` 切换 QQ 侧网关，同理新增微信通道开关
  `BOT_WECHAT_ENABLED`，未启用时 watchdog 跳过对应巡检，**不改现有 QQ 链路行为**；
- 插件代码改动一律走标准重启流程（热重载只覆盖 `bot.env` 配置，见既有规范）。

---

## 6. 分阶段实施路线

| 阶段 | 内容 | 验收标准 | 回滚方式 |
|---|---|---|---|
| **W-x1 PoC** | 方案 A：官方 adapter + 企微私聊跑通 `deepseek.js`（不改业务代码） | 企微私聊发问 → 收到 AI 回复；QQ 侧回归 `s0-verify.sh` 全绿 | 配置项注释掉即回滚，代码零改动 |
| **W-x2 平台化** | 第 4 节改造清单 4.1/4.2/4.3 落地；`PLATFORM_CAPS` 进代码 | 双平台并发消息互不串历史；图片识别在微信侧可用 | 每步独立 commit，可单步 revert |
| **W-x3 群聊语义** | @ 唤醒、活跃窗口、群缓冲在微信侧对齐 QQ 行为 | 微信群里"@后连发 3 条窗口内消息"表现与 QQ 一致 | 开关 `BOT_WECHAT_GROUP=0` 退化为仅私聊 |
| **W-x4 形态决策** | 评估是否需要 B（自研长连接 adapter）替代 A（去掉公网回调） | ADR-0003 补充实施结论 | 保持 A 运行不切换 |
| （可选） | 方案 C 个人微信 | 仅在需求方明确接受封号风险与服务费后立项 | 独立容器，随时可整体移除 |

---

## 7. 风险登记

| 风险 | 等级 | 说明 | 缓解 |
|---|---|---|---|
| 个人微信封号 | 🔴 高 | 方案 C/D 本质违反使用规范；新号/高频/异地登录是三大触发点 | 老号+低频+同省 IP+节流闸；**先小流量灰度** |
| 公网回调面扩大 | 🟡 中 | 方案 A 需要暴露 HTTPS 端口，历史上已因 server 插件吃过暴露公网的教训 | 反代只放行回调路径；Koishi API 保持 127.0.0.1；s0 断言加端口检查 |
| 第三方 adapter 停更 | 🟡 中 | wechaty 系 Koishi adapter 社区维护弱 | 引入前锁定版本 + fork 预案（同 onebot adapter 的 overrides 教训） |
| 跨平台行为漂移 | 🟡 中 | @ 判定/quote 降级在两平台不一致，用户感知割裂 | `PLATFORM_CAPS` 显式声明能力，不在文档外的隐式分支 |
| padlocal 服务商业风险 | 🟢 低 | 单一供应商，价格/可用性不受我方控制 | 方案 C 缓议；若实施则 bridge 层保留换 puppet 的余地 |
| 状态键不含 botId 的旧问题被放大 | 🟢 低 | 多平台后同群多 bot 概率上升（见 `01-architecture.md` 3.1） | 若微信侧也拉机器人群，把 `selfId` 并入键的改造提前做 |

---

## 8. 给决策者的三个问题

1. **产品形态**：先做企业微信（合规、免费、PoC 一天可见），还是必须个人微信号（风险自理）？
2. **公网暴露**：是否接受方案 A 需要的 HTTPS 回调端口？不接受则直接走方案 B（自研，+1~2 周）。
3. **成本**：若走个人微信，是否接受 padlocal 月度服务费与备号成本？

对以上问题的回答写入 `decisions/ADR-0003-wechat-channel.md`（当前为"提议中"草稿），选定后本文档相应小节转为实施记录。
