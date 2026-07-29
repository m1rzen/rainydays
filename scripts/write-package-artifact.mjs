import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { atomicWriteJson, runProcess, sha256File } from "../tests/helpers.mjs";
import { expectedInstallerName, fileSha256 } from "./package-artifact-lib.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function reportPath(argv) {
  const index = argv.indexOf("--report");
  if (index < 0) return path.join(projectRoot, "test-results", "package-artifact.json");
  assert(argv[index + 1], "--report requires a path");
  assert.equal(argv.length, 2, "unknown package artifact arguments");
  return path.resolve(argv[index + 1]);
}

async function main() {
  const check = await runProcess(process.execPath, ["scripts/generate-build-info.mjs", "--check"], { timeoutMs: 60_000 });
  assert.equal(check.code, 0, check.stderr);
  const buildInfo = JSON.parse(await readFile(path.join(projectRoot, "build-info.json"), "utf8"));
  const filename = expectedInstallerName(buildInfo);
  const installer = path.join(projectRoot, "release", filename);
  const info = await stat(installer);
  assert(info.isFile() && info.size > 0, "exact current installer is missing");
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    build: {
      appVersion: buildInfo.appVersion,
      buildId: buildInfo.buildId,
      sourceDigest: buildInfo.sourceDigest,
      buildInfoSha256: await sha256File(path.join(projectRoot, "build-info.json")),
      executionIsolation: buildInfo.versions?.executionIsolation,
    },
    artifact: { filename, bytes: info.size, sha256: await fileSha256(installer) },
  };
  const output = reportPath(process.argv.slice(2));
  await atomicWriteJson(output, manifest);
  console.log(JSON.stringify({ output: path.relative(projectRoot, output).replaceAll("\\", "/"), ...manifest.artifact }));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
});
