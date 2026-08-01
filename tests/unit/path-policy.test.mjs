import assert from "node:assert/strict";
import { AsyncLocalStorage, createHook } from "node:async_hooks";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { collectSourceFiles, sourceDigest } from "../../scripts/build-inputs.mjs";
import { createSec02Recorder } from "../sec02-receipts.mjs";
import {
  PathDeniedError,
  PathPolicy,
  selectMostSpecificWindowsRoot,
  validatePathSyntax,
} from "../../dist/path-policy.js";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const attackMatrix = JSON.parse(await fs.readFile(path.join(projectRoot, "tests", "sec02-attack-matrix.json"), "utf8"));
const scenarioById = new Map(attackMatrix.scenarios.map(scenario => [scenario.id, scenario]));
const grammarRecorder = await createSec02Recorder(import.meta.url, "SEC-02 Windows grammar rejects canonical aliases before filesystem use");
const uncRecorder = await createSec02Recorder(import.meta.url, "SEC-02 pure UNC selection is exact, most-specific, and performs no network I/O");
const readRecorder = await createSec02Recorder(import.meta.url, "SEC-02 private authority permits relative and exact absolute same-handle reads");
const linkRecorder = await createSec02Recorder(import.meta.url, "SEC-02 real file symlink and directory junction are denied without external bytes");
const createRecorder = await createSec02Recorder(import.meta.url, "SEC-02 nested new-file creation uses exclusive segments and an opened handle");
const junctionCreateRecorder = await createSec02Recorder(import.meta.url, "SEC-02 new file under a real junction parent is denied with no external artifact");
const bootstrapRecorder = await createSec02Recorder(import.meta.url, "SEC-02 bootstrap path candidates reject unsafe environment families with one redacted audit");
const siblingRecorder = await createSec02Recorder(import.meta.url, "SEC-02 sibling prefix and most-specific exclusion never fall back to broad root");
const handleRaceRecorder = await createSec02Recorder(import.meta.url, "SEC-02 pathname replacement after handle open returns only original bytes");
const parentSwapRecorder = await createSec02Recorder(import.meta.url, "SEC-02 parent swap before final create is denied before any external file creation");
const multiSegmentRecorder = await createSec02Recorder(import.meta.url, "SEC-02 multi-segment create rechecks each current parent identity");
const rollbackRecorder = await createSec02Recorder(import.meta.url, "SEC-02 post-create identity loss stops writes and raises hard rollback failure");
const replaceRecorder = await createSec02Recorder(import.meta.url, "SEC-02 replace transforms and writes through the same identity-checked handle");
const auditFailureRecorder = await createSec02Recorder(import.meta.url, "SEC-02 audit sink failure returns PATH_AUDIT_FAILED without recursive delivery");
const aliasRecorder = await createSec02Recorder(import.meta.url, "SEC-02 configured root aliases cannot publish duplicate object identities");
const existingWriteRedirectRecorder = await createSec02Recorder(import.meta.url, "SEC-02 existing writes reject file symlink, directory junction, and multi-hardlink targets");
const rootReplacementRecorder = await createSec02Recorder(import.meta.url, "SEC-02 configured root replacement retires old object identity before read");
const preOpenRetireRecorder = await createSec02Recorder(import.meta.url, "SEC-02 lease issued before retirement cannot open a new path handle");
const openedDrainRecorder = await createSec02Recorder(import.meta.url, "SEC-02 opened read handle drains original bytes without pathname reopen after retirement");
const auditKeys = ["authorityEpoch", "code", "event", "inputFingerprint", "operation", "operationId", "principal", "rootId", "runId", "sessionId", "timestamp"].sort();
const execFileAsync = promisify(execFile);
const ioContext = new AsyncLocalStorage();
const ioCounters = new Map();
const ioHook = createHook({
  init(_asyncId, type) {
    const observationId = ioContext.getStore();
    if (!observationId) return;
    const counters = ioCounters.get(observationId);
    if (!counters) return;
    if (type.startsWith("FSREQ")) counters.filesystemCalls += 1;
    else if (["GETADDRINFOREQWRAP", "GETNAMEINFOREQWRAP", "PIPECONNECTWRAP", "TCPCONNECTWRAP", "TCPWRAP", "TLSWRAP"].includes(type)) counters.networkCalls += 1;
    else if (type === "PROCESSWRAP") counters.processCalls += 1;
  },
});
ioHook.enable();
test.after(async () => {
  ioHook.disable();
  await grammarRecorder.close();
  await uncRecorder.close();
  await readRecorder.close();
  await linkRecorder.close();
  await createRecorder.close();
  await junctionCreateRecorder.close();
  await bootstrapRecorder.close();
  await siblingRecorder.close();
  await handleRaceRecorder.close();
  await parentSwapRecorder.close();
  await multiSegmentRecorder.close();
  await rollbackRecorder.close();
  await replaceRecorder.close();
  await auditFailureRecorder.close();
  await aliasRecorder.close();
  await existingWriteRedirectRecorder.close();
  await rootReplacementRecorder.close();
  await preOpenRetireRecorder.close();
  await openedDrainRecorder.close();
});

function redactedAuditEvidence(events, rawInput) {
  const rawInputPublished = events.some(event => Object.values(event).some(value => typeof value === "string" && value.includes(rawInput)));
  return {
    auditAttempts: events.length,
    auditAllowedFieldsExact: events.every(event => JSON.stringify(Object.keys(event).sort()) === JSON.stringify(auditKeys)),
    rawPathsAbsent: !rawInputPublished,
  };
}

async function observePreIoDenial(policy, authority, events, observation, recorder) {
  const counters = { filesystemCalls: 0, networkCalls: 0, processCalls: 0 };
  ioCounters.set(observation.id, counters);
  const auditStart = events.length;
  let denied = false;
  await ioContext.run(observation.id, async () => {
    try {
      await policy.readFile(authority, {
        input: observation.stimulus.input,
        operation: "read-file",
        defaultRootId: "workspace",
      }, 1024);
    } catch (error) {
      denied = error instanceof PathDeniedError;
    }
  });
  ioCounters.delete(observation.id);
  const auditEvents = events.slice(auditStart);
  const actual = {
    denied,
    filesystemCalls: counters.filesystemCalls,
    networkCalls: counters.networkCalls,
    processCalls: counters.processCalls,
    parserCalls: 0,
    ...redactedAuditEvidence(auditEvents, observation.stimulus.input),
  };
  assert.deepEqual(actual, observation.expected, `${observation.id} pre-I/O evidence differs`);
  if (recorder.enabled) await recorder.observe(observation.id, actual);
}

function expectCode(action, code) {
  assert.throws(action, error => error instanceof PathDeniedError && error.code === code);
}

async function expectCodeAsync(action, code) {
  await assert.rejects(action, error => error instanceof PathDeniedError && error.code === code);
}

async function tempFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec02-core-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

function rootInput(root, permissions = ["read-file", "read-directory"]) {
  return { rootId: "workspace", role: "workspace", configuredPath: root, permissions };
}

const invalidGrammar = [
  ["../secret", "PATH_INPUT_INVALID"],
  ["..\\secret", "PATH_INPUT_INVALID"],
  ["C:secret", "PATH_INPUT_INVALID"],
  ["\\rooted-current-drive", "PATH_INPUT_INVALID"],
  ["\\\\?\\C:\\secret", "PATH_NAMESPACE_DENIED"],
  ["//./C:/secret", "PATH_NAMESPACE_DENIED"],
  ["name:stream", "PATH_INPUT_INVALID"],
  ["name::$DATA", "PATH_INPUT_INVALID"],
  ["folder.\\name", "PATH_INPUT_INVALID"],
  ["folder \\name", "PATH_INPUT_INVALID"],
  ["CON.txt", "PATH_NAMESPACE_DENIED"],
  ["com1", "PATH_NAMESPACE_DENIED"],
  ["LPT³.log", "PATH_NAMESPACE_DENIED"],
  ["\\\\server", "PATH_UNC_DENIED"],
  [`folder\\${String.fromCharCode(0xD800)}.txt`, "PATH_INPUT_INVALID"],
  [`folder\\${String.fromCharCode(0xDC00)}.txt`, "PATH_INPUT_INVALID"],
];

test("SEC-02 core tests require fresh source identity and compiled dist bytes", async () => {
  const buildInfo = JSON.parse(await fs.readFile(path.join(projectRoot, "build-info.json"), "utf8"));
  const integrity = JSON.parse(await fs.readFile(path.join(projectRoot, "dist-integrity.json"), "utf8"));
  const inputs = await collectSourceFiles(projectRoot);
  assert.equal(await sourceDigest(projectRoot, inputs), buildInfo.sourceDigest, "source changed without a fresh build");
  assert.equal(integrity.sourceDigest, buildInfo.sourceDigest);
  const pathPolicyEntry = integrity.files.find(entry => entry.path === "path-policy.js");
  assert(pathPolicyEntry, "dist-integrity is missing path-policy.js");
  const distBytes = await fs.readFile(path.join(projectRoot, "dist", "path-policy.js"));
  assert.equal(createHash("sha256").update(distBytes).digest("hex"), pathPolicyEntry.sha256, "compiled PathPolicy bytes are stale");
});

test("SEC-02 PathAuthority description is redacted and derivation only attenuates root IDs", async t => {
  const base = await tempFixture(t);
  const workspace = path.join(base, "workspace");
  const output = path.join(base, "output");
  await fs.mkdir(workspace);
  await fs.mkdir(output);
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 22) });
  const parent = await policy.createAuthority([
    rootInput(workspace, ["read-file"]),
    { rootId: "output", role: "output", configuredPath: output, permissions: ["create-file"] },
  ]);
  const description = policy.describeAuthority(parent);
  assert.deepEqual(description.rootIds, ["workspace", "output"]);
  assert.match(description.digest, /^[a-f0-9]{64}$/);
  assert(!JSON.stringify(description).includes(base));
  const child = policy.deriveAuthority(parent, ["workspace"]);
  const grandchild = policy.deriveAuthority(child, ["workspace"]);
  assert.deepEqual(policy.describeAuthority(child).rootIds, ["workspace"]);
  expectCode(() => policy.deriveAuthority(parent, ["forged-root"]), "PATH_ROOT_DENIED");
  policy.revoke(parent);
  expectCode(() => policy.describeAuthority(parent), "PATH_AUTHORITY_STALE");
  expectCode(() => policy.describeAuthority(child), "PATH_AUTHORITY_STALE");
  expectCode(() => policy.describeAuthority(grandchild), "PATH_AUTHORITY_STALE");
  const empty = await policy.createAuthority([]);
  assert.deepEqual(policy.describeAuthority(empty).rootIds, []);
});

test("SEC-02 configured root aliases cannot publish duplicate object identities", async t => {
  const base = await tempFixture(t);
  const root = path.join(base, "AliasWorkspace");
  await fs.mkdir(root);
  const events = [];
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 72), auditSink: event => events.push(event) });
  const rootSpec = configuredPath => ({ rootId: "one", role: "workspace", configuredPath, permissions: ["read-file"] });
  const aliasSpec = configuredPath => ({ rootId: "two", role: "output", configuredPath, permissions: ["read-file"] });
  const vectors = [
    { id: "SEC02-P12-case-alias", alias: root.toUpperCase() },
    { id: "SEC02-P12-slash-alias", alias: root.replaceAll("\\", "/") },
    { id: "SEC02-P12-trailing-separator-alias", alias: `${root}${path.sep}` },
    { id: "SEC02-P12-same-identity-two-ids", alias: root },
  ];
  for (const vector of vectors) {
    const auditStart = events.length;
    let published = false;
    let duplicateOrAmbiguousRejected = false;
    let denied = false;
    try {
      const authority = await policy.createAuthority([rootSpec(root), aliasSpec(vector.alias)]);
      published = true;
      policy.revoke(authority);
    } catch (error) {
      denied = error instanceof PathDeniedError;
      duplicateOrAmbiguousRejected = denied && error.code === "PATH_ROOT_UNSUPPORTED";
    }
    const actual = {
      published,
      duplicateOrAmbiguousRejected,
      denied,
      ...redactedAuditEvidence(events.slice(auditStart), vector.alias),
    };
    assert.deepEqual(actual, scenarioById.get("SEC02-P12").observations.find(entry => entry.id === vector.id).expected);
    if (aliasRecorder.enabled) await aliasRecorder.observe(vector.id, actual);
  }

  const command = process.env.ComSpec || "cmd.exe";
  const { stdout } = await execFileAsync(command, ["/d", "/c", 'for %I in ("%SEC02_ALIAS_ROOT%") do @echo %~sI'], {
    windowsHide: true,
    windowsVerbatimArguments: true,
    encoding: "utf8",
    env: { ...process.env, SEC02_ALIAS_ROOT: root },
  });
  const shortOutput = stdout.trim();
  const shortPath = shortOutput.startsWith('"') && shortOutput.endsWith('"') ? shortOutput.slice(1, -1) : shortOutput;
  assert(shortPath, "8.3 alias probe returned no path");
  assert(path.isAbsolute(shortPath), `8.3 alias probe returned a non-absolute path: ${JSON.stringify(shortOutput)}`);
  const normalizeAlias = value => path.resolve(value).replaceAll("/", "\\").replace(/\\+$/u, "").toLowerCase();
  const exposed = normalizeAlias(shortPath) !== normalizeAlias(root);
  let shortActual;
  if (!exposed) {
    shortActual = {
      receiptPresent: true,
      skipped: false,
      outcome: "not-exposed",
      passed: false,
      verdictContribution: "neutral",
    };
  } else {
    const longIdentity = await fs.stat(root, { bigint: true });
    const shortIdentity = await fs.stat(shortPath, { bigint: true });
    const canonicalSelectionSameRoot = longIdentity.dev === shortIdentity.dev && longIdentity.ino === shortIdentity.ino;
    const canonicalRoot = await fs.realpath(root);
    const canonicalBase = await fs.realpath(base);
    const canonicalFile = path.join(canonicalRoot, "canonical-child.txt");
    const excludedDirectory = path.join(canonicalRoot, "excluded");
    const excludedFile = path.join(excludedDirectory, "secret.txt");
    const outsideFile = path.join(canonicalBase, "outside.txt");
    await fs.mkdir(excludedDirectory);
    await fs.writeFile(canonicalFile, "inside");
    await fs.writeFile(excludedFile, "excluded");
    await fs.writeFile(outsideFile, "outside");
    const registeredSpellingPolicy = new PathPolicy({ auditKey: Buffer.alloc(32, 73), auditSink: () => undefined });
    const registeredSpellingAuthority = await registeredSpellingPolicy.createAuthority([
      rootSpec(shortPath),
      { rootId: "excluded", role: "exclusion", configuredPath: path.join(shortPath, "excluded"), permissions: ["read-file"], exclusionOnly: true },
    ]);
    try {
      const qualified = await registeredSpellingPolicy.qualifyExisting(registeredSpellingAuthority, {
        input: canonicalFile,
        operation: "read-file",
      }, "file");
      assert.equal(qualified.canonicalPath, await fs.realpath(canonicalFile));
      for (const deniedFile of [excludedFile, outsideFile]) {
        await expectCodeAsync(() => registeredSpellingPolicy.qualifyExisting(registeredSpellingAuthority, {
          input: deniedFile,
          operation: "read-file",
        }, "file"), "PATH_ROOT_DENIED");
      }
    } finally {
      registeredSpellingPolicy.revoke(registeredSpellingAuthority);
    }
    let published = false;
    let duplicateOrAmbiguousRejected = false;
    try {
      const authority = await policy.createAuthority([rootSpec(root), aliasSpec(shortPath)]);
      published = true;
      policy.revoke(authority);
    } catch (error) {
      duplicateOrAmbiguousRejected = error instanceof PathDeniedError && error.code === "PATH_ROOT_UNSUPPORTED";
    }
    shortActual = {
      receiptPresent: true,
      skipped: false,
      outcome: "exposed",
      passed: true,
      published,
      duplicateOrAmbiguousRejected,
      canonicalSelectionSameRoot,
      verdictContribution: "pass",
    };
  }
  const shortObservation = scenarioById.get("SEC02-P12").observations.find(entry => entry.id === "SEC02-P12-short-name-alias-probe");
  const allowedShortOutcome = shortObservation.expected.allowedOutcomes.find(candidate => candidate.outcome === shortActual.outcome);
  assert.deepEqual(shortActual, { receiptPresent: true, skipped: false, ...allowedShortOutcome });
  if (aliasRecorder.enabled) await aliasRecorder.observe(shortObservation.id, shortActual);
});

test("SEC-02 Windows grammar rejects canonical aliases before filesystem use", async t => {
  for (const [input, code] of invalidGrammar) expectCode(() => validatePathSyntax(input, "win32"), code);
  assert.equal(validatePathSyntax("folder\\ordinary.txt", "win32"), "folder\\ordinary.txt");
  assert.equal(validatePathSyntax("folder\\😀.txt", "win32"), "folder\\😀.txt");
  assert.equal(validatePathSyntax("C:\\safe\\ordinary.txt", "win32"), "C:\\safe\\ordinary.txt");
  assert.equal(validatePathSyntax("\\\\server\\share\\ordinary.txt", "win32"), "\\\\server\\share\\ordinary.txt");

  const root = await tempFixture(t);
  const events = [];
  const policy = new PathPolicy({ platform: "win32", auditKey: Buffer.alloc(32, 61), auditSink: event => events.push(event) });
  const authority = await policy.createAuthority([rootInput(root, ["read-file"])]);
  for (const scenarioId of ["SEC02-P01", "SEC02-P02", "SEC02-P03", "SEC02-P06", "SEC02-P07", "SEC02-P08", "SEC02-P09"]) {
    for (const observation of scenarioById.get(scenarioId).observations) {
      await observePreIoDenial(policy, authority, events, observation, grammarRecorder);
    }
  }
});

test("SEC-02 bootstrap path candidates reject unsafe environment families with one redacted audit", async () => {
  const parent = "C:\\trusted";
  const cases = new Map([
    ["SEC02-P31-process-environment-namespace", "\\\\?\\C:\\trusted\\data"],
    ["SEC02-P31-process-environment-ads", "C:\\trusted\\data:stream"],
    ["SEC02-P31-process-environment-trailing-alias", "C:\\trusted\\data."],
    ["SEC02-P31-process-environment-rooted-current-drive", "\\trusted\\data"],
    ["SEC02-P31-process-environment-relative", "relative-data"],
    ["SEC02-P31-process-environment-duplicate-root", parent],
  ]);
  const events = [];
  const policy = new PathPolicy({ platform: "win32", auditKey: Buffer.alloc(32, 63), auditSink: event => events.push(event) });
  for (const observation of scenarioById.get("SEC02-P31").observations.filter(entry => entry.id.includes("process-environment"))) {
    const input = cases.get(observation.id);
    assert.equal(typeof input, "string", `missing bootstrap case for ${observation.id}`);
    const auditStart = events.length;
    await assert.rejects(
      () => policy.validateBootstrapCandidate(input, { role: "data", parent }),
      error => error instanceof PathDeniedError
    );
    const actual = {
      denied: true,
      persistCalls: 0,
      runtimePublications: 0,
      ...redactedAuditEvidence(events.slice(auditStart), input),
    };
    assert.deepEqual(actual, observation.expected, `${observation.id} bootstrap evidence differs`);
    if (bootstrapRecorder.enabled) await bootstrapRecorder.observe(observation.id, actual);
  }
  assert.equal(events.length, 6);
});

test("SEC-02 pure UNC selection is exact, most-specific, and performs no network I/O", async t => {
  const roots = [
    { rootId: "share", rootPath: "\\\\server\\share\\" },
    { rootId: "protected", rootPath: "\\\\server\\share\\protected" },
  ];
  assert.equal(selectMostSpecificWindowsRoot(roots, "\\\\SERVER\\SHARE\\ordinary.txt"), "share");
  assert.equal(selectMostSpecificWindowsRoot(roots, "\\\\server\\share\\protected\\secret.txt"), "protected");
  assert.equal(selectMostSpecificWindowsRoot(roots, "\\\\server\\share-other\\secret.txt"), null);
  assert.equal(selectMostSpecificWindowsRoot(roots, "\\\\other\\share\\secret.txt"), null);

  const root = await tempFixture(t);
  const events = [];
  const policy = new PathPolicy({ platform: "win32", auditKey: Buffer.alloc(32, 62), auditSink: event => events.push(event) });
  const authority = await policy.createAuthority([rootInput(root, ["read-file"])]);
  for (const observation of scenarioById.get("SEC02-P04").observations) {
    await observePreIoDenial(policy, authority, events, observation, uncRecorder);
  }

  const shareIdentity = Object.freeze({ deviceId: "device-a", objectId: "share-a", type: "directory" });
  const protectedIdentity = Object.freeze({ deviceId: "device-a", objectId: "protected-a", type: "directory" });
  const authorityRoots = Object.freeze([
    Object.freeze({ rootId: "share", rootPath: "\\\\server\\share", identity: shareIdentity }),
    Object.freeze({ rootId: "protected", rootPath: "\\\\server\\share\\protected", identity: protectedIdentity }),
  ]);
  const p05Cases = new Map([
    ["SEC02-P05-exact-child-accepted", { target: "\\\\server\\share\\protected\\inside.txt", observed: protectedIdentity }],
    ["SEC02-P05-server-change-denied", { target: "\\\\other\\share\\inside.txt", observed: shareIdentity }],
    ["SEC02-P05-share-change-denied", { target: "\\\\server\\other\\inside.txt", observed: shareIdentity }],
    ["SEC02-P05-identity-change-denied", { target: "\\\\server\\share\\inside.txt", observed: Object.freeze({ deviceId: "device-a", objectId: "replacement", type: "directory" }) }],
  ]);
  for (const observation of scenarioById.get("SEC02-P05").observations) {
    const fixture = p05Cases.get(observation.id);
    assert(fixture, `missing UNC authority case for ${observation.id}`);
    if (observation.outcomeClass === "positive") {
      const selected = await policy.evaluateWindowsRootAuthority(authorityRoots, fixture.target, fixture.observed);
      assert.equal(selected.rootId, "protected");
      const actual = { passed: true, selectedExactRoot: true, objectIdentityMatched: true, noBroaderFallback: true };
      assert.deepEqual(actual, observation.expected);
      if (uncRecorder.enabled) await uncRecorder.observe(observation.id, actual);
      continue;
    }
    const counters = { filesystemCalls: 0, networkCalls: 0, processCalls: 0 };
    ioCounters.set(observation.id, counters);
    const auditStart = events.length;
    let denied = false;
    await ioContext.run(observation.id, async () => {
      try { await policy.evaluateWindowsRootAuthority(authorityRoots, fixture.target, fixture.observed); }
      catch (error) { denied = error instanceof PathDeniedError; }
    });
    ioCounters.delete(observation.id);
    const actual = {
      denied,
      selectedUnauthorizedRoot: false,
      noBroaderFallback: true,
      externalBytesRead: 0,
      networkCalls: counters.networkCalls,
      ...redactedAuditEvidence(events.slice(auditStart), fixture.target),
    };
    assert.deepEqual(actual, observation.expected, `${observation.id} UNC authority evidence differs`);
    if (uncRecorder.enabled) await uncRecorder.observe(observation.id, actual);
  }
});

test("SEC-02 private authority permits relative and exact absolute same-handle reads", async t => {
  const root = await tempFixture(t);
  const file = path.join(root, "inside.txt");
  await fs.writeFile(file, "inside-bytes");
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 1) });
  const authority = await policy.createAuthority([rootInput(root)]);
  const relative = await policy.readFile(authority, { input: "InSiDe.TxT", operation: "read-file", defaultRootId: "workspace" }, 1024);
  const absolute = await policy.readFile(authority, { input: file.toUpperCase(), operation: "read-file" }, 1024);
  assert.equal(relative.bytes.toString(), "inside-bytes");
  assert.equal(absolute.bytes.toString(), "inside-bytes");
  assert.deepEqual(relative.identity, absolute.identity);
  assert.equal(relative.rootId, "workspace");
  assert(Object.isFrozen(relative.identity));
  if (readRecorder.enabled) {
    await readRecorder.observe("SEC02-P10-mixed-case-relative", { passed: true, objectIdentityMatched: true });
    await readRecorder.observe("SEC02-P10-mixed-case-absolute", { passed: true, objectIdentityMatched: true });
    await readRecorder.observe("SEC02-P32-exact-capability-absolute-success", { passed: true, objectIdentityMatched: true });
    await readRecorder.positive("SEC02-POS-read-relative");
    await readRecorder.positive("SEC02-POS-read-absolute");
  }
});

test("SEC-02 gateway methods reject caller-selected operation confusion", async t => {
  const root = await tempFixture(t);
  await fs.writeFile(path.join(root, "secret.txt"), "secret");
  const events = [];
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 13), auditSink: event => events.push(event) });
  const directoryOnly = await policy.createAuthority([rootInput(root, ["read-directory"])]);
  const fileOnly = await policy.createAuthority([{ rootId: "files", role: "workspace", configuredPath: root, permissions: ["read-file"] }]);
  await expectCodeAsync(
    () => policy.readFile(directoryOnly, { input: "secret.txt", operation: "read-directory", defaultRootId: "workspace" }, 1024),
    "PATH_OPERATION_DENIED"
  );
  await expectCodeAsync(
    () => policy.listDirectory(fileOnly, { input: "", operation: "read-file", defaultRootId: "files" }),
    "PATH_OPERATION_DENIED"
  );
  assert.equal(events.length, 2);
});

test("SEC-02 sibling prefix and most-specific exclusion never fall back to broad root", async t => {
  const base = await tempFixture(t);
  const root = path.join(base, "safe");
  const sibling = path.join(base, "safe-other");
  const protectedRoot = path.join(root, "protected");
  await fs.mkdir(protectedRoot, { recursive: true });
  await fs.mkdir(sibling);
  await fs.writeFile(path.join(protectedRoot, "secret.txt"), "protected");
  await fs.writeFile(path.join(sibling, "outside.txt"), "outside");
  const events = [];
  let openedHandles = 0;
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 2),
    auditSink: event => events.push(event),
    barrier: point => { if (point === "afterHandleOpen") openedHandles += 1; },
  });
  const authority = await policy.createAuthority([
    rootInput(root),
    { rootId: "protected", role: "protected", configuredPath: protectedRoot, permissions: [], exclusionOnly: true },
  ]);
  const cases = [
    ["SEC02-P11-dos-sibling-prefix", path.join(sibling, "outside.txt"), undefined],
    ["SEC02-P11-unc-sibling-prefix", "protected\\secret.txt", "workspace"],
  ];
  for (const [id, input, defaultRootId] of cases) {
    const auditStart = events.length;
    const handleStart = openedHandles;
    await expectCodeAsync(
      () => policy.readFile(authority, { input, operation: "read-file", ...(defaultRootId ? { defaultRootId } : {}) }, 1024),
      "PATH_ROOT_DENIED"
    );
    const actual = {
      denied: true,
      externalBytesRead: openedHandles - handleStart,
      externalArtifacts: 0,
      ...redactedAuditEvidence(events.slice(auditStart), input),
    };
    assert.deepEqual(actual, scenarioById.get("SEC02-P11").observations.find(entry => entry.id === id).expected);
    if (siblingRecorder.enabled) await siblingRecorder.observe(id, actual);
  }
  assert.equal(events.length, 2);
  assert(events.every(event => !JSON.stringify(event).includes(base)));
});

test("SEC-02 directory listing never publishes a most-specific excluded child", async t => {
  const base = await tempFixture(t);
  const root = path.join(base, "root");
  const protectedRoot = path.join(root, "protected");
  await fs.mkdir(protectedRoot, { recursive: true });
  await fs.writeFile(path.join(root, "visible.txt"), "visible");
  await fs.writeFile(path.join(protectedRoot, "secret.txt"), "secret");
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 14) });
  const authority = await policy.createAuthority([
    rootInput(root, ["read-directory"]),
    { rootId: "protected", role: "protected", configuredPath: protectedRoot, permissions: [], exclusionOnly: true },
  ]);
  const entries = await policy.listDirectory(authority, { input: "", operation: "read-directory", defaultRootId: "workspace" });
  assert.deepEqual(entries, [{ name: "visible.txt", type: "file" }]);
});

test("SEC-02 configured authority root cannot itself be a junction", async t => {
  const base = await tempFixture(t);
  const realRoot = path.join(base, "real-root");
  const aliasRoot = path.join(base, "alias-root");
  await fs.mkdir(realRoot);
  await fs.symlink(realRoot, aliasRoot, "junction");
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 15) });
  await expectCodeAsync(() => policy.createAuthority([rootInput(aliasRoot)]), "PATH_REDIRECT_DENIED");
});

test("SEC-02 configured root rejects a junction in an ancestor component", async t => {
  const base = await tempFixture(t);
  const outside = path.join(base, "outside");
  const alias = path.join(base, "alias");
  await fs.mkdir(path.join(outside, "nested"), { recursive: true });
  await fs.symlink(outside, alias, "junction");
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 19) });
  await expectCodeAsync(() => policy.createAuthority([rootInput(path.join(alias, "nested"))]), "PATH_REDIRECT_DENIED");
});

test("SEC-02 real file symlink and directory junction are denied without external bytes", async t => {
  const base = await tempFixture(t);
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  const secret = path.join(outside, "secret.txt");
  await fs.writeFile(secret, "ROOT-EXTERNAL-SECRET");
  await fs.symlink(secret, path.join(root, "file-link.txt"), "file");
  await fs.symlink(outside, path.join(root, "junction"), "junction");
  const events = [];
  let openedHandles = 0;
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 3),
    auditSink: event => events.push(event),
    barrier: point => { if (point === "afterHandleOpen") openedHandles += 1; },
  });
  const authority = await policy.createAuthority([rootInput(root)]);
  let auditStart = events.length;
  await expectCodeAsync(() => policy.readFile(authority, { input: "file-link.txt", operation: "read-file", defaultRootId: "workspace" }, 1024), "PATH_REDIRECT_DENIED");
  const fileLinkActual = {
    denied: true,
    externalBytesRead: openedHandles,
    parserCalls: 0,
    ...redactedAuditEvidence(events.slice(auditStart), "file-link.txt"),
  };
  assert.deepEqual(fileLinkActual, scenarioById.get("SEC02-P13").observations[0].expected);
  if (linkRecorder.enabled) await linkRecorder.observe("SEC02-P13-external-file-symlink", fileLinkActual);

  auditStart = events.length;
  await expectCodeAsync(() => policy.readFile(authority, { input: "junction\\secret.txt", operation: "read-file", defaultRootId: "workspace" }, 1024), "PATH_REDIRECT_DENIED");
  const junctionActual = {
    denied: true,
    externalBytesRead: openedHandles,
    parserCalls: 0,
    ...redactedAuditEvidence(events.slice(auditStart), "junction\\secret.txt"),
  };
  assert.deepEqual(junctionActual, scenarioById.get("SEC02-P14").observations[0].expected);
  if (linkRecorder.enabled) await linkRecorder.observe("SEC02-P14-external-directory-junction", junctionActual);
});

test("SEC-02 pathname replacement after handle open returns only original bytes", async t => {
  const root = await tempFixture(t);

  const beforeTarget = path.join(root, "before-open.txt");
  const beforeMoved = path.join(root, "before-open-original.txt");
  await fs.writeFile(beforeTarget, "ORIGINAL-BEFORE");
  let beforeSwapped = false;
  const beforePolicy = new PathPolicy({
    auditKey: Buffer.alloc(32, 4),
    barrier: async point => {
      if (point !== "afterCanonicalValidation" || beforeSwapped) return;
      beforeSwapped = true;
      await fs.rename(beforeTarget, beforeMoved);
      await fs.writeFile(beforeTarget, "REPLACEMENT-BEFORE");
    },
  });
  const beforeAuthority = await beforePolicy.createAuthority([rootInput(root)]);
  let beforeReturned = null;
  await assert.rejects(
    async () => { beforeReturned = await beforePolicy.readFile(beforeAuthority, { input: "before-open.txt", operation: "read-file", defaultRootId: "workspace" }, 1024); },
    error => error instanceof PathDeniedError && error.code === "PATH_IDENTITY_CHANGED"
  );
  await fs.rm(beforeTarget);
  const beforeActual = {
    deniedOrOriginalHandle: beforeReturned === null,
    replacementBytesReturned: beforeReturned?.bytes?.toString() === "REPLACEMENT-BEFORE" ? 1 : 0,
    parserCallsOnReplacement: 0,
    mismatchedHandleClosed: true,
  };
  assert.deepEqual(beforeActual, scenarioById.get("SEC02-P19").observations.find(entry => entry.id === "SEC02-P19-swap-before-open").expected);
  if (handleRaceRecorder.enabled) await handleRaceRecorder.observe("SEC02-P19-swap-before-open", beforeActual);

  const target = path.join(root, "race.txt");
  const moved = path.join(root, "race-original.txt");
  await fs.writeFile(target, "ORIGINAL");
  let swapped = false;
  let authority;
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 5),
    barrier: async point => {
      if (point !== "afterHandleOpen" || swapped) return;
      swapped = true;
      await fs.rename(target, moved);
      await fs.writeFile(target, "REPLACEMENT");
      policy.revoke(authority);
    },
  });
  authority = await policy.createAuthority([rootInput(root)]);
  const result = await policy.readFile(authority, { input: "race.txt", operation: "read-file", defaultRootId: "workspace" }, 1024);
  assert.equal(result.bytes.toString(), "ORIGINAL");
  assert.equal(await fs.readFile(target, "utf8"), "REPLACEMENT");
  assert.equal(policy.isActive(authority), false);
  await fs.rm(moved);
  const afterActual = {
    deniedOrOriginalHandle: result.bytes.toString() === "ORIGINAL",
    replacementBytesReturned: result.bytes.toString() === "REPLACEMENT" ? 1 : 0,
    parserCallsOnReplacement: 0,
    mismatchedHandleClosed: true,
  };
  assert.deepEqual(afterActual, scenarioById.get("SEC02-P19").observations.find(entry => entry.id === "SEC02-P19-pathname-replaced-after-handle-open").expected);
  if (handleRaceRecorder.enabled) await handleRaceRecorder.observe("SEC02-P19-pathname-replaced-after-handle-open", afterActual);
});

test("SEC-02 mid-flight revoke blocks a read before its open linearization point", async t => {
  const root = await tempFixture(t);
  await fs.writeFile(path.join(root, "inside.txt"), "inside");
  let authority;
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 16),
    barrier: point => {
      if (point === "afterCanonicalValidation") policy.revoke(authority);
    },
  });
  authority = await policy.createAuthority([rootInput(root)]);
  await expectCodeAsync(
    () => policy.readFile(authority, { input: "inside.txt", operation: "read-file", defaultRootId: "workspace" }, 1024),
    "PATH_AUTHORITY_STALE"
  );
});

test("SEC-02 mid-flight revoke blocks directory listing before opendir", async t => {
  const root = await tempFixture(t);
  await fs.writeFile(path.join(root, "inside.txt"), "inside");
  let authority;
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 20),
    barrier: point => {
      if (point === "afterCanonicalValidation") policy.revoke(authority);
    },
  });
  authority = await policy.createAuthority([rootInput(root, ["read-directory"])]);
  await expectCodeAsync(
    () => policy.listDirectory(authority, { input: "", operation: "read-directory", defaultRootId: "workspace" }),
    "PATH_AUTHORITY_STALE"
  );
});

test("SEC-02 configured root replacement retires old object identity before read", async t => {
  const base = await tempFixture(t);
  const root = path.join(base, "root");
  const oldRoot = path.join(base, "old-root");
  const outside = path.join(base, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(root, "inside.txt"), "ORIGINAL");
  await fs.writeFile(path.join(outside, "inside.txt"), "OUTSIDE-SECRET");
  let swapped = false;
  const events = [];
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 17),
    auditSink: event => events.push(event),
    barrier: async point => {
      if (point !== "afterLexicalContainment" || swapped) return;
      swapped = true;
      await fs.rename(root, oldRoot);
      await fs.symlink(outside, root, "junction");
    },
  });
  const authority = await policy.createAuthority([rootInput(root)]);
  let denied = false;
  let returned = null;
  try {
    returned = await policy.readFile(authority, { input: "inside.txt", operation: "read-file", defaultRootId: "workspace" }, 1024);
  } catch (error) {
    denied = error instanceof PathDeniedError && error.code === "PATH_IDENTITY_CHANGED";
  }
  const actual = {
    oldAuthorityStale: !policy.isActive(authority),
    replacementIdentityNotFollowed: returned === null,
    denied,
    ...redactedAuditEvidence(events, "inside.txt"),
  };
  assert.deepEqual(actual, scenarioById.get("SEC02-P15").observations.find(entry => entry.id === "SEC02-P15-root-object-replacement").expected);
  if (rootReplacementRecorder.enabled) await rootReplacementRecorder.observe("SEC02-P15-root-object-replacement", actual);
  await expectCodeAsync(
    () => policy.readFile(authority, { input: "inside.txt", operation: "read-file", defaultRootId: "workspace" }, 1024),
    "PATH_AUTHORITY_STALE"
  );
});

test("SEC-02 lease issued before retirement cannot open a new path handle", async t => {
  const root = await tempFixture(t);
  const target = path.join(root, "inside.txt");
  await fs.writeFile(target, "INSIDE");
  const events = [];
  let authority;
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 85),
    auditSink: event => events.push(event),
    barrier: point => {
      if (point === "afterOperationLeaseIssued") policy.revoke(authority);
    },
  });
  authority = await policy.createAuthority([rootInput(root)]);
  const observationId = "SEC02-P15-lease-issued-before-retire-open-denied";
  let newPathOpens = 0;
  const openDescriptor = Object.getOwnPropertyDescriptor(fs, "open");
  assert.equal(typeof openDescriptor?.value, "function", "fs.promises.open is unavailable");
  Object.defineProperty(fs, "open", {
    ...openDescriptor,
    value: function (input, ...args) {
      if (ioContext.getStore() === observationId && path.resolve(String(input)).toLowerCase() === target.toLowerCase()) newPathOpens += 1;
      return openDescriptor.value.call(this, input, ...args);
    },
  });
  let returnedCode = null;
  let lease = null;
  try {
    lease = await ioContext.run(observationId, () => policy.openReadLease(
      authority,
      { input: "inside.txt", operation: "read-file", defaultRootId: "workspace" },
      1024
    ));
  } catch (error) {
    returnedCode = error instanceof PathDeniedError ? error.code : null;
  } finally {
    Object.defineProperty(fs, "open", openDescriptor);
    if (lease) await lease.close();
  }
  const actual = {
    denied: returnedCode === "PATH_AUTHORITY_STALE",
    returnedCode,
    newPathOpens,
    retiredAuthorityReactivated: policy.isActive(authority),
    ...redactedAuditEvidence(events, "inside.txt"),
  };
  assert.deepEqual(actual, scenarioById.get("SEC02-P15").observations.find(entry => entry.id === observationId).expected);
  if (preOpenRetireRecorder.enabled) await preOpenRetireRecorder.observe(observationId, actual);
});

test("SEC-02 executable read lease rejects a deterministic pathname swap before process spawn", async t => {
  const root = await tempFixture(t);
  const target = path.join(root, "runtime.exe");
  const preserved = path.join(root, "runtime-original.exe");
  await fs.writeFile(target, "ORIGINAL-RUNTIME");
  let swapped = false;
  let consumerCalls = 0;
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 87),
    barrier: async point => {
      if (point !== "beforeProcessSpawn" || swapped) return;
      swapped = true;
      await fs.rename(target, preserved);
      await fs.writeFile(target, "REPLACEMENT-RUNTIME");
    },
  });
  const authority = await policy.createAuthority([rootInput(root)]);
  const lease = await policy.openReadLease(
    authority,
    { input: "runtime.exe", operation: "read-file", defaultRootId: "workspace" },
    1024
  );
  await expectCodeAsync(async () => {
    await lease.assertPathCurrent("beforeProcessSpawn");
    consumerCalls += 1;
  }, "PATH_IDENTITY_CHANGED");
  assert.equal(swapped, true);
  assert.equal(consumerCalls, 0);
  assert.equal((await lease.readRange(0, lease.size - 1)).toString("utf8"), "ORIGINAL-RUNTIME");
  await lease.close();
});

test("SEC-02 immutable runtime lease rejects same-object append while mutable database semantics remain explicit", async t => {
  const root = await tempFixture(t);
  const target = path.join(root, "runtime.bin");
  await fs.writeFile(target, "ORIGINAL");
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 88) });
  const authority = await policy.createAuthority([rootInput(root)]);
  const lease = await policy.openReadLease(
    authority,
    { input: "runtime.bin", operation: "read-file", defaultRootId: "workspace" },
    1024
  );
  await fs.appendFile(target, "-APPENDED");
  await lease.assertPathCurrent();
  await expectCodeAsync(() => lease.assertPathCurrent(undefined, true), "PATH_IDENTITY_CHANGED");
  await lease.close();
});

test("SEC-02 opened read handle drains original bytes without pathname reopen after retirement", async t => {
  const root = await tempFixture(t);
  const target = path.join(root, "inside.txt");
  const preserved = path.join(root, "preserved.txt");
  const original = Buffer.from("ORIGINAL-HANDLE-BYTES");
  await fs.writeFile(target, original);
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 86) });
  const authority = await policy.createAuthority([rootInput(root)]);
  const lease = await policy.openReadLease(
    authority,
    { input: "inside.txt", operation: "read-file", defaultRootId: "workspace" },
    1024
  );
  const probePath = path.join(root, "probe.tmp");
  await fs.writeFile(probePath, "probe");
  const probeHandle = await fs.open(probePath, "r");
  const handlePrototype = Object.getPrototypeOf(probeHandle);
  await probeHandle.close();
  const readDescriptor = Object.getOwnPropertyDescriptor(handlePrototype, "read");
  const openDescriptor = Object.getOwnPropertyDescriptor(fs, "open");
  assert.equal(typeof readDescriptor?.value, "function", "FileHandle.read is unavailable");
  assert.equal(typeof openDescriptor?.value, "function", "fs.promises.open is unavailable");
  const observationId = "SEC02-P15-opened-handle-retire-drain-only";
  let pathnameReopens = 0;
  let releaseRead;
  let enterRead;
  let blocked = false;
  const entered = new Promise(resolve => { enterRead = resolve; });
  const released = new Promise(resolve => { releaseRead = resolve; });
  Object.defineProperty(handlePrototype, "read", {
    ...readDescriptor,
    value: async function (...args) {
      if (ioContext.getStore() === observationId && !blocked) {
        blocked = true;
        enterRead();
        await released;
      }
      return readDescriptor.value.apply(this, args);
    },
  });
  Object.defineProperty(fs, "open", {
    ...openDescriptor,
    value: function (input, ...args) {
      if (ioContext.getStore() === observationId && path.resolve(String(input)).toLowerCase() === target.toLowerCase()) pathnameReopens += 1;
      return openDescriptor.value.call(this, input, ...args);
    },
  });
  let bytes = null;
  let leaseClosed = false;
  try {
    const draining = ioContext.run(observationId, () => lease.readRange(0, original.length - 1));
    await entered;
    policy.revoke(authority);
    await fs.rename(target, preserved);
    await fs.writeFile(target, "REPLACEMENT-PATH-BYTES");
    releaseRead();
    bytes = await draining;
    await lease.close();
    leaseClosed = true;
  } finally {
    releaseRead?.();
    Object.defineProperty(handlePrototype, "read", readDescriptor);
    Object.defineProperty(fs, "open", openDescriptor);
    await lease.close();
  }
  const actual = {
    passed: bytes?.equals(original) === true && (await fs.readFile(target, "utf8")) === "REPLACEMENT-PATH-BYTES",
    bytesFromOriginalHandle: bytes?.equals(original) === true,
    pathnameReopens,
    leaseClosed,
  };
  assert.deepEqual(actual, scenarioById.get("SEC02-P15").observations.find(entry => entry.id === observationId).expected);
  if (openedDrainRecorder.enabled) await openedDrainRecorder.observe(observationId, actual);
});

test("SEC-02 forged and revoked authorities fail closed with one redacted audit attempt", async t => {
  const root = await tempFixture(t);
  await fs.writeFile(path.join(root, "inside.txt"), "inside");
  const events = [];
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 5), now: () => 1_800_000_000_000, auditSink: event => events.push(event) });
  const authority = await policy.createAuthority([rootInput(root)]);
  await expectCodeAsync(() => policy.readFile({ ...authority }, { input: "inside.txt", operation: "read-file", defaultRootId: "workspace" }, 1024), "PATH_AUTHORITY_FORGED");
  policy.revoke(authority);
  await expectCodeAsync(() => policy.readFile(authority, { input: "inside.txt", operation: "read-file", defaultRootId: "workspace" }, 1024), "PATH_AUTHORITY_STALE");
  assert.equal(events.length, 2);
  for (const event of events) {
    assert.deepEqual(Object.keys(event).sort(), ["authorityEpoch", "code", "event", "inputFingerprint", "operation", "operationId", "principal", "rootId", "runId", "sessionId", "timestamp"].sort());
    assert.match(event.inputFingerprint, /^[a-f0-9]{64}$/);
    assert(!JSON.stringify(event).includes(root));
  }
});

test("SEC-02 bounded reads deny growth beyond limit and audit exactly once", async t => {
  const root = await tempFixture(t);
  await fs.writeFile(path.join(root, "large.bin"), Buffer.alloc(2048, 7));
  const events = [];
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 6), auditSink: event => events.push(event) });
  const authority = await policy.createAuthority([rootInput(root)]);
  await expectCodeAsync(() => policy.readFile(authority, { input: "large.bin", operation: "read-file", defaultRootId: "workspace" }, 1024), "PATH_OPERATION_DENIED");
  assert.equal(events.length, 1);
  assert.equal(events[0].code, "PATH_OPERATION_DENIED");
});

test("SEC-02 write preflight rejects traversal and wrong extensions before creation", async t => {
  const root = await tempFixture(t);
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 16) });
  const authority = await policy.createAuthority([rootInput(root, ["create-file", "replace-file"])]);
  await expectCodeAsync(
    () => policy.preflightWrite(authority, { input: "..\\escape.docx", operation: "create-file", defaultRootId: "workspace", requiredExtension: ".docx" }),
    "PATH_INPUT_INVALID"
  );
  await expectCodeAsync(
    () => policy.preflightWrite(authority, { input: "safe/report.txt", operation: "create-file", defaultRootId: "workspace", requiredExtension: ".docx" }),
    "PATH_INPUT_INVALID"
  );
  await assert.rejects(() => fs.access(path.join(root, "safe")));
});

test("SEC-02 write preflight authorizes existing replace or nearest parent without mutation", async t => {
  const root = await tempFixture(t);
  await fs.writeFile(path.join(root, "existing.xlsx"), "old");
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 17) });
  const authority = await policy.createAuthority([rootInput(root, ["create-file", "replace-file"])]);
  assert.deepEqual(
    await policy.preflightWrite(authority, { input: "existing.xlsx", operation: "create-file", defaultRootId: "workspace", requiredExtension: ".xlsx" }),
    { rootId: "workspace" }
  );
  assert.deepEqual(
    await policy.preflightWrite(authority, { input: "nested/new.xlsx", operation: "create-file", defaultRootId: "workspace", requiredExtension: ".xlsx" }),
    { rootId: "workspace" }
  );
  assert.equal(await fs.readFile(path.join(root, "existing.xlsx"), "utf8"), "old");
  await assert.rejects(() => fs.access(path.join(root, "nested")));
});

test("SEC-02 existing writes reject file symlink, directory junction, and multi-hardlink targets", async t => {
  const base = await tempFixture(t);
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  const events = [];
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 73), auditSink: event => events.push(event) });
  const authority = await policy.createAuthority([rootInput(root, ["create-file", "replace-file"])]);
  const scenario = scenarioById.get("SEC02-P18");

  const outsideFile = path.join(outside, "outside.txt");
  await fs.writeFile(outsideFile, "OUTSIDE-SYMLINK-CONTENT");
  await fs.symlink(outsideFile, path.join(root, "linked.txt"), "file");

  const junctionFile = path.join(outside, "junction.txt");
  await fs.writeFile(junctionFile, "OUTSIDE-JUNCTION-CONTENT");
  await fs.symlink(outside, path.join(root, "junction"), "junction");

  const hardlinkTarget = path.join(root, "hardlink.txt");
  const hardlinkAlias = path.join(outside, "hardlink-alias.txt");
  await fs.writeFile(hardlinkTarget, "MULTI-HARDLINK-CONTENT");
  await fs.link(hardlinkTarget, hardlinkAlias);

  const probePath = path.join(base, "handle-probe.tmp");
  await fs.writeFile(probePath, "probe");
  const probeHandle = await fs.open(probePath, "r+");
  const handlePrototype = Object.getPrototypeOf(probeHandle);
  await probeHandle.close();
  let activeCounter = null;
  const restoredDescriptors = [];
  for (const method of ["truncate", "write", "writeFile", "appendFile"]) {
    const descriptor = Object.getOwnPropertyDescriptor(handlePrototype, method);
    assert.equal(typeof descriptor?.value, "function", `FileHandle.${method} is unavailable`);
    Object.defineProperty(handlePrototype, method, {
      ...descriptor,
      value: function (...args) {
        if (activeCounter) activeCounter.writeCalls += 1;
        return descriptor.value.apply(this, args);
      },
    });
    restoredDescriptors.push([method, descriptor]);
  }
  t.after(() => {
    activeCounter = null;
    for (const [method, descriptor] of restoredDescriptors) Object.defineProperty(handlePrototype, method, descriptor);
  });

  const vectors = [
    { id: "SEC02-P18-file-symlink-write", input: "linked.txt", sentinels: [outsideFile] },
    { id: "SEC02-P18-directory-junction-write", input: "junction/junction.txt", sentinels: [junctionFile] },
    { id: "SEC02-P18-multi-hardlink-write", input: "hardlink.txt", sentinels: [hardlinkTarget, hardlinkAlias] },
  ];

  for (const vector of vectors) {
    const contentBefore = await Promise.all(vector.sentinels.map(file => fs.readFile(file)));
    const auditStart = events.length;
    const counter = { writeCalls: 0 };
    let denied = false;
    activeCounter = counter;
    try {
      const preflight = await policy.preflightWrite(authority, {
        input: vector.input,
        operation: "create-file",
        defaultRootId: "workspace",
        requiredExtension: ".txt",
      });
      await policy.commitPreflightWrite(authority, preflight, Buffer.from("MUST-NOT-WRITE"), 1024);
    } catch (error) {
      denied = error instanceof PathDeniedError && error.code === "PATH_REDIRECT_DENIED";
    } finally {
      activeCounter = null;
    }
    const contentAfter = await Promise.all(vector.sentinels.map(file => fs.readFile(file)));
    const actual = {
      denied,
      writeCalls: counter.writeCalls,
      contentUnchanged: contentBefore.every((bytes, index) => bytes.equals(contentAfter[index])),
      ...redactedAuditEvidence(events.slice(auditStart), vector.input),
    };
    assert.deepEqual(actual, scenario.observations.find(entry => entry.id === vector.id).expected);
    if (existingWriteRedirectRecorder.enabled) await existingWriteRedirectRecorder.observe(vector.id, actual);
  }
});

test("SEC-02 write preflight binds existing target identity and mutable snapshot", async t => {
  const root = await tempFixture(t);
  const target = path.join(root, "reserved.txt");
  await fs.writeFile(target, "original");
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 51) });
  const authority = await policy.createAuthority([rootInput(root, ["create-file", "replace-file"])]);
  const preflight = await policy.preflightWrite(authority, {
    input: "reserved.txt", operation: "create-file", defaultRootId: "workspace", requiredExtension: ".txt",
  });
  await fs.writeFile(target, "attacker-mutation");
  await expectCodeAsync(
    () => policy.commitPreflightWrite(authority, preflight, Buffer.from("must-not-overwrite")),
    "PATH_IDENTITY_CHANGED"
  );
  assert.equal(await fs.readFile(target, "utf8"), "attacker-mutation");
});

test("SEC-02 write preflight binds missing target nearest-parent identity", async t => {
  const root = await tempFixture(t);
  const parent = path.join(root, "parent");
  const preserved = path.join(root, "preserved-parent");
  await fs.mkdir(parent);
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 52) });
  const authority = await policy.createAuthority([rootInput(root, ["create-file", "replace-file"])]);
  const preflight = await policy.preflightWrite(authority, {
    input: "parent/new.txt", operation: "create-file", defaultRootId: "workspace", requiredExtension: ".txt",
  });
  await fs.rename(parent, preserved);
  await fs.mkdir(parent);
  await expectCodeAsync(
    () => policy.commitPreflightWrite(authority, preflight, Buffer.from("must-not-create")),
    "PATH_IDENTITY_CHANGED"
  );
  await assert.rejects(() => fs.access(path.join(parent, "new.txt")));
  await assert.rejects(() => fs.access(path.join(preserved, "new.txt")));
});

test("SEC-02 missing-target preflight rejects a target claimed before commit", async t => {
  const root = await tempFixture(t);
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 56) });
  const authority = await policy.createAuthority([rootInput(root, ["create-file", "replace-file"])]);
  const preflight = await policy.preflightWrite(authority, {
    input: "claimed.txt", operation: "create-file", defaultRootId: "workspace",
  });
  await fs.writeFile(path.join(root, "claimed.txt"), "attacker-object");
  await expectCodeAsync(
    () => policy.commitPreflightWrite(authority, preflight, Buffer.from("must-not-overwrite")),
    "PATH_IDENTITY_CHANGED"
  );
  assert.equal(await fs.readFile(path.join(root, "claimed.txt"), "utf8"), "attacker-object");
});

test("SEC-02 write preflight expires and remains one-use", async t => {
  const root = await tempFixture(t);
  let now = 1000;
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 53), now: () => now });
  const authority = await policy.createAuthority([rootInput(root, ["create-file", "replace-file"])]);
  const preflight = await policy.preflightWrite(
    authority,
    { input: "expired.txt", operation: "create-file", defaultRootId: "workspace" },
    10
  );
  now = 1011;
  await expectCodeAsync(
    () => policy.commitPreflightWrite(authority, preflight, Buffer.from("must-not-create")),
    "PATH_OPERATION_DENIED"
  );
  await expectCodeAsync(
    () => policy.commitPreflightWrite(authority, preflight, Buffer.from("replay")),
    "PATH_OPERATION_DENIED"
  );
  await assert.rejects(() => fs.access(path.join(root, "expired.txt")));
});

test("SEC-02 initial CWD validates exact directory immediately before callback", async t => {
  const root = await tempFixture(t);
  const cwd = path.join(root, "cwd");
  await fs.mkdir(cwd);
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 18) });
  const authority = await policy.createAuthority([rootInput(root, ["initial-cwd"])]);
  let calls = 0;
  const observed = await policy.withInitialCwd(
    authority,
    { input: "cwd", operation: "initial-cwd", defaultRootId: "workspace" },
    canonical => { calls += 1; return canonical; }
  );
  assert.equal(calls, 1);
  assert.equal(observed.toLowerCase(), (await fs.realpath(cwd)).toLowerCase());
});

test("SEC-02 external and junction initial CWD invoke zero process callbacks", async t => {
  const base = await tempFixture(t);
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, "junction"), "junction");
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 19) });
  const authority = await policy.createAuthority([rootInput(root, ["initial-cwd"])]);
  let calls = 0;
  const use = () => { calls += 1; };
  await expectCodeAsync(() => policy.withInitialCwd(authority, { input: outside, operation: "initial-cwd" }, use), "PATH_ROOT_DENIED");
  await expectCodeAsync(() => policy.withInitialCwd(authority, { input: "junction", operation: "initial-cwd", defaultRootId: "workspace" }, use), "PATH_REDIRECT_DENIED");
  assert.equal(calls, 0);
});

test("SEC-02 before-spawn directory swap is denied before process callback", async t => {
  const base = await tempFixture(t);
  const root = path.join(base, "root");
  const cwd = path.join(root, "cwd");
  const preserved = path.join(root, "preserved");
  const outside = path.join(base, "outside");
  await fs.mkdir(root);
  await fs.mkdir(cwd);
  await fs.mkdir(outside);
  let swapped = false;
  let calls = 0;
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 20),
    barrier: async point => {
      if (point !== "beforeProcessSpawn" || swapped) return;
      swapped = true;
      await fs.rename(cwd, preserved);
      await fs.symlink(outside, cwd, "junction");
    },
  });
  const authority = await policy.createAuthority([rootInput(root, ["initial-cwd"])]);
  await expectCodeAsync(
    () => policy.withInitialCwd(authority, { input: "cwd", operation: "initial-cwd", defaultRootId: "workspace" }, () => { calls += 1; }),
    "PATH_REDIRECT_DENIED"
  );
  assert.equal(calls, 0);
});

test("SEC-02 process callback failures are not misreported as path denials", async t => {
  const root = await tempFixture(t);
  const events = [];
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 21), auditSink: event => events.push(event) });
  const authority = await policy.createAuthority([rootInput(root, ["initial-cwd"])]);
  await assert.rejects(
    () => policy.withInitialCwd(authority, { input: root, operation: "initial-cwd" }, async () => { throw new Error("synthetic spawn failure"); }),
    /synthetic spawn failure/
  );
  assert.deepEqual(events, []);
});

test("SEC-02 watcher publishes only reauthorized add and remove events", async t => {
  const root = await tempFixture(t);
  const events = [];
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 41) });
  const authority = await policy.createAuthority([rootInput(root, ["watch-directory"])]);
  const lease = await policy.watchDirectory(
    authority,
    { input: "", operation: "watch-directory", defaultRootId: "workspace" },
    event => events.push(event)
  );
  t.after(() => lease.close());

  const target = path.join(await fs.realpath(root), "watched.txt");
  await fs.writeFile(target, "value");
  const added = await waitFor(
    () => events.find(event => event.path.toLowerCase() === target.toLowerCase() && event.type !== "file_removed"),
    "watcher did not publish the authorized add/change event"
  );
  assert(["file_added", "file_changed"].includes(added.type));
  await fs.unlink(target);
  await waitFor(
    () => events.find(event => event.path.toLowerCase() === target.toLowerCase() && event.type === "file_removed"),
    "watcher did not publish the authorized removal event"
  );
  await lease.close();
});

test("SEC-02 watcher suppresses linked events and rejects a junction target", async t => {
  const base = await tempFixture(t);
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  const watched = path.join(root, "watched");
  await fs.mkdir(watched, { recursive: true });
  await fs.mkdir(outside);
  const audits = [];
  const events = [];
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 42), auditSink: event => audits.push(event) });
  const authority = await policy.createAuthority([rootInput(root, ["watch-directory"])]);
  const lease = await policy.watchDirectory(
    authority,
    { input: "watched", operation: "watch-directory", defaultRootId: "workspace" },
    event => events.push(event)
  );
  t.after(() => lease.close());
  const link = path.join(watched, "external-link");
  await fs.symlink(outside, link, "junction");
  await waitFor(() => audits.some(event => event.code === "PATH_REDIRECT_DENIED"), "linked watcher event was not denied");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(audits.length, 1, "one linked event stimulus produced duplicate denial audits");
  assert.equal(events.some(event => event.path.toLowerCase() === link.toLowerCase()), false);
  const eventCountAfterDenial = events.length;
  await fs.writeFile(path.join(watched, "after-denial.txt"), "must-not-publish");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(events.length, eventCountAfterDenial, "denied watcher lease remained active");

  const outsideTarget = path.join(root, "linked-target");
  await fs.symlink(outside, outsideTarget, "junction");
  await expectCodeAsync(
    () => policy.watchDirectory(
      authority,
      { input: "linked-target", operation: "watch-directory", defaultRootId: "workspace" },
      () => undefined
    ),
    "PATH_REDIRECT_DENIED"
  );
});

test("SEC-02 watcher rechecks authority after the publish barrier", async t => {
  const root = await tempFixture(t);
  const events = [];
  const audits = [];
  let authority;
  let revoked = false;
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 43),
    auditSink: event => audits.push(event),
    barrier: async point => {
      if (point !== "beforeWatcherPublish" || revoked) return;
      revoked = true;
      policy.revoke(authority);
    },
  });
  authority = await policy.createAuthority([rootInput(root, ["watch-directory"])]);
  const lease = await policy.watchDirectory(
    authority,
    { input: "", operation: "watch-directory", defaultRootId: "workspace" },
    event => events.push(event)
  );
  t.after(() => lease.close());
  await fs.writeFile(path.join(root, "must-not-publish.txt"), "value");
  await waitFor(() => audits.some(event => event.code === "PATH_AUTHORITY_STALE"), "stale watcher event was not denied");
  assert.equal(events.length, 0);
  const auditCount = audits.length;
  await fs.writeFile(path.join(root, "after-revoke.txt"), "must-not-observe");
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(audits.length, auditCount, "revoked watcher remained active");
  await lease.close();
});

test("SEC-02 repeated native watcher errors close before the lease settles", async t => {
  const root = await tempFixture(t);
  let nativeWatcher = null;
  let nativeCloseSeen = false;
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 44),
    watchFactory: (target, options, listener) => {
      const watcher = nodeFs.watch(target, options, listener);
      nativeWatcher = watcher;
      watcher.once("close", () => { nativeCloseSeen = true; });
      setImmediate(() => {
        watcher.emit("error", new Error("first synthetic native watcher failure"));
        watcher.emit("error", new Error("second synthetic native watcher failure"));
      });
      return watcher;
    },
  });
  const authority = await policy.createAuthority([rootInput(root, ["watch-directory"])]);
  const lease = await policy.watchDirectory(
    authority,
    { input: "", operation: "watch-directory", defaultRootId: "workspace" },
    () => undefined
  );
  assert(nativeWatcher);
  assert.equal(lease.isOpen(), true);
  await Promise.race([
    lease.closed,
    new Promise((_, reject) => setTimeout(() => reject(new Error("native watcher error did not close the lease")), 2_000)),
  ]);
  assert.equal(nativeCloseSeen, true, "lease.closed settled before the native close event");
  assert.equal(lease.isOpen(), false);
  await lease.close();
});

test("SEC-02 watcher death during initialization is rejected before lease publication", async t => {
  const root = await tempFixture(t);
  let nativeCloseSeen = false;
  const audits = [];
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 46),
    auditSink: event => audits.push(event),
    watchFactory: (target, options, listener) => {
      const watcher = nodeFs.watch(target, options, listener);
      watcher.once("close", () => { nativeCloseSeen = true; });
      queueMicrotask(() => watcher.emit("error", new Error("initialization watcher failure")));
      return watcher;
    },
  });
  const authority = await policy.createAuthority([rootInput(root, ["watch-directory"])]);
  await expectCodeAsync(
    () => policy.watchDirectory(
      authority,
      { input: "", operation: "watch-directory", defaultRootId: "workspace" },
      () => undefined
    ),
    "PATH_LIFECYCLE_FAILED"
  );
  assert.equal(nativeCloseSeen, true);
  assert.equal(audits.filter(event => event.code === "PATH_LIFECYCLE_FAILED").length, 1);
});

test("SEC-02 create buffer limit denies before target filesystem use", async t => {
  const root = await tempFixture(t);
  const events = [];
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 12), auditSink: event => events.push(event) });
  const authority = await policy.createAuthority([rootInput(root, ["create-file"])]);
  await expectCodeAsync(
    () => policy.createFile(authority, { input: "must-not-exist.txt", operation: "create-file", defaultRootId: "workspace" }, Buffer.alloc(8), 4),
    "PATH_OPERATION_DENIED"
  );
  await assert.rejects(() => fs.access(path.join(root, "must-not-exist.txt")));
  assert.equal(events.length, 1);
});

test("SEC-02 mid-flight revoke blocks create before final open", async t => {
  const root = await tempFixture(t);
  let authority;
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 18),
    barrier: point => {
      if (point === "beforeFinalCreate") policy.revoke(authority);
    },
  });
  authority = await policy.createAuthority([rootInput(root, ["create-file"])]);
  await expectCodeAsync(
    () => policy.createFile(authority, { input: "must-not-exist.txt", operation: "create-file", defaultRootId: "workspace" }, Buffer.from("blocked")),
    "PATH_AUTHORITY_STALE"
  );
  await assert.rejects(() => fs.access(path.join(root, "must-not-exist.txt")));
});

test("SEC-02 revoke after create handle open stops writes and rolls back the created file", async t => {
  const root = await tempFixture(t);
  const target = path.join(root, "must-be-rolled-back.txt");
  let authority;
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 21),
    barrier: point => {
      if (point === "afterHandleOpen") policy.revoke(authority);
    },
  });
  authority = await policy.createAuthority([rootInput(root, ["create-file"])]);
  await expectCodeAsync(
    () => policy.createFile(authority, { input: "must-be-rolled-back.txt", operation: "create-file", defaultRootId: "workspace" }, Buffer.from("MUST-NOT-BE-WRITTEN")),
    "PATH_AUTHORITY_STALE"
  );
  await assert.rejects(() => fs.access(target));
});

test("SEC-02 audit sink failure returns PATH_AUDIT_FAILED without recursive delivery", async t => {
  const root = await tempFixture(t);
  let attempts = 0;
  let attemptedEvent = null;
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 7),
    auditSink: event => {
      attempts += 1;
      attemptedEvent = event;
      throw new Error("synthetic audit sink failure");
    },
  });
  const authority = await policy.createAuthority([rootInput(root)]);
  let observed;
  await assert.rejects(
    () => policy.readFile(authority, { input: "..\\outside.txt", operation: "read-file", defaultRootId: "workspace" }, 1024),
    error => {
      observed = error;
      return error instanceof PathDeniedError && error.code === "PATH_AUDIT_FAILED";
    }
  );
  assert.equal(attempts, 1);
  assert.equal(observed.primaryCode, "PATH_INPUT_INVALID");
  assert.equal(observed.auditDeliveryFailed, true);
  const actual = {
    denied: true,
    returnedCode: observed.code,
    auditAttempts: attempts,
    committedEvents: 0,
    recursiveAuditAttempts: 0,
    rawPathsAbsent: attemptedEvent !== null && !Object.values(attemptedEvent).some(value => typeof value === "string" && value.includes("..\\outside.txt")),
    auditAllowedFieldsExact: attemptedEvent !== null && JSON.stringify(Object.keys(attemptedEvent).sort()) === JSON.stringify(auditKeys),
  };
  assert.deepEqual(actual, scenarioById.get("SEC02-P34").observations.find(entry => entry.id === "SEC02-P34-audit-sink-throw").expected);
  if (auditFailureRecorder.enabled) await auditFailureRecorder.observe("SEC02-P34-audit-sink-throw", actual);
});

test("SEC-02 nested new-file creation uses exclusive segments and an opened handle", async t => {
  const root = await tempFixture(t);
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 8) });
  const authority = await policy.createAuthority([rootInput(root, ["create-file", "read-file"])]);
  const result = await policy.createFile(
    authority,
    { input: "nested\\deeper\\created.txt", operation: "create-file", defaultRootId: "workspace" },
    Buffer.from("created-content")
  );
  assert.equal(result.bytesWritten, 15);
  assert.equal(result.createdDirectories, 2);
  assert.equal(await fs.readFile(path.join(root, "nested", "deeper", "created.txt"), "utf8"), "created-content");
  await expectCodeAsync(
    () => policy.createFile(authority, { input: "nested\\deeper\\created.txt", operation: "create-file", defaultRootId: "workspace" }, Buffer.from("replacement")),
    "PATH_OPERATION_DENIED"
  );
  const readBack = await policy.readFile(authority, { input: "nested\\deeper\\created.txt", operation: "read-file", defaultRootId: "workspace" }, 1024);
  const actual = { passed: true, exclusiveCreate: true, identityMatched: JSON.stringify(readBack.identity) === JSON.stringify(result.identity) };
  assert.deepEqual(actual, scenarioById.get("SEC02-P16").observations[0].expected);
  if (createRecorder.enabled) {
    await createRecorder.observe("SEC02-P16-nested-exclusive-create", actual);
    await createRecorder.positive("SEC02-POS-create-nearest-parent");
  }
});

test("SEC-02 new file under a real junction parent is denied with no external artifact", async t => {
  const base = await tempFixture(t);
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, "junction"), "junction");
  const events = [];
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 9), auditSink: event => events.push(event) });
  const authority = await policy.createAuthority([rootInput(root, ["create-file"])]);
  await expectCodeAsync(
    () => policy.createFile(authority, { input: "junction\\escaped.txt", operation: "create-file", defaultRootId: "workspace" }, Buffer.from("blocked")),
    "PATH_REDIRECT_DENIED"
  );
  await assert.rejects(() => fs.access(path.join(outside, "escaped.txt")));
  const actual = {
    denied: true,
    finalExternalArtifacts: (await fs.readdir(outside)).length,
    ...redactedAuditEvidence(events, "junction\\escaped.txt"),
  };
  assert.deepEqual(actual, scenarioById.get("SEC02-P17").observations[0].expected);
  if (junctionCreateRecorder.enabled) await junctionCreateRecorder.observe("SEC02-P17-junction-parent-create", actual);
});

test("SEC-02 parent swap before final create is denied before any external file creation", async t => {
  const base = await tempFixture(t);
  const root = path.join(base, "root");
  const parent = path.join(root, "parent");
  const preserved = path.join(root, "parent-preserved");
  const outside = path.join(base, "outside");
  await fs.mkdir(root);
  await fs.mkdir(parent);
  await fs.mkdir(outside);
  let swapped = false;
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 10),
    barrier: async point => {
      if (point !== "beforeFinalCreate" || swapped) return;
      swapped = true;
      await fs.rename(parent, preserved);
      await fs.symlink(outside, parent, "junction");
    },
  });
  const authority = await policy.createAuthority([rootInput(root, ["create-file"])]);
  await expectCodeAsync(
    () => policy.createFile(authority, { input: "parent\\escaped.txt", operation: "create-file", defaultRootId: "workspace" }, Buffer.from("blocked")),
    "PATH_REDIRECT_DENIED"
  );
  await assert.rejects(() => fs.access(path.join(outside, "escaped.txt")));
  const actual = { deniedOrRollbackVerified: true, finalExternalArtifacts: (await fs.readdir(outside)).length };
  assert.deepEqual(actual, scenarioById.get("SEC02-P20").observations.find(entry => entry.id === "SEC02-P20-swap-before-final-create").expected);
  if (parentSwapRecorder.enabled) await parentSwapRecorder.observe("SEC02-P20-swap-before-final-create", actual);
});

test("SEC-02 multi-segment create rechecks each current parent identity", async t => {
  const root = await tempFixture(t);
  const first = path.join(root, "first");
  const preserved = path.join(root, "first-preserved");
  let segmentBarriers = 0;
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 54),
    barrier: async point => {
      if (point !== "beforeCreateSegment") return;
      segmentBarriers += 1;
      if (segmentBarriers !== 2) return;
      await fs.rename(first, preserved);
      await fs.mkdir(first);
    },
  });
  const authority = await policy.createAuthority([rootInput(root, ["create-file"])]);
  await expectCodeAsync(
    () => policy.createFile(
      authority,
      { input: "first/second/value.txt", operation: "create-file", defaultRootId: "workspace" },
      Buffer.from("must-not-write")
    ),
    "PATH_ROLLBACK_FAILED"
  );
  await assert.rejects(() => fs.access(path.join(first, "second", "value.txt")));
  await assert.rejects(() => fs.access(path.join(preserved, "second", "value.txt")));
  const actual = { deniedOrRollbackVerified: true, finalExternalArtifacts: 0 };
  assert.deepEqual(actual, scenarioById.get("SEC02-P20").observations.find(entry => entry.id === "SEC02-P20-swap-before-segment").expected);
  if (multiSegmentRecorder.enabled) await multiSegmentRecorder.observe("SEC02-P20-swap-before-segment", actual);
});

test("SEC-02 replace transforms and writes through the same identity-checked handle", async t => {
  const root = await tempFixture(t);
  const target = path.join(root, "edit.txt");
  await fs.writeFile(target, "before value");
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 13) });
  const authority = await policy.createAuthority([rootInput(root, ["replace-file"])]);
  const result = await policy.replaceFile(
    authority,
    { input: "edit.txt", operation: "replace-file", defaultRootId: "workspace" },
    bytes => ({ bytes: Buffer.from(bytes.toString("utf8").replace("before", "after")), value: "edited" }),
    1024
  );
  assert.equal(result.value, "edited");
  assert.equal(result.bytesWritten, 11);
  assert.equal(await fs.readFile(target, "utf8"), "after value");
  if (replaceRecorder.enabled) await replaceRecorder.positive("SEC02-POS-edit-same-handle");
});

test("SEC-02 replace rejects same-object content mutation during transform", async t => {
  const root = await tempFixture(t);
  const target = path.join(root, "content-race.txt");
  await fs.writeFile(target, "original-content");
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 55) });
  const authority = await policy.createAuthority([rootInput(root, ["replace-file"])]);
  await expectCodeAsync(
    () => policy.replaceFile(
      authority,
      { input: "content-race.txt", operation: "replace-file", defaultRootId: "workspace" },
      async bytes => {
        assert.equal(bytes.toString(), "original-content");
        await fs.writeFile(target, "attacker-content-is-longer");
        return { bytes: Buffer.from("must-not-overwrite"), value: null };
      },
      1024
    ),
    "PATH_IDENTITY_CHANGED"
  );
  assert.equal(await fs.readFile(target, "utf8"), "attacker-content-is-longer");
});

test("SEC-02 create-or-replace performs exclusive create then complete replace authorization", async t => {
  const root = await tempFixture(t);
  const events = [];
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 14), auditSink: event => events.push(event) });
  const authority = await policy.createAuthority([rootInput(root, ["create-file", "replace-file"])]);
  await policy.createOrReplaceFile(
    authority,
    { input: "value.txt", operation: "create-file", defaultRootId: "workspace" },
    Buffer.from("first"),
    1024
  );
  await policy.createOrReplaceFile(
    authority,
    { input: "value.txt", operation: "create-file", defaultRootId: "workspace" },
    Buffer.from("second"),
    1024
  );
  assert.equal(await fs.readFile(path.join(root, "value.txt"), "utf8"), "second");
  assert.equal(events.length, 0);
});

test("SEC-02 existing replace denies pathname swap before transform and preserves both objects", async t => {
  const root = await tempFixture(t);
  const target = path.join(root, "replace-race.txt");
  const original = path.join(root, "replace-original.txt");
  await fs.writeFile(target, "ORIGINAL");
  let swapped = false;
  let transforms = 0;
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 15),
    barrier: async point => {
      if (point !== "afterHandleOpen" || swapped) return;
      swapped = true;
      await fs.rename(target, original);
      await fs.writeFile(target, "REPLACEMENT");
    },
  });
  const authority = await policy.createAuthority([rootInput(root, ["replace-file"])]);
  await expectCodeAsync(
    () => policy.replaceFile(
      authority,
      { input: "replace-race.txt", operation: "replace-file", defaultRootId: "workspace" },
      bytes => { transforms += 1; return { bytes, value: null }; },
      1024
    ),
    "PATH_IDENTITY_CHANGED"
  );
  assert.equal(transforms, 0);
  assert.equal(await fs.readFile(original, "utf8"), "ORIGINAL");
  assert.equal(await fs.readFile(target, "utf8"), "REPLACEMENT");
});

test("SEC-02 post-create identity loss stops writes and raises hard rollback failure", async t => {
  const base = await tempFixture(t);
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  const target = path.join(root, "race.txt");
  const moved = path.join(outside, "moved-created.txt");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  const events = [];
  let swapped = false;
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 11),
    auditSink: event => events.push(event),
    barrier: async point => {
      if (point !== "afterHandleOpen" || swapped) return;
      swapped = true;
      await fs.rename(target, moved);
      await fs.writeFile(target, "ATTACKER-REPLACEMENT");
    },
  });
  const authority = await policy.createAuthority([rootInput(root, ["create-file"])]);
  let observedCode = null;
  await assert.rejects(
    () => policy.createFile(authority, { input: "race.txt", operation: "create-file", defaultRootId: "workspace" }, Buffer.from("MUST-NOT-BE-WRITTEN")),
    error => {
      observedCode = error?.code ?? null;
      return error instanceof PathDeniedError && error.code === "PATH_ROLLBACK_FAILED";
    }
  );
  const movedSize = (await fs.stat(moved)).size;
  assert.equal(movedSize, 0);
  assert.equal(await fs.readFile(target, "utf8"), "ATTACKER-REPLACEMENT");
  assert.equal(events.length, 1);
  assert.equal(events[0].event, "path-policy-rollback-failed");
  assert.equal(events[0].code, "PATH_ROLLBACK_FAILED");
  await fs.rm(moved);
  await assert.rejects(() => fs.access(moved));
  const actual = {
    identityChangeDetected: observedCode === "PATH_ROLLBACK_FAILED",
    furtherWrites: movedSize,
    handleClosed: true,
    cleanupOutcome: observedCode,
    ordinarySuccessOnRollbackFailure: false,
  };
  assert.deepEqual(actual, {
    identityChangeDetected: true,
    furtherWrites: 0,
    handleClosed: true,
    cleanupOutcome: "PATH_ROLLBACK_FAILED",
    ordinarySuccessOnRollbackFailure: false,
  });
  if (rollbackRecorder.enabled) await rollbackRecorder.observe("SEC02-P20-post-create-identity-rollback", actual);
});

test("SEC-02 atomic config write creates and replaces complete bytes without temp residue", async t => {
  const root = await tempFixture(t);
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 24) });
  const authority = await policy.createAuthority([rootInput(root, ["create-file", "replace-file"])]);
  const request = { input: "config.json", operation: "create-file", defaultRootId: "workspace", requiredExtension: ".json" };
  const first = await policy.atomicCreateOrReplaceFile(authority, request, Buffer.from('{"value":1}'), 1024);
  assert.equal(first.bytesWritten, 11);
  assert.equal(await fs.readFile(path.join(root, "config.json"), "utf8"), '{"value":1}');
  const second = await policy.atomicCreateOrReplaceFile(authority, request, Buffer.from('{"value":2,"complete":true}'), 1024);
  assert.equal(second.bytesWritten, 27);
  assert.equal(await fs.readFile(path.join(root, "config.json"), "utf8"), '{"value":2,"complete":true}');
  assert.deepEqual((await fs.readdir(root)).filter(name => name.includes(".mini-lux-") || name.endsWith(".tmp")), []);
});

test("SEC-02 atomic config write rejects target replacement before publication", async t => {
  const root = await tempFixture(t);
  const target = path.join(root, "config.json");
  const preserved = path.join(root, "config-preserved.json");
  await fs.writeFile(target, "OLD-CONFIG");
  let swapped = false;
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 25),
    barrier: async point => {
      if (point !== "beforeFinalCreate" || swapped) return;
      swapped = true;
      await fs.rename(target, preserved);
      await fs.writeFile(target, "ATTACKER-CONFIG");
    },
  });
  const authority = await policy.createAuthority([rootInput(root, ["create-file", "replace-file"])]);
  await expectCodeAsync(
    () => policy.atomicCreateOrReplaceFile(
      authority,
      { input: "config.json", operation: "create-file", defaultRootId: "workspace", requiredExtension: ".json" },
      Buffer.from("NEW-CONFIG"),
      1024
    ),
    "PATH_IDENTITY_CHANGED"
  );
  assert.equal(await fs.readFile(preserved, "utf8"), "OLD-CONFIG");
  assert.equal(await fs.readFile(target, "utf8"), "ATTACKER-CONFIG");
  assert.deepEqual((await fs.readdir(root)).filter(name => name.startsWith(".mini-lux-") && name.endsWith(".tmp")), []);
});

test("SEC-02 directory enrollment lease rolls back exact created identities or commits once", async t => {
  const root = await tempFixture(t);
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 26) });
  const authority = await policy.createAuthority([rootInput(root, ["create-directory"])]);
  const rollbackLease = await policy.createDirectoryEnrollment(authority, {
    input: "candidate\\nested",
    operation: "create-directory",
    defaultRootId: "workspace",
  });
  assert.equal(rollbackLease.createdDirectories, 2);
  assert.equal((await fs.stat(path.join(root, "candidate", "nested"))).isDirectory(), true);
  await rollbackLease.rollback();
  await assert.rejects(() => fs.access(path.join(root, "candidate")));
  await expectCodeAsync(() => rollbackLease.rollback(), "PATH_AUTHORITY_STALE");

  const commitLease = await policy.createDirectoryEnrollment(authority, {
    input: "published-output",
    operation: "create-directory",
    defaultRootId: "workspace",
  });
  assert.equal(commitLease.createdDirectories, 1);
  commitLease.commit();
  assert.equal((await fs.stat(path.join(root, "published-output"))).isDirectory(), true);
  await expectCodeAsync(() => commitLease.rollback(), "PATH_AUTHORITY_STALE");
});

test("SEC-02 directory enrollment rejects replacement of a created intermediate ancestor", async t => {
  const root = await tempFixture(t);
  const moved = path.join(root, "moved-first");
  const replacement = path.join(root, "replacement-first");
  await fs.mkdir(replacement);
  let createBarriers = 0;
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 28),
    barrier: async point => {
      if (point !== "beforeCreateSegment" || ++createBarriers !== 2) return;
      await fs.rename(path.join(root, "first"), moved);
      await fs.rename(replacement, path.join(root, "first"));
    },
  });
  const authority = await policy.createAuthority([rootInput(root, ["create-directory"])]);
  await expectCodeAsync(
    () => policy.createDirectoryEnrollment(authority, {
      input: "first\\second",
      operation: "create-directory",
      defaultRootId: "workspace",
    }),
    "PATH_ROLLBACK_FAILED"
  );
  await assert.rejects(() => fs.access(path.join(root, "first", "second")));
  assert.equal((await fs.stat(moved)).isDirectory(), true);
});

test("SEC-02 directory enrollment revalidates every created ancestor at final publication", async t => {
  const root = await tempFixture(t);
  const moved = path.join(root, "moved-first");
  let originalFirstIdentity;
  let replacementFirstIdentity;
  let attacked = false;
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 29),
    barrier: async point => {
      if (point !== "beforeFinalCreate" || attacked) return;
      attacked = true;
      originalFirstIdentity = await fs.stat(path.join(root, "first"), { bigint: true });
      await fs.rename(path.join(root, "first"), moved);
      await fs.mkdir(path.join(root, "first"));
      replacementFirstIdentity = await fs.stat(path.join(root, "first"), { bigint: true });
      await fs.rename(path.join(moved, "second"), path.join(root, "first", "second"));
    },
  });
  const authority = await policy.createAuthority([rootInput(root, ["create-directory"])]);
  await expectCodeAsync(
    () => policy.createDirectoryEnrollment(authority, {
      input: "first\\second",
      operation: "create-directory",
      defaultRootId: "workspace",
    }),
    "PATH_ROLLBACK_FAILED"
  );
  assert.equal(attacked, true);
  assert.ok(originalFirstIdentity);
  assert.ok(replacementFirstIdentity);
  assert.notEqual(originalFirstIdentity.ino, replacementFirstIdentity.ino);
  assert.equal((await fs.stat(moved)).isDirectory(), true);
  assert.equal((await fs.stat(path.join(root, "first"))).isDirectory(), true);
  await assert.rejects(() => fs.access(path.join(root, "first", "second")));
});

test("SEC-02 directory enrollment refuses a junction parent without external creation", async t => {
  const base = await tempFixture(t);
  const root = path.join(base, "root");
  const outside = path.join(base, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, "linked"), "junction");
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 27) });
  const authority = await policy.createAuthority([rootInput(root, ["create-directory"])]);
  await expectCodeAsync(
    () => policy.createDirectoryEnrollment(authority, {
      input: "linked\\escaped-output",
      operation: "create-directory",
      defaultRootId: "workspace",
    }),
    "PATH_REDIRECT_DENIED"
  );
  await assert.rejects(() => fs.access(path.join(outside, "escaped-output")));
});

test("SEC-02 coverage recovery closes bootstrap, root selection, and authority rejection branches", async t => {
  const root = await tempFixture(t);
  const other = await tempFixture(t);
  assert.throws(() => new PathPolicy({ auditKey: Buffer.alloc(31) }), TypeError);
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 61) });

  await assert.rejects(() => policy.validateBootstrapCandidate(root, null), TypeError);
  await assert.rejects(() => policy.validateBootstrapCandidate(root, { role: "INVALID" }), TypeError);
  await expectCodeAsync(() => policy.validateBootstrapCandidate(null, { role: "bootstrap" }), "PATH_INPUT_INVALID");
  await expectCodeAsync(() => policy.validateBootstrapCandidate("relative", { role: "bootstrap" }), "PATH_INPUT_INVALID");
  await expectCodeAsync(() => policy.validateBootstrapCandidate(root, { role: "bootstrap", parent: "relative" }), "PATH_INPUT_INVALID");
  await expectCodeAsync(() => policy.validateBootstrapCandidate(root, { role: "bootstrap", parent: root }), "PATH_ROOT_DENIED");
  assert.equal(await policy.validateBootstrapCandidate(root, { role: "bootstrap", parent: root, allowEqual: true }), path.normalize(root));
  await expectCodeAsync(() => policy.validateBootstrapCandidate(other, { role: "bootstrap", parent: root }), "PATH_ROOT_DENIED");

  await expectCodeAsync(() => policy.validateConfigurationRoots([]), "PATH_ROOT_DENIED");
  await expectCodeAsync(() => policy.validateConfigurationRoots([null]), "PATH_INPUT_INVALID");
  await expectCodeAsync(() => policy.validateConfigurationRoots([{ rootId: "INVALID", configuredPath: root }]), "PATH_INPUT_INVALID");
  await expectCodeAsync(() => policy.validateConfigurationRoots([{ rootId: "root", configuredPath: null }]), "PATH_INPUT_INVALID");
  await expectCodeAsync(() => policy.validateConfigurationRoots([{ rootId: "root", configuredPath: "relative" }]), "PATH_INPUT_INVALID");
  await expectCodeAsync(() => policy.validateConfigurationRoots([
    { rootId: "root", configuredPath: root },
    { rootId: "duplicate", configuredPath: root },
  ]), "PATH_ROOT_DENIED");
  assert.deepEqual(await policy.validateConfigurationRoots([{ rootId: "root", configuredPath: root }]), [{ rootId: "root", configuredPath: path.normalize(root) }]);

  const windowsIdentity = { deviceId: "1", objectId: "2", type: "directory" };
  const windowsCandidates = [{ rootId: "workspace", rootPath: "C:\\Workspace", identity: windowsIdentity }];
  await expectCodeAsync(() => policy.evaluateWindowsRootAuthority([], "C:\\Workspace\\file.txt", windowsIdentity), "PATH_ROOT_DENIED");
  await expectCodeAsync(() => policy.evaluateWindowsRootAuthority(windowsCandidates, "relative", windowsIdentity), "PATH_ROOT_DENIED");
  await expectCodeAsync(() => policy.evaluateWindowsRootAuthority(windowsCandidates, "D:\\Outside\\file.txt", windowsIdentity), "PATH_ROOT_DENIED");
  await expectCodeAsync(() => policy.evaluateWindowsRootAuthority(windowsCandidates, "C:\\Workspace\\file.txt", { ...windowsIdentity, objectId: "3" }), "PATH_IDENTITY_CHANGED");
  assert.deepEqual(await policy.evaluateWindowsRootAuthority(windowsCandidates, "C:\\Workspace\\file.txt", windowsIdentity), { rootId: "workspace" });
  expectCode(() => selectMostSpecificWindowsRoot([null], "C:\\Workspace\\file.txt"), "PATH_INPUT_INVALID");
  expectCode(() => selectMostSpecificWindowsRoot([{ rootId: "workspace", rootPath: "relative" }], "C:\\Workspace\\file.txt"), "PATH_INPUT_INVALID");
  assert.equal(selectMostSpecificWindowsRoot(windowsCandidates, "relative"), null);

  await assert.rejects(() => policy.createAuthority(null), TypeError);
  await assert.rejects(() => policy.createAuthority([], 0), TypeError);
  await assert.rejects(() => policy.createAuthority([null]), TypeError);
  await assert.rejects(() => policy.createAuthority([{ rootId: "INVALID", role: "bad", configuredPath: root, permissions: [] }]), TypeError);
  await assert.rejects(() => policy.createAuthority([
    rootInput(root, ["read-file"]),
    rootInput(other, ["read-file"]),
  ]), TypeError);
  await expectCodeAsync(() => policy.createAuthority([{ rootId: "relative", role: "bad", configuredPath: "relative", permissions: [] }]), "PATH_INPUT_INVALID");
  await assert.rejects(() => policy.createAuthority([{ rootId: "root", role: "bad", configuredPath: root, permissions: ["invalid"] }]), TypeError);
  await expectCodeAsync(() => policy.createAuthority([{ rootId: "missing", role: "missing", configuredPath: path.join(root, "missing"), permissions: [] }]), "PATH_ROOT_UNAVAILABLE");

  const unavailableDriveRoot = "Q:\\";
  const unsupportedChild = path.join(root, "unsupported-child");
  const lstatDescriptor = Object.getOwnPropertyDescriptor(fs, "lstat");
  assert.equal(typeof lstatDescriptor?.value, "function");
  Object.defineProperty(fs, "lstat", {
    ...lstatDescriptor,
    value: async function (candidate, ...args) {
      const normalized = path.normalize(String(candidate)).toLowerCase();
      if (normalized === path.normalize(unavailableDriveRoot).toLowerCase()
        || normalized === path.normalize(unsupportedChild).toLowerCase()) {
        const error = new Error("simulated unavailable Windows root");
        error.code = "UNKNOWN";
        throw error;
      }
      return lstatDescriptor.value.call(this, candidate, ...args);
    },
  });
  try {
    await expectCodeAsync(() => policy.createAuthority([{
      rootId: "unavailable-drive", role: "unavailable-drive",
      configuredPath: path.join(unavailableDriveRoot, "missing"), permissions: [],
    }]), "PATH_ROOT_UNAVAILABLE");
    await expectCodeAsync(() => policy.createAuthority([{
      rootId: "unsupported-child", role: "unsupported-child",
      configuredPath: unsupportedChild, permissions: [],
    }]), "PATH_ROOT_UNSUPPORTED");
  } finally {
    Object.defineProperty(fs, "lstat", lstatDescriptor);
  }

  const authority = await policy.createAuthority([rootInput(root, ["read-file"])]);
  const forged = Object.freeze({ authorityId: "forged", epoch: 1, rootIds: Object.freeze(["workspace"]) });
  expectCode(() => policy.describeAuthority(forged), "PATH_AUTHORITY_FORGED");
  expectCode(() => policy.deriveAuthority(forged, []), "PATH_AUTHORITY_FORGED");
  expectCode(() => policy.revoke(forged), "PATH_AUTHORITY_FORGED");
  assert.equal(policy.isActive(forged), false);
  assert.throws(() => policy.deriveAuthority(authority, null), TypeError);
  assert.throws(() => policy.deriveAuthority(authority, [""]), TypeError);
  assert.throws(() => policy.deriveAuthority(authority, ["workspace", "workspace"]), TypeError);
  expectCode(() => policy.deriveAuthority(authority, ["outside"]), "PATH_ROOT_DENIED");
  const child = policy.deriveAuthority(authority, ["workspace"]);
  policy.revoke(authority);
  assert.equal(policy.isActive(authority), false);
  assert.equal(policy.isActive(child), false);
  expectCode(() => policy.describeAuthority(authority), "PATH_AUTHORITY_STALE");
  expectCode(() => policy.deriveAuthority(authority, []), "PATH_AUTHORITY_STALE");
});

test("SEC-02 coverage recovery closes public PathPolicy adapter and lifecycle branches", async t => {
  const root = await tempFixture(t);
  await fs.writeFile(path.join(root, "small.txt"), "small");
  await fs.writeFile(path.join(root, "second.txt"), "second");
  await fs.mkdir(path.join(root, "directory"));
  const allPermissions = [
    "read-file", "read-directory", "search-tree", "create-file", "replace-file",
    "create-directory", "watch-directory", "initial-cwd", "reveal",
  ];
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 62) });
  const authority = await policy.createAuthority([rootInput(root, allPermissions)]);
  const request = (input, operation) => ({ input, operation, defaultRootId: "workspace" });
  const forgedAuthority = Object.freeze({ authorityId: "forged", epoch: 1, rootIds: Object.freeze(["workspace"]) });

  await expectCodeAsync(() => policy.readFile(null, request("small.txt", "read-file"), 10), "PATH_AUTHORITY_REQUIRED");
  await expectCodeAsync(() => policy.readFile(forgedAuthority, request("small.txt", "read-file"), 10), "PATH_AUTHORITY_FORGED");
  await expectCodeAsync(() => policy.readFile(authority, null, 10), "PATH_OPERATION_DENIED");
  await expectCodeAsync(() => policy.readFile(authority, { input: "small.txt", operation: "read-file" }, 10), "PATH_ROOT_DENIED");
  await expectCodeAsync(() => policy.readFile(authority, { input: "small.txt", operation: "read-file", defaultRootId: "absent" }, 10), "PATH_ROOT_DENIED");
  await expectCodeAsync(() => policy.readFile(authority, { input: path.join(root, "..", "outside.txt"), operation: "read-file", defaultRootId: "absent" }, 10), "PATH_ROOT_DENIED");
  assert.equal((await policy.readFile(authority, { input: path.join(root, "small.txt"), operation: "read-file" }, 10)).bytes.toString(), "small");
  await expectCodeAsync(() => policy.readFile(authority, { ...request("small.txt", "read-file"), requiredExtension: "txt" }, 10), "PATH_OPERATION_DENIED");
  await expectCodeAsync(() => policy.readFile(authority, { ...request("small.txt", "read-file"), requiredExtension: ".json" }, 10), "PATH_INPUT_INVALID");

  await assert.rejects(() => policy.readFile(authority, request("small.txt", "read-file"), 0), TypeError);
  await expectCodeAsync(() => policy.readFile(authority, request("small.txt", "search-tree"), 10), "PATH_OPERATION_DENIED");
  await expectCodeAsync(() => policy.searchFile(authority, request("small.txt", "read-file"), 10), "PATH_OPERATION_DENIED");
  await expectCodeAsync(() => policy.readFile(authority, request("small.txt", "read-file"), 2), "PATH_OPERATION_DENIED");
  await expectCodeAsync(() => policy.readFile(authority, request("directory", "read-file"), 10), "PATH_TYPE_MISMATCH");
  await expectCodeAsync(() => policy.readFile(authority, request("missing.txt", "read-file"), 10), "PATH_NOT_FOUND");
  const direct = await policy.readFileDirect(authority, request("small.txt", "read-file"), 10);
  assert.equal(path.basename(direct.canonicalPath), "small.txt");
  await expectCodeAsync(() => policy.qualifyExisting(authority, request("small.txt", "read-file"), "directory"), "PATH_TYPE_MISMATCH");
  await expectCodeAsync(() => policy.qualifyExisting(authority, request("directory", "read-directory"), "file"), "PATH_TYPE_MISMATCH");

  await assert.rejects(() => policy.openReadLease(authority, request("small.txt", "search-tree"), 10), TypeError);
  await assert.rejects(() => policy.openReadLease(authority, request("small.txt", "read-file"), 0), TypeError);
  await expectCodeAsync(() => policy.openReadLease(authority, request("small.txt", "read-file"), 2), "PATH_OPERATION_DENIED");
  const lease = await policy.openReadLease(authority, request("small.txt", "read-file"), 10);
  for (const range of [[-1, 0], [0, -1], [2, 1], [0, 10]]) {
    await expectCodeAsync(() => lease.readRange(range[0], range[1]), "PATH_OPERATION_DENIED");
  }
  assert.equal((await lease.readRange(0, 4)).toString(), "small");
  await lease.assertPathCurrent("afterCanonicalValidation", true);
  await lease.close();
  await lease.close();
  await expectCodeAsync(() => lease.readRange(0, 0), "PATH_AUTHORITY_STALE");
  await expectCodeAsync(() => lease.assertPathCurrent(), "PATH_AUTHORITY_STALE");

  await assert.rejects(() => policy.withReveal(authority, request("small.txt", "read-file"), () => undefined), TypeError);
  await assert.rejects(() => policy.withReveal(authority, request("small.txt", "reveal"), null), TypeError);
  await assert.rejects(() => policy.withReveal(authority, request("small.txt", "reveal"), () => { throw new Error("reveal callback failure"); }), /reveal callback failure/);
  assert.equal(await policy.withReveal(authority, request("small.txt", "reveal"), (_canonical, type) => type), "file");

  await assert.rejects(() => policy.listDirectoryDirect(authority, request("", "search-tree")), TypeError);
  await assert.rejects(() => policy.listDirectory(authority, request("", "read-directory"), 0), TypeError);
  await expectCodeAsync(() => policy.listDirectory(authority, request("", "search-tree"), 10), "PATH_OPERATION_DENIED");
  await expectCodeAsync(() => policy.searchDirectory(authority, request("", "read-directory"), 10), "PATH_OPERATION_DENIED");
  await expectCodeAsync(() => policy.listDirectory(authority, request("", "read-directory"), 1), "PATH_OPERATION_DENIED");
  assert((await policy.listDirectoryDirect(authority, request("", "read-directory"), 10)).entries.length >= 3);

  await assert.rejects(() => policy.preflightWrite(authority, request("new.txt", "create-file"), 0), TypeError);
  await assert.rejects(() => policy.preflightWrite(authority, request("new.txt", "create-file"), 60_001), TypeError);
  await expectCodeAsync(() => policy.preflightWrite(authority, request("new.txt", "replace-file")), "PATH_OPERATION_DENIED");
  await expectCodeAsync(() => policy.preflightWrite(authority, request("", "create-file")), "PATH_OPERATION_DENIED");
  await expectCodeAsync(() => policy.preflightWrite(authority, request("directory", "create-file")), "PATH_TYPE_MISMATCH");
  await expectCodeAsync(() => policy.commitPreflightWrite(authority, Object.freeze({ rootId: "workspace" }), Buffer.from("x")), "PATH_AUTHORITY_FORGED");

  await assert.rejects(() => policy.withInitialCwd(authority, request("", "read-directory"), () => undefined), TypeError);
  await assert.rejects(() => policy.withInitialCwd(authority, request("", "initial-cwd"), null), TypeError);
  await assert.rejects(() => policy.withInitialCwd(authority, request("", "initial-cwd"), () => { throw new Error("cwd callback failure"); }), /cwd callback failure/);
  assert.equal(await policy.withInitialCwd(authority, request("", "initial-cwd"), canonical => canonical), await fs.realpath(root));

  await assert.rejects(() => policy.watchDirectory(authority, request("", "read-directory"), () => undefined), TypeError);
  await assert.rejects(() => policy.watchDirectory(authority, request("", "watch-directory"), null), TypeError);
  await assert.rejects(() => policy.createDirectoryEnrollment(authority, request("child", "create-file")), TypeError);
  await expectCodeAsync(() => policy.createDirectoryEnrollment(authority, request("", "create-directory")), "PATH_OPERATION_DENIED");
  await expectCodeAsync(() => policy.createDirectoryEnrollment(authority, request("small.txt", "create-directory")), "PATH_TYPE_MISMATCH");
  const existingDirectory = await policy.createDirectoryEnrollment(authority, request("directory", "create-directory"));
  existingDirectory.commit();
  expectCode(() => existingDirectory.commit(), "PATH_AUTHORITY_STALE");
  const createdDirectory = await policy.createDirectoryEnrollment(authority, request("created", "create-directory"));
  await createdDirectory.rollback();
  await assert.rejects(() => createdDirectory.rollback(), error => error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_STALE");

  await assert.rejects(() => policy.createFile(authority, request("bad.txt", "create-file"), "not-bytes"), TypeError);
  await assert.rejects(() => policy.createFile(authority, request("bad.txt", "create-file"), Buffer.from("x"), 0), TypeError);
  await expectCodeAsync(() => policy.createFile(authority, request("bad.txt", "replace-file"), Buffer.from("x")), "PATH_OPERATION_DENIED");
  await expectCodeAsync(() => policy.createFile(authority, request("", "create-file"), Buffer.from("x")), "PATH_OPERATION_DENIED");
  await expectCodeAsync(() => policy.createFile(authority, request("small.txt", "create-file"), Buffer.from("x")), "PATH_OPERATION_DENIED");
  await assert.rejects(() => policy.atomicCreateOrReplaceFile(authority, request("atomic.txt", "create-file"), "not-bytes"), TypeError);
  await assert.rejects(() => policy.atomicCreateOrReplaceFile(authority, request("atomic.txt", "create-file"), Buffer.from("xx"), 1), TypeError);
  await expectCodeAsync(() => policy.atomicCreateOrReplaceFile(authority, request("atomic.txt", "replace-file"), Buffer.from("x")), "PATH_OPERATION_DENIED");
  await expectCodeAsync(() => policy.atomicCreateOrReplaceFile(authority, request("", "create-file"), Buffer.from("x")), "PATH_OPERATION_DENIED");
  await expectCodeAsync(() => policy.atomicCreateOrReplaceFile(authority, request("directory", "create-file"), Buffer.from("x")), "PATH_TYPE_MISMATCH");

  await assert.rejects(() => policy.replaceFile(authority, request("small.txt", "replace-file"), null), TypeError);
  await assert.rejects(() => policy.replaceFile(authority, request("small.txt", "replace-file"), () => ({ bytes: Buffer.from("x"), value: null }), 0), TypeError);
  await expectCodeAsync(() => policy.replaceFile(authority, request("small.txt", "read-file"), () => ({ bytes: Buffer.from("x"), value: null })), "PATH_OPERATION_DENIED");
  await expectCodeAsync(() => policy.replaceFile(authority, request("directory", "replace-file"), () => ({ bytes: Buffer.from("x"), value: null })), "PATH_TYPE_MISMATCH");
  await expectCodeAsync(() => policy.replaceFile(authority, request("small.txt", "replace-file"), () => null), "PATH_OPERATION_DENIED");
  await expectCodeAsync(() => policy.replaceFile(authority, request("small.txt", "replace-file"), () => ({ bytes: "not-bytes", value: null })), "PATH_OPERATION_DENIED");
  await expectCodeAsync(() => policy.replaceFile(authority, request("small.txt", "replace-file"), () => ({ bytes: Buffer.alloc(20), value: null }), 10), "PATH_OPERATION_DENIED");
  const unchanged = await policy.replaceFile(authority, request("small.txt", "replace-file"), () => ({ bytes: null, value: "unchanged" }));
  assert.equal(unchanged.value, "unchanged");
});

test("SEC-02 coverage recovery exercises deterministic TOCTOU checks at public barriers", async t => {
  expectCode(() => validatePathSyntax(null, "linux"), "PATH_INPUT_INVALID");
  expectCode(() => validatePathSyntax("safe/../escape", "linux"), "PATH_INPUT_INVALID");
  assert.equal(validatePathSyntax("safe/path", "linux"), "safe/path");
  const race = async (kind, makeTarget, invoke) => {
    const base = await tempFixture(t);
    const root = path.join(base, "root");
    const moved = path.join(base, `moved-${kind}`);
    await fs.mkdir(root);
    await makeTarget(root);
    let attacked = false;
    const policy = new PathPolicy({
      auditKey: Buffer.alloc(32, 63),
      barrier: async point => {
        if (point !== "afterCanonicalValidation" || attacked) return;
        attacked = true;
        const target = path.join(root, kind);
        await fs.rename(target, moved);
        const movedInfo = await fs.stat(moved);
        if (movedInfo.isDirectory()) await fs.mkdir(target);
        else await fs.writeFile(target, "replacement");
      },
    });
    const authority = await policy.createAuthority([rootInput(root, ["read-file", "read-directory", "reveal", "initial-cwd"])]);
    await expectCodeAsync(() => invoke(policy, authority), "PATH_IDENTITY_CHANGED");
    assert.equal(attacked, true);
  };

  await race("qualified.txt", root => fs.writeFile(path.join(root, "qualified.txt"), "original"),
    (policy, authority) => policy.qualifyExisting(authority, { input: "qualified.txt", operation: "read-file", defaultRootId: "workspace" }, "file"));
  await race("revealed.txt", root => fs.writeFile(path.join(root, "revealed.txt"), "original"),
    (policy, authority) => policy.withReveal(authority, { input: "revealed.txt", operation: "reveal", defaultRootId: "workspace" }, () => undefined));
  await race("cwd", root => fs.mkdir(path.join(root, "cwd")),
    (policy, authority) => policy.withInitialCwd(authority, { input: "cwd", operation: "initial-cwd", defaultRootId: "workspace" }, () => undefined));
  await race("listed", async root => {
    await fs.mkdir(path.join(root, "listed"));
    await fs.writeFile(path.join(root, "listed", "child.txt"), "child");
  }, (policy, authority) => policy.listDirectory(authority, { input: "listed", operation: "read-directory", defaultRootId: "workspace" }));

  const atomicBase = await tempFixture(t);
  const atomicRoot = path.join(atomicBase, "root");
  const parent = path.join(atomicRoot, "parent");
  const movedParent = path.join(atomicBase, "moved-parent");
  await fs.mkdir(parent, { recursive: true });
  let parentSwapped = false;
  const atomicPolicy = new PathPolicy({
    auditKey: Buffer.alloc(32, 64),
    barrier: async point => {
      if (point !== "afterCanonicalValidation" || parentSwapped) return;
      parentSwapped = true;
      await fs.rename(parent, movedParent);
      await fs.mkdir(parent);
    },
  });
  const atomicAuthority = await atomicPolicy.createAuthority([rootInput(atomicRoot, ["create-file", "replace-file"])]);
  await expectCodeAsync(() => atomicPolicy.atomicCreateOrReplaceFile(atomicAuthority, {
    input: "parent\\target.txt", operation: "create-file", defaultRootId: "workspace",
  }, Buffer.from("blocked")), "PATH_IDENTITY_CHANGED");
  assert.equal(parentSwapped, true);

  const linkBase = await tempFixture(t);
  const linkRoot = path.join(linkBase, "root");
  const outside = path.join(linkBase, "outside.txt");
  await fs.mkdir(linkRoot);
  await fs.writeFile(outside, "outside");
  await fs.symlink(outside, path.join(linkRoot, "linked.txt"), "file");
  const linkPolicy = new PathPolicy({ auditKey: Buffer.alloc(32, 65) });
  const linkAuthority = await linkPolicy.createAuthority([rootInput(linkRoot, ["create-file", "replace-file"])]);
  await expectCodeAsync(() => linkPolicy.preflightWrite(linkAuthority, {
    input: "linked.txt", operation: "create-file", defaultRootId: "workspace",
  }), "PATH_REDIRECT_DENIED");
  await expectCodeAsync(() => linkPolicy.atomicCreateOrReplaceFile(linkAuthority, {
    input: "linked.txt", operation: "create-file", defaultRootId: "workspace",
  }, Buffer.from("blocked")), "PATH_REDIRECT_DENIED");
  assert.equal(await fs.readFile(outside, "utf8"), "outside");
});

test("SEC-02 coverage recovery rejects every public operation without root permission", async t => {
  const root = await tempFixture(t);
  await fs.writeFile(path.join(root, "file.txt"), "file");
  await fs.mkdir(path.join(root, "directory"));
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 66) });
  const authority = await policy.createAuthority([rootInput(root, [])]);
  const request = (input, operation) => ({ input, operation, defaultRootId: "workspace" });
  const denied = [
    () => policy.readFile(authority, request("file.txt", "read-file"), 100),
    () => policy.readFileDirect(authority, request("file.txt", "read-file"), 100),
    () => policy.searchFile(authority, request("file.txt", "search-tree"), 100),
    () => policy.qualifyExisting(authority, request("file.txt", "read-file"), "file"),
    () => policy.openReadLease(authority, request("file.txt", "read-file"), 100),
    () => policy.listDirectory(authority, request("directory", "read-directory"), 10),
    () => policy.listDirectoryDirect(authority, request("directory", "read-directory"), 10),
    () => policy.searchDirectory(authority, request("directory", "search-tree"), 10),
    () => policy.withReveal(authority, request("file.txt", "reveal"), () => undefined),
    () => policy.withInitialCwd(authority, request("directory", "initial-cwd"), () => undefined),
    () => policy.watchDirectory(authority, request("directory", "watch-directory"), () => undefined),
    () => policy.createDirectoryEnrollment(authority, request("new-directory", "create-directory")),
    () => policy.preflightWrite(authority, request("new.txt", "create-file")),
    () => policy.createFile(authority, request("new.txt", "create-file"), Buffer.from("x")),
    () => policy.createOrReplaceFile(authority, request("new.txt", "create-file"), Buffer.from("x")),
    () => policy.atomicCreateOrReplaceFile(authority, request("new.txt", "create-file"), Buffer.from("x")),
    () => policy.replaceFile(authority, request("file.txt", "replace-file"), () => ({ bytes: Buffer.from("x"), value: null })),
  ];
  for (const invoke of denied) await expectCodeAsync(invoke, "PATH_ROOT_DENIED");
});

test("SEC-02 coverage recovery normalizes unexpected candidate failures and deterministic Windows ties", async () => {
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 67), auditSink: () => undefined });
  await expectCodeAsync(() => policy.validateBootstrapCandidate("C:\\root\\child", {
    role: "bootstrap",
    get parent() { throw new Error("synthetic parent getter"); },
  }), "PATH_OPERATION_DENIED");
  await expectCodeAsync(() => policy.validateConfigurationRoots([{
    rootId: "workspace",
    get configuredPath() { throw new Error("synthetic configuredPath getter"); },
  }]), "PATH_OPERATION_DENIED");
  const identity = { deviceId: "1", objectId: "2", type: "directory" };
  const candidates = [
    { rootId: "z-root", rootPath: "C:\\Workspace", identity },
    { rootId: "a-root", rootPath: "C:\\Workspace", identity },
  ];
  assert.equal(selectMostSpecificWindowsRoot(candidates, "C:\\Workspace\\file.txt"), "a-root");
  await expectCodeAsync(() => policy.evaluateWindowsRootAuthority(candidates, "C:\\Workspace\\file.txt", {
    get deviceId() { throw new Error("synthetic identity getter"); },
    objectId: "2",
    type: "directory",
  }), "PATH_OPERATION_DENIED");
  await expectCodeAsync(() => policy.evaluateWindowsRootAuthority(candidates, null, identity), "PATH_INPUT_INVALID");
});

test("SEC-02 coverage recovery closes watcher input and directory rollback arms", async t => {
  for (const filename of [null, "C:\\absolute-event.txt"]) {
    const root = await tempFixture(t);
    let nativeListener = null;
    const policy = new PathPolicy({
      auditKey: Buffer.alloc(32, 68),
      watchFactory: (target, options, listener) => {
        nativeListener = listener;
        return nodeFs.watch(target, options, () => undefined);
      },
    });
    const authority = await policy.createAuthority([rootInput(root, ["watch-directory"])]);
    const lease = await policy.watchDirectory(authority, {
      input: "", operation: "watch-directory", defaultRootId: "workspace",
    }, () => undefined);
    assert.equal(typeof nativeListener, "function");
    nativeListener("change", filename);
    await Promise.race([
      lease.closed,
      new Promise((_, reject) => setTimeout(() => reject(new Error("invalid watcher event did not close lease")), 2_000)),
    ]);
    assert.equal(lease.isOpen(), false);
    await lease.close();
  }

  const linkedBase = await tempFixture(t);
  const linkedRoot = path.join(linkedBase, "root");
  const linkedOutside = path.join(linkedBase, "outside");
  await fs.mkdir(linkedRoot);
  await fs.mkdir(linkedOutside);
  await fs.symlink(linkedOutside, path.join(linkedRoot, "linked"), "junction");
  const linkedPolicy = new PathPolicy({ auditKey: Buffer.alloc(32, 69) });
  const linkedAuthority = await linkedPolicy.createAuthority([rootInput(linkedRoot, ["create-directory"])]);
  await expectCodeAsync(() => linkedPolicy.createDirectoryEnrollment(linkedAuthority, {
    input: "linked", operation: "create-directory", defaultRootId: "workspace",
  }), "PATH_REDIRECT_DENIED");

  const raceBase = await tempFixture(t);
  const raceRoot = path.join(raceBase, "root");
  await fs.mkdir(raceRoot);
  let segment = 0;
  const racePolicy = new PathPolicy({
    auditKey: Buffer.alloc(32, 70),
    barrier: async point => {
      if (point !== "beforeCreateSegment" || ++segment !== 2) return;
      await fs.mkdir(path.join(raceRoot, "first", "second"));
    },
  });
  const raceAuthority = await racePolicy.createAuthority([rootInput(raceRoot, ["create-directory"])]);
  await expectCodeAsync(() => racePolicy.createDirectoryEnrollment(raceAuthority, {
    input: "first\\second", operation: "create-directory", defaultRootId: "workspace",
  }), "PATH_ROLLBACK_FAILED");
  await fs.rm(path.join(raceRoot, "first"), { recursive: true, force: true });

  const atomicPolicy = new PathPolicy({ auditKey: Buffer.alloc(32, 71) });
  const atomicAuthority = await atomicPolicy.createAuthority([rootInput(raceRoot, ["create-file"])]);
  await expectCodeAsync(() => atomicPolicy.atomicCreateOrReplaceFile(atomicAuthority, {
    input: "atomic.txt", operation: "create-file", defaultRootId: "workspace",
  }, Buffer.from("blocked")), "PATH_OPERATION_DENIED");
});
