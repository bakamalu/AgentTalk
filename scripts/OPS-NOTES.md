# 运维速查与注意事项 —— QQ 机器人（SnowLuma 网关）

> 配套脚本：[`botctl.sh`](botctl.sh)。本文只讲**正确顺序**和**踩过的坑**，
> 不讲架构（架构见 [`../docs/`](../docs)）。
> 所有"实测"字样都指 2026-10-31 在那台服务器上跑出来的真实结果；
> 标"未验证"的请不要当结论用。

---

## 0. 三十秒上手

```bash
cd /root/code/AgentTalk
scripts/botctl.sh status          # ① 先看这个，只读，任何时候都能跑
scripts/botctl.sh login           # ② 群里 @ 没反应且 :3001 未监听 → 恢复登录
scripts/botctl.sh restart koishi  # ③ 改了插件代码之后
scripts/botctl.sh gate            # ④ 收工前跑一次，39 项必须全绿
```

**判断"机器人是不是挂了"只看一个信号**：`status` 里 `:3001 监听` 且 `warmup 完成 > 0`。
两者缺一，群里 @ 它就没反应（`mentionOnly: true` 意味着未被 @ 的消息本来也不回，那是正常行为不是故障）。

---

## 1. 一页拓扑

| 端口 | 用途 | 当前 bind（实测） | 说明 |
|---|---|---|---|
| `3001` | OneBot v11 WS，Koishi 连它 | `127.0.0.1` | 由 supervisor 按 uin 生成 `config/onebot_<uin>.json` |
| `5099` | SnowLuma WebUI | `0.0.0.0` ⚠ | 10-31 为开放外网改的，回滚见 §5 |
| `5140` | Koishi | `127.0.0.1` | HTTP/WS |
| `5900` | VNC | 不监听 | `SNOWLUMA_VNC="0"` |

容器 `qqbot-snowluma` 用 `--network host`，**所以 bind 0.0.0.0 = 直接裸暴露公网**，中间没有 NAT 隔离。

| 路径 | 内容 |
|---|---|
| `/root/deploy/bot.env` | Koishi 侧密钥与白名单（`BOT_ALLOWED_GROUPS` 等） |
| `/root/deploy/snowluma.env` | SnowLuma 侧口令、EULA、日志目录、`SNOWLUMA_WEBUI_HOST/TLS` |
| `/opt/snowluma/config/runtime.json` | `webuiHost` / `webuiTls.enabled`（env 会覆盖它） |
| `/opt/snowluma/config/cert.pem` `key.pem` | WebUI 证书（key 权限 600） |
| `/opt/snowluma/config/webui.json` | 口令 scrypt 哈希，**别手搓**，走 API 改 |
| `/opt/snowluma/logs/snowluma-YYYY-MM-DD.log` | 主日志（⚠ 文件名带 `snowluma-` 前缀） |
| `/opt/logs/koishi.log` | Koishi 日志（看 `[天气]`/`[搜索]`/`[回复]`、`retcode`、唤醒记录） |
| `/opt/koishi/state/deepseek/histories.json` | 机器人**实际回复正文**在这里（日志只记前 120 字）；排“它到底回了什么”靠保存时间反查 |
| `/root/.config/QQ/global/nt_db/login.db` | QQ 登录凭据（挂载进容器） |

**两份"仓库 vs 线上"的独立副本，没有自动同步**（改仓库必须显式部署）：

| 仓库 | 线上执行副本 | 部署方式 |
|---|---|---|
| `bot/plugins/deepseek.js` | `/opt/koishi/plugins/deepseek.js` | `botctl.sh sync plugin` |
| `bot/lib/*.js`（10 个模块，含 timers.js 定时提醒、members.js 平台无关成员解析） | `/opt/koishi/lib/` | 同上，`sync plugin` 会自动连带同步（11-02 前旧版**只 cp 一个文件**，拆模块后沿用会把线上部署成缺模块 → 插件加载失败） |
| `ops/bot-watchdog.sh` | `/opt/bot-watchdog.sh` | `botctl.sh sync watchdog` |

---

## 2. 改了什么 → 怎么生效（最容易搞错的一张表）

| 改动对象 | 生效方式 | 不这么做的后果 |
|---|---|---|
| `BOT_SEARCH_*`、`BOT_WEATHER_*`、`BOT_QUOTE_REPLY`、`BOT_REMINDER_*`、敏感词等热配置 | 约 5s 自动重载，**不用重启** | 白重启一次 |
| `bot.env` 里其余变量 | 需重启 Koishi，且必须验证进程真拿到了新值 | 改了但进程还是旧值 |
| `bot/plugins/deepseek.js`（及 `bot/lib/`） | `botctl.sh sync plugin`（diff 确认 → `FORCE=1` → 逐文件备份+cp → `node --check` → 重启） | 跑的仍是旧代码（无软链！）；只 cp 主体不 cp lib 则 `Cannot find module` |
| `snowluma.env` 的 `WEBUI_HOST` / `WEBUI_TLS` | 仅进程启动时读，**无热重载** → 重启容器 | 配置写了但没监听 |
| `runtime.json` | 同上，重启容器 | 同上 |
| WebUI 证书 | 放 `cert.pem`+`key.pem` 后重启容器；开 `webuiTls` **前**必须先有证书 | `requireTlsContext()` 抛错，**WebUI 完全起不来** |
| `ops/bot-watchdog.sh` | `cp` 到 `/opt` + `systemctl restart qqbot-watchdog` | systemd 跑的是 `/opt` 那份旧文件 |

验证"进程实际拿到的值"（改 env 后必看）：

```bash
tr '\0' '\n' < /proc/$(pgrep -f 'koishi listen' | head -1)/environ | grep BOT_ALLOWED_GROUPS
```

⚠ `ops/snowluma/setup.sh` 是"runtime.json 已存在则跳过"，重跑**不会**撤销外网/TLS 改动。

---

## 3. 判活：端口在监听 ≠ 服务状态正确

三条铁律，都是真金白银的事故换来的：

1. **探测只匹端口，绝不写死 `"IP:port"`。**
   ```bash
   ss -ltn | grep -qE ':5099([[:space:]]|$)'   # ✅
   ss -ltn | grep -q  '127.0.0.1:5099'         # ❌ bind 一改就永久失配
   ```
   10-31 把 `webuiHost` 改成 `0.0.0.0` 后，watchdog 的判活字面量匹配不中 →
   连续 3 次失败 → **每 ~90s 重建一次容器**的死循环，机器人整上午离线。
   同一处写死还存在于 `ops/s0-verify.sh`，两处都要改。

2. **重启 Koishi 禁止 `kill $(pgrep -f koishi)`。**
   那通常拿到的是 **worker 子进程**；kill 掉主进程后 worker 变 PPID=1 孤儿，
   继续用旧代码占着 5140，而 watchdog 按端口判活认为"服务正常"不补拉
   —— 表现是"已重启"，实际什么都没变。
   正确：`botctl.sh restart koishi`（走 systemd），然后核对 worker 启动时间：
   ```bash
   ps -eo pid,lstart,cmd | grep -E 'worker.*koishi|koishi.*worker' | grep -v grep
   ```
   时间不是"刚才"，就是没真重启。

3. **取日志前先确认文件名。** SnowLuma 主日志是 `snowluma-YYYY-MM-DD.log`，
   漏掉前缀会让依赖它的判断**静默得到空值**（我的 `status` 第一版就把 warmup
   算成了恒 0）。稳健写法：`ls -t /opt/snowluma/logs/snowluma-*.log | head -1`。

另外两个小坑：
- `free -m | awk '/^Mem/'` 在中文 locale 的机器上匹配不到（行首是"内存："）→ 用 `NR==2`。
- `grep -oE '[0-9.\[:]+:5099'` 漏转义方括号会报 `Unmatched [` → 取地址用 `awk '$4 ~ /:5099$/ {print $4; exit}'`。

---

## 4. QQ 登录恢复（容器被重建之后）

**结论：不需要扫码。** 容器重建后停在**账号选择页**（头像 + 账号 + 「自动登录」勾选框 + 「登录」按钮），
勾上再点，约 15s 上线。一条命令搞定：

```bash
scripts/botctl.sh login
```

它按"先拍画面 → 按账号页点 → 用 :3001 是否起来验收"走，**不靠日志措辞猜页面**
（日志只有 `awaiting login` 一种措辞，区分不了账号页和扫码页，猜过一次就白刷了两回码）。

如果 60s 后 3001 仍没起，`login` 会打印两种可能；此时**别重复盲点**：

```bash
scripts/botctl.sh shot 诊断    # 看真实画面，别凭想象操作
```

要点：
- 控件坐标（1280x800）：「自动登录」`613,497`、「登录」`639,537`。页面改版就失效，
  改常数前务必先 `shot` 用像素确认（方法见 `ops/snowluma/container/run.sh` 注释）。
- 两次 `click()` 之间要 `sync()`，否则第二个点击会丢。
- 真需要扫码时：`botctl.sh qr`，手机 QQ「扫一扫」。**二维码约 2 分钟过期**；
  同账号一天限 3 次非首次登录（经验值，非官方文档），超限只会拿到坏码，只能等次日。
- `scrot -o` 遇同名文件**不覆盖也不报错** → 判断"刷码是否成功"要看文件 mtime/体积，别只看退出码。
- 上线后 **warmup 首轮约 4-5 分钟**（949 成员），期间发消息会失败，属正常。

---

## 5. 安全边界（截至 10-31 的实况，别当成已加固）

当前 `https://<SERVER_IP>:5099` 对公网开放，防护只剩 **HTTPS + 口令**。

| 项 | 状态 | 备注 |
|---|---|---|
| 自签证书 | ✅ 已放，SAN 含公网 IP，有效期至 2029-02（剩约 824 天） | `botctl.sh tls` 看详情 |
| `webuiTls` | ✅ enabled；明文 http 返回 426 | |
| TOTP 两步验证 | ❌ **未开** | 端点 `/api/auth/totp/begin\|confirm`（按 "2fa" 搜不到）；需手机验证器配合 |
| 主机防火墙 | ❌ `ufw status` = **inactive** | ⚠ `systemctl is-active ufw` 返回 `active` 是**误导**，那只表示服务进程在跑 |
| 阿里云安全组 | ❓ **未确认** | 需从外部网络实测；本机 curl 自己公网 IP 恒返回 `000`（EIP 不支持 hairpin），**不能用它判断外网可达性** |
| 来源 IP 白名单 | ❌ 不可用 | 访问来源是手机/出差，IP 不固定 |
| OneBot `3001` | ✅ 仍只绑 `127.0.0.1` | 本次刻意没放开 |
| `nginx` / `qqbot-ddns` | 实测均 `inactive` | WebUI 走 IP 直连；要上域名需先定这两个服务是否该常驻 |

口令强度规则：≥10 位、含小写、含大写、含特殊符号、无空格。
改密走 API（`POST /api/login` 拿 token → `POST /api/auth/change-password`，token 放请求头 `x-snowluma-token`，不是 cookie），**别手搓 scrypt 哈希**。

**想收回去**：`runtime.json` 的 `webuiHost` 改回 `127.0.0.1`（或 `snowluma.env` 里
`SNOWLUMA_WEBUI_HOST="127.0.0.1"`）+ 重启容器，然后改用 SSH 隧道：
```bash
ssh -L 5099:127.0.0.1:5099 root@<SERVER_IP>
```
在白名单不可用的前提下，**TOTP 是最该补的一项**。

---

## 6. 坑清单（现象 → 根因 → 正确做法）

| # | 现象 | 根因 | 正确做法 |
|---|---|---|---|
| 1 | 群里 @ 没反应；容器每 ~90s 被重建 | 判活写死 `127.0.0.1:5099`，bind 改 0.0.0.0 后失配 | §3 第 1 条；`grep -qE ':5099([[:space:]]\|$)'` |
| 2 | "机器人要求重新扫码" | 其实是账号页，有「登录」按钮 | `botctl.sh login`；先 `shot` 再动手 |
| 3 | 回复"抱歉，我当前无法回复"，Koishi 日志 `send_group_msg retcode 1400` | `send_group_msg` **第三个位置参数是 `auto_escape`**，不是引用参数；NapCat 宽容、SnowLuma 严格 | 引用要作为 message 数组首元素 `{type:'reply',data:{id}}` |
| 4 | 引用回复偶发仍失败 | SnowLuma 校验 `replySeq` 必须**正整数**，而消息 ID 存在**负数** | 保留"失败降级为不带引用重发"的保险，别去掉 |
| 5 | 问"今天周几"答错/拒答 | system prompt 里**没有任何时间注入** | 已在 `deepseek.js` 注入本地时间 + UTC 偏移；`toISOString()` 是 UTC，别用它 |
| 6 | 联网搜索接了 DuckDuckGo 却全部超时 | 该机到 DDG 三端点 `http=000 time=12s`，**阿里云网络不可达** | 改用 `cn.bing.com`（实测 200，解析质量最好） |
| 7 | 搜索结果里出现 `&ensp;` `&#39;` | HTML 实体没解码全 | 命名实体表 + **`&amp;` 必须放最后**，否则双重解码 |
| 8 | 改了 `bot/plugins/xxx.js` 但行为没变 | 仓库与 `/opt/koishi/plugins/` 是两份独立文件 | `botctl.sh sync plugin`（内含 diff 确认 + 备份 + `node --check` + 重启 + 核对启动时间） |
| 9 | `s0-verify.sh` 报截图残留计数不为 0 | 排障时 `scrot` 的图没清 | `botctl.sh clean` |
| 10 | 打开 WebUI 报 TLS 相关错误、页面完全起不来 | 开了 `webuiTls` 但没放证书 → `requireTlsContext()` 抛错 | 先 `cert.pem`+`key.pem`，再开开关 |
| 11 | `start.sh` 静默 exit 1 且无输出 | 脚本里 `. /etc/profile`（20.04 宿主会让整个脚本以 1 退出，`\|\| true` 拦不住 profile 内部的 exit） | 显式给 `PATH/HOME/LANG`，不 source profile |
| 12 | 改配置后 curl 自己的公网 IP 返回 000，误判"外网不通" | 阿里云 EIP 不支持 hairpin 回环 | 必须从**外部网络**实测，且受安全组控制 |
| 13 | 设了定时提醒，到点却没叫（日志 `[提醒] 投递目标失效…`） | `reminders.json` 能恢复提醒表，但 **bot 连接不可序列化**；重启后若该会话没再发过消息，就 `registerTarget` 不上、拿不到 bot | 预期行为：目标失效会 60s 退避重试最多 3 次，期间该会话发任意一条消息即可续上；仍不行走 `#状态` 看"待触发 N 个"确认表还在 |
| 14 | 同一条到点提醒被投两遍（日志同一 id、同一秒出现两行"主动消息已发"+"已触发"） | `tryTick` 在 `await fire(r)` **之后**才 `pending.delete`；await 让出窗口内并发的第二次 tryTick 又按 `status==='pending'` 捞到同一提醒 | 已在 `lib/timers.js` 修复：`tryTick` 改为**纯同步**的"快照→把到期项 `status` 改 `firing` 认领→`due.map(runFire)` 并发派发"，投递（含延迟代理轮）在各自 `runFire` 后台 await，不再阻塞调度、跨会话真正并发；同一提醒靠同步认领保证只派发一次，`createReminder` 也不再直调 `tryTick()`。回归见 `scripts/smoke-timers.js` 用例 #12/#13 |
| 15 | 想“到点@某个昵称的人”却只 @ 到了自己 | 旧版 @ 只认“5~12 位纯数字”且只当 QQ；昵称一律被丢弃 | 现 `set_reminder` 支持 `at_user_names`，走 `lib/members.js` 的 Satori 抽象 `getGuildMemberList` 查成不透明 userId（非 QQ 专用）；查不到/多人同名会回告模型去向用户要 ID |

还有两条属于"设计上的残余风险"，不是 bug 但要知道：

- watchdog 的"连续 3 次才重建"只防瞬时抖动，**不防持续性误判**（坑 #1 正是持续性误判）。
  建议加"重建频率上限"，例如 10 分钟内最多重建 1 次，否则只告警不动作。
- `verify-onebot.sh` 和群里实测**会真的发消息到群 <GROUP_ID>**，别在半夜跑。

---

## 7. 已知未解决

| 项 | 观测事实 | 状态 |
|---|---|---|
| QQ 会话周期性抖动 | `adapter connect ECONNREFUSED 127.0.0.1:3001`；同刻服务端 `[OneBot] session closed` → `[Hook] login detected: PID 不变` → warmup → 重新 listening，**每次约 7 秒**；30 分钟内 6 次，间隔不规律 | ❌ 未诊断。归因方法：先看 `docker ps` 的 created/Status 变没变，没变就**不是容器重建**，别去查 watchdog |
| 内存偏紧 | 实测 `used 1456MB / available 215MB` | ⚠ 抖动诱因之一，未处理 |
| 搜索质量 | Bing 把官网排在前面（问"NVIDIA 最新财报"返回驱动页/首页），财报股价类命中率低 | 要准就得换带 key 的 API（Tavily / 博查） |
| TOTP | 未开启 | ⚠ 见 §5 |
| 安全组 | 未从外部确认 | ⚠ 见 §5 |

---

## 8. 脚本索引

| 脚本 | 干什么 | 有副作用？ |
|---|---|---|
| `scripts/botctl.sh` | **日常统一入口**：status / restart / login / shot / qr / clean / sync / verify / gate / tls / logs / listen | 视子命令而定 |
| `scripts/export-from-server.sh` | 服务器 → 仓库回灌，**强制过脱敏与密钥检查** | 写仓库 |
| `ops/snowluma/container/run.sh` | 容器原生 `up\|down\|status\|logs\|shot\|qr\|vnc` | 起停容器 |
| `ops/snowluma/setup.sh` | 镜像准备与配置播种（已存在则跳过） | 写配置 |
| `ops/snowluma/start.sh` | supervisor 启动器（切 CWD → 载入 env → exec launcher） | 起进程 |
| `ops/snowluma/post-login.sh` | **登录后的**核验与网关切换（不含点击登录） | 改网关 |
| `ops/snowluma/verify-onebot.sh` | OneBot 协议层 12 项闭环 | **真发消息到群** |
| `ops/s0-verify.sh` | 39 项一致性闸门 | 只读 |
| `ops/bot-watchdog.sh` | 守卫（systemd `qqbot-watchdog`，`CHECK_INTERVAL=20s`） | 会重建容器 |
| `ops/migrate/switch-to-snowluma.sh`<br>`rollback-to-napcat.sh` | 网关切换 / 回滚 | 大改 |

**收工三连**（每次动过线上都跑一遍）：

```bash
scripts/botctl.sh gate && scripts/botctl.sh status && scripts/botctl.sh clean
```

回灌仓库用 `scripts/export-from-server.sh`，别直接 `cp` —— 它会拦住密钥。
