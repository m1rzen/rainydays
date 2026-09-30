import { createHash, randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { getProviderProfile, loadConfig, type ProviderProfile } from "./config.js";
import { MEDIA_ARTIFACTS_DIR } from "./runtime-paths.js";

export type MediaKind = "image" | "video";
export type MediaJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface MediaReference {
  readonly name: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly dataBase64: string;
}

export interface MediaRequest {
  readonly prompt: string;
  readonly references: readonly MediaReference[];
  readonly size?: string;
  readonly quality?: string;
  readonly format?: "png" | "jpeg" | "webp" | "mp4";
  readonly durationSeconds?: number;
  readonly aspectRatio?: string;
}

export interface MediaArtifact {
  readonly artifactId: string;
  readonly kind: MediaKind;
  readonly path: string;
  readonly mimeType: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly createdAt: string;
  readonly providerUrl: string | null;
}

export interface MediaJob {
  readonly jobId: string;
  readonly kind: MediaKind;
  readonly status: MediaJobStatus;
  readonly prompt: string;
  readonly profileName: string;
  readonly model: string;
  readonly capability: Readonly<{ generation: boolean; editing: boolean; polling: boolean; cancellation: boolean }>;
  readonly referenceMetadata: readonly Omit<MediaReference, "dataBase64">[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
  readonly progress: number;
  readonly providerJobId: string | null;
  readonly artifacts: readonly MediaArtifact[];
  readonly error: string | null;
}

interface MutableMediaJob {
  jobId: string;
  kind: MediaKind;
  status: MediaJobStatus;
  prompt: string;
  profileName: string;
  model: string;
  capability: { generation: boolean; editing: boolean; polling: boolean; cancellation: boolean };
  referenceMetadata: Omit<MediaReference, "dataBase64">[];
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  progress: number;
  providerJobId: string | null;
  artifacts: MediaArtifact[];
  error: string | null;
}

export interface ProviderArtifactResult {
  readonly mimeType?: string;
  readonly dataBase64?: string;
  readonly url?: string;
}

export interface ProviderGenerationResult {
  readonly providerJobId?: string;
  readonly status: "completed" | "pending" | "failed";
  readonly progress?: number;
  readonly artifacts?: readonly ProviderArtifactResult[];
  readonly error?: string;
}

export interface MediaProvider {
  readonly profileName: string;
  readonly model: string;
  readonly capability: Readonly<{ generation: boolean; editing: boolean; polling: boolean; cancellation: boolean }>;
  generate(kind: MediaKind, request: MediaRequest, signal: AbortSignal): Promise<ProviderGenerationResult>;
  poll?(kind: MediaKind, providerJobId: string, signal: AbortSignal): Promise<ProviderGenerationResult>;
  cancel?(kind: MediaKind, providerJobId: string): Promise<void>;
  fetchArtifact?(url: string, signal: AbortSignal): Promise<Readonly<{ bytes: Buffer; mimeType: string }>>;
}

interface ActiveMediaJob {
  readonly controller: AbortController;
  readonly provider: MediaProvider;
  readonly cleanup?: () => Promise<void>;
  readonly completion: Promise<void>;
}

const MAX_REFERENCE_BYTES = 32 * 1024 * 1024;
const MAX_IMAGE_BYTES = 64 * 1024 * 1024;
const MAX_VIDEO_BYTES = 512 * 1024 * 1024;
const MAX_HISTORY = 1_000;
const JOB_ID = /^media_[a-f0-9]{24}$/u;

function exactText(value: unknown, label: string, maximum: number, allowEmpty = false): string {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0") || (!allowEmpty && value.length === 0)) throw new TypeError(`${label} is invalid`);
  return value;
}

function cloneJob(job: MutableMediaJob): MediaJob {
  return Object.freeze({
    ...job,
    capability: Object.freeze({ ...job.capability }),
    referenceMetadata: Object.freeze(job.referenceMetadata.map(reference => Object.freeze({ ...reference }))),
    artifacts: Object.freeze(job.artifacts.map(artifact => Object.freeze({ ...artifact }))),
  });
}

export function detectImageMime(bytes: Uint8Array, name = "image"): string {
  if (bytes.length > MAX_REFERENCE_BYTES) throw new Error(`Reference image exceeds ${MAX_REFERENCE_BYTES} bytes: ${name}`);
  const match = (...values: number[]): boolean => values.every((value, index) => bytes[index] === value);
  if (match(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (match(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (match(0x47, 0x49, 0x46, 0x38)) return "image/gif";
  if (bytes.length >= 12 && String.fromCharCode(...bytes.slice(0, 4)) === "RIFF" && String.fromCharCode(...bytes.slice(8, 12)) === "WEBP") return "image/webp";
  throw new Error(`Unsupported reference image MIME/signature: ${name}`);
}

export function createMediaReference(nameInput: string, bytes: Uint8Array): MediaReference {
  const name = exactText(nameInput, "Reference image name", 240);
  const buffer = Buffer.from(bytes);
  const mimeType = detectImageMime(buffer, name);
  return Object.freeze({ name, mimeType, bytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex"), dataBase64: buffer.toString("base64") });
}

function profileFor(kind: "vision" | MediaKind): Readonly<{ name: string; profile: ProviderProfile }> {
  const config = loadConfig();
  const requested = kind === "vision" ? config.domains.common.visionProfile : kind === "image" ? config.domains.common.imageProfile : config.domains.common.videoProfile;
  const name = requested || config.defaultProfile;
  return Object.freeze({ name, profile: getProviderProfile(name) });
}

export function getVisionProfile(): Readonly<{ name: string; profile: ProviderProfile }> { return profileFor("vision"); }
export function getMediaProfile(kind: MediaKind): Readonly<{ name: string; profile: ProviderProfile }> { return profileFor(kind); }

function endpoint(baseURL: string, suffix: string): string { return `${baseURL.replace(/\/+$/u, "")}${suffix}`; }

function outputMime(kind: MediaKind, value?: string): string {
  if (value && /^(?:image|video)\/[a-z0-9.+-]+$/iu.test(value)) return value.toLowerCase();
  return kind === "video" ? "video/mp4" : "image/png";
}

export type MediaFetch = (url: string, init?: RequestInit) => Promise<Response>;

export class OpenAiCompatibleMediaProvider implements MediaProvider {
  readonly profileName: string;
  readonly model: string;
  readonly profile: ProviderProfile;
  readonly fetcher: MediaFetch;
  readonly capability: Readonly<{ generation: boolean; editing: boolean; polling: boolean; cancellation: boolean }>;

  constructor(profileName: string, profile: ProviderProfile, fetcher: MediaFetch) {
    this.profileName = profileName;
    this.profile = profile;
    this.model = profile.model;
    this.fetcher = fetcher;
    this.capability = Object.freeze({ generation: true, editing: true, polling: true, cancellation: true });
  }

  #headers(): Record<string, string> {
    return { "content-type": "application/json", ...(this.profile.apiKey ? { authorization: `Bearer ${this.profile.apiKey}` } : {}) };
  }

  async #json(url: string, init: RequestInit, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.fetcher(url, { ...init, signal });
    const text = await response.text();
    let value: unknown;
    try { value = text ? JSON.parse(text) : {}; } catch { throw new Error(`Media provider returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`); }
    if (!response.ok) throw new Error(`Media provider HTTP ${response.status}: ${JSON.stringify(value).slice(0, 1_000)}`);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Media provider response is invalid");
    return value as Record<string, unknown>;
  }

  #result(kind: MediaKind, value: Record<string, unknown>): ProviderGenerationResult {
    const statusValue = typeof value.status === "string" ? value.status.toLowerCase() : "";
    const data = Array.isArray(value.data) ? value.data : Array.isArray(value.output) ? value.output : [];
    const artifacts = data.flatMap((entry): ProviderArtifactResult[] => {
      if (typeof entry === "string") return entry.startsWith("http") ? [{ url: entry }] : [{ dataBase64: entry, mimeType: outputMime(kind) }];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) return [];
      const record = entry as Record<string, unknown>;
      const url = typeof record.url === "string" ? record.url : undefined;
      const dataBase64 = typeof record.b64_json === "string" ? record.b64_json : typeof record.dataBase64 === "string" ? record.dataBase64 : undefined;
      const mimeType = outputMime(kind, typeof record.mimeType === "string" ? record.mimeType : undefined);
      return url || dataBase64 ? [{ url, dataBase64, mimeType }] : [];
    });
    const providerJobId = typeof value.id === "string" ? value.id : typeof value.job_id === "string" ? value.job_id : undefined;
    const failed = new Set(["failed", "error", "cancelled"]).has(statusValue);
    const pending = providerJobId && artifacts.length === 0 && !failed;
    return Object.freeze({
      providerJobId,
      status: failed ? "failed" : pending ? "pending" : "completed",
      progress: typeof value.progress === "number" ? value.progress : pending ? 0 : 100,
      artifacts: Object.freeze(artifacts),
      error: typeof value.error === "string" ? value.error : failed ? JSON.stringify(value.error ?? "Provider generation failed") : undefined,
    });
  }

  async generate(kind: MediaKind, request: MediaRequest, signal: AbortSignal): Promise<ProviderGenerationResult> {
    const edit = kind === "image" && request.references.length > 0;
    const suffix = kind === "video" ? "/videos/generations" : edit ? "/images/edits" : "/images/generations";
    const body = {
      model: this.model,
      prompt: request.prompt,
      size: request.size,
      quality: request.quality,
      response_format: "b64_json",
      duration: request.durationSeconds,
      aspect_ratio: request.aspectRatio,
      images: request.references.map(reference => ({ name: reference.name, image: `data:${reference.mimeType};base64,${reference.dataBase64}` })),
    };
    return this.#result(kind, await this.#json(endpoint(this.profile.baseURL, suffix), { method: "POST", headers: this.#headers(), body: JSON.stringify(body) }, signal));
  }

  async poll(kind: MediaKind, providerJobId: string, signal: AbortSignal): Promise<ProviderGenerationResult> {
    return this.#result(kind, await this.#json(endpoint(this.profile.baseURL, `/videos/generations/${encodeURIComponent(providerJobId)}`), { method: "GET", headers: this.#headers() }, signal));
  }

  async cancel(_kind: MediaKind, providerJobId: string): Promise<void> {
    await this.#json(endpoint(this.profile.baseURL, `/videos/generations/${encodeURIComponent(providerJobId)}/cancel`), { method: "POST", headers: this.#headers() });
  }

  async fetchArtifact(url: string, signal: AbortSignal): Promise<Readonly<{ bytes: Buffer; mimeType: string }>> {
    const response = await this.fetcher(url, { signal });
    if (!response.ok) throw new Error(`Media artifact download failed: HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return Object.freeze({ bytes, mimeType: response.headers.get("content-type")?.split(";")[0] || "application/octet-stream" });
  }
}

export class MediaJobManager {
  readonly root: string;
  #jobs = new Map<string, MutableMediaJob>();
  #active = new Map<string, ActiveMediaJob>();
  #ready: Promise<void>;
  #writeQueue: Promise<void> = Promise.resolve();

  constructor(root = MEDIA_ARTIFACTS_DIR) {
    this.root = root;
    this.#ready = this.#recover();
  }

  async #recover(): Promise<void> {
    const jobsDirectory = path.join(this.root, "jobs");
    await mkdir(jobsDirectory, { recursive: true });
    for (const entry of await readdir(jobsDirectory, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      try {
        const value = JSON.parse(await readFile(path.join(jobsDirectory, entry.name), "utf8")) as MutableMediaJob;
        if (!value || !JOB_ID.test(value.jobId)) continue;
        if (value.status === "queued" || value.status === "running") {
          value.status = "interrupted";
          value.error = "Generation was interrupted by process restart; provider job id is preserved for diagnosis";
          value.completedAt = new Date().toISOString();
          value.updatedAt = value.completedAt;
          await this.#persist(value);
        }
        this.#jobs.set(value.jobId, value);
      } catch (error) {
        console.error(`Skipping invalid media job ${entry.name}:`, error);
      }
    }
  }

  async #persist(job: MutableMediaJob): Promise<void> {
    job.updatedAt = new Date().toISOString();
    const target = path.join(this.root, "jobs", `${job.jobId}.json`);
    const snapshot = cloneJob(job);
    const write = async (): Promise<void> => {
      await mkdir(path.dirname(target), { recursive: true });
      const temporary = `${target}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
      await rm(target, { force: true });
      await rename(temporary, target);
    };
    const queued = this.#writeQueue.then(write, write);
    this.#writeQueue = queued;
    await queued;
  }

  async #saveArtifact(job: MutableMediaJob, result: ProviderArtifactResult, provider: MediaProvider, signal: AbortSignal): Promise<MediaArtifact> {
    let bytes: Buffer;
    let mimeType = outputMime(job.kind, result.mimeType);
    if (result.dataBase64) bytes = Buffer.from(result.dataBase64, "base64");
    else if (result.url && provider.fetchArtifact) {
      const downloaded = await provider.fetchArtifact(result.url, signal);
      bytes = downloaded.bytes;
      mimeType = outputMime(job.kind, downloaded.mimeType);
    } else throw new Error("Media provider artifact has no downloadable bytes");
    const maximum = job.kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
    if (bytes.length === 0 || bytes.length > maximum) throw new Error(`Generated ${job.kind} artifact size is invalid: ${bytes.length}`);
    const extension = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : mimeType === "video/mp4" ? "mp4" : "png";
    const artifactId = `artifact_${randomBytes(12).toString("hex")}`;
    const directory = path.join(this.root, "files", job.jobId);
    await mkdir(directory, { recursive: true });
    const filePath = path.join(directory, `${artifactId}.${extension}`);
    await writeFile(filePath, bytes, { flag: "wx" });
    return Object.freeze({ artifactId, kind: job.kind, path: filePath, mimeType, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex"), createdAt: new Date().toISOString(), providerUrl: result.url ?? null });
  }

  async #run(job: MutableMediaJob, request: MediaRequest, active: ActiveMediaJob): Promise<void> {
    try {
      job.status = "running";
      job.progress = 1;
      await this.#persist(job);
      let result = await active.provider.generate(job.kind, request, active.controller.signal);
      if (result.providerJobId) job.providerJobId = exactText(result.providerJobId, "Provider job id", 500);
      while (result.status === "pending") {
        if (!active.provider.poll || !job.providerJobId) throw new Error("Media provider returned a pending job without polling support");
        job.progress = Math.max(job.progress, Math.min(99, result.progress ?? job.progress));
        await this.#persist(job);
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, 1_000);
          active.controller.signal.addEventListener("abort", () => { clearTimeout(timer); reject(active.controller.signal.reason); }, { once: true });
        });
        result = await active.provider.poll(job.kind, job.providerJobId, active.controller.signal);
      }
      if (result.status === "failed") throw new Error(result.error || "Media provider generation failed");
      for (const artifactResult of result.artifacts ?? []) job.artifacts.push(await this.#saveArtifact(job, artifactResult, active.provider, active.controller.signal));
      if (job.artifacts.length === 0) throw new Error("Media provider completed without an artifact");
      job.status = "completed";
      job.progress = 100;
      job.completedAt = new Date().toISOString();
    } catch (error) {
      if (active.controller.signal.aborted) {
        job.status = "cancelled";
        job.error = active.controller.signal.reason instanceof Error ? active.controller.signal.reason.message : "Media generation cancelled";
      } else {
        job.status = "failed";
        job.error = error instanceof Error ? error.stack || error.message : String(error);
      }
      job.completedAt = new Date().toISOString();
    } finally {
      try { await this.#persist(job); } finally {
        this.#active.delete(job.jobId);
        await active.cleanup?.().catch(() => undefined);
      }
    }
  }

  async start(kind: MediaKind, request: MediaRequest, provider: MediaProvider, cleanup?: () => Promise<void>): Promise<MediaJob> {
    await this.#ready;
    if (request.references.length > 4) throw new Error("At most four reference images are supported");
    const prompt = exactText(request.prompt, "Media prompt", 32_768);
    const jobId = `media_${randomBytes(12).toString("hex")}`;
    const now = new Date().toISOString();
    const job: MutableMediaJob = {
      jobId, kind, status: "queued", prompt, profileName: provider.profileName, model: provider.model,
      capability: { ...provider.capability },
      referenceMetadata: request.references.map(({ dataBase64: _discard, ...metadata }) => ({ ...metadata })),
      createdAt: now, updatedAt: now, completedAt: null, progress: 0, providerJobId: null, artifacts: [], error: null,
    };
    this.#jobs.set(jobId, job);
    let resolveCompletion!: () => void;
    const completion = new Promise<void>(resolve => { resolveCompletion = resolve; });
    const active = Object.freeze({ controller: new AbortController(), provider, cleanup, completion });
    this.#active.set(jobId, active);
    await this.#persist(job);
    void this.#run(job, { ...request, prompt }, active).finally(resolveCompletion);
    return cloneJob(job);
  }

  async status(jobIdInput: string): Promise<MediaJob> {
    await this.#ready;
    const jobId = exactText(jobIdInput, "Media job id", 64);
    if (!JOB_ID.test(jobId)) throw new TypeError("Media job id is invalid");
    const job = this.#jobs.get(jobId);
    if (!job) throw new Error(`Media job was not found: ${jobId}`);
    return cloneJob(job);
  }

  async cancel(jobIdInput: string): Promise<MediaJob> {
    await this.#ready;
    const job = await this.status(jobIdInput);
    const mutable = this.#jobs.get(job.jobId)!;
    const active = this.#active.get(job.jobId);
    if (!active || !new Set<MediaJobStatus>(["queued", "running"]).has(mutable.status)) throw new Error(`Media job is not cancellable: ${job.jobId}`);
    if (mutable.providerJobId && active.provider.cancel) await active.provider.cancel(mutable.kind, mutable.providerJobId).catch(() => undefined);
    active.controller.abort(new Error("Media generation cancelled by user"));
    mutable.status = "cancelled";
    mutable.completedAt = new Date().toISOString();
    mutable.error = "Media generation cancelled by user";
    await this.#persist(mutable);
    await active.completion;
    return cloneJob(mutable);
  }

  async history(limitInput = 50): Promise<MediaJob[]> {
    await this.#ready;
    const limit = Math.max(1, Math.min(MAX_HISTORY, Math.floor(limitInput)));
    return [...this.#jobs.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit).map(cloneJob);
  }
}

export const mediaJobs = new MediaJobManager();
