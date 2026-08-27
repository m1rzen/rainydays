import assert from "node:assert/strict";
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

async function api(base, token, route) {
  const response = await fetch(`${base}${route}`, { headers: { "X-RainyDays-Token": token } });
  return {
    status: response.status,
    requestId: response.headers.get("x-rainydays-request-id"),
    text: await response.text(),
  };
}

function assertNoSensitiveKeys(value) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) assertNoSensitiveKeys(entry);
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    assert.equal(/api.?key|authorization|credential|password|secret|token|prompt|message/i.test(key), false, `diagnostic key is sensitive: ${key}`);
    assertNoSensitiveKeys(entry);
  }
}

test("REL-04 real API exposes correlated health probes and a bounded redacted support bundle", async () => {
  const fixture = await makeTempDir("mini-lux-rel04-");
  const port = await freePort();
  const token = "rel04-control-token-must-not-leak";
  const prompt = "rel04-user-prompt-must-not-leak";
  const base = `http://127.0.0.1:${port}/api`;
  const child = spawnManaged(process.execPath, ["tests/fixtures/server-with-test-protector.mjs"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      RAINYDAYS_API_TOKEN: token,
      RAINYDAYS_USER_DATA_DIR: fixture,
      RAINYDAYS_DATA_DIR: path.join(fixture, "data"),
      RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"),
      RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"),
      RAINYDAYS_PUBLIC_DIR: path.join(projectRoot, "public"),
      LLM_API_KEY: "",
      DEEPSEEK_API_KEY: "",
    },
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  let terminated = false;

  try {
    await waitFor(async () => {
      try { return (await api(base, token, "/health/live")).status === 200; }
      catch { return false; }
    }, { timeoutMs: 30_000, label: "REL-04 source server" }).catch(error => {
      throw new Error(`${error.message}\nstdout=${stdout}\nstderr=${stderr}`);
    });

    const live = await api(base, token, "/health/live");
    assert.equal(live.status, 200);
    assert.match(live.requestId, /^[0-9a-f-]{36}$/u);
    const liveBody = JSON.parse(live.text);
    assert.equal(liveBody.status, "live");
    assert.equal(liveBody.live, true);

    const ready = await api(base, token, "/health/ready");
    assert.equal(ready.status, 200);
    const readyBody = JSON.parse(ready.text);
    assert.equal(readyBody.ready, true);
    assert(["ready", "degraded"].includes(readyBody.status));
    if (readyBody.status === "degraded") assert(readyBody.reasons.includes("provider_unconfigured"));

    await api(base, token, "/status");
    const diagnostics = await api(base, token, "/diagnostics");
    assert.equal(diagnostics.status, 200);
    assert.match(diagnostics.requestId, /^[0-9a-f-]{36}$/u);
    assert(Buffer.byteLength(diagnostics.text, "utf8") <= 256 * 1024);
    const body = JSON.parse(diagnostics.text);
    assert.equal(body.schemaVersion, 1);
    assert.equal(body.requestId, diagnostics.requestId);
    assert.equal(body.version.buildId, body.health.buildId);
    assert.equal(body.health.ready, true);
    assert.deepEqual(Object.keys(body.metrics).sort(), ["database", "http", "llm", "pty", "tool"]);
    assert(body.metrics.http.total >= 4);
    assert(body.metrics.database.total >= 1);
    assert.deepEqual(Object.keys(body.securityAudit).sort(), ["eventCount", "headHash", "integrity", "schemaVersion"]);
    assert.equal(body.securityAudit.integrity, "verified");
    assert.equal(Object.hasOwn(body.state, "activeProfile"), false);
    assert.equal(Object.hasOwn(body.state, "activePersona"), false);
    assertNoSensitiveKeys(body);
    for (const forbidden of [token, prompt, fixture, "X-RainyDays-Token", "apiKey"]) {
      assert.equal(diagnostics.text.includes(forbidden), false, `diagnostics leaked ${forbidden}`);
    }

    const requestLogs = stdout.split(/\r?\n/u).flatMap(line => {
      try { return [JSON.parse(line)]; } catch { return []; }
    }).filter(entry => entry?.message === "request-finished");
    assert(requestLogs.length >= 4, `correlated request logs are missing\nstdout=${stdout}`);
    assert(requestLogs.every(entry => /^[0-9a-f-]{36}$/u.test(entry.correlation?.requestId ?? "")));
    assert.equal(JSON.stringify(requestLogs).includes(token), false);

    child.kill("SIGTERM");
    terminated = await waitForChildExit(child, 15_000);
    assert.equal(terminated, true, `server did not shut down cleanly\nstdout=${stdout}\nstderr=${stderr}`);
  } finally {
    if (!terminated) await terminateProcessTreeAsync(child).catch(() => undefined);
    await removeFixture(fixture);
  }
});
