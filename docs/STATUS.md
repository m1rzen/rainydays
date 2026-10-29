# 当前开发状态

更新：2026-10-30。R5 Electron回歸已修復（明確合成模型比較預算），完整產品99/99、UI15/15、桌面5/5。A03按开发模式范围verified；A04工程已验证、真实编码模型配置/预算blocked，20题样例自检通过。接续A05。A15、A14、D05、D03、A02、D06、D08已验证。D13整票blocked，无有效安装候选。项目范围的详细判断见 [二次重构进度审计](audits/baseline-2026-09-29.md)；已完成修复见 [演示问题修复](devlog/2026-10-16-demo-repair.md)。

## 通用Agent规划与恢复入口

- 2026-10-25新会话接续见[会话交接](handoffs/2026-10-25-development.md)：先核对A15对A03的覆盖与剩余缺口；本次只整理文档并迁移会话，没有新增产品测试或交付证据。该文件是恢复快照，执行顺序继续只由总路线维护。

- 文档清理已完成：排期只由D+A总路线维护，旧多轮路线与差距表已归档；默认rg过滤历史规范/报告与本地产物。旧R证据按需查询，见[历史索引](archive/README.md)。

- 2026-10-20路线修订（用户批准）：增加开发模式A15与长任务Agent循环A14，优先于A03收尾；见[规格§7](specs/general-agent.md#7-2026-10-20路线修订开发模式与agent循环)。
- 当前阶段：implementation / A03、A15开发模式、A14 Agent循环verified，A04真实模型blocked，接续A05；D08 verified；A03旧隔离兼容缺口保留为后续项；D01、A01、D03、D04、D05、D06、A02 verified；D02真实模型认证和D13构建/机器blocked。2026-10-18用户已整体批准D+A路线并授权连续研发；Prism、钉钉排除。
- 入口：[Codex研发手册](agents/README.md)、[通用规格](specs/general-agent.md)、[D+A总任务图](work/general-agent/plan.md)。31项整体获批，D01已验证，A01调查已完成；D18为中间里程碑，完整出口A13。
- 下一项：A05本地MCP接入；A04的20题真实模型评测待具体授权，工程与样例准备已完成；D09文件整理并行候选。真实编码模型配置与预算仍待用户提供。A03已按规格§7使用用户工具链完成；临时Node/ClangCL、活动native host租约与三项认证观察保留为同事隔离模式后续项，未伪装通过，不再阻挡开发模式下A04/A05。D13保留审计/干净机器阻塞，D02真实模型未认证。既有default五项研究授权不扩大。
- 新确认差距：默认助手代码/CLI工程已接入，真实模型质量仍待测；MCP只有配置与关闭标志，未接客户端；浏览器有实现但缺完整真实验收；原生Windows工具和截图到模型的完整循环未形成可交付能力。详见[能力手册](agents/general-agent-capabilities.md)。
- D01–D05新增验证均使用隔离环境和合成模型，不修改日常用户数据库或调用真实模型；具体命令和结果见对应票据。

## 已验证

- A03：开发模式默认助手61秒终端、1600行中文分页/stdin/exit7、活动终端旁运行命令、跨Session拒绝与取消清理通过；修复缺命令诊断乱码并给PATH/安装选择提示。真实Electron输入框→任务授权→只读面板→结束后保留活动手动终端通过。产品93+UI15、同事模式4项通过；真实模型/当前安装未测。[证据](work/general-agent/tickets/03-cli-sessions.md)

- A14：迭代上限改读`common.maxIterations`（默认200），到上限如实说明未完成；运行中可从输入框追加指令，下一轮模型请求生效、不重放工具，`/api/chat/steer`绑定当前run；开发模式下编码与计划工具首轮常驻，同事模式不变。产品93+UI15、desktop4、A14真实Electron追加1/1通过；R5旧allowlist比较fixture已于2026-10-30修复，见R5-02。真实模型未测。[证据](work/general-agent/tickets/14-agent-loop.md)

- A15：设置中显式开启的开发模式。execute_command与持久终端以用户身份、用户PATH/工具链和网络运行，cwd仍限授权根；应用内确认可授权到本次任务结束。`node --test`与`python -m unittest`真实red→green，git/npm可用；超时/取消/run结束5秒内清理进程树；cmd中文参数/内建输出/程序stdin正确。同事模式隔离回归保持。产品90+UI15、Electron开关与终端视图通过；安装包与真实模型未测。[证据](work/general-agent/tickets/15-developer-mode.md)

- D08：writer兼容增加Word标题/列表/原生表格blocks与Excel columnFormats（日期/数值/文本），生成后字节复读才登记成功；R2真实Electron双成果一次确认、重启恢复、另存原件不变通过，Word/Excel 16.0真实打开并编辑副本。产品83+UI15、Electron4项通过；WPS、安装包与模型内容质量未测。[证据](work/colleague-delivery/tickets/08-document-quality.md)

- D06：文件/附件PDF真实页、DOCX提取段落、XLSX原表行/单元格与公式缓存说明接入read；长Unicode原文、混合损坏、摘要/分支/新进程续读通过。产品80+UI15、契约11、定向16通过；真实回答质量留D15，非安装包证据。[证据](work/colleague-delivery/tickets/06-file-evidence.md)

- A02：默认助手按需识别项目根/工作目录、脚本、已有/未跟踪/已删内容；read版本、一批多文件精确修改、完整差异、进程重启后撤回通过。预检及保存中竞争、外改/跨会话/越界拒绝、取消、新建不覆盖均有证据。产品74+UI15、契约11与路径4、真实Electron两项通过；真实模型编码质量留A04。[证据](work/general-agent/tickets/02-repository-editing.md)

- D03：完整请求/摘要预算可配置；不静默裁剪，原始用户要求、成果引用与最新完整工具组保留，失败/空/超时停止且取消传播。read(history:)分页取回本会话原文，真实Electron20轮、13次摘要、进程重启后普通Agent取回早期事实通过；产品63+UI15、Memory18与RT04两项通过。真实模型语义仍留F04，源码证据不代替安装。[证据](work/colleague-delivery/tickets/03-context-and-retrieval.md)

- D05：公司资料源默认关闭、保留旧路径、显式只读启用；本地目录切换、成果目录删除后重启重选、实际SMB缺失共享与NTFS只读错误提示通过。绝对搜索不再隐含依赖部门根，慢连接有界且撤销迟到授权；修复通用设置缺视觉字段和根刷新缺会话header。定向22、HTTP根事务1、Electron两项、产品51+UI15通过。R2完整预览仍有多秒等待，交D13。[证据](work/colleague-delivery/tickets/05-workspace-ux.md)

- D04：修复额度/Agent错误被通知为成功、取消丢正文、背景响应丢失和并行工具回执错配；结算区分完成/部分/失败/取消。发送与停止立即反馈，真实原生进程5秒内停止；第一份DOCX中断重启保留，第二份不重放。产品51+UI/IPC15、生命周期24、真实服务结果/会话隔离、源码Electron4项通过。[证据](work/colleague-delivery/tickets/04-run-stop-and-recovery.md)

- A01：五项可行性调查完成；MCP stdio/HTTP真实协议、自建Windows窗口与自包含发布成功；确认CLI项目命令拒绝/模块导入EPERM、浏览器Enter/Tab与工具图片投影缺口。接口、支持限制与后续实验已交接A03/A05/A07/A08/A09；不代表这些能力已产品化。[证据](work/general-agent/prototype.md)

- D01：修复旧定义文件标签的普通400/缺恢复入口，以及工作目录失效后遗留子路径；正常启动干净10次+旧数据10次通过，消息/附件可读、目录可换。两个缺陷及真实后台恢复3/3；路径相关回归3/3、supervisor6/6；完整产品检查26+15通过。历史单次退出未知，开发并发初始化超时留D13测量，真实断网资料源留D05。[证据](work/colleague-delivery/tickets/01-startup-and-old-data.md)

- R1：资料不再静默截断；模型流建立后中断不重发请求，已显示内容可恢复。
- R2：PDF/DOCX/XLSX/文本附件可分页读取；Word/Excel 可在一次任务授权内连续生成、集中展示、预览、重启恢复并另存修改。
- 桌面界面：完成比例与组件深化，统一 SVG 图标、两行输入区、成果行、折叠工具记录和设置；桌面、125% 缩放和 360px 窄窗口已检查。会话抽屉加入键盘焦点管理，独立设计复核已闭合。
- 当前源码构建、类型和 lint 通过；产品快速回归80/80，UI/IPC15/15；真实Electron回归按各票证据分别记录。用户已接受界面开发。
- R3：既有源码基线 bf3a7e4 已保存；日常 `check:product` 23 秒、UI/IPC 15/15；真实源码桌面、R1/R2 流程通过，输入框无内联样式且支持窄窗口。
- R5 工程：首次无密钥直接进入模型设置，保存后主动短请求检测连接；未接入设置隐藏。默认助手首轮十二项工具，额外能力按需发现，下一任务重置。旧对话定义变化时历史可读，使用保留消息与附件的副本继续；原回答和绑定保留。详见 [本轮记录](devlog/2026-09-30-first-use-and-default-tools.md)。
- 演示修复：两个新增入口使用正确开发 Node，原生启动 2/2；兼容 SQLite WAL 重置后的旧尾部，原损坏拒绝矩阵保持通过。实际找回 2 会话、1 消息、3 附件，当前新记录保持不变，恢复前快照保留；展示说明与任务授权一致。应用已正常重试启动。

## 开发中但未计为产品完成

- A04：默认助手真实JS/Python读取→失败→多文件修正→检查通过与缺依赖分离，正式源码Electron最终差异/结果展示通过；三次修正上限、无进展停止、同批编辑→检查与无变化回执有确定性证据。产品99+UI15、管道7+集成1、20题样例自检20/20；真实模型0次，整票blocked待配置/预算，不计能力分数。[证据](work/general-agent/tickets/04-coding-loop.md)

- A03同事隔离模式后续：Node pipe/SDK接入、活动native host阻挡新租约、三项原生认证拒绝观察失败仍未解决。开发模式已按批准的规格§7完成，不把这些旧失败改写成通过。[证据](work/general-agent/tickets/03-cli-sessions.md)

- D13：SQL物化结果遍历的808次额外文件检查已消除，15项数据库/审计/恢复负向保持；R2完整Electron预览与另存回归1/1通过。修复staging缺vendor；43新增/2过期已按实际边界分类，只登记3项核实调用、移除2项过期，40处仍被原gate拒绝。移除前置方案遭自动审批拒绝，已撤回且隔离未执行产物9c4ee25f908c。两套干净Windows、当前安装/凭据/恢复未验收；无有效新候选。[证据](work/colleague-delivery/tickets/13-installer.md)

- D02本地工程：流/非流共享完整性校验、usage与请求投影、真实Agent串并行工具/取消通过，并修复绝对路径read对DATA_ROOT的隐含依赖。产品检查50+15、LLM取消3、观测8及源码Electron3项通过。真实模型/费用未认证，整票blocked；旧文件/Playbook fixture故障已交D05/D11。[证据](work/colleague-delivery/tickets/02-model-contract.md)

- Playbook 8/8、Routine 8/8、Browser 6/6、Media 7/7 定向测试通过；这些能力仍缺普通用户入口、真实任务验收或首版必要性证明。
- Download 的主要行为测试通过，但治理清单过期；Worker 持久 bash 输出仍有失败。
- 既有混合 WIP 已保存为明确未验收的源码基线；后续切片独立提交，仍不能当作可分发候选。
- 旧数据文件根400及失效子路径已由D01复现修复；历史单次后台意外退出根因仍未知，D13继续测负载/启动。D05已完成可选源、受控慢连接与本地文件搜索修复；公司VPN/服务器未测，不扩大兼容性结论。

## 尚未完成

- R4：来源追踪、Word 引用与真实桌面工程验证通过；获准使用 default 的五项真实任务均被 Kimi 月度额度 403 阻塞，0 项有效研究，产品质量未验收。
- R5 产品验收：R5-01/02 工程均 verified；工具描述 JSON 实测 52,920 → 8,119 bytes（旧允许列表与当前 schemas 对比）。真实模型选择错误、耗时、费用前后比较与新用户首次任务未验收。
- R6：面向普通用户的“保存成功任务并换输入重跑”单一入口。
- R7：当前安装包、干净机器验收、固定脱敏任务集和三人小范围试用。

## 当前优先级

Media、远程Worker、双浏览器、企业生态与无限自治仍冻结；MCP、一个浏览器后端、原生Windows和有界子任务已进入A系列。R4/R5真实模型验收仍等用户补充可用配置名称，当前没有新的可分发安装候选。Office复杂版式、OCR、原文件无损编辑继续后移。
