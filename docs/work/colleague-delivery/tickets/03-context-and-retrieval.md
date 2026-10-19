# D03 完整请求预算与长对话取回

Kind: implementation

Status: in-progress

Spec: [同事版交付规格](../../../specs/colleague-delivery.md)

Research: [技术资料：同事版研发](../../../research/technology-stack.md#同事版研发2026-10-18)

Blockers: [D02](./02-model-contract.md) 的本地协议契约与确定性回归已验证；不要求先完成其付费模型认证

User stories: U03、U10

## 用户结果与工作范围

1. 在最终模型请求处计算系统提示、历史、附件投影、工具 schemas 与预留输出的预算；先采用保守可配置估算，记录误差，避免硬编码所有模型同一容量。
2. 压缩保留用户目标、关键约束、已生成成果引用与工具调用成对关系；原始历史继续保留。
3. 摘要失败/容量不足时显示有界降级与分段/取回方式；摘要请求自身也受预算和取消约束。

## 先读与研究

src/memory.ts、agent.ts、task-tools.ts、attachment-reader.ts；ConversationMemory 与 Agent 本地模型服务测试。

与 Lux 有直接对应且尚未解决的问题，按 [有界研究计划](../../../research/lux-reference-plan.md) 只研究本票需要的行为。已有材料足够就直接记录复用决定。外部库/API 有变化时读已安装定义与官方资料，不凭记忆更换技术栈。

## 验收条件

- [ ] 用小上下文配置和动态发现工具强制触发超限，发送前即可处理，不能依靠服务端拒绝。
- [ ] 跨 20 轮及重启后的早期关键事实可通过原始资料/历史定位核对。
- [ ] 摘要超时、空结果、用户取消都能结束；不把静默删掉上下文后猜测的答案当正常成功。
- [ ] 工具调用/结果成对；已产生成果路径和用户禁止事项不因压缩遗失。

## 验证接口与证据

现有 conversation/stream 回归 + 一个完整 Agent 压缩取回场景；真实模型长对话质量纳入 F04，不自造摘要通过率。
通用计分与证据口径见 [acceptance](../../../agents/acceptance.md)。本票通过需要所有验收条件有实际证据；未测部分明示，不能以旧报告代替。

## 范围与回退

不建立向量数据库/知识图谱/多 Agent 策展系统；默认容量需来自实测或所选模型官方资料。
保留其他人的改动。数据结构变化先保存可恢复测试快照并明确兼容；代码按本票独立提交，回退只针对该提交，不能重置他人工作。

## 执行记录

2026-10-20，沿用整套路线授权；起点0ef7f4b。D02本地依赖满足，D13阻塞不影响本票。先处理最终请求预算与按配置调整的公开入口，再处理压缩和原文取回；只使用隔离模型fixture，不扩大既有真实模型授权。

## Test and design seam

通过真实LLMClient→本地HTTP模型接口验证完整投影与工具schemas在发送前受预算约束；通过真实Agent、ConversationMemory与数据库恢复验证压缩/取回。采用profile工作预算与输出预留、最终LLM请求强制检查、Agent在所有动态注入后触发压缩，避免仅检查memory正文的盲点。原始历史保留；摘要失败不得静默删除后继续。规格D03段维护此决定。

## 审查与验证结果

预算子切片已实现并按[审查](../reviews/03-code-review.md)核对；整票仍in-progress，历史取回/压缩尚待完成。

- `node --import tsx --test tests/product/request-budget.test.mjs tests/product/model-contract.test.mjs`：预算/并发4项（最初3项均red）与协议21项通过。低预算时流/非流均在HTTP前拒绝、动态schemas重新核算、输出预留写入请求、实际usage偏差和共享Client并发配对已验证。
- `node --test tests/contract/config-managed-store.test.mjs`：9/9。profile预算持久化、旧bundle默认、非法预留拒绝，原凭据断言保持。
- `node --test --test-name-pattern 'D03 real Electron' tests/electron/startup-recovery.test.mjs`：1/1，24.397秒；真实设置保存与重启读回2048/256，无模型调用。
- `npm run check:product`：typecheck、lint、产品55/55、UI/IPC15/15。未调用真实模型或改日常配置。真实容量和长对话内容质量尚未认证。

本预算切片终点为`feat: enforce configurable budgets on complete model requests`提交；后续继续本票，不将本记录视作完整D03验收。
