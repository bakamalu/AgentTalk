使用框架:
NapCat
Koishi

目的:
接入deepseek机器人到QQ群聊，之后还可能接入微信群

NapCat:
http://127.0.0.1:6099/webui/web_login

opt/napcat/config/webui.json
（2026-10-30 S0：host 已从 `::` 收回 `127.0.0.1`，公网不再可达；
远程访问请走 SSH 隧道：`ssh -L 6099:127.0.0.1:6099 <user>@<SERVER_IP>`）
用户名：napcat-webui
Token： <WEBUI_TOKEN>

<BOT_UIN>

---

## 运行与守护（2026-10-29 配置）

- 守护脚本：`/opt/bot-watchdog.sh`（每 20s 检查，缺进程就拉起）
- systemd 服务：`qqbot-watchdog.service`（已 enable，开机自启 + 崩溃自愈）
- 日志：
  - Koishi：`/opt/logs/koishi.log`
  - NapCat：`/opt/logs/napcat.log`
- 端口：NapCat ws `3001`、Koishi `5140`、WebUI `6099`
- Koishi 配置：`/opt/koishi/koishi.config.js`（protocol: ws，必须同时启用 `http` 与 `server` 插件）
- 依赖修正：`@koishijs/plugin-adapter-onebot@6` + `@satorijs/satori@3`，并用 overrides 锁定单一 `@satorijs/core@4.6.1`

- 机器人自称/人格：改 `/root/deploy/bot.env` 里的 `BOT_SYSTEM_PROMPT`（留空=插件默认提示词）；人格内置在 `bot/lib/persona.js`，用 `BOT_PERSONA=yuanfang|shirley` 热切。
  - **few-shot 示例不是聊天记录**（11-04 修正）：示例轮只当"语气示范"拼进 system prompt，头一句写死
    `【语气示例·不是真实对话】`；关掉看 `BOT_FEWSHOT_ENABLED=0`。以前是当 user/assistant 轮混在历史前面，
    模型在"总结聊天记录"时会拿"今天天气咋样 / 选C还是D"这类示例当用户真说过的话。
- **热生效配置（2026-10-29 新增）**：以下 bot.env 项**改完约 5s 内自动生效、无需重启**（日志会出现 `[热配置] 已重新加载`）：`BOT_ALLOWED_USERS/GROUPS`、`BOT_BLACKLIST_USERS/GROUPS`、`BOT_ADMIN_USERS/GROUP`、`BOT_SENSITIVE_WORDS`、`BOT_SENSITIVE_NOTIFY`、`BOT_QUOTE_REPLY`、`BOT_SYSTEM_PROMPT`、`BOT_PERSONA`、`BOT_FEWSHOT_ENABLED`、`BOT_ACTIVE_WINDOW_MS`、`BOT_GROUP_CONTEXT_MS`、`BOT_GROUP_CONTEXT_MAX`、`BOT_QUOTE_CONTEXT_*`（含 `_HOP_MAX/_HOP_MIN_LINES/_HOP_BUDGET_MS/_ARCHIVE_MIN_LINES`）。
  - 注意：值必须**双引号包裹**（`export KEY="value"`），否则热解析识别不到；只有改**插件代码**或新增未纳入热解析的变量才需按下方流程重启。
- 内容类型：图片/语音/视频/表情等非文本消息会以 `[图片]`/`[语音]` 等占位送入上下文，@ 机器人正常识别唤醒。
- 引用回复（读入）：用户用 QQ「回复/引用」某条消息时，机器人现在能**看到被引用的原文**（会拼成 `[引用 …的消息] …` 一起送入上下文）。注：群聊里仍需 @ 机器人才会被唤醒。
  - adapter 偶尔会**在你之前弄丢引用节点**（重启后第一条带引用的消息最易中：它先摘掉 reply 再异步拉原文，拉不到就不给 quote）。
    现在插件启动（`ready`）就给 `getMessage` 挂钩，且 `findRawReplyId` 会从平台原始 payload 里找回 reply id，
    再走网关 `get_msg` 兜底，不会再把它当普通消息。
  - 群聊还会**以被引用那条为锚点回捞前后的小段对话**当背景（`BOT_QUOTE_CONTEXT_*`，见 `bot/lib/quote.js`）：
    滑动窗口圈时段 → 先按「引用过他 / @ 他 / 紧接他发言接话」的结构信号定讨论对象，一条都没命中才问一次模型。
  - **引用里的 @ 会被还原**（11-05）：`[CQ:at]` 渲染成 `@昵称(uid)`（本次拉回的消息里没他发言就写 `@QQ<uid>`），
    锚点自己 @ 到的人一律当作讨论对象 —— 「总结一下 @他 的聊天记录」里的「他」不会再变成空代词；
    那人这段没开口时，会从**同一批已拉回的群历史**里补一段「他在本群最近的发言」（最多 12 条/600 字，按最新取；
    同群可查、不需要本人同意，不额外打网关、不跨群、不查私聊）。
  - **正文里的 @ 也会还原**（11-05 晚）：用户直接 `@元芳 总结一下 @某某 他的聊天记录`（没有引用）时，
    正文的 at 段不再被 `normalizeText` 抹掉，一律渲成 `@昵称(uid)`（`lib/segments.bodyOfElements` + 成员表补昵称，
    拉不到就留 `@QQ<uid>`；`@前上下文` 同口径）；同时按“同群可查”口径现拉最近群历史，
    补一段「他在本群最近的发言」（`lib/quote.retrieveSpeakerRecent`，单次 120 条、6s 上限，失败不阻断回复）。
    日志：`[正文] @ 目标补昵称 N 人`、`[点名检索] 往前拉 N 条群历史，补 M 条（某人(uid)）`。
  - **沿引用链上溯**（11-04）：用户常引用一条「自己又引用过别人」的消息来追问，锚点周围只剩他自己的两句空话
    （`引用背景=2行` 就是这种）。背景不足 `BOT_QUOTE_CONTEXT_HOP_MIN_LINES` 行且没有讨论对象开口时，会沿他自己
    消息里的引用换个更旧的锚点再找一轮（≤`BOT_QUOTE_CONTEXT_HOP_MAX` 跳、`BOT_QUOTE_CONTEXT_HOP_BUDGET_MS` 预算，
    日志写 `上溯 N 跳`）。真找不着时会答「没记录」，那是群里确实没留下可检索的记录，不是没查。
  - 背景的另一份**压缩存档**会落进会话历史，所以紧接着追问「这事前因后果」不至于只剩一句引用原文；
    但只有两三行、又没人在这段里开口的空话不落存档（`BOT_QUOTE_CONTEXT_ARCHIVE_MIN_LINES`，0=不设门槛）。
  - **排查「明明唤醒了却不回话」**（11-05 19:39）：正常路径是唤醒后 2s（连发合并窗）内出现 `[引用检索]` 或
    `[正文] @ 目标补昵称`，再往后是 `[用量]` + `[回复]`。如果日志停在 `[运营] 群 … 唤醒（被@）` 就再无下文
    （连 `[E]` 都没有），优先看两处：
    ① `[队列] <chatKey> 本轮处理异常（本轮不会回复）` —— 会话队列里的异常现在一定留痕，不再被静默吞掉；
    ② 本次发布后启动时有没有 `[引用诊断] quote 实例缺少方法 …` —— 能力模块漏挂到实例上时，插件在启动就喊出来
       （11-05 那次就是 `renderQuoteAt` 只加在 `module.exports`、忘了加进 `create()`，引用一有原文就整轮静默）。
- 图片识别：**暂不支持**。当前 DeepSeek 官方模型为纯文本，无法看图；需接入支持图片的多模态端点后才能实现（待提供视觉模型配置）。
- @前后上下文（2026-10-29 新增）：不再只响应“@ 的那一句”。
  - **@前**：群里没 @ 机器人的近期消息会先暂存；一旦有人 @ 机器人，就把这些“@前消息（全群、带 [QQ号]）”作为背景一并送入，机器人能看懂前因后果（`BOT_GROUP_CONTEXT_MS` 时间窗、`BOT_GROUP_CONTEXT_MAX` 条数）。
  - **@后**：被 @ 唤醒后默认 120s 内为“活跃窗口”，同一人再发的消息即使不带 @ 也会响应（引用机器人/含关键词同样唤醒）；`BOT_ACTIVE_WINDOW_MS` 可调，=0 则恢复“必须每次 @”。
- 白名单规则（群聊、私聊同理）：`BOT_ALLOWED_GROUPS` / `BOT_ALLOWED_USERS` **为空 = 不设白名单（全部放行）**，有值 = 仅名单内生效；群聊暂时不设白名单（留空）
- QQ 内管理员：`BOT_ADMIN_USERS`（同样空=无管理员），名单内 QQ 可用特权指令：
  - `#状态`（或 `/status`）：查看模型/上下文轮次/白名单/频率闸等运行状态
  - `#重置对话`（或 `/reset`）：清空当前会话的多轮上下文；指令不走频率闸、不调模型
  - `#公告 [置顶] <正文>`：发群公告（网关动作 `_send_group_notice`，见 `bot/lib/notice.js`）。
    群里只能发**当前群**（正文以群号开头也不吃群号）；私聊写法是 `#公告 <群号> [置顶] <正文>`。
    ⚠ **`#公告` 必须在最前面**：`normalizeText` 会把 @ 洗成空格再 trim，所以 `@机器人 #公告 正文` 和
    `#公告 正文 @机器人` 都认，但「将这句话 #公告 正文」这种前面带话的不算指令 —— 会当成普通聊天交给模型，
    而公告不在工具清单里，于是只会得到一句「我发不了公告」。
    限制：正文 ≤`BOT_NOTICE_MAX_CHARS`（默认 200 字）、同群 `BOT_NOTICE_COOLDOWN_MS`（默认 60s）一条、要过敏感词；
    而且**机器人自己在那个群必须是群主/管理员**（QQ 只让这两种身份发公告），发送前先查 role，不够就回人话。
  - 生效范围：默认**仅私聊**；`BOT_ADMIN_GROUP=1` 时群里也可用（需 @机器人）。
    唯一例外是 `#公告`：`BOT_NOTICE_ALLOW_GROUP_ADMIN=1`（线上取 1）时**该群的群主/管理员**也能触发，
    不等管理员名单 —— 权限来自 QQ 自己的群身份，名单外的号想发也得先是那个群的群主/管理员

常用命令：

```bash
systemctl status qqbot-watchdog
systemctl restart qqbot-watchdog
tail -f /opt/logs/koishi.log
ss -lntup | grep -E ':3001|:5140|:6099'
```

# 改配置重启（**仅插件代码变更、或改非热生效变量时需要**；名单/开关/敏感词/人格改 bot.env 会热生效，见上方；详见 ds-roobot-dev.md 第九节）
```bash
# 注意：只 pkill Koishi 不杀守护是没用的——守护内存里缓存的是旧环境变量，
# 20s 后它会带着旧配置把 Koishi 重新拉起；且 KillMode=process 会留孤儿。
systemctl stop qqbot-watchdog
# 自动干掉残留孤儿（无需肉眼找 PID）。k[o]ishi 这种写法不会匹配命令自身，不会误杀 shell
pkill -f "b[o]t-watchdog\.sh"; pkill -f "k[o]ishi start"; pkill -f "k[o]ishi/lib/worker"
sleep 2
systemctl start qqbot-watchdog    # 等 20~30s 守护循环拉起 Koishi

# 验证新配置真的生效（不能只看进程/端口存在）
tr '\0' '\n' < /proc/<koishi_pid>/environ | grep BOT_ALLOWED
grep 白名单 /opt/logs/koishi.log | tail -1
```

---

## SnowLuma（容器模式）运维（2026-10-30 落地）

> 与 NapCat **二选一**，端口同为 `3001`，由 `bot.env` 的 `BOT_GATEWAY=napcat|snowluma` 决定，
> watchdog 会互斥清理另一方。为什么用容器：SnowLuma 原生层要 glibc ≥ 2.34（宿主是 2.31）。

容器 = QQ + Xvfb + SnowLuma supervisor，三者在同一个 `ubuntu:24.04` 里。

```bash
# 状态（容器 / 容器内三类进程 / 端口 5099+3001+5900）
./ops/snowluma/container/run.sh status
# 起停
./ops/snowluma/container/run.sh up
./ops/snowluma/container/run.sh down
# entrypoint 日志（Xvfb/QQ/supervisor 的启停轨迹）
docker logs qqbot-snowluma
```

| 项 | 位置 |
|---|---|
| WebUI | `http://127.0.0.1:5099`（远程走 SSH 隧道），口令在 `/root/deploy/snowluma.env`（600） |
| supervisor 日志 | `/opt/snowluma/logs/snowluma-YYYY-MM-DD.log` + `supervisor.out` |
| QQ 日志 | `/opt/snowluma/logs/qq.log` |
| 配置 | `/opt/snowluma/config/{onebot.json,runtime.json}`（600） |
| hook socket | `/opt/snowluma/run/`（`SNOWLUMA_HOOK_RUNTIME_DIR` 两侧必须一致） |

### 首次扫码（无头机唯一需要人工的一步）

二维码在 **QQ 自己的 X 窗口**里（SnowLuma 不代理登录，WebUI 的二维码只用于 2FA）：

```bash
# 1) /root/deploy/snowluma.env 里 SNOWLUMA_VNC="1"，重启容器
./ops/snowluma/container/run.sh down && ./ops/snowluma/container/run.sh up
# 2) 本机建隧道
ssh -L 5900:127.0.0.1:5900 <user>@<SERVER_IP>
# 3) VNC 客户端连 localhost:5900（无密码），用手机 QQ 扫码
# 4) 登录成功后把 SNOWLUMA_VNC 改回 "0" 再重启（省 ~12MB 内存 + 少一个监听）
```

### 注入是否健康（不要只看进程在）

```bash
grep -E "hook auto-load|awaiting login|pipe connected" /opt/snowluma/logs/snowluma-$(date +%F).log | tail -3
```

正常应看到 `hook auto-load enabled` 与 `pipe connected: PID=…`；若出现
`process enumeration failed`，说明宿主 glibc 又被用上了（不在容器里跑就会这样）。

手动注入（自动注入关掉时）：WebUI → 进程 → 加载，或
`POST /api/processes/<pid>/load`（先 `POST /api/login` 拿 token，带 `Authorization: Bearer`）。

### 切换网关

```bash
# 改成 snowluma（容器）或 napcat（宿主 LD_PRELOAD）后重启守护
sed -i 's/^export BOT_GATEWAY=.*/export BOT_GATEWAY="snowluma"/' /root/deploy/bot.env
systemctl restart qqbot-watchdog
```

> 提醒：`/root/deploy/bot.env` 与 `/opt/snowluma/config/onebot.json` 的 WS token 必须同值，
> 否则 Koishi 一直 401；`./ops/s0-verify.sh` 第 2、10 组会分别查两侧。