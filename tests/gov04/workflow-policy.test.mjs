import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { gov04StepIds } from "../../scripts/gov04/report-schema.mjs";
import { projectRoot } from "../helpers.mjs";

const workflowPaths = [
  ".github/workflows/gov-04-merge.yml",
  ".github/workflows/gov-04-trusted-release.yml",
];

test("GOV-04 test manifest binds the frozen 16-step state machine", async () => {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "tests", "manifests", "gov-04.json"), "utf8"));
  assert.deepEqual(Object.keys(manifest).sort(), ["schemaVersion", "stepOrder", "taskId", "testFiles"].sort());
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.taskId, "GOV-04");
  assert.deepEqual(manifest.stepOrder, gov04StepIds);
  assert.deepEqual(manifest.testFiles, ["tests/gov04/report-schema.test.mjs", "tests/gov04/workflow-policy.test.mjs"]);
});

test("GitHub Actions are immutable, read-only and never use pull_request_target", async () => {
  for (const relative of workflowPaths) {
    const text = await readFile(path.join(projectRoot, ...relative.split("/")), "utf8");
    assert(!text.includes("pull_request_target"));
    assert.match(text, /permissions:\s*\n\s+contents: read/);
    assert(!/contents:\s*write/.test(text));
    const uses = [...text.matchAll(/^\s*uses:\s*([^\s]+)$/gm)].map((match) => match[1]);
    assert(uses.length >= 3);
    for (const identity of uses) assert.match(identity, /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+@[a-f0-9]{40}$/);
    assert(!/@v\d+(?:\s|$)/m.test(text));
    assert.match(text, /fetch-depth: 0/);
    assert.match(text, /persist-credentials: false/);
    assert.match(text, /if-no-files-found: error/);
  }
});

test("merge and trusted artifact retention/trust domains stay separated", async () => {
  const merge = await readFile(path.join(projectRoot, ".github", "workflows", "gov-04-merge.yml"), "utf8");
  const release = await readFile(path.join(projectRoot, ".github", "workflows", "gov-04-trusted-release.yml"), "utf8");
  assert.match(merge, /UNSIGNED-UNTRUSTED-DO-NOT-DISTRIBUTE/);
  assert.match(merge, /retention-days: 7/);
  assert(!merge.includes("environment: mini-lux-trusted-release"));
  assert.match(release, /environment: mini-lux-trusted-release/);
  assert.match(release, /RAINYDAYS_TRUSTED_ENVIRONMENT: mini-lux-trusted-release/);
  assert.match(release, /cancel-in-progress: false/);
  assert.match(release, /retention-days: 90/);
  assert(!release.includes("pull_request:"));
});

test("trusted signer and hosted repository policies remain explicitly unconfigured", async () => {
  const signers = JSON.parse(await readFile(path.join(projectRoot, "parity", "policies", "gov-04-signer-allowlist.json"), "utf8"));
  const policy = JSON.parse(await readFile(path.join(projectRoot, "parity", "policies", "gov-04-policy.json"), "utf8"));
  assert.equal(signers.state, "unconfigured");
  assert.deepEqual(signers.allowedSigners, []);
  assert.equal(policy.trustedRelease.state, "unconfigured");
  assert.equal(policy.trustedRelease.repository, null);
  assert.equal(policy.trustedRelease.provider, "github-actions");
  assert.equal(policy.trustedRelease.requireProtectedRef, true);
});
