// ===========================================
// Persistent Terminal projection over SEC-03 ExecutionIsolationService
// ===========================================

import { createHmac, randomBytes, randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import type { IsolatedTerminalLease, ScopedExecutionGateway } from "./execution-runtime.js";
import type { NativeExecutionProof } from "./execution-native.js";
import type { ExecutionRootLease } from "./path-policy.js";
import { observeTerminalOwnerDenial, readIsolatedTerminal, resizeIsolatedTerminal, retireIsolatedTerminal, terminateIsolatedTerminal } from "./execution-runtime.js";
import {
  assertResourceOwner,
  registerOwnedResource,
  type ResourceOwner,
} from "./resource-owner.js";
import { logger } from "./logger.js";

export type TerminalShell = "cmd" | "powershell";
export type TerminalStatus = "running" | "exited" | "killed" | "error";
export type TerminalOwner = ResourceOwner;

export interface TerminalInfo {
  id: string;
  name: string;
  shell: TerminalShell;
  cwd: string;
  pid: number | null;
  status: TerminalStatus;
  exitCode: number | null;
  createdAt: string;
  updatedAt: string;
  outputStart: number;
  outputEnd: number;
  cols: number;
  rows: number;
  pty: "conpty";
}

export type TerminalEvent =
  | { type: "output"; terminalId: string; data: string; start: number; end: number; timestamp: number }
  | { type: "resize"; terminalId: string; cols: number; rows: number; timestamp: number }
  | { type: "status"; terminalId: string; status: TerminalStatus; exitCode: number | null; timestamp: number };

interface TerminalSession extends TerminalInfo {
  owner: TerminalOwner;
  isolationLease: IsolatedTerminalLease;
  output: string;
  observedNativeStdout: number;
  observedNativeStderr: number;
  stdoutDecoder: StringDecoder;
  stderrDecoder: StringDecoder;
  subscribers: Set<(event: TerminalEvent) => void>;
  poller: NodeJS.Timeout | null;
  unregisterOwnedResource: () => void;
}

export interface TerminalStartOptions {
  readonly name?: string;
  readonly shell?: TerminalShell;
  /** Display-only canonical CWD; never used as native root authority. */
  readonly authorizedCwd: string;
  readonly executionRootLease: ExecutionRootLease;
  readonly execution: ScopedExecutionGateway;
}

const MAX_TERMINALS = 8;
const MAX_OUTPUT_CHARS = 1024 * 1024;
const MAX_INPUT_CHARS = 64 * 1024;
const terminalAuditKey = randomBytes(32);

type TerminalOwnerDenialCode = "PATH_AUTHORITY_FORGED" | "EXEC_OWNER_MISMATCH";

class TerminalOwnerMismatchError extends Error {
  readonly code = "EXEC_OWNER_MISMATCH";
  readonly nativeObservation: NativeExecutionProof | null;

  constructor(nativeObservation: NativeExecutionProof | null = null) {
    super("Terminal owner mismatch");
    this.name = "TerminalOwnerMismatchError";
    this.nativeObservation = nativeObservation;
  }
}

function auditTerminalOwnerDenial(
  operation: string,
  terminalId: string,
  code: TerminalOwnerDenialCode = "PATH_AUTHORITY_FORGED"
): void {
  logger.warn("terminal-security", "terminal-owner-denied", {
    event: "terminal-owner-denied",
    code,
    operation,
    terminalFingerprint: createHmac("sha256", terminalAuditKey).update(terminalId).digest("hex"),
  });
}

export interface TerminalIsolationBackend {
  readonly read: (lease: IsolatedTerminalLease, owner: ResourceOwner) => Readonly<{
    stdout: string; stderr: string; stdoutBytes: Uint8Array; stderrBytes: Uint8Array;
    stdoutStart: number; stdoutEnd: number; stderrStart: number; stderrEnd: number;
    outputTruncated: boolean; running: boolean;
  }>;
  readonly terminate: (lease: IsolatedTerminalLease, owner: ResourceOwner, reason: string) => Promise<void>;
  readonly resize?: (lease: IsolatedTerminalLease, owner: ResourceOwner, cols: number, rows: number) => Promise<void>;
  readonly retire?: (lease: IsolatedTerminalLease, owner: ResourceOwner, reason: string) => Promise<void>;
  readonly observeOwnerDenial?: (lease: IsolatedTerminalLease, requester: ResourceOwner, operation: "kill" | "close", terminalId: string) => Promise<NativeExecutionProof>;
}

class TerminalManager {
  readonly #sessions = new Map<string, TerminalSession>();
  readonly #isolation: TerminalIsolationBackend;

  constructor(isolation: TerminalIsolationBackend) {
    this.#isolation = isolation;
  }

  async start(owner: TerminalOwner, options: TerminalStartOptions): Promise<TerminalInfo> {
    this.#assertOwner(owner);
    const activeCount = [...this.#sessions.values()].filter(session => session.status === "running").length;
    if (activeCount >= MAX_TERMINALS) throw new Error(`最多同时运行 ${MAX_TERMINALS} 个终端`);
    const shell = options.shell ?? "cmd";
    if (shell !== "cmd" && shell !== "powershell") throw new Error(`不支持的 Shell: ${shell}`);
    if (!options.authorizedCwd || !options.executionRootLease || !options.execution) throw new Error("终端缺少 SEC-03 执行授权");

    const id = `term_${randomUUID().slice(0, 8)}`;
    const name = (options.name || `${shell}-${this.#sessions.size + 1}`).trim().slice(0, 80) || id;
    const isolationLease = await options.execution.startShell({
      terminalId: id,
      shell,
      rootLease: options.executionRootLease,
    });
    const now = new Date().toISOString();
    const session: TerminalSession = {
      id,
      owner,
      isolationLease,
      name,
      shell,
      cwd: options.authorizedCwd,
      pid: null,
      status: "running",
      exitCode: null,
      createdAt: now,
      updatedAt: now,
      outputStart: 0,
      outputEnd: 0,
      cols: 120,
      rows: 30,
      pty: "conpty",
      output: "",
      observedNativeStdout: 0,
      observedNativeStderr: 0,
      stdoutDecoder: new StringDecoder("utf8"),
      stderrDecoder: new StringDecoder("utf8"),
      subscribers: new Set(),
      poller: null,
      unregisterOwnedResource: () => undefined,
    };
    this.#sessions.set(id, session);
    try {
      session.unregisterOwnedResource = registerOwnedResource(owner, () => this.#closeOwnedSession(session, true));
      session.poller = setInterval(() => this.#refresh(session), 100);
      session.poller.unref?.();
    } catch (error) {
      this.#sessions.delete(id);
      await this.#isolation.terminate(isolationLease, owner, "terminal-registration-failed").catch(() => undefined);
      throw error;
    }
    this.#refresh(session);
    return this.#toInfo(session);
  }

  list(owner: TerminalOwner): TerminalInfo[] {
    this.#assertOwner(owner);
    return [...this.#sessions.values()]
      .filter(session => this.#isOwner(session, owner))
      .map(session => { this.#refresh(session); return this.#toInfo(session); })
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  get(owner: TerminalOwner, id: string): TerminalInfo | undefined {
    this.#assertOwner(owner);
    const session = this.#sessions.get(id);
    if (session && !this.#isOwner(session, owner)) {
      auditTerminalOwnerDenial("get", id);
      return undefined;
    }
    if (!session) return undefined;
    this.#refresh(session);
    return this.#toInfo(session);
  }

  async input(owner: TerminalOwner, id: string, data: string, appendNewline: boolean, execution: ScopedExecutionGateway): Promise<void> {
    const session = this.#requireSession(owner, id, "input");
    if (session.status !== "running") throw new Error(`终端未运行: ${id} (${session.status})`);
    if (typeof data !== "string" || data.length === 0) throw new Error("输入不能为空");
    if (Buffer.byteLength(data, "utf8") > MAX_INPUT_CHARS) throw new Error(`单次输入不能超过 ${MAX_INPUT_CHARS} 字节`);
    if (data.includes("\0")) throw new Error("输入不能包含空字符");
    await execution.writeShell({ lease: session.isolationLease, terminalId: id, data, appendNewline });
    session.updatedAt = new Date().toISOString();
  }

  output(owner: TerminalOwner, id: string, offset?: number, limit = 20000): { data: string; start: number; nextOffset: number; truncated: boolean; info: TerminalInfo } {
    const session = this.#requireSession(owner, id, "output");
    this.#refresh(session);
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 20000, 1), 100000);
    const requested = Number.isFinite(offset) ? Math.max(0, Math.trunc(offset!)) : Math.max(session.outputStart, session.outputEnd - safeLimit);
    const start = Math.max(requested, session.outputStart);
    const relativeStart = start - session.outputStart;
    const data = session.output.slice(relativeStart, relativeStart + safeLimit);
    return { data, start, nextOffset: start + data.length, truncated: requested < session.outputStart || start + data.length < session.outputEnd, info: this.#toInfo(session) };
  }

  clear(owner: TerminalOwner, id: string): void {
    const session = this.#requireSession(owner, id, "clear");
    session.output = "";
    session.outputStart = session.outputEnd;
    session.updatedAt = new Date().toISOString();
  }

  async resize(owner: TerminalOwner, id: string, cols: number, rows: number): Promise<TerminalInfo> {
    const session = this.#requireSession(owner, id, "resize");
    if (session.status !== "running") throw new Error(`终端未运行: ${id} (${session.status})`);
    if (!Number.isSafeInteger(cols) || cols < 2 || cols > 500 || !Number.isSafeInteger(rows) || rows < 1 || rows > 300) {
      throw new Error("终端尺寸无效");
    }
    if (!this.#isolation.resize) throw new Error("PTY resize 不可用");
    if (session.cols === cols && session.rows === rows) return this.#toInfo(session);
    await this.#isolation.resize(session.isolationLease, owner, cols, rows);
    session.cols = cols;
    session.rows = rows;
    session.updatedAt = new Date().toISOString();
    const event: TerminalEvent = { type: "resize", terminalId: id, cols, rows, timestamp: Date.now() };
    for (const subscriber of session.subscribers) subscriber(event);
    return this.#toInfo(session);
  }

  async kill(owner: TerminalOwner, id: string): Promise<void> {
    await this.#killOwnedSession(await this.#requireMutationSession(owner, id, "kill"));
  }

  async close(owner: TerminalOwner, id: string): Promise<void> {
    await this.#closeOwnedSession(await this.#requireMutationSession(owner, id, "close"));
  }

  subscribe(owner: TerminalOwner, id: string, callback: (event: TerminalEvent) => void): () => void {
    const session = this.#requireSession(owner, id, "subscribe");
    session.subscribers.add(callback);
    return () => session.subscribers.delete(callback);
  }

  async disposeAll(): Promise<void> {
    const outcomes = await Promise.allSettled([...this.#sessions.values()].map(session => this.#closeOwnedSession(session)));
    const failure = outcomes.find(outcome => outcome.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  #assertOwner(owner: TerminalOwner): void { assertResourceOwner(owner); }
  #isOwner(session: TerminalSession, owner: TerminalOwner): boolean { return session.owner === owner; }

  #requireSession(owner: TerminalOwner, id: string, operation: string): TerminalSession {
    this.#assertOwner(owner);
    const session = this.#sessions.get(id);
    if (session && !this.#isOwner(session, owner)) {
      if (operation === "kill" || operation === "close") {
        auditTerminalOwnerDenial(operation, id, "EXEC_OWNER_MISMATCH");
        throw new TerminalOwnerMismatchError();
      }
      auditTerminalOwnerDenial(operation, id);
    }
    if (!session || !this.#isOwner(session, owner)) throw new Error(`终端不存在: ${id}`);
    return session;
  }

  async #requireMutationSession(owner: TerminalOwner, id: string, operation: "kill" | "close"): Promise<TerminalSession> {
    this.#assertOwner(owner);
    const session = this.#sessions.get(id);
    if (session && !this.#isOwner(session, owner)) {
      auditTerminalOwnerDenial(operation, id, "EXEC_OWNER_MISMATCH");
      let nativeObservation: NativeExecutionProof | null = null;
      if (this.#isolation.observeOwnerDenial) {
        try { nativeObservation = await this.#isolation.observeOwnerDenial(session.isolationLease, owner, operation, id); }
        catch { nativeObservation = null; }
      }
      throw new TerminalOwnerMismatchError(nativeObservation);
    }
    if (!session) throw new Error(`终端不存在: ${id}`);
    return session;
  }

  async #killOwnedSession(session: TerminalSession): Promise<void> {
    if (session.status !== "running") return;
    await this.#isolation.terminate(session.isolationLease, session.owner, "terminal-kill");
    this.#updateStatus(session, "killed", null);
  }

  async #closeOwnedSession(session: TerminalSession, ownerRetirement = false): Promise<void> {
    if (!this.#sessions.has(session.id)) return;
    if (session.status === "running") {
      if (ownerRetirement && this.#isolation.retire) {
        await this.#isolation.retire(session.isolationLease, session.owner, "owner-retired");
        this.#updateStatus(session, "killed", null);
      } else await this.#killOwnedSession(session);
    }
    if (session.poller) clearInterval(session.poller);
    session.poller = null;
    session.unregisterOwnedResource();
    session.subscribers.clear();
    this.#sessions.delete(session.id);
  }

  #refresh(session: TerminalSession): void {
    if (!this.#sessions.has(session.id)) return;
    try {
      const native = this.#isolation.read(session.isolationLease, session.owner);
      this.#consumeNativeStream(session, "stdout", native.stdoutBytes, native.stdoutStart, native.stdoutEnd);
      this.#consumeNativeStream(session, "stderr", native.stderrBytes, native.stderrStart, native.stderrEnd);
      if (!native.running && session.status === "running") this.#updateStatus(session, "exited", null);
    } catch (error) {
      if (session.status === "running") {
        this.#appendOutput(session, `\r\n[terminal error] ${error instanceof Error ? error.message : String(error)}\r\n`);
        this.#updateStatus(session, "error", null);
      }
    }
  }

  #consumeNativeStream(
    session: TerminalSession,
    stream: "stdout" | "stderr",
    retained: Uint8Array,
    start: number,
    end: number
  ): void {
    const observedKey = stream === "stdout" ? "observedNativeStdout" : "observedNativeStderr";
    const decoderKey = stream === "stdout" ? "stdoutDecoder" : "stderrDecoder";
    let observed = session[observedKey];
    if (observed < start) {
      session[decoderKey] = new StringDecoder("utf8");
      observed = start;
      this.#appendOutput(session, "\r\n\x1b[2m[earlier terminal output truncated]\x1b[0m\r\n");
    }
    if (end <= observed) return;
    const bytes = Buffer.from(retained);
    const offset = observed - start;
    if (offset < 0 || offset > bytes.length || end - start !== bytes.length) throw new Error("Native PTY output offsets are invalid");
    const firstStderr = stream === "stderr" && session.observedNativeStderr === 0;
    const decoded = session[decoderKey].write(bytes.subarray(offset));
    session[observedKey] = end;
    if (decoded) this.#appendOutput(session, `${firstStderr ? "\r\n[stderr]\r\n" : ""}${decoded}`);
  }

  #appendOutput(session: TerminalSession, chunk: string): void {
    if (!chunk) return;
    const start = session.outputEnd;
    session.output += chunk;
    session.outputEnd += chunk.length;
    session.updatedAt = new Date().toISOString();
    if (session.output.length > MAX_OUTPUT_CHARS) {
      const removeCount = session.output.length - MAX_OUTPUT_CHARS;
      session.output = session.output.slice(removeCount);
      session.outputStart += removeCount;
    }
    const event: TerminalEvent = { type: "output", terminalId: session.id, data: chunk, start, end: session.outputEnd, timestamp: Date.now() };
    for (const subscriber of session.subscribers) subscriber(event);
  }

  #updateStatus(session: TerminalSession, status: TerminalStatus, exitCode: number | null): void {
    if (session.status === status && session.exitCode === exitCode) return;
    session.status = status;
    session.exitCode = exitCode;
    session.updatedAt = new Date().toISOString();
    if (status !== "running" && session.poller) {
      clearInterval(session.poller);
      session.poller = null;
    }
    const event: TerminalEvent = { type: "status", terminalId: session.id, status, exitCode, timestamp: Date.now() };
    for (const subscriber of session.subscribers) subscriber(event);
  }

  #toInfo(session: TerminalSession): TerminalInfo {
    return {
      id: session.id, name: session.name, shell: session.shell, cwd: session.cwd, pid: session.pid,
      status: session.status, exitCode: session.exitCode, createdAt: session.createdAt, updatedAt: session.updatedAt,
      outputStart: session.outputStart, outputEnd: session.outputEnd,
      cols: session.cols, rows: session.rows, pty: session.pty,
    };
  }
}

function facadeFor(manager: TerminalManager) {
  return Object.freeze({
    list: (owner: TerminalOwner): TerminalInfo[] => manager.list(owner),
    start: (owner: TerminalOwner, options: TerminalStartOptions): Promise<TerminalInfo> => manager.start(owner, options),
    get: (owner: TerminalOwner, id: string): TerminalInfo | undefined => manager.get(owner, id),
    input: (owner: TerminalOwner, id: string, data: string, appendNewline: boolean, execution: ScopedExecutionGateway): Promise<void> =>
      manager.input(owner, id, data, appendNewline, execution),
    output: (owner: TerminalOwner, id: string, offset?: number, limit = 20000) => manager.output(owner, id, offset, limit),
    clear: (owner: TerminalOwner, id: string): void => manager.clear(owner, id),
    resize: (owner: TerminalOwner, id: string, cols: number, rows: number): Promise<TerminalInfo> => manager.resize(owner, id, cols, rows),
    kill: (owner: TerminalOwner, id: string): Promise<void> => manager.kill(owner, id),
    close: (owner: TerminalOwner, id: string): Promise<void> => manager.close(owner, id),
    subscribe: (owner: TerminalOwner, id: string, callback: (event: TerminalEvent) => void): (() => void) => manager.subscribe(owner, id, callback),
    disposeAllForShutdown: (): Promise<void> => manager.disposeAll(),
  });
}

const productionIsolation: TerminalIsolationBackend = Object.freeze({
  read: readIsolatedTerminal,
  terminate: terminateIsolatedTerminal,
  resize: resizeIsolatedTerminal,
  retire: retireIsolatedTerminal,
  observeOwnerDenial: observeTerminalOwnerDenial,
});

export const terminalFacade = facadeFor(new TerminalManager(productionIsolation));

/** Test-only in-memory projection factory. It cannot create a process; launch still comes from the supplied execution gateway. */
export function createTerminalFacadeForTests(isolation: TerminalIsolationBackend) {
  return facadeFor(new TerminalManager(isolation));
}
