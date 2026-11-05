# RainyDays → Lux-Cloud 全量能力對齊與改造規範（LC-00 ～ LC-05）

> 狀態：**Active（用戶已批准啟動）**
> 基線文件：`parity/baselines/lux-cloud-2026.json`
> 演進脈絡：`Pi Agent (pi-coding-agent / pi-ai)` → `Lux Desktop v0.1.898` → `Lux-Cloud (2026.10)`

---

## 一、從 Pi Agent 到 Lux-Cloud：核心基因與減負準則

### 1.1 三代架構演進關係

```text
[第一代：Pi Agent (@mariozechner/pi-coding-agent)]
 ├─ 極簡原子工具：read / write / edit(精確替換) / bash / grep / glob
 ├─ 無門禁 (YOLO) 單一主循環：真實退出碼與報錯驅動自修復
 ├─ 嚴格的 Prefix Cache 保護：System Prompt 固定不變，不塞每輪動態文本
 └─ 統一推理強度抽象 (pi-ai)：thinking_effort (minimal/low/medium/high/xhigh/max)
         │
         ▼ 疊加桌面 UI、多角色與本地自動化
[第二代：Lux Desktop v0.1.898（RainyDays 原復刻對象）]
 ├─ 引入 SQLite 會話、本地 MCP、Worker Attach、知識圖譜雛形
 └─ 歷史包袱：19 個 Persona 切換、Playbook/Routine 雙入口、同步阻塞摘要
         │
         ▼ 雲端化、砍掉冗餘角色門禁、升級分層記憶與多機控制面
[第三代：Lux-Cloud (2026.10)（當前目標）]
 ├─ 四服務運行時：sessiond + core + coordinator + worker（支持單次調用級 worker_id）
 ├─ 記憶引擎代差：凍結前綴 + 50%/90% 雙水位線 + Scribe 異步製圖 + Agent Map 探索樹
 ├─ 冷熱分層畫布：分段 SQLite 冷區只讀檢索 (canvas_history_*) + 大輸出分頁 (tool_result_read)
 ├─ 零預載按章節 Skill：Store-backed skill_load(sections) + ETag 版本化 skill_manage
 ├─ 三元組 CAS 圖譜：Node(n_) / Edge(e_) / Note(t_) + consolidate_memory + 獨立 Muse Peer
 └─ 持久子會話編排：agent_spawn(持久 Session) + agent_wait(async/persistent) + main_agent_inspect
```

### 1.2 RainyDays 立即執行的「三大減負」

1. **廢除靜態行號/SHA 連坐重簽門禁**：
   保留 `CapabilityBroker`、`PathPolicy`、`AppContainer` 沙箱的**運行時強制攔截**與單測，但不再要求每次修改代碼重簽 20+ 個 `tests/manifests/*-resolved.json`。
2. **廢除每輪 `refreshSystemPrompt()` 動態重寫與 `taskMode` 強制注入**：
   在 `src/agent.ts` 中停止每輪重寫 `messages[0]`，停止每輪往上下文塞 `system` 消息催促調用 `task_update`。
3. **廢除強制 `switch_persona` 审批鏈**：
   從「多 Persona 來回切換 + Supervisor 攔截」轉向 Lux-Cloud 的「**Anima 憲章四件套 + 按需章節 Skill + YOLO 執行**」。

---

## 二、Lux-Cloud 核心子系統完整工程設計（在 RainyDays 中的落地方案）

### 2.1 子系統 A：Prompt 編譯器与 50%/90% 雙水位線引擎（`src/prompt-compiler.ts` & `src/memory.ts`）

#### 1) 凍結前綴（Frozen Prefix）結構
發送給模型的消息序列固定為三段，保證同一階段內前綴字节流 100% 不變：

```text
[段 1：Frozen System Prefix（緩存錨點，階段內絕不修改）]
  ├─ Anima Constitution：{identity.md, working-principles.md, memory-salience.md, voice.md}
  ├─ <memory>：會話啟動或上次 90% 替換時快照的近期知識線索（Node/Note 短 ID）
  ├─ <agent_map>：上次提交的 Agent Map 全局導航投影（有界樹）
  └─ <env>：date（僅精確到小時，如 2026-11-05 11:00 UTC+08:00）、model、anima、session_id、execution: YOLO

[段 2：Continuity & Protected Constraints（僅在替換邊界更新）]
  ├─ Scribe / Curator 生成的累積工作摘要（~1024 tokens）
  └─ 當前生效的 Session Pins（通常 ≤ 5 條）

[段 3：Hot Canvas Window（追加式熱區對話流）]
  └─ 自上次 coverage watermark 以來的 User / Assistant / Tool Call / Tool Result 塊
     （中途新增的 pin、skill_load、map_update 均以 Tool Result 形態留在此處，不回寫段 1）
```

#### 2) 三角色 Prompt 編譯器（對應 `prompt_inspect(role)`）
- **`role = "main"`**：完整四件套憲章 + `<memory>` + `<agent_map>` + `<env>`。
- **`role = "scribe"`**：
  - 系統指令：`# Scribe: context cartographer` + Anima 認識論與記憶顯著性子集；
  - 專用工具集：`scribe_overview`、`scribe_list`、`scribe_search`、`scribe_inspect`、`map_view`、`map_search`、`map_update`、`scribe_complete(continuity)`；
  - 完成條件：必須調用 `scribe_complete({ continuity })` 提交約 1024 tokens 的增量摘要，純文本回復不算完成。
- **`role = "muse"`**：
  - 系統指令：`# Muse: restricted independent reflection peer` + 完整四件套憲章 + `kind`（`reflect | worry | doubt | eureka | gratitude`）與 `about` 焦點；
  - 專用工具集：`muse_snapshot`、`map_view`、`map_search`、`map_update`（僅允許改節點結構與 Focus，禁止創建/修改/掛載 Note）、`muse_inject({ narrative })`、`muse_noop`。

#### 3) 冷熱分層與超大工具結果分頁
- **超大工具結果（`tool_result_read`）**：當單次工具輸出超過閾值（如 12,000 字符）時，完整字符串存入 `canvas_blocks` 表，熱窗口內僅返回 `{ blockId, truncated: true, total_chars, preview, read_more }`。模型通過 `tool_result_read(blockId, offset, maxChars)` 按 Unicode 字符偏移讀取。
- **冷區只讀檢索（`canvas_history_*`）**：被 Scribe 推進 watermark 歸檔後的舊 Block 標記 `tier = 'cold'`，提供：
  - `canvas_history_overview(after, limit)`：按單調 `ordinal` 列出冷區塊摘要；
  - `canvas_history_search(query, after, limit)`：FTS5 檢索冷區塊，返回 `next_after`；
  - `canvas_history_inspect(blockId, offset, maxChars)`：按字符偏移讀取冷區塊原文（**只讀，絕不將冷區塊重新塞回熱窗口**）。

---

### 2.2 子系統 B：Session Agent Map 探索樹與原子 CAS（`src/agent-map.ts`）

#### 1) SQLite 表結構
```sql
CREATE TABLE map_meta (
  session_id        TEXT PRIMARY KEY,
  map_id            TEXT NOT NULL,
  root_node_id      TEXT,
  focused_node_id   TEXT,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE map_nodes (
  session_id        TEXT NOT NULL,
  node_id           TEXT NOT NULL,
  parent_id         TEXT,
  title             TEXT NOT NULL,
  summary           TEXT NOT NULL DEFAULT '',
  last_action_seq   INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL,
  PRIMARY KEY (session_id, node_id)
);

CREATE TABLE map_node_notes (
  session_id        TEXT NOT NULL,
  node_id           TEXT NOT NULL,
  note_id           TEXT NOT NULL,
  attached_at       INTEGER NOT NULL,
  PRIMARY KEY (session_id, node_id, note_id)
);
```

#### 2) 原子批次 CAS 規則（`map_update`）
- 校驗 `expectedMapId === currentMapId`（首次創建時為 `null`）。
- 遍歷 `operations` 數組（1..100 項）：
  - 對既有節點的 `update_node / move_node / remove_node / focus_node`，強制校驗 `op.expectedLastActionSeq === node.last_action_seq`，不匹配立即回滾整批事務並返回最新節點狀態供重試。
  - 支持同批次內通過 `ref: "my_branch"` 定義臨時別名，後續操作用 `"$my_branch"` 作为 `nodeId` 或 `parentId`。
  - 提交後約束：整棵樹必須有且僅有一個 Root（`parent_id IS NULL`），且無環。

---

### 2.3 子系統 C：三元組知識圖譜與 Muse Peer（`src/knowledge-graph.ts`）

#### 1) 按 Anima 隔離的 `knowledge.sqlite3` 表結構
```sql
CREATE TABLE knowledge_nodes (
  id                TEXT PRIMARY KEY, -- 'n_' + 16 hex
  scope             TEXT NOT NULL CHECK (scope IN ('project', 'global')),
  project_id        TEXT,
  name              TEXT NOT NULL,
  kind              TEXT NOT NULL DEFAULT 'entity',
  tags              TEXT NOT NULL DEFAULT '[]',
  revision          INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE knowledge_edges (
  id                TEXT PRIMARY KEY, -- 'e_' + 16 hex
  scope             TEXT NOT NULL CHECK (scope IN ('project', 'global')),
  project_id        TEXT,
  from_id           TEXT NOT NULL,
  to_id             TEXT NOT NULL,
  relation          TEXT NOT NULL,
  tags              TEXT NOT NULL DEFAULT '[]',
  revision          INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);

CREATE TABLE knowledge_notes (
  id                TEXT PRIMARY KEY, -- 't_' + 32 hex
  scope             TEXT NOT NULL CHECK (scope IN ('project', 'global')),
  project_id        TEXT,
  kind              TEXT NOT NULL DEFAULT 'observation',
  content           TEXT NOT NULL,
  tags              TEXT NOT NULL DEFAULT '[]',
  revision          INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
```

- `knowledge_update`：支持 `op: "create" | "update"`，`type: "node" | "edge" | "note"`；`update` 時強制校驗 `expectedRevision === revision`。
- `consolidate_memory(level, hint)`：`shallow` 僅歸檔/錨定 Note；`deep` 啟動受限 Peer 從近期會話與 Note 中提取 `n_` 實體與 `e_` 關係。

---

### 2.4 子系統 D：Store-Backed 零預載 Skill 系統（`src/skills-store.ts`）

- **廢除 `persona.ts` 中的預拼接**：啟動 Session 時不把任何 `SKILL.md` 正文拼入 System Prompt。
- **Markdown 章節切片器**：將 `SKILL.md` 按 `# / ## / ###` 標題解析為章節樹。
- **工具鏈**：
  - `skill_search(query, limit, cursor)`：僅返回匹配的 Skill ID、名稱、描述與章節標題列表（不含正文）。
  - `skill_load(id, sections?, maxTokens?)`：讀取指定章節正文，寫入當前 Session 的 `skill_receipts(session_id, skill_id, etag, sections_json, loaded_at)` 表並作為工具結果返回；重複載入自動去重。
  - `skill_reload` / `skill_release` / `skill_status`：管理當前會話已載入的 Skill Receipt。
  - `skill_manage(action, ...)`：支持 `list / read / create / update / delete / history / restore`，基於內容 SHA-256 `etag` 做 CAS 保護，每次修改在 `.skill-history/<id>/<revision>/` 保存完整歷史快照。

---

### 2.5 子系統 E：持久子代理會話与多機 Worker 路由（`src/subagent.ts` & `src/worker.ts`）

1. **子代理即持久 Session（替換原 10 輪內存 `runSubAgent`）**：
   - `agent_spawn({ task, name, model, allow_subagent })`：在 `SessionRuntimeRegistry` 中創建真實持久 Session（記錄 `parent_session_id`），異步啟動 Run。
   - `agent_list` / `agent_peek(id, scope, turn)` / `agent_post(id, message, mode, abort)` / `agent_close(id)` / `main_agent_inspect(depth, turn)`。
   - `agent_wait({ event: { session, on }, async, persistent, timeout })`：
     - 同步模式（`async: false`）：阻塞等待目標 Session 進入 `idle | error | any`；若等待期間當前父 Session 收到用戶或代理發來的新消息，立即中斷等待並返回 `{ trigger: "message", interrupted: true }`（子代理繼續在後台跑）。
     - 異步模式（`async: true`）：在 `EventBus` 註冊訂閱並返回订阅 `id`；觸發時自動向父 Session 投遞喚醒消息。
2. **單次調用級 `worker_id` 路由**：
   - 在 `read / write / edit / glob / grep / bash / bash_output / bash_list / bash_kill / script` 中統一支持 `worker_id?: string`；
   - `workerRegistry.execute(sessionId, operation, args, signal, timeoutMs, explicitWorkerId)`：若傳入 `explicitWorkerId`，僅本次調用路由至該 Worker，不改變 Session 默認選中的 Worker，從而支持單輪並發操作多台機器。

---

## 三、RainyDays 實施批次路線圖（LC-01 ～ LC-05）

| 批次 | 核心交付物 | 修改/新增文件 | 驗收出口 |
| :--- | :--- | :--- | :--- |
| **LC-00** | 固化 `Lux-Cloud` 契約基線與差異診斷腳本 | `parity/baselines/lux-cloud-2026.json`、`docs/specs/lux-cloud-parity.md`、`scripts/check-lux-cloud-parity.mjs` | 自動化腳本精確輸出當前 RainyDays 與 Lux-Cloud 的逐工具、逐參數對齊率 |
| **LC-01** | 工程門禁減負 + Prefix Cache 凍結 + Thinking Effort + Pin 升級 | `src/agent.ts`、`src/llm.ts`、`src/tools/memory-tools.ts` | 連續多輪對話 System Prompt Hash 恆定不變；支持 `pin/unpin`（按 blockId/index）與 `thinking_effort_get/set` |
| **LC-02** | Canvas 冷熱分層 + `tool_result_read` + `canvas_history_*` + `compact_context` | `src/memory.ts`、`src/db.ts`、`src/tools/canvas-tools.ts` | 超長工具輸出自動轉預覽並可分頁讀取；冷歷史只讀檢索不污染熱窗口；`compact_context(focus)` 可無損回退 |
| **LC-03** | Session Agent Map 探索樹（CAS）+ 後台 Scribe 雙水位線 | `src/agent-map.ts`、`src/scribe.ts`、`src/prompt-compiler.ts` | `map_view/search/update` 11 種 CAS 操作與 `$ref` 通過測試；50% 異步準備、90% 邊界替換跑通 |
| **LC-04** | 零預載按章節 Skill + Anima 四件套 + 三元組知識圖譜 CAS + 真 Muse Peer | `src/skills-store.ts`、`src/anima.ts`、`src/tools/knowledge-tools.ts`、`src/muse.ts` | `skill_load(sections)` 按需載入與 `skill_manage` 版本回滾可用；`n_/e_/t_` `knowledge_update` CAS 與 `muse` 跑通 |
| **LC-05** | 持久子代理會話（`agent_*`）+ `cron_schedule_on_idle` + 單次調用級 `worker_id` | `src/subagent.ts`、`src/worker.ts`、`src/cron.ts`、`src/session-folders.ts` | 父子持久會話異步等待/消息打斷、`cron_schedule_on_idle` 空閒邊界觸發、跨 Worker 並發調用跑通 |
| **LC-06** | 主循環深度接線（50% Scribe 水位線、推理強度映射、Prompt 塊）與桌面 GUI `computer_use` | `src/agent.ts`、`src/memory.ts`、`src/llm.ts`、`src/worker.ts`、`scripts/rainydays-worker.mjs` | 60/60 工具契約對齊；`computer_use` 桌面截圖、窗口枚舉/聚焦、鍵鼠與剪貼板端到端跑通 |
| **LC-07** | 移動端遠程控制網關（Web/Tailscale/Tunnel 授權訪問）與微信個人號消息通道橋接 | `src/index.ts`、`src/event-bus.ts`、`src/channels/wechat-bridge.ts` | 支持受 Token 保護的移動端 Web 遠程訪問，以及通過「微信插件/測試號」或本機 PC 微信 UI Automation 的雙向指令派發與結果回傳 |
| **LC-08** | 吸收 DSH Superagent 協同範式：`Observe/Auto` 候選任務模式、`Ticket + Mandate` 授權邊界契約與跨渠道會話續接 | `src/lux-cloud-runtime.ts`、`src/task-tools.ts`、`src/tools/lux-cloud-tools.ts` | 群聊/外部通道默認 `observe` 生成候選工單（`auto` 自動接單）；`task_create`/`agent_spawn` 強制校驗 `Mandate` 範圍防越權；跨 IM/Web/Git 同一 Ticket 持續路由至原 Session |

---

## 四、後續擴展子系統設計（LC-07 ～ LC-08：遠程移動端操控與 Superagent 協同吸收）

### 4.1 子系統 F：移動端遠程控制面與個人微信通道橋接（LC-07）

1. **受控遠程 Web / PWA 控制面（`src/index.ts`）**：
   - 在默認 `127.0.0.1` 回環保護基礎上，提供顯式配置的遠程安全入口（`RAINYDAYS_ALLOW_REMOTE` / 受信任 `Host` 與 `Origin` 白名單，支持 Tailscale / Cloudflare Tunnel / 局域網訪問）。
   - 強制要求 `X-RainyDays-Token` 或 HttpOnly 簽名會話 Cookie，確保手機瀏覽器可隨時隨地派發任務、查看實時 SSE 流並進行 `ask_user` 審批。
2. **個人微信雙模接入通道（免封號合規優先）**：
   - **通道模式 1（官方 API 零風控）**：接入「微信插件（原企業微信個人端插件）」或「微信公眾平台開發者測試號」，用戶直接使用個人微信掃碼關注即可在微信聊天窗口收發文字、文件與桌面截圖，通過 Webhook 接入 `event-bus.ts`。
   - **通道模式 2（純本機 PC 微信 UI Automation / `computer_use` 橋接）**：不依賴任何第三方破解協議，直接通過 Windows UIA 與 `computer_use` 監聽本機 PC 微信「文件傳輸助手」或指定置頂窗口的新消息，執行完畢後通過剪貼板與熱鍵將結果/文件發回微信窗口。

### 4.2 子系統 G：吸收 DSH Superagent 精華設計（LC-08，形成對 DSH 底座的全面覆蓋）

針對 DeepSeek Harness `dsh-superagent` 原型的 Router-Worker 機制，將其最具價值的三項協同設計內化進 RainyDays：

1. **外部消息流的 `Observe`（影子觀察）與 `Auto`（自動接單）雙模式**：
   - **明確請求（Explicit Request）**：用戶直接私聊或 `@` 指派的任務，在任何模式下立即進入執行。
   - **推斷候選任務（Inferred Candidate Ticket）**：從群聊或工單流中識別出的潛在需求（如報錯討論、數據整理需求），在默認 `observe` 模式下**僅記錄並生成「候選任務卡片」供人工一鍵確認**（「本應接受並立項，原因：…」），不擅自消耗資源；切換至 `auto` 模式且命中啟用規則時才自動立項執行。
2. **`Ticket + Mandate`（任務授權範圍契約，防參考資料越權）**：
   - 嚴格區分「任務輸入/參考資料（Untrusted Reference）」與「任務授權範圍（`Mandate`）」。
   - 在 `task_create` 與 `agent_spawn` 中引入結構化 `mandate` 字段（記錄 `authorizedBy`、`allowedRoots`、`allowedToolCategories`、`deliverableScope`）。
   - 當後續追加評論或讀取到的文檔內容試圖誘導 Worker 超出原 `Mandate`（例如從「修日期格式」擴展為「重新部署生產環境」）時，子代理自動拒絕越界操作並交回主 Router 重新申請授權。
3. **跨渠道同 Ticket 會話續接（Cross-Channel Continuity）**：
   - 建立 `external_thread_id (WeChat / Feishu / GitHub PR / Web)` ↔ `ticket_id` ↔ `session_id` 持久化映射表。
   - 無論用戶在手機微信追加一句修改意見，還是在桌面 Web 端補充文件，均自動注入同一個持久工作 Session 的上下文並喚醒執行，無需人工搬運上下文。

