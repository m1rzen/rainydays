# A03 分步审查

## E3真实项目模块切片（2026-10-20）

固定范围09ad4e9至本轮工作树的native E3固定参数与对应真实回归；先Standards后Spec，无委派。整票in-progress。

Standards：只增加两个Node解析选项，未改协议/宿主鉴权、JS read/write根、原生ACL、AppContainer/Job或取消链。preserve-symlinks会改变模块标识，但不会赋予Node子进程、新原生addon或新的文件范围；现有cwd/根/junction/hardlink/外部文件读取拒绝实际保持。运行时仍是native租约中的当前Node，未采用任意系统spawn或隔离失败回退。新native产物由原build脚本和当前元数据构建，未修改验证器来接受旧产物。

Spec：新增相对依赖真实导入先遇到项目断言错误，改代码后检查通过；与A01的祖先EPERM有明确red/green。内联ESM、require和范围负向共4/4通过。只解决E3模块加载，E1外部Node/Python、编码、长终端、默认助手接入尚未完成，不能标A03 verified。收尾继续原取消用例和产品检查。

验证闭合：原D04真实native取消回归1/1（1.412秒，5秒内停止写入）保持；check:product类型/lint、74/74与UI/IPC15/15通过。源码构建0.1.0+local.ea857b6096fc；E3子切片已验证，整票继续。

## E1后代进程标准输出切片

固定范围b07cf7d至本轮工作树的E1创建console标志与版本回归、临时区分原型；Standards/Spec顺序检查，无委派。

Standards：只对E1改用CREATE_NO_WINDOW，E3与持久PTY方式保持；原显式标准句柄列表、悬停/Job/令牌检查和ACL不变。真实E1基础负向仍验证外部文件、ambient env和实际loopback网络请求拒绝，没有无隔离回退。探针persona unrestricted仅用于通过原execute_command网络risk声明，native仍network:deny；deny baseline的CAPABILITY_RISK_DENIED保留，未把这条路径认证为可用。

Spec：版本命令exit0而stdout缺失有独立red；修改后实际v24.14.1出现，不能用宿主SEC03_EVIDENCE代替用户输出。临时Node脚本真实断言/修正标记可核对；Python失败与默认Node test runner超时保持明示，原型复制不作为生产缓存实现。build原命令通过，E1边界1/1、版本1/1及完整产品74+UI15通过；源码构建0.1.0+local.ae6f013acc5e。本子切片已验证，A03整票继续。

## 已有文件读取与保留句柄切片

固定范围182db0e至当前native保留普通文件access、真实读取/重命名回归及诊断；按Standards、Spec顺序复核，无委派。

Standards：普通文件保留句柄以FILE_READ_DATA替代DELETE，继续READ_CONTROL/WRITE_DAC/FILE_READ_ATTRIBUTES及不共享删除。只读数据访问使Windows共享保留实际生效；目录、ACL授权、身份校验、Job/网络和恢复契约未变。只去DELETE的中间候选未能拒绝ren，已弃用，没有删除失败断言。当前方案实际验证原文件内容及dev/ino保持、目标不存在；原E3范围/链接拒绝、J5外部对象无SID和E1数据/环境/真实网络负向保持。探针与测试共用全局native恢复目录，不适合并行；串行执行，不清空journal。

Spec：真实type先因sharing violation失败，当前1/1通过；相关E3拒绝1/1、原生E1/J5共2/2通过。Python临时项目真正断言失败、修正后unittest成功；仅支持因果实验，不代表生产运行时已接入。默认Node --test仍超时，上游libuv命名管道兼容缺陷另记；不静默改变测试语义或用源码证据代替安装。该子切片可验证，A03整票继续。

## E1编码切片

固定范围e1f648b至本轮native console编码与真实回归。Standards：继承launcher给host的私有隐藏console，先设置65001，保留原命令文本、单次cmd解析、标准句柄列表、AppContainer/Job、路径和网络。额外cmd包装曾破坏引号，已撤回；未改全局console或SDK。原E1边界1/1及停止1/1保持。D04 fixture使用已观察heartbeat快照，避免第二次读落在截断写入之间，原停止时限/进程不存在/不再写入断言不变。

Spec：中文cmd与外部stdout/stderr真实red→green；引用路径/参数、中文空格cwd和exit7按实际内容与状态核对，版本及文件保留回归共4/4。类型/lint、产品74/74及UI15/15通过。源码构建0.1.0+local.d8ed84e25321；不是当前安装候选、不是任意编码自动识别。本切片可验证，A03继续。

## 持久终端结果切片

固定范围a52d08a至当前ExecutionIsolationService/Terminal、原工具/面板结果与真实测试。按Standards→Spec复核，无委派。

Standards：实际native completion码/原因只经原服务保存，不从输出文本猜退出码；终止中等到closed才报结束。原owner、输入grant/lease、字节窗口、Job清理均保持；当前run与另一Session真实输入误投被拒绝。UI只增加状态原因，未开放HTTP写终端或跨principal控制。产品74+UI15、相关公共边界11/11通过。全文件60项实际57/60，三项fixed-production denial observation为EXEC_NATIVE_EVIDENCE_UNAVAILABLE，其中manual observation单独复现，原因尚未确定；不可因只跑聚焦子集而称全套通过，不删除认证断言或改为未认证证据。

Spec：两个公共结果用例先red，修改后实际exit0/7、执行限制与native通道失败可区分。真实原生长终端1/1（64.292秒，合计68.496秒），完成stdin、跨会话拒绝、超过60秒、1600行分页、无早期丢失、最后一行只出现一次及exit7。首轮失败源于把旧truncated（包含“还有后页”）当输出丢失，现断言起点连续、outputStart=0及末行不重不漏；工具文案区分后页与超出保留窗口。真实停止1/1（执行3.368秒，含启动/检查，不代表纯停止耗时），断言停止<5秒、父子PID消失、心跳不再变化、独立进程仍存活。源码f55eb60e828c。当前切片已验证；A03整票、默认入口/SDK与原生观察失败仍未完成。

## 默认助手与只读终端切片

固定范围a07adb1至当前persona、Agent只读投影、原HTTP/renderer入口及Agent结束资源范围。Standards→Spec顺序复核，无委派。

Standards：CLI仍按需发现，首轮不常驻schemas，原native-process精确授权保持，工程fixture仅在tests中注册私有批准handler。只读视图绑定当前Agent上下文，返回list/get/output/subscribe/isCurrent，不返回owner/lease/写入方法；原Session/direct-operation校验内选择该视图。先用当前owner列表匹配ID，未捕获任意认证错误做fallback。原手动输入/kill通道保持；UI禁用助手输入/控制及resize调度与延迟回调。Agent普通结束改用经真实root context绑定的现有资源清理，保留active local-user-api资源；会话退休、poison和authority关闭仍全范围清理，原失败封锁保持。相关清理red→green4项及完整Broker32/32通过。

Spec：普通默认Agent真实执行中文cmd→终端→退出7，工具发现从缺失red到真实6步成功，精确四次native授权，旧视图结束失效；2.144秒。Electron renderer连接真实daemon/本地合成模型，助手输出/只读按钮、越界Session404、退回手动视图、Agent结束后旧视图404且手动记录200通过（35.726秒，合计45.314秒）。该窗口使用test独立Electron壳及测试认证注入，resize在实际renderer用窄spy验证；不是原生确认UI/正式main/安装包验收。活动手动host时第二lease仍EXEC_ACL_RECOVERY_REQUIRED，面板测试明确先结束手动进程，只验证保留视图共存，不冒充活动进程并发。源码69ed8d83d46b；A03整票继续，SDK、并发、Node pipe与三项观察失败未闭合。
