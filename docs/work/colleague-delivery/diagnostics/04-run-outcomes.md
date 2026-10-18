# D04 任务结果、停止与响应保留

日期：2026-10-18，起点83f976e。使用临时数据库、loopback模型、当前源码Electron和真实原生执行；没有真实模型费用或日常数据。

## 已复现的产品缺陷

1. 真实HTTP额度403后，Agent发出error并正常退出generator；/api/chat只在catch更改status，因此保存success/运行完成通知。红测试实际读到该通知。现在消费error事件，并在原有清理、Persona切换之后统一发run_finished；工具存在失败时为partial提醒，不宣布任务全成功。
2. 用户停止时Agent先重抛取消，未保存streamedContent。红测试重开历史只得到用户请求。现在先保存已显示正文与未完成说明，仍以取消异常结算，不保存半截工具调用。
3. 界面切换会话后丢弃背景answer_chunk，并将旧响应DOM移除。真实Electron红测试切回运行中的A只有欢迎页。现在每轮持有自己的响应节点，背景更新该节点，选回时重新挂载；通知、任务面板和朗读仍核对当前会话。
4. 停止界面等待后端结算才反馈，并清空正文/工具记录。现在立即显示正在停止、禁用重复停止，等待确认；网络失败/超时显示未确认，保留已有内容。连接正常关闭但没有最终结果也不宣称成功。
5. 并行tool_result总是更新最后一张卡片；红单测第一张始终执行中。AgentStep现携带toolCallId，按ID和执行状态配对；相同ID在后续轮次复用时选最新记录。正文与工具记录分开更新，取消/最终回答不清空卡片。

## 具体验证入口

- `node --test --test-name-pattern "D04 真实服务" tests/integration/rt01-session-runtime.test.mjs`：额度、工具失败、25步限制、等待授权时取消；检查实际SSE、通知与desktop状态。
- `node --test --test-name-pattern "D04 real Electron" tests/electron/desktop-smoke.test.mjs`：发送/停止即时反馈、两个运行切换、部分正文保留，以及生成第一份Word后中断/重启不重放第二份。
- `node --test --test-name-pattern "D04 real native tool" tests/integration/tool04-script-native.test.mjs`：真实原生Node进程写heartbeat；取消在5秒内结算、PID消失、写入停止，随后可执行新工具。
- `node --import tsx --test --test-name-pattern "D04 用户停止" tests/product/conversation.test.mjs`：数据库恢复已显示正文与未完成说明。

原生测试初稿错误设置30000ms，超过现有10000ms脚本上限，未启动便失败；更正fixture为10000ms后真实启动/取消通过。没有扩大执行上限或放宽保护。

RT-01既有长流程在Settings变更处发现fixture缺少当前必需的expectedRevision；按真实GET设置/更新返回值传递版本并保留原断言后通过。模型请求记录区分标题和对话流，原profile兼容断言仍检查两份实际对话。没有修改生产Settings规则。

## 边界

partial表示本轮曾出现失败工具，应检查记录；即使后来模型补救，也不凭模型一句成功就抹去失败。它是提醒，不替代真实成果评分。当前证据为本机源码与合成模型；安装候选、真实模型质量和同事试用继续由后续票据验收。没有引入新的任务调度、事务或安全平台。
