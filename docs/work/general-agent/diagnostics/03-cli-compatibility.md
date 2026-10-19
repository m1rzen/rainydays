# A03 CLI兼容性诊断

2026-10-20，起点09ad4e9；仅临时项目/合成凭据，无真实模型。

## 基线和区分实验

`node docs/work/general-agent/prototypes/a01-cli.mjs`重复A01：E1 echo通过；Node/Python绝对可执行文件拒绝、退出1，stderr被UTF-8误解码；E3直接import项目文件在Node realpathSync的父目录lstat(C:\)报EPERM。日志在忽略目录test-results/a03-cli-baseline.log。

单独启动同一Node24.14.1、相同permission/no-addons/no-global-search-paths/仅cwd子树read参数，在自建项目导入相对依赖：未加与加preserve-symlinks两种均退出0、PROJECT_SUM8。说明仅Node permission参数不足以复现EPERM，AppContainer下的祖先访问是更强假设；没有据此修改ACL。

优先验证两个最小候选：给祖先目录追加元数据ACL、或避免模块加载器为已限定项目访问所有祖先。前者涉及系统卷根且可能无WRITE_DAC，不应先扩授权。先用现有E3真实模块红→修正→绿与原链接/越界负向验证preserve-symlinks；若不能保持现有边界，不采用。E1外部运行时问题另做租约/依赖实验，不把E3导入通过当CLI已完成。

## E3模块实验结果

新增真实Broker/native回归，初始期望进入项目断言失败（ERR_ASSERTION），实际在C:\祖先lstat EPERM，确认red。native E3固定Node参数增加preserve-symlinks和preserve-symlinks-main后，项目错误确实报ERR_ASSERTION，修改依赖后PROJECT_MODULE_PASSED；原ESM/require与cwd/根、junction、hardlink、任意外部读取拒绝共4/4通过。保持原permission范围、AppContainer、ACL、Job、child-process限制；没有给祖先或安装目录追加权限。

这是E3加载器兼容修复，E1 Node/Python外部命令仍未通过。读取安装文件ACL发现只含Users/Authenticated Users、Administrators、SYSTEM，没有AppContainer SID；E3由native host直接启动租约中的当前Node，E1则由受限cmd再启动外部程序，二者启动链不同。后续按此区别验证运行时接入；不能从E3成功推断普通cmd已能执行Node/Python。
