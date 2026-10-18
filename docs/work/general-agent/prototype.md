# A01 可行性实验与接入决定

日期：2026-10-18。A01回答现有能力能否接入普通助手以及哪里必须补齐。以下是独立工程实验；没有调用真实模型，没有接入生产工具注册表。原型源文件标记throwaway，暂保留供A03/A05/A07/A08/A09复现；对应生产路径验证后可删除。

## 结果与下一步

| 探针 | 实际输入与结果 | 决定/后续验收 |
|---|---|---|
| CLI/项目 | Broker+原生E1执行`echo`成功；使用当前Node跑小项目测试、Python跑unittest均被拒绝，退出1。E3内联Node脚本两项已有真实回归通过；E3直接import项目文件则在Windows父目录realpath/lstat失败（EPERM）。修正项目代码仍不能越过执行问题 | A03先补明确的开发运行时租约及必要路径元数据访问，跑真正的Node/Python红→修复→绿；不能将“脚本工具可计算”当作项目CLI可用。保留Job/取消/范围保护，不用全局放权代替适配 |
| MCP | 临时官方TypeScript SDK1.32.1，经真实stdio和loopback Streamable HTTP列举sum并调用[3,5,13]，二者结构化结果均为21 | SDK与协议可用；A05/A06接到普通会话。stdio原型直接SDK子进程只证明协议；生产需受控原始管道Transport，不能绕过原生执行/所有者链 |
| 浏览器 | 既有headless CDP真实流程通过；新增原生表单实验中fill可用，press Enter未提交，press Tab未移动焦点 | A07修真实键盘输入与状态核验；旧Browser6/6不能证明原生交互完备 |
| 图像 | 真实CDP截图3424bytes；当前用户附件投影确有PNG data URI；同一图像作为tool附件被拒绝：Only user messages may contain attachments | A08新增工具观察到模型图像消息的适配，保持call/目标/坐标/预算关联。不能只返回路径，也不能把未经支持的tool图像结构发给提供方 |
| Windows | 独立UIA客户端线程观察自建窗口，ValuePattern输入中文、InvokePattern执行按钮，PrintWindow截图经图像检查内容正确。360×180、96DPI、非管理员；self-contained x64程序在DOTNET_ROOT指向不存在目录时退出0 | Windows公共API路径可行。A09/A10继续做真实应用、目标窗口/焦点、125%/150%和多显示器；当前只控制自己的离屏测试窗口 |

现有CLI障碍不是模型选择问题。E1外部程序访问与E3模块解析失败已被独立记录，A03须先复现。若最小运行时/目录元数据契约不能实现，应在A03提出具体替代和成本；不得静默换成无隔离执行。

## 最小接口与默认助手

1. 默认general仍按任务发现能力；允许列表/注册表必须真实接入，search_tools不能突破允许范围。统一提供available、缺依赖/未配置/不支持原因，原型不改变这些状态。
2. CLI复用现有调用授权、原生执行、Job、raw输出/输入和取消。先认证Node/Python运行依赖、cwd与模块解析，再补持久终端交互；命令编码须可理解或保留原始字节，不能输出乱码。
3. MCP使用官方SDK Client和协议schema。SDK Transport接现有NativeExecutionHandle的write/output/terminate，或暴露所需的最小原始管道会话；与终端ConPTY视图分开。远端HTTP无需本地服务器进程，但认证/取消/未知写入仍需接运行链。
4. 浏览器保留一个CDP后端，替换已证实不足的键盘动作。截图是观察数据；工具观察图片经宿主适配成提供方支持的图片输入，文字回执与tool call关联保留，不假设当前SDK支持tool角色图片。
5. Windows helper在标准用户交互会话中运行，限定观察/控件/输入接口并绑定run；复用宿主认证，避免通用shell接口。将控件操作和视觉坐标落在同一观察—动作—核验循环。

## 部署与支持矩阵草案

- 原生实验本机Windows x64、非管理员，96DPI；没有干净机器或Office/WPS/多显示器验收。最终标准用户支持在A09/A13验证。
- .NET SDK9.0.200成功发布self-contained win-x64，目录176,720,173bytes。证明可随包带运行时，但代价较大；A09比较系统已有薄宿主与该方案的体积/依赖/维护成本再定，不直接把此原型当生产helper。
- Node24.14.1已确认内联E3执行；完整项目Node命令、Python3.14命令在当前隔离通道未通过。A03完成前不把它们列已支持。
- MCP SDK1.32.1要求Node≥18，临时安装于test-results，生产package.json/lock没有变化。认证、动态schema、取消、资源和第三方服务尚未验证。
- 主模型/视觉模型配置仍未认证。工程图片投影通过不等于模型看懂；真实视觉在A08，真实工具任务在D02/A04/A13。

## 运行与证据位置

临时依赖：`npm install --prefix test-results/a01-probe --ignore-scripts --no-audit --no-fund @modelcontextprotocol/sdk@1.32.1 zod@4`。依赖只用于实验，生产A05另行锁定/审查版本。

```powershell
node docs/work/general-agent/prototypes/a01-cli.mjs
node --import tsx docs/work/general-agent/prototypes/a01-protocol-and-vision.mjs test-results/a01-probe
node --test --test-name-pattern "real E3 runs Node|node-cjs require" tests/integration/tool04-script-native.test.mjs
node --import tsx --test tests/integration/eco08-browser-cdp.test.mjs
dotnet publish docs/work/general-agent/prototypes/a01-windows/Probe.csproj -c Release -r win-x64 --self-contained true -p:BaseIntermediateOutputPath=F:/mini-lux/test-results/a01-probe/windows-obj/ -p:BaseOutputPath=F:/mini-lux/test-results/a01-probe/windows-bin/ -o F:/mini-lux/test-results/a01-probe/windows-publish
```

Windows程序通过Node spawnSync以windowsHide=true运行，只传自己的PNG输出路径，20秒超时；DOTNET_ROOT指向测试目录中的不存在路径、DOTNET_MULTILEVEL_LOOKUP=0。退出0，JSON中uiaObserved/invoked/captured均true，elevated=false；图片已查看。96DPI的运行不代表125%/150%通过。

本机证据在忽略目录test-results/a01-probe：protocol-and-vision.json、cli-result.json、windows-result.json、windows-window.png与发布目录。Node原型临时项目自动清理，MCP进程/HTTP服务与自建窗口已关闭；编译中间文件留在该忽略目录，不加入应用或Git。

## 投入校准与退出

A01已经将五个问题转成具体接口与失败场景。相比原先“已有CLI只需接入口”的假设，A03/A05预计增加3–6个维护者工作日用于运行时与原始管道适配。总路线调整为58–96工程工作日，另计5日试用，约13–21周；仍是粗估，A03两个真实项目跑通后再重估。没有新增完整沙箱、审计平台或Agent内核的研发项。

本票工程调查完成，不代表CLI/MCP/Computer Use已产品化；失败结果是后续必修项，不改写成能力通过。
