# 当前切片技术依据

更新：2026-10-18。以当前仓库及安装版本为准，新增技术仅引用官方资料。下方 R1 等小节保留当时发现；当前实现状态以 STATUS 和对应后续验证为准。

## 同事版研发（2026-10-18）

扩展代码、CLI、MCP、浏览器、Windows Computer Use、技能与有界子任务的官方依据和本机证据集中在[通用Agent技术研究](general-agent-stack.md)。A系列读取该文与[能力实现手册](../agents/general-agent-capabilities.md)，复用下述既有栈；不因参照Codex/Lux就自动迁移模型SDK或整个内核。

规划基线 417039e；当前包入口和测试命令已从 package.json 核对。本轮不更换技术栈。D01–D18 对应代码、待研究问题与验收见 [任务图](../work/colleague-delivery/plan.md)，研究与代码位置导航见 [架构手册](../agents/architecture.md)。

- Lux：用户已确认本机 Desktop 0.1.898；版本元数据、随包 Help、既有捕获基线与研究预算见 [定向逆向计划](lux-reference-plan.md)。没有重跑动态探针，不把说明文档当作全部运行证据。
- 模型与上下文（D02/D03/D07）：以 src/llm.ts、memory.ts、task-tools.ts 及已安装 SDK 类型为当前接口事实。28,000 消息粗估预算与最终工具 schemas 分开，需要完整请求预算与真实行为验证；未选择新 SDK。参考配置/模型容量/费用须按具体配置实施时核对官方资料，当前不编造跨模型兼容结论。
- 重复任务（D10/D11）：routine.ts 是带 schema 的脚本工程，playbook.ts 有独立生命周期；普通同事入口采用最小任务 metadata + 现有 Agent run。先评估存储复用，不增加第三个执行内核。
- 打包与恢复（D13/D14）：现有 Electron/NSIS、better-sqlite3、原生宿主与恢复链为实现基线。源码启动证据不能证明包内依赖和干净安装，必须在当前候选核对。
- 文档输出（D06/D08）：复用当前 parser/worker、docx、vendor xlsx；明确公式缓存与实际重算差别，目标办公软件视觉/编辑验证由票据要求。

每票开始前只补它需要的官方 API/版本事实；本节是已知输入与未知项清单，不将未来研究标为 research-complete。涉及外部模型新用法时先检索其对应官方资料再实现。

D02本地协议研究（2026-10-18）：已读已安装OpenAI SDK4.104.0的chat/completions类型和streaming实现。finish_reason区分stop/tool_calls与length/content_filter；stream_options.include_usage可在最终空choices块携带usage，断流可缺失。沿用该版本和Chat Completions，不新增API。provider兼容性、实际模型版本、费用仍未知，留真实认证；fixture只验证应用契约。

D03预算资料（2026-10-20）：已核对[Kimi官方模型说明](https://www.kimi.com/en/help/kimi-code/models)与[CLI配置说明](https://www.kimi.com/code/docs/en/kimi-code-cli/configuration/config-files)。模型别名可原地升级，模型页面写最高1M而示例配置仍保留262144；不能凭kimi-for-coding名称替用户认定实际可用窗口。沿用现有SDK的max_tokens与usage类型，不迁移协议；按profile设置保守工作预算，真实容量和估算误差另验。官方资料查询不调用用户模型或密钥。

## 演示修复（2026-10-16）

当前 Node 的 better-sqlite3 ABI 137，Electron RunAsNode ABI 148；演示入口直接启动 Electron 会丢失 npm_node_execpath。复用现有 npm exec 注入开发 Node，保持既有 IPC 和用户目录行为。

SQLite WAL reset 可以保留前代帧，盐值区分当前提交与旧尾部；不能把旧代尾部直接判为数据库损坏。依据：[SQLite WAL 格式与重置](https://sqlite.org/fileformat2.html#wal_reset)、[WAL checkpoint](https://sqlite.org/wal.html#checkpointing)。真实复现使用本机 better-sqlite3 生成，既有损坏校验不整体移除。

会话恢复复用 session.ts 的 exportSession / importSession，包括消息、固定指令、任务、附件验证和 ID 映射；用 SQLite backup 产生一致副本。只追加缺失会话，不复制旧审计链、任务许可或覆盖当前配置。副本和实际结果分别核对，原库与恢复前快照保留在忽略的私有目录。

## R3

- 复用 Node 原生测试运行器与现有 helpers；npm 串联现有行为检查，不添加清单生成框架。依据：[Node 24 测试文档](https://nodejs.org/docs/latest-v24.x/api/test.html)。
- 输入框使用浏览器 `field-sizing: content`，由 min/max-height 限制，替代 renderer 动态内联样式。依据：[MDN field-sizing](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/field-sizing)。安装的 Electron 中实际测量多行、清空和高度上限；不假设所有浏览器兼容。
- 开发启动使用 npm Node 与 tsx loader，保留原 IPC 私有管道与 readiness 身份检查；安装模式仍使用现有编译入口。

## R4（2026-09-30）

复用 fetch-runtime.ts 的 Readability/有界读取与 network-policy.ts 重定向网关；fetch_markdown 返回宿主结构化回执，来源清单从现有 tool 历史投影。网络和执行许可不变。`marked` 的本地 lexer/walkTokens 与界面同源，用于显式链接、GFM 自动链接、参考式链接；代码片段不当作引用。

Word 参考资料使用当前 docx 安装版本的 ExternalHyperlink/HeadingLevel；定义见 node_modules/docx/dist/index.d.ts，并以真实生成和解析验证。未引入额外 Office 库。正文获取状态与事实正确性明确分开，公开官方资料入口和人工预期见 R4-model-evaluation.md。

## R5（2026-09-30）

连接检测复用本地 OpenAI SDK chat.completions.create 和 AbortSignal；SDK maxRetries 已为 0，检测独立一次调用，不走 Agent/Memory。当前 Provider 只接通 OpenAI compatible 两类；不添加不支持的 Provider。读取受保护的 getProviderProfile 快照，现有 Base URL 校验和 HTTP 鉴权保持有效。

默认工具复用 getToolProtocolDescriptors 的 authentic Broker 快照、search_tools 的 scoped definitions 和 Agent 现有 outcome 历史。新的加载集合只在单次运行内保存，成功宿主发现回执加工具；实际调用仍经过 inspectToolCall。普通正文不能改变加载集合，集合不能超过本轮允许协议。前后体积以已安装的真实严格化 schemas 序列化测量，不用工具名长度代替。

设置可用性以 settings-schema.ts 的 domainManifest 与实际 AppSettings 为准；common 的内部 domain 未接通不代表工作/输出目录无效。新界面隐藏待接入设置，不修改存储 schema。impeccable onboard 依据用户既定“对话与成果”方向与已批准 DESIGN.md。

独立模型验收需 Windows Chromium Local State 中 OS 保护配置密钥；依据 [Electron 43.1.1 源码](https://raw.githubusercontent.com/electron/electron/v43.1.1/shell/browser/electron_browser_main_parts.cc)，只复制必要字段并在退出后删除。

### D06 文件位置与公式依据（2026-10-20）

本机SheetJS0.20.3的types含cellFormula、cellDates、sheetStubs、encode/decode_cell、format_cell；[官方cell对象](https://docs.sheetjs.com/docs/csf/cell/)区分t/v/w/f/F，日期不携带可靠时区，格式值不等于原始值。[公式说明](https://docs.sheetjs.com/docs/csf/features/formulae/)与当前库均未提供本项目可直接依赖的通用重算能力，读取只能明确缓存/缺失。Mammoth当前raw-text实现对每个paragraph追加两个换行，[官方raw text说明](https://github.com/mwilliamson/mammoth.js#extracting-raw-text)亦说明忽略格式；因此只能给提取段落序号，不能推断物理页。实现只加read证据投影，原预览不重写。

## R1

- Node 24.14.1；TypeScript 5.7.3；tsx 4.23.0；OpenAI SDK 4.104.0；better-sqlite3 12.11.1。
- `src/memory.ts` 在 addMany/loadFromDb 固定截短工具内容，compact 使用 28000 估算 token 预算；`src/db.ts` 保存原工具内容。用已有数据库保存完整记录，不引入新存储。
- `src/tool-pipeline.ts` 已有 128 KiB 工具输出上限。移除记忆截短不等于解除工具输出上限；更大结果分页另做。
- `node_modules/openai/src/streaming.ts`：SSE error 会抛 APIError；流迭代错误与建立请求错误须由调用层区分。当前 `src/llm.ts` 的 catch 同时覆盖二者，导致中途重试。
- `src/agent.ts` 只在完整 result 后保存回答；`public/renderer.js` error 分支清空已显示内容。两端必须同步修复。
- 验证命令从源码运行，避免旧 dist 冒充新结果；真实模型质量与打包分发另行验收。

## R2-01

- `src/tools/parsers.ts` 已提供 mammoth、xlsx、pdf-parse 的字节解析；`src/document-parser.ts` 在 worker 中执行并管理取消。
- `src/tools/filesystem-lux.ts` 的 read 与代理 read_file 是可复用公共接口；附件句柄在调用远程 Worker 之前解析，只使用调用上下文中的会话 ID。
- `src/file-viewer.ts` 已有 Office 文本预览、PDF 预览；`src/tools/writer.ts` 已有 DOCX/XLSX 输出，不复制实现。
- 保留 text/image 持久化枚举，通过 MIME 区分文档。旧附件与导出结构保持兼容；新增文档内容不会被 Provider 直接按 UTF-8 解码。

## R2-02：任务内新建与成果清单（2026-09-28）

本地代码为本次接口依据：capability-broker.ts 的审批挑战、运行上下文、调用路径网关；path-policy.ts 的 preflightWrite/commitPreflightWrite；ask-user-tool.ts 的身份绑定回答通道。新建提交使用已有 createFile 原子无覆盖语义；预检时缺失而提交时出现的文件必须拒绝。任务许可仅内存保存，绑定根运行对象与内置注册绑定。

writer.ts 已在 reserveFile.commit 后返回结果；将回执改为含实际路径的 JSON，成果读取模块只接受匹配成功 tool 消息。db.ts getMessagesBySession 保留消息顺序，memory.compact 不删除数据库历史；复用 messages HTTP 响应附带 outputs，无额外迁移。renderer.js createLocalFileLink 复用受限 File Viewer。界面沿用 renderer.css 的现有颜色、控件与可滚动区域。
