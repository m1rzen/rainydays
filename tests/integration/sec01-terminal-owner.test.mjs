import assert from "node:assert/strict";
import { access, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
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
  waitForChildExit,
} from "../helpers.mjs";
import { createSec02Recorder } from "../sec02-receipts.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const terminalApiRecorder = await createSec02Recorder(import.meta.url, "SEC-01 local Terminal API is capability-gated and Session-owned");
test.after(async () => terminalApiRecorder.close());

async function api(base, token, route, options = {}) {
  const response = await fetch(`${base}${route}`, {
    ...options,
    headers: {
      "X-RainyDays-Token": token,
      "Content-Type": "application/json",
      ...options.headers,
    },
  });
  let body;
  try { body = await response.json(); }
  catch { body = await response.text(); }
  return { status: response.status, body };
}

test("SEC-01 local Terminal API is capability-gated and Session-owned", async () => {
  const fixture = await makeTempDir("mini-lux-sec01-terminal-");
  const port = await freePort();
  const token = "sec01-terminal-owner-test";
  const sensitiveInput = "echo sec06-direct-secret-must-not-persist";
  const forgedTerminalId = "term_sec06_secret_identifier";
  const base = `http://127.0.0.1:${port}/api`;
  const child = spawnManaged(process.execPath, ["tests/fixtures/server-with-test-protector.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      RAINYDAYS_API_TOKEN: token,
      RAINYDAYS_USER_DATA_DIR: fixture,
      RAINYDAYS_DATA_DIR: path.join(fixture, "data"),
      DEPARTMENT_DATA_ROOT: path.join(fixture, "department"),
      RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"),
      RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"),
      RAINYDAYS_PUBLIC_DIR: path.join(projectRoot, "public"),
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  let terminated = false;

  try {
    await waitFor(async () => {
      const response = await fetch(`${base}/status`, { headers: { "X-RainyDays-Token": token } });
      return response.ok;
    }, { timeoutMs: 30_000, label: "SEC-01 source server" }).catch(error => {
      throw new Error(`${error.message}\nstdout=${stdout}\nstderr=${stderr}`);
    });

    const defaultWorkspace = path.join(fixture, "workspace");
    const roots = await api(base, token, "/files/roots");
    assert.equal(roots.status, 400, "file roots unexpectedly bypassed the selected-Session requirement");

    const noSession = await api(base, token, "/terminals");
    assert.equal(noSession.status, 400);
    assert.match(noSession.body.error, /已选择的会话/);

    const first = await api(base, token, "/sessions", { method: "POST", body: JSON.stringify({ title: "owner A" }) });
    assert.equal(first.status, 200);
    assert.equal((await stat(defaultWorkspace)).isDirectory(), true, "first Session runtime did not enroll the default workspace below userData");
    const firstId = first.body.session.id;
    const firstApi = (route, options = {}) => api(base, token, route, {
      ...options,
      headers: { "X-RainyDays-Session": firstId, ...options.headers },
    });

    const startDenied = await firstApi("/terminals", {
      method: "POST",
      body: JSON.stringify({ name: "must-not-start", shell: "cmd", cwd: defaultWorkspace }),
    });
    assert.equal(startDenied.status, 403, "A13-01 HTTP start status drifted");
    assert.equal(startDenied.body.code, "EXEC_DIRECT_MUTATION_DENIED");
    const afterStart = await firstApi("/terminals");
    assert.equal(afterStart.status, 200);
    assert.deepEqual(afterStart.body.terminals, [], "A13-01 created a Terminal lease");

    const inputDenied = await firstApi(`/terminals/${forgedTerminalId}/input`, {
      method: "POST",
      body: JSON.stringify({ input: sensitiveInput, appendNewline: true }),
    });
    assert.equal(inputDenied.status, 403, "A13-02 HTTP input status drifted");
    assert.equal(inputDenied.body.code, "EXEC_DIRECT_MUTATION_DENIED");
    for (const [route, method] of [["clear", "POST"], ["kill", "POST"], ["close", "DELETE"]]) {
      const suffix = route === "close" ? "" : `/${route}`;
      const denied = await firstApi(`/terminals/${forgedTerminalId}${suffix}`, { method, body: "{}" });
      assert.equal(denied.status, 403, `HTTP terminal ${route} status drifted`);
      assert.equal(denied.body.code, "EXEC_DIRECT_MUTATION_DENIED");
    }

    const firstList = await firstApi("/terminals");
    assert.equal(firstList.status, 200);
    assert.deepEqual(firstList.body.terminals, [], "A13-02 created a Terminal lease or wrote stdin");

    const second = await api(base, token, "/sessions", { method: "POST", body: JSON.stringify({ title: "owner B" }) });
    assert.equal(second.status, 200);
    const secondId = second.body.session.id;
    assert.notEqual(secondId, firstId);
    const secondApi = (route, options = {}) => api(base, token, route, {
      ...options,
      headers: { "X-RainyDays-Session": secondId, ...options.headers },
    });
    const secondList = await secondApi("/terminals");
    assert.equal(secondList.status, 200);
    assert.deepEqual(secondList.body.terminals, []);

    const selected = await api(base, token, `/sessions/${firstId}/select`, { method: "POST", body: "{}" });
    assert.equal(selected.status, 200);
    const selectedList = await firstApi("/terminals");
    assert.equal(selectedList.status, 200);
    assert.deepEqual(selectedList.body.terminals, [], "authority switch resurrected a denied Terminal mutation");

    const diagnostics = await api(base, token, "/diagnostics");
    assert.equal(diagnostics.status, 200);
    assert.deepEqual(Object.keys(diagnostics.body.securityAudit).sort(), ["eventCount", "headHash", "integrity", "schemaVersion"]);
    assert.equal(diagnostics.body.securityAudit.integrity, "verified");
    assert(diagnostics.body.securityAudit.eventCount >= 32, "direct-operation audit chain is unexpectedly short");
    const diagnosticBytes = JSON.stringify(diagnostics.body);
    for (const forbidden of ["safePayload", "wrappedKey", sensitiveInput, forgedTerminalId, token]) assert.equal(diagnosticBytes.includes(forbidden), false);

    const deleted = await api(base, token, `/sessions/${firstId}`, { method: "DELETE" });
    assert.equal(deleted.status, 200);
    if (terminalApiRecorder.enabled) await terminalApiRecorder.positive("SEC02-POS-http-terminal-cwd");

    child.kill("SIGTERM");
    terminated = await waitForChildExit(child, 15_000);
    assert.equal(terminated, true, `server did not shut down cleanly\nstdout=${stdout}\nstderr=${stderr}`);
    const databasePath = path.join(fixture, "data", "mini-lux.db");
    const auditStorageBytes = Buffer.concat(await Promise.all([databasePath, `${databasePath}-wal`, `${databasePath}-shm`].map(async candidate => {
      try { return await readFile(candidate); }
      catch (error) { if (error.code === "ENOENT") return Buffer.alloc(0); throw error; }
    })));
    for (const forbidden of [sensitiveInput, forgedTerminalId, token]) {
      assert.equal(auditStorageBytes.includes(Buffer.from(forbidden, "utf8")), false, `audit database leaked ${forbidden}`);
    }
    const database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const rows = database.prepare("SELECT request_id,phase,operation_name,outcome,safe_payload FROM security_audit_events ORDER BY sequence").all();
      const byRequest = new Map();
      for (const row of rows) {
        const group = byRequest.get(row.request_id) ?? [];
        group.push(row);
        byRequest.set(row.request_id, group);
        const payload = JSON.parse(row.safe_payload);
        assert.equal(JSON.stringify(payload).includes(sensitiveInput), false);
        assert.equal(JSON.stringify(payload).includes(forgedTerminalId), false);
      }
      for (const events of byRequest.values()) assert.deepEqual(events.map(event => event.phase), ["request", "authorization", "execution", "result"]);
      for (const operation of ["terminal:start", "terminal:input", "terminal:clear", "terminal:kill", "terminal:close"]) {
        const denied = [...byRequest.values()].filter(events => events[0].operation_name === operation && events[1].outcome === "denied");
        assert(denied.length >= 1, `${operation} deny chain is absent`);
        assert(denied.every(events => events[2].outcome === "not_started" && events[3].outcome === "denied"));
      }
      const successfulLists = [...byRequest.values()].filter(events => events[0].operation_name === "terminal:list" && events[3].outcome === "success");
      assert(successfulLists.length >= 1, "terminal:list success chain is absent");
      assert(successfulLists.every(events => events[2].outcome === "started"));
    } finally {
      database.close();
    }
  } finally {
    if (!terminated) {
      const termination = await terminateProcessTreeAsync(child);
      assert.equal(termination.childExited, true, `server cleanup failed\nstdout=${stdout}\nstderr=${stderr}`);
    }
    await removeFixture(fixture);
  }
});

test("SEC-01 shutdown gate prevents runtime publication during asynchronous cleanup", async () => {
  const fixture = await makeTempDir("mini-lux-sec01-shutdown-");
  const signalPath = path.join(fixture, "shutdown.signal");
  const startedPath = `${signalPath}.started`;
  const port = await freePort();
  const token = "sec01-shutdown-gate-test";
  const base = `http://127.0.0.1:${port}/api`;
  const child = spawnManaged(process.execPath, ["tests/fixtures/sec01-shutdown-server.mjs", signalPath], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      RAINYDAYS_API_TOKEN: token,
      RAINYDAYS_USER_DATA_DIR: fixture,
      RAINYDAYS_DATA_DIR: path.join(fixture, "data"),
      DEPARTMENT_DATA_ROOT: path.join(fixture, "department"),
      RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"),
      RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"),
      RAINYDAYS_PUBLIC_DIR: path.join(projectRoot, "public"),
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });

  try {
    await waitFor(async () => {
      const response = await fetch(`${base}/status`, { headers: { "X-RainyDays-Token": token } });
      return response.ok;
    }, { timeoutMs: 30_000, label: "SEC-01 shutdown server" }).catch(error => {
      throw new Error(`${error.message}\nstdout=${stdout}\nstderr=${stderr}`);
    });

    const defaultWorkspace = path.join(fixture, "workspace");
    const session = await api(base, token, "/sessions", { method: "POST", body: JSON.stringify({ title: "shutdown owner" }) });
    assert.equal(session.status, 200);
    assert.equal((await stat(defaultWorkspace)).isDirectory(), true, "shutdown fixture Session runtime did not enroll the default workspace");
    const denied = await api(base, token, "/terminals", {
      headers: { "X-RainyDays-Session": session.body.session.id },
      method: "POST",
      body: JSON.stringify({ name: "shutdown-probe", shell: "cmd", cwd: defaultWorkspace }),
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.code, "EXEC_DIRECT_MUTATION_DENIED");

    await writeFile(signalPath, "shutdown\n", "utf8");
    await waitFor(async () => {
      try { await access(startedPath); return true; }
      catch { return false; }
    }, { timeoutMs: 5_000, intervalMs: 10, label: "shutdown gate publication" });

    let postShutdownStatus = 0;
    try {
      postShutdownStatus = (await api(base, token, "/sessions", {
        method: "POST",
        body: JSON.stringify({ title: "must not publish" }),
      })).status;
    } catch {
      postShutdownStatus = 0;
    }
    assert.notEqual(postShutdownStatus, 200, "shutdown gate allowed a new runtime publication");
    assert.equal(await waitForChildExit(child, 20_000), true, `graceful shutdown did not finish\nstdout=${stdout}\nstderr=${stderr}`);
    assert.equal(child.exitCode, 0, `graceful shutdown failed\nstdout=${stdout}\nstderr=${stderr}`);
  } finally {
    const termination = await terminateProcessTreeAsync(child);
    assert.equal(termination.childExited, true, `shutdown server cleanup failed\nstdout=${stdout}\nstderr=${stderr}`);
    await removeFixture(fixture);
  }
});
