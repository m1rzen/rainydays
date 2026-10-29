# MCP：延遲程序與固定工具目錄

2026-10-30，A05。採用使用者授權的保守、可回退方案；後續遠端傳輸由A06擴充，不改同事模式的原生隔離。

比較兩個方案：在每次對話建立時啟動所有server以取得schema，或由使用者在設定中測試/更新工具目錄，對話只綁定已知schema，首次實際調用後才啟動server。前者會在模型調用前啟動任意第三方程序，且擴大既有Capability快照與授權接口。選後者，保持工具綁定與run邊界清楚。

- `src/mcp/`管理設定契約、官方SDK傳輸/協商、工具目錄、具類型結果與分頁、生命週期、HTTP設定路由；`public/mcp-settings.js`管理該設定區。主路由和renderer只接線。
- 設定測試是使用者明確觸發的短任務：檢查授權cwd，在開發模式下用現有owner/程序樹清理鏈啟動，使用官方SDK列舉工具後關閉。普通會話的MCP工具仍經Broker檢查schema、權限及每run每server授權；不從終端回顯承載協議。
- 設定存server的command/args/cwd、環境變數credential引用與已測工具schema。匯入包保留本機整個MCP設定，不能新增/啟用；匯出與公開設定不含credential值或引用。舊六欄server設定相容，未測目錄不會自行啟動。
- 模型按原search_tools發現命名空間工具，schema不全常駐。server工具目錄變更時拒絕舊綁定，設定可更新目錄；新對話取得新schema。這保留不可變授權快照，不在活動run中偷偷改參數定義。
- server以使用者身份執行，可能使用使用者可訪問的文件與網路；初始cwd檢查不是程序檔案沙箱。原生隔離尚無可用stdio產品通道時，同事模式停用MCP並明示原因，不回退到使用者程序。
- run結束/取消或應用退出收回本run的連線與受控程序樹；崩潰與協議錯誤不得重放工具。超時或回應丟失保留結果未知，不假裝遠端副作用已撤銷。
- SDK結果先映射具類型物件，再經原工具結果管道；大型文字保留本run的有界分頁內容與明確offset/保留限制，不用字串前綴猜成功。

公共驗證介面：設定API與真實stdio fixture、普通Agent的search_tools→namespaced調用、原owner取消與真實Electron設定/對話。實際模型與安裝另依原票驗收，不混合計分。

生命週期補充：既有taskkill只能在root還活著時確認整棵樹。開發stdio使用獨立的PowerShell/.NET原始管道host，先將host加入Windows kill-on-close Job再啟動payload，因此一般子程序從出生就繼承Job；MCP parent崩潰或應用stdin關閉也收回後代。不加全域套件，不改SEC-03 C++、安裝流程或同事隔離。bootstrap固定系統PowerShell路徑，腳本為固定常數，command/args/env走私有資料值與ProcessStartInfo，沒有shell拼接。根資格與owner仍來自現有Broker；這是A15使用者模式的stdio後端，並非AppContainer能力宣稱。[Windows Job官方依據](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)。
