# D05 目录与表单诊断

起点a6f980e，2026-10-20。复现入口为workspace-settings、TOOL-02和startup-recovery的D05真实Electron用例。

1. 空部门路径被要求非空；旧配置缺开关归一化仍默认Z盘。新增开关与空路径后公开配置测试由2失败变2通过。
2. 无DATA_ROOT的绝对glob在真正路径调用前失败。与D02的read相同，绝对glob/grep/legacy交已有gateway；相对路径仍要求默认根。旧TOOL-02 fixture缺capabilityContext，补齐会话上下文后保留原行为断言。
3. 目录保存HTTP400。曾考虑初始化表单竞争、目录授权失败和字段不一致；已有日志显示PUT仅1ms且无路径拒绝，排除目录探测。等待首次设置初始化后明确得到Common settings字段无效，核对发现schema的visionProfile未从表单提交。保留现有值修复。
4. 保存成功但根列表为空：设置页未打开文件标签时activeFileOwnerSessionId为null，刷新根请求没带当前会话。改用当前会话回退，真实Electron覆盖此入口。
5. 外部成果目录删除后，原准备链将其当作必需根导致启动失败。改为可用状态、保留配置、允许进入设置重选；不自动移动文件。

测试维护：首次设置延迟200ms自动打开，测试必须等其渲染并await openSettings；重启后根列表按需加载，测试显式ensureFileRoots。这些等待不放宽原产品超时。

一次R2文档流程已创建两份成果，但预览等待失败：resolve、roots各约3.8秒，list/preview仍在等待；构建元数据后来变化不是该失败的已证实原因。D13继续量测SQL/审计热路径，不通过增加等待掩盖问题。
