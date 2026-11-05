# RainyDays vs Lux-Cloud 自動化契約對齊報告（LC-00）

> 生成腳本：`docs/research/check-lux-cloud-parity.mjs`
> 基準文件：`parity/baselines/lux-cloud-2026.json`（共 60 個核心原生工具契約；RainyDays 現有已註冊工具 161 個）

## 1. 總體統計

- **完全對齊 (aligned)**：60 / 60
- **同名但缺 Lux-Cloud 新增參數 (partial-schema)**：0 / 60
- **舊版別名/原型實現 (legacy-alias)**：0 / 60
- **完全缺失 (missing)**：0 / 60
- **已覆蓋（含同名與舊版別名）**：60 / 60 (100%)

## 2. 逐工具對齊明細表

| 子系統 | Lux-Cloud 工具 | 狀態 | RainyDays 現有映射 | RainyDays 現有參數 | 缺失的 Lux-Cloud 關鍵參數 |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `worker-fs` | `read` | **aligned** | `read (src/tools/filesystem-lux.ts)` | `file_path`, `offset`, `limit`, `byte_offset`, `max_bytes`, `pages`, `worker_id` | 無 |
| `worker-fs` | `write` | **aligned** | `write (src/tools/filesystem-lux.ts)` | `file_path`, `content`, `worker_id` | 無 |
| `worker-fs` | `edit` | **aligned** | `edit (src/tools/filesystem-lux.ts)` | `file_path`, `old_string`, `new_string`, `replace_all`, `worker_id` | 無 |
| `worker-fs` | `glob` | **aligned** | `glob (src/tools/filesystem-lux.ts)` | `pattern`, `path`, `head_limit`, `max_depth`, `timeout`, `worker_id` | 無 |
| `worker-fs` | `grep` | **aligned** | `grep (src/tools/filesystem-grep.ts)` | `pattern`, `path`, `glob`, `type`, `output_mode`, `regex_dialect`, `-i`, `-n`, `-A`, `-B`, `-C`, `context`, `head_limit`, `offset`, `multiline`, `timeout`, `worker_id` | 無 |
| `worker-exec` | `bash` | **aligned** | `bash (src/tools/worker-tools.ts)` | `command`, `cwd`, `timeout`, `description`, `session`, `shell`, `env`, `worker_id` | 無 |
| `worker-exec` | `bash_output` | **aligned** | `bash_output (src/tools/worker-tools.ts)` | `session`, `tail`, `wait`, `worker_id` | 無 |
| `worker-exec` | `bash_list` | **aligned** | `bash_list (src/tools/worker-tools.ts)` | `worker_id` | 無 |
| `worker-exec` | `bash_kill` | **aligned** | `bash_kill (src/tools/worker-tools.ts)` | `session`, `worker_id` | 無 |
| `worker-exec` | `script` | **aligned** | `script (src/tools/script.ts)` | `code`, `lang`, `cwd`, `timeout`, `worker_id` | 無 |
| `worker-plane` | `worker_list` | **aligned** | `worker_list (src/tools/worker-tools.ts)` | - | 無 |
| `worker-plane` | `worker_select` | **aligned** | `worker_select (src/tools/worker-tools.ts)` | `worker_id`, `workerId` | 無 |
| `worker-plane` | `worker_pairing_claim` | **aligned** | `worker_pairing_claim (src/tools/lux-cloud-tools.ts)` | `code` | 無 |
| `worker-plane` | `worker_file_upload` | **aligned** | `worker_file_upload (src/tools/lux-cloud-tools.ts)` | `file_path`, `worker_id` | 無 |
| `worker-plane` | `worker_file_download` | **aligned** | `worker_file_download (src/tools/lux-cloud-tools.ts)` | `file_id`, `output_path`, `overwrite`, `worker_id` | 無 |
| `worker-plane` | `preview_web` | **aligned** | `preview_web (src/tools/lux-cloud-tools.ts)` | `ports`, `ttl_seconds`, `worker_id` | 無 |
| `worker-plane` | `preview_list` | **aligned** | `preview_list (src/tools/lux-cloud-tools.ts)` | `worker_id` | 無 |
| `worker-plane` | `preview_close` | **aligned** | `preview_close (src/tools/lux-cloud-tools.ts)` | `id`, `worker_id` | 無 |
| `canvas-context` | `context_usage` | **aligned** | `context_usage (src/tools/lux-cloud-tools.ts)` | - | 無 |
| `canvas-context` | `compact_context` | **aligned** | `compact_context (src/tools/lux-cloud-tools.ts)` | `focus` | 無 |
| `canvas-context` | `pin` | **aligned** | `pin (src/tools/lux-cloud-tools.ts)` | `content` | 無 |
| `canvas-context` | `unpin` | **aligned** | `unpin (src/tools/lux-cloud-tools.ts)` | `blockId`, `index`, `all` | 無 |
| `canvas-context` | `tool_result_read` | **aligned** | `tool_result_read (src/tools/lux-cloud-tools.ts)` | `blockId`, `offset`, `maxChars` | 無 |
| `canvas-context` | `canvas_history_overview` | **aligned** | `canvas_history_overview (src/tools/lux-cloud-tools.ts)` | `after`, `limit` | 無 |
| `canvas-context` | `canvas_history_search` | **aligned** | `canvas_history_search (src/tools/lux-cloud-tools.ts)` | `query`, `after`, `limit` | 無 |
| `canvas-context` | `canvas_history_inspect` | **aligned** | `canvas_history_inspect (src/tools/lux-cloud-tools.ts)` | `blockId`, `offset`, `maxChars` | 無 |
| `canvas-context` | `prompt_inspect` | **aligned** | `prompt_inspect (src/tools/lux-cloud-tools.ts)` | `role` | 無 |
| `agent-map` | `map_view` | **aligned** | `map_view (src/tools/lux-cloud-tools.ts)` | `nodeId`, `depth`, `includeNotes`, `cursor` | 無 |
| `agent-map` | `map_search` | **aligned** | `map_search (src/tools/lux-cloud-tools.ts)` | `query`, `limit`, `cursor` | 無 |
| `agent-map` | `map_update` | **aligned** | `map_update (src/tools/lux-cloud-tools.ts)` | `expectedMapId`, `operations` | 無 |
| `knowledge-graph` | `remember` | **aligned** | `remember (src/tools/memory-tools.ts)` | `content`, `kind`, `tags`, `scope` | 無 |
| `knowledge-graph` | `recall` | **aligned** | `recall (src/tools/memory-tools.ts)` | `query`, `limit`, `scope`, `type` | 無 |
| `knowledge-graph` | `inspect` | **aligned** | `inspect (src/tools/knowledge-tools.ts)` | `id`, `name` | 無 |
| `knowledge-graph` | `graph` | **aligned** | `graph (src/tools/knowledge-tools.ts)` | `id`, `name`, `depth`, `edge_type` | 無 |
| `knowledge-graph` | `knowledge_update` | **aligned** | `knowledge_update (src/tools/lux-cloud-tools.ts)` | `op`, `type`, `scope`, `id`, `expectedRevision`, `name`, `kind`, `from`, `to`, `relation`, `content`, `tags` | 無 |
| `knowledge-graph` | `consolidate_memory` | **aligned** | `consolidate_memory (src/tools/lux-cloud-tools.ts)` | `level`, `hint` | 無 |
| `knowledge-graph` | `muse` | **aligned** | `muse (src/tools/phase1-tools.ts)` | `about`, `kind`, `topic`, `perspective` | 無 |
| `skills` | `skill_search` | **aligned** | `skill_search (src/tools/lux-cloud-tools.ts)` | `query`, `limit`, `cursor` | 無 |
| `skills` | `skill_load` | **aligned** | `skill_load (src/tools/lux-cloud-tools.ts)` | `id`, `sections`, `maxTokens` | 無 |
| `skills` | `skill_reload` | **aligned** | `skill_reload (src/tools/lux-cloud-tools.ts)` | `id`, `sections`, `maxTokens` | 無 |
| `skills` | `skill_release` | **aligned** | `skill_release (src/tools/lux-cloud-tools.ts)` | `id` | 無 |
| `skills` | `skill_status` | **aligned** | `skill_status (src/tools/lux-cloud-tools.ts)` | - | 無 |
| `skills` | `skill_manage` | **aligned** | `skill_manage (src/tools/lux-cloud-tools.ts)` | `action`, `id`, `key`, `etag`, `expected_absent`, `content`, `file`, `files`, `remove_files`, `package_base64`, `revision`, `query`, `cursor`, `limit`, `offset`, `max_bytes` | 無 |
| `subagents-models` | `models_list` | **aligned** | `models_list (src/tools/lux-cloud-tools.ts)` | - | 無 |
| `subagents-models` | `thinking_effort_get` | **aligned** | `thinking_effort_get (src/tools/lux-cloud-tools.ts)` | - | 無 |
| `subagents-models` | `thinking_effort_set` | **aligned** | `thinking_effort_set (src/tools/lux-cloud-tools.ts)` | `effort` | 無 |
| `subagents-models` | `agent_spawn` | **aligned** | `agent_spawn (src/tools/lux-cloud-tools.ts)` | `task`, `name`, `model`, `allow_subagent` | 無 |
| `subagents-models` | `agent_list` | **aligned** | `agent_list (src/tools/lux-cloud-tools.ts)` | `scope`, `status`, `query`, `updated_after`, `limit`, `cursor` | 無 |
| `subagents-models` | `agent_peek` | **aligned** | `agent_peek (src/tools/lux-cloud-tools.ts)` | `id`, `scope`, `turn` | 無 |
| `subagents-models` | `agent_post` | **aligned** | `agent_post (src/tools/lux-cloud-tools.ts)` | `id`, `message`, `mode`, `abort` | 無 |
| `subagents-models` | `agent_wait` | **aligned** | `agent_wait (src/tools/lux-cloud-tools.ts)` | `event`, `async`, `persistent`, `timeout` | 無 |
| `subagents-models` | `agent_cancel_wait` | **aligned** | `agent_cancel_wait (src/tools/lux-cloud-tools.ts)` | `id` | 無 |
| `subagents-models` | `agent_close` | **aligned** | `agent_close (src/tools/lux-cloud-tools.ts)` | `id` | 無 |
| `subagents-models` | `main_agent_inspect` | **aligned** | `main_agent_inspect (src/tools/lux-cloud-tools.ts)` | `depth`, `turn` | 無 |
| `subagents-models` | `session_folders` | **aligned** | `session_folders (src/tools/lux-cloud-tools.ts)` | `action`, `folder`, `query`, `limit`, `cursor`, `expected_revision`, `request_id`, `plan_id`, `undo_id`, `dry_run`, `compact`, `operations` | 無 |
| `cron` | `cron_schedule` | **aligned** | `cron_schedule (src/tools/cron-tools.ts)` | `message`, `delay`, `repeat`, `target`, `tag` | 無 |
| `cron` | `cron_schedule_on_idle` | **aligned** | `cron_schedule_on_idle (src/tools/lux-cloud-tools.ts)` | `delay`, `message`, `repeat`, `tag` | 無 |
| `cron` | `cron_list` | **aligned** | `cron_list (src/tools/cron-tools.ts)` | - | 無 |
| `cron` | `cron_cancel` | **aligned** | `cron_cancel (src/tools/cron-tools.ts)` | `id`, `tag` | 無 |
| `interaction` | `ask_user` | **aligned** | `ask_user (src/tools/ask-user-tool.ts)` | `question`, `options`, `questions` | 無 |
