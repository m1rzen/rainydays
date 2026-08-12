import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import dgram from "node:dgram";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { CapabilityBroker } from "../../dist/capability-broker.js";
import { ExecutionDeniedError, ExecutionIsolationService } from "../../dist/execution-isolation.js";
import { createFiniteHttpsBroker, FiniteHttpsBrokerError } from "../../dist/execution-network-broker.js";
import { bindNativeRootAuthority, createProductionNativeExecutionBridge } from "../../dist/execution-native.js";
import { createManualExecutionGateway, observeTerminalDirectDenial, shutdownExecutionRuntime } from "../../dist/execution-runtime.js";
import { PathPolicy } from "../../dist/path-policy.js";
import { terminalFacade } from "../../dist/terminal.js";
import { DIRECT_OPERATION_POLICIES } from "../../dist/tool-policies.js";
import { ManualConsentDeniedError, ManualExecutionConsentLedger } from "../../dist/manual-execution-consent.js";
import { issueResourceOwner } from "../../dist/resource-owner.js";
import { createSec03NativeVerifier } from "../../scripts/sec03-native-verifier.mjs";
import { aggregateSec03Receipts } from "../../scripts/sec03-receipt-set.mjs";
import { createSec03Receipt, createSec03Recorder, validateSec03Matrix, validateSec03Receipt } from "../sec03-receipts.mjs";
import { A01_OUTPUT_MARKER, A02_ANOTHER_DRIVE_PATH, A02_OUTPUT_MARKER, A04_LISTEN_READY_MARKER, A04_OUTPUT_MARKER, A04_PORTS, A08_SUPPORT_FILES, A14_INVALID_JOURNAL, A15_EXTRA_ARTIFACT, A17_OUTPUT_MARKER, a01ParentMutation, a01Probe, a02Case, a03Case, a04Case, a04ExternalAddress, a06Case, a07Case, a08Case, a09Case, a10Case, a11Case, a12Case, a13Case, a15Case, a17Probe, a19Case, e3aCase } from "../fixtures/sec03-real-host-plan.mjs";

const execFileAsync = promisify(execFile);

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(import.meta.dirname, "../..");
const manifestPath = path.join(projectRoot, "dist/native/sec03-native-manifest.json");
const addonPath = path.join(projectRoot, "dist/native/sandbox-launcher.node");
const testNativeDirectory = path.join(projectRoot, ".sec03-native-test");
const testAddonPath = path.join(testNativeDirectory, "sandbox-launcher.node");
const testHostPath = path.join(testNativeDirectory, "sandbox-host.exe");
const a07HelperPath = path.join(testNativeDirectory, "sec03-a07-adversary.exe");
let sharedReceiptRecorder = null;

async function receiptRecorder(identity, nativeVerifier) {
  if (!sharedReceiptRecorder) sharedReceiptRecorder = await createSec03Recorder(import.meta.url, identity, nativeVerifier);
  return sharedReceiptRecorder;
}

test.after(async () => { if (sharedReceiptRecorder) await sharedReceiptRecorder.close(); });

function frame(body) {
  const payload = Buffer.from(JSON.stringify(body), "utf8");
  const result = Buffer.alloc(payload.length + 4);
  result.writeUInt32BE(payload.length, 0);
  payload.copy(result, 4);
  return result;
}

function environment(root) {
  const systemRoot = process.env.SystemRoot;
  assert.equal(typeof systemRoot, "string");
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    ComSpec: path.join(systemRoot, "System32", "cmd.exe"),
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    OS: "Windows_NT",
    PROCESSOR_ARCHITECTURE: "AMD64",
    NUMBER_OF_PROCESSORS: "1",
    TEMP: root,
    TMP: root,
    USERPROFILE: root,
    HOME: root,
    APPDATA: root,
    LOCALAPPDATA: root,
    PATH: path.join(systemRoot, "System32"),
    MINI_LUX_SANDBOX_ID: "native-integration",
    MINI_LUX_SESSION_ID: "native-integration",
    MINI_LUX_ROOT_0: root,
  };
}

function scriptEnvironment(root) {
  const systemRoot = process.env.SystemRoot;
  assert.equal(typeof systemRoot, "string");
  return {
    SystemRoot: systemRoot,
    WINDIR: systemRoot,
    PATHEXT: ".COM;.EXE;.BAT;.CMD",
    OS: "Windows_NT",
    PROCESSOR_ARCHITECTURE: "AMD64",
    NUMBER_OF_PROCESSORS: "1",
    PATH: path.join(systemRoot, "System32"),
    TEMP: root,
    TMP: root,
    USERPROFILE: root,
    HOME: root,
    APPDATA: root,
    LOCALAPPDATA: root,
    NODE_DISABLE_COLORS: "1",
    MINI_LUX_SANDBOX_ID: "native-integration",
    MINI_LUX_SESSION_ID: "native-integration",
    MINI_LUX_ROOT_0: root,
  };
}

async function launchBody(root, command, overrides = {}) {
  const info = await fs.stat(root, { bigint: true });
  return {
    v: 1,
    type: "launch",
    secret: "0".repeat(64),
    candidateId: "c".repeat(64),
    buildIdSha256: "d".repeat(64),
    sourceSha256: "e".repeat(64),
    hostSha256: "0".repeat(64),
    launcherSha256: "0".repeat(64),
    executable: { handleIndex: -1, kind: "fixed-system" },
    executionId: `sec03-${Date.now()}-${Math.random()}`,
    entryPoint: "E1",
    profile: "one-shot-shell",
    contextId: "native-integration",
    sessionId: "native-integration",
    runId: "native-integration",
    principal: "native-integration",
    authorityEpoch: 1,
    personaDigest: "a".repeat(64),
    policyDigest: "b".repeat(64),
    payload: Buffer.from(command, "utf8").toString("base64"),
    payloadDigest: createHash("sha256").update(command).digest("hex"),
    roots: [{ rootId: "integration-root", access: "read-write", canonicalPath: root, identity: { volumeSerial: String(info.dev), fileId: String(info.ino), type: "directory" }, canonicalCwd: root, cwdIdentity: { volumeSerial: String(info.dev), fileId: String(info.ino), type: "directory" } }],
    environment: environment(root),
    network: { mode: "deny" },
    limits: {
      activeProcesses: 16,
      processMemoryBytes: 512 * 1024 * 1024,
      jobMemoryBytes: 1024 * 1024 * 1024,
      cpuRatePercent: 50,
      jobUserTimeMs: 30_000,
      wallTimeMs: 30_000,
      idleTimeMs: null,
      aggregateOutputBytes: 1024 * 1024,
      retainedOutputBytes: 1024 * 1024,
      inputBytes: 128 * 1024,
    },
    expiresAtMs: Date.now() + 30_000,
    ...overrides,
  };
}

async function scriptLaunchBody(root, source, overrides = {}) {
  return launchBody(root, source, {
    executable: { handleIndex: -1, kind: "current-node" },
    entryPoint: "E3",
    profile: "script",
    environment: scriptEnvironment(root),
    limits: {
      activeProcesses: 1,
      processMemoryBytes: 256 * 1024 * 1024,
      jobMemoryBytes: 256 * 1024 * 1024,
      cpuRatePercent: 20,
      jobUserTimeMs: 10_000,
      wallTimeMs: 10_000,
      idleTimeMs: null,
      aggregateOutputBytes: 1024 * 1024,
      retainedOutputBytes: 1024 * 1024,
      inputBytes: 128 * 1024,
    },
    ...overrides,
  });
}

async function terminalLaunchBody(root, entryPoint, overrides = {}) {
  const e2 = entryPoint === "E2";
  return launchBody(root, "cmd", {
    entryPoint,
    profile: e2 ? "agent-shell" : "manual-terminal",
    environment: environment(root),
    limits: {
      activeProcesses: e2 ? 32 : 64,
      processMemoryBytes: e2 ? 512 * 1024 * 1024 : 1024 * 1024 * 1024,
      jobMemoryBytes: e2 ? 1024 * 1024 * 1024 : 2 * 1024 * 1024 * 1024,
      cpuRatePercent: e2 ? 25 : 50,
      jobUserTimeMs: e2 ? 600_000 : 3_600_000,
      wallTimeMs: e2 ? 1_800_000 : 28_800_000,
      idleTimeMs: e2 ? 300_000 : 1_800_000,
      aggregateOutputBytes: e2 ? 10 * 1024 * 1024 : 64 * 1024 * 1024,
      retainedOutputBytes: 1024 * 1024,
      inputBytes: 64 * 1024,
    },
    ...overrides,
  });
}

function inputFrame(data, appendNewline = true) {
  const bytes = Buffer.from(data, "utf8");
  return frame({ v: 1, type: "input", secret: "0".repeat(64), data: bytes.toString("base64"), digest: createHash("sha256").update(bytes).digest("hex"), appendNewline });
}

function terminateFrame(reason = "requested") {
  return frame({ v: 1, type: "terminate", secret: "0".repeat(64), reason });
}

function decode(frames) {
  return frames.map((value) => {
    assert.ok(Buffer.isBuffer(value));
    assert.equal(value.readUInt32BE(0), value.length - 4);
    const body = JSON.parse(value.subarray(4).toString("utf8"));
    return { stream: body.stream, text: Buffer.from(body.data, "base64").toString("utf8") };
  });
}

function parseNativeProof(nativeProof) {
  assert(nativeProof && Buffer.isBuffer(nativeProof.proof));
  return Object.fromEntries(nativeProof.proof.toString("utf8").trimEnd().split("\n").map(line => {
    const separator = line.indexOf("=");
    assert(separator > 0 && separator === line.lastIndexOf("="));
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
}

function evidenceFromNativeProof({ nativeProof, host, launcher, layer, familyId, variantId, profileId, observedCode, observedSubcode = null, networkAttemptCount = 0, networkAcceptedCount = 0 }) {
  const fields = parseNativeProof(nativeProof);
  return {
    fields,
    envelope: {
      producer: { kind: "sandbox-host", hostSha256: host.sha256, launcherSha256: launcher.sha256, instanceSha256: createHash("sha256").update(`${nativeProof.keyId}\0${fields.execution}`).digest("hex") },
      runId: fields.run, candidateId: fields.candidate, buildId: fields.buildIdSha256, executionNonce: fields.execution,
      layer, familyId, variantId, profileId, observedCode, observedSubcode,
      transcriptSha256: fields.transcriptSha256, transcriptMac: nativeProof.mac, launcherChannelMarker: nativeProof.channelMarker,
      sideEffects: { processStarts: Number(fields.processStarts), aclMutations: Number(fields.aclMutations), stdinWrites: Number(fields.stdinWrites) },
      token: { isAppContainer: fields.tokenIsAppContainer === "1", packageSidSha256: fields.packageSidSha256, capabilityCount: Number(fields.capabilityCount), integrity: fields.lowIntegrity === "1" ? "low" : "other" },
      job: { policySha256: fields.jobPolicySha256, activeProcessZero: fields.activeProcessZero === "1" },
      root: { identitySha256: fields.rootIdentityDigest, accessProfileSha256: fields.rootAccessProfileSha256 },
      environment: { nameSetSha256: fields.environmentNameDigest, valueSetSha256: fields.environmentValueDigest, ambientLeakCount: Number(fields.ambientLeakCount) },
      network: { mode: fields.networkMode, attemptCount: networkAttemptCount, acceptedCount: networkAcceptedCount },
      termination: { reason: fields.completionReason, exitCode: Number(fields.childExit), treeTerminated: fields.treeTerminated === "1", activeProcessZero: fields.activeProcessZero === "1" },
      cleanup: { jobClosed: fields.cleanupComplete === "1", handlesDrained: fields.handlesDrained === "1", hostExited: true, aclProfileSha256: fields.aclProfileSha256 },
      nativeProof: { kind: "execution-proof", proofBase64: nativeProof.proof.toString("base64"), mac: nativeProof.mac, keyId: nativeProof.keyId, channelMarker: nativeProof.channelMarker },
    },
  };
}

function evidenceFromLauncherObservation({ nativeObservation, host, launcher, familyId, variantId, profileId }) {
  const fields = parseNativeProof(nativeObservation);
  return {
    fields,
    envelope: {
      producer: { kind: "sandbox-host", hostSha256: host.sha256, launcherSha256: launcher.sha256, instanceSha256: createHash("sha256").update(`${nativeObservation.keyId}\0${fields.execution}`).digest("hex") },
      runId: fields.run, candidateId: fields.candidate, buildId: fields.buildIdSha256, executionNonce: fields.execution,
      layer: "real-host", familyId, variantId, profileId, observedCode: fields.observedCode, observedSubcode: fields.observedSubcode === "none" ? null : fields.observedSubcode,
      transcriptSha256: fields.transcriptSha256, transcriptMac: null, launcherChannelMarker: nativeObservation.channelMarker,
      sideEffects: { processStarts: Number(fields.processStarts), aclMutations: Number(fields.aclMutations), stdinWrites: Number(fields.stdinWrites) },
      token: { isAppContainer: false, packageSidSha256: fields.packageSidSha256, capabilityCount: Number(fields.capabilityCount), integrity: "other" },
      job: { policySha256: fields.jobPolicySha256, activeProcessZero: fields.activeProcessZero === "1" },
      root: { identitySha256: fields.rootIdentityDigest, accessProfileSha256: fields.rootAccessProfileSha256 },
      environment: { nameSetSha256: fields.environmentNameDigest, valueSetSha256: fields.environmentValueDigest, ambientLeakCount: Number(fields.ambientLeakCount) },
      network: { mode: fields.networkMode, attemptCount: Number(fields.networkAttemptCount), acceptedCount: Number(fields.networkAcceptedCount) },
      termination: { reason: fields.completionReason, exitCode: null, treeTerminated: fields.treeTerminated === "1", activeProcessZero: fields.activeProcessZero === "1" },
      cleanup: { jobClosed: fields.jobClosed === "1", handlesDrained: fields.handlesDrained === "1", hostExited: fields.hostExited === "1", aclProfileSha256: fields.aclProfileSha256 },
      nativeProof: { kind: "launcher-observation", proofBase64: nativeObservation.proof.toString("base64"), mac: nativeObservation.mac, keyId: nativeObservation.keyId, channelMarker: nativeObservation.channelMarker },
    },
  };
}

async function start(addon, host, launcher, body) {
  const lease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
  const frames = [];
  const handle = lease.launchHost(frame(body), (value) => frames.push(value));
  await lease.close();
  return { handle, frames };
}

async function launch(addon, host, launcher, body) {
  const started = await start(addon, host, launcher, body);
  return { ...started, completion: await started.handle.completed };
}

async function startAclConflictReceipt(addon, host, launcher, body) {
  const lease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
  const frames = [];
  assert.equal(typeof lease.launchAclConflictForReceipt, "function");
  const handle = lease.launchAclConflictForReceipt(frame(body), value => frames.push(value));
  await lease.close();
  return { handle, frames };
}

async function startAclCrashReceipt(addon, host, launcher, body, variantId) {
  const method = variantId === "A14-01" ? "launchAclPristineCrashForReceipt" : variantId === "A14-02" ? "launchAclAppliedCrashForReceipt" : null;
  assert(method);
  const lease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
  const frames = [];
  assert.equal(typeof lease[method], "function");
  const handle = lease[method](frame(body), value => frames.push(value));
  await lease.close();
  return { handle, frames };
}

async function startLifecycleCrashReceipt(addon, host, launcher, body, variantId) {
  const method = variantId === "A09-06" ? "launchServiceCrashForReceipt" : variantId === "A09-07" ? "launchHostCrashForReceipt" : null;
  assert(method);
  const lease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
  const frames = [];
  assert.equal(typeof lease[method], "function");
  const handle = lease[method](frame(body), value => frames.push(value));
  await lease.close();
  return { handle, frames };
}

function fixedAdversaryBody(variantId, identity) {
  const planned = e3aCase(variantId, "E3A");
  return Object.freeze({
    v: 1,
    type: "fixed-adversary",
    tuple: planned.tuple,
    secret: "0".repeat(64),
    candidateId: identity.candidateId,
    buildIdSha256: identity.buildId,
    sourceSha256: identity.sourceSha256,
    hostSha256: "0".repeat(64),
    launcherSha256: "0".repeat(64),
    executionId: createHash("sha256").update(randomUUID()).digest("hex"),
    runId: identity.runId,
  });
}

async function runFixedAdversary(addon, host, launcher, variantId, identity) {
  return launch(addon, host, launcher, fixedAdversaryBody(variantId, identity));
}

async function observeRootDenial(addon, host, launcher, body, expectedCode = "EXEC_ROOT_UNSUPPORTED") {
  const lease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
  try {
    let denial = null;
    try { lease.launchHost(frame(body), () => assert.fail("pre-host denial emitted an output frame")); }
    catch (error) { denial = error; }
    assert.equal(denial?.code, expectedCode);
    assert(denial.nativeObservation && Object.isFrozen(denial.nativeObservation));
    assert(Buffer.isBuffer(denial.nativeObservation.proof));
    return denial.nativeObservation;
  } finally {
    await lease.close();
  }
}

async function observeA15NativeIdentity(addon, host, launcher, subjectPath, variantId, profileId, identity) {
  const planned = a15Case(variantId, profileId);
  const request = Object.freeze({
    v: 1,
    type: "native-identity-observation",
    candidateId: identity.candidateId,
    buildIdSha256: identity.buildId,
    sourceSha256: identity.sourceSha256,
    executionId: createHash("sha256").update(randomUUID()).digest("hex"),
    contextId: createHash("sha256").update(`sec03-a15-context-${profileId}`).digest("hex"),
    sessionId: createHash("sha256").update(`sec03-a15-session-${profileId}`).digest("hex"),
    runId: identity.runId,
    authorityEpoch: 1,
    entryPoint: planned.entryPoint,
    profile: planned.profile,
    personaDigest: createHash("sha256").update("sec03-a15-persona").digest("hex"),
    policyDigest: createHash("sha256").update(`sec03-a15-policy-${profileId}`).digest("hex"),
    subjectPath,
    variantId,
  });
  const lease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
  try {
    assert.equal(typeof lease.observeFixedNativeIdentity, "function");
    return lease.observeFixedNativeIdentity(frame(request));
  } finally {
    await lease.close();
  }
}

async function observeA14InvalidJournal(addon, host, launcher, profileId, identity) {
  const profiles = { E1: "one-shot-shell", E2: "agent-shell", E3: "script", E4: "manual-terminal" };
  const request = Object.freeze({
    v: 1,
    type: "invalid-recovery-observation",
    candidateId: identity.candidateId,
    buildIdSha256: identity.buildId,
    sourceSha256: identity.sourceSha256,
    executionId: createHash("sha256").update(randomUUID()).digest("hex"),
    contextId: createHash("sha256").update(`sec03-a14-context-${profileId}`).digest("hex"),
    sessionId: createHash("sha256").update(`sec03-a14-session-${profileId}`).digest("hex"),
    runId: identity.runId,
    authorityEpoch: 1,
    entryPoint: profileId,
    profile: profiles[profileId],
    personaDigest: createHash("sha256").update("sec03-a14-persona").digest("hex"),
    policyDigest: createHash("sha256").update(`sec03-a14-policy-${profileId}`).digest("hex"),
    variantId: "A14-07",
  });
  assert.equal(typeof addon.openExclusiveHostLease.observeInvalidRecoveryJournal, "function");
  return addon.openExclusiveHostLease.observeInvalidRecoveryJournal(host.sha256, host.bytes, launcher.sha256, frame(request));
}

async function createA13RealTerminal(root, runId) {
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 113) });
  const broker = new CapabilityBroker({ pathPolicy: policy, resolveSessionPersona: sessionId => sessionId.startsWith("sec03-a13-") ? "sec03-a13" : null, newRunId: () => runId });
  for (const operation of ["terminal:start", "terminal:kill", "terminal:close"]) broker.registerDirectOperation(operation, DIRECT_OPERATION_POLICIES[operation]);
  const pathAuthority = await policy.createAuthority([{ rootId: "workspace", role: "workspace", configuredPath: root, permissions: ["initial-cwd"] }]);
  const authority = broker.createRuntimeAuthority({
    name: "sec03-a13",
    tools: [],
    env: { WORKSPACE_ROOT: root },
    systemPrompt: "SEC-03 A13 authentic owner boundary",
    allowedRoots: [root],
    rootEnv: { WORKSPACE_ROOT: "workspace" },
    pathAuthority,
    networkPolicy: { mode: "deny" },
  });
  const principal = broker.createLocalApiPrincipal();
  const exactRequest = Object.freeze({ name: "sec03-a13-victim", shell: "cmd", cwd: root });
  const victimContext = broker.issueLocalApiContext({ authority, principal, sessionId: "sec03-a13-victim", operation: "terminal:start", args: exactRequest });
  let victimOwner;
  let terminal;
  try {
    const authorized = broker.authorizeDirectOperation(victimContext, "terminal:start", exactRequest);
    victimOwner = broker.getResourceOwner(victimContext);
    terminal = await broker.withDirectExecutionRoot(victimContext, "terminal:start", root, "WORKSPACE_ROOT", (authorizedCwd, executionRootLease) =>
      terminalFacade.start(victimOwner, {
        name: String(authorized.name),
        shell: authorized.shell,
        authorizedCwd,
        executionRootLease,
        execution: createManualExecutionGateway({ context: victimContext, owner: victimOwner, operation: "terminal-start", exactRequest: authorized }),
      }));
  } finally {
    if (broker.isContextActive(victimContext)) broker.finishContext(victimContext);
  }
  assert(victimOwner && terminal);
  const attack = async (operation) => {
    const sessionId = `sec03-a13-attacker-${operation}`;
    const directOperation = `terminal:${operation}`;
    const args = Object.freeze({ id: terminal.id });
    const context = broker.issueLocalApiContext({ authority, principal, sessionId, operation: directOperation, args });
    try {
      broker.authorizeDirectOperation(context, directOperation, args);
      const owner = broker.getResourceOwner(context);
      let denial;
      try { await terminalFacade[operation](owner, terminal.id); }
      catch (error) { denial = error; }
      assert.equal(denial?.code, "EXEC_OWNER_MISMATCH");
      assert(denial.nativeObservation, `${operation} owner mismatch omitted native observation`);
      return denial.nativeObservation;
    } finally {
      if (broker.isContextActive(context)) broker.finishContext(context);
    }
  };
  return Object.freeze({ broker, authority, victimOwner, terminal, attack });
}

async function runA06Profile(addon, host, launcher, root, variantId, profileId, identity) {
  const planned = a06Case(variantId, profileId);
  const executionId = createHash("sha256").update(randomUUID()).digest("hex");
  const overrides = { runId: identity.runId, executionId, candidateId: identity.candidateId, buildIdSha256: identity.buildId, sourceSha256: identity.sourceSha256 };
  if (profileId === "E1") return launch(addon, host, launcher, await launchBody(root, planned.payload, overrides));
  const started = await start(addon, host, launcher, await terminalLaunchBody(root, profileId, overrides));
  try {
    await started.handle.writeFrame(inputFrame(planned.input));
    return { ...started, completion: await started.handle.completed };
  } catch (error) {
    try { await started.handle.terminateHost(terminateFrame("test-cleanup")); } catch {}
    await started.handle.completed.catch(() => undefined);
    throw error;
  }
}

async function runA07Profile(addon, host, launcher, root, variantId, profileId, identity) {
  const planned = a07Case(variantId, profileId);
  const executionId = createHash("sha256").update(randomUUID()).digest("hex");
  const overrides = { runId: identity.runId, executionId, candidateId: identity.candidateId, buildIdSha256: identity.buildId, sourceSha256: identity.sourceSha256 };
  if (profileId === "E1") return launch(addon, host, launcher, await launchBody(root, planned.payload, overrides));
  if (profileId === "E3") return launch(addon, host, launcher, await scriptLaunchBody(root, planned.payload, overrides));
  const started = await start(addon, host, launcher, await terminalLaunchBody(root, profileId, overrides));
  try {
    await started.handle.writeFrame(inputFrame(planned.input));
    return { ...started, completion: await started.handle.completed };
  } catch (error) {
    try { await started.handle.terminateHost(terminateFrame("test-cleanup")); } catch {}
    await started.handle.completed.catch(() => undefined);
    throw error;
  }
}

async function runPositiveProfile(addon, host, launcher, root, profileId, identity) {
  const marker = `SEC03_A16_${profileId}_${randomUUID().replaceAll("-", "")}`;
  const executionId = createHash("sha256").update(randomUUID()).digest("hex");
  const overrides = { runId: identity.runId, executionId, candidateId: identity.candidateId, buildIdSha256: identity.buildId, sourceSha256: identity.sourceSha256 };
  if (profileId === "E1") return launch(addon, host, launcher, await launchBody(root, `echo ${marker}`, overrides));
  if (profileId === "E3") return launch(addon, host, launcher, await scriptLaunchBody(root, `console.log(${JSON.stringify(marker)});`, overrides));
  const started = await start(addon, host, launcher, await terminalLaunchBody(root, profileId, overrides));
  try {
    await started.handle.writeFrame(inputFrame(`echo ${marker}`));
    await Promise.race([
      waitFor(async () => decode(started.frames).some(value => value.text.includes(marker))),
      started.handle.completed.then(value => { throw new Error(`persistent positive completed before marker: ${JSON.stringify(value)}`); }),
    ]);
    await started.handle.writeFrame(inputFrame("exit"));
    return { ...started, completion: await started.handle.completed };
  } catch (error) {
    try { await started.handle.terminateHost(terminateFrame("test-cleanup")); } catch {}
    await started.handle.completed.catch(() => undefined);
    throw error;
  }
}

async function runA01Profile(addon, host, launcher, root, variantId, profileId, identity) {
  const probe = a01Probe(variantId, profileId);
  const executionId = createHash("sha256").update(randomUUID()).digest("hex");
  const overrides = { runId: identity.runId, executionId, candidateId: identity.candidateId, buildIdSha256: identity.buildId, sourceSha256: identity.sourceSha256 };
  if (profileId === "E1") return launch(addon, host, launcher, await launchBody(root, probe, overrides));
  if (profileId === "E3") return launch(addon, host, launcher, await scriptLaunchBody(root, probe, overrides));
  const started = await start(addon, host, launcher, await terminalLaunchBody(root, profileId, overrides));
  try {
    await started.handle.writeFrame(inputFrame(probe));
    await Promise.race([
      waitFor(async () => decode(started.frames).some(value => value.text.includes(A01_OUTPUT_MARKER))),
      started.handle.completed.then(value => { throw new Error(`A01 probe detected an ambient environment leak: ${JSON.stringify(value)}`); }),
    ]);
    await started.handle.writeFrame(inputFrame("exit"));
    return { ...started, completion: await started.handle.completed };
  } catch (error) {
    try { await started.handle.terminateHost(terminateFrame("test-cleanup")); } catch {}
    await started.handle.completed.catch(() => undefined);
    throw error;
  }
}

async function runExactDenyProfile(addon, host, launcher, root, profileId, identity, planned, marker) {
  const executionId = createHash("sha256").update(randomUUID()).digest("hex");
  const overrides = { runId: identity.runId, executionId, candidateId: identity.candidateId, buildIdSha256: identity.buildId, sourceSha256: identity.sourceSha256 };
  if (profileId === "E1") return launch(addon, host, launcher, await launchBody(root, planned.payload, overrides));
  if (profileId === "E3") return launch(addon, host, launcher, await scriptLaunchBody(root, planned.payload, overrides));
  const started = await start(addon, host, launcher, await terminalLaunchBody(root, profileId, overrides));
  try {
    await started.handle.writeFrame(inputFrame(planned.input));
    await Promise.race([
      waitFor(async () => decode(started.frames).some(value => value.text.includes(marker))),
      started.handle.completed.then(value => { const output = decode(started.frames).map(frame => frame.text).join(""); throw new Error(`SEC-03 ${profileId} deny probe completed before denial marker: ${JSON.stringify(value)} output=${JSON.stringify(output)}`); }),
    ]);
    await started.handle.writeFrame(inputFrame("exit"));
    return { ...started, completion: await started.handle.completed };
  } catch (error) {
    try { await started.handle.terminateHost(terminateFrame("test-cleanup")); } catch {}
    await started.handle.completed.catch(() => undefined);
    throw error;
  }
}

async function attemptInboundConnection(host, port) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = accepted => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(accepted ? 1 : 0);
    };
    const timer = setTimeout(() => finish(false), 750);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

async function runA04Profile(addon, host, launcher, root, variantId, profileId, identity, planned, external) {
  if (variantId !== "A04-05") {
    return { ...await runExactDenyProfile(addon, host, launcher, root, profileId, identity, planned, A04_OUTPUT_MARKER), networkAcceptedCount: 0 };
  }
  const executionId = createHash("sha256").update(randomUUID()).digest("hex");
  const overrides = { runId: identity.runId, executionId, candidateId: identity.candidateId, buildIdSha256: identity.buildId, sourceSha256: identity.sourceSha256 };
  const persistent = profileId === "E2" || profileId === "E4";
  const body = profileId === "E1"
    ? await launchBody(root, planned.payload, overrides)
    : profileId === "E3"
      ? await scriptLaunchBody(root, planned.payload, overrides)
      : await terminalLaunchBody(root, profileId, overrides);
  const started = await start(addon, host, launcher, body);
  try {
    if (persistent) await started.handle.writeFrame(inputFrame(planned.input));
    const state = await Promise.race([
      waitFor(async () => {
        const output = decode(started.frames).map(value => value.text).join("");
        if (output.includes(A04_LISTEN_READY_MARKER)) return "ready";
        if (output.includes(A04_OUTPUT_MARKER)) return "denied";
        return null;
      }),
      started.handle.completed.then(value => { throw new Error(`SEC-03 ${profileId} inbound probe completed before observation: ${JSON.stringify(value)}`); }),
    ]);
    const networkAcceptedCount = state === "ready" ? await attemptInboundConnection(external, A04_PORTS.listen) : 0;
    if (persistent) await started.handle.writeFrame(inputFrame("exit"));
    return { ...started, completion: await started.handle.completed, networkAcceptedCount };
  } catch (error) {
    try { await started.handle.terminateHost(terminateFrame("test-cleanup")); } catch {}
    await started.handle.completed.catch(() => undefined);
    throw error;
  }
}

async function a03LaunchBody(root, cwd, variantId, profileId, identity) {
  const planned = a03Case(variantId, profileId);
  const executionId = createHash("sha256").update(randomUUID()).digest("hex");
  const [rootInfo, cwdInfo] = await Promise.all([fs.stat(root, { bigint: true }), fs.stat(cwd, { bigint: true })]);
  const roots = [{ rootId: "integration-root", access: "read-write", canonicalPath: root, identity: { volumeSerial: String(rootInfo.dev), fileId: String(rootInfo.ino), type: "directory" }, canonicalCwd: cwd, cwdIdentity: { volumeSerial: String(cwdInfo.dev), fileId: String(cwdInfo.ino), type: "directory" } }];
  const overrides = { runId: identity.runId, executionId, candidateId: identity.candidateId, buildIdSha256: identity.buildId, sourceSha256: identity.sourceSha256, roots };
  if (profileId === "E1") return launchBody(root, planned.payload, overrides);
  if (profileId === "E3") return scriptLaunchBody(root, planned.payload, overrides);
  return terminalLaunchBody(root, profileId, overrides);
}

async function runA03Profile(addon, host, launcher, root, cwd, variantId, profileId, identity) {
  const planned = a03Case(variantId, profileId);
  const body = await a03LaunchBody(root, cwd, variantId, profileId, identity);
  if (profileId === "E1" || profileId === "E3") return launch(addon, host, launcher, body);
  const started = await start(addon, host, launcher, body);
  await started.handle.writeFrame(inputFrame(planned.input));
  return { ...started, completion: await started.handle.completed };
}

async function runA08Profile(addon, host, launcher, root, variantId, profileId, identity) {
  const planned = a08Case(variantId, profileId);
  const executionId = createHash("sha256").update(randomUUID()).digest("hex");
  const overrides = { runId: identity.runId, executionId, candidateId: identity.candidateId, buildIdSha256: identity.buildId, sourceSha256: identity.sourceSha256, limits: planned.limits };
  if (profileId === "E1") return launch(addon, host, launcher, await launchBody(root, planned.payload, overrides));
  if (profileId === "E3") return launch(addon, host, launcher, await scriptLaunchBody(root, planned.payload, overrides));
  const started = await start(addon, host, launcher, await terminalLaunchBody(root, profileId, overrides));
  if (planned.input !== null) await started.handle.writeFrame(inputFrame(planned.input));
  return { ...started, completion: await started.handle.completed };
}

async function runA09Profile(addon, host, launcher, root, variantId, profileId, identity) {
  const planned = a09Case(variantId, profileId);
  const executionId = createHash("sha256").update(randomUUID()).digest("hex");
  const overrides = { runId: identity.runId, executionId, candidateId: identity.candidateId, buildIdSha256: identity.buildId, sourceSha256: identity.sourceSha256 };
  const body = profileId === "E1"
    ? await launchBody(root, planned.payload, overrides)
    : profileId === "E3"
      ? await scriptLaunchBody(root, planned.payload, overrides)
      : await terminalLaunchBody(root, profileId, overrides);
  const started = await start(addon, host, launcher, body);
  if (variantId === "A09-01" && planned.input !== null) await started.handle.writeFrame(inputFrame(planned.input));
  if (planned.closeControlChannel) {
    assert.equal(typeof started.handle.closeControlChannel, "function");
    await Promise.race([
      waitFor(async () => {
        const output = decode(started.frames).map(value => value.text).join("");
        return profileId === "E2" || profileId === "E4" ? started.frames.length > 0 : output.includes(planned.readyMarker);
      }),
      started.handle.completed.then(value => { throw new Error(`native host completed before channel-loss stimulus: ${JSON.stringify(value)}`); }),
    ]);
    await started.handle.closeControlChannel();
  } else if (variantId !== "A09-01") await started.handle.terminateHost(terminateFrame(planned.terminateReason));
  return { ...started, completion: await started.handle.completed };
}

async function runA09CrashProfile(addon, host, launcher, root, variantId, profileId, identity) {
  const planned = a09Case(variantId, profileId);
  const executionId = createHash("sha256").update(randomUUID()).digest("hex");
  const overrides = { runId: identity.runId, executionId, candidateId: identity.candidateId, buildIdSha256: identity.buildId, sourceSha256: identity.sourceSha256 };
  const body = profileId === "E1"
    ? await launchBody(root, planned.payload, overrides)
    : profileId === "E3"
      ? await scriptLaunchBody(root, planned.payload, overrides)
      : await terminalLaunchBody(root, profileId, overrides);
  const started = await startLifecycleCrashReceipt(addon, host, launcher, body, variantId);
  await Promise.race([
    waitFor(async () => profileId === "E2" || profileId === "E4" ? started.frames.length > 0 : decode(started.frames).some(value => value.text.includes(planned.readyMarker))),
    started.handle.completed.then(value => { throw new Error(`native host completed before lifecycle crash stimulus: ${JSON.stringify(value)}`); }),
  ]);
  assert.equal(typeof started.handle.triggerLifecycleCrashForReceipt, "function");
  await started.handle.triggerLifecycleCrashForReceipt();
  return { ...started, completion: await started.handle.completed };
}

async function waitFor(check, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for native recovery state");
}

async function recoveryDirectory() {
  assert.equal(typeof process.env.LOCALAPPDATA, "string");
  const nonce = process.env.MINI_LUX_SEC03_NATIVE_TEST_NONCE;
  const leaf = typeof nonce === "string" && /^[0-9a-f]{32}$/u.test(nonce)
    ? `sec03-journal-v2-test-${nonce}`
    : "sec03-journal-v2";
  const directory = path.join(process.env.LOCALAPPDATA, "Mini-Lux", leaf);
  await fs.mkdir(directory, { recursive: true });
  return directory;
}

async function testNativeArtifacts() {
  const [hostBytes, launcherBytes] = await Promise.all([fs.readFile(testHostPath), fs.readFile(testAddonPath)]);
  return {
    host: { bytes: hostBytes.length, sha256: createHash("sha256").update(hostBytes).digest("hex") },
    launcher: { bytes: launcherBytes.length, sha256: createHash("sha256").update(launcherBytes).digest("hex") },
    addon: require(testAddonPath),
  };
}

async function icacls(target, ...args) {
  const executable = path.join(process.env.SystemRoot, "System32", "icacls.exe");
  return execFileAsync(executable, [target, ...args], { windowsHide: true, encoding: "utf8" });
}

async function realHostReceiptContext() {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const host = manifest.outputs.find(value => value.path === "dist/native/sandbox-host.exe");
  const launcher = manifest.outputs.find(value => value.path === "dist/native/sandbox-launcher.node");
  assert.ok(host && launcher);
  const configured = process.env.RAINYDAYS_SEC03_IDENTITY_FILE ? JSON.parse(await fs.readFile(process.env.RAINYDAYS_SEC03_IDENTITY_FILE, "utf8")) : null;
  const buildInfo = configured ? null : JSON.parse(await fs.readFile(path.join(projectRoot, "build-info.json"), "utf8"));
  const identity = {
    runId: configured?.runId ?? randomUUID(),
    candidateId: configured?.candidateId ?? buildInfo.candidateId,
    buildId: configured?.buildId ?? createHash("sha256").update(buildInfo.buildId).digest("hex"),
    sourceSha256: configured?.sourceSha256 ?? buildInfo.sourceDigest,
    hostSha256: host.sha256,
    launcherSha256: launcher.sha256,
    packageSha256: configured?.packageSha256 ?? "5".repeat(64),
  };
  const nativeVerifier = await createSec03NativeVerifier(identity);
  const [matrixBytes, schemaBytes] = await Promise.all([fs.readFile(path.join(projectRoot, "tests/sec03-attack-matrix.json")), fs.readFile(path.join(projectRoot, "tests/sec03-attack-matrix.schema.json"))]);
  const matrix = validateSec03Matrix(JSON.parse(matrixBytes));
  const effectiveIdentity = { ...identity, matrixSha256: createHash("sha256").update(matrixBytes).digest("hex"), schemaSha256: createHash("sha256").update(schemaBytes).digest("hex") };
  const recorder = await receiptRecorder(effectiveIdentity, nativeVerifier);
  return { addon: require(addonPath), host, launcher, identity, effectiveIdentity, matrix, nativeVerifier, recorder };
}

const A11_PROFILES = Object.freeze({ E1: "one-shot-shell", E2: "agent-shell", E3: "script", E4: "manual-terminal" });
const A11_CONTEXT_ID = "sec03-a11-context";
const A11_SESSION_ID = "sec03-a11-session";
const A11_PRINCIPAL = "sec03-a11-agent";
const A11_PERSONA_DIGEST = createHash("sha256").update("sec03-a11-persona").digest("hex");
const A11_POLICY_DIGEST = createHash("sha256").update("sec03-a11-policy").digest("hex");

function a11BridgeIdentity(context) {
  return Object.freeze({
    candidateId: context.identity.candidateId,
    buildIdSha256: context.identity.buildId,
    sourceSha256: context.identity.sourceSha256,
    launcherSha256: context.launcher.sha256,
    launcherBytes: context.launcher.bytes,
    hostSha256: context.host.sha256,
    hostBytes: context.host.bytes,
    machine: "x64",
    protocolVersion: 1,
  });
}

async function a11ExecutionRequest(root, resourceOwner, identity, profileId, payload, now) {
  const body = profileId === "E1"
    ? await launchBody(root, payload)
    : profileId === "E3"
      ? await scriptLaunchBody(root, payload)
      : await terminalLaunchBody(root, profileId);
  const rootIdentity = body.roots[0].identity;
  const binding = bindNativeRootAuthority(Object.freeze({
    rootId: "a11-root",
    access: "read-write",
    canonicalPath: root,
    identity: rootIdentity,
    canonicalCwd: root,
    cwdIdentity: rootIdentity,
  }));
  const identityWithAuthority = Object.freeze({ ...rootIdentity, nativeAuthorityId: binding.nativeAuthorityId });
  return {
    request: {
      contextId: A11_CONTEXT_ID,
      sessionId: A11_SESSION_ID,
      runId: identity.runId,
      principal: A11_PRINCIPAL,
      authorityEpoch: 1,
      personaDigest: A11_PERSONA_DIGEST,
      policyDigest: A11_POLICY_DIGEST,
      resourceOwner,
      entryPoint: profileId,
      profile: A11_PROFILES[profileId],
      payload: Buffer.from(payload),
      roots: [Object.freeze({ rootId: "a11-root", access: "read-write", identity: identityWithAuthority })],
      environment: body.environment,
      network: { mode: "deny" },
      limits: body.limits,
      expiresAtMs: now + 10_000,
    },
    revoke: binding.revoke,
  };
}

async function captureA11Denial(operation, expectedCode) {
  let denial = null;
  await assert.rejects(operation, error => {
    denial = error;
    return error instanceof ExecutionDeniedError && error.code === expectedCode;
  });
  assert(denial?.nativeObservation, `${expectedCode} lacks native service-denial evidence`);
  assert(Buffer.isBuffer(denial.nativeObservation.proof));
  return denial.nativeObservation;
}

async function runA11LaunchDenial(context, root, variantId, profileId) {
  const planned = a11Case(variantId, profileId);
  let now = Date.now();
  const resourceOwner = issueResourceOwner({ authorityId: `sec03-a11-${profileId.toLowerCase()}`, authorityEpoch: 1, sessionId: A11_SESSION_ID, principal: A11_PRINCIPAL, rootIds: ["a11-root"] });
  const bridge = createProductionNativeExecutionBridge(a11BridgeIdentity(context));
  const service = new ExecutionIsolationService(bridge, { now: () => now });
  const prepared = await a11ExecutionRequest(root, resourceOwner, context.identity, profileId, planned.approvedPayload, now);
  const approved = prepared.request;
  try {
    await bridge.initialize?.();
    if (variantId === "A11-01") return await captureA11Denial(() => service.launchOneShot(undefined, resourceOwner, approved), planned.expectedCode);
    if (variantId === "A11-02") return await captureA11Denial(() => service.launchOneShot({ grantId: "forged" }, resourceOwner, approved), planned.expectedCode);
    const grantRequest = variantId === "A11-04" ? { ...approved, expiresAtMs: now + 10 } : approved;
    const grant = service.issueExecutionGrant(grantRequest);
    if (variantId === "A11-03") return await captureA11Denial(() => service.launchOneShot(grant, resourceOwner, { ...approved, payload: Buffer.from(planned.attemptedPayload) }), planned.expectedCode);
    if (variantId === "A11-04") {
      now += 11;
      return await captureA11Denial(() => service.launchOneShot(grant, resourceOwner, grantRequest), planned.expectedCode);
    }
    if (variantId === "A11-05") {
      await service.launchOneShot(grant, resourceOwner, approved);
      return await captureA11Denial(() => service.launchOneShot(grant, resourceOwner, approved), planned.expectedCode);
    }
    if (variantId === "A11-06") return await captureA11Denial(() => service.launchOneShot(grant, resourceOwner, { ...approved, runId: "sec03-a11-cross-run" }), planned.expectedCode);
    if (variantId === "A11-07") return await captureA11Denial(() => service.launchOneShot(grant, resourceOwner, { ...approved, sessionId: "sec03-a11-cross-session" }), planned.expectedCode);
    assert.equal(variantId, "A11-08");
    const first = service.launchOneShot(grant, resourceOwner, approved);
    const observation = await captureA11Denial(() => service.launchOneShot(grant, resourceOwner, approved), planned.expectedCode);
    await first;
    return observation;
  } finally {
    prepared.revoke();
    await service.shutdown();
  }
}

async function runA11InputDenial(context, root, variantId) {
  const planned = a11Case(variantId, "E2");
  let now = Date.now();
  const resourceOwner = issueResourceOwner({ authorityId: "sec03-a11-e2", authorityEpoch: 1, sessionId: A11_SESSION_ID, principal: A11_PRINCIPAL, rootIds: ["a11-root"] });
  const bridge = createProductionNativeExecutionBridge(a11BridgeIdentity(context));
  const service = new ExecutionIsolationService(bridge, { now: () => now });
  const prepared = await a11ExecutionRequest(root, resourceOwner, context.identity, "E2", "cmd", now);
  try {
    await bridge.initialize?.();
    const lease = await service.launchPersistent(service.issueExecutionGrant(prepared.request), resourceOwner, prepared.request);
    const approved = {
      lease,
      resourceOwner,
      contextId: A11_CONTEXT_ID,
      sessionId: A11_SESSION_ID,
      runId: context.identity.runId,
      principal: A11_PRINCIPAL,
      authorityEpoch: 1,
      payload: Buffer.from(planned.approvedPayload),
      appendNewline: true,
      expiresAtMs: now + 1_000,
    };
    const invocation = {
      contextId: approved.contextId,
      sessionId: approved.sessionId,
      runId: approved.runId,
      principal: approved.principal,
      authorityEpoch: approved.authorityEpoch,
      payload: approved.payload,
      appendNewline: approved.appendNewline,
    };
    if (variantId === "A11-01") return await captureA11Denial(() => service.write(lease, undefined, resourceOwner, invocation), planned.expectedCode);
    if (variantId === "A11-02") return await captureA11Denial(() => service.write(lease, { grantId: "forged" }, resourceOwner, invocation), planned.expectedCode);
    const inputRequest = variantId === "A11-04" ? { ...approved, expiresAtMs: now + 10 } : approved;
    const grant = service.issueInputGrant(inputRequest);
    if (variantId === "A11-03") return await captureA11Denial(() => service.write(lease, grant, resourceOwner, { ...invocation, payload: Buffer.from(planned.attemptedPayload) }), planned.expectedCode);
    if (variantId === "A11-04") {
      now += 11;
      return await captureA11Denial(() => service.write(lease, grant, resourceOwner, invocation), planned.expectedCode);
    }
    if (variantId === "A11-05") {
      await service.write(lease, grant, resourceOwner, invocation);
      return await captureA11Denial(() => service.write(lease, grant, resourceOwner, invocation), planned.expectedCode);
    }
    if (variantId === "A11-06") return await captureA11Denial(() => service.write(lease, grant, resourceOwner, { ...invocation, runId: "sec03-a11-cross-run" }), planned.expectedCode);
    if (variantId === "A11-07") return await captureA11Denial(() => service.write(lease, grant, resourceOwner, { ...invocation, sessionId: "sec03-a11-cross-session" }), planned.expectedCode);
    assert.equal(variantId, "A11-08");
    const first = service.write(lease, grant, resourceOwner, invocation);
    const observation = await captureA11Denial(() => service.write(lease, grant, resourceOwner, invocation), planned.expectedCode);
    await first;
    return observation;
  } finally {
    prepared.revoke();
    await service.shutdown();
  }
}

const A12_CONTEXT_ID = "sec03-a12-context";
const A12_SESSION_ID = "sec03-a12-session";
const A12_PERSONA_DIGEST = createHash("sha256").update("sec03-a12-persona").digest("hex");
const A12_POLICY_DIGEST = createHash("sha256").update("sec03-a12-policy").digest("hex");

async function captureA12Denial(operation, expectedCode) {
  let denial = null;
  await assert.rejects(operation, error => {
    denial = error;
    return error instanceof ManualConsentDeniedError && error.code === expectedCode;
  });
  assert(denial?.nativeObservation, `${expectedCode} lacks native consent-denial evidence`);
  assert(Buffer.isBuffer(denial.nativeObservation.proof));
  return denial.nativeObservation;
}

async function runA12Denial(context, variantId) {
  const planned = a12Case(variantId, "E4");
  let now = Date.now();
  let releaseFirst = null;
  let firstDecision = null;
  let executeCalls = 0;
  const bridge = createProductionNativeExecutionBridge(a11BridgeIdentity(context));
  const ledger = new ManualExecutionConsentLedger({
    now: () => now,
    observeDenial: async request => {
      assert.equal(typeof bridge.observeServiceDenial, "function");
      return bridge.observeServiceDenial(request);
    },
  });
  const presence = Object.freeze({
    windowId: 101,
    webContentsId: 202,
    sessionId: A12_SESSION_ID,
    runtimeAuthorityId: "sec03-a12-authority",
    authorityEpoch: 1,
    incarnationId: "sec03-a12-incarnation",
    topFrame: true,
    windowVisible: true,
    windowFocused: true,
  });
  const evidence = Object.freeze({
    contextId: A12_CONTEXT_ID,
    sessionId: A12_SESSION_ID,
    runId: context.identity.runId,
    authorityEpoch: 1,
    personaDigest: A12_PERSONA_DIGEST,
    policyDigest: A12_POLICY_DIGEST,
  });
  const challenge = ledger.prepare({
    operation: "terminal-input",
    presence,
    request: planned.request,
    display: Object.freeze({ operationLabel: "Send input", targetLabel: "sec03-a12-terminal", rootAlias: "terminal", preview: "echo SEC03_A12_EXACT" }),
    evidence,
  });
  const decision = {
    challengeId: challenge.challengeId,
    decision: "approve",
    operation: "terminal-input",
    argumentsDigest: challenge.argumentsDigest,
    presence,
    evidence,
  };
  const executeStored = async () => { executeCalls += 1; };
  try {
    await bridge.initialize?.();
    let observation;
    if (variantId === "A12-01") {
      observation = await captureA12Denial(() => ledger.decide({ ...decision, decision: "deny" }, executeStored), planned.expectedCode);
    } else if (variantId === "A12-02") {
      observation = await captureA12Denial(() => ledger.decide({ ...decision, decision: "dismiss" }, executeStored), planned.expectedCode);
    } else if (variantId === "A12-03") {
      now += 15_001;
      observation = await captureA12Denial(() => ledger.decide(decision, executeStored), planned.expectedCode);
    } else if (variantId === "A12-04") {
      observation = await captureA12Denial(() => ledger.decide({ ...decision, argumentsDigest: "f".repeat(64) }, executeStored), planned.expectedCode);
    } else if (variantId === "A12-05") {
      await ledger.decide(decision, executeStored);
      observation = await captureA12Denial(() => ledger.decide(decision, executeStored), planned.expectedCode);
    } else if (variantId === "A12-06") {
      observation = await captureA12Denial(() => ledger.decide({ ...decision, presence: { ...presence, topFrame: false } }, executeStored), planned.expectedCode);
    } else if (variantId === "A12-07") {
      observation = await captureA12Denial(() => ledger.decide({ ...decision, presence: { ...presence, windowId: 303 } }, executeStored), planned.expectedCode);
    } else if (variantId === "A12-08") {
      observation = await captureA12Denial(() => ledger.decide({ ...decision, presence: { ...presence, sessionId: "sec03-a12-cross-session" } }, executeStored), planned.expectedCode);
    } else {
      assert.equal(variantId, "A12-09");
      const gate = new Promise(resolve => { releaseFirst = resolve; });
      firstDecision = ledger.decide(decision, async () => { executeCalls += 1; await gate; });
      observation = await captureA12Denial(() => ledger.decide(decision, executeStored), planned.expectedCode);
      releaseFirst();
      await firstDecision;
      firstDecision = null;
    }
    assert.equal(executeCalls, variantId === "A12-05" || variantId === "A12-09" ? 1 : 0);
    return observation;
  } finally {
    if (releaseFirst) releaseFirst();
    if (firstDecision) await firstDecision.catch(() => undefined);
    ledger.shutdown();
    await bridge.shutdown();
  }
}

async function runA19Denial(context, root) {
  const planned = a19Case("A19-01", "E4");
  const now = Date.now();
  const resourceOwner = issueResourceOwner({ authorityId: "sec03-a19-e4", authorityEpoch: 1, sessionId: A11_SESSION_ID, principal: "local-user-api", rootIds: ["a11-root"] });
  const bridge = createProductionNativeExecutionBridge(a11BridgeIdentity(context));
  const service = new ExecutionIsolationService(bridge, { now: () => now });
  const prepared = await a11ExecutionRequest(root, resourceOwner, context.identity, "E4", planned.payload, now);
  const attempted = Object.freeze({
    ...prepared.request,
    principal: "local-user-api",
    network: Object.freeze({ mode: "brokered", operationsDigest: createHash("sha256").update("sec03-a19-broker").digest("hex") }),
  });
  try {
    await bridge.initialize?.();
    return await captureA11Denial(() => service.issueExecutionGrantAuthenticated(attempted), planned.expectedCode);
  } finally {
    prepared.revoke();
    await service.shutdown();
  }
}

async function a18RootDescriptor(canonicalPath, reparse = false) {
  const info = await (reparse ? fs.lstat(canonicalPath, { bigint: true }) : fs.stat(canonicalPath, { bigint: true }));
  assert(reparse ? info.isSymbolicLink() : info.isDirectory(), `A18 root object is not the expected directory type: ${canonicalPath}`);
  const identity = { volumeSerial: String(info.dev), fileId: String(info.ino), type: "directory" };
  return { rootId: "a18-root", access: "read", canonicalPath, identity, canonicalCwd: canonicalPath, cwdIdentity: identity };
}

async function discoverA18StorageRoots() {
  const powershell = `
    [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
    $remote = Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -eq 4 } | Select-Object -First 1
    $nonNtfs = Get-Volume | Where-Object { $_.DriveLetter -and $_.DriveType -eq 'Fixed' -and $_.FileSystemType -ne 'NTFS' } | Select-Object -First 1
    $removable = Get-Volume | Where-Object { $_.DriveLetter -and $_.DriveType -eq 'Removable' -and $_.FileSystemType -eq 'NTFS' } | Select-Object -First 1
    [ordered]@{
      unc = if ($remote) { $remote.ProviderName } else { $null }
      mapped = if ($remote) { $remote.DeviceID + '\\' } else { $null }
      nonNtfs = if ($nonNtfs) { [string]$nonNtfs.DriveLetter + ':\\' } else { $null }
      removableNtfs = if ($removable) { [string]$removable.DriveLetter + ':\\' } else { $null }
    } | ConvertTo-Json -Compress
  `;
  const { stdout } = await execFileAsync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", powershell], { windowsHide: true, encoding: "utf8" });
  const discovered = JSON.parse(stdout.trim());
  return {
    "A18-01": process.env.MINI_LUX_SEC03_A18_UNC_ROOT ?? discovered.unc,
    "A18-02": process.env.MINI_LUX_SEC03_A18_MAPPED_ROOT ?? discovered.mapped,
    "A18-03": process.env.MINI_LUX_SEC03_A18_NON_NTFS_ROOT ?? discovered.nonNtfs,
    "A18-04": process.env.MINI_LUX_SEC03_A18_REMOVABLE_NTFS_ROOT ?? discovered.removableNtfs,
  };
}

async function a18LaunchBody(safeRoot, unsupportedRoot, profileId, identity) {
  const executionId = createHash("sha256").update(randomUUID()).digest("hex");
  const overrides = { runId: identity.runId, executionId, candidateId: identity.candidateId, buildIdSha256: identity.buildId, sourceSha256: identity.sourceSha256, roots: [unsupportedRoot] };
  if (profileId === "E1") return launchBody(safeRoot, "echo MUST_NOT_RUN", overrides);
  if (profileId === "E3") return scriptLaunchBody(safeRoot, `console.log("MUST_NOT_RUN");`, overrides);
  return terminalLaunchBody(safeRoot, profileId, overrides);
}

function blockedCapability(label, error) {
  const detail = error instanceof Error ? `${error.code ? `${error.code}: ` : ""}${error.message}` : String(error);
  return Object.assign(new Error(`BLOCKED: SEC-03 ${label}: ${detail}`), { code: "BLOCKED", cause: error });
}

function adminUnc(target) {
  const root = path.parse(target).root;
  return `\\\\localhost\\${root[0]}$\\${target.slice(root.length).split(path.sep).join("\\")}`;
}

async function createA02Fixture() {
  await fs.mkdir(testNativeDirectory, { recursive: true });
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "sec03-a02-"));
  const root = path.join(parent, "root");
  const outside = path.join(parent, "outside-canary.txt");
  const anotherDrive = A02_ANOTHER_DRIVE_PATH;
  let anotherDriveCreated = false;
  try {
    if (path.parse(parent).root.toLowerCase() === path.parse(anotherDrive).root.toLowerCase()) throw blockedCapability("A02-03 another fixed drive", new Error("repository test volume is the system volume"));
    await fs.mkdir(root);
    await fs.writeFile(outside, "SEC03_A02_OUTSIDE", "utf8");
    await fs.mkdir(path.join(parent, "sec03-a02-sibling"));
    await fs.writeFile(path.join(parent, "sec03-a02-sibling", "canary.txt"), "SEC03_A02_SIBLING", "utf8");
    await fs.writeFile(path.join(root, "ads-base.txt"), "base", "utf8");
    await fs.writeFile(`${path.join(root, "ads-base.txt")}:sec03`, "SEC03_A02_ADS", "utf8");
    await fs.symlink(outside, path.join(root, "outside-symlink.txt"), "file");
    const junctionTarget = path.join(parent, "junction-target");
    await fs.mkdir(junctionTarget);
    await fs.writeFile(path.join(junctionTarget, "canary.txt"), "SEC03_A02_JUNCTION", "utf8");
    await fs.symlink(junctionTarget, path.join(root, "outside-junction"), "junction");
    const hardlinkSource = path.join(parent, "hardlink-source.txt");
    await fs.writeFile(hardlinkSource, "SEC03_A02_HARDLINK", "utf8");
    await fs.link(hardlinkSource, path.join(root, "outside-hardlink.txt"));
    await fs.writeFile(anotherDrive, "SEC03_A02_ANOTHER_DRIVE", { encoding: "utf8", flag: "wx" });
    anotherDriveCreated = true;
    const slash = String.fromCharCode(92);
    const namespaceTargets = [adminUnc(outside), `${slash}${slash}?${slash}${outside}`, `${slash}${slash}.${slash}${outside}`];
    const readable = [
      outside,
      path.join(parent, "sec03-a02-sibling", "canary.txt"),
      anotherDrive,
      ...namespaceTargets,
      `${path.join(root, "ads-base.txt")}:sec03`,
      path.join(root, "outside-symlink.txt"),
      path.join(root, "outside-junction", "canary.txt"),
      path.join(root, "outside-hardlink.txt"),
    ];
    for (const target of readable) assert.ok((await fs.readFile(target)).length > 0, `A02 fixture is not host-readable: ${target}`);
    return {
      root,
      outside,
      hardlinkSource,
      junctionTarget,
      async close() {
        await fs.rm(parent, { recursive: true, force: true });
        if (anotherDriveCreated) await fs.rm(anotherDrive, { force: true });
      },
    };
  } catch (error) {
    await fs.rm(parent, { recursive: true, force: true }).catch(() => undefined);
    if (anotherDriveCreated) await fs.rm(anotherDrive, { force: true }).catch(() => undefined);
    if (error?.code === "BLOCKED") throw error;
    throw blockedCapability("A02 authentic fixture construction", error);
  }
}

async function closeServer(server) {
  await new Promise(resolve => server.close(resolve));
}

async function probeListenAvailable(host, port) {
  const server = net.createServer();
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  } finally {
    if (server.listening) await closeServer(server);
  }
}

async function createA04Fixture() {
  const external = a04ExternalAddress();
  if (!external) throw blockedCapability("A04 external address", new Error("no non-loopback IPv4 address exists"));
  const counts = Object.fromEntries(["A04-01", "A04-02", "A04-03", "A04-04", "A04-05"].map(key => [key, 0]));
  const servers = [];
  try {
    const dnsServer = dgram.createSocket("udp4");
    dnsServer.on("message", (message, remote) => {
      counts["A04-01"] += 1;
      const response = Buffer.from(message);
      if (response.length >= 12) { response[2] |= 0x80; response[3] = (response[3] & 0xf0) | 3; }
      dnsServer.send(response, remote.port, remote.address);
    });
    await new Promise((resolve, reject) => { dnsServer.once("error", reject); dnsServer.bind(A04_PORTS.dns, "127.0.0.1", resolve); });
    servers.push(dnsServer);
    const udpServer = dgram.createSocket("udp4");
    udpServer.on("message", (message, remote) => {
      counts["A04-03"] += 1;
      udpServer.send(message, remote.port, remote.address);
    });
    await new Promise((resolve, reject) => { udpServer.once("error", reject); udpServer.bind(A04_PORTS.udp, external, resolve); });
    servers.push(udpServer);
    for (const [variantId, host, port] of [["A04-02", external, A04_PORTS.externalTcp], ["A04-04", "127.0.0.1", A04_PORTS.loopback]]) {
      const server = net.createServer(socket => { counts[variantId] += 1; socket.destroy(); });
      await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
      servers.push(server);
    }
    await probeListenAvailable(external, A04_PORTS.listen);
    const connect = (host, port) => new Promise((resolve, reject) => { const socket = net.createConnection({ host, port }); socket.once("connect", () => socket.end()); socket.once("close", resolve); socket.once("error", reject); });
    const send = (bytes, port, host) => new Promise((resolve, reject) => {
      const socket = dgram.createSocket("udp4");
      socket.send(bytes, port, host, error => { socket.close(); if (error) reject(error); else resolve(); });
    });
    await connect(external, A04_PORTS.externalTcp);
    await connect("127.0.0.1", A04_PORTS.loopback);
    await send(Buffer.alloc(12), A04_PORTS.dns, "127.0.0.1");
    await send(Buffer.from("preflight"), A04_PORTS.udp, external);
    await waitFor(async () => counts["A04-01"] === 1 && counts["A04-02"] === 1 && counts["A04-03"] === 1 && counts["A04-04"] === 1);
    for (const key of Object.keys(counts)) counts[key] = 0;
    return {
      external,
      async accepted(variantId) {
        await new Promise(resolve => setTimeout(resolve, 100));
        if (variantId === "A04-05") await probeListenAvailable(external, A04_PORTS.listen);
        return counts[variantId];
      },
      async close() {
        for (const server of servers.reverse()) {
          if ("close" in server) await new Promise(resolve => server.close(resolve));
        }
      },
    };
  } catch (error) {
    for (const server of servers.reverse()) await new Promise(resolve => server.close(resolve)).catch(() => undefined);
    if (error?.code === "BLOCKED") throw error;
    throw blockedCapability("A04 host-side listeners", error);
  }
}

const windowsTest = process.platform === "win32" && process.arch === "x64" ? test : test.skip;

windowsTest("SEC-03 native E1 uses real AppContainer/Job, denies ambient user data/env/network, and has no fallback", async () => {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const host = manifest.outputs.find((value) => value.path === "dist/native/sandbox-host.exe");
  const launcher = manifest.outputs.find((value) => value.path === "dist/native/sandbox-launcher.node");
  assert.ok(host && launcher);
  const addon = require(addonPath);
  assert.equal(addon.protocolVersion, 1);
  assert.deepEqual(Object.keys(addon).sort(), ["openEvidenceVerifier", "openExclusiveHostLease", "protocolVersion"]);
  assert.equal("sign" in addon, false);
  assert.equal("createReceipt" in addon, false);

  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec03-native-"));
  const root = path.join(parent, "root");
  const outside = path.join(parent, "outside-canary.txt");
  await fs.mkdir(root);
  await fs.writeFile(outside, "must-not-read", "utf8");
  process.env.SEC03_PARENT_SENTINEL = "must-not-inherit";
  let accepted = 0;
  const server = createServer((_request, response) => { accepted += 1; response.end("forbidden"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  try {
    const positive = await launch(addon, host, launcher, await launchBody(root, "echo SEC03_NATIVE_E1_OK"));
    const positiveOutput = decode(positive.frames).map((value) => value.text).join("");
    assert.deepEqual({ exitCode: positive.completion.exitCode, reason: positive.completion.reason }, { exitCode: 0, reason: "completed" }, positiveOutput);
    assert.match(positiveOutput, /SEC03_NATIVE_E1_OK/);
    assert.match(positiveOutput, /SEC03_EVIDENCE profile=E1 appcontainer=1 capabilities=0 job=1 lowIL=1 childExit=0/);

    const outsideDenied = await launch(addon, host, launcher, await launchBody(root, `type "${outside}" >nul`));
    assert.match(decode(outsideDenied.frames).map((value) => value.text).join(""), /childExit=[1-9][0-9]*/);

    const environmentDenied = await launch(addon, host, launcher, await launchBody(root, "if defined SEC03_PARENT_SENTINEL (exit /b 91) else (exit /b 7)"));
    assert.match(decode(environmentDenied.frames).map((value) => value.text).join(""), /childExit=7/);

    const networkDenied = await launch(addon, host, launcher, await launchBody(root, `curl.exe -s --max-time 2 http://127.0.0.1:${address.port}/ >nul`));
    assert.match(decode(networkDenied.frames).map((value) => value.text).join(""), /childExit=[1-9][0-9]*/);
    assert.equal(accepted, 0);
  } finally {
    delete process.env.SEC03_PARENT_SENTINEL;
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(parent, { recursive: true, force: true });
  }
});

windowsTest("SEC-03 J5 reuses the retained nested CWD identity lock", async () => {
  const { host, launcher, addon } = await testNativeArtifacts();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec03-nested-cwd-"));
  const cwd = path.join(root, "nested-cwd");
  const marker = "SEC03_NESTED_CWD_OK";
  try {
    await fs.mkdir(cwd);
    const cwdInfo = await fs.stat(cwd, { bigint: true });
    const body = await launchBody(root, `cd && echo ${marker}`);
    body.roots[0].canonicalCwd = cwd;
    body.roots[0].cwdIdentity = { volumeSerial: String(cwdInfo.dev), fileId: String(cwdInfo.ino), type: "directory" };
    const result = await launch(addon, host, launcher, body);
    const output = decode(result.frames).map(value => value.text).join("");
    assert.deepEqual({ exitCode: result.completion.exitCode, reason: result.completion.reason }, { exitCode: 0, reason: "completed" });
    assert.match(output, new RegExp(marker));
    assert.equal(output.toLowerCase().includes(cwd.toLowerCase()), true);
  } finally {
    const recoveryLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
    await recoveryLease.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});

windowsTest("SEC-03 native execution proof is fixed-identity, host-produced, and verify-only", async () => {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const host = manifest.outputs.find((value) => value.path === "dist/native/sandbox-host.exe");
  const launcher = manifest.outputs.find((value) => value.path === "dist/native/sandbox-launcher.node");
  assert.ok(host && launcher);
  const addon = require(addonPath);
  assert.deepEqual(Object.keys(addon).sort(), ["openEvidenceVerifier", "openExclusiveHostLease", "protocolVersion"]);
  const configuredIdentity = process.env.RAINYDAYS_SEC03_IDENTITY_FILE ? JSON.parse(await fs.readFile(process.env.RAINYDAYS_SEC03_IDENTITY_FILE, "utf8")) : null;
  const candidateId = configuredIdentity?.candidateId ?? "c".repeat(64);
  const buildIdSha256 = configuredIdentity?.buildId ?? "d".repeat(64);
  const sourceSha256 = configuredIdentity?.sourceSha256 ?? "e".repeat(64);
  assert.throws(() => addon.openEvidenceVerifier(candidateId, buildIdSha256, sourceSha256, "0".repeat(64), launcher.sha256), error => error?.code === "EXEC_NATIVE_IDENTITY_INVALID");
  assert.throws(() => addon.openEvidenceVerifier(candidateId, buildIdSha256, sourceSha256, host.sha256, "0".repeat(64)), error => error?.code === "EXEC_NATIVE_IDENTITY_INVALID");

  const verifier = addon.openEvidenceVerifier(candidateId, buildIdSha256, sourceSha256, host.sha256, launcher.sha256);
  assert.deepEqual(Object.keys(verifier).sort(), ["createProjectionObservation", "keyId", "verifyExecutionProof", "verifyLauncherObservation"]);
  assert.equal("sign" in verifier, false);
  assert.equal("mac" in verifier, false);
  assert.equal("createReceipt" in verifier, false);

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec03-proof-"));
  const command = "echo SEC03_PROOF_CANARY";
  const runId = configuredIdentity?.runId ?? randomUUID();
  const executionNonce = createHash("sha256").update(randomUUID()).digest("hex");
  try {
    const result = await launch(addon, host, launcher, await launchBody(root, command, { runId, executionId: executionNonce, candidateId, buildIdSha256, sourceSha256 }));
    const proofOutput = decode(result.frames).map(value => value.text).join("");
    assert.equal(result.completion.exitCode, 0, proofOutput);
    assert.equal(result.completion.reason, "completed", proofOutput);
    const nativeProof = result.completion.nativeProof;
    assert.ok(nativeProof && Buffer.isBuffer(nativeProof.proof));
    assert.equal(nativeProof.keyId, verifier.keyId);
    assert.match(nativeProof.mac, /^[a-f0-9]{64}$/u);
    assert.match(nativeProof.channelMarker, /^[a-f0-9]{64}$/u);
    const proofText = nativeProof.proof.toString("utf8");
    const proofFields = Object.fromEntries(proofText.trimEnd().split("\n").map(line => { const separator = line.indexOf("="); return [line.slice(0, separator), line.slice(separator + 1)]; }));
    assert.match(proofText, /^v=1\nkind=execution-proof\n/u);
    assert.equal(proofFields.profile, "one-shot-shell");
    assert.equal(proofFields.tokenIsAppContainer, "1");
    assert.match(proofFields.packageSidSha256, /^[a-f0-9]{64}$/u);
    assert.equal(proofFields.capabilityCount, "0");
    assert.equal(proofFields.lowIntegrity, "1");
    assert.equal(proofFields.jobConstrained, "1");
    assert.match(proofFields.jobPolicySha256, /^[a-f0-9]{64}$/u);
    assert.equal(proofFields.activeProcessZero, "1");
    assert.equal(proofFields.cleanupComplete, "1");
    assert.doesNotMatch(proofText, /SEC03_PROOF_CANARY/u);
    assert.equal(proofText.includes(root), false);
    assert.equal(proofText.includes(command), false);

    const verified = verifier.verifyExecutionProof(nativeProof.proof, nativeProof.mac, nativeProof.channelMarker);
    assert.equal(verified.authenticated, true);
    assert.equal(verified.testOnly, false);
    assert.match(verified.attestationSha256, /^[a-f0-9]{64}$/u);

    assert.equal(proofFields.candidate, candidateId);
    assert.equal(proofFields.buildIdSha256, buildIdSha256);
    assert.equal(proofFields.sourceSha256, sourceSha256);
    assert.equal(proofFields.hostSha256, host.sha256);
    const verifierIdentity = { runId: proofFields.run, candidateId, buildId: buildIdSha256, sourceSha256, hostSha256: host.sha256, launcherSha256: launcher.sha256 };
    const fixedVerifier = await createSec03NativeVerifier(verifierIdentity);
    const envelope = {
      producer: { kind: "sandbox-host", hostSha256: host.sha256, launcherSha256: launcher.sha256, instanceSha256: createHash("sha256").update(`${nativeProof.keyId}\0${proofFields.execution}`).digest("hex") },
      runId: proofFields.run, candidateId, buildId: buildIdSha256, executionNonce: proofFields.execution,
      layer: "real-host", familyId: "A16", variantId: "A16-01", profileId: "E1", observedCode: "OBS_POSITIVE_COMPLETE", observedSubcode: null,
      transcriptSha256: proofFields.transcriptSha256, transcriptMac: nativeProof.mac, launcherChannelMarker: nativeProof.channelMarker,
      sideEffects: { processStarts: Number(proofFields.processStarts), aclMutations: Number(proofFields.aclMutations), stdinWrites: Number(proofFields.stdinWrites) },
      token: { isAppContainer: true, packageSidSha256: proofFields.packageSidSha256, capabilityCount: 0, integrity: "low" },
      job: { policySha256: proofFields.jobPolicySha256, activeProcessZero: true },
      root: { identitySha256: proofFields.rootIdentityDigest, accessProfileSha256: proofFields.rootAccessProfileSha256 },
      environment: { nameSetSha256: proofFields.environmentNameDigest, valueSetSha256: proofFields.environmentValueDigest, ambientLeakCount: 0 },
      network: { mode: "deny", attemptCount: 0, acceptedCount: 0 },
      termination: { reason: proofFields.completionReason, exitCode: Number(proofFields.childExit), treeTerminated: true, activeProcessZero: true },
      cleanup: { jobClosed: true, handlesDrained: true, hostExited: true, aclProfileSha256: proofFields.aclProfileSha256 },
      nativeProof: { kind: "execution-proof", proofBase64: nativeProof.proof.toString("base64"), mac: nativeProof.mac, keyId: nativeProof.keyId, channelMarker: nativeProof.channelMarker },
    };
    const [matrixBytes, schemaBytes] = await Promise.all([
      fs.readFile(path.join(projectRoot, "tests/sec03-attack-matrix.json")),
      fs.readFile(path.join(projectRoot, "tests/sec03-attack-matrix.schema.json")),
    ]);
    const matrix = validateSec03Matrix(JSON.parse(matrixBytes));
    const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A16" && value.variantId === "A16-01" && value.profileId === "E1");
    assert.ok(record);
    assert.deepEqual(fixedVerifier.verifyNativeEvidence(envelope, { identity: verifierIdentity, record }), verified);
    assert.throws(() => fixedVerifier.verifyNativeEvidence({ ...envelope, observedCode: "OBS_FS_DENIED" }, { identity: verifierIdentity, record }), /observed code differs/u);
    const receiptIdentity = { ...verifierIdentity, matrixSha256: createHash("sha256").update(matrixBytes).digest("hex"), schemaSha256: createHash("sha256").update(schemaBytes).digest("hex"), packageSha256: configuredIdentity?.packageSha256 ?? "5".repeat(64) };
    const receipt = createSec03Receipt(record, receiptIdentity, envelope, fixedVerifier);
    validateSec03Receipt(receipt, { matrix, identity: receiptIdentity, nativeVerifier: fixedVerifier });
    const partial = aggregateSec03Receipts([receipt], { matrix, identity: receiptIdentity, nativeVerifier: fixedVerifier });
    assert.equal(partial.validCount, 1);
    assert.equal(partial.complete, false);
    assert.equal(partial.missingKeys.length, 481);
    const reopened = addon.openEvidenceVerifier(candidateId, buildIdSha256, sourceSha256, host.sha256, launcher.sha256);
    assert.equal(reopened.keyId, verifier.keyId);
    assert.deepEqual(reopened.verifyExecutionProof(nativeProof.proof, nativeProof.mac, nativeProof.channelMarker), verified);
    const crossCandidate = addon.openEvidenceVerifier("f".repeat(64), buildIdSha256, sourceSha256, host.sha256, launcher.sha256);
    assert.notEqual(crossCandidate.keyId, verifier.keyId);
    assert.throws(() => crossCandidate.verifyExecutionProof(nativeProof.proof, nativeProof.mac, nativeProof.channelMarker), error => error?.code === "EXEC_NATIVE_EVIDENCE_INVALID");

    const changedProof = Buffer.from(nativeProof.proof);
    changedProof[changedProof.length - 2] ^= 1;
    assert.throws(() => reopened.verifyExecutionProof(changedProof, nativeProof.mac, nativeProof.channelMarker), error => error?.code === "EXEC_NATIVE_EVIDENCE_INVALID");
    const changedMac = `${nativeProof.mac[0] === "0" ? "1" : "0"}${nativeProof.mac.slice(1)}`;
    assert.throws(() => reopened.verifyExecutionProof(nativeProof.proof, changedMac, nativeProof.channelMarker), error => error?.code === "EXEC_NATIVE_EVIDENCE_INVALID");
    const changedMarker = `${nativeProof.channelMarker[0] === "0" ? "1" : "0"}${nativeProof.channelMarker.slice(1)}`;
    assert.throws(() => reopened.verifyExecutionProof(nativeProof.proof, nativeProof.mac, changedMarker), error => error?.code === "EXEC_NATIVE_EVIDENCE_INVALID");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

windowsTest("SEC-03 real-host receipt harness authenticates fixed A15 native identity denials", { timeout: 60_000 }, async () => {
  const { addon, host, launcher, identity, effectiveIdentity, matrix, nativeVerifier, recorder } = await realHostReceiptContext();
  const subject = await fs.mkdtemp(path.join(os.tmpdir(), "mls3a15-"));
  const stagedLauncher = path.join(subject, "sandbox-launcher.node");
  const stagedHost = path.join(subject, "sandbox-host.exe");
  const stagedExtra = path.join(subject, "unexpected-native.bin");
  const stagedManifest = path.join(subject, "sec03-native-manifest.json");
  const receipts = [];
  const envelopes = new Map();
  const stage = async (variantId) => {
    await Promise.all([fs.rm(stagedLauncher, { force: true }), fs.rm(stagedHost, { force: true }), fs.rm(stagedExtra, { force: true }), fs.rm(stagedManifest, { force: true })]);
    if (variantId !== "A15-01" && variantId !== "A15-07" && variantId !== "A15-09") await fs.copyFile(addonPath, stagedLauncher);
    if (variantId !== "A15-02" && variantId !== "A15-07" && variantId !== "A15-09") await fs.copyFile(path.join(projectRoot, "dist/native/sandbox-host.exe"), stagedHost);
    if (variantId === "A15-03") await fs.writeFile(stagedExtra, A15_EXTRA_ARTIFACT, "utf8");
    if (variantId === "A15-07") {
      let text = await fs.readFile(manifestPath, "utf8");
      const manifest = JSON.parse(text);
      const hostOutput = manifest.outputs.find(value => value.path === "dist/native/sandbox-host.exe");
      assert.match(hostOutput?.importedDllAllowlistDigest, /^[a-f0-9]{64}$/u);
      const pathField = `"path": "${hostOutput.path}"`;
      const importField = `"importedDllAllowlistDigest": "${hostOutput.importedDllAllowlistDigest}"`;
      const pathPosition = text.indexOf(pathField);
      const importPosition = text.indexOf(importField, pathPosition);
      assert(pathPosition >= 0 && importPosition > pathPosition && importPosition < pathPosition + 384);
      text = `${text.slice(0, importPosition)}"importedDllAllowlistDigest": "${"0".repeat(64)}"${text.slice(importPosition + importField.length)}`;
      await fs.writeFile(stagedManifest, text, "utf8");
    }
    if (variantId === "A15-09") {
      let text = await fs.readFile(manifestPath, "utf8");
      const manifest = JSON.parse(text);
      for (const [key, replacement] of [["sourceDigest", "0"], ["toolchainDigest", "1"]]) {
        const needle = `"${key}": "${manifest[key]}"`;
        assert.notEqual(text.indexOf(needle), -1);
        assert.equal(text.indexOf(needle), text.lastIndexOf(needle));
        text = text.replace(needle, `"${key}": "${replacement.repeat(64)}"`);
      }
      await fs.writeFile(stagedManifest, text, "utf8");
    }
    if (variantId === "A15-04") await fs.appendFile(stagedLauncher, "mini-lux/sec03/A15-04", "utf8");
    if (variantId === "A15-05") await fs.appendFile(stagedHost, "mini-lux/sec03/A15-05", "utf8");
    if (variantId === "A15-06") {
      const bytes = await fs.readFile(stagedHost);
      const peOffset = bytes.readUInt32LE(0x3c);
      assert.equal(bytes.readUInt16LE(peOffset + 4), 0x8664);
      bytes.writeUInt16LE(0x014c, peOffset + 4);
      await fs.writeFile(stagedHost, bytes);
    }
  };
  try {
    for (const variantId of ["A15-01", "A15-02", "A15-03", "A15-04", "A15-05", "A15-06", "A15-07", "A15-08", "A15-09"]) {
      await stage(variantId);
      for (const profileId of ["E1", "E2", "E3", "E4"]) {
        const planned = a15Case(variantId, profileId);
        const observationSubject = variantId === "A15-08" ? "fixed-host-directory" : subject;
        const nativeObservation = await observeA15NativeIdentity(addon, host, launcher, observationSubject, variantId, profileId, identity);
        const { fields, envelope } = evidenceFromLauncherObservation({ nativeObservation, host, launcher, familyId: "A15", variantId, profileId });
        assert.equal(fields.observationClass, "native-identity-denial");
        assert.equal(fields.raceStage, "native-projection-validation");
        assert.equal(fields.decisionState, planned.decisionState);
        assert.equal(fields.observedCode, planned.expectedCode);
        assert.equal(fields.processStarts, "0");
        assert.equal(fields.profileCreates, "0");
        assert.equal(fields.journalWrites, "0");
        assert.equal(fields.aclMutations, "0");
        const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A15" && value.variantId === variantId && value.profileId === profileId);
        assert.ok(record);
        const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
        validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
        receipts.push(receipt);
        envelopes.set(`${variantId}/${profileId}`, envelope);
        if (recorder.enabled) await recorder.record("real-host", "A15", variantId, profileId, envelope);
      }
    }
    const wrongRecord = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A15" && value.variantId === "A15-01" && value.profileId === "E1");
    assert.ok(wrongRecord);
    assert.throws(() => createSec03Receipt(wrongRecord, effectiveIdentity, { ...envelopes.get("A15-02/E1"), variantId: "A15-01" }, nativeVerifier));

    await stage("A15-02");
    await assert.rejects(
      () => Promise.resolve().then(() => observeA15NativeIdentity(addon, host, launcher, subject, "A15-01", "E1", identity)),
      error => error?.code === "EXEC_NATIVE_IDENTITY_INVALID",
    );
  } finally {
    await fs.rm(subject, { recursive: true, force: true });
  }
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  assert.equal(partial.validCount, 36);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 446);
  assert.equal(partial.mockCount, 0);
  assert.equal(partial.testOnlyCount, 0);
});

windowsTest("SEC-03 real-host receipt harness authenticates A16 fixed NTFS positives across E1-E4", { timeout: 60_000 }, async () => {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const host = manifest.outputs.find(value => value.path === "dist/native/sandbox-host.exe");
  const launcher = manifest.outputs.find(value => value.path === "dist/native/sandbox-launcher.node");
  assert.ok(host && launcher);
  const addon = require(addonPath);
  const configured = process.env.RAINYDAYS_SEC03_IDENTITY_FILE ? JSON.parse(await fs.readFile(process.env.RAINYDAYS_SEC03_IDENTITY_FILE, "utf8")) : null;
  const identity = {
    runId: configured?.runId ?? randomUUID(),
    candidateId: configured?.candidateId ?? "c".repeat(64),
    buildId: configured?.buildId ?? "d".repeat(64),
    sourceSha256: configured?.sourceSha256 ?? "e".repeat(64),
    hostSha256: host.sha256,
    launcherSha256: launcher.sha256,
    packageSha256: configured?.packageSha256 ?? "5".repeat(64),
  };
  const nativeVerifier = await createSec03NativeVerifier(identity);
  const [matrixBytes, schemaBytes] = await Promise.all([
    fs.readFile(path.join(projectRoot, "tests/sec03-attack-matrix.json")),
    fs.readFile(path.join(projectRoot, "tests/sec03-attack-matrix.schema.json")),
  ]);
  const matrix = validateSec03Matrix(JSON.parse(matrixBytes));
  const effectiveIdentity = { ...identity, matrixSha256: createHash("sha256").update(matrixBytes).digest("hex"), schemaSha256: createHash("sha256").update(schemaBytes).digest("hex") };
  const recorder = await receiptRecorder(effectiveIdentity, nativeVerifier);
  const receipts = [];
  const roots = [];
  try {
    const asciiRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mls3a16-"));
    const unicodeParent = await fs.mkdtemp(path.join(os.tmpdir(), "mls3a16u-"));
    const unicodeRoot = path.join(unicodeParent, "工作 空间");
    await fs.mkdir(unicodeRoot);
    roots.push(asciiRoot, unicodeParent);
    const variants = [["A16-01", asciiRoot], ["A16-02", unicodeRoot]];
    if (process.env.MINI_LUX_SEC03_A16_FIXED_NTFS_ROOT) {
      const fixtureRoot = path.resolve(process.env.MINI_LUX_SEC03_A16_FIXED_NTFS_ROOT);
      const fixtureInfo = await fs.lstat(fixtureRoot);
      assert(fixtureInfo.isDirectory() && !fixtureInfo.isSymbolicLink(), "A16-03 fixed NTFS fixture root is not a regular directory");
      assert.equal(await fs.realpath(fixtureRoot), fixtureRoot, "A16-03 fixed NTFS fixture root is not canonical");
      const separateRoot = await fs.mkdtemp(path.join(fixtureRoot, "mls3a16v-"));
      roots.push(separateRoot);
      variants.push(["A16-03", separateRoot]);
    }
    for (const [variantId, root] of variants) {
      for (const profileId of ["E1", "E2", "E3", "E4"]) {
        const result = await runPositiveProfile(addon, host, launcher, root, profileId, identity);
        assert.equal(result.completion.exitCode, 0);
        assert.equal(result.completion.reason, "completed");
        const { envelope } = evidenceFromNativeProof({ nativeProof: result.completion.nativeProof, host, launcher, layer: "real-host", familyId: "A16", variantId, profileId, observedCode: "OBS_POSITIVE_COMPLETE" });
        const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A16" && value.variantId === variantId && value.profileId === profileId);
        assert.ok(record);
        const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
        validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
        receipts.push(receipt);
        if (recorder.enabled) await recorder.record("real-host", "A16", variantId, profileId, envelope);
      }
    }
  } finally {
    for (const root of roots) await fs.rm(root, { recursive: true, force: true });
  }
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  const expectedCount = process.env.MINI_LUX_SEC03_A16_FIXED_NTFS_ROOT ? 12 : 8;
  assert.equal(partial.validCount, expectedCount);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 482 - expectedCount);
  assert.equal(partial.complete, false);
});

windowsTest("SEC-03 real-host receipt harness authenticates A01 exact environment denial across E1-E4", { timeout: 120_000 }, async () => {
  const { addon, host, launcher, identity, effectiveIdentity, matrix, nativeVerifier, recorder } = await realHostReceiptContext();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mls3a01-"));
  const receipts = [];
  try {
    for (const variantId of ["A01-01", "A01-02", "A01-03", "A01-04", "A01-05", "A01-06", "A01-07", "A01-08"]) {
      const mutation = a01ParentMutation(variantId, process.env.PATH ?? "");
      const hadValue = Object.hasOwn(process.env, mutation.name);
      const previousValue = process.env[mutation.name];
      process.env[mutation.name] = mutation.value;
      try {
        for (const profileId of ["E1", "E2", "E3", "E4"]) {
          const result = await runA01Profile(addon, host, launcher, root, variantId, profileId, identity);
          assert.equal(result.completion.exitCode, 0);
          assert.equal(result.completion.reason, "completed");
          const { envelope } = evidenceFromNativeProof({ nativeProof: result.completion.nativeProof, host, launcher, layer: "real-host", familyId: "A01", variantId, profileId, observedCode: "OBS_ENV_ABSENT" });
          const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A01" && value.variantId === variantId && value.profileId === profileId);
          assert.ok(record);
          const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
          validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
          receipts.push(receipt);
          if (recorder.enabled) await recorder.record("real-host", "A01", variantId, profileId, envelope);
        }
      } finally {
        if (hadValue) process.env[mutation.name] = previousValue;
        else delete process.env[mutation.name];
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  assert.equal(partial.validCount, 32);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 450);
  assert.equal(partial.complete, false);
});

windowsTest("SEC-03 real-host receipt harness authenticates all 44 A02 root-escape denials", { timeout: 180_000 }, async () => {
  const { addon, host, launcher, identity, effectiveIdentity, matrix, nativeVerifier, recorder } = await realHostReceiptContext();
  const fixture = await createA02Fixture();
  const receipts = [];
  let safeToClose = false;
  try {
    for (const variantId of ["A02-01", "A02-02", "A02-03", "A02-04", "A02-05", "A02-06", "A02-07", "A02-08", "A02-09", "A02-10", "A02-11"]) {
      for (const profileId of ["E1", "E2", "E3", "E4"]) {
        const planned = a02Case(variantId, profileId);
        const result = await runExactDenyProfile(addon, host, launcher, fixture.root, profileId, identity, planned, A02_OUTPUT_MARKER);
        const output = decode(result.frames).map(value => value.text).join("");
        assert.deepEqual({ exitCode: result.completion.exitCode, reason: result.completion.reason }, { exitCode: 0, reason: "completed" }, `${variantId}/${profileId}: ${output}`);
        assert.match(output, new RegExp(A02_OUTPUT_MARKER), `${variantId}/${profileId}`);
        const { envelope } = evidenceFromNativeProof({ nativeProof: result.completion.nativeProof, host, launcher, layer: "real-host", familyId: "A02", variantId, profileId, observedCode: "OBS_FS_DENIED" });
        const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A02" && value.variantId === variantId && value.profileId === profileId);
        assert.ok(record);
        const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
        validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
        receipts.push(receipt);
        if (recorder.enabled) await recorder.record("real-host", "A02", variantId, profileId, envelope);
      }
    }
    safeToClose = true;
  } finally {
    if (!safeToClose) {
      const recoveryLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
      await recoveryLease.close();
      safeToClose = true;
    }
    if (safeToClose) await fixture.close();
  }
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  assert.equal(partial.validCount, 44);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 438);
  assert.equal(partial.complete, false);
});

windowsTest("SEC-03 J5 locks prevent implicit SID propagation to hardlinks and reparse targets", { timeout: 60_000 }, async () => {
  const { host, launcher, addon } = await testNativeArtifacts();
  const directory = await recoveryDirectory();
  const initialLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
  await initialLease.close();
  const baseline = new Set(await fs.readdir(directory));
  const fixture = await createA02Fixture();
  let started;
  let safeToClose = false;
  try {
    started = await start(addon, host, launcher, await launchBody(fixture.root, "for /L %i in (1,1,2000000000) do @rem"));
    const transactionFiles = await waitFor(async () => {
      const names = (await fs.readdir(directory)).filter(name => !baseline.has(name));
      return names.some(name => /\.0002\.jrn$/u.test(name)) ? names : null;
    });
    const appliedName = transactionFiles.find(name => /\.0002\.jrn$/u.test(name));
    assert(appliedName);
    const applied = await fs.readFile(path.join(directory, appliedName), "utf8");
    const sidHex = /^sidString=([0-9a-f]+)$/mu.exec(applied)?.[1];
    assert(sidHex);
    const executionSid = Buffer.from(sidHex, "hex").toString("utf16le");
    assert.match(executionSid, /^S-1-15-2-(?:[0-9]+-){6}[0-9]+$/u);
    assert.match(applied, /^MLSEC03J5$/mu);
    assert.match(applied, /^descendants=.*,[01],0,[0-9a-f]{64}(?:;|$)/mu);
    for (const target of [fixture.hardlinkSource, fixture.outside, fixture.junctionTarget]) {
      const observed = await icacls(target);
      assert.equal(observed.stdout.includes(executionSid), false, `Ineligible outside object received the exact execution SID: ${path.basename(target)}`);
    }
    await started.handle.terminateHost(terminateFrame("requested"));
    await started.handle.completed;
    started = undefined;
    const recoveryLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
    await recoveryLease.close();
    assert.deepEqual((await fs.readdir(directory)).filter(name => !baseline.has(name)), []);
    safeToClose = true;
  } finally {
    if (started) {
      try { await started.handle.crashHostForTest(); } catch {}
      await started.handle.completed.catch(() => undefined);
    }
    if (!safeToClose) {
      const recoveryLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
      await recoveryLease.close();
      safeToClose = true;
    }
    if (safeToClose) await fixture.close();
  }
});

windowsTest("SEC-03 real-host receipt harness authenticates A03 retained-root replacement barriers", { timeout: 60_000 }, async () => {
  const { addon, host, launcher, identity, effectiveIdentity, matrix, nativeVerifier, recorder } = await realHostReceiptContext();
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "mls3a03-"));
  const root = path.join(parent, "root");
  const cwd = path.join(root, "cwd");
  await fs.mkdir(cwd, { recursive: true });
  const receipts = [];
  try {
    for (const profileId of ["E1", "E2", "E3", "E4"]) {
      const raceParent = path.join(parent, `identity-${profileId}`);
      const raceRoot = path.join(raceParent, "root");
      const raceCwd = path.join(raceRoot, "cwd");
      const displacedRoot = path.join(raceParent, "displaced-root");
      await fs.mkdir(raceCwd, { recursive: true });
      const body = await a03LaunchBody(raceRoot, raceCwd, "A03-01", profileId, identity);
      const expected = await fs.stat(raceRoot, { bigint: true });
      await fs.rename(raceRoot, displacedRoot);
      await fs.mkdir(raceCwd, { recursive: true });
      const observed = await fs.stat(raceRoot, { bigint: true });
      assert(expected.dev !== observed.dev || expected.ino !== observed.ino, `${profileId} root replacement reused its object identity`);
      const nativeObservation = await observeRootDenial(addon, host, launcher, body, "EXEC_ROOT_IDENTITY_CHANGED");
      const { fields, envelope } = evidenceFromLauncherObservation({ nativeObservation, host, launcher, familyId: "A03", variantId: "A03-01", profileId });
      assert.equal(fields.observationClass, "root-identity-changed");
      assert.equal(fields.raceStage, "before-retained-handle");
      assert.notEqual(fields.expectedRootIdentityDigest, fields.observedRootIdentityDigest);
      const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A03" && value.variantId === "A03-01" && value.profileId === profileId);
      assert.ok(record);
      const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
      validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
      receipts.push(receipt);
      if (recorder.enabled) await recorder.record("real-host", "A03", "A03-01", profileId, envelope);
    }
    for (const variantId of ["A03-02", "A03-03"]) {
      for (const profileId of ["E1", "E2", "E3", "E4"]) {
        const result = await runA03Profile(addon, host, launcher, root, cwd, variantId, profileId, identity);
        const output = decode(result.frames).map(value => value.text).join("");
        assert.deepEqual({ exitCode: result.completion.exitCode, reason: result.completion.reason }, { exitCode: 0, reason: "completed" }, `${variantId}/${profileId}: ${output}`);
        const { envelope } = evidenceFromNativeProof({ nativeProof: result.completion.nativeProof, host, launcher, layer: "real-host", familyId: "A03", variantId, profileId, observedCode: "OBS_ROOT_REPLACEMENT_BLOCKED" });
        const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A03" && value.variantId === variantId && value.profileId === profileId);
        assert.ok(record);
        const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
        validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
        receipts.push(receipt);
        if (recorder.enabled) await recorder.record("real-host", "A03", variantId, profileId, envelope);
      }
    }
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  assert.equal(partial.validCount, 12);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 470);
  assert.equal(partial.complete, false);
});

windowsTest("SEC-03 real-host receipt harness authenticates A14 root identity change", { timeout: 60_000 }, async () => {
  const { addon, host, launcher, identity, effectiveIdentity, matrix, nativeVerifier, recorder } = await realHostReceiptContext();
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "mls3a14-root-"));
  const receipts = [];
  try {
    for (const profileId of ["E1", "E2", "E3", "E4"]) {
      const raceParent = path.join(parent, `identity-${profileId}`);
      const raceRoot = path.join(raceParent, "root");
      const raceCwd = path.join(raceRoot, "cwd");
      const displacedRoot = path.join(raceParent, "displaced-root");
      await fs.mkdir(raceCwd, { recursive: true });
      const body = await a03LaunchBody(raceRoot, raceCwd, "A03-01", profileId, identity);
      const expected = await fs.stat(raceRoot, { bigint: true });
      await fs.rename(raceRoot, displacedRoot);
      await fs.mkdir(raceCwd, { recursive: true });
      const observed = await fs.stat(raceRoot, { bigint: true });
      assert(expected.dev !== observed.dev || expected.ino !== observed.ino, `${profileId} A14 root replacement reused its object identity`);
      const nativeObservation = await observeRootDenial(addon, host, launcher, body, "EXEC_ROOT_IDENTITY_CHANGED");
      const { fields, envelope } = evidenceFromLauncherObservation({ nativeObservation, host, launcher, familyId: "A14", variantId: "A14-06", profileId });
      assert.equal(fields.observationClass, "root-identity-changed");
      assert.equal(fields.raceStage, "before-retained-handle");
      assert.notEqual(fields.expectedRootIdentityDigest, fields.observedRootIdentityDigest);
      const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A14" && value.variantId === "A14-06" && value.profileId === profileId);
      assert.ok(record);
      const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
      validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
      receipts.push(receipt);
      if (recorder.enabled) await recorder.record("real-host", "A14", "A14-06", profileId, envelope);
    }
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  assert.equal(partial.validCount, 4);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 478);
  assert.equal(partial.mockCount, 0);
  assert.equal(partial.testOnlyCount, 0);
});

windowsTest("SEC-03 real-host receipt harness authenticates A13 direct HTTP terminal denials", { timeout: 60_000 }, async () => {
  const { host, launcher, effectiveIdentity, matrix, nativeVerifier, recorder } = await realHostReceiptContext();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mls3a13-http-"));
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 114) });
  const broker = new CapabilityBroker({ pathPolicy: policy, resolveSessionPersona: sessionId => sessionId === "sec03-a13-http" ? "sec03-a13" : null, newRunId: () => effectiveIdentity.runId });
  broker.registerDirectOperation("terminal:list", DIRECT_OPERATION_POLICIES["terminal:list"]);
  const pathAuthority = await policy.createAuthority([{ rootId: "workspace", role: "workspace", configuredPath: root, permissions: ["initial-cwd"] }]);
  const authority = broker.createRuntimeAuthority({ name: "sec03-a13", tools: [], env: { WORKSPACE_ROOT: root }, systemPrompt: "SEC-03 A13 authentic HTTP boundary", allowedRoots: [root], rootEnv: { WORKSPACE_ROOT: "workspace" }, pathAuthority, networkPolicy: { mode: "deny" } });
  const principal = broker.createLocalApiPrincipal();
  const observations = new Map();
  const server = createServer(async (request, response) => {
    const event = request.method === "POST" && request.url === "/api/terminals" ? "start"
      : request.method === "POST" && /^\/api\/terminals\/[^/]+\/input$/u.test(request.url || "") ? "input" : null;
    if (!event) { response.writeHead(404).end(); return; }
    const operation = "terminal:list";
    const context = broker.issueLocalApiContext({ authority, principal, sessionId: "sec03-a13-http", operation, args: { deniedRoute: event } });
    try { observations.set(event, await observeTerminalDirectDenial(context, event)); }
    finally { if (broker.isContextActive(context)) broker.finishContext(context); }
    response.writeHead(403, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ code: "EXEC_DIRECT_MUTATION_DENIED", error: `Direct HTTP terminal ${event} is permanently denied` }));
  });
  const receipts = [];
  try {
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    assert(address && typeof address === "object");
    for (const [variantId, event, route] of [["A13-01", "start", "/api/terminals"], ["A13-02", "input", "/api/terminals/term_forged/input"]]) {
      const response = await fetch(`http://127.0.0.1:${address.port}${route}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
      assert.equal(response.status, 403);
      assert.equal((await response.json()).code, "EXEC_DIRECT_MUTATION_DENIED");
      const nativeObservation = observations.get(event);
      assert(nativeObservation, `${event} HTTP denial omitted native observation`);
      const planned = a13Case(variantId, "E4");
      const { fields, envelope } = evidenceFromLauncherObservation({ nativeObservation, host, launcher, familyId: "A13", variantId, profileId: "E4" });
      assert.equal(fields.operation, planned.operation);
      assert.equal(fields.decisionState, planned.decisionState);
      assert.equal(fields.observedCode, planned.expectedCode);
      assert.equal(fields.processStarts, "0");
      assert.equal(fields.profileCreates, "0");
      assert.equal(fields.journalWrites, "0");
      assert.equal(fields.aclMutations, "0");
      assert.equal(fields.stdinWrites, "0");
      const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A13" && value.variantId === variantId && value.profileId === "E4");
      assert.ok(record);
      const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
      validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
      receipts.push(receipt);
      if (recorder.enabled) await recorder.record("real-host", "A13", variantId, "E4", envelope);
    }
  } finally {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await broker.retireAuthority(authority).catch(() => undefined);
    await shutdownExecutionRuntime().catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  assert.equal(partial.validCount, 2);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 480);
  assert.equal(partial.mockCount, 0);
  assert.equal(partial.testOnlyCount, 0);
});

windowsTest("SEC-03 real-host receipt harness authenticates A13 cross-owner terminal denials", { timeout: 60_000 }, async () => {
  const { host, launcher, effectiveIdentity, matrix, nativeVerifier, recorder } = await realHostReceiptContext();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mls3a13-owner-"));
  const receipts = [];
  try {
    for (const [variantId, operation] of [["A13-03", "kill"], ["A13-04", "close"]]) {
      let fixture;
      try {
        fixture = await createA13RealTerminal(root, effectiveIdentity.runId);
        const planned = a13Case(variantId, "E4");
        assert.equal(planned.operation, operation);
        const nativeObservation = await fixture.attack(operation);
        const { fields, envelope } = evidenceFromLauncherObservation({ nativeObservation, host, launcher, familyId: "A13", variantId, profileId: "E4" });
        assert.equal(fields.observationClass, "service-denial");
        assert.equal(fields.raceStage, "trusted-service-decision");
        assert.equal(fields.operation, operation);
        assert.equal(fields.decisionState, planned.decisionState);
        assert.equal(fields.observedCode, "EXEC_OWNER_MISMATCH");
        assert.equal(fields.processStarts, "0");
        assert.equal(fields.profileCreates, "0");
        assert.equal(fields.journalWrites, "0");
        assert.equal(fields.aclMutations, "0");
        assert.equal(fields.stdinWrites, "0");
        assert.equal(terminalFacade.get(fixture.victimOwner, fixture.terminal.id)?.status, "running");
        const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A13" && value.variantId === variantId && value.profileId === "E4");
        assert.ok(record);
        const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
        validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
        receipts.push(receipt);
        if (recorder.enabled) await recorder.record("real-host", "A13", variantId, "E4", envelope);
      } finally {
        if (fixture) {
          await terminalFacade.close(fixture.victimOwner, fixture.terminal.id).catch(() => undefined);
          await fixture.broker.retireAuthority(fixture.authority).catch(() => undefined);
        }
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  assert.equal(partial.validCount, 2);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 480);
  assert.equal(partial.mockCount, 0);
  assert.equal(partial.testOnlyCount, 0);
});

windowsTest("SEC-03 real-host receipt harness authenticates A14 invalid recovery journals", { timeout: 60_000 }, async () => {
  const { addon, host, launcher, identity, effectiveIdentity, matrix, nativeVerifier, recorder } = await realHostReceiptContext();
  const journalDirectory = path.join(process.env.LOCALAPPDATA, "Mini-Lux", "sec03-journal-v2");
  const journalPath = path.join(journalDirectory, "txn-00000000000000000000000000000000.0001.jrn");
  const receipts = [];
  let fixtureCreated = false;
  try {
    const initialLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
    await initialLease.close();
    await fs.mkdir(journalDirectory, { recursive: true });
    assert.deepEqual(await fs.readdir(journalDirectory), []);
    await fs.writeFile(journalPath, A14_INVALID_JOURNAL, { encoding: "utf8", flag: "wx" });
    fixtureCreated = true;
    assert.throws(() => addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256), error => error?.code === "EXEC_ACL_RECOVERY_REQUIRED");
    for (const profileId of ["E1", "E2", "E3", "E4"]) {
      const nativeObservation = await observeA14InvalidJournal(addon, host, launcher, profileId, identity);
      const { fields, envelope } = evidenceFromLauncherObservation({ nativeObservation, host, launcher, familyId: "A14", variantId: "A14-07", profileId });
      assert.equal(fields.observationClass, "recovery-denial");
      assert.equal(fields.raceStage, "startup-recovery");
      assert.equal(fields.observedCode, "EXEC_RECOVERY_JOURNAL_INVALID");
      assert.equal(fields.processStarts, "0");
      assert.equal(fields.profileCreates, "0");
      assert.equal(fields.journalWrites, "0");
      assert.equal(fields.aclMutations, "0");
      const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A14" && value.variantId === "A14-07" && value.profileId === profileId);
      assert.ok(record);
      const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
      validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
      receipts.push(receipt);
      if (recorder.enabled) await recorder.record("real-host", "A14", "A14-07", profileId, envelope);
    }
  } finally {
    if (fixtureCreated) await fs.rm(journalPath, { force: true });
    const recoveryLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
    await recoveryLease.close();
  }
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  assert.equal(partial.validCount, 4);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 478);
  assert.equal(partial.mockCount, 0);
  assert.equal(partial.testOnlyCount, 0);
});

windowsTest("SEC-03 real-host receipt harness authenticates all 20 A04 direct-network denials", { timeout: 120_000 }, async () => {
  const { addon, host, launcher, identity, effectiveIdentity, matrix, nativeVerifier, recorder } = await realHostReceiptContext();
  await fs.mkdir(testNativeDirectory, { recursive: true });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sec03-a04-"));
  const fixture = await createA04Fixture();
  const receipts = [];
  try {
    for (const variantId of ["A04-01", "A04-02", "A04-03", "A04-04", "A04-05"]) {
      for (const profileId of ["E1", "E2", "E3", "E4"]) {
        const planned = a04Case(variantId, profileId, fixture.external);
        const result = await runA04Profile(addon, host, launcher, root, variantId, profileId, identity, planned, fixture.external);
        const output = decode(result.frames).map(value => value.text).join("");
        assert.deepEqual({ exitCode: result.completion.exitCode, reason: result.completion.reason }, { exitCode: 0, reason: "completed" }, `${variantId}/${profileId}: ${output}`);
        assert.match(output, new RegExp(A04_OUTPUT_MARKER), `${variantId}/${profileId}`);
        const accepted = result.networkAcceptedCount || await fixture.accepted(variantId);
        assert.equal(accepted, 0, `${variantId}/${profileId} reached a host-side listener`);
        const { envelope } = evidenceFromNativeProof({ nativeProof: result.completion.nativeProof, host, launcher, layer: "real-host", familyId: "A04", variantId, profileId, observedCode: "OBS_NETWORK_DENIED", networkAttemptCount: 1, networkAcceptedCount: accepted });
        const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A04" && value.variantId === variantId && value.profileId === profileId);
        assert.ok(record);
        const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
        validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
        receipts.push(receipt);
        if (recorder.enabled) await recorder.record("real-host", "A04", variantId, profileId, envelope);
      }
    }
  } finally {
    await fixture.close();
    await fs.rm(root, { recursive: true, force: true });
  }
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  assert.equal(partial.validCount, 20);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 462);
  assert.equal(partial.complete, false);
});

windowsTest("SEC-03 real-host receipt harness authenticates all 30 finite HTTPS broker outcomes", { timeout: 240_000 }, async () => {
  const { host, launcher, identity, effectiveIdentity, matrix, nativeVerifier, recorder } = await realHostReceiptContext();
  const artifactIdentity = Object.freeze({
    candidateId: identity.candidateId,
    buildIdSha256: identity.buildId,
    sourceSha256: identity.sourceSha256,
    launcherSha256: launcher.sha256,
    launcherBytes: launcher.bytes,
    hostSha256: host.sha256,
    hostBytes: host.bytes,
    machine: "x64",
    protocolVersion: 1,
  });
  const bridge = createProductionNativeExecutionBridge(artifactIdentity);
  await bridge.initialize?.();
  const receipts = [];
  let firstEnvelope = null;
  const profiles = Object.freeze({ E1: "one-shot-shell", E2: "agent-shell", E3: "script" });
  const emptyBody = Buffer.alloc(0);
  const body = Buffer.from("body", "utf8");
  const emptySha256 = createHash("sha256").digest("hex");
  try {
    for (const variantId of ["A05-01", "A05-02", "A05-03", "A05-04", "A05-05", "A05-06", "A05-07", "A05-08", "A05-09", "A05-10"]) {
      for (const profileId of ["E1", "E2", "E3"]) {
        const redirectCase = variantId === "A05-07";
        const origin = redirectCase ? "https://iana.org" : "https://example.com";
        const url = redirectCase ? "https://iana.org/domains/reserved" : "https://example.com/";
        const requestBody = variantId === "A05-08" ? body : emptyBody;
        const method = variantId === "A05-08" ? "POST" : "GET";
        const limits = Object.freeze({
          maxRequestBytes: variantId === "A05-08" ? body.length - 1 : 1024,
          maxResponseBytes: variantId === "A05-09" ? 1 : 4096,
          deadlineMs: variantId === "A05-10" ? 1 : 60_000,
          maxRedirects: 0,
        });
        const operation = Object.freeze({
          version: 1,
          operationId: `${variantId.toLowerCase()}-${profileId.toLowerCase()}`,
          method,
          url,
          headers: Object.freeze([]),
          bodyBytes: requestBody.length,
          bodySha256: requestBody.length ? createHash("sha256").update(requestBody).digest("hex") : emptySha256,
          redirects: Object.freeze([]),
          limits,
        });
        const personaDigest = createHash("sha256").update(`sec03-a05-persona\0${profileId}`).digest("hex");
        const context = Object.freeze({
          contextId: `a05-context-${variantId}-${profileId}`,
          executionDomainId: `a05-domain-${variantId}-${profileId}`,
          sessionId: `a05-session-${profileId}`,
          runId: identity.runId,
          parentContextId: null,
          principal: "agent",
          persona: Object.freeze({ name: "sec03-a05", digest: personaDigest }),
          authorityEpoch: 1,
          allowedTools: Object.freeze(["sec03-a05-broker"]),
          allowedRoots: Object.freeze([]),
          networkPolicy: Object.freeze({ mode: "allowlist", origins: Object.freeze([origin]) }),
          allowedRiskClasses: Object.freeze(["network"]),
          approvalGrant: null,
        });
        let resolution = 0;
        const broker = createFiniteHttpsBroker(context, [operation], variantId === "A05-05"
          ? { resolve: async () => Object.freeze([{ address: "169.254.169.254", family: 4 }]) }
          : variantId === "A05-06"
            ? { resolve: async () => Object.freeze([{ address: ++resolution === 1 ? "93.184.216.34" : "1.1.1.1", family: 4 }]) }
            : {});
        const invocationUrl = variantId === "A05-02" ? "http://example.com/"
          : variantId === "A05-03" ? "https://www.example.com/"
            : variantId === "A05-04" ? "https://example.com:444/" : url;
        const invocation = Object.freeze({ operationId: operation.operationId, method, url: invocationUrl, headers: operation.headers, body: requestBody });
        let observation;
        try { observation = await broker.execute(context, invocation); }
        catch (error) {
          assert(error instanceof FiniteHttpsBrokerError, `${variantId}/${profileId}: unexpected broker failure ${error}`);
          observation = error.observation;
        }
        const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A05" && value.variantId === variantId && value.profileId === profileId);
        assert.ok(record);
        assert.equal(observation.code, record.expectedCode, `${variantId}/${profileId}`);
        const executionId = createHash("sha256").update(randomUUID()).digest("hex");
        const policyDigest = createHash("sha256").update(JSON.stringify(context.networkPolicy)).digest("hex");
        const nativeObservation = await bridge.observeBrokerOperation(Object.freeze({
          executionId,
          entryPoint: profileId,
          profile: profiles[profileId],
          contextId: context.executionDomainId,
          sessionId: context.sessionId,
          runId: context.runId,
          authorityEpoch: context.authorityEpoch,
          personaDigest,
          policyDigest,
          observation,
        }));
        const { fields, envelope } = evidenceFromLauncherObservation({ nativeObservation, host, launcher, familyId: "A05", variantId, profileId });
        assert.equal(fields.operation, "broker");
        assert.equal(fields.observationClass, "broker-observation");
        assert.equal(fields.raceStage, "trusted-network-broker");
        assert.equal(fields.networkMode, "brokered");
        assert.equal(fields.observedCode, record.expectedCode);
        assert.equal(Number(fields.networkAttemptCount), observation.attemptCount);
        assert.equal(Number(fields.journalWrites), observation.dnsResolutionCount);
        assert.equal(Number(fields.aclMutations), observation.redirectCount);
        assert.equal(Number(fields.stdinWrites), observation.requestBytes);
        assert.equal(Number(fields.aggregateOutputBytes), observation.responseBytes);
        const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
        validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
        receipts.push(receipt);
        if (!firstEnvelope) firstEnvelope = envelope;
        if (recorder.enabled) await recorder.record("real-host", "A05", variantId, profileId, envelope);
      }
    }
  } finally {
    await bridge.shutdown();
  }
  assert.ok(firstEnvelope);
  const wrongRecord = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A05" && value.variantId === "A05-02" && value.profileId === "E1");
  assert.ok(wrongRecord);
  assert.throws(() => createSec03Receipt(wrongRecord, effectiveIdentity, { ...firstEnvelope, variantId: "A05-02", observedCode: wrongRecord.expectedCode }, nativeVerifier), /broker|observed|decisionState/iu);
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  assert.equal(partial.validCount, 30);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 452);
  assert.equal(partial.complete, false);
});

windowsTest("SEC-03 real-host receipt harness authenticates all nine fixed E3A adversarial tuples", { timeout: 180_000 }, async () => {
  const { addon, host, launcher, identity, effectiveIdentity, matrix, nativeVerifier, recorder } = await realHostReceiptContext();
  const receipts = [];
  let firstEnvelope = null;
  const variants = ["A06-01", "A06-02", "A06-03", "A06-04", "A07-01", "A07-02", "A07-03", "A08-02", "A08-04"];
  for (const variantId of variants) {
    const planned = e3aCase(variantId, "E3A");
    const result = await runFixedAdversary(addon, host, launcher, variantId, identity);
    const fields = parseNativeProof(result.completion.nativeProof);
    assert.equal(result.completion.reason, planned.nativeReason === "completed" ? "completed" : planned.expectedCode, `${variantId}/E3A: ${JSON.stringify({ childExit: fields.childExit, completionReason: fields.completionReason })}`);
    assert.equal(fields.profile, "fixed-adversary");
    assert.equal(fields.childExit, String(planned.childExit));
    assert.equal(fields.completionReason, planned.nativeReason);
    assert.equal(fields.aclMutations, "4");
    assert.equal(fields.executableLease, "1");
    assert.equal(fields.descendantValidationFailures, "0");
    assert.equal(fields.activeProcessZero, "1");
    assert.equal(fields.cleanupComplete, "1");
    assert.equal(fields.handlesDrained, "1");
    assert.equal(fields.treeTerminated, "1");
    const { envelope } = evidenceFromNativeProof({ nativeProof: result.completion.nativeProof, host, launcher, layer: "real-host", familyId: variantId.slice(0, 3), variantId, profileId: "E3A", observedCode: planned.expectedCode });
    const record = matrix.records.find(value => value.layer === "real-host" && value.variantId === variantId && value.profileId === "E3A");
    assert.ok(record);
    const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
    validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
    if (variantId === "A06-01") firstEnvelope = envelope;
    receipts.push(receipt);
    if (recorder.enabled) await recorder.record("real-host", record.familyId, variantId, "E3A", envelope);
  }
  assert.ok(firstEnvelope);
  const wrongRecord = matrix.records.find(value => value.layer === "real-host" && value.variantId === "A06-02" && value.profileId === "E3A");
  assert.ok(wrongRecord);
  const substitutedEnvelope = { ...firstEnvelope, variantId: "A06-02" };
  assert.throws(() => createSec03Receipt(wrongRecord, effectiveIdentity, substitutedEnvelope, nativeVerifier), /E3A fixed tuple payload differs/u);
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  assert.equal(partial.validCount, 9);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 473);
  assert.equal(partial.complete, false);
});

windowsTest("SEC-03 fixed E3A launcher rejects every non-frozen tuple before host output", async () => {
  const { addon, host, launcher, identity } = await realHostReceiptContext();
  const lease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
  const frames = [];
  try {
    const invalid = { ...fixedAdversaryBody("A06-01", identity), tuple: "A06-99/E3A" };
    assert.throws(() => lease.launchHost(frame(invalid), value => frames.push(value)), error => error?.code === "EXEC_NATIVE_PROTOCOL");
    assert.equal(frames.length, 0);
  } finally {
    await lease.close();
  }
});

windowsTest("SEC-03 real-host receipt harness authenticates reachable A06 descendant containment", { timeout: 120_000 }, async () => {
  const { addon, host, launcher, identity, effectiveIdentity, matrix, nativeVerifier, recorder } = await realHostReceiptContext();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mls3a06-"));
  const receipts = [];
  try {
    for (const variantId of ["A06-01", "A06-02", "A06-03", "A06-04"]) {
      for (const profileId of ["E1", "E2", "E4"]) {
        const planned = a06Case(variantId, profileId);
        const result = await runA06Profile(addon, host, launcher, root, variantId, profileId, identity);
        const output = decode(result.frames).map(value => value.text).join("");
        assert.deepEqual({ exitCode: result.completion.exitCode, reason: result.completion.reason }, { exitCode: 0, reason: "completed" }, `${variantId}/${profileId}: ${output}`);
        const { fields, envelope } = evidenceFromNativeProof({ nativeProof: result.completion.nativeProof, host, launcher, layer: "real-host", familyId: "A06", variantId, profileId, observedCode: planned.expectedCode });
        assert(Number(fields.observedDescendantCount) >= planned.minimumDescendants, `${variantId}/${profileId}: descendant topology missing ${JSON.stringify({ processStarts: fields.processStarts, observedProcessCount: fields.observedProcessCount, observedDescendantCount: fields.observedDescendantCount, descendantValidationFailures: fields.descendantValidationFailures, output })}`);
        assert.equal(fields.descendantValidationFailures, "0", `${variantId}/${profileId}: descendant token or Job mismatch`);
        assert.equal(fields.activeProcessZero, "1");
        assert.equal(fields.treeTerminated, "1");
        const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A06" && value.variantId === variantId && value.profileId === profileId);
        assert.ok(record);
        const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
        validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
        receipts.push(receipt);
        if (recorder.enabled) await recorder.record("real-host", "A06", variantId, profileId, envelope);
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  assert.equal(partial.validCount, 12);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 470);
  assert.equal(partial.complete, false);
});

windowsTest("SEC-03 real-host receipt harness authenticates all production-profile A07 denials", { timeout: 180_000 }, async () => {
  const { addon, host, launcher, identity, effectiveIdentity, matrix, nativeVerifier, recorder } = await realHostReceiptContext();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mls3a07-"));
  const stagedHelper = path.join(root, "sec03-a07-adversary.exe");
  const receipts = [];
  try {
    await fs.copyFile(a07HelperPath, stagedHelper);
    const fixedHelperSha256 = a07Case("A07-01", "E1").helperSha256;
    assert.equal(createHash("sha256").update(await fs.readFile(stagedHelper)).digest("hex"), fixedHelperSha256);
    for (const variantId of ["A07-01", "A07-02", "A07-03", "A07-04", "A07-05", "A07-06"]) {
      const profiles = ["A07-01", "A07-02", "A07-03"].includes(variantId) ? ["E1", "E2", "E4"] : ["E1", "E2", "E3", "E4"];
      for (const profileId of profiles) {
        const planned = a07Case(variantId, profileId);
        const result = await runA07Profile(addon, host, launcher, root, variantId, profileId, identity);
        const output = decode(result.frames).map(value => value.text).join("");
        assert.deepEqual({ exitCode: result.completion.exitCode, reason: result.completion.reason }, { exitCode: 0, reason: "completed" }, `${variantId}/${profileId}: ${output}`);
        const { fields, envelope } = evidenceFromNativeProof({ nativeProof: result.completion.nativeProof, host, launcher, layer: "real-host", familyId: "A07", variantId, profileId, observedCode: planned.expectedCode });
        assert.equal(fields.childExit, String(planned.expectedExit), `${variantId}/${profileId}: actual Win32 stimulus result differs: ${output}`);
        assert.equal(fields.jobBreakawayAllowed, "0");
        assert.equal(fields.jobSilentBreakawayAllowed, "0");
        if (["A07-01", "A07-02", "A07-03"].includes(variantId)) {
          assert.equal(createHash("sha256").update(await fs.readFile(stagedHelper)).digest("hex"), planned.helperSha256);
          assert(Number(fields.observedDescendantCount) >= planned.minimumDescendants, `${variantId}/${profileId}: fixed Win32 stimulus descendant missing`);
          assert.equal(fields.descendantValidationFailures, "0", `${variantId}/${profileId}: fixed Win32 stimulus escaped token or Job validation`);
        } else if (variantId === "A07-04") {
          assert.equal(fields.hostDupOpenWin32, "5");
          assert.equal(fields.jobHandleInheritable, "0");
          assert.equal(fields.jobHandleDuplicateBlocked, "1");
        } else if (variantId === "A07-05") {
          assert.equal(fields.hostDupOpenWin32, "5");
          assert.equal(fields.controlHandleInheritable, "0");
          assert.equal(fields.controlHandleDuplicateBlocked, "1");
        } else {
          assert.equal(fields.sentinelHandleInheritable, "1");
          assert.equal(fields.sentinelHandleListed, "0");
          assert.equal(fields.sentinelHandleObserved, "0");
          assert.equal(fields.unlistedSentinelBlocked, "1");
          assert(["0", "6"].includes(fields.sentinelProbeWin32), `${profileId}: unexpected sentinel probe result ${fields.sentinelProbeWin32}`);
        }
        const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A07" && value.variantId === variantId && value.profileId === profileId);
        assert.ok(record);
        const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
        validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
        receipts.push(receipt);
        if (recorder.enabled) await recorder.record("real-host", "A07", variantId, profileId, envelope);
      }
    }
  } finally {
    let recovered = false;
    const recoveryLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
    try {
      await recoveryLease.close();
      recovered = true;
    } finally {
      if (recovered) await fs.rm(root, { recursive: true, force: true });
    }
  }
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  assert.equal(partial.validCount, 21);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 461);
  assert.equal(partial.complete, false);
});

windowsTest("SEC-03 native rejects a protected existing descendant before root mutation", { timeout: 60_000 }, async () => {
  const { addon, host, launcher, identity } = await realHostReceiptContext();
  const recoveryRoot = await recoveryDirectory();
  const journalBaseline = [...await fs.readdir(recoveryRoot)].sort();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mls3acl-protected-"));
  const protectedDirectory = path.join(root, "protected");
  const protectedFile = path.join(protectedDirectory, "nested.txt");
  const marker = "SEC03_PROTECTED_DESCENDANT_MUST_NOT_RUN";
  let recovered = false;
  try {
    await fs.mkdir(protectedDirectory);
    await fs.writeFile(protectedFile, "protected", "utf8");
    await icacls(protectedDirectory, "/inheritance:d", "/Q");
    assert.equal(await fs.readFile(protectedFile, "utf8"), "protected");
    const executionId = createHash("sha256").update(randomUUID()).digest("hex");
    const result = await launch(addon, host, launcher, await launchBody(root, `echo ${marker}`, { runId: identity.runId, executionId, candidateId: identity.candidateId, buildIdSha256: identity.buildId, sourceSha256: identity.sourceSha256 }));
    const output = decode(result.frames).map(value => value.text).join("");
    assert.match(output, /EXEC_ACL_PROPAGATION_FAILED/u);
    assert.deepEqual({ exitCode: result.completion.exitCode, reason: result.completion.reason }, { exitCode: 74, reason: "host-failed" });
    assert.ok(result.completion.nativeProof && Buffer.isBuffer(result.completion.nativeProof.proof));
    const proofFields = parseNativeProof(result.completion.nativeProof);
    assert.equal(proofFields.completionReason, "acl-propagation-failed");
    assert.equal(proofFields.execution, executionId);
    assert.equal(proofFields.processStarts, "0");
    assert.equal(proofFields.aclMutations, "0");
    assert.equal(proofFields.jobConstrained, "0");
    assert.equal(proofFields.cleanupComplete, "1");
    assert.doesNotMatch(output, new RegExp(marker, "u"));
    const recoveryLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
    await recoveryLease.close();
    recovered = true;
    assert.deepEqual([...await fs.readdir(recoveryRoot)].sort(), journalBaseline);
  } finally {
    if (!recovered) {
      const recoveryLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
      await recoveryLease.close();
      recovered = true;
    }
    if (recovered) {
      await icacls(protectedDirectory, "/inheritance:e", "/Q").catch(() => undefined);
      await fs.rm(root, { recursive: true, force: true });
    }
  }
});

windowsTest("SEC-03 real-host receipt harness authenticates A14 crash recovery observations", { timeout: 180_000 }, async () => {
  const { addon, host, launcher, identity, effectiveIdentity, matrix, nativeVerifier, recorder } = await realHostReceiptContext();
  const recoveryRoot = await recoveryDirectory();
  const initialLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
  await initialLease.close();
  const journalBaseline = [...await fs.readdir(recoveryRoot)].sort();
  const receipts = [];
  const envelopes = new Map();
  for (const variantId of ["A14-01", "A14-02"]) {
    const pristine = variantId === "A14-01";
    for (const profileId of ["E1", "E2", "E3", "E4"]) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `mls3a14-${pristine ? "pristine" : "recovered"}-`));
      const marker = `SEC03_${variantId.replace("-", "_")}_${profileId}_MUST_NOT_RUN`;
      let recovered = false;
      try {
        const executionId = createHash("sha256").update(randomUUID()).digest("hex");
        const overrides = { runId: identity.runId, executionId, candidateId: identity.candidateId, buildIdSha256: identity.buildId, sourceSha256: identity.sourceSha256 };
        const body = profileId === "E3"
          ? await scriptLaunchBody(root, `console.log(${JSON.stringify(marker)})`, overrides)
          : profileId === "E2" || profileId === "E4"
            ? await terminalLaunchBody(root, profileId, overrides)
            : await launchBody(root, `echo ${marker}`, overrides);
        const d0 = (await icacls(root)).stdout;
        const started = await startAclCrashReceipt(addon, host, launcher, body, variantId);
        const completion = await started.handle.completed;
        recovered = true;
        const output = decode(started.frames).map(value => value.text).join("");
        assert.equal(completion.exitCode, pristine ? 58273 : 58274);
        assert.equal(completion.reason, "host-failed");
        assert.doesNotMatch(output, new RegExp(marker, "u"));
        assert.equal((await icacls(root)).stdout, d0, "fixed ACL recovery did not restore the exact D0 sequence");
        assert.deepEqual([...await fs.readdir(recoveryRoot)].sort(), journalBaseline);
        assert(completion.nativeProof && Buffer.isBuffer(completion.nativeProof.proof));
        const { fields, envelope } = evidenceFromLauncherObservation({ nativeObservation: completion.nativeProof, host, launcher, familyId: "A14", variantId, profileId });
        assert.equal(fields.execution, executionId);
        assert.equal(fields.observationClass, "acl-crash-recovery");
        assert.equal(fields.raceStage, "post-host-recovery");
        assert.equal(fields.decisionState, pristine ? "acl-pristine-recovered" : "acl-applied-recovered");
        assert.equal(fields.observedCode, pristine ? "OBS_ACL_PRISTINE" : "OBS_ACL_RECOVERED");
        assert.equal(fields.hostExitCode, pristine ? "58273" : "58274");
        assert.equal(fields.recoveryJournalState, pristine ? "prepared" : "applied");
        assert.equal(fields.recoveryJournalGeneration, pristine ? "1" : "2");
        assert.equal(fields.journalWrites, pristine ? "1" : "2");
        assert.equal(fields.aclMutations, pristine ? "0" : "2");
        assert.equal(fields.processStarts, "0");
        assert.equal(fields.profileCreates, "1");
        assert.equal(fields.cleanupComplete, "1");
        assert.equal(fields.hostExited, "1");
        assert.equal(fields.childExit, "none");
        assert.equal(fields.completionReason, "host-crash-recovered");
        const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A14" && value.variantId === variantId && value.profileId === profileId);
        assert.ok(record);
        const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
        validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
        receipts.push(receipt);
        envelopes.set(`${variantId}/${profileId}`, envelope);
        if (recorder.enabled) await recorder.record("real-host", "A14", variantId, profileId, envelope);
      } finally {
        if (!recovered) {
          try { const recoveryLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256); await recoveryLease.close(); } catch { /* Preserve the primary failure. */ }
        }
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  }
  const a1401Record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A14" && value.variantId === "A14-01" && value.profileId === "E1");
  const a1402Envelope = envelopes.get("A14-02/E1");
  assert.ok(a1401Record && a1402Envelope);
  const substituted = { ...a1402Envelope, variantId: "A14-01", observedCode: "OBS_ACL_PRISTINE" };
  assert.throws(() => createSec03Receipt(a1401Record, effectiveIdentity, substituted, nativeVerifier), /fixed ACL recovery variant\/request binding differs/u);
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  assert.equal(partial.validCount, 8);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 474);
  assert.equal(partial.mockCount, 0);
  assert.equal(partial.testOnlyCount, 0);
});

windowsTest("SEC-03 real-host receipt harness authenticates A14 D0 conflict denials", { timeout: 180_000 }, async () => {
  const { addon, host, launcher, identity, effectiveIdentity, matrix, nativeVerifier, recorder } = await realHostReceiptContext();
  const recoveryRoot = await recoveryDirectory();
  const journalBaseline = [...await fs.readdir(recoveryRoot)].sort();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mls3a14-conflict-"));
  const ready = path.join(root, ".sec03-a14-conflict-ready");
  const release = path.join(root, ".sec03-a14-conflict-release");
  const marker = "SEC03_A14_CONFLICT_MUST_NOT_RUN";
  const receipts = [];
  let unrelatedAdded = false;
  try {
    for (const profileId of ["E1", "E2", "E3", "E4"]) {
      const executionId = createHash("sha256").update(randomUUID()).digest("hex");
      const overrides = { runId: identity.runId, executionId, candidateId: identity.candidateId, buildIdSha256: identity.buildId, sourceSha256: identity.sourceSha256 };
      const body = profileId === "E3"
        ? await scriptLaunchBody(root, `console.log(${JSON.stringify(marker)})`, overrides)
        : profileId === "E2" || profileId === "E4"
          ? await terminalLaunchBody(root, profileId, overrides)
          : await launchBody(root, `echo ${marker}`, overrides);
      const started = await startAclConflictReceipt(addon, host, launcher, body);
      await waitFor(async () => fs.access(ready).then(() => true, () => null));
      await icacls(root, "/grant", "*S-1-5-20:(OI)(CI)(RX)", "/Q"); unrelatedAdded = true;
      await fs.writeFile(release, "release", { flag: "wx" });
      const completion = await started.handle.completed;
      const output = decode(started.frames).map(value => value.text).join("");
      assert.deepEqual({ exitCode: completion.exitCode, reason: completion.reason }, { exitCode: 74, reason: "host-failed" });
      assert.match(output, /EXEC_ACL_CONFLICT/u);
      assert.doesNotMatch(output, new RegExp(marker, "u"));
      assert.match((await icacls(root)).stdout, /NETWORK SERVICE|S-1-5-20/iu);
      const { fields, envelope } = evidenceFromNativeProof({ nativeProof: completion.nativeProof, host, launcher, layer: "real-host", familyId: "A14", variantId: "A14-05", profileId, observedCode: "EXEC_ACL_CONFLICT" });
      assert.equal(fields.execution, executionId);
      assert.equal(fields.completionReason, "acl-conflict");
      assert.equal(fields.processStarts, "0");
      assert.equal(fields.aclMutations, "0");
      assert.equal(fields.jobConstrained, "0");
      assert.equal(fields.cleanupComplete, "1");
      const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A14" && value.variantId === "A14-05" && value.profileId === profileId);
      assert.ok(record);
      const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
      validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
      receipts.push(receipt);
      if (recorder.enabled) await recorder.record("real-host", "A14", "A14-05", profileId, envelope);
      assert.deepEqual([...await fs.readdir(recoveryRoot)].sort(), journalBaseline);
      await icacls(root, "/remove:g", "*S-1-5-20", "/Q"); unrelatedAdded = false;
    }
  } finally {
    if (unrelatedAdded) await icacls(root, "/remove:g", "*S-1-5-20", "/Q").catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  assert.equal(partial.validCount, 4);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 478);
  assert.equal(partial.mockCount, 0);
  assert.equal(partial.testOnlyCount, 0);
});

windowsTest("SEC-03 real-host receipt harness authenticates A14 retained-handle sharing denials", { timeout: 120_000 }, async () => {
  const { addon: testAddon } = await testNativeArtifacts();
  const { addon, host, launcher, identity, effectiveIdentity, matrix, nativeVerifier, recorder } = await realHostReceiptContext();
  const recoveryRoot = await recoveryDirectory();
  const journalBaseline = [...await fs.readdir(recoveryRoot)].sort();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mls3a14-sharing-"));
  const blockedFile = path.join(root, "blocked.txt");
  const marker = "SEC03_A14_SHARING_MUST_NOT_RUN";
  const receipts = [];
  let sharingLease = null;
  try {
    await fs.writeFile(blockedFile, "locked", "utf8");
    sharingLease = testAddon.openAclSharingLeaseForTest(blockedFile);
    assert.equal(typeof sharingLease.close, "function");
    for (const profileId of ["E1", "E2", "E3", "E4"]) {
      const executionId = createHash("sha256").update(randomUUID()).digest("hex");
      const overrides = { runId: identity.runId, executionId, candidateId: identity.candidateId, buildIdSha256: identity.buildId, sourceSha256: identity.sourceSha256 };
      const body = profileId === "E3"
        ? await scriptLaunchBody(root, `console.log(${JSON.stringify(marker)})`, overrides)
        : profileId === "E2" || profileId === "E4"
          ? await terminalLaunchBody(root, profileId, overrides)
          : await launchBody(root, `echo ${marker}`, overrides);
      const result = await launch(addon, host, launcher, body);
      const output = decode(result.frames).map(value => value.text).join("");
      assert.deepEqual({ exitCode: result.completion.exitCode, reason: result.completion.reason }, { exitCode: 74, reason: "host-failed" });
      assert.match(output, /EXEC_ACL_SHARING_FAILED/u);
      assert.doesNotMatch(output, new RegExp(marker, "u"));
      const { fields, envelope } = evidenceFromNativeProof({ nativeProof: result.completion.nativeProof, host, launcher, layer: "real-host", familyId: "A14", variantId: "A14-03", profileId, observedCode: "EXEC_ACL_SHARING_FAILED" });
      assert.equal(fields.execution, executionId);
      assert.equal(fields.completionReason, "acl-sharing-failed");
      assert.equal(fields.processStarts, "0");
      assert.equal(fields.aclMutations, "0");
      assert.equal(fields.jobConstrained, "0");
      assert.equal(fields.cleanupComplete, "1");
      const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A14" && value.variantId === "A14-03" && value.profileId === profileId);
      assert.ok(record);
      const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
      validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
      receipts.push(receipt);
      if (recorder.enabled) await recorder.record("real-host", "A14", "A14-03", profileId, envelope);
      assert.deepEqual([...await fs.readdir(recoveryRoot)].sort(), journalBaseline);
    }
  } finally {
    if (sharingLease) sharingLease.close();
    await fs.rm(root, { recursive: true, force: true });
  }
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  assert.equal(partial.validCount, 4);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 478);
  assert.equal(partial.mockCount, 0);
  assert.equal(partial.testOnlyCount, 0);
});

windowsTest("SEC-03 real-host receipt harness authenticates A14 protected-DACL propagation denials", { timeout: 120_000 }, async () => {
  const { addon, host, launcher, identity, effectiveIdentity, matrix, nativeVerifier, recorder } = await realHostReceiptContext();
  const recoveryRoot = await recoveryDirectory();
  const journalBaseline = [...await fs.readdir(recoveryRoot)].sort();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mls3a14-protected-"));
  const protectedDirectory = path.join(root, "protected");
  const protectedFile = path.join(protectedDirectory, "nested.txt");
  const marker = "SEC03_A14_PROTECTED_DACL_MUST_NOT_RUN";
  const receipts = [];
  try {
    await fs.mkdir(protectedDirectory);
    await fs.writeFile(protectedFile, "protected", "utf8");
    await icacls(protectedDirectory, "/inheritance:d", "/Q");
    for (const profileId of ["E1", "E2", "E3", "E4"]) {
      const executionId = createHash("sha256").update(randomUUID()).digest("hex");
      const overrides = { runId: identity.runId, executionId, candidateId: identity.candidateId, buildIdSha256: identity.buildId, sourceSha256: identity.sourceSha256 };
      const body = profileId === "E3"
        ? await scriptLaunchBody(root, `console.log(${JSON.stringify(marker)})`, overrides)
        : profileId === "E2" || profileId === "E4"
          ? await terminalLaunchBody(root, profileId, overrides)
          : await launchBody(root, `echo ${marker}`, overrides);
      const result = await launch(addon, host, launcher, body);
      const output = decode(result.frames).map(value => value.text).join("");
      assert.deepEqual({ exitCode: result.completion.exitCode, reason: result.completion.reason }, { exitCode: 74, reason: "host-failed" });
      assert.match(output, /EXEC_ACL_PROPAGATION_FAILED/u);
      assert.doesNotMatch(output, new RegExp(marker, "u"));
      const { fields, envelope } = evidenceFromNativeProof({ nativeProof: result.completion.nativeProof, host, launcher, layer: "real-host", familyId: "A14", variantId: "A14-04", profileId, observedCode: "EXEC_ACL_PROPAGATION_FAILED" });
      assert.equal(fields.execution, executionId);
      assert.equal(fields.completionReason, "acl-propagation-failed");
      assert.equal(fields.processStarts, "0");
      assert.equal(fields.aclMutations, "0");
      assert.equal(fields.jobConstrained, "0");
      assert.equal(fields.cleanupComplete, "1");
      const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A14" && value.variantId === "A14-04" && value.profileId === profileId);
      assert.ok(record);
      const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
      validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
      receipts.push(receipt);
      if (recorder.enabled) await recorder.record("real-host", "A14", "A14-04", profileId, envelope);
      assert.deepEqual([...await fs.readdir(recoveryRoot)].sort(), journalBaseline);
    }
  } finally {
    await icacls(protectedDirectory, "/inheritance:e", "/Q").catch(() => undefined);
    await fs.rm(root, { recursive: true, force: true });
  }
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  assert.equal(partial.validCount, 4);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 478);
  assert.equal(partial.mockCount, 0);
  assert.equal(partial.testOnlyCount, 0);
});

windowsTest("SEC-03 real-host receipt harness authenticates all reachable A08 Job limits", { timeout: 120_000 }, async () => {
  const { addon, host, launcher, identity, effectiveIdentity, matrix, nativeVerifier, recorder } = await realHostReceiptContext();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mls3a08-"));
  await Promise.all(Object.entries(A08_SUPPORT_FILES).map(([name, contents]) => fs.writeFile(path.join(root, name), contents, "utf8")));
  const receipts = [];
  const allProfiles = ["E1", "E2", "E3", "E4"];
  const shellProfiles = ["E1", "E2", "E4"];
  const records = [
    ...allProfiles.map(profileId => ["A08-01", profileId]),
    ...shellProfiles.map(profileId => ["A08-02", profileId]),
    ...allProfiles.map(profileId => ["A08-03", profileId]),
    ...shellProfiles.map(profileId => ["A08-04", profileId]),
    ...allProfiles.map(profileId => ["A08-05", profileId]),
    ...allProfiles.map(profileId => ["A08-06", profileId]),
    ["A08-07", "E2"], ["A08-07", "E4"],
  ];
  try {
    for (const [variantId, profileId] of records) {
      const planned = a08Case(variantId, profileId);
      const result = await runA08Profile(addon, host, launcher, root, variantId, profileId, identity);
      const diagnosticFields = parseNativeProof(result.completion.nativeProof);
      const diagnosticOutput = decode(result.frames).map(value => value.text).join("");
      assert.equal(result.completion.reason, planned.expectedCode, `${variantId}/${profileId}: childExit=${diagnosticFields.childExit}; output=${JSON.stringify(diagnosticOutput.slice(0, 512))}`);
      const { envelope } = evidenceFromNativeProof({ nativeProof: result.completion.nativeProof, host, launcher, layer: "real-host", familyId: "A08", variantId, profileId, observedCode: planned.expectedCode });
      const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A08" && value.variantId === variantId && value.profileId === profileId);
      assert.ok(record);
      const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
      validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
      receipts.push(receipt);
      if (recorder.enabled) await recorder.record("real-host", "A08", variantId, profileId, envelope);
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  assert.equal(partial.validCount, 24);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 458);
  assert.equal(partial.complete, false);
});

windowsTest("SEC-03 real-host receipt harness authenticates A09 service and host crash recovery", { timeout: 120_000 }, async () => {
  const { addon, host, launcher, identity, effectiveIdentity, matrix, nativeVerifier, recorder } = await realHostReceiptContext();
  const recoveryRoot = await recoveryDirectory();
  const initialLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
  await initialLease.close();
  const journalBaseline = [...await fs.readdir(recoveryRoot)].sort();
  const receipts = [];
  const envelopes = new Map();
  for (const variantId of ["A09-06", "A09-07"]) {
    for (const profileId of ["E1", "E2", "E3", "E4"]) {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), `mls3a09-${variantId.toLowerCase()}-`));
      let recovered = false;
      try {
        const d0 = (await icacls(root)).stdout;
        const result = await runA09CrashProfile(addon, host, launcher, root, variantId, profileId, identity);
        recovered = true;
        assert.equal(result.completion.exitCode, variantId === "A09-06" ? 58278 : 58279);
        assert.equal(result.completion.reason, "host-failed");
        assert.equal((await icacls(root)).stdout, d0, "lifecycle crash recovery did not restore the exact D0 sequence");
        assert.deepEqual([...await fs.readdir(recoveryRoot)].sort(), journalBaseline);
        const { fields, envelope } = evidenceFromLauncherObservation({ nativeObservation: result.completion.nativeProof, host, launcher, familyId: "A09", variantId, profileId });
        assert.equal(fields.observationClass, "lifecycle-crash-recovery");
        assert.equal(fields.decisionState, variantId === "A09-06" ? "service-lost-recovered" : "host-lost-recovered");
        assert.equal(fields.observedCode, variantId === "A09-06" ? "EXEC_SERVICE_LOST" : "EXEC_HOST_LOST");
        assert.equal(fields.recoveryJournalState, "applied");
        assert.equal(fields.recoveryJournalGeneration, "2");
        assert.equal(fields.activeProcessZero, "1");
        assert(Number(fields.processStarts) >= 1);
        assert.equal(fields.cleanupComplete, "1");
        assert.equal(fields.jobClosed, "1");
        assert.equal(fields.hostExited, "1");
        assert.equal(fields.treeTerminated, "1");
        const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A09" && value.variantId === variantId && value.profileId === profileId);
        assert.ok(record);
        const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
        validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
        receipts.push(receipt);
        envelopes.set(`${variantId}/${profileId}`, envelope);
        if (recorder.enabled) await recorder.record("real-host", "A09", variantId, profileId, envelope);
      } finally {
        if (!recovered) {
          try { const recoveryLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256); await recoveryLease.close(); } catch { /* Preserve the primary failure. */ }
        }
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  }
  const hostLostRecord = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A09" && value.variantId === "A09-07" && value.profileId === "E1");
  const serviceLostEnvelope = envelopes.get("A09-06/E1");
  assert.ok(hostLostRecord && serviceLostEnvelope);
  const substituted = { ...serviceLostEnvelope, variantId: "A09-07", observedCode: "EXEC_HOST_LOST" };
  assert.throws(() => createSec03Receipt(hostLostRecord, effectiveIdentity, substituted, nativeVerifier), /fixed lifecycle variant\/request binding differs/u);
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  assert.equal(partial.validCount, 8);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 474);
  assert.equal(partial.mockCount, 0);
  assert.equal(partial.testOnlyCount, 0);
});

windowsTest("SEC-03 real-host receipt harness authenticates reachable A09 lifecycle reasons", { timeout: 60_000 }, async () => {
  const { addon, host, launcher, identity, effectiveIdentity, matrix, nativeVerifier, recorder } = await realHostReceiptContext();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mls3a09-"));
  const receipts = [];
  try {
    for (const variantId of ["A09-01", "A09-02", "A09-03", "A09-04", "A09-05", "A09-08"]) {
      for (const profileId of ["E1", "E2", "E3", "E4"]) {
        const planned = a09Case(variantId, profileId);
        const result = await runA09Profile(addon, host, launcher, root, variantId, profileId, identity);
        const output = decode(result.frames).map(value => value.text).join("");
        assert.equal(result.completion.reason, planned.completionReason, `${variantId}/${profileId}: ${output}`);
        const { envelope } = evidenceFromNativeProof({ nativeProof: result.completion.nativeProof, host, launcher, layer: "real-host", familyId: "A09", variantId, profileId, observedCode: planned.expectedCode });
        const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A09" && value.variantId === variantId && value.profileId === profileId);
        assert.ok(record);
        const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
        validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
        receipts.push(receipt);
        if (recorder.enabled) await recorder.record("real-host", "A09", variantId, profileId, envelope);
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  assert.equal(partial.validCount, 24);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 458);
  assert.equal(partial.complete, false);
});

windowsTest("SEC-03 real-host receipt harness authenticates all 24 A11 grant and input denials", { timeout: 120_000 }, async () => {
  const context = await realHostReceiptContext();
  const { host, launcher, effectiveIdentity, matrix, nativeVerifier, recorder } = context;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mls3a11-"));
  const receipts = [];
  try {
    for (const variantId of ["A11-01", "A11-02", "A11-03", "A11-04", "A11-05", "A11-06", "A11-07", "A11-08"]) {
      for (const profileId of ["E1", "E2", "E3"]) {
        const planned = a11Case(variantId, profileId);
        const nativeObservation = profileId === "E2"
          ? await runA11InputDenial(context, root, variantId)
          : await runA11LaunchDenial(context, root, variantId, profileId);
        const { fields, envelope } = evidenceFromLauncherObservation({ nativeObservation, host, launcher, familyId: "A11", variantId, profileId });
        assert.equal(fields.observationClass, "service-denial");
        assert.equal(fields.operation, planned.operation);
        assert.equal(fields.decisionState, planned.decisionState);
        assert.equal(fields.observedCode, planned.expectedCode);
        assert.equal(fields.processStarts, "0");
        assert.equal(fields.profileCreates, "0");
        assert.equal(fields.journalWrites, "0");
        assert.equal(fields.aclMutations, "0");
        assert.equal(fields.stdinWrites, "0");
        const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A11" && value.variantId === variantId && value.profileId === profileId);
        assert.ok(record);
        const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
        validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
        receipts.push(receipt);
        if (recorder.enabled) await recorder.record("real-host", "A11", variantId, profileId, envelope);
      }
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  assert.equal(partial.validCount, 24);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 458);
  assert.equal(partial.complete, false);
});

windowsTest("SEC-03 real-host receipt harness authenticates all 9 A12 manual consent denials", { timeout: 60_000 }, async () => {
  const context = await realHostReceiptContext();
  const { host, launcher, effectiveIdentity, matrix, nativeVerifier, recorder } = context;
  const receipts = [];
  for (const variantId of ["A12-01", "A12-02", "A12-03", "A12-04", "A12-05", "A12-06", "A12-07", "A12-08", "A12-09"]) {
    const planned = a12Case(variantId, "E4");
    const nativeObservation = await runA12Denial(context, variantId);
    const { fields, envelope } = evidenceFromLauncherObservation({ nativeObservation, host, launcher, familyId: "A12", variantId, profileId: "E4" });
    assert.equal(fields.observationClass, "service-denial");
    assert.equal(fields.operation, planned.operation);
    assert.equal(fields.decisionState, planned.decisionState);
    assert.equal(fields.observedCode, planned.expectedCode);
    assert.equal(fields.processStarts, "0");
    assert.equal(fields.profileCreates, "0");
    assert.equal(fields.journalWrites, "0");
    assert.equal(fields.aclMutations, "0");
    assert.equal(fields.stdinWrites, "0");
    const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A12" && value.variantId === variantId && value.profileId === "E4");
    assert.ok(record);
    const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
    validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
    receipts.push(receipt);
    if (recorder.enabled) await recorder.record("real-host", "A12", variantId, "E4", envelope);
  }
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  assert.equal(partial.validCount, 9);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 473);
  assert.equal(partial.complete, false);
});

windowsTest("SEC-03 real-host receipt harness authenticates A19 unsupported E4 broker mode", { timeout: 30_000 }, async () => {
  const context = await realHostReceiptContext();
  const { host, launcher, effectiveIdentity, matrix, nativeVerifier, recorder } = context;
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mls3a19-"));
  try {
    const planned = a19Case("A19-01", "E4");
    const nativeObservation = await runA19Denial(context, root);
    const { fields, envelope } = evidenceFromLauncherObservation({ nativeObservation, host, launcher, familyId: "A19", variantId: "A19-01", profileId: "E4" });
    assert.equal(fields.observationClass, "service-denial");
    assert.equal(fields.operation, planned.operation);
    assert.equal(fields.decisionState, planned.decisionState);
    assert.equal(fields.observedCode, planned.expectedCode);
    assert.equal(fields.processStarts, "0");
    assert.equal(fields.profileCreates, "0");
    assert.equal(fields.journalWrites, "0");
    assert.equal(fields.aclMutations, "0");
    assert.equal(fields.stdinWrites, "0");
    const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A19" && value.variantId === "A19-01" && value.profileId === "E4");
    assert.ok(record);
    const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
    validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
    const partial = aggregateSec03Receipts([receipt], { matrix, identity: effectiveIdentity, nativeVerifier });
    assert.equal(partial.validCount, 1);
    assert.equal(partial.invalidKeys.length, 0);
    assert.equal(partial.missingKeys.length, 481);
    if (recorder.enabled) await recorder.record("real-host", "A19", "A19-01", "E4", envelope);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

windowsTest("SEC-03 real-host receipt harness authenticates A17 restricted Script capabilities", { timeout: 60_000 }, async () => {
  const { addon, host, launcher, identity, effectiveIdentity, matrix, nativeVerifier, recorder } = await realHostReceiptContext();
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "mls3a17-"));
  const root = path.join(parent, "root");
  await fs.mkdir(root);
  await fs.writeFile(path.join(parent, "outside.txt"), "outside-canary", "utf8");
  await fs.copyFile(addonPath, path.join(root, "sandbox-launcher.node"));
  let accepted = 0;
  const server = createServer((_request, response) => { accepted += 1; response.end("forbidden"); });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(47831, "127.0.0.1", resolve); });
  const receipts = [];
  try {
    for (const variantId of ["A17-01", "A17-02", "A17-03", "A17-04", "A17-05", "A17-06", "A17-07"]) {
      const source = a17Probe(variantId);
      const executionId = createHash("sha256").update(randomUUID()).digest("hex");
      const result = await launch(addon, host, launcher, await scriptLaunchBody(root, source, { runId: identity.runId, executionId, candidateId: identity.candidateId, buildIdSha256: identity.buildId, sourceSha256: identity.sourceSha256 }));
      const output = decode(result.frames).map(value => value.text).join("");
      assert.deepEqual({ exitCode: result.completion.exitCode, reason: result.completion.reason }, { exitCode: 0, reason: "completed" }, `${variantId}: ${output}`);
      assert.match(output, new RegExp(A17_OUTPUT_MARKER), variantId);
      const { envelope } = evidenceFromNativeProof({ nativeProof: result.completion.nativeProof, host, launcher, layer: "real-host", familyId: "A17", variantId, profileId: "E3", observedCode: "OBS_SCRIPT_DENIED" });
      const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A17" && value.variantId === variantId && value.profileId === "E3");
      assert.ok(record);
      const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
      validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
      receipts.push(receipt);
      if (recorder.enabled) await recorder.record("real-host", "A17", variantId, "E3", envelope);
    }
    assert.equal(accepted, 0);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(parent, { recursive: true, force: true });
  }
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  assert.equal(partial.validCount, 7);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 475);
  assert.equal(partial.complete, false);
});

windowsTest("SEC-03 real-host receipt harness authenticates all 20 A18 unsupported roots before host launch", { timeout: 60_000 }, async () => {
  const { addon, host, launcher, identity, effectiveIdentity, matrix, nativeVerifier, recorder } = await realHostReceiptContext();
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "mls3a18-"));
  const safeRoot = path.join(parent, "safe-root");
  const junctionTarget = path.join(parent, "junction-target");
  const junctionRoot = path.join(parent, "reparse-root");
  const receipts = [];
  const missing = [];
  try {
    await fs.mkdir(safeRoot);
    await fs.mkdir(junctionTarget);
    await fs.symlink(junctionTarget, junctionRoot, "junction");
    const paths = { ...await discoverA18StorageRoots(), "A18-05": junctionRoot };
    for (const variantId of ["A18-01", "A18-02", "A18-03", "A18-04", "A18-05"]) {
      const rootPath = paths[variantId];
      let descriptor = null;
      if (rootPath) {
        try { descriptor = await a18RootDescriptor(rootPath, variantId === "A18-05"); }
        catch (error) { missing.push(`${variantId}:${error.code ?? error.message}`); }
      } else missing.push(`${variantId}:unavailable`);
      if (!descriptor) continue;
      for (const profileId of ["E1", "E2", "E3", "E4"]) {
        const body = await a18LaunchBody(safeRoot, descriptor, profileId, identity);
        const nativeObservation = await observeRootDenial(addon, host, launcher, body);
        const { fields, envelope } = evidenceFromLauncherObservation({ nativeObservation, host, launcher, familyId: "A18", variantId, profileId });
        assert.equal(fields.processStarts, "0");
        assert.equal(fields.profileCreates, "0");
        assert.equal(fields.journalWrites, "0");
        assert.equal(fields.aclMutations, "0");
        const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A18" && value.variantId === variantId && value.profileId === profileId);
        assert.ok(record);
        const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
        validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
        receipts.push(receipt);
        if (recorder.enabled) await recorder.record("real-host", "A18", variantId, profileId, envelope);
      }
    }
  } finally {
    await fs.rm(parent, { recursive: true, force: true });
  }
  assert.deepEqual(missing, [], `BLOCKED: SEC-03 A18 requires real accessible root fixtures: ${missing.join(", ")}`);
  const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
  assert.equal(partial.validCount, 20);
  assert.equal(partial.invalidKeys.length, 0);
  assert.equal(partial.missingKeys.length, 462);
  assert.equal(partial.complete, false);
});

windowsTest("SEC-03 native rejects malformed launch/non-local root and survives repeated launcher lifecycle", async () => {
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const host = manifest.outputs.find((value) => value.path === "dist/native/sandbox-host.exe");
  const launcher = manifest.outputs.find((value) => value.path === "dist/native/sandbox-launcher.node");
  assert.ok(host && launcher);
  const addon = require(addonPath);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec03-deny-"));
  try {
    const malformed = await launch(addon, host, launcher, { ...await launchBody(root, "echo MUST_NOT_RUN"), type: "unknown" });
    assert.notEqual(malformed.completion.exitCode, 0);
    assert.match(decode(malformed.frames).map((value) => value.text).join(""), /EXEC_PROTOCOL_INVALID/);

    const poisonedEnvironment = environment(root);
    poisonedEnvironment.SystemRoot = root;
    const poisoned = await launch(addon, host, launcher, await launchBody(root, "echo MUST_NOT_RUN", { environment: poisonedEnvironment }));
    assert.notEqual(poisoned.completion.exitCode, 0);
    assert.match(decode(poisoned.frames).map((value) => value.text).join(""), /EXEC_ENV_INVALID:native-runtime/);

    const remoteBody = { ...await launchBody(root, "echo MUST_NOT_RUN"), roots: [{ path: "\\\\localhost\\C$\\Windows", access: "read" }] };
    await assert.rejects(() => launch(addon, host, launcher, remoteBody), (error) => error?.code === "EXEC_ROOT_UNSUPPORTED");

    for (let iteration = 0; iteration < 20; iteration += 1) {
      const repeated = await launch(addon, host, launcher, await launchBody(root, "exit /b 0"));
      assert.deepEqual({ exitCode: repeated.completion.exitCode, reason: repeated.completion.reason }, { exitCode: 0, reason: "completed" });
      globalThis.gc?.();
    }
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

windowsTest("SEC-03 native E3 runs exact stdin module with executable lease and denies ambient authority", async () => {
  assert.match(process.version, /^v24\./u);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  const host = manifest.outputs.find((value) => value.path === "dist/native/sandbox-host.exe");
  const launcher = manifest.outputs.find((value) => value.path === "dist/native/sandbox-launcher.node");
  assert.ok(host && launcher);
  const addon = require(addonPath);
  const parent = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec03-e3-"));
  const root = path.join(parent, "root");
  const outside = path.join(parent, "outside-canary.txt");
  await fs.mkdir(root);
  await fs.writeFile(outside, "must-not-read", "utf8");
  process.env.SEC03_PARENT_SENTINEL = "must-not-inherit";
  let accepted = 0;
  const server = createServer((_request, response) => { accepted += 1; response.end("forbidden"); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.equal(typeof address, "object");
  const source = `
    import { readFile } from "node:fs/promises";
    import { spawn } from "node:child_process";
    console.log("SEC03_NATIVE_E3_OK");
    try { await readFile(${JSON.stringify(outside)}, "utf8"); throw new Error("outside-readable"); }
    catch (error) { if (error?.message === "outside-readable") throw error; console.log("SEC03_E3_FS_DENIED"); }
    if (process.env.SEC03_PARENT_SENTINEL !== undefined || process.env.ComSpec !== undefined) throw new Error("ambient-environment");
    console.log("SEC03_E3_ENV_DENIED");
    try { await fetch("http://127.0.0.1:${address.port}/"); throw new Error("network-reachable"); }
    catch (error) { if (error?.message === "network-reachable") throw error; console.log("SEC03_E3_NETWORK_DENIED"); }
    try {
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ["--version"], { stdio: "ignore" });
        child.once("error", () => { console.log("SEC03_E3_DESCENDANT_DENIED"); resolve(); });
        child.once("exit", (code) => reject(new Error("descendant-exit-" + code)));
      });
    } catch (error) {
      if (error?.code !== "ERR_ACCESS_DENIED") throw error;
      console.log("SEC03_E3_DESCENDANT_DENIED");
    }
  `;
  try {
    const result = await launch(addon, host, launcher, await scriptLaunchBody(root, source));
    const output = decode(result.frames).map((value) => value.text).join("");
    assert.deepEqual({ exitCode: result.completion.exitCode, reason: result.completion.reason }, { exitCode: 0, reason: "completed" }, output);
    assert.match(output, /SEC03_NATIVE_E3_OK/);
    assert.match(output, /SEC03_E3_FS_DENIED/);
    assert.match(output, /SEC03_E3_ENV_DENIED/);
    assert.match(output, /SEC03_E3_NETWORK_DENIED/);
    assert.match(output, /SEC03_E3_DESCENDANT_DENIED/);
    assert.match(output, /SEC03_EVIDENCE profile=E3 appcontainer=1 capabilities=0 job=1 lowIL=1 executableLease=1 childExit=0/);
    assert.equal(accepted, 0);
  } finally {
    delete process.env.SEC03_PARENT_SENTINEL;
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(parent, { recursive: true, force: true });
  }
});

for (const entryPoint of ["E2", "E4"]) {
  windowsTest(`SEC-03 native ${entryPoint} uses authenticated ConPTY input/output and graceful cleanup`, { timeout: 30_000 }, async () => {
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    const host = manifest.outputs.find((value) => value.path === "dist/native/sandbox-host.exe");
    const launcher = manifest.outputs.find((value) => value.path === "dist/native/sandbox-launcher.node");
    assert.ok(host && launcher);
    const addon = require(addonPath);
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `mini-lux-sec03-${entryPoint.toLowerCase()}-`));
    const marker = `SEC03_NATIVE_${entryPoint}_OK`;
    let started;
    try {
      started = await start(addon, host, launcher, await terminalLaunchBody(root, entryPoint));
      assert.throws(() => started.handle.writeFrame(frame({ v: 1, type: "input", secret: "1".repeat(64), data: "WA==", digest: "0".repeat(64), appendNewline: true })), error => error?.code === "EXEC_NATIVE_PROTOCOL");
      await started.handle.writeFrame(inputFrame(`echo ${marker}`));
      try {
        await Promise.race([
          waitFor(async () => decode(started.frames).some(value => value.text.includes(marker))),
          started.handle.completed.then(value => { throw new Error(`native host completed before ConPTY output: ${JSON.stringify(value)}`); }),
        ]);
      } catch (error) {
        assert.fail(`${error.message}\n${decode(started.frames).map(value => `${value.stream}: ${value.text}`).join("")}`);
      }
      if (entryPoint === "E2") {
        await started.handle.writeFrame(inputFrame("exit"));
      } else {
        await started.handle.terminateHost(terminateFrame("requested"));
        assert.throws(() => started.handle.terminateHost(terminateFrame("requested")), error => error?.code === "EXEC_NATIVE_PROTOCOL");
      }
      const completion = await started.handle.completed;
      assert.equal(completion.reason, entryPoint === "E2" ? "completed" : "EXEC_CANCELLED");
      const output = decode(started.frames).map(value => value.text).join("");
      assert.match(output, new RegExp(marker));
      assert.match(output, new RegExp(`profile=${entryPoint} .*conpty=1 conptyMerged=1`));
    } finally {
      if (started) {
        try { await started.handle.terminateHost(terminateFrame("test-cleanup")); } catch {}
        await started.handle.completed.catch(() => undefined);
      }
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

windowsTest("SEC-03 real-host receipt harness authenticates all nine frozen host protocol denials", { timeout: 120_000 }, async () => {
  const { addon, host, launcher, identity, effectiveIdentity, matrix, nativeVerifier, recorder } = await realHostReceiptContext();
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec03-control-protocol-"));
  const receipts = [];
  const envelopes = new Map();
  try {
    for (let index = 1; index <= 9; index += 1) {
      const variantId = `A10-${String(index).padStart(2, "0")}`;
      const planned = a10Case(variantId, "HOST");
      const executionId = createHash("sha256").update(randomUUID()).digest("hex");
      const started = await start(addon, host, launcher, await terminalLaunchBody(root, planned.carrierEntryPoint, {
        candidateId: identity.candidateId,
        buildIdSha256: identity.buildId,
        sourceSha256: identity.sourceSha256,
        executionId,
        runId: identity.runId,
      }));
      assert.equal(typeof started.handle.probeFixedHostProtocol, "function");
      await Promise.race([
        waitFor(async () => started.frames.length > 0),
        started.handle.completed.then(value => { throw new Error(`host completed before protocol probe: ${JSON.stringify(value)}`); }),
      ]);
      await started.handle.probeFixedHostProtocol(planned.subcode);
      const completion = await started.handle.completed;
      assert.equal(completion.reason, "EXEC_PROTOCOL_INVALID", variantId);
      assert(completion.nativeProof, `${variantId} did not publish authenticated native proof`);
      const { fields, envelope } = evidenceFromNativeProof({
        nativeProof: completion.nativeProof,
        host,
        launcher,
        layer: "real-host",
        familyId: "A10",
        variantId,
        profileId: "HOST",
        observedCode: "EXEC_PROTOCOL_INVALID",
        observedSubcode: planned.subcode,
      });
      assert.equal(fields.execution, executionId);
      assert.equal(fields.protocolSubcode, planned.subcode);
      assert.equal(fields.completionReason, "protocol-invalid");
      assert.equal(fields.activeProcessZero, "1");
      assert.equal(fields.cleanupComplete, "1");
      const record = matrix.records.find(value => value.layer === "real-host" && value.familyId === "A10" && value.variantId === variantId && value.profileId === "HOST");
      assert(record);
      const receipt = createSec03Receipt(record, effectiveIdentity, envelope, nativeVerifier);
      validateSec03Receipt(receipt, { matrix, identity: effectiveIdentity, nativeVerifier });
      receipts.push(receipt);
      envelopes.set(variantId, envelope);
      if (recorder.enabled) await recorder.record("real-host", "A10", variantId, "HOST", envelope);
    }
    const lengthRecord = matrix.records.find(value => value.layer === "real-host" && value.variantId === "A10-01" && value.profileId === "HOST");
    const oversizeEnvelope = envelopes.get("A10-02");
    assert(lengthRecord && oversizeEnvelope);
    assert.throws(
      () => createSec03Receipt(lengthRecord, effectiveIdentity, { ...oversizeEnvelope, variantId: "A10-01", observedSubcode: "length" }, nativeVerifier),
      error => error?.actual === "oversize" && error?.expected === "length",
    );
    const partial = aggregateSec03Receipts(receipts, { matrix, identity: effectiveIdentity, nativeVerifier });
    assert.equal(partial.validCount, 9);
    assert.equal(partial.layerCounts["real-host"], 9);
    assert.equal(partial.mockCount, 0);
    assert.equal(partial.testOnlyCount, 0);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

windowsTest("SEC-03 J5 prepared ledger recovers a partial descendant mutation", { timeout: 60_000 }, async () => {
  const { host, launcher, addon } = await testNativeArtifacts();
  const directory = await recoveryDirectory();
  const initialLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
  await initialLease.close();
  const baseline = new Set(await fs.readdir(directory));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec03-partial-ledger-"));
  const nestedDirectory = path.join(root, "nested");
  const nestedFile = path.join(nestedDirectory, "existing.txt");
  await fs.mkdir(nestedDirectory);
  await fs.writeFile(nestedFile, "SEC03_PARTIAL_LEDGER", "utf8");
  const previousCrash = process.env.MINI_LUX_SEC03_NATIVE_TEST_CRASH;
  let recovered = false;
  try {
    process.env.MINI_LUX_SEC03_NATIVE_TEST_CRASH = "descendant-applied";
    const started = await start(addon, host, launcher, await launchBody(root, "echo SEC03_MUST_NOT_RUN"));
    await started.handle.completed;
    const transactionFiles = (await fs.readdir(directory)).filter(name => !baseline.has(name));
    assert.equal(transactionFiles.some(name => /\.0001\.jrn$/u.test(name)), true);
    assert.equal(transactionFiles.some(name => /\.0002\.jrn$/u.test(name)), false);
    const preparedName = transactionFiles.find(name => /\.0001\.jrn$/u.test(name));
    assert(preparedName);
    const prepared = await fs.readFile(path.join(directory, preparedName), "utf8");
    const sidHex = /^sidString=([0-9a-f]+)$/mu.exec(prepared)?.[1];
    assert(sidHex);
    const executionSid = Buffer.from(sidHex, "hex").toString("utf16le");
    assert.equal((await icacls(root)).stdout.includes(executionSid), true);
    assert.equal((await icacls(nestedDirectory)).stdout.includes(executionSid), true);

    const recoveryLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
    await recoveryLease.close();
    recovered = true;
    assert.deepEqual((await fs.readdir(directory)).filter(name => !baseline.has(name)), []);
    for (const target of [root, nestedDirectory, nestedFile]) assert.equal((await icacls(target)).stdout.includes(executionSid), false);
  } finally {
    if (previousCrash === undefined) delete process.env.MINI_LUX_SEC03_NATIVE_TEST_CRASH;
    else process.env.MINI_LUX_SEC03_NATIVE_TEST_CRASH = previousCrash;
    if (!recovered) {
      const recoveryLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
      await recoveryLease.close();
      recovered = true;
    }
    if (recovered) await fs.rm(root, { recursive: true, force: true });
  }
});

windowsTest("SEC-03 J5 prevents late outside hardlink propagation after preflight", { timeout: 60_000 }, async () => {
  const { host, launcher, addon } = await testNativeArtifacts();
  const directory = await recoveryDirectory();
  const initialLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
  await initialLease.close();
  const baseline = new Set(await fs.readdir(directory));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec03-late-link-root-"));
  const outsideDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec03-late-link-outside-"));
  const outsideFile = path.join(outsideDirectory, "outside.txt");
  const lateLink = path.join(root, "late-link.txt");
  const marker = path.join(root, ".sec03-j5-prepared");
  const release = path.join(root, ".sec03-j5-release");
  await fs.writeFile(outsideFile, "SEC03_LATE_OUTSIDE", "utf8");
  const previousCrash = process.env.MINI_LUX_SEC03_NATIVE_TEST_CRASH;
  let started;
  let recovered = false;
  try {
    process.env.MINI_LUX_SEC03_NATIVE_TEST_CRASH = "barrier-prepared-hold-applied";
    started = await start(addon, host, launcher, await launchBody(root, "echo SEC03_MUST_NOT_RUN"));
    await waitFor(async () => fs.access(marker).then(() => true, () => null));
    await fs.link(outsideFile, lateLink);
    await fs.writeFile(release, "release", "utf8");
    const transactionFiles = await waitFor(async () => {
      const names = (await fs.readdir(directory)).filter(name => !baseline.has(name));
      return names.some(name => /\.0002\.jrn$/u.test(name)) ? names : null;
    });
    const appliedName = transactionFiles.find(name => /\.0002\.jrn$/u.test(name));
    assert(appliedName);
    const applied = await fs.readFile(path.join(directory, appliedName), "utf8");
    const sidHex = /^sidString=([0-9a-f]+)$/mu.exec(applied)?.[1];
    assert(sidHex);
    const executionSid = Buffer.from(sidHex, "hex").toString("utf16le");
    assert.equal((await icacls(outsideFile)).stdout.includes(executionSid), false);
    assert.equal((await icacls(lateLink)).stdout.includes(executionSid), false);
    await started.handle.crashHostForTest();
    await started.handle.completed;
    started = undefined;
    const recoveryLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
    await recoveryLease.close();
    recovered = true;
    assert.deepEqual((await fs.readdir(directory)).filter(name => !baseline.has(name)), []);
    assert.equal((await icacls(outsideFile)).stdout.includes(executionSid), false);
  } finally {
    if (previousCrash === undefined) delete process.env.MINI_LUX_SEC03_NATIVE_TEST_CRASH;
    else process.env.MINI_LUX_SEC03_NATIVE_TEST_CRASH = previousCrash;
    await fs.writeFile(release, "release", "utf8").catch(() => undefined);
    if (started) {
      try { await started.handle.crashHostForTest(); } catch {}
      await started.handle.completed.catch(() => undefined);
    }
    if (!recovered) {
      const recoveryLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
      await recoveryLease.close();
      recovered = true;
    }
    if (recovered) {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(outsideDirectory, { recursive: true, force: true });
    }
  }
});

windowsTest("SEC-03 native startup recovery blocks a live host and preserves an unrelated ACE after host crash", { timeout: 60_000 }, async () => {
  const { host, launcher, addon } = await testNativeArtifacts();
  const directory = await recoveryDirectory();
  const initialLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
  await initialLease.close();
  const baseline = new Set(await fs.readdir(directory));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec03-recovery-"));
  const nestedDirectory = path.join(root, "nested");
  const nestedFile = path.join(nestedDirectory, "existing.txt");
  const movedDirectory = `${root}-moved-nested`;
  const movedFile = path.join(movedDirectory, "existing.txt");
  await fs.mkdir(nestedDirectory);
  await fs.writeFile(nestedFile, "SEC03_RECOVERY_DESCENDANT", "utf8");
  let started;
  let unrelatedAdded = false;
  try {
    started = await start(addon, host, launcher, await launchBody(root, "for /L %i in (1,1,2000000000) do @rem"));
    const transactionFiles = await waitFor(async () => {
      const names = (await fs.readdir(directory)).filter(name => !baseline.has(name));
      return names.some(name => /\.0002\.jrn$/u.test(name)) ? names : null;
    });
    assert.ok(transactionFiles.some(name => /\.0001\.jrn$/u.test(name)));
    const journalCopies = await Promise.all(transactionFiles.filter(name => /\.jrn$/u.test(name)).map(async name => [name, await fs.readFile(path.join(directory, name))]));
    const appliedJournalName = transactionFiles.find(name => /\.0002\.jrn$/u.test(name));
    assert(appliedJournalName);
    const appliedJournal = await fs.readFile(path.join(directory, appliedJournalName), "utf8");
    const sidHex = /^sidString=([0-9a-f]+)$/mu.exec(appliedJournal)?.[1];
    assert(sidHex);
    const executionSid = Buffer.from(sidHex, "hex").toString("utf16le");
    assert.match(executionSid, /^S-1-15-2-(?:[0-9]+-){6}[0-9]+$/u);
    assert.throws(
      () => addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256),
      error => error?.code === "EXEC_ACL_RECOVERY_REQUIRED",
    );
    await assert.rejects(fs.rename(nestedDirectory, movedDirectory), error => error?.code === "EBUSY" || error?.code === "EPERM" || error?.code === "EACCES");

    await started.handle.crashHostForTest();
    await started.handle.completed;
    started = undefined;
    await fs.rename(nestedDirectory, movedDirectory);
    await fs.mkdir(nestedDirectory);
    await fs.writeFile(nestedFile, "SEC03_RECOVERY_REPLACEMENT", "utf8");
    await icacls(root, "/grant", "*S-1-5-20:(OI)(CI)(RX)", "/Q");
    unrelatedAdded = true;

    const recoveryLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
    await recoveryLease.close();
    const remaining = (await fs.readdir(directory)).filter(name => !baseline.has(name));
    assert.deepEqual(remaining, []);
    const { stdout } = await icacls(root);
    assert.match(stdout, /NETWORK SERVICE|S-1-5-20/iu);
    for (const target of [root, movedDirectory, movedFile, nestedDirectory, nestedFile]) {
      const observed = await icacls(target);
      assert.equal(observed.stdout.includes(executionSid), false, `Recovered ACL still contains the exact execution SID on ${path.basename(target)}`);
    }
    for (const [name, bytes] of journalCopies) await fs.writeFile(path.join(directory, name), bytes, { flag: "wx" });
    const idempotentRecovery = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
    await idempotentRecovery.close();
    assert.deepEqual((await fs.readdir(directory)).filter(name => !baseline.has(name)), []);
  } finally {
    if (started) {
      try { await started.handle.crashHostForTest(); } catch {}
      await started.handle.completed.catch(() => undefined);
    }
    if (unrelatedAdded) await icacls(root, "/remove:g", "*S-1-5-20", "/Q").catch(() => undefined);
    let recovered = false;
    try {
      const recoveryLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
      await recoveryLease.close();
      recovered = true;
    } catch {}
    if (recovered) {
      await fs.rm(root, { recursive: true, force: true });
      await fs.rm(movedDirectory, { recursive: true, force: true });
    }
  }
});

windowsTest("SEC-03 J5 recovery traverses a protected parent to clean a current-namespace child", { timeout: 60_000 }, async () => {
  const { host, launcher, addon } = await testNativeArtifacts();
  const directory = await recoveryDirectory();
  const initialLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
  await initialLease.close();
  const baseline = new Set(await fs.readdir(directory));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec03-protected-recovery-"));
  const nestedDirectory = path.join(root, "protected-parent");
  const nestedFile = path.join(nestedDirectory, "protected-child.txt");
  let started;
  let executionSid;
  let recovered = false;
  try {
    started = await start(addon, host, launcher, await launchBody(root, "for /L %i in (1,1,2000000000) do @rem"));
    const transactionFiles = await waitFor(async () => {
      const names = (await fs.readdir(directory)).filter(name => !baseline.has(name));
      return names.some(name => /\.0002\.jrn$/u.test(name)) ? names : null;
    });
    const appliedName = transactionFiles.find(name => /\.0002\.jrn$/u.test(name));
    assert(appliedName);
    const applied = await fs.readFile(path.join(directory, appliedName), "utf8");
    const sidHex = /^sidString=([0-9a-f]+)$/mu.exec(applied)?.[1];
    assert(sidHex);
    executionSid = Buffer.from(sidHex, "hex").toString("utf16le");
    await started.handle.crashHostForTest();
    await started.handle.completed;
    started = undefined;

    await fs.mkdir(nestedDirectory);
    await fs.writeFile(nestedFile, "SEC03_PROTECTED_RECOVERY", "utf8");
    await icacls(nestedFile, "/inheritance:d", "/Q");
    await icacls(nestedDirectory, "/inheritance:d", "/Q");
    await icacls(nestedDirectory, "/remove:g", `*${executionSid}`, "/Q");
    assert.equal((await icacls(nestedDirectory)).stdout.includes(executionSid), false);
    assert.equal((await icacls(nestedFile)).stdout.includes(executionSid), true);

    const recoveryLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
    await recoveryLease.close();
    recovered = true;
    assert.deepEqual((await fs.readdir(directory)).filter(name => !baseline.has(name)), []);
    assert.equal((await icacls(nestedFile)).stdout.includes(executionSid), false);
  } finally {
    if (started) {
      try { await started.handle.crashHostForTest(); } catch {}
      await started.handle.completed.catch(() => undefined);
    }
    if (!recovered && executionSid) await icacls(nestedFile, "/remove:g", `*${executionSid}`, "/Q").catch(() => undefined);
    if (!recovered) {
      const recoveryLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
      await recoveryLease.close();
      recovered = true;
    }
    if (recovered) await fs.rm(root, { recursive: true, force: true });
  }
});

windowsTest("SEC-03 J5 state gates and newest-first deletion remain crash recoverable", { timeout: 60_000 }, async () => {
  const { host, launcher, addon } = await testNativeArtifacts();
  const directory = await recoveryDirectory();
  const initialLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
  await initialLease.close();
  const baseline = new Set(await fs.readdir(directory));
  const previousCrash = process.env.MINI_LUX_SEC03_NATIVE_TEST_CRASH;
  for (const scenario of [
    { marker: "force-active-process-proof-failure", expectedGenerations: [1, 2] },
    { marker: "journal-delete-newest", expectedGenerations: [1, 2, 3] },
  ]) {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), `mini-lux-sec03-${scenario.marker}-`));
    let recovered = false;
    try {
      process.env.MINI_LUX_SEC03_NATIVE_TEST_CRASH = scenario.marker;
      const started = await start(addon, host, launcher, await launchBody(root, "echo SEC03_STATE_GATE"));
      await started.handle.completed;
      const names = (await fs.readdir(directory)).filter(name => !baseline.has(name));
      const generations = names.filter(name => /\.jrn$/u.test(name)).map(name => Number(/\.(\d{4})\.jrn$/u.exec(name)?.[1])).sort((left, right) => left - right);
      assert.deepEqual(generations, scenario.expectedGenerations, scenario.marker);
      const recoveryLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
      await recoveryLease.close();
      recovered = true;
      assert.deepEqual((await fs.readdir(directory)).filter(name => !baseline.has(name)), []);
    } finally {
      if (!recovered) {
        const recoveryLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
        await recoveryLease.close();
        recovered = true;
      }
      if (recovered) await fs.rm(root, { recursive: true, force: true });
    }
  }
  if (previousCrash === undefined) delete process.env.MINI_LUX_SEC03_NATIVE_TEST_CRASH;
  else process.env.MINI_LUX_SEC03_NATIVE_TEST_CRASH = previousCrash;
});

windowsTest("SEC-03 J5 journal parser rejects noncanonical descendant ledgers", { timeout: 60_000 }, async () => {
  const { host, launcher, addon } = await testNativeArtifacts();
  const directory = await recoveryDirectory();
  const initialLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
  await initialLease.close();
  const baseline = new Set(await fs.readdir(directory));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec03-j5-canonical-"));
  await fs.writeFile(path.join(root, "first.txt"), "first", "utf8");
  await fs.writeFile(path.join(root, "second.txt"), "second", "utf8");
  const previousCrash = process.env.MINI_LUX_SEC03_NATIVE_TEST_CRASH;
  let journalPath;
  let original;
  let recovered = false;
  try {
    process.env.MINI_LUX_SEC03_NATIVE_TEST_CRASH = "prepared";
    const started = await start(addon, host, launcher, await launchBody(root, "echo SEC03_MUST_NOT_RUN"));
    await started.handle.completed;
    const journalName = (await fs.readdir(directory)).find(name => !baseline.has(name) && /\.0001\.jrn$/u.test(name));
    assert(journalName);
    journalPath = path.join(directory, journalName);
    original = await fs.readFile(journalPath, "utf8");
    const ledger = /^descendants=(.+)$/mu.exec(original)?.[1];
    assert(ledger);
    const tokens = ledger.split(";");
    assert.equal(tokens.length >= 2, true);
    const duplicate = tokens[1].split(",");
    duplicate[0] = tokens[0].split(",")[0];
    const mutations = [
      `${ledger};`,
      ledger.replace(";", ";;"),
      `0${ledger}`,
      [tokens[1], tokens[0], ...tokens.slice(2)].join(";"),
      [tokens[0], duplicate.join(","), ...tokens.slice(2)].join(";"),
    ];
    for (const mutation of mutations) {
      await fs.writeFile(journalPath, original.replace(`descendants=${ledger}`, `descendants=${mutation}`), "utf8");
      assert.throws(() => addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256), error => error?.code === "EXEC_ACL_RECOVERY_REQUIRED");
    }
    await fs.writeFile(journalPath, original, "utf8");
    const recoveryLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
    await recoveryLease.close();
    recovered = true;
    assert.deepEqual((await fs.readdir(directory)).filter(name => !baseline.has(name)), []);
  } finally {
    if (previousCrash === undefined) delete process.env.MINI_LUX_SEC03_NATIVE_TEST_CRASH;
    else process.env.MINI_LUX_SEC03_NATIVE_TEST_CRASH = previousCrash;
    if (!recovered && journalPath && original) {
      await fs.writeFile(journalPath, original, "utf8");
      const recoveryLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
      await recoveryLease.close();
      recovered = true;
    }
    if (recovered) await fs.rm(root, { recursive: true, force: true });
  }
});

windowsTest("SEC-03 J5 recovery retains journals for missing or ACL-drifted ledger identities", { timeout: 60_000 }, async () => {
  const { host, launcher, addon } = await testNativeArtifacts();
  const directory = await recoveryDirectory();
  const initialLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
  await initialLease.close();
  const baseline = new Set(await fs.readdir(directory));

  async function crashApplied(root) {
    const started = await start(addon, host, launcher, await launchBody(root, "for /L %i in (1,1,2000000000) do @rem"));
    const names = await waitFor(async () => {
      const current = (await fs.readdir(directory)).filter(name => !baseline.has(name));
      return current.some(name => /\.0002\.jrn$/u.test(name)) ? current : null;
    });
    const appliedName = names.find(name => /\.0002\.jrn$/u.test(name));
    assert(appliedName);
    const applied = await fs.readFile(path.join(directory, appliedName), "utf8");
    const sidHex = /^sidString=([0-9a-f]+)$/mu.exec(applied)?.[1];
    assert(sidHex);
    await started.handle.crashHostForTest();
    await started.handle.completed;
    return { names, executionSid: Buffer.from(sidHex, "hex").toString("utf16le") };
  }

  const missingRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec03-j5-missing-"));
  const missingFile = path.join(missingRoot, "missing.txt");
  await fs.writeFile(missingFile, "missing", "utf8");
  const missing = await crashApplied(missingRoot);
  await fs.rm(missingFile);
  assert.throws(() => addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256), error => error?.code === "EXEC_ACL_RECOVERY_REQUIRED");
  assert.equal((await fs.readdir(directory)).filter(name => !baseline.has(name)).length > 0, true);
  assert.equal((await icacls(missingRoot)).stdout.includes(missing.executionSid), false);
  for (const name of missing.names) await fs.rm(path.join(directory, name), { force: true });
  await fs.rm(missingRoot, { recursive: true, force: true });

  const driftRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec03-j5-drift-"));
  const driftFile = path.join(driftRoot, "drift.txt");
  await fs.writeFile(driftFile, "drift", "utf8");
  let driftRecovered = false;
  try {
    const drift = await crashApplied(driftRoot);
    await icacls(driftFile, "/grant", "*S-1-5-20:(R)", "/Q");
    assert.throws(() => addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256), error => error?.code === "EXEC_ACL_RECOVERY_REQUIRED");
    assert.equal((await fs.readdir(directory)).filter(name => !baseline.has(name)).length > 0, true);
    assert.equal((await icacls(driftFile)).stdout.includes(drift.executionSid), true);
    await icacls(driftFile, "/remove:g", "*S-1-5-20", "/Q");
    const recoveryLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
    await recoveryLease.close();
    driftRecovered = true;
    assert.deepEqual((await fs.readdir(directory)).filter(name => !baseline.has(name)), []);
    assert.equal((await icacls(driftFile)).stdout.includes(drift.executionSid), false);
  } finally {
    if (!driftRecovered) await icacls(driftFile, "/remove:g", "*S-1-5-20", "/Q").catch(() => undefined);
    if (!driftRecovered) {
      const recoveryLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
      await recoveryLease.close();
      driftRecovered = true;
    }
    if (driftRecovered) await fs.rm(driftRoot, { recursive: true, force: true });
  }
});

windowsTest("SEC-03 native startup recovery rejects corrupt and generation-gap journals before launch", async () => {
  const { host, launcher, addon } = await testNativeArtifacts();
  const directory = await recoveryDirectory();
  const initialLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
  await initialLease.close();
  const corrupt = path.join(directory, `txn-${"a".repeat(32)}.0001.jrn`);
  const gap = path.join(directory, `txn-${"b".repeat(32)}.0002.jrn`);
  const unpublished = path.join(directory, `txn-${"c".repeat(32)}.0001.tmp`);
  try {
    await fs.writeFile(unpublished, "unpublished", { flag: "wx" });
    const unpublishedLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
    await unpublishedLease.close();
    await assert.rejects(fs.access(unpublished));
    await fs.writeFile(corrupt, "MLSEC03J3\ninvalid=true\n", { flag: "wx" });
    assert.throws(
      () => addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256),
      error => error?.code === "EXEC_ACL_RECOVERY_REQUIRED",
    );
    await fs.rm(corrupt);
    await fs.writeFile(gap, "MLSEC03J3\ninvalid=true\n", { flag: "wx" });
    assert.throws(
      () => addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256),
      error => error?.code === "EXEC_ACL_RECOVERY_REQUIRED",
    );
  } finally {
    await fs.rm(corrupt, { force: true });
    await fs.rm(gap, { force: true });
    await fs.rm(unpublished, { force: true });
  }
  const finalLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
  await finalLease.close();
});

windowsTest("SEC-03 native recovery rejects candidate drift and root object replacement", { timeout: 60_000 }, async () => {
  const { host, launcher, addon } = await testNativeArtifacts();
  const directory = await recoveryDirectory();
  const initialLease = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
  await initialLease.close();
  const baseline = new Set(await fs.readdir(directory));

  async function orphan(root) {
    const started = await start(addon, host, launcher, await launchBody(root, "for /L %i in (1,1,2000000000) do @rem"));
    const names = await waitFor(async () => {
      const current = (await fs.readdir(directory)).filter(name => !baseline.has(name));
      return current.some(name => /\.0002\.jrn$/u.test(name)) ? current : null;
    });
    await started.handle.crashHostForTest();
    await started.handle.completed;
    return names.filter(name => /\.jrn$/u.test(name)).map(name => path.join(directory, name));
  }

  const candidateRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec03-candidate-"));
  try {
    const journals = await orphan(candidateRoot);
    const originals = await Promise.all(journals.map(file => fs.readFile(file, "utf8")));
    for (let index = 0; index < journals.length; index += 1) {
      const changed = originals[index].replace(`candidateHostSha256=${host.sha256}`, `candidateHostSha256=${"c".repeat(64)}`);
      assert.notEqual(changed, originals[index]);
      await fs.writeFile(journals[index], changed, "utf8");
    }
    assert.throws(
      () => addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256),
      error => error?.code === "EXEC_ACL_RECOVERY_REQUIRED",
    );
    await Promise.all(journals.map((file, index) => fs.writeFile(file, originals[index], "utf8")));
    const recovered = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
    await recovered.close();
  } finally {
    try {
      const recovered = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
      await recovered.close();
    } catch {}
    await fs.rm(candidateRoot, { recursive: true, force: true });
  }

  const replacementParent = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec03-root-swap-"));
  const recordedRoot = path.join(replacementParent, "root");
  const retainedRoot = path.join(replacementParent, "retained-root");
  await fs.mkdir(recordedRoot);
  let swapped = false;
  try {
    await orphan(recordedRoot);
    await fs.rename(recordedRoot, retainedRoot);
    await fs.mkdir(recordedRoot);
    swapped = true;
    assert.throws(
      () => addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256),
      error => error?.code === "EXEC_ACL_RECOVERY_REQUIRED",
    );
    await fs.rm(recordedRoot, { recursive: true, force: true });
    await fs.rename(retainedRoot, recordedRoot);
    swapped = false;
    const recovered = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
    await recovered.close();
  } finally {
    if (swapped) {
      await fs.rm(recordedRoot, { recursive: true, force: true });
      await fs.rename(retainedRoot, recordedRoot).catch(() => undefined);
    }
    try {
      const recovered = addon.openExclusiveHostLease(host.sha256, host.bytes, launcher.sha256);
      await recovered.close();
    } catch {}
    await fs.rm(replacementParent, { recursive: true, force: true });
  }
});
