import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { makeTempDir, projectRoot, removeFixture, runProcess } from "../helpers.mjs";

function payload(stdout) {
  const lines = stdout.trim().split(/\r?\n/u).filter(Boolean);
  return JSON.parse(lines.at(-1));
}

test("DS-03 schema 11 persists one canonical WorkbenchLayout with optimistic revision", { timeout: 30_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-ds03-layout-");
  const child = path.join("tests", "fixtures", "ds03-workbench-child.mjs");
  try {
    const write = await runProcess(process.execPath, [child, "write", fixture], { cwd: projectRoot, timeoutMs: 15_000 });
    assert.equal(write.code, 0, write.stderr);
    assert.deepEqual(payload(write.stdout), { mode: "write", schemaVersion: 11, revision: 2, tabs: 2 });
    const read = await runProcess(process.execPath, [child, "read", fixture], { cwd: projectRoot, timeoutMs: 15_000 });
    assert.equal(read.code, 0, read.stderr);
    assert.deepEqual(payload(read.stdout), { mode: "read", schemaVersion: 11, revision: 2, tabs: 2 });
  } finally {
    await removeFixture(fixture);
  }
});
