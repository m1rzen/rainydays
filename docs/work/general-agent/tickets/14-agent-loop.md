# A14 长任务Agent循环

Kind: implementation

Status: verified

Spec: [通用Agent规格](../../../specs/general-agent.md#7-2026-10-20路线修订开发模式与agent循环)

Blockers: 无

User stories: G04、G10

## 用户结果与工作范围

默认助手能像通用编码Agent一样完成几十到上百步的任务：迭代上限可配置且默认足够长；有可见的任务计划并随进展更新；用户在运行中追加的话进入下一轮而不是等任务结束；常用开发工具不必每次先search_tools发现。仍复用现有Agent/Session/工具管道，不新建第二个循环。

## 验收条件

- [x] 迭代上限从固定25改为配置项，默认≥100、上限可调；达到上限时如实说明未完成部分，不伪装完成。
- [x] 计划工具：模型写入/更新步骤及状态，界面按需展示；计划只是进度投影，不授予权限。
- [x] 运行中用户追加消息进入下一轮模型请求，停止仍立即生效；不重放已执行的写入。
- [x] 开发模式开启时，读写/命令核心工具首轮即可用；关闭时保持原按需发现与允许列表。
- [x] 产品回归、相关Electron用例通过；真实模型长任务表现留A04/A13。

## 范围与回退

不改模型协议、不建多Agent编排。按本票独立提交，回退只针对自身提交。

## 执行记录

2026-10-21起点eda664e。复用现有Agent循环与Session/run管道，未新建循环、未改模型协议。

- 迭代上限：设置中已有`common.maxIterations`（默认200，范围1–1000，通用设置已有输入框），本票让Agent每次run读取它（`resolveMaxIterations()`，隔离夹具无配置时200），替换固定25。达到上限时说明“已达到本次任务的最大循环次数（N），任务尚未完成；已执行的步骤和成果已保留”，并提示回复“继续”或调高设置；不伪装完成。
- 计划：沿用既有task_create/task_update/task_list/task_get与任务面板（task_created/task_update事件），任务只是进度投影，执行仍经broker。开发模式提示要求多步任务先列计划并随进展更新。
- 运行中追加：`Agent.steer(runId, text)`只接受当前活动run（非空、≤32000字、最多排队20条）；每轮模型请求前作为用户消息落库并产出`steer`事件，已执行工具不重放；回答结束时若有排队指令则同一run继续。`POST /api/chat/steer`绑定activeRunInteractions中的run identity，不匹配/已结束返回409；run结束后仍未取走的指令由HTTP循环作为下一输入继续，取消后不再执行。界面：本窗口运行中发送键变为“追加指令”（停止键同时可用），Enter/点击发送追加；附件与斜杠命令运行中不追加；气泡内显示“已追加，下一步处理/已加入对话”。
- 开发模式常驻工具：开发模式开启时read_repo、edit_files、undo_edits、execute_command、shell_start/input/output/list/kill、task_create/update/list/get首轮可用（仍只取人格允许列表内的工具）；关闭时保持原12项与search_tools按需发现。

## 审查与验证结果

按Standards/Spec自审，未委派。Standards：steer经run identity绑定，跨run/结束后拒绝；追加只增加用户消息，不改变授权或工具结果；同事模式工具集与提示不变；无数据库迁移。Spec：五项验收如下。

- `tests/product/agent-loop.test.mjs` 3/3：默认200与旧默认配置兼容；maxIterations=3时恰好3次请求后如实报告未完成；追加在下一请求出现、工具只执行1次、回答后追加继续同一run、错误run/空白/结束后拒绝、追加落库；开发模式常驻集与允许列表边界。
- `npm run typecheck`、`npm run lint`通过；`npm run test:product` 93/93；`npm run test:product:ui` 15/15；`npm run test:product:desktop` 4/4。
- 真实Electron：新增“A14 real Electron steers a running task”1/1（模型请求挂起时从输入框追加、跨run 409、下一请求末条为追加的用户消息且工具结果2条、完成后按键复原）；D04两项与A15开关通过（D04断言随本票改为运行中发送键为“追加指令”）。
- 既有失败：`R5 real Electron loads discovered tools…`在“previous allowlist measurement”步骤超时，回退本票改动后同样失败，与本票无关，留待单独排查。

未测：真实模型长任务表现（A04/A13）。回退：revert本票提交。
