# D系列基础工作流任务索引

Status: approved

本页只维护D01–D18的依赖与验收索引，不另设排期。完整执行顺序以[D+A总路线](../general-agent/plan.md)为准。基础行为见[规格](../../specs/colleague-delivery.md)，实际状态回填票据与[STATUS](../../STATUS.md)。D18是中间里程碑，完整出口为A13。

## 依赖与验收

| 任务 | 阻塞依赖 | 主要验收证据（完整条件见票据） | 状态 |
|---|---|---|---|
| [D01 稳定启动、旧数据与缺失目录](tickets/01-startup-and-old-data.md) | 无 | 正常启动20/20、两项缺陷及后台恢复3/3；历史退出未知与并发性能观察已记录 | verified |
| [D02 认证一个可靠模型配置](tickets/02-model-contract.md) | 无 | 本地协议已验证；真实参考配置尚待可用额度与具体授权。 | blocked |
| [D03 完整请求预算与长对话取回](tickets/03-context-and-retrieval.md) | D02本地工程 | 完整请求/摘要预算、20轮后进程重启与Agent原文取回、取消/失败原子性通过；真实模型语义留F04。 | verified |
| [D04 任务完成、停止与中断一致](tickets/04-run-stop-and-recovery.md) | D01、D02本地工程 | 本地状态/取消反馈、结算和成果中断恢复已验证。 | verified |
| [D05 资料与成果目录可以独立使用](tickets/05-workspace-ux.md) | D01 | 无 Z 盘/无部门盘的新用户能完成本地文件读取和新建文档。 | verified |
| [D06 文件回答完整且能定位依据](tickets/06-file-evidence.md) | D03、D05 | F01–F05确定性依据、公式缓存、长文中段与摘要/分支/新进程续读通过；模型质量留D15。 | verified |
| [D07 完成五项真实研究验收](tickets/07-research-live.md) | D02、D03、D05 | 五项真实研究全部满足既有人工预期，失败来源不被伪装已读。 | ready |
| [D08 可编辑成果达到交付质量](tickets/08-document-quality.md) | D06 | O01–O04 的内容和格式检查通过；至少在试用者实际使用的 WPS 或 Microsoft Office 中打开并编辑。 | verified |
| [D09 预览、执行和撤回文件整理](tickets/09-file-organization.md) | D04、D05 | 12 个文件含 2 个重名冲突的 O05 完整演示；冲突不覆盖，原内容不丢。 | ready |
| [D10 把成功任务保存为可编辑模板](tickets/10-save-task-template.md) | D04、D08 | 保存、重命名、编辑、删除/归档、重启读取模板可用；已有会话不被修改。 | ready |
| [D11 换输入重跑、校验与失败恢复](tickets/11-rerun-template.md) | D10 | T01–T05 工程流程成立，新输入不会混入上一次数值。 | ready |
| [D12 可行动错误与轻量诊断](tickets/12-errors-and-support.md) | D02、D04 | 额度、认证、断网、目录失效、解析失败、权限拒绝、应用故障都能从界面采取下一步。 | ready |
| [D13 尽早验证同事机器安装](tickets/13-installer.md) | D01、D05 | 至少两套干净 Windows 11 x64 环境，无 Node/npm/MSVC 也可用基本文件/文档流程。 | blocked |
| [D14 普通用户可恢复的备份与升级](tickets/14-upgrade-and-restore.md) | D13 | 备份后新建任务，再恢复测试副本，能证明新数据被保护或可另行导入。 | ready |
| [D15 固定任务与 Beta 候选验收](tickets/15-beta-evaluation.md) | D03、D06、D07、D08、D09、D11、D12、D13、D14 | Beta ≥34/40、各类 ≥8/10 | ready |
| [D16 三位同事独立使用一周](tickets/16-colleague-trial.md) | D15 | 三人五日真实证据 | ready |
| [D17 修复试用问题并达到稳定版门槛](tickets/17-stabilize.md) | D15 | 试用问题修复、最终 ≥38/40 | ready |
| [D18 正式交付、操作说明与维护接手](tickets/18-handoff-and-maintenance.md) | D16、D17 | 维护者能依靠文档定位版本、诊断和恢复数据，无需回读聊天记录。 | ready |

## 依赖例外与证据复用

- D03/D04只要求D02的本地协议契约和确定性工程已验证；D02整票在真实模型认证前仍未verified。D07需要可用且获准的真实配置，其余依赖默认整票verified。
- D07额度阻塞不妨碍无此依赖的D08–D14工程；D15基础验收必须补齐研究结果。
- D13尽早发现打包/ABI问题，最终候选重测受后续变化影响的行为。
- D17可在D16期间修问题；D18同时要求二者完成。D16与A13综合试用尽量使用同一个符合全部覆盖的窗口。
- 复用已有R1–R5实现与相关证据，只补当前票据缺口。历史R票、评审、devlog是研究材料，不能形成另一条执行队列。

## 扩展候选

以下能力仍按实际收益后续决定，不进入本版依赖。

| 候选 | 重新进入条件 |
|---|---|
| OCR或PPTX | 真实试用持续受阻，先选一种格式证明效果与费用 |
| 可编辑偏好/项目记忆 | 普通模板不够，能查看、改正与删除，无跨项目暗用 |
| 本机定时重复 | 手动重跑稳定，有明确规律任务和失败/去重契约 |
| 特定业务连接器 | 具体系统成为重复成本；Prism、钉钉继续排除 |

代码、CLI、通用MCP、一个浏览器后端、原生Windows和有界子任务已在A系列，不属于上表候选。
