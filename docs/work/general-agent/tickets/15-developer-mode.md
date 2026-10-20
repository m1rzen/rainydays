# A15 开发模式：以用户身份执行命令

Kind: implementation

Status: in-progress

Spec: [通用Agent规格](../../../specs/general-agent.md#7-2026-10-20路线修订开发模式与agent循环)

Blockers: 无

User stories: G02、G03、G04、G05

## 用户结果与工作范围

用户在设置中显式开启开发模式后，助手的execute_command与持久终端以当前Windows用户身份、用户自己的PATH/工具链（git、node、npm、python等）和网络运行，cwd仍限定在已授权工作目录内。默认（同事模式）保持现有AppContainer隔离，不改变原负向契约。

批准：2026-10-20用户在会话中明确批准“增加开发模式”，并要求按修订路线开展新一轮开发。

## 验收条件

- [ ] 设置项默认关闭；开启需用户在本机界面操作，模型、资料或项目文件不能开启它。界面清楚说明命令不再隔离。
- [ ] 开发模式下execute_command使用用户环境，真实运行`node --test`、`python -m unittest`、`git status`、`npm`命令；超时可指定（默认120秒，最长600秒），返回真实退出码与有界输出。
- [ ] 审批：首个命令在应用内确认，可选“本次任务允许运行命令”/“仅这一次”/“拒绝”；任务内授权不跨任务；关闭开发模式后立即回到隔离路径。
- [ ] 取消/停止在1秒内反馈并在5秒内结束进程树；应用退出清理本任务启动的进程，不杀用户其他进程。
- [ ] 持久终端在开发模式下同样使用用户环境，保留输入归属、分页输出、退出码。
- [ ] 隔离模式原有负向/产品回归保持；新增开发模式的确定性测试与真实命令测试。

## 范围与回退

不提权、不绕过UAC、不自动安装软件；依赖缺失如实报告。命令以用户身份运行意味着可访问用户可访问的一切，这一点在设置中明示，不再宣称沙箱。按本票独立提交；关闭设置即回到原行为。

## 执行记录

2026-10-20起点4a3b020。设计：设置沿用shell域加可选developerMode（旧配置缺省false，导入包不能开启，任务运行中不能修改）；通用设置“高级偏好”提供开关。执行：新增developer-execution，execute_command在开发模式下经Path gateway取得授权根内cwd后，以用户环境（去除RAINYDAYS_/ELECTRON_/NODE_TEST_CONTEXT）在cmd中运行，chcp 65001、stdin关闭、超时/取消/run资源回收都终止进程树、保留输出尾部。审批：broker对开发模式命令改用应用内渠道，“本次任务允许运行命令”记在当前run上下文，后续命令单次签发授权，下一任务重新询问。script仍在E3隔离中；持久终端尚未切换（下一子切片）。

### 子切片1：execute_command（已验证）

- `node --import tsx --test tests/product/developer-mode.test.mjs`：5/5。默认关/旧配置/导入不能开启；中文、cwd、退出码7、长输出保留尾部；**`node --test`与`python -m unittest`在临时项目真实red→green**，git/npm可用；1秒超时与运行中取消均在5秒内结束；默认助手应用内一次确认覆盖同任务两条命令，退出码3如实为error，下一任务重新询问并拒绝，未触发原生隔离确认，系统提示含开发模式说明。
- `npm run check:product`：类型/lint、产品88/88、UI/IPC15/15。
- `npm run build`后，同事模式原回归：`tests/integration/agent-cli.test.mjs` 1/1、`sec03-native-host` E1真实AppContainer/Job 1/1，隔离路径不受影响。
- `node --test --test-name-pattern "A15 real Electron" tests/electron/desktop-smoke.test.mjs`：真实Electron开关可见、开启/重启保留/关闭1/1（测试壳新增keepConfig以保留应用自身保存的配置）。

## 审查与验证结果

尚未审查/验证。
