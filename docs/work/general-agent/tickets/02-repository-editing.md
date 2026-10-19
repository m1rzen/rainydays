# A02 项目上下文与可检查代码编辑

Kind: implementation

Status: verified

Spec: [通用Agent规格](../../../specs/general-agent.md)

Research: [技术依据与研究问题](../../../research/general-agent-stack.md)

Blockers: A01、D04、D05

User stories: G02

## 用户结果与工作范围

把项目上下文、精准多文件编辑和差异展示接入默认助手。识别仓库根、工作目录、文件类型、项目脚本、已有修改与相关未跟踪文件；在选定范围获取必要内容。读后写采用前提校验，冲突重读；保存仅影响目标内容。结果区可检查diff和本次变更，撤回只能处理本次且未被外改的片段。

## 先读与研究

src/tools/read-repo.ts、filesystem-lux.ts、现有文件授权与成果呈现；read_repo的git ls-files不能代表完整用户工作树。

共同实现原则见[能力手册](../../../agents/general-agent-capabilities.md)。实施前查当前定义与官方资料，记录实际版本；不要凭旧文档猜接口。

## 验收条件

- [x] C03/C04的确定性工程路径通过，中文/空格路径和多文件修改正确。
- [x] 原有未提交/未跟踪内容保留；没有擅自commit、checkout、reset或删除。
- [x] 用户/另一工具在读取后修改时不盲写；差异准确展示旧/新与未完成项。
- [x] 默认助手能发现并使用编辑能力；不向普通用户暴露内部工具配置负担。

## 验证接口与证据

临时Git仓库＋文件公共接口＋普通会话/界面，模拟并发编辑；C01–C04的编辑部分。

计分与真实模型授权见[通用验收](../../../agents/general-agent-acceptance.md)。工程桩与真实结果分别记录；没有实际执行的条件不能勾选。

## 范围与回退

不开发完整IDE或全语言语义索引。已有文件结果模型能表达diff就复用；大文件/二进制明确限制。完整真实编码质量在A04验收。

保留他人修改和用户数据；变更按本票独立提交，回退仅针对自身变更。涉及数据迁移先准备测试副本与恢复路径。复用[安全预算](../../../agents/safety-budget.md)，只加本能力需要的边界检查。

## 执行记录

2026-10-20，沿用整套路线授权，起点22e1897。A01/D04/D05及D03工程依赖满足；先完成项目上下文切片，再处理读后写校验、差异与撤回。只使用临时仓库和本地fixture，不调用真实模型或修改日常项目内容。

## Test and design seam

比较新建代码工作台/第二套仓库索引与增强现有read_repo/read/edit工具，采用后者。read_repo用固定只读Git命令识别根和工作目录、状态与未跟踪文件，所有实际内容仍走现有Path gateway；忽略规则遵循Git，删除项单独标明。默认助手按需发现read_repo，不常驻全部项目内容。临时含中文/空格的Git仓库验证未跟踪、已改/已删、脚本与筛选，真实默认会话验证发现入口。随后在原编辑接口加读取版本前提和可见差异，撤回也受当前版本校验；不调用Git写入/重置来撤回。

## 审查与验证结果

项目上下文切片已实现，并按[审查](../reviews/02-code-review.md)完成Standards/Spec检查。整票保持in-progress；读后写冲突、多文件差异与撤回待后续切片。

上述为上下文切片当时状态；以下编辑收尾已完成，本票工程状态为verified。完整真实模型编码循环仍由A04负责。

- `node --import tsx --test tests/product/repository-context.test.mjs`：3/3。先复现未允许read_repo、已删文件导致整读失败、无开发环境变量无法检测Git，再补齐。临时Git仓库含中文/空格、未提交修改、未跟踪/忽略/已删文件、子目录筛选、项目脚本；原内容/Git状态保持。使用内置general允许列表与真实Agent工具发现/执行。
- `node --test --test-name-pattern 'read_repo uses fixed Git' tests/integration/repo-oracle-path.test.mjs`：1/1；原cwd越界零进程、hardlink/junction/恶意文件名拒绝、长内容预算行为保持，未改原断言。
- `node --test --test-name-pattern 'A02 real Electron' tests/electron/startup-recovery.test.mjs`：1/1，交互20.962秒、完整37.515秒。实际默认会话按需发现→读取summary→读取all，模型HTTP fixture核对真实工具结果后回答；无开发Git路径覆盖，用户原修改与未跟踪内容保留。不是实际模型能力认证或安装证据。

无数据迁移，不运行Git写入/项目脚本；测试中的init/add/config仅限自建临时仓库。回退仅针对本切片代码/Persona提交，不恢复或覆盖用户仓库。

`npm run check:product`：typecheck、lint、产品66/66与UI/IPC15/15通过。只更新runGitQuery的单一已核实execFile登记；原拒绝新/未解析/过期及ASAR篡改负向2/2通过，scanner199/binding159、未认证40、过期0，D13仍blocked。切片终点为`feat: discover real project context from the default assistant`提交；后续继续A02编辑验收。

### 编辑切片启动

起点c385fa8，沿用授权。采用规格中的edit_files/undo_edits薄适配器；读取版本→一批多文件精确替换→真实差异→基于当前会话回执撤回。新增安全工作仅为本能力必要的版本/作用域校验与已有负向，不变更全局批准规则或D13构建gate。新建文本只原子创建，已有文件覆盖必须提供读取版本。先验证冲突、部分保存及撤回外改拒绝，再补真实默认会话与界面恢复。

### 编辑切片验证闭合

- `node --import tsx --test tests/product/code-editing.test.mjs`：最终8项纳入完整产品检查。真实gateway/精确批准执行两文件修改、BOM/CRLF/Unicode保留、预检冲突零写入、写中竞争部分完成、外改/跨会话/越界拒绝、删除片段/顺序替换撤回、取消后下一文件不写、新建不覆盖均通过。8文件完整转义回执经过原工具限制和Memory压缩仍可从原始记录撤回；超大差异写前拒绝，不增加全局预算。
- `npm run check:product`：类型、lint、产品74/74与UI/IPC15/15通过。
- `node --test --test-timeout=30000 tests/contract/tool02-filesystem-contract.test.mjs`：11/11，4.017秒。最初在清理阶段挂起，修复隔离fixture关闭其导入的数据库后通过；没有修改行为断言或生产超时。
- `node --test --test-name-pattern 'write_file|edit_file|real dispatcher executes' tests/integration/path-tool-gateway.test.mjs`：4/4。旧fixture补齐sessionId，保留原unsanitized路径/无匹配不写/真实dispatcher断言；write断言按本票明确的新建语义改为createFile，原输入、字节和根检查不变。
- `node --test --test-name-pattern 'restores complete diffs' tests/electron/startup-recovery.test.mjs`：1/1，交互32.945秒、完整49.498秒，源码构建0.1.0+local.0e2c660160d5。真实默认会话发现→read版本→两文件一次确认→保存差异→正常退出/新进程→恢复超过300字的完整差异→界面撤回→用户原内容与未跟踪状态保持。首次暴露API tool_calls为数组的恢复缺陷，修复后通过；模型为本地HTTP fixture，无付费调用。

Standards/Spec审查见[记录](../reviews/02-code-review.md)。当前扫描仍199/binding159，未认证40、过期0；本切片没有新增裸文件/进程调用或修改D13 gate。批写不是多文件原子事务；异常崩溃若发生在落盘与回执持久化之间，需重读文件检查，不承诺有可撤回回执。源码证据不代替安装或真实模型编码质量。终点为`feat: apply inspectable code edits with conflict-safe undo`提交；下一项A03。

