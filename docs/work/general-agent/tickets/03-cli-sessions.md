# A03 CLI与持久终端进入普通任务

Kind: implementation

Status: ready

Spec: [通用Agent规格](../../../specs/general-agent.md)

Research: [技术依据与研究问题](../../../research/general-agent-stack.md)

Blockers: A01、D04、D05

User stories: G03

## 用户结果与工作范围

复用execute_command及shell_start/input/output/list/resize/stop。默认助手按任务获得工具，界面按需展开终端。明确cwd、shell、依赖、有限环境变量、进程归属；短命令和长任务都能取退出码和输出。保留持久会话stdin、分页输出、取消及应用退出清理。补充缺失运行时的可行动提示。

## 先读与研究

src/tools/shell.ts、terminal-tools.ts、script.ts及执行adapter；tests中的terminal-owner、terminal-interruption与script-native相关用例。

共同实现原则见[能力手册](../../../agents/general-agent-capabilities.md)。实施前查当前定义与官方资料，记录实际版本；不要凭旧文档猜接口。

## 验收条件

- [ ] L01–L05工程场景通过；长于60秒与大输出不因短命令默认超时丢结果。
- [ ] stdin只进本run所属会话，实际退出码/错误/分页内容可核对。
- [ ] 取消反馈≤1秒，目标5秒内回收受控进程树；不杀用户原有进程。
- [ ] 普通无开发环境用户得到缺依赖提示；项目所需工具和安装选择明确，不自动扩大执行权限。
- [ ] 标准构建/测试在现有隔离契约下可用，阻挡点有最小兼容修复及针对性验证。

## 验证接口与证据

临时目录真实PowerShell/cmd与持久会话，退出码/进程树/增量输出检查；实际Electron按需终端入口。

计分与真实模型授权见[通用验收](../../../agents/general-agent-acceptance.md)。工程桩与真实结果分别记录；没有实际执行的条件不能勾选。

## 范围与回退

不替换所有终端实现，不捆绑所有语言和第三方CLI，不启用无限后台任务。隔离不可用时明确能力不可用，不偷换成无约束执行。

保留他人修改和用户数据；变更按本票独立提交，回退仅针对自身变更。涉及数据迁移先准备测试副本与恢复路径。复用[安全预算](../../../agents/safety-budget.md)，只加本能力需要的边界检查。

## 执行记录

尚未开始。获批后记录起点提交、修改边界、实际决定与偏离理由、调用授权、未完成条件；按[执行流程](../../../agents/workflow.md)推进。

## 审查与验证结果

尚未审查/验证。完成时记录具体命令、实际结果、人工核对、未测项、回退和终点提交。全部条件有证据才改为verified；依赖例外以[总任务图](../plan.md)为准。

