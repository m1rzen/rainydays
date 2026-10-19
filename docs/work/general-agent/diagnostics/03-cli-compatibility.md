# A03 CLI兼容性诊断

2026-10-20，起点09ad4e9；仅临时项目/合成凭据，无真实模型。

## 基线和区分实验

`node docs/work/general-agent/prototypes/a01-cli.mjs`重复A01：E1 echo通过；Node/Python绝对可执行文件拒绝、退出1，stderr被UTF-8误解码；E3直接import项目文件在Node realpathSync的父目录lstat(C:\)报EPERM。日志在忽略目录test-results/a03-cli-baseline.log。

单独启动同一Node24.14.1、相同permission/no-addons/no-global-search-paths/仅cwd子树read参数，在自建项目导入相对依赖：未加与加preserve-symlinks两种均退出0、PROJECT_SUM8。说明仅Node permission参数不足以复现EPERM，AppContainer下的祖先访问是更强假设；没有据此修改ACL。

优先验证两个最小候选：给祖先目录追加元数据ACL、或避免模块加载器为已限定项目访问所有祖先。前者涉及系统卷根且可能无WRITE_DAC，不应先扩授权。先用现有E3真实模块红→修正→绿与原链接/越界负向验证preserve-symlinks；若不能保持现有边界，不采用。E1外部运行时问题另做租约/依赖实验，不把E3导入通过当CLI已完成。

## E3模块实验结果

新增真实Broker/native回归，初始期望进入项目断言失败（ERR_ASSERTION），实际在C:\祖先lstat EPERM，确认red。native E3固定Node参数增加preserve-symlinks和preserve-symlinks-main后，项目错误确实报ERR_ASSERTION，修改依赖后PROJECT_MODULE_PASSED；原ESM/require与cwd/根、junction、hardlink、任意外部读取拒绝共4/4通过。保持原permission范围、AppContainer、ACL、Job、child-process限制；没有给祖先或安装目录追加权限。

这是E3加载器兼容修复，E1 Node/Python外部命令仍未通过。读取安装文件ACL发现只含Users/Authenticated Users、Administrators、SYSTEM，没有AppContainer SID；E3由native host直接启动租约中的当前Node，E1则由受限cmd再启动外部程序，二者启动链不同。后续按此区别验证运行时接入；不能从E3成功推断普通cmd已能执行Node/Python。

## E1运行时区分实验（未通过）

新增throwaway a03-runtime-probe：仅把本机Node及Python标准运行依赖复制/打包到自建临时项目，由原E1执行；不是生产缓存/安装方案，不修改原安装目录。首轮persona networkPolicy=deny在进入native前因既有execute_command声明network risk被CAPABILITY_RISK_DENIED拒绝，无子进程退出码、无运行时成功证据。原deny事实保留；不是操作系统运行时拒绝。

为继续区分文件/启动链，第二轮实验persona与A01一样用unrestricted，但原native request仍固定network:deny，未修改生产策略或允许实际联网。复制Node后--test两次达到原30秒EXEC_LIMIT_WALL（外层exit80，原childExit57472）；Python复制标准库ZIP/DLLs后仍child-failed、childExit1。两者都没有得到真实断言或修复后通过，不算CLI可用。下一最小实验分开--version、直接脚本和Node test runner，输出每一步，避免把IPC/加载器/运行时故障混成同一结论。

进一步区分：复制后的Node/Python --version均childExit0，但版本字符串没有进入输出，只有宿主SEC03_EVIDENCE；Node直接脚本先exit1、修正后exit0，仍丢失断言输出；Python两次exit1。不能把非空宿主证明当实际stdout。新假设是E1 detached cmd→外部程序的标准句柄/console行为；先加独立版本输出red，再比较CREATE_NO_WINDOW，保持原显式handle list、AppContainer和Job。微软[创建标志](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)与[重定向子进程](https://learn.microsoft.com/en-us/windows/win32/procthread/creating-a-child-process-with-redirected-input-and-output)已核对，两种console标志不可并用。尚未因此改任何网络策略。

E1改CREATE_NO_WINDOW单变量后，实际版本输出测试red→green（2.006秒）；原E1 AppContainer/Job、外部文件/父环境/网络拒绝1/1保持，产品74+UI15通过。Node/Python版本均实际输出且exit0，Node直接脚本的ERR_ASSERTION与修正成功标记可见。

同一临时SDK打包在隔离外import unittest成功，不是可发布运行时。隔离内Node默认--test仍达到30秒墙钟限制；仅实验指定--test-isolation=none后真实断言→修正→TAP1/1通过，不能据此认证默认测试进程隔离或静默改用户测试语义。Python ZIP启动仍缺encodings；增加未压缩encodings后定位为读取其__init__.py的PermissionError，childExit1。下一步核对现有保留文件句柄的DELETE访问与CRT share-delete兼容，仍无生产网络策略变更。
