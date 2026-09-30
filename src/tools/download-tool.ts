// ===========================================
// TOOL-06 streaming/background download runtime
// ===========================================

import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import { PathDeniedError, type PathStreamingWriteLease } from "../path-policy.js";
import type { CapabilityContext } from "../capability-broker.js";
import type { ToolDefinition, ToolExecutor, ToolInvocationServices } from "../types.js";
import { cancellationError, throwIfCancelled } from "../run-cancellation.js";

const DEFAULT_MAX_BYTES = 1024 * 1024 * 1024;
const ABSOLUTE_MAX_BYTES = 2 * 1024 * 1024 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const MAX_IDLE_TIMEOUT_MS = 5 * 60_000;
const MAX_TASKS = 256;
const DESCRIPTOR_MAX_BYTES = 8 * 1024;
const TASK_ID_PATTERN = /^dl_[a-f0-9]{24}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const WINDOWS_DEVICE_NAMES = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu;

type DownloadState = "running" | "completed" | "cancelled" | "failed" | "interrupted";

interface DownloadDescriptor {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly sessionDigest: string;
  readonly filename: string;
  readonly maxBytes: number;
  readonly expectedSha256: string | null;
  readonly validatorHeader: "etag" | "last-modified" | null;
  readonly validatorValue: string | null;
  readonly createdAt: string;
}

interface DownloadMarker {
  readonly schemaVersion: 1;
  readonly taskId: string;
  readonly state: Exclude<DownloadState, "running" | "interrupted">;
  readonly filename: string;
  readonly bytesDownloaded: number;
  readonly totalBytes: number | null;
  readonly sha256: string | null;
  readonly errorCode: string | null;
  readonly finishedAt: string;
}

interface DownloadTask {
  readonly id: string;
  readonly sessionDigest: string;
  readonly descriptor: DownloadDescriptor;
  readonly url: string;
  readonly controller: AbortController;
  readonly unregisterController: () => void;
  readonly detachedContext: CapabilityContext;
  readonly target: PathStreamingWriteLease;
  readonly marker: PathStreamingWriteLease;
  readonly idleTimeoutMs: number;
  state: DownloadState;
  bytesDownloaded: number;
  totalBytes: number | null;
  sha256: string | null;
  partialSha256: string;
  errorCode: string | null;
  updatedAt: string;
  cancelRequested: boolean;
  worker: Promise<void>;
  finish: () => void;
  readonly finished: Promise<void>;
}

const tasks = new Map<string, DownloadTask>();

function outputGateway(invocation?: ToolInvocationServices) {
  if (!invocation) throw new Error("Path gateway is required");
  const rootId = invocation.path.rootIdForEnv("OUTPUT_DIR");
  if (!rootId) throw new Error("Path root is unavailable: OUTPUT_DIR");
  return { gateway: invocation.path, rootId };
}

function exactObject(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()));
}

function positiveInteger(value: unknown, fallback: number, maximum: number, field: string): number {
  const resolved = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(resolved) || (resolved as number) < 1 || (resolved as number) > maximum) {
    throw new TypeError(`${field} is invalid`);
  }
  return resolved as number;
}

function sessionDigest(invocation: ToolInvocationServices): string {
  return createHash("sha256").update(invocation.capabilityContext.sessionId).digest("hex");
}

function taskId(value: unknown): string {
  if (typeof value !== "string" || !TASK_ID_PATTERN.test(value)) throw new TypeError("download task_id is invalid");
  return value;
}

function normalizeSha256(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !SHA256_PATTERN.test(value.toLowerCase())) throw new TypeError("download sha256 is invalid");
  return value.toLowerCase();
}

function safeFilename(input: string): string {
  let value = input.normalize("NFKC").replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/gu, "").replace(/[<>:"/\\|?*]/gu, "_").trim();
  value = value.replace(/[. ]+$/gu, "").replace(/^\.+/gu, "");
  if (!value || value === "." || value === ".." || WINDOWS_DEVICE_NAMES.test(value)
    || value.toLowerCase().startsWith("rainydays-stream-") || value.toLowerCase().startsWith("rainydays-download-")) {
    value = "download.bin";
  }
  if (value.length > 180) {
    const extension = path.extname(value).slice(0, 20);
    value = `${value.slice(0, Math.max(1, 180 - extension.length))}${extension}`;
  }
  return value;
}

function contentDispositionFilename(header: string | null): string | null {
  if (!header) return null;
  const encoded = /filename\*=UTF-8''([^;]+)/iu.exec(header)?.[1];
  if (encoded) {
    try { return decodeURIComponent(encoded); } catch { /* Fall through to filename=. */ }
  }
  const quoted = /filename\s*=\s*"([^"]+)"/iu.exec(header)?.[1];
  if (quoted) return quoted.replaceAll("\\\"", "\"");
  return /filename\s*=\s*([^;\s]+)/iu.exec(header)?.[1] ?? null;
}

function filenameFromResponse(url: string, explicit: unknown, response: Response): string {
  if (typeof explicit === "string" && explicit.trim()) return safeFilename(explicit);
  const fromHeader = contentDispositionFilename(response.headers.get("content-disposition"));
  if (fromHeader) return safeFilename(fromHeader);
  try {
    const parsed = new URL(url);
    const basename = decodeURIComponent(path.posix.basename(parsed.pathname));
    return safeFilename(basename || "download.bin");
  } catch { return "download.bin"; }
}

function responseValidator(response: Response): Readonly<{ header: "etag" | "last-modified"; value: string }> | null {
  const etag = response.headers.get("etag");
  if (etag && !/^W\//iu.test(etag) && etag.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(etag)) {
    return Object.freeze({ header: "etag", value: etag });
  }
  const modified = response.headers.get("last-modified");
  if (modified && modified.length <= 256 && Number.isFinite(Date.parse(modified)) && !/[\u0000-\u001f\u007f]/u.test(modified)) {
    return Object.freeze({ header: "last-modified", value: modified });
  }
  return null;
}

function validateUrl(value: unknown): string {
  if (typeof value !== "string" || value.length < 8 || value.length > 8_192) throw new TypeError("download url is invalid");
  const parsed = new URL(value);
  if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password) {
    throw new TypeError("download url is invalid");
  }
  return parsed.toString();
}

function descriptorName(id: string): string { return `.rainydays-download-${id.slice(3)}.json`; }
function markerName(id: string): string { return `.rainydays-download-${id.slice(3)}.done.json`; }
function streamId(id: string, suffix: "data" | "marker"): string { return `${id.slice(3)}-${suffix}`; }

function parseDescriptor(value: unknown): DownloadDescriptor {
  if (!exactObject(value, ["schemaVersion", "taskId", "sessionDigest", "filename", "maxBytes", "expectedSha256", "validatorHeader", "validatorValue", "createdAt"])
    || value.schemaVersion !== 1 || typeof value.taskId !== "string" || !TASK_ID_PATTERN.test(value.taskId)
    || typeof value.sessionDigest !== "string" || !SHA256_PATTERN.test(value.sessionDigest)
    || typeof value.filename !== "string" || safeFilename(value.filename) !== value.filename
    || !Number.isSafeInteger(value.maxBytes) || (value.maxBytes as number) < 1 || (value.maxBytes as number) > ABSOLUTE_MAX_BYTES
    || !(value.expectedSha256 === null || (typeof value.expectedSha256 === "string" && SHA256_PATTERN.test(value.expectedSha256)))
    || !(value.validatorHeader === null || value.validatorHeader === "etag" || value.validatorHeader === "last-modified")
    || !(value.validatorValue === null || (typeof value.validatorValue === "string" && value.validatorValue.length >= 1 && value.validatorValue.length <= 256 && !/[\u0000-\u001f\u007f]/u.test(value.validatorValue)))
    || ((value.validatorHeader === null) !== (value.validatorValue === null))
    || typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) throw new Error("download descriptor is invalid");
  return Object.freeze(value as unknown as DownloadDescriptor);
}

function parseMarker(value: unknown): DownloadMarker {
  if (!exactObject(value, ["schemaVersion", "taskId", "state", "filename", "bytesDownloaded", "totalBytes", "sha256", "errorCode", "finishedAt"])
    || value.schemaVersion !== 1 || typeof value.taskId !== "string" || !TASK_ID_PATTERN.test(value.taskId)
    || !["completed", "cancelled", "failed"].includes(String(value.state))
    || typeof value.filename !== "string" || safeFilename(value.filename) !== value.filename
    || !Number.isSafeInteger(value.bytesDownloaded) || (value.bytesDownloaded as number) < 0
    || !(value.totalBytes === null || (Number.isSafeInteger(value.totalBytes) && (value.totalBytes as number) >= 0))
    || !(value.sha256 === null || (typeof value.sha256 === "string" && SHA256_PATTERN.test(value.sha256)))
    || !(value.errorCode === null || (typeof value.errorCode === "string" && /^[A-Z0-9_]{1,64}$/u.test(value.errorCode)))
    || typeof value.finishedAt !== "string" || Number.isNaN(Date.parse(value.finishedAt))) throw new Error("download marker is invalid");
  return Object.freeze(value as unknown as DownloadMarker);
}

async function readJson(invocation: ToolInvocationServices, name: string, rootId: string, required: boolean): Promise<unknown | null> {
  try {
    const result = await invocation.path.readFile(name, { defaultRootId: rootId, maxBytes: DESCRIPTOR_MAX_BYTES });
    return JSON.parse(result.bytes.toString("utf8"));
  } catch (error) {
    if (!required && error instanceof PathDeniedError && error.code === "PATH_NOT_FOUND") return null;
    throw error;
  }
}

async function loadDescriptor(invocation: ToolInvocationServices, id: string, rootId: string): Promise<DownloadDescriptor> {
  const descriptor = parseDescriptor(await readJson(invocation, descriptorName(id), rootId, true));
  if (descriptor.taskId !== id || descriptor.sessionDigest !== sessionDigest(invocation)) throw new Error("download task is unavailable");
  return descriptor;
}

function totalFromResponse(response: Response, offset: number): { total: number | null; mode: "append" | "reset" | "complete" } {
  if (offset === 0 && response.status === 206) {
    const match = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/iu.exec(response.headers.get("content-range") ?? "");
    const end = Number(match?.[2]);
    const total = match?.[3] === "*" ? null : Number(match?.[3]);
    if (!match || Number(match[1]) !== 0 || !Number.isSafeInteger(end) || end < 0
      || (total !== null && (!Number.isSafeInteger(total) || total <= end))) throw new Error("download initial range response is invalid");
    return { total, mode: "append" };
  }
  if (offset > 0 && response.status === 416) {
    const total = Number(/bytes\s+\*\/(\d+)/iu.exec(response.headers.get("content-range") ?? "")?.[1]);
    if (Number.isSafeInteger(total) && total === offset) return { total, mode: "complete" };
    throw new Error("download range is unsatisfiable");
  }
  if (!response.ok) throw new Error(`download HTTP status ${response.status}`);
  if (offset > 0 && response.status === 206) {
    const match = /bytes\s+(\d+)-(\d+)\/(\d+|\*)/iu.exec(response.headers.get("content-range") ?? "");
    const end = Number(match?.[2]);
    const total = match?.[3] === "*" ? null : Number(match?.[3]);
    if (!match || Number(match[1]) !== offset || !Number.isSafeInteger(end) || end < offset
      || (total !== null && (!Number.isSafeInteger(total) || total <= end))) throw new Error("download range response is invalid");
    return { total, mode: "append" };
  }
  const length = Number(response.headers.get("content-length"));
  return { total: Number.isSafeInteger(length) && length >= 0 ? length : null, mode: offset > 0 ? "reset" : "append" };
}

function statusPayload(input: Readonly<{
  id: string;
  state: DownloadState;
  filename: string;
  bytesDownloaded: number | null;
  totalBytes: number | null;
  sha256: string | null;
  errorCode: string | null;
  updatedAt: string;
}>) {
  const progress = input.bytesDownloaded !== null && input.totalBytes !== null && input.totalBytes > 0
    ? Math.min(100, Math.round((input.bytesDownloaded / input.totalBytes) * 10_000) / 100)
    : input.totalBytes === 0 ? 100 : null;
  return Object.freeze({
    taskId: input.id,
    state: input.state,
    filename: input.filename,
    bytesDownloaded: input.bytesDownloaded,
    totalBytes: input.totalBytes,
    progress,
    sha256: input.sha256,
    errorCode: input.errorCode,
    resumable: input.state === "interrupted",
    updatedAt: input.updatedAt,
  });
}

function taskStatus(task: DownloadTask) {
  return statusPayload({
    id: task.id,
    state: task.state,
    filename: task.descriptor.filename,
    bytesDownloaded: task.bytesDownloaded,
    totalBytes: task.totalBytes,
    sha256: task.sha256,
    errorCode: task.errorCode,
    updatedAt: task.updatedAt,
  });
}

function ownedTask(invocation: ToolInvocationServices, id: string): DownloadTask | null {
  const task = tasks.get(id) ?? null;
  if (!task) return null;
  if (task.sessionDigest !== sessionDigest(invocation)) throw new Error("download task is unavailable");
  return task;
}

async function persistedStatus(invocation: ToolInvocationServices, id: string, rootId: string) {
  const descriptor = await loadDescriptor(invocation, id, rootId);
  const markerValue = await readJson(invocation, markerName(id), rootId, false);
  if (markerValue) {
    const marker = parseMarker(markerValue);
    if (marker.taskId !== id || marker.filename !== descriptor.filename) throw new Error("download marker identity differs");
    return statusPayload({
      id,
      state: marker.state,
      filename: marker.filename,
      bytesDownloaded: marker.bytesDownloaded,
      totalBytes: marker.totalBytes,
      sha256: marker.sha256,
      errorCode: marker.errorCode,
      updatedAt: marker.finishedAt,
    });
  }
  return statusPayload({
    id,
    state: "interrupted",
    filename: descriptor.filename,
    bytesDownloaded: null,
    totalBytes: null,
    sha256: null,
    errorCode: "PROCESS_RESTARTED",
    updatedAt: descriptor.createdAt,
  });
}

function markerFor(task: DownloadTask, state: DownloadMarker["state"], errorCode: string | null): DownloadMarker {
  return Object.freeze({
    schemaVersion: 1,
    taskId: task.id,
    state,
    filename: task.descriptor.filename,
    bytesDownloaded: task.bytesDownloaded,
    totalBytes: task.totalBytes,
    sha256: task.sha256,
    errorCode,
    finishedAt: new Date().toISOString(),
  });
}

async function commitMarker(task: DownloadTask, state: DownloadMarker["state"], errorCode: string | null): Promise<void> {
  const bytes = Buffer.from(`${JSON.stringify(markerFor(task, state, errorCode))}\n`, "utf8");
  await task.marker.write(bytes);
  await task.marker.commit();
}

function transition(task: DownloadTask, state: DownloadState, errorCode: string | null): void {
  task.state = state;
  task.errorCode = errorCode;
  task.updatedAt = new Date().toISOString();
}

function pruneTasks(): void {
  if (tasks.size <= MAX_TASKS) return;
  for (const [id, task] of tasks) {
    if (task.state !== "running") tasks.delete(id);
    if (tasks.size <= MAX_TASKS) return;
  }
}

async function runDownload(task: DownloadTask, response: Response, alreadyComplete: boolean, invocation: ToolInvocationServices): Promise<void> {
  let idleTimer: NodeJS.Timeout | null = null;
  let streamPhase = true;
  const armIdle = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => task.controller.abort("idle-timeout"), task.idleTimeoutMs);
    idleTimer.unref?.();
  };
  try {
    if (!alreadyComplete && response.body) {
      armIdle();
      for await (const chunk of response.body) {
        if (task.cancelRequested) throw new Error("download cancelled");
        armIdle();
        const buffer = Buffer.from(chunk);
        let snapshot = task.target.snapshot();
        for (let offset = 0; offset < buffer.length; offset += 4 * 1024 * 1024) {
          snapshot = await task.target.write(buffer.subarray(offset, offset + 4 * 1024 * 1024));
        }
        task.bytesDownloaded = snapshot.bytesWritten;
        task.partialSha256 = snapshot.sha256;
        task.updatedAt = new Date().toISOString();
      }
    }
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
    if (task.totalBytes !== null && task.bytesDownloaded !== task.totalBytes) throw new Error("download body ended before declared length");
    streamPhase = false;
    const snapshot = task.target.snapshot();
    if (task.descriptor.expectedSha256 && snapshot.sha256 !== task.descriptor.expectedSha256) {
      throw new Error("download checksum differs");
    }
    const committed = await task.target.commit(task.descriptor.expectedSha256 ?? undefined);
    task.bytesDownloaded = committed.bytesWritten;
    task.sha256 = committed.sha256;
    let markerError: string | null = null;
    try { await commitMarker(task, "completed", null); }
    catch { markerError = "STATUS_MARKER_FAILED"; }
    transition(task, "completed", markerError);
  } catch (error) {
    if (idleTimer) clearTimeout(idleTimer);
    if (task.cancelRequested || task.controller.signal.reason === "cancelled") {
      await task.target.cancel().catch(() => undefined);
      transition(task, "cancelled", "CANCELLED");
      await commitMarker(task, "cancelled", "CANCELLED").catch(() => undefined);
    } else if (streamPhase && !(error instanceof PathDeniedError)) {
      const preserved = await task.target.preserve().catch(() => null);
      if (preserved) {
        task.bytesDownloaded = preserved.bytesWritten;
        task.partialSha256 = preserved.sha256;
      }
      await task.marker.cancel().catch(() => undefined);
      transition(task, "interrupted", task.controller.signal.reason === "idle-timeout" ? "IDLE_TIMEOUT" : "NETWORK_INTERRUPTED");
    } else {
      await task.target.cancel().catch(() => undefined);
      transition(task, "failed", error instanceof PathDeniedError ? error.code : "VALIDATION_FAILED");
      await commitMarker(task, "failed", task.errorCode).catch(() => undefined);
    }
  } finally {
    task.unregisterController();
    await invocation.finishDetachedChild(task.detachedContext).catch(() => undefined);
    task.finish();
  }
}

async function createDetachedRuntime(invocation: ToolInvocationServices, id: string) {
  const controller = new AbortController();
  const detachedContext = invocation.deriveDetachedChild({
    principal: "subagent",
    tools: [],
    allowedRoots: invocation.capabilityContext.allowedRoots,
    networkPolicy: invocation.capabilityContext.networkPolicy,
  }, `download:${id}`);
  let unregisterController: () => void = () => undefined;
  try {
    const network = invocation.createDetachedNetwork(detachedContext, controller.signal);
    unregisterController = invocation.registerDetachedResource(detachedContext, () => controller.abort("resource-retired"));
    return { controller, unregisterController, detachedContext, network };
  } catch (error) {
    unregisterController();
    await invocation.finishDetachedChild(detachedContext).catch(() => undefined);
    throw error;
  }
}

async function fetchResponse(
  network: ToolInvocationServices["network"],
  controller: AbortController,
  url: string,
  offset: number,
  timeoutMs: number,
  validator: DownloadDescriptor | null,
): Promise<Response> {
  const timer = setTimeout(() => controller.abort("idle-timeout"), timeoutMs);
  timer.unref?.();
  try {
    return await network.fetch(url, {
      headers: {
        "User-Agent": "RainyDays/1.0",
        "Accept-Encoding": "identity",
        ...(offset > 0 ? {
          Range: `bytes=${offset}-`,
          ...(validator?.validatorValue ? { "If-Range": validator.validatorValue } : {}),
        } : {}),
      },
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) throw cancellationError(controller.signal, "download connection timed out");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function startDownload(args: Readonly<Record<string, unknown>>, invocation: ToolInvocationServices) {
  throwIfCancelled(invocation.signal);
  const { gateway, rootId } = outputGateway(invocation);
  const resumeIdValue = args.resume_task_id === undefined ? null : taskId(args.resume_task_id);
  const id = resumeIdValue ?? `dl_${randomBytes(12).toString("hex")}`;
  const current = ownedTask(invocation, id);
  if (current && current.state !== "interrupted") throw new Error(`download task is ${current.state}`);
  let descriptor: DownloadDescriptor | null = null;
  let url: string;
  let maxBytes: number;
  let expectedSha256: string | null;
  if (resumeIdValue) {
    descriptor = await loadDescriptor(invocation, id, rootId);
    url = args.url === undefined && current ? current.url : validateUrl(args.url);
    maxBytes = descriptor.maxBytes;
    expectedSha256 = descriptor.expectedSha256;
    const suppliedSha = normalizeSha256(args.sha256);
    if (suppliedSha && suppliedSha !== expectedSha256) throw new Error("download resume checksum differs");
  } else {
    url = validateUrl(args.url);
    maxBytes = positiveInteger(args.max_bytes, DEFAULT_MAX_BYTES, ABSOLUTE_MAX_BYTES, "download max_bytes");
    expectedSha256 = normalizeSha256(args.sha256);
  }
  const idleTimeoutMs = positiveInteger(args.idle_timeout_ms, DEFAULT_IDLE_TIMEOUT_MS, MAX_IDLE_TIMEOUT_MS, "download idle_timeout_ms");
  const detached = await createDetachedRuntime(invocation, id);
  let target: PathStreamingWriteLease | null = null;
  let marker: PathStreamingWriteLease | null = null;
  let response: Response | null = null;
  let resumableSetup = descriptor !== null;
  try {
    if (descriptor) {
      target = await invocation.reserveDetachedStreamingFile(detached.detachedContext, descriptor.filename, {
        defaultRootId: rootId,
        maxBytes,
        resumeId: streamId(id, "data"),
      });
      let partial = target.snapshot();
      if (current && (partial.bytesWritten !== current.bytesDownloaded || partial.sha256 !== current.partialSha256)) {
        throw new Error("download partial identity differs");
      }
      const mustRestartFromZero = partial.bytesWritten > 0 && !descriptor.expectedSha256
        && (!current || !descriptor.validatorHeader);
      if (mustRestartFromZero) partial = await target.reset();
      response = await fetchResponse(detached.network, detached.controller, url, partial.bytesWritten, idleTimeoutMs, descriptor);
    } else {
      response = await fetchResponse(detached.network, detached.controller, url, 0, idleTimeoutMs, null);
    }
    const initialOffset = target?.snapshot().bytesWritten ?? 0;
    if (descriptor && initialOffset > 0 && response.status === 206 && descriptor.validatorHeader
      && response.headers.get(descriptor.validatorHeader) !== descriptor.validatorValue) {
      throw new Error("download range validator differs");
    }
    const range = totalFromResponse(response, initialOffset);
    if (range.total !== null && range.total > maxBytes) throw new Error("download content length exceeds limit");
    if (!descriptor) {
      const filename = filenameFromResponse(url, args.filename, response);
      const validator = responseValidator(response);
      descriptor = Object.freeze({
        schemaVersion: 1,
        taskId: id,
        sessionDigest: sessionDigest(invocation),
        filename,
        maxBytes,
        expectedSha256,
        validatorHeader: validator?.header ?? null,
        validatorValue: validator?.value ?? null,
        createdAt: new Date().toISOString(),
      });
      target = await invocation.reserveDetachedStreamingFile(detached.detachedContext, filename, {
        defaultRootId: rootId,
        maxBytes,
        resumeId: streamId(id, "data"),
      });
      await gateway.createFile(descriptorName(id), Buffer.from(`${JSON.stringify(descriptor)}\n`, "utf8"), {
        defaultRootId: rootId,
        maxBytes: DESCRIPTOR_MAX_BYTES,
      });
      resumableSetup = true;
    }
    marker = await invocation.reserveDetachedStreamingFile(detached.detachedContext, markerName(id), {
      defaultRootId: rootId,
      maxBytes: DESCRIPTOR_MAX_BYTES,
      resumeId: streamId(id, "marker"),
    });
    if (!descriptor || !target || !marker) throw new Error("download setup is incomplete");
    if (range.mode === "reset") await target.reset();
    const targetSnapshot = target.snapshot();
    const offset = targetSnapshot.bytesWritten;
    if (range.total !== null && offset > range.total) throw new Error("download content length exceeds limit");
    if (range.mode === "complete" && range.total !== offset) throw new Error("download completion range differs");
    if (range.mode === "complete") {
      await response.body?.cancel().catch(() => undefined);
      response = new Response(null, { status: 204 });
    }
    let finish: () => void = () => undefined;
    const finished = new Promise<void>(resolve => { finish = resolve; });
    const task: DownloadTask = {
      id,
      sessionDigest: descriptor.sessionDigest,
      descriptor,
      url,
      controller: detached.controller,
      unregisterController: detached.unregisterController,
      detachedContext: detached.detachedContext,
      target,
      marker,
      idleTimeoutMs,
      state: "running",
      bytesDownloaded: offset,
      totalBytes: range.total,
      sha256: null,
      partialSha256: targetSnapshot.sha256,
      errorCode: null,
      updatedAt: new Date().toISOString(),
      cancelRequested: false,
      worker: Promise.resolve(),
      finish,
      finished,
    };
    tasks.set(id, task);
    pruneTasks();
    task.worker = runDownload(task, response, range.mode === "complete", invocation);
    return taskStatus(task);
  } catch (error) {
    await response?.body?.cancel().catch(() => undefined);
    if (resumableSetup) await target?.preserve().catch(() => undefined);
    else await target?.cancel().catch(() => undefined);
    await marker?.cancel().catch(() => undefined);
    detached.unregisterController();
    await invocation.finishDetachedChild(detached.detachedContext).catch(() => undefined);
    throw error;
  }
}

async function cancelPersisted(invocation: ToolInvocationServices, id: string, rootId: string, descriptor: DownloadDescriptor): Promise<void> {
  const detached = await createDetachedRuntime(invocation, id);
  let target: PathStreamingWriteLease | null = null;
  try {
    target = await invocation.reserveDetachedStreamingFile(detached.detachedContext, descriptor.filename, {
      defaultRootId: rootId,
      maxBytes: descriptor.maxBytes,
      resumeId: streamId(id, "data"),
    });
    const bytesDownloaded = target.snapshot().bytesWritten;
    await target.cancel();
    target = null;
    const marker: DownloadMarker = Object.freeze({
      schemaVersion: 1,
      taskId: id,
      state: "cancelled",
      filename: descriptor.filename,
      bytesDownloaded,
      totalBytes: null,
      sha256: null,
      errorCode: "CANCELLED",
      finishedAt: new Date().toISOString(),
    });
    await invocation.path.createFile(markerName(id), Buffer.from(`${JSON.stringify(marker)}\n`, "utf8"), {
      defaultRootId: rootId,
      maxBytes: DESCRIPTOR_MAX_BYTES,
    });
  } finally {
    await target?.preserve().catch(() => undefined);
    detached.unregisterController();
    await invocation.finishDetachedChild(detached.detachedContext).catch(() => undefined);
  }
}

export function clearSettledDownloadTasks(): number {
  let removed = 0;
  for (const [id, task] of tasks) {
    if (task.state === "running") continue;
    tasks.delete(id);
    removed += 1;
  }
  return removed;
}

export const downloadDef: ToolDefinition = {
  type: "function",
  function: {
    name: "download",
    description: "Start or resume a bounded streaming download. Returns a background task ID immediately after headers and safe output reservation are verified.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTP/HTTPS URL. Required for a new task and after process restart." },
        filename: { type: "string", description: "Optional output filename. Unsafe characters and device names are replaced." },
        resume_task_id: { type: "string", description: "Interrupted download task ID to resume with HTTP Range." },
        sha256: { type: "string", description: "Optional expected lowercase SHA-256 checksum." },
        max_bytes: { type: "number", description: "Maximum bytes, default 1 GiB and hard-capped at 2 GiB." },
        idle_timeout_ms: { type: "number", description: "No-progress timeout, default 30000 and maximum 300000." },
      },
    },
  },
};

export const downloadStatusDef: ToolDefinition = {
  type: "function",
  function: {
    name: "download_status",
    description: "Read background download state and progress. After process restart, unfinished descriptors report interrupted explicitly.",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
  },
};

export const downloadWaitDef: ToolDefinition = {
  type: "function",
  function: {
    name: "download_wait",
    description: "Wait for a download to complete, fail, be cancelled or become interrupted, with a bounded timeout.",
    parameters: {
      type: "object",
      properties: {
        task_id: { type: "string" },
        timeout_ms: { type: "number", description: "Maximum wait, default 30000 and maximum 300000." },
      },
      required: ["task_id"],
    },
  },
};

export const downloadCancelDef: ToolDefinition = {
  type: "function",
  function: {
    name: "download_cancel",
    description: "Cancel a background or interrupted download and remove its unpublished partial file.",
    parameters: {
      type: "object",
      properties: { task_id: { type: "string" } },
      required: ["task_id"],
    },
  },
};

export const downloadExec: ToolExecutor = async (args, _env, invocation) => {
  if (!invocation) throw new Error("Tool invocation services are required");
  const status = await startDownload(args, invocation);
  return JSON.stringify(status);
};

export const downloadStatusExec: ToolExecutor = async (args, _env, invocation) => {
  if (!invocation) throw new Error("Tool invocation services are required");
  throwIfCancelled(invocation.signal);
  const id = taskId(args.task_id);
  const { rootId } = outputGateway(invocation);
  const current = ownedTask(invocation, id);
  return JSON.stringify(current ? taskStatus(current) : await persistedStatus(invocation, id, rootId));
};

export const downloadWaitExec: ToolExecutor = async (args, _env, invocation) => {
  if (!invocation) throw new Error("Tool invocation services are required");
  throwIfCancelled(invocation.signal);
  const id = taskId(args.task_id);
  const timeoutMs = positiveInteger(args.timeout_ms, 30_000, 300_000, "download wait timeout_ms");
  const { rootId } = outputGateway(invocation);
  const current = ownedTask(invocation, id);
  if (!current) return JSON.stringify(await persistedStatus(invocation, id, rootId));
  let timer: NodeJS.Timeout | null = null;
  let onAbort: (() => void) | null = null;
  try {
    await Promise.race([
      current.finished,
      new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs); timer.unref?.(); }),
      new Promise<void>((_resolve, reject) => {
        onAbort = () => reject(cancellationError(invocation.signal, "download wait was cancelled"));
        invocation.signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort) invocation.signal.removeEventListener("abort", onAbort);
  }
  return JSON.stringify(taskStatus(current));
};

export const downloadCancelExec: ToolExecutor = async (args, _env, invocation) => {
  if (!invocation) throw new Error("Tool invocation services are required");
  throwIfCancelled(invocation.signal);
  const id = taskId(args.task_id);
  const { rootId } = outputGateway(invocation);
  const current = ownedTask(invocation, id);
  if (current?.state === "running") {
    current.cancelRequested = true;
    current.controller.abort("cancelled");
    await current.worker;
    return JSON.stringify(taskStatus(current));
  }
  const persisted = await persistedStatus(invocation, id, rootId);
  if (persisted.state !== "interrupted") return JSON.stringify(persisted);
  const descriptor = await loadDescriptor(invocation, id, rootId);
  await cancelPersisted(invocation, id, rootId, descriptor);
  if (current) transition(current, "cancelled", "CANCELLED");
  return JSON.stringify(statusPayload({
    id,
    state: "cancelled",
    filename: descriptor.filename,
    bytesDownloaded: persisted.bytesDownloaded,
    totalBytes: null,
    sha256: null,
    errorCode: "CANCELLED",
    updatedAt: new Date().toISOString(),
  }));
};
