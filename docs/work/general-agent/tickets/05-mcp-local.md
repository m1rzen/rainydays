# A05 MCP本地接入与工具发现

Kind: implementation

Status: proposed

Spec: [通用Agent规格](../../../specs/general-agent.md)

Research: [技术依据与研究问题](../../../research/general-agent-stack.md)

Blockers: A03

User stories: G05、G10

## 用户结果与工作范围

采用官方SDK接入stdio客户端。在设置添加/修改/测试/停用服务器，给出command/args/cwd及许可环境配置。注册工具目录，服务器命名空间隔离，分页/变更刷新，按任务发现。工具调用进入现有run、结果、错误和取消链。更新实际能力available/enabled/version状态及测试，不留下仅能保存却不生效的开关。

## 先读与研究

src/settings-schema.ts、version.ts、task-tools.ts、tools/index.ts与执行器；研究dossier的官方SDK/传输资料。

共同实现原则见[能力手册](../../../agents/general-agent-capabilities.md)。实施前查当前定义与官方资料，记录实际版本；不要凭旧文档猜接口。

## 验收条件

- [ ] M01/M02工程流程由真实stdio协议与普通会话完成；两个同名工具不混淆。
- [ ] 进程stdout协议与stderr日志分离；协议错误、超时、退出和应用关闭可恢复/清理。
- [ ] 停用后不能新调用；重启配置保留，凭据仅引用现有vault。
- [ ] 动态工具schema不全部常驻提示；工具变更后不沿用失效参数定义。
- [ ] 第三方进程通过现有受控执行接口，说明实际文件/网络权限，不误称工具路径检查能限制其全部行为。

## 验证接口与证据

一个真实本地stdio测试服务器＋分页/变更/命名冲突用例＋实际设置/默认助手入口；M01/M02。

计分与真实模型授权见[通用验收](../../../agents/general-agent-acceptance.md)。工程桩与真实结果分别记录；没有实际执行的条件不能勾选。

## 范围与回退

不做市场、企业审批或任意插件安装。用户可接兼容自定义服务器；SDK版本和运行时支持需在实施时锁定。

保留他人修改和用户数据；变更按本票独立提交，回退仅针对自身变更。涉及数据迁移先准备测试副本与恢复路径。复用[安全预算](../../../agents/safety-budget.md)，只加本能力需要的边界检查。

## 执行记录

尚未开始。获批后记录起点提交、修改边界、实际决定与偏离理由、调用授权、未完成条件；按[执行流程](../../../agents/workflow.md)推进。

## 审查与验证结果

尚未审查/验证。完成时记录具体命令、实际结果、人工核对、未测项、回退和终点提交。全部条件有证据才改为verified；依赖例外以[总任务图](../plan.md)为准。

