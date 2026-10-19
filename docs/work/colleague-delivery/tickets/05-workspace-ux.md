# D05 资料与成果目录可以独立使用

Kind: implementation

Status: verified

Spec: [同事版交付规格](../../../specs/colleague-delivery.md)

Research: [技术资料：同事版研发](../../../research/technology-stack.md#同事版研发2026-10-18)

Blockers: [D01](./01-startup-and-old-data.md)

User stories: U02

## 用户结果与工作范围

1. 让普通用户从界面选择资料与成果位置，清楚显示本任务范围。
2. 部门内容源按可选高级能力处理，不作为本地工作的必要依赖。
3. 无效/断开的路径可重新选择；保留旧配置兼容。

## 先读与研究

D01已确认本机缺失部门目录可降级；用户说明Z盘仅公司内网可达，旧配置曾为避免依赖Z盘而改到缺失目录。这里需补查可选公司资料源的启用/状态与真实断网时延；本机ENOENT测试不能证明断开的SMB请求不会等待。参见[D01诊断](../diagnostics/01-startup-and-file-roots.md)。

D02真实Agent协议验证发现并修复read的隐含依赖：已授权绝对路径也先require DATA_ROOT，导致没有部门根时读取失败；现在绝对路径交既有gateway按实际授权根选择，相对路径仍要求其默认根。已有集成用例覆盖无DATA_ROOT本地读取与越界拒绝。本票还需核对glob/grep/legacy工具的同类默认根假设、用户相对路径入口与断网时延，不能据read修复直接标全票通过。

测试维护：旧TOOL-02 contract七项在worker路由处缺capabilityContext而失败，未进入文件逻辑；D02保存旧fixture对照结果，见[诊断](../diagnostics/02-model-contract.md)。本票修改文件工具时将fixture对齐当前公共调用链，保持原行为断言，不把这七项记为已通过。

src/config.ts、settings-schema.ts、path-runtime.ts、src/index.ts 文件接口、public/index.html 与 renderer。

与 Lux 有直接对应且尚未解决的问题，按 [有界研究计划](../../../research/lux-reference-plan.md) 只研究本票需要的行为。已有材料足够就直接记录复用决定。外部库/API 有变化时读已安装定义与官方资料，不凭记忆更换技术栈。

## 验收条件

- [x] 无 Z 盘/无部门盘的新用户能完成本地文件读取和新建文档。
- [x] 中文、空格、只读目录、目录被删除时错误具体，用户无需编辑 JSON。
- [x] 只改输出目录不会获得其他目录写入权；原资料不被自动移动。
- [x] 重启后路径选择与显示一致，离线网络盘不冻结界面。

## 验证接口与证据

配置与路径相关现有测试 + 真实 Electron 选择/断开/重选流程。
通用计分与证据口径见 [acceptance](../../../agents/acceptance.md)。本票通过需要所有验收条件有实际证据；未测部分明示，不能以旧报告代替。

## 范围与回退

不增加目录同步、自动扫描整个磁盘或新文件管理器。
保留其他人的改动。数据结构变化先保存可恢复测试快照并明确兼容；代码按本票独立提交，回退只针对该提交，不能重置他人工作。

## 执行记录

2026-10-20，沿用整套路线授权；起点 a6f980e。首先复现空部门目录配置拒绝和绝对路径搜索依赖DATA_ROOT，再验证真实Electron的本地任务、设置持久化与离线源。

## Test and design seam

通过配置公开函数、现有ScopedPathGateway、HTTP设置/文件接口和隔离Electron验证。运行链复用PathPolicy，目录准备增加有界等待并撤销迟到authority；不改授权选择规则。配置采用显式departmentEnabled开关，缺失时关闭但保留旧路径，避免升级后继续访问旧Z盘。详细决定见规格D05段。

## 审查与验证结果

已按[审查](../reviews/05-code-review.md)顺序检查Standards与Spec并修复范围内发现，详见[诊断](../diagnostics/05-workspace-settings.md)。

- `node --test tests/unit/workspace-settings.test.mjs tests/unit/workspace-path-timeout.test.mjs tests/contract/tool02-filesystem-contract.test.mjs tests/contract/config-managed-store.test.mjs`：22/22。包括旧路径保留/关闭、空源、严格开关、迟到授权撤销、绝对搜索与相对默认根、原七项文件契约、配置负向与凭据事务。
- `node --test --test-name-pattern 'D05 real Electron' tests/electron/startup-recovery.test.mjs`：目录切换/原资料保留/部门只读/禁用后保留路径/删除外部成果目录/重启重选用例通过（31.7秒）；最终只读提示补修后定向第二项再次通过（20.5秒）。真实loopback SMB缺失共享的界面启动12.5秒；真实NTFS ACL拒绝创建/覆盖时原文保持、UI给权限及重选提示。未连接公司Z盘，不代表公司VPN/服务器兼容性认证。
- `node --test --test-name-pattern 'HTTP File Viewer' tests/integration/file-viewer-settings.test.mjs`：1/1，45.995秒。根变更、旧范围拒绝、命名空间/ADS/相对根/重复根拒绝、成果子目录受管创建、持久化和重启通过。fixture显式开启部门源并补充新字段断言，原断言保持。
- `npm run check:product`：typecheck、lint、产品51/51、UI/IPC15/15。产品真实Agent在仅OUTPUT_DIR范围新建DOCX/XLSX，解析实际落盘文档并核对原文、覆盖拒绝、下一任务重新确认均通过；源码Electron本地读取已另测。
- `npm run build`与元数据一致性检查通过，源码构建`0.1.0+local.e1ed7adfed2c`（645输入）。独立R2完整Electron回归在预览阶段等待失败，不能记录通过；两份成果已实际生成，性能问题交D13。没有真实模型费用或日常数据变更。

回退：只反向应用本票本地提交；新开关先关闭仍保留路径，原文件不迁移。终点为包含本记录的`fix: make local workspaces independent of company drives`提交。安装包、干净机器、真实模型质量不在本票计为完成。
