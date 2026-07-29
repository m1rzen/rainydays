import assert from "node:assert/strict";
import { lstat, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { buildSec03ResolvedManifest, projectRoot, resolvedManifestPath, serializeResolvedManifest, validateSec03ResolvedManifest } from "./sec03-governance.mjs";

async function assertSafeOutput(filePath) {
  const parent = path.dirname(filePath);
  const parentInfo = await lstat(parent);
  assert(parentInfo.isDirectory() && !parentInfo.isSymbolicLink(), "resolved manifest parent must be a real directory");
  const relative = path.relative(await realpath(projectRoot), await realpath(parent));
  assert(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "resolved manifest parent escapes project root");
  try {
    const info = await lstat(filePath);
    assert(info.isFile() && !info.isSymbolicLink(), "resolved manifest output must be a regular file");
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
}

export async function generateSec03ResolvedManifest({ check = false } = {}) {
  const output = path.join(projectRoot, ...resolvedManifestPath.split("/"));
  const manifest = await buildSec03ResolvedManifest();
  await validateSec03ResolvedManifest(manifest);
  const expectedBytes = serializeResolvedManifest(manifest);
  if (check) {
    const actualBytes = await readFile(output, "utf8");
    assert.equal(actualBytes, expectedBytes, "SEC-03 resolved manifest bytes are stale");
    return manifest;
  }
  await assertSafeOutput(output);
  const temporary = `${output}.${process.pid}.tmp`;
  await writeFile(temporary, expectedBytes, { encoding: "utf8", flag: "wx" });
  try { await assertSafeOutput(output); await rename(temporary, output); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
  return manifest;
}

const check = process.argv.slice(2).includes("--check");
try {
  const manifest = await generateSec03ResolvedManifest({ check });
  console.log(`SEC-03 resolved manifest ${check ? "checked" : "generated"}: ${manifest.deltaEntries.length} delta, ${manifest.cumulativeEntries.length} cumulative`);
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}
