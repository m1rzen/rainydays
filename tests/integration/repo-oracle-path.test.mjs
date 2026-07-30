import assert from "node:assert/strict";
import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createSec02Recorder } from "../sec02-receipts.mjs";

const execFileAsync = promisify(execFile);
const repoRecorder = await createSec02Recorder(
  import.meta.url,
  "SEC-02 read_repo uses fixed Git NUL enumeration and authorizes every tracked entry"
);
const oracleRecorder = await createSec02Recorder(
  import.meta.url,
  "SEC-02 Oracle project read and managed snapshot write use disjoint governed paths"
);
const auditKeys = ["authorityEpoch", "code", "event", "inputFingerprint", "operation", "operationId", "principal", "rootId", "runId", "sessionId", "timestamp"].sort();
const pathAuditEvents = [];
const processObservation = new AsyncLocalStorage();
const processHook = createHook({
  init(_asyncId, type) {
    if (type === "PROCESSWRAP") {
      const counter = processObservation.getStore();
      if (counter) counter.processStarts += 1;
    }
  },
});
processHook.enable();
const originalConsoleWarn = console.warn;
console.warn = (...args) => {
  try {
    const parsed = typeof args[0] === "string" ? JSON.parse(args[0]) : null;
    if (parsed?.component === "path-policy") {
      const { component: _component, ...event } = parsed;
      pathAuditEvents.push(event);
    }
  } catch {
    // Non-JSON warnings are unrelated to PathPolicy evidence.
  }
  originalConsoleWarn(...args);
};

function denialAuditEvidence(events, rawInputs) {
  return {
    auditAttempts: events.length,
    auditAllowedFieldsExact: events.every(event => JSON.stringify(Object.keys(event).sort()) === JSON.stringify(auditKeys)),
    rawPathsAbsent: events.every(event => !Object.values(event).some(value => typeof value === "string" && rawInputs.some(raw => value.includes(raw)))),
  };
}

function exposedExternalBytes(value, secret) {
  const serialized = value instanceof Error ? `${value.name}:${value.message}` : JSON.stringify(value);
  return serialized.includes(secret) ? Buffer.byteLength(secret) : 0;
}

async function captureDenial(invoke) {
  const auditStart = pathAuditEvents.length;
  const counter = { processStarts: 0 };
  let error;
  await processObservation.run(counter, async () => {
    try { await invoke(); }
    catch (caught) { error = caught; }
  });
  return { error, events: pathAuditEvents.slice(auditStart), processStarts: counter.processStarts };
}

async function externalState() {
  return {
    entries: await fs.readdir(outside, { recursive: true }),
    secret: await fs.readFile(externalSecretPath),
  };
}

function externalArtifactsChanged(before, after) {
  return Number(JSON.stringify(before.entries.sort()) !== JSON.stringify(after.entries.sort()) || !before.secret.equals(after.secret));
}

const gitExecutable = process.platform === "win32"
  ? (await execFileAsync(path.join(process.env.SystemRoot ?? process.env.WINDIR, "System32", "where.exe"), ["git.exe"], { encoding: "utf8", windowsHide: true })).stdout.split(/\r?\n/u).find(Boolean)
  : "/usr/bin/git";
assert(gitExecutable && path.isAbsolute(gitExecutable), "Git executable fixture is unavailable");
process.env.RAINYDAYS_GIT_EXECUTABLE = await fs.realpath(gitExecutable);
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec02-repo-oracle-"));
const repository = path.join(fixture, "repository");
const outside = path.join(fixture, "outside");
const data = path.join(fixture, "data");
const externalSecret = "EXTERNAL-SECRET";
const externalSecretPath = path.join(outside, "secret.txt");
await fs.mkdir(path.join(repository, "src"), { recursive: true });
await fs.mkdir(outside, { recursive: true });
await fs.mkdir(data, { recursive: true });
await fs.writeFile(path.join(repository, "package.json"), JSON.stringify({ name: "governed-repository" }));
await fs.writeFile(path.join(repository, "src", "main.ts"), "export const governed = true;\n");
await fs.writeFile(path.join(repository, "README.md"), "# Governed Repository\n");
await fs.writeFile(externalSecretPath, externalSecret);
await execFileAsync(process.env.RAINYDAYS_GIT_EXECUTABLE, ["init", "--quiet"], { cwd: repository, windowsHide: true });
await execFileAsync(process.env.RAINYDAYS_GIT_EXECUTABLE, ["add", "--", "package.json", "README.md", "src/main.ts"], { cwd: repository, windowsHide: true });

process.env.RAINYDAYS_USER_DATA_DIR = fixture;
process.env.RAINYDAYS_DATA_DIR = data;
const [personaModule, sessionModule, dbModule, toolsModule, pathRuntimeModule, managedStoreModule] = await Promise.all([
  import("../../dist/persona.js"),
  import("../../dist/session.js"),
  import("../../dist/db.js"),
  import("../../dist/tools/index.js"),
  import("../../dist/path-runtime.js"),
  import("../../dist/managed-path-store.js"),
]);

const persona = personaModule.createEffectivePersona({
  name: "sec02-repo-oracle",
  displayName: "SEC02 Repo Oracle",
  description: "isolated repository and Oracle path test",
  tools: ["read_repo", "oracle_save", "oracle_status"],
  env: { DATA_ROOT: repository, WORKSPACE_ROOT: repository },
  allowedRoots: [repository],
  networkPolicy: { mode: "deny" },
  systemPrompt: "SEC-02 repository and Oracle",
});
const session = sessionModule.createSession(persona, "SEC-02 repo Oracle");

async function makeAuthority() {
  const pathAuthority = await pathRuntimeModule.pathPolicy.createAuthority([{
    rootId: "workspace",
    role: "workspace",
    configuredPath: repository,
    permissions: ["initial-cwd", "search-tree"],
  }]);
  return toolsModule.capabilityBroker.createRuntimeAuthority({
    name: persona.name,
    tools: persona.tools,
    env: persona.env,
    systemPrompt: persona.systemPrompt,
    allowedRoots: persona.allowedRoots,
    rootEnv: { DATA_ROOT: "workspace", WORKSPACE_ROOT: "workspace" },
    pathAuthority,
    networkPolicy: persona.networkPolicy,
    digest: persona.digest,
  });
}

async function approved(context, name, args) {
  const inspected = toolsModule.inspectToolCall(context, name, args);
  const challenge = toolsModule.capabilityBroker.createApprovalChallenge(context, inspected);
  const grant = toolsModule.capabilityBroker.resolveApprovalChallenge({
    challengeId: challenge.challengeId,
    choice: "approve",
    sessionId: context.sessionId,
    runId: context.runId,
    responsePrincipal: "local-user-api",
    responseChannel: "ask-user",
  });
  assert(grant);
  try { return await toolsModule.executeInspectedTool(grant, inspected); }
  finally { toolsModule.capabilityBroker.finishContext(grant); }
}

test.after(async () => {
  processHook.disable();
  console.warn = originalConsoleWarn;
  await repoRecorder.close();
  await oracleRecorder.close();
  dbModule.closeDb();
  await fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("SEC-02 read_repo uses fixed Git NUL enumeration and authorizes every tracked entry", async () => {
  const authority = await makeAuthority();
  const root = toolsModule.capabilityBroker.beginAgentRun(authority, session.id);
  try {
    const tree = await toolsModule.executeTool(root, "read_repo", { path: "", level: "tree" });
    assert.match(tree, /package\.json/);
    assert.match(tree, /src\/main\.ts/);
    const headers = await toolsModule.executeTool(root, "read_repo", { path: "", level: "headers" });
    assert.match(headers, /governed-repository/);
    assert.match(headers, /Governed Repository/);

    const cwdBefore = await externalState();
    const cwdAttempt = await captureDenial(() => toolsModule.executeTool(root, "read_repo", { path: outside, level: "tree" }));
    const cwdAfter = await externalState();
    const cwdActual = {
      denied: cwdAttempt.error !== undefined,
      rootExternalBytesRead: exposedExternalBytes(cwdAttempt.error, externalSecret),
      rootExternalArtifacts: externalArtifactsChanged(cwdBefore, cwdAfter),
      processStarts: cwdAttempt.processStarts,
      ...denialAuditEvidence(cwdAttempt.events, [outside]),
    };
    assert.equal(cwdAttempt.error?.code, "PATH_ROOT_DENIED");
    assert.deepEqual(cwdActual, {
      denied: true,
      rootExternalBytesRead: 0,
      rootExternalArtifacts: 0,
      processStarts: 0,
      auditAttempts: 1,
      auditAllowedFieldsExact: true,
      rawPathsAbsent: true,
    });
    if (repoRecorder.enabled) await repoRecorder.observe("SEC02-P25-repo-cwd-escape", cwdActual);

    const newlineName = "line\nbreak.txt";
    const newlineCarrierName = "zz-newline-denial";
    const newlineCarrier = path.join(repository, newlineCarrierName);
    const newlineTrackedPath = `${newlineCarrierName}/${newlineName}`;
    await fs.symlink(outside, newlineCarrier, "junction");
    const { stdout: blobOutput } = await execFileAsync(
      process.env.RAINYDAYS_GIT_EXECUTABLE,
      ["hash-object", "package.json"],
      { cwd: repository, encoding: "utf8", windowsHide: true }
    );
    await execFileAsync(
      process.env.RAINYDAYS_GIT_EXECUTABLE,
      ["-c", "core.protectNTFS=false", "update-index", "--add", "--cacheinfo", `100644,${blobOutput.trim()},${newlineTrackedPath}`],
      { cwd: repository, windowsHide: true }
    );
    const { stdout: gitEntries } = await execFileAsync(
      process.env.RAINYDAYS_GIT_EXECUTABLE,
      ["ls-files", "-z", "--"],
      { cwd: repository, encoding: "buffer", windowsHide: true }
    );
    const newlineBefore = await externalState();
    const newlineAttempt = await captureDenial(() => toolsModule.executeTool(root, "read_repo", { path: "", level: "tree" }));
    const newlineAfter = await externalState();
    const newlineActual = {
      denied: newlineAttempt.error !== undefined,
      rootExternalBytesRead: exposedExternalBytes(newlineAttempt.error, externalSecret),
      rootExternalArtifacts: externalArtifactsChanged(newlineBefore, newlineAfter),
      nulProtocolUsed: Buffer.isBuffer(gitEntries) && gitEntries.at(-1) === 0
        && gitEntries.includes(Buffer.from(`${newlineTrackedPath}\0`)),
      eachTrackedPathAuthorized: newlineAttempt.error?.code === "PATH_REDIRECT_DENIED"
        && newlineAttempt.events.length === 1
        && newlineAttempt.events[0]?.operation === "search-tree",
      ...denialAuditEvidence(newlineAttempt.events, [newlineName, newlineTrackedPath, newlineCarrier]),
    };
    assert.deepEqual(newlineActual, {
      denied: true,
      rootExternalBytesRead: 0,
      rootExternalArtifacts: 0,
      nulProtocolUsed: true,
      eachTrackedPathAuthorized: true,
      auditAttempts: 1,
      auditAllowedFieldsExact: true,
      rawPathsAbsent: true,
    });
    if (repoRecorder.enabled) await repoRecorder.observe("SEC02-P25-git-newline-name", newlineActual);
    await execFileAsync(
      process.env.RAINYDAYS_GIT_EXECUTABLE,
      ["-c", "core.protectNTFS=false", "update-index", "--force-remove", "--", newlineTrackedPath],
      { cwd: repository, windowsHide: true }
    );
    await fs.unlink(newlineCarrier);

    const linkedName = "tracked-external-link";
    const linkedEntry = path.join(repository, linkedName);
    await fs.symlink(outside, linkedEntry, "junction");
    await execFileAsync(process.env.RAINYDAYS_GIT_EXECUTABLE, ["add", "--", linkedName], { cwd: repository, windowsHide: true });
    const linkedBefore = await externalState();
    const linkedAttempt = await captureDenial(() => toolsModule.executeTool(root, "read_repo", { path: "", level: "tree" }));
    const linkedAfter = await externalState();
    const linkedActual = {
      denied: linkedAttempt.error !== undefined,
      rootExternalBytesRead: exposedExternalBytes(linkedAttempt.error, externalSecret),
      rootExternalArtifacts: externalArtifactsChanged(linkedBefore, linkedAfter),
      ...denialAuditEvidence(linkedAttempt.events, [linkedName, linkedEntry]),
    };
    assert.equal(linkedAttempt.error?.code, "PATH_REDIRECT_DENIED");
    assert.deepEqual(linkedActual, {
      denied: true,
      rootExternalBytesRead: 0,
      rootExternalArtifacts: 0,
      auditAttempts: 1,
      auditAllowedFieldsExact: true,
      rawPathsAbsent: true,
    });
    if (repoRecorder.enabled) await repoRecorder.observe("SEC02-P25-git-linked-entry", linkedActual);
    await execFileAsync(process.env.RAINYDAYS_GIT_EXECUTABLE, ["rm", "--cached", "-r", "--ignore-unmatch", "--", linkedName], { cwd: repository, windowsHide: true });
    await fs.unlink(linkedEntry);

    const oracleEscapeBefore = await externalState();
    const oracleEscapeAttempt = await captureDenial(() => approved(root, "oracle_save", { path: outside }));
    const oracleEscapeAfter = await externalState();
    const oracleEscapeActual = {
      denied: oracleEscapeAttempt.error !== undefined,
      rootExternalBytesRead: exposedExternalBytes(oracleEscapeAttempt.error, externalSecret),
      rootExternalArtifacts: externalArtifactsChanged(oracleEscapeBefore, oracleEscapeAfter),
      ...denialAuditEvidence(oracleEscapeAttempt.events, [outside]),
    };
    assert.equal(oracleEscapeAttempt.error?.code, "PATH_ROOT_DENIED");
    assert.deepEqual(oracleEscapeActual, {
      denied: true,
      rootExternalBytesRead: 0,
      rootExternalArtifacts: 0,
      auditAttempts: 1,
      auditAllowedFieldsExact: true,
      rawPathsAbsent: true,
    });
    if (repoRecorder.enabled) await repoRecorder.observe("SEC02-P25-oracle-project-escape", oracleEscapeActual);

    await approved(root, "oracle_save", { path: "" });
    const store = await managedStoreModule.getManagedPathStore();
    const snapshotBefore = await store.readOracle();
    assert(snapshotBefore);
    const managedLinkName = "oracle-managed-link";
    const managedLink = path.join(repository, managedLinkName);
    await fs.symlink(outside, managedLink, "junction");
    const managedBefore = await externalState();
    const managedAttempt = await captureDenial(() => approved(root, "oracle_save", { path: "" }));
    const managedAfter = await externalState();
    const snapshotAfter = await store.readOracle();
    assert(snapshotAfter);
    const managedActual = {
      denied: managedAttempt.error !== undefined,
      rootExternalBytesRead: exposedExternalBytes(managedAttempt.error, externalSecret),
      rootExternalArtifacts: Number(
        externalArtifactsChanged(managedBefore, managedAfter) !== 0
        || Buffer.compare(snapshotBefore, snapshotAfter) !== 0
      ),
      ...denialAuditEvidence(managedAttempt.events, [managedLinkName, managedLink]),
    };
    assert.equal(managedAttempt.error?.code, "PATH_REDIRECT_DENIED");
    assert.deepEqual(managedActual, {
      denied: true,
      rootExternalBytesRead: 0,
      rootExternalArtifacts: 0,
      auditAttempts: 1,
      auditAllowedFieldsExact: true,
      rawPathsAbsent: true,
    });
    if (repoRecorder.enabled) await repoRecorder.observe("SEC02-P25-oracle-managed-store-denial", managedActual);
    await fs.unlink(managedLink);
  } finally {
    toolsModule.capabilityBroker.finishContext(root);
    await toolsModule.capabilityBroker.retireAuthority(authority);
  }
});

test("SEC-02 Oracle project read and managed snapshot write use disjoint governed paths", async () => {
  const authority = await makeAuthority();
  const root = toolsModule.capabilityBroker.beginAgentRun(authority, session.id);
  try {
    const saved = await approved(root, "oracle_save", { path: "" });
    assert.match(saved, /Oracle 快照已保存/);
    const status = await toolsModule.executeTool(root, "oracle_status", {});
    assert.match(status, /Oracle 已加载/);
    const store = await managedStoreModule.getManagedPathStore();
    const before = await store.readOracle();
    assert(before);
    const parsed = JSON.parse(before.toString("utf8"));
    assert.equal(parsed.projectPath, ".");
    assert.match(parsed.headers["package.json"].join("\n"), /governed-repository/);

    const linked = path.join(repository, "external-link");
    await fs.symlink(outside, linked, "junction");
    await execFileAsync(process.env.RAINYDAYS_GIT_EXECUTABLE, ["add", "--", "external-link"], { cwd: repository, windowsHide: true });
    await assert.rejects(
      () => toolsModule.executeTool(root, "read_repo", { path: "", level: "tree" }),
      error => error?.code === "PATH_REDIRECT_DENIED"
    );
    await assert.rejects(
      () => approved(root, "oracle_save", { path: "" }),
      error => error?.code === "PATH_REDIRECT_DENIED"
    );
    const after = await store.readOracle();
    assert(after);
    assert.equal(Buffer.compare(before, after), 0, "denied Oracle scan modified the managed snapshot");
    if (oracleRecorder.enabled) await oracleRecorder.positive("SEC02-POS-oracle");
  } finally {
    toolsModule.capabilityBroker.finishContext(root);
    await toolsModule.capabilityBroker.retireAuthority(authority);
  }
});

test("SEC-02 read_repo and Oracle sources have no direct filesystem or shell execution fallback", async () => {
  const readRepoSource = await fs.readFile(new URL("../../src/tools/read-repo.ts", import.meta.url), "utf8");
  const oracleSource = await fs.readFile(new URL("../../src/oracle.ts", import.meta.url), "utf8");
  assert(!/from\s+["'](?:node:)?fs(?:\/promises)?["']/.test(readRepoSource));
  assert(!/from\s+["'](?:node:)?fs(?:\/promises)?["']/.test(oracleSource));
  assert(!/\bexec\s*\(/.test(readRepoSource));
  assert.match(readRepoSource, /["']ls-files["'],\s*["']-z["']/);
  assert(!/listFilesRecursive|USERPROFILE|process\.env/.test(readRepoSource));
  assert.match(oracleSource, /getManagedPathStore/);
});
