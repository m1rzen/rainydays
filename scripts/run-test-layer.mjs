import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createSec03NativeVerifier } from "./sec03-native-verifier.mjs";
import {
  atomicWriteJson,
  classifyProcessResult,
  formalArtifactSnapshot,
  layerNames,
  loadCoverageScope,
  loadTaskManifest,
  makeTempDir,
  parseTapSummary,
  prepareReportPath,
  projectRoot,
  removeFixture,
  runProcess,
  sameSnapshot,
  validateCoverageGovernance,
} from "../tests/helpers.mjs";
import { recomputeSec03Evidence, validateLayerReport, validatePackagedDetails } from "./report-schema.mjs";
import { collectSec02LayerEvidence } from "./sec02-receipt-set.mjs";
import { validateSec02SinkInventory } from "./sec02-sink-inventory.mjs";

function parseArgs(argv) {
  const result = { task: "GOV-03", layer: null, report: null, timeoutMs: 300_000, runId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--task") result.task = argv[++index] ?? "";
    else if (argument === "--layer") result.layer = argv[++index] ?? "";
    else if (argument === "--report") result.report = path.resolve(argv[++index] ?? "");
    else if (argument === "--timeout-ms") result.timeoutMs = Number(argv[++index]);
    else if (argument === "--run-id") result.runId = argv[++index] ?? "";
    else throw new Error(`Unknown argument: ${argument}`);
  }
  assert(layerNames.includes(result.layer), `--layer must be one of: ${layerNames.join(", ")}`);
  assert(Number.isInteger(result.timeoutMs) && result.timeoutMs > 0 && result.timeoutMs <= 900_000, "--timeout-ms is invalid");
  if (result.runId !== null) assert.match(result.runId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "--run-id is invalid");
  result.report ??= path.join(projectRoot, "test-results", "layers", `${result.task.toLowerCase()}-${result.layer}.json`);
  return result;
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function trustedPath(value, kind, field) {
  assert(value && path.isAbsolute(value) && path.resolve(value) === value, `${field} must be an exact absolute path`);
  let cursor = path.parse(value).root;
  for (const segment of value.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    assert(!(await lstat(cursor)).isSymbolicLink(), `${field} must not traverse a link`);
  }
  const info = await lstat(value);
  assert(kind === "directory" ? info.isDirectory() : info.isFile(), `${field} has the wrong type`);
  assert.equal(await realpath(value), value, `${field} must be canonical`);
  return value;
}
async function loadFrozenSec02Predecessor(sec03ResolvedManifest) {
  const binding = sec03ResolvedManifest.predecessor;
  assert.equal(binding?.taskId, "SEC-02", "SEC-03 predecessor task differs");
  const bytes = await readFile(path.join(projectRoot, ...binding.exactCasePath.split("/")));
  assert.equal(sha256(bytes), binding.fileSha256, "SEC-03 predecessor file identity differs");
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.canonicalPayloadSha256, binding.canonicalPayloadSha256, "SEC-03 predecessor payload identity differs");
  return manifest;
}

async function loadFrozenSec02SinkIdentity(sec02Manifest) {
  const exactCasePath = "tests/sec02-sink-inventory.json";
  const binding = sec02Manifest.governedArtifacts.find((entry) => entry.exactCasePath === exactCasePath);
  assert(binding, "SEC-02 frozen sink inventory binding is missing");
  const bytes = await readFile(path.join(projectRoot, ...exactCasePath.split("/")));
  assert.equal(sha256(bytes), binding.sha256, "SEC-02 frozen sink inventory file identity differs");
  const inventory = JSON.parse(bytes);
  const runtimeClasses = new Set(["product-runtime", "source-runtime", "electron-runtime"]);
  return Object.freeze({
    inventoryComplete: true,
    runtimeCanaryComplete: true,
    packagedBound: true,
    executableFileCount: inventory.files.length,
    sinkCount: inventory.sinks.length,
    runtimeSinkCount: inventory.sinks.filter((site) => runtimeClasses.has(site.executionClass)).length,
    canonicalPayloadSha256: inventory.canonicalPayloadSha256,
    detectorPolicySha256: inventory.detectorPolicySha256,
    reviewPolicySha256: inventory.reviewPolicySha256,
    dialectCheckerSha256: inventory.dialectCheckerSha256,
    dialectPolicySha256: inventory.dialectPolicySha256,
    dialectImportSetSha256: inventory.dialectImportSetSha256,
    dialectImportCount: inventory.sourceClosure.dialectImportCount,
    dialectExceptionCount: inventory.sourceClosure.dialectExceptionCount,
    executableManifestSha256: inventory.sourceClosure.executableManifestSha256,
    runtimeSinkSetSha256: inventory.runtimeSinkSetSha256,
  });
}

async function loadSec03Inputs(layer) {
  const matrixBytes = await readFile(path.join(projectRoot, "tests", "sec03-attack-matrix.json"));
  const schemaBytes = await readFile(path.join(projectRoot, "tests", "sec03-attack-matrix.schema.json"));
  const matrix = JSON.parse(matrixBytes);
  const fallbackIdentity = { runId: null, candidateId: null, buildId: null, sourceSha256: null, launcherSha256: null, hostSha256: null, packageSha256: null, matrixSha256: sha256(matrixBytes), schemaSha256: sha256(schemaBytes) };
  try {
    const root = await trustedPath(process.env.RAINYDAYS_SEC03_RECEIPT_DIR, "directory", "RAINYDAYS_SEC03_RECEIPT_DIR");
    const identityFile = await trustedPath(process.env.RAINYDAYS_SEC03_IDENTITY_FILE, "file", "RAINYDAYS_SEC03_IDENTITY_FILE");
    const identity = { ...JSON.parse(await readFile(identityFile, "utf8")), matrixSha256: sha256(matrixBytes), schemaSha256: sha256(schemaBytes) };
    const nativeVerifier = await createSec03NativeVerifier(identity);
    const runDirectory = path.join(root, identity.runId);
    await mkdir(runDirectory, { recursive: true });
    const sidecarDirectory = path.join(runDirectory, `${layer}-${randomUUID()}`);
    await mkdir(sidecarDirectory, { recursive: false });
    assert.equal(await realpath(sidecarDirectory), sidecarDirectory);
    return { configured: true, matrix, identity, nativeVerifier, sidecarDirectory };
  } catch (error) {
    return { configured: false, matrix, identity: fallbackIdentity, nativeVerifier: { verifyNativeEvidence() { throw new Error("blocked"); } }, sidecarDirectory: null, error: error instanceof Error ? error.message : String(error) };
  }
}
async function readRawSec03Receipts(directory) {
  const receipts = [];
  for (const name of (await readdir(directory)).sort()) {
    assert(/^receipts-[1-9]\d*-[a-f0-9]{16}\.jsonl$/u.test(name), `invalid SEC-03 sidecar: ${name}`);
    const file = path.join(directory, name);
    const info = await lstat(file);
    assert(info.isFile() && !info.isSymbolicLink(), `invalid SEC-03 sidecar type: ${name}`);
    const text = await readFile(file, "utf8");
    assert(text.endsWith("\n"), `truncated SEC-03 sidecar: ${name}`);
    for (const line of text.slice(0, -1).split("\n")) { assert(line); receipts.push(JSON.parse(line)); }
  }
  return receipts;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  args.report = await prepareReportPath(args.report);
  const detailPath = `${args.report}.${process.pid}.details.json`;
  await rm(detailPath, { force: true });
  const startedAt = new Date();
  const started = Date.now();
  const loadedTask = await loadTaskManifest(args.task);
  const { manifest } = loadedTask;
  const sec03Resolved = manifest.taskId === "SEC-03";
  const sec02Resolved = sec03Resolved || manifest.taskId === "SEC-02" || manifest.taskId === "GOV-03";
  const sec02Manifest = sec03Resolved ? await loadFrozenSec02Predecessor(loadedTask.resolvedManifest) : sec02Resolved ? loadedTask.resolvedManifest : null;
  const sec02Matrix = sec02Resolved
    ? JSON.parse(await readFile(path.join(projectRoot, "tests", "sec02-attack-matrix.json"), "utf8"))
    : null;
  const sec02RunId = sec02Resolved ? (args.runId ?? randomUUID()) : null;
  const sec02SinkIdentity = sec03Resolved
    ? await loadFrozenSec02SinkIdentity(sec02Manifest)
    : sec02Resolved ? await validateSec02SinkInventory(projectRoot) : null;
  const { scope } = await loadCoverageScope();
  await validateCoverageGovernance(manifest, scope);
  const before = await formalArtifactSnapshot();
  const buildInfo = JSON.parse(await readFile(path.join(projectRoot, "build-info.json"), "utf8"));
  const sec03 = sec03Resolved ? await loadSec03Inputs(args.layer) : null;
  if (sec03Resolved && !sec03.configured) {
    const sec03Evidence = recomputeSec03Evidence([], { matrix: sec03.matrix, identity: sec03.identity, nativeVerifier: sec03.nativeVerifier, layer: args.layer });
    const report = {
      reportVersion: 3, taskId: manifest.taskId, baseline: manifest.baseline, personaChain: manifest.personaChain,
      layer: args.layer, state: "failed", failureClass: "SEC03_BLOCKED_NATIVE_EVIDENCE",
      command: ["node", "--test", "--test-concurrency=1", "--test-reporter=tap", ...manifest.layers[args.layer]], expectedFiles: manifest.layers[args.layer],
      exitCode: 3, signal: null, timeoutTermination: null,
      tap: { tests: null, passed: null, failed: null, skipped: null, cancelled: null, todo: null },
      build: { appVersion: buildInfo.appVersion, buildId: buildInfo.buildId, sourceDigest: buildInfo.sourceDigest },
      startedAt: startedAt.toISOString(), finishedAt: new Date().toISOString(), durationMs: Date.now() - started, maxRssBytes: process.memoryUsage().rss,
      artifactSnapshot: { before, after: before, unchanged: true }, details: null, sec02Evidence: null, sec03Evidence,
    };
    validateLayerReport(report, { taskId: manifest.taskId, layer: args.layer, build: report.build, expectedFiles: manifest.layers[args.layer], sec03Context: sec03 });
    await atomicWriteJson(args.report, report);
    console.error("SEC03_BLOCKED_NATIVE_EVIDENCE");
    process.exitCode = 3;
    return;
  }

  if (args.layer === "packaged" && process.platform !== "win32") {
    const report = {
      reportVersion: sec03Resolved ? 3 : sec02Resolved ? 2 : 1,
      taskId: manifest.taskId,
      baseline: manifest.baseline,
      personaChain: manifest.personaChain,
      layer: args.layer,
      state: "unsupported",
      failureClass: "UNSUPPORTED_PLATFORM",
      command: ["node", "--test", "--test-concurrency=1", "--test-reporter=tap", ...manifest.layers[args.layer]],
      expectedFiles: manifest.layers[args.layer],
      exitCode: 2,
      signal: null,
      timeoutTermination: null,
      tap: { tests: null, passed: null, failed: null, skipped: null, cancelled: null, todo: null },
      build: { appVersion: buildInfo.appVersion, buildId: buildInfo.buildId, sourceDigest: buildInfo.sourceDigest },
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: Date.now() - started,
      maxRssBytes: process.memoryUsage().rss,
      artifactSnapshot: { before, after: before, unchanged: true },
      details: null,
      ...(sec02Resolved ? { sec02Evidence: null } : {}),
    };
    validateLayerReport(report, {
      taskId: manifest.taskId,
      layer: args.layer,
      build: report.build,
      expectedFiles: manifest.layers[args.layer],
      sec02Manifest,
      sec02Matrix,
      sec02RunId,
    });
    await atomicWriteJson(args.report, report);
    console.error(`[${args.task}] packaged layer is unsupported on this platform`);
    process.exitCode = 2;
    return;
  }

  const files = manifest.layers[args.layer];
  const receiptDirectory = sec02Resolved ? await makeTempDir("mini-lux-sec02-receipts-") : null;
  const matrixBinding = sec02Resolved
    ? sec02Manifest.governedArtifacts.find(entry => entry.exactCasePath === "tests/sec02-attack-matrix.json")
    : null;
  if (sec02Resolved) assert(matrixBinding, "SEC-02 matrix binding is missing");
  const childEnvironment = {
    ...process.env,
    ...(args.layer === "packaged" ? { RAINYDAYS_LAYER_DETAIL_REPORT: detailPath } : {}),
    ...(sec03Resolved ? {
      RAINYDAYS_SEC03_RECEIPT_DIR: sec03.sidecarDirectory,
      RAINYDAYS_SEC03_IDENTITY_FILE: process.env.RAINYDAYS_SEC03_IDENTITY_FILE,
    } : {}),
    ...(sec02Resolved ? {
      RAINYDAYS_SEC02_RECEIPT_DIR: receiptDirectory,
      RAINYDAYS_SEC02_RUN_ID: sec02RunId,
      RAINYDAYS_SEC02_RESOLVED_SHA256: sec02Manifest.canonicalPayloadSha256,
      RAINYDAYS_SEC02_MATRIX_SHA256: matrixBinding.sha256,
    } : {}),
  };
  let childResult = { code: 1, signal: null, stdout: "", stderr: "" };
  let timedOut = false;
  let timeoutTermination = null;
  let timeoutCleanupFailed = false;
  try {
    childResult = await runProcess(process.execPath, [
      "--test",
      "--test-concurrency=1",
      "--test-reporter=tap",
      ...files,
    ], {
      timeoutMs: args.timeoutMs,
      echo: true,
      env: childEnvironment,
    });
  } catch (error) {
    timedOut = error?.timedOut === true;
    timeoutTermination = timedOut ? error.termination ?? null : null;
    timeoutCleanupFailed = error?.code === "PROCESS_TIMEOUT_CLEANUP_FAILED";
    if (!timedOut) throw error;
  }

  let details = null;
  let detailInvalid = false;
  if (args.layer === "packaged") {
    try {
      details = JSON.parse(await readFile(detailPath, "utf8"));
      validatePackagedDetails(details);
    } catch {
      detailInvalid = true;
      details = null;
    }
  }
  await rm(detailPath, { force: true });

  let sec02Evidence = null;
  if (sec02Resolved) {
    try {
      sec02Evidence = await collectSec02LayerEvidence(receiptDirectory, {
        manifest: sec02Manifest,
        matrix: sec02Matrix,
        runId: sec02RunId,
        layer: args.layer,
      });
    } finally {
      await removeFixture(receiptDirectory);
    }
  }

  let sec03Evidence = null;
  if (sec03Resolved) {
    try {
      const rawReceipts = await readRawSec03Receipts(sec03.sidecarDirectory);
      sec03Evidence = recomputeSec03Evidence(rawReceipts, { ...sec03, layer: args.layer });
    } catch {
      sec03Evidence = recomputeSec03Evidence([], { ...sec03, layer: args.layer });
    } finally {
      await removeFixture(sec03.sidecarDirectory);
    }
  }

  const after = await formalArtifactSnapshot();
  const artifactsUnchanged = sameSnapshot(before, after);
  const childState = classifyProcessResult({ ...childResult, timedOut });
  const cleanupFailed = args.layer === "packaged" && details !== null && !details.cleanup.passed;
  const packagedFailureClass = details?.installerClassification === "windows-crash" || details?.installerClassification === "signal-crash"
    ? "INSTALLER_CRASH"
    : details?.installerClassification && details.installerClassification !== "passed"
      ? "INSTALLER_FAILURE"
      : cleanupFailed
        ? "CLEANUP"
        : null;
  const evidenceIncomplete = (sec02Resolved && sec02Evidence?.complete !== true)
    || (sec03Resolved && !["complete", "not-applicable"].includes(sec03Evidence?.status));
  const state = childState === "timed-out" || childState === "crashed"
    ? childState
    : !artifactsUnchanged || childState !== "passed" || cleanupFailed || detailInvalid || evidenceIncomplete ? "failed" : "passed";
  const failureClass = timedOut
    ? (timeoutCleanupFailed ? "TIMEOUT_CLEANUP_FAILED" : "TIMEOUT")
    : childResult.signal
      ? "CRASH"
      : !artifactsUnchanged
        ? "ARTIFACT_MUTATION"
        : detailInvalid || (childResult.code === 0 && evidenceIncomplete)
          ? "REPORT_VALIDATION"
          : childResult.code !== 0
            ? packagedFailureClass ?? "TEST_ASSERTION"
            : cleanupFailed
              ? "CLEANUP"
              : null;
  const report = {
    reportVersion: sec03Resolved ? 3 : sec02Resolved ? 2 : 1,
    taskId: manifest.taskId,
    baseline: manifest.baseline,
    personaChain: manifest.personaChain,
    layer: args.layer,
    state,
    failureClass,
    command: ["node", "--test", "--test-concurrency=1", "--test-reporter=tap", ...files],
    expectedFiles: files,
    exitCode: childResult.code,
    signal: childResult.signal,
    timeoutTermination,
    tap: parseTapSummary(childResult.stdout),
    build: { appVersion: buildInfo.appVersion, buildId: buildInfo.buildId, sourceDigest: buildInfo.sourceDigest },
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    maxRssBytes: process.memoryUsage().rss,
    artifactSnapshot: { before, after, unchanged: artifactsUnchanged },
    details,
    ...(sec02Resolved ? { sec02Evidence } : {}),
    ...(sec03Resolved ? { sec03Evidence } : {}),
  };
  validateLayerReport(report, {
    taskId: manifest.taskId,
    layer: args.layer,
    build: report.build,
    expectedFiles: files,
    sec02Manifest,
    sec02Matrix,
    sec02RunId,
    sec02SinkIdentity,
    ...(sec03Resolved ? { sec03Context: sec03 } : {}),
  });
  await atomicWriteJson(args.report, report);
  console.log(`[${args.task}] ${args.layer}: ${state} (${report.durationMs} ms)`);
  if (state !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
