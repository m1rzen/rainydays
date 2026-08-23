import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { deflateSync } from "node:zlib";
import test from "node:test";
import {
  freePort,
  makeTempDir,
  projectRoot,
  removeFixture,
  spawnManaged,
  terminateProcessTreeAsync,
  waitFor,
} from "../helpers.mjs";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0); name.copy(output, 4); data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}
function png(extraChunks = []) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"), pngChunk("IHDR", header), ...extraChunks,
    pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 255]))), pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
function sse(response, content) {
  response.writeHead(200, { "Content-Type": "text/event-stream" });
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-ds05", object: "chat.completion.chunk", created: 1, model: "vision-model", choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }] })}\n\n`);
  response.write(`data: ${JSON.stringify({ id: "chatcmpl-ds05", object: "chat.completion.chunk", created: 1, model: "vision-model", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
  response.end("data: [DONE]\n\n");
}
async function startProvider() {
  const port = await freePort();
  const requests = [];
  const server = http.createServer(async (request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    let raw = "";
    for await (const chunk of request) raw += chunk;
    requests.push(JSON.parse(raw));
    sse(response, "vision-ok");
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  return {
    baseURL: `http://127.0.0.1:${port}/v1`, requests,
    close: async () => { server.closeAllConnections?.(); await new Promise(resolve => server.close(resolve)); },
  };
}
async function startProduct(fixture, providerBaseURL, token) {
  const workspace = path.join(fixture, "workspace");
  const department = path.join(fixture, "department");
  const output = path.join(fixture, "output");
  await Promise.all([workspace, department, output, path.join(fixture, "data")].map(directory => fs.mkdir(directory, { recursive: true })));
  const configPath = path.join(fixture, "config.json");
  await fs.writeFile(configPath, JSON.stringify({
    defaultProfile: "default",
    profiles: { default: { model: "vision-model", apiKey: "ds05-secret", baseURL: providerBaseURL, providerType: "openai-compatible-vision" } },
    settings: { defaultPersona: "general", workspaceRoot: workspace, departmentDataRoot: department, outputDir: output },
  }));
  const port = await freePort();
  const base = `http://127.0.0.1:${port}/api`;
  const child = spawnManaged(process.execPath, ["tests/fixtures/server-with-test-protector.mjs"], {
    cwd: projectRoot, stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env, PORT: String(port), RAINYDAYS_API_TOKEN: token,
      RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data"), RAINYDAYS_CONFIG_PATH: configPath,
      RAINYDAYS_ALLOW_LOOPBACK_HTTP_PROVIDER: "1", RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"),
      RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"), RAINYDAYS_PUBLIC_DIR: path.join(projectRoot, "public"),
      WORKSPACE_ROOT: "", DEPARTMENT_DATA_ROOT: "", OUTPUT_DIR: "",
    },
  });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  await waitFor(async () => (await fetch(`${base}/status`, { headers: { "X-RainyDays-Token": token } }).catch(() => null))?.ok === true,
    { timeoutMs: 30_000, label: "DS-05 server" });
  return { child, base, logs: () => ({ stdout, stderr }) };
}
let childCounter = 0;
async function childRequest(child, input) {
  const requestId = `ds05-child-${++childCounter}`;
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { child.off("message", onMessage); reject(new Error("DS-05 child timeout")); }, 10_000);
    const onMessage = message => {
      if (message?.requestId !== requestId) return;
      clearTimeout(timer); child.off("message", onMessage);
      if (message.ok) resolve(message.value); else reject(new Error(message.error || "DS-05 child failed"));
    };
    child.on("message", onMessage);
    child.send({ ...input, requestId });
  });
}
async function stopProduct(product) {
  if (!product) return;
  await childRequest(product.child, { type: "rt01-shutdown" }).catch(() => undefined);
  await terminateProcessTreeAsync(product.child);
}
async function api(base, token, route, options = {}) {
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: { "X-RainyDays-Token": token, "Content-Type": "application/json", ...options.headers },
  });
  const text = await response.text();
  let body = text;
  try { body = JSON.parse(text); } catch {}
  return { status: response.status, body, response };
}
async function createSession(product, token) {
  const created = await api(product.base, token, "/sessions", { method: "POST", body: "{}" });
  assert.equal(created.status, 200);
  return created.body.session.id;
}
async function reserve(product, token, sessionId, name, mime, size) {
  return api(product.base, token, `/sessions/${sessionId}/attachments`, {
    method: "POST", headers: { "X-RainyDays-Session": sessionId }, body: JSON.stringify({ name, mime, size }),
  });
}
async function upload(product, token, sessionId, attachmentId, bytes) {
  return api(product.base, token, `/sessions/${sessionId}/attachments/${attachmentId}/content`, {
    method: "PUT",
    headers: { "X-RainyDays-Session": sessionId, "Content-Type": "application/octet-stream", "Content-Length": String(bytes.length) },
    body: bytes,
  });
}
function partialUpload(product, token, sessionId, attachmentId, declaredSize) {
  const target = new URL(`${product.base}/sessions/${sessionId}/attachments/${attachmentId}/content`);
  let settle;
  const closed = new Promise(resolve => { settle = resolve; });
  const request = http.request(target, {
    method: "PUT",
    headers: {
      "X-RainyDays-Token": token,
      "X-RainyDays-Session": sessionId,
      "Content-Type": "application/octet-stream",
      "Content-Length": String(declaredSize),
    },
  });
  request.once("response", response => { response.resume(); response.once("end", settle); });
  request.once("error", settle);
  request.once("close", settle);
  request.write(Buffer.from("x"));
  return { request, closed };
}

test("DS-05 attachments remain Session-owned across upload, chat, export/import and restart", { timeout: 120_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-ds05-");
  const token = "d".repeat(64);
  const provider = await startProvider();
  let product;
  try {
    product = await startProduct(fixture, provider.baseURL, token);
    const sessionA = await createSession(product, token);
    const sessionB = await createSession(product, token);
    const image = png();

    const reserved = await reserve(product, token, sessionA, "screen.png", "image/png", image.length);
    assert.equal(reserved.status, 201);
    const attachmentId = reserved.body.attachment.id;
    const crossRead = await api(product.base, token, `/sessions/${sessionA}/attachments/${attachmentId}/content`, {
      headers: { "X-RainyDays-Session": sessionB },
    });
    assert.equal(crossRead.status, 400);
    const uploaded = await upload(product, token, sessionA, attachmentId, image);
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
    assert.equal(uploaded.body.attachment.state, "ready");

    const chat = await api(product.base, token, "/chat", {
      method: "POST", headers: { "X-RainyDays-Session": sessionA },
      body: JSON.stringify({ sessionId: sessionA, message: "inspect image", attachmentIds: [attachmentId] }),
    });
    assert.equal(chat.status, 200, String(chat.body));
    assert(provider.requests.length >= 1);
    const user = [...provider.requests.at(-1).messages].reverse().find(message => message.role === "user");
    assert(Array.isArray(user.content));
    const imagePart = user.content.find(part => part.type === "image_url");
    assert(imagePart.image_url.url.startsWith("data:image/png;base64,"));
    assert.equal(Buffer.from(imagePart.image_url.url.split(",")[1], "base64").equals(image), true);
    assert.equal(JSON.stringify(provider.requests.at(-1)).includes(fixture), false);

    const history = await api(product.base, token, `/sessions/${sessionA}/messages`, { headers: { "X-RainyDays-Session": sessionA } });
    const userMessage = history.body.messages.find(message => message.role === "user");
    assert.equal(userMessage.attachments[0].id, attachmentId);
    const drafts = await api(product.base, token, `/sessions/${sessionA}/attachments`, { headers: { "X-RainyDays-Session": sessionA } });
    assert.deepEqual(drafts.body.attachments, []);

    const exported = await api(product.base, token, `/sessions/${sessionA}/export`, { headers: { "X-RainyDays-Session": sessionA } });
    assert.equal(exported.status, 200);
    assert.equal(exported.body.canvas.attachments.length, 1);
    assert.equal(Buffer.from(exported.body.canvas.attachments[0].contentBase64, "base64").equals(image), true);
    const imported = await api(product.base, token, "/sessions/import", { method: "POST", body: JSON.stringify(exported.body) });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    const importedId = imported.body.session.id;
    const importedHistory = await api(product.base, token, `/sessions/${importedId}/messages`, { headers: { "X-RainyDays-Session": importedId } });
    assert.equal(importedHistory.body.messages.find(message => message.role === "user").attachments.length, 1);

    const maximumImageBytes = 8 * 1024 * 1024;
    const maximumImage = png([pngChunk("tEXt", Buffer.alloc(maximumImageBytes - png().length - 12))]);
    assert.equal(maximumImage.length, maximumImageBytes);
    const maximumReserved = await reserve(product, token, sessionB, "maximum.png", "image/png", maximumImage.length);
    assert.equal(maximumReserved.status, 201);
    const maximumUploaded = await upload(product, token, sessionB, maximumReserved.body.attachment.id, maximumImage);
    assert.equal(maximumUploaded.status, 200, JSON.stringify(maximumUploaded.body));
    const maximumExport = await api(product.base, token, `/sessions/${sessionB}/export`, { headers: { "X-RainyDays-Session": sessionB } });
    assert.equal(maximumExport.status, 200);
    assert(maximumExport.body.canvas.attachments[0].contentBase64.length > 10 * 1024 * 1024);
    const maximumImport = await api(product.base, token, "/sessions/import", { method: "POST", body: JSON.stringify(maximumExport.body) });
    assert.equal(maximumImport.status, 200, JSON.stringify(maximumImport.body));

    const pending = await reserve(product, token, sessionA, "pending.txt", "text/plain", 1024);
    assert.equal(pending.status, 201);
    const pendingId = pending.body.attachment.id;
    const partial = partialUpload(product, token, sessionA, pendingId, 1024);
    await new Promise(resolve => setTimeout(resolve, 50));
    const cancelStarted = Date.now();
    const cancelled = await api(product.base, token, `/sessions/${sessionA}/attachments/${pendingId}/cancel`, {
      method: "POST", headers: { "X-RainyDays-Session": sessionA },
    });
    assert.equal(cancelled.body.attachment.state, "cancelled");
    await Promise.race([partial.closed, new Promise((_, reject) => setTimeout(() => reject(new Error("active upload reader did not stop")), 1000))]);
    assert(Date.now() - cancelStarted < 1000);
    partial.request.destroy();
    const cancelledAgain = await api(product.base, token, `/sessions/${sessionA}/attachments/${pendingId}/cancel`, {
      method: "POST", headers: { "X-RainyDays-Session": sessionA },
    });
    assert.equal(cancelledAgain.status, 200);

    const interrupted = await reserve(product, token, sessionA, "interrupted.txt", "text/plain", 5);
    assert.equal(interrupted.status, 201);
    const interruptedId = interrupted.body.attachment.id;
    await stopProduct(product); product = null;
    product = await startProduct(fixture, provider.baseURL, token);
    const restored = await api(product.base, token, `/sessions/${sessionA}/attachments`, { headers: { "X-RainyDays-Session": sessionA } });
    assert.equal(restored.body.attachments.find(attachment => attachment.id === interruptedId).state, "failed");
    assert.equal(restored.body.attachments.find(attachment => attachment.id === interruptedId).errorCode, "UPLOAD_INTERRUPTED");
  } catch (error) {
    const logs = product?.logs() ?? { stdout: "", stderr: "" };
    throw new Error(`${error instanceof Error ? error.stack : String(error)}\nstdout=${logs.stdout}\nstderr=${logs.stderr}`, { cause: error });
  } finally {
    await stopProduct(product);
    await provider.close();
    await removeFixture(fixture);
  }
});
