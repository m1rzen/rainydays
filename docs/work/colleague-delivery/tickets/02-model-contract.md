# D02 认证一个可靠模型配置

Kind: implementation

Status: blocked

Spec: [同事版交付规格](../../../specs/colleague-delivery.md)

Research: [技术资料：同事版研发](../../../research/technology-stack.md#同事版研发2026-10-18)

Blockers: 可用且获准的真实参考配置；既有default五项研究因额度403失败，用户将补充配置，未自动调用其他已存密钥。本地工程已验证，D03/D04可按依赖例外继续。

User stories: U01、U08

## 用户结果与工作范围

1. 确定一个实际可用的参考配置；记录模型/服务版本、流式和工具调用能力与未知项。额度未恢复时先完成本地协议回归。
2. 核对串行/并行工具结果、拆分的工具参数流、非流响应、usage、认证/额度/限流/网络错误的真实映射。
3. 保留已开始流不重发语义；设置中只将已经验证的配置说明为支持。

## 先读与研究

src/llm.ts、model-connection.ts、settings-enrollment.ts、tests/product/connection.test.mjs、stream.test.mjs。

与 Lux 有直接对应且尚未解决的问题，按 [有界研究计划](../../../research/lux-reference-plan.md) 只研究本票需要的行为。已有材料足够就直接记录复用决定。外部库/API 有变化时读已安装定义与官方资料，不凭记忆更换技术栈。

## 验收条件

- [x] 连接检测不发送文件或旧历史，一次短请求，错误能给出下一步。
- [x] 可控服务验证文本流、工具流、错误/取消；未完成 JSON 不执行。
- [ ] 批准参考配置的真实文字→工具→结果→回答流程通过，记录实际请求数与 usage；无批准配置则只标工程完成。
- [x] 第二模型支持是可选兼容测试；不通过更换密钥或将 403 吞成成功过关。

## 验证接口与证据

connection/stream/task-tools 现有回归、一个合成协议 fixture；真实最小模型任务需核对授权，费用记录未知即未知。
通用计分与证据口径见 [acceptance](../../../agents/acceptance.md)。本票通过需要所有验收条件有实际证据；未测部分明示，不能以旧报告代替。

## Test and design seam

使用现有LLMClient.chat/chatStream/probe和真实Agent，对loopback OpenAI-compatible HTTP fixture交互，不替换SDK私有方法。串并行工具、拆分参数、结束原因、usage及取消都从公开返回值/下一次请求/Agent事件检查。沿用SDK4.104.0，无新依赖。完整性校验共享于LLM边界；工具参数schema与权限仍留在现有pipeline。

比较过改为统一Reply包装（会改动全部chat调用者）和保持Message兼容、附加可选usage。选择后者：chat返回兼容Message的响应与可选usage；stream最终事件携带可选usage。消息投影只发协议字段，宿主usage不回发提供方。没有usage保持未知，不记为0；标准include_usage请求不做静默兼容重发。具体决定见[规格](../../../specs/colleague-delivery.md#5-架构与测试决定)。

## 范围与回退

不新建多提供方路由平台、不自动账户轮换；不预设所有 OpenAI-compatible 服务完全等价。
保留其他人的改动。数据结构变化先保存可恢复测试快照并明确兼容；代码按本票独立提交，回退只针对该提交，不能重置他人工作。

## 执行记录

2026-10-18，用户整套D+A授权，起点b2cda55。先完成本地协议工程；未使用真实密钥或调用收费模型。已安装SDK类型确认finish_reason、stream_options.include_usage和空choices用量块。当前非流式未检查结束原因，流式未拒绝带成功结束标志的残缺JSON，usage丢失；以这些复现开始。

## 审查与验证结果

本地工程implemented，Standards/Spec顺序[审查](../reviews/02-model-contract-code-review.md)无阻塞发现，进入reviewed。红绿过程与旧测试故障界定见[诊断](../diagnostics/02-model-contract.md)。真实参考模型未测，整票不会因工程测试通过而改为verified；完成最终检查后记录工程通过与外部阻塞。

本地工程验证通过（2026-10-18）：`npm run check:product`类型/lint、50项产品和15项UI/IPC通过；21项新增协议、3项真实Agent集成计在其中。`node --test --test-name-pattern "RT-04 LLM" tests/integration/rt04-runtime-cancellation.test.mjs` 3/3；REL-04观测8/8。构建通过，build为0.1.0+local.9fe93412e678，643个输入。当前源码Electron：R1断流保留、R5首次配置一次检测及按需工具3项通过。无真实模型、费用、安装候选或同事试用证据。终点为包含本记录的D02提交；回退该提交，不涉及数据库迁移或日常配置。
