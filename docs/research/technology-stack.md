# 当前切片技术依据

更新：2026-09-30。以当前仓库及安装版本为准，新增技术仅引用官方资料。

## R3

- 复用 Node 原生测试运行器与现有 helpers；npm 串联现有行为检查，不添加清单生成框架。依据：[Node 24 测试文档](https://nodejs.org/docs/latest-v24.x/api/test.html)。
- 输入框使用浏览器 `field-sizing: content`，由 min/max-height 限制，替代 renderer 动态内联样式。依据：[MDN field-sizing](https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/field-sizing)。安装的 Electron 中实际测量多行、清空和高度上限；不假设所有浏览器兼容。
- 开发启动使用 npm Node 与 tsx loader，保留原 IPC 私有管道与 readiness 身份检查；安装模式仍使用现有编译入口。

## R4（2026-09-30）

复用 fetch-runtime.ts 的 Readability/有界读取与 network-policy.ts 重定向网关；fetch_markdown 返回宿主结构化回执，来源清单从现有 tool 历史投影。网络和执行许可不变。`marked` 的本地 lexer/walkTokens 与界面同源，用于显式链接、GFM 自动链接、参考式链接；代码片段不当作引用。

Word 参考资料使用当前 docx 安装版本的 ExternalHyperlink/HeadingLevel；定义见 node_modules/docx/dist/index.d.ts，并以真实生成和解析验证。未引入额外 Office 库。正文获取状态与事实正确性明确分开，公开官方资料入口和人工预期见 R4-model-evaluation.md。

## R5（2026-09-30）

连接检测复用本地 OpenAI SDK chat.completions.create 和 AbortSignal；SDK maxRetries 已为 0，检测独立一次调用，不走 Agent/Memory。当前 Provider 只接通 OpenAI compatible 两类；不添加不支持的 Provider。读取受保护的 getProviderProfile 快照，现有 Base URL 校验和 HTTP 鉴权保持有效。

设置可用性以 settings-schema.ts 的 domainManifest 与实际 AppSettings 为准；common 的内部 domain 未接通不代表工作/输出目录无效。新界面隐藏待接入设置，不修改存储 schema。impeccable onboard 依据用户既定“对话与成果”方向与已批准 DESIGN.md。

独立模型验收需 Windows Chromium Local State 中 OS 保护配置密钥；依据 [Electron 43.1.1 源码](https://raw.githubusercontent.com/electron/electron/v43.1.1/shell/browser/electron_browser_main_parts.cc)，只复制必要字段并在退出后删除。

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
