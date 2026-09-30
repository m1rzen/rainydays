import type { ToolExecutionOutcome, ToolProtocolDescriptor } from "./types.js";

const commonTools = new Set(["glob", "read", "grep", "write", "edit", "get_current_time", "ask_user", "web_search", "fetch_markdown", "create_docx", "create_xlsx", "search_tools"]);

/** One run's visible schemas; the authentic Broker remains the authority for every execution. */
export class TaskToolSelection {
  readonly #allowed: Map<string, ToolProtocolDescriptor>;
  readonly #loaded: Set<string>;
  readonly enabled: boolean;

  constructor(personaName: string, allowed: readonly ToolProtocolDescriptor[]) {
    this.#allowed = new Map(allowed.map(protocol => [protocol.name, protocol]));
    this.enabled = personaName === "general" && this.#allowed.has("search_tools");
    this.#loaded = new Set(allowed.filter(protocol => !this.enabled || commonTools.has(protocol.name)).map(protocol => protocol.name));
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
