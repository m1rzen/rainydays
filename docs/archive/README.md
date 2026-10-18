# 历史资料索引

此处记录旧决策和观察。当前范围、顺序、状态与验收从[研发手册](../agents/README.md)进入；历史文件不能新增任务、冻结能力或改变授权。

| 历史材料 | 当前用途 |
|---|---|
| [旧R路线及多轮排期](legacy-roadmaps/2026-10-18-roadmap-before-cleanup.md) | 追溯范围如何变化；排期由D+A总路线替代 |
| [Lux v0.1.887差距表](legacy-roadmaps/2026-07-08-lux-gap-analysis.md) | 查旧问题线索，必须先核对当前代码；不延续其优先级 |
| [旧100% Lux规范](../../LUX-DESKTOP-100-PARITY-EXECUTION-SPEC.md) | 构建身份仍引用其原路径；仅按具体契约查询，旧68卡/角色链不再排期 |
| [parity材料](../../parity/README.md) | 已有基线、架构与机器证据；仅在当前改动涉及对应边界时读取 |

docs/tickets、旧docs/specs/R*、docs/work/r*、audits与devlog保留已有实现/审查/诊断证据，不构成当前执行队列。当前D票明确引用它们时再读相关部分。

仓库.rgignore让默认rg搜索避开本目录、旧全量规范、parity文档/报告与deliverables；不会删除文件、改变Git跟踪或跳过测试。需要查历史时用明确路径，例如`rg --no-ignore -- '关键词' docs/archive`。本机deliverables中的旧交接文本和备份保持本地，不作为新会话入口。
