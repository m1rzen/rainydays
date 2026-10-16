# 演示启动与会话恢复修复

Status: verified
日期：2026-10-16；起点 a3e1e49；用户明确要求解决核查中的三项问题。

规范：两种演示入口使用开发 Node 启动；缺失会话及附件追加恢复，保留当前新会话；移除旧恢复脚本整库覆盖行为；演示 Word/Excel 在同一次发送中生成，授权边界不变。恢复所需 WAL 重置日志兼容性修复属于数据问题根因处理。

依据：[核查](../../demo-review/reviews/01-code-review.md)、[研究](../../../research/technology-stack.md#演示修复2026-10-16)。本次不调用真实模型，不更改现有模型或部门目录设置。

## Test and design seam

- 启动复用 npm exec 提供正确 Node 身份，不新增运行时或重编译依赖。原生 Electron 从外部启动环境、隔离用户目录验证快捷入口实际目标和简易 CMD。
- WAL 使用真实 SQLite checkpoint/reset 产生短新日志与旧尾部，经过 openBootstrapDatabase 验证。保留原有损坏日志、路径、版本、审计约束；仅识别已提交事务边界后的旧代盐值尾部。
- 恢复比较当前与迁出库；通过既有 exportSession/importSession 追加缺失会话，不复制旧权限或整库覆盖。先在当前库一致副本验证，实际写入前保存一致备份；不读取/输出密钥。真实修复结果检查新旧会话、消息、三个附件及重启可见性。
- 备选整库恢复会覆盖恢复后新会话，已排除。直接复制任意表会绕开消息/附件映射与校验，已排除；选择现有会话迁移链，允许恢复会话拥有新 ID，并保存私有恢复映射以便核对。

完成后分别 Standards/Spec 审查，再验证与本地提交。演示素材及带用户数据的备份不整体加入 Git。

## Implementation / Code review

实现完成，分别审查通过：[审查](../reviews/01-code-review.md)，根因与红绿证据：[诊断](../diagnostics/01-launch-and-wal.md)。实际追加恢复已完成；当前 6 个会话、35 条消息，原四会话/34 消息/200 审计记录均不变；恢复两会话、一消息、三附件，附件内容相同。

## Verification

- `npm run check:product`：类型、lint、26/26 产品行为、15/15 UI/IPC 全通过。产品层 15.039 秒，UI 层 0.502 秒。
- `node --test --test-concurrency=1 --test-name-pattern "demo desktop" tests/electron/development-launch.test.mjs`：两个真实 Electron 入口 2/2，无 npm 环境、隔离用户数据，真实后台和已鉴权会话列表工作；外部请求仍 401。
- `node --test --test-name-pattern "corrupted WAL|online backup" tests/integration/bootstrap-database-lifetime.test.mjs`：2/2，包含原有 11 种损坏与 2 种身份拒绝、有效 WAL 恢复、一致在线快照。
- 实际恢复 CLI：预览缺失 2；副本演练后实际新增 2 会话、1 消息、3 附件；再次预览缺失 0。恢复前快照、来源快照、导出内容、恢复映射保存在用户 data/history-recovery-*，不进入 Git。恢复前后逐行/字节核对通过，quick_check=ok、foreign_key_check=0。
- 原用户目录残留安全模式通过既有 recoveryStateStore.requestNormalRetry API 准备正常重试，随后以 --recover-normal 启动；当前 recovery-state safeMode=false，正常窗口标题及 HTTP 根页面 200，服务 ready。没有手工抹除恢复状态或更换模型。
- 额外的真实数据隔离桌面探测在旧工作台/文件根加载期间 Runtime.evaluate 等待超时，不能当作历史全界面验收通过；原生干净启动和实际数据完整性证据分别记录。实际目录启动日志曾有一次服务意外退出后自动恢复 ready，尚不能归因于此次启动器；本轮不把它视为完整文档/模型质量验收。
- 演示 Word/Excel 请求合并为一次发送，追加修改重新授权；退出说明改为从菜单/托盘退出。没有更改授权代码。

本轮未调用真实模型。现有部门目录设置、R4/R5 真实模型与 R6/R7 出口状态不变。
