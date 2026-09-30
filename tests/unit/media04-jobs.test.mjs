import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "media04-unit-"));
process.env.RAINYDAYS_USER_DATA_DIR = root;
const { MediaJobManager, createMediaReference, detectImageMime } = await import("../../src/media.ts");
after(async () => { await rm(root, { recursive: true, force: true }); });

const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,1,2,3,4]);

async function waitFor(manager, jobId, expected, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await manager.status(jobId);
    if (job.status === expected) return job;
    if (["failed", "cancelled", "interrupted"].includes(job.status) && job.status !== expected) assert.fail(job.error || job.status);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Media job ${jobId} did not reach ${expected}`);
}

test("MEDIA-04 validates reference MIME/signature and omits raw bytes from persisted metadata", async () => {
  assert.equal(detectImageMime(png, "fixture.png"), "image/png");
  assert.throws(() => detectImageMime(Buffer.from("not-image"), "bad.bin"), /Unsupported reference image/u);
  const reference = createMediaReference("fixture.png", png);
  assert.equal(reference.mimeType, "image/png");
  assert.equal(reference.dataBase64, png.toString("base64"));
});

test("MEDIA-04 persists completed image artifacts and restores history", async () => {
  const manager = new MediaJobManager(path.join(root, "image-jobs"));
  const provider = {
    profileName: "image-profile",
    model: "image-model",
    capability: { generation: true, editing: true, polling: false, cancellation: false },
    generate: async () => ({ status: "completed", artifacts: [{ mimeType: "image/png", dataBase64: png.toString("base64") }] }),
  };
  const reference = createMediaReference("fixture.png", png);
  const started = await manager.start("image", { prompt: "edit fixture", references: [reference], format: "png" }, provider);
  const completed = await waitFor(manager, started.jobId, "completed");
  assert.equal(completed.progress, 100);
  assert.equal(completed.artifacts.length, 1);
  assert.equal(completed.artifacts[0].sha256, reference.sha256);
  assert.equal(completed.referenceMetadata[0].sha256, reference.sha256);
  assert.equal("dataBase64" in completed.referenceMetadata[0], false);

  const recovered = new MediaJobManager(path.join(root, "image-jobs"));
  const history = await recovered.history();
  assert.equal(history.length, 1);
  assert.equal(history[0].status, "completed");
  assert.equal(history[0].artifacts[0].path, completed.artifacts[0].path);
});

test("MEDIA-04 cancels an asynchronous pending video job", async () => {
  const manager = new MediaJobManager(path.join(root, "cancel-jobs"));
  let cancelCalls = 0;
  const provider = {
    profileName: "video-profile",
    model: "video-model",
    capability: { generation: true, editing: false, polling: true, cancellation: true },
    generate: async () => ({ status: "pending", providerJobId: "provider-video-1", progress: 10 }),
    poll: async () => ({ status: "pending", providerJobId: "provider-video-1", progress: 20 }),
    cancel: async () => { cancelCalls += 1; },
  };
  const started = await manager.start("video", { prompt: "cancel fixture", references: [] }, provider);
  while ((await manager.status(started.jobId)).providerJobId === null) await new Promise(resolve => setTimeout(resolve, 10));
  const cancelled = await manager.cancel(started.jobId);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelCalls, 1);
});
