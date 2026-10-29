import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { getDefaultEnvironment } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { terminateProcessTree } from "../process-tree.js";
import { registerOwnedResource, type ResourceOwner } from "../resource-owner.js";
import { getBootstrapPathStore } from "../bootstrap-path-store.js";
import { WINDOWS_JOB_HOST } from "./windows-job-host.js";

/** Raw pipes only: SDK owns the protocol, existing owner/tree lifecycle owns the process. */
export class OwnedStdioTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  protocolVersion = "";
  private child?: ChildProcessWithoutNullStreams;
  private stopping?: Promise<void>;
  private unregister = () => {};
  private closed = false;
  private readonly buffer = new ReadBuffer({ maxBufferSize: 2 * 1024 * 1024 });
  constructor(private readonly input: { command: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; owner: ResourceOwner }) {}
  setProtocolVersion(version: string): void { this.protocolVersion = version; }
  async start(): Promise<void> {
    if (this.child || this.closed) throw new Error("MCP transport is unavailable");
    this.unregister = registerOwnedResource(this.input.owner, () => this.close());
    if (process.platform !== "win32") throw new Error("MCP owned process backend requires Windows");
    const executable = await getBootstrapPathStore().openTerminalShell("powershell");
    let child: ChildProcessWithoutNullStreams;
    try {
      await executable.assertCurrent("beforeProcessSpawn");
      if (this.closed) throw new Error("MCP transport was closed before launch");
      child = this.child = spawn(executable.canonicalPath, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(WINDOWS_JOB_HOST, "utf16le").toString("base64")], { cwd: this.input.cwd, env: { ...getDefaultEnvironment(), RAINYDAYS_MCP_LAUNCH: Buffer.from(JSON.stringify(this.input)).toString("base64") }, shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", () => reject(new Error("MCP server could not start"))); });
    } finally { await executable.close(); }
    child.stdin.on("error", () => this.onerror?.(new Error("MCP input pipe failed")));
    child.stdout.on("data", (bytes: Buffer) => {
      try {
        this.buffer.append(bytes);
        for (let message = this.buffer.readMessage(); message; message = this.buffer.readMessage()) this.onmessage?.(message);
      } catch { this.onerror?.(new Error("MCP protocol output is invalid or exceeds 2MiB")); void this.close().catch(() => undefined); }
    });
    // Drain logs without mixing them into protocol or disclosing environment values.
    child.stderr.on("data", () => undefined);
    child.once("exit", () => this.notifyClosed());
    child.once("error", () => { this.onerror?.(new Error("MCP server could not start")); this.notifyClosed(); });
    if (child.exitCode !== null || child.signalCode !== null) this.notifyClosed();
  }
  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.child?.stdin;
    if (this.closed || !stdin?.writable) throw new Error("MCP connection closed");
    await new Promise<void>((resolve, reject) => stdin.write(serializeMessage(message), error => error ? reject(new Error("MCP input failed")) : resolve()));
  }
  close(): Promise<void> {
    this.stopping ??= (async () => {
      const child = this.child;
      if (child && child.exitCode === null && child.signalCode === null && child.pid) await terminateProcessTree(child);
      this.buffer.clear(); this.unregister(); this.notifyClosed();
    })();
    return this.stopping;
  }
  private notifyClosed(): void { if (!this.closed) { this.closed = true; this.onclose?.(); } }
}
