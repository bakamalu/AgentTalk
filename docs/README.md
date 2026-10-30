# 文档索引

| 文档 | 内容 | 读者 |
|---|---|---|
| [01-architecture.md](01-architecture.md) | 分层架构、关键机制、状态键设计、网关契约 | 想改代码的人 |
| [02-operations.md](02-operations.md) | 部署结构、启停、验证命令、常见故障 | 运维 / 排查故障 |
| [03-dev-log.md](03-dev-log.md) | 从零到现在的完整改造记录（19 项修复 + 踩坑） | 追溯"为什么这么写" |
| [04-migration-snowluma.md](04-migration-snowluma.md) | 网关迁移路线 B：三次可回滚窗口 | 执行迁移的人 |
| [05-external-links.md](05-external-links.md) | 第三方项目外链、许可与版本 | 环境重建 |
| [decisions/](decisions/) | ADR（架构决策记录） | 想知道"为什么不选另一个" |

---

## 写作约定

1. **时间戳**：每次改动在 `03-dev-log.md` 追加小节，标题带日期。
2. **不写密钥**：一律占位符（`<BOT_UIN>` / `<SERVER_IP>` / `<WEBUI_TOKEN>`）。
3. **失败也记**：踩过的坑比成功经验更值钱，写清"现象 → 根因 → 修法 → 如何验证"。
4. **决策进 ADR**：凡是"二选一"的选择，写一份 ADR，内容包括备选项和放弃理由。
