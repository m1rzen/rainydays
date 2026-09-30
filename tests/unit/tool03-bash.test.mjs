import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "tool03-bash-"));
const { WorkerRegistry } = await import("../../src/worker.ts");
const registry = new WorkerRegistry();
after(async () => { await registry.dispose(); await rm(root, { recursive: true, force: true }); });
const shell = process.platform === "win32" ? "powershell" : "bash";
const print = process.platform === "win32" ? "Write-Output" : "printf";

test("TOOL-03 aligns one-shot and persistent bash contracts on the selected Worker", async () => {
  await registry.connect({ workerId: "tool03-remote", name: "TOOL-03 fixture", transport: "stdio", cwd: root, accessCode: "tool03-access" });
  await registry.select("session-tool03", "tool03-remote");
  const one = await registry.execute("session-tool03", "bash", { command: `${print} one-shot-ok`, shell, cwd: root, timeout: 10_000 });
  assert.equal(one.exitCode, 0);
  assert.match(one.stdout, /one-shot-ok/u);
  assert.equal(one.cwd, root);

  const started = await registry.execute("session-tool03", "bash", { command: `${print} persistent-ok`, shell, cwd: root, session: "dev", description: "fixture" });
  assert.equal(started.status, "running");
  await new Promise(resolve => setTimeout(resolve, 300));
  const output = await registry.execute("session-tool03", "bash_output", { session: "dev", tail: 20 });
  assert.match(output.output, /persistent-ok/u);
  const listed = await registry.execute("session-tool03", "bash_list", {});
  assert.equal(listed.length, 1);
  assert.equal(listed[0].session, "dev");
  assert.equal((await registry.execute("session-tool03", "bash_kill", { session: "dev" })).status, "killed");
});

test("ECO-03 selection is Session-scoped and disconnected remote targets fail closed", async () => {
  const listed = await registry.list("session-tool03");
  assert.equal(listed.find(worker => worker.workerId === "tool03-remote").selected, true);
  assert.equal(listed.find(worker => worker.workerId === "local").selected, false);
  assert.equal((await registry.status("session-other")).workerId, "local");
  await registry.disconnect("tool03-remote");
  await assert.rejects(() => registry.execute("session-tool03", "status", {}), /Selected Worker is unavailable/u);
});
