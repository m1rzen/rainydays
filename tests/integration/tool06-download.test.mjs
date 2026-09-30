import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { NEVER_ABORT_SIGNAL } from "../../dist/run-cancellation.js";

const projectRoot = path.resolve(import.meta.dirname, "..", "..");

async function createServer() {
  const block = Buffer.alloc(64 * 1024, 0x5a);
  const resumeTotal = 4 * 1024 * 1024;
  const ignoreTotal = 3 * 1024 * 1024;
  const requests = { resume: 0, ignore: 0, complete: 0, restart: 0, restartRange: null, ifRange: null };
  const writeBytes = async (response, total, byte = block) => {
    let written = 0;
    while (written < total) {
      const chunk = byte.subarray(0, Math.min(byte.length, total - written));
      if (!response.write(chunk)) await once(response, "drain");
      written += chunk.length;
    }
    response.end();
  };
  const server = http.createServer(async (request, response) => {
    try {
      if (request.url === "/large") {
        const total = 48 * 1024 * 1024;
        response.writeHead(200, { "Content-Length": total, ETag: '"large-v1"', "Content-Disposition": "attachment; filename=large.bin" });
        await writeBytes(response, total);
        return;
      }
      if (request.url === "/resume") {
        requests.resume += 1;
        const range = request.headers.range;
        if (!range) {
          response.writeHead(200, { "Content-Length": resumeTotal, ETag: '"resume-v1"' });
          response.flushHeaders();
          response.write(block);
          response.write(block);
          await new Promise(resolve => setTimeout(resolve, 50));
          response.socket?.destroy();
          return;
        }
        const offset = Number(/^bytes=(\d+)-$/u.exec(range)?.[1]);
        requests.ifRange = request.headers["if-range"] ?? null;
        response.writeHead(206, {
          "Content-Length": resumeTotal - offset,
          "Content-Range": `bytes ${offset}-${resumeTotal - 1}/${resumeTotal}`,
          ETag: '"resume-v1"',
        });
        await writeBytes(response, resumeTotal - offset);
        return;
      }
      if (request.url === "/restart-no-checksum") {
        requests.restart += 1;
        const total = 512 * 1024;
        if (requests.restart === 1) {
          response.writeHead(200, { "Content-Length": total, ETag: '"restart-v1"' });
          response.flushHeaders();
          response.write(Buffer.alloc(128 * 1024, 0x52));
          await new Promise(resolve => setTimeout(resolve, 50));
          response.socket?.destroy();
          return;
        }
        requests.restartRange = request.headers.range ?? null;
        response.writeHead(200, { "Content-Length": total, ETag: '"restart-v1"' });
        await writeBytes(response, total, Buffer.alloc(64 * 1024, 0x52));
        return;
      }
      if (request.url === "/already-complete") {
        requests.complete += 1;
        const total = 256 * 1024;
        if (requests.complete === 1) {
          response.writeHead(200, { ETag: '"complete-v1"' });
          response.flushHeaders();
          response.write(Buffer.alloc(total, 0x43));
          await new Promise(resolve => setTimeout(resolve, 50));
          response.socket?.destroy();
          return;
        }
        const offset = Number(/^bytes=(\d+)-$/u.exec(request.headers.range ?? "")?.[1]);
        response.writeHead(416, { "Content-Range": `bytes */${offset}`, ETag: '"complete-v1"' });
        response.end("range error body");
        return;
      }
      if (request.url === "/ignore-range") {
        requests.ignore += 1;
        if (requests.ignore === 1) {
          response.writeHead(200, { "Content-Length": ignoreTotal, ETag: '"ignore-v1"' });
          response.flushHeaders();
          response.write(Buffer.alloc(128 * 1024, 0x49));
          await new Promise(resolve => setTimeout(resolve, 50));
          response.socket?.destroy();
          return;
        }
        response.writeHead(200, { "Content-Length": ignoreTotal, ETag: '"ignore-v2"' });
        await writeBytes(response, ignoreTotal, Buffer.alloc(64 * 1024, 0x49));
        return;
      }
      if (request.url === "/slow") {
        const total = 8 * 1024 * 1024;
        response.writeHead(200, { "Content-Length": total, ETag: '"slow-v1"' });
        let written = 0;
        const timer = setInterval(() => {
          if (response.destroyed || written >= total) {
            clearInterval(timer);
            if (!response.destroyed) response.end();
            return;
          }
          response.write(block);
          written += block.length;
        }, 15);
        timer.unref?.();
        response.on("close", () => clearInterval(timer));
        return;
      }
      if (request.url === "/idle") {
        response.writeHead(200, { "Content-Length": 1024, ETag: '"idle-v1"' });
        response.flushHeaders();
        const timer = setTimeout(() => { if (!response.destroyed) response.end(); }, 10_000);
        timer.unref?.();
        response.on("close", () => clearTimeout(timer));
        return;
      }
      if (request.url === "/checksum") {
        const bytes = Buffer.from("checksum-content");
        response.writeHead(200, { "Content-Length": bytes.length, ETag: '"checksum-v1"' });
        response.end(bytes);
        return;
      }
      if (request.url === "/safe-name") {
        const bytes = Buffer.from("safe-name");
        response.writeHead(200, { "Content-Length": bytes.length, "Content-Disposition": "attachment; filename=CON" });
        response.end(bytes);
        return;
      }
      response.writeHead(404).end();
    } catch {
      response.destroy();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert(address && typeof address === "object");
  return {
    base: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise(resolve => {
      server.close(resolve);
      server.closeAllConnections?.();
    }),
  };
}

async function createRuntime() {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-tool06-runtime-"));
  const workspace = path.join(temp, "workspace");
  const output = path.join(temp, "output");
  const data = path.join(temp, "data");
  await Promise.all([workspace, output, data].map(directory => fs.mkdir(directory, { recursive: true })));
  const prior = new Map([
    ["RAINYDAYS_USER_DATA_DIR", process.env.RAINYDAYS_USER_DATA_DIR],
    ["RAINYDAYS_DATA_DIR", process.env.RAINYDAYS_DATA_DIR],
  ]);
  process.env.RAINYDAYS_USER_DATA_DIR = temp;
  process.env.RAINYDAYS_DATA_DIR = data;
  const [personaModule, sessionModule, dbModule, toolsModule, pathRuntimeModule, downloadModule] = await Promise.all([
    import("../../dist/persona.js"),
    import("../../dist/session.js"),
    import("../../dist/db.js"),
    import("../../dist/tools/index.js"),
    import("../../dist/path-runtime.js"),
    import("../../dist/tools/download-tool.js"),
  ]);
  const toolNames = ["download", "download_status", "download_wait", "download_cancel"];
  const persona = personaModule.createEffectivePersona({
    name: "tool06-download",
    displayName: "TOOL06 Download",
    description: "streaming download integration",
    tools: toolNames,
    env: { OUTPUT_DIR: output },
    allowedRoots: [output],
    networkPolicy: { mode: "unrestricted" },
    systemPrompt: "TOOL-06 integration",
  });
  const pathAuthority = await pathRuntimeModule.pathPolicy.createAuthority([{
    rootId: "output",
    role: "output",
    configuredPath: output,
    permissions: ["read-file", "create-file"],
  }]);
  const authority = toolsModule.capabilityBroker.createRuntimeAuthority({
    name: persona.name,
    tools: persona.tools,
    env: persona.env,
    systemPrompt: persona.systemPrompt,
    allowedRoots: persona.allowedRoots,
    rootEnv: { OUTPUT_DIR: "output" },
    pathAuthority,
    networkPolicy: persona.networkPolicy,
    digest: persona.digest,
  });
  const session = sessionModule.createSession(persona, "TOOL-06 download");
  const root = toolsModule.capabilityBroker.beginAgentRun(authority, session.id);
  async function approved(name, args) {
    const inspected = toolsModule.inspectToolCall(root, name, args);
    const challenge = toolsModule.capabilityBroker.createApprovalChallenge(root, inspected);
    const grant = toolsModule.capabilityBroker.resolveApprovalChallenge({
      challengeId: challenge.challengeId,
      choice: "approve",
      sessionId: root.sessionId,
      runId: root.runId,
      responsePrincipal: "local-user-api",
      responseChannel: "ask-user",
    });
    assert(grant);
    try { return await toolsModule.executeInspectedTool(grant, inspected); }
    finally { toolsModule.capabilityBroker.finishContext(grant); }
  }
  let retired = false;
  const retire = async () => {
    if (retired) return;
    retired = true;
    if (toolsModule.capabilityBroker.isContextActive(root)) toolsModule.capabilityBroker.finishContext(root);
    await toolsModule.capabilityBroker.retireAuthority(authority);
  };
  return {
    output,
    approved,
    execute: (name, args) => toolsModule.executeTool(root, name, args, null, null, NEVER_ABORT_SIGNAL),
    clearSettled: downloadModule.clearSettledDownloadTasks,
    retire,
    close: async () => {
      await retire();
      dbModule.closeDb();
      for (const [key, value] of prior) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

function parsed(value) { return JSON.parse(value); }

async function waitState(runtime, id, timeoutMs = 30_000) {
  return parsed(await runtime.execute("download_wait", { task_id: id, timeout_ms: timeoutMs }));
}

async function closeResources(runtime, server) {
  const results = await Promise.allSettled([runtime.close(), server.close()]);
  const failures = results.filter(result => result.status === "rejected").map(result => result.reason);
  if (failures.length) throw new AggregateError(failures, "TOOL-06 integration cleanup failed");
}

let runtime;
let server;
test.before(async () => {
  server = await createServer();
  runtime = await createRuntime();
});
test.after(async () => closeResources(runtime, server));

test("TOOL-06 streams a large file with bounded ArrayBuffer growth", { timeout: 120_000 }, async () => {
  let monitor;
  try {
    const baseline = process.memoryUsage().arrayBuffers;
    let peak = baseline;
    monitor = setInterval(() => { peak = Math.max(peak, process.memoryUsage().arrayBuffers); }, 5);
    const started = parsed(await runtime.approved("download", { url: `${server.base}/large`, max_bytes: 64 * 1024 * 1024 }));
    assert.equal(started.state, "running");
    const completed = await waitState(runtime, started.taskId, 90_000);
    clearInterval(monitor); monitor = null;
    assert.equal(completed.state, "completed");
    assert.equal(completed.bytesDownloaded, 48 * 1024 * 1024);
    assert.equal((await fs.stat(path.join(runtime.output, "large.bin"))).size, 48 * 1024 * 1024);
    assert(peak - baseline < 40 * 1024 * 1024, `ArrayBuffer growth was ${peak - baseline}`);
  } finally {
    if (monitor) clearInterval(monitor);
  }
});

test("TOOL-06 persists interrupted state, resumes with Range and validates If-Range", { timeout: 90_000 }, async () => {
  const expectedSha256 = createHash("sha256").update(Buffer.alloc(4 * 1024 * 1024, 0x5a)).digest("hex");
  const started = parsed(await runtime.approved("download", {
    url: `${server.base}/resume`,
    filename: "resume.bin",
    sha256: expectedSha256,
  }));
  const interrupted = await waitState(runtime, started.taskId);
  assert.equal(interrupted.state, "interrupted");
  assert(interrupted.bytesDownloaded > 0);
  assert(runtime.clearSettled() >= 1);
  const restarted = parsed(await runtime.execute("download_status", { task_id: started.taskId }));
  assert.equal(restarted.state, "interrupted");
  assert.equal(restarted.errorCode, "PROCESS_RESTARTED");
  const resumed = parsed(await runtime.approved("download", {
    resume_task_id: started.taskId,
    url: `${server.base}/resume`,
  }));
  assert.equal(resumed.taskId, started.taskId);
  const completed = await waitState(runtime, started.taskId);
  assert.equal(completed.state, "completed");
  assert.equal(completed.bytesDownloaded, 4 * 1024 * 1024);
  assert.equal(server.requests.ifRange, '"resume-v1"');
  assert.equal((await fs.stat(path.join(runtime.output, "resume.bin"))).size, 4 * 1024 * 1024);
});

test("TOOL-06 safely restarts from zero after registry loss when no final checksum is available", { timeout: 30_000 }, async () => {
  const started = parsed(await runtime.approved("download", {
    url: `${server.base}/restart-no-checksum`,
    filename: "restart-no-checksum.bin",
  }));
  assert.equal((await waitState(runtime, started.taskId)).state, "interrupted");
  assert(runtime.clearSettled() >= 1);
  await runtime.approved("download", {
    resume_task_id: started.taskId,
    url: `${server.base}/restart-no-checksum`,
  });
  const completed = await waitState(runtime, started.taskId);
  assert.equal(completed.state, "completed");
  assert.equal(server.requests.restartRange, null);
  const bytes = await fs.readFile(path.join(runtime.output, "restart-no-checksum.bin"));
  assert.equal(bytes.length, 512 * 1024);
  assert(bytes.every(byte => byte === 0x52));
});

test("TOOL-06 treats a matching 416 range as complete without appending its error body", { timeout: 30_000 }, async () => {
  const started = parsed(await runtime.approved("download", {
    url: `${server.base}/already-complete`,
    filename: "already-complete.bin",
  }));
  const interrupted = await waitState(runtime, started.taskId);
  assert.equal(interrupted.state, "interrupted");
  await runtime.approved("download", { resume_task_id: started.taskId });
  const completed = await waitState(runtime, started.taskId);
  assert.equal(completed.state, "completed");
  const bytes = await fs.readFile(path.join(runtime.output, "already-complete.bin"));
  assert.equal(bytes.length, interrupted.bytesDownloaded);
  assert(bytes.every(byte => byte === 0x43));
});

test("TOOL-06 resets a partial when a server ignores Range", { timeout: 90_000 }, async () => {
  const started = parsed(await runtime.approved("download", { url: `${server.base}/ignore-range`, filename: "ignore.bin" }));
  assert.equal((await waitState(runtime, started.taskId)).state, "interrupted");
  await runtime.approved("download", { resume_task_id: started.taskId });
  const completed = await waitState(runtime, started.taskId);
  assert.equal(completed.state, "completed");
  const bytes = await fs.readFile(path.join(runtime.output, "ignore.bin"));
  assert.equal(bytes.length, 3 * 1024 * 1024);
  assert(bytes.every(byte => byte === 0x49));
});

test("TOOL-06 converts a bounded no-progress timeout into resumable interrupted state", { timeout: 30_000 }, async () => {
  const started = parsed(await runtime.approved("download", {
    url: `${server.base}/idle`,
    filename: "idle.bin",
    idle_timeout_ms: 100,
  }));
  const interrupted = await waitState(runtime, started.taskId, 10_000);
  assert.equal(interrupted.state, "interrupted");
  assert.equal(interrupted.errorCode, "IDLE_TIMEOUT");
  await assert.rejects(() => fs.access(path.join(runtime.output, "idle.bin")));
  const cancelled = parsed(await runtime.execute("download_cancel", { task_id: started.taskId }));
  assert.equal(cancelled.state, "cancelled");
});

test("TOOL-06 cancellation removes partial bytes and checksum failure never publishes success", { timeout: 90_000 }, async () => {
  const slow = parsed(await runtime.approved("download", { url: `${server.base}/slow`, filename: "slow.bin" }));
  const timedWait = parsed(await runtime.execute("download_wait", { task_id: slow.taskId, timeout_ms: 1 }));
  assert.equal(timedWait.state, "running");
  let status;
  const deadline = Date.now() + 10_000;
  do {
    status = parsed(await runtime.execute("download_status", { task_id: slow.taskId }));
    if (status.bytesDownloaded > 0) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  } while (Date.now() < deadline);
  assert(status.bytesDownloaded > 0);
  const cancelled = parsed(await runtime.execute("download_cancel", { task_id: slow.taskId }));
  assert.equal(cancelled.state, "cancelled");
  await assert.rejects(() => fs.access(path.join(runtime.output, "slow.bin")));
  const partials = (await fs.readdir(runtime.output)).filter(name => name.endsWith(".part"));
  assert.deepEqual(partials, []);

  const checksum = parsed(await runtime.approved("download", {
    url: `${server.base}/checksum`,
    filename: "checksum.bin",
    sha256: "0".repeat(64),
  }));
  const failed = await waitState(runtime, checksum.taskId);
  assert.equal(failed.state, "failed");
  assert.equal(failed.errorCode, "VALIDATION_FAILED");
  await assert.rejects(() => fs.access(path.join(runtime.output, "checksum.bin")));
});

test("TOOL-06 sanitizes Content-Disposition device names before reservation", async () => {
  const started = parsed(await runtime.approved("download", { url: `${server.base}/safe-name` }));
  const completed = await waitState(runtime, started.taskId);
  assert.equal(completed.state, "completed");
  assert.equal(completed.filename, "download.bin");
  assert.equal(await fs.readFile(path.join(runtime.output, "download.bin"), "utf8"), "safe-name");
});

test("TOOL-06 authority retirement aborts detached transport and removes unpublished partials", { timeout: 30_000 }, async () => {
  const started = parsed(await runtime.approved("download", { url: `${server.base}/slow`, filename: "retired.bin" }));
  const deadline = Date.now() + 10_000;
  let status = started;
  while (Date.now() < deadline && status.bytesDownloaded === 0) {
    status = parsed(await runtime.execute("download_status", { task_id: started.taskId }));
    if (status.bytesDownloaded > 0) break;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert(status.bytesDownloaded > 0);
  await runtime.retire();
  await assert.rejects(() => fs.access(path.join(runtime.output, "retired.bin")));
  assert.equal((await fs.readdir(runtime.output)).some(name => name.endsWith(".part")), false);
});
