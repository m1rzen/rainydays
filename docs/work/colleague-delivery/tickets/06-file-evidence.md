# D06 文件回答完整且能定位依据

Kind: implementation

Status: proposed

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

- [ ] F01–F05 的确定性解析和定位部分通过；关键中段可取回。
- [ ] XLSX 公式和缓存值区分，无法得到可信数值时说明；不生成假数值。
- [ ] 附件内容与读取权限不因重启或旧对话分支丢失。
- [ ] 真实回答质量留待 D15；工程测试不能标完整产品通过。

## 验证接口与证据

现有文档/长文/附件迁移测试，增加跨文件冲突和位置核对 fixture；资料以合成内容制作。
通用计分与证据口径见 [acceptance](../../../agents/acceptance.md)。本票通过需要所有验收条件有实际证据；未测部分明示，不能以旧报告代替。

## 范围与回退

不建设企业知识库、OCR 集群或全格式转换平台。
保留其他人的改动。数据结构变化先保存可恢复测试快照并明确兼容；代码按本票独立提交，回退只针对该提交，不能重置他人工作。

## 执行记录

尚未开始。实施时记录批准来源、起点提交、实际变更与偏离计划的理由；真实模型调用需核对已有授权。

## 审查与验证结果

尚未审查/验证。完成后写具体命令、结果、人工核对、未测项、回退方式和终点提交；全部满足才改为 verified。
