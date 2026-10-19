# D13 尽早验证同事机器安装

Kind: implementation

Status: blocked

Spec: [同事版交付规格](../../../specs/colleague-delivery.md)

Research: [技术资料：同事版研发](../../../research/technology-stack.md#同事版研发2026-10-18)

Blockers: [D01](./01-startup-and-old-data.md)、[D05](./05-workspace-ux.md)

User stories: U01、U11

## 用户结果与工作范围

1. 构建当前候选，确认原生模块、解析 worker、隔离宿主和静态资源实际入包。
2. 在无开发工具的标准用户环境安装/启动/退出/卸载，检查应用 ID、数据路径、日志与更新身份。
3. 记录签名状态、最低环境与分发方法；把开发入口与安装入口说明分开。

## 先读与研究

D01的顺序20次启动通过，但源码开发测试并发时有一次20秒renderer初始化等待超时，原因未知；干净场景测得4.9–13.3秒，尚未认证冷启动性能。这里须在当前安装候选与参考机器测量启动、旧数据规模和负载影响，定位瓶颈后修最小问题，不通过放宽超时或删除保护过关。见[D01诊断](../diagnostics/01-startup-and-file-roots.md)。

package.json、scripts/build-electron.mjs、after-pack.cjs、electron/main.cjs、tests/packaged；现有 NSIS。

与 Lux 有直接对应且尚未解决的问题，按 [有界研究计划](../../../research/lux-reference-plan.md) 只研究本票需要的行为。已有材料足够就直接记录复用决定。外部库/API 有变化时读已安装定义与官方资料，不凭记忆更换技术栈。

## 验收条件

- [ ] 至少两套干净 Windows 11 x64 环境，无 Node/npm/MSVC 也可用基本文件/文档流程。
- [ ] 中文/空格路径、没有部门盘时可启动；不存在开发机路径依赖。
- [ ] 卸载/重装的数据策略明确，安装候选不携带用户数据或 Lux bundle。
- [ ] 签名/Windows 提示如实记录；不能要求关闭安全软件来通过。

## 验证接口与证据

当前包的 installed-smoke、IPC/凭据/服务恢复相关已有测试；真实干净环境人工记录。
通用计分与证据口径见 [acceptance](../../../agents/acceptance.md)。本票通过需要所有验收条件有实际证据；未测部分明示，不能以旧报告代替。

## 范围与回退

不提前建设自动更新服务器、跨平台发布矩阵或企业部署平台。
保留其他人的改动。数据结构变化先保存可恢复测试快照并明确兼容；代码按本票独立提交，回退只针对该提交，不能重置他人工作。

## 执行记录

2026-10-20，沿用整套路线授权；起点3a7e9f2，D01/D05 verified。先定位D05暴露的文件请求多秒等待，再构建当前NSIS候选、运行既有包内/已安装验证。本机Windows 11家庭中文版26200、标准用户、已有开发工具；不能算两套干净机器。

## Test and design seam

通过openBootstrapDatabase的公开database接口量测物化结果消费、实际文件/文档HTTP与Electron路径、现有Electron staging/ASAR检查和installed-smoke。性能修复只在有复现和证据后实施；数据库操作前后的现有身份检查及审计链仍须通过负向测试。设计决定记录到基础规格D13段。安装包和干净机器的状态分开。

## 审查与验证结果

性能与依赖切片经[顺序审查](../reviews/13-code-review.md)；[诊断与产物隔离](../diagnostics/13-runtime-and-packaging.md)保存完整事实。

- `node --test tests/integration/database-materialization.test.mjs tests/integration/bootstrap-database-lifetime.test.mjs`：15/15。200条SQL物化结果遍历由808次额外文件检查/约0.5秒变为0次/<0.1ms，关闭/替换/硬链接/审计篡改/备份恢复保持。
- `node --test --test-name-pattern 'R2 real Electron completes document' tests/electron/desktop-smoke.test.mjs`：1/1，34.100秒。文档生成、重启找回、预览、另存修改完整通过，原等待上限未放宽。
- 原`npm run dist`复现xlsx本地tarball未入stage；增加vendor与投影后npm ci安装227项生产依赖成功。当前原gate报UNBOUND_SINK，重新`npm run stage:electron`仍按原语义拒绝。43个新/2个过期绑定需实际核对；没有自动标审查通过。
- 产品51/51、最终UI/IPC15/15；首次UI静态目录列表断言因新增vendor失败，已包含必需tarball后恢复。ASAR新增文件/同路径调用篡改拒绝用例1/1。构建/元数据检查通过，源码`0.1.0+local.3bb5589f43aa`（647输入）。
- 自动审批拒绝了审计前置移除方案，理由见诊断。相关未提交代码已撤回；9c4ee25f908c产物未运行/安装，均加.blocked-d13后缀，不作为有效候选。其安装器签名实测NotSigned，未用signing日志冒充签名。
- `tests/packaged/local-documents.test.mjs`已准备真实包内读文件→生成DOCX→重启→worker预览/模型取回流程，去掉开发PATH并从System32启动；尚未执行。现有SEC-05凭据fixture改为合法路径格式，未削弱密钥断言，仍需当前包运行。

解除阻塞：在保留既有gate下实际核对并维护相关绑定，生成通过同一验证的当前候选，再执行包内/安装测试及两套干净机器要求。本机标准用户但有开发工具，不能顶替。D03不依赖本票，按总计划继续。只回退本票本地提交可撤销本次工程修复；不恢复或分发被隔离产物。终点为本记录所在的`fix: remove redundant filesystem checks from database snapshots`提交。
