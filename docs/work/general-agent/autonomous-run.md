# RainyDays 自主連續開發記錄

更新：2026-11-06。分支`demo/2026-10-16`。排期唯一來源仍是[plan.md](plan.md)，本檔記錄執行與恢復位置。

## 目前位置

目前：
1. **A06 遠端 MCP 接入**（in-progress，已完成 Streamable HTTP JSON/SSE、寫後斷線不重放、token vault 設定、跨 origin 重導與寫後 401 防重放；待接普通 Agent/UI/OAuth 與資源 reader）；
2. **LC-00 ~ LC-06（Lux Cloud 60 工具與主循環對齊）+ 桌面端實戰體驗修復（Session Auto 授權模式、自然語言授權說明、長對話整理歷史超時修復、工具折疊時間軸 UI）**：已完成代碼落地、TypeScript 編譯與核心單元/契約/產品測試驗證，待重啟桌面端進程使新 `dist/` 在運行中實例生效並繼續完成用戶 B 站「永雛塔菲」最後 3 個直播回放合並與「邑易行」小程序源碼分析會話。

## 本輪已完成與未完成的改動（2026-11-06 切片）

### 已完成改動
1. **Session 級工具授權 Auto 模式（Claude Auto 風格）**：
   - `src/agent.ts`：新增 `isSessionAutoApproveEnabled` / `setSessionAutoApproveEnabled`。開啟後當前 Session 內後續工具調用自動通過授權挑戰，不再重複彈窗。
   - `src/tools/ask-user-tool.ts`：`askUserConfirm` 新增 `「本會話自動批准（Auto 模式）」` 選項並納入正向授權集合。
   - `src/index.ts`：`POST /api/sessions/:id/select`、`POST /api/chat`、`POST /api/ask-user/answer` 及 `GET/POST /api/sessions/:id/auto-approve` 同步 Session 級 `autoApprove` 狀態。
   - `public/index.html`、`public/redesign.css`、`public/renderer.js`：底部輸入欄新增 `⚡ Auto 授權: 開/關` 一鍵切換按鈕，並在每次授權彈窗（`#ask-modal`）提供醒目的 `「本會話自動批准（Auto 模式）」` 按鈕。
2. **自然語言工具授權提示與開發模式審批打通**：
   - `src/agent.ts`：新增 `summarizeFileContentPurpose`、`describeDeveloperCommandPurpose`、`describeNaturalToolApproval`，將原本僅顯示 `工具: write / 參數: {...}` 的生硬 JSON 替換為清晰自然語言說明（要做的事、目的、保存路徑/目標與調用工具名）。
   - `src/developer-execution.ts`：將 `bash`、`bash_kill`、`shell_kill`、`browser_open`、`browser_close`、`computer_use` 納入 `DEVELOPER_COMMAND_TOOLS`，在開發模式下統一走應用內授權而非為每次調用彈原生進程確認框。
   - `src/agent.ts`：`write`/`edit`/`replace`/`shell_input` 成功後及 `execute_command` 輸出發生變化時調用 `toolLoopDetector.noteCodeChange()`，避免輪詢後台下載進度時誤觸發 `TOOL_LOOP_DETECTED`。
3. **「整理歷史超時」根因修復**：
   - `src/memory.ts`：移除 `this.messages.length <= this.maxMessages` 強制壓縮條件（僅在超過上下文預算或達到 90% 水位線時才觸發 `compact()`）；`formatMessagesForSummary` 對單條 `role === "tool"` 輸出做 1,200 字符有界裁剪；默認 `summaryTimeoutMs` 從 30s 提升至 90s 以適配 Thinking 模型（`Gcable-Pro-Thinking`）。
4. **任務執行過程分段時間軸與 `.tool-group` 折疊 UI**：
   - `public/renderer.js`、`public/redesign.css`：實時流式輸出按時間順序分段渲染 `.run-text-segment`，連續工具調用自動折疊進 `.tool-group` 摘要面板。

### 未完成改動（WIP）
1. **歷史超大錯誤輸出清理**：`%APPDATA%\rainydays\data\mini-lux.db` 中會話 `a841e150-b0e4-4bf4-8ee7-7b3fb0137f11` 與 `0db1b724-7956-4f7e-bfc5-c2bb3f4771cc` 的 4 條 32KB `find` 失敗輸出尚未裁剪，待用戶確認（倉庫內 `data/mini-lux.db` 是 2026-08 舊檔，不是此庫）。
2. **用戶未完任務收尾（2026-11-06 依資料庫與磁碟核實，更正先前記錄）**：
   - 會話 `0db1b724-7956-4f7e-bfc5-c2bb3f4771cc` 的實際需求是下載 B 站 `BV1r6xo6aEC3`（2026 IEM 北京 NAVI vs Falcons 小組賽三局，共約 1.26 GB）。下載於 2026-11-05 17:39 中止，`%APPDATA%\rainydays\workspace\downloads` 僅有 P1 音視頻與 P2 視頻的部分分片，尚無成品 MP4；腳本 `download_iem.py` 支援續傳。
   - 先前記錄的「永雛塔菲」5 個直播回放、`v3_video.m4s` 與其目標資料夾，在資料庫及 `C:\Users`、D、E、F 均查無依據，不作為待辦。
   - 會話 `a841e150-b0e4-4bf4-8ee7-7b3fb0137f11` 的邑易行分析已於 2026-11-05 17:02 完成並回覆（程式碼在 `E:\For_Miniprogram\Yi_yixing`，先前記錄的 `Desktop\專案\yiyixing` 不存在）；該會話最後兩條 B 站請求未獲回覆，後續由 `0db1b724` 承接。
3. **A06 遠端 MCP 接入**：普通 Agent 發現與調用、UI 設定頁 OAuth 流程與資源 reader 尚未完成。

## 長會話與 Auto 授權（2026-11-09）

- 上下文達 50% 水位時，較舊的大工具輸出（保留最近 12 個完整）折疊為開頭、結尾與 `history:消息ID` 引用，不呼叫模型，資料庫原文不變。用兩個真實會話的資料庫副本估算，內容減少 60%（307,828→123,362 字符）與 49%（178,099→91,420 字符）。
- 交接改按模型摘要代數提示（每 4 代一次），不用固定字符數。
- 系統提示加入連續性規則：摘要與交接只是線索，寫交接要實查並註明來源，接手先核對。該規則不寫進 persona，既有對話不受 persona 摘要變更影響。
- Auto 改為逐次放行；刪除、Git 推送或改寫、發布、對外發送、桌面操作與遠端 MCP 仍需確認；模型摘要後自動關閉。命令文字比對只是盡力識別，不是隔離邊界；瀏覽器點擊仍會自動放行。
- 證據：`check:product` 產品 134/134、UI 15/15；`developer-mode.test.mjs` 以真實 Agent 流程驗證 Auto。真實模型長會話與桌面實際畫面尚未驗證。

## 票據與提交

| 票據 | 狀態 | 提交／證據 |
|---|---|---|
| R5 Electron修復 | verified | 84c95b9；產品99/99、UI15/15、桌面5/5 |
| A03 | verified（既有） | 34294c5；本輪不重做 |
| A04 | blocked（既有） | fc9f745；工程產品99/99、UI15/15、20題樣例自檢20/20；真實模型未授權 |
| A05 | verified | 1e0a09e、08f31b9；產品109/109、UI15/15、桌面6/6 |
| A06 | in-progress | 起點6b01449；Streamable HTTP/token vault/redirect-auth 5/5 green；待接Agent/UI/OAuth |
| LC-00 ~ LC-06 + Auto授權與整理歷史修復 | in-progress (WIP) | 60/60 工具契約對齊、LC-01~LC-06 6/6、D03 8/8、A15 7/7、TOOL-02 11/11、UI/DS10 6/6；待重啟桌面端與收尾用戶任務 |
| A11 | 未開始 | 依A02/D03已verified |
| A12 | 未開始 | 依A01/D03/D04已verified |
| A07 | 未開始 | 依A01/D04/D05已verified |
| D09/D10/D07/D11/D12/D14–D18 | 未開始（本輪） | 各票先核對依賴與既有狀態；D07/D15–D18外部驗收不冒充通過 |
| A08–A10 | 未開始 | 依各票；真實視覺/安裝/實體環境只記未驗收 |

## 本輪測試

### 2026-11-06 切片測試結果
- `npm run check:product`：**全量通過**（`typecheck` 0 errors、`lint` 0 warnings、`test:product` **123/123 通過**、`test:product:ui` **15/15 通過**）
- `npm run build`：**通過**（`buildId: 0.1.0+local.393d8de2e9bf`，生成 `dist/`、`build-info.json`、`dist-integrity.json`）
- `tests/contract/sec01-boundaries.test.mjs`：**5/5 通過**（核實自 `c2b203d` 以來 5 個提交新增 85 個靜態工具：`ab92e84` +1、`bf3a7e4` +41、`09ad4e9` +2、`1e0a09e` +1、`5ad3f70` +40，靜態工具數由 57 增至 142、總數 162 且與 `STATIC_TOOL_POLICIES` 完全一一對應；清理 `src/developer-terminal.ts` 注釋中觸發正則的 `TerminalManager` 字樣）
- `tests/product/code-editing.test.mjs`：**8/8 通過**（移除 `writeExec` 對 `PATH_OPERATION_DENIED` 的自動覆蓋回退，恢復 A02 `write` 僅創建不覆蓋的契約保證）
- `tests/unit/ui-icon-contract.test.mjs`：**3/3 通過**（含 `.tool-group` 折疊與 `.tool-card` 狀態變更測試）
- `tests/unit/ds10-accessibility-contract.test.mjs`：**3/3 通過**
- `tests/unit/approval-response.test.mjs`：**1/1 通過**
- `tests/contract/tool02-filesystem-contract.test.mjs`：**11/11 通過**
- `tests/product/developer-mode.test.mjs`：**7/7 通過**
- `tests/product/long-context.test.mjs`：**8/8 通過**
- `tests/product/lux-cloud-parity.test.mjs`：**6/6 通過**
- `tests/product/mcp-remote.test.mjs`：**7/7 通過**（含 A06 Streamable HTTP、token vault、redirect、401 防重放、OAuth PKCE 與普通 Agent 按需資源調用）

### 下一步計劃与未解決問題
1. **下一步計劃**：
   - 待用戶確認後，清理上述 4 條 32KB `find` 失敗輸出（先備份資料庫）。
   - 經用戶確認後續傳 `BV1r6xo6aEC3` 並合成 MP4。
   - 在真實對話中開啟 `⚡ Auto 授權: 開`，驗證不再出現「整理歷史超時」與重複原始 JSON 授權彈窗（需一次真實模型運行）。
2. **未解決問題**：
   - 桌面端已於 2026-11-06 以 `0.1.0+local.393d8de2e9bf` 用真實資料啟動：舊會話載入正常、`⚡ Auto 授權` 按鈕顯示；隔離環境 `test:product:desktop` 6/6。上述 Auto 與整理歷史修復尚無真實模型運行證據。
   - `%APPDATA%\rainydays\workspace\_cookiecopy\Profile_2.db` 是 Chrome Cookies 資料庫副本，屬敏感殘留，待用戶確認後刪除。

## 待我確認的決定

- 自主輪次先處理使用者指定的R5回歸，再沿plan.md修訂順序推進；D系列按依賴穿插。進度檔不另建平行排期。
- 同事模式的MCP若尚無可用的既有隔離stdio契約，保持停用；開發模式下可實作受run/owner管理的使用者程序，不作靜默回退。
- A05以Windows Job受控原始管道承載開發stdio，沒有修改SEC-03 C++；設定顯示使用者檔案/網路權限。工具目錄明確測試後由新會話取得，活動schema不熱改。
- 有界子任務先保持最多兩個、無遞迴、唯讀工具，主任務持有寫入權；不擴成一般多寫入者。
- 所有模型與服務均使用本地確定性fixture；無真實API、帳號或費用授權時保留相關驗收未完成，繼續可獨立工程。

## Blocked與嘗試記錄

- A04真實評估、D02模型認證、D13有效安裝候選/乾淨機與後續同事試用：沿用票據外部阻塞；不呼叫其他已存金鑰、不更改發布流程。
- 每個新阻塞最多三種有區分力的做法；只記實際嘗試，不以重跑同一失敗湊方法數。超限後寫解除條件並轉下一張可獨立票。

## 步驟

1. 完成啟動閱讀、Git同步與基線確認。沒有需要清理或暫存的已追蹤修改。
2. R5基線真實Electron重現：工具發現與下一任務重置正常（12→13→12），只在舊allowlist比較逾時。加失敗現場資訊後，證實請求輸入29251＋回覆預留4096超過32768，故根本沒有第5次模型請求。不是A14或能力註冊失效。
3. R5最小修復候選：僅為本地假模型比較配置65536/4096工作預算；原斷言全部保留，產品預設預算不變。將該用例加入test:product:desktop，等待實際回歸。
4. R5修復後聚焦Electron 1/1通過（16.577秒，程序總25.897秒）。開始完整產品與桌面檢查；未新增真實模型呼叫。

5. R5完整檢查全綠；原測試斷言全部保留。準備精確提交與祕密/路徑檢查，完成後推送目前分支。
6. R5提交84c95b9。暫存路徑無.env/deliverables/資料庫/憑據；差異祕密模式唯一命中為task/ask名稱中的sk-，人工核對是識別字，不是金鑰。
7. A05新增官方SDK精確版本1.32.1（stdio協議與工具schema的必要依賴，無全域安裝）。舊設定/匯入防注入兩項先red再green；加入vault環境值與匯出保密共3/3，typecheck通過。SDK安裝報告既有依賴樹15個audit項，尚未將其當成本輪修復範圍或執行自動升級。
8. A05真實SDK fixture提供echo/fail/hang三工具，tools/list分頁、stdio/stderr分離、目錄變更、崩潰/逾時/取消和後代PID清理已實跑。首次3項中2過1敗：JSON-RPC工具異常被錯分類為斷線，現修正分類後重驗；未使用模型API。
9. SDK stdio 3/3 green；Agent普通search_tools→MCP成功/具類型錯誤→同run一次同server授權、次run再確認通過。加入12k字元分頁、跨run結果拒讀、父run取消5秒內清理。設定頁新增/測試/停用、vault環境值與重啟保留的真實Electron切片通過，納入完整桌面回歸。
10. 原taskkill方法在root崩潰後無法證明後代清理，改為開發模式專用Windows Job管道host，啟動payload之前先讓host加入kill-on-close Job；SDK仍管理協議，owner/PathPolicy/Broker不變，SEC-03 C++未改。修正spawn事件註冊競爭與.NET管道flush後，真正的root崩潰/子程序和app突然退出清理5/5通過。
11. 首輪完整check:product為106/106＋UI15/15；後續新增兩server隔離、app意外退出與設定變更目錄失效（先red再green，設定4/4）。順序自審發現並修正：避免工具成功發布後再次驗證context改寫結果、MCP草稿刷新保留、字典原型名稱、狀態Map有界與設定摘要綁定；驗證全套最新結果中。
12. npm官方audit回報20項（3moderate/17high），SDK本體無直接advisory；未自動升級無關既有依賴。先前預設mirror不支援audit，其失敗不計通過。
13. runtime切片提交1e0a09e，精確暫存23項，無.env/deliverables/資料庫/憑據；祕密模式只命中ask-user等識別字。UI/桌面與紀錄留下一切片，不在票完成前推送半份工作。
14. 最新完整check:product109/109＋UI15/15；完整桌面已兩輪6/6。首次並行高負載出現開發原生確認握手期EPIPE，保留斷言；SDK改按需import，空白啟動不載SDK。加連線實際數量與同事模式舊Session不可見後，凍結程式碼再重驗。
15. 額外既有邊界用例45/46，唯一DS09 source-regex不接受R5既存optional chaining（00c7e9b已存在），未弱化斷言；Broker32/32、設定3/3、工具管道7/7通過。完整五組要求的檢查另列，不把此額外失敗藏起來。
16. A05最終凍結後整套check:product109/109＋UI15/15，test:product:desktop6/6；額外最新邊界42/42。UI切片08f31b9（7項精確暫存，祕密模式只命中ask-modal字樣）。票/plan/STATUS與能力手冊同步verified，準備推送後立刻接A06。
17. A05文件6b01449與兩個程式碼切片均已推送origin/demo/2026-10-16。開始A06，已重讀票據與官方HTTP/OAuth規格及SDK1.32.1實際型別；不呼叫外部服務或真實帳號。選擇擴充同一MCP registry/Broker/run授權，不另建連接平台。
18. A06真實SDK Streamable HTTP的JSON/SSE、寫後斷線不重放先2項red再2/2 green；token vault設定red→green，設定5/5。加入跨origin重導與寫後401兩項red，修正既有network gateway尊重SDK的redirect:manual（預設自動重導不變）、SDK寫入工具的auth/redirect回應不自動重放；遠端聚焦5/5 green，typecheck通過。仍未接普通Agent/UI/OAuth與資源reader，不標verified。
19. 2026-11-16 用戶批准按 2026-11-14 計劃審閱執行交付修復切片。M1-1 交付收敛（沿 A14/D04）已實現並提交：`Agent.deliveryArmed` 識別明確交付要求（輸入或 steer），收敛期間 system prompt 攜帶交付收敛模式塊；宿主逐輪分類工具調用，只有檢查類命令（execute_command/bash/shell_input/shell_output）的連續輪次計數，其他工具成功即重置；連續 2 輪注入复核提醒、連續 3 輪由宿主停止本輪並用 RunLedger 匯報已完成步驟與產物。新增 tests/product/delivery-convergence.test.mjs 4/4；typecheck 與 eslint 通過；既有 developer-mode + long-context 17/17 無回歸。下一步：M1-2 本地圖像觀察（A08 缺失入口）、M1-3 成品登記。
20. M1-2 本地圖像觀察（沿 A08）已實現：`observations.ts` 觀察 mime 擴展 PNG|JPEG（新增 jpegSize/imageSize），`read` 對授權讀取的本地 PNG/JPEG 註冊為會話觀察（source=read、scale=1、viewport=false），結果 JSON 帶 file/mime/bytes/尺寸/version(sha256)/觀察標記；`OBSERVATION_TOOLS` 加入 read，照舊受最近 2 張預算與只讀已註冊摘要防偽約束；註冊失敗回退原文本提示，重複讀取按摘要複用，文件變化即註冊新版本。新增 tests/product/local-image-observation.test.mjs 2/2；tool02 契約補真實 PNG/JPEG 觀察斷言 11/11；build/typecheck/eslint 通過。文稿渲染逐頁檢查與真實視覺模型對本地圖片的表現留 A08 剩餘驗收。下一步：M1-3 成品登記。
