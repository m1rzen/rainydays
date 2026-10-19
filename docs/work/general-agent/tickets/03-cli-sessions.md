# A03 CLI与持久终端进入普通任务

Kind: implementation

Status: in-progress

Spec: [通用Agent规格](../../../specs/general-agent.md)

Research: [技术依据与研究问题](../../../research/general-agent-stack.md)

Blockers: A01、D04、D05

User stories: G03

## 用户结果与工作范围

复用execute_command及shell_start/input/output/list/resize/stop。默认助手按任务获得工具，界面按需展开终端。明确cwd、shell、依赖、有限环境变量、进程归属；短命令和长任务都能取退出码和输出。保留持久会话stdin、分页输出、取消及应用退出清理。补充缺失运行时的可行动提示。

## 先读与研究

A01已实测E1 echo可用，但Node/Python项目命令被隔离通道拒绝；E3直接import项目文件因父目录lstat的EPERM失败。先按[A01原型记录](../prototype.md)复现，再设计最小运行时租约/模块解析所需目录元数据契约，验证Node和Python项目红→修复→绿；不得只接终端UI或全局放权。另需处理现有Windows stderr乱码，明确编码或保留原始字节。

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

2026-10-20，沿用整套授权，起点09ad4e9。A01/D04/D05及A02工程均已验证。先复现隔离中Node/Python项目失败与E3父目录元数据EPERM，读取实际native/runtime契约后做最小兼容设计；再接普通会话与长输出/输入/取消。只使用自建临时项目，不调用真实模型、不改用户开发环境或D13 gate。

## Test and design seam

真实Broker→现有script/execute_command→native AppContainer/Job，临时Node/Python项目验证红→修改→绿，stdout/exit及取消为可观察结果。优先E3模块解析最小实验，同时保留现有root/cwd、链接和hardlink负向；实际决定见规格，区分证据见[诊断](../diagnostics/03-cli-compatibility.md)。E1运行时、终端长任务与编码随后独立处理，不新增执行内核。

## 审查与验证结果

E3真实模块子切片已实现、按[审查](../reviews/03-code-review.md)分别检查Standards/Spec并验证；整票in-progress，E1/Python/长终端/编码/默认会话尚待完成。

- `node docs/work/general-agent/prototypes/a01-cli.mjs`：再次确认echo可用，Node/Python外部命令拒绝，E3祖先EPERM，未把失败记为通过。
- `node --test --test-name-pattern 'A03 real E3 imports' tests/integration/tool04-script-native.test.mjs`：最初red，期望ERR_ASSERTION却先遇到C:\祖先lstat EPERM。
- `npm run build`：原native构建/TypeScript/产物完整性通过，源码构建0.1.0+local.ea857b6096fc。仅固定E3 Node解析参数增preserve-symlinks/main；未加祖先ACL或扩大read根。
- `node --test --test-name-pattern 'A03 real E3 imports|lux bridge and Node permission model reject|real E3 runs Node ESM|real E3 runs node-cjs' tests/integration/tool04-script-native.test.mjs`：4/4。真正进入项目断言失败，改依赖后通过；ESM/require及root/cwd、junction/hardlink/外部文件拒绝保持。
- `node --test --test-name-pattern 'D04 real native tool stops' tests/integration/tool04-script-native.test.mjs`：1/1，1.412秒，原5秒停止写入目标保持。
- `npm run check:product`：类型/lint、74/74和UI/IPC15/15通过。

没有数据库迁移、付费调用或用户环境变更，D13 gate保持。回退本切片仅移除固定解析参数与对应回归，不回退用户项目。切片终点为`fix: load scoped project modules in isolated Node scripts`提交。后续继续运行时租约/依赖与真实CLI，不用E3子切片代替整票。

### E1标准输出切片

起点b07cf7d。原生E1 detached cmd启动外部runtime可exit0但stdout消失，独立版本用例先red；改为CREATE_NO_WINDOW后实际版本输出通过。E3/PTY、句柄列表、AppContainer/Job/ACL及生产网络策略保持。

- `node --test --test-name-pattern 'A03 real E1 captures' tests/integration/tool04-script-native.test.mjs`：red→green，1/1、2.006秒。
- `node --test --test-name-pattern 'native E1 uses real AppContainer/Job' tests/integration/sec03-native-host.test.mjs`：1/1，2.845秒；外部文件、ambient env、真实网络拒绝保持。
- `npm run build`和`npm run check:product`：当前native/源码构建0.1.0+local.ae6f013acc5e，类型/lint、74/74与UI/IPC15/15通过。
- `node docs/work/general-agent/prototypes/a03-runtime-probe.mjs`：仅区分实验；deny在native前CAPABILITY_RISK_DENIED，unrestricted persona下native仍deny网络。版本exit0输出真实；Node直接脚本及显式--test-isolation=none可断言失败后修正通过，默认--test超时、Python仍失败。不能标完整CLI已通过；细节见诊断，不部署原型的SDK复制方式。

子切片按审查已验证；终点为`fix: capture external CLI output without detached consoles`提交。后续继续现有文件句柄兼容、运行时产品接入、编码、终端和普通会话。

### 已有文件共享兼容切片

起点182db0e。已有文件type被宿主DELETE保留句柄阻挡，真实red。最终用FILE_READ_DATA替代DELETE且继续不共享删除；仅移除DELETE的候选未保持ren拒绝，已弃用。当前源码构建0.1.0+local.768e8d13e4fe。

- `node --test --test-name-pattern 'authorized existing files remain readable|lux bridge and Node permission model reject' tests/integration/tool04-script-native.test.mjs`：串行2/2，读取/内容/身份/目标不存在与原范围负向通过。
- `node --test --test-name-pattern 'locks prevent implicit SID propagation|native E1 uses real AppContainer/Job' tests/integration/sec03-native-host.test.mjs`：2/2，不扩大链接/外部文件/父环境/网络权限。
- `node docs/work/general-agent/prototypes/a03-runtime-probe.mjs`：Python真实unittest断言→修正→通过；Node默认--test仍超时，对应上游libuv AppContainer pipe缺陷见诊断。没有改系统SDK、网络策略、journal或D13 gate。

按审查闭合当前子切片；整票保持in-progress，继续生产运行时/依赖提示、编码、长终端与默认会话。Node pipe问题不能靠静默改测试参数掩盖。

### E1编码切片（子切片已验证）

起点e1f648b。以同一次E1中的中文cmd echo及外部Node stdout/stderr作为真实接口，先复现混合OEM/UTF-8输出。最终只在宿主自己隐藏console中设置UTF-8，E1继承console并保持原命令/标准句柄；不修改用户console，不猜测系统语言。E3与ConPTY保持原UTF-8；不承诺自动识别任意二进制/其他自行指定编码。

- 原build通过，源码构建0.1.0+local.d8ed84e25321。中文/版本/保留文件/直接引用路径与空格参数及cwd/exit7定向4/4；实际非零退出没有变成功。
- 原E1真实AppContainer/Job、数据/环境/网络负向1/1；D04停止1/1、1.696秒。修复测试重复读取正在写的JSON竞争，只复用已观察快照，不放宽断言或上限。
- `npm run check:product`：类型/lint、产品74/74、UI/IPC15/15通过。按审查记录闭合；临时chcp/嵌套cmd方案未保留，无额外shell进程或命令改写。

### 持久终端结果切片（子切片已验证）

起点a52d08a。使用原ExecutionIsolationService/Terminal facade接真实native completion；当前投影把结束码丢成null，不能满足L02/L05。保留exitCode和完成原因，区分自然退出/非零退出/执行限制/通道失败；原owner、输入绑定、分页与清理不变。先测公共readOutput与facade，再跑真实cmd长任务、stdin及结束码，不新增终端实现。

- 公共结果2项red→green；原输入/grant/PTY窗口/owner/退休共相关11/11。完整两文件60项实际57/60；三项fixed-production native denial observation仍失败，单独复现且未定位，详见诊断，不能视为全套通过。
- `node --test --test-name-pattern 'A03 real persistent terminal' tests/integration/tool04-script-native.test.mjs`：1/1，64.292秒；正确stdin、跨Session拒绝、1600行分页完整取回、>60秒与exit7通过。首轮旧truncated语义误判已改为起点连续/无早期丢失/末行仅一次，不降低真实覆盖。
- `node --test --test-name-pattern 'A03 stopping a real terminal' tests/integration/tool04-script-native.test.mjs`：1/1；停止<5秒、写入父子PID消失/不再写、独立进程未杀。
- 原build与check:product通过，源码0.1.0+local.f55eb60e828c，产品74/74、UI15/15。按审查闭合子切片；未勾整票，默认入口/SDK与原生观察失败继续。

### 默认助手与只读终端入口（子切片已验证）

起点a07adb1。默认助手按需发现现有CLI工具；以真实Broker/原生执行验证中文cmd、持久终端与退出7。Agent仅向宿主暴露当前run的只读投影，原HTTP Session鉴权内合并到既有终端列表/输出/SSE；面板标注助手终端只读，原输入/清理/kill通道不扩大，取消仍走停止任务。读取视图绑定原run，结束/替换即失效；无需另一套终端、身份或权限体系。

- `node --test tests/integration/agent-cli.test.mjs`：发现allowlist缺失red→green；普通Agent真实6步、中文cmd与exit7，四项精确native确认、只读owner与旧视图失效通过（2.144秒）。没有扩大search_tools暴露上限。
- `node --test tests/electron/agent-cli-view.test.mjs`：真实daemon+合成模型+隔离Electron renderer1/1，35.726秒；当前会话输出/SSE、只读控件/resize、跨Session404、手动视图及结束后失效通过。使用测试壳/认证及resize spy，不代替正式Electron main原生确认或安装候选。
- 原活动手动进程+Agent并发启动真实失败，最小addon openLease断言EXEC_ACL_RECOVERY_REQUIRED已保留；窗口通过只覆盖手动进程结束后的保留视图共存，不说明两个活动进程可并行。
- Agent清理范围新回归red→green，相关4项、完整Broker32/32通过；手动资源保留，Session/authority/poison仍原全清理。原build通过，源码0.1.0+local.69ed8d83d46b；check:product结果见收尾记录。

整票仍in-progress：生产SDK租约与依赖提示、默认Node pipe、活动host并发及三项原生认证观察失败尚待解决。当前源码slice不作为安装交付承诺。

收尾：类型/lint、产品74/74与UI/IPC15/15通过；完整Broker32/32通过。当前切片按Standards/Spec审查闭合并本地提交，后续继续A03兼容实验，不把A04/A05前置标为已满足。

### 上游Node管道修复实验（进行中）

起点4653916。2026-10-20复查Node release/nightly索引，均未含libuv1.53，升级现成官方二进制不是已证实解法。比较等待上游、升级全部libuv、自建仅36行上游pipe补丁；先选临时构建Node24.14.1+libuv官方commit 2cadaa40167050baf7c6905ac897e6fb57afb2c6中的pipe.c变更，保持应用构建Node不变。不移植其CI/其他系统修复，不安装到用户项目，不改隔离或测试参数。

最高验证接口仍为A03现有E1原型的默认node --test，先确认真实断言→修正→TAP/退出码；只有通过后才讨论运行时产品接入及维护成本。原型构建目录在C盘Temp，因F仅余约1.8GiB、C约105GiB；下载原始源码以官方SHASUMS核对，临时路径/日志记录到忽略的test-results。不清理用户文件腾空间，不把临时或未签名运行时称可发布依赖。

实验结果：官方源码SHA256 `7822507713f202cf2a551899d250259643f477b671706db421a6fb55c4aa0991`核对通过；只移植pipe.c的上游补丁，git apply --check通过。Windows tar不能处理源码内三项中文copy测试名，改用Python3.14 tarfile data filter并明确省略非编译用Node/V8测试及docs；没有省略本项目Agent回归。vcbuild在编译前退出1：Node24要求ClangCL，当前VS2022未安装Clang/LLVM组件，三个标准clang-cl路径均不存在。未安装系统组件、未修改应用Node、未生成可用二进制，故默认Node测试仍未通过。临时源码保留，可在具备工具链后--resume；当前不继续为此临时实验扩建SDK安装器。

等待工具链/兼容决定期间，按唯一总路线选择下一项前置已满足的D06（D03、D05 verified）做独立文件依据工程；A04/A05仍保留A03前置未满足，未调整依赖。

