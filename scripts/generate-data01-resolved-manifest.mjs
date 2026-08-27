import assert from "node:assert/strict";
import { lstat, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  buildData01ResolvedManifest,
  projectRoot,
  resolvedManifestPath,
  serializeData01ResolvedManifest,
  validateData01ResolvedManifest,
} from "./data01-governance.mjs";

async function assertSafeOutput(filePath) {
  const parent = path.dirname(filePath);
  const parentInfo = await lstat(parent);
  assert(parentInfo.isDirectory() && !parentInfo.isSymbolicLink(), "DATA-01 resolved parent must be a real directory");
  const relative = path.relative(await realpath(projectRoot), await realpath(parent));
  assert(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "DATA-01 resolved parent escapes project root");
  try {
    const info = await lstat(filePath);
    assert(info.isFile() && !info.isSymbolicLink(), "DATA-01 resolved output must be a regular file");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export async function generateData01ResolvedManifest({ check = false } = {}) {
  const output = path.join(projectRoot, ...resolvedManifestPath.split("/"));
  const manifest = await buildData01ResolvedManifest();
  await validateData01ResolvedManifest(manifest);
  const expectedBytes = serializeData01ResolvedManifest(manifest);
  if (check) {
    assert.equal(await readFile(output, "utf8"), expectedBytes, "DATA-01 resolved manifest bytes are stale");
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
  const manifest = await generateData01ResolvedManifest({ check });
  console.log(`DATA-01 resolved manifest ${check ? "checked" : "generated"}: ${manifest.runtimeEntries.length} runtime, ${manifest.testEntries.length} tests`);
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exitCode = 1;
}
