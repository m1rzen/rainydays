import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as tar from "tar";

export const electronHeaderPolicy = Object.freeze({
  version: "43.1.1",
  archiveUrl: "https://electronjs.org/headers/v43.1.1/node-v43.1.1-headers.tar.gz",
  archiveSha256: "b1112989ad4c4807a6bf59bfc96ce8d0f0b16962efe9818fa768e5908cc24d21",
  nodeLibUrl: "https://electronjs.org/headers/v43.1.1/win-x64/node.lib",
  nodeLibSha256: "757cde97e0dd2f01aed47326440429a1012624892e6e4cbebf59dac964ac8e6d",
  headerTreeFiles: 124,
  headerTreeBytes: 1_570_824,
  headerTreeSha256: "956c2a3dda4622f75093a7adf5e19bbc09d760e166afb092e9d0e62be9e8873d",
});

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function regularFileBytes(file, label) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
  return readFile(file);
}

export async function digestElectronHeaderTree(versionRoot) {
  const records = [];
  const includeRoot = path.join(versionRoot, "include", "node");
  async function walk(directory) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Electron header tree contains a non-directory or link");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const bytes = await regularFileBytes(absolute, "Electron header");
        records.push({
          path: path.relative(versionRoot, absolute).replaceAll("\\", "/"),
          bytes: bytes.length,
          sha256: sha256(bytes),
        });
      } else {
        throw new Error("Electron header tree contains a non-file entry");
      }
    }
  }
  await walk(includeRoot);
  records.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const digest = createHash("sha256");
  digest.update("rainydays-electron-header-tree-v1\0");
  for (const record of records) digest.update(`${record.path}\0${record.bytes}\0${record.sha256}\0`);
  return Object.freeze({
    files: records.length,
    bytes: records.reduce((sum, record) => sum + record.bytes, 0),
    sha256: digest.digest("hex"),
  });
}

async function validateCache(versionRoot) {
  let info;
  try {
    info = await lstat(versionRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Electron native cache root is not a real directory");
  let tree;
  try {
    tree = await digestElectronHeaderTree(versionRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  const nodeLibPath = path.join(versionRoot, "x64", "node.lib");
  let nodeLib;
  try {
    nodeLib = await regularFileBytes(nodeLibPath, "Electron x64 node.lib");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (tree.files !== electronHeaderPolicy.headerTreeFiles ||
      tree.bytes !== electronHeaderPolicy.headerTreeBytes ||
      tree.sha256 !== electronHeaderPolicy.headerTreeSha256 ||
      sha256(nodeLib) !== electronHeaderPolicy.nodeLibSha256) return null;
  return Object.freeze({ tree, nodeLibSha256: electronHeaderPolicy.nodeLibSha256 });
}

async function downloadPinned(url, expectedSha256, output, maximumBytes) {
  const response = await fetch(url, { redirect: "follow" });
  if (!response.ok) throw new Error(`Pinned Electron dependency download failed (${response.status})`);
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("Pinned Electron dependency exceeds its byte limit");
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0 || bytes.length > maximumBytes) throw new Error("Pinned Electron dependency has an invalid byte length");
  if (sha256(bytes) !== expectedSha256) throw new Error("Pinned Electron dependency checksum mismatch");
  await writeFile(output, bytes, { flag: "wx" });
}

async function installStagedVersion(stagedVersion, targetVersion, electronGypRoot) {
  let backup = null;
  try {
    await lstat(targetVersion);
    backup = path.join(electronGypRoot, `.rainydays-electron-backup-${randomUUID()}`);
    await rename(targetVersion, backup);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  try {
    await rename(stagedVersion, targetVersion);
  } catch (error) {
    if (backup) {
      try {
        await rename(backup, targetVersion);
      } catch (restoreError) {
        throw new AggregateError([error, restoreError], `Electron cache replacement and restore both failed; backup retained at ${backup}`);
      }
    }
    throw error;
  }
  if (backup) await rm(backup, { recursive: true, force: true });
}

export async function bootstrapElectronHeaders({ userProfile = process.env.USERPROFILE } = {}) {
  if (process.platform !== "win32" || process.arch !== "x64") throw new Error("Electron native headers require Windows x64");
  if (typeof userProfile !== "string" || !path.isAbsolute(userProfile)) throw new Error("Electron native headers require an absolute USERPROFILE");
  const electronGypRoot = path.join(userProfile, ".electron-gyp");
  const targetVersion = path.join(electronGypRoot, electronHeaderPolicy.version);
  const current = await validateCache(targetVersion);
  if (current) return Object.freeze({ state: "reused", ...current });

  await mkdir(electronGypRoot, { recursive: true });
  const stagingRoot = await mkdtemp(path.join(electronGypRoot, ".rainydays-electron-staging-"));
  try {
    const archive = path.join(stagingRoot, "headers.tar.gz");
    const nodeLib = path.join(stagingRoot, "node.lib");
    await Promise.all([
      downloadPinned(electronHeaderPolicy.archiveUrl, electronHeaderPolicy.archiveSha256, archive, 2 * 1024 * 1024),
      downloadPinned(electronHeaderPolicy.nodeLibUrl, electronHeaderPolicy.nodeLibSha256, nodeLib, 10 * 1024 * 1024),
    ]);

    const stagedVersion = path.join(stagingRoot, electronHeaderPolicy.version);
    await mkdir(stagedVersion);
    await tar.x({
      file: archive,
      cwd: stagedVersion,
      strip: 1,
      strict: true,
      preservePaths: false,
      filter(entryPath, entry) {
        const normalized = entryPath.replaceAll("\\", "/");
        if (normalized !== "node_headers/" && !normalized.startsWith("node_headers/")) throw new Error("Electron header archive contains an unexpected path");
        if (!["Directory", "File", "OldFile", "ContiguousFile"].includes(entry.type)) throw new Error("Electron header archive contains a link or special entry");
        return true;
      },
    });
    await mkdir(path.join(stagedVersion, "x64"));
    await writeFile(path.join(stagedVersion, "x64", "node.lib"), await regularFileBytes(nodeLib, "Downloaded Electron x64 node.lib"), { flag: "wx" });

    const staged = await validateCache(stagedVersion);
    if (!staged) throw new Error("Staged Electron native headers do not match the frozen identity");
    await installStagedVersion(stagedVersion, targetVersion, electronGypRoot);
    const installed = await validateCache(targetVersion);
    if (!installed) throw new Error("Installed Electron native headers do not match the frozen identity");
    return Object.freeze({ state: "installed", ...installed });
  } finally {
    await rm(stagingRoot, { recursive: true, force: true });
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  bootstrapElectronHeaders()
    .then(result => process.stdout.write(`${JSON.stringify(result)}${os.EOL}`))
    .catch(error => {
      process.stderr.write(`${error?.stack ?? error}${os.EOL}`);
      process.exitCode = 1;
    });
}
