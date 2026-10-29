import { createHash } from "node:crypto";
import { validateCredentialReference } from "../credential-store.js";

export interface McpToolSetting {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}
export interface McpServerSetting {
  name: string;
  enabled: boolean;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  url: string;
  cwd: string;
  /** Values are vault references, never plaintext environment secrets. */
  env: Record<string, string>;
  tools: McpToolSetting[];
  protocolVersion: string;
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label}必须是对象`);
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max: number, empty = true): string {
  if (typeof value !== "string" || value.length > max || (!empty && !value.trim()) || value.includes("\0")) throw new TypeError(`${label}无效`);
  return value;
}
export function parseMcpTools(value: unknown): McpToolSetting[] {
  if (!Array.isArray(value) || value.length > 128 || Buffer.byteLength(JSON.stringify(value)) > 256 * 1024) throw new TypeError("MCP工具目录过大或无效");
  const seen = new Set<string>();
  return value.map(entry => {
    const item = object(entry, "MCP工具"), name = text(item.name, "MCP工具名称", 128, false);
    if (seen.has(name)) throw new TypeError("MCP工具名称重复"); seen.add(name);
    const inputSchema = object(item.inputSchema, "MCP工具参数");
    if (inputSchema.type !== "object") throw new TypeError("MCP工具参数须为object schema");
    return { name, description: text(item.description ?? "", "MCP工具说明", 8192), inputSchema: JSON.parse(JSON.stringify(inputSchema)) };
  });
}
export function parseMcpServers(value: unknown): McpServerSetting[] {
  if (!Array.isArray(value) || value.length > 32 || Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) throw new TypeError("MCP servers 无效或超过1MiB");
  const seen = new Set<string>();
  return value.map(entry => {
    const item = object(entry, "MCP server");
    const allowed = new Set(["name", "enabled", "transport", "command", "args", "url", "cwd", "env", "tools", "protocolVersion"]);
    if (Object.keys(item).some(key => !allowed.has(key))) throw new TypeError("MCP server包含未知字段");
    const name = text(item.name, "MCP名称", 64, false);
    if (seen.has(name)) throw new TypeError("MCP name重复"); seen.add(name);
    if (typeof item.enabled !== "boolean" || (item.transport !== "stdio" && item.transport !== "http")) throw new TypeError("MCP启用状态或传输无效");
    if (!Array.isArray(item.args) || item.args.length > 64) throw new TypeError("MCP args无效");
    const args = item.args.map(arg => text(arg, "MCP参数", 1024));
    const command = text(item.command, "MCP命令", 2048), url = text(item.url, "MCP URL", 2048);
    if (item.transport === "stdio" && !command) throw new TypeError("stdio MCP缺少command");
    if (item.transport === "http") {
      const target = new URL(url);
      if (target.protocol !== "https:" || target.username || target.password || target.hash) throw new TypeError("MCP URL须为无凭据的HTTPS地址");
    }
    const env = object(item.env ?? {}, "MCP环境变量");
    if (Object.keys(env).length > 32) throw new TypeError("MCP环境变量过多");
    const references = Object.fromEntries(Object.entries(env).map(([key, reference]) => {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/u.test(key) || /^(?:RAINYDAYS_|ELECTRON_)/iu.test(key)) throw new TypeError("MCP环境变量名称无效");
      return [key, reference === "" ? "" : validateCredentialReference(reference)];
    }));
    if (new Set(Object.keys(references).map(key => key.toUpperCase())).size !== Object.keys(references).length) throw new TypeError("MCP环境变量名称重复");
    return { name, enabled: item.enabled, transport: item.transport, command, args, url, cwd: text(item.cwd ?? "", "MCP cwd", 2048), env: references, tools: parseMcpTools(item.tools ?? []), protocolVersion: text(item.protocolVersion ?? "", "MCP协议版本", 64) };
  });
}
/** Public forms keep existing secrets with an empty placeholder; refs are never accepted from a client. */
export function prepareMcpSettings(input: Record<string, unknown>, current: McpServerSetting[]): McpServerSetting[] {
  if (!Array.isArray(input.servers)) throw new TypeError("MCP servers 无效");
  const parsed = parseMcpServers(input.servers.map(entry => {
    const item = object(entry, "MCP server");
    const old = current.find(server => server.name === item.name);
    const env = object(item.env ?? {}, "MCP环境变量");
    return { ...item, env: Object.fromEntries(Object.entries(env).map(([key, value]) => {
      if (value !== "" && value !== old?.env[key]) throw new TypeError("MCP环境变量须通过秘密输入更新");
      return [key, old?.env[key] ?? ""];
    })) };
  }));
  for (const server of parsed) {
    const old = current.find(entry => entry.name === server.name);
    if (old && mcpConfigurationKey(old) !== mcpConfigurationKey(server)) { server.tools = []; server.protocolVersion = ""; }
  }
  return parsed;
}
export function mcpEnvironmentValues(input: unknown, servers: McpServerSetting[]): Array<{ server: McpServerSetting; key: string; value: string }> {
  if (input === undefined) return [];
  const values = object(input, "MCP环境秘密"), result: Array<{ server: McpServerSetting; key: string; value: string }> = [];
  for (const [name, raw] of Object.entries(values)) {
    const server = servers.find(entry => entry.name === name);
    if (!server) throw new TypeError("MCP环境秘密服务器不存在");
    for (const [key, rawValue] of Object.entries(object(raw, "MCP环境秘密"))) {
      if (!Object.hasOwn(server.env, key)) throw new TypeError("MCP环境秘密名称不存在");
      const value = text(rawValue, "MCP环境秘密", 8192);
      if (value) result.push({ server, key, value });
    }
  }
  return result;
}
export function mcpConfigurationKey(server: McpServerSetting): string {
  return createHash("sha256").update(JSON.stringify({ name: server.name, transport: server.transport, command: server.command, args: server.args, cwd: server.cwd, env: server.env, url: server.url })).digest("hex");
}
export function mcpToolName(server: string, tool: string): string {
  const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9_-]/gu, "_").slice(0, 16);
  return `mcp__${slug(server)}__${slug(tool)}_${createHash("sha256").update(JSON.stringify([server, tool])).digest("hex").slice(0, 12)}`;
}
