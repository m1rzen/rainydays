# D04 任务完成、停止与中断一致

Kind: implementation

Status: verified

Spec: [同事版交付规格](../../../specs/colleague-delivery.md)

Research: [技术资料：同事版研发](../../../research/technology-stack.md#同事版研发2026-10-18)

Blockers: [D01](./01-startup-and-old-data.md)；[D02](./02-model-contract.md) 的本地协议契约与确定性回归已验证，不要求先完成其付费模型认证

User stories: U06、U08

## 用户结果与工作范围

1. 用现有 run/event 链统一执行中、等待、停止、完成、失败、取消、中断的界面投影。
2. 记录已完成成果与未完成事项；限步/循环检测命中时提供可理解的原因。
3. 同会话发送串行化；双击、切换会话、服务退出后不重复未知写入，继续动作由用户发起。

## 先读与研究

agent.ts、run-cancellation.ts、session-runtime.ts、process-tree.ts、src/index.ts 聊天接口、public renderer；既有 RT04/RT10。

与 Lux 有直接对应且尚未解决的问题，按 [有界研究计划](../../../research/lux-reference-plan.md) 只研究本票需要的行为。已有材料足够就直接记录复用决定。外部库/API 有变化时读已安装定义与官方资料，不凭记忆更换技术栈。

## 验收条件

- [x] 发送后 1 秒内有本地状态；取消 1 秒内反馈，受控工具/进程目标 5 秒内结束。
- [x] 工具失败、额度失败、等待授权被取消、达到步数限制都不显示成功。
- [x] 生成第一个文件后中断，重启后文件可达，第二个文件不会自动重放。
- [x] 两会话切换不会串结果；连续发送在同会话的顺序清楚。

## 验证接口与证据

现有流/输出许可/取消/服务恢复用例，真实 Electron 检查状态和成果。
通用计分与证据口径见 [acceptance](../../../agents/acceptance.md)。本票通过需要所有验收条件有实际证据；未测部分明示，不能以旧报告代替。

## Test and design seam

现有/api/chat SSE、/api/chat/cancel、desktop/state及临时用户目录Electron为公开验证接口。选择在原run事件链发送最终run_finished结果，优于用连接EOF推断成功；Agent的error事件与异常统一投影失败，工具失败以部分结果提醒，不新增调度器。取消立即显示正在停止，结算后显示已停止或未确认；不清空已显示内容/工具记录。保留每个会话现有响应DOM，切换后可重新挂载且不串流。

## 范围与回退

不新增任务调度平台、自治守护 Agent 或分布式事务。
保留其他人的改动。数据结构变化先保存可恢复测试快照并明确兼容；代码按本票独立提交，回退只针对该提交，不能重置他人工作。

## 执行记录

2026-10-18，整套D+A授权，起点83f976e；D01 verified、D02本地协议工程通过。检查发现：HTTP聊天没有将yield的error归入最终status，可能发成功通知；取消界面要等后端请求返回才显示中断且清空正文；切换会话会丢弃背景流的可见增量。先在既有真实服务/Electron接口复现，使用合成模型与临时文件，不调用真实模型。

## 审查与验证结果

实现后Standards/Spec顺序[审查](../reviews/04-run-stop-code-review.md)无剩余阻塞发现，进入reviewed。红绿过程、实际缺陷与验证入口见[诊断](../diagnostics/04-run-outcomes.md)。最终工程检查后逐项回填，不以源码验证代替安装候选或真实模型。

2026-10-18最终verified：

- `npm run check:product`：类型/lint、51项产品、15项UI/IPC通过。新增取消正文持久化；UI回执验证并行反序返回和跨轮ID复用。
- `node --test --test-name-pattern "D04 真实服务" tests/integration/rt01-session-runtime.test.mjs`：额度、工具失败、25步与等待授权取消通过，含真实通知/SSE结算。
- `node --test --test-name-pattern "RT-01 real server isolates" tests/integration/rt01-session-runtime.test.mjs`：两会话并行、同会话重复409、取消后继续、关闭回收通过。旧fixture未带Settings expectedRevision，按当前接口补齐并区分标题/对话请求，未放宽保护。
- `node --test tests/unit/session-runtime.test.mjs tests/unit/run-cancellation.test.mjs tests/integration/rt04-child-cancellation.test.mjs tests/integration/rt04-parser-cancellation.test.mjs`：24/24通过。
- `node --test --test-name-pattern "D04 real native tool" tests/integration/tool04-script-native.test.mjs`：真实进程取消、5秒内结算/PID消失/写入停止/后续可执行通过，整例约1.1秒。
- `node --test --test-concurrency=1 --test-name-pattern "D04 real Electron|R1 real Electron preserves|R2 real Electron completes" tests/electron/desktop-smoke.test.mjs`：4/4通过。D04真实Electron检查发送/取消本地反馈<1秒、背景/前台响应、正文保留；第一份DOCX中断重启后字节一致且可达，第二份未创建，模型请求数仍2。R1断流与R2多文档/重启/另存回归通过。
- 最终构建0.1.0+local.310ca673756f，643输入，检查一致。终点为包含此记录的D04提交。回退该提交即可，无数据库迁移。

本机源码与合成模型的行为验证成立；安装包/干净机器与真实任务质量仍未验收。下一项D05，沿用整套授权。
