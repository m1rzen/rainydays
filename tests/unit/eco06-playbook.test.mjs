import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "eco06-unit-"));
process.env.RAINYDAYS_USER_DATA_DIR = root;
const playbook = await import("../../src/playbook.ts");
after(async () => { await rm(root, { recursive: true, force: true }); });

const signal = new AbortController().signal;
const invocation = {
  signal,
  deriveChild: () => ({ runId: "legacy-child" }),
  finishChild: () => undefined,
  deriveDetachedChild: (_request, runId) => ({ runId }),
  finishDetachedChild: async () => undefined,
  createDetachedNetwork: () => ({ fetch: globalThis.fetch }),
  getToolDefinitions: () => [],
  executeDetachedTool: async () => "unused",
};
const llm = { chat: async () => ({ content: "unused" }) };
const persona = { systemPrompt: "test" };

async function waitFor(playbookId, expected, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await playbook.getPlaybookStatus(playbookId);
    if (status.status === expected) return status;
    await new Promise(resolve => setTimeout(resolve, 15));
  }
  assert.fail(`Playbook ${playbookId} did not reach ${expected}`);
}

test("ECO-06 creates and archives a managed npm ESM Playbook project", async () => {
  const created = await playbook.createPlaybook({ name: "Lifecycle", description: "archive fixture", script: "lux.done({ ok: true });" });
  assert.equal(created.playbookId, "lifecycle");
  assert.deepEqual((await playbook.listPlaybooks()).map(item => item.playbookId), ["lifecycle"]);
  const archived = await playbook.archivePlaybook("lifecycle");
  assert.equal(archived.archived, true);
  assert.deepEqual(await playbook.listPlaybooks(), []);
  assert.deepEqual((await playbook.listPlaybooks({ archivedOnly: true })).map(item => item.playbookId), ["lifecycle"]);
  assert.equal((await playbook.unarchivePlaybook("lifecycle")).archived, false);
});

test("ECO-06 reserves the singleton before asynchronous project loading", async () => {
  const race = await playbook.createPlaybook({ name: "Race", script: "await new Promise(resolve => setTimeout(resolve, 100)); lux.done({ ok: true });" });
  const attempts = await Promise.allSettled([
    playbook.startPlaybook({ playbookId: race.playbookId, llm, persona, invocation }),
    playbook.startPlaybook({ playbookId: race.playbookId, llm, persona, invocation }),
  ]);
  assert.equal(attempts.filter(result => result.status === "fulfilled").length, 1);
  const rejected = attempts.find(result => result.status === "rejected");
  assert.match(String(rejected.reason), /already running/u);
  await playbook.abortPlaybook(race.playbookId, "race stop");
  await playbook.deletePlaybook(race.playbookId);
});

test("ECO-06 enforces singleton and denies archive/delete while active", async () => {
  const slow = await playbook.createPlaybook({ name: "Slow", script: "await new Promise(resolve => setTimeout(resolve, 500)); lux.done({ ok: true });" });
  const started = await playbook.startPlaybook({ playbookId: slow.playbookId, llm, persona, invocation });
  assert.equal(started.status, "running");
  await assert.rejects(() => playbook.startPlaybook({ playbookId: slow.playbookId, llm, persona, invocation }), /already running/u);
  await assert.rejects(() => playbook.archivePlaybook(slow.playbookId), /running/u);
  await assert.rejects(() => playbook.deletePlaybook(slow.playbookId), /running/u);
  assert.equal((await playbook.abortPlaybook(slow.playbookId, "unit stop")).status, "aborted");
  await waitFor(slow.playbookId, "aborted");
  await playbook.deletePlaybook(slow.playbookId);
  await playbook.deletePlaybook("lifecycle");
  assert.deepEqual(await playbook.listPlaybooks({ includeArchived: true }), []);
});
