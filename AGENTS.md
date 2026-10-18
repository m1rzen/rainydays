# RainyDays 开发入口

面向少量同事的 Windows 通用 Agent。基础方向为文件、研究、文档和重复任务；最新规划加入代码、CLI、MCP、浏览器、原生桌面与有界子任务。

- 开始任务：先读 `docs/STATUS.md`、`docs/agents/README.md`，再读当前票据及其引用。
- 最新范围见 `docs/specs/general-agent.md`，基础工作流见 `docs/specs/colleague-delivery.md`；原已批准部分继续有效。D/A 新规划票据保持 proposed，不能把计划当完成证据；整体批准后按 `docs/work/general-agent/plan.md` 依赖连续执行，无须逐票重复确认。
- 开发流程见 `docs/agents/workflow.md`；修改运行链前读 `docs/agents/architecture.md`；开发代码/CLI/MCP/Computer Use/技能/子任务时读 `docs/agents/general-agent-capabilities.md`；安全投入边界见 `docs/agents/safety-budget.md`。
- Lux 仅作核心行为参考，按 `docs/research/lux-reference-plan.md` 研究。Prism、钉钉明确排除。旧 100% parity 规范与 68 卡为历史资料，不能重新成为普通功能前置门槛。
- 保留其他人的改动；本机数据库、密钥、私有备份和原始诊断不得进 Git。模型测试使用明确批准的配置与预算，已有授权按原范围延续。
- 最终交付标准见 `docs/agents/general-agent-acceptance.md`；`docs/agents/acceptance.md` 只负责基础任务。D18 是中间里程碑，A13 才是完整出口。模拟测试、旧安装包和源码启动不能代替当前安装包及真实模型证据。
