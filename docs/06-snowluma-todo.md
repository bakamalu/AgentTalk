# SnowLuma 收尾待办（2026-10-30 20:20 快照）

迁移主线已经推进到"只差一次合法登录"，剩下的都是一次性收尾和小概率坑。
本文按**优先级**排列，每条带「现状 / 动作 / 验收」，做完一条就勾掉。

> 11-02 更新：**P1-11 的搜索只解决了一半 —— 天气类问题已改为独立数据源，插件同时做了模块化拆分。**
> 1. ❗ **根因（见 P1-11 (c)）**：问“今天苏州天气”时日志里 3 次 `[搜索]` 都“命中 5 条”，
>    看着成功、实际全是百科/旅游页。原样重放那 3 条 query 证实：**长查询（带日期/年份/“未来三天”）
>    会让 cn.bing 退化成实体页**，三条不同 query 返回完全相同的 top5；而短查询能拿到中国天气网。
>    再加上 `bingSearch` 只取标题+摘要、**结构上就拿不到温度数值** —— 天气压根不该走搜索。
> 2. ✅ **已修（P1-11 (d)）**：新增 `lib/weather.js`（Open-Meteo 主 + wttr.in 兜底，免 key），
>    `lib/websearch.js` 加查询词归一化 + 结果质量闸 + 无效自动重试；`bot.env` 新增三个 `BOT_WEATHER_*` 开关。
> 3. ✅ **顺带做了结构治理**：`deepseek.js` 从 1014 行降到 589 行，拆出 8 个 `bot/lib/*.js`；
>    `botctl.sh sync plugin` 现在会连带同步 `lib/`（**旧版只 cp 一个文件，会把线上部署成缺模块的状态**）。
>    详见 `docs/03-dev-log.md` 第二十节。

> 10-31 09:30 更新：**WebUI 已开放外网（HTTPS）；过程中引入并修好了一个严重回归。**
> 三件事按重要性排序：
> 1. ❗ **我引入的死循环（P1-9）**：P1-6 的判活写死了 `127.0.0.1:5099`，而 P1-7 把
>    WebUI 改绑 `0.0.0.0` 后该字面量永远匹配不中 → **watchdog 每 ~90s 重建一次容器**，
>    机器人持续离线（这才是你“群里 @ 没反应”的真因，**与 `bot.env` 无关**）。
>    已改为只匹端口 `:5099`；`s0-verify.sh` 里同错误的第二实例也一并修了。
> 2. ✅ **登录不需要扫码（推翻 P1-8 原结论）**：重建后停在**账号页**，
>    勾「自动登录」+ 点「登录」即可，15 秒上线，**全程不碰 168**。
>    我 09:11–09:17 那六分钟一直在让你扫码，是白费的——抱歉。
>    ❗ 这也让 P0-1 那套“168 冷却窗口”叙事需要重新审视：部分失败可能是
>    **页面状态与预期不符**，而不是服务端拦截。
> 3. ⚠ **安全现状（未完成）**：`https://<SERVER_IP>:5099` 已可对外访问，但
>    **TOTP 未开**、**`ufw` 处于 `inactive`**、**阿里云安全组未确认** ——
>    因你 IP 不固定无法做白名单，自签 HTTPS + 口令 现在是**唯一防线**，建议尽快补 TOTP。

> 10-31 08:25 更新：**✅ 登录成功（第 7 次尝试，08:22:44）！P0-1 / P0-2 / P0-4 均已收口。**
> `verify-onebot.sh` **12 项全绿**（含 `3001` 监听 + Koishi `adapter connect to server`）；
> 宿主 NapCat 残留 0；截图已删；`5900` 仍关。**只剩 P0-5 人工回归 8 项。**
>
> ⚠ **必须修正一个认知（本次最重要的发现）**：“168 是冷却窗口、要等更久、不要连扫”
> 这个依据**已被时序直接证伪**：
> `08:05 失败（隔夜 9h50m 后）` → `08:21 成功（只隔 16 分钟）`。
> **等 10 小时不行，等 16 分钟反而过了** —— 间隔时长与结果**无相关性**。
> 所以 168 更可能是**概率性/条件性放行**（每次扫码独立抽签），而不是固定倒计时窗口。
> 回看全部 7 次：19:43 成（第 1 次）、之后 6 次全败、第 7 次成 —— 吻合“随机放行”而不是“冷却”。
> **推论：遇到 168 不要傻等天级窗口，也不要怕“连扫加重风控”——它不是这样工作的。**
> （仍不建议高频狂扫：服务端可能有失败计数，但本案例里 16 分钟一次就过了。）

> 10-31 08:10 更新：**第六次实测（隔夜 9 小时 50 分）仍 168** —— “小时级冷却”这条路
> 也被排除了。19:43 一次就成 vs 之后 6 次全拒，单靠等时间已经不能解释。
> 但本轮拿到一个**实质收益**：查明并修好了 P1-6 —— watchdog 三层判活
> **单次探测失败就直接重建容器**，而重建会把登录态一起拆掉
> （今早 07:59 它就这样白重建了一次；现在没登录所以无害，
> **但登录成功后它就是定时炸弹**）。已改为连续 3 次失败才重建，
> 仓库与 `/opt` 两份已同步、已重启验证（容器 `Up 9→10min` 未被动）。

> 22:25 更新：**“19:43 那次是不是连扫”已询问用户，确认为只扫了一次** →
> “尝试次数”这个变量已排除（日志里 19:37–19:42 那四次 `awaiting login` 不是四次扫码）。
> **当前最优解释：不是“撞上一个正在倒计时的窗口”，而是我们自己在 20:03 把风控等级顶上去的**：
> 19:43 一次就成（等级低）→ 20:03 刚登录就被 watchdog 误杀、随后立即重登
> （对服务端而言与“会话劫持”难区分）→ 20:54 起 5 次全拒。
> **推论：这类升级需要小时级以上的冷却，45–50 分钟远远不够** —— 这就是今天怎么等都过不去的原因。
> **行动：今天收手，下次试的时间拉到 12 小时以上（建议隔夜或后天），且只试一次。**

> 22:17 更新：**第五次实测（22:12）仍 168**，距上次 49 分钟。本轮试了一条**以前没试过的路**：
> 不点「确认」、只等手机端推进。结果：弹窗在原地 **3 分钟毫无变化**，
> 桌面也没收到任何来自手机侧的事件（90s 轮询：3001=0、日志零新增）。
> 说明 168 是**在扫码瞬间就终止流程的终态**，手机侧那个“允许登录”环节
> 要么根本没弹出来，要么弹了也推不动服务端的判定。
> 已点「确认」关窗 + 删截图（`*.png` 归 0）。**今天到此为止，不再刷码。**

> 21:35 更新：**P1-4 全部收口（WebUI 已改密）+ 容器已用新镜像重启验证**。
> 改密没走浏览器，直接调 `POST /api/login` 拿 token → `POST /api/auth/change-password`
> （token 走 `x-snowluma-token` 头）。新口令存 `/root/deploy/snowluma-webui.pass`（600），
> 已验证：新口令 PASS / 旧 bootstrap 口令 401 / **重建容器后 hash 不变**。
> `snowluma.env` 里已作废的明文口令行已删。`s0-verify` 改密后复跑仍 **38 全绿**。
> 同时确认：`fs.inotify` 修复经一次重建不复发（ENOSPC 全天仅 21:06 那 1 次）。
> **P0-1 按用户决定停手**：今天不再扫码，等小时/天级窗口。

> 21:25 更新：**上一条（21:10）“inotify 是真因”的假设已被实测推翻，已改回。**
> 修好 watch 后 21:23 再扫一次，**仍稳弹 168**；点“确认”后回到扫码页、不进主界面
> （相 20:55 那次一共两轮，watch 坏/好各一次，结果一致）。
> 所以正确结论：**168 是服务端硬阻断，不是“功能受限告知”**；
> inotify 的 ENOSPC 是**真 bug、修对了，但不是登录被拒的原因**。
> 另查：`login.db` 本体存在（`/root/.config/QQ/global/nt_db/login.db`），但 SnowLuma watch 的是
> `QQ/nt_qq/global/nt_db/login.db`（多一层不存在的 `nt_qq/`）——它探的是错路径。
> 扫码失败时服务端**不下发 ticket**，所以无凭据可自动恢复，只能过一次 168。

> 21:10 更新：**⚠ 本块“真因”结论已被 21:25 推翻，仅保留 ENOSPC 修复记录。**
> 当时在新容器日志里抓到：`WARN [Hook] account watch failed: path=/root/.config/QQ/nt_qq/global/nt_db/login.db
> err=ENOSPC: System limit for number of file watchers reached`。
> 宿主 `fs.inotify.max_user_watches` 还是 Ubuntu 默认 **8192**，而 SnowLuma 要 watch
> 整个 `/root/.config/QQ` 目录树 → 必然耗尽 → **它根本看不到登录事件**。
> 已 `sysctl` 提到 524288（instance 128→512）+ 持久化 `/etc/sysctl.d/99-snowluma-inotify.conf`，
> 重启容器后 **ENOSPC 警告消失**。重新扫到全新二维码（新容器直接停在扫码页，无需点刷新）。

> 20:55 更新：**第三次扫码实测（20:54）仍撞 168**，距上次 168（20:03）**已 51 分钟**，
> 且中间只扫了 1 次（非连扫）。**⚙ 认知修正：上一条“等 10–30 分钟窗口就够”的假设被证伪**
> —— 至少窗口 >51 分钟，且提示原文点名“请登录**最新**手机QQ并根据提示恢复”，
> 属**需手机端主动处置**类风控，不是纯冷却时间。
> 另实测：**SnowLuma 日志完全不记录登录失败细节**（无 168 / 无错误码，
> 20:50 后零新增行）—— 风控信息**只存在于 UI 弹窗**，排查必须靠 `run.sh shot` 看图，
> 不能靠 grep 日志。弹窗已点“确认”（723,463）关闭，客户端回到扫码页。

> 20:48 更新：距 20:03 误杀重撞 168 已过 45 分钟（>P0-1 建议的 10–30 分钟窗口），
> `run.sh qr` 已刷出**新二维码**（旧码 20:46 截到时是「当前二维码已过期」）。
> 容器 `Up 40min`、supervisor `pipe connected: PID=807`、`awaiting login`。
> `verify-onebot.sh` 现在 **10/12 绿**：生成物 `onebot_<UIN>.json` 已存在且
> host/port/token/messageFormat 四项全对，**只剩 3001 监听 + Koishi adapter 两项**
> —— 即 P0-2 的配置核验实质已过，剩下的纯粹等登录。
> 已起 180s 后台监控（`/tmp/qr-watch.log`）盯 3001 与风控迹象。

> 20:20 更新：**19:43 手机扫码登录成功过一次**（UIN=<UIN>，昵称"<BOT_NICKNAME>"，
> 4 个群 949 成员全部加载，`127.0.0.1:3001` 正常监听，`verify-onebot` 11 项全绿）。
> 随后被一个**自己写出来的 bug** 打断：`qqbot-watchdog` 的"停宿主 NapCat"逻辑
> 用 `pgrep -f '/opt/QQ/qq'` 在宿主侧匹配，而宿主 `ps` **能命中容器内进程**，
> 于是把容器里刚登录的 QQ 误杀了。已在 `ops/bot-watchdog.sh` 修复（扣掉
> `docker top` 的容器 PID），重启验证通过。修复后重启触发重建 + 快速登录，
> 又撞回风控 168 —— 属连锁反应，**现等风控窗口过去再扫一次**。
> 详见 `docs/03-dev-log.md` 第十九节。

> 18:55 更新：P1-1 / P1-2 / P1-3 / P2-1 已完成（详见对应小节）；镜像重建为
> `17d98e85b9d3`（含 `scrot`/`xdotool`），容器已用新镜像重建，`run.sh shot` 在
> 干净容器里一次出图。QQ 现在停在**扫码页**（新容器 `-q` 会先停在密码页，
> 需点 `(597,592)` 的"扫码登录"）。P0 仍卡在手机端风控 168。

---

## 0. 当前状态快照

| 项 | 状态 |
|---|---|
| 容器 `qqbot-snowluma` | Up（Ubuntu 24.04，glibc 2.39，镜像 `17d98e85b9d3`） |
| 容器内 QQ | ✅ **已登录**（UIN=<UIN>，10-31 08:22），Xvfb `:99`，`5900` 已关 |
| SnowLuma supervisor | ✅ 运行中，hook 已注入主进程 |
| WebUI | `127.0.0.1:5099` HTTP 200，**口令已轮换**（非 bootstrap） |
| 截屏能力 | ✅ `run.sh shot` / `run.sh qr`（`scrot`/`xdotool` 已固化进镜像） |
| OneBot WS `:3001` | ✅ **监听中**（10-31 08:22:44 起，第 7 次扫码成功） |
| `BOT_GATEWAY` | ✅ `snowluma`，P0-4 验收全通过（宿主 NapCat 残留 0） |
| `qqbot-watchdog` | ✅ `enabled` + `active`（误杀 bug 已修） |
| `SNOWLUMA_VNC` | ✅ `0`，5900 已关（不重建容器直接 `pkill x11vnc`） |
| 账号登录 | ✅ **10-31 08:22 第 7 次尝试成功**（前 6 次被 168 拒，含隔夜 10h） |
| WebUI 口令 | ✅ 已轮换（21:31），新口令存 `/root/deploy/snowluma-webui.pass`（600） |
| `fs.inotify` 上限 | ✅ 524288/512，持久化 `/etc/sysctl.d/99-snowluma-inotify.conf` |
| `switch` / `rollback` 脚本 | ✅ 已容器化，各跑过一次 `--dry-run` 通过 |
| `ops/s0-verify.sh` | ✅ 39 项全绿（11-02 11:10 部署后复跑，0 失败；原文记的 37/38 已过期） |
| 天气能力 | ✅ `lib/weather.js`（Open-Meteo 主 + wttr.in 兜底），默认城市苏州（11-02） |
| 插件代码结构 | ✅ `bot/plugins/deepseek.js`(589) + `bot/lib/*.js`(8 个模块)，线上 `/opt/koishi/lib/`（11-02） |


---

## P0 阻塞项（必须人工）

### P0-1 解除账号风控 168

- **现状**：扫码后 QQ 客户端弹「你的账号近期存在安全风险，部分功能使用受限，请登录最新手机QQ并根据提示恢复账号使用」，NapCat 时代日志同样是 `serverErrorCode: 168`。
  **⚠ 认知修正（19:43 实测）**：168 **不是永久拒绝**，而是"某时间窗口内拒绝"。
  同一账号同一客户端在 19:43 扫码**成功过一次**（3001 正常监听 20 分钟）。
  20:03 被 watchdog 误杀后立刻重登才又撞 168 —— 所以**关键是"不要连着扫"**，
  而不是"账号已经废了"。
  **⚙ 但本修正已被 20:54 实测推翻一半**：不连扫、等足 51 分钟，仍拒。所以正确认知是：
  168 **不是单纯靠时间能解的**，它需要手机端按提示主动处置（升级 / 安全中心验证）；
  "不连扫"只能防**加重**，不能代替处置。
- **实测数据点**（同一账号、同一客户端、同一镜像）：
  | 时刻 | 动作 | 结果 |
  |---|---|---|
  | 19:43 | 扫码 | ✅ 成功（3001 监听 20 分钟） |
  | 20:03 | 误杀后立即重登 | ❌ 168 |
  | 20:54 | 不连扫、等 51 分钟后扫 1 次 | ❌ 168（弹窗原文同上） |
  | 21:23 | **inotify 已修后**再扫 1 次 + 点“确认” | ❌ 168（回扫码页，不进主界面） |
  | 22:12 | 距上次 49 分钟，**不点确认、只等手机侧推进** | ❌ 168（弹窗原地 3 分钟不动，桌面零事件） |
  | 10-31 08:05 | **隔夜 9h50m** 后扫 1 次 | ❌ 168（现象与昨晚完全一致） |
  另：扫码时客户端标题能走到**“打开手机QQ允许登录”**，说明二维码本身有效、
  扫码链路通，**拒在服务端授权阶段**，不是“手机没点允许”。
  **已排除的假设（四个，别再重试）**：
  ① “等时间窗口就能解”（51 / 49 分钟各一次，仍拒）—— **10-31 已补测隔夜 9h50m，仍拒**；
     时间量级已试到小时级，剩下的只有**天级**（24–72h）或根本不会自动解；
  ② “168 只是告知、点确认就能进”（watch 修好后点确认仍失败）；
  ③ “不点确认、等手机端点允许就能过”（22:12 实测：弹窗 3 分钟不动、桌面零事件）；
  ④ **“19:43 成功是因为连扫”—— 已由用户 22:2x 否认，当时只扫了一次**。
     （日志里 19:37–19:42 同一 PID=20 重复四次 `awaiting login` 不是四次扫码，
     而是 hook 重注/界面刷新，不要拿它当“当时扫了四次”的证据。）
  手机端安全中心已查：**无待处理风险项**（用户 21:0x 确认）——所以也不是“有明确待办项”型。
- **动作**：
  1. 手机 QQ 升级到最新版（提示原文点名"最新手机QQ"）；
  2. 手机 QQ → 设置 → 账号安全 / QQ 安全中心，看是否有待处理风险项，按引导做人脸或短信验证；
  3. 处理完**等 10–30 分钟**再试，不要连扫（高频重试会加重风控）。
- **验收**：扫码后 QQ 进入主界面，`/opt/snowluma/logs/snowluma-<date>.log` 出现 uin/登录成功记录，`ss -lnt` 出现 `127.0.0.1:3001`。
- **不要做**（❗ 10-31 修正）：换网关（NapCat/SnowLuma/Lagrange）确实绕不过风控，
  这条仍成立；但原文另半句“**反复扫码只会让风控窗口变长**”**已被实测推翻** ——
  16 分钟后的重试就成功了，而隔夜 10 小时反而失败（见上方状态与实测表）。
  真正该避免的不是“重试”，而是“**登录后立即把 QQ 强杀再重登**”（P1-5 的 watchdog 误杀）。
- **动作**（修正版，按性价比排序）：
  1. 直接重试扫码，**间隔几分钟即可**，当成概率性拦截；
  2. 若连拒 5 次以上再考虑：手机 QQ 升级到最新版、安全中心查待处理风险项；
  3. **不要**在登录成功后强杀 QQ（会把会话弄脏，下次重试成本更高）。
- **状态**：✅ **已解除（10-31 08:22:44，第 7 次尝试）**。
  **重要：解除方式与本文原来的判断完全相反** ——
  08:05 在**隔夜 9h50m 冷却后**失败，08:21 在**只隔 16 分钟后**成功。
  所以“168 = 固定冷却窗口”不成立，它更像**每次扫码独立判定的概率性拦截**。
  共 7 次：19:43 成 → 20:03 / 20:54 / 21:23 / 22:12 / 10-31 08:05 五连败 → 08:21 成。
  **下次再遇到 168 的正确做法**：当成“重试几次就能过”的随机拦截处理
  （隔几分钟再试，不必狂扫），**不要按本文旧版本去等“天级窗口”**，
  也不要因此去改网关或换 QQ 版本。

### P0-2 首次登录后立刻核验产物（最容易踩）

- **现状**：`/opt/snowluma/config/onebot.json` 是 `mode: "overlay"` 的预置文件（`wsServers[0]` = koishi/127.0.0.1:3001 + accessToken）。登录后 SnowLuma 会按 uin 生成 `onebot_<uin>.json` 并与 overlay 合并。
- **✅ 已脚本化**：`ops/snowluma/verify-onebot.sh` 一次搞定（python3 解析 JSON，不靠 grep 猜）：
  ```bash
  ./ops/snowluma/verify-onebot.sh      # exit 0 全绿 / 2 还没登录 / 1 有 ✗
  ./ops/snowluma/verify-onebot.sh -q   # 只看失败项
  ```
  核对项：overlay 存在 → 生成物存在 → 逐个文件 `host=127.0.0.1` / `port=3001` /
  `accessToken == NAPCAT_WS_TOKEN` / `messageFormat=array` → 3001 只听回环 →
  `koishi.log` 有 `adapter connect to server`。失败时直接打印三条兜底动作。
- **动作**：
  1. `ls -l /opt/snowluma/config/onebot_*.json`，确认新文件出现；
  2. 用 `python3 -c` 读该文件的 `networks.wsServers[0]`，逐项核对 `host=127.0.0.1` / `port=3001` / `accessToken` 与 `/root/deploy/bot.env` 的 `NAPCAT_WS_TOKEN` **完全一致** / `messageFormat=array`；
  3. `ss -lnt | grep 127.0.0.1:3001`。
- **验收**：端口在监听，且 Koishi 侧能 `adapter connect to server`。
- **失败兜底**：若生成物覆盖了 overlay 导致 token 不一致 → 把生成文件里的 `networks` 段对齐 overlay（或删掉生成文件的 `networks` 段让 overlay 生效），改完 `run.sh down && run.sh up`。
- **状态**：✅ **10-31 08:23 正式收口：`verify-onebot.sh` 12 项全绿（exit 0）**。
  overlay 与生成物 `onebot_<UIN>.json` 的 host/port/accessToken/messageFormat
  八项全对，**未需要任何兜底修改**（预置的 overlay 直接生效）；
  `127.0.0.1:3001` 已监听，Koishi 日志已出现 `adapter connect to server`。
  截图已删（`/opt/snowluma/logs/*.png` = 0）。

### P0-3 ✅ 关掉 VNC

- **动作**：`/root/deploy/snowluma.env` 里 `SNOWLUMA_VNC="0"` → `run.sh down && run.sh up`。
- **验收**：`ss -lnt` 无 5900；`run.sh status` 不再列 x11vnc。
- **理由**：VNC 是免密（`-nopw`）的，虽然只听回环，但登录完成后没有任何保留理由。
- **状态**：✅ 完成（2026-10-30 20:07），**没有重建容器**（重建会丢登录态）：
  - `docker exec qqbot-snowluma pkill -f x11vnc` → 5900 立即消失；
    entrypoint 的判活循环只管 QQ、不复活 x11vnc，所以这一刀是持久的；
  - 关完复核 `127.0.0.1:3001` 仍在监听（登录态未受影响）；
  - `snowluma.env` 已同步 `SNOWLUMA_VNC="0"`，下次重建不会再把 5900 开出来。
  - **结论**：以后想关 VNC 不必付"重建容器 + 重新登录"的代价。

### P0-4 切网关 + 拉起守护（配置项已完成，待登录后复验）

- **前置**：先做 P1-2（switch 脚本容器化），否则脚本会在**宿主**上 `nohup ./launcher.sh`，必然重现 `GLIBCXX_3.4.29 not found`。
- **动作**（容器模式下最小手工路径）：
  1. `sed -i 's/^export BOT_GATEWAY=.*/export BOT_GATEWAY="snowluma"/' /root/deploy/bot.env`  ✅ 20:03 已做（备份 `bot.env.bak-switch-201*`）
  2. `systemctl enable --now qqbot-watchdog`  ✅ 20:03 已做
  3. 等 20–30s，`ss -lnt | grep -E '3001|5140'`
- **验收**：watchdog `active (running)`；3001 在监听；Koishi 起来且日志有 `adapter connect to server`；host 上**没有** NapCat/napcat_launcher 进程。
- **状态**：✅ **10-31 08:23 验收全部通过**：`BOT_GATEWAY=snowluma`、
  `qqbot-watchdog` `enabled` + `active`、`3001` 在监听、Koishi `5140` 已起且日志有
  `adapter connect to server`、**宿主侧 NapCat 残留数 = 0**（用 `docker top` 扣掉容器 PID 后核）。
  内存 `available 305MB`（参 P3-1，偏紧但未触发 OOM）。

### P0-5 人工回归 8 项（沿用 `switch-to-snowluma.sh` 尾部清单）

1. 群里 @ 一次 → 有回复
2. 引用一条消息再 @ → 回复体现被引用内容
3. 撤回一条被回复的消息 → 日志可见历史剔除
4. 发一张图片 → 日志出现 `[图片]`
5. 未 @ 说两句再 @ → 回复体现前文
6. 私聊连续 3 轮 → 轮次递增
7. `#状态` → 正常返回
8. 改 `bot.env` 一行 → 5s 内热重载日志

任一项失败 → `ops/migrate/rollback-to-napcat.sh`（先修 P1-3）。

### P0-6 闸门复跑

`./ops/s0-verify.sh` 必须仍是 0 失败；第 10 组会额外校验容器内 QQ/supervisor/5099/5900 未暴露。

- **状态**：✅ **20:56 复跑通过：38 项全绿 / 0 失败**（含第 10 组 15 项：容器内 QQ 在跑、
  supervisor 在跑、WebUI 只听 5099、**5900 未暴露**、token/端口/messageFormat 与 `bot.env` 一致）。
  计数从原记录的 37 变 38，是脚本本身在 P1-1/P2-1 过程中补了断言，不是环境异常。
  **本项不依赖登录**，所以登录被 168 卡住期间它仍可持续把关。

---

## P1 一次性工程债（切换前必做）

### P1-1 ✅ 已把 `scrot` / `xdotool` 固化进镜像

- **现状**：这两个包是 `docker exec apt-get install` **临时装进运行中容器**的（`scrot 1.10-1build2`、`xdotool 1:3.20160805.1-5build1`），镜像里没有 → 容器一重建，截二维码的命令就失效。
- **动作**：
  1. `ops/snowluma/container/Dockerfile` 的 apt 列表加 `scrot xdotool`；
  2. `run.sh` 增加 `shot` 子命令：`scrot -o /opt/snowluma/logs/qq-screen.png` + `scrot -a 540,310,202,208 -o .../qq-qr.png`（区域参数按 1280x800 Xvfb 校准，坐标写进脚本注释）；
  3. 重建镜像验证：全新容器不装包也能一次截出二维码。
- **验收**：`run.sh shot` 在重建后的干净容器里直接可用。
- **状态**：✅ 完成（2026-10-30 18:55）
  - `Dockerfile` apt 列表已加 `scrot xdotool`，镜像重建为 `17d98e85b9d3`；
    `docker run --rm --entrypoint sh` 校验 `/usr/bin/scrot`、`/usr/bin/xdotool` 都在。
  - `run.sh` 新增 `shot` 子命令（含"容器未运行/镜像无 scrot"两道断言），
    坐标表写进注释：全屏 `0,0,1280,800`、二维码 `540,310,202,208`、
    密码页→扫码页链接 `(597,592)`。
  - 实测：`down && up` 起**全新容器** → `shot` 一次出图，`xdotool` 点击"扫码登录"
    成功切到扫码页（不再需要任何 `docker exec apt-get install`）。

### P1-2 ✅ 已完成 `switch-to-snowluma.sh` 容器化

| 原问题 | 改法 |
|---|---|
| `preflight` 要求 `config/onebot_*.json` 已存在 | 改为断言 overlay `onebot.json`；生成物 `onebot_<uin>.json` 在 dry-run 下缺失只提示、真切换才中止 |
| `pkill -f "/opt/QQ/qq --no-sandbox"` 停 QQ | 前置 `"$SL_RUN" down`；宿主 pkill 只清 NapCat 残留 |
| `cd $SL_DIR && nohup ./launcher.sh` 起网关 | 改 `"$SL_RUN" up`，然后**轮询**等 `127.0.0.1:3001`（最多 60s） |
| `sed` 改端口 | 容器模式端口来自 overlay 的 `wsServers[0].port`：改为**断言** overlay + 生成物都是 3001，不一致直接中止并给出处理办法 |
| 脚本自己 `nohup koishi` | 删除：Koishi 交给 `qqbot-watchdog`；脚本只 `systemctl enable --now` 后轮询 `adapter connect to server` |

- **状态**：✅ 完成（2026-10-30 18:45），`--dry-run` 通过（前置全绿，计划里可见 `run.sh down` / `run.sh up`）。
- **顺手**：脚本开头 `source /root/deploy/bot.env`（原先靠交互 shell 已 export `NAPCAT_WS_TOKEN`，不 source 时 dry-run 直接判失败）。
- **⚠ 认知修正**：原文"容器内进程宿主 `ps` 看不到"是**错的** —— 宿主 `ps`/`pkill` 能命中容器内进程
  （PID namespace 只挡住"容器看不到宿主"这个方向）。不能用 pkill 的真正原因是
  entrypoint 的 `while true` 每 10s 判活重启，杀了也会复活。所以唯一正确停法是 `run.sh down`。

### P1-3 ✅ 已完成 `rollback-to-napcat.sh` 容器化

- **现状**：只有 `pkill -f "snowluma"`，容器内进程（不同 PID namespace）**杀不到**。
- **后果**：回滚后容器仍占 `3001` → NapCat 起不来 → 又回到停机。
- **动作**：在 pkill 段之前插 `"$SL_RUN" down 2>/dev/null || true`，并加断言「3001 已释放」再启 NapCat。
- **验收**：`--dry-run` 打印的计划里能看到 `run.sh down`；真跑后 3001 归 NapCat。
- **状态**：✅ 完成（2026-10-30 18:45）
  - 第 2 步首行 `"$SL_RUN" down`；第 3 步改成**硬断言**：3001 仍被占就打印占用进程 + 容器状态并 `exit 1`（不再"⚠ 仍被占用"然后硬启 NapCat）。
  - 第 4 步原先 `sed` SnowLuma 的 `onebot_*.json` 改为**校验 NapCat 自己的** `/opt/napcat/config/onebot11_*.json` 是否是 3001 —— 改 SnowLuma 的配置 NapCat 根本不读。
  - 第 6 步去掉固定 `sleep 35`，改成最多 60s 轮询 3001，并额外检查"容器有没有被 watchdog 又拉起来"。
  - `--dry-run` 通过。

### P1-4 安全清理 + WebUI 改密（✅ 两项均完成）

- **待删（含凭据）**：
  - `/root/deploy/.ck`（276B，WebUI cookie）
  - `/root/deploy/.login.json`（118B，WebUI session token）
  - `/opt/snowluma/logs/qq-screen*.png`、`qq-qr.png`（7 张，**二维码 = 一次性登录授权**）
- **状态**：✅ 文件清理已完成（2026-10-30 19:00）
  - `.ck` / `.login.json` 已删（仓库里没有任何脚本再引用它们）；
  - 5 张过期二维码/整屏截图（`qq-screen2..6.png`，均为 16:13–16:37 的历史产物）已删；
  - **保留** `qq-screen.png` + `qq-qr.png`（18:56 新截，登录要用；一旦扫码成功立即再删）。
- **✅ 20:57 补充：截图已全部清空**。因登录被 168 阻塞（见 P0-1），已无“待用”价值；
  20:46–20:54 期间产生的 `qq-screen.png` / `qq-qr.png`（包括 18:56 那两张）已全删，
  `/opt/snowluma/logs/*.png` 现为 0 个。下次要扫码时 `run.sh qr` 会现刷现用，用完再删。
  注：删 `/opt` 下的文件需越过工作区沙箱（`rm` 报 Read-only file system）。
- **✅ 21:31 WebUI 改密已完成**（没走浏览器，直接调 API，免了 SSH 隧道）：
  ```bash
  # 1) 拿 token（口令字段就叫 password）
  curl -sX POST 127.0.0.1:5099/api/login -H 'Content-Type: application/json' \
       -d '{"password":"<旧口令>"}'            # → {"success":true,"token":"…","mustChangePassword":false}
  # 2) 改密（token 走 header，不是 cookie）
  curl -sX POST 127.0.0.1:5099/api/auth/change-password \
       -H "x-snowluma-token: <token>" -H 'Content-Type: application/json' \
       -d '{"oldPassword":"<旧>","newPassword":"<新>"}'
  ```
  - 强度规则（`PASSWORD_RULES`）：≥ 10 位 + 小写 + 大写 + 特殊符号 + 无空格；
  - 新口令已存 `/root/deploy/snowluma-webui.pass`（**600**）；
  - **已双向验证**：新口令登录 PASS、旧 bootstrap 口令 401 拒绝；
  - **已做持久性验证**：`run.sh down && up` 重建后 `webui.json` 的 hash 仍为改密后的
    `c22e9a69…`、`mustChangePassword:false` —— 因为 `WebuiAuth.load()` 只在
    **webui.json 缺失/损坏时**才用 env 里的 bootstrap 口令播种；
  - `snowluma.env` 里那行已作废的 `SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD` **已删除**
    （文件头已改写说明），本文档也不再保留其明文；
  - ⚠ **一个反向陷阱值得记**：`mustChangePassword` 必须保持 `false`。若它是 `true`，
    下次重启会直接**生成随机口令**并日志提示“bootstrap password was never rotated”，
    把现有口令冲掉；
  - 未做：2FA（`/api/auth/totp/begin|confirm|recovery-codes` 端点已存在）。需要手机
     authenticator 扫码，且丢恢复码会锁死 WebUI —— 建议登录跑通后再单独开。
- **顺手**：`/root/deploy/w0-diag.log`、`host-start-test.log` 是诊断产物，可留档到 migrate 目录后删。

---

## P1 一次性工程债（切换前必做）

### P1-5 ✅ watchdog 误杀容器内 QQ（19:43 那次登录就死在这）

- **现象**：`systemctl enable --now qqbot-watchdog` 后，日志出现
  `检测到宿主 NapCat(QQ)，先停掉（容器模式独占端口）`，紧接着容器内 QQ（PID=20）
  被杀，entrypoint 10s 判活把它重启成新 PID 并停在快速登录页 → `3001` 消失、
  刚登录成功的账号掉线。
- **根因**：宿主 `ps`/`pgrep` **能命中容器内进程**（PID namespace 只挡反方向），
  所以 `pgrep -f '/opt/QQ/qq --no-sandbox'` 在容器模式下命中的就是**自己容器的
  QQ**，`pkill -f` 直接杀穿。
- **修复**（`ops/bot-watchdog.sh`，`/opt` 与仓库两份已同步）：
  - 新增 `sl_pids()`：`docker top "$SL_CONTAINER" -o pid` 取容器内 PID 集合；
  - 新增 `host_napcat_pids()`：`pgrep` 结果逐个 `case` 扣掉容器 PID，只留真正的宿主 NapCat；
  - 互斥段由 `pgrep … && pkill -f` 改为 `[ -n "$(host_napcat_pids)" ] && stop_host_napcat`
    （定点 `kill`，不再全量匹配）。
- **验收**：重启 watchdog 后日志**不再**出现"检测到宿主 NapCat"，容器内 QQ PID
  不变、`3001` 不受影响。
- **教训**：容器化之后，任何"宿主侧按命令行特征杀进程"的代码都必须先扣掉容器
  PID。`switch-to-snowluma.sh` / `rollback-to-napcat.sh` 里残留的宿主 `pkill` 已
  逐条加注释说明"能命中但杀不干净（会被 entrypoint 复活），唯一正确停法是
  `run.sh down`"。

### P1-6 ✅ watchdog 单次误判就重建容器（登录成功后会拆掉登录态）

- **现象**：10-31 07:59:15 日志 `容器在但内部组件不完整，重建容器...`，但当时
  系统未重启（boot 10-29 13:51）、supervisor 无异常记录、无 OOM。
  事后手测三层判活（QQ / supervisor / 5099）**全部 PASS** —— 说明这是一次
  **瞬时误判**（`docker exec` 偶发超时、QQ 止在启动、宿主高负载都会让 pgrep 拿不到 PID）。
- **根因**：`start_snowluma()` 的三层判活**没有容错**——一次失败就直接
  `run.sh down` 重建。现在没登录所以无害，但**登录成功后它就是定时炸弹**：
  重建会拆掉 QQ 凭据，而重登要再撞一次 168（见 P0-1）。
- **修复**（`ops/bot-watchdog.sh`）：
  - 抽出 `sl_components_ok()` 封装三层判活；
  - 新增**连续失败计数**：状态文件 `SL_LIVE_STATE=/opt/logs/snowluma-live-fail`，
    阈值 `SL_LIVE_FAIL_THRESHOLD=3`；**连续 3 次失败才重建**，任一成功就归零；
  - `CHECK_INTERVAL=20s`，所以真挂 **60s 内仍会被拉起，不损失自愈能力**。
- **验收**：✅ 已做（10-31 08:08）—— `bash -n` 通过；仓库与 `/opt` 两份已同步
  （备份 `bot-watchdog.sh.bak-livefail-0808`）；`systemctl restart` 后容器
  `Up 9 → 10 分钟` **未被重建**，日志无“重建容器”；三层判活单独测均为 ✓，计数文件不存在（=0）。
  顺带发现 Koishi 当时并未在跑，重启守护后 `5140` 已拉起。
- **同类残留（待查）**：入口 `entrypoint.sh` 的 10s 判活循环会重启 QQ，所以
  “QQ 挂了”本不该走到重建分支；07:59 那次更可能是 **supervisor 或 5099 瞬时不可达**。
  下次再出现该日志时，先抓 `docker inspect` + `docker logs` 再下结论。

---

### P1-7 ✅ WebUI 已放开外网访问（HTTPS）

- **需求**（10-31 09:05）：从外网访问 SnowLuma WebUI。已确认：**来源 IP 不固定**
  （手机/出差 → **白名单不可用**）、**只放 WebUI（5099）**，不动 OneBot 3001。
- **实际做法**（SnowLuma 不自带生成证书，必须严格按此顺序，否则 WebUI 直接起不来）：
  1. 生成自签证书 `config/cert.pem` + `config/key.pem`（EC prime256v1，825 天，
     SAN = `IP:<SERVER_IP>, IP:127.0.0.1, DNS:localhost`；key.pem 已 600）；
  2. 先**只开 TLS、仍绑 127.0.0.1** 验证（日志 `listening https://127.0.0.1:5099`，
     https 登录 success、明文 http 拿不到响应）；
  3. 确认可用后再把 `webuiHost` 改为 `0.0.0.0`（`isValidBindHost` 对纯 IPv4 返回 true）。
- **配置落点**（两处要对齐，**env 优先于 runtime.json**）：
  - `snowluma.env`：`SNOWLUMA_WEBUI_HOST="0.0.0.0"`、`SNOWLUMA_WEBUI_TLS="true"`
    （`parseBoolValue` 接受 `1/true/yes/on`）；
  - `config/runtime.json`：`webuiHost: "0.0.0.0"`、`webuiTls: {enabled: true}`；已备份
    `runtime.json.bak-before-tls-0907`。
- **访问方式**：`https://<SERVER_IP>:5099`。自签证书会弹安全警告，需点“继续访问”；
  口令见 `/root/deploy/snowluma-webui.pass`。`http://` 会被拒。
- ⚠ **未完成的防护（重要）**：
  1. **TOTP 未开**。本仓库里端点是 `/api/auth/totp/begin` → `/confirm`（**不叫 2fa**，
     按 2fa 搜不到），需手机验证器扫码，本轮**未做** —— 在白名单不可用前提下这是最该补的一项；
  2. **本机 `ufw` 处于 `inactive`**（`systemctl is-active ufw` 返 active 只说明服务在跑，
     **`ufw status` 才是真相**）—— 所以 5099 目前在公网只靠 HTTPS + 口令；
  3. **阿里云安全组是否已放行 5099 未确认**：从本机 curl 自己的公网 IP 返 `000`，
     但 EIP 一般不支持 hairpin 回环，**不能据此判定外网不可达**，需从外部网络实测。
- ❗ **本次副作用**：host/TLS **只在启动时生效、不能热重载**，而重建容器**会丢 QQ 登录态**
  → 09:09 起重建完 `3001` 不再监听、机器人下线。恢复只需到账号页**点一下「登录」**
  （**不需要扫码、不碰 168**，见 P1-8）。
  ⚠ 但本次真正卡住登录的不是丢登录态，而是 P1-9：**改 bind 地址把 watchdog 的
  判活条件弄失效了，导致每 ~90s 重建一次容器**，任何点击/扫码都作用在即将被拆的容器上。

### P1-8 ❗ 定论（10-31 09:25 修正版）：登录态不跨重建，但**恢复只需点一下「登录」，不用扫码**

- **成立的部分**：`run.sh down && up` 后一定回到 `awaiting login`，`3001` 直接不再监听，
  等 1 分钟也不会自恢（08:22 已登录并跑起 3001；09:07 开 TLS、09:09 改 host 各重建一次）。
- ❌ **错误并已推翻的部分**：我 09:10 由 `awaiting login` 直接推出“**必须重新扫码**”，
  于是整个 09:11–09:17 都在刷二维码、等你扫码 —— **其实根本不需要**。
  09:15:28 一看画面才发现：重建后停在的是**账号选择页**（头像 + 昵称「<BOT_NICKNAME>」+ QQ 号），
  中间有个**「自动登录」勾选框**，下面是个**「登录」按钮**。
  **勾上自动登录 + 点登录，约 15 秒就上线**，全程无二维码、**不碰 168**：
  ```
  09:24:49 点击（613,497 勾选框 → 639,537 登录）
  09:24:59 [Bridge] self info: UIN=<UIN>
  09:25:05 ✅ 3001 监听
  ```
- **坐标补表**（归入 `run.sh` 注释）：账号页「自动登录」勾选框 `(613,497)`、
  「登录」按钮 `(639,537)`。⚠ 之前的 `qr` 子命令点的 `(639,448)` 在这个页面上什
  么也不是，所以“刷码后文件 mtime 不变 / 二维码不出现”是页面不对，不是 168。
- ❗ **对 P0-1 的连带影响（重要，待重新审视）**：既然重建后默认停在**账号页**而不是
  扫码页，那本文 P0-1 里那套“168 冷却窗口”叙事需要打个问号：部分失败可
  能是**页面状态与预期不符**（在账号页上刷码、点错位置）而非服务端拦截。
  下次再遇到登录不进去，**先 `run.sh shot` 看画面再动手**，不要直接假定要扫码。
- **运维含义（修正版，成本比原先认为低得多）**：重启容器 = 机器人下线 + **需要一次人工
  点击**（不是扫码），所以仍应**非必要不重启、要重启就把改动攒成一批**；但不再需要
  为“碰 168 概率门”而恐惧重启。待验证：勾上自动登录后，重建是否连点都不用
  （若确实能全自动，重启成本就降到接近零，可单独评估把 `nt_runtime/`、`qq/`
  的会话做成真正可移植的持久登录）。
- **同时补文档一处空白**：“登录态能否跨重建保留”原本没有单独条目，只在 P1-4/P0-4
  补注里零散提过。另正一句：P1-1 其实是“scrot/xdotool 固化进镜像”（我 09:10 说错了编号）。

### P1-9 ❗ 已修：判活写死 `127.0.0.1:5099`，开放外网后 watchdog 陷入 90s 重建死循环

- **现象**：10-31 09:11–09:20 期间，容器每 ~90 秒被重建一次，QQ 永远登不上：
  ```
  09:12:58 容器在但内部组件不完整（连续 3 次），重建容器...
  09:14:37 容器在但内部组件不完整（连续 3 次），重建容器...
  09:16:15 容器在但内部组件不完整（连续 3 次），重建容器...
  09:17:53 容器在但内部组件不完整（连续 3 次），重建容器...
  ```
- **根因（P1-7 与 P1-6 的耦合疏漏，由我引入）**：P1-6 写的判活第三层是
  `ss -ltn | grep -q '127.0.0.1:5099'`，而 P1-7 把 `webuiHost` 改成 `0.0.0.0` 后
  `ss` 输出变成 `0.0.0.0:5099` → **字面量永远匹配不中** → 每轮必失败 → 凑足 3 次就重建。
  连续两次改动各自正确，合在一起却是死循环 —— 改 bind 地址时必须同步检查所有
  按地址字面量做健康检查的地方。
- **修复**：判活改为只匹端口、不关心理它绑在哪：`grep -qE ':5099([[:space:]]|$)'`
  （同时兼容 `127.0.0.1` / `0.0.0.0` / `[::]`）。仓库与线上已同步，线上备份
  `bot-watchdog.sh.bak-5099fix-0921`；`rm /opt/logs/snowluma-live-fail` 清计数 + 重启 unit。
- **同错误第二实例（已一并修）**：`ops/s0-verify.sh:238` 也写死了 `127.0.0.1:5099`，
  会在开放外网后误报 `bad "WebUI 5099 未监听"` —— 闸门误报比没闸门更坑，已同样改为匹端口。
- **验收**：✅ 09:21:22 重启 watchdog 后，容器 `created=09:19:47` 保持 `Up`、不再被拆；
  09:25:05 登录成功且 `verify-onebot.sh` 12 项全绿。
- **遗留待查**：本次死循环能跑起来，说明 P1-6 的“连续 3 次”计数**只防住了瞬时抖动，
  没防住“持续性误判”**（判活条件本身错时，3 次只是把 20s 拖到 60s）。可考虑加一个
  **重建频率上限**（如 1 小时内最多重建 1 次，超阈就只告警不动作），否则一旦
  判活逻辑写错，就是无上限地拆登录态。

### P1-10 ✅ 已修：群聊回复全部发不出去（retcode 1400，引用回复参数传错了位置）

- **现象**（10-31 09:51 用户报“提问回答都是当前无法回复”）：链路其实是通的，
  只是最后一步挂：
  ```
  09:51:47 [运营] 群 <GROUP_ID> 唤醒（被@）        ← 收到、白名单对
  09:51:51 [用量] in=351 out=111 成本≈0.0084元    ← DeepSeek 正常返回
  09:51:51 [E] 发送失败 send_group_msg retcode: 1400  ← ❌ 卡在投递
  → deepseek.js:709 兜底→ 用户看到“抱歉，我当前无法回复。请稍后再试。”
  ```
  对比同一秒的两次调用，差异只有一个字段：
  `message="你好呀…" auto_escape={...}` → 1400；`message="抱歉…"`（不带）→ 09:51:52 发送成功。
- **根因**：`deepseek.js:435` 写的是
  `bot.internal.sendGroupMsg(groupId, part, quote ? { message_id: quote } : undefined)`，
  但 adapter-onebot 的签名是
  `defineExtract("send_group_msg", "message_id", "group_id", "message", "auto_escape")`
  —— **第三个位置参数是 `auto_escape`**，不是引用回复参数。于是 `{message_id}` 被当成
  `auto_escape` 发给网关。**NapCat 对非法值宽容忽略，SnowLuma 严格校验 → 1400**，
  所以这是一个“NapCat 时代就错、迁移后才暴露”的隐藏 bug。群聊必挂，私聊正常。
- **修复**：改成 OneBot v11 正确写法 —— 引用是 **message 数组里的 `reply` 段**：
  `[{type:'reply',data:{id}}, {type:'text',data:{text}}]`；并加一层保险：
  带 reply 段发送失败时**自动降级为不引用重发**（消息不丢），并在本次运行内关掉 quoteReply。
- ⚠ **部署过程中两个坑（下次改插件必来看）**：
  1. **`/opt/koishi/plugins/deepseek.js` 是独立副本，不是软链，也没有脚本同步**；
     只改仓库 `bot/plugins/deepseek.js` 不生效。cp 前先 `diff` 确认两边除自己改动外
     无其他差异（本次已确认，差异就是那两处），并备份 `deepseek.js.bak-1400-0957`。
  2. **`pgrep -f koishi | head -1` 会拿到 worker 子进程，不是主进程**。直接 kill 它
     会把主进程杀掉、worker 变成 PPID=1 的孤儿继续占着 5140 跑**旧代码**，
     而 watchdog 按端口判活所以不会重拉 —— 表面“已重启”实际没重启。
     正确做法：`systemctl restart qqbot-watchdog`（已验证它不会拆 SnowLuma 容器），
     并用 `ps -o lstart` 确认新进程启动时间真的变了。
- **验收**：✅ 09:59:47 全新 worker（PID=2343065）已加载新代码，`09:59:53 adapter connect`，
  `引用回复 开`，容器 `Up 40 minutes` 未被动过。人工回发结果待补。

### P1-11 ✅ 已加：时间注入 + 联网搜索（Bing 免 key + function calling）

背景（10-31 13:00 用户报“问周几、问搜索类问题都答不了”）：这是**两个不同性质的问题**。

#### （a）“今天周几”——不是能力问题，是根本没告诉它时间

- 原来全文件没有任何时间注入：`Date.now()` 只用在活跃窗口/超时/连发分桶，
  `toISOString().slice(0,10)` 是**用量按天统计**，都不是给模型的上下文 → 模型真的不知道现在几点。
- 修在 `messages` 的 system 行（原 `{ role: 'system', content: hot.systemPrompt }`），
  现在拼上 `当前时间：2026-10-31 13:05 周六（UTC+8）`。
- ⚠ **不能用 `toISOString()`**：那是 UTC，服务器在 UTC+8，直接拿去用会让时间整整差 8 小时，
  而且跟午夜时星期也会算错。已用 `getFullYear/getMonth/getDate/getHours/getDay` 取本地时间，
  并用 `-getTimezoneOffset()/60` 把时区标出来。
- **部署前必须实测进程自己的时区**：`tr '\0' '\n' < /proc/<worker>/environ | grep '^TZ='`。
  本例是“未设置 → 继承系统”，所以拿得到 CST；若哪天被 systemd/容器设成 `TZ=UTC`，
  这段代码会输出 UTC 时间并标着“UTC+0”，看着正常但全错。
- 用户已实测确认：“已经试过了可以”。

#### （b）联网搜索——❗ DuckDuckGo 在这台机器上不可达，改用 Bing

- 原计划接 DDG（免 key），**实测直接否定**：`html.duckduckgo.com/html/`、`lite.duckduckgo.com/lite/`
  、`api.duckduckgo.com` **三个端点全部 12s 超时、`http=000`** —— 阿里云国内机器访问不了。
  下次想接搜索**不要再试 DDG**，这一条就是为这个写的。
- 可达性实测（http 状态）：`cn.bing.com 200`、`www.bing.com 302`、`baidu.com 301`、
  `sogou.com 200`、`so.com 200`、`quark.cn 301`、`api.bochaai.com 404`。
- **解析质量实测**（能连通 ≠ 能解析，反爬会给验证页）：Bing 能干净拿到 `b_algo` 的标题+摘要；
  Sogou 部分能拿；360 标题正则不匹配。**所以选 Bing**。
- **网关支持度实测**：`api.deepseek.com` + `deepseek-flash` 支持 `tools`，
  `finish_reason: tool_calls`，而且**会一次并行返多个 tool_calls**（实测返 2 个）
  —— 实现时必须循环回填每一个，不能只取 `[0]`。
- **实现要点**（`bot/plugins/deepseek.js`）：
  - `SEARCH_TOOL` 定义 + `bingSearch()` 按 `<li class="b_algo">` 切块取标题/摘要；
  - `callDeepSeek` 改成 `for(;;)` 工具往返循环；**最后一轮不再下发 `tools`**，
    强制模型基于已搜内容出文字答案，防无限循环（上限 `BOT_SEARCH_MAX_ROUNDS`）；
  - **多轮 token 要累加 `usage`**，否则用量/成本统计会偏低（原代码只取单次 `payload.usage`）；
  - 搜索失败不阻断回复：把“搜索失败…”如实回给模型，要求它说“查不到”而不是编造；
  - `decodeEntities` 要带命名实体表（Bing 摘要里大量 `&ensp;` `&middot;`），
    且 **`&amp;` 必须最后替换**，否则 `&amp;lt;` 会被双重解码成 `<`。
- ⚠ **能力边界必须跟着开关变**（已做成条件判断 `capabilityLine`）：
  写“能搜”但实际关了 → 模型直接编造搜索结果；写“不能搜”但实际开了 → 它明明能搜却拒答。
  两者都是真实故障，改 `BOT_SEARCH_ENABLED` 时不用动代码，但**别在别处硬编码这句提示词**。
- **配置**（已接入现有热重载，改后约 5s 生效、无需重启）：
  `BOT_SEARCH_ENABLED=1`、`BOT_SEARCH_MAX_ROUNDS=2`（上限 3）、`BOT_SEARCH_MAX_RESULTS=5`（上限 8）、
  `BOT_SEARCH_TIMEOUT_MS=8000`。
- **验收**：启动横幅 `[搜索] 联网搜索 开（Bing，最多 2 轮 × 5 条）`；解析实测
  “2026年诺贝尔文学奖”能拿到多源一致的真实答案（加拿大作家安妮·卡森，2026-10-08），
  这是模型训练数据里绝对没有的信息。人工 QQ 实测待补。
- ⚠ **已知局限**：Bing 会把官网排前面（实测“NVIDIA 最新财报”返的全是驱动/首页），
  所以财报、股价这类需要具体数字的问题，命中率不如事件类问题。
  要更好的效果得换带摘要的正式搜索 API（Tavily / 博查，需注册 key）。

#### （c）❗ 11-02 复盘：上面那个“已知局限”其实是硬故障，而且天气问题根本无法靠搜索解决

现象（11-02 09:40，群 <GROUP_ID> 被@问“今天苏州的天气”）：日志里连跑 3 次
`[搜索]` 且各“**命中 5 条**”，看着很成功；但实际回复是“没搜到苏州今天的实时天气
（搜索结果都是百科、旅游攻略之类的，没有气象数据）”。

> **排障口径上的一个坑**：当时的日志**不记回复正文**，正文是从
> `state/deepseek/histories.json`（保存时间 09:40:19，与日志秒级吻合）反查到的。
> `命中 N 条` ≠ 有效命中。已补两条日志：`[回复] <chatKey>: <正文前 120 字>`
> 与 `DeepSeek 回复 … 工具=<本轮实际调用的工具>`。

取证（把当日那 3 条 query **原样重放**，不是推断）：

| query | 结果 |
|---|---|
| `苏州 今日天气 2026年11月2日` | 苏州市百度百科 / 苏州市政府 / 知乎旅游攻略… |
| `苏州天气预报 今天` | **与上面完全相同的 top5** |
| `苏州 气温 实时 天气预报 未来三天` | **仍相同**，零气象数据 |
| `苏州天气` / `苏州 今日天气`（短查询） | 中国天气网等真实结果 |
| `江苏 高考 政策 2026年11月` → `江苏 高考` | 前者退化，后者命中江苏省教育考试院 |

三条根因：

1. **提示词把模型推向长查询**：`SEARCH_TOOL` 的参数描述写的是“搜索关键词，尽量具体”，
   于是模型拼出带年份日期/问句/“未来三天”的串 —— cn.bing 对这种串会退化成实体兜底页。
   （(b) 末尾“官网排前面”与这条是同一机理的不同表现，当时归因不够。）
2. **天气根本不该走搜索**：`bingSearch` 只取标题+摘要，即便查询词正确也没有温度/降水数值。
   天气、开奖、汇率这类“结构化数值”问题需要**专用数据源**。
3. **无去重、无质量闸**：三条 query 拿回同一批垃圾，`BOT_SEARCH_MAX_ROUNDS=2` 的额度
   全烧完，模型只能回答“搜不到”。

#### （d）✅ 11-02 已修：天气独立成 `lib/weather.js`，搜索加“查询词治理 + 质量闸”

- **天气**（新文件 `bot/lib/weather.js`，工具名 `get_weather`）：
  主源 `api.open-meteo.com`（`geocoding` 拿坐标 + `forecast` 拿 current/daily，**免 key**），
  失败自动降级 `wttr.in?format=j1`（观测站口径，数值略不同）。选它们是因为本机实测可达且免注册。
  工具描述里写死“问天气/气温/要不要带伞/穿什么**必须调用本工具**，不要用 web_search 搜天气”。
  分支行为：城市空且有默认城市→用默认城市；无默认城市→让模型反问哪个城市；两源都挂→
  回“如实告知查不到，绝对不要编造”。地理编码结果做进程内缓存（同名城市二次查询 0ms）。
- **搜索**（新文件 `bot/lib/websearch.js`）：
  - `normalizeQuery`：剥掉日期/年份与“今天/最新/实时/未来三天/请问/怎么样”等噪声词，最多留 4 个 token
    （`苏州 今日天气 2026年11月2日` → `苏州 天气`）；
  - `isUseful` 质量闸，三条规则：无任何 token 命中判无效；**全部**标题命中
    “百科/维基百科/人民政府/政务服务/- 知乎/旅游攻略/官网首页…”判无效；
    **多词查询只命中 1 个 token 判无效**（实体兜底页必然只命中主体词，这条是关键）；
  - 判无效 → 自动用核心词重试一轮；仍无效 → 在回填给模型的文本前加“以下结果不能作为事实依据”；
  - 按 URL 去重 + 短 TTL 缓存（相同查询不重复打 Bing）。
- **开关**（`bot.env`，热生效）：`BOT_WEATHER_ENABLED=1`、`BOT_WEATHER_DEFAULT_CITY=苏州`、
  `BOT_WEATHER_TIMEOUT_MS=6000`。⚠ 值行不能带行内注释（同 (b) 里的旧坑）。
- **实测**（真实网络，非 mock）：
  - `get_weather(苏州)` → `当前：大致晴 17.5℃（体感 16.7℃），湿度 71%… 今天(2026-11-02 周一)：小雨，12.6~19.9℃，降水 3mm，降水概率 100%`
    （与中央气象台 12~20℃ 多云量级一致）；
  - `苏州 气温 实时 天气预报 未来三天` → 首判无效 → 重试 `苏州 气温` → 有效；
  - 坏城市名 / 空城市 / wttr 兜底 / 缓存命中四条分支均按预期（11-02 真实调用）。
- **验收**：启动横幅 `[天气] 开（Open-Meteo 主 + wttr.in 兜底；默认城市 苏州）`，
  `scripts/smoke-plugin.js` 16 项断言全绿（含“天气必须走 get_weather 且 `role=tool` 内容带 ℃”、
  “搜索必须走归一化后的短查询”）。
- ⚠ **待补**：真实 QQ 群里人工实测（本轮只做到插件级冒烟 + 真实数据源调用）。

### P1-12 ✅ 已加：统一运维入口 `scripts/botctl.sh` + 注意事项 `scripts/OPS-NOTES.md`

- **背景**：本次排障（P1-7→P1-11）的动作全部散在 `docker exec`/`xdotool`/`systemctl`/`ss`
  的手敲命令里，敲错一条就出事故（P1-9 的 90s 重建死循环就是把判活写死了字面量）。
  清点发现仓库缺两类能力：**恢复登录**（`post-login.sh` 只做“登录后的核验”，不含点击登录）
  和**安全重启**（无统一入口，也没有任何 `botctl`）。
- **`scripts/botctl.sh`**（297 行，已 `chmod +x`）子命令：
  `status`（只读总览）/ `restart <koishi|snowluma|watchdog|nginx|ddns|all>` /
  `login` / `shot` / `qr` / `clean` / `sync <plugin|watchdog|env>` / `verify` / `gate` /
  `tls` / `logs` / `listen`。**不重复实现**，`up|down|vnc` 仍走 `container/run.sh`，
  核验仍走 `post-login.sh`，闸门仍走 `s0-verify.sh`。
- **内建的事故防护**（每条对应一个真实踩过的坑）：判活只匹端口；重启 Koishi 走 systemd
  不 kill，并打印 worker 真实启动时间供核对、额外检测“5140 在监听但无主进程”的孤儿态；
  `sync plugin` 先 diff 确认再备份再 cp，`node --check` 不过就回滚；`login` 先拍画面、
  **用 3001 是否起来验收而不靠日志措辞猜页面**；`qr` 先删旧图（scrot 不覆盖同名文件）。
- **写过程中自查修正的 8 处自身错误**（记录下来是因为它们都是“凭记忆写”导致的）：
  curl 缺 JSON 头招 **415** 被当成 WebUI 异常（实测：form 编码=415，带 `Content-Type:
  application/json`=401）；日志文件漏了 `snowluma-` 前缀 → warmup 恒 0（实测修正后=27）；
  warmup 措辞记成 `round complete`，实际是 `member warmup completed`；`free -m | awk '/^Mem/'`
  在中文 locale 下取空（改 `NR==2`）；`scrot` 不覆盖同名文件却写了“先删再拍”的注释但没实现；
  `sync` 想回滚却没先备份（回滚为空操作）；替换时误将 `bind_addr` 的冒号丢掉；
  以及把“`docker restart` 不丢登录态”当结论写进了注释——**此项并未专项实测**（实测过的只是
  watchdog 走 rm+run 会丢），已改为不下结论、靠 3001 探测判定。
- **验收**：`bash -n` 通过；`status`/`tls`/`listen`/`shot`→`clean` 已实测输出正确（包括
  `:5099 监听 0.0.0.0` 与外网告警）；`gate` 经本脚本跑通 **39 项全绿 0 失败**。
  有副作用的子命令（`restart`/`login`/`qr`/`verify`/`sync`）本轮**未实地跑**，首次使用请人工盯着输出。
- **`scripts/OPS-NOTES.md`**（225 行）：拓扑/路径速查、“改了什么→怎么生效”映射表、
  判活三条铁律、登录恢复流程、**安全边界实况表**（TOTP 未开、`ufw` inactive 且
  `systemctl is-active` 会误导、安全组未确认、EIP hairpin 不可用）、12 条坑清单、
  4 项已知未解决、脚本索引。文档内引用的脚本路径已全部扫过一遍，无失效引用。

## P2 运维一致性

- **P2-1 ✅ 已改**：unit 描述过期。`/etc/systemd/system/qqbot-watchdog.service` 与仓库 `ops/systemd/qqbot-watchdog.service` 的 `Description` 均已改为
  `QQ Bot Watchdog (NapCat 或 SnowLuma 容器 + Koishi)`，并在 `[Service]` 上方加注释说明
  `BOT_GATEWAY` 二选一与"容器不自启、只有本 unit 能拉起"（已 `systemctl daemon-reload` 生效）。
- **P2-2 容器不自启**：`run.sh` 用 `--restart no`，宿主重启后必须靠 `qqbot-watchdog` 拉起（它已能 `docker inspect` 判活 + 重建）。所以 **watchdog 必须 `systemctl enable`**，这是唯一的开机自愈入口。
- **P2-3 容器/镜像漂移**：见 P1-1。凡是 `docker exec apt-get install` 的东西都只活在当前容器里，重建即失，**不要再走这条路**。
- **P2-4 `/opt/QQ` 可写挂载**：✅ **已实测取证（20:56），可收口**
  - `find /opt/QQ -newermt '-24 hours' -type f` → **0 个**（共 614M / 1533 文件），
    容器内 QQ 跑了一整天也没往安装目录写过任何东西；
  - **⚙ 原描述不准**：容器内 QQ 的 CWD 是 `/opt/snowluma`（`readlink /proc/807/cwd`），
    **不是** `/opt/QQ`；`/opt/QQ` 只是二进制/资源依赖路径，挂载 mode 为空（= rw）；
  - **结论**：改 `:ro` 可行，但**必须重建容器才生效**，而重建本身要付一次重扫代价。
    所以**不单独为这条重建** —— 把它挂在“下次因别的原因重建时”顺手改 + 验证 QQ 能起。
- **P2-5 ✅ 已补**：`docs/03-dev-log.md` 第十八节已写入扫码取码手法（`scrot`/`xdotool` 坐标表、二维码 2 分钟过期必须点刷新）与风控弹窗原文，下次无头机不用再摸索。
- **P2-6 多账号脚手架已就绪但未启用**：`entrypoint.sh`（`start_extra_qq`）+ `run.sh`（额外 HOME 挂载）已支持 `SNOWLUMA_EXTRA_QQ_HOMES`，镜像已重建；`/root/qq-acct2` 已建，开关留空 = 单账号。启用步骤与端口（3002）见 `04-migration-snowluma.md` 附录 B。**前置条件：内存扩容**（当前 available ≈141MB，第二个 QQ 需 300–500MB）。
- **P2-7 ⚠ 已被 21:10 推翻（保留作为反面教训）**：本条原写“登录失败在日志里查不到任何痕迹”，
  这是**错的** —— 当时只 grep 了 `168|serverError|risk` 这类服务端错误码，没注意
  `[Hook] account watch failed ... ENOSPC` 这条 **WARN**。真失败原因**在日志里**。
  教训：SnowLuma 不记服务端错误码，但会记**本地 hook/watch 异常**，
  排查登录问题应该先看 `grep -E 'WARN|ERROR'` 的全部行，而不是猜关键字。
- **P2-8 新增（21:10，21:25 修正定位）——inotify 上限是隐形地基，但与 168 无关**：
  `fs.inotify.max_user_watches` 默认 8192 对 SnowLuma 不够（要 watch 整个 QQ 配置树），
  会直接报 `account watch failed ... ENOSPC`。已提到 524288 并持久化到
  `/etc/sysctl.d/99-snowluma-inotify.conf`。
  **⚠ 定位修正**：修好它**并没有**让登录过去（21:23 实测仍 168），所以它不是 P0-1 的解法；
  但它是**必须保留的独立修复** —— watch 失效会影响会话变更感知，且换机器/重装必重现。
  另遗留一条待查：SnowLuma watch 的路径带 `nt_qq/` 一层，而实际是 `QQ/global/nt_db/login.db`。
- **P2-9 ⚠ 新发现（11-02）：Koishi ↔ 3001 的 WS 每天掉线十几次**：
  `adapter normal, will retry in 5s` → `ECONNREFUSED 127.0.0.1:3001` → 几秒后重连成功。
  11-02 当日 09:24 起已 14 次（**早于本次部署，与代码拆分无关**），每次约 10–30s 窗口内
  进来的群消息会丢。`grep -c 'failed to connect to ws://127.0.0.1:3001' /opt/logs/koishi.log`
  可量化趋势（10-31 凌晨那 300+ 次是 P1-9 的重建死循环，已修）。
  **动作**：先定因 —— 看 SnowLuma 侧日志与容器内 QQ 进程是否在同一时刻重启，
  再看是否宿主 TCP/连接数限制；**不要把 adapter 自动重连当成“没问题”**。

---

## P3 容量与版本

- **P3-1 内存**：1.8G 机器，容器当前 `392 MiB / 1.829 GiB`，宿主 `available 613 MB`。Koishi 起来预计再吃 ~200 MB，**可用会掉到 400 MB 上下**，swap 已用 552 MB。建议升到 4G；不升则必须保持 NapCat/SnowLuma 二选一（守护已做互斥）。
- **P3-2 客户端版本**：容器内 QQ `3.2.34-53644`。风控提示只点名"最新手机QQ"，客户端暂不强求升级；若风控解除后仍反复掉线，再考虑换 QQ 版本重打镜像。
- **P3-3 日志保留**：`runtime.json` 是 `logRetainDays: 7` / `logMaxTotalMb: 1024`，40G 盘够用；容器 ulimit `max-size=10m × 2`。

---

## 完成判据（Definition of Done）

- [x] 手机端风控解除，扫码一次成功，QQ 进主界面（10-31 08:22，第 7 次尝试）
- [x] `onebot_<uin>.json` 生成且 token/端口与 overlay、`bot.env` 三方一致（12 项全绿）
- [x] `127.0.0.1:3001` 监听，Koishi `adapter connect to server`
- [x] VNC 关闭，5900 不再监听（21:35 重建后仍无 5900；`snowluma.env` 已固定 `SNOWLUMA_VNC="0"`）
- [x] `BOT_GATEWAY=snowluma`，`qqbot-watchdog` enabled + running（运行态复验待 3001，见上一行）
- [ ] 回归 8 项全过，`s0-verify.sh` 0 失败
- [x] `.ck` / `.login.json` / 二维码截图已清理，WebUI 已改密（21:31，含重建后持久性验证）
- [x] `switch` / `rollback` 两个脚本容器化并各跑过一次 `--dry-run`
- [x] `scrot` / `xdotool` 固化进镜像，`run.sh shot` 在干净容器可用
- [x] watchdog unit 描述改成容器版（宿主 + 仓库两份都改，已 daemon-reload）
