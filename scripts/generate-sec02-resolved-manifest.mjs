import assert from "node:assert/strict";
import { lstat, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  buildSec02ResolvedManifest,
  currentResolvedManifestPath,
  projectRoot,
  serializeResolvedManifest,
  validateSec02ResolvedManifest,
} from "./sec02-governance.mjs";

async function assertSafeOutput(filePath) {
  const parent = path.dirname(filePath);
  const parentInfo = await lstat(parent);
  assert(parentInfo.isDirectory() && !parentInfo.isSymbolicLink(), "resolved manifest parent must be a real directory");
  const relative = path.relative(await realpath(projectRoot), await realpath(parent));
  assert(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "resolved manifest parent escapes project root");
  try {
    const info = await lstat(filePath);
    assert(info.isFile() && !info.isSymbolicLink(), "resolved manifest output must be a regular file");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function generateSec02ResolvedManifest({ check = false } = {}) {
  const output = path.join(projectRoot, ...currentResolvedManifestPath.split("/"));
  const manifest = await buildSec02ResolvedManifest();
  await validateSec02ResolvedManifest(manifest);
  const expectedBytes = serializeResolvedManifest(manifest);
  if (check) {
    const actualBytes = await readFile(output, "utf8");
    assert.deepEqual(JSON.parse(actualBytes), manifest, "resolved manifest semantic content is stale");
    assert.equal(actualBytes, expectedBytes, "resolved manifest bytes are stale");
    return manifest;
  }
  await assertSafeOutput(output);
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, expectedBytes, { encoding: "utf8", flag: "wx" });
  try {
    await assertSafeOutput(output);
    await rename(temporary, output);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return manifest;
}

const check = process.argv.slice(2).includes("--check");
try {
  const manifest = await generateSec02ResolvedManifest({ check });
  console.log(`SEC-02 resolved manifest ${check ? "checked" : "generated"}: ${manifest.evidence.observations.length} observations, ${manifest.evidence.positives.length} positives`);
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}
