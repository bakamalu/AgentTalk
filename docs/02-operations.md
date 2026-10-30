使用框架:
NapCat
Koishi

目的:
接入deepseek机器人到QQ群聊，之后还可能接入微信群

NapCat:
http://127.0.0.1:6099/webui/web_login

opt/napcat/config/webui.json
http://<SERVER_IP>:6099/webui/web_login
用户名：<WEBUI_USER>
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

- 机器人自称/人格：改 `/root/deploy/bot.env` 里的 `BOT_SYSTEM_PROMPT`（留空=插件默认提示词）
- **热生效配置（2026-10-29 新增）**：以下 bot.env 项**改完约 5s 内自动生效、无需重启**（日志会出现 `[热配置] 已重新加载`）：`BOT_ALLOWED_USERS/GROUPS`、`BOT_BLACKLIST_USERS/GROUPS`、`BOT_ADMIN_USERS/GROUP`、`BOT_SENSITIVE_WORDS`、`BOT_SENSITIVE_NOTIFY`、`BOT_QUOTE_REPLY`、`BOT_SYSTEM_PROMPT`、`BOT_ACTIVE_WINDOW_MS`、`BOT_GROUP_CONTEXT_MS`、`BOT_GROUP_CONTEXT_MAX`。
  - 注意：值必须**双引号包裹**（`export KEY="value"`），否则热解析识别不到；只有改**插件代码**或新增未纳入热解析的变量才需按下方流程重启。
- 内容类型：图片/语音/视频/表情等非文本消息会以 `[图片]`/`[语音]` 等占位送入上下文，@ 机器人正常识别唤醒。
- 引用回复（读入）：用户用 QQ「回复/引用」某条消息时，机器人现在能**看到被引用的原文**（会拼成 `[引用 …的消息] …` 一起送入上下文）。注：群聊里仍需 @ 机器人才会被唤醒。
- 图片识别：**暂不支持**。当前 DeepSeek 官方模型为纯文本，无法看图；需接入支持图片的多模态端点后才能实现（待提供视觉模型配置）。
- @前后上下文（2026-10-29 新增）：不再只响应“@ 的那一句”。
  - **@前**：群里没 @ 机器人的近期消息会先暂存；一旦有人 @ 机器人，就把这些“@前消息（全群、带 [QQ号]）”作为背景一并送入，机器人能看懂前因后果（`BOT_GROUP_CONTEXT_MS` 时间窗、`BOT_GROUP_CONTEXT_MAX` 条数）。
  - **@后**：被 @ 唤醒后默认 120s 内为“活跃窗口”，同一人再发的消息即使不带 @ 也会响应（引用机器人/含关键词同样唤醒）；`BOT_ACTIVE_WINDOW_MS` 可调，=0 则恢复“必须每次 @”。
- 白名单规则（群聊、私聊同理）：`BOT_ALLOWED_GROUPS` / `BOT_ALLOWED_USERS` **为空 = 不设白名单（全部放行）**，有值 = 仅名单内生效；群聊暂时不设白名单（留空）
- QQ 内管理员：`BOT_ADMIN_USERS`（同样空=无管理员），名单内 QQ 可用特权指令：
  - `#状态`（或 `/status`）：查看模型/上下文轮次/白名单/频率闸等运行状态
  - `#重置对话`（或 `/reset`）：清空当前会话的多轮上下文；指令不走频率闸、不调模型
  - 生效范围：默认**仅私聊**；`BOT_ADMIN_GROUP=1` 时群里也可用（需 @机器人）

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