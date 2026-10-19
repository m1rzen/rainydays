# A03 分步审查

## E3真实项目模块切片（2026-10-20）

固定范围09ad4e9至本轮工作树的native E3固定参数与对应真实回归；先Standards后Spec，无委派。整票in-progress。

Standards：只增加两个Node解析选项，未改协议/宿主鉴权、JS read/write根、原生ACL、AppContainer/Job或取消链。preserve-symlinks会改变模块标识，但不会赋予Node子进程、新原生addon或新的文件范围；现有cwd/根/junction/hardlink/外部文件读取拒绝实际保持。运行时仍是native租约中的当前Node，未采用任意系统spawn或隔离失败回退。新native产物由原build脚本和当前元数据构建，未修改验证器来接受旧产物。

Spec：新增相对依赖真实导入先遇到项目断言错误，改代码后检查通过；与A01的祖先EPERM有明确red/green。内联ESM、require和范围负向共4/4通过。只解决E3模块加载，E1外部Node/Python、编码、长终端、默认助手接入尚未完成，不能标A03 verified。收尾继续原取消用例和产品检查。

验证闭合：原D04真实native取消回归1/1（1.412秒，5秒内停止写入）保持；check:product类型/lint、74/74与UI/IPC15/15通过。源码构建0.1.0+local.ea857b6096fc；E3子切片已验证，整票继续。
