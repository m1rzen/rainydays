# A13 通用任务、安装与同事交付

Kind: implementation

Status: ready

Spec: [通用Agent规格](../../../specs/general-agent.md)

Research: [技术依据与研究问题](../../../research/general-agent-stack.md)

Blockers: A04、A06、A10、A11、A12、D18

User stories: G01–G11

## 用户结果与工作范围

汇合所有基础与新增能力，冻结支持矩阵、候选包和50项任务的输入/rubric/预算。先通用Beta，再完成稳定100次评分与三位同事试用；修复缺陷后按影响复试并获得最终合格窗口。更新用户指南、维护渠道、模型/CLI/MCP/浏览器/桌面限制，交付同一已验证包。

## 先读与研究

general-agent-acceptance.md为唯一最终计分入口；release.md与D18资料复用，已通过同候选同任务的记录可复用而不重复收费。

共同实现原则见[能力手册](../../../agents/general-agent-capabilities.md)。实施前查当前定义与官方资料，记录实际版本；不要凭旧文档猜接口。

## 验收条件

- [ ] 完整Beta≥85/100且每组≥8/10；稳定候选≥95/100且每组≥9/10，无未解决P0/P1。
- [ ] 三位目标同事5工作日≥30项、≥90%无需作者救场，新增能力覆盖符合最终验收；有实际代码/CLI使用者。
- [ ] 两套干净Windows环境验证普通使用与开发依赖路径；helper、浏览器及MCP生命周期正常，升级/恢复通过。
- [ ] S04/S05真实组合任务从默认助手完成，不能靠开发者手工调工具补齐。
- [ ] 指南与支持矩阵匹配实际版本，维护人/渠道落实；包不含用户私有数据、凭据或Lux闭源代码。
- [ ] 缺额度、外部服务、机器或试用者的项目保持未验证，不减分母、不用作者自演替代。

## 验证接口与证据

冻结安装候选、50×2真实任务记录、同行试用原始反馈摘要、发布/恢复检查；完整证据统一引用，勿复制证明体系。

计分与真实模型授权见[通用验收](../../../agents/general-agent-acceptance.md)。工程桩与真实结果分别记录；没有实际执行的条件不能勾选。

## 范围与回退

本票是最终集成与交付门槛，不是无边界重构票。新发现缺陷按所属A/D任务记录修复切片，避免一张票混入大量无关改动；不自动公开发布或发消息。

保留他人修改和用户数据；变更按本票独立提交，回退仅针对自身变更。涉及数据迁移先准备测试副本与恢复路径。复用[安全预算](../../../agents/safety-budget.md)，只加本能力需要的边界检查。

## 执行记录

尚未开始。获批后记录起点提交、修改边界、实际决定与偏离理由、调用授权、未完成条件；按[执行流程](../../../agents/workflow.md)推进。

## 审查与验证结果

尚未审查/验证。完成时记录具体命令、实际结果、人工核对、未测项、回退和终点提交。全部条件有证据才改为verified；依赖例外以[总任务图](../plan.md)为准。


### 2026-11-16 成品登记（2026-11-14 审阅补充切片3，工程切片）

审阅第 3 项指出 document-outputs 只从 create_docx/create_xlsx 回执派生，脚本、通用 write 与下载保存成果不在登记链。本轮补齐显式登记：

- 新增 `register_output` 工具（`src/tools/output-registry.ts`，parallelReadPolicy，只读 read-file）：模型对成果文件显式登记，要求 `kind` 区分 deliverable（交付件）/intermediate（中间产物）/source（原始资料）。执行器经授权路径网关 `readFile` 核对授权与存在性（≤32MiB 全量读 → 完整 sha256 + 大小 + 魔数实际格式；超限或权限类失败降级头部 64KiB 校验 `verification: "head64k"`；头部也读不到一律拒绝登记，不按文件名或 mtime 猜测）。回执 `type: "artifact_registration"` 持久化在会话消息中；扩展名与实际内容不符时在回执附 `formatWarning`。
- `document-outputs.ts`：`collectDocumentOutputs` 统一派生 `document_output`（kind=document）与 `artifact_registration`（kind=deliverable/intermediate/source）两类成功回执；`DocumentOutput` 增加 kind/bytes/sha256 可选字段，同一路径重复登记只保留最新版本；失败、截断与伪造回执不入列表，助手散文路径不算产物。列表展示所有候选，不自动挑选。
- `agent.ts` 交付收敛引导（DELIVERY_GUIDANCE_PROMPT）增加第 3 条：交付文件用 register_output 登记，中间产物与原始资料按 kind 区分。
- `personas/general.md`、`writer.md`、`rds-assistant.md` 工具清单加入 `register_output`；`tool-policies.ts` 静态策略同步；sec01 基线同步为 141 静态 + 29 运行时 = 170（此前测试断言 133/162 与实际注册表已经漂移，属 A06 收尾清单的既知事项，本轮顺手对齐）。
- 验证：新增 `tests/product/output-registry.test.mjs` 3/3（校验存在文件回传格式与摘要、缺失路径与非法 kind 拒绝；相对路径走 OUTPUT_DIR、超限降级头部校验、格式不符提示；统一派生两类回执、失败与伪造不入列表、同路径保留最新版本）；sec01 5/5（141/29/170 基线）、conversation、delivery-convergence 无回归，合计 22/22；typecheck、eslint、build 通过。真实模型在长任务中主动登记交付件的行为留 A04/A13 真实运行验收。

### 2026-11-16 独立 Code review：成果登记切片 changes-requested

详见[独立审查报告 R02/R06/R07/R09](../reviews/2026-11-16-glm-improvements-code-review.md)。已重现：允许的相对路径工具登记成功而成果列表为零；非 register_output 工具可伪造成果回执；授权 33MiB 文件的头部降级实际失败；真实 Electron 将 PDF/MP4/Markdown 均标为 Excel 且不展示 source/intermediate/deliverable 类别。修复应覆盖可信路径登记→持久消息→会话 API→用户成果列表，不以单工具假网关测试代替完整链。

整票仍为 ready，M1/M2 不视为已通过。结构化章节恢复、真实文稿语义质量及 M3 固定回放继续按原规格补齐，修复后再冻结正式回归候选。未新增真实模型或当前安装包证据，本轮未实施产品修复。
