# D13：43新增 / 2过期调用的有界核对

2026-10-20；基于9f34ac5源码，只核对当前gate报错范围，保持扫描器、policy验证和构建前置。不是完整安全认证，也不把这些功能重新设为全部历史治理任务。

| 文件/函数 | 新增数 | 已核对边界 | 本次处置及缺口 |
|---|---:|---|---|
| electron/main.cjs 顶层require(node:url) | 1 | 固定Node内建模块，无模型提供的模块名/路径；D01/D03真实启动已执行 | 登记static-module-loader，保留source/packaged证据归属 |
| electron/main.cjs startServerProcess | 1 | commandLease、argumentLeases、importLease在受管cwd回调内再次verify；固定--import参数，pathToFileURL编码，shell:false、windowsHide:true、consent IPC | 替换旧spawn节点ID，沿用原bootstrap-adapter及操作数约束；源码启动有证据，当前包仍待安装验证 |
| src/attachment-reader.ts readAttachmentDocument | 1 | 固定import('./attachment-store.js')，读取由真实invocation会话ID限定，附件已绑定原消息；产品附件分页/跨会话拒绝通过 | 登记static-module-loader，dispatcher/packaged证据归属；没有给新路径或执行授权 |
| src/browser.ts firstExecutable | 1 | 候选来自固定系统位置或宿主环境设置；动态导入Node fs后access探测 | 尚未登记；A07需核对可执行文件选择与实际fs访问的审计覆盖，不能只批准import便声称全部访问已验证 |
| src/browser.ts CdpBrowserBackend.#connect / close | 3 | 随机临时profile、固定CDP参数，记录spawned进程，close杀进程后rm | 尚未登记；需要复用受管临时目录/进程所有权并验证真实退出及目录释放，不能只SIGTERM后立即删除。归A07及本gate |
| src/browser.ts BrowserSessionManager.screenshot | 2 | 会话ID哈希目录、宿主生成文件名、wx、返回sha；模型不能指定任意目标路径 | 尚未登记；目录祖先重定向与写入租约未证实，需受管写入与重定向用例。归A07/A08 |
| src/media.ts MediaJobManager.#recover | 3 | 应用固定jobs目录、Dirent文件筛选、JOB_ID检查 | 尚未登记；根祖先、数据文件身份/重定向未接现有受管存储。Media保持冻结，只处理打包所需边界，不扩生成能力 |
| src/media.ts #persist 内write | 4 | 串行写队列、随机临时名、任务ID子路径 | 尚未登记；直接mkdir/write/rm/rename，先rm旧记录再rename有崩溃窗口，缺受管原子替换及恢复验证 |
| src/media.ts #saveArtifact | 2 | 固定files/jobId目录、随机artifactId、格式/体积上限、wx | 尚未登记；根祖先重定向与受管落盘未验证 |
| src/playbook.ts ensureRoots/assertDirectory/atomicJson/readJson/loadProjectFrom/listRoot | 12 | 固定active/archive根，exactId限制名称，项目目录lstat，包格式验证 | 尚未登记；根祖先与文件读写仍直接fs，需现有受管存储及重定向/冲突验证。归D11与本gate |
| src/playbook.ts createPlaybook/appendLog | 6 | exactId、新建wx、运行中状态与追加日志 | 尚未登记；同上，失败清理/日志边界须覆盖真实目录身份 |
| src/playbook.ts executeActive | 1 | 选定项目sourcePath、runSignal、受控lux上下文 | 尚未登记；在宿主进程动态import代码，lux globals本身不隔离Node API。D11需按新规格用既有Agent任务/既有隔离执行，不能给任意宿主JS直接盖章 |
| src/playbook.ts archivePlaybook/unarchivePlaybook/deletePlaybook | 5 | exactId、禁止运行中变更、目标重名检测 | 尚未登记；直接rename/rm与父目录身份、删除对象生命周期缺受管证明。归D11 |
| src/worker.ts StdioWorkerAdapter.constructor | 1 | 私有构造、stdio协议、超时/退出状态，Worker默认关闭 | 尚未登记；直接spawn executable/args/cwd并继承process.env，缺已有执行授权/环境范围/父取消清理归属。归A03/A05，不能用未隔离回退来通过 |

合计43。Playbook分组为24，Browser6、Media9、Worker1；三个已核实项单独登记，剩余40未认证。

## 两项过期绑定

- sink-c83e73b470e1688c7a07d1a7：main.startServerProcess旧spawn节点，已由核对过的新节点sink-7aa0d16801fc47c432aef929替换。
- sink-9bcf1e99e867cc31003dd4cf：imageHelperExec旧动态import已不在当前扫描集，删除无对应代码的登记。没有忽略新调用。

## 本次验证与下一步

仅增加固定ID的3项登记、移除固定ID的2项过期绑定；159条登记对应199个实际调用。`sec02-sink-inventory.mjs --check`仍按原语义拒绝，下一处为browser.ts:168，而非放行全部源码。原“新/未解析/过期拒绝”和“ASAR新增文件/同路径调用篡改拒绝”用例2/2通过；inventory本体未生成或标绿。

后续按上述现有边界逐组处理，优先附件/浏览器受管资源与Worker已有执行接口；Media仅修必要存储，Playbook按D11产品入口改造。当前仍是本地工程阻塞，不是模型密钥或干净机器阻塞。外部机器门槛另保留。
