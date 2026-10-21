# A15 开发模式：以用户身份执行命令

Kind: implementation

Status: verified

Spec: [通用Agent规格](../../../specs/general-agent.md#7-2026-10-20路线修订开发模式与agent循环)

Blockers: 无

User stories: G02、G03、G04、G05

## 用户结果与工作范围

用户在设置中显式开启开发模式后，助手的execute_command与持久终端以当前Windows用户身份、用户自己的PATH/工具链（git、node、npm、python等）和网络运行，cwd仍限定在已授权工作目录内。默认（同事模式）保持现有AppContainer隔离，不改变原负向契约。

批准：2026-10-20用户在会话中明确批准“增加开发模式”，并要求按修订路线开展新一轮开发。

## 验收条件

- [x] 设置项默认关闭；开启需用户在本机界面操作，模型、资料或项目文件不能开启它。界面清楚说明命令不再隔离。
- [x] 开发模式下execute_command使用用户环境，真实运行`node --test`、`python -m unittest`、`git status`、`npm`命令；超时可指定（默认120秒，最长600秒），返回真实退出码与有界输出。
- [x] 审批：首个命令在应用内确认，可选“本次任务允许运行命令”/“仅这一次”/“拒绝”；任务内授权不跨任务；关闭开发模式后立即回到隔离路径。
- [x] 取消/停止在1秒内反馈并在5秒内结束进程树；应用退出清理本任务启动的进程，不杀用户其他进程。
- [x] 持久终端在开发模式下同样使用用户环境，保留输入归属、分页输出、退出码。
- [x] 隔离模式原有负向/产品回归保持；新增开发模式的确定性测试与真实命令测试。

## 范围与回退

不提权、不绕过UAC、不自动安装软件；依赖缺失如实报告。命令以用户身份运行意味着可访问用户可访问的一切，这一点在设置中明示，不再宣称沙箱。按本票独立提交；关闭设置即回到原行为。

## 执行记录

2026-10-20起点4a3b020。设计：设置沿用shell域加可选developerMode（旧配置缺省false，导入包不能开启，任务运行中不能修改）；通用设置“高级偏好”提供开关。执行：新增developer-execution，execute_command在开发模式下经Path gateway取得授权根内cwd后，以用户环境（去除RAINYDAYS_/ELECTRON_/NODE_TEST_CONTEXT）在cmd中运行，chcp 65001、stdin关闭、超时/取消/run资源回收都终止进程树、保留输出尾部。审批：broker对开发模式命令改用应用内渠道，“本次任务允许运行命令”记在当前run上下文，后续命令单次签发授权，下一任务重新询问。script仍在E3隔离中；用户界面中的手动终端仍走原生隔离。

### 子切片1：execute_command（已验证）

- `node --import tsx --test tests/product/developer-mode.test.mjs`：5/5。默认关/旧配置/导入不能开启；中文、cwd、退出码7、长输出保留尾部；**`node --test`与`python -m unittest`在临时项目真实red→green**，git/npm可用；1秒超时与运行中取消均在5秒内结束；默认助手应用内一次确认覆盖同任务两条命令，退出码3如实为error，下一任务重新询问并拒绝，未触发原生隔离确认，系统提示含开发模式说明。
- `npm run check:product`：类型/lint、产品88/88、UI/IPC15/15。
- `npm run build`后，同事模式原回归：`tests/integration/agent-cli.test.mjs` 1/1、`sec03-native-host` E1真实AppContainer/Job 1/1，隔离路径不受影响。
- `node --test --test-name-pattern "A15 real Electron" tests/electron/desktop-smoke.test.mjs`：真实Electron开关可见、开启/重启保留/关闭1/1（测试壳新增keepConfig以保留应用自身保存的配置）。

### 子切片2：持久终端

开发模式shell_start/shell_input改为应用内同一任务级确认；终端以用户身份、管道方式运行（不支持全屏TUI/resize），同一TerminalManager按lease类型路由，输出分页、退出码、owner归属与run结束清理不变。实测cmd在chcp 65001下从管道读取多字节输入出现`More?`并退出、不切代码页时中文参数被误解码；最终保持系统OEM代码页：cmd空闲时命令行按OEM编码写入、运行中程序的stdin按UTF-8写入（以提示符哨兵判断，哨兵从输出移除），输出逐行将OEM内建命令输出转为UTF-8。PowerShell管道宿主按OEM解析输入，且不把输入转给子程序；需要stdin交互时用cmd。

- `tests/product/developer-mode.test.mjs` 7/7：默认助手一次确认启动终端/两次输入/读取；`echo 中文内建`、中文参数、程序stdin“张三”、`exit 7`→退出码7/child-failed；run结束后终端视图失效；owner回收在5秒内结束终端及其node子进程；他人owner不能写入。
- `npm run check:product`：类型/lint、产品90/90、UI/IPC15/15。
- build后同事模式回归：agent-cli 1/1、rt10-terminal-interruption 1/1、sec01-terminal-owner 2/2、真实Electron agent-cli-view 1/1。

### 补丁：长命令不被工具管道截断（2026-10-21）

开发模式execute_command按timeout参数最长600秒，但工具管道统一超时仍是60秒，会提前中止测试/构建。管道上限改为610秒（同事模式E1仍自身30秒结束），body协议execute_command增加timeout头。developer-mode产品7/7（新增管道上限>600秒、默认120秒/上限600秒断言）；tool-protocol单元断言更新为610000（隔离数据目录下8/8子测试通过，进程因既有句柄需外部结束）。

## 审查与验证结果

按Standards/Spec顺序自审，未委派。Standards：设置仅本机界面可改、导入包保留现值、运行中锁定；审批经原broker challenge/grant，开发模式只换渠道与任务级复用，supervisor升级时不给任务级授权；同事模式执行/终端代码路径未改，原负向回归通过；无数据库迁移。Spec：六项验收均有上文证据。

未测：当前安装包/干净机器（D13）、真实模型使用开发模式完成任务（A04）、MCP stdio在开发模式下的接入（A05）。回退：revert本票两次提交；关闭设置即回到原隔离行为。
