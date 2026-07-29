import assert from "node:assert/strict";
import { cp, mkdir, symlink } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { collectSourceFiles, toPosix } from "../../scripts/build-inputs.mjs";
import {
  formalArtifactSnapshot,
  makeTempDir,
  projectRoot,
  removeFixture,
  runProcess,
} from "../helpers.mjs";

function parseJsonOutput(stdout) {
  const start = stdout.indexOf("{");
  assert(start >= 0, "GOV-02 JSON output missing");
  return JSON.parse(stdout.slice(start));
}

async function copyRegressionSandbox(root) {
  for (const source of await collectSourceFiles(projectRoot)) {
    const relative = toPosix(path.relative(projectRoot, source));
    const target = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await cp(source, target);
  }
  await cp(path.join(projectRoot, "dist"), path.join(root, "dist"), { recursive: true });
  for (const file of ["build-info.json", "dist-integrity.json"]) await cp(path.join(projectRoot, file), path.join(root, file));
  await symlink(path.join(projectRoot, "node_modules"), path.join(root, "node_modules"), "junction");
}

test("GOV-02 version, persistence, Session and Link integration matrix is side-effect free", async () => {
  const before = await formalArtifactSnapshot();
  const sandbox = await makeTempDir("mini-lux-gov03-integration-");
  try {
    await copyRegressionSandbox(sandbox);
    const result = await runProcess(process.execPath, ["scripts/test-version-model.mjs"], {
      cwd: sandbox,
      env: { ...process.env, MINI_LUX_TEST_RUNTIME_ROOT: projectRoot },
      timeoutMs: 240_000,
    });
    assert.equal(result.code, 0, result.stderr);
    const payload = parseJsonOutput(result.stdout);
    assert.deepEqual({ passed: payload.passed, failed: payload.failed }, { passed: 27, failed: 0 });
    assert(payload.scenarios.some((entry) => entry.name === "future WAL database rejected byte-identically"));
    assert(payload.scenarios.some((entry) => entry.name === "Session Export current, legacy and rejection matrix"));
    assert(payload.scenarios.some((entry) => entry.name === "legitimate memo and session writes survive database restart"));
  } finally {
    await removeFixture(sandbox, ["node_modules"]);
  }
  assert.deepEqual(await formalArtifactSnapshot(), before);
});
