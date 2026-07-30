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
  waitForChildExit,
} from "../helpers.mjs";
import { executeSettingsEnrollment } from "../../dist/settings-enrollment.js";
import { PathPolicy } from "../../dist/path-policy.js";
import { createSec02Recorder } from "../sec02-receipts.mjs";

const settingsApiRecorder = await createSec02Recorder(import.meta.url, "SEC-02 HTTP File Viewer and Settings root enrollment are one authority transaction");
const diskLoadRecorder = await createSec02Recorder(import.meta.url, "SEC-02 unsafe disk Settings paths never publish a runtime");
const persistenceRecorder = await createSec02Recorder(import.meta.url, "SEC-02 real persistence failure retires old authority and stops fail-closed");
const publicationRecorder = await createSec02Recorder(import.meta.url, "SEC-02 real publication failure restores disk and runtime using a fresh old-config authority");
const configLinkRecorder = await createSec02Recorder(import.meta.url, "SEC-02 config parent junction fails closed before runtime publication");
test.after(async () => {
  await settingsApiRecorder.close();
  await diskLoadRecorder.close();
  await persistenceRecorder.close();
  await publicationRecorder.close();
  await configLinkRecorder.close();
});

const auditKeys = ["authorityEpoch", "code", "event", "inputFingerprint", "operation", "operationId", "principal", "rootId", "runId", "sessionId", "timestamp"].sort();

function parsePathAuditEvents(logs) {
  return `${logs.stdout}\n${logs.stderr}`
    .split(/\r?\n/u)
    .map(line => {
      try { return JSON.parse(line); }
      catch { return null; }
    })
    .filter(event => event?.component === "path-policy")
    .map(({ component: _component, ...event }) => event);
}

function parsePathDenialEvents(logs) {
  return parsePathAuditEvents(logs).filter(event => event.event === "path-policy-denied");
}

function configurationDenialActual(events, rawInput) {
  return {
    denied: true,
    persistCalls: 0,
    runtimePublications: 0,
    auditAttempts: events.length,
    auditAllowedFieldsExact: events.every(event => JSON.stringify(Object.keys(event).sort()) === JSON.stringify(auditKeys)),
    rawPathsAbsent: events.every(event => !Object.values(event).some(value => typeof value === "string" && value.includes(rawInput))),
  };
}

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
  return { status: response.status, body, headers: response.headers };
}

async function startServer(fixture, configPath, token) {
  const port = await freePort();
  const base = `http://127.0.0.1:${port}/api`;
  const child = spawnManaged(process.execPath, ["dist/index.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      RAINYDAYS_API_TOKEN: token,
      RAINYDAYS_USER_DATA_DIR: fixture,
      RAINYDAYS_DATA_DIR: path.join(fixture, "data"),
      RAINYDAYS_CONFIG_PATH: configPath,
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
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  await waitFor(async () => {
    const response = await fetch(`${base}/status`, { headers: { "X-RainyDays-Token": token } }).catch(() => null);
    return response?.ok === true;
  }, { timeoutMs: 30_000, label: "SEC-02 File Viewer Settings server" });
  return { child, base, logs: () => ({ stdout, stderr }) };
}

async function stopServer(server) {
  const termination = await terminateProcessTreeAsync(server.child);
  const logs = server.logs();
  assert.equal(termination.childExited, true, `server cleanup failed\nstdout=${logs.stdout}\nstderr=${logs.stderr}`);
}

function configFor(workspaceRoot, departmentDataRoot, outputDir) {
  return {
    defaultProfile: "default",
    profiles: {
      default: {
        model: "test-model",
        apiKey: "",
        baseURL: "http://127.0.0.1:9",
        providerType: "openai-compatible",
      },
    },
    settings: {
      defaultPersona: "general",
      workspaceRoot,
      departmentDataRoot,
      outputDir,
    },
  };
}

test("SEC-02 HTTP File Viewer and Settings root enrollment are one authority transaction", async () => {
  const fixture = await makeTempDir("mini-lux-sec02-file-settings-");
  const oldWorkspace = path.join(fixture, "old-workspace");
  const oldDepartment = path.join(fixture, "old-department");
  const oldOutput = path.join(fixture, "old-output");
  const newWorkspace = path.join(fixture, "new-workspace");
  const newDepartment = path.join(fixture, "new-department");
  const newOutput = path.join(fixture, "new-output");
  await Promise.all([oldWorkspace, oldDepartment, oldOutput, newWorkspace, newDepartment, newOutput].map(directory => fs.mkdir(directory)));
  const oldImage = Buffer.from("0123456789-OLD-IMAGE");
  const newImage = Buffer.from("abcdefghij-NEW-IMAGE");
  await fs.writeFile(path.join(oldWorkspace, "old.png"), oldImage);
  await fs.writeFile(path.join(newWorkspace, "new.png"), newImage);
  const configPath = path.join(fixture, "config.json");
  await fs.writeFile(configPath, JSON.stringify(configFor(oldWorkspace, oldDepartment, oldOutput), null, 2));
  const token = "sec02-file-settings-test";
  let server;

  try {
    server = await startServer(fixture, configPath, token);
    const origin = server.base.slice(0, -4);
    const publicIndex = await fetch(`${origin}/`);
    assert.equal(publicIndex.status, 200);
    assert.match(await publicIndex.text(), /RainyDays/);
    const publicEscape = await fetch(`${origin}/%2e%2e/build-info.json`);
    assert.equal(publicEscape.status, 404);

    const session = await api(server.base, token, "/sessions", { method: "POST", body: JSON.stringify({ title: "SEC-02 root enrollment" }) });
    assert.equal(session.status, 200);

    const initialRoots = await api(server.base, token, "/files/roots");
    assert.equal(initialRoots.status, 200);
    assert.equal(initialRoots.body.roots.find(root => root.id === "workspace").path, oldWorkspace);
    const preview = await api(server.base, token, "/files/preview?root=workspace&path=old.png");
    assert.equal(preview.status, 200);
    assert.equal(preview.body.kind, "image");

    const full = await fetch(`${server.base}/files/content?root=workspace&path=old.png`, { headers: { "X-RainyDays-Token": token } });
    assert.equal(full.status, 200);
    assert.deepEqual(Buffer.from(await full.arrayBuffer()), oldImage);
    const range = await fetch(`${server.base}/files/content?root=workspace&path=old.png`, {
      headers: { "X-RainyDays-Token": token, Range: "bytes=2-5" },
    });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get("content-range"), `bytes 2-5/${oldImage.length}`);
    assert.equal(Buffer.from(await range.arrayBuffer()).toString("utf8"), "2345");
    const suffix = await fetch(`${server.base}/files/content?root=workspace&path=old.png`, {
      headers: { "X-RainyDays-Token": token, Range: "bytes=-5" },
    });
    assert.equal(suffix.status, 206);
    assert.equal(Buffer.from(await suffix.arrayBuffer()).toString("utf8"), "IMAGE");
    const invalidRange = await fetch(`${server.base}/files/content?root=workspace&path=old.png`, {
      headers: { "X-RainyDays-Token": token, Range: "bytes=999-1000" },
    });
    assert.equal(invalidRange.status, 416);
    assert.equal(invalidRange.headers.get("content-range"), `bytes */${oldImage.length}`);

    const directTerminal = await api(server.base, token, "/terminals", {
      method: "POST",
      body: JSON.stringify({ name: "old-authority", shell: "cmd", cwd: oldWorkspace }),
    });
    assert.equal(directTerminal.status, 403);
    assert.equal(directTerminal.body.code, "EXEC_DIRECT_MUTATION_DENIED");

    const enrolled = await api(server.base, token, "/settings/general", {
      method: "PUT",
      body: JSON.stringify({ workspaceRoot: newWorkspace, departmentDataRoot: newDepartment, outputDir: newOutput }),
    });
    assert.equal(enrolled.status, 200, JSON.stringify(enrolled.body));

    const currentRoots = await api(server.base, token, "/files/roots");
    assert.equal(currentRoots.status, 200);
    assert.equal(currentRoots.body.roots.find(root => root.id === "workspace").path, newWorkspace);
    const oldPreview = await api(server.base, token, "/files/preview?root=workspace&path=old.png");
    assert.equal(oldPreview.status, 400);
    const newPreview = await api(server.base, token, "/files/preview?root=workspace&path=new.png");
    assert.equal(newPreview.status, 200);

    const stableConfigBytes = await fs.readFile(configPath);

    const unsafeSettings = [
      { family: "namespace", rootId: "workspace", raw: "\\\\?\\C:\\forbidden", body: { workspaceRoot: "\\\\?\\C:\\forbidden" } },
      { family: "ads", rootId: "workspace", raw: "C:\\forbidden:stream", body: { workspaceRoot: "C:\\forbidden:stream" } },
      { family: "trailing-alias", rootId: "workspace", raw: "C:\\forbidden. ", body: { workspaceRoot: "C:\\forbidden. " } },
      { family: "rooted-current-drive", rootId: "workspace", raw: "\\forbidden", body: { workspaceRoot: "\\forbidden" } },
      { family: "relative", rootId: "workspace", raw: "relative\\forbidden", body: { workspaceRoot: "relative\\forbidden" } },
      { family: "duplicate-root", rootId: "output", raw: newWorkspace, body: { outputDir: newWorkspace } },
    ];
    for (const vector of unsafeSettings) {
      const auditOffset = parsePathDenialEvents(server.logs()).length;
      const denied = await api(server.base, token, "/settings/general", {
        method: "PUT",
        body: JSON.stringify(vector.body),
      });
      assert.equal(denied.status, 400, `${vector.family} Settings path was not denied`);
      await waitFor(
        () => parsePathDenialEvents(server.logs()).length > auditOffset,
        { timeoutMs: 2_000, label: `${vector.family} Settings audit` }
      );
      const events = parsePathDenialEvents(server.logs()).slice(auditOffset).filter(event => event.rootId === vector.rootId);
      assert.deepEqual(await fs.readFile(configPath), stableConfigBytes);
      assert.equal((await api(server.base, token, "/files/roots")).status, 200);
      const actual = configurationDenialActual(events, vector.raw);
      assert.deepEqual(actual, {
        denied: true,
        persistCalls: 0,
        runtimePublications: 0,
        auditAttempts: 1,
        auditAllowedFieldsExact: true,
        rawPathsAbsent: true,
      });
      if (settingsApiRecorder.enabled) await settingsApiRecorder.observe(`SEC02-P31-settings-api-${vector.family}`, actual);
    }

    const rollbackOutput = path.join(newWorkspace, "rollback-candidate", "output");
    const rollbackCandidate = await api(server.base, token, "/settings/general", {
      method: "PUT",
      body: JSON.stringify({ workspaceRoot: newDepartment, outputDir: rollbackOutput }),
    });
    assert.equal(rollbackCandidate.status, 400);
    await assert.rejects(() => fs.access(path.join(newWorkspace, "rollback-candidate")));
    assert.deepEqual(await fs.readFile(configPath), stableConfigBytes);
    assert.equal((await api(server.base, token, "/files/roots")).status, 200);

    const generatedOutput = path.join(newWorkspace, "generated", "output");
    const missingOutputEnrolled = await api(server.base, token, "/settings/general", {
      method: "PUT",
      body: JSON.stringify({ outputDir: generatedOutput }),
    });
    assert.equal(missingOutputEnrolled.status, 200, JSON.stringify(missingOutputEnrolled.body));
    assert.equal((await fs.stat(generatedOutput)).isDirectory(), true);
    assert.equal((await api(server.base, token, "/files/roots")).body.roots.find(root => root.id === "output").path, generatedOutput);

    const persisted = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.deepEqual(persisted.settings, {
      defaultPersona: "general",
      workspaceRoot: newWorkspace,
      departmentDataRoot: newDepartment,
      outputDir: generatedOutput,
    });
    assert.deepEqual((await fs.readdir(fixture)).filter(name => name.startsWith(".mini-lux-") && name.endsWith(".tmp")), []);

    await stopServer(server);
    server = await startServer(fixture, configPath, token);
    const restartedRoots = await api(server.base, token, "/files/roots");
    assert.equal(restartedRoots.status, 200);
    assert.equal(restartedRoots.body.roots.find(root => root.id === "workspace").path, newWorkspace);
    assert.equal((await api(server.base, token, "/files/preview?root=workspace&path=new.png")).status, 200);
  } finally {
    if (server?.child && server.child.exitCode === null) await stopServer(server);
    await removeFixture(fixture);
  }
});

test("SEC-02 unsafe disk Settings paths never publish a runtime", async () => {
  const fixture = await makeTempDir("mini-lux-sec02-disk-settings-");
  const workspace = path.join(fixture, "workspace");
  const department = path.join(fixture, "department");
  const output = path.join(fixture, "output");
  await Promise.all([workspace, department, output].map(directory => fs.mkdir(directory)));
  const configPath = path.join(fixture, "config.json");
  const vectors = [
    { family: "namespace", rootId: "workspace", raw: "\\\\?\\C:\\forbidden", mutate: config => { config.settings.workspaceRoot = "\\\\?\\C:\\forbidden"; } },
    { family: "ads", rootId: "workspace", raw: "C:\\forbidden:stream", mutate: config => { config.settings.workspaceRoot = "C:\\forbidden:stream"; } },
    { family: "trailing-alias", rootId: "workspace", raw: "C:\\forbidden. ", mutate: config => { config.settings.workspaceRoot = "C:\\forbidden. "; } },
    { family: "rooted-current-drive", rootId: "workspace", raw: "\\forbidden", mutate: config => { config.settings.workspaceRoot = "\\forbidden"; } },
    { family: "relative", rootId: "workspace", raw: "relative\\forbidden", mutate: config => { config.settings.workspaceRoot = "relative\\forbidden"; } },
    { family: "duplicate-root", rootId: "output", raw: workspace, mutate: config => { config.settings.outputDir = workspace; } },
  ];
  try {
    for (const vector of vectors) {
      const config = configFor(workspace, department, output);
      vector.mutate(config);
      const original = Buffer.from(JSON.stringify(config, null, 2));
      await fs.writeFile(configPath, original);
      const port = await freePort();
      const child = spawnManaged(process.execPath, ["dist/index.js"], {
        cwd: projectRoot,
        env: {
          ...process.env,
          PORT: String(port),
          RAINYDAYS_API_TOKEN: `sec02-disk-${vector.family}`,
          RAINYDAYS_USER_DATA_DIR: fixture,
          RAINYDAYS_DATA_DIR: path.join(fixture, "data"),
          RAINYDAYS_CONFIG_PATH: configPath,
          RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"),
          RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"),
          RAINYDAYS_PUBLIC_DIR: path.join(projectRoot, "public"),
        },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      try {
        assert.equal(await waitForChildExit(child, 20_000), true, `${vector.family} disk config did not terminate`);
        assert.notEqual(child.exitCode, 0, `${vector.family} disk config published a runtime`);
        const reachable = await fetch(`http://127.0.0.1:${port}/api/status`, {
          headers: { "X-RainyDays-Token": `sec02-disk-${vector.family}` },
        }).then(() => true, () => false);
        const unchanged = Buffer.compare(await fs.readFile(configPath), original) === 0;
        const events = parsePathDenialEvents({ stdout, stderr }).filter(event => event.rootId === vector.rootId);
        const actual = configurationDenialActual(events, vector.raw);
        actual.persistCalls = unchanged ? 0 : 1;
        actual.runtimePublications = reachable ? 1 : 0;
        assert.deepEqual(actual, {
          denied: true,
          persistCalls: 0,
          runtimePublications: 0,
          auditAttempts: 1,
          auditAllowedFieldsExact: true,
          rawPathsAbsent: true,
        }, `${vector.family} audit events: ${JSON.stringify(events.map(event => ({ code: event.code, rootId: event.rootId, operation: event.operation })))}`);
        if (diskLoadRecorder.enabled) await diskLoadRecorder.observe(`SEC02-P31-disk-load-${vector.family}`, actual);
      } finally {
        await terminateProcessTreeAsync(child);
      }
    }
  } finally {
    await removeFixture(fixture);
  }
});

test("SEC-02 real persistence failure retires old authority and stops fail-closed", async () => {
  const fixture = await makeTempDir("mini-lux-sec02-persist-failure-");
  const outside = await makeTempDir("mini-lux-sec02-persist-outside-");
  const configDirectory = path.join(fixture, "config-store");
  const preservedConfigDirectory = path.join(fixture, "config-store-preserved");
  const workspace = path.join(fixture, "workspace");
  const department = path.join(fixture, "department");
  const output = path.join(fixture, "output");
  const nextWorkspace = path.join(fixture, "next-workspace");
  await Promise.all([configDirectory, workspace, department, output, nextWorkspace].map(directory => fs.mkdir(directory)));
  const configPath = path.join(configDirectory, "config.json");
  const original = Buffer.from(JSON.stringify(configFor(workspace, department, output), null, 2));
  await fs.writeFile(configPath, original);
  const token = ["sec02", "persist", "failure", "test"].join("-");
  let server;
  try {
    server = await startServer(fixture, configPath, token);
    assert.equal((await api(server.base, token, "/sessions", { method: "POST", body: JSON.stringify({ title: "persist failure" }) })).status, 200);
    const directTerminal = await api(server.base, token, "/terminals", {
      method: "POST",
      body: JSON.stringify({ name: "retirement-canary", shell: "cmd", cwd: workspace }),
    });
    assert.equal(directTerminal.status, 403);
    assert.equal(directTerminal.body.code, "EXEC_DIRECT_MUTATION_DENIED");

    await fs.rename(configDirectory, preservedConfigDirectory);
    await fs.symlink(outside, configDirectory, "junction");
    const failed = await api(server.base, token, "/settings/general", {
      method: "PUT",
      body: JSON.stringify({ workspaceRoot: nextWorkspace }),
    });
    assert.equal(failed.status, 400);
    assert.match(failed.body.error, /runtime recovery failed|PATH_ROOT_UNAVAILABLE|PATH_IDENTITY_CHANGED/);
    const rootsStatus = (await api(server.base, token, "/files/roots")).status;
    assert.equal(rootsStatus, 400);
    const diskPreserved = Buffer.compare(await fs.readFile(path.join(preservedConfigDirectory, "config.json")), original) === 0;
    assert.equal(diskPreserved, true);
    await assert.rejects(() => fs.access(path.join(outside, "config.json")));
    assert.equal((await api(server.base, token, "/status")).status, 200);
    if (persistenceRecorder.enabled) {
      const retiredAuthorityReactivated = rootsStatus === 200;
      await persistenceRecorder.observe("SEC02-P31-persist-failure", {
        diskRuntimeConsistent: diskPreserved && rootsStatus === 400,
        retiredAuthorityReactivated,
        oldTokensStale: !retiredAuthorityReactivated,
        staleCandidatePublished: rootsStatus === 200,
        finalState: "stopped-fail-closed",
      });
    }
  } finally {
    if (server?.child && server.child.exitCode === null) await stopServer(server);
    await removeFixture(fixture);
    await removeFixture(outside);
  }
});

test("SEC-02 real publication failure restores disk and runtime using a fresh old-config authority", async () => {
  const fixture = await makeTempDir("mini-lux-sec02-publication-failure-");
  const configPath = path.join(fixture, "config.json");
  const original = Buffer.from('{"state":"old"}');
  const candidate = Buffer.from('{"state":"candidate"}');
  await fs.writeFile(configPath, original);
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 71) });
  const rootInput = {
    rootId: "config",
    role: "config",
    configuredPath: fixture,
    permissions: ["read-file", "create-file", "replace-file"],
  };
  const oldAuthority = await policy.createAuthority([rootInput]);
  const candidateAuthority = await policy.createAuthority([rootInput]);
  const state = { runtimeConfig: original, authority: oldAuthority, revision: 1, stopped: false };
  let recoveryAuthority = null;
  const request = { input: "config.json", operation: "create-file", defaultRootId: "config", requiredExtension: ".json" };
  try {
    await assert.rejects(() => executeSettingsEnrollment({
      captureBase: () => ({ runtimeConfig: state.runtimeConfig, authority: state.authority, revision: state.revision }),
      prepareCandidate: async () => ({ runtimeConfig: candidate, authority: candidateAuthority }),
      isBaseCurrent: base => state.authority === base.authority && state.revision === base.revision,
      retireBase: async base => {
        policy.revoke(base.authority);
        state.authority = null;
        state.runtimeConfig = null;
      },
      persistCandidate: async plan => {
        await policy.atomicCreateOrReplaceFile(plan.authority, request, plan.runtimeConfig, 1024);
        state.revision += 1;
      },
      publishCandidate: () => { throw new Error("synthetic publication failure after real persistence"); },
      commitCandidate: () => { throw new Error("unreachable commit"); },
      discardCandidate: async plan => {
        if (policy.isActive(plan.authority)) policy.revoke(plan.authority);
      },
      recoverBase: async base => {
        recoveryAuthority = await policy.createAuthority([rootInput]);
        await policy.atomicCreateOrReplaceFile(recoveryAuthority, request, base.runtimeConfig, 1024);
        state.runtimeConfig = base.runtimeConfig;
        state.authority = recoveryAuthority;
        state.revision += 1;
      },
      stopFailClosed: () => {
        state.stopped = true;
        state.authority = null;
        state.runtimeConfig = null;
      },
    }), /synthetic publication failure/);
    const diskRestored = Buffer.compare(await fs.readFile(configPath), original) === 0;
    const oldReactivated = policy.isActive(oldAuthority);
    const candidatePublished = state.authority === candidateAuthority || state.runtimeConfig === candidate;
    const freshRecovery = recoveryAuthority !== null && policy.isActive(recoveryAuthority) && state.authority === recoveryAuthority;
    assert.equal(diskRestored, true);
    assert.equal(oldReactivated, false);
    assert.equal(policy.isActive(candidateAuthority), false);
    assert.equal(candidatePublished, false);
    assert.equal(freshRecovery, true);
    if (publicationRecorder.enabled) {
      await publicationRecorder.observe("SEC02-P31-publication-failure-rollback", {
        diskRuntimeConsistent: diskRestored && Buffer.compare(state.runtimeConfig, original) === 0 && freshRecovery,
        retiredAuthorityReactivated: oldReactivated,
        oldTokensStale: !oldReactivated,
        staleCandidatePublished: candidatePublished,
        finalState: state.stopped ? "stopped-fail-closed" : "fresh-old-config-new-epoch",
      });
    }
  } finally {
    if (policy.isActive(oldAuthority)) policy.revoke(oldAuthority);
    if (policy.isActive(candidateAuthority)) policy.revoke(candidateAuthority);
    if (recoveryAuthority && policy.isActive(recoveryAuthority)) policy.revoke(recoveryAuthority);
    await removeFixture(fixture);
  }
});

test("SEC-02 config parent junction fails closed before runtime publication", async () => {
  const fixture = await makeTempDir("mini-lux-sec02-config-link-");
  const outside = await makeTempDir("mini-lux-sec02-config-outside-");
  const workspace = path.join(fixture, "workspace");
  const department = path.join(fixture, "department");
  const output = path.join(fixture, "output");
  await Promise.all([workspace, department, output].map(directory => fs.mkdir(directory)));
  const linkedParent = path.join(fixture, "linked-config");
  await fs.symlink(outside, linkedParent, "junction");
  const configPath = path.join(linkedParent, "config.json");
  const original = Buffer.from(JSON.stringify(configFor(workspace, department, output), null, 2));
  await fs.writeFile(path.join(outside, "config.json"), original);
  const port = await freePort();
  const child = spawnManaged(process.execPath, ["dist/index.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      RAINYDAYS_API_TOKEN: "sec02-config-link-test",
      RAINYDAYS_USER_DATA_DIR: fixture,
      RAINYDAYS_DATA_DIR: path.join(fixture, "data"),
      RAINYDAYS_CONFIG_PATH: configPath,
      RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"),
      RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"),
      RAINYDAYS_PUBLIC_DIR: path.join(projectRoot, "public"),
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  try {
    assert.equal(await waitForChildExit(child, 20_000), true, `junction startup did not terminate\nstdout=${stdout}\nstderr=${stderr}`);
    assert.notEqual(child.exitCode, 0, "junction-backed config unexpectedly published a runtime");
    assert.match(`${stdout}\n${stderr}`, /PATH_REDIRECT_DENIED|Path operation denied/);
    assert.deepEqual(await fs.readFile(path.join(outside, "config.json")), original);
    const reachable = await fetch(`http://127.0.0.1:${port}/api/status`, {
      headers: { "X-RainyDays-Token": "sec02-config-link-test" },
    }).then(() => true, () => false);
    assert.equal(reachable, false);
    const events = parsePathDenialEvents({ stdout, stderr }).filter(event => event.rootId === "config");
    const actual = {
      diskRuntimeConsistent: Buffer.compare(await fs.readFile(path.join(outside, "config.json")), original) === 0 && !reachable,
      retiredAuthorityReactivated: false,
      oldTokensStale: true,
      staleCandidatePublished: reachable,
      finalState: "stopped-fail-closed",
      denied: child.exitCode !== 0,
      auditAttempts: events.length,
      auditAllowedFieldsExact: events.every(event => JSON.stringify(Object.keys(event).sort()) === JSON.stringify(auditKeys)),
      rawPathsAbsent: events.every(event => !Object.values(event).some(value => typeof value === "string" && value.includes(configPath))),
    };
    assert.equal(actual.auditAttempts, 1, `config parent audit events: ${JSON.stringify(events.map(event => ({ code: event.code, rootId: event.rootId, operation: event.operation })))}`);
    assert.equal(actual.auditAllowedFieldsExact, true);
    assert.equal(actual.rawPathsAbsent, true);
    if (configLinkRecorder.enabled) await configLinkRecorder.observe("SEC02-P31-config-parent-link", actual);
  } finally {
    await terminateProcessTreeAsync(child);
    await removeFixture(fixture);
    await removeFixture(outside);
  }
});
