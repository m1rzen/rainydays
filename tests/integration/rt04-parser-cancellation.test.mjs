import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { Worker } from "node:worker_threads";
import { makeTempDir, removeFixture, waitFor } from "../helpers.mjs";

test("RT-04 document parser cancellation terminates its Worker before settlement", { timeout: 30_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-rt04-parser-");
  const appRoot = path.join(fixture, "app");
  const userData = path.join(fixture, "user-data");
  const dataDir = path.join(userData, "data");
  const marker = path.join(fixture, "worker-heartbeat.txt");
  await Promise.all([
    path.join(appRoot, "dist"),
    path.join(appRoot, "public"),
    path.join(appRoot, "models"),
    path.join(appRoot, "personas"),
    path.join(appRoot, "skills"),
    dataDir,
  ].map(directory => mkdir(directory, { recursive: true })));
  await writeFile(path.join(appRoot, "package.json"), JSON.stringify({ type: "module" }));
  const workerSource = [
    'import { appendFileSync, writeFileSync } from "node:fs";',
    `const marker = ${JSON.stringify(marker)};`,
    'writeFileSync(marker, "started\\n");',
    'setInterval(() => appendFileSync(marker, "tick\\n"), 20);',
  ].join("\n");
  await writeFile(path.join(appRoot, "dist", "document-parser-worker.js"), workerSource);
  Object.assign(process.env, {
    RAINYDAYS_APP_ROOT: appRoot,
    RAINYDAYS_USER_DATA_DIR: userData,
    RAINYDAYS_DATA_DIR: dataDir,
    RAINYDAYS_PUBLIC_DIR: path.join(appRoot, "public"),
    RAINYDAYS_MODELS_DIR: path.join(appRoot, "models"),
    RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(appRoot, "personas"),
    RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(appRoot, "skills"),
  });

  const [
    { parseDocumentIsolated },
    { issueResourceOwner, retireResourceOwner },
    { RunCancellationError },
    { getBootstrapPathStore },
  ] = await Promise.all([
    import("../../dist/document-parser.js"),
    import("../../dist/resource-owner.js"),
    import("../../dist/run-cancellation.js"),
    import("../../dist/bootstrap-path-store.js"),
  ]);
  const owner = issueResourceOwner({
    authorityId: "rt04-parser-authority",
    authorityEpoch: 1,
    sessionId: "rt04-parser-session",
    principal: "agent",
    rootIds: [],
  });
  const controller = new AbortController();
  try {
    const running = parseDocumentIsolated("held.xlsx", Buffer.from("fixture"), owner, controller.signal);
    await waitFor(
      async () => (await readFile(marker, "utf8").catch(() => "")).includes("started"),
      { timeoutMs: 10_000, label: "parser Worker heartbeat" },
    );
    const reason = new RunCancellationError("RUN_CANCELLED", "parser cancelled");
    controller.abort(reason);
    await assert.rejects(() => running, error => error === reason);
    const afterSettlement = await readFile(marker, "utf8");
    await new Promise(resolve => setTimeout(resolve, 120));
    assert.equal(await readFile(marker, "utf8"), afterSettlement, "Worker heartbeat continued after parser cancellation settled");

    await writeFile(marker, "");
    const originalTerminate = Worker.prototype.terminate;
    Worker.prototype.terminate = async function terminateWithReportedFailure() {
      await originalTerminate.call(this);
      throw new Error("synthetic Worker termination failure");
    };
    try {
      const cleanupController = new AbortController();
      const cleanupRunning = parseDocumentIsolated("held-cleanup.xlsx", Buffer.from("fixture"), owner, cleanupController.signal);
      await waitFor(
        async () => (await readFile(marker, "utf8").catch(() => "")).includes("started"),
        { timeoutMs: 10_000, label: "parser cleanup-failure Worker heartbeat" },
      );
      const cleanupReason = new RunCancellationError("RUN_CANCELLED", "parser cleanup cancellation");
      cleanupController.abort(cleanupReason);
      await assert.rejects(() => cleanupRunning, error => {
        assert.equal(error?.code, "RUN_SETTLEMENT_FAILED");
        assert(error instanceof AggregateError);
        assert.equal(error.errors[0], cleanupReason);
        assert(error.errors.some(candidate => /synthetic Worker termination failure/u.test(String(candidate))));
        return true;
      });
    } finally {
      Worker.prototype.terminate = originalTerminate;
    }
    await retireResourceOwner(owner);
  } finally {
    await getBootstrapPathStore().close().catch(() => undefined);
    await removeFixture(fixture);
  }
});
