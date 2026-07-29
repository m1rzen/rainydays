import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeTempDir, projectRoot, removeFixture, runProcess, sha256File } from "../helpers.mjs";

const baselinePath = path.join(projectRoot, "parity", "baselines", "lux-desktop-0.1.898.json");
const expectedHash = "1126d7449fca392e64721d5e7e86169158bc8c72ea72f9d414fa0fe93ab445df";

function parseJsonOutput(stdout) {
  const start = stdout.indexOf("{");
  assert(start >= 0, "JSON output missing");
  return JSON.parse(stdout.slice(start));
}

test("GOV-01 synthetic contract matrix remains fail-closed", async () => {
  const result = await runProcess(process.execPath, ["parity/scripts/test-baseline-diff.mjs"], { timeoutMs: 60_000 });
  assert.equal(result.code, 0, result.stderr);
  const payload = parseJsonOutput(result.stdout);
  assert.deepEqual({ passed: payload.passed, failed: payload.failed }, { passed: 13, failed: 0 });
});

test("locked Lux v0.1.898 baseline and fault injection remain valid", async () => {
  const root = await makeTempDir("mini-lux-gov03-contract-");
  try {
    const reportPath = path.join(root, "report.json");
    const result = await runProcess(process.execPath, [
      "parity/scripts/verify-locked-baseline.mjs",
      "--report",
      reportPath,
    ], { timeoutMs: 90_000 });
    assert.equal(result.code, 0, result.stderr);
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    assert.equal(report.target.version, "0.1.898");
    assert.equal(report.baseline.sha256, expectedHash);
    assert.deepEqual({ passed: report.summary.passed, failed: report.summary.failed }, { passed: 10, failed: 0 });
    assert.equal(await sha256File(baselinePath), expectedHash);
  } finally {
    await removeFixture(root);
  }
});
