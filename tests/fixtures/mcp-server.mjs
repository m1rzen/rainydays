import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";

const server = new Server({ name: "rainydays-fixture", version: "1.0.0" }, { capabilities: { tools: { listChanged: true } } });
const tools = [
  { name: "echo", description: "Fixture text, error, crash or large output", inputSchema: { type: "object", properties: { text: { type: "string" }, action: { type: "string" } } } },
  { name: "fail", description: "Fixture typed tool error", inputSchema: { type: "object", properties: {} } },
  { name: "hang", description: "Wait until cancelled with a live descendant", inputSchema: { type: "object", properties: { pidFile: { type: "string" }, action: { type: "string" } } } },
];
server.setRequestHandler(ListToolsRequestSchema, async request => ({ tools: [tools[Number(request.params?.cursor ?? 0)]], ...(Number(request.params?.cursor ?? 0) < 2 ? { nextCursor: String(Number(request.params?.cursor ?? 0) + 1) } : {}) }));
server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
  const args = request.params.arguments ?? {};
  console.error("fixture stderr is not a protocol message");
  if (request.params.name === "fail") return { isError: true, content: [{ type: "text", text: "fixture tool failed" }] };
  if (request.params.name === "echo") {
    if (args.action === "crash") process.exit(17);
    if (args.action === "changed") { tools[0].inputSchema.required = ["text"]; await server.sendToolListChanged(); }
    if (args.action === "throw") throw new Error("fixture protocol tool error");
    return { content: [{ type: "text", text: args.action === "large" ? "中文 result\n".repeat(10000) : String(args.text ?? "") }] };
  }
  if (request.params.name === "hang") {
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { windowsHide: true, stdio: "ignore" });
    if (args.pidFile) await writeFile(args.pidFile, JSON.stringify([process.pid, child.pid]));
    if (args.action === "crash-tree") process.exit(18);
    await new Promise(resolve => extra.signal.addEventListener("abort", resolve, { once: true }));
    // Client must close the owned process tree even when a server ignores cancellation.
    await new Promise(() => {});
  }
  throw new Error("unknown fixture tool");
});
await server.connect(new StdioServerTransport());
