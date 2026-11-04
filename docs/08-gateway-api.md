# 网关接口速查（OneBot11 / SnowLuma）

> **要做新功能时先在这里查有没有现成动作**：有就照着调，调完把参数口径与实测注意补进下面
> 「已接入的接口」小节，方便下次直接复用（不用再猜一次方法名）。
>
> 资料三处等价，任选其一（**优先本地，线上慢且大文件容易超时**）：
>
> - 本地快照 `/root/snowluma-docs/`：`catalog.json`（193 动作机器可读目录）、
>   `openapi-snowluma.json`、`llms.txt` / `llms-full.txt`（整站正文）、`docs-mdx/`（54 篇中英正文）
> - 本地克隆：`/root/code/SnowLumaDocs`（文档站源码，`public/api/catalog.json` 是上游随网关版本同步的）
> - 线上文档站：<https://snowluma.github.io/zh/docs/api>
>
> 更新方式：`bash scripts/crawl-snowluma-docs.sh && node scripts/gen-gateway-api.js`
> —— 脚本默认从本地克隆 copy（瞬间完成），只有 `llms*.txt` 必须走线上（route 运行时生成）；
> `GIT=1` 先 ff-only 拉克隆，`ONLINE=1` 强制走线上，`PAGES=1` 顺手存几页 HTML，
> `CURL_MAX=秒` 调超时（默认 240；90 会把 320KB 的 llms-full 掐在半路）。
> 生成的速查表只重写文末 AUTO 标记之间的内容，标记以上的手写口径不动。

## 一、调用口径（本项目实测）

1. **传输**：本机 SnowLuma 只开了 **WS `127.0.0.1:3001`**（文档里的 HTTP `:3000` 实测没监听）。
   Koishi 的 onebot adapter 就是主动连这条 WS。
2. **鉴权**：`?access_token=<NAPCAT_WS_TOKEN>`，或 `Authorization: Bearer <token>`。
   不带 token 直连会在握手阶段就被拒——老的「临时直连网关」兜底正是没带 token，从来没成功过。
3. **应答信封**：`{ status, retcode, data, message, wording }`，**只有 `retcode === 0` 是成功**；
   收到回包 ≠ 成功，业务失败也照样回。
4. **在 Koishi 里怎么调（11-03 踩过的坑）**：`@satorijs/adapter-onebot` 的 `internal`
   **没有 `request()` 方法**，能用的只有私有 `_get(action, params)`（内部 `_request`，成功返回
   `data`，`retcode !== 0` 抛 `SenderError`）和 `Internal.define(...)` 生成的驼峰方法。
   - 驼峰方法不能乱用：`Internal.define("get_group_msg_history", "group_id", "message_seq")`
     的第二个参数名是 `message_seq`，而 SnowLuma 要的是 `message_id`，名字对不上会被**静默忽略**
     （等于没给锚点，返回的是最新若干条）。
   - 所以一律走 **`_get(动作名, 具名参数)`**，统一收在 `bot/lib/onebot.js` 的 `callApi`
     里（`internal._get` → `internal.request` → 带 token 的临时直连 WS 三档降级，
     每档失败原因都进日志——避免再出现「方法名不存在 → 特性静默失效」）。
5. **`callApi` 的 `timeoutMs` 是整次调用的总预算**，不是每档各等一遍（否则串起来 3×，回复主链路
   会被拖死）。默认值来自热键 `BOT_GW_TIMEOUT_MS`（改 `bot.env` 即时生效、不用重发版），线上取
   **12000**（依据见第三节）；重试间隔来自 `BOT_GW_RETRY_INTERVAL_MS`（默认 1200，填 `0` = 关掉重试）。
   返回 `{ ok, data, via, ms, attempts, offline, business, capped, error }`：`via` 走的那一档、
   `ms` 实际耗时、`attempts` 试了几轮，都进日志（慢网关 / 撞超时 / 撞断窗一眼可辨）。
   预算剩余不足 `RETRY_MIN_LEFT_MS`(700ms) 就不再开新一轮，各档至少留 `TIER_MIN_MS`(300ms)
   —— 所以预算只比 1s 大一点就等于没重试，别踩。
6. **失败分两类，处理方式相反**（都在 `bot/lib/onebot.js`）：
   - `offline`（连不上）：命中 `OFFLINE_HINT` 词表 —— `this._request is not a function`、
     `ECONNREFUSED / ECONNRESET / EPIPE / socket hang up / Channel closed / 超时` 等。
     ⚠ `this._request is not a function` **不是方法名又猜错了**：adapter 在 socket close 时
     `delete bot.internal._request`（`@satorijs/adapter-onebot/lib/index.js` v6.0.2：连接建立时挂上、
     close 时删掉，line 645/647），所以这句的真实含义是「这一刻没连着网关」。
     这类**在预算内每隔 `retryInterval` 重试一轮**，等 adapter 自己重连上；
   - `business`（网关回了 `retcode !== 0`）：参数错 / 没权限 / 消息不存在，重试和换档都没意义，
     **任一档拿到业务失败就整次收手**——否则接着试 ws 档，那下的 `ECONNREFUSED` 会把这次误判成离线。
7. **离线冷却（防串行放大）**：一轮回复串着打 `历史 ×2 → get_msg → get_forward_msg`，真断线时每个
   各等满预算就是十几秒。第一个调用判出离线后压 `COOLDOWN_MS=8000` 的冷却窗，窗内后续调用预算
   砍到 `COLD_BUDGET_MS=1200` 且不重试（`error` 尾会写「撞在离线冷却窗内故走快失败」），
   任一调用成功立即解除。

## 二、已接入的接口

### `get_group_msg_history` —— 拉群历史（引用周边检索用）

| 参数 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `group_id` | uint | ✔ | | 群号 |
| `message_id` | int | | 0 | 锚点消息 id；0 = 不带锚点 |
| `count` | int | | 20 | 条数 |
| `reverse_order` | bool | | true | **仅 `message_id != 0` 时生效**：true = 锚点及更旧，false = 锚点及更新 |

返回 `{ messages }`：每项是 OneBot 消息事件（`time` 为 unix 秒、`message_id`、`message_seq`、
`sender.user_id / card / nickname`、`raw_message`（CQ 串）、`message`（段数组）、`real_id`）。

实测注意：

1. **`message_id` 可正可负**（线上见过 `-1183072755`）。不能按 id 大小排序、也不能当自增游标，
   排序一律用 `time`。
2. 不带锚点时返回的是**最近 `count` 条**（升序）。实测 200 条只够回到当天 14:50，
   而 17:05 发的言被 20:10 引用时已经不在里面了 → 所以检索改成**按锚点双向分页**
   （`reverse_order` 各一次，合并后按 `message_id` 去重）。
3. **条数与耗时强相关**（同群实测，完整基线见第三节）：`count=60` ≈ 0.9~2.8s，
   `count=200` 稳态 ≈ 3.8s（返 174 条），但 11-03 冷/忙时测到过 13.7s。引用检索在回复主链路上，
   调太大一旦撞上慢网关就被预算整个砍掉，所以 `BOT_QUOTE_CONTEXT_FETCH_COUNT` 默认 **60（单侧）**。
4. 网关返回顺序不依赖：合并后自己按 `time` 升序。
5. 锚点正好是**最新一条**时，`reverse_order=false` 那页只返回锚点自己（1 条）——这是正常结果，
   不是失败，日志里"锚点后 1"不用当问题查。
6. **锚点常常是隔天甚至隔两天的**（11-04 实测：11-02 17:05 发的被 11-04 13:11 引用；11-03 16:14 的被
   13:09 引用），所以检索日志与背景行里的时间一律 `MM-DD HH:MM`；只写 `HH:MM` 时跨天串
   （`覆盖 22:14~13:11`）判不出是哪两天，只能手工翻网关原始记录。
7. **窗内只剩「提问者自己 + 机器人当时的回答」时背景会很薄**：候选参与人与背景组装都排除 `selfId`，
   而"引用旧消息再问一次"这种场景窗内往往就是这两种人（11-04 13:09 实测只有 2 行）。
   复核不要只靠检索日志，直连网关把锚点前后各 60 条带日期打出来看：`/root/probe_ctx.cjs`。

调用位置：`bot/lib/quote.js` 的 `retrieveAroundQuote()`（两页并发）。

### `get_msg` —— 取单条消息

参数：`message_id`（必填）。返回消息事件本体（文档注明是首次收到时存的副本，已去掉
`post_type/self_id`、附带 `real_id`、并刷新图片 URL）。

实测：`message` 是段数组时 `raw_message` 仍是 CQ 串，两种都解析得了
（`bot/lib/quote.js` 的 `parseMsgPayload`）。

调用位置：`bot/lib/quote.js`（引用原文兜底 + `getMessage` 补丁）、
`bot/lib/forward.js`（`detectForwardIdOfMessage` 判断被引用的是不是转发卡片）。

### `get_forward_msg` —— 展开合并转发

参数：`id`（转发 id）**或** `message_id`，文档说明二者取一；我们两个都带上以防不同网关差异。
返回 `{ messages }`：转发内的子消息节点数组（字段不固定，首次展开会记一条结构探针日志）。

调用位置：`bot/lib/forward.js` 的 `fetchNodes()`。

### `get_group_member_info` / `_send_group_notice` —— 群身份与群公告（#公告 指令用）

`get_group_member_info`：`group_id + user_id + no_cache`，返回里的 **`role` 只有 `owner`/`admin`/`member` 三种**
（11-04 实测同一个群里机器人是 `member`、提问的人是 `owner`）。**发公告前必须先查它**：QQ 只让群主/管理员发公告，
`member` 去发必被拒 —— 先查再发才能把「我在你们群只是普通成员，先把我提上去」这种人话回给用户，而不是等腾讯报错。

`_send_group_notice`（官方 catalog 参数）：`group_id`、`content` 必填；`image`（本地路径/URL/base64）、
`pinned=0|1` 是否置顶、`type=1 普通 / 20 新成员公告`（catalog 自己建议改用 `send_to_new_members`）、
`is_show_edit_card=1`、`ti…`（截断，完整看 catalog）。
我们只接了 `group_id + content + pinned`（`bot/lib/notice.js`）：公告是**全员弹窗**，每多接一个参数就多一分误发面积。

实测注意：

1. `get_supported_actions` 回 **retcode=1404（未实现）** —— 别指望开机自检「这版网关到底支持哪些动作」，
   只能照文档名字直接调、失败时把 retmsg 记全；
2. `_get_group_notice`（读群公告）retcode=0、正常返回数组（没有公告时是 `[]`）——说明公告这族动作在 SnowLuma 侧是通的，
   「发不出去」基本等于**身份不够**，不要先怀疑接口缺失；
3. 这两个动作都走 `callApi` 第一档 `internal._get(action, params)` 就通（adapter 没给它们生成驼峰方法，
   按方法名去找会像 11-03 那样静默失效）。
4. 本项目的入口是管理员指令 `#公告`（`bot/plugins/deepseek.js` 的 `handleAdminCommand` → `bot/lib/notice.js`），
   **刻意没做成模型工具**：公告会推送/弹窗给全群，不能让模型自己决定发不发。所以「引用一句 + 说声发公告」
   是发不出去的（那句会当普通聊天进模型，日志里 `工具=未调用`）；指令要求 `#公告` 出现在正文最前面
   （@ 会被洗成空格，所以 `@机器人 #公告 …` 与 `#公告 … @机器人` 都能识别）。

## 三、网关抖动口径（实测数字，写容错前先读）

SnowLuma 侧的 QQ 会话会**周期性重登**，它自己日志里一轮长这样：
`[Bridge] session closed` → `Action ingress quiesced` → `[Bridge] session started` → `[Hook] login detected`
→ 载入好友/群 + `member warmup`（4 群 1003 人 ≈ 5s）→ `[OneBot] session started`
→ `[OneBot.WS-Server] [koishi] listening 127.0.0.1:3001/`。
这中间 **3001 是关着的**（`connect ECONNREFUSED`）；Koishi 侧就是
`adapter normal, will retry in 5s...` →（若干次 `failed to connect ... code: 1006`）→ `adapter connect to server`。

「断 → adapter 重连上」的耗时（10-30 ~ 11-04 的 koishi 日志，184 个样本，统计脚本 `/root/gapstat2.py`）：

| 分位 | p50 | p75 | p90 | p95 | max |
|---|---|---|---|---|---|
| 秒 | 10 | 13 | 16 | 19 | 28 |

预算给多少就最多盖得住多长的窗（重试间隔 1.2s）：

| 预算 | 6s | 8s | 10s | **12s** | 15s | 20s |
|---|---|---|---|---|---|---|
| 覆盖率 | 20% | 43% | 56% | **73%** | 88% | 96% |

- 频率很不均：清淡时几小时一次（11-04 01:36 / 05:36），发作时每 1~5 分钟一次
  （11-03 全天 88 次，19~20 点每小时 20 次以上）。容器 `qqbot-snowluma` `RestartCount=0`、
  QQ 进程 PID 不变 → 不是进程崩，是账号侧会话重登，我们改不了，只能等；
- **预算是上限、不是固定等待**：网关通着时几乎零成本，只有真断着才把时间花满，
  所以按 ≥p75 取 12s，而不是因为「怕回复慢」留 6s；
- 耗时基线（走第三档临时直连、每次新 socket）：首包冷启 1.3~4.2s；稳态 `count=5` ≈ 0.2s、
  `count=60` ≈ 0.9~2.8s、`count=200` ≈ 3.8s。同一条长连接复用则 `count=5` ≈ 0.14~0.29s、
  `count=60` ≈ 0.92~0.96s（`/root/lat.out`、`/root/lat2.out`）——第一档 `internal._get`
  复用 adapter 那条长连接，所以平时比自建连接快得多；
- 引用检索撞上断窗时日志写「网关离线（连不上，已在 N ms 预算内重试 N 轮仍没碰上重连）」，
  看到这行就是环境问题，不是口径错；写「网关未返回历史消息」才要回去查参数。

## 四、还没接、但查一下就能用的（只记名字）

- `get_friend_msg_history`：私聊消息历史，参数口径与群版同款（`user_id + message_id + count + reverse_order`）——
  要做「私聊也带前情」就用它，别再自己攒缓冲。
- `forward_group_single_msg` / `forward_friend_single_msg`：让服务端直接把某条消息转发到群/好友，
  不用我们自己重发内容。
- `mark_group_msg_as_read`、`get_msg_emoji_likes`、`set_essence_msg`、`get_group_at_all_remain`：
  已读标记 / 表情回应 / 精华 / @全体剩余次数。
- 全量清单见下面的速查表（193 个动作，按分类分组）。

<!-- AUTO-BEGIN：以下由 scripts/gen-gateway-api.js 生成，别手改 -->

## 全部动作速查（共 193 个，来源 /root/snowluma-docs/catalog.json）

带 ✅ 的是本项目已接入的（用法/参数口径见上面手写小节）。参数列里 `?` 表示可省、`=值` 表示文档给的默认值。

### 信息（5）

| 动作 | 说明 | 参数 | 返回 |
|---|---|---|---|
| `can_send_image` | — | — | 能力查询结果。 |
| `can_send_record` | — | — | 能力查询结果。 |
| `get_login_info` | — | — | 当前登录账号的 QQ 号与昵称。 |
| `get_status` | — | — | 运行状态。`online` 表示账号在线；`good` 表示已确认的收发链路健康状态。 |
| `get_version_info` | — | — | 实现与协议版本信息。 |

### 好友（3）

| 动作 | 说明 | 参数 | 返回 |
|---|---|---|---|
| `delete_friend` | 删除好友 | user_id, block=false | — |
| `get_friend_list` | 获取好友列表 | — | 好友列表数组，每项含 QQ 号、昵称与备注。 |
| `get_stranger_info` | 获取陌生人信息 | user_id | 用户资料：QQ 号、昵称、好友备注、性别、年龄与个性签名，命中资料时另含等级、企点标志与企业名称。 |

### 扩展（115）

| 动作 | 说明 | 参数 | 返回 |
|---|---|---|---|
| `_del_group_notice` | 删除群公告（fid 或 notice_id 二选一） | group_id, fid?, notice_id? | — |
| `_get_friend_dress` | 获取指定 QQ 号正在使用的个性装扮（挂件/名片/来电/输入状态等） | user_id | 装扮信息；目标未使用任何可查询装扮时 items 为空数组。网络失败、未登录态/风控、页面改版、返回账号与请求不一致时返回失败并附具体原因 |
| `_get_group_notice` | 获取群公告 | group_id | 普通公告与新成员公告的合并数组；send_to_new_members 标识后者 |
| `_get_model_show` | 获取机型展示（兼容 mock） | model= | 数组，每项含 variants（回显请求的机型名与 need_pay 标记）。 |
| `_mark_all_as_read` | 标记全部已读 | — | — |
| `_send_group_notice` | 发送群公告（支持置顶、弹窗、新成员、群昵称引导与确认） | group_id, content, image=, pinned=0, type?, send_to_new_members?, is_show_edit_card=1, ti… | — |
| `_set_model_show` | 设置机型展示（占位） | — | — |
| `.get_word_slices` | 分词（未实现） | — | — |
| `add_custom_face` | 添加收藏表情 | file | — |
| `bot_exit` | 退出机器人 | — | — |
| `cancel_group_todo` | 取消群待办 | group_id, message_id | — |
| `check_url_safely` | 检查链接安全性 | — | { level }：安全等级（占位实现，恒为 1）。 |
| `clean_cache` | 清理缓存 | — | — |
| `click_inline_keyboard_button` | 点击内联键盘按钮 | group_id, bot_appid, msg_seq, button_id, callback_data= | — |
| `complete_group_todo` | 完成群待办 | group_id, message_id | — |
| `create_collection` | 创建收藏（未实现） | — | — |
| `create_flash_task` | 创建闪传任务 | files?, name?, thumb_path? | — |
| `delete_custom_face` | 删除收藏表情 | emoji_id | — |
| `delete_essence_msg` | 移除精华消息 | message_id | — |
| `delete_flash_file` | 删除闪传文件 | fileset_id | — |
| `delete_group_folder` | 删除群文件夹 | group_id, folder_id | — |
| `download_file` | 下载文件（url 或 base64）到 data/downloads | url=, base64=, name=, headers? | { file } |
| `download_fileset` | 解析闪传文件下载直链（不下载，由调用方实现下载） | fileset_id, file_name?, file_index? | { url, file_name, file_size } |
| `fetch_custom_face` | 获取自定义表情 | count=10, return_type=url | 字符串数组：return_type=url 时为图片 URL，return_type=id 时为 emoji_id。 |
| `fetch_custom_face_detail` | 获取自定义表情详情 | count=48 | 自定义表情详情数组，包含资源标识、图片地址、摘要与描述。 |
| `fetch_emoji_like` | 获取表情回应用户（NapCat 分页） | message_id, emojiId, count=10, cookie= | 分页的表情回应用户列表（NapCat 形状），含分页游标 cookie 与首/末页标记。 |
| `fetch_ptt_text` | 获取语音转文字结果 | message_id | { text }：语音识别出的文本。 |
| `forward_friend_single_msg` | 转发单条消息给好友 | message_id, user_id | — |
| `forward_group_single_msg` | 转发单条消息到群 | message_id, group_id | — |
| `friend_poke` | 好友拍一拍 | user_id, target_id? | — |
| `get_ai_characters` | 获取 AI 语音角色 | group_id, chat_type=1 | 按分类分组的 AI 语音角色列表，每组含分类名与角色（id、名称、试听 URL）。 |
| `get_ai_record` | 生成 AI 语音 | group_id, character, text, chat_type=1 | — |
| `get_clientkey` | 获取 clientkey | — | { clientKey, expireTime, keyIndex }：clientkey 及其过期时间与索引。 |
| `get_collection_list` | 获取收藏列表 | category=0, count=50 | 返回收藏条目、是否还有更多数据及底部时间游标。 |
| `get_cookies` | 获取 Cookies | domain=qun.qq.com | { cookies }：指定域名的 Cookie 字符串。 |
| `get_credentials` | 获取凭证 | domain=qun.qq.com | { cookies, token, csrf_token }：Cookie 字符串与 CSRF 令牌（token 与 csrf_token… |
| `get_csrf_token` | 获取 CSRF 令牌 | — | { token }：CSRF 令牌（bkn，数值）。 |
| `get_doubt_friends_add_request` | 获取可疑好友申请 | count=50 | 可疑好友申请数组，每项含 uid（作为处理用 flag）、昵称、来源、留言与申请时间。 |
| `get_emoji_likes` | 获取表情回应用户 | message_id, emoji_id | { emoji_like_list }：回应该表情的用户列表（nick_name 恒为空串）。 |
| `get_essence_msg_list` | 获取精华消息列表 | group_id | — |
| `get_file` | 获取文件信息（仅图片/语音缓存；群文件请用 get_group_file_url） | file_id=, file= | — |
| `get_fileset_id` | 从 QQ 闪传分享码或官方分享链接获取 fileset_id | share_code | { fileset_id }：解析出的文件集 ID。 |
| `get_fileset_info` | 获取文件集信息 | fileset_id | — |
| `get_flash_file_list` | 获取闪传文件列表 | fileset_id | — |
| `get_flash_file_url` | 获取闪传文件链接 | fileset_id, file_name?, file_index? | — |
| ✅ `get_forward_msg` | 获取合并转发消息（id 或 message_id） | id?, message_id? | { messages }：转发内的消息节点数组（每项为 OneBot 消息事件，内部字段不固定）。 |
| `get_friend_msg_history` | 获取好友消息历史（无锚点时从服务器获取最新双向记录） | user_id, message_id=0, count=20, reverse_order=true | { messages }：好友消息事件对象数组（每项为 OneBot 消息事件，内部字段不固定）。 |
| `get_friends_with_category` | 获取分组好友列表 | — | 好友分组数组；每组包含 categoryId、categoryName、categoryMbCount 和 buddyList。 |
| `get_group_at_all_remain` | 获取群 @全体成员 剩余次数 | group_id | { can_at_all, remain_at_all_count_for_group, remain_at_all_count_for_… |
| `get_group_detail_info` | 获取群详细信息 | group_id, no_cache=false | — |
| `get_group_file_system_info` | 获取群文件系统信息 | group_id | { file_count, limit_count, used_space, total_space }：群文件数量与容量信息（均为服务端… |
| `get_group_ignore_add_request` | 获取被忽略的入群请求（NapCat） | — | 被忽略的入群请求数组（NapCat 字段命名），每项含请求序列、邀请人、群信息与处理标记。 |
| `get_group_ignored_notifies` | 获取被过滤的入群请求 | — | 被过滤的入群请求数组，每项含群号、申请人、邀请人、留言与处理标记。 |
| `get_group_info_ex` | 获取群信息（扩展） | group_id, no_cache=false | — |
| ✅ `get_group_msg_history` | 获取群消息历史 | group_id, message_id=0, count=20, reverse_order=true | { messages }：群消息事件对象数组（每项为 OneBot 消息事件，内部字段不固定）。 |
| `get_group_shut_list` | 获取群禁言列表 | group_id | 仍在禁言中的成员数组，每项含 QQ 号、昵称与禁言到期时间戳（秒）。 |
| `get_group_signed_list` | 获取群今日打卡列表 | group_id | — |
| `get_group_todo_list` | 获取群待办列表 | group_id | 群待办数组，包含可用于待办操作的消息标识、服务端摘要与时间 |
| `get_image` | 获取图片信息 | file=, file_id= | — |
| `get_mini_app_ark` | 获取小程序卡片 ark | type?, title?, desc?, picUrl?, pic_url?, jumpUrl?, jump_url? | — |
| `get_msg_emoji_likes` | 获取一条消息的全部表情回应 | message_id | 该消息上每个表情回应的编号、数量与用户列表。 |
| `get_online_clients` | 获取在线客户端 | no_cache=false | { clients }：QQ 本次会话最近推送的在线设备快照。 |
| `get_profile_like` | 获取资料点赞 | user_id=0, start=0, count=10 | 点赞资料：uid、最近点赞时间、收藏与点赞统计及用户明细。 |
| `get_recent_contact` | 获取最近会话（占位） | count=10 | 占位实现，恒返回空数组。 |
| `get_record` | 获取语音信息；传 out_format 则服务端转码并附带 base64 | file=, file_id=, out_format? | — |
| `get_rkey` | 获取下载 rkey | — | — |
| `get_rkey_server` | 获取 rkey 服务器信息 | — | { expired_time, name, private_rkey?, group_rkey? }：rkey 过期时间与（存在时的）私聊… |
| `get_share_link` | 获取文件分享链接 | fileset_id | — |
| `get_unidirectional_friend_list` | 获取单向好友列表 | — | — |
| `group_poke` | 群拍一拍 | group_id, user_id | — |
| `list_filesets` | 列出当前账号的所有闪传文件集 | — | — |
| `mark_group_msg_as_read` | 标记群消息已读 | message_id, group_id? | — |
| `mark_msg_as_read` | 标记消息已读（群聊/私聊自动路由） | message_id, target_id? | — |
| `mark_private_msg_as_read` | 标记私聊消息已读 | message_id, user_id? | — |
| `modify_custom_face` | 修改收藏表情备注 | emoji_id, desc= | — |
| `move_custom_face_to_front` | 收藏表情移到最前 | emoji_id | — |
| `nc_get_packet_status` | 获取 packet 状态（占位） | — | 占位实现，恒返回 null。 |
| `nc_get_user_status` | 获取用户在线/扩展状态 | user_id | { status, ext_status }：用户在线状态码与扩展状态码。 |
| `ocr_image` | OCR 图片（服务端，需图片 URL 或已缓存的图片 file_id） | image | { texts, language }：识别文本数组（含置信度与坐标）与识别语言。 |
| `rename_flash_file` | 重命名闪传文件 | fileset_id, new_name | — |
| `request_decrypt_key` | 请求数据库解密密钥 | db_path | — |
| `send_ark_share` | 分享用户/群 Ark 卡片（NapCat 标准名） | user_id?, group_id?, phone_number= | { arkMsg }：服务端生成的推荐联系人 Ark 卡片 JSON 字符串。 |
| `send_flash_msg` | 发送闪传消息（私聊或群聊，引用 fileset_id 让对端下载） | fileset_id, user_id?, group_id? | { message_id } |
| `send_forward_msg` | 发送合并转发（按 message_type/群号自动路由） | messages?, message?, message_type?, group_id?, user_id?, source?, summary?, prompt?, news? | { message_id, res_id, forward_id } |
| `send_group_ai_record` | 发送 AI 语音到群 | group_id, character, text, chat_type=1 | { message_id }：已发送 AI 语音的 OneBot 消息 ID。 |
| `send_group_ark_share` | 分享群 Ark 卡片（NapCat 标准名） | group_id | 服务端生成的群推荐 Ark 卡片 JSON 字符串。 |
| `send_group_forward_msg` | 发送群合并转发 | group_id, messages?, message?, source?, summary?, prompt?, news? | { message_id, res_id, forward_id } |
| `send_like` | 点赞 | user_id, times=1 | — |
| `send_packet` | 发送原始 SSO 包（cmd + hex data） | cmd, data=, rsp=true | — |
| `send_poke` | 拍一拍（群聊/私聊自动路由） | user_id, group_id? | — |
| `send_private_forward_msg` | 发送私聊合并转发 | user_id, messages?, message?, source?, summary?, prompt?, news? | { message_id, res_id, forward_id } |
| `send_tuwen_ark` | 发送图文 Ark 卡片（私聊/群聊） | user_id?, group_id?, title, desc, summary=[分享], preview_url=https://tangram-1251316161.fi… | null |
| `set_diy_online_status` | 设置自定义在线状态 | face_id, face_type=1, wording= | — |
| `set_doubt_friends_add_request` | 处理可疑好友申请 | flag, approve=true | — |
| `set_essence_msg` | 设置精华消息 | message_id | — |
| `set_friend_remark` | 设置好友备注 | user_id, remark | — |
| `set_friends_category` | 移动好友到指定分组 | uin, categoryId?, categoryName? | 成功时返回空数据。 |
| `set_group_reaction` | 群聊表情回应 | group_id?, message_id, code, is_set=true | — |
| `set_group_remark` | 设置群备注 | group_id, remark | — |
| `set_group_robot_add_option` | 设置群机器人加群选项 | group_id, robot_member_switch?, robot_member_examine? | — |
| `set_group_sign` | 群签到 | group_id | — |
| `set_group_todo` | 设置群待办 | group_id, message_id | — |
| `set_input_status` | 设置输入状态 | user_id, event_type=0 | — |
| `set_msg_emoji_like` | 设置消息表情回应 | message_id, emoji_id, set=true | — |
| `set_online_status` | 设置在线状态 | status, ext_status=0, battery_status=100 | — |
| `set_qq_avatar` | 设置 QQ 头像 | file | — |
| `set_qq_profile` | 设置 QQ 资料 | nickname?, personal_note?, sex? | — |
| `set_restart` | 重启（不支持） | — | — |
| `set_self_longnick` | 设置个性签名（longNick/long_nick，严格 string） | longNick?, long_nick? | — |
| `share_group_ex` | 分享群 Ark 卡片 | group_id | 服务端生成的群推荐 Ark 卡片 JSON 字符串。 |
| `share_peer` | 分享用户/群 Ark 卡片 | user_id?, group_id?, phone_number= | { arkMsg }：服务端生成的推荐联系人 Ark 卡片 JSON 字符串。 |
| `trans_group_file` | 转存群文件 | group_id, file_id | { ok: true } |
| `translate_en2zh` | 英译中 | words | { words }：与输入等长的中文译文字符串数组。 |
| `upload_forward_msg` | 上传转发消息 | messages?, message?, group_id? | — |
| `upload_foward_msg` | 上传转发消息（别名拼写） | messages?, message?, group_id? | — |

### 流式接口（6）

| 动作 | 说明 | 参数 | 返回 |
|---|---|---|---|
| `clean_stream_temp_file` | 清理流式传输临时文件(仅清理 stream 上传/下载目录) | — | { message, removed } |
| `download_file_image_stream` | 以流式方式下载图片(缓存图片 id / URL / stream 目录本地文件) | file?, file_id?, chunk_size? | 流式帧:file_info → file_chunk* → file_complete |
| `download_file_record_stream` | 以流式方式下载语音(缓存语音 id / URL / stream 目录本地文件) | file?, file_id?, chunk_size? | 流式帧:file_info → file_chunk* → file_complete |
| `download_file_stream` | 以流式方式下载文件(stream 目录本地文件 / URL / 缓存媒体) | file?, file_id?, chunk_size? | 流式帧:file_info → file_chunk* → file_complete |
| `test_download_stream` | 测试下载流(推送 10 个数据帧,验证流式传输,不触达 QQ) | error=false | 流式帧:data_chunk*10 → data_complete(error=true 时以 error 帧结束) |
| `upload_file_stream` | 以流式分块方式上传文件到机器人本地(返回可用于发送的本地路径) | stream_id, chunk_data?, chunk_index?, total_chunks?, file_size?, expected_sha256?, is_com… | 流式帧:分块确认 type=stream、完成 type=response(含 file_path/file_name/file_size… |

### 消息（5）

| 动作 | 说明 | 参数 | 返回 |
|---|---|---|---|
| `delete_msg` | 撤回消息 | message_id | — |
| ✅ `get_msg` | 获取消息 | message_id | 消息事件对象（首次收到时存储的副本，已去除 post_type/self_id、附带 real_id 字段并刷新图片 URL）。 |
| `send_group_msg` | 发送群消息 | group_id, message, auto_escape=false | { message_id: number } |
| `send_msg` | 发送消息（按 message_type/群号 自动路由群聊或私聊） | message, message_type?, group_id?, user_id?, auto_escape=false | { message_id: number } |
| `send_private_msg` | 发送私聊消息 | user_id, message, group_id?, auto_escape=false | { message_id: number } |

### 空间（9）

| 动作 | 说明 | 参数 | 返回 |
|---|---|---|---|
| `comment_qzone` | 评论一条说说（QQ 空间，支持纯文字或带图；传 images 自动上传） | tid, content, target_uin?, images? | — |
| `delete_qzone_msg` | 删除一条说说（QQ 空间，按 tid） | tid | — |
| `get_qzone_feeds` | 获取 QQ 空间好友动态（feed）；page_num 仅首页可靠，深翻页需时间游标（暂未实现） | page_num=1, count=10 | 好友动态对象，含本页 feed 数组与是否有更多页。 |
| `get_qzone_msg_list` | 获取 QQ 空间说说列表（默认机器人自己的空间） | target_uin?, pos=0, num=20 | 说说列表对象，含说说总数与本页说说数组。 |
| `like_qzone` | 给一条说说点赞（QQ 空间） | tid, target_uin?, abstime=0 | — |
| `send_qzone_msg` | 发表说说（QQ 空间，支持纯文字或带图；传 images 自动上传；可设置查看权限） | content, images?, ugc_right=1, target_uins? | — |
| `set_qzone_ban` | 拉黑或解除拉黑某人（修改机器人自身 QQ 空间黑名单；enable=true 拉黑，false 解除） | user_id, enable=true | — |
| `set_qzone_msg_right` | 修改一条已发说说的查看权限（QQ 空间，按 tid） | tid, ugc_right, target_uins? | 更新后的权限对象。 |
| `unlike_qzone` | 取消对一条说说的点赞（QQ 空间；取消赞端点待真机核实） | tid, target_uin?, abstime=0 | — |

### 系统表情（4）

| 动作 | 说明 | 参数 | 返回 |
|---|---|---|---|
| `fetch_face_entity` | 按编号查询 QQ 系统表情 | face_id, refresh=false | 表情详情；编号不存在时返回 null。 |
| `fetch_super_face_id` | 判断 QQ 系统表情是否使用超级表情格式 | face_id, refresh=false | 是否使用超级表情格式。 |
| `fetch_sys_faces` | 获取 QQ 系统表情目录 | refresh=false | 按分组返回完整的 QQ 系统表情映射。 |
| `search_sys_faces` | 搜索 QQ 系统表情 | query | 匹配编号、名称、别名或分组名的表情列表。 |

### 群信息（6）

| 动作 | 说明 | 参数 | 返回 |
|---|---|---|---|
| `get_group_honor_info` | 获取群荣誉信息 | group_id, type? | — |
| `get_group_info` | 获取群信息 | group_id, no_cache=false | 群信息对象。 |
| `get_group_list` | 获取群列表 | no_cache=false | 群信息对象数组。 |
| `get_group_member_info` | 获取群成员信息 | group_id, user_id, no_cache=false | 群成员信息对象。 |
| `get_group_member_list` | 获取群成员列表 | group_id, no_cache=false | 群成员信息对象数组。 |
| `get_group_system_msg` | 获取群系统消息 | group_id?, only_pending=false, count=50 | 群系统消息数组，可按群号或未处理状态过滤。 |

### 群文件（12）

| 动作 | 说明 | 参数 | 返回 |
|---|---|---|---|
| `create_group_file_folder` | 创建群文件夹 | group_id, name, parent_id=/ | { result: { retCode, retMsg }, groupItem: { folderInfo: { folderId, f… |
| `delete_group_file` | 删除群文件 | group_id, file_id | — |
| `delete_group_file_folder` | 删除群文件夹 | group_id, folder_id | — |
| `get_group_file_url` | 获取群文件下载链接 | group_id, file_id, busid? | 群文件下载链接。 |
| `get_group_files_by_folder` | 获取群子目录文件列表 | group_id, folder_id=, folder= | 群文件系统信息（文件与文件夹列表）。 |
| `get_group_root_files` | 获取群根目录文件列表 | group_id | 群文件系统信息（文件与文件夹列表）。 |
| `get_private_file_url` | 获取私聊文件下载链接 | user_id?, file_id, file_hash= | 私聊文件下载链接。 |
| `move_group_file` | 移动群文件 | group_id, file_id, parent_directory, target_directory | — |
| `rename_group_file` | 重命名群文件 | group_id, file_id, current_parent_directory=/, new_name | — |
| `rename_group_file_folder` | 重命名群文件夹 | group_id, folder_id, new_folder_name=, name= | — |
| `upload_group_file` | 上传群文件 | group_id, file, name=, folder=, folder_id=, upload_file=true | { file_id: string } |
| `upload_private_file` | 上传私聊文件 | user_id, file, name=, upload_file=true | { file_id: string } |

### 群相册（8）

| 动作 | 说明 | 参数 | 返回 |
|---|---|---|---|
| `cancel_group_album_media_like` | — | group_id, album_id, batch_id, lloc? | — |
| `del_group_album_media` | 删除群相册图片或视频 | group_id, album_id, lloc | — |
| `do_group_album_comment` | — | group_id, album_id, lloc, content | — |
| `get_group_album_list` | — | group_id | 群相册列表数组，每项为一个相册的基本信息。 |
| `get_group_album_media_list` | — | group_id, album_id, attach_info= | 相册图片/视频列表及下一页分页游标；视频项包含 id、url、cover、尺寸、时长和多规格地址。 |
| `get_qun_album_list` | — | group_id, attach_info= | NapCat 风格的相册列表封套：{album_list, attach_info, has_more}。 |
| `set_group_album_media_like` | — | group_id, album_id, batch_id, lloc? | — |
| `upload_image_to_qun_album` | — | group_id, album_id, album_name, file | — |

### 群管理（18）

| 动作 | 说明 | 参数 | 返回 |
|---|---|---|---|
| `get_group_admin_settings` | 获取群管理设置的当前值 | group_id | 与对应设置接口字段对齐的当前群管理设置。 |
| `set_group_add_option` | 设置加群选项 | group_id, add_type=0, group_question?, group_answer? | — |
| `set_group_admin` | 设置/取消管理员 | group_id, user_id, enable=true | — |
| `set_group_anonymous` | 匿名开关（未实现，返回 ok） | — | — |
| `set_group_anonymous_ban` | 匿名禁言（未实现，返回 ok） | — | — |
| `set_group_ban` | 禁言群成员（duration=0 解除） | group_id, user_id, duration=1800 | — |
| `set_group_card` | 设置群名片（空字符串清除） | group_id, user_id, card= | — |
| `set_group_kick` | 踢出群成员 | group_id, user_id, reject_add_request=false | — |
| `set_group_kick_members` | 批量踢出群成员 | group_id, user_id, reject_add_request=false | — |
| `set_group_leave` | 退群 | group_id | — |
| `set_group_member_invite_policy` | 设置群成员邀请策略 | group_id, policy | — |
| `set_group_member_permissions` | 设置群成员权限（仅群主可改） | group_id, allow_member_upload_album?, allow_member_temporary_session?, allow_member_creat… | — |
| `set_group_name` | 设置群名 | group_id, group_name= | — |
| `set_group_new_member_history_visibility` | 设置新成员是否可查看历史消息 | group_id, visible | — |
| `set_group_portrait` | 设置群头像 | group_id, file | — |
| `set_group_search` | 设置群被搜索方式（群指纹 / 群号搜索开关） | group_id, no_finger_open?, no_code_finger_open? | — |
| `set_group_special_title` | 设置群头衔 | group_id, user_id, special_title= | — |
| `set_group_whole_ban` | 全员禁言开关 | group_id, enable=true | — |

### 请求（2）

| 动作 | 说明 | 参数 | 返回 |
|---|---|---|---|
| `set_friend_add_request` | 处理好友添加请求 | flag, approve=true | — |
| `set_group_add_request` | 处理加群请求 | flag, sub_type?, type?, approve=true, reason= | — |

<!-- AUTO-END -->
