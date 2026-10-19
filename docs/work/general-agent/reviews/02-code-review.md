# A02 分步审查

## 项目上下文切片（2026-10-20）

固定范围：22e1897至本轮工作树的read_repo、Bootstrap Git检测、general Persona及相关测试；先Standards后Spec，无委派。整票保持in-progress，编辑/差异/撤回尚未交付。

Standards：保留existing gateway与executable lease；固定只读Git参数、NUL路径协议、输出/数量/超时与取消边界保持。状态命令关闭可选索引写锁与fsmonitor，移除进程继承的Git根/索引覆盖变量；项目脚本仅展示。未跟踪内容遵循忽略规则；删除项不恢复，选定子目录的状态不泄露其他目录条目。自动Git检测只从标准安装和有限PATH候选选择通过现有检查的文件；拒绝的候选不执行，显式配置失效不回退。旧cwd越界、hardlink、junction、恶意文件名与输出预算负向已通过。

Spec：普通默认助手可按需发现read_repo；项目根/工作目录、类型、脚本、未提交/未跟踪/已删状态与中文空格路径有真实临时仓库证据。真实Electron普通对话发现→summary→all→回答1/1（交互20.962秒），文件和Git状态未变。局部Agent fixture沿用内置general允许列表，省略未安装的server-only管理hooks；桌面测试补齐完整实际入口。C04的读后写版本/多文件diff/撤回未在此切片实现，不能标A02 verified。

已知限制：Git工作树查询需要已安装Git，缺失会说明安装/重启，普通文件仍可读取；未递归读取submodule，二进制/大文件沿用明确限制。更完整项目指令作用域属A11，CLI执行属A03。

验证入口：产品repository-context3项、受影响旧read_repo负向1项、A02真实Electron1项；收尾check:product在票据记录。发现不存在剩余切片阻塞项，整票按后续编辑切片继续。

收尾：check:product66/66、UI/IPC15/15通过。只维护runGitQuery受影响的execFile登记，159条对应199调用，未认证40、过期0；新/未解析/过期与ASAR篡改负向2/2保持。D13原gate与其余未认证调用不变。
