import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { makeTempDir, projectRoot, removeFixture, runProcess } from "../helpers.mjs";

async function runScenario(scenario) {
  const fixture = await makeTempDir(`mini-lux-sqlite-${scenario}-`);
  const outside = await makeTempDir(`mini-lux-sqlite-${scenario}-outside-`);
  try {
    const result = await runProcess(process.execPath, [
      "tests/fixtures/sqlite-lifetime-child.mjs",
      scenario,
      fixture,
      outside,
    ], {
      cwd: projectRoot,
      timeoutMs: 30_000,
    });
    assert.equal(result.signal, null, `${scenario} child ended by signal`);
    assert.equal(result.code, 0, `${scenario} child failed\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    const lines = result.stdout.split(/\r?\n/u).filter(Boolean);
    return JSON.parse(lines.at(-1));
  } finally {
    await removeFixture(fixture);
    await removeFixture(outside);
  }
}

test("SEC-02 SQLite connection lifetime blocks bootstrap retirement until clean close", async () => {
  assert.deepEqual(await runScenario("normal"), {
    scenario: "normal",
    transactionGuarded: true,
    activeLeaseBlockedRetirement: true,
    cleanClose: true,
  });
});

test("SEC-02 SQLite rejects a linked sidecar before opening the third-party connection", async () => {
  assert.deepEqual(await runScenario("sidecar-link"), {
    scenario: "sidecar-link",
    code: "PATH_REDIRECT_DENIED",
    externalUnchanged: true,
  });
});

test("SEC-02 SQLite active main pathname cannot be replaced on Windows", async () => {
  const actual = await runScenario("main-replacement");
  assert.equal(actual.scenario, "main-replacement");
  assert(["EBUSY", "EACCES", "EPERM"].includes(actual.replacementCode));
  assert.equal(actual.replacementAttemptDenied, true);
  assert.equal(actual.originalReadable, true);
  assert.equal(actual.cleanClose, true);
});

test("SEC-02 SQLite active main multi-hardlink poisons the guarded connection", async () => {
  assert.deepEqual(await runScenario("main-hardlink"), {
    scenario: "main-hardlink",
    code: "PATH_IDENTITY_CHANGED",
    closeCode: "PATH_AUTHORITY_STALE",
    linkCount: 2,
    operationDenied: true,
    poisonedHandleDrained: true,
    bootstrapRetired: true,
  });
});

test("SEC-02 governed database facade exercises the persistent schema and CRUD surface", async () => {
  assert.deepEqual(await runScenario("crud"), {
    scenario: "crud",
    crudCovered: true,
    schemaVersion: 1,
  });
});
