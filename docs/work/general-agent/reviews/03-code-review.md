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
