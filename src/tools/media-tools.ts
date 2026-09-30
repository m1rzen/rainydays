import path from "node:path";
import { createMediaReference, getMediaProfile, mediaJobs, OpenAiCompatibleMediaProvider, type MediaKind, type MediaReference, type MediaRequest } from "../media.js";
import { throwIfCancelled } from "../run-cancellation.js";
import type { ToolDefinition, ToolExecutor, ToolInvocationServices } from "../types.js";

const referenceImages = { type: "array", maxItems: 4, items: { type: "string" }, description: "Optional reference image paths under DATA_ROOT." } as const;
const noExtra = { additionalProperties: false } as const;

function json(value: unknown): string { return JSON.stringify(value, null, 2); }

async function readReferences(values: unknown, invocation: ToolInvocationServices): Promise<MediaReference[]> {
  if (values === undefined) return [];
  if (!Array.isArray(values) || values.length > 4 || values.some(value => typeof value !== "string")) throw new TypeError("reference_images must contain at most four paths");
  const rootId = invocation.path.rootIdForEnv("DATA_ROOT");
  if (!rootId) throw new Error("Reference images require DATA_ROOT");
  const references: MediaReference[] = [];
  for (const value of values as string[]) {
    throwIfCancelled(invocation.signal);
    const authorized = await invocation.path.readFile(value, { defaultRootId: rootId, maxBytes: 32 * 1024 * 1024 });
    references.push(createMediaReference(path.basename(value), authorized.bytes));
  }
  return references;
}

async function start(kind: MediaKind, args: Readonly<Record<string, unknown>>, invocation: ToolInvocationServices | undefined): Promise<string> {
  if (!invocation) throw new Error("Media generation requires invocation services");
  throwIfCancelled(invocation.signal);
  const references = await readReferences(args.reference_images, invocation);
  const request: MediaRequest = {
    prompt: args.prompt as string,
    references,
    size: typeof args.size === "string" ? args.size : undefined,
    quality: typeof args.quality === "string" ? args.quality : undefined,
    format: typeof args.format === "string" ? args.format as MediaRequest["format"] : undefined,
    durationSeconds: typeof args.duration_seconds === "number" ? args.duration_seconds : undefined,
    aspectRatio: typeof args.aspect_ratio === "string" ? args.aspect_ratio : undefined,
  };
  const selected = getMediaProfile(kind);
  const lifecycle = new AbortController();
  const child = invocation.deriveDetachedChild({ principal: "playbook" }, `media:${kind}:${Date.now()}`);
  const network = invocation.createDetachedNetwork(child, lifecycle.signal);
  const provider = new OpenAiCompatibleMediaProvider(selected.name, selected.profile, network.fetch);
  let started = false;
  const cleanup = async (): Promise<void> => {
    if (!lifecycle.signal.aborted) lifecycle.abort();
    await invocation.finishDetachedChild(child);
  };
  try {
    const job = await mediaJobs.start(kind, request, provider, cleanup);
    started = true;
    return json(job);
  } finally {
    if (!started) await cleanup().catch(() => undefined);
  }
}

export const generateImageDef: ToolDefinition = {
  type: "function",
  function: {
    name: "generate_image",
    description: "Start asynchronous text-to-image or reference-image edit generation using the configured image profile.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", maxLength: 32768 },
        reference_images: referenceImages,
        size: { type: "string" },
        quality: { type: "string" },
        format: { type: "string", enum: ["png", "jpeg", "webp"] },
      },
      required: ["prompt"],
      ...noExtra,
    },
  },
};
export const generateImageExec: ToolExecutor = async (args, _env, invocation) => start("image", args, invocation);

export const generateVideoDef: ToolDefinition = {
  type: "function",
  function: {
    name: "generate_video",
    description: "Start asynchronous text/reference-to-video generation with provider polling using the configured video profile.",
    parameters: {
      type: "object",
      properties: {
        prompt: { type: "string", maxLength: 32768 },
        reference_images: referenceImages,
        duration_seconds: { type: "number", minimum: 1, maximum: 300 },
        aspect_ratio: { type: "string" },
        format: { type: "string", enum: ["mp4"] },
      },
      required: ["prompt"],
      ...noExtra,
    },
  },
};
export const generateVideoExec: ToolExecutor = async (args, _env, invocation) => start("video", args, invocation);

export const mediaStatusDef: ToolDefinition = { type: "function", function: { name: "media_status", description: "Get persistent image/video generation job status and artifact metadata.", parameters: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"], ...noExtra } } };
export const mediaStatusExec: ToolExecutor = async args => json(await mediaJobs.status(args.job_id as string));

export const mediaCancelDef: ToolDefinition = { type: "function", function: { name: "media_cancel", description: "Cancel a queued/running image or video generation job.", parameters: { type: "object", properties: { job_id: { type: "string" } }, required: ["job_id"], ...noExtra } } };
export const mediaCancelExec: ToolExecutor = async args => json(await mediaJobs.cancel(args.job_id as string));

export const mediaHistoryDef: ToolDefinition = { type: "function", function: { name: "media_history", description: "Restore persistent image/video generation history with inline artifact metadata.", parameters: { type: "object", properties: { limit: { type: "number", minimum: 1, maximum: 1000 } }, ...noExtra } } };
export const mediaHistoryExec: ToolExecutor = async args => json(await mediaJobs.history(typeof args.limit === "number" ? args.limit : 50));
