# RainyDays 100% 复刻 Lux Desktop 总执行规范

> 文档状态：**后续实施唯一执行基准（Canonical Execution Spec）**  
> 目标基线：**Lux Desktop v0.1.898**  
> 项目：`F:\rainydays`
> 制定日期：2026-07-15  
> 适用范围：架构、开发、测试、安全、桌面、生态、发布和长期维护  
> 旧文档：`GAP-ANALYSIS.md` 仅作历史参考，不再作为完成度判据

---

## 0. 文档使命

本规范把 2026-07-15 全面审计发现的每一类差距转换为可执行任务。后续不得再以“文件存在”“工具注册”“名称相同”“开发环境跑过一次”作为完成依据。

最终目标不是做一个模仿 Lux 的部门助手，而是：

1. 全量复刻 Lux Desktop v0.1.898 的行为、边界、桌面体验、自治能力、扩展生态和发布能力；
2. Z 盘仅作为广电政企服务部 Persona、Skill 和知识内容源之一；
3. Session 可以工作于任意经授权的本地目录、网络目录或 Lux Worker；
4. Persona 内容来源、工作区和文件授权彼此独立；
5. 所有“完成”都必须有契约、真实环境、负向场景、恢复场景和正式安装包证据。

---

## 1. 不可协商原则

### 1.1 100% 复刻口径

- 以 Lux Desktop v0.1.898 锁定基线，不以旧 Help、旧差距表或印象作为真相。
- 同名不等价不计完成；占位实现按未完成处理。
- 开发态可用但正式安装包不可用，不计完成。
- 正常路径通过但权限、错误、取消、恢复或重启语义不同，不计完成。
- 缺少自动化回归和证据包，不得标记 completed。
- 任何 P0/P1 未关闭时，不得宣称“100%复刻完成”或“可正式发布”。

### 1.2 通用性铁律

任何改动必须同时满足：

1. 解决当前审计问题；
2. 形成可复用、可配置、与具体 Z 盘目录或单一测试数据无关的通用能力。

禁止为了通过单个测试而：

- 硬编码文件名、目录、Persona、模型、端口或平台；
- 降低递归深度、静默截断结果或绕开慢路径；
- 给特定测试输入增加专门分支；
- 在工具执行器中通过拦截命令“教模型选工具”；
- 用固定字符串或假后端模拟 Lux 能力。

### 1.3 先理解再修改

每个任务开始前必须：

1. 切换到规定 Persona；
2. 读取任务卡指定文件；
3. 读取调用点、测试和相邻状态模型；
4. 确认 Lux v0.1.898 的对应契约；
5. 创建可追踪任务；
6. 才能修改代码。

### 1.4 Z 盘边界

Z 盘的目标角色是 `DepartmentContentProvider`，不是全局工作区：

```text
Lux Runtime
├─ Session Workspace：任意本地/网络/Worker 工作目录
├─ Persona/Skill Catalog
│  ├─ Lux 内建
│  ├─ 用户自定义
│  ├─ Prism 下发
│  └─ Z盘广电政企内容源
└─ Capability Policy：每个 Session 独立授权
```

验收必须证明：

- Z 盘断开时，RainyDays 核心功能仍正常；
- 加载 Z 盘 Persona 不会自动授予整个 Z 盘读写权；
- 非 Z 盘项目可以完整使用 Agent、终端、浏览器、MCP 和文件工具；
- 同一 Persona 可以服务不同工作区；同一工作区可以切换不同 Persona。

---

## 2. 状态、优先级和完成定义

### 2.1 状态

| 状态 | 定义 |
|---|---|
| `pending` | 尚未开始 |
| `in_progress` | 正在探索、设计或实现 |
| `implemented` | 代码完成，但尚未通过全部门禁 |
| `verified` | 自动化和真实环境证据全部通过，等待用户核实 |
| `completed` | 用户确认或总验收批准 |
| `blocked` | 前置依赖、外部服务或安全条件未满足 |

未经用户核实，不得从 `verified` 自行提升为 `completed`。

### 2.2 优先级

| 级别 | 定义 |
|---|---|
| P0 | 安全、数据隔离、核心运行时或全局架构阻断 |
| P1 | Lux 主流程或关键语义不兼容 |
| P2 | 能使用但可靠性、体验或高级契约不足 |
| P3 | 版本、文案、视觉和发布卫生问题 |

### 2.3 Definition of Done

每个任务必须全部满足：

- [ ] 与 Lux v0.1.898 的名称、Schema、默认值、结果和错误语义对齐；
- [ ] 实现位于通用架构层，不含场景特化；
- [ ] TypeScript 编译、lint 和相关静态检查零错误；
- [ ] 单元、集成、契约和适用的 Electron E2E 全部通过；
- [ ] 在真实 Provider、真实文件系统或真实目标服务中验证，不只使用 mock；
- [ ] 三个不同正常场景连续通过；
- [ ] 至少一个错误输入、一个取消/超时、一个重启/恢复场景通过；
- [ ] P0/P1 任务包含攻击性或竞态测试；
- [ ] 正式打包版本重复验证，不只验证源码运行；
- [ ] 报告耗时、工具调用数、错误数、资源变化和测试次数；
- [ ] Reviewer 独立复核，无“同名占位”或静默降级；
- [ ] 实际数据提交给用户，状态停留在 `verified` 等待核实。

---

## 3. Persona 执行规则

### 3.1 任务与 Persona 对应

| 工作阶段 | 必须使用的 Persona | 职责 |
|---|---|---|
| 新模块探索、行为取证 | `explorer` | 只读理解源码、Lux Help、调用点和现有测试 |
| 架构、协议、状态模型 | `architect` | 冻结边界、依赖、数据模型、失败语义和迁移方案 |
| 一般功能实现 | `developer` | 按冻结设计实现，不扩大范围 |
| 小型确定性修复 | `quick-fix` | 仅用于边界清晰、低风险、少量文件修复 |
| 并发、崩溃、PTY、网络恢复 | `debugger` | 故障复现、根因定位、故障注入和恢复验证 |
| 权限、安全、供应链 | `sentinel` 或 `reviewer` | 威胁建模、攻击性测试和发布阻断判定 |
| 最终代码审查与差距复核 | `reviewer` | 独立检查契约、回归、安全和是否存在表面实现 |
| 测试计划与阶段编排 | `planner` | 拆任务、依赖和资源，不代替技术设计 |
| 文档和运维手册 | `writer` | 在实现稳定后整理用户和运维文档 |

### 3.2 强制切换流程

每个实施批次按以下顺序执行：

```text
explorer 取证
→ architect 冻结设计
→ developer 实现
→ debugger 做负向/恢复/竞态验证
→ reviewer 独立门禁
→ 用户核实
```

规则：

1. 开始新阶段、任务类型变化或进入审查时必须显式调用 `switch_persona`；
2. Persona 切换记录写入任务元数据和测试报告；
3. 实现者不得以自己的自测替代 Reviewer；
4. Reviewer 发现架构问题时回退到 architect，不得在审查阶段顺手重构；
5. 安全 P0 必须有 sentinel/reviewer 签字；
6. 长批次允许子 Agent 并行探索，但写入任务只能有一个明确 owner；
7. 子 Agent 必须使用与子任务匹配的 Persona，不得默认继承高权限。

---

## 4. Canvas 与上下文压缩规划

### 4.1 上下文分层

| 层 | 内容 | 保存方式 |
|---|---|---|
| L0 永久准则 | 本文档路径、100%目标、Z盘边界、两大铁律、Persona规则 | 长期记忆 `remember` |
| L1 项目基线 | Lux manifest、架构决策、迁移版本、阶段状态 | 项目文件 + Oracle/任务元数据 |
| L2 当前批次 | 任务 ID、依赖、修改文件、测试矩阵、未决风险 | Canvas + task system |
| L3 临时证据 | 工具原始输出、编译日志、截图、网络响应 | 当前 Canvas/测试 artifact |

### 4.2 压缩时机

必须在以下节点主动压缩，而不是等上下文失控：

1. 探索阶段完成、进入设计前；
2. 设计冻结、进入实现前；
3. 单批次工具调用达到约 25 次；
4. Canvas 估算达到约 60%–65%；
5. 开始长构建、安装包或大规模 E2E 前；
6. 一个任务从 implemented 进入 verified 前；
7. 切换到下一阶段前。

### 4.3 压缩保留模板

每次 `curate` 必须要求保留：

```text
- 当前目标与 Lux 基线版本
- 当前任务 ID、Persona、状态、owner 和依赖
- 已读文件与准确行号
- 已修改文件和关键 diff
- 冻结的架构决策及原因
- 当前失败现象、错误原文和复现步骤
- 已运行测试、次数、耗时、结果和未覆盖项
- 安全/数据迁移风险
- 下一步唯一动作
```

不得依赖摘要保存以下信息：

- 即将编辑的源代码原文；
- 尚未解决的错误堆栈；
- 数据库迁移 SQL；
- 安全策略条件；
- 外部协议 Schema。

这些内容在修改前必须重新 `read`，不能凭压缩摘要或记忆猜测。

### 4.4 批次结束记忆规则

只把稳定知识写入长期记忆：

- 架构决策；
- 用户确认的行为；
- 通用踩坑教训；
- 已通过门禁的里程碑；
- 仍然有效的阻断项。

不写入长期记忆：临时日志、一次性测试数据、中间猜测、未验证结论。

---

## 5. 严格测试铁律

### 5.1 原有铁律继续生效

1. 不允许“跑一遍通过就标完成”；
2. 每项改动至少三个不同正常场景连续通过；
3. 必须故意传错路径、参数或制造依赖失败，验证恢复；
4. 简单 Agent 任务目标不超过 5 次工具调用，复杂任务目标不超过 15 次；超出必须解释；
5. 报告实际工具调用数、耗时、错误数，不以主观描述代替数据；
6. 不得用过拟合测试的代码让测试通过；
7. 工具选择通过清晰 Schema、描述和 Persona 引导，不在执行器里拦截一种工具去强迫模型使用另一种；
8. 必须在真实环境运行修改后的 Agent，而不只测试底层函数。

### 5.2 新增100%复刻门禁

每项功能采用五层测试：

| 层级 | 要求 |
|---|---|
| Unit | 边界算法、Schema、状态转换、权限和错误分类 |
| Contract | 与 Lux v0.1.898 工具/UI/协议基线逐字段对比 |
| Integration | SQLite、Provider、文件系统、PTY、MCP、Worker 等真实集成 |
| Electron E2E | 正式桌面工作流、Tab、通知、附件、快捷键和重启恢复 |
| Packaged E2E | 安装后的 `.exe`/对应平台产物中重复关键用例 |

P0/P1 还必须增加：

- 安全攻击测试；
- 并发与竞态测试；
- 断网、超时、进程崩溃、磁盘满和重启恢复；
- 跨 Session、跨 Persona、跨 Workspace 隔离；
- 失败无副作用和幂等性验证。

### 5.3 测试证据格式

每个任务生成统一报告：

```text
Task ID / Lux baseline / Persona chain
Changed files / migration / configuration
Normal scenarios: input, expected, actual, duration
Negative scenarios: injected fault, expected rejection/recovery, actual
Concurrency/restart/package scenarios
Tool calls / LLM calls / tokens / duration / peak memory
Automated test command and exact result
Packaged app result
Known limitations
Reviewer verdict: pass / request changes
User status: pending verification / accepted
```

---

## 6. 目标架构与阶段依赖

```text
P0 契约基线 + 安全底座 + 测试门禁
        │
        ▼
P1 SessionRuntime + Canvas + Workspace + EventBus
        │
        ├──────────────┐
        ▼              ▼
P2 Desktop Workbench   P3 MCP/Worker/Link/Oracle/Playbook
        │              │
        └──────┬───────┘
               ▼
P4 Browser/Prism/Anima/Media/Enterprise/Trusted Release
```

禁止绕过依赖：

- 未完成 SessionRuntime，不实现真实 Link、Cron wake、Daemon Session 或 Playbook child flow；
- 未完成 CapabilityBroker，不开放 MCP、Worker、Shell 或企业写工具；
- 未完成统一 Tab/Pane，不继续堆叠独立覆盖式 File/Terminal/Browser UI；
- 未完成契约测试，不把新增同名工具计入完成度。

## 7. P0：基线、安全和工程门禁

### GOV-01　Lux v0.1.898 机器可读基线

- **审计对应**：工具总量不明、Help 与运行时漂移、旧 `GAP-ANALYSIS.md` 基于 v0.1.887。
- **目标**：建立 versioned manifest，锁定工具 Schema、Persona、Skill、Settings、Session、快捷键和桌面能力。
- **主要范围**：新增 `parity/` 基线目录、manifest 生成器、diff reporter；旧差距表标记历史。
- **依赖**：无。
- **Persona**：explorer → architect → developer → reviewer。
- **验收**：同名 Schema 变化、工具增删、默认值变化和 Help 漂移会在 CI 明确失败；报告可追溯到 Lux 版本。
- **负向测试**：故意删除工具、改变必填字段、篡改默认值，diff 必须失败且指出字段路径。
- **证据**：manifest hash、diff 报告、生成命令、Reviewer verdict。

### GOV-02　版本与追踪模型

- **审计对应**：应用 `0.1.0`、UI `v1.0`、导出 `1.0` 混用；无 app/schema/export/protocol 版本。
- **目标**：分别管理 app、database schema、session export、MCP/Worker/Link protocol 和 baseline 版本。
- **范围**：`package.json`、构建元数据、About、API status、DB migration、导入导出。
- **依赖**：GOV-01。
- **Persona**：architect → developer → reviewer。
- **验收**：UI、安装器、日志、诊断包和 API 显示同一 build ID；不兼容版本被显式拒绝或迁移。

### GOV-03　测试框架与契约测试

- **审计对应**：无 test/spec/e2e、无 `npm test`，现有完成项不能证明行为。
- **目标**：建立 unit、contract、integration、Electron E2E、packaged E2E 五层测试。
- **范围**：测试目录、fixture、Lux contract runner、覆盖率和统一报告器。
- **依赖**：GOV-01。
- **Persona**：planner → architect → developer → debugger → reviewer。
- **验收**：每个后续任务必须能挂接测试；核心安全 branch coverage ≥90%，总体 line coverage 初始门槛≥80%。
- **负向测试**：让断言、fixture 或 packaged smoke 故意失败，CI 必须阻断。

### GOV-04　CI/CD 最小强制门禁

- **审计对应**：无 CI；正式依赖安装使用 `--no-audit`；未验证安装包行为。
- **目标**：clean install → typecheck → lint → tests → SCA/secret scan → package → signature check → packaged smoke。
- **依赖**：GOV-03。
- **Persona**：architect → developer → sentinel/reviewer。
- **验收**：任一 P0/P1、安全扫描、契约或打包测试失败即停止发布；保留 artifacts 和报告。

### SEC-01　不可绕过的 CapabilityBroker

- **审计对应**：Persona 只过滤展示给模型的定义；执行器可执行任意全局工具；Supervisor fail-open。
- **目标**：每次工具执行携带不可变 `CapabilityContext`：session、persona/version、allowed tools/roots、network policy、risk class、approval grant。
- **范围**：`src/agent.ts`、`src/tools/index.ts`、`src/persona.ts`、`src/supervisor.ts`、动态工具注册和所有直接高危 API。
- **依赖**：GOV-03。
- **Persona**：architect → sentinel → developer → debugger → reviewer。
- **验收**：执行点二次校验；未声明、旧 Persona、跨 Session、伪造动态工具均 fail-closed；子 Agent/Playbook 不得越权父上下文。
- **攻击测试**：恶意 Provider 伪造 `script`/shell；Agent 尝试关闭 Supervisor；并行调用混入未授权工具；全部零副作用。

### SEC-02　统一 PathPolicy

- **审计对应**：Agent 文件工具接受任意绝对路径；`isPathAllowed` 未使用；写入可被盘符、UNC、junction 绕过。
- **目标**：所有文件、下载、Oracle、Persona、Playbook、Office 输出、Terminal/Script CWD 统一 canonical path policy。
- **范围**：抽取/复用 `src/file-viewer.ts` 的正确模式；改造 `src/tools/filesystem.ts` 及所有路径调用点。
- **依赖**：SEC-01。
- **Persona**：architect → sentinel → developer → debugger → reviewer。
- **验收**：`path.relative + realpath`；新文件验证最近存在父目录；按 capability 接受绝对路径；越界无副作用并写审计。
- **攻击测试**：`..`、其他盘符、UNC、`\\?\`、`\\.\`、大小写、尾随点/空格、ADS、sibling-prefix、junction/symlink、TOCTOU。

### SEC-03　Shell/Script/Terminal 隔离和授权

- **审计对应**：三者以当前用户权限执行，继承全部环境和网络；Terminal API 可绕过审批；超时不保证杀进程树。
- **目标**：区分受限 `script`、Agent shell 和用户手动 PTY；统一进入 CapabilityBroker。
- **范围**：`src/tools/script.ts`、`src/tools/shell.ts`、`src/terminal.ts`、Terminal API、OS sandbox/Worker runner。
- **依赖**：SEC-01、SEC-02。
- **Persona**：architect → sentinel → developer → debugger → reviewer。
- **验收**：最小环境 allowlist、默认禁网/受控网络、允许目录、CPU/内存/进程/输出/时间限制、完整进程树终止；手动终端使用短期用户手势 grant。
- **攻击测试**：读取 Key、访问根外、外网传输、派生后台进程、超时逃逸、直接 API 调用。

### SEC-04　API Token 和本地控制面加固

- **审计对应**：Token 进入 query、URL 和日志；任意 localhost Origin；单 Token 控制终端等高危能力。
- **目标**：正式 Electron 优先使用 IPC/MessagePort；HTTP 仅保留最小受控面。
- **范围**：`src/index.ts`、`electron/main.cjs`、`electron/preload.cjs`、前端 SSE/媒体请求。
- **依赖**：SEC-01。
- **Persona**：architect → sentinel → developer → reviewer。
- **验收**：Token 不出现在 URL、query、日志、历史或崩溃报告；每次启动轮换；高危操作独立短期 grant；Origin 精确绑定。

### SEC-05　凭据安全存储与脱敏

- **审计对应**：Provider Key 明文写入 `config.json`，子进程继承环境，HTTP Provider 可传输密钥。
- **目标**：接入 Windows DPAPI/Credential Manager、macOS Keychain、Linux Secret Service；配置仅存 opaque reference。
- **范围**：`src/config.ts`、Electron safe storage、日志/导出/诊断 redaction、子进程环境。
- **依赖**：SEC-03、GOV-02。
- **Persona**：architect → sentinel → developer → reviewer。
- **验收**：旧密钥安全迁移；普通配置/备份无明文；默认只允许 HTTPS，loopback HTTP 需显式开发模式。

### SEC-06　结构化安全审计链

- **审计对应**：散落 `console.log`，无审批证据、关联 ID、脱敏和不可修改记录。
- **目标**：记录工具、文件、命令、Persona、Provider、设置、导入导出和企业写操作的请求—授权—执行—结果链。
- **范围**：`src/logger.ts`、审计表/文件、CapabilityBroker、API middleware、诊断导出。
- **依赖**：SEC-01、SEC-05、DATA-01。
- **Persona**：architect → sentinel → developer → reviewer。
- **验收**：按 session/request/tool 可重建一次高危操作；secret/PII 脱敏；Agent 无权修改或删除审计记录。

### SEC-07　Electron Renderer 加固

- **审计对应**：`sandbox:false`、CSP 允许 inline script/style、缺权限 handler 和 fuse 加固。
- **目标**：renderer sandbox、最小 preload IPC allowlist、移除 inline script、默认拒绝非必要权限。
- **范围**：`electron/main.cjs`、`electron/preload.cjs`、拆分 `public/index.html` 脚本和样式。
- **依赖**：SEC-04、DS-02。
- **Persona**：architect → sentinel → developer → reviewer。
- **验收**：CSP 无 `script-src 'unsafe-inline'`；Markdown/XSS corpus、恶意链接和导航测试通过。

### DATA-01　版本化迁移、全量备份与恢复

- **审计对应**：裸建表/`ALTER TABLE`，无 migration、升级前备份、回滚和恢复演练。
- **目标**：单调 schema version、不可变事务 migration、SQLite 一致性快照、加密备份和 restore drill。
- **范围**：`src/db.ts`、userData、Personas/Skills/Playbooks/Oracle/配置引用和长期知识。
- **依赖**：GOV-02、GOV-03、SEC-05。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：N-1/N-2 升级；中途断电、磁盘满、WAL 损坏、重复迁移可恢复；恢复后数据一致。

### DATA-02　会话导入导出契约

- **审计对应**：仅检查 `session/messages`；不验证版本、role、tool call、大小或事务完整性。
- **目标**：严格 Schema、版本迁移、大小上限、事务导入和恶意 tool call 隔离。
- **范围**：`src/session.ts`、导入 API、附件和完整 Canvas 导出。
- **依赖**：GOV-02、DATA-01、RT-03。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：畸形、超大、未知版本、孤立 tool call、半导入故障全部安全拒绝或完整回滚。

## 8. P1：每会话 Agent Runtime 与自治底座

### RT-01　SessionManager 与独立 SessionRuntime

- **审计对应**：全局单 Agent/Memory/currentSession；切换会话可串写消息和工具结果。
- **目标**：`Map<sessionId, SessionRuntime>`；每个 runtime 独立 Agent、Canvas、Persona、Capability、Tasks、Abort 和事件通道。
- **范围**：`src/index.ts`、`src/agent.ts`、`src/memory.ts`、`src/session.ts`、动态工具和 SSE/WS。
- **依赖**：SEC-01、GOV-03。
- **Persona**：explorer → architect → developer → debugger → reviewer。
- **验收**：API 显式 `sessionId`；同 Session 排队或拒绝，不同 Session 并行；8 Session×100工具调用零串扰；切换 UI 不影响后台 Run。

### RT-02　每会话 Workspace 与目标路由

- **审计对应**：只有全局 `workspaceRoot`；终端、文件、Agent 不能恢复会话自己的 CWD。
- **目标**：Session 持久化 workspaceId、cwd、target(local/worker)、allowed roots；全局设置只作为新会话默认值。
- **范围**：DB schema、Session API、Runtime、File/Terminal/Browser target、UI 新建会话流程。
- **依赖**：RT-01、SEC-02。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：两个仓库并行 `pwd/git status`；切换、重启、Persona 切换后各自 CWD 不变；Z 盘断开不影响其他会话。

### RT-03　Lux Canvas、Pin 和知识注入

- **审计对应**：有消息和摘要但无完整 Canvas 三区模型；Pin/任务/观察和 Oracle 快照语义不足。
- **目标**：定义 system/context/runtime 三层 Canvas，持久化消息、工具、Pin、Task、观察、压缩摘要和来源。
- **范围**：`src/memory.ts`、`src/db.ts`、Agent prompt builder、UI Pin、Oracle/Session export。
- **依赖**：RT-01、DATA-01。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：长对话压缩后保留关键决策、路径、错误和任务；Pin 确实进入后续 prompt；重启和 Fork 保真。

### RT-04　取消、超时与底层 Abort

- **审计对应**：无 Escape 中断；`Promise.race` 只停止等待，底层 I/O/进程可能继续。
- **目标**：Run、LLM、工具、下载、Office parser、子 Agent 和网络请求统一 `AbortSignal`。
- **范围**：`src/agent.ts`、`src/llm.ts`、`src/tools/index.ts`、各 executor、UI 中断 API。
- **依赖**：RT-01、SEC-03。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：Escape 500ms 内进入 abort 状态；进程树和网络真实停止；无半条 assistant/tool 消息；重启不重复副作用。

### RT-05　Lux 八阶段工具执行管道

- **审计对应**：缺 Schema 校验、循环检测、统一权限、路径、输出控制和结构化诊断；非法 JSON 降级 `{}`。
- **目标**：Schema → capability → loop detection → approval → path/network policy → execute → output control → audit。
- **范围**：`src/tools/index.ts`、`src/agent.ts`、所有动态工具适配器。
- **依赖**：SEC-01、SEC-02、SEC-06、RT-04。
- **Persona**：architect → developer → sentinel/debugger → reviewer。
- **验收**：错误参数执行前拒绝；tool error 与普通结果分离；重复循环熔断；所有阶段可追踪。

### RT-06　工具并行调度

- **审计对应**：一次响应中的多个独立 tool call 被强制串行。
- **目标**：根据工具元数据、依赖和副作用分类并行只读调用；写操作/审批保持有序。
- **范围**：Agent loop、Tool metadata、结果归并和取消传播。
- **依赖**：RT-05。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：并行结果按原 tool_call_id 回填；故障隔离；写读冲突不乱序；性能数据优于串行基线且结果一致。

### RT-07　Task DAG 完整复刻

- **审计对应**：只有 create/update/list；无 get/delete、blocked_by、owner、metadata 和真正调度。
- **目标**：对齐 `task_create/update/list/get/delete`，实现依赖图、owner、metadata、阻塞和循环检测。
- **范围**：`src/task.ts`、`src/tools/task-tools.ts`、DB、UI 和 Agent task driver。
- **依赖**：RT-01、RT-03、DATA-01。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：依赖未完成不能开始；循环依赖拒绝；子 Agent owner 状态可见；重启和 Fork 保真。

### RT-08　Subagent 完整生命周期

- **审计对应**：现为同步10轮函数；缺 wait/output/peek/post/stop/list 和后台并发。
- **目标**：独立 child runtime、可选 `inherit_canvas`、异步 ID、侧带消息和停止。
- **范围**：`src/subagent.ts`、`src/tools/subagent-tools.ts`、SessionManager、Link/EventBus、UI 状态。
- **依赖**：RT-01、RT-04、RT-05、RT-07。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：并行 child 不阻塞父流；post/stop/wait 可控；权限不超过父级；父结束时按策略清理。

### RT-09　Session Fork/Rollback/Regenerate/标题恢复语义

- **审计对应**：Fork 只复制消息；Rollback/Regenerate 调同一逻辑；标题仅截取首条消息；只恢复最近会话。
- **目标**：按 Lux 复制完整 Canvas/Task/Pin/Workspace/Persona；Regenerate 保留用户消息；语义标题和全部活动布局恢复。
- **范围**：`src/session.ts`、DB、Runtime、Sidebar、输入历史和草稿。
- **依赖**：RT-01、RT-02、RT-03、RT-07。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：运行中操作事务化；无孤立 tool call；标题后台生成失败可恢复；重启恢复全部活动 Session。

### EVT-01　统一 EventBus

- **审计对应**：Cron、Wire、Link、通知各自回调/SSE，无法持久投递和唤醒 Session。
- **目标**：统一事件 envelope、持久队列、ack、重试、dedupe、target 和 wake 策略。
- **范围**：新增事件模块，接入 SessionRuntime、UI、Cron/Poll/Link/Notification。
- **依赖**：RT-01、DATA-01、SEC-06。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：断线期间事件不丢；重复投递不重复副作用；按 Session 精确路由；可追踪。

### EVT-02　Cron Lux 语义

- **审计对应**：只支持单段 duration、无 target/broadcast、触发只发 SSE。
- **目标**：支持复合 duration、target、`*`、repeat、tag、持久恢复，并真正启动/注入 Session flow。
- **范围**：`src/cron.ts`、`src/tools/cron-tools.ts`、EventBus、SessionManager。
- **依赖**：EVT-01、RT-04。
- **Persona**：developer → debugger → reviewer。
- **验收**：`2h30m`、重启、取消、广播、空闲唤醒、运行中注入；重复任务无漂移或明确漂移策略。

### EVT-03　Poll/Wire 外部事件订阅

- **审计对应**：当前同名工具只是 `fs.watch(path)`；无 source glob/tag/debounce/wake。
- **目标**：实现外部 source adapter、tagFilters、persistent、debounce 和 Session wake；文件监听只是 adapter 之一。
- **范围**：替换 `src/wire.ts`、`src/tools/advanced-tools.ts` 中占位语义，接入 EventBus。
- **依赖**：EVT-01。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：文件、webhook/测试事件、source glob、tag AND、debounce、unsubscribe、重启策略均通过。

### RT-10　正式后台服务与崩溃恢复

- **审计对应**：开发 daemon 不适用于正式 Electron；服务与主进程同生共死；健康检查端口/Token 错误。
- **目标**：后端 utility/child process 独立故障域，退避重启、crash-loop safe mode、可靠 shutdown。
- **范围**：`src/daemon.ts`、`electron/main.cjs`、health endpoints、checkpoint 和恢复 UI。
- **依赖**：RT-01、EVT-01、DATA-01、REL-04。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：强杀服务、LLM 中崩溃、数据库写入中断、Terminal 运行时退出均可恢复且不重复副作用。

### RT-11　Memo/Muse 与长期自治对齐

- **审计对应**：Memo 定时字段不会实际提醒；Muse 是手动单轮，不是完整长期自治流程。
- **目标**：Memo 与 Cron/EventBus 关联；Muse 有明确 Session、任务、停止、审计和资源上限。
- **范围**：memory/memo tools、EventBus、SessionRuntime、UI。
- **依赖**：EVT-01、EVT-02、RT-07。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：提醒真实触发并定位会话；Muse 中断、重启和资源限制行为明确。

## 9. P2：Lux Desktop 工作台

### DS-01　Electron 主进程生命周期

- **审计对应**：基础单实例/托盘可用；缺窗口状态、多显示器恢复、菜单、深链和完整进程事件。
- **目标**：保存 bounds/maximized/fullscreen；处理 display 变化、renderer/service crash、单实例参数和安全退出。
- **范围**：`electron/main.cjs`、window state store、diagnostics。
- **依赖**：RT-10、DATA-01。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：多显示器拔插后窗口可达；退出等待 DB/WAL/日志/进程树；第二实例正确聚焦并处理参数。

### DS-02　最小安全 Preload/IPC 桥

- **审计对应**：preload 只暴露两个标量；原生选择器、通知点击、更新、窗口和权限缺失。
- **目标**：typed IPC allowlist，覆盖目录/文件对话框、窗口、通知、更新、平台能力和用户手势 grant。
- **范围**：`electron/preload.cjs`、`electron/main.cjs`、renderer API adapter。
- **依赖**：SEC-04。
- **Persona**：architect → sentinel → developer → reviewer。
- **验收**：参数与 sender/origin 校验；未列 IPC 不可调用；renderer compromise 不能直接获得 Shell 权限。

### DS-03　统一 Tab/Pane 工作台

- **审计对应**：当前是单聊天区、底部终端抽屉和右侧文件覆盖层；无分屏和布局恢复。
- **目标**：Session/Terminal/File/Browser/Prism 统一 Tab；拖拽、重排、递归横纵分屏和持久布局。
- **范围**：前端状态模型和组件化重构、DB/layout store、快捷键。
- **依赖**：RT-01、RT-02、DS-02。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：Tab 跨 Pane 移动、关闭/恢复、重启布局、后台运行状态准确；不同类型可同时可见。

### DS-04　真实 PTY/ConPTY 终端

- **审计对应**：当前普通 pipe 不是 PTY；缺 ANSI、resize、逐字符和交互应用。
- **目标**：Windows ConPTY、macOS/Linux PTY，xterm-compatible renderer，统一 Lux bash/session 工具。
- **范围**：替换 `src/terminal.ts`、terminal tools、前端终端组件、进程树管理。
- **依赖**：SEC-03、RT-01、DS-03。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：vim、PSReadLine、Node/Python REPL、npm prompt、Ctrl+C/D、resize、truecolor、alternate screen；8 PTY 并行零错配。

### DS-05　附件、粘贴与拖放

- **审计对应**：聊天仅字符串；无图片/文件粘贴、拖放、上传和附件消息模型。
- **目标**：Ctrl+V 图片、Alt+V 文件、多附件、拖放、上传进度/取消、草稿恢复和结构化视觉输入。
- **范围**：Canvas/DB、临时 artifact store、IPC/API、输入 UI、Provider message adapter。
- **依赖**：RT-03、DS-02、SEC-02、DATA-01。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：附件按 Session 隔离；超大/冲突/取消/失败有状态；重启可恢复；视觉模型收到 image input 而非路径文本。

### DS-06　完整 File Tab 与编辑器

- **审计对应**：现有查看器只覆盖文本/Markdown/Office/图片/PDF，缺编辑、HTML、视频、自动刷新和虚拟化。
- **目标**：Code/Markdown/HTML/PDF/Office/Image/Audio/Video 的统一 File Tab。
- **范围**：`src/file-viewer.ts`、File service/API、Editor/Preview UI、watcher、save conflict。
- **依赖**：DS-03、SEC-02、EVT-03。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：源码/预览切换、受限 HTML sandbox、外部修改冲突、大文件虚拟化、媒体 Range 和正式包离线可用。

### DS-07　快捷键、输入历史和中断

- **审计对应**：缺 Escape abort、Shift/Alt 工作台快捷键、完整输入历史和平台映射。
- **目标**：对齐 Lux 快捷键，建立上下文优先级和可配置映射。
- **范围**：renderer keyboard manager、RT-04、Tab/Pane、附件、ASR、Terminal。
- **依赖**：DS-03、RT-04、DS-05。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：输入编辑不被误拦截；Escape 正确中断；macOS Command 映射；冲突和焦点场景 E2E。

### DS-08　通知、Tray 和会话定位

- **审计对应**：notification/link/cron 事件未完整消费；Tray 只有显示/退出；点击不能定位 Session。
- **目标**：统一后台状态、未读/运行/错误计数、持久通知和点击导航。
- **范围**：EventBus、Electron Notification/Tray、Session/Tab router。
- **依赖**：EVT-01、DS-01、DS-03。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：隐藏、最小化、锁屏和断线后事件不丢；点击打开正确 Session/Tab；Tray 状态实时准确。

### DS-09　完整 Settings 框架

- **审计对应**：只有路径和 Provider；缺 MCP/Wire/Anima/Nous/TTS/ASR/Shell/Relay/Update。
- **目标**：按 Lux 设置域建立 typed schema、校验、即时/重启语义、导入导出和原生目录选择。
- **范围**：`src/config.ts`、Settings UI、OS credential references、各子系统 adapters。
- **依赖**：DS-02、SEC-05、GOV-02。
- **Persona**：architect → developer → reviewer。
- **验收**：所有目标设置页与基线 manifest 对齐；敏感字段不回显；错误配置不破坏现有运行时。

### DS-10　无障碍与可用性门禁

- **审计对应**：不可聚焦 div、缺 dialog/tab 语义、focus trap、aria-live 和 reduced motion。
- **目标**：WCAG 2.1 AA 级键盘和屏幕阅读器可用性。
- **范围**：全部 renderer 组件、主题、缩放、动画和测试。
- **依赖**：DS-03、DS-05、DS-06、DS-09。
- **Persona**：developer → reviewer。
- **验收**：axe Critical/Serious=0；键盘-only 完成主流程；Narrator/NVDA/VoiceOver、200%/400%缩放、高对比度通过。

## 10. P3：工具契约与控制平面

### TOOL-01　Lux Body Tool 与统一工具协议

- **审计对应**：RainyDays 仅支持 OpenAI JSON function；Lux body tools 支持 org-mode block。
- **目标**：工具定义同时描述 schema、body mode、权限、side-effect、host-bound、并行性和超时。
- **依赖**：GOV-01、RT-05。
- **Persona**：architect → developer → reviewer。
- **验收**：write/edit/bash/script 的 org-mode 原始文本不被转义破坏；JSON 与 body 两种调用错误语义一致。

### TOOL-02　文件工具名称与完整契约

- **审计对应**：名称为 `read_file/write_file/...`；缺 Lux `read/write/edit/glob/grep/replace` 完整参数。
- **目标**：实现 Lux 同名 Schema、分页、PDF pages、grep modes/context、多行、replace_all；旧名称仅兼容别名。
- **范围**：`src/tools/filesystem.ts`、parsers、registry。
- **依赖**：SEC-02、RT-05、TOOL-01。
- **Persona**：developer → debugger → reviewer。
- **验收**：逐字段 contract test；图片/PDF/文本/大文件；唯一替换、无匹配、多匹配和二进制边界。

### TOOL-03　`bash`/持久 Session 契约

- **审计对应**：`execute_command` 和 `shell_*` 命名/参数不同，固定 Windows shell。
- **目标**：对齐 `bash/bash_output/bash_list/bash_kill`，支持 shell override、cwd、env、session、description 和 remote target。
- **依赖**：DS-04、SEC-03、ECO-03。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：一次性/持久语义、历史 tail、状态、进程树和 Worker 路由契约一致。

### TOOL-04　`script` 完整契约

- **审计对应**：固定 Node/10秒/4000字，无 lang/cwd/timeout、Python 和 `lux.*` bridge；安全语义错误。
- **目标**：在 SEC-03 隔离 runner 上实现 Node ESM、可选 Python、cwd/timeout 和受控 bridge。
- **依赖**：SEC-03、TOOL-01、RT-05。
- **Persona**：architect → developer → sentinel/debugger → reviewer。
- **验收**：JSON、正则、文件受控访问、timeout、输出上限和 bridge contract；不能逃逸沙箱。

### TOOL-05　Fetch/Readability 与搜索

- **审计对应**：正则剥 HTML，固定截断；DuckDuckGo HTML 解析不稳定。
- **目标**：`fetch_markdown` 的 Readability/raw/max_length/timeout/content-type；搜索 provider adapter 和来源结构。
- **依赖**：RT-04、SEC-01。
- **Persona**：developer → debugger → reviewer。
- **验收**：文章、JSON、登录失败、重定向、超时、超大响应、恶意 HTML；来源 URL 可追踪。

### TOOL-06　流式/后台 Download

- **审计对应**：响应整体进内存；无断点、后台、wait/status/cancel。
- **目标**：Range、流式落盘、任务 ID、进度、续传、取消、校验和和安全文件名。
- **依赖**：SEC-02、RT-04、EVT-01。
- **Persona**：developer → debugger → reviewer。
- **验收**：大文件内存稳定；断网续传；取消无残缺伪成功；重启状态明确。

### TOOL-07　`read_repo` 真实层级

- **审计对应**：`full` 静默限制50文件×2000字符；缺 signatures/all。
- **目标**：对齐 summary/tree/headers/signatures/full/all、Git tracked、include/exclude 和显式预算。
- **依赖**：SEC-02、RT-03。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：不得把截断称为 full；预算/分页明确；大型仓库性能和取消通过。

### TOOL-08　动态 `search_tools`

- **审计对应**：只能搜索本地58个 registry 工具，不能发现隐藏 MCP/Prism/Worker 工具。
- **目标**：统一 ToolCatalog，支持内建、MCP、Prism、Worker、Session 临时工具和热更新。
- **依赖**：RT-05、ECO-01、ECO-02、ECO-03。
- **Persona**：architect → developer → reviewer。
- **验收**：动态加入/移除后立即可搜索；返回完整 schema、来源、权限和状态；不可调用的工具不伪装可用。

### PERS-01　完整 Persona 权限与运行时工具

- **审计对应**：本地文件加载可用，但缺权限等级、switch/list/current/find、升权确认和 Infrastructure rules。
- **目标**：对齐内建 Persona、minimal/read_only/coding/guarded/full、allow/deny、Agent 管理工具和 Session 持久化。
- **依赖**：SEC-01、RT-01、GOV-01。
- **Persona**：architect → developer → sentinel/reviewer。
- **验收**：低到高权限需用户确认；只读 Persona 无法通过别名/动态工具写入；切换不影响其他 Session。

### PERS-02　Skill Overlay 与内容提供器

- **审计对应**：Skill 文件拼接可用；缺 load/unload/import、Session overlay、变量绑定、Watcher 和完整内建清单。
- **目标**：内建/用户/Prism/Z盘内容源统一 Catalog，来源和优先级清晰，Z盘不等于授权根。
- **依赖**：PERS-01、EVT-03、ECO-02。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：热加载/卸载、同名覆盖、断线、坏文件隔离、变量绑定、保存 Persona 不重复展开 Skill。

### ECO-01　MCP Client 与管理器

- **审计对应**：MCP 全缺失。
- **目标**：stdio/HTTP/SSE transport、initialize/listTools/callTool、resource 物化、重连、过滤、冲突命名和 Settings 热重载。
- **依赖**：SEC-01、RT-05、TOOL-08、DS-09。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：三 transport 协议测试；多 Server 同名不覆盖；Resource 受控临时文件；断线不产生假成功。

### ECO-02　Prism Managed Mode

- **审计对应**：Hub、CR Key、managed profiles、企业内容同步和 Prism panel 全缺失。
- **目标**：onboard、凭据、Hub reconnect、managed/local profile 共存、Persona/Skill/Anima 同步、iframe 单例面板。
- **依赖**：ECO-01、DS-03、DS-09、SEC-05。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：首次扫码/跳过、凭据失效、离线回退、模块 online/degraded/offline、面板 open/focus/close。

### ECO-03　Lux Worker

- **审计对应**：attach/detach、host-bound 路由、SSH/relay、fail-closed 和传输全缺失。
- **目标**：独立 Worker artifact；read/glob/grep/bash/write/edit/script/read_repo 精确远端路由。
- **依赖**：SEC-01、SEC-02、RT-05、TOOL-03。
- **Persona**：architect → developer → debugger → sentinel/reviewer。
- **验收**：access code/SSH、target switch、upload/download；远端断开绝不回落本机；跨平台 Worker smoke。

### ECO-04　Link 完整复刻

- **审计对应**：registry 未接入 Session；discover 空、peek/post 占位；wait/config/cluster/chatroom 缺失。
- **目标**：local/cluster discover、peek scopes/turn、post 空闲启动/运行注入、abort/alert/broadcast、wait/cancel、Chatroom。
- **依赖**：RT-01、RT-08、EVT-01、ECO-02。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：双 Session 和跨实例 E2E；运行中注入不中断；消息持久化；权限和附件正确。

### ECO-05　Oracle Canvas 子流

- **审计对应**：现有 Oracle 是全局目录树+文件头，不是项目 Canvas 快照和只读 child flow。
- **目标**：项目根 `LUX.oracle`、完整 Canvas/Pins 快照、只读 child Session、独立 profile、stale 检测和递归保护。
- **依赖**：RT-03、RT-08、SEC-02、DATA-01。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：多项目不串快照；缺文件结构化 OracleError；child 无写权限；格式/version 可迁移。

### ECO-06　npm ESM Playbook

- **审计对应**：当前 JSON prompt 步骤不是 Lux Playbook；无 runner、artifact、persist、child sessions 和单例。
- **目标**：独立 npm 项目、`playbook.mjs`、`lux.done`、agent/parallel/pipeline、logs/artifacts/persist、archive 生命周期。
- **依赖**：RT-08、RT-05、DATA-01、SEC-01。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：同 ID 单例；状态重启可查；abort 终止 child；运行中拒绝删除/归档；artifact 可预览。

### ECO-07　Routine

- **审计对应**：完全缺失。
- **目标**：npm Routine 项目、search/get/create/delete/run、input/output JSON Schema、timeout 和 `lux.done`。
- **依赖**：RT-05、DATA-01、SEC-01。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：输入输出执行前后强校验；有限执行；错误作为 tool error；运行中禁止删除。

## 11. P4：浏览器、媒体、Anima 与企业生态

### ECO-08　Browser CDP/Extension 双后端

- **审计对应**：全部 `browser_*` 缺失，Electron BrowserWindow 不能替代 Agent 浏览器。
- **目标**：连接/启动/关闭、tabs、snapshot、click/fill/type/press/scroll、screenshot/eval/back/forward/fetch。
- **依赖**：RT-01、DS-03、SEC-01、RT-04。
- **Persona**：architect → developer → debugger → sentinel/reviewer。
- **验收**：CDP 与 Extension 双后端；登录态、多 Tab、SPA、modal、iframe、ref 失效、安全 eval、会话隔离。

### ECO-09　Windows/跨平台 Desktop Automation

- **审计对应**：desktop screenshot/windows/snapshot/click/type/press/scroll/focus 缺失。
- **目标**：Windows UIA 起步，并形成平台 adapter。
- **依赖**：SEC-01、RT-04、REL-06。
- **Persona**：architect → developer → debugger → sentinel/reviewer。
- **验收**：多显示器、DPI、窗口移动、权限错误、坐标/ref 操作和敏感窗口策略通过。

### ECO-10　企业 MCP/Prism 集成集

- **审计对应**：Board、ERP、钉钉、iLink、CRM、供应商、小工单、专利、Tavily/上位AI 全缺失。
- **目标**：优先通过 MCP/Prism 动态加载相同 Server，不在 Desktop 硬编码业务逻辑。
- **依赖**：ECO-01、ECO-02、SEC-06、DS-09。
- **Persona**：architect → developer → sentinel/debugger → reviewer。
- **验收**：逐工具同名/Schema；read/write visibility、身份、组织/项目范围、幂等、审计、staleness 和上游最终校验一致。
- **企业写测试**：越权、重复提交、缓存过期、上游拒绝、附件过大、凭据失效和网络中断。

### MEDIA-01　Provider 化 ASR/TTS

- **审计对应**：现为浏览器 Web Speech，占位且固定语言；无 `read_tts`。
- **目标**：ASR/TTS profiles、Prism relay、按住 Alt、热词/替换词、voice/rate/auto-speak、长文本队列。
- **依赖**：DS-07、DS-09、ECO-02、SEC-05。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：权限拒绝、录音取消、断网、Session 切换、长回复、主动朗读和正式包麦克风权限。

### MEDIA-02　Anima 与隔离存储

- **审计对应**：无 Anima identity、独立记忆/会话、默认选择和 Prompt 映射。
- **目标**：每 Anima 独立身份、memory/session namespace、Persona 映射、创建/删除/默认、Prism 同步。
- **依赖**：RT-01、RT-03、PERS-01、ECO-02、DATA-01。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：不同 Anima 的记忆、会话、附件和 Emote 零串扰；删除/迁移安全；Tab 显示准确。

### MEDIA-03　Emote 与 HUD/Mascot

- **审计对应**：`mascot_notify` 只是系统通知；无 Emote、透明窗口、状态动画和快速输入。
- **目标**：独立 HUD/Mascot 窗口，idle/thinking/tool/waiting/completed/error 状态、气泡和 overseer 输入。
- **依赖**：MEDIA-02、DS-01、DS-08、EVT-01。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：点击穿透、多显示器/DPI、状态同步、主窗口隐藏/退出行为、断线降级和 Emote 安全渲染。

### MEDIA-04　图像生成/编辑、视频与 Artifact

- **审计对应**：`image_helper` 仅分析且无独立 VLM profile；图像生成/编辑和视频全缺失。
- **目标**：vision/image/video profiles、参考图、异步任务、取消、artifact metadata、内联历史恢复。
- **依赖**：DS-05、DS-06、DS-09、RT-04、SEC-02。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：模型能力检测、大小/MIME、text-to-image、image edit、video polling/cancel、生成文件持久化和历史恢复。

## 12. P4：可信发布、运维与多平台

### REL-01　代码签名与发布身份

- **审计对应**：安装包 Authenticode `NotSigned`，配置关闭签名。
- **目标**：Windows EXE/安装器/卸载器签名和 RFC3161 时间戳；macOS 对应签名/公证。
- **依赖**：GOV-04。
- **Persona**：architect → developer → sentinel/reviewer。
- **验收**：CI 验证 Publisher、证书链、时间戳和 hash；无签名 artifact 不得发布。

### REL-02　可信自动更新与回滚

- **审计对应**：无 updater、签名 manifest、防降级、渠道和失败回滚。
- **目标**：stable/beta/dev channel、签名 metadata、hash、版本/架构校验、防重放/降级、断电回滚。
- **依赖**：REL-01、GOV-02、DATA-01、DS-09。
- **Persona**：architect → developer → debugger → sentinel/reviewer。
- **验收**：篡改包、错误签名者、旧 manifest、降级和断网均安全拒绝；升级失败恢复旧版数据。

### REL-03　崩溃恢复与安全模式

- **审计对应**：正式包无独立服务监督、crash-loop、safe mode、完整性检查和恢复 UI。
- **目标**：主进程、renderer、service、native module 分级恢复；副作用去重。
- **依赖**：RT-10、DATA-01、REL-04。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：主/渲染/服务/native crash 故障注入；crash-loop 进入 safe mode；诊断脱敏。

### REL-04　可观测性与诊断包

- **审计对应**：只有 console 和简单 `/api/status`；无 readiness/liveness、metrics、trace 和 build ID。
- **目标**：结构化日志、request/session correlation、LLM/tool/DB/PTY 指标、健康探针和一键脱敏支持包。
- **依赖**：SEC-06、GOV-02。
- **Persona**：architect → developer → reviewer。
- **验收**：诊断包不含 prompt/key/token；健康检查区分 live/ready/degraded；故障可从证据定位。

### REL-05　供应链、SBOM 与可重复构建

- **审计对应**：`--no-audit`、镜像 advisory 失败、第三方包直接 patch、无 SBOM/provenance。
- **目标**：可工作的 SCA、secret/license scan、CycloneDX/SPDX、依赖 hash、正式 patch 流程和 clean checkout build。
- **依赖**：GOV-04、REL-01。
- **Persona**：architect → sentinel → developer → reviewer。
- **验收**：审计源不可用时 fail closed；产物可从 lockfile/commit 重建；patch 有 checksum 和审查记录。

### REL-06　多平台发布矩阵

- **审计对应**：只配置 Windows NSIS/x64；原生依赖硬编码 win32/x64；终端 enum 只含 cmd/PowerShell。
- **目标**：Windows x64/arm64、macOS x64/arm64、Linux x64/arm64；如最终基线要求，再覆盖 PWA/Android。
- **依赖**：DS-01、DS-04、REL-01、REL-02、REL-05。
- **Persona**：architect → developer → debugger → reviewer。
- **验收**：各平台安装、首次启动、PTY、SQLite、Embedding、通知、权限、升级、卸载和数据迁移 packaged E2E。

### REL-07　运维 Runbook 与用户数据治理

- **审计对应**：无安装升级、备份恢复、凭据轮换、安全事件响应；源码目录混有 DB/output/release 产物。
- **目标**：源码/运行数据/fixture/artifact 分离，形成安装、升级、回滚、备份、日志、安全事件和卸载策略。
- **依赖**：DATA-01、SEC-05、REL-02、REL-04。
- **Persona**：writer → reviewer。
- **验收**：clean checkout 无运行数据/秘密；新机按 Runbook 可完成恢复；卸载保留/删除策略明确。

## 13. 审计差距到任务的完整映射

本表用于防止遗漏。Reviewer 每阶段结束时必须逐行更新证据链接，不能只更新任务卡状态。

### 13.1 Agent 与自治

| 审计项 | 任务 |
|---|---|
| Agent 流式循环缺取消/安全管道/并行 | RT-04、RT-05、RT-06 |
| 全局单 Agent 导致跨会话污染 | RT-01 |
| 无每会话 Workspace | RT-02 |
| Canvas/Pin/知识注入不完整 | RT-03 |
| Task 无 DAG/owner/get/delete | RT-07 |
| Subagent 无完整生命周期 | RT-08 |
| Supervisor fail-open/可自行关闭 | SEC-01、SEC-03 |
| Cron 不唤醒 Session | EVT-01、EVT-02 |
| Poll/Wire 是 fs.watch 占位 | EVT-01、EVT-03 |
| Link registry/peek/post/wait/cluster 缺失 | ECO-04 |
| Oracle 不是 Canvas child flow | ECO-05 |
| Playbook 是 JSON 步骤占位 | ECO-06 |
| Routine 缺失 | ECO-07 |
| Daemon 不是持久后台 Session | RT-10、REL-03 |
| Memo/Muse 长期自治不足 | RT-11 |
| DB 状态和迁移不完整 | DATA-01、GOV-02 |

### 13.2 桌面体验

| 审计项 | 任务 |
|---|---|
| Electron 生命周期过薄 | DS-01、REL-03 |
| Preload/IPC 占位 | DS-02、SEC-07 |
| 无统一 Tab/Pane/分屏 | DS-03 |
| 多工作区缺失 | RT-02 |
| 终端非 PTY | DS-04、TOOL-03 |
| 文件查看器缺编辑/HTML/视频/刷新 | DS-06 |
| 附件、图片粘贴和拖放缺失 | DS-05 |
| Browser 工作台缺失 | ECO-08 |
| 快捷键/Agent 中断缺失 | DS-07、RT-04 |
| 通知/Tray/会话定位不完整 | DS-08、EVT-01 |
| Settings 仅小部分 | DS-09 |
| ASR/TTS 是浏览器占位 | MEDIA-01 |
| Anima/Emote 缺失 | MEDIA-02、MEDIA-03 |
| HUD/Mascot 缺失 | MEDIA-03 |
| 无障碍不足 | DS-10 |
| Fork/Rollback/Regenerate/标题恢复不等价 | RT-09 |
| 多平台缺失 | REL-06 |
| 版本显示不一致、平台文案硬编码 | GOV-02、REL-06 |

### 13.3 工具与生态

| 审计项 | 任务 |
|---|---|
| 工具总量/Schema 无固定基线 | GOV-01、GOV-03 |
| JSON-only，无 org-mode body tools | TOOL-01 |
| Persona 权限等级和管理工具缺失 | PERS-01 |
| Skill runtime overlay/Z盘边界缺失 | PERS-02 |
| 文件工具命名/参数不兼容 | TOOL-02 |
| Bash/持久 shell 契约不兼容 | TOOL-03 |
| Script 契约及沙箱不完整 | TOOL-04、SEC-03 |
| Fetch 无 Readability | TOOL-05 |
| Download 无流式/续传/后台 | TOOL-06 |
| read_repo full 静默截断 | TOOL-07 |
| search_tools 不发现动态工具 | TOOL-08 |
| MCP 缺失 | ECO-01 |
| Prism/Managed Mode 缺失 | ECO-02 |
| Lux Worker 缺失 | ECO-03 |
| Link 同名占位 | ECO-04 |
| Oracle 同名占位 | ECO-05 |
| Playbook 同名占位 | ECO-06 |
| Routine 缺失 | ECO-07 |
| Browser tools 缺失 | ECO-08 |
| Desktop automation 缺失 | ECO-09 |
| 企业集成缺失 | ECO-10 |
| Image helper profile 不足、生成/视频缺失 | MEDIA-04 |

### 13.4 安全、发布和运维

| 审计项 | 任务 |
|---|---|
| 执行点无 Persona/Session 授权 | SEC-01 |
| Agent 文件路径越界 | SEC-02 |
| Shell/Script/Terminal 无隔离 | SEC-03 |
| API Token 在 URL/query/log | SEC-04 |
| Key 明文和环境继承 | SEC-05 |
| 无安全审计链 | SEC-06 |
| renderer sandbox/CSP 不足 | SEC-07 |
| 无版本化 migration/备份恢复 | DATA-01 |
| 导入 Schema 不严格 | DATA-02 |
| 无测试体系 | GOV-03 |
| 无 CI/发布门禁 | GOV-04 |
| 安装包未签名 | REL-01 |
| 无可信更新/回滚 | REL-02 |
| 崩溃恢复占位 | REL-03 |
| 可观测性不足 | REL-04 |
| 供应链/SBOM/provenance 缺失 | REL-05 |
| Windows x64 之外缺失 | REL-06 |
| 无 Runbook、源码和运行产物混杂 | REL-07 |

---

## 14. 执行批次与严格顺序

### Batch 0A：冻结基线和测试骨架

`GOV-01 → GOV-02 → GOV-03 → GOV-04`

- 未完成前，只允许安全止血，不允许扩展新生态。
- 退出条件：Lux manifest diff 和最小 CI 能阻断伪完成。

### Batch 0B：安全止血

`SEC-01 → SEC-02 → SEC-03 → SEC-04 → SEC-05 → SEC-06`

- SEC-07 可与 DS-02 联合完成。
- 退出条件：工具越权、路径逃逸、凭据读取和直接 Terminal RCE 测试全部失败关闭。

### Batch 0C：数据可靠性

`DATA-01 → DATA-02`

- 退出条件：升级前备份、迁移、失败回滚和恢复演练可重复。

### Batch 1：SessionRuntime

`RT-01 → RT-02 → RT-03 → RT-04 → RT-05 → RT-06 → RT-07 → RT-08 → RT-09`

- 退出条件：8 Session 并行压力零串扰；完整 Session 语义和取消恢复通过。

### Batch 1E：事件与后台自治

`EVT-01 → EVT-02 → EVT-03 → RT-10 → RT-11`

- 退出条件：Cron/Poll/通知能持久路由并唤醒正确 Session；后台服务崩溃可恢复。

### Batch 2：Desktop Workbench

`DS-01 → DS-02 → DS-03 → DS-04 → DS-05 → DS-06 → DS-07 → DS-08 → DS-09 → DS-10`

- 退出条件：Session/Terminal/File 统一工作台、PTY、附件、快捷键、通知、Settings 和无障碍门禁通过。

### Batch 3A：内建工具契约

`TOOL-01 → TOOL-02/03/04/05/06/07 → TOOL-08`

- 退出条件：目标 manifest 的内建工具逐项 contract pass，无静默降级。

### Batch 3B：Persona 与动态控制平面

`PERS-01 → PERS-02 → ECO-01 → ECO-03 → ECO-04 → ECO-05 → ECO-06 → ECO-07`

- ECO-02 Prism 依赖 MCP 和 Desktop Pane，可在 ECO-01 后开始。
- 退出条件：动态工具、Worker、Link、Oracle、Playbook、Routine 全部真实 E2E。

### Batch 4A：浏览器、Prism 与媒体

`ECO-08 → ECO-09`，并行 `ECO-02 → MEDIA-01/02/03/04`

- 退出条件：Browser 双后端、Anima 隔离、HUD、ASR/TTS、图像/视频通过正式包验证。

### Batch 4B：企业生态

`ECO-10`

- 按 MCP Server 分批，每个写系统独立安全审查。
- 退出条件：当前 Lux 企业工具 manifest 全量 contract + 权限 E2E。

### Batch 4C：可信发布与多平台

`REL-04/05 → REL-01 → REL-02 → REL-03 → REL-06 → REL-07`

- 退出条件：签名、更新、回滚、SBOM、跨平台安装升级和 Runbook 全部通过。

---

## 15. 每个批次的执行模板

### 15.1 开始

1. `switch_persona(explorer)`；
2. 阅读本文对应任务卡、Lux baseline 和现有源码；
3. 创建 task DAG，标注 owner、依赖和风险；
4. 收集基线行为与失败证据；
5. 主动 `curate`，保留任务/证据/文件/下一步；
6. `switch_persona(architect)` 冻结设计。

### 15.2 实现

1. 设计评审通过后 `switch_persona(developer)`；
2. 每次修改前重新读取目标文件和调用点；
3. 小批提交，不混入无关重构；
4. 同步补单元、契约和集成测试；
5. 发生并发、崩溃、网络或平台问题时切换 `debugger`；
6. Canvas 达到压缩阈值时按第4章执行 `curate`。

### 15.3 验证

1. Typecheck/lint/unit/contract/integration；
2. 三个不同正常场景连续通过；
3. 错误、取消、超时、重启、攻击或竞态测试；
4. 启动真实服务和真实 Provider；
5. 打包正式应用，再跑 packaged E2E；
6. 记录调用数、耗时、错误和资源指标；
7. `switch_persona(reviewer)` 独立审查；
8. 状态只更新到 `verified`，提交用户核实。

### 15.4 结束与记忆

- 更新本文任务状态/证据链接或独立状态清单；
- `remember` 只保存稳定决策、教训和里程碑；
- 对过时记忆写新决策纠正，不依赖旧完成宣称；
- 为下一批次留下标准 Handoff Capsule。

---

## 16. 阶段级不可降级验收

### Gate A：安全

- 所有工具执行点强制 capability；
- 所有路径统一 PathPolicy；
- Shell/Script/Terminal 隔离和审批；
- Token/Key 不泄漏；
- 安全审计链可重建操作。

### Gate B：Session Runtime

- 8 并行 Session × 100 调用零串扰；
- 每 Session 独立 Workspace/Canvas/Persona/Task/Abort；
- Fork/Regenerate/恢复语义一致。

### Gate C：Desktop

- 统一 Tab/Pane；
- 8 PTY 并行；
- 附件、文件、快捷键、通知、Settings 和无障碍通过。

### Gate D：动态生态

- MCP 三 transport；
- Worker fail-closed；
- Link 跨 Session/实例；
- Oracle child flow；
- Playbook/Routine 生命周期；
- Browser 双后端。

### Gate E：可信发布

- 签名状态有效；
- 更新防篡改、防降级和回滚；
- migration/backup/restore；
- SBOM/provenance；
- Windows/macOS/Linux packaged E2E。

任一 Gate 未满足：产品状态只能是“正在复刻”，不能标记100%。

---

## 17. 当前状态与下一步

截至本文制定：

- 审计结论：**不通过**；
- 严格行为复刻度：约15%–20%；
- 发布门槛：0%；
- 文档状态：执行规范已建立，任务尚未实施；
- 下一唯一动作：**切换 explorer，执行 GOV-01，建立 Lux v0.1.898 机器可读基线。**

在 GOV-01/GOV-03/SEC-01/SEC-02 完成前，不得优先新增更多表面工具或企业 UI。

