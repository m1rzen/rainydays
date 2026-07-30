import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { validateModelManifest } from "../../scripts/bootstrap-models.mjs";
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

test("model bootstrap manifest pins the complete immutable payload", async () => {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "models-manifest.json"), "utf8"));
  assert.equal(validateModelManifest(manifest), manifest);
  const mutableRevision = structuredClone(manifest);
  mutableRevision.revision = "main";
  assert.throws(() => validateModelManifest(mutableRevision), /revision is invalid/);
  const changedUrl = structuredClone(manifest);
  changedUrl.files[0].url = "https://example.com/config.json";
  assert.throws(() => validateModelManifest(changedUrl), /URL differs/);

  const provenance = await readFile(path.join(projectRoot, "scripts", "gov04", "provenance.mjs"), "utf8");
  const checkout = provenance.indexOf('git(workspace, ["checkout"');
  const bootstrap = provenance.indexOf('runProcess(process.execPath, ["scripts/bootstrap-models.mjs"]');
  const identity = provenance.indexOf("computeCandidateIdentity(workspace)", bootstrap);
  assert(checkout >= 0 && checkout < bootstrap && bootstrap < identity);

  const toolchain = await readFile(path.join(projectRoot, "scripts", "gov04", "ensure-native-toolchain.ps1"), "utf8");
  assert.match(toolchain, /Microsoft\.VisualStudio\.Component\.VC\.14\.43\.17\.13\.x86\.x64/);
  assert.match(toolchain, /\[17\.0,18\.0\)/);
  assert.match(toolchain, /17\.13\.35825\.156/);
  assert.match(toolchain, /https:\/\/download\.visualstudio\.microsoft\.com\/download\/pr\/84955a63-15ca-4f52-94af-14ea55b50424\/e26a4f237c908739caa2ac36e2d90a51d7e3f71746e615207b7db449f82e3c4e\/vs_BuildTools\.exe/);
  assert.match(toolchain, /e26a4f237c908739caa2ac36e2d90a51d7e3f71746e615207b7db449f82e3c4e/);
  assert.match(toolchain, /Microsoft\.VisualStudio\.Product\.BuildTools/);
  assert.match(toolchain, /Microsoft\.VisualStudio\.Product\.Community/);
  assert.match(toolchain, /19\.43\.34808\.0/);
  assert.match(toolchain, /10\.0\.22621\.0/);
  assert.match(toolchain, /ExitCode -ne 0/);
  assert.match(toolchain, /AddMinutes\(10\)/);
  assert.match(toolchain, /instances\.Count -gt 1/);
  assert.match(toolchain, /installation did not become ready before the deadline/);

  const electronHeaders = await readFile(path.join(projectRoot, "scripts", "gov04", "bootstrap-electron-headers.mjs"), "utf8");
  assert.match(electronHeaders, /https:\/\/electronjs\.org\/headers\/v43\.1\.1\/node-v43\.1\.1-headers\.tar\.gz/);
  assert.match(electronHeaders, /b1112989ad4c4807a6bf59bfc96ce8d0f0b16962efe9818fa768e5908cc24d21/);
  assert.match(electronHeaders, /https:\/\/electronjs\.org\/headers\/v43\.1\.1\/win-x64\/node\.lib/);
  assert.match(electronHeaders, /757cde97e0dd2f01aed47326440429a1012624892e6e4cbebf59dac964ac8e6d/);
  assert.match(electronHeaders, /956c2a3dda4622f75093a7adf5e19bbc09d760e166afb092e9d0e62be9e8873d/);
  assert(!electronHeaders.includes("node-gyp"));

  const nativeBuild = await readFile(path.join(projectRoot, "scripts", "build-sec03-native.mjs"), "utf8");
  assert.match(nativeBuild, /installationVersion !== "17\.13\.35825\.156"/);
  assert.match(nativeBuild, /versionProbe\.status !== 0/);
  assert.match(nativeBuild, /electronHeaders/);
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
    assert.match(text, /run: npm ci --no-audit --no-fund/);
    assert.match(text, /run: npm run models:bootstrap/);
    assert.match(text, /run: \.\\scripts\\gov04\\ensure-native-toolchain\.ps1/);
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
