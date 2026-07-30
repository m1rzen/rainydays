import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { access, readFile, stat } from "node:fs/promises";
import path from "node:path";

export class InstallerPreflightError extends Error {
  constructor(code, message) {
    super(`${code}: ${message}`);
    this.name = "InstallerPreflightError";
    this.code = code;
  }
}

export function artifactSafeBuildId(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, (character) =>
    `~${character.codePointAt(0).toString(16).toUpperCase().padStart(2, "0")}`
  );
}

export function expectedInstallerName(buildInfo) {
  return `RainyDays Setup ${buildInfo.appVersion}-${artifactSafeBuildId(buildInfo.buildId)}.exe`;
}

export async function fileSha256(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

function exactKeys(value, expected, field) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${field} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${field} keys differ`);
}

export async function verifyInstallerPreflight({ manifestPath, installerOverride, buildInfo, projectRoot }) {
  let manifest;
  try { manifest = JSON.parse(await readFile(manifestPath, "utf8")); }
  catch (error) { throw new InstallerPreflightError("ARTIFACT_MANIFEST_INVALID", error instanceof Error ? error.message : String(error)); }
  try {
    exactKeys(manifest, ["schemaVersion", "createdAt", "build", "artifact"], "artifact manifest");
    assert.equal(manifest.schemaVersion, 1);
    exactKeys(manifest.build, ["appVersion", "buildId", "sourceDigest", "buildInfoSha256", "executionIsolation"], "artifact manifest build");
    exactKeys(manifest.build.executionIsolation, ["architectureSha256", "protocolVersion", "nativeSourceDigest", "toolchainDigest", "signatureStatus", "artifacts"], "artifact manifest execution isolation");
    assert(Array.isArray(manifest.build.executionIsolation.artifacts) && manifest.build.executionIsolation.artifacts.length === 2, "artifact manifest native artifacts differ");
    for (const artifact of manifest.build.executionIsolation.artifacts) {
      exactKeys(artifact, ["path", "bytes", "sha256", "machine"], "artifact manifest native artifact");
      assert(Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0, "artifact manifest native artifact bytes differ");
      assert.match(artifact.sha256, /^[a-f0-9]{64}$/);
      assert.equal(artifact.machine, "AMD64");
    }
    exactKeys(manifest.artifact, ["filename", "bytes", "sha256"], "artifact manifest artifact");
    assert.match(manifest.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    assert.match(manifest.build.sourceDigest, /^[a-f0-9]{64}$/);
    assert.match(manifest.build.buildInfoSha256, /^[a-f0-9]{64}$/);
    assert.match(manifest.build.executionIsolation.architectureSha256, /^[a-f0-9]{64}$/);
    assert.equal(manifest.build.executionIsolation.protocolVersion, 1);
    assert.match(manifest.build.executionIsolation.nativeSourceDigest, /^[a-f0-9]{64}$/);
    assert.match(manifest.build.executionIsolation.toolchainDigest, /^[a-f0-9]{64}$/);
    assert.equal(manifest.build.executionIsolation.signatureStatus, "unsigned-local");
    assert.match(manifest.artifact.sha256, /^[a-f0-9]{64}$/);
    assert(Number.isSafeInteger(manifest.artifact.bytes) && manifest.artifact.bytes > 0);
  } catch (error) {
    throw new InstallerPreflightError("ARTIFACT_MANIFEST_INVALID", error instanceof Error ? error.message : String(error));
  }
  const expectedName = expectedInstallerName(buildInfo);
  if (manifest.build.appVersion !== buildInfo.appVersion || manifest.build.buildId !== buildInfo.buildId || manifest.build.sourceDigest !== buildInfo.sourceDigest
    || JSON.stringify(manifest.build.executionIsolation) !== JSON.stringify(buildInfo.versions?.executionIsolation)) {
    throw new InstallerPreflightError("ARTIFACT_BUILD_MISMATCH", `manifest does not bind current Build ID ${buildInfo.buildId}`);
  }
  if (manifest.artifact.filename !== expectedName) throw new InstallerPreflightError("INSTALLER_NAME_MISMATCH", `expected ${expectedName}`);
  const installer = installerOverride ? path.resolve(installerOverride) : path.join(projectRoot, "release", expectedName);
  if (path.basename(installer) !== expectedName) throw new InstallerPreflightError("INSTALLER_NAME_MISMATCH", `expected ${expectedName}`);
  if (!await exists(installer)) throw new InstallerPreflightError("INSTALLER_MISSING", expectedName);
  const info = await stat(installer);
  if (!info.isFile()) throw new InstallerPreflightError("INSTALLER_MISSING", `${expectedName} is not a regular file`);
  const actualHash = await fileSha256(installer);
  if (info.size !== manifest.artifact.bytes || actualHash !== manifest.artifact.sha256) {
    throw new InstallerPreflightError("INSTALLER_HASH_MISMATCH", expectedName);
  }
  if (await fileSha256(path.join(projectRoot, "build-info.json")) !== manifest.build.buildInfoSha256) {
    throw new InstallerPreflightError("ARTIFACT_BUILD_MISMATCH", "build-info.json changed after packaging");
  }
  return { installer, manifest };
}
