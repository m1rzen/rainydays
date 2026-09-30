import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "media04-provider-"));
process.env.RAINYDAYS_USER_DATA_DIR = root;
const { MediaJobManager, OpenAiCompatibleMediaProvider, createMediaReference } = await import("../../src/media.ts");
after(async () => { await rm(root, { recursive: true, force: true }); });

const png = Buffer.from([0x89,0x50,0x4e,0x47,0x0d,0x0a,0x1a,0x0a,8,9,10,11]);
const mp4 = Buffer.from("media04-video-artifact");

async function fixture() {
  let videoPolls = 0;
  const requests = [];
  const server = http.createServer(async (request, response) => {
    const body = await new Promise(resolve => { const chunks=[]; request.on("data", chunk => chunks.push(chunk)); request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8"))); });
    requests.push({ method: request.method, url: request.url, body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/v1/images/generations") {
      const base = `http://127.0.0.1:${server.address().port}`;
      response.end(JSON.stringify({ data: [{ url: `${base}/artifact.png`, mimeType: "image/png" }] }));
      return;
    }
    if (request.url === "/v1/images/edits") {
      response.end(JSON.stringify({ data: [{ b64_json: png.toString("base64"), mimeType: "image/png" }] }));
      return;
    }
    if (request.url === "/v1/videos/generations" && request.method === "POST") {
      response.end(JSON.stringify({ id: "video-remote-1", status: "queued", progress: 5 }));
      return;
    }
    if (request.url === "/v1/videos/generations/video-remote-1") {
      videoPolls += 1;
      response.end(JSON.stringify(videoPolls < 1 ? { id: "video-remote-1", status: "running", progress: 50 } : { id: "video-remote-1", status: "completed", data: [{ b64_json: mp4.toString("base64"), mimeType: "video/mp4" }] }));
      return;
    }
    if (request.url === "/artifact.png") {
      response.statusCode = 200;
      response.setHeader("content-type", "image/png");
      response.end(png);
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  return { server, requests, baseURL: `http://127.0.0.1:${server.address().port}/v1` };
}

async function waitFor(manager, jobId, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const job = await manager.status(jobId);
    if (["completed", "failed", "cancelled"].includes(job.status)) return job;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  assert.fail("provider job did not settle");
}

test("MEDIA-04 drives compatible image generation/edit, URL artifact download, video polling, and persistent metadata", async () => {
  const { server, requests, baseURL } = await fixture();
  const provider = new OpenAiCompatibleMediaProvider("media-profile", {
    model: "media-model", apiKey: "fixture-key", baseURL, providerType: "openai-compatible", codexTransport: "auto", proxy: "", stripImages: false, knowledgeMaxCount: 20, personaProfileBindings: {},
  }, (url, init) => fetch(url, init));
  const manager = new MediaJobManager(path.join(root, "provider-jobs"));
  try {
    const generated = await manager.start("image", { prompt: "generate", references: [] }, provider);
    const generatedDone = await waitFor(manager, generated.jobId);
    assert.equal(generatedDone.status, "completed", generatedDone.error);
    assert.equal(generatedDone.artifacts[0].mimeType, "image/png");
    assert.equal(generatedDone.artifacts[0].providerUrl.endsWith("/artifact.png"), true);

    const reference = createMediaReference("reference.png", png);
    const edited = await manager.start("image", { prompt: "edit", references: [reference] }, provider);
    assert.equal((await waitFor(manager, edited.jobId)).status, "completed");

    const video = await manager.start("video", { prompt: "animate", references: [reference], durationSeconds: 3, aspectRatio: "16:9" }, provider);
    const videoDone = await waitFor(manager, video.jobId);
    assert.equal(videoDone.status, "completed", videoDone.error);
    assert.equal(videoDone.providerJobId, "video-remote-1");
    assert.equal(videoDone.artifacts[0].mimeType, "video/mp4");
    assert(requests.some(request => request.url === "/v1/images/edits" && request.body.includes("data:image/png;base64")));
    assert(requests.some(request => request.url === "/v1/videos/generations/video-remote-1"));
    assert.equal((await manager.history()).length, 3);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
