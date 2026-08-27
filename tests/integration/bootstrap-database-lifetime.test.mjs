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

test("SEC-06 persisted audit journal survives restart, rejects mutation and enters snapshots", async () => {
  assert.deepEqual(await runScenario("security-audit"), {
    scenario: "security-audit",
    persistedAcrossReopen: true,
    appendOnlyTriggers: true,
    snapshotContainsKeyAndChain: true,
    secretBytesAbsent: true,
    tamperDetected: true,
    tailTruncationDetected: true,
    missingCheckpointDetected: true,
    genesisPublishedAtomically: true,
  });
});

test("DATA-01 corrupted WAL is rejected before writable open without mutating recovery evidence", async () => {
  assert.deepEqual(await runScenario("wal-corruption"), {
    scenario: "wal-corruption",
    corruptionsDenied: 11,
    identityViolationsDenied: 2,
    sourceByteIdentical: true,
    validWalRecovered: true,
    cleanClose: true,
  });
});

test("DATA-01 SQLite online backup seals WAL content into one validated snapshot", async () => {
  assert.deepEqual(await runScenario("snapshot"), {
    scenario: "snapshot",
    schemaVersion: 11,
    walContentPreserved: true,
    checksPassed: true,
    cleanClose: true,
  });
});

test("DATA-01 validated restore plan denies active DB and publishes the frozen snapshot after close", async () => {
  assert.deepEqual(await runScenario("restore"), {
    scenario: "restore",
    activeDatabaseDenied: true,
    publishAfterCloseSucceeded: true,
    postBackupMutationAbsent: true,
    oneShot: true,
  });
});

test("DATA-01 restore publication refuses live SQLite sidecars without consuming the plan", async () => {
  assert.deepEqual(await runScenario("restore-sidecar"), {
    scenario: "restore-sidecar",
    liveSidecarDenied: true,
    liveSidecarUnchanged: true,
    discardAfterDenial: true,
  });
});

test("DATA-01B restore preflight rejects foreign-user vault and audit key before PREPARED", async () => {
  assert.deepEqual(await runScenario("restore-dpapi-preflight"), {
    scenario: "restore-dpapi-preflight",
    foreignVaultDenied: true,
    foreignAuditKeyDenied: true,
    auditPreflightMatrix: 7,
    noPreparedTransaction: true,
    cleanClose: true,
  });
});

test("DATA-01 restore rejects config references absent from the opaque vault before staging", async () => {
  assert.deepEqual(await runScenario("restore-config-mismatch"), {
    scenario: "restore-config-mismatch",
    mismatchDenied: true,
    stagingLeaseNotIssued: true,
    cleanClose: true,
  });
});

test("DATA-01 managed backup authenticates every allowlisted managed role and discard is one-shot", async () => {
  assert.deepEqual(await runScenario("restore-rich-managed"), {
    scenario: "restore-rich-managed",
    allManagedRoles: true,
    discardOneShot: true,
    incompatibleVersionDenied: true,
    exactSetPublished: true,
    cleanClose: true,
  });
});

test("DATA-01 restore staging primitives reject invalid input and enforce one-shot lifecycle", async () => {
  assert.deepEqual(await runScenario("restore-primitives"), {
    scenario: "restore-primitives",
    invalidArgumentsDenied: true,
    rejectedCandidateCleaned: true,
    activeLeaseBlockedRetirement: true,
    oneShotLease: true,
    activeDatabaseDenied: true,
    sidecarDeniedUnchanged: true,
    multiLinkDenied: true,
    publishAfterDenialsSucceeded: true,
    invalidTemporaryPrefixDenied: true,
    closedDatabaseLeaseDenied: true,
    activeRuntimeLeaseBlockedRetirement: true,
    closedRuntimeLeaseDenied: true,
  });
});

test("SEC-02 governed database facade exercises the persistent schema and CRUD surface", async () => {
  assert.deepEqual(await runScenario("crud"), {
    scenario: "crud",
    crudCovered: true,
    schemaVersion: 11,
  });
});
