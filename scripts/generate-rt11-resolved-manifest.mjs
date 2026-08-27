import assert from "node:assert/strict";
import { lstat, open, realpath, rename, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  buildRt11ResolvedManifest,
  projectRoot,
  readRt11BoundFile,
  resolvedManifestPath,
  serializeRt11ResolvedManifest,
  validateRt11ResolvedManifest,
} from "./rt11-governance.mjs";

async function assertSafeOutput(filePath, root = projectRoot) {
  const parent = path.dirname(filePath);
  const parentInfo = await lstat(parent, { bigint: true });
  assert(parentInfo.isDirectory() && !parentInfo.isSymbolicLink(), "RT-11 resolved parent must be a real directory");
  const relative = path.relative(await realpath(root), await realpath(parent));
  assert(relative && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "RT-11 resolved parent escapes project root");
  try {
    const info = await lstat(filePath, { bigint: true });
    assert(info.isFile() && !info.isSymbolicLink(), "RT-11 resolved output must be a regular file");
    assert.equal(info.nlink, 1n, "RT-11 resolved output must not be hardlinked");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

async function openPinnedDirectory(directory) {
  const before = await lstat(directory, { bigint: true });
  assert(before.isDirectory() && !before.isSymbolicLink(), "RT-11 resolved parent identity is invalid");
  const handle = await open(directory, "r+");
  const opened = await handle.stat({ bigint: true });
  assert(opened.isDirectory() && opened.dev === before.dev && opened.ino === before.ino, "RT-11 resolved parent changed before pinning");
  const assertCurrent = async () => {
    const current = await lstat(directory, { bigint: true });
    assert(current.isDirectory() && !current.isSymbolicLink()
      && current.dev === opened.dev && current.ino === opened.ino,
    "RT-11 resolved parent changed during publication");
  };
  return Object.freeze({
    handle,
    assertCurrent,
    sync: async () => {
      await assertCurrent();
      await handle.sync();
      await assertCurrent();
    },
  });
}

export async function publishRt11ResolvedBytes(output, expectedBytes, { root = projectRoot, beforeRename } = {}) {
  await assertSafeOutput(output, root);
  const parent = path.dirname(output);
  const parentLease = await openPinnedDirectory(parent);
  const temporary = `${output}.${process.pid}.tmp`;
  const expectedBuffer = Buffer.from(expectedBytes, "utf8");
  let temporaryHandle = null;
  try {
    temporaryHandle = await open(temporary, "wx+", 0o600);
    await temporaryHandle.writeFile(expectedBuffer);
    await temporaryHandle.sync();
    const written = await temporaryHandle.stat({ bigint: true });
    assert(written.isFile() && written.nlink === 1n && written.size === BigInt(expectedBuffer.length), "RT-11 resolved temporary identity is invalid");
    await parentLease.sync();
    if (beforeRename !== undefined) {
      assert.equal(typeof beforeRename, "function", "RT-11 beforeRename hook is invalid");
      await beforeRename({ parent, temporary, output });
    }
    await parentLease.assertCurrent();
    const [pinned, pathname] = await Promise.all([
      temporaryHandle.stat({ bigint: true }),
      lstat(temporary, { bigint: true }),
    ]);
    assert(pinned.isFile() && pathname.isFile() && !pathname.isSymbolicLink()
      && pinned.dev === written.dev && pinned.ino === written.ino
      && pathname.dev === written.dev && pathname.ino === written.ino
      && pinned.nlink === 1n && pathname.nlink === 1n
      && pinned.size === BigInt(expectedBuffer.length) && pathname.size === BigInt(expectedBuffer.length),
    "RT-11 resolved temporary identity changed before publication");
    const verifiedBytes = Buffer.alloc(expectedBuffer.length);
    const { bytesRead } = await temporaryHandle.read(verifiedBytes, 0, verifiedBytes.length, 0);
    assert.equal(bytesRead, expectedBuffer.length, "RT-11 resolved temporary bytes are truncated");
    assert.deepEqual(verifiedBytes, expectedBuffer, "RT-11 resolved temporary bytes changed before publication");
    await assertSafeOutput(output, root);
    await rename(temporary, output);
    await parentLease.sync();
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  } finally {
    await temporaryHandle?.close();
    await parentLease.handle.close();
  }
}

export async function generateRt11ResolvedManifest({ check = false } = {}) {
  const output = path.join(projectRoot, ...resolvedManifestPath.split("/"));
  const manifest = await buildRt11ResolvedManifest();
  await validateRt11ResolvedManifest(manifest);
  const expectedBytes = serializeRt11ResolvedManifest(manifest);
  if (check) {
    const current = await readRt11BoundFile(resolvedManifestPath, { field: "RT-11 resolved manifest" });
    assert.equal(current.bytes.toString("utf8"), expectedBytes, "RT-11 resolved manifest bytes are stale");
    return manifest;
  }
  await publishRt11ResolvedBytes(output, expectedBytes);
  const published = await readRt11BoundFile(resolvedManifestPath, { field: "RT-11 published resolved manifest" });
  assert.equal(published.bytes.toString("utf8"), expectedBytes, "RT-11 published resolved manifest bytes differ");
  return manifest;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const check = process.argv.slice(2).includes("--check");
  try {
    const manifest = await generateRt11ResolvedManifest({ check });
    console.log(`RT-11 resolved manifest ${check ? "checked" : "generated"}: ${manifest.runtimeEntries.length} runtime, ${manifest.testEntries.length} tests`);
  } catch (error) {
    console.error(error instanceof Error ? error.stack || error.message : String(error));
    process.exitCode = 1;
  }
}
