# RainyDays 全量复刻差距清单

> 生成时间：2026-07-08
> 基线：Lux Desktop v0.1.887
> 项目位置：F:\rainydays
> 状态：每项修复完成后标记 `[x]`，用户核实后标记 `✅ 已核实`

---

## A 类：基础缺陷（导致功能不可用）

这些是地基级问题，直接导致已有功能在真实使用中崩溃或退化。**最高优先级修复。**

### A1. 上下文压缩是截断不是摘要

| 项目 | 内容 |
|------|------|
| **Lux 行为** | Canvas 压缩：用 LLM 把旧对话生成摘要，保留语义信息。"重要内容保持清晰，远处细节柔化为轮廓" |
| **RainyDays 现状** | 纯 slice 截断：`otherMsgs.slice(-keep)` + 工具结果 `slice(0, 1500)`。直接砍掉后半段，丢失语义 |
| **问题后果** | 长对话中 agent 会"忘记"之前做过什么。工具结果被截断后 LLM 丢失关键信息 |
| **修复方案** | 当 token 接近预算时，用一次轻量 LLM 调用把旧的对话轮次压缩成摘要消息。保留 system + 摘要 + 最近 N 轮完整对话 |
| **涉及文件** | `src/memory.ts` |
| **验证标准** | 模拟 20 轮工具调用后，agent 仍能准确回忆前 5 轮的关键信息（如"之前搜索到了哪些文件"） |
| **状态** | `[x]` |

### A2. 知识不自动注入 prompt

| 项目 | 内容 |
|------|------|
| **Lux 行为** | 每次对话开始时，`<knowledge>` 区域自动注入近期记忆摘要到 system prompt。agent 不需要主动 recall 就能"想起"相关的事 |
| **RainyDays 现状** | 完全没有注入机制。agent 只有主动调用 `recall` 才能搜索记忆。如果 LLM 没想到要 recall，就完全失忆 |
| **问题后果** | 用户说"你还记得上次说的那个项目吗"，agent 不会自动搜索记忆，而是回答"我不记得了" |
| **修复方案** | 1. 每次 agent.run() 开始时，从 memories 表取最近 N 条记忆，拼成摘要注入 system prompt 尾部。2. 对话过程中如果用户提到了和记忆相关的关键词，自动触发 recall（可选优化） |
| **涉及文件** | `src/agent.ts`、`src/memory.ts`、`src/db.ts` |
| **验证标准** | 1. remember 一条信息 → 新建会话 → 不主动 recall，agent 能在对话中自然引用这条记忆。2. 重启服务后记忆仍自动注入 |
| **状态** | `[x]` |

### A3. 任务系统没有驱动执行流

| 项目 | 内容 |
|------|------|
| **Lux 行为** | 任务系统是 agent 循环的一部分。agent 创建任务后**自动逐个执行**，每个任务有独立的执行流。任务有依赖关系（blocked_by），A 没完成 B 不能开始 |
| **RainyDays 现状** | 任务只是"创建 + 标记状态"。LLM 需要自己记住要执行哪些任务，手动调用 update_task。没有任务驱动的执行流，没有依赖关系 |
| **问题后果** | LLM 创建任务后可能"忘记"去执行，或者执行顺序混乱。任务面板只是展示用，不影响 agent 行为 |
| **修复方案** | 1. agent.run() 中检测 create_tasks 调用后，自动进入"任务执行模式"——逐个取 pending 任务，把任务作为 prompt 发给 LLM 执行，完成后自动标记 completed。2. 加 blocked_by 字段，任务有未完成的依赖时不执行 |
| **涉及文件** | `src/agent.ts`、`src/task.ts`、`src/db.ts`、`src/tools/task-tools.ts` |
| **验证标准** | 1. 用户说"整理医院项目生成Excel"→ agent 自动拆 4 个任务 → 逐个执行 → 全部完成 → 汇总。2. 中途不需要 LLM 自己调 update_task，是 agent 循环自动驱动的。3. 任务有依赖时，被依赖任务未完成则跳过 |
| **状态** | `[x]` |

### A4. LLM 调用无重试 / 超时 / 错误恢复

| 项目 | 内容 |
|------|------|
| **Lux 行为** | LLM 调用有重试（网络错误自动重试）、超时处理、速率限制检测、降级策略 |
| **RainyDays 现状** | 直接 `await this.client.chat.completions.create()`，无重试、无超时、无错误恢复。API 网络波动 → 直接崩溃 |
| **问题后果** | DeepSeek API 一次网络波动或速率限制就导致整个对话中断，用户看到错误信息，体验断裂 |
| **修复方案** | 1. 指数退避重试（3次：1s → 2s → 4s）。2. 请求超时（30s）。3. 识别 429 速率限制 → 等待后重试。4. 识别 5xx 服务端错误 → 重试。5. 所有重试失败后 yield error 事件而不是崩溃 |
| **涉及文件** | `src/llm.ts` |
| **验证标准** | 1. 模拟 API 返回 429 → agent 等待后重试成功。2. 模拟网络超时 → agent 重试 3 次后报错但不崩溃。3. 正常请求不受影响 |
| **状态** | `[x]` |

### A5. 工具结果压缩丢失语义

| 项目 | 内容 |
|------|------|
| **Lux 行为** | 工具结果在 canvas 中被"压缩成摘要"——保留关键信息（文件路径、行号、关键数据），丢弃冗余内容 |
| **RainyDays 现状** | 纯截断：`content.slice(0, 1500)`。砍掉后半段，如果关键信息在后半段就丢失了 |
| **问题后果** | 读取一个表格文件，前 1500 字符是表头，关键数据在后半段 → 被截断 → LLM 看不到数据 → 回答错误 |
| **修复方案** | 方案 A（推荐）：对长工具结果用 LLM 生成摘要（和 A1 统一实现）。方案 B（轻量）：智能截断——保留头部 + 尾部 + 包含关键词的行，而非只保留头部 |
| **涉及文件** | `src/memory.ts`（和 A1 统一） |
| **验证标准** | 读取一个 8000 字符的 Excel 文件，工具结果被压缩后，LLM 仍能准确回答文件末尾的数据（如"最后一行是什么"） |
| **状态** | `[x]` |

---

## B 类：核心工具缺失（限制 agent 能力）

这些是 agent 干活的基本工具，缺了就做不了真正的开发/分析工作。

### B1. edit 工具（精确文件编辑）

| 项目 | 内容 |
|------|------|
| **Lux 行为** | `edit`：精确查找替换。`old_string` 必须唯一出现一次，替换为 `new_string`。支持 `replace_all` |
| **RainyDays 现状** | 只有 `write_file`（全量覆盖）。修改一个文件的某一行需要重写整个文件 |
| **问题后果** | agent 无法精确修改文件——修改 config 文件的一个配置项要重写整个文件，容易引入错误 |
| **修复方案** | 实现 `edit` 工具：读文件 → 查找 old_string → 替换为 new_string → 写回。要求 old_string 唯一（除非 replace_all）。失败时返回有意义的错误 |
| **涉及文件** | `src/tools/filesystem.ts`（新增 editFileDef/editFileExec）、`src/tools/index.ts`（注册） |
| **验证标准** | 1. 创建文件 → edit 替换其中一行 → 验证只有目标行被改。2. old_string 不唯一时报错。3. old_string 不存在时报错 |
| **状态** | `[x]` |

### B2. grep 工具（内容搜索）

| 项目 | 内容 |
|------|------|
| **Lux 行为** | `grep`：正则内容搜索。支持 output_mode（content/files_with_matches/count）、上下文行（-A/-B/-C）、文件类型过滤、多行模式 |
| **RainyDays 现状** | `search_files` 只搜文件名，不搜文件内容 |
| **问题后果** | agent 无法"在所有文件里找包含某关键词的文件"。比如"哪些项目文件提到了五邑中医院"做不到 |
| **修复方案** | 实现 `grep` 工具：递归遍历目录 → 读取每个文本文件 → 正则匹配 → 返回匹配结果（文件名+行号+匹配行）。支持 glob 过滤。注意性能（跳过二进制文件、限制搜索深度） |
| **涉及文件** | `src/tools/filesystem.ts`（新增 grepDef/grepExec）、`src/tools/index.ts`（注册） |
| **验证标准** | 1. 在 Z 盘搜索"五邑中医院" → 返回包含该关键词的文件列表+行号。2. 正则搜索 `医院|中心医院` → 返回多个匹配。3. 限制只搜 .docx/.txt 文件 |
| **状态** | `[x]` |

### B3. script 工具（编程计算沙箱）

| 项目 | 内容 |
|------|------|
| **Lux 行为** | `script`：Node.js ESM 沙箱。agent 能运行代码做数据处理、JSON 操作、正则提取、数学计算。top-level await 支持 |
| **RainyDays 现状** | 只有 `execute_command`（Shell 命令）。可以跑 `node -e` 但没有沙箱，且违反 Lux 设计原则 |
| **问题后果** | agent 需要处理 JSON 数据、做正则提取、计算数值时，只能用 Shell 命令拼接，容易出错且不安全 |
| **修复方案** | 实现 `script` 工具：用 Node.js `vm` 模块或子进程执行 ESM 代码。支持 top-level await。返回 console.log 输出。设置超时（10s）和资源限制 |
| **涉及文件** | `src/tools/script.ts`（新建）、`src/tools/index.ts`（注册） |
| **验证标准** | 1. 跑一段 JSON 解析代码 → 返回正确结果。2. 跑一段正则提取代码 → 返回匹配结果。3. 死循环代码 → 10s 超时被终止 |
| **状态** | `[x]` |

### B4. read_file 增强（行号、offset/limit）

| 项目 | 内容 |
|------|------|
| **Lux 行为** | `read`：带行号输出、支持 offset（起始行）和 limit（行数）、支持 PDF 页码 |
| **RainyDays 现状** | `read_file`：读全文截断到 4000 字符。无行号、无 offset/limit |
| **问题后果** | agent 无法精确定位文件中的某一段内容。读取大文件只能看前 4000 字符，看不到后面的。无法引用行号 |
| **修复方案** | 增强 `read_file`：1. 输出带行号。2. 支持 offset（从第几行开始）和 limit（读几行）。3. 默认读前 200 行，超出提示用 offset 翻页 |
| **涉及文件** | `src/tools/filesystem.ts` |
| **验证标准** | 1. 读一个 500 行的文件 → 默认返回前 200 行带行号。2. offset=300, limit=50 → 返回 300-350 行。3. 返回末尾提示总行数 |
| **状态** | `[x]` |

### B5. get_current_time 工具

| 项目 | 内容 |
|------|------|
| **Lux 行为** | `get_current_time`：返回当前日期时间，agent 用于时间判断、时间戳、调度 |
| **RainyDays 现状** | 缺失 |
| **问题后果** | agent 不知道当前时间，无法做"今天""昨天""30天后"之类的时间判断 |
| **修复方案** | 实现 `get_current_time` 工具：返回 ISO 格式 + 本地化格式 |
| **涉及文件** | `src/tools/system.ts`（新建）、`src/tools/index.ts`（注册） |
| **验证标准** | 调用后返回正确当前时间，格式包含 ISO 和中文可读格式 |
| **状态** | `[x]` |

---

## C 类：系统缺失（完全未实现）

这些是完整的子系统，需要从零构建。按依赖顺序排列。

### C1. 子 Agent 系统

| 项目 | 内容 |
|------|------|
| **Lux 行为** | `subagent`（派遣）、`subagent_wait`（等待）、`subagent_output`（检查）、`subagent_peek`（无阻塞查看）、`subagent_post`（侧带消息）、`subagent_stop`（停止）、`subagent_list`（列出）。子 agent 独立运行，可继承父上下文 |
| **RainyDays 现状** | 完全缺失 |
| **修复方案** | 1. `SubAgent` 类：独立 memory、共享 LLM/工具、不能再 spawn 子 agent（防递归）。2. `subagent` 工具：派遣+等待结果。3. 递归深度保护 |
| **涉及文件** | `src/subagent.ts`（新建）、`src/tools/subagent-tools.ts`（新建） |
| **验证标准** | 1. 主 agent 派遣子 agent 读取文件 → 子 agent 返回结果 → 主 agent 汇总。2. 子 agent 不能再派遣子 agent |
| **状态** | `[x]` |

### C2. 定时任务系统

| 项目 | 内容 |
|------|------|
| **Lux 行为** | `cron_schedule`（创建）、`cron_list`（列出）、`cron_cancel`（取消）。支持延迟/重复/广播 |
| **RainyDays 现状** | 完全缺失 |
| **修复方案** | 1. `cron_jobs` 数据库表。2. `CronManager` 类：加载活跃 job、setTimeout/setInterval 调度、触发回调。3. 三个 cron 工具。4. 触发时 SSE 推送 |
| **涉及文件** | `src/cron.ts`（新建）、`src/tools/cron-tools.ts`（新建）、`src/db.ts` |
| **验证标准** | 1. "30秒后提醒我" → 30秒后前端收到通知。2. "每分钟检查一次" → 周期性触发。3. 重启后定时任务恢复 |
| **状态** | `[ ]` |

### C3. 事件订阅系统

| 项目 | 内容 |
|------|------|
| **Lux 行为** | `poll_subscribe`（订阅）、`poll_unsubscribe`（取消）、`poll_list`（列出）。支持 source glob、tag 过滤、防抖 |
| **RainyDays 现状** | 完全缺失 |
| **修复方案** | 1. 文件监听（chokidar 监听目录变化）。2. 事件分发器。3. 三个 poll 工具。4. 事件到达时 SSE 推送或自动唤醒 |
| **涉及文件** | `src/events.ts`（新建）、`src/tools/event-tools.ts`（新建） |
| **验证标准** | 1. 订阅 Z 盘变化 → 新建文件时 agent 收到通知。2. 取消订阅后不再收到通知 |
| **状态** | `[~]` 暂缓，后续迭代补充 |

### C4. 多 Session 通信

| 项目 | 内容 |
|------|------|
| **Lux 行为** | `link_discover`（发现）、`link_peek`（查看）、`link_wait`（等待）、`link_post`（发送）。session 之间可通信 |
| **RainyDays 现状** | 完全缺失 |
| **修复方案** | 1. Session 注册表。2. 消息队列。3. 四个 link 工具 |
| **涉及文件** | `src/link.ts`（新建） |
| **验证标准** | 一个会话能向另一个会话发送消息，对方能收到 |
| **状态** | `[~]` 暂缓，后续迭代补充 |

### C5. 知识图谱（实体/关系/巩固）

| 项目 | 内容 |
|------|------|
| **Lux 行为** | 碎片叙事（Note, t_）→ 巩固 agent → 实体（Node, n_）+ 关系（Edge, e_）。`inspect` 展开详情，`graph` 展开子图。`<knowledge>` 摘要注入 prompt |
| **RainyDays 现状** | 只有扁平的 memories 表（content + tags + embedding）。没有实体/关系/巩固 |
| **修复方案** | 1. entities 表（id/name/kind/props）。2. edges 表（src/dst/type/props）。3. 巩固逻辑：定期从 memories 提取实体和关系。4. `inspect`/`graph` 工具。5. 知识摘要注入 prompt（和 A2 统一） |
| **涉及文件** | `src/db.ts`、`src/knowledge-graph.ts`（新建）、`src/tools/knowledge-tools.ts`（新建） |
| **验证标准** | 1. remember 多条关于同一项目的记忆 → 巩固后自动提取出项目实体。2. inspect 能展开实体详情。3. graph 能看到关系子图 |
| **状态** | `[x]` |

### C6. Persona Skills 层

| 项目 | 内容 |
|------|------|
| **Lux 行为** | 每个 persona 预加载技能（如 Coding skill 有代码规范、Git 纪律、测试流程）。Skills 是"专业知识包" |
| **RainyDays 现状** | Persona 只有 system prompt + 工具列表，没有 skills 层 |
| **修复方案** | 1. persona frontmatter 加 `skills` 字段。2. skills/ 目录放技能文件。3. 加载 persona 时把 skill 内容拼入 system prompt |
| **涉及文件** | `src/persona.ts`、`personas/*.md`、`skills/`（新建目录） |
| **验证标准** | 切换到带 coding skill 的 persona → system prompt 包含代码规范内容 |
| **状态** | `[x]` |

### C7. Electron 桌面应用

| 项目 | 内容 |
|------|------|
| **Lux 行为** | Electron 桌面应用，系统托盘，单实例锁，打包成 .exe |
| **RainyDays 现状** | Web 页面（浏览器访问 localhost:3111） |
| **修复方案** | 1. electron/main.ts 主进程。2. electron/preload.ts。3. 系统托盘。4. electron-builder 打包 |
| **涉及文件** | `electron/`（新建目录）、`package.json` |
| **验证标准** | 双击图标启动桌面应用，不需要浏览器，最小化到系统托盘 |
| **状态** | `[x]` |

---

## 修复执行顺序

```
第一阶段：A 类基础缺陷（让地基稳固）
  A1 上下文压缩改为 LLM 摘要
  A2 知识自动注入 prompt
  A3 任务系统驱动执行流
  A4 LLM 调用重试/超时
  A5 工具结果摘要压缩（和 A1 统一实现）

第二阶段：B 类核心工具（让 agent 有能力干活）
  B1 edit 工具
  B2 grep 工具
  B3 script 工具
  B4 read_file 增强
  B5 get_current_time 工具

第三阶段：C 类新系统（从零构建）
  C1 子 Agent 系统
  C2 定时任务系统
  C3 事件订阅系统
  C4 多 Session 通信
  C5 知识图谱
  C6 Persona Skills 层
  C7 Electron 桌面应用
```

---

## 附：工程可靠性补充（贯穿所有阶段）

| 项目 | 优先级 | 说明 |
|------|--------|------|
| 工具执行超时 | 高 | 除 execute_command 外的工具也需要超时保护 |
| 优雅关闭 | 中 | 清理定时器、关闭数据库连接、保存状态 |
| 结构化日志 | 中 | 替换 console.log，带时间戳和级别 |
| Markdown 渲染 | 中 | 前端消息支持 Markdown 渲染和代码高亮 |
| 错误边界 | 中 | agent 循环中的 try-catch 完善，错误不外泄给用户 |
