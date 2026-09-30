import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";

const root = await mkdtemp(path.join(os.tmpdir(), "eco06-integration-"));
process.env.RAINYDAYS_USER_DATA_DIR = root;
const playbook = await import("../../src/playbook.ts");
after(async () => { await rm(root, { recursive: true, force: true }); });

async function waitUntil(playbookId, terminal = new Set(["completed", "failed", "aborted"]), timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await playbook.getPlaybookStatus(playbookId);
    if (terminal.has(status.status)) return status;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Playbook ${playbookId} did not settle`);
}

function invocationFixture(overrides = {}) {
  const finished = [];
  const invocation = {
    signal: new AbortController().signal,
    deriveChild: () => ({ runId: "legacy" }),
    finishChild: () => undefined,
    deriveDetachedChild: (_request, runId) => ({ runId }),
    finishDetachedChild: async child => { finished.push(child.runId); },
    createDetachedNetwork: () => ({ fetch: globalThis.fetch }),
    getToolDefinitions: () => [],
    executeDetachedTool: async () => "tool-result",
    ...overrides,
  };
  return { invocation, finished };
}

test("ECO-06 executes lux.done with agent/parallel/pipeline and persists logs/artifacts/state", async () => {
  const script = `
await lux.log("started", lux.playbookId);
const first = await agent("first task");
const many = await parallel([() => Promise.resolve("local"), "second task"]);
const piped = await pipeline([value => value + "-one", value => value + "-two"], "seed");
await lux.persist("checkpoint", { first, many, piped });
const restored = await lux.load("checkpoint");
await lux.artifact("summary", restored);
lux.done(restored);
`;
  const project = await playbook.createPlaybook({ name: "Orchestration", description: "integration fixture", script });
  const { invocation, finished } = invocationFixture();
  const llm = {
    chat: async messages => ({ content: `agent:${messages.at(-1).content}`, tool_calls: [] }),
  };
  const started = await playbook.startPlaybook({ playbookId: project.playbookId, llm, persona: { systemPrompt: "fixture" }, invocation });
  assert.equal(started.status, "running");
  const status = await waitUntil(project.playbookId);
  assert.equal(status.status, "completed", status.error);
  assert.equal(status.result.first, "agent:first task");
  assert.deepEqual(status.result.many, ["local", "agent:second task"]);
  assert.equal(status.result.piped, "seed-one-two");
  assert.match(status.logTail.join("\n"), /started orchestration/u);
  assert.equal(status.artifacts.length, 1);
  assert.equal(status.artifacts[0].name, "summary");
  assert.match(status.artifacts[0].preview, /seed-one-two/u);
  assert.equal(status.childSessionIds.length, 2);
  assert.equal(finished.length, 2);

  const persisted = await playbook.getPlaybookStatus(project.playbookId);
  assert.equal(persisted.status, "completed");
  const latest = JSON.parse(await readFile(path.join(root, "playbooks", project.playbookId, "runs", "latest.json"), "utf8"));
  assert.equal(latest.status, "completed");
  await playbook.deletePlaybook(project.playbookId);
});

test("ECO-06 abort propagates to active agent child and persists aborted status", async () => {
  const project = await playbook.createPlaybook({ name: "Abort Child", script: "const value = await agent('wait forever'); lux.done(value);" });
  let childEntered;
  const entered = new Promise(resolve => { childEntered = resolve; });
  const { invocation, finished } = invocationFixture();
  const llm = {
    chat: async (_messages, _tools, signal) => {
      childEntered();
      await new Promise((resolve, reject) => {
        signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
      return { content: "unreachable" };
    },
  };
  await playbook.startPlaybook({ playbookId: project.playbookId, llm, persona: { systemPrompt: "fixture" }, invocation });
  await entered;
  await playbook.abortPlaybook(project.playbookId, "integration stop");
  const status = await waitUntil(project.playbookId);
  assert.equal(status.status, "aborted");
  assert.match(status.reason, /integration stop/u);
  assert.equal(finished.length, 1);
  await playbook.deletePlaybook(project.playbookId);
});
