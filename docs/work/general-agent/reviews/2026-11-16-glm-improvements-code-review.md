---
workflow: project-workflow
kind: code-review
ticket: A14/A08/A11/A13
fixed_point: 3a635ecf39dc856a43c225aa58139f5f2599706d
status: active
---

# GLM 六项改进独立代码与验收审查

日期：2026-11-16。结论：**changes-requested，M1/M2 不能整批验收。** 六项均有工程投入，但当前实现存在 4 项 P1、5 项 P2 可重现问题；“切片已实现”不能作为“里程碑已合格”的依据。本轮只审查、复现和同步内部记录，没有修改产品源码。

## Review scope

- 固定起点：`3a635ecf39dc856a43c225aa58139f5f2599706d`。
- 产品终点：`3247477924a2b58ce68aa9acc1e715c265829a13`；六个提交依次为 `b087dc1`、`87804fb`、`056670f`、`9efdbd3`、`f79beb9`、`3247477`。范围为这六个提交的 29 个文件、约 1132 行新增/22 行删除。
- 审查启动 HEAD：`ef5a7dec4b23ed7473baf3f072b81f870c6902a8`。其 Lux 诊断文档不属于本轮产品范围。开始和结束产品检查时，已跟踪源码均无其他未提交修改；已有未跟踪文件原样保留。
- Spec：已于 `plan.md` 2026-11-16 修订采纳的[六项补充计划](2026-11-14-progress-plan-assessment.md)、A14/A08/A11/A13 对应验收、D04 的残缺参数不执行与如实报告状态要求。原工作复盘的背景与问题采用该计划审阅中的已有提取，本轮未重新读取原始 Word。
- Standards：`AGENTS.md`、`docs/agents/workflow.md`、`architecture.md`、`general-agent-capabilities.md`，以及现有路径网关、持久化回执、RunLedger、技能发现和运行终态契约。
- 方法：先按工程正确性检查，再独立按规格检查，顺序执行；使用真实本地文件、Agent、隔离 HTTP 服务及真实 Electron。模型响应均为确定性 fixture，未调用真实付费模型，未访问日常用户数据库或凭据。
- P1 表示阻塞核心交付或声称的能力不可达；P2 表示应在对应切片关闭前修正的明确功能/数据问题。

## Standards findings

### R01 · P1 — 交付收敛把实际生成成果的命令当成无进展检查，提前截断任务

- Location：`src/agent.ts:276`、`src/agent.ts:1412–1425`。
- Evidence：检测只看工具名，把全部 `execute_command/bash/shell_input/shell_output` 归为检查。隔离 Agent 连续执行三个实际写入 Markdown 文件的命令，三个文件都存在，但模型只被请求 3 次，宿主提前输出“没有产出新成果”并结束；正常的第 4 次最终交付回答无法发生。初始“生成报告并交付”已经会启用此机制。
- Authority：已批准计划要求按宿主阶段、完成依据和产物进展收敛，不能破坏普通生产任务；A14 要求支持长任务执行与如实反馈。
- Impact：生成文档、脚本处理、下载和编码步骤均可误触发。反过来，任何非检查工具回合即使失败也会重置计数，无法可靠限制实际无进展循环。
- Recommended correction：结合任务阶段、成功结果及可核对的产物/内容变化判定进展；对复核阶段设上限。生产命令必须能到达最终交付；未完成停止须使用未完成终态。

### R02 · P1 — 工具允许的相对成果路径登记成功，随后却被成果列表静默丢弃

- Location：`src/tools/output-registry.ts:51`、`:68`、`:99`；`src/document-outputs.ts:45`。
- Evidence：真实授权文件下，`register_output({path:"review-relative.md",kind:"deliverable"})` 返回 success、正确字节数和摘要；回执保留相对路径。数据库消息回放后，`collectDocumentOutputs` 因要求绝对路径返回 0 项。
- Authority：工具公开契约允许相对 `OUTPUT_DIR`；计划要求脚本/下载成果可持久归属并从正常会话交付。
- Impact：模型收到“已登记”，用户却看不到成果，重启回放也不会恢复。
- Recommended correction：使用路径网关实际解析的规范绝对路径作为回执路径，保持读权限与根目录归属；不要按进程 cwd 猜测补全。补工具→持久化→会话 API 的相对路径测试。

### R03 · P1 — length 截断等待续接时仍向界面报告 completed

- Location：`src/agent.ts:1082–1086`；`src/index.ts:3215–3224` 的通知与 `run_finished` 生成逻辑。
- Evidence：真实 HTTP 流程先通过工具写入第一章，再返回 `finish_reason=length`。第一章被保留，回答含检查点提示，但 SSE 最终为 `run_finished.outcome="completed"`。Agent 在此分支只发 `answer_chunk/answer_done`，服务端因没有 error 判为成功。
- Authority：D04 及补充计划要求清楚区分完成、中断与待续接；已保存文件不等于任务已完成。
- Impact：用户看到任务完成通知，自动化或界面也无法辨认还需要继续，影响长文交付判断。
- Recommended correction：引入并贯通明确的 incomplete/awaiting-resume 状态，覆盖 Agent、HTTP、通知、会话恢复与 UI；已写入章节保留，但不得以 completed 收束。

### R05 · P2 — 尚未受理的请求占用幂等键，正常重试被当作重复提交

- Location：`src/index.ts:3102–3128`；`src/chat-idempotency.ts:11–23`。
- Evidence：真实 HTTP：没有配置 key 时首次请求返回 400；配置隔离的有效 fixture Provider 后，同一 `clientRequestId` 重试返回 409“已经提交过”，会话实际 user 消息数为 0。去重函数在 API key 检查、runtime 初始化及 claimRun 前已经写入 seen，失败无撤销。
- Authority：计划要求同一逻辑提交幂等，不能吞掉未受理的合法请求；既有 API 允许修复前置条件后重试。
- Impact：配置错误、运行繁忙和 runtime 变更等前置失败也会把键封锁十分钟，误导用户查找并不存在的回复。
- Recommended correction：区分预留、已受理及失败，原子绑定成功 claim/持久化，前置失败释放；增加 API 层失败后重试及并发受理测试。

### R06 · P2 — 任意成功工具可伪造成果登记回执

- Location：`src/document-outputs.ts:45–60`。
- Evidence：用正常 assistant tool_call 对应 `third_party_tool`，返回 success 且内容为 `artifact_registration`，指定不存在的绝对 DOCX 路径，成果列表仍得到 1 项；该路径从未由 register_output 校验。
- Authority：计划要求核对路径、存在性及格式后显式登记；既有 document_output 分支已经绑定可信工具名称。
- Impact：第三方/MCP 内容可以被误当成宿主校验过的交付件。此处确认的是成果可信性失守，不声称可以绕过文件访问权限。
- Recommended correction：仅接受与可信 `register_output` 调用匹配的成功回执，校验所需字段；为未知工具伪造、错误类型和无匹配 call_id 补负向检查。

### R07 · P2 — 超过 32 MiB 的“头部校验降级”使用了错误的网关 API

- Location：`src/tools/output-registry.ts:77–87`；`src/path-policy.ts` 的 `readFile` 总字节上限逻辑。
- Evidence：真实授权 33 MiB MP4 登记返回 denied。第一次 `maxBytes=32MiB` 超限，第二次把同一整文件读取的上限改成 64KiB，仍必然超限。该参数是总量拒绝阈值，不是读取范围；既有新增测试的假网关提供了不同语义，所以未发现问题。
- Authority：实现及执行记录明确声称大文件会降级头部校验；计划包括脚本与下载成果。
- Impact：正常视频等较大成果无法登记，而且被误报为“无法访问”。
- Recommended correction：使用受授权约束的真正有界范围读取，或明确实现支持的文件大小并按规格处理；全文件摘要与头部摘要分开标识，不能互当版本证明。

### R08 · P2 — JPEG 观察被淘汰后没有删除磁盘文件

- Location：`src/observations.ts:84–86`。
- Evidence：连续注册 41 张有效、不同摘要的 JPEG，首张索引已经淘汰，磁盘却仍有 41 个 `.jpg`。代码先删除 Map 条目再查询其 MIME，查不到后总按 `.png` 删除。
- Authority：现有每会话最多 40 张的有界观察缓存契约；新增 JPEG 应保持 PNG 的清理行为。
- Impact：长文逐页检查与重复读取不同版本图片时，JPEG 磁盘占用持续累积。
- Recommended correction：删除索引前保存旧观察 MIME/文件名，验证 PNG/JPEG 混合及连续淘汰后磁盘和索引一致。

## Spec findings

### R04 · P1 — 新增会议纪要模板没有接入任何 Agent 的技能发现或人格加载

- Requirement：M2-2 通过 A11/D07/D08 让实际文稿任务使用模板及事实规则。
- Location：`skills/meeting-minutes.md:1`；`src/skill-packages.ts:75–95`；`src/persona.ts:155–177`。
- Evidence：新文件是平铺 `.md`，没有技能包 `SKILL.md` 与 frontmatter；A11 只发现 `<id>/SKILL.md`。保留的旧平铺加载方式必须由 persona 的 skills 显式列出，general、writer、rds-assistant 均未绑定该文件。实际技能目录没有 meeting-minutes，三个人格提示也没有模板内容。
- Impact：文件和静态测试存在，运行中模型却拿不到这项新能力。已有语义样本契约测试只读取磁盘文本，不能证明模板可用。
- Recommended correction：按现有 A11 包格式接入并验证列表→skill_open→模型请求；或选择明确的人格绑定路径并验证实际加载。避免再建另一套技能机制。

### R09 · P2 — 成果界面没有支持新格式，也没有展示原始资料/中间件/交付件类别

- Requirement：M1-3 要区分源资料、中间产物、交付件，避免再次把输入资料当成交付成果。
- Location：`public/renderer.js:1849–1854`（未随新登记格式一起更新）。
- Evidence：真实 Electron 渲染 PDF/source、MP4/deliverable、Markdown/intermediate 三项，三行 DOM 都标为“Excel 工作簿”；渲染器仅区分 DOCX 与其他，完全不读取 `output.kind`。
- Impact：用户无法从登记列表分清输入与最终结果，格式也被错误呈现。后台新增 kind 不等于用户端完成了区分。
- Recommended correction：按实际格式显示名称/图标与合适操作，并明确类别；用普通会话成果列表验证三种角色与多种格式。此次 Electron 使用合成登记数据隔离验证渲染，不宣称真实模型主动登记已验收。

### 仍未满足的验收范围

这些是未完成的规格或证据，不额外计为以上九个可重现缺陷：

1. **length 检查点仍只有文字说明和 RunLedger 写入文件列表。** 没有独立结构保存输入版本、环境、已验证章节边界、产物版本和下一步；脚本产物/register_output 也不自动成为该列表。现有用例在同一 Agent 上输入“继续”，没有杀进程后恢复、取消续接和防重复发布回放。原有残缺 JSON 不执行机制有保留，这是已有能力；跨进程章节恢复尚不能验收。
2. **语义样本是起步夹具。** 24 条标注与六维度、分项权重已加入，最低页数规则也避免了普遍扩写；但尚无冻结原始材料/上下文、独立人工复核和真实模型分项结果。3 个静态契约检查证明文件结构，不证明事实保真收益。GLM 自己保留了这部分待验收，不能把它算作已完成的语义质量评测。
3. **重复消息原案例根因未被追溯。** 新增逻辑键方向合理，但执行记录给出的是代码机制分析，没有把原来 75ms 三条消息关联到具体客户端事件、请求与持久化来源。渲染器每次新发送生成新键，双击是否复用同一逻辑键仍需真实 UI/API 联合验证；不应宣称已经覆盖所有双击、重连或重放情况。
4. **M3 尚未开展。** 八场景×3 次冻结回放、当前 D13 安装候选及 A13 全出口仍在后续范围，本轮不把它们算成已交付，也不要求以静态测试替代。

## 六个切片的验收判断

| 切片 | 可保留的实现 | 本轮判断与关闭条件 |
|---|---|---|
| M1-1 交付收敛 | 有宿主计数、提醒和停止入口 | 不合格：R01 阻塞生产路径；恢复既有编码检查并验证真实产物进展 |
| M1-2 本地图像 | PNG/JPEG 实际像素、版本摘要、复用与图片预算入口 | 部分成立：修 R08；文稿逐页/小字/真实视觉收益继续按 A08 验收 |
| M1-3 成果登记 | 新工具、类别/摘要字段、持久化回执派生链 | 不合格：R02/R06/R07/R09，补齐可信登记至会话 UI 的完整路径 |
| M2-1 length 续接 | 保留已写文件与说明，残缺工具不执行 | 不合格：R03；补结构化检查点与真正重启/取消恢复 |
| M2-2 模板与语义 | 模板正文、24 条样本、六维度与分项权重 | 不合格：R04 导致模板不可达；语义质量尚无实测证明 |
| M2-3 消息幂等 | 基于 session+请求键的十分钟去重 | 部分成立：修 R05，再关联原案并测失败重试/并发/真实 UI 逻辑键 |

## Checks and evidence

| 检查 | 结果 | 解释 |
|---|---|---|
| `npm run check:product` | 类型/lint 通过；产品 **188/191，3 失败** | 在产品阶段退出，命令中的 UI 阶段未执行；不能写成整套通过 |
| `npm run build` | 通过 | 随后 HTTP/Electron 使用当前源码构建；构建成功不代表上述行为合格 |
| 单独 `npm run test:product:ui` | **15/15** | 现有 UI 静态/契约检查通过，覆盖不到 R09 |
| 幂等 unit + semantic-samples contract | **4/4** | 基础窗口/夹具检查通过，覆盖不到请求受理生命周期与模板接入 |
| SEC-01 + TOOL-02 | **16/16** | 既有工具边界与文件契约通过，覆盖不到本次登记组合边界 |
| 旧 Agent 受控对照 | coding-loop **6/6** | 只把 Agent 替换为 `3a635ec` 版本，其余模块及测试保持当前；用于定位，不冒称完整旧版基线 |
| 新增审查探针 | **9 个均重现问题** | 8 个 Agent/HTTP/文件探针，加 1 个真实 Electron 渲染探针；断言正确行为时预期为 red |

产品 3 项失败为：默认 Agent 的脏 JS 项目、脏 Python 项目、无代码变化时重复失败检查。前两项是新增 system 提醒改变了脚本模型的“最后消息必为 tool”假设，出现空值异常；第三项模型请求数由预期 4 变成 3。不能把三个失败全解释成三个独立真实模型缺陷，因此另用实际写文件探针确认 R01。旧 Agent 对照六项全部通过，说明失败与本轮 Agent 变更相关。

本地原始日志和隔离探针保存在 `test-results/glm-review-20261116/`，按仓库规则不提交原始诊断目录。完整产品日志为 `test-results/glm-review-product-20261116.log`。关键观察值：

```text
productive-commands: modelCalls=3, allThreeFilesExist=true, halted=true
relative-registration: toolStatus=success, outputs=0
length-run-status: chapterPreserved=true, checkpointNotice=true, outcome=completed
skill-discovery: inPackageCatalog=false, inPersonas=false
preflight-idempotency: firstStatus=400, retryStatus=409, userMessages=0
untrusted-receipt: outputs=1 (nonexistent file, third_party_tool)
large-registration: authorized 33MiB MP4 -> denied
jpeg-eviction: registeredFirst=false, filesOnDisk=41 (limit=40)
artifact-ui: PDF/source, MP4/deliverable, MD/intermediate -> all Excel 工作簿
```

本机复跑入口（均为合成材料，红色结果是已发现问题的验收断言失败）：

```powershell
node --import tsx --test --test-concurrency=1 --test-name-pattern REVIEW test-results/glm-review-20261116/delivery-probe.test.mjs test-results/glm-review-20261116/artifact-probes.test.mjs test-results/glm-review-20261116/api-probes.test.mjs
node --test test-results/glm-review-20261116/ui-probe.test.mjs
```

## Resolution

- Blocking findings：R01–R04 阻塞相应核心能力；R05–R09 在相应切片关闭前修复。不存在“全部完成后只剩打包”的验收结论。
- 状态同步：A14 从 verified 回到 in-progress；A08/A11 从 implemented 回到 in-progress，表示新增切片发现缺陷，历史已通过范围保留。A13 保持 ready，其新增成果登记切片 changes-requested；不将整票提前标为完成。A04 既有评测历史保留，本次编码回归由 A14 修复，不重写旧模型成绩。
- 执行记录：保留 GLM 六项原记录，追加独立审查更正，M1/M2 的“全部完成”改按“已提交实现，验收需返工”理解。
- 修复顺序归入原票：先 R01/R03 运行与终态，再 R02/R06/R07/R09 成果链，再 R04/R05/R08；补齐章节恢复和原案例证据后，才冻结 M3 的 24 次回归候选。M3 准备工作可继续，正式合格窗口须在修复后开始。
- 本轮交付：审查报告、状态与票据记录；没有实施产品修复，没有新增真实模型或安装包合格结论。
- Final review status：**changes-requested**。
