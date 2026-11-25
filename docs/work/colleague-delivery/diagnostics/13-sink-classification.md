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

## A02受影响登记维护（2026-10-20）

read_repo把runGitLsFiles扩为固定四种只读查询runGitQuery；该execFile从sink-fbebe1312d594532f0d822df变为sink-b8c178a4d8f83a7f4502dcda。仅替换这一条已核实登记及对应anchor，继续使用runtime-executable-lease、fixed-reviewed-argv、authority-canonical-cwd、shell:false。查询关闭可选索引锁和fsmonitor，实际路径仍经原gateway；原repo-oracle负向1/1、真实默认Electron1/1已通过。新/未解析/过期拒绝与ASAR篡改拒绝2/2保持。

当前scanner199、binding159、未认证40、过期0；未注册其他调用，未修改scanner、验证器或打包gate，也未把旧inventory重生成为通过状态。


## 2026-11-25 當前候選核對

以 `demo/2026-10-16` 的實際工作樹為基線。使用 `%TEMP%\rainydays-d13-inventory-audit-20261125.mjs` 呼叫原掃描器與交叉檢查，輸出按檔案分組的改前及改後 JSON。盤點包含五個未追蹤的桌面來源／測試檔案。

| 清單 | 改前 | 處置 | 改後 |
| --- | --- | --- | --- |
| SEC-02 | 228 個掃描點，159 筆登記。69 未登記、20 受管匯入未核准、1 語法違規。掃描器無 unresolved call，無過期登記。 | 補登記 13 個呼叫與 6 個模組匯入；下載改經 PathPolicy，移除 1 個動態匯入呼叫及其交叉檢查違規。 | 227 個掃描點、172 筆登記。55 未登記、13 受管匯入未核准、1 語法違規；無過期登記。 |
| SEC-03 | 640 個掃描點。85 未分類、56 筆過期、1 語法違規。 | 核准 67 個精確呼叫，刪除 56 筆舊身分，重產保留違規的清單。 | 640 個掃描點。18 未分類、1 語法違規、無過期登記。 |

正式 SEC-02 清單仍需全量通過原產生器。新增登記的 `packaged-asar` 是既有證據歸屬，本輪未產包或執行該證據。以下逐條列出基線差異；同一行多個呼叫以欄位或 API 區分。

### SEC-02 改前差異與處置

**`src/browser.ts`**

| 行:欄 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `2:1` | `UNAPPROVED_GOVERNED_IMPORT` `node:child_process` | 保留拒絕 | 程式啟動仍用 Chrome/Edge 平台候選與宿主環境覆寫；需執行檔租約與生命週期證據。 |
| `3:1` | `UNAPPROVED_GOVERNED_IMPORT` `node:fs/promises` | 保留拒絕 | 同檔的目錄建立、刪除、截圖寫入尚無完整受管路徑證據。 |
| `255:28` | `UNBOUND` `module-loader.import` | 登記 | 固定 Node 內建匯入；僅登記模組字串。執行檔探測與瀏覽器啟動的受管匯入仍待核對。 |
| `255:28` | `UNAPPROVED_GOVERNED_IMPORT` `node:fs/promises` | 保留交叉檢查拒絕 | 程式啟動仍用 Chrome/Edge 平台候選與宿主環境覆寫；需執行檔租約與生命週期證據。 |
| `335:31` | `UNBOUND` `node-fs.mkdtemp` | 保留拒絕 | 啟動瀏覽器用 OS temp 下的隨機 profile；根與清理尚缺完整目錄租約。 |
| `347:21` | `UNBOUND` `child-process.spawn` | 保留拒絕 | 只從平台清單或宿主覆寫取 executable。argv 由宿主組裝，但啟動前未取得檔案租約，退出與清理尚未完整驗證。 |
| `364:13` | `UNBOUND` `node-fs.mkdir` | 保留拒絕 | 本次程序的 I/O 根下固定 downloads 子目錄。建立仍直接 mkdir；下載讀取已改經 PathPolicy。 |
| `383:45` | `UNBOUND` `node-fs.mkdtemp` | 保留拒絕 | I/O 目錄名由宿主產生，仍依賴未綁定的 OS temp 祖先。 |
| `505:29` | `UNBOUND` `node-fs.rm` | 保留拒絕 | 遞迴清掉本次 I/O 目錄；目前缺目錄身分複核與瀏覽器停止後清理的證據。 |
| `509:34` | `UNBOUND` `node-fs.rm` | 保留拒絕 | 遞迴清掉啟動 profile；目前只發 SIGTERM，尚未等退出並複核目錄身分。 |
| `678:11` | `UNBOUND` `node-fs.mkdir` | 保留拒絕 | 每次上傳使用本次 I/O 根加隨機子目錄；尚無受管建立與上傳期間的身分證據。 |
| `699:38` | `UNBOUND` `module-loader.import` | 改實現 | 移除動態 fs 匯入與 stat/readFile。驗證 CDP GUID，下載啟用前綁定唯讀目錄，讀取時由 PathPolicy 驗證身分及限量。 |
| `699:38` | `UNAPPROVED_GOVERNED_IMPORT` `node:fs/promises` | 改實現 | 移除動態 fs 匯入與 stat/readFile。驗證 CDP GUID，下載啟用前綁定唯讀目錄，讀取時由 PathPolicy 驗證身分及限量。 |
| `941:11` | `UNBOUND` `node-fs.mkdir` | 保留拒絕 | 使用宿主 userData 與 Session 雜湊；建立目錄仍未綁定祖先身分。 |
| `943:11` | `UNBOUND` `node-fs.writeFile` | 保留拒絕 | 固定截圖名與 wx 只允許新建；檔案提交前仍缺 PathPolicy 的目錄身分複核。 |

**`src/command-encoding.ts`**

| 行:欄 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `1:1` | `UNAPPROVED_GOVERNED_IMPORT` `node:child_process` | 核准匯入 | 從 BootstrapPathStore 取得固定 System32\chcp.com 的受管可執行檔租約；spawn 前核對，空 argv，shell 關閉，失敗回 UTF-8。 |
| `13:20` | `UNBOUND` `child-process.spawnSync` | 改實現並登記到第 17 行 | 從 BootstrapPathStore 取得固定 System32\chcp.com 的受管可執行檔租約；spawn 前核對，空 argv，shell 關閉，失敗回 UTF-8。 |

**`src/desktop/desktop-helper.ts`**

| 行:欄 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `7:1` | `UNAPPROVED_GOVERNED_IMPORT` `node:child_process` | 保留拒絕 | PowerShell helper 與 desktop_launch 皆為指定保留的未追蹤來源；暫不認證。 |
| `8:1` | `UNAPPROVED_GOVERNED_IMPORT` `node:fs/promises` | 保留拒絕 | helper 暫存腳本的建立、讀取身分與清理需確認，檔案在指定保留範圍。 |
| `38:29` | `UNBOUND` `node-fs.mkdtemp` | 保留拒絕 | helper 使用隨機 OS temp 目錄，尚待驗證目錄租約；指定保留範圍。 |
| `40:11` | `UNBOUND` `node-fs.writeFile` | 保留拒絕 | 寫入固定 helper.ps1 與內嵌腳本，使用 wx。需驗證 PowerShell 讀腳本前的身分；指定保留範圍。 |
| `45:21` | `UNBOUND` `child-process.spawn` | 保留拒絕 | PowerShell binary 有 Bootstrap 租約，腳本檔案仍來自直接寫入的暫存路徑；指定保留範圍。 |
| `114:32` | `UNBOUND` `node-fs.rm` | 保留拒絕 | close 會清除 helper 暫存目錄，需原始目錄身分與生命週期證據；指定保留範圍。 |

**`src/developer-execution.ts`**

| 行:欄 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `7:1` | `UNAPPROVED_GOVERNED_IMPORT` `node:child_process` | 保留拒絕 | A15 僅在已啟用開發模式，並由 Broker 的命令授權及執行根供應 cwd。仍以宿主 ComSpec 或名稱搜尋選擇直啟 shell，需固定受管執行檔。 |
| `110:17` | `UNBOUND` `child-process.spawn` | 保留拒絕 | A15 僅在已啟用開發模式，並由 Broker 的命令授權及執行根供應 cwd。仍以宿主 ComSpec 或名稱搜尋選擇直啟 shell，需固定受管執行檔。 |

**`src/developer-terminal.ts`**

| 行:欄 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `7:1` | `UNAPPROVED_GOVERNED_IMPORT` `node:child_process` | 保留拒絕 | A15 僅在已啟用開發模式，並由 Broker 的命令授權及執行根供應 cwd。仍以宿主 ComSpec 或名稱搜尋選擇直啟 shell，需固定受管執行檔。 |
| `80:17` | `UNBOUND` `child-process.spawn` | 保留拒絕 | A15 僅在已啟用開發模式，並由 Broker 的命令授權及執行根供應 cwd。仍以宿主 ComSpec 或名稱搜尋選擇直啟 shell，需固定受管執行檔。 |

**`src/mcp/client.ts`**

| 行:欄 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `43:63` | `UNBOUND` `module-loader.import` | 登記 | 固定 `./oauth-store.js`，遠端連線開啟時檢查 OAuth 憑據。 |
| `45:47` | `UNBOUND` `module-loader.import` | 登記 | 固定 `./remote.js`，遠端連線必須持有 Broker 網路能力。 |

**`src/mcp/host.ts`**

| 行:欄 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `1:1` | `UNAPPROVED_GOVERNED_IMPORT` `express` | 核准匯入 | 固定 Express 型別匯入，TypeScript 產物會移除。路由仍由既有 Broker 入口註冊。 |
| `22:37` | `UNBOUND` `module-loader.import` | 登記 | 固定 `./client.js`，設定測試經 `mcp:test` 的直接呼叫入口。 |

**`src/mcp/oauth-browser.ts`**

| 行:欄 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `1:1` | `UNAPPROVED_GOVERNED_IMPORT` `node:child_process` | 核准匯入 | 設定登入入口經 Broker；URL 限 HTTPS 或回環 HTTP，拒絕帳密、片段與超長。受管 rundll32 租約，固定 URL handler 與單一 URL 引數，shell 關閉。 |
| `18:21` | `UNBOUND` `child-process.spawn` | 登記 | 設定登入入口經 Broker；URL 限 HTTPS 或回環 HTTP，拒絕帳密、片段與超長。受管 rundll32 租約，固定 URL handler 與單一 URL 引數，shell 關閉。 |

**`src/mcp/oauth-manager.ts`**

| 行:欄 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `29:75` | `UNBOUND` `module-loader.import` | 登記 | OAuth 開始流程載入固定 SDK `@modelcontextprotocol/sdk/client/auth.js`。 |
| `29:127` | `UNBOUND` `module-loader.import` | 登記 | OAuth 開始流程載入固定 `./oauth-provider.js`。 |
| `45:75` | `UNBOUND` `module-loader.import` | 登記 | OAuth 回呼先檢查待處理狀態，載入固定 SDK `@modelcontextprotocol/sdk/client/auth.js`。 |
| `45:127` | `UNBOUND` `module-loader.import` | 登記 | OAuth 回呼載入固定 `./oauth-provider.js` 同步授權狀態。 |

**`src/mcp/oauth-routes.ts`**

| 行:欄 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `1:1` | `UNAPPROVED_GOVERNED_IMPORT` `express` | 核准匯入 | 固定 Express 型別匯入，TypeScript 產物會移除。路由仍由既有 Broker 入口註冊。 |

**`src/mcp/remote.ts`**

| 行:欄 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `12:93` | `UNBOUND` `module-loader.import` | 登記 | 遠端傳輸載入固定 `./oauth-provider.js`，傳輸使用注入的網路閘道。 |

**`src/mcp/routes.ts`**

| 行:欄 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `1:1` | `UNAPPROVED_GOVERNED_IMPORT` `express` | 核准匯入 | 固定 Express 型別匯入，TypeScript 產物會移除。路由仍由既有 Broker 入口註冊。 |

**`src/mcp/runtime.ts`**

| 行:欄 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `57:37` | `UNBOUND` `module-loader.import` | 登記 | 已啟用且快照相符的 MCP 工具，按呼叫資源擁有者載入固定 `./client.js`。 |

**`src/mcp/stdio.ts`**

| 行:欄 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `1:1` | `UNAPPROVED_GOVERNED_IMPORT` `node:child_process` | 核准匯入 | 開發模式與啟用設定限制 command/argv。設定測試和模型工具均經 Broker 與執行根閘道給 canonical cwd。受管 PowerShell 執行固定 Job Object 腳本，啟動資料走私有環境欄位，子程序歸 task owner，shell 關閉。 |
| `33:28` | `UNBOUND` `child-process.spawn` | 登記 | 開發模式與啟用設定限制 command/argv。設定測試和模型工具均經 Broker 與執行根閘道給 canonical cwd。受管 PowerShell 執行固定 Job Object 腳本，啟動資料走私有環境欄位，子程序歸 task owner，shell 關閉。 |

**`src/media.ts`**

| 行:欄 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `2:1` | `UNAPPROVED_GOVERNED_IMPORT` `node:fs/promises` | 保留拒絕 | 整個 Media 儲存使用直接 fs，尚待遷移至受管儲存。 |
| `261:11` | `UNBOUND` `node-fs.mkdir` | 保留拒絕 | 啟動恢復建立固定 jobs 目錄；還未驗證祖先。 |
| `262:31` | `UNBOUND` `node-fs.readdir` | 保留拒絕 | 只枚舉 jobs，Dirent 限 JSON 檔；目錄未受管。 |
| `265:40` | `UNBOUND` `node-fs.readFile` | 保留拒絕 | 讀取後檢查 jobId；目標在枚舉到讀取間未維持身分。 |
| `286:13` | `UNBOUND` `node-fs.mkdir` | 保留拒絕 | 序列寫入佇列建立 jobs 父目錄；尚無路徑租約。 |
| `288:13` | `UNBOUND` `node-fs.writeFile` | 保留拒絕 | 以工作 ID 及 UUID 組裝暫存檔；尚無受管新建。 |
| `289:13` | `UNBOUND` `node-fs.rm` | 保留拒絕 | 先刪舊工作記錄再發布，存在崩潰間隙且缺目標身分複核。 |
| `290:13` | `UNBOUND` `node-fs.rename` | 保留拒絕 | 暫存轉正式記錄，需改用既有受管替換操作。 |
| `311:11` | `UNBOUND` `node-fs.mkdir` | 保留拒絕 | 固定 files/jobId 與宿主 ID；建立前需父路徑身分驗證。 |
| `313:11` | `UNBOUND` `node-fs.writeFile` | 保留拒絕 | 格式及大小有上限，隨機檔名用 wx；尚無受管提交。 |

**`src/observations.ts`**

| 行:欄 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `8:1` | `UNAPPROVED_GOVERNED_IMPORT` `node:fs` | 保留拒絕 | 截圖與檔案工具的同步快取使用直接 fs；路徑邊界尚待遷移。 |
| `76:3` | `UNBOUND` `node-fs.mkdirSync` | 保留拒絕 | Session 雜湊目錄固定在 userData；尚未綁定祖先身分。 |
| `77:9` | `UNBOUND` `node-fs.writeFileSync` | 保留拒絕 | 驗證 MIME、尺寸、摘要，使用 wx；尚未受管提交。 |
| `87:5` | `UNBOUND` `node-fs.rmSync` | 保留拒絕 | 只淘汰記憶體索引選出的同 Session 摘要，刪除前尚未複核檔案身分。 |
| `101:19` | `UNBOUND` `node-fs.readFileSync` | 保留拒絕 | 僅允許同 Session 索引且讀後比摘要；讀取本身缺路徑身分與讀取上限。 |

**`src/playbook.ts`**

| 行:欄 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `3:1` | `UNAPPROVED_GOVERNED_IMPORT` `node:fs/promises` | 保留拒絕 | 啟用、歸檔、執行紀錄及刪除使用直接 fs，需受管資料根。 |
| `140:22` | `UNBOUND` `node-fs.mkdir` | 保留拒絕 | 設定的 active/archive 根加固定名稱，各自遞迴建立；需受管祖先驗證。 |
| `140:65` | `UNBOUND` `node-fs.mkdir` | 保留拒絕 | 設定的 active/archive 根加固定名稱，各自遞迴建立；需受管祖先驗證。 |
| `148:22` | `UNBOUND` `node-fs.lstat` | 保留拒絕 | 專案目錄 lstat 排除最終目標連結；祖先及後續操作未綁定身分。 |
| `153:9` | `UNBOUND` `node-fs.mkdir` | 保留拒絕 | 由 run status、artifact、persist 路徑推得父目錄；無建立租約。 |
| `155:9` | `UNBOUND` `node-fs.writeFile` | 保留拒絕 | UUID 暫存 JSON；需受管新建與原子發布。 |
| `156:9` | `UNBOUND` `node-fs.rm` | 保留拒絕 | 先刪原 JSON；需消除崩潰窗口與複核刪除身分。 |
| `157:9` | `UNBOUND` `node-fs.rename` | 保留拒絕 | 暫存轉正式 JSON；需既有受管替換。 |
| `161:27` | `UNBOUND` `node-fs.readFile` | 保留拒絕 | 固定結構或驗證後的資料鍵，仍直接讀取。 |
| `186:56` | `UNBOUND` `node-fs.lstat` | 保留拒絕 | 專案固定 package.json / playbook.mjs，兩個 lstat 只核對當時檔案類型，後續讀取未綁身分。 |
| `186:76` | `UNBOUND` `node-fs.lstat` | 保留拒絕 | 專案固定 package.json / playbook.mjs，兩個 lstat 只核對當時檔案類型，後續讀取未綁身分。 |
| `189:24` | `UNBOUND` `node-fs.readFile` | 保留拒絕 | 從專案固定路徑讀腳本，讀後才檢查文字長度，尚未受管讀取。 |
| `209:29` | `UNBOUND` `node-fs.readdir` | 保留拒絕 | 在 active/archive 根列舉，限制 ID；根身分未受管。 |
| `240:13` | `UNBOUND` `node-fs.mkdir` | 保留拒絕 | 模型名稱先轉合法 ID，固定 active 子目錄；新建需受管。 |
| `256:7` | `UNBOUND` `node-fs.writeFile` | 保留拒絕 | 固定 package.json 並 wx；新建需受管。 |
| `257:7` | `UNBOUND` `node-fs.writeFile` | 保留拒絕 | 固定 playbook.mjs 並 wx，內容可由工具提供；新建需受管。 |
| `260:11` | `UNBOUND` `node-fs.rm` | 保留拒絕 | 失敗後刪除本次專案目錄；遞迴清理前未重驗身分。 |
| `306:9` | `UNBOUND` `node-fs.mkdir` | 保留拒絕 | 固定 run ID 路徑建立日誌目錄；尚未受管。 |
| `307:9` | `UNBOUND` `node-fs.appendFile` | 保留拒絕 | 固定 logs.txt；制約日誌尾長，追加前尚未驗證檔案身分。 |
| `455:28` | `UNBOUND` `module-loader.import` | 保留拒絕 | playbook_create 接受腳本文字；playbook_execute 選定專案後在應用宿主匯入。lux API 與取消器無法隔離 Node 模組。現有 Script 執行介面缺這套 lux 回呼契約，保留拒絕。 |
| `455:28` | `UNSUPPORTED_RUNTIME_DIALECT` `non-literal dynamic import` | 保留拒絕 | playbook_create 接受腳本文字；playbook_execute 選定專案後在應用宿主匯入。lux API 與取消器無法隔離 Node 模組。現有 Script 執行介面缺這套 lux 回呼契約，保留拒絕。 |
| `567:15` | `UNBOUND` `node-fs.lstat` | 保留拒絕 | 歸檔前查目標是否存在；與 rename 未共用受管身分。 |
| `568:9` | `UNBOUND` `node-fs.rename` | 保留拒絕 | 以同一驗證 ID 在 active/archive 間移動；需受管移動。 |
| `579:15` | `UNBOUND` `node-fs.lstat` | 保留拒絕 | 還原前查目標是否存在；與 rename 未共用受管身分。 |
| `580:9` | `UNBOUND` `node-fs.rename` | 保留拒絕 | 以同一驗證 ID 還原；需受管移動。 |
| `588:9` | `UNBOUND` `node-fs.rm` | 保留拒絕 | 驗證 ID 與非運行狀態後遞迴刪除；尚缺目標生命週期保護。 |

**`src/tools/browser-tools.ts`**

| 行:欄 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `3:1` | `UNAPPROVED_GOVERNED_IMPORT` `node:fs/promises` | 保留拒絕 | browser_upload 經 invocation.path 讀批准的單檔，清理檔名後用 wx 寫 Session 內副本。上傳暫存根與寫入身分仍待受管。 |
| `179:9` | `UNBOUND` `node-fs.writeFile` | 保留拒絕 | browser_upload 經 invocation.path 讀批准的單檔，清理檔名後用 wx 寫 Session 內副本。上傳暫存根與寫入身分仍待受管。 |

**`src/tools/desktop-tools.ts`**

| 行:欄 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `7:1` | `UNAPPROVED_GOVERNED_IMPORT` `node:child_process` | 保留拒絕 | PowerShell helper 與 desktop_launch 皆為指定保留的未追蹤來源；暫不認證。 |
| `181:19` | `UNBOUND` `child-process.spawn` | 保留拒絕 | 固定 Windows 應用清單，普通檔案／目錄參數先經閘道。執行檔本身未取得租約，指定保留範圍。 |

**`src/worker.ts`**

| 行:欄 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `1:1` | `UNAPPROVED_GOVERNED_IMPORT` `node:child_process` | 保留拒絕 | worker_connect 可指定 executable、argv 和 cwd，local 預設也走此 spawn。Broker 有程序批准，適配層仍繼承完整環境且未將 executable/cwd 接同一執行閘道；需 Worker 隔離與清理責任確認。 |
| `68:20` | `UNBOUND` `child-process.spawn` | 保留拒絕 | worker_connect 可指定 executable、argv 和 cwd，local 預設也走此 spawn。Broker 有程序批准，適配層仍繼承完整環境且未將 executable/cwd 接同一執行閘道；需 Worker 隔離與清理責任確認。 |

### SEC-03 改前差異與處置

**`electron/main.cjs`**

| 改前行號 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `210` | `ALLOWLIST_DRIFT` `process-environment.process.env` | 移除舊登記 | 舊精確身分 `exec-d59783cea970f275eb230a77` 匹配 0 處；下方現有呼叫各自核對。 |
| `264` | `ALLOWLIST_DRIFT` `child-process.spawn` | 移除舊登記 | 舊精確身分 `exec-1e241547198e041ef3d6c8b3` 匹配 0 處；下方現有呼叫各自核對。 |
| `264` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | Electron 以選定的數值 port 探測固定回環 readiness 路徑，使用專用 API token。 |
| `384` | `UNCLASSIFIED_EXECUTION_SINK` `child-process.spawn` | 登記 `fixed-purpose-production` | 事先核對 server、command 和可選 loader 租約，再於受管 cwd 內重新核對後啟動。shell 關閉，啟動狀態與 consent IPC 綁定。 |
| `804` | `ALLOWLIST_DRIFT` `child-process.spawn` | 移除舊登記 | 舊精確身分 `exec-73773f4ce2e5df4b35010c49` 匹配 0 處；下方現有呼叫各自核對。 |
| `836` | `ALLOWLIST_DRIFT` `process-environment.process.env` | 移除舊登記 | 舊精確身分 `exec-dfab20a8bc7fb2744db2973f` 匹配 0 處；下方現有呼叫各自核對。 |
| `1344` | `UNCLASSIFIED_EXECUTION_SINK` `child-process.spawn` | 登記 `fixed-purpose-production` | 終止應用擁有的 server child；受管 System32 taskkill，固定 /pid /T /F，spawn 前後複核。 |
| `1414` | `UNCLASSIFIED_EXECUTION_SINK` `process-environment.process.env` | 登記 `fixed-purpose-production` | Electron bootstrap 只合併 runtimeEnvironment 組裝的 app、userData、build 與服務識別設定。 |

**`native/sandbox-host/sandbox-host.cpp`**

| 改前行號 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `870` | `ALLOWLIST_DRIFT` `native-addon.CreateAppContainerProfile` | 移除舊登記 | 舊精確身分 `exec-c9d35575ff853bda23e37e70` 匹配 0 處；下方現有呼叫各自核對。 |
| `870` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.CreateAppContainerProfile` | 登記 `native-host-adapter` | 受驗證 E1–E4 啟動要求，宿主自行產生 profile，零能力 AppContainer。 |
| `871` | `ALLOWLIST_DRIFT` `native-addon.DeleteAppContainerProfile` | 移除舊登記 | 舊精確身分 `exec-060e2fcac83011efb6e16c36` 匹配 0 處；下方現有呼叫各自核對。 |
| `871` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.DeleteAppContainerProfile` | 登記 `native-host-adapter` | 僅清理此次 Run 建立的 profileName，依分支回收資源。 |
| `872` | `ALLOWLIST_DRIFT` `native-addon.DeleteAppContainerProfile` | 移除舊登記 | 舊精確身分 `exec-78475e0910417c02f0285f65` 匹配 0 處；下方現有呼叫各自核對。 |
| `872` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.DeleteAppContainerProfile` | 登記 `native-host-adapter` | 僅清理此次 Run 建立的 profileName，依分支回收資源。 |
| `876` | `ALLOWLIST_DRIFT` `native-addon.DeleteAppContainerProfile` | 移除舊登記 | 舊精確身分 `exec-b64380d1e80098ed64c97e65` 匹配 0 處；下方現有呼叫各自核對。 |
| `876` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.DeleteAppContainerProfile` | 登記 `native-host-adapter` | 僅清理此次 Run 建立的 profileName，依分支回收資源。 |
| `887` | `ALLOWLIST_DRIFT` `native-addon.DeleteAppContainerProfile` | 移除舊登記 | 舊精確身分 `exec-dff88c8d3a9c2c74cbe86e59` 匹配 0 處；下方現有呼叫各自核對。 |
| `887` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.DeleteAppContainerProfile` | 登記 `native-host-adapter` | 僅清理此次 Run 建立的 profileName，依分支回收資源。 |
| `903` | `ALLOWLIST_DRIFT` `native-addon.DeleteAppContainerProfile` | 移除舊登記 | 舊精確身分 `exec-d2ec7e5968b99408b2a0a952` 匹配 0 處；下方現有呼叫各自核對。 |
| `903` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.DeleteAppContainerProfile` | 登記 `native-host-adapter` | 僅清理此次 Run 建立的 profileName，依分支回收資源。 |
| `905` | `ALLOWLIST_DRIFT` `native-addon.CreateJobObjectW` | 移除舊登記 | 舊精確身分 `exec-4f390d4acb11b2294b5f3da1` 匹配 0 處；下方現有呼叫各自核對。 |
| `905` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.CreateJobObjectW` | 登記 `native-host-adapter` | 由受驗證的 Run 建立匿名 Job 供這次子程序使用。 |
| `906` | `ALLOWLIST_DRIFT` `native-addon.SetInformationJobObject` | 移除舊登記 | 舊精確身分 `exec-d65707802afb4017c2a40745` 匹配 0 處；下方現有呼叫各自核對。 |
| `906` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.SetInformationJobObject` | 登記 `native-host-adapter` | 套用本次 profile 驗證後的 CPU、記憶體、程序數與 kill-on-close 限制。 |
| `907` | `ALLOWLIST_DRIFT` `native-addon.DeleteAppContainerProfile` | 移除舊登記 | 舊精確身分 `exec-582790794cda8b80a6f7ea8f` 匹配 0 處；下方現有呼叫各自核對。 |
| `907` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.DeleteAppContainerProfile` | 登記 `native-host-adapter` | 僅清理此次 Run 建立的 profileName，依分支回收資源。 |
| `912` | `ALLOWLIST_DRIFT` `native-addon.CreatePseudoConsole` | 移除舊登記 | 舊精確身分 `exec-a86d63733d05ef83c69f568f` 匹配 0 處；下方現有呼叫各自核對。 |
| `912` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.CreatePseudoConsole` | 登記 `native-host-adapter` | 僅 persistent E2/E4 使用此 Run 的成對管線與 ConPTY。 |
| `919` | `ALLOWLIST_DRIFT` `native-addon.ClosePseudoConsole` | 移除舊登記 | 舊精確身分 `exec-161f2e1216e2257c60212545` 匹配 0 處；下方現有呼叫各自核對。 |
| `919` | `ALLOWLIST_DRIFT` `native-addon.DeleteAppContainerProfile` | 移除舊登記 | 舊精確身分 `exec-d2eb7957e708d8a1cc63cc35` 匹配 0 處；下方現有呼叫各自核對。 |
| `919` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.ClosePseudoConsole` | 登記 `native-host-adapter` | 關閉此 Run 取得的 ConPTY；不同失敗或完成分支各有一次。 |
| `919` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.DeleteAppContainerProfile` | 登記 `native-host-adapter` | 僅清理此次 Run 建立的 profileName，依分支回收資源。 |
| `924` | `ALLOWLIST_DRIFT` `native-addon.ClosePseudoConsole` | 移除舊登記 | 舊精確身分 `exec-07db68dbcb61c3f1f87ad0a3` 匹配 0 處；下方現有呼叫各自核對。 |
| `924` | `ALLOWLIST_DRIFT` `native-addon.DeleteAppContainerProfile` | 移除舊登記 | 舊精確身分 `exec-87673dedc8b7d70d46f3b4e0` 匹配 0 處；下方現有呼叫各自核對。 |
| `924` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.ClosePseudoConsole` | 登記 `native-host-adapter` | 關閉此 Run 取得的 ConPTY；不同失敗或完成分支各有一次。 |
| `924` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.DeleteAppContainerProfile` | 登記 `native-host-adapter` | 僅清理此次 Run 建立的 profileName，依分支回收資源。 |
| `930` | `ALLOWLIST_DRIFT` `native-addon.ClosePseudoConsole` | 移除舊登記 | 舊精確身分 `exec-944ca70ed26a7ee736908279` 匹配 0 處；下方現有呼叫各自核對。 |
| `930` | `ALLOWLIST_DRIFT` `native-addon.DeleteAppContainerProfile` | 移除舊登記 | 舊精確身分 `exec-6dd222afa0e3b19bf78f3df8` 匹配 0 處；下方現有呼叫各自核對。 |
| `930` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.ClosePseudoConsole` | 登記 `native-host-adapter` | 關閉此 Run 取得的 ConPTY；不同失敗或完成分支各有一次。 |
| `930` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.DeleteAppContainerProfile` | 登記 `native-host-adapter` | 僅清理此次 Run 建立的 profileName，依分支回收資源。 |
| `933` | `ALLOWLIST_DRIFT` `native-addon.ClosePseudoConsole` | 移除舊登記 | 舊精確身分 `exec-d7950f40f38f9b871b286019` 匹配 0 處；下方現有呼叫各自核對。 |
| `933` | `ALLOWLIST_DRIFT` `native-addon.DeleteAppContainerProfile` | 移除舊登記 | 舊精確身分 `exec-6fdc91901f4f05ac6e307f2f` 匹配 0 處；下方現有呼叫各自核對。 |
| `933` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.ClosePseudoConsole` | 登記 `native-host-adapter` | 關閉此 Run 取得的 ConPTY；不同失敗或完成分支各有一次。 |
| `933` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.DeleteAppContainerProfile` | 登記 `native-host-adapter` | 僅清理此次 Run 建立的 profileName，依分支回收資源。 |
| `959` | `ALLOWLIST_DRIFT` `child-process.CreateProcessW` | 移除舊登記 | 舊精確身分 `exec-cb1e11bb8b8770de9e85ad02` 匹配 0 處；下方現有呼叫各自核對。 |
| `962` | `UNCLASSIFIED_EXECUTION_SINK` `child-process.CreateProcessW` | 登記 `native-host-adapter` | 驗證 profile、可執行檔與 cwd，使用受管環境、受限 AppContainer、明確 attributes 與懸停建立；E1 由專用 console 設 UTF-8。 |
| `963` | `ALLOWLIST_DRIFT` `native-addon.AssignProcessToJobObject` | 移除舊登記 | 舊精確身分 `exec-4ec571a1d78e5ad2a1f7e657` 匹配 0 處；下方現有呼叫各自核對。 |
| `966` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.AssignProcessToJobObject` | 登記 `native-host-adapter` | 掛入此 Run 的 Job 後才恢復懸停子程序。 |
| `983` | `ALLOWLIST_DRIFT` `native-addon.ClosePseudoConsole` | 移除舊登記 | 舊精確身分 `exec-60fca6bf3b12838d20afa7db` 匹配 0 處；下方現有呼叫各自核對。 |
| `983` | `ALLOWLIST_DRIFT` `native-addon.DeleteAppContainerProfile` | 移除舊登記 | 舊精確身分 `exec-9de82e0a780a1abd7c2b8fd7` 匹配 0 處；下方現有呼叫各自核對。 |
| `984` | `ALLOWLIST_DRIFT` `native-addon.TerminateJobObject` | 移除舊登記 | 舊精確身分 `exec-9a80516b3589a7b7b9f0cbeb` 匹配 0 處；下方現有呼叫各自核對。 |
| `986` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.ClosePseudoConsole` | 登記 `native-host-adapter` | 關閉此 Run 取得的 ConPTY；不同失敗或完成分支各有一次。 |
| `986` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.DeleteAppContainerProfile` | 登記 `native-host-adapter` | 僅清理此次 Run 建立的 profileName，依分支回收資源。 |
| `987` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.TerminateJobObject` | 登記 `native-host-adapter` | 針對此 Run 的 Job 做失敗、取消或到期退場。 |
| `1010` | `ALLOWLIST_DRIFT` `native-addon.TerminateJobObject` | 移除舊登記 | 舊精確身分 `exec-630a9b22d1d1be435569b1b8` 匹配 0 處；下方現有呼叫各自核對。 |
| `1013` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.TerminateJobObject` | 登記 `native-host-adapter` | 針對此 Run 的 Job 做失敗、取消或到期退場。 |
| `1017` | `ALLOWLIST_DRIFT` `native-addon.TerminateJobObject` | 移除舊登記 | 舊精確身分 `exec-f3b5dac869c3a9d831956ef0` 匹配 0 處；下方現有呼叫各自核對。 |
| `1018` | `ALLOWLIST_DRIFT` `native-addon.TerminateJobObject` | 移除舊登記 | 舊精確身分 `exec-fd4f5c05610194a3a2327cc0` 匹配 0 處；下方現有呼叫各自核對。 |
| `1020` | `ALLOWLIST_DRIFT` `native-addon.ClosePseudoConsole` | 移除舊登記 | 舊精確身分 `exec-6d5ed93dcf1c828ee3fffa1e` 匹配 0 處；下方現有呼叫各自核對。 |
| `1020` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.TerminateJobObject` | 登記 `native-host-adapter` | 針對此 Run 的 Job 做失敗、取消或到期退場。 |
| `1021` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.TerminateJobObject` | 登記 `native-host-adapter` | 針對此 Run 的 Job 做失敗、取消或到期退場。 |
| `1023` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.ClosePseudoConsole` | 登記 `native-host-adapter` | 關閉此 Run 取得的 ConPTY；不同失敗或完成分支各有一次。 |
| `1028` | `ALLOWLIST_DRIFT` `native-addon.DeleteAppContainerProfile` | 移除舊登記 | 舊精確身分 `exec-c73d15a6d6913bbe450aaf1d` 匹配 0 處；下方現有呼叫各自核對。 |
| `1031` | `UNCLASSIFIED_EXECUTION_SINK` `native-addon.DeleteAppContainerProfile` | 登記 `native-host-adapter` | 僅清理此次 Run 建立的 profileName，依分支回收資源。 |

**`public/renderer.js`**

| 改前行號 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `429` | `ALLOWLIST_DRIFT` `network.fetch` | 移除舊登記 | 舊精確身分 `exec-fa5d600286e15f6781a75ec3` 匹配 0 處；下方現有呼叫各自核對。 |
| `439` | `ALLOWLIST_DRIFT` `network.fetch` | 移除舊登記 | 舊精確身分 `exec-532b079d464ce9a8d03912d1` 匹配 0 處；下方現有呼叫各自核對。 |
| `492` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 讀固定 Session pins 路徑；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `502` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 向固定 Session rollback 路徑送 POST；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `1094` | `ALLOWLIST_DRIFT` `network.fetch` | 移除舊登記 | 舊精確身分 `exec-2b07b7c0b342ce0430f48719` 匹配 0 處；下方現有呼叫各自核對。 |
| `1150` | `ALLOWLIST_DRIFT` `network.fetch` | 移除舊登記 | 舊精確身分 `exec-3008619bde9a5dff14ab5f67` 匹配 0 處；下方現有呼叫各自核對。 |
| `1205` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 固定 file roots API，帶 Session header；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `1284` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 固定 file list API，目錄查詢使用 URLSearchParams；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `1465` | `ALLOWLIST_DRIFT` `network.fetch` | 移除舊登記 | 舊精確身分 `exec-f6a706f99a5edd10f4756352` 匹配 0 處；下方現有呼叫各自核對。 |
| `1572` | `ALLOWLIST_DRIFT` `network.fetch` | 移除舊登記 | 舊精確身分 `exec-c3ee3d06a53cd845a55a3d25` 匹配 0 處；下方現有呼叫各自核對。 |
| `1598` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 固定 file content 寫入 API，使用 file viewer 路徑授權；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `1716` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 固定 file resolve API，路徑經 URL 編碼並由伺服器檢查；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `1901` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 讀固定 Session messages API 產出預覽；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `2026` | `ALLOWLIST_DRIFT` `network.fetch` | 移除舊登記 | 舊精確身分 `exec-28ccb2f989a20e1244ac3cb6` 匹配 0 處；下方現有呼叫各自核對。 |
| `2065` | `ALLOWLIST_DRIFT` `network.fetch` | 移除舊登記 | 舊精確身分 `exec-14a5d902166620b7b5783629` 匹配 0 處；下方現有呼叫各自核對。 |
| `2267` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 固定設定 API，以 revision 與來源設定檔儲存預設；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `2274` | `ALLOWLIST_DRIFT` `network.fetch` | 移除舊登記 | 舊精確身分 `exec-76c5386943a6b61872a292e7` 匹配 0 處；下方現有呼叫各自核對。 |
| `2323` | `ALLOWLIST_DRIFT` `network.fetch` | 移除舊登記 | 舊精確身分 `exec-7c23c2fa2fbb593106196260` 匹配 0 處；下方現有呼叫各自核對。 |
| `2339` | `ALLOWLIST_DRIFT` `network.fetch` | 移除舊登記 | 舊精確身分 `exec-51cbd23717a4c7e0f8e4920a` 匹配 0 處；下方現有呼叫各自核對。 |
| `2345` | `ALLOWLIST_DRIFT` `network.fetch` | 移除舊登記 | 舊精確身分 `exec-7bbf6f113bbd1b81c72c6d07` 匹配 0 處；下方現有呼叫各自核對。 |
| `2347` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 固定 shell 設定 API，交設定的開發模式流程；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `2349` | `ALLOWLIST_DRIFT` `network.fetch` | 移除舊登記 | 舊精確身分 `exec-c071f68e2ba383dff624fc8a` 匹配 0 處；下方現有呼叫各自核對。 |
| `2372` | `ALLOWLIST_DRIFT` `network.fetch` | 移除舊登記 | 舊精確身分 `exec-15ce43e5c8744aac867db93f` 匹配 0 處；下方現有呼叫各自核對。 |
| `2384` | `ALLOWLIST_DRIFT` `network.fetch` | 移除舊登記 | 舊精確身分 `exec-3864690b02429b796e31f5e4` 匹配 0 處；下方現有呼叫各自核對。 |
| `2410` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 固定 general settings API；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `2418` | `ALLOWLIST_DRIFT` `network.fetch` | 移除舊登記 | 舊精確身分 `exec-c409160500213f79ab3cecb2` 匹配 0 處；下方現有呼叫各自核對。 |
| `2452` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 固定 provider 設定 API，編碼 profile 名稱；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `2494` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 固定伺服端 provider 測試 API；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `2684` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 固定 Session 清單讀取；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `2688` | `ALLOWLIST_DRIFT` `network.fetch` | 移除舊登記 | 舊精確身分 `exec-ffe624646cb2ec532f2d119d` 匹配 0 處；下方現有呼叫各自核對。 |
| `2733` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 固定 Session 建立 API；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `2736` | `ALLOWLIST_DRIFT` `network.fetch` | 移除舊登記 | 舊精確身分 `exec-56a9cd8b1429483221806d3d` 匹配 0 處；下方現有呼叫各自核對。 |
| `2753` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 固定 Session 選取 API；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `2770` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 固定 Persona 讀取 API；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `2774` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 固定 Session messages API，帶 Session header；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `2824` | `ALLOWLIST_DRIFT` `network.fetch` | 移除舊登記 | 舊精確身分 `exec-42fd00beab990d0cf99b3bdf` 匹配 0 處；下方現有呼叫各自核對。 |
| `2826` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 固定 Session 刪除 API；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `2840` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 刪除後使用固定 Session 建立 API 補新會話；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `2851` | `ALLOWLIST_DRIFT` `network.fetch` | 移除舊登記 | 舊精確身分 `exec-05f96d6b65e3f67c0e8f955b` 匹配 0 處；下方現有呼叫各自核對。 |
| `2906` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 固定 chat cancel API；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `2909` | `ALLOWLIST_DRIFT` `network.fetch` | 移除舊登記 | 舊精確身分 `exec-08ed20709e6475b25d1acc03` 匹配 0 處；下方現有呼叫各自核對。 |
| `3091` | `ALLOWLIST_DRIFT` `network.fetch` | 移除舊登記 | 舊精確身分 `exec-0b2c07f7773ae42c8bd683c5` 匹配 0 處；下方現有呼叫各自核對。 |
| `3163` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 固定 chat steer API；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `3235` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 固定 chat 串流 API；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `3344` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 由目前 Session 讀取固定 messages API；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `3579` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 固定 chat clear API；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `3611` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 固定 Session tasks API；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `3682` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 固定 status API；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |
| `3942` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 固定 AskUser answer API；相對 URL 走同源服務，伺服器限制 connect-src 與 base-uri。 |

**`src/browser.ts`**

| 改前行號 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `168` | `UNCLASSIFIED_EXECUTION_SINK` `network.WebSocket` | 保留拒絕 | WebSocket URL 可來自工具 cdpUrl 或回環 CDP 回應，現有檢查不足以綁定目標來源。 |
| `230` | `UNCLASSIFIED_EXECUTION_SINK` `network.createServer` | 登記 `fixed-purpose-production` | freePort 僅在 127.0.0.1 暫聽 OS 分配的端口，讀取後立即關閉。 |
| `267` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 保留拒絕 | 等候固定 loopback CDP 的 /json/version；需核對回環服務身分與 HTTP 重導行為。 |
| `347` | `UNCLASSIFIED_EXECUTION_SINK` `child-process.spawn` | 保留拒絕 | 只從平台清單或宿主覆寫取 executable。argv 由宿主組裝，但啟動前未取得檔案租約，退出與清理尚未完整驗證。 |
| `357` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 保留拒絕 | 固定 loopback /json/version 的回應供應 WebSocket 位址；需核對服務身分與端點。 |
| `403` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 保留拒絕 | 從固定 loopback CDP 列舉 /json/list，回應的目標位址仍待校驗與綁定。 |
| `480` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 保留拒絕 | 透過既有的 CDP 連線建立 about:blank，路徑固定；需確認 CDP 連線與重導邊界。 |
| `495` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 保留拒絕 | 僅關閉 owned target ID，已編碼；CDP 連線與重導仍待核對。 |
| `522` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 保留拒絕 | 目標 URL 驗證、編碼進固定 /json/new；CDP 連線與重導仍待核對。 |
| `536` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 保留拒絕 | 只關閉選定或 owned tab，ID 編碼；CDP 連線與重導仍待核對。 |
| `793` | `UNCLASSIFIED_EXECUTION_SINK` `network.WebSocket` | 保留拒絕 | Extension bridge URL 可由模型工具引數提供，僅核對 WebSocket scheme；需要可信端點約束。 |

**`src/command-encoding.ts`**

| 改前行號 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `13` | `UNCLASSIFIED_EXECUTION_SINK` `child-process.spawnSync` | 登記 `fixed-purpose-production` | 從 BootstrapPathStore 取得固定 System32\chcp.com 的受管可執行檔租約；spawn 前核對，空 argv，shell 關閉，失敗回 UTF-8。 |

**`src/daemon.ts`**

| 改前行號 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `192` | `ALLOWLIST_DRIFT` `network.fetch` | 移除舊登記 | 舊精確身分 `exec-45e92bf5a6d6ea1f346108d9` 匹配 0 處；下方現有呼叫各自核對。 |
| `192` | `UNCLASSIFIED_EXECUTION_SINK` `network.fetch` | 登記 `fixed-purpose-production` | 僅探測應用自己的固定 loopback readiness 路徑，新增整數端口範圍檢查與禁止 redirect，避免 API token 經重新導向。 |

**`src/desktop/desktop-helper.ts`**

| 改前行號 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `45` | `UNCLASSIFIED_EXECUTION_SINK` `child-process.spawn` | 保留拒絕 | PowerShell binary 有 Bootstrap 租約，腳本檔案仍來自直接寫入的暫存路徑；指定保留範圍。 |

**`src/developer-execution.ts`**

| 改前行號 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `43` | `UNCLASSIFIED_EXECUTION_SINK` `process-environment.process.env` | 保留拒絕 | 開發模式清掉 RainyDays/Electron 等宿主變數，仍繼承其餘主機環境。啟動邊界與環境白名單一起複核。 |
| `110` | `UNCLASSIFIED_EXECUTION_SINK` `child-process.spawn` | 保留拒絕 | A15 僅在已啟用開發模式，並由 Broker 的命令授權及執行根供應 cwd。仍以宿主 ComSpec 或名稱搜尋選擇直啟 shell，需固定受管執行檔。 |

**`src/developer-terminal.ts`**

| 改前行號 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `80` | `UNCLASSIFIED_EXECUTION_SINK` `child-process.spawn` | 保留拒絕 | A15 僅在已啟用開發模式，並由 Broker 的命令授權及執行根供應 cwd。仍以宿主 ComSpec 或名稱搜尋選擇直啟 shell，需固定受管執行檔。 |

**`src/mcp/oauth-browser.ts`**

| 改前行號 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `18` | `UNCLASSIFIED_EXECUTION_SINK` `child-process.spawn` | 登記 `fixed-purpose-production` | 設定登入入口經 Broker；URL 限 HTTPS 或回環 HTTP，拒絕帳密、片段與超長。受管 rundll32 租約，固定 URL handler 與單一 URL 引數，shell 關閉。 |

**`src/mcp/stdio.ts`**

| 改前行號 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `33` | `UNCLASSIFIED_EXECUTION_SINK` `child-process.spawn` | 登記 `fixed-purpose-production` | 開發模式與啟用設定限制 command/argv。設定測試和模型工具均經 Broker 與執行根閘道給 canonical cwd。受管 PowerShell 執行固定 Job Object 腳本，啟動資料走私有環境欄位，子程序歸 task owner，shell 關閉。 |

**`src/playbook.ts`**

| 改前行號 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `455` | `UNCLASSIFIED_EXECUTION_SINK` `unknown-execution-sink.computed-import` | 保留拒絕 | playbook_create 接受腳本文字；playbook_execute 選定專案後在應用宿主匯入。lux API 與取消器無法隔離 Node 模組。現有 Script 執行介面缺這套 lux 回呼契約，保留拒絕。 |
| `455` | `UNSUPPORTED_RUNTIME_DIALECT` `computed import is outside the finite dialect` | 保留拒絕 | playbook_create 接受腳本文字；playbook_execute 選定專案後在應用宿主匯入。lux API 與取消器無法隔離 Node 模組。現有 Script 執行介面缺這套 lux 回呼契約，保留拒絕。 |

**`src/tools/desktop-tools.ts`**

| 改前行號 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `181` | `UNCLASSIFIED_EXECUTION_SINK` `child-process.spawn` | 保留拒絕 | 固定 Windows 應用清單，普通檔案／目錄參數先經閘道。執行檔本身未取得租約，指定保留範圍。 |

**`src/tools/lux-cloud-tools.ts`**

| 改前行號 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `1173` | `UNCLASSIFIED_EXECUTION_SINK` `network.connect` | 登記 `fixed-purpose-production` | preview_web 的 Broker 網路批准，工具 schema 限 1–4 個有效端口；固定 127.0.0.1 TCP 探測，1 秒逾時，只回報就緒。 |

**`src/tools/read-repo.ts`**

| 改前行號 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `41` | `ALLOWLIST_DRIFT` `child-process.execFile` | 移除舊登記 | 舊精確身分 `exec-332fdc46a4d75dee93c8e1d8` 匹配 0 處；下方現有呼叫各自核對。 |
| `48` | `UNCLASSIFIED_EXECUTION_SINK` `process-environment.process.env` | 登記 `fixed-purpose-production` | 只把宿主環境傳給已限定的 Git 查詢，移除可改寫 worktree/index/object 根的變數。 |
| `51` | `UNCLASSIFIED_EXECUTION_SINK` `child-process.execFile` | 登記 `fixed-purpose-production` | 固定四個 Git 查詢、受管 Git executable 和 cwd、shell 關閉，停用 fsmonitor 與選擇性鎖。 |

**`src/worker.ts`**

| 改前行號 | 差異 | 處置 | 呼叫來源或依據 |
| --- | --- | --- | --- |
| `68` | `UNCLASSIFIED_EXECUTION_SINK` `child-process.spawn` | 保留拒絕 | worker_connect 可指定 executable、argv 和 cwd，local 預設也走此 spawn。Broker 有程序批准，適配層仍繼承完整環境且未將 executable/cwd 接同一執行閘道；需 Worker 隔離與清理責任確認。 |
| `72` | `UNCLASSIFIED_EXECUTION_SINK` `process-environment.process.env` | 保留拒絕 | worker_connect 可指定 executable、argv 和 cwd，local 預設也走此 spawn。Broker 有程序批准，適配層仍繼承完整環境且未將 executable/cwd 接同一執行閘道；需 Worker 隔離與清理責任確認。 |

### 實現變更與候選驗證

| 現行位置 | 類別 | 改法 |
| --- | --- | --- |
| `src/browser.ts:316`、`src/browser.ts:368`、`src/browser.ts:527` | 下載目錄授權 | 在 CDP 啟用下載前建立僅允許 read-file 的根授權，啟用失敗或關閉後端時撤銷。 |
| `src/browser.ts:381`、`src/browser.ts:719` | 下載識別及讀取 | 只接收符合 Chrome GUID 格式的檔名。已完成下載從本次連線的根授權限量讀取，移除直接 fs 動態匯入。 |
| `src/bootstrap-path-store.ts:233`、`src/command-encoding.ts:17` | 固定 OEM 探測程序 | 採用固定 Windows 系統 chcp.com 與既有可執行檔租約，取代 ComSpec 與命令尋找。 |
| `src/developer-execution.ts:71`、`src/developer-execution.ts:110` | OEM 探測呼叫者 | 等待受管探測，複核取消訊號，同一結果供兩個輸出解碼器。 |
| `src/developer-terminal.ts:72` | OEM 探測呼叫者 | 終端啟動改等候受管探測，在真正啟動前複核取消訊號。 |
| `src/daemon.ts:191`、`src/daemon.ts:195` | Daemon 回環探測 | PORT 限整數 1–65535，HTTP redirect 遇到即失敗。 |

| 驗收命令 | 結果 |
| --- | --- |
| `npm run governance:sec02:sinks` | 退出 1，`AssertionError [ERR_ASSERTION]: UNBOUND_SINK: src/browser.ts:338 node-fs.mkdtemp`。 |
| `node --test tests/contract/sec02-sink-inventory.test.mjs` | 預設程序隔離退出 1，`Error: spawn EPERM`。以 `NODE_OPTIONS=--experimental-test-isolation=none` 複核 17/19，兩個失敗為當前清單與受限匯入閉包。未登記／解析失敗／過期政策及 ASAR 增檔／同路徑修改負向用例均通過。 |
| `npm run governance:sec03:sinks` | 退出 1，`AssertionError [ERR_ASSERTION]: SEC-03 migration incomplete:`，18 個未分類與 1 個 Playbook 計算式匯入違規。 |
| `npm run test:sec03:contract` | 預設隔離退出 1（spawn EPERM）；相同命令以單程序模式退出 0，18/18。 |
| `npm run typecheck`、`npm run lint` | 兩項退出 0。 |
| `npm run test:product` | 預設隔離退出 1，40 個測試檔無法啟動（spawn EPERM）；單程序退出 1，4/43，esbuild 建立程序仍失敗，未取得可與 201/201 比較的完整結果。 |
| `npm run test:product:ui` | 預設隔離退出 1（spawn EPERM）；單程序退出 0，15/15。 |
| `npm run build`、`npm run test:package` | 兩道清單仍拒絕，未進入使用者指定的構建順序。原生構建、staging、Electron/NSIS、ASAR 實包與安裝測試均未執行。離線模型預檢四檔通過，未發生下載。 |
| `git diff --check` | 退出 0。 |

待確認包括未追蹤桌面來源的候選歸屬、Playbook 隔離後如何保留 lux 執行契約、Worker 的執行閘道，以及瀏覽器程序／檔案生命週期與 CDP/擴充端點邊界。Media、觀察快取與 Playbook 檔案均需接上受管存取。核對由本輪執行者順序進行。

### 第二輪複核

負責人移出五個桌面 WIP 檔案後，原掃描器的 SEC-02 起點為 222 個呼叫、50 個未登記、10 個未核准匯入、1 個 Playbook 計算匯入語法違規。SEC-03 起點為 636 個呼叫、16 個未分類、1 個 Playbook 語法違規。沿用 `%TEMP%\rainydays-d13-inventory-audit-20261125.mjs` 產生改前與改後的完整分組盤點。

| 呼叫點（改前或當前位置） | 第二輪處置與依據 |
| --- | --- |
| `src/browser.ts:257` 改前的 `firstExecutable` | 改用 `BootstrapPathStore.openBrowserExecutable` 驗證固定安裝候選或宿主環境指定的絕對路徑、檔案身分與內容。移除消失的固定 fs 匯入登記 `sink-a876da838de0ad0330e418bc`。 |
| `src/browser.ts:338,405,529,533` 改前的暫存建立／清除 | 由 PathPolicy 建立 UUID 子目錄與各自的根授權。啟動失敗與正常關閉走同一釋放路徑。Windows 受管終止已取得完整程序樹退出證據後才清理內容，失敗即撤銷權限並保留目錄。目錄清理走 PathPolicy 的列舉、刪除與 enrollment rollback。 |
| `src/browser.ts:367,702,968,970` 改前的下載目錄、上傳目錄、截圖寫入 | 下載及上傳使用暫存根下的受管子目錄。截圖使用固定 userData 根下的 Session 雜湊及唯一檔名，由 PathPolicy 新建。 |
| `src/browser.ts:432` `CdpBrowserBackend.#connect` | 核准 SEC-02/03 精確 spawn 及 SEC-02 `node:child_process` 匯入。Chrome/Edge 可執行檔持有 Bootstrap 租約，參數只含受管 profile、固定旗標和 headless 選項，shell 關閉。原 `freePort` 改由 Chrome 綁定 port 0 並在受管 profile 發布 `DevToolsActivePort`，移除 SEC-03 舊監聽身分 `exec-be0b9bae20bcc81b14dfc0d5`。 |
| `src/browser.ts:170,245,929` 當前的兩個 WebSocket 與 `requestCdp` fetch | 核准 SEC-03 精確呼叫。WebSocket 僅允許 `127.0.0.1` 或 `::1`，CDP 回應提供的 URL 還須匹配已選主機和埠。自行啟動的瀏覽器校對 profile 公布的 browser socket 路徑。原七個 HTTP 呼叫共用固定回環 HTTP 入口，拒絕重導並限制逾時。外部瀏覽器附接須明確提供端點或埠。 |
| `src/developer-execution.ts:44,119`、`src/developer-terminal.ts:86` | 核准兩個具 Bootstrap cmd/PowerShell 租約的 spawn 與對應匯入、開發模式的宿主環境讀取。原 Broker 批准、受管 cwd 與取消流程仍在。啟動固定 shell，交給 shell 執行的已批准命令繼續使用使用者 PATH。 |
| `src/tools/browser-tools.ts:179` 改前的 `writeFile` | 複製經原工具閘道讀取的單檔，改由 PathPolicy 新建暫存副本。以讀取租約校對副本的身分，再交給 CDP 的 `DOM.setFileInputFiles`。 |
| `src/observations.ts:76,77,87,101` 改前的建立／寫入／淘汰／讀取 | 四處改走 PathPolicy。Session 寫入串行化，大小及每 Session 40 筆上限照舊，既有檔案須通過摘要檢查，讀取後複核 Session 索引。`src/llm.ts` 真實投影等待限量讀取；同步預算使用原影像固定成本。截圖和本地圖像入口及六個現有測試檔案改等待非同步介面。 |
| `src/media.ts:261,262,265,286,288,289,290,311,313` 改前的九處直接 I/O | `src/tools/index.ts` 靜態匯入 `media-tools.ts`，後者匯入 `media.ts`。原本匯入即恢復寫入，現改第一次呼叫才載入。列舉、限量讀取、原子狀態替換與成果新建均使用 PathPolicy，恢復時核對檔名和 job ID。 |
| `src/playbook.ts:140,148,153,155–157,161,186,189,209,240,256,257,260,306,307,455,567,579` 改前的直接 I/O 和匯入 | `src/index.ts` 直接匯入 Playbook 執行入口，`src/tools/index.ts` 也經 `advanced-tools.ts` 靜態匯入。改由 PathPolicy 管理建立、列舉、讀取、狀態原子替換、日誌、歸檔和還原的目標存在檢查。把計算式匯入改成固定白名單，只接受原內建模板內容並執行編譯進應用的實作。既有自訂腳本資料保留，可讀取但拒絕執行。 |
| `src/playbook.ts:3,596,608,616` 當前剩餘拒絕 | `node:fs/promises` 匯入，歸檔與還原的兩個目錄 `rename`，以及遞迴 `rm`。現有 PathPolicy 無保護來源與目的身分且不覆蓋目標的目錄移動，也無對 Playbook 樹持續綁定身分的遞迴刪除。保留拒絕及原功能原始碼，待落實相容的受管操作。 |
| `src/worker.ts:1,68,72` 當前剩餘拒絕 | `src/tools/index.ts` 靜態載入 `worker-tools.ts`，後者載入 `worker.ts`。Worker 只在呼叫時啟動，但工具註冊與 import 皆無條件，現有設定預設值無法證明程式不可達。第 1 行匯入和第 68 行任意 executable/argv/cwd 的 spawn 仍被 SEC-02 拒絕，第 68、72 行啟動與完整環境複製仍被 SEC-03 拒絕。現有 scoped shell/script 與 MCP 傳輸缺 Worker 自有 stdio 協議的可直接替代入口，而固定的本機腳本 `scripts/rainydays-worker.mjs` 也未列入 ASAR 正式內容。保留拒絕，待選正式 Worker 入口或從正式 tool registry、相關靜態依賴及候選來源一併排除。 |

改後 SEC-02 為 178 個呼叫、174 筆登記、4 個未登記與 2 個未核准匯入。新增 3 個精確 spawn 及 3 筆匯入，移除 1 筆舊登記，無未知呼叫或新語法例外。SEC-03 新補 7 個精確呼叫、移除 1 筆舊登記。`node scripts/sec03-execution-inventory.mjs` 原樣產生 538 個檔案、628 個呼叫、2 個違規，清單內已無五個桌面 WIP 路徑，`migrated` 仍為 `false`。

| 命令 | 第二輪結果 |
| --- | --- |
| `npm run governance:sec02:sinks` | 退出 1。`AssertionError [ERR_ASSERTION]: UNBOUND_SINK: src/playbook.ts:596 node-fs.rename`。 |
| `npm run governance:sec03:sinks` | 退出 1。`AssertionError [ERR_ASSERTION]: SEC-03 migration incomplete:`，僅上述 Worker 68、72 兩處。 |
| `node --experimental-test-isolation=none --test tests/contract/sec02-sink-inventory.test.mjs` | 退出 1，17/19。現行精確清單與受限匯入閉包仍失敗。新增未登記、未解析、過期與 ASAR 改動的原負向用例均通過。 |
| `NODE_OPTIONS=--experimental-test-isolation=none npm run test:sec03:contract` | 退出 0，18/18。 |
| `npm run typecheck`、`npm run lint`、`git diff --check` | 均退出 0。 |
| `npm run test:product`、`npm run test:product:ui`、預設隔離的 SEC-02/03 契約 | 需負責人複跑。真實 Windows 瀏覽器啟停、上傳下載、開發模式 PATH 與觀察落盤也需由負責人執行。舊 ECO-06 自訂 JS 執行案例與本輪凍結的白名單行為不同，需以當期交付範圍複核。 |
| `npm run build`、`npm run test:package` | 清單閘門仍拒絕，尚未執行。無原生編譯、staging、Electron／NSIS 或已安裝證據。 |

### 第三輪複核

起點 `f596664`。負責人的第二輪結果為產品 201/201、UI 15/15、預設隔離 SEC-03 18/18、SEC-02 17/19。第三輪完成最後的 Worker 啟動、環境和 Playbook 目錄操作。原掃描器與交叉檢查均完整通過。

| 位置 | 處置與登記依據 |
| --- | --- |
| `src/worker.ts:1,40,114` | 兩條本機 stdio 啟動共用同一個固定入口。Node／Electron 執行檔及內建腳本由 BootstrapPathStore 分別取得並複核租約。固定 argv 結構、產生握手密碼、shell 關閉。環境只投影 Windows 系統路徑、使用者目錄、暫存、PATH／PATHEXT、語系和已使用的 Bash／sh 路徑；Electron Node 模式旗標由程式設定。取消 `RAINYDAYS_WORKER_CLI` 覆寫，倉庫測試無使用者。登記新 spawn、環境讀取及對應匯入。 |
| `src/worker.ts`、`src/tools/worker-tools.ts`、`src/tool-policies.ts`、`src/project-instructions.ts` | `worker_connect` 保留工具名稱及輸入 schema，拒絕 `executable`、`args` 和 SSH，使用指定中文錯誤。附接名稱對應本機 Worker；設定的 cwd 與 bash 提供的 cwd 使用原路徑閘道。第一版檔案傳輸和專案檔案／腳本工具保留於主程序既有授權流程，登記在本機的 Worker 選擇仍有 Session 隔離及離線拒絕。 |
| `electron/rainydays-worker.mjs:2,74,88,105`、`scripts/rainydays-worker.mjs` | 既有入口改委派給 `electron/` 下的產品腳本。保留握手、狀態、bash、持久 shell 與 `computer_use` 協議。腳本端停止接收遠端原始檔案存取／腳本 RPC。固定 Windows 系統 shell 或明確選用的使用者工具鏈執行經批准的 Bash／桌面請求。清理使用本 Worker 擁有的子程序 PID 與固定 taskkill 參數。兩層環境投影均限制繼承範圍，保留使用者 PATH。新納管的三個精確 spawn 及其匯入均登記。 |
| `package.json`、`scripts/electron-asar-integrity.mjs` | 內建腳本由 `electron/**/*` 正式納入 ASAR，明確列入 unpacked 內容以便檔案租約使用。SEC-02 使用原 `electron/` 掃描範圍收錄其執行點，包投影原有比對覆蓋來源位元組、ASAR 位置及執行點。 |
| `src/playbook.ts` 改前 `3,596,608,616`、`src/path-policy.ts:2292,2318,2345,2362,2363` | 歸檔及還原使用同一授權根的目錄移動，要求目的地不存在，檢查來源及目的父目錄的身分並驗證發布後的來源身分。在 Windows 上由目錄 rename 拒絕覆蓋；其他平台不執行此移動。遞迴清理先列舉受限樹並拒絕連結或掛接點，刪除前重查根與各項身分，逐項 unlink/rmdir。新列舉、空位檢查、rename、rmdir、unlink 均以 PathPolicy 內部呼叫登記。 |
| `tests/unit/path-policy-directories.test.mjs`、`tests/unit/tool03-bash.test.mjs`、`tests/contract/sec02-sink-inventory.test.mjs` | 新增目錄越根、目的地已存在、junction、移動中來源替換與有效目錄操作的測試。Worker 新增自訂 executable／argv／SSH 拒絕測試，保留既有 Bash 與 Session 選擇斷言。SEC-02 契約核對產品腳本入包及被掃描，將現行匯入數更新為 56。 |

使用原產生器重建兩份清單。SEC-02 有 150 個檔案、183 個呼叫點，新增 9 筆呼叫與 2 筆匯入登記，56 個匯入與 2 筆既有語法例外。SEC-03 有 540 個檔案、626 個呼叫點，新增 5 筆精確登記，違規為 0。

| 驗收 | 結果 |
| --- | --- |
| `npm run governance:sec02:sinks`、`npm run governance:sec03:sinks` | 均退出 0。 |
| `node --experimental-test-isolation=none --test tests/contract/sec02-sink-inventory.test.mjs` | 19/19，原未登記、未解析、過期與 ASAR 竄改拒絕用例均通過。 |
| 單程序 `npm run test:sec03:contract` | 設定 `NODE_OPTIONS=--experimental-test-isolation=none`，18/18。 |
| `node --experimental-test-isolation=none --test tests/unit/path-policy-directories.test.mjs` | Windows 3/3。 |
| `tests/unit/tool03-bash.test.mjs`、固定 Worker stdin 握手 | 以 Node 原生 TypeScript 轉譯及暫存路徑解析鉤子執行，Worker 啟動前的三種拒絕通過。兩項實際啟動案例在 `src/worker.ts:114` 受 `Error: spawn EPERM` 阻擋。直接執行固定腳本的未登入拒絕、握手和狀態回覆通過。 |
| `npm run typecheck`、`npm run lint`、`git diff --check` | 均退出 0。 |
| 離線 `npm run build` | 四個模型檔案通過，下載 0。首個失敗在 `build:native` 探測 MSVC。原文為 `Error: spawnSync C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe EPERM`。未到達後續原生編譯、build metadata、tsc emit、dist 完整性、assets。 |
| `npm run test:package` | 構建未通過，因此未啟動。尚無本輪 staging、Electron／NSIS、ASAR 實檔或安裝測試結果。 |

待負責人複跑預設隔離契約、產品／UI、真實 Worker Bash／桌面生命週期，以及 Windows 離線構建、包內清單與安裝候選。第三輪驗證為原掃描器、契約與人工順序核對。
