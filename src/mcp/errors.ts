export class McpRemoteRequestError extends Error {
  constructor(readonly code: "MCP_AUTH_REQUIRED" | "MCP_CONNECTION_LOST", message: string) { super(message); this.name = "McpRemoteRequestError"; }
}
