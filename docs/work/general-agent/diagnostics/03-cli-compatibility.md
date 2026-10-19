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

## 已授权普通文件读失败的最小复现

新增真实E1 `type` 读取自建已有文件，预期返回ASCII标记，实际childExit1、sharing violation（中文原始输出被旧UTF-8解码破坏）。这不依赖Python打包或ZIP。native保留文件句柄请求READ_CONTROL/WRITE_DAC/DELETE/FILE_READ_ATTRIBUTES且不共享删除；CRT新读句柄不共享删除，因既有句柄的DELETE访问而冲突。最小修复移除保留句柄不使用的DELETE访问，继续不共享FILE_SHARE_DELETE；测试同时检查可读和ren仍被阻止。

单纯移除DELETE后，type确实可读，但ren返回成功且未满足预期拒绝；当次在状态断言前停止，不能据退出码单独认证物理保护。该仅元数据访问方案已弃用、未提交。改为FILE_READ_DATA（只读数据访问）使共享保留有效，并继续不共享删除后，读取通过、ren实际child-failed，原文件内容保持且目标不存在；随后补核对dev/ino不变。原保护断言保留。

当前方案串行验证2/2：已有文件可读，重命名拒绝、内容/文件身份不变、目标不存在；原E3 cwd/根/链接/hardlink拒绝保持。原生E1环境/文件/网络与J5不向外部hardlink/reparse目标传播SID共2/2保持。一次与运行时探针重叠的测试遇到全局恢复锁EXEC_ACL_RECOVERY_REQUIRED，探针正常清理后按相同断言串行通过；未删除journal或放宽恢复条件。源码构建0.1.0+local.768e8d13e4fe。

相同临时Python依赖在现有E1下真正运行unittest：错误代码AssertionError，修正后Ran 1 test / OK，退出0。默认Node --test仍30秒墙钟终止。查到对应[Node上游问题66374](https://github.com/nodejs/node/issues/66374)与[libuv修复5181](https://github.com/libuv/libuv/pull/5181)：AppContainer中的旧libuv创建子进程pipe/IPC使用非LOCAL命名空间，在ERROR_ACCESS_DENIED循环重试；不是增加项目读权限能解决。2026-10-20核对官方dist索引最新v26.12.0仍uv1.52.1，不能假设升级已发布Node就能修好。保留该阻塞，不能静默注入--test-isolation=none、取消隔离或把临时SDK复制称为产品支持。

## E1中文输出与命令语义

真实同一命令中的cmd echo中文先出现替代符，Node中文stdout/stderr正确，确认OEM/UTF-8混合。仅chcp65001显示设置成功，当前cmd却仍按旧页转换；加嵌套cmd虽令中文通过，却在直接引用中文/空格可执行路径、复杂参数时破坏引号并返回255，因此两种shell前缀方案均弃用。

最终不追加/重解析shell文本：launcher原CREATE_NO_WINDOW给host私有隐藏console，在host用SetConsoleCP/SetConsoleOutputCP设65001，E1继承它，E3仍detached。依据微软[console code pages](https://learn.microsoft.com/en-us/windows/console/console-code-pages)与[创建标志](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags)，实际验证中文混合输出、版本、保留锁、直接引用可执行文件/参数、中文空格cwd及退出7共4/4；E1原网络/数据/环境负向1/1，真实停止1/1（1.696秒）。源码构建0.1.0+local.d8ed84e25321。D04测试曾第二次读取被写中的heartbeat而JSON空，改为使用waitFor已验证的同一快照；5秒、PID消失及停止后不写断言保持，未增加等待上限。

## 持久终端结果与尚未闭合的观察测试

原服务丢弃handle.completed结果，facade把所有native非running投影exited/null。新增公共service/facade结果用例先red；现保存真实exitCode/reason，终止等待结算，区分0/7/限制/native-failed。相关公共边界11/11、产品74+UI15通过；真实长任务64.292秒，stdin正确、另一Session误投拒绝、1600行连续分页取回且末行一次、exit7；真实父子写入进程停止<5秒，独立进程存活。旧truncated包含“尚有后页”，工具文案现与实际保留窗口分开，不扩展全局输出上限。

同时完整运行execution-isolation与terminal-owner两文件60项，57通过、3失败：manual runtime denial observation、direct terminal denial observation、terminal owner denial observation，均EXEC_NATIVE_EVIDENCE_UNAVAILABLE。manual用原命名单独执行仍失败，不能归为并发；native已接受request_valid后未生成认证观察，尚未定位到具体步骤。真实执行/停止证明与此不同，不能互相代替。未清除journal/密钥、未修改身份/签名验证、未降级成未认证证据。相关11项聚焦通过只覆盖输出/输入/所有者/取消，不表示这3项已恢复，保留为A03/D13整体验证缺口。
