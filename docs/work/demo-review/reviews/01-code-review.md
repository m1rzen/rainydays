---
workflow: project-workflow
kind: code-review
ticket: external-demo-changes
date: 2026-10-16
fixed_point: a3e1e494f3f7ede10060dbe1b8cd095e4ecd35ff
status: resolved-for-reported-findings
---

# 演示准备改动核查

## Review scope

用户要求确认 Claude 在项目文件夹内留下的改动。本次仅检查和记录，不合入、修改或撤销演示脚本，不更改用户配置，不恢复数据库，不调用真实模型。

- 当前分支 `demo/2026-10-16`，HEAD 与上次开发基线 a3e1e49 完全相同；reflog 记录 2026-10-15 从 codex/product-development 切到此分支，无后续提交。
- `git diff a3e1e49` 与暂存 diff 均为空；没有 assume-unchanged / skip-worktree 路径。当前留下的变化不包含受版本控制的核心源码。无法仅凭文件确认修改者身份或排除修改后又撤销的历史。
- 新增未跟踪内容：两个演示 CMD、deliverables/demo-tools（19 个文件）、demo-materials（三份 Office/PDF 素材和展示脚本）、demo-backup-20261015 与 broken-db-20261016-092401。deliverables 内已有旧交接材料，不把整个目录归于本次变化。
- demo-backup 下的 data 子目录被既有 `data/` 忽略规则覆盖，因此普通 Git 状态不足以显示全部演示备份。运行时 AppData 配置与数据库也不属于源码 diff。
- Standards 依据：既有 scripts/start-desktop.ps1、electron/main.cjs 的开发 Node 选择、配置更新接口、会话与恢复行为；Spec 依据：docs/ROADMAP.md、docs/STATUS.md、docs/tickets/R2-02.md、展示脚本。分别完成 Standards 与 Spec 审查，无委派。

## Standards findings

### P1 — 新启动器绕过开发 Node 选择，普通双击有原生模块不兼容风险

- Location：演示啟動（簡易）RainyDays.cmd:16；deliverables/demo-tools/start-demo.ps1:53；electron/main.cjs:465。
- Evidence：新入口直接执行 electron.exe；开发服务选用 `npm_node_execpath || process.execPath`。普通外部启动没有 npm_node_execpath 时会使用 Electron 的 Node。当前普通 Node ABI 为 137，better-sqlite3 内存数据库正常；Electron RunAsNode ABI 为 148，同一个模块明确报 137 / 148 不兼容。构建元数据与原生隔离产物检查通过不会覆盖这个问题。
- Authority：R3 已采用 npm 驱动的源码启动保留正确 Node 身份；既有正式启动入口仍在。
- Impact：新入口可能启动不了后台服务、反复重试或进入安全模式，不能因为 build 检查通过就认定可以稳定演示。
- Recommended correction：复用已验证的启动链，或显式解析并传递正确的开发 Node；以隔离用户目录验证两个快捷入口，避免通过重编译依赖来回切换 ABI。

### P1 — 数据恢复回退了近期会话，尚未完成核对

- Location：deliverables/demo-tools/restore-db.ps1:6-10；deliverables/broken-db-20261016-092401/；test-results/rehearsal-out.log:150。
- Evidence：脚本把日常 data 全部迁出，再复制固定日期的备份；没有核对恢复目标中新数据是否保留。现场日志记录 SQLite WAL frame identity is invalid，随后存在被迁出的库与当前库。
- 本次将冷备份与迁出库复制到隔离临时目录；当前运行库通过 SQLite 只读连接的 backup 获取一致副本。仅输出统计和基础检查，不展示消息正文。三个库 quick_check 均为 ok，schema 均为 12：

| 数据集 | 会话数 | 消息数 |
|---|---:|---:|
| 演示前备份 | 3 | 33 |
| 被迁出的库 | 5 | 34 |
| 当前运行库 | 4 | 34 |

- 使用 id 与 created_at 核对：当前与迁出库共同保留 3 个会话、33 条消息；迁出库独有 2 个会话、1 条消息；当前库另有 1 个新会话、1 条新消息。总消息数相同不代表旧消息都保留。
- Authority：项目要求保留用户历史、可恢复且不静默丢失资料。基础检查通过不能证明业务完整性，也不能证明应用 WAL 校验没有问题；仅凭原日志不足以确认旧库真实损坏。
- Impact：近期内容已从当前可见数据集中缺失，但迁出副本仍保留，不能表述为永久丢失。直接再次覆盖当前库还会影响恢复之后的新会话。
- Recommended correction：保留两个数据集，先在副本上核对或导出缺失会话，再确定合并/恢复方案；定位 WAL 校验失败原因，恢复助手先完成备份预检与明确的恢复范围说明。

## Spec findings

### P2 — 演示脚本把两次发送描述为共享一次任务授权

- Location：deliverables/demo-materials/展示腳本.md:54-58。
- Requirement：R2-02 明确“任务指一次发送到回答结束，后续消息重新授权”。
- Evidence：演示先单独请求 Word，回答后再发送 Excel，仍承诺“这次不会再问一次”。这与已实现和已验证的任务许可不符。
- Impact：现场会出现与讲解不一致的第二次授权，容易被误认为应用故障。
- Recommended correction：把 Word 与 Excel 放在同一次任务请求中，或如实说明第二次发送需要再次授权；不扩大授权范围去迎合演示文案。

## Runtime changes and boundaries

- 当前日常配置含 default / kimi-for-coding 与 deepseek / deepseek-chat，均只有凭据引用，没有配置内明文密钥。defaultProfile 仍为 default。存在 DeepSeek 配置不代表其已通过真实任务验收。
- 部门资料目录在备份之间依次为 Z:\产品研发室、F:\mini-lux\deliverables\demo-materials，当前为 C:\RainyDays-no-department。set-dept-missing.cjs 刻意指定不存在的目录，意图绕过不可用的网络盘；目前不能把部门资料读取当作正常开启。
- set-dept-root / set-dept-missing / restore-dept-root 直接写入或覆盖日常配置，没有走应用更新与 revision 变化链。前后可见 revision 相同；建议正式收敛时仅修改所需字段并保留当前配置，而非整体回滚旧快照。
- probe/main.cjs 运行时会读取默认配置加密凭据，并从项目 .env 读取另一套模型配置发请求；它不等同于应用的短请求连接检测，也不等同于五项研究验收。本次仅审阅代码，没有执行它，未解密或展示凭据，无法据此确认历史请求是否获批或是否成功。
- 新素材仅确认文件存在；未审阅 Office/PDF 内文与数值，未重跑现场真实模型流程，不把其视为已完成真实验收。
- 核心源码仍在上一开发基线；本次演示准备没有形成 R4/R5 的真实模型验收或 R6/R7 的产品完成证据。

## Resolution

- Final review status：changes-requested；Standards 两项 P1、Spec 一项 P2，均仅记录，未修复。
- Checks：受跟踪文件 diff；分支/reflog；13 个 PowerShell 文件在 Windows PowerShell 5.1 下语法解析通过；新增 JS/CJS/MJS 语法通过；build-info 与 SEC-03 native 只读检查通过；Node / Electron 各自的纯内存 SQLite 加载；隔离数据库副本基础检查与元数据对比。
- 没有运行新增启动/恢复/停止/模型探测脚本，没有停止当前应用，也没有修改配置或覆盖数据库。临时数据库检查目录已移除。
- 建议先处理启动兼容和缺失会话核对，再统一演示入口、配置变更与展示脚本。不得把恢复过程的“能启动”当作数据完整或真实任务验收通过。

## 2026-10-16 修复附注

用户随后授权解决三项问题；启动 ABI、追加找回会话/附件与展示授权说明均已处理。原核查正文保留为当时证据。完成结果、验证边界及额外运行问题见 [修复票据](../../demo-repair/tickets/01-launch-and-history.md)。
