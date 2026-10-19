# A02 项目上下文与可检查代码编辑

Kind: implementation

Status: in-progress

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

- [ ] C03/C04的确定性工程路径通过，中文/空格路径和多文件修改正确。
- [ ] 原有未提交/未跟踪内容保留；没有擅自commit、checkout、reset或删除。
- [ ] 用户/另一工具在读取后修改时不盲写；差异准确展示旧/新与未完成项。
- [ ] 默认助手能发现并使用编辑能力；不向普通用户暴露内部工具配置负担。

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

- `node --import tsx --test tests/product/repository-context.test.mjs`：3/3。先复现未允许read_repo、已删文件导致整读失败、无开发环境变量无法检测Git，再补齐。临时Git仓库含中文/空格、未提交修改、未跟踪/忽略/已删文件、子目录筛选、项目脚本；原内容/Git状态保持。使用内置general允许列表与真实Agent工具发现/执行。
- `node --test --test-name-pattern 'read_repo uses fixed Git' tests/integration/repo-oracle-path.test.mjs`：1/1；原cwd越界零进程、hardlink/junction/恶意文件名拒绝、长内容预算行为保持，未改原断言。
- `node --test --test-name-pattern 'A02 real Electron' tests/electron/startup-recovery.test.mjs`：1/1，交互20.962秒、完整37.515秒。实际默认会话按需发现→读取summary→读取all，模型HTTP fixture核对真实工具结果后回答；无开发Git路径覆盖，用户原修改与未跟踪内容保留。不是实际模型能力认证或安装证据。

无数据迁移，不运行Git写入/项目脚本；测试中的init/add/config仅限自建临时仓库。回退仅针对本切片代码/Persona提交，不恢复或覆盖用户仓库。

`npm run check:product`：typecheck、lint、产品66/66与UI/IPC15/15通过。只更新runGitQuery的单一已核实execFile登记；原拒绝新/未解析/过期及ASAR篡改负向2/2通过，scanner199/binding159、未认证40、过期0，D13仍blocked。切片终点为`feat: discover real project context from the default assistant`提交；后续继续A02编辑验收。

