# 2026-10-18：清理研发文档噪声

用户询问能否使用GPT-6.1 Sol/xhigh按现有文档开发，并要求处理旧路线噪声。本轮完成文档入口和搜索范围清理，没有开始D/A功能开发；计划状态仍为proposed，不把模型选择视为实现批准。

## 发现与处理

- ROADMAP混合当前范围、旧R0–R7执行顺序和多轮排期：完整旧文保存在[历史快照](../archive/legacy-roadmaps/2026-10-18-roadmap-before-cleanup.md)，当前页收敛为权威文档导航。
- 根目录GAP-ANALYSIS仍要求最高优先级修复并沿用Lux v0.1.887勾选：原内容移至[历史差距表](../archive/legacy-roadmaps/2026-07-08-lux-gap-analysis.md)，原路径保留短入口。
- D系列索引仍有独立六阶段与执行顺序：保留18票依赖、例外和候选；唯一排期回到D+A总路线，31票依赖未改。
- 旧全量规范/parity文档仍自称canonical或唯一基准，且全量规范被build-inputs、版本测试及已有机器证据引用：保留这些构建绑定文件的原路径/内容，AGENTS和手册明确其仅作具体契约资料。新建[历史索引](../archive/README.md)说明用途。
- `.rgignore`让默认rg搜索避开archive、旧全量规范、parity Markdown/报告及本地deliverables。代码、测试、parity脚本/策略/schema照常检索；指定路径与`--no-ignore`可查历史。没有删除用户备份或改变Git跟踪/应用测试。
- PRODUCT、短反馈说明、README与STATUS同步当前入口；既有R票、审查、诊断、audits和devlog按需保留证据，不作为第二条执行队列。DESIGN继续保留用户已通过的UI方向。

## 模型与启动

已获取官方GPT-6.1 Sol模型页与Codex发布记录，确认支持xhigh并有Codex使用说明，链接与新会话启动指令写入[研发手册](../agents/README.md)。建议针对开发时的Codex，没有修改本机模型配置、读取凭据或替换RainyDays运行模型。

## 验证

- 清理涉及的文档内链/锚点、UTF-8、围栏和空白检查通过；归档保留原内容并调整相对链接。
- 31项D/A依赖表与票据一致，无缺失边或循环；票据状态未变。
- 实测默认rg已过滤上述噪声，AGENTS、当前路线、D01、src和parity脚本仍可见。
- `git diff --check`通过；`node scripts/generate-build-info.mjs --check`通过，640项构建输入未变，build仍为`0.1.0+local.9e687ab918ac`。
- 纯文档/搜索规则变更，无应用行为变化，未重复全量应用或真实模型测试。本地提交不含deliverables、数据库、凭据或私有备份。
