# GLM 改进返工诊断

日期：2026-11-17。起点 `09676e4d9e49b34527951f224cf7ca0d78ea6196`；问题来源为 [R01–R09 独立审查](../reviews/2026-11-16-glm-improvements-code-review.md)。复现使用合成模型、真实本地文件、隔离 HTTP 与 Electron，不调用真实模型或日常数据库。

## 可判红的反馈入口

- 生产命令：`tests/product/delivery-convergence.test.mjs` 的 productive commands；修复前实际写出三个文件但模型请求数为 3，预期 4。
- 成果、图像、技能：原审查五个 artifact 探针全部重现；现已纳入 `local-image-observation.test.mjs`，并由真实 PathPolicy 的 `output-registry.test.mjs` 覆盖全文件摘要与版本变化。
- 请求与恢复：`tests/integration/delivery-recovery.test.mjs`；用真实服务进程、SSE、持久数据库和本地模拟 Provider 验证。
- 界面：`tests/electron/artifact-delivery.test.mjs`，输入→发现工具→登记→列表→重载→预览，避免仅向渲染函数注入假数据。

## 区分假设与结论

| 假设 | 区分方式 | 实际结论 |
|---|---|---|
| Agent 把命令工具名等同于检查，或生产命令本身未成功 | 独立读取三个真实文件，并观察模型请求数 | 文件均生成，停止规则误判；改为仅对确认的成功唯读查询计数，保留原循环检测 |
| 大文件确实无权限，或 maxBytes 被当成读取范围 | 真实授权 33 MiB 文件经同一网关登记 | 旧逻辑两次整文件上限读取均失败；改为单一授权句柄、流式完整摘要和有界预览 |
| 检查点说明已经持久化，或恢复上下文实际没有进入模型 | 真正重启服务，读取下一次 Provider 收到的请求 | 初版接线中的临时 system 消息被 setSystemPrompt 清掉；改为主系统提示组装的一部分，并保留文件版本校验 |
| 请求已经被受理，或失败前置请求污染去重窗口 | 首次无 key 返回 400，修复设置后以同键重试 | 原代码没有用户消息却拒重；去重预留移到原子 claim 成功后，并测并发、已受理重放和合法同文新请求 |
| 新模板已可用，或只有磁盘文件 | 真实目录→skill_open→下一次模型请求 | 平铺文件不可达；迁移为现有 A11 SKILL.md 包，并补真实加载证据 |

## 验证中识别的其他事实

1. 新内置包使 A11 的“没有内置包”和 R5 的“首轮恰好 12 工具”旧夹具假设过期。改为精确断言新增 meeting-minutes 包与 skill_open 常驻；遮蔽、停用、按需发现、危险工具不常驻和下一任务重置断言保留。
2. 扩大路径检查曾捕获本轮添加的中途 authority 活性检查改变旧 readFile 的“已打开句柄继续读原文件”契约；该额外检查现仅用于新 inspectFile，旧契约保持。
3. 旧 preflight 测试只预期 rootId，但起点源码实际已返回 directory/exists/path/rootId。起点模块受控对照确认这一点后，测试改为精确核对四字段，保留“不修改原文件/不创建目录”的断言。
4. 大文件校验增加 AbortSignal 分块检查；取消时不发布摘要。读取中版本或路径对象变化时拒绝登记；检查点写入失败也保证运行资源在 finally 中回收。

原始 red、阶段复试及冻结验证日志保存在本机 `test-results/glm-fix-*.log`，未删除首次失败。最终结果、版本范围和剩余产品验收见[修复复核报告](../reviews/2026-11-17-glm-repair-verification.md)。
