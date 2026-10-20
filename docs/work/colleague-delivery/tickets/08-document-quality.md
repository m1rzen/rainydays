# D08 可编辑成果达到交付质量

Kind: implementation

Status: verified

Spec: [同事版交付规格](../../../specs/colleague-delivery.md)

Research: [技术资料：同事版研发](../../../research/technology-stack.md#同事版研发2026-10-18)

Blockers: [D06](./06-file-evidence.md)

User stories: U05、U06

## 用户结果与工作范围

1. 统一基本 Word/Excel 格式：标题/段落/列表/表格/引用、数值/日期类型与易读列宽。
2. 成果从真实工具回执形成，可打开、预览、另存修改并在重启后找到。
3. 实际生成后复读核对关键结构/数字；视觉检查使用目标软件或可靠渲染，不能只解压 XML。

## 先读与研究

tools/writer.ts、document-outputs.ts、file-viewer.ts、src/index.ts 成果接口、public renderer；R2 流程。

与 Lux 有直接对应且尚未解决的问题，按 [有界研究计划](../../../research/lux-reference-plan.md) 只研究本票需要的行为。已有材料足够就直接记录复用决定。外部库/API 有变化时读已安装定义与官方资料，不凭记忆更换技术栈。

## 验收条件

- [x] O01–O04 的内容和格式检查通过；至少在试用者实际使用的 WPS 或 Microsoft Office 中打开并编辑。
- [x] 一次请求生成两个文件仅一次新建范围审批；第二次修改请求按新任务处理。
- [x] 另存修改保留原文件字节；同名冲突不会静默覆盖。
- [x] 不存在的文件不能出现为成功成果；部分生成失败保留已成功项。

## 验证接口与证据

现有 R2 Electron、输出权限与文档解析回归；一份 Word/一份 Excel 做真实视觉核验。
通用计分与证据口径见 [acceptance](../../../agents/acceptance.md)。本票通过需要所有验收条件有实际证据；未测部分明示，不能以旧报告代替。

## 范围与回退

不承诺复杂原格式无损编辑、不扩展 PPTX/OCR/任意宏；不另换整套 Office 引擎。
保留其他人的改动。数据结构变化先保存可恢复测试快照并明确兼容；代码按本票独立提交，回退只针对该提交，不能重置他人工作。

## 执行记录

2026-10-20，沿用整套D+A授权；起点38a2105，D06已verified。复用现有writer/成果/预览/审批链，只补正文结构与表格类型，不替换Office引擎，不调用真实模型。Microsoft Word与Excel16.0.20430.20182均已真实打开/编辑合成成果，具体证据见下文。

## 设计与验证接口

比较另建文档引擎与扩展当前writer，选择当前工具的小幅兼容扩展：DOCX保留title/paragraphs/sources，增可选blocks，支持实际标题/列表/表格；采用统一A4、中文字体、段落间距、重复表头与页内宽度。XLSX保留二维data，增可选columnFormats表达日期/数值/文本；计算列宽，保留真实类型，不从字符串猜数字，不声称公式重算。格式逻辑留writer私有函数，仍从原gateway提交。生成字节复读关键内容/类型后才登记成功，视觉与编辑另由实际Office验证。

公共create_docx/create_xlsx为测试缝；现有普通Agent双成果/一次新建审批、覆盖拒绝、下一任务新许可与重启恢复测试复用。补充结构/类型、无效日期/数值和真实另存数据检查；最终对合成成果做Word/Excel打开和编辑，源码证据与安装包区分。

## 审查与验证结果

审查见[D08代码审查](../reviews/08-code-review.md)，无未处理阻塞发现。

- 自动：typecheck、lint通过；`test:product` 83/83（含D08定向3项）、`test:product:ui` 15/15；`test:product:desktop` 构建后真实Electron 4/4，其中R2双成果一次新建确认、重启恢复、另存修改原件字节不变及Word结构/Excel数值1500、日期格式复读通过（2026-10-20）。
- 人工：Microsoft Word/Excel 16.0.20430.20182打开合成成果无修复提示、无裁切；Word副本写入D08_EDIT_OK、Excel副本B2改为1300后复读类型与编号/日期保持，两原件SHA256不变。
- 未测：WPS、当前安装包、真实模型内容质量（留D15）；复杂版式无损编辑、宏、OCR、公式重算不在本票。
- 回退：单独revert本票提交；不涉及数据库结构或用户数据。
