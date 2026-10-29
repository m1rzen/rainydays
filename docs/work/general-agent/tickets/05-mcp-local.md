# A05 MCP本地接入与工具发现

Kind: implementation

Status: verified

Spec: [通用Agent规格](../../../specs/general-agent.md)

Research: [技术依据与研究问题](../../../research/general-agent-stack.md)

Blockers: A03

User stories: G05、G10

## 用户结果与工作范围

采用官方SDK接入stdio客户端。在设置添加/修改/测试/停用服务器，给出command/args/cwd及许可环境配置。注册工具目录，服务器命名空间隔离，分页/变更刷新，按任务发现。工具调用进入现有run、结果、错误和取消链。更新实际能力available/enabled/version状态及测试，不留下仅能保存却不生效的开关。

## 先读与研究

A01官方SDK1.32.1的stdio/HTTP往返成功，见[原型记录](../prototype.md)。生产stdio不能直接沿用SDK默认无受控spawn；用SDK Transport接口连接现有NativeExecutionHandle的原始write/output/terminate，必要时只补最小原始管道会话。ConPTY终端显示不能充当协议stdout，A03运行时租约问题须先解决。

src/settings-schema.ts、version.ts、task-tools.ts、tools/index.ts与执行器；研究dossier的官方SDK/传输资料。

共同实现原则见[能力手册](../../../agents/general-agent-capabilities.md)。实施前查当前定义与官方资料，记录实际版本；不要凭旧文档猜接口。

## 验收条件

- [x] M01/M02工程流程由真实stdio协议与普通会话完成；两个同名工具不混淆。
- [x] 进程stdout协议与stderr日志分离；协议错误、超时、退出和应用关闭可恢复/清理。
- [x] 停用后不能新调用；重启配置保留，凭据仅引用现有vault。
- [x] 动态工具schema不全部常驻提示；工具变更后不沿用失效参数定义。
- [x] 第三方进程通过现有受控执行接口，说明实际文件/网络权限，不误称工具路径检查能限制其全部行为。

## 验证接口与证据

一个真实本地stdio测试服务器＋分页/变更/命名冲突用例＋实际设置/默认助手入口；M01/M02。

计分与真实模型授权见[通用验收](../../../agents/general-agent-acceptance.md)。工程桩与真实结果分别记录；没有实际执行的条件不能勾选。

## 范围与回退

不做市场、企业审批或任意插件安装。用户可接兼容自定义服务器；SDK版本和运行时支持需在实施时锁定。

保留他人修改和用户数据；变更按本票独立提交，回退仅针对自身变更。涉及数据迁移先准备测试副本与恢复路径。复用[安全预算](../../../agents/safety-budget.md)，只加本能力需要的边界检查。

## 执行记录

2026-10-30，起點00c7e9b；R5已修復並推送。依自主授權連續開發，模型/帳號均用本地fixture。選擇與界面見[ADR](../../../adr/0001-mcp-runtime.md)：設定明確測試目錄、普通run固定schema、首次調用才啟動server；不為發現工具提前無授權啟動程序。使用者身份傳輸只在開發模式；同事模式保持停用，待已有隔離stdio可用再接，無靜默回退。

## Test and design seam

設定API→官方SDK真實stdio→命名空間schema→原Broker/Agent→具類型工具結果與owner收回。將設定/傳輸/目錄/結果放src/mcp，UI放獨立script；主文件只接線。比較啟動時批量連線與設定測試後快照，採後者保留現有不可變Capability邊界。每個子切片先經公共介面red，再實作green；不靠直接調私有方法或另造Agent驗收。

## 审查与验证结果

審查範圍：00c7e9b至本票工作樹，按倉庫規則/正確性及票據/spec兩軸順序自審，未宣稱獨立人員審查。依使用者要求，只在本票記錄，不新增治理清單或證明腳本。

已修正發現：設定啟動參數或vault環境值變更時清除舊schema（先red再green）；工具已成功發布後不再追加context檢查而改寫結果；MCP表單草稿刷新保留；環境字典原型名稱；連線狀態依配置摘要綁定且Map有界。既有Session切回同事模式後，Broker在下一run亦移除MCP工具。

實作：官方SDK精確1.32.1；自訂SDK Transport只接原始管道，initialize/list分頁/call/通知由SDK處理。開發模式的Windows Job host先加入Job再啟動payload，原Broker run/單次grant、PathPolicy execution-root與owner收回均沿用。錯誤為typed MCP結果，1MiB保留上限、12k字元分頁（每run最多8份），無隱藏截斷或工具自動重放。設定CRUD/明確測試/啟停/連線狀態/數量在獨立UI模組，對話卡片顯示原server名稱。公開/匯出無環境值或credential引用，匯入保留本機整個MCP清單。

最終驗證：2026-10-30，`npm run check:product`的typecheck/lint通過、產品109/109、UI15/15；緊接`npm run test:product:desktop` 6/6（132.957秒，新增A05，原五項不減）。額外最新Broker/設定/管道42/42。stdio fixture工程包含雙server同名、分頁/變更、isError/協議錯誤、崩潰連帶子程序、逾時、父run取消和app被強制結束；普通假模型Agent驗證成功、每server每run授權、分頁跨run拒讀。提交1e0a09e（runtime/授權/產品fixture）、08f31b9（設定UI/來源標籤/重啟/桌面入口），兩者構成已測程式碼；本節更新僅為文件。

額外邊界檢查45/46：Broker32/32、設定3/3、工具管道7/7、DS09 renderer3/4。唯一失敗是舊source-regex要求`settingsState.domainManifest`，R5基線已使用`settingsState?.domainManifest`，與本票無關；核對00c7e9b已存在，保留原測試，不修改斷言來冒充通過。首輪桌面5/6曾在開發啟動出現EPIPE/握手失敗，串行再跑6/6；SDK已改成實際測試/調用時才載入，未調大握手時限或吞錯。

必要的既有斷言更新三處：settings-schema的MCP available由false改true，因現在確有產品adapter；R5首次設定的可用分頁增加MCP，其他項目順序保持；version-model diagnostics改斷言完整`{version:1,enabled:true,transport:"stdio"}`，取代未實作時的null。沒有跳過、停用或刪除舊用例。

偏差/決定：票據原NativeExecutionHandle建議沒有現成可用的開發模式原始stdio契約；採A15使用者模式的獨立Windows Job管道後端，仍受原Broker/路徑/owner管理，SEC-03 C++與同事隔離未改。與提示詞要求「不碰SEC-03」一致。同事MCP預設停用待隔離通道；目錄更新於明確測試後供新會話使用，活動快照不熱改。SDK安裝只新增必要本地依賴；官方npm audit回報既有樹20項（3 moderate/17 high），SDK本體無直接advisory，未擅自升級其他套件。

未驗：真實模型語義、外部server帳號、目前安裝包及受管電腦禁用Add-Type時的可用性；本票僅確認本機工程路徑，A13仍是完整出口。回退本票提交會移除MCP adapter，舊空清單仍相容；不動任何使用者資料。

