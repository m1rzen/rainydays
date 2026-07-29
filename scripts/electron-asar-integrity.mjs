import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import * as asar from "@electron/asar";
import {
  collectSourceFiles,
  sec03NativeBinaryRelatives,
  sec03NativeManifestRelative,
  sourceDigest,
  toPosix,
  validateSec03NativeProjection,
} from "./build-inputs.mjs";
import { electronStageManifestName, expectedElectronStagePackage, validateElectronStage } from "./electron-stage-integrity.mjs";
import { validateSec02SinkInventory } from "./sec02-sink-inventory.mjs";
import { scanSec02SourceSet } from "./sec02-sink-scanner.mjs";
import { crosscheckPolicyPath, validateSec02RestrictedSourceSet } from "./sec02-sink-crosscheck.mjs";

const authoredDirectories = Object.freeze(["dist", "electron", "models", "personas", "public", "skills"]);
const authoredRootFiles = Object.freeze(["build-info.json", "dist-integrity.json"]);
const executableExtension = /\.(?:cjs|js|jsx|mjs)$/iu;
const sec03NativeBinarySet = new Set(sec03NativeBinaryRelatives);

function isRuntimeProjection(relative) {
  return relative === "build-info.json"
    || relative === "package.json"
    || relative === "dist/document-parser-worker.js"
    || sec03NativeBinarySet.has(relative)
    || /^(?:models|personas|public|skills)\//u.test(relative);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

async function walkRegularFiles(directory, root) {
  const rootReal = await realpath(root);
  const files = [];
  const visit = async current => {
    const currentInfo = await lstat(current);
    if (currentInfo.isSymbolicLink() || !currentInfo.isDirectory()) throw new Error(`ASAR source directory is invalid: ${toPosix(path.relative(root, current))}`);
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`ASAR source projection contains a link: ${toPosix(path.relative(root, absolute))}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        const resolved = await realpath(absolute);
        const relative = path.relative(rootReal, resolved);
        if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("ASAR source projection escapes project root");
        files.push(absolute);
      } else throw new Error(`ASAR source projection contains an unsupported entry: ${toPosix(path.relative(root, absolute))}`);
    }
  };
  await visit(directory);
  return files;
}

async function expectedAuthoredFiles(projectRoot) {
  const stageDir = path.join(projectRoot, ".electron-app");
  const [buildInfoBytes, sourcePackageBytes, stageManifestBytes, sourceFiles, sinkInventory, stageIdentity] = await Promise.all([
    readFile(path.join(projectRoot, "build-info.json")),
    readFile(path.join(projectRoot, "package.json")),
    readFile(path.join(stageDir, electronStageManifestName)),
    collectSourceFiles(projectRoot),
    validateSec02SinkInventory(projectRoot),
    validateElectronStage(projectRoot, stageDir),
  ]);
  const buildInfo = JSON.parse(buildInfoBytes.toString("utf8"));
  const sourcePackage = JSON.parse(sourcePackageBytes.toString("utf8"));
  const native = await validateSec03NativeProjection(projectRoot, { buildInfo });
  assert.equal(buildInfo.sourceDigest, await sourceDigest(projectRoot, sourceFiles), "ASAR source identity differs from build metadata");
  assert.deepEqual(stageIdentity.native, native, "ASAR stage native identity differs");
  const records = new Map();
  const executableSources = new Map();
  const add = (relative, bytes) => {
    if (records.has(relative)) throw new Error(`Duplicate ASAR authored path: ${relative}`);
    records.set(relative, Object.freeze({ path: relative, bytes: bytes.length, sha256: sha256(bytes), runtimeProjection: isRuntimeProjection(relative) }));
    if (executableExtension.test(relative)) executableSources.set(relative, Buffer.from(bytes).toString("utf8"));
  };
  for (const directory of authoredDirectories) {
    for (const absolute of await walkRegularFiles(path.join(projectRoot, directory), projectRoot)) {
      add(toPosix(path.relative(projectRoot, absolute)), await readFile(absolute));
    }
  }
  for (const relative of authoredRootFiles) add(relative, await readFile(path.join(projectRoot, relative)));
  add(electronStageManifestName, stageManifestBytes);
  const stagePackage = expectedElectronStagePackage(projectRoot, sourcePackage, buildInfo);
  const packagedPackage = structuredClone(stagePackage);
  delete packagedPackage.scripts;
  delete packagedPackage.build;
  delete packagedPackage.devDependencies;
  add("package.json", Buffer.from(JSON.stringify(packagedPackage, null, 2), "utf8"));
  return { buildInfo, records, executableSources, sinkInventory, native, stageIdentity, stageManifestSha256: sha256(stageManifestBytes) };
}

function normalizeAsarPath(value) {
  const normalized = value.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || path.posix.normalize(normalized) !== normalized || normalized.startsWith("../")) throw new Error(`Invalid ASAR path: ${value}`);
  return normalized;
}

async function readUnpackedFile(unpackedRoot, relative) {
  const absolute = path.join(unpackedRoot, ...relative.split("/"));
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Unpacked authored payload is not a regular file: ${relative}`);
  const [rootReal, fileReal] = await Promise.all([realpath(unpackedRoot), realpath(absolute)]);
  const containment = path.relative(rootReal, fileReal);
  if (!containment || containment === ".." || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) {
    throw new Error(`Unpacked authored payload escapes its root: ${relative}`);
  }
  return readFile(absolute);
}

async function actualAsarFiles(asarPath, unpackedRoot) {
  const records = new Map();
  const executableSources = new Map();
  for (const listed of asar.listPackage(asarPath, { isPack: false })) {
    const archiveKey = listed.replace(/^[\\/]+/u, "");
    const relative = normalizeAsarPath(archiveKey);
    const metadata = asar.statFile(asarPath, archiveKey, false);
    if ("link" in metadata) throw new Error(`ASAR payload contains a link: ${relative}`);
    if ("files" in metadata) continue;
    if (records.has(relative)) throw new Error(`Duplicate ASAR payload path: ${relative}`);
    if (relative.startsWith("node_modules/")) {
      records.set(relative, Object.freeze({ path: relative, dependency: true, unpacked: metadata.unpacked === true }));
      continue;
    }
    const unpacked = metadata.unpacked === true;
    const bytes = unpacked
      ? await readUnpackedFile(unpackedRoot, relative)
      : asar.extractFile(asarPath, archiveKey, false);
    records.set(relative, Object.freeze({ path: relative, bytes: bytes.length, sha256: sha256(bytes), unpacked }));
    if (executableExtension.test(relative)) executableSources.set(relative, Buffer.from(bytes).toString("utf8"));
  }
  return { records, executableSources };
}

async function inspectUnpacked(unpackedRoot) {
  try {
    const rootInfo = await lstat(unpackedRoot);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) throw new Error("app.asar.unpacked is not a regular directory");
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ fileCount: 0, executableFileCount: 0 });
    throw error;
  }
  let fileCount = 0;
  let executableFileCount = 0;
  const visit = async current => {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = toPosix(path.relative(unpackedRoot, absolute));
      if (entry.isSymbolicLink()) throw new Error(`Unpacked payload contains a link: ${relative}`);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) {
        fileCount += 1;
        if (!relative.startsWith("node_modules/") && !isRuntimeProjection(relative)) {
          throw new Error(`Unpacked payload is outside the fixed runtime projection: ${relative}`);
        }
        if (executableExtension.test(relative)) executableFileCount += 1;
      } else throw new Error(`Unpacked payload contains an unsupported entry: ${relative}`);
    }
  };
  await visit(unpackedRoot);
  return Object.freeze({ fileCount, executableFileCount });
}

function packageDialectSources(sources) {
  return new Map([...sources].filter(([relative]) => relative.startsWith("dist/") || relative.startsWith("electron/")));
}

export function validatePackagedExecutableProjection(expectedSources, actualSources, dialect = null) {
  assert.deepEqual([...actualSources.keys()].sort(), [...expectedSources.keys()].sort(), "Packaged ASAR executable projection differs");
  const expectedPackagedSinks = scanSec02SourceSet(expectedSources);
  const actualPackagedSinks = scanSec02SourceSet(actualSources);
  assert.deepEqual(actualPackagedSinks, expectedPackagedSinks, "Packaged ASAR sink set differs from fresh authored projection");
  let packagedDialectImportSetSha256 = null;
  if (dialect) {
    const expectedDialect = validateSec02RestrictedSourceSet(packageDialectSources(expectedSources), dialect.policy, dialect.checkerSha256, "package");
    const actualDialect = validateSec02RestrictedSourceSet(packageDialectSources(actualSources), dialect.policy, dialect.checkerSha256, "package");
    assert.deepEqual(actualDialect, expectedDialect, "Packaged ASAR restricted dialect differs from fresh authored projection");
    packagedDialectImportSetSha256 = actualDialect.importSetSha256;
  }
  const sourceProjection = [...actualSources].sort(([left], [right]) => left.localeCompare(right, "en")).map(([relative, source]) => ({
    path: relative,
    bytes: Buffer.byteLength(source, "utf8"),
    sha256: sha256(Buffer.from(source, "utf8")),
  }));
  return Object.freeze({
    sourceProjectionSha256: sha256(Buffer.from(canonicalJson(sourceProjection), "utf8")),
    packagedSinkSetSha256: sha256(Buffer.from(canonicalJson(actualPackagedSinks), "utf8")),
    packagedDialectImportSetSha256,
  });
}

export async function validateElectronAsar(projectRoot, appResourcesDirectory) {
  const asarPath = path.join(appResourcesDirectory, "app.asar");
  const asarInfo = await lstat(asarPath);
  if (asarInfo.isSymbolicLink() || !asarInfo.isFile()) throw new Error("Packaged app.asar is not a regular file");
  const unpackedRoot = path.join(appResourcesDirectory, "app.asar.unpacked");
  const [{ buildInfo, records: expected, executableSources: expectedExecutableSources, sinkInventory, native, stageIdentity, stageManifestSha256 }, { records: actual, executableSources: actualExecutableSources }, asarBytes, unpacked] = await Promise.all([
    expectedAuthoredFiles(projectRoot),
    actualAsarFiles(asarPath, unpackedRoot),
    readFile(asarPath),
    inspectUnpacked(unpackedRoot),
  ]);
  const actualAuthored = new Map([...actual].filter(([relative]) => !relative.startsWith("node_modules/")));
  const missing = [...expected.keys()].filter(relative => !actualAuthored.has(relative));
  const extra = [...actualAuthored.keys()].filter(relative => !expected.has(relative));
  const mismatched = [...expected].filter(([relative, record]) => {
    const observed = actualAuthored.get(relative);
    return observed && (observed.bytes !== record.bytes
      || observed.sha256 !== record.sha256
      || observed.unpacked !== record.runtimeProjection);
  }).map(([relative]) => relative);
  assert.deepEqual(missing, [], "Packaged ASAR is missing authored files");
  assert.deepEqual(extra, [], "Packaged ASAR contains extra authored files");
  assert.deepEqual(mismatched, [], "Packaged ASAR authored bytes differ");
  for (const relative of sec03NativeBinaryRelatives) assert.equal(actualAuthored.get(relative)?.unpacked, true, `SEC-03 native binary is not uniquely unpacked: ${relative}`);
  assert.equal(actualAuthored.get(sec03NativeManifestRelative)?.unpacked, false, "SEC-03 native manifest must remain inside ASAR");
  assert.equal(actualAuthored.get(electronStageManifestName)?.unpacked, false, "Electron stage identity must remain inside ASAR");
  const [dialectCheckerBytes, dialectPolicyBytes] = await Promise.all([
    readFile(path.join(projectRoot, "scripts", "sec02-sink-crosscheck.mjs")),
    readFile(path.join(projectRoot, ...crosscheckPolicyPath.split("/")), "utf8"),
  ]);
  const dialectCheckerSha256 = sha256(dialectCheckerBytes);
  const dialectPolicy = JSON.parse(dialectPolicyBytes);
  assert.equal(sinkInventory.dialectCheckerSha256, dialectCheckerSha256, "ASAR dialect checker identity differs from sink inventory");
  assert.equal(sinkInventory.dialectPolicySha256, dialectPolicy.canonicalPayloadSha256, "ASAR dialect policy identity differs from sink inventory");
  const rescannedProjection = validatePackagedExecutableProjection(expectedExecutableSources, actualExecutableSources, {
    policy: dialectPolicy,
    checkerSha256: dialectCheckerSha256,
  });
  const executableProjection = [...actualExecutableSources.keys()].sort().map(relative => {
    const record = actualAuthored.get(relative);
    return { path: relative, bytes: record.bytes, sha256: record.sha256, unpacked: record.unpacked };
  });
  const authoredExecutableProjectionSha256 = sha256(Buffer.from(canonicalJson(executableProjection), "utf8"));
  const packagedSinkSetSha256 = rescannedProjection.packagedSinkSetSha256;
  const packagedDialectImportSetSha256 = rescannedProjection.packagedDialectImportSetSha256;
  assert(expected.has("electron/path-bootstrap.cjs"), "Electron path bootstrap is absent from expected payload");
  assert(actualAuthored.has("electron/path-bootstrap.cjs"), "Electron path bootstrap is absent from ASAR");
  return Object.freeze({
    schemaVersion: 3,
    buildId: buildInfo.buildId,
    sourceDigest: buildInfo.sourceDigest,
    stageManifestSha256,
    buildInfoSha256: stageIdentity.buildInfoSha256,
    distIntegritySha256: stageIdentity.distIntegritySha256,
    native: Object.freeze({
      architectureSha256: native.architectureSha256,
      manifest: native.manifest,
      sourceDigest: native.sourceDigest,
      toolchainDigest: native.toolchainDigest,
      signatureStatus: native.signatureStatus,
      binaries: native.binaries,
    }),
    sinkInventorySha256: sinkInventory.canonicalPayloadSha256,
    detectorPolicySha256: sinkInventory.detectorPolicySha256,
    reviewPolicySha256: sinkInventory.reviewPolicySha256,
    dialectCheckerSha256: sinkInventory.dialectCheckerSha256,
    dialectPolicySha256: sinkInventory.dialectPolicySha256,
    dialectImportSetSha256: sinkInventory.dialectImportSetSha256,
    executableManifestSha256: sinkInventory.executableManifestSha256,
    runtimeSinkSetSha256: sinkInventory.runtimeSinkSetSha256,
    authoredExecutableProjectionSha256,
    packagedSinkSetSha256,
    packagedDialectImportSetSha256,
    asarSha256: sha256(asarBytes),
    authoredFileCount: expected.size,
    dependencyFileCount: actual.size - actualAuthored.size,
    unpacked,
    missing,
    extra,
    mismatched,
    packageInspected: true,
    asarPayloadBound: true,
    producerSummaryTrusted: false,
  });
}
