# A06 MCP远端认证与内容处理

Kind: implementation

Status: in-progress

Spec: [通用Agent规格](../../../specs/general-agent.md)

Research: [技术依据与研究问题](../../../research/general-agent-stack.md)

Blockers: A05

User stories: G05

## 用户结果与工作范围

增加Streamable HTTP传输、token及常见OAuth登录/刷新/断开；复用SDK和系统浏览器，凭据引用既有vault。映射text/structured/image/resource，资源按需读，工具错误和进度可见。区分连接中断、取消和未知写入；限制可安全重试的读取，不重放副作用。

## 先读与研究

官方SDK、传输、认证资料；当前网络/凭据/取消链。图片协议先验证载荷，真实模型识别由A08/A13统一验收。

共同实现原则见[能力手册](../../../agents/general-agent-capabilities.md)。实施前查当前定义与官方资料，记录实际版本；不要凭旧文档猜接口。

## 验收条件

- [ ] M03真实协议的token和OAuth测试登录均通过，过期/拒绝/移除行为清楚；外部服务账号另核对授权。
- [ ] M04所有内容类型能投影到统一结果，资源按需获取，图片载荷可供视觉适配使用。
- [ ] M05写入后丢响应不自动重放；断线与取消不被宣称为远端撤销。
- [ ] 服务器错误不会使整个会话永远等待；身份/网络错误可采取下一步，日志无凭据。
- [ ] 至少一个真实兼容HTTP服务和本地受控故障服务有记录；不宣称所有MCP服务已支持。

## 验证接口与证据

真实loopback HTTP/OAuth fixture、已批准外部测试服务的连接记录、超时/断线/写入未知场景；M03–M05。

计分与真实模型授权见[通用验收](../../../agents/general-agent-acceptance.md)。工程桩与真实结果分别记录；没有实际执行的条件不能勾选。

## 范围与回退

不自写OAuth/SSO或兼容所有历史传输。若SDK/服务差异影响方案，记录具体版本和替代，不无限建设通用连接平台。

保留他人修改和用户数据；变更按本票独立提交，回退仅针对自身变更。涉及数据迁移先准备测试副本与恢复路径。复用[安全预算](../../../agents/safety-budget.md)，只加本能力需要的边界检查。

## 执行记录

2026-10-30，起點6b01449；A05已verified並推送。只用真實loopback SDK HTTP/OAuth fixture與確定性模型，不用外部帳號。沿用SDK1.32.1、A05設定/vault、命名空間、Broker每run每server授權和結果/取消鏈，擴充獨立src/mcp模組。比較另建遠端registry與擴充同一adapter，選後者，保留本地/遠端一致的schema與任務歸屬。外部已批准兼容服務尚無帳號/地址，其真實服務驗收保留未完成。

2026-11-06，核對發現後端已有Streamable HTTP、token、OAuth與資源讀取，但設定頁沒有遠端傳輸、URL、認證欄位，也沒有OAuth登入／斷開入口；`collect()`漏送`auth`與`resources`，儲存表單會把遠端認證重設為none。已補齊表單與登入狀態顯示，並以`tests/product/mcp-settings-form.test.mjs`覆蓋。`check:product`：產品127/127、UI 15/15。設定頁真實畫面與真實OAuth服務登入尚未驗收，本票維持in-progress。

2026-11-12，在真實 Electron 走完設定頁遠端 OAuth 全流程（本機 OAuth fixture + 使用者預設瀏覽器 Edge），發現並修正三個缺陷：
1. `oauth-browser` 用 `explorer.exe <URL>` 開瀏覽器，帶查詢參數的授權網址在本機完全打不開（瀏覽器零請求，explorer 結束碼 1）。改用 `rundll32.exe url.dll,FileProtocolHandler`（`bootstrap-path-store` 新增 `url-handler`，固定入口、URL 仍先過 `validateOAuthBrowserUrl`），同機實測立即打開。
2. 未登入時按「測試」，SDK 會先動態註冊客戶端並寫入設定，改變設定版本，頁面隨後按「登入」被 409 拒絕，錯誤訊息也只是籠統的連線失敗。現在 `McpConnection.open` 與 `/api/mcp/test` 在無 token 時先拒絕，不發任何請求、不改設定，提示「此服务器尚未登录」。
3. 瀏覽器回調保存 token 會改變設定版本，設定頁只更新「已登录」字樣，下一次「測試」被 409 拒絕。現在登入從等待轉為完成時自動重新載入設定；任何 409 也會同步一次。

驗證：`RAINYDAYS_SYSTEM_BROWSER_TESTS=1 node --test --test-name-pattern "A06 real Electron" tests/electron/desktop-smoke.test.mjs` 1/1（設定遠端 OAuth 伺服器→未登入測試即時拒絕且 fixture 零請求→系統瀏覽器登入→測試得 1 個工具→設定檔與日誌不含 access token→斷開後再測試在本地拒絕、credentialRef 清空）。此測試會開啟系統瀏覽器，預設跳過。產品 149/149、UI 15/15、桌面 6/6、A05 Electron 1/1、SEC-01 邊界 5/5。`test:sec03:contract` 1 項失敗為既有清單漂移（`electron/main.cjs` 自 2026-09-30 未改，清單仍記舊位元組數），與本次無關。

仍未完成：外部已批准的真實 MCP 服務與帳號（M03 的外部部分）、token 模式的真實 Electron 設定頁登入。本票維持 in-progress。

## Test and design seam

設定/API→官方StreamableHTTP（JSON與SSE回應）/必要的SDK舊SSE adapter→token/OAuth provider vault→原Agent工具鏈。官方SDK負責認證協議與PKCE，應用只管理callback狀態、現有憑據引用及使用者登入入口。網路遵循父context且不把token轉送到跨origin重導；取消/丟回應不重放工具。fixture先測red再green，外部模型/帳號不以fixture充當已驗。

依據：[傳輸](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)、[認證](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)與已安裝SDK實際client/auth、streamableHttp型別；不採GitHub main的v2 API。

## 审查与验证结果

尚未审查/验证。完成时记录具体命令、实际结果、人工核对、未测项、回退和终点提交。全部条件有证据才改为verified；依赖例外以[总任务图](../plan.md)为准。

