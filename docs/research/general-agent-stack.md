# 通用 Agent 扩展：技术依据与研究问题

更新：2026-10-18。此文记录静态材料与官方资料，不是运行验收。代码映射见 [能力手册](../agents/general-agent-capabilities.md)，工作顺序见 [任务图](../work/general-agent/plan.md)。

本轮A01的实际运行结果另见[可行性实验](../work/general-agent/prototype.md)：临时官方MCP SDK1.32.1（Node≥18）通过stdio/Streamable HTTP协议往返；非管理员自建Windows窗口通过UIA/PrintWindow及自包含发布。CLI完整项目、浏览器真实键盘、工具图片投影均有失败复现，不能由下述静态资料推断产品已支持。

## 一、产品参照应怎样使用

Codex官方CLI文档描述项目阅读、编辑、命令执行，以及技能、MCP与子任务等能力。这里采用这些能力类别及结果循环作为参照；不声称每个Codex界面或平台都提供同样的原生桌面控制。[Codex CLI](https://learn.chatgpt.com/docs/codex/cli)

Computer Use还需要驱动应用/浏览器、把观察交给模型，再执行动作并观察后果。模型API本身不会替RainyDays提供Windows窗口管理、权限、清理或UI交接。[Computer use指南](https://developers.openai.com/api/docs/guides/tools-computer-use)、[动作集成](https://developers.openai.com/api/docs/guides/tools-computer-use-integration)

实现选择：复用现有LLM抽象，用通用工具调用和图像输入先跑通；提供方原生computer工具可作为同一适配接口的后续选择，不因参照Codex就强制迁移全部模型提供方。

## 二、协议和平台的一手资料

| 主题 | 已查资料 | 对本项目的决定 |
|---|---|---|
| MCP配置与接入体验 | [Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli) | 支持stdio、HTTP和必要认证；用户在应用内可配置与检查状态 |
| MCP客户端SDK | [官方SDK索引](https://modelcontextprotocol.io/docs/2026-07-28/sdk) | 实施时选择并锁定TypeScript SDK，核对安装版本支持的协议与运行时 |
| MCP传输 | [2025-11-25传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports) | stdio与Streamable HTTP分别测试；断开连接不代表取消，旧HTTP+SSE不作默认实现 |
| MCP认证 | [2025-11-25认证规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization) | 复用SDK OAuth/PKCE与凭据存储；开发前核对所选服务/协议版本，不自写SSO |
| Windows UI Automation | [Microsoft UIA](https://learn.microsoft.com/en-us/windows/win32/winauto/entry-uiauto-win32) | 优先读取可访问性控件及其操作；无可用树时才用视觉坐标 |
| Windows输入 | [Microsoft SendInput](https://learn.microsoft.com/en-us/windows/win32/api/winuser/nf-winuser-sendinput) | 注入受UIPI/完整性等级限制；普通用户工具不承诺操控提权窗口，修饰键状态需处理 |
| .NET部署 | [Microsoft部署说明](https://learn.microsoft.com/en-us/dotnet/core/deploying/) | self-contained可包含运行时；A01实际发布约177MB，A09比较薄宿主与该方案后定生产选择 |

引用2025-11-25是明确研究快照，不声称它永远最新。实施时记录SDK版本、协商协议和测试服务；升级只在实际兼容需求下进行。不得从官方资料推断第三方服务一定正确实现规范。

## 三、本机Lux v0.1.898的新增证据

根目录：`C:/Users/raidriar/AppData/Local/Programs/Lux/resources/app/lux-dist`。仅作本机研究参数，不进入产品硬编码。参照 [已有计划](lux-reference-plan.md)。

- `help/tools.md`列有文件/仓库、持久bash、浏览器、`desktop_*`、动态`mcp_*`、子任务和图像辅助工具。说明有这些接口，不证明用户任意任务都成功。
- `win-desktop.ps1`可读代码使用UIAutomation、Windows图像/窗口接口，提供NDJSON请求响应与截图/输入；本轮未执行该脚本、未操作Lux用户实例。
- RainyDays的CLI/终端和浏览器已有模块；MCP只发现配置定义与关闭状态，未发现实际客户端；未发现完整原生桌面工具组。证据入口见能力手册。

不拷贝Lux闭源bundle或helper进安装包。研究可观察接口和失败行为，用Windows公共API/官方SDK独立实现；完整反混淆无法恢复服务端和模型能力，也不是必要前置。

## 四、定向研究清单

### A02 Git接口核对（2026-10-20）

本机Git2.53.0.windows.2。核对[ls-files官方文档](https://git-scm.com/docs/git-ls-files)、[status官方文档](https://git-scm.com/docs/git-status)、[rev-parse官方文档](https://git-scm.com/docs/git-rev-parse)：cached与others结合并启用exclude-standard获取未忽略工作树，NUL分隔保留中文/空格；porcelain v1 -z状态的重命名有额外原路径，路径以仓库根为基准；show-toplevel/show-prefix区分根与选定子目录。固定参数、有限输出/超时、现有Git executable lease及Path gateway保持，状态检测禁用可选索引锁，不运行hook/项目脚本或任何Git写命令。项目脚本只展示，A03才负责执行。

### A03 Node运行时核对（2026-10-20）

本机Node24.14.1；对应官方tag的[CLI说明](https://raw.githubusercontent.com/nodejs/node/v24.14.1/doc/api/cli.md)、[permission说明](https://raw.githubusercontent.com/nodejs/node/v24.14.1/doc/api/permissions.md)已查。preserve-symlinks改变模块解析时是否解引用真实路径，主入口有单独选项；目录read许可可能扩为整个子树，不能为解决祖先lstat直接把卷根作为read目录。Node许可不代替OS隔离，原native AppContainer/Job/范围与链接负向保持。先由诊断中区分实验验证最小兼容选项，不仅据文档宣称可用；当前Node/Python完整CLI仍失败。

| 问题 | 最小实验/产物 | 对应任务 | 退出条件 |
|---|---|---|---|
| 常用CLI在现有执行器能否构建/测试 | 临时JS/Python小项目，带退出码/长输出/取消的记录 | A01、A03 | 一个真实开发循环，识别必要依赖及隔离差异 |
| MCP工具如何成为默认助手可发现能力 | 本地stdio和loopback HTTP服务器，列工具→调用→取消 | A01、A05、A06 | 契约fixture与SDK选型；未知副作用不重试 |
| 浏览器当前合成事件是否足够 | 本地SPA的Tab/Enter/表单/下载测试 | A07 | 确定应替换的具体操作，保持一个后端 |
| 模型是否真正收到了截图 | 使用合成非敏感截图，核对请求图片内容与模型实际识别 | A01、A08 | 工程传输与真实视觉结果分别记录 |
| Windows控件与像素如何对应 | 测试窗口在125%/150%DPI和不同显示器移动后输入 | A01、A09、A10 | 标准用户helper可打包、正确观察与点击；失败能停 |
| 技能与子任务是否改善完整任务 | 项目说明+一个技能、两个只读子任务的受控场景 | A11、A12 | 来源/范围/取消/汇总结果明确；无必要时不派生 |

全部Lux定向研究粗预算5–8人日，包含原3–5日基础研究，分散在实际任务内；已经获得足够接口信息的主题不必继续看Lux。先做A01的2–3日技术验证。两次实验没有新信息就记录未知并采用本项目契约；不以旧68卡全绿作为退出条件。

动态研究使用临时文件、测试窗口、loopback服务与脱敏样本。真实模型、外部MCP账号和同事应用的数据须核对具体授权，不自动扩大已有default五项研究许可。
