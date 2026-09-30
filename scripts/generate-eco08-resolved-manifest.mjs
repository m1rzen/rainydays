import assert from "node:assert/strict";
import { lstat, open, realpath } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildEco08ResolvedManifest,
  projectRoot,
  readEco08BoundFile,
  resolvedManifestPath,
  serializeEco08ResolvedManifest,
  validateEco08ResolvedManifest,
} from "./eco08-governance.mjs";

async function publish(output, bytes) {
  const parent = path.dirname(output);
  const rootCanonical = await realpath(projectRoot);
  const parentCanonical = await realpath(parent);
  const containment = path.relative(rootCanonical, parentCanonical);
  assert(containment && !containment.startsWith(`..${path.sep}`) && !path.isAbsolute(containment), "ECO-08 resolved parent escapes project");
  const parentBefore = await lstat(parent, { bigint: true });
  const before = await lstat(output, { bigint: true });
  assert(parentBefore.isDirectory() && !parentBefore.isSymbolicLink());
  assert(before.isFile() && !before.isSymbolicLink() && before.nlink === 1n);
  const handle = await open(output, "r+");
  try {
    const opened = await handle.stat({ bigint: true });
    assert(opened.dev === before.dev && opened.ino === before.ino);
    await handle.truncate(0);
    await handle.writeFile(bytes);
    await handle.sync();
    const written = await handle.stat({ bigint: true });
    assert(written.size === BigInt(bytes.length));
    const parentNow = await lstat(parent, { bigint: true });
    assert(parentNow.dev === parentBefore.dev && parentNow.ino === parentBefore.ino);
  } finally {
    await handle.close();
  }
}

export async function generateEco08ResolvedManifest({ check = false } = {}) {
  const manifest = await buildEco08ResolvedManifest();
  await validateEco08ResolvedManifest(manifest);
  const expected = serializeEco08ResolvedManifest(manifest);
  if (check) {
    const current = await readEco08BoundFile(resolvedManifestPath, { field: "ECO-08 resolved manifest" });
    assert.equal(current.bytes.toString("utf8"), expected, "ECO-08 resolved manifest is stale");
    return manifest;
  }
  await publish(path.join(projectRoot, ...resolvedManifestPath.split("/")), Buffer.from(expected));
  const published = await readEco08BoundFile(resolvedManifestPath, { field: "ECO-08 published manifest" });
  assert.equal(published.bytes.toString("utf8"), expected);
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const check = process.argv.slice(2).includes("--check");
  try {
    const manifest = await generateEco08ResolvedManifest({ check });
    console.log(`ECO-08 resolved manifest ${check ? "checked" : "generated"}: ${manifest.runtimeEntries.length} runtime, ${manifest.testEntries.length} tests`);
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  }
}
