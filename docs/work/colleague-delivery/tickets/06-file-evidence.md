# D06 文件回答完整且能定位依据

Kind: implementation

Status: verified

Spec: [同事版交付规格](../../../specs/colleague-delivery.md)

Research: [技术资料：同事版研发](../../../research/technology-stack.md#同事版研发2026-10-18)

Blockers: [D03](./03-context-and-retrieval.md)、[D05](./05-workspace-ux.md)

User stories: U03

## 用户结果与工作范围

1. 复用现有分页，补足用户能理解的文件/页/段/表格位置与读取范围。
2. 多个文件的冲突、读取不完整、扫描/损坏/公式缓存问题明确呈现。
3. 大资料走检索/分段，不依靠缩小全局字符限制静默通过。

## 先读与研究

attachment-reader/store、document-parser/worker、tools/filesystem-lux.ts、memory.ts；现有 conversation/document-migration。

与 Lux 有直接对应且尚未解决的问题，按 [有界研究计划](../../../research/lux-reference-plan.md) 只研究本票需要的行为。已有材料足够就直接记录复用决定。外部库/API 有变化时读已安装定义与官方资料，不凭记忆更换技术栈。

## 验收条件

- [x] F01–F05 的确定性解析和定位部分通过；关键中段可取回。
- [x] XLSX 公式和缓存值区分，无法得到可信数值时说明；不生成假数值。
- [x] 附件内容与读取权限不因重启或旧对话分支丢失。
- [x] 真实回答质量留待 D15；工程测试不能标完整产品通过。

## 验证接口与证据

现有文档/长文/附件迁移测试，增加跨文件冲突和位置核对 fixture；资料以合成内容制作。
通用计分与证据口径见 [acceptance](../../../agents/acceptance.md)。本票通过需要所有验收条件有实际证据；未测部分明示，不能以旧报告代替。

## 范围与回退

不建设企业知识库、OCR 集群或全格式转换平台。
保留其他人的改动。数据结构变化先保存可恢复测试快照并明确兼容；代码按本票独立提交，回退只针对该提交，不能重置他人工作。

## 执行记录

2026-10-20，沿用整套D+A授权，起点4c62f77；D03、D05已verified。A03上游Node补丁实验受ClangCL缺失影响且并发/观察仍未闭合，先推进本项独立工程；A04/A05前置不改。只使用合成文件和隔离会话，不调用真实模型。

现状：PDF已有真实页号、附件已有500字符分段；DOCX没有段落定位，XLSX只转CSV并丢公式/缓存区别，文件路径read默认全量且长单行可能在工具上限截断。复用原解析worker/文件与附件读取，不改存储/权限/全局工具输出限制。

## Test and design seam

先用parseFileBuffer的真实字节和公共read验证，最终覆盖F01–F05：30页PDF第17页、两份冲突DOCX、两表数字/日期/文本/公式缓存、TXT/MD长行中段、扫描/损坏混合。保持不猜数值，不把工程解析当模型回答质量。

比较直接重写全部预览格式和在ParseFileOptions增加includeEvidence；选择后者，使Agent读取获得位置与类型，原预览/兼容调用继续原文本。ParseResult可选locations（提取行范围与宿主生成标签）及warnings；DOCX标“提取段落”而非伪造Word页码，XLSX标原工作表/行/单元格、值类型、公式与已存缓存或无缓存，PDF用解析器真实pageNumber。共用分页模块在500 Unicode字符分段后仍带正确来源位置；附件支持原PDF页选择，文件文档/长TXT/MD有明确分页，代码物理行语义保持。无新的索引或引用数据库。

## 审查与验证结果

顺序完成Standards/Spec检查，见[代码审查](../reviews/06-code-review.md)，无待修阻塞。起点4c62f77；终点为本票`feat: preserve file locations and spreadsheet formula evidence`提交。

- `npm run build`：通过，源码构建0.1.0+local.fb911b2b5fc9。
- `node --test tests/contract/tool02-filesystem-contract.test.mjs`：11/11，真实页选择及原文件工具字段保持。
- `node --import tsx --test tests/product/file-evidence.test.mjs tests/product/conversation.test.mjs`：16/16，17.25秒。包含真实parser worker、Broker公开read、原文末尾/完整计数、混合解析失败与附件隔离。
- `npm run check:product`：类型、lint通过；产品80/80（34.17秒）、UI/IPC15/15。首轮79/80的旧原文计数把新增读取说明也算入，已改为只数实际编号内容行后通过，原文12000次数和末尾断言未放宽。

F04新用例先真实compact，再读取原句；分支生成新附件ID后关闭父DB，使用新Node进程从持久化会话读取原表依据、中段原句及200行表格最后一行，原字节SHA256一致。旧ID在新Session被拒绝。曾因未await父closeDb导致同步子进程等待超时，已修测试清理顺序，未增加超时。此项是新进程存储/reader恢复；整应用重启复用D03现有Electron证据，不冒充新安装验收。

没有调用真实模型或读取日常数据。未做OCR、公式重算或Word物理页推断；真实模型是否正确汇总、保留冲突与追问原句留D15。无数据结构迁移；回退本票代码提交即可恢复旧投影，不重置其他工作。
