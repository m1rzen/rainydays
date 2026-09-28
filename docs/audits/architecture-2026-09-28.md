---
workflow: project-workflow
kind: architecture-review
date: 2026-09-28
scope: product usability, authorization, execution evidence and governance
---

# RainyDays 架构调整候选

证据与复现见 [产品评估](baseline-2026-09-28.md)。未找到 CONTEXT.md 或 ADR 目录；现有约束主要来自 Lux 总执行规范及 parity 下的冻结设计。本文件提出方向，不定义生产接口，也不批准绕过现有保护。

## 候选 A：合并重复治理实现

- 建议强度：Strong。
- 模块：scripts 下 78 个 governance/generate-resolved 文件、39 份 resolved 清单、tests/helpers、report-schema。
- 当前 interface：每张卡各自维护文件范围、哈希、角色链、报告验证与生成步骤；共享源码改变会传导至多份卡。
- 当前 seam：任务清单本应表达数据，却同时派生出大量相似实现。
- 摩擦：当前五项清单 stale；主入口被 23 份 resolved 清单引用。
- Deletion test：删除重复任务实现、将差异留为声明数据，可以消除重复逻辑；删除整个行为测试则会丢失真实保障。
- 方向：一个通用验证模块处理任务目录与测试结果；发布候选单独绑定版本/产物身份。先保留旧行为测试作为对照，再逐步退役重复证明代码。
- Leverage / locality：新增任务只声明自己的行为用例；校验错误只修一处。
- 测试影响：保留来源/范围/失败判定与必要负向测试，减少只验证文件存在、关键词和哈希同步的门槛。
- 约束冲突：会改变 GOV-03/GOV-04、resolved 清单以及总规范的过程要求，必须通过专门的小范围迁移任务完成，不能直接修改期望以消除红灯。

## 候选 B：以一次任务表达有限授权

- 建议强度：Strong。
- 模块：Agent、CapabilityBroker、ToolPolicy、PathPolicy、运行交互模块。
- 当前 interface：调用方需要了解工具风险、审批 challenge、单次 grant、生命周期、子权限和路径许可。
- 当前 seam：授权分散在运行建立、单次工具调用和文件/进程执行阶段。
- 摩擦：正常 Agent 路径对 write/edit/create_docx/create_xlsx 每次询问；用户已指定输出目录仍需重复表达相同意图。
- Deletion test：删除宿主授权会把安全责任推回模型和每个工具，是负收益；把连续工具调用的相同授权事实集中到任务中，可以减少重复交互。
- 方向：任务开始时明确输入目录、输出目录、允许的操作及有效期；宿主逐次执行仍核对权限，范围内新建文件可继承许可。覆盖、删除、越界、外发、扩大进程能力另行确认。
- Leverage / locality：用户理解一次工作范围；调用者不承担挑战/许可细节；子任务只能继承明确批准的更小范围。
- 测试影响：从“每次都弹窗”转向“范围内少打断、范围外必拦截”，测试续期、取消、重启与子任务扩大权限。
- 约束冲突：改变 SEC-01 与 Persona 授权契约；必须先冻结新的权限含义并用行为测试证明，不能靠开启 full/unrestricted/YOLO 实现。

## 候选 C：将执行证明移出普通用户路径

- 建议强度：Strong（分离方向）；具体迁移工作量待验证。
- 模块：execution-runtime、native-process-consent、manual-execution-consent、原生宿主和构建元数据。
- 当前 interface：真实二进制身份、运行能力和测试投影元数据混在执行初始化中。
- 证据：`src/execution-runtime.ts:160` 起解析并要求 testProjection 匹配；`:188` 将其作为拒绝条件。拒绝手工终端也会通过原生 bridge 记录拒绝证明，详见 `manual-execution-consent.ts:363`。
- Deletion test：移走测试投影与证明生成不会自然消除运行沙箱；删除 AppContainer/Job/原生宿主则会丢掉真实限制。
- 方向：执行模块对产品只承诺有限执行、输出、取消和回收；内部保留产物身份校验与系统隔离。测试宿主、对抗证明和回执验证由专项测试/发布 adapter 负责。
- Leverage / locality：普通用户失败原因集中于可执行能力和授权；测试配置变化不再影响产品启动或普通拒绝路径。
- 测试影响：同一执行 interface 的成功、越权、取消和崩溃测试继续存在，测试证据身份验证放在发布阶段。
- 约束冲突：改变 SEC-03 冻结设计与 build-info 格式；迁移前必须列清不能变弱的保护属性。

## 候选 D：围绕一次任务和结果文件改善模块深度

- 建议强度：Strong（先修已复现缺陷）；大范围重构为 Worth exploring。
- 模块：Agent、ConversationMemory、LLMClient、文件/文档工具、renderer。
- 当前 interface：工具返回字符串后立即压缩；界面显示与最终保存的流消息可能不同；工具定义集合与模型预算分离。
- 证据：评估 F3、F4 的可复现故障；index 3,761 行、renderer 3,337 行、db 2,902 行说明后续改动需关注集中度，但行数本身不是重构理由。
- Deletion test：去除不合适的立即截断能消除真实信息丢失；简单拆分文件不会自动提升模块 depth。
- 方向：先修缺陷，再让一次任务拥有明确的输入、输出文件引用、进度、停止和恢复语义。只有在该行为要求下提取 module，避免另起一套运行内核。
- Leverage / locality：同一种结果文件可被模型分页读取、用户预览和后续任务复用；结果与界面的状态在同一处解释。
- 测试影响：用长文、表格、断流、文件生成和继续修改验证，而非模拟内部步骤。
- 约束冲突：与旧工具结果压缩及部分流式契约有关，应保留会话数据兼容与取消语义。

## 建议顺序

先做 D 中的已复现故障修复，和 A 中最小的开发反馈解耦；随后通过 B 完成用户可感知的一次任务授权。C 只有在它阻碍已选任务或打包时进入本轮，避免把“简化原生执行”做成新的漫长基础设施项目。详细实施方案应在选定任务后设计。
