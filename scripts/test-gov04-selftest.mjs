import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import process from "node:process";
import { atomicWriteJson, prepareReportPath, projectRoot, runProcess } from "../tests/helpers.mjs";
import { gov04SelfTestIds, validateGov04SelfTestReport } from "./gov04/report-schema.mjs";

function parseArgs(argv) {
  const result = { report: path.join(projectRoot, "test-results", "gov04-self-test.json") };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--report") result.report = path.resolve(argv[++index] ?? "");
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return result;
}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  args.report = await prepareReportPath(args.report);
  const startedAt = new Date();
  const started = Date.now();
  let child;
  let cleanupPassed = false;
  try {
    child = await runProcess(process.execPath, ["--test", "--test-concurrency=1", "--test-reporter=tap", "tests/gov04/report-schema.test.mjs", "tests/gov04/workflow-policy.test.mjs"], { cwd: projectRoot, timeoutMs: 180_000 });
    cleanupPassed = true;
  } catch (error) {
    child = { code: 1, signal: null, stdout: "", stderr: error instanceof Error ? error.name : "Error" };
    cleanupPassed = error?.timedOut !== true || error?.termination?.childExited === true;
  }
  const scenarios = gov04SelfTestIds.map((id) => {
    const passedPattern = new RegExp(`^ok \\d+ - ${id}(?:\\s|$)`, "m");
    const failedPattern = new RegExp(`^not ok \\d+ - ${id}(?:\\s|$)`, "m");
    return { id, passed: passedPattern.test(child.stdout) && !failedPattern.test(child.stdout) };
  });
  const report = {
    schemaVersion: 1,
    taskId: "GOV-04",
    state: child.code === 0 && cleanupPassed && scenarios.every((scenario) => scenario.passed) ? "passed" : "failed",
    failureClass: null,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - started,
    expected: [...gov04SelfTestIds],
    actual: scenarios.map((scenario) => scenario.id),
    scenarios,
    exitCode: child.code ?? 1,
    stdoutSha256: digest(child.stdout),
    stderrSha256: digest(child.stderr),
    cleanupPassed,
  };
  if (report.state === "failed") report.failureClass = "SELF_TEST_PROOF_FAILED";
  validateGov04SelfTestReport(report);
  await atomicWriteJson(args.report, report);
  console.log(`[GOV-04 self-test] ${report.state}: ${scenarios.filter((scenario) => scenario.passed).length}/${scenarios.length}`);
  if (report.state !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
