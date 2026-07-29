import assert from "node:assert/strict";
import { cp, mkdir, readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { evaluateCoverageSummary } from "./coverage-lib.mjs";
import {
  atomicWriteJson,
  formalArtifactSnapshot,
  loadCoverageScope,
  loadTaskManifest,
  makeTempDir,
  prepareReportPath,
  projectRoot,
  removeFixture,
  runProcess,
  sameSnapshot,
  sha256File,
  validateCoverageGovernance,
} from "../tests/helpers.mjs";
import { validateCoverageReport } from "./report-schema.mjs";

function parseArgs(argv) {
  const result = { task: "GOV-03", report: path.join(projectRoot, "test-results", "coverage-gate.json"), scope: null, preserveOutput: null, timeoutMs: 600_000, staleSeed: null };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--task") result.task = argv[++index] ?? "";
    else if (argv[index] === "--report") result.report = path.resolve(argv[++index] ?? "");
    else if (argv[index] === "--scope") result.scope = path.resolve(argv[++index] ?? "");
    else if (argv[index] === "--preserve-output") result.preserveOutput = true;
    else if (argv[index] === "--no-preserve-output") result.preserveOutput = false;
    else if (argv[index] === "--timeout-ms") result.timeoutMs = Number(argv[++index]);
    else if (argv[index] === "--seed-stale-coverage") result.staleSeed = path.resolve(argv[++index] ?? "");
    else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  assert.match(result.task, /^[A-Z]+-\d{2}$/);
  assert(Number.isInteger(result.timeoutMs) && result.timeoutMs >= 100 && result.timeoutMs <= 600_000, "--timeout-ms is invalid");
  result.preserveOutput ??= result.scope === null;
  return result;
}

async function listAuthoredFiles(root, extensions) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile() && extensions.has(path.extname(entry.name))) files.push(path.relative(projectRoot, absolute).replaceAll("\\", "/"));
    }
  }
  await visit(root);
  return files;
}

async function seedStaleCoverage(seedDirectory, rawDirectory) {
  if (!seedDirectory) return 0;
  const seedReal = await realpath(seedDirectory);
  const tempReal = await realpath(os.tmpdir());
  const relative = path.relative(tempReal, seedReal);
  assert(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "stale coverage seed must be inside OS Temp");
  const entries = await readdir(seedReal, { withFileTypes: true });
  assert(entries.length > 0 && entries.length <= 100, "stale coverage seed file count is invalid");
  await mkdir(rawDirectory, { recursive: true });
  for (const entry of entries) {
    assert(entry.isFile() && entry.name.endsWith(".json"), "stale coverage seed must contain only JSON files");
    const source = path.join(seedReal, entry.name);
    const info = await stat(source);
    assert(info.size > 0 && info.size <= 10 * 1024 * 1024, "stale coverage seed file size is invalid");
    JSON.parse(await readFile(source, "utf8"));
    await cp(source, path.join(rawDirectory, `stale-${entry.name}`));
  }
  return entries.length;
}

async function authoredInventory(scope) {
  const authored = [
    ...await listAuthoredFiles(path.join(projectRoot, "src"), new Set([".ts"])),
    ...await listAuthoredFiles(path.join(projectRoot, "electron"), new Set([".cjs", ".mjs", ".js"])),
    ...await listAuthoredFiles(path.join(projectRoot, "public"), new Set([".js"])),
    ...await listAuthoredFiles(path.join(projectRoot, "parity", "scripts"), new Set([".mjs"])),
  ].sort();
  const mapped = new Set();
  for (const entry of scope.overall) {
    if (entry.startsWith("dist/") && entry.endsWith(".js")) {
      const source = `src/${entry.slice("dist/".length, -3)}.ts`;
      if (authored.includes(source)) mapped.add(source);
    } else if (authored.includes(entry)) mapped.add(entry);
  }
  return { authoredProductionFiles: authored.length, registeredAuthoredEquivalents: mapped.size, unregisteredLegacyDebt: authored.length - mapped.size };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  args.report = await prepareReportPath(args.report);
  const startedAt = new Date();
  const started = Date.now();
  const { manifest } = await loadTaskManifest(args.task);
  const { scope, filePath: scopePath } = await loadCoverageScope(args.scope);
  await validateCoverageGovernance(manifest, scope);
  const before = await formalArtifactSnapshot();
  const temporary = await makeTempDir("mini-lux-gov03-coverage-");
  let child = { code: 1, signal: null, stdout: "", stderr: "" };
  let timedOut = false;
  let timeoutTermination = null;
  let timeoutCleanupFailed = false;
  let evaluation = null;
  let reportError = null;
  let preservedOutput = false;
  let staleSeedFiles = 0;
  try {
    const reportsDirectory = path.join(temporary, "report");
    const rawDirectory = path.join(temporary, "raw");
    const c8 = path.join(projectRoot, "node_modules", "c8", "bin", "c8.js");
    staleSeedFiles = await seedStaleCoverage(args.staleSeed, rawDirectory);
    const includes = scope.overall.flatMap((entry) => ["--include", entry]);
    try {
      child = await runProcess(process.execPath, [
        c8,
      "--all",
      "--clean=true",
      "--src=.",
      ...includes,
      "--reporter=json",
      "--reporter=json-summary",
      "--reporter=text",
      `--reports-dir=${reportsDirectory}`,
      `--temp-directory=${rawDirectory}`,
      process.execPath,
      "--test",
      "--test-concurrency=1",
      ...manifest.layers.contract,
      ...manifest.layers.integration,
      ], { timeoutMs: args.timeoutMs, echo: true });
    } catch (error) {
      timedOut = error?.timedOut === true;
      timeoutTermination = timedOut ? error.termination ?? null : null;
      timeoutCleanupFailed = error?.code === "PROCESS_TIMEOUT_CLEANUP_FAILED";
      if (!timedOut) throw error;
    }
    try {
      const summary = JSON.parse(await readFile(path.join(reportsDirectory, "coverage-summary.json"), "utf8"));
      evaluation = evaluateCoverageSummary(summary, scope, projectRoot);
      if (args.preserveOutput) {
        const preserved = path.join(projectRoot, "test-results", "coverage");
        await rm(preserved, { recursive: true, force: true });
        await mkdir(preserved, { recursive: true });
        await cp(path.join(reportsDirectory, "coverage-summary.json"), path.join(preserved, "coverage-summary.json"));
        await cp(path.join(reportsDirectory, "coverage-final.json"), path.join(preserved, "coverage-final.json"));
        preservedOutput = true;
      }
    } catch {
      reportError = "COVERAGE_REPORT_READ_OR_VALIDATION_FAILED";
    }
  } finally {
    await removeFixture(temporary);
  }
  const after = await formalArtifactSnapshot();
  const artifactsUnchanged = sameSnapshot(before, after);
  const state = timedOut
    ? "timed-out"
    : child.signal
      ? "crashed"
      : child.code === 0 && evaluation?.passed && !reportError && artifactsUnchanged ? "passed" : "failed";
  const failureClass = timedOut
    ? (timeoutCleanupFailed ? "TIMEOUT_CLEANUP_FAILED" : "TIMEOUT")
    : child.signal
      ? "CRASH"
      : !artifactsUnchanged
        ? "ARTIFACT_MUTATION"
        : child.code !== 0
          ? "COVERAGE_TEST_FAILURE"
          : reportError
            ? "COVERAGE_REPORT_INVALID"
            : !evaluation?.passed ? "COVERAGE_THRESHOLD" : null;
  const c8Package = JSON.parse(await readFile(path.join(projectRoot, "node_modules", "c8", "package.json"), "utf8"));
  const report = {
    reportVersion: 1,
    taskId: manifest.taskId,
    state,
    failureClass,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    registrySha256: await sha256File(scopePath),
    nodeVersion: process.versions.node,
    c8Version: c8Package.version,
    testExitCode: child.code,
    testSignal: child.signal,
    testTimedOut: timedOut,
    timeoutTermination,
    evaluation,
    reportError,
    inventory: await authoredInventory(scope),
    coverageExemptions: manifest.coverageExemptions,
    artifactSnapshot: { before, after, unchanged: artifactsUnchanged },
    maxRssBytes: process.memoryUsage().rss,
    preservedOutput,
    staleSeedFiles,
  };
  validateCoverageReport(report, { taskId: manifest.taskId, coverageScope: scope });
  await atomicWriteJson(args.report, report);
  console.log(`[${args.task}] coverage: ${state} (${report.durationMs} ms)`);
  if (state !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
