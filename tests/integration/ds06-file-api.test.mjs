import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
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

async function api(base, token, route, options = {}) {
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: { "X-RainyDays-Token": token, "Content-Type": "application/json", ...options.headers },
  });
  let body;
  try { body = await response.json(); } catch { body = await response.text(); }
  return { status: response.status, body, headers: response.headers };
}

function configFor(workspaceRoot, departmentDataRoot, outputDir) {
  return {
    defaultProfile: "default",
    profiles: { default: { model: "test-model", apiKey: "", baseURL: "http://127.0.0.1:9", providerType: "openai-compatible" } },
    settings: { defaultPersona: "general", workspaceRoot, departmentDataRoot, outputDir },
  };
}

async function startServer(fixture, configPath, token) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}/api`;
  const child = spawnManaged(process.execPath, ["tests/fixtures/server-with-test-protector.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      RAINYDAYS_API_TOKEN: token,
      RAINYDAYS_USER_DATA_DIR: fixture,
      RAINYDAYS_DATA_DIR: path.join(fixture, "data"),
      RAINYDAYS_CONFIG_PATH: configPath,
      RAINYDAYS_ALLOW_LOOPBACK_HTTP_PROVIDER: "1",
      RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"),
      RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"),
      RAINYDAYS_PUBLIC_DIR: path.join(projectRoot, "public"),
      WORKSPACE_ROOT: "",
      DEPARTMENT_DATA_ROOT: "",
      OUTPUT_DIR: "",
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  await waitFor(async () => {
    const response = await fetch(`${base}/status`, { headers: { "X-RainyDays-Token": token } }).catch(() => null);
    return response?.ok === true;
  }, { timeoutMs: 30_000, label: "DS-06 server" });
  return { child, base, logs: () => ({ stdout, stderr }) };
}

async function stopServer(server) {
  const termination = await terminateProcessTreeAsync(server.child);
  assert.equal(termination.childExited, true, `DS-06 server cleanup failed\n${JSON.stringify(server.logs())}`);
}

async function waitForSse(reader, predicate, timeoutMs = 5000) {
  const decoder = new TextDecoder();
  let buffer = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const result = await Promise.race([
      reader.read(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("SSE read timeout")), remaining)),
    ]);
    if (result.done) throw new Error("SSE closed before expected event");
    buffer += decoder.decode(result.value, { stream: true });
    const frames = buffer.split("\n\n");
    buffer = frames.pop() || "";
    for (const frame of frames) {
      const line = frame.split("\n").find(value => value.startsWith("data: "));
      if (!line) continue;
      const event = JSON.parse(line.slice(6));
      if (predicate(event)) return event;
    }
  }
  throw new Error("SSE event timeout");
}

test("DS-06 HTTP File Tab saves with CAS, reports external events and serves media ranges", { timeout: 60_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-ds06-api-");
  const workspace = path.join(fixture, "workspace");
  const department = path.join(fixture, "department");
  const output = path.join(fixture, "output");
  await Promise.all([workspace, department, output].map(directory => fs.mkdir(directory)));
  const notePath = path.join(workspace, "note.md");
  const audio = Buffer.from("ID3-DS06-HTTP-AUDIO");
  await fs.writeFile(notePath, "# Initial\n");
  await fs.writeFile(path.join(workspace, "sample.mp3"), audio);
  const configPath = path.join(fixture, "config.json");
  await fs.writeFile(configPath, JSON.stringify(configFor(workspace, department, output), null, 2));
  const token = "ds06-file-api";
  let server;
  let eventsAbort;
  let reader;
  try {
    server = await startServer(fixture, configPath, token);
    const session = await api(server.base, token, "/sessions", { method: "POST", body: JSON.stringify({ title: "DS-06" }) });
    assert.equal(session.status, 200);
    const sessionId = session.body.session.id;
    const headers = { "X-RainyDays-Session": sessionId };

    const preview = await api(server.base, token, "/files/preview?root=workspace&path=note.md", { headers });
    assert.equal(preview.status, 200);
    assert.equal(preview.body.fullText, "# Initial\n");

    eventsAbort = new AbortController();
    const eventResponse = await fetch(`${server.base}/files/events?root=workspace&path=note.md&sessionId=${encodeURIComponent(sessionId)}`, {
      headers: { "X-RainyDays-Token": token }, signal: eventsAbort.signal,
    });
    assert.equal(eventResponse.status, 200);
    assert.match(eventResponse.headers.get("content-type") || "", /text\/event-stream/u);
    reader = eventResponse.body.getReader();
    await waitForSse(reader, event => event.type === "snapshot");

    const saved = await api(server.base, token, "/files/content", {
      method: "PUT", headers,
      body: JSON.stringify({ root: "workspace", path: "note.md", expectedRevision: preview.body.revision, encoding: "utf-8", text: "# Saved\n" }),
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(await fs.readFile(notePath, "utf8"), "# Saved\n");
    await waitForSse(reader, event => event.type === "file_changed");

    await fs.writeFile(notePath, "# External\n");
    const conflict = await api(server.base, token, "/files/content", {
      method: "PUT", headers,
      body: JSON.stringify({ root: "workspace", path: "note.md", expectedRevision: saved.body.revision, encoding: "utf-8", text: "# Stale editor\n" }),
    });
    assert.equal(conflict.status, 409);
    assert.equal(conflict.body.code, "FILE_EDIT_CONFLICT");
    assert.equal(await fs.readFile(notePath, "utf8"), "# External\n");

    const audioPreview = await api(server.base, token, "/files/preview?root=workspace&path=sample.mp3", { headers });
    assert.equal(audioPreview.body.kind, "audio");
    const range = await fetch(`${server.base}/files/content?root=workspace&path=sample.mp3`, {
      headers: { "X-RainyDays-Token": token, "X-RainyDays-Session": sessionId, Range: "bytes=4-7" },
    });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), `bytes 4-7/${audio.length}`);
    assert.equal(Buffer.from(await range.arrayBuffer()).toString("utf8"), "DS06");
  } finally {
    eventsAbort?.abort();
    await reader?.cancel().catch(() => undefined);
    if (server) await stopServer(server);
    await removeFixture(fixture);
  }
});
