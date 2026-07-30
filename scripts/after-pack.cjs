const { createHash } = require("crypto");
const fs = require("fs/promises");
const path = require("path");
const asar = require("@electron/asar");

const binaryPaths = Object.freeze([
  "dist/native/sandbox-host.exe",
  "dist/native/sandbox-launcher.node",
]);
const manifestPath = "dist/native/sec03-native-manifest.json";
const stageManifestPath = "electron-stage-integrity.json";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function archivePath(relative) {
  return relative.split("/").join(path.sep);
}

function parsePeMachine(bytes, field) {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error(`${field} is not a PE image`);
  const offset = bytes.readUInt32LE(0x3c);
  if (offset < 0x40 || offset + 6 > bytes.length || bytes.readUInt32LE(offset) !== 0x4550) throw new Error(`${field} has invalid PE headers`);
  return bytes.readUInt16LE(offset + 4);
}

async function regularBytes(filePath, field) {
  const info = await fs.lstat(filePath);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${field} is not a regular file`);
  return fs.readFile(filePath);
}

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== "win32") return;
  const stageDir = context.packager.projectDir;
  const resources = path.join(context.appOutDir, "resources");
  const archive = path.join(resources, "app.asar");
  const unpackedNative = path.join(resources, "app.asar.unpacked", "dist", "native");
  const archiveInfo = await fs.lstat(archive);
  const nativeInfo = await fs.lstat(unpackedNative);
  if (archiveInfo.isSymbolicLink() || !archiveInfo.isFile()) throw new Error("Packaged app.asar is invalid");
  if (nativeInfo.isSymbolicLink() || !nativeInfo.isDirectory()) throw new Error("Packaged SEC-03 native directory is invalid");

  const unpackedNames = (await fs.readdir(unpackedNative, { withFileTypes: true }))
    .map((entry) => {
      if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`Packaged SEC-03 native entry is invalid: ${entry.name}`);
      return entry.name;
    })
    .sort();
  if (JSON.stringify(unpackedNames) !== JSON.stringify(["sandbox-host.exe", "sandbox-launcher.node"].sort())) {
    throw new Error(`Packaged SEC-03 native output set mismatch: ${unpackedNames.join(", ")}`);
  }

  const stageManifestBytes = await regularBytes(path.join(stageDir, stageManifestPath), "Staged Electron identity");
  const stagedNativeManifestBytes = await regularBytes(path.join(stageDir, ...manifestPath.split("/")), "Staged SEC-03 native manifest");
  const archivedStageManifest = asar.extractFile(archive, stageManifestPath, false);
  const archivedNativeManifest = asar.extractFile(archive, archivePath(manifestPath), false);
  if (!stageManifestBytes.equals(archivedStageManifest)) throw new Error("Packaged Electron stage identity differs byte-for-byte");
  if (!stagedNativeManifestBytes.equals(archivedNativeManifest)) throw new Error("Packaged SEC-03 native manifest differs byte-for-byte");

  const stageIdentity = JSON.parse(stageManifestBytes.toString("utf8"));
  const nativeManifest = JSON.parse(stagedNativeManifestBytes.toString("utf8"));
  if (!stageIdentity.native || stageIdentity.native.manifest?.sha256 !== sha256(stagedNativeManifestBytes)
    || stageIdentity.native.sourceDigest !== nativeManifest.sourceDigest
    || stageIdentity.native.toolchainDigest !== nativeManifest.toolchainDigest
    || JSON.stringify(stageIdentity.native.binaries) !== JSON.stringify(nativeManifest.outputs)) {
    throw new Error("Electron stage identity does not bind the SEC-03 native manifest");
  }

  for (const relative of binaryPaths) {
    const metadata = asar.statFile(archive, archivePath(relative), false);
    if (metadata.unpacked !== true || "link" in metadata || "files" in metadata) throw new Error(`SEC-03 native binary is not uniquely unpacked: ${relative}`);
    const record = nativeManifest.outputs.find((entry) => entry.path === relative);
    if (!record || record.machine !== "AMD64") throw new Error(`SEC-03 native manifest output is invalid: ${relative}`);
    const unpackedBytes = await regularBytes(path.join(resources, "app.asar.unpacked", ...relative.split("/")), `Packaged ${relative}`);
    const stagedBytes = await regularBytes(path.join(stageDir, ...relative.split("/")), `Staged ${relative}`);
    if (!unpackedBytes.equals(stagedBytes) || unpackedBytes.length !== record.bytes || sha256(unpackedBytes) !== record.sha256) {
      throw new Error(`Packaged SEC-03 native byte identity differs: ${relative}`);
    }
    if (parsePeMachine(unpackedBytes, relative) !== 0x8664) throw new Error(`Packaged SEC-03 native machine differs: ${relative}`);
  }

  const manifestMetadata = asar.statFile(archive, archivePath(manifestPath), false);
  const stageMetadata = asar.statFile(archive, stageManifestPath, false);
  if (manifestMetadata.unpacked === true || stageMetadata.unpacked === true) throw new Error("SEC-03 identity manifests must remain only inside ASAR");
  console.log(`  • verified SEC-03 native package identity  manifest=${sha256(stagedNativeManifestBytes)}`);
};
