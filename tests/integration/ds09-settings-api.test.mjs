import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { freePort, makeTempDir, projectRoot, removeFixture, spawnManaged, terminateProcessTreeAsync, waitFor } from "../helpers.mjs";

async function startProduct(fixture, token) {
  const workspace = path.join(fixture, "workspace");
  const department = path.join(fixture, "department");
  const output = path.join(fixture, "output");
  await Promise.all([workspace, department, output, path.join(fixture, "data")].map(directory => fs.mkdir(directory, { recursive: true })));
  const configPath = path.join(fixture, "config.json");
  try { await fs.access(configPath); }
  catch {
    await fs.writeFile(configPath, JSON.stringify({
      defaultProfile: "default",
      profiles: { default: { model: "test-model", apiKey: "provider-secret-never-public", baseURL: "https://provider.example.test", providerType: "openai-compatible" } },
      settings: { defaultPersona: "general", workspaceRoot: workspace, departmentDataRoot: department, outputDir: output },
    }));
  }
  const port = await freePort();
  const base = `http://127.0.0.1:${port}/api`;
  const child = spawnManaged(process.execPath, ["tests/fixtures/server-with-test-protector.mjs"], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      PORT: String(port), RAINYDAYS_API_TOKEN: token,
      RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data"), RAINYDAYS_CONFIG_PATH: configPath,
      RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"), RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"), RAINYDAYS_PUBLIC_DIR: path.join(projectRoot, "public"),
      WORKSPACE_ROOT: "", DEPARTMENT_DATA_ROOT: "", OUTPUT_DIR: "",
    },
  });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  await waitFor(async () => (await fetch(`${base}/status`, { headers: { "X-RainyDays-Token": token } }).catch(() => null))?.ok === true, { timeoutMs: 30_000, label: "DS-09 server" });
  return { child, base, configPath, logs: () => ({ stdout, stderr }) };
}

let shutdownId = 0;
async function stopProduct(product) {
  if (!product) return;
  const requestId = `ds09-shutdown-${++shutdownId}`;
  const settled = new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 10_000);
    const onMessage = message => {
      if (message?.requestId !== requestId) return;
      clearTimeout(timer); product.child.off("message", onMessage); resolve(true);
    };
    product.child.on("message", onMessage);
  });
  product.child.send({ type: "rt01-shutdown", requestId });
  await settled;
  await terminateProcessTreeAsync(product.child);
}

async function api(product, token, route, options = {}) {
  const response = await fetch(`${product.base}${route}`, {
    ...options,
    headers: { "X-RainyDays-Token": token, "Content-Type": "application/json", ...options.headers },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

function assertNoSecrets(value) {
  const encoded = JSON.stringify(value);
  assert.doesNotMatch(encoded, /provider-secret-never-public|asr-secret-never-public|credentialRef|apiKeyHint/u);
}

test("DS-09 Settings API migrates, validates, CAS-publishes, exports and restarts without secret disclosure", { timeout: 120_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-ds09-");
  const token = "ds09-settings-api-token";
  let product;
  try {
    product = await startProduct(fixture, token);
    const initial = await api(product, token, "/settings");
    assert.equal(initial.status, 200);
    assert.equal(initial.body.schemaVersion, 2);
    assert.deepEqual(initial.body.domainManifest.map(domain => domain.label), ["Common", "Profiles", "MCP", "Wire", "Animas", "Nous", "TTS", "ASR", "Shell", "Relay", "Update"]);
    assert.equal(initial.body.profiles[0].hasApiKey, true);
    assertNoSecrets(initial.body);
    const missingRevision = await api(product, token, "/settings/general", { method: "PUT", body: JSON.stringify({}) });
    assert.equal(missingRevision.status, 400);

    const stale = await api(product, token, "/settings/domains/tts", { method: "PUT", body: JSON.stringify({ expectedRevision: "0".repeat(64), value: initial.body.domains.tts }) });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.code, "SETTINGS_REVISION_CONFLICT");

    const ttsValue = { enabled: true, voice: "Fixture Voice", language: "en-US", rate: 1.25 };
    const saved = await api(product, token, "/settings/domains/tts", { method: "PUT", body: JSON.stringify({ expectedRevision: initial.body.revision, value: ttsValue }) });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.deepEqual(saved.body.settings.domains.tts, ttsValue);
    assert.notEqual(saved.body.settings.revision, initial.body.revision);

    const concurrentRevision = saved.body.settings.revision;
    const [mcpConcurrent, wireConcurrent] = await Promise.all([
      api(product, token, "/settings/domains/mcp", { method: "PUT", body: JSON.stringify({ expectedRevision: concurrentRevision, value: { servers: [] } }) }),
      api(product, token, "/settings/domains/wire", { method: "PUT", body: JSON.stringify({ expectedRevision: concurrentRevision, value: { sources: [] } }) }),
    ]);
    assert.deepEqual([mcpConcurrent.status, wireConcurrent.status].sort(), [200, 409]);
    const beforeProvider = (await api(product, token, "/settings")).body.revision;
    const createdProvider = await api(product, token, "/settings/providers/secondary", { method: "PUT", body: JSON.stringify({
      expectedRevision: beforeProvider, model: "secondary-model", baseURL: "https://secondary.example.test", providerType: "openai-compatible",
    }) });
    assert.equal(createdProvider.status, 200, JSON.stringify(createdProvider.body));
    const staleDelete = await api(product, token, "/settings/providers/secondary", { method: "DELETE", body: JSON.stringify({ expectedRevision: beforeProvider }) });
    assert.equal(staleDelete.status, 409);
    const deletedProvider = await api(product, token, "/settings/providers/secondary", { method: "DELETE", body: JSON.stringify({ expectedRevision: createdProvider.body.settings.revision }) });
    assert.equal(deletedProvider.status, 200, JSON.stringify(deletedProvider.body));
    const beforeInvalid = deletedProvider.body.settings.revision;
    const invalid = await api(product, token, "/settings/domains/mcp", { method: "PUT", body: JSON.stringify({ expectedRevision: beforeInvalid, value: { servers: [
      { name: "same", enabled: true, transport: "stdio", command: "one", args: [], url: "" },
      { name: "same", enabled: true, transport: "stdio", command: "two", args: [], url: "" },
    ] } }) });
    assert.equal(invalid.status, 400);
    assert.equal((await api(product, token, "/settings")).body.revision, beforeInvalid);

    const asr = await api(product, token, "/settings/domains/asr", { method: "PUT", body: JSON.stringify({ expectedRevision: beforeInvalid, value: {
      provider: "volcengine", language: "zh-CN", endpoint: "https://asr.example.test", apiKey: "asr-secret-never-public", clearCredential: false,
    } }) });
    assert.equal(asr.status, 200, JSON.stringify(asr.body));
    assert.equal(asr.body.settings.domains.credentials.asrConfigured, true);
    assertNoSecrets(asr.body);

    const exported = await api(product, token, "/settings/export");
    assert.equal(exported.status, 200);
    assertNoSecrets(exported.body);
    assert.doesNotMatch(JSON.stringify(exported.body), /"apiKey"|"accessToken"/u);

    const invalidBundle = structuredClone(exported.body);
    invalidBundle.settings.workspaceRoot = "relative-root";
    const rejectedImport = await api(product, token, "/settings/import", { method: "POST", body: JSON.stringify({ expectedRevision: asr.body.settings.revision, bundle: invalidBundle }) });
    assert.equal(rejectedImport.status, 400);
    assert.equal((await api(product, token, "/settings")).body.revision, asr.body.settings.revision);

    await stopProduct(product); product = null;
    product = await startProduct(fixture, token);
    const restarted = await api(product, token, "/settings");
    assert.deepEqual(restarted.body.domains.tts, ttsValue);
    assert.equal(restarted.body.domains.credentials.asrConfigured, true);
    assertNoSecrets(restarted.body);
    const disk = JSON.parse(await fs.readFile(product.configPath, "utf8"));
    assert.equal(disk.schemaVersion, 2);
    assert.equal(typeof disk.domains.asr.credentialRef, "string");
    assert.doesNotMatch(JSON.stringify(disk), /provider-secret-never-public|asr-secret-never-public/u);
  } finally {
    await stopProduct(product);
    await removeFixture(fixture);
  }
});

test("DS-09 startup rejects an unavailable configured default Persona", { timeout: 30_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-ds09-invalid-persona-");
  const workspace = path.join(fixture, "workspace");
  const department = path.join(fixture, "department");
  const output = path.join(fixture, "output");
  let child;
  try {
    await Promise.all([workspace, department, output, path.join(fixture, "data")].map(directory => fs.mkdir(directory, { recursive: true })));
    const configPath = path.join(fixture, "config.json");
    await fs.writeFile(configPath, JSON.stringify({
      defaultProfile: "default",
      profiles: { default: { model: "test-model", apiKey: "", baseURL: "https://provider.example.test", providerType: "openai-compatible" } },
      settings: { defaultPersona: "missing-persona", workspaceRoot: workspace, departmentDataRoot: department, outputDir: output },
    }));
    child = spawnManaged(process.execPath, ["tests/fixtures/server-with-test-protector.mjs"], {
      cwd: projectRoot,
      stdio: ["ignore", "pipe", "pipe", "ipc"],
      env: {
        ...process.env,
        PORT: String(await freePort()), RAINYDAYS_API_TOKEN: "invalid-persona-token",
        RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data"), RAINYDAYS_CONFIG_PATH: configPath,
        RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"), RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"), RAINYDAYS_PUBLIC_DIR: path.join(projectRoot, "public"),
        WORKSPACE_ROOT: "", DEPARTMENT_DATA_ROOT: "", OUTPUT_DIR: "",
      },
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr += chunk; });
    await waitFor(() => child.exitCode !== null, { timeoutMs: 15_000, label: "DS-09 invalid Persona startup rejection" });
    assert.notEqual(child.exitCode, 0);
    assert.match(stderr, /默认 Persona 不可用: missing-persona/u);
  } finally {
    if (child?.exitCode === null) await terminateProcessTreeAsync(child);
    await removeFixture(fixture);
  }
});
