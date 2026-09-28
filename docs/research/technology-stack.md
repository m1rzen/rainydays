# 当前切片技术依据

更新：2026-09-28。只使用当前仓库及安装版本的资料。

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
