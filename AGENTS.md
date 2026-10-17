# RainyDays 开发入口

面向少量同事的 Windows 桌面助手：文件、公开资料研究、可编辑文档、手动重复任务。

- 开始任务：先读 `docs/STATUS.md`、`docs/agents/README.md`，再读当前票据及其引用。
- 产品行为以 `docs/specs/colleague-delivery.md` 的已批准部分为准；新增规划票据保持 proposed，不能把计划当作完成证据。用户明确批准整套计划后可按依赖连续执行，无须逐票重复确认。
- 开发流程与反馈尺度见 `docs/agents/workflow.md`；修改运行链前读 `docs/agents/architecture.md`；安全投入边界见 `docs/agents/safety-budget.md`。
- Lux 仅作核心行为参考，按 `docs/research/lux-reference-plan.md` 研究。Prism、钉钉明确排除。旧 100% parity 规范与 68 卡为历史资料，不能重新成为普通功能前置门槛。
- 保留其他人的改动；本机数据库、密钥、私有备份和原始诊断不得进 Git。模型测试使用明确批准的配置与预算，已有授权按原范围延续。
- 用真实用户结果验收；完成标准见 `docs/agents/acceptance.md`。模拟测试、旧安装包和源码启动不能代替当前安装包及真实模型证据。
