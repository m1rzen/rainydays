# D07 完成五项真实研究验收

Kind: implementation

Status: proposed

Spec: [同事版交付规格](../../../specs/colleague-delivery.md)

Research: [技术资料：同事版研发](../../../research/technology-stack.md#同事版研发2026-10-18)

Blockers: [D02](./02-model-contract.md)、[D03](./03-context-and-retrieval.md)、[D05](./05-workspace-ux.md)

User stories: U04

## 用户结果与工作范围

1. 沿用 R4 的五项公开任务，在批准的配置/次数/预算内执行，保存实际结果。
2. 只按真实失败点修复搜索、读取、来源、工具选择或报告生成，避免另加研究代理框架。
3. 比较默认工具收敛前后相同任务的请求体积、选择错误、耗时与 usage；缺少可比运行就保留限制。

## 先读与研究

research-sources.ts、fetch-runtime.ts、tools/web.ts、writer.ts、scripts/evaluate-research.mjs、docs/research/R4-model-evaluation.md。

与 Lux 有直接对应且尚未解决的问题，按 [有界研究计划](../../../research/lux-reference-plan.md) 只研究本票需要的行为。已有材料足够就直接记录复用决定。外部库/API 有变化时读已安装定义与官方资料，不凭记忆更换技术栈。

## 验收条件

- [ ] 五项真实研究全部满足既有人工预期，失败来源不被伪装已读。
- [ ] 报告引用对应真正读到的资料；事实与推断分开人工核对。
- [ ] 完成 R5 真实选择表现比较或明确记录未测，不用 JSON 体积代替费用与成功率。
- [ ] 403/限流/网络中断如实记为失败或阻塞，不自动改用其他账号。

## 验证接口与证据

现有 research 回归与 R4 real Electron；真实任务使用独立用户目录、公开材料和新建输出。
通用计分与证据口径见 [acceptance](../../../agents/acceptance.md)。本票通过需要所有验收条件有实际证据；未测部分明示，不能以旧报告代替。

## 范围与回退

不增加浏览器自动登录、多渠道抓取框架、代理池或无限重试。
保留其他人的改动。数据结构变化先保存可恢复测试快照并明确兼容；代码按本票独立提交，回退只针对该提交，不能重置他人工作。

## 执行记录

尚未开始。实施时记录批准来源、起点提交、实际变更与偏离计划的理由；真实模型调用需核对已有授权。

## 审查与验证结果

尚未审查/验证。完成后写具体命令、结果、人工核对、未测项、回退方式和终点提交；全部满足才改为 verified。
