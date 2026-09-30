import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { LLMClient } from "./llm.js";
import { PLAYBOOKS_ARCHIVED_DIR, PLAYBOOKS_DIR } from "./runtime-paths.js";
import { RunCancellationError, isRunCancellation, throwIfCancelled } from "./run-cancellation.js";
import type { CapabilityContext } from "./capability-broker.js";
import type { ToolDefinition, ToolExecutor, ToolInvocationServices } from "./types.js";

export interface PlaybookStep { message: string; description?: string }
export interface Playbook { name: string; description: string; steps: PlaybookStep[] }
export interface PlaybookOwner { readonly sessionId: string; readonly runId: string }
export interface PlaybookRun {
  id: string;
  ownerSessionId: string;
  ownerRunId: string;
  playbookName: string;
  currentStep: number;
  totalSteps: number;
  status: "running" | "completed" | "failed" | "aborted";
  results: string[];
  startedAt: string;
}

export type PlaybookStatusName = "idle" | "running" | "completed" | "failed" | "aborted" | "interrupted";

export interface PlaybookProject {
  readonly playbookId: string;
  readonly name: string;
  readonly description: string;
  readonly archived: boolean;
  readonly projectPath: string;
}

export interface PlaybookArtifact {
  readonly name: string;
  readonly path: string;
  readonly preview: string;
}

export interface PlaybookStatus {
  readonly playbookId: string;
  readonly runId: string | null;
  readonly status: PlaybookStatusName;
  readonly startedAt: string | null;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly result: unknown;
  readonly error: string | null;
  readonly reason: string | null;
  readonly childSessionIds: readonly string[];
  readonly logTail: readonly string[];
  readonly artifacts: readonly PlaybookArtifact[];
}

interface StoredPackage {
  readonly name: string;
  readonly private: true;
  readonly type: "module";
  readonly lux: Readonly<{ playbook: Readonly<{ id: string; name: string; description: string }> }>;
}

interface MutableStatus {
  playbookId: string;
  runId: string;
  status: Exclude<PlaybookStatusName, "idle" | "interrupted">;
  startedAt: string;
  updatedAt: string;
  completedAt: string | null;
  result: unknown;
  error: string | null;
  reason: string | null;
  childSessionIds: string[];
  logTail: string[];
  artifacts: PlaybookArtifact[];
}

interface ActivePlaybookRun {
  readonly project: PlaybookProject;
  readonly sourcePath: string;
  readonly controller: AbortController;
  readonly status: MutableStatus;
  readonly invocation: ToolInvocationServices;
  readonly llm: LLMClient;
  readonly persona: Readonly<{ systemPrompt: string }>;
  readonly completion: Promise<void>;
  writeQueue: Promise<void>;
}

interface PlaybookRuntimeContext {
  readonly active: ActivePlaybookRun;
  doneCalled: boolean;
  doneValue: unknown;
  childCounter: number;
}

const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const DATA_KEY = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/u;
const MAX_SOURCE_CHARS = 256 * 1024;
const MAX_LOG_LINES = 200;
const activePlaybooks = new Map<string, ActivePlaybookRun>();
const startingPlaybooks = new Set<string>();
const runtimeStorage = new AsyncLocalStorage<PlaybookRuntimeContext>();
const legacyRuns = new Map<string, PlaybookRun>();

function exactId(value: unknown): string {
  if (typeof value !== "string" || !PROJECT_ID.test(value)) throw new TypeError("Playbook id is invalid");
  return value;
}

function exactText(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0) || value.length > maximum || value.includes("\0")) throw new TypeError(`${label} is invalid`);
  return value;
}

function safeDataKey(value: unknown, label: string): string {
  if (typeof value !== "string" || !DATA_KEY.test(value)) throw new TypeError(`${label} is invalid`);
  return value;
}

function cloneJson<T>(value: T, label: string): T {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError(`${label} must be JSON-serializable`);
    return JSON.parse(encoded) as T;
  } catch (error) {
    if (error instanceof TypeError && error.message.includes("JSON-serializable")) throw error;
    throw new TypeError(`${label} must be JSON-serializable`, { cause: error });
  }
}

function slug(value: string): string {
  const normalized = value.toLocaleLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48);
  return normalized || "playbook";
}

async function ensureRoots(): Promise<void> {
  await Promise.all([mkdir(PLAYBOOKS_DIR, { recursive: true }), mkdir(PLAYBOOKS_ARCHIVED_DIR, { recursive: true })]);
}

function projectPath(root: string, playbookId: string): string {
  return path.join(root, exactId(playbookId));
}

async function assertDirectory(candidate: string, label: string): Promise<void> {
  const info = await lstat(candidate);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} is not a real directory`);
}

async function atomicJson(filePath: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${randomUUID()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rm(filePath, { force: true });
  await rename(temporary, filePath);
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function parsePackage(playbookId: string, value: unknown): StoredPackage["lux"]["playbook"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`Playbook ${playbookId} package.json is invalid`);
  const root = value as Record<string, unknown>;
  const lux = root.lux;
  if (!lux || typeof lux !== "object" || Array.isArray(lux)) throw new TypeError(`Playbook ${playbookId} package.json has no lux.playbook`);
  const metadata = (lux as Record<string, unknown>).playbook;
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) throw new TypeError(`Playbook ${playbookId} metadata is invalid`);
  const record = metadata as Record<string, unknown>;
  if (record.id !== playbookId) throw new TypeError(`Playbook ${playbookId} metadata id differs`);
  return Object.freeze({
    id: playbookId,
    name: exactText(record.name, `Playbook ${playbookId} name`, 120),
    description: exactText(record.description ?? "", `Playbook ${playbookId} description`, 2_000, true),
  });
}

async function loadProjectFrom(root: string, playbookIdInput: string, archived: boolean): Promise<Readonly<{ project: PlaybookProject; sourcePath: string }>> {
  const playbookId = exactId(playbookIdInput);
  const directory = projectPath(root, playbookId);
  await assertDirectory(directory, `Playbook ${playbookId}`);
  const packagePath = path.join(directory, "package.json");
  const sourcePath = path.join(directory, "playbook.mjs");
  const [packageInfo, sourceInfo] = await Promise.all([lstat(packagePath), lstat(sourcePath)]);
  if (!packageInfo.isFile() || packageInfo.isSymbolicLink() || !sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error(`Playbook ${playbookId} project files are invalid`);
  const metadata = parsePackage(playbookId, await readJson(packagePath));
  const source = await readFile(sourcePath, "utf8");
  exactText(source, `Playbook ${playbookId} source`, MAX_SOURCE_CHARS);
  return Object.freeze({
    project: Object.freeze({ playbookId, name: metadata.name, description: metadata.description, archived, projectPath: directory }),
    sourcePath,
  });
}

async function loadProject(playbookId: string): Promise<Readonly<{ project: PlaybookProject; sourcePath: string }>> {
  await ensureRoots();
  try {
    return await loadProjectFrom(PLAYBOOKS_DIR, playbookId, false);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return loadProjectFrom(PLAYBOOKS_ARCHIVED_DIR, playbookId, true);
  }
}

async function listRoot(root: string, archived: boolean): Promise<PlaybookProject[]> {
  const results: PlaybookProject[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !PROJECT_ID.test(entry.name)) continue;
    try {
      results.push((await loadProjectFrom(root, entry.name, archived)).project);
    } catch (error) {
      console.error(`Skipping invalid Playbook ${entry.name}:`, error);
    }
  }
  return results;
}

export async function listPlaybooks(options: Readonly<{ includeArchived?: boolean; archivedOnly?: boolean }> = {}): Promise<PlaybookProject[]> {
  await ensureRoots();
  if (options.archivedOnly) return (await listRoot(PLAYBOOKS_ARCHIVED_DIR, true)).sort((a, b) => a.playbookId.localeCompare(b.playbookId));
  const active = await listRoot(PLAYBOOKS_DIR, false);
  const archived = options.includeArchived ? await listRoot(PLAYBOOKS_ARCHIVED_DIR, true) : [];
  return [...active, ...archived].sort((a, b) => a.playbookId.localeCompare(b.playbookId));
}

export async function createPlaybook(input: Readonly<{ name?: string; description?: string; script?: string }>): Promise<PlaybookProject> {
  await ensureRoots();
  const name = exactText(input.name ?? "Playbook", "Playbook name", 120);
  const description = exactText(input.description ?? "", "Playbook description", 2_000, true);
  const source = input.script === undefined
    ? "lux.log('Playbook started');\nlux.done({ ok: true, playbookId: lux.playbookId });"
    : exactText(input.script, "Playbook source", MAX_SOURCE_CHARS);
  const base = slug(name);
  let playbookId = base;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = attempt === 0 ? base : `${base}-${randomBytes(3).toString("hex")}`;
    try {
      await mkdir(projectPath(PLAYBOOKS_DIR, candidate), { recursive: false });
      playbookId = candidate;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST" || attempt === 19) throw error;
    }
  }
  const directory = projectPath(PLAYBOOKS_DIR, playbookId);
  const packageValue: StoredPackage = Object.freeze({
    name: `@rainydays/playbook-${playbookId}`,
    private: true,
    type: "module",
    lux: Object.freeze({ playbook: Object.freeze({ id: playbookId, name, description }) }),
  });
  try {
    await Promise.all([
      writeFile(path.join(directory, "package.json"), `${JSON.stringify(packageValue, null, 2)}\n`, { encoding: "utf8", flag: "wx" }),
      writeFile(path.join(directory, "playbook.mjs"), `${source.trim()}\n`, { encoding: "utf8", flag: "wx" }),
    ]);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return (await loadProjectFrom(PLAYBOOKS_DIR, playbookId, false)).project;
}

function statusFile(project: PlaybookProject, runId = "latest"): string {
  return path.join(project.projectPath, "runs", runId === "latest" ? "latest.json" : path.join(runId, "status.json"));
}

function snapshot(status: MutableStatus): PlaybookStatus {
  return Object.freeze({
    playbookId: status.playbookId,
    runId: status.runId,
    status: status.status,
    startedAt: status.startedAt,
    updatedAt: status.updatedAt,
    completedAt: status.completedAt,
    result: cloneJson(status.result, "Playbook result"),
    error: status.error,
    reason: status.reason,
    childSessionIds: Object.freeze([...status.childSessionIds]),
    logTail: Object.freeze([...status.logTail]),
    artifacts: Object.freeze(status.artifacts.map((artifact) => Object.freeze({ ...artifact }))),
  });
}

async function persistStatus(active: ActivePlaybookRun): Promise<void> {
  active.status.updatedAt = new Date().toISOString();
  const value = snapshot(active.status);
  const write = async (): Promise<void> => {
    await Promise.all([
      atomicJson(statusFile(active.project, active.status.runId), value),
      atomicJson(statusFile(active.project), value),
    ]);
  };
  const queued = active.writeQueue.then(write, write);
  active.writeQueue = queued;
  await queued;
}

async function appendLog(context: PlaybookRuntimeContext, values: unknown[]): Promise<void> {
  const line = values.map((value) => typeof value === "string" ? value : JSON.stringify(value)).join(" ");
  context.active.status.logTail.push(line);
  if (context.active.status.logTail.length > MAX_LOG_LINES) context.active.status.logTail.splice(0, context.active.status.logTail.length - MAX_LOG_LINES);
  const logPath = path.join(context.active.project.projectPath, "runs", context.active.status.runId, "logs.txt");
  await mkdir(path.dirname(logPath), { recursive: true });
  await appendFile(logPath, `${new Date().toISOString()} ${line}\n`, "utf8");
  await persistStatus(context.active);
}

async function writeArtifact(context: PlaybookRuntimeContext, nameInput: unknown, value: unknown): Promise<PlaybookArtifact> {
  const name = safeDataKey(nameInput, "Artifact name");
  const stable = cloneJson(value, "Artifact");
  const artifactPath = path.join(context.active.project.projectPath, "runs", context.active.status.runId, "artifacts", `${name}.json`);
  await atomicJson(artifactPath, stable);
  const encoded = JSON.stringify(stable);
  const artifact = Object.freeze({ name, path: artifactPath, preview: encoded.length > 2_000 ? `${encoded.slice(0, 2_000)}…` : encoded });
  const existing = context.active.status.artifacts.findIndex((candidate) => candidate.name === name);
  if (existing >= 0) context.active.status.artifacts[existing] = artifact;
  else context.active.status.artifacts.push(artifact);
  await persistStatus(context.active);
  return artifact;
}

async function persistValue(context: PlaybookRuntimeContext, keyInput: unknown, value: unknown): Promise<void> {
  const key = safeDataKey(keyInput, "Persist key");
  await atomicJson(path.join(context.active.project.projectPath, "persist", `${key}.json`), cloneJson(value, "Persist value"));
}

async function loadValue(context: PlaybookRuntimeContext, keyInput: unknown): Promise<unknown> {
  const key = safeDataKey(keyInput, "Persist key");
  try {
    return await readJson(path.join(context.active.project.projectPath, "persist", `${key}.json`));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function currentRuntime(): PlaybookRuntimeContext {
  const context = runtimeStorage.getStore();
  if (!context) throw new Error("Playbook helper was called outside an active Playbook run");
  return context;
}

function runSignal(active: ActivePlaybookRun): AbortSignal {
  return active.controller.signal;
}

async function runAgent(taskInput: unknown): Promise<string> {
  const context = currentRuntime();
  const task = typeof taskInput === "string" ? exactText(taskInput, "Agent task", 64 * 1024) : exactText((taskInput as Record<string, unknown>)?.task, "Agent task", 64 * 1024);
  throwIfCancelled(runSignal(context.active));
  context.childCounter += 1;
  const detachedRunId = `${context.active.status.runId}:child:${context.childCounter}`;
  const child = context.active.invocation.deriveDetachedChild({ principal: "playbook" }, detachedRunId);
  context.active.status.childSessionIds.push(child.runId);
  await persistStatus(context.active);
  const network = context.active.invocation.createDetachedNetwork(child, runSignal(context.active));
  try {
    const tools = context.active.invocation.getToolDefinitions(child);
    const response = await context.active.llm.chat([
      { role: "system", content: context.active.persona.systemPrompt },
      { role: "user", content: task },
    ], tools, runSignal(context.active), network.fetch);
    let result = response.content || "";
    for (const toolCall of response.tool_calls ?? []) {
      throwIfCancelled(runSignal(context.active));
      const toolResult = await context.active.invocation.executeDetachedTool(
        child,
        toolCall.function.name,
        toolCall.function.arguments,
        toolCall.id,
        runSignal(context.active),
      );
      result += `${result ? "\n" : ""}[${toolCall.function.name}] ${toolResult}`;
    }
    return result;
  } finally {
    await context.active.invocation.finishDetachedChild(child);
  }
}

async function runParallel(values: unknown): Promise<unknown[]> {
  const items = Array.isArray(values) ? values : [values];
  return Promise.all(items.map(async (item) => {
    if (typeof item === "function") return await item();
    if (typeof item === "string" || (item && typeof item === "object" && "task" in item)) return runAgent(item);
    return await item;
  }));
}

async function runPipeline(stepsInput: unknown, initial?: unknown): Promise<unknown> {
  if (!Array.isArray(stepsInput)) throw new TypeError("pipeline steps must be an array");
  let value = initial;
  for (const step of stepsInput) {
    throwIfCancelled(runSignal(currentRuntime().active));
    if (typeof step === "function") value = await step(value);
    else if (typeof step === "string") value = await runAgent(`${step}\n\nPipeline input:\n${typeof value === "string" ? value : JSON.stringify(value)}`);
    else throw new TypeError("pipeline step must be a function or task string");
  }
  return value;
}

function installGlobals(): void {
  const target = globalThis as Record<string, unknown>;
  if (target.__rainydaysPlaybookGlobals === true) return;
  const lux = Object.freeze({
    get playbookId() { return currentRuntime().active.project.playbookId; },
    get runId() { return currentRuntime().active.status.runId; },
    get cwd() { return currentRuntime().active.project.projectPath; },
    done(value: unknown) {
      const context = currentRuntime();
      if (context.doneCalled) throw new Error("lux.done may only be called once");
      context.doneValue = cloneJson(value, "lux.done result");
      context.doneCalled = true;
    },
    log: async (...values: unknown[]) => appendLog(currentRuntime(), values),
    artifact: async (name: unknown, value: unknown) => writeArtifact(currentRuntime(), name, value),
    persist: async (key: unknown, value: unknown) => persistValue(currentRuntime(), key, value),
    load: async (key: unknown) => loadValue(currentRuntime(), key),
    tools: Object.freeze({
      call: async (name: unknown, args: unknown = {}) => {
        const context = currentRuntime();
        const toolName = exactText(name, "Tool name", 200);
        const childRunId = `${context.active.status.runId}:tool:${randomBytes(4).toString("hex")}`;
        const child = context.active.invocation.deriveDetachedChild({ principal: "playbook" }, childRunId);
        context.active.status.childSessionIds.push(child.runId);
        await persistStatus(context.active);
        try {
          return await context.active.invocation.executeDetachedTool(child, toolName, cloneJson(args, "Tool arguments") as Record<string, unknown>, `playbook_${randomBytes(8).toString("hex")}`, runSignal(context.active));
        } finally {
          await context.active.invocation.finishDetachedChild(child);
        }
      },
    }),
  });
  Object.defineProperties(target, {
    lux: { value: lux, configurable: false, enumerable: true, writable: false },
    agent: { value: runAgent, configurable: false, enumerable: true, writable: false },
    parallel: { value: runParallel, configurable: false, enumerable: true, writable: false },
    pipeline: { value: runPipeline, configurable: false, enumerable: true, writable: false },
    __rainydaysPlaybookGlobals: { value: true, configurable: false, enumerable: false, writable: false },
  });
}

async function executeActive(active: ActivePlaybookRun): Promise<void> {
  const context: PlaybookRuntimeContext = { active, doneCalled: false, doneValue: null, childCounter: 0 };
  try {
    await runtimeStorage.run(context, async () => {
      throwIfCancelled(runSignal(active));
      installGlobals();
      const url = pathToFileURL(active.sourcePath);
      url.searchParams.set("run", active.status.runId);
      const loaded = await import(url.href);
      if (typeof loaded.default === "function" && !context.doneCalled) await loaded.default();
      if (!context.doneCalled) throw new Error("Playbook must call lux.done(result) exactly once");
      throwIfCancelled(runSignal(active));
    });
    active.status.status = "completed";
    active.status.result = context.doneValue;
    active.status.completedAt = new Date().toISOString();
  } catch (error) {
    if (active.controller.signal.aborted || isRunCancellation(error)) {
      active.status.status = "aborted";
      active.status.reason = error instanceof Error ? error.message : "Playbook aborted";
    } else {
      active.status.status = "failed";
      active.status.error = error instanceof Error ? error.stack || error.message : String(error);
    }
    active.status.completedAt = new Date().toISOString();
  } finally {
    try { await persistStatus(active); } finally { activePlaybooks.delete(active.project.playbookId); }
  }
}

export async function startPlaybook(input: Readonly<{
  playbookId: string;
  llm: LLMClient;
  persona: Readonly<{ systemPrompt: string }>;
  invocation: ToolInvocationServices;
}>): Promise<PlaybookStatus> {
  const playbookId = exactId(input.playbookId);
  if (activePlaybooks.has(playbookId) || startingPlaybooks.has(playbookId)) throw new Error(`Playbook ${playbookId} is already running`);
  startingPlaybooks.add(playbookId);
  try {
    throwIfCancelled(input.invocation.signal);
    const loaded = await loadProjectFrom(PLAYBOOKS_DIR, playbookId, false);
    const runId = `run_${Date.now()}_${randomBytes(4).toString("hex")}`;
    const now = new Date().toISOString();
    const controller = new AbortController();
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const active = {
      project: loaded.project,
      sourcePath: loaded.sourcePath,
      controller,
      status: {
        playbookId,
        runId,
        status: "running" as const,
        startedAt: now,
        updatedAt: now,
        completedAt: null,
        result: null,
        error: null,
        reason: null,
        childSessionIds: [],
        logTail: [],
        artifacts: [],
      },
      invocation: input.invocation,
      llm: input.llm,
      persona: input.persona,
      completion,
      writeQueue: Promise.resolve(),
    } satisfies ActivePlaybookRun;
    activePlaybooks.set(playbookId, active);
    try {
      await persistStatus(active);
    } catch (error) {
      activePlaybooks.delete(playbookId);
      throw error;
    }
    void executeActive(active).finally(resolveCompletion);
    return snapshot(active.status);
  } finally {
    startingPlaybooks.delete(playbookId);
  }
}

export async function abortPlaybook(playbookIdInput: string, reason = "Playbook aborted by user"): Promise<PlaybookStatus> {
  const playbookId = exactId(playbookIdInput);
  const active = activePlaybooks.get(playbookId);
  if (!active || active.controller.signal.aborted) throw new Error(`Playbook ${playbookId} is not running`);
  active.status.reason = exactText(reason, "Abort reason", 2_000);
  active.controller.abort(new RunCancellationError("RUN_CANCELLED", active.status.reason));
  active.status.status = "aborted";
  active.status.completedAt = new Date().toISOString();
  await persistStatus(active);
  await active.completion;
  return snapshot(active.status);
}

export async function getPlaybookStatus(playbookIdInput: string): Promise<PlaybookStatus> {
  const playbookId = exactId(playbookIdInput);
  const active = activePlaybooks.get(playbookId);
  if (active) return snapshot(active.status);
  const loaded = await loadProject(playbookId);
  try {
    const stored = await readJson(statusFile(loaded.project)) as PlaybookStatus;
    if (stored.status === "running") return Object.freeze({ ...stored, status: "interrupted", error: stored.error ?? "Playbook process restarted before completion" });
    return Object.freeze(stored);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return Object.freeze({ playbookId, runId: null, status: "idle", startedAt: null, updatedAt: new Date().toISOString(), completedAt: null, result: null, error: null, reason: null, childSessionIds: Object.freeze([]), logTail: Object.freeze([]), artifacts: Object.freeze([]) });
  }
}

export async function archivePlaybook(playbookIdInput: string): Promise<PlaybookProject> {
  const playbookId = exactId(playbookIdInput);
  if (activePlaybooks.has(playbookId) || startingPlaybooks.has(playbookId)) throw new Error(`Playbook ${playbookId} is running and cannot be archived`);
  await ensureRoots();
  const source = projectPath(PLAYBOOKS_DIR, playbookId);
  const destination = projectPath(PLAYBOOKS_ARCHIVED_DIR, playbookId);
  await assertDirectory(source, `Playbook ${playbookId}`);
  try { await lstat(destination); throw new Error(`Archived Playbook ${playbookId} already exists`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await rename(source, destination);
  return (await loadProjectFrom(PLAYBOOKS_ARCHIVED_DIR, playbookId, true)).project;
}

export async function unarchivePlaybook(playbookIdInput: string): Promise<PlaybookProject> {
  const playbookId = exactId(playbookIdInput);
  if (activePlaybooks.has(playbookId) || startingPlaybooks.has(playbookId)) throw new Error(`Playbook ${playbookId} is running and cannot be unarchived`);
  await ensureRoots();
  const source = projectPath(PLAYBOOKS_ARCHIVED_DIR, playbookId);
  const destination = projectPath(PLAYBOOKS_DIR, playbookId);
  await assertDirectory(source, `Archived Playbook ${playbookId}`);
  try { await lstat(destination); throw new Error(`Active Playbook ${playbookId} already exists`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  await rename(source, destination);
  return (await loadProjectFrom(PLAYBOOKS_DIR, playbookId, false)).project;
}

export async function deletePlaybook(playbookIdInput: string): Promise<void> {
  const playbookId = exactId(playbookIdInput);
  if (activePlaybooks.has(playbookId) || startingPlaybooks.has(playbookId)) throw new Error(`Playbook ${playbookId} is running and cannot be deleted`);
  const loaded = await loadProject(playbookId);
  await rm(loaded.project.projectPath, { recursive: true, force: false });
}

export function validatePlaybookSource(name: string, bytes: Uint8Array): Playbook {
  const safeName = exactId(name);
  const parsed: unknown = JSON.parse(Buffer.from(bytes).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`Playbook ${safeName} format is invalid`);
  const value = parsed as Record<string, unknown>;
  if (value.name !== safeName || typeof value.description !== "string" || !Array.isArray(value.steps)) throw new Error(`Playbook ${safeName} definition is invalid`);
  const steps = value.steps.map((step, index) => {
    if (!step || typeof step !== "object" || Array.isArray(step)) throw new Error(`Playbook ${safeName} step ${index + 1} is invalid`);
    const candidate = step as Record<string, unknown>;
    if (typeof candidate.message !== "string" || !candidate.message) throw new Error(`Playbook ${safeName} step ${index + 1} is invalid`);
    if (candidate.description !== undefined && typeof candidate.description !== "string") throw new Error(`Playbook ${safeName} step ${index + 1} is invalid`);
    return Object.freeze({ message: candidate.message, ...(candidate.description === undefined ? {} : { description: candidate.description }) });
  });
  return Object.freeze({ name: safeName, description: value.description, steps: Object.freeze(steps) }) as Playbook;
}

export function createRun(playbookName: string, totalSteps: number, owner: PlaybookOwner): PlaybookRun {
  const run: PlaybookRun = { id: `run_${Date.now()}_${randomBytes(3).toString("hex")}`, ownerSessionId: owner.sessionId, ownerRunId: owner.runId, playbookName, currentStep: 0, totalSteps, status: "running", results: [], startedAt: new Date().toISOString() };
  legacyRuns.set(run.id, run);
  return run;
}

export function updateRun(runId: string, step: number, result: string): void {
  const run = legacyRuns.get(runId);
  if (!run) return;
  run.currentStep = step;
  run.results[step - 1] = result;
  if (step >= run.totalSteps) run.status = "completed";
}

export function getRunStatus(runId: string, owner: PlaybookOwner): PlaybookRun | undefined {
  const run = legacyRuns.get(runId);
  return run?.ownerSessionId === owner.sessionId && run.ownerRunId === owner.runId ? run : undefined;
}

export function listActiveRuns(owner: PlaybookOwner): PlaybookRun[] {
  return [...legacyRuns.values()].filter((run) => run.ownerSessionId === owner.sessionId && run.ownerRunId === owner.runId);
}

export function abortRun(runId: string, owner: PlaybookOwner): boolean {
  const run = getRunStatus(runId, owner);
  if (!run) return false;
  run.status = "aborted";
  return true;
}

export const playbookExecuteDef: ToolDefinition = {
  type: "function",
  function: {
    name: "playbook_execute",
    description: "Execute a managed npm ESM Playbook singleton by playbookId.",
    parameters: { type: "object", properties: { playbookId: { type: "string" } }, required: ["playbookId"], additionalProperties: false },
  },
};

export function createPlaybookExecuteExec(llm: LLMClient, persona: { systemPrompt: string }): ToolExecutor {
  return async (args, _env, invocation) => {
    if (!invocation) throw new Error("Playbook execution requires invocation services");
    if (invocation.signal.aborted) {
      const child = invocation.deriveChild({ principal: "playbook" });
      try { throwIfCancelled(invocation.signal); } finally { invocation.finishChild(child); }
    }
    return JSON.stringify(await startPlaybook({ playbookId: args.playbookId as string, llm, persona, invocation }), null, 2);
  };
}

export const playbookAbortDef: ToolDefinition = {
  type: "function",
  function: {
    name: "playbook_abort",
    description: "Abort the running singleton Playbook and its active child contexts.",
    parameters: { type: "object", properties: { playbookId: { type: "string" }, reason: { type: "string", maxLength: 2_000 } }, required: ["playbookId"], additionalProperties: false },
  },
};

export const playbookAbortExec: ToolExecutor = async (args) => JSON.stringify(await abortPlaybook(args.playbookId as string, typeof args.reason === "string" ? args.reason : undefined), null, 2);
