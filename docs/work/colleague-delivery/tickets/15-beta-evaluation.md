# D15 固定任务与 Beta 候选验收

本票只验收基础工作流。完整通用Beta还需[通用验收](../../../agents/general-agent-acceptance.md)与A13，不能仅凭本票发布为完整Agent。

Kind: implementation

Status: ready

Spec: [同事版交付规格](../../../specs/colleague-delivery.md)

Research: [技术资料：同事版研发](../../../research/technology-stack.md#同事版研发2026-10-18)

Blockers: [D03](./03-context-and-retrieval.md)、[D06](./06-file-evidence.md)、[D07](./07-research-live.md)、[D08](./08-document-quality.md)、[D09](./09-file-organization.md)、[D11](./11-rerun-template.md)、[D12](./12-errors-and-support.md)、[D13](./13-installer.md)、[D14](./14-upgrade-and-restore.md)

User stories: U01–U12

## 用户结果与工作范围

1. 落实 20 项合成资料、精确提示和人工预期，运行前固定 rubric 与费用/时间预算。
2. 在同一候选执行 40 次真实任务，按既定规则逐次核对；可复用符合相同候选条件的既有实际运行。
3. 完成 Beta 安装/停止/恢复与性能抽查，给出失败分类和下一步。

## 先读与研究

docs/agents/acceptance.md、R4-model-evaluation.md、现有评估/产品/安装测试工具。

与 Lux 有直接对应且尚未解决的问题，按 [有界研究计划](../../../research/lux-reference-plan.md) 只研究本票需要的行为。已有材料足够就直接记录复用决定。外部库/API 有变化时读已安装定义与官方资料，不凭记忆更换技术栈。

## 验收条件

- [ ] 总分至少 34/40，每类至少 8/10；40 次结果都保留，不能只留最好一次。
- [ ] 无未解决 P0/P1，所有必须的安装/数据/取消检查有证据。
- [ ] 真实费用/usage 不可获得时写未知；明确支持的模型/系统与限制。
- [ ] 不达标时列实际缺陷，保持未通过，不降低原门槛。

## 验证接口与证据

真实模型+文件人工核对+当前候选；确定性回归只作为补充，不能替代质量分数。
通用计分与证据口径见 [acceptance](../../../agents/acceptance.md)。本票通过需要所有验收条件有实际证据；未测部分明示，不能以旧报告代替。

## 范围与回退

不拓展为任意任务 benchmark 平台；不把 20 项成功率宣传成普遍准确率。
保留其他人的改动。数据结构变化先保存可恢复测试快照并明确兼容；代码按本票独立提交，回退只针对该提交，不能重置他人工作。

## 执行记录

尚未开始。实施时记录批准来源、起点提交、实际变更与偏离计划的理由；真实模型调用需核对已有授权。

## 审查与验证结果

尚未审查/验证。完成后写具体命令、结果、人工核对、未测项、回退方式和终点提交；全部满足才改为 verified。
