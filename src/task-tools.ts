import type { ToolExecutionOutcome, ToolProtocolDescriptor } from "./types.js";

const commonTools = new Set(["glob", "read", "grep", "write", "edit", "get_current_time", "ask_user", "web_search", "fetch_markdown", "create_docx", "create_xlsx", "search_tools"]);
// A14：开发模式下编码核心工具与计划工具首轮常驻；仍只取人格允许列表内的工具。
const developerTools = new Set(["read_repo", "edit_files", "undo_edits", "execute_command", "shell_start", "shell_input", "shell_output", "shell_list", "shell_kill", "task_create", "task_update", "task_list", "task_get"]);

/** One run's visible schemas; the authentic Broker remains the authority for every execution. */
export class TaskToolSelection {
  readonly #allowed: Map<string, ToolProtocolDescriptor>;
  readonly #loaded: Set<string>;
  readonly enabled: boolean;

  constructor(personaName: string, allowed: readonly ToolProtocolDescriptor[], options: Readonly<{ developerMode?: boolean }> = {}) {
    this.#allowed = new Map(allowed.map(protocol => [protocol.name, protocol]));
    this.enabled = personaName === "general" && this.#allowed.has("search_tools");
    const resident = (name: string) => commonTools.has(name) || (options.developerMode === true && developerTools.has(name));
    this.#loaded = new Set(allowed.filter(protocol => !this.enabled || resident(protocol.name)).map(protocol => protocol.name));
  }

  has(name: string): boolean { return this.#loaded.has(name); }
  protocols(): ToolProtocolDescriptor[] { return [...this.#allowed.values()].filter(protocol => this.#loaded.has(protocol.name)); }

  discover(toolName: string, outcome: Pick<ToolExecutionOutcome, "status" | "content" | "truncated">): void {
    if (!this.enabled || toolName !== "search_tools" || outcome.status !== "success" || outcome.truncated) return;
    try {
      const receipt = JSON.parse(outcome.content);
      if (receipt.type !== "tool_discovery" || !Array.isArray(receipt.tools)) return;
      for (const name of receipt.tools) if (typeof name === "string" && this.#allowed.has(name)) this.#loaded.add(name);
    } catch { /* legacy discovery text does not establish a schema-loading receipt */ }
  }
}
