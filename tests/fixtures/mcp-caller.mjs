// A test-owned app process that the parent deliberately terminates while MCP is busy.
import path from "node:path";
const [directory, serverFile, pidFile] = process.argv.slice(2);
Object.assign(process.env, { RAINYDAYS_USER_DATA_DIR: directory, RAINYDAYS_DATA_DIR: path.join(directory, "data"), RAINYDAYS_CONFIG_PATH: path.join(directory, "config.json") });
const { initializeConfig } = await import("../../src/config.ts"); await initializeConfig();
const { issueResourceOwner } = await import("../../src/resource-owner.ts");
const { McpConnection } = await import("../../src/mcp/client.ts");
const { parseMcpServers } = await import("../../src/mcp/settings.ts");
const [server] = parseMcpServers([{ name: "abrupt-caller", enabled: true, transport: "stdio", command: process.execPath, args: [serverFile], url: "" }]);
const connection = new McpConnection(server);
await connection.open(directory, issueResourceOwner({ authorityId: "fixture", authorityEpoch: 1, sessionId: "fixture", principal: "agent", rootIds: ["workspace"] }), new AbortController().signal);
await connection.call("hang", { pidFile }, new AbortController().signal);
