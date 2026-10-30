# 第三方项目外链

> 本仓库**不 vendor 任何第三方源码**。需要复现环境时按下面链接自行获取。
> 记录版本是为了"半年后还能重建同样环境"。

## 核心链路

| 组件 | 上游 | 本机部署路径 | 版本 | 许可 |
|---|---|---|---|---|
| QQ 客户端 | 腾讯官方 Linux QQ | `/opt/QQ` | 3.2.34-53644 | 专有 |
| 网关（现） | [NapNeko/NapCatQQ](https://github.com/NapNeko/NapCatQQ) | `/opt/napcat` + `libnapcat_launcher.so` | — | 见上游 |
| 网关（目标） | [SnowLuma/SnowLuma](https://github.com/SnowLuma/SnowLuma) | `/opt/snowluma` | v2.2.1 | **source-available 非商业**，非 OSI 开源 |
| 网关（目标·分支） | [bakamalu/SnowLuma](https://github.com/bakamalu/SnowLuma) | `/opt/snowluma-src` | 与上游 main 同步 | 同上 |
| 框架 | [koishijs/koishi](https://github.com/koishijs/koishi) | `/opt/koishi` | 4.18.11 | MIT |

## 依赖（版本必须钉住）

| 包 | 版本 | 为什么必须钉 |
|---|---|---|
| `@koishijs/plugin-adapter-onebot` | ^6.0.2 | v5.8.1 依赖 satori 2.x，与 Koishi 4.18 冲突 |
| `@satorijs/satori` | ^3.7.0 | 与上面配套 |
| `@satorijs/core` | **4.6.1**（`overrides` 锁定） | 不锁会出现两份 core，`session.internal` 为 undefined |

> 完整依赖见 [`../bot/package.json`](../bot/package.json)。
> 注意该文件是从生产机原样导出的，里面还留有历史遗留依赖
> （`koishi-plugin-chatgpt` / `koishi-plugin-openai` / `koishi-plugin-ai*`），
> 当前**未被 `koishi.config.js` 加载**，属于待清理项，不要因为"能跑"就误以为在用。

## 规范与参考资料

| 资源 | 链接 |
|---|---|
| OneBot v11 标准 | https://github.com/botuniverse/onebot-11 |
| SnowLuma 动作参考 | https://snowluma.github.io/zh/docs/api |
| SnowLuma SDK | https://www.npmjs.com/package/@snowluma/sdk |
| SnowLuma MCP | https://www.npmjs.com/package/@snowluma/mcp |
| DeepSeek API | https://api.deepseek.com |
| 机器人改造 playbook | https://github.com/rentaoyan0628-collab/dsh-qq-bot-playbook |
| qq-bridge（功能对照用） | https://github.com/Derpyu520/qq-bridge |

## 许可注意

SnowLuma 的 LICENSE 是**源码可见但非商业**：

- 可用于查看、学习、**非商业自托管**、私下修改；
- **商业使用**、或**公开发布修改版/衍生版**，需事先取得书面授权；
- 发行包内的**原生附加组件为专有组件**，不在源码许可范围内。

因此：

1. 本项目**只外链** SnowLuma，不复制其源码；
2. `external/snowluma-analysis.md` 是**行为分析笔记**，不含其代码；
3. 若将来从 fork 构建并分发，需先确认许可边界。
