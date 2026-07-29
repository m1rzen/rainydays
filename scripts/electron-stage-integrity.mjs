import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { collectSourceFiles, sourceDigest, toPosix, validateSec03NativeProjection } from "./build-inputs.mjs";
import { validateSec02SinkInventory } from "./sec02-sink-inventory.mjs";

export const electronStageManifestName = "electron-stage-integrity.json";
const projectedDirectories = Object.freeze(["build", "dist", "electron", "models", "personas", "public", "scripts", "skills"]);
const projectedRootFiles = Object.freeze(["build-info.json", "dist-integrity.json", "package-lock.json"]);
const sha256Pattern = /^[a-f0-9]{64}$/u;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function artifactSafeBuildId(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/gu, character => `~${character.codePointAt(0).toString(16).toUpperCase().padStart(2, "0")}`);
}

async function listRegularFiles(directory, root) {
  const rootReal = await realpath(root);
  const files = [];
  const visit = async current => {
    const currentInfo = await lstat(current);
    if (currentInfo.isSymbolicLink() || !currentInfo.isDirectory()) throw new Error(`Electron stage projection directory is invalid: ${toPosix(path.relative(root, current))}`);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Electron stage projection contains a link: ${toPosix(path.relative(root, absolute))}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const resolved = await realpath(absolute);
        const containment = path.relative(rootReal, resolved);
        if (!containment || containment === ".." || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) {
          throw new Error(`Electron stage projection escapes its root: ${toPosix(path.relative(root, absolute))}`);
        }
        files.push(absolute);
      } else throw new Error(`Electron stage projection contains an unsupported entry: ${toPosix(path.relative(root, absolute))}`);
    }
  };
  await visit(directory);
  return files.sort((left, right) => {
    const a = toPosix(path.relative(root, left));
    const b = toPosix(path.relative(root, right));
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

async function fileRecord(root, absolute) {
  const bytes = await readFile(absolute);
  return Object.freeze({ path: toPosix(path.relative(root, absolute)), bytes: bytes.length, sha256: sha256(bytes) });
}

async function projectedSourceRecords(projectRoot) {
  const records = [];
  for (const directory of projectedDirectories) {
    const root = path.join(projectRoot, directory);
    for (const absolute of await listRegularFiles(root, projectRoot)) records.push(await fileRecord(projectRoot, absolute));
  }
  for (const relative of projectedRootFiles) {
    const absolute = path.join(projectRoot, relative);
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Electron source projection file is invalid: ${relative}`);
    records.push(await fileRecord(projectRoot, absolute));
  }
  return records.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

async function projectedStageRecords(stageDir) {
  const records = [];
  for (const directory of projectedDirectories) {
    const root = path.join(stageDir, directory);
    for (const absolute of await listRegularFiles(root, stageDir)) records.push(await fileRecord(stageDir, absolute));
  }
  for (const relative of projectedRootFiles) {
    const absolute = path.join(stageDir, relative);
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Electron stage projection file is invalid: ${relative}`);
    records.push(await fileRecord(stageDir, absolute));
  }
  return records.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

export function expectedElectronStagePackage(projectRoot, sourcePackage, buildInfo) {
  return {
    ...sourcePackage,
    scripts: {},
    build: {
      ...sourcePackage.build,
      electronVersion: sourcePackage.devDependencies.electron.replace(/^[^0-9]*/u, ""),
      electronDist: path.join(projectRoot, "node_modules", "electron", "dist"),
      directories: { ...sourcePackage.build.directories, output: "../release" },
      artifactName: `Mini-Lux Setup ${sourcePackage.version}-${artifactSafeBuildId(buildInfo.buildId)}.\${ext}`,
    },
  };
}

async function expectedManifest(projectRoot, stageDir) {
  const [sourcePackageBytes, stagedPackageBytes, buildInfoBytes, distIntegrityBytes, sourceFiles, sinkInventory] = await Promise.all([
    readFile(path.join(projectRoot, "package.json")),
    readFile(path.join(stageDir, "package.json")),
    readFile(path.join(projectRoot, "build-info.json")),
    readFile(path.join(projectRoot, "dist-integrity.json")),
    collectSourceFiles(projectRoot),
    validateSec02SinkInventory(projectRoot),
  ]);
  const sourcePackage = JSON.parse(sourcePackageBytes.toString("utf8"));
  const stagedPackage = JSON.parse(stagedPackageBytes.toString("utf8"));
  const buildInfo = JSON.parse(buildInfoBytes.toString("utf8"));
  const distIntegrity = JSON.parse(distIntegrityBytes.toString("utf8"));
  const currentSourceDigest = await sourceDigest(projectRoot, sourceFiles);
  const native = await validateSec03NativeProjection(projectRoot, { buildInfo });
  assert.equal(buildInfo.sourceDigest, currentSourceDigest, "Electron stage build metadata is stale");
  assert.equal(buildInfo.appVersion, sourcePackage.version, "Electron stage app version differs");
  assert.equal(buildInfo.distIntegritySha256, sha256(distIntegrityBytes), "Electron stage dist integrity digest differs");
  assert.equal(distIntegrity.schemaVersion, 2, "Electron stage dist integrity schema differs");
  assert.deepEqual(distIntegrity.native, native, "Electron stage dist native identity differs");
  assert.deepEqual(stagedPackage, expectedElectronStagePackage(projectRoot, sourcePackage, buildInfo), "Electron stage package contract differs");

  const [sourceProjection, stageProjection] = await Promise.all([
    projectedSourceRecords(projectRoot),
    projectedStageRecords(stageDir),
  ]);
  assert.deepEqual(stageProjection, sourceProjection, "Electron stage authored projection differs from source bytes");
  const payload = {
    schemaVersion: 1,
    buildId: buildInfo.buildId,
    sourceDigest: currentSourceDigest,
    sourceFileCount: sourceFiles.length,
    buildInfoSha256: sha256(buildInfoBytes),
    distIntegritySha256: sha256(distIntegrityBytes),
    native,
    projectedFileCount: sourceProjection.length,
    projectionSha256: sha256(Buffer.from(canonicalJson(sourceProjection), "utf8")),
    stagePackageSha256: sha256(stagedPackageBytes),
    sinkInventorySha256: sinkInventory.canonicalPayloadSha256,
    detectorPolicySha256: sinkInventory.detectorPolicySha256,
    reviewPolicySha256: sinkInventory.reviewPolicySha256,
    dialectCheckerSha256: sinkInventory.dialectCheckerSha256,
    dialectPolicySha256: sinkInventory.dialectPolicySha256,
    dialectImportSetSha256: sinkInventory.dialectImportSetSha256,
    executableManifestSha256: sinkInventory.executableManifestSha256,
    runtimeSinkSetSha256: sinkInventory.runtimeSinkSetSha256,
    projectedDirectories: [...projectedDirectories],
    projectedRootFiles: [...projectedRootFiles],
  };
  return Object.freeze({ ...payload, canonicalPayloadSha256: sha256(Buffer.from(canonicalJson(payload), "utf8")) });
}

export async function validateElectronStage(projectRoot, stageDir) {
  const expected = await expectedManifest(projectRoot, stageDir);
  const manifestPath = path.join(stageDir, electronStageManifestName);
  const info = await lstat(manifestPath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error("Electron stage identity manifest is not a regular file");
  const bytes = await readFile(manifestPath);
  const actual = JSON.parse(bytes.toString("utf8"));
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort(), "Electron stage identity manifest keys differ");
  assert.match(actual.canonicalPayloadSha256, sha256Pattern, "Electron stage identity digest is invalid");
  assert.deepEqual(actual, expected, "Electron stage identity manifest is stale");
  assert.equal(bytes.toString("utf8"), `${JSON.stringify(expected, null, 2)}\n`, "Electron stage identity manifest bytes differ");
  return expected;
}

export async function writeElectronStageManifest(projectRoot, stageDir) {
  const manifest = await expectedManifest(projectRoot, stageDir);
  const output = path.join(stageDir, electronStageManifestName);
  const temporary = `${output}.${process.pid}.tmp`;
  await rm(temporary, { force: true });
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, output);
  await validateElectronStage(projectRoot, stageDir);
  return manifest;
}
