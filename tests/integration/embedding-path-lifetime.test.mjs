import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeTempDir, projectRoot, removeFixture, runProcess } from "../helpers.mjs";

const childScript = path.join(projectRoot, "tests", "fixtures", "model-tree-child.mjs");

async function runTreeScenario(scenario) {
  const fixture = await makeTempDir(`mini-lux-model-tree-${scenario}-`);
  const appRoot = path.join(fixture, "app");
  const userDataRoot = path.join(fixture, "user-data");
  const outsideRoot = path.join(fixture, "outside");
  await fs.mkdir(appRoot, { recursive: true });
  try {
    const result = await runProcess(process.execPath, [childScript, scenario, appRoot, userDataRoot, outsideRoot], {
      cwd: projectRoot,
      timeoutMs: 60_000,
      env: { ...process.env },
    });
    assert.equal(result.signal, null, `${scenario} child ended by signal`);
    assert.equal(result.code, 0, `${scenario} child failed\nstdout=${result.stdout}\nstderr=${result.stderr}`);
    const line = result.stdout.trim().split(/\r?\n/u).at(-1);
    return JSON.parse(line);
  } finally {
    await removeFixture(fixture);
  }
}

test("SEC-02 model tree lease binds every descendant identity and content for its lifetime", async () => {
  const stable = await runTreeScenario("stable");
  assert.deepEqual(stable, { scenario: "stable", code: null, fileCount: 1, cleanClose: true });

  const content = await runTreeScenario("content-change");
  assert.equal(content.code, "PATH_IDENTITY_CHANGED");
  assert.equal(content.cleanClose, true);

  const added = await runTreeScenario("entry-added");
  assert.equal(added.code, "PATH_IDENTITY_CHANGED");
  assert.equal(added.cleanClose, true);
});

test("SEC-02 model tree lease rejects descendant redirects before third-party model loading", async () => {
  const redirected = await runTreeScenario("redirect");
  assert.deepEqual(redirected, {
    scenario: "redirect",
    code: "PATH_REDIRECT_DENIED",
    externalUnchanged: true,
  });
});

test("SEC-02 bootstrap path store exercises pinned app, public, runtime, database and temporary lifetimes", async () => {
  assert.deepEqual(await runTreeScenario("coverage"), {
    scenario: "coverage",
    bootstrapSurfaceCovered: true,
    runtimeLeaseCount: 9,
  });
});

test("SEC-02 real Transformers pipeline performs local inference under the model tree lifetime lease", { timeout: 120_000 }, async () => {
  const originalFetch = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => {
    networkCalls += 1;
    throw new Error("network access denied by SEC-02 embedding canary");
  };
  const embedding = await import("../../dist/embedding.js");
  const bootstrap = await import("../../dist/bootstrap-path-store.js");
  try {
    const vector = await embedding.embed("路径策略运行期证据", true);
    assert(vector instanceof Float32Array);
    assert.equal(vector.length, 384);
    const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
    assert(Math.abs(norm - 1) < 0.001, `embedding norm differs: ${norm}`);
    assert.equal(networkCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    await embedding.closeEmbedding();
    await bootstrap.getBootstrapPathStore().close();
  }
});
