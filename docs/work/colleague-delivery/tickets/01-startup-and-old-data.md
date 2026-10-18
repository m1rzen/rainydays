# D01 稳定启动、旧数据与缺失目录

Kind: implementation

Status: verified

Spec: [同事版交付规格](../../../specs/colleague-delivery.md)

Research: [技术资料：同事版研发](../../../research/technology-stack.md#同事版研发2026-10-18)

Blockers: 无

User stories: U02、U08、U11

## 用户结果与工作范围

1. 先用脱敏副本复现工作台超时/文件根 400，并单独记录后台 unexpected-exit；区分相关现象，不能把共享目录缺失直接当全部根因。
2. 让不可用的可选内容源呈现不可用状态，本地会话/资料/成果仍能使用。只有已确认的启动/等待缺陷才修改。
3. 补齐必要的加载失败/重试交互，保留旧数据与安全模式恢复语义。

## 先读与研究

src/index.ts 的 /api/files/roots、src/config.ts、session-runtime.ts、electron/main.cjs、recovery-state.cjs；既有 demo-repair 诊断。

与 Lux 有直接对应且尚未解决的问题，按 [有界研究计划](../../../research/lux-reference-plan.md) 只研究本票需要的行为。已有材料足够就直接记录复用决定。外部库/API 有变化时读已安装定义与官方资料，不凭记忆更换技术栈。

## 验收条件

- [x] 干净目录和合成旧数据副本各连续启动10次，无卡死或未解释的服务退出。
- [x] 缺部门盘、工作目录移走、中文/空格路径时可进入界面、降级到可用根并改选目录。
- [x] 旧消息在实际UI恢复，附件实际内容可读；不只检查数据库计数。
- [x] 历史偶发后台退出未复现，已保留未知；正常20次观察与并发开发负载超时分别记录，未冒称全部修复。

## 验证接口与证据

既有 development-launch、desktop-smoke、rt10-service-recovery 中受影响用例；追加一个能复现实际旧数据问题的行为回归。
通用计分与证据口径见 [acceptance](../../../agents/acceptance.md)。本票通过需要所有验收条件有实际证据；未测部分明示，不能以旧报告代替。

## 范围与回退

不重写 supervisor、目录授权或整套配置系统；不修改用户正在使用的数据来做测试。
保留其他人的改动。数据结构变化先保存可恢复测试快照并明确兼容；代码按本票独立提交，回退只针对该提交，不能重置他人工作。

## 执行记录

2026-10-18开始，起点71644f8。用户已明确批准D+A并要求从D01连续实施。已读目录/运行时/renderer入口、历史演示诊断及同事版技术研究；验证采用临时配置、合成旧会话与工作台、真实Electron及本地服务，不读取日常数据库或调用模型。先复现再决定修改边界。

## 审查与验证结果

2026-10-18：顺序完成[Standards与Spec审查](../reviews/01-startup-code-review.md)，无阻塞发现。两项红/绿缺陷与边界见[诊断](../diagnostics/01-startup-and-file-roots.md)。最终build为`0.1.0+local.4ef1d44d311d`。

- `npm run check:product`：typecheck/lint、产品26/26、UI/IPC15/15通过；测试脚本后续补充部分独立eslint通过。
- `npm run build`：通过，原生宿主复用；没有更改隔离/权限或schema。
- `RAINYDAYS_D01_STARTUP_RUNS=10`的正常矩阵：干净10/10、旧数据10/10，235.9秒。
- 最终`node --test --test-concurrency=1 --test-name-pattern "D01 old definition|D01 moved workspace|RT-10 Electron recovers" tests/electron/startup-recovery.test.mjs tests/electron/rt10-service-recovery.test.mjs`：3/3通过，包含真实后台强杀后的恢复。
- `node --test --test-name-pattern "HTTP File Viewer|unsafe disk Settings|persistence failure" tests/integration/file-viewer-settings.test.mjs`：3/3通过，保持已有路径拒绝和失败停止。
- `node --test tests/unit/service-supervisor.test.mjs`：6/6通过。

未复现历史单次unexpected-exit，不将其写成已修；开发并发负载下曾有20秒初始化等待超时，详见诊断，已转D13性能实测。未认证干净安装机或真实公司SMB断网。本票仅代表已列D01行为验证。回退针对本票代码提交，不回滚用户数据。
