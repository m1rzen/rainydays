# 第一批产品方向开发：资料完整性与回答断流

日期：2026-09-28。用户授权：开始按照产品方向和开发路线二次开发。

## 改动

- 删除工具结果入内存和恢复时固定 1500 字符压缩。完整保留预算内的单行 JSON、多行资料。
- 摘要边界纳入全部工具结果；无法保留近期内容时明确失败，原记录不被不合格摘要替换。
- 流建立后不自动重试；提前关闭及长度截断不返回成功工具调用。
- Agent 保存已显示正文和失败提示，界面保留模型错误及传输错误之前的文字。
- 新增从源码直接运行的产品回归，复用现有 Electron 测试入口。生产改动限于四个文件，未增加新的安全或运行框架。

## 验证记录

| 检查 | 结果 |
|---|---|
| 初次源码回归 | 7 项中 6 项失败，分别复现资料截断、预算漏检、摘要结果遗漏和中途重试 |
| Agent 持久化回归初次运行 | 失败：最后保存的仍是用户输入，未保存已显示正文 |
| EOF/length 初次运行 | 2 项均失败：未完成工具流被当作成功 |
| `node --import tsx --test tests/product/*.test.mjs` | 最终 11/11 通过，约 6 秒；测试使用临时 SQLite 和本地 HTTP/SSE |
| `npm run typecheck` | 通过 |
| `npm run lint` | 通过；最后改动另运行涉及文件 ESLint 和 renderer 语法检查，均通过 |
| `npm run build` | 通过；最终候选 `0.1.0+local.8a62c5fa3608`，模型资源无需下载，原生隔离构建复用校验通过 |
| `node --test --test-name-pattern "LLM\|memory" tests/integration/rt04-runtime-cancellation.test.mjs` | 最终 5/5 通过，包含取消与摘要回退 |
| `node --test --test-name-pattern "R1 real Electron" tests/electron/desktop-smoke.test.mjs` | 1/1 通过；真实应用启动，模拟两类断流，正文保留且不重复；测试后关闭进程并清理临时目录 |
| 全 RT-04 + SEC-01 Agent + DS-10 静态契约 | 12/14 通过。SEC-01 授权与 Agent 主循环通过、DS-10 3 项通过；RT-04 两项 Playbook 失败，详见下文 |

评审：[Standards 与 Spec 两次检查](../work/r1/reviews/01-code-review.md)。

## 现有工作保护

起始提交：`6a05df02523b446e891631e6594c38f96d2f5f3b`。

原工作树补丁、索引补丁、非忽略未跟踪文件与 SHA-256 清单保存于：
`C:\Users\raidriar\AppData\Local\Temp\rainydays-secondary-baseline-20260928-133731`。

本轮修改路线文档之前复核清单中 111 个文件，全部与备份相同。后续只更新其中本任务编写的 ROADMAP；其他原 WIP 不纳入提交。未访问真实模型或读取用户会话数据库。

## 未完成事项

- Playbook 旧测试仍调用按名称执行及 `getPlaybook`；当前已有 WIP 接口不同，分别报 id 无效与函数不存在。本轮未改 Playbook 实现，不把这两项失败隐藏掉。
- 超大资料目前提示在新会话分段读取；自动分页和原始大结果索引是下一切片工作。现有工具流水线 128 KiB 上限仍存在。
- 只有 stop/tool_calls 结束原因被视为完整结果；供应商接入需验证此兼容契约。
- 文档输入到成果输出、真实模型质量、小范围试用和候选安装包尚未验收。
