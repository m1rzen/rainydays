import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  hashTree,
  makeTempDir,
  projectRoot,
  removeFixture,
  runProcess,
  spawnManaged,
  terminateProcessTreeAsync,
  waitFor,
} from "../helpers.mjs";

const cases = Object.freeze([
  Object.freeze({ barrier: "journal:prepared-published", expected: "A" }),
  Object.freeze({ barrier: "live:set-complete", expected: "A" }),
  Object.freeze({ barrier: "journal:committed-published", expected: "B" }),
]);

for (const entry of cases) {
  test(`DATA-01B hard kill at ${entry.barrier} recovers exact generation ${entry.expected}`, { timeout: 120_000 }, async () => {
    const fixture = await makeTempDir("mini-lux-data01b-restore-");
    const child = spawnManaged(process.execPath, [
      "tests/fixtures/managed-restore-crash-child.mjs",
      "crash",
      fixture,
      entry.barrier,
    ], { cwd: projectRoot });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    try {
      await waitFor(() => stdout.includes(`RESTORE_BARRIER:${entry.barrier}`), {
        timeoutMs: 30_000,
        label: entry.barrier,
      });
      const killed = await terminateProcessTreeAsync(child);
      assert.equal(killed.exitCode, 0, `taskkill failed\n${stderr}`);
      assert.equal(killed.childExited, true);
      const recovery = await runProcess(process.execPath, [
        "tests/fixtures/managed-restore-crash-child.mjs",
        "recover",
        fixture,
        entry.expected,
      ], { cwd: projectRoot, timeoutMs: 30_000 });
      assert.equal(recovery.code, 0, `recovery failed\nstdout=${recovery.stdout}\nstderr=${recovery.stderr}`);
      const payload = JSON.parse(recovery.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1));
      assert.deepEqual(payload, { expected: entry.expected, recoveredExactGeneration: true, startupGatePassed: true });
    } finally {
      if (child.exitCode === null) await terminateProcessTreeAsync(child);
      await removeFixture(fixture);
    }
  });
}

test("DATA-01B OS restore lock serializes processes and releases on hard kill", { timeout: 120_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-data01b-lock-");
  const owner = spawnManaged(process.execPath, [
    "tests/fixtures/managed-restore-crash-child.mjs", "crash", fixture, "journal:prepared-published",
  ], { cwd: projectRoot });
  let ownerOutput = "";
  owner.stdout.setEncoding("utf8");
  owner.stdout.on("data", chunk => { ownerOutput += chunk; });
  let contender = null;
  try {
    await waitFor(() => ownerOutput.includes("RESTORE_BARRIER:journal:prepared-published"), { timeoutMs: 30_000, label: "restore lock owner" });
    contender = spawnManaged(process.execPath, [
      "tests/fixtures/managed-restore-crash-child.mjs", "lock-probe", fixture, "unused",
    ], { cwd: projectRoot });
    let contenderOutput = "";
    contender.stdout.setEncoding("utf8");
    contender.stdout.on("data", chunk => { contenderOutput += chunk; });
    await new Promise(resolve => setTimeout(resolve, 750));
    assert.equal(contenderOutput.includes("RESTORE_LOCK_ACQUIRED"), false);
    assert.equal((await terminateProcessTreeAsync(owner)).exitCode, 0);
    await waitFor(() => contenderOutput.includes("RESTORE_LOCK_ACQUIRED"), { timeoutMs: 10_000, label: "restore lock takeover" });
  } finally {
    if (owner.exitCode === null) await terminateProcessTreeAsync(owner);
    if (contender?.exitCode === null) await terminateProcessTreeAsync(contender);
    await removeFixture(fixture);
  }
});

test("DATA-01B post-PREPARED ENOSPC rolls back exact A and the same sources retry to B", { timeout: 120_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-data01b-enospc-");
  try {
    const result = await runProcess(process.execPath, [
      "tests/fixtures/managed-restore-crash-child.mjs", "enospc-retry", fixture, "unused",
    ], { cwd: projectRoot, timeoutMs: 60_000 });
    assert.equal(result.code, 0, `ENOSPC fixture failed\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    const payload = JSON.parse(result.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1));
    assert.deepEqual(payload, {
      injectedEnospc: true,
      exactRollbackA: true,
      journalCleared: true,
      sameSourcesRetryB: true,
    });
  } finally {
    await removeFixture(fixture);
  }
});

test("DATA-01B pinned stage leases survive post-verification old/new path removal and roll back exact A", { timeout: 120_000 }, async () => {
  for (const side of ["old", "new"]) {
    const fixture = await makeTempDir(`mini-lux-data01b-stage-toctou-${side}-`);
    try {
      const result = await runProcess(process.execPath, [
        "tests/fixtures/managed-restore-crash-child.mjs", "stage-toctou", fixture, side,
      ], { cwd: projectRoot, timeoutMs: 60_000 });
      assert.equal(result.code, 0, `${side} stage TOCTOU fixture failed\nstdout=${result.stdout}\nstderr=${result.stderr}`);
      assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
        side,
        pinnedStageSurvivedPathRemoval: true,
        exactRollbackA: true,
        journalCleared: true,
      });
    } finally {
      await removeFixture(fixture);
    }
  }
});

test("DATA-01B rollback recovery remains idempotent across a second hard kill", { timeout: 120_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-data01b-recovery-crash-");
  const first = spawnManaged(process.execPath, [
    "tests/fixtures/managed-restore-crash-child.mjs", "crash", fixture, "live:set-complete",
  ], { cwd: projectRoot });
  let firstOutput = "";
  first.stdout.setEncoding("utf8");
  first.stdout.on("data", chunk => { firstOutput += chunk; });
  let recoveryChild = null;
  try {
    await waitFor(() => firstOutput.includes("RESTORE_BARRIER:live:set-complete"), { timeoutMs: 30_000, label: "initial restore crash" });
    assert.equal((await terminateProcessTreeAsync(first)).exitCode, 0);
    recoveryChild = spawnManaged(process.execPath, [
      "tests/fixtures/managed-restore-crash-child.mjs", "recover-crash", fixture, "recovery:after-write",
    ], { cwd: projectRoot });
    let recoveryOutput = "";
    recoveryChild.stdout.setEncoding("utf8");
    recoveryChild.stdout.on("data", chunk => { recoveryOutput += chunk; });
    await waitFor(() => recoveryOutput.includes("RESTORE_BARRIER:recovery:after-write"), { timeoutMs: 30_000, label: "recovery crash" });
    const secondKill = await terminateProcessTreeAsync(recoveryChild);
    assert.equal(secondKill.exitCode, 0);
    assert.equal(secondKill.childExited, true);
    const finalRecovery = await runProcess(process.execPath, [
      "tests/fixtures/managed-restore-crash-child.mjs", "recover", fixture, "A",
    ], { cwd: projectRoot, timeoutMs: 30_000 });
    assert.equal(finalRecovery.code, 0, finalRecovery.stderr);
  } finally {
    if (first.exitCode === null) await terminateProcessTreeAsync(first);
    if (recoveryChild?.exitCode === null) await terminateProcessTreeAsync(recoveryChild);
    await removeFixture(fixture);
  }
});

test("DATA-01B rollback and committed cleanup converge after every durable hard-kill point", { timeout: 600_000 }, async () => {
  const cleanupPoints = Object.freeze([
    "cleanup:old-file-removed",
    "cleanup:old-directory-removed",
    "cleanup:new-file-removed",
    "cleanup:new-directory-removed",
    "cleanup:transaction-directory-removed",
    "cleanup:before-journal-remove",
    "cleanup:journal-removed",
  ]);
  const matrices = Object.freeze([
    Object.freeze({ expected: "A", initialBarrier: "live:set-complete", recoveryPoints: Object.freeze([
      "recovery:prepared-set-complete",
      "recovery:rolled-back-published",
      ...cleanupPoints,
    ]) }),
    Object.freeze({ expected: "B", initialBarrier: "journal:committed-published", recoveryPoints: Object.freeze([
      "recovery:committed-set-complete",
      ...cleanupPoints,
    ]) }),
  ]);

  for (const matrix of matrices) {
    for (const recoveryPoint of matrix.recoveryPoints) {
      const fixture = await makeTempDir(`mini-lux-data01b-cleanup-${matrix.expected.toLowerCase()}-`);
      const initial = spawnManaged(process.execPath, [
        "tests/fixtures/managed-restore-crash-child.mjs", "crash", fixture, matrix.initialBarrier,
      ], { cwd: projectRoot });
      let initialOutput = "";
      initial.stdout.setEncoding("utf8");
      initial.stdout.on("data", chunk => { initialOutput += chunk; });
      let recoveryChild = null;
      try {
        await waitFor(() => initialOutput.includes(`RESTORE_BARRIER:${matrix.initialBarrier}`), {
          timeoutMs: 30_000,
          label: `${matrix.expected}:${matrix.initialBarrier}`,
        });
        assert.equal((await terminateProcessTreeAsync(initial)).exitCode, 0);

        recoveryChild = spawnManaged(process.execPath, [
          "tests/fixtures/managed-restore-crash-child.mjs", "recover-crash", fixture, recoveryPoint,
        ], { cwd: projectRoot });
        let recoveryOutput = "";
        recoveryChild.stdout.setEncoding("utf8");
        recoveryChild.stdout.on("data", chunk => { recoveryOutput += chunk; });
        await waitFor(() => recoveryOutput.includes(`RESTORE_BARRIER:${recoveryPoint}`), {
          timeoutMs: 30_000,
          label: `${matrix.expected}:${recoveryPoint}`,
        });
        assert.equal((await terminateProcessTreeAsync(recoveryChild)).exitCode, 0);

        for (let attempt = 0; attempt < 2; attempt += 1) {
          const recovered = await runProcess(process.execPath, [
            "tests/fixtures/managed-restore-crash-child.mjs", "recover", fixture, matrix.expected,
          ], { cwd: projectRoot, timeoutMs: 30_000 });
          assert.equal(recovered.code, 0, `${matrix.expected}:${recoveryPoint}:attempt-${attempt + 1}\n${recovered.stderr}`);
        }
      } finally {
        if (initial.exitCode === null) await terminateProcessTreeAsync(initial);
        if (recoveryChild?.exitCode === null) await terminateProcessTreeAsync(recoveryChild);
        await removeFixture(fixture);
      }
    }
  }
});

test("DATA-01B missing journal after partial live publication fails closed", { timeout: 120_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-data01b-missing-journal-");
  const child = spawnManaged(process.execPath, [
    "tests/fixtures/managed-restore-crash-child.mjs", "crash", fixture, "live:after-write",
  ], { cwd: projectRoot });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  try {
    await waitFor(() => stdout.includes("RESTORE_BARRIER:live:after-write"), { timeoutMs: 30_000, label: "partial live publication" });
    assert.equal((await terminateProcessTreeAsync(child)).exitCode, 0);
    await fs.unlink(path.join(fixture, ".rainydays-restore", "active.json"));
    const before = await hashTree(fixture);
    const recovery = await runProcess(process.execPath, [
      "tests/fixtures/managed-restore-crash-child.mjs", "recover", fixture, "A",
    ], { cwd: projectRoot, timeoutMs: 30_000 });
    assert.notEqual(recovery.code, 0);
    assert.match(recovery.stderr, /transaction exists without an authenticated journal/u);
    assert.equal(await hashTree(fixture), before);
  } finally {
    if (child.exitCode === null) await terminateProcessTreeAsync(child);
    await removeFixture(fixture);
  }
});

test("DATA-01B COMMITTED recovery rejects managed content substitution without further mutation", { timeout: 120_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-data01b-content-substitution-");
  const child = spawnManaged(process.execPath, [
    "tests/fixtures/managed-restore-crash-child.mjs", "crash", fixture, "journal:committed-published",
  ], { cwd: projectRoot });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  try {
    await waitFor(() => stdout.includes("RESTORE_BARRIER:journal:committed-published"), { timeoutMs: 30_000, label: "committed content substitution" });
    assert.equal((await terminateProcessTreeAsync(child)).exitCode, 0);
    await fs.writeFile(path.join(fixture, "config.json"), JSON.stringify({ substituted: true }));
    const before = await hashTree(fixture);
    const recovery = await runProcess(process.execPath, [
      "tests/fixtures/managed-restore-crash-child.mjs", "recover", fixture, "B",
    ], { cwd: projectRoot, timeoutMs: 30_000 });
    assert.notEqual(recovery.code, 0);
    assert.match(recovery.stderr, /live state differs/u);
    assert.equal(await hashTree(fixture), before);
  } finally {
    if (child.exitCode === null) await terminateProcessTreeAsync(child);
    await removeFixture(fixture);
  }
});

test("DATA-01B COMMITTED recovery rejects an injected allowlisted file outside the exact set", { timeout: 120_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-data01b-exact-injection-");
  const child = spawnManaged(process.execPath, [
    "tests/fixtures/managed-restore-crash-child.mjs", "crash", fixture, "journal:committed-published",
  ], { cwd: projectRoot });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  try {
    await waitFor(() => stdout.includes("RESTORE_BARRIER:journal:committed-published"), { timeoutMs: 30_000, label: "committed exact set" });
    assert.equal((await terminateProcessTreeAsync(child)).exitCode, 0);
    await fs.writeFile(path.join(fixture, "data", "skills", "injected.md"), "injected");
    const before = await hashTree(fixture);
    const recovery = await runProcess(process.execPath, [
      "tests/fixtures/managed-restore-crash-child.mjs", "recover", fixture, "B",
    ], { cwd: projectRoot, timeoutMs: 30_000 });
    assert.notEqual(recovery.code, 0);
    assert.match(recovery.stderr, /exact-set inventory differs/u);
    assert.equal(await hashTree(fixture), before);
  } finally {
    if (child.exitCode === null) await terminateProcessTreeAsync(child);
    await removeFixture(fixture);
  }
});

test("DATA-01B pinned PathPolicy rejects an ancestor junction without touching its target", { timeout: 120_000, skip: process.platform !== "win32" }, async () => {
  const fixture = await makeTempDir("mini-lux-data01b-junction-");
  const outside = await makeTempDir("mini-lux-data01b-junction-outside-");
  const child = spawnManaged(process.execPath, [
    "tests/fixtures/managed-restore-crash-child.mjs", "crash", fixture, "journal:prepared-published",
  ], { cwd: projectRoot });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  const data = path.join(fixture, "data");
  const originalData = path.join(fixture, "data-original");
  try {
    await waitFor(() => stdout.includes("RESTORE_BARRIER:journal:prepared-published"), { timeoutMs: 30_000, label: "prepared junction attack" });
    assert.equal((await terminateProcessTreeAsync(child)).exitCode, 0);
    await fs.writeFile(path.join(outside, "sentinel.bin"), "outside-unchanged");
    await fs.mkdir(path.join(outside, "personas"));
    await fs.mkdir(path.join(outside, "skills"));
    await fs.rename(data, originalData);
    await fs.symlink(outside, data, "junction");
    const outsideBefore = await hashTree(outside);
    const recovery = await runProcess(process.execPath, [
      "tests/fixtures/managed-restore-crash-child.mjs", "recover", fixture, "A",
    ], { cwd: projectRoot, timeoutMs: 30_000 });
    assert.notEqual(recovery.code, 0);
    assert.match(recovery.stderr, /PATH_REDIRECT_DENIED|PATH_ROOT_DENIED|PATH_OPERATION_DENIED|directory identity is invalid/u);
    assert.equal(await hashTree(outside), outsideBefore);
    assert.equal(await fs.access(path.join(fixture, ".rainydays-restore", "active.json")).then(() => true, () => false), true);
    await fs.unlink(data);
    await fs.rename(originalData, data);
    const completed = await runProcess(process.execPath, [
      "tests/fixtures/managed-restore-crash-child.mjs", "recover", fixture, "A",
    ], { cwd: projectRoot, timeoutMs: 30_000 });
    assert.equal(completed.code, 0, completed.stderr);
  } finally {
    if (child.exitCode === null) await terminateProcessTreeAsync(child);
    await fs.unlink(data).catch(() => undefined);
    await fs.rename(originalData, data).catch(() => undefined);
    await removeFixture(fixture);
    await removeFixture(outside);
  }
});

test("DATA-01B restore failure matrix rejects malformed input and survives cleanup faults", { timeout: 120_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-data01b-failure-matrix-");
  try {
    const result = await runProcess(process.execPath, [
      "tests/fixtures/managed-restore-crash-child.mjs", "failure-matrix", fixture, "unused",
    ], { cwd: projectRoot, timeoutMs: 90_000 });
    assert.equal(result.code, 0, `failure matrix failed\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
      invalidCalls: 20,
      invalidWrappedKeys: 3,
      prePreparedCleanup: true,
      pendingDenied: true,
      aggregateRollbackFailure: true,
      cleanupPendingRecovered: true,
      invalidStageCleanupDenied: true,
      zeroSidecarDenied: true,
      publicationLeaseDenied: true,
      idempotentLockRelease: true,
    });
  } finally {
    await removeFixture(fixture);
  }
});

test("DATA-01B PREPARED recovery rejects incomplete or injected stage sets without mutation", { timeout: 120_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-data01b-stage-matrix-");
  const child = spawnManaged(process.execPath, [
    "tests/fixtures/managed-restore-crash-child.mjs", "crash", fixture, "journal:prepared-published",
  ], { cwd: projectRoot });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  try {
    await waitFor(() => stdout.includes("RESTORE_BARRIER:journal:prepared-published"), { timeoutMs: 30_000, label: "prepared stage matrix" });
    assert.equal((await terminateProcessTreeAsync(child)).exitCode, 0);
    const result = await runProcess(process.execPath, [
      "tests/fixtures/managed-restore-crash-child.mjs", "prepared-stage-matrix", fixture, "unused",
    ], { cwd: projectRoot, timeoutMs: 90_000 });
    assert.equal(result.code, 0, `prepared stage matrix failed\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
      preparedStageVariants: 5,
      zeroMutationRejections: true,
      validRecoveryAfterRejection: true,
    });
  } finally {
    if (child.exitCode === null) await terminateProcessTreeAsync(child);
    await removeFixture(fixture);
  }
});

test("DATA-01B strict journal parser rejects malformed state before valid recovery", { timeout: 120_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-data01b-journal-matrix-");
  const child = spawnManaged(process.execPath, [
    "tests/fixtures/managed-restore-crash-child.mjs", "crash", fixture, "journal:prepared-published",
  ], { cwd: projectRoot });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  try {
    await waitFor(() => stdout.includes("RESTORE_BARRIER:journal:prepared-published"), { timeoutMs: 30_000, label: "journal matrix fixture" });
    assert.equal((await terminateProcessTreeAsync(child)).exitCode, 0);
    const result = await runProcess(process.execPath, [
      "tests/fixtures/managed-restore-crash-child.mjs", "journal-matrix", fixture, "unused",
    ], { cwd: projectRoot, timeoutMs: 90_000 });
    assert.equal(result.code, 0, `journal matrix failed\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1)), {
      journalVariants: 35,
      invalidUnwrappedKeys: 3,
      missingProtectorDenied: true,
      corruptStageDenied: true,
      linkedStageDenied: process.platform === "win32",
      invalidOrphanDenied: true,
      validRecoveryAfterRejection: true,
    });
  } finally {
    if (child.exitCode === null) await terminateProcessTreeAsync(child);
    await removeFixture(fixture);
  }
});

test("DATA-01B authenticated restore journal tamper blocks startup without further mutation", { timeout: 120_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-data01b-tamper-");
  const child = spawnManaged(process.execPath, [
    "tests/fixtures/managed-restore-crash-child.mjs",
    "crash",
    fixture,
    "journal:prepared-published",
  ], { cwd: projectRoot });
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  try {
    await waitFor(() => stdout.includes("RESTORE_BARRIER:journal:prepared-published"), {
      timeoutMs: 30_000,
      label: "prepared journal for tamper",
    });
    const killed = await terminateProcessTreeAsync(child);
    assert.equal(killed.exitCode, 0);
    assert.equal(killed.childExited, true);
    const journalPath = path.join(fixture, ".rainydays-restore", "active.json");
    const journal = JSON.parse(await fs.readFile(journalPath, "utf8"));
    journal.mac = `${journal.mac.slice(0, -1)}${journal.mac.endsWith("0") ? "1" : "0"}`;
    await fs.writeFile(journalPath, JSON.stringify(journal));
    const before = await hashTree(fixture);
    const recovery = await runProcess(process.execPath, [
      "tests/fixtures/managed-restore-crash-child.mjs",
      "recover",
      fixture,
      "A",
    ], { cwd: projectRoot, timeoutMs: 30_000 });
    assert.notEqual(recovery.code, 0);
    assert.match(recovery.stderr, /journal authentication failed/u);
    assert.equal(await hashTree(fixture), before);
  } finally {
    if (child.exitCode === null) await terminateProcessTreeAsync(child);
    await removeFixture(fixture);
  }
});
