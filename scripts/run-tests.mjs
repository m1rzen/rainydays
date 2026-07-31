import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createSec03NativeVerifier } from "./sec03-native-verifier.mjs";
import {
  atomicWriteJson,
  formalArtifactSnapshot,
  layerNames,
  loadCoverageScope,
  loadTaskManifest,
  makeTempDir,
  prepareReportPath,
  projectRoot,
  removeFixture,
  runProcess,
  sameSnapshot,
  validateCoverageGovernance,
} from "../tests/helpers.mjs";
import {
  validateCoverageReport,
  validateLayerReport,
  validateSelfTestReport,
  validateUnifiedReport,
  recomputeSec03Evidence,
} from "./report-schema.mjs";
import { aggregateSec02UnifiedEvidence } from "./sec02-receipt-set.mjs";

function parseArgs(argv) {
  const result = { task: "GOV-03", profile: "full", report: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--task") result.task = argv[++index] ?? "";
    else if (argument === "--profile") result.profile = argv[++index] ?? "";
    else if (argument === "--report") result.report = path.resolve(argv[++index] ?? "");
    else throw new Error(`Unknown argument: ${argument}`);
  }
  assert(["quick", "full"].includes(result.profile), "--profile must be quick or full");
  result.report ??= path.join(projectRoot, "test-results", `${result.task.toLowerCase()}-${result.profile}.json`);
  return result;
}

async function readJsonIfPresent(filePath) {
  try { return JSON.parse(await readFile(filePath, "utf8")); } catch { return null; }
}

async function loadFrozenSec02Predecessor(sec03ResolvedManifest) {
  const binding = sec03ResolvedManifest.predecessor;
  assert.equal(binding?.taskId, "SEC-02", "SEC-03 predecessor task differs");
  const bytes = await readFile(path.join(projectRoot, ...binding.exactCasePath.split("/")));
  assert.equal(createHash("sha256").update(bytes).digest("hex"), binding.fileSha256, "SEC-03 predecessor file identity differs");
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.canonicalPayloadSha256, binding.canonicalPayloadSha256, "SEC-03 predecessor payload identity differs");
  return manifest;
}

function childReportValidation(kind, name, report, taskId, build, coverageScope, manifestLayers, sec02Context = null) {
  if (!report) return "REPORT_MISSING_OR_INVALID_JSON";
  try {
    if (kind === "layer") validateLayerReport(report, {
      taskId,
      layer: name,
      build,
      expectedFiles: manifestLayers[name],
      ...(sec02Context ?? {}),
    });
    else if (name === "coverage") validateCoverageReport(report, { taskId, coverageScope });
    else if (name === "self-test") validateSelfTestReport(report, { taskId });
    else return "REPORT_KIND_UNKNOWN";
    return null;
  } catch {
    return "REPORT_SCHEMA_INVALID";
  }
}

async function loadSec03Context() {
  const matrixBytes = await readFile(path.join(projectRoot, "tests", "sec03-attack-matrix.json"));
  const schemaBytes = await readFile(path.join(projectRoot, "tests", "sec03-attack-matrix.schema.json"));
  const matrixSha256 = createHash("sha256").update(matrixBytes).digest("hex");
  const schemaSha256 = createHash("sha256").update(schemaBytes).digest("hex");
  const fallbackIdentity = { runId: null, candidateId: null, buildId: null, sourceSha256: null, launcherSha256: null, hostSha256: null, packageSha256: null, matrixSha256, schemaSha256 };
  try {
    const identityPath = process.env.RAINYDAYS_SEC03_IDENTITY_FILE;
    assert(identityPath && path.isAbsolute(identityPath) && path.resolve(identityPath) === identityPath, "SEC-03 trusted identity configuration is missing");
    const info = await lstat(identityPath); assert(info.isFile() && !info.isSymbolicLink()); assert.equal(await realpath(identityPath), identityPath);
    const identity = { ...JSON.parse(await readFile(identityPath, "utf8")), matrixSha256, schemaSha256 };
    const nativeVerifier = await createSec03NativeVerifier(identity);
    return { configured: true, matrix: JSON.parse(matrixBytes), identity, nativeVerifier };
  } catch (error) {
    return { configured: false, matrix: JSON.parse(matrixBytes), identity: fallbackIdentity, nativeVerifier: { verifyNativeEvidence() { throw new Error("blocked"); } }, error: error instanceof Error ? error.message : String(error) };
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  args.report = await prepareReportPath(args.report);
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
  const configuredSec02RunId = sec02Resolved ? process.env.RAINYDAYS_SEC02_RUN_ID : undefined;
  if (configuredSec02RunId !== undefined) {
    assert.match(configuredSec02RunId, /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, "GOV-04 SEC-02 run ID is invalid");
  }
  const sec02RunId = sec02Resolved ? (configuredSec02RunId ?? randomUUID()) : null;
  const sec02Context = sec02Resolved ? { sec02Manifest, sec02Matrix, sec02RunId } : null;
  const sec03Context = sec03Resolved ? await loadSec03Context() : null;
  const { scope } = await loadCoverageScope();
  await validateCoverageGovernance(manifest, scope);
  const buildInfo = JSON.parse(await readFile(path.join(projectRoot, "build-info.json"), "utf8"));
  const before = await formalArtifactSnapshot();
  const runRoot = await makeTempDir("mini-lux-gov03-run-");
  const results = [];
  let sec02Evidence = null;
  let sec03Evidence = null;
  let cleanupPassed = false;
  try {
    const requiredLayers = args.profile === "full" ? layerNames : layerNames.filter((layer) => layer !== "packaged");
    for (const layer of requiredLayers) {
      const reportPath = path.join(runRoot, `${layer}.json`);
      const child = await runProcess(process.execPath, [
        "scripts/run-test-layer.mjs",
        "--task", args.task,
        "--layer", layer,
        "--report", reportPath,
        ...(sec02RunId ? ["--run-id", sec02RunId] : []),
      ], { timeoutMs: layer === "packaged" ? 600_000 : 360_000, echo: true });
      const report = await readJsonIfPresent(reportPath);
      const reportValidation = childReportValidation("layer", layer, report, manifest.taskId, {
        appVersion: buildInfo.appVersion,
        buildId: buildInfo.buildId,
        sourceDigest: buildInfo.sourceDigest,
      }, scope, manifest.layers, { ...(sec02Context ?? {}), ...(sec03Resolved ? { sec03Context } : {}) });
      results.push({ kind: "layer", name: layer, exitCode: child.code, report: reportValidation ? null : report, reportValidation });
      if (child.code !== 0 || reportValidation || report?.state !== "passed") break;
    }

    const layerResults = results.filter(entry => entry.kind === "layer");
    if (sec02Resolved && args.profile === "full" && layerResults.length === layerNames.length) {
      sec02Evidence = aggregateSec02UnifiedEvidence(
        layerResults.map(entry => ({ layer: entry.name, receipts: entry.report?.sec02Evidence?.receipts ?? null })),
        { manifest: sec02Manifest, matrix: sec02Matrix, runId: sec02RunId },
      );
    }

    if (sec03Resolved) {
      const receipts = layerResults.flatMap((entry) => entry.report?.sec03Evidence?.receipts ?? []);
      sec03Evidence = recomputeSec03Evidence(receipts, { ...sec03Context, layer: "unified" });
    }
    const sec02AggregationPassed = !sec02Resolved || args.profile === "quick" || sec02Evidence?.complete === true;
    const sec03AggregationPassed = !sec03Resolved || sec03Evidence?.status === "complete";
    if (sec02AggregationPassed && sec03AggregationPassed && (!sec03Resolved || args.profile === "full") && results.every((entry) => entry.exitCode === 0 && !entry.reportValidation && entry.report?.state === "passed")) {
      const coveragePath = path.join(runRoot, "coverage.json");
      const coverage = await runProcess(process.execPath, ["scripts/run-coverage.mjs", "--task", args.task, "--report", coveragePath], { timeoutMs: 660_000, echo: true });
      const report = await readJsonIfPresent(coveragePath);
      const reportValidation = childReportValidation("gate", "coverage", report, manifest.taskId, null, scope, manifest.layers);
      results.push({ kind: "gate", name: "coverage", exitCode: coverage.code, report: reportValidation ? null : report, reportValidation });
    }

    if (args.profile === "full" && sec02AggregationPassed && sec03AggregationPassed && results.every((entry) => entry.exitCode === 0 && !entry.reportValidation && entry.report?.state === "passed")) {
      const selfPath = path.join(runRoot, "self-test.json");
      const selfTest = await runProcess(process.execPath, ["scripts/test-gate-selftest.mjs", "--task", args.task, "--report", selfPath], { timeoutMs: 900_000, echo: true });
      const report = await readJsonIfPresent(selfPath);
      const reportValidation = childReportValidation("gate", "self-test", report, manifest.taskId, null, scope, manifest.layers);
      results.push({ kind: "gate", name: "self-test", exitCode: selfTest.code, report: reportValidation ? null : report, reportValidation });
    }
  } finally {
    await removeFixture(runRoot);
    cleanupPassed = true;
  }

  const after = await formalArtifactSnapshot();
  const artifactsUnchanged = sameSnapshot(before, after);
  const expected = args.profile === "full"
    ? [...layerNames, "coverage", "self-test"]
    : sec03Resolved ? layerNames.filter((layer) => layer !== "packaged") : [...layerNames.filter((layer) => layer !== "packaged"), "coverage"];
  const actual = results.map((entry) => entry.name);
  const allExpectedRan = expected.length === actual.length && expected.every((entry, index) => entry === actual[index]);
  const allPassed = allExpectedRan && results.every((entry) => entry.exitCode === 0 && !entry.reportValidation && entry.report?.state === "passed");
  const state = allPassed && artifactsUnchanged && cleanupPassed ? (sec03Resolved && args.profile === "quick" ? "partial" : "passed") : "failed";
  const report = {
    reportVersion: sec03Resolved ? 3 : sec02Resolved ? 2 : 1,
    taskId: manifest.taskId,
    profile: args.profile,
    state,
    baseline: manifest.baseline,
    personaChain: manifest.personaChain,
    build: { appVersion: buildInfo.appVersion, buildId: buildInfo.buildId, sourceDigest: buildInfo.sourceDigest },
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    expected,
    actual,
    results,
    ...(sec02Resolved ? { sec02Evidence } : {}),
    ...(sec03Resolved ? { sec03Evidence } : {}),
    cleanupPassed,
    artifactSnapshot: { before, after, unchanged: artifactsUnchanged },
    metrics: { toolCalls: 0, llmCalls: 0, tokens: 0, runnerMaxRssBytes: process.memoryUsage().rss },
    knownLimitations: manifest.taskId === "SEC-01" ? [
      "SEC-01 binds allowed roots and network envelopes, but canonical PathPolicy and TOCTOU defenses remain SEC-02",
      "SEC-01 authorizes executors but does not claim OS process, filesystem or socket sandbox enforcement; that remains SEC-03",
      "Coverage applies only to the disclosed governed executable registry and every authored exemption remains visible in the task manifest",
      "A same-path immediate NSIS rerun previously produced Windows 0xC0000005; packaged tests execute a manifest-verified per-run copy as a mitigation, not an upstream NSIS root-cause fix",
    ] : [
      "GOV-04 local governance is implemented; real GitHub server-side rules and REL-01 trusted signing remain externally blocked",
      "Coverage applies only to the disclosed governed executable registry",
      "A same-path immediate NSIS rerun previously produced Windows 0xC0000005; packaged tests execute a manifest-verified per-run copy as a mitigation, not an upstream NSIS root-cause fix",
    ],
    reviewerVerdict: null,
    userStatus: "not-reviewed",
  };
  validateUnifiedReport(report, {
    taskId: manifest.taskId,
    build: report.build,
    coverageScope: scope,
    layerExpectedFiles: manifest.layers,
    ...(sec02Context ?? {}),
    ...(sec03Resolved ? { sec03Context } : {}),
  });
  await atomicWriteJson(args.report, report);
  console.log(`[${args.task}] ${args.profile}: ${state} (${report.durationMs} ms)`);
  if (state !== "passed") {
    const nativeEvidenceBlocked = sec03Resolved && results.some((entry) => entry.exitCode === 3 && entry.report?.failureClass === "SEC03_BLOCKED_NATIVE_EVIDENCE");
    process.exitCode = nativeEvidenceBlocked ? 3 : 1;
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
