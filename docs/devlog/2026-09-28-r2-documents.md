# 文档阶段第一批：附件到按需读取

起点 ed6afd2；用户授权“进入下一阶段”。本轮没有使用真实模型、用户文件或真实会话数据库。

## 交付

- PDF/DOCX/XLSX 附件入口，保留原始字节与哈希。文档及超过 4000 bytes 的文本通过附件索引提供给模型，不整份塞入请求。
- 复用 read/read_file 接受 `attachment:ID`，使用真实会话归属和原有隔离解析。最多 12 个提取行/次，长行按 500 Unicode 字符拆分并给出下一页位置。
- 来源文件名与提取行号可引用，PDF 保留页码。空文本 PDF 提示识别文字，损坏文件报告解析失败。
- 11→12 数据库事务迁移只扩展附件 MIME 约束，保留旧消息和附件；构建及打包版本常量同步。
- 复用原有 DOCX/XLSX 创建及 Office 文本预览。测试验证生成内容回读与 Word 修订稿回读；不宣称已完成真实模型文档端到端验收。

## 验证

| 命令/范围 | 结果 |
|---|---|
| `node --import tsx --test tests/product/*.test.mjs` | 最终 15/15，通过真实 SQLite、解析 worker、Broker 工具调度；约 18 秒 |
| `node --test --test-name-pattern "R2 real Electron" tests/electron/desktop-smoke.test.mjs` | 1/1，真实窗口上传 PDF 并取回相同字节 |
| `tests/unit/attachment.test.mjs` + `tests/integration/ds05-attachments.test.mjs` | 4/4，旧文本/图片、上传、会话归属、导入导出与重启通过 |
| `npm run build` | 通过，最终构建 `0.1.0+local.898b6e9eb2da`，包含 TypeScript 检查 |
| 涉及文件 ESLint、`git diff --check` | 通过 |
| Schema 11→12 专项测试 | 旧绑定消息、附件记录和字节保持一致，两次启动成功 |
| 在线备份、恢复 staging 定向复测 | 各 1/1 通过 |
| Workbench 布局、Schema 2→12 Task DAG 迁移、Agent DAG 恢复、五工具接口 | 通过 |

初次测试依次发现应用层 MIME 限制、数据库 CHECK 限制，修复后转绿。分页测试检查 12000 个“正文”完整取回，末尾事实可见；Unicode 测试检查 6501 个字符完整取回。

## 未通过的扩展检查

- TOOL-02 7 项失败于已有 Worker WIP 要求 capabilityContext，而旧夹具没有 sessionId。该 Worker 分支未纳入本轮提交；其测试进程未退出，已仅终止对应测试子进程。
- 版本综合脚本首次因打包仍检查 schema 11 失败，此项已修复；随后在旧 Electron 测试夹具缺 service-supervisor.cjs 处超时。试验性复制完整夹具后仍与已有 safe-mode 行为不匹配，已撤回这项无关测试改造。
- 扩展审计/通知/任务持久化存在超时、通知接口返回 active-run 409；未确认全部根因，也未放宽时限或关闭断言。它们继续属于发布前待查项。
- schema 相关旧测试断言和夹具参数已更新为 12，非版本相关断言保留。

## 范围与保护

原 WIP 保留。`src/tools/filesystem-lux.ts` 原有 Worker 改动与新增附件支持共用文件，仅暂存本轮 4 行差异，其余 WIP 不提交。开始前的补丁与该文件副本保存在系统临时目录 `rainydays-r2-start`。

下一批：任务范围内新建成果许可、成果入口，以及真实模型从资料到报告再修订的验收。当前每页重新解析文档；尚未优化缓存。大资料支持仅覆盖本次附件路径，不代表任意工具输出都有完整结果索引。
