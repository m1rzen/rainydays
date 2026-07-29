import assert from "node:assert/strict";
import { constants as fsConstants, copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { collectSourceFiles, digestFiles, fileManifest, sourceDigest, toPosix } from "../build-inputs.mjs";

const sha256Pattern = /^[a-f0-9]{64}$/;

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function selectFiles(projectRoot, files, predicate) {
  const selected = files.filter((absolute) => predicate(toPosix(path.relative(projectRoot, absolute))));
  assert(selected.length > 0, "candidate identity subset must not be empty");
  return selected;
}

export function isPipelineDefinitionInput(relative) {
  return relative.startsWith(".github/")
    || relative.startsWith("build/")
    || relative.startsWith("scripts/")
    || relative.startsWith("tests/")
    || relative.startsWith("parity/")
    || relative === "LUX-DESKTOP-100-PARITY-EXECUTION-SPEC.md"
    || relative === "eslint.config.mjs"
    || relative === ".gitleaks.toml"
    || relative === "package.json"
    || relative === "package-lock.json"
    || relative === "tsconfig.json";
}

export async function computeCandidateIdentity(projectRoot) {
  const files = await collectSourceFiles(projectRoot);
  const manifest = await fileManifest(projectRoot, files);
  const source = await sourceDigest(projectRoot, files);
  const packageInputDigest = await digestFiles(projectRoot, files, "mini-lux-package-input-v1");
  const pipelineFiles = selectFiles(projectRoot, files, isPipelineDefinitionInput);
  const policyFiles = selectFiles(projectRoot, files, (relative) =>
    relative.startsWith("parity/policies/")
    || relative === "parity/GOV-04-CI-ARCHITECTURE.md"
    || relative === "parity/GOV-04-ARCHITECT-AMENDMENT-01.md"
    || relative === "LUX-DESKTOP-100-PARITY-EXECUTION-SPEC.md"
    || relative === ".gitleaks.toml"
  );
  const pipelineDefinitionDigest = await digestFiles(projectRoot, pipelineFiles, "mini-lux-pipeline-definition-v1");
  const policyDigest = await digestFiles(projectRoot, policyFiles, "mini-lux-gov04-policy-v1");
  const sourceManifestSha256 = sha256(canonicalJson(manifest));
  const releaseCandidateId = sha256(canonicalJson({ sourceDigest: source, packageInputDigest, pipelineDefinitionDigest, policyDigest }));
  return {
    schemaVersion: 1,
    sourceDigest: source,
    packageInputDigest,
    pipelineDefinitionDigest,
    policyDigest,
    sourceManifestSha256,
    releaseCandidateId,
    fileCount: manifest.length,
    totalBytes: manifest.reduce((sum, entry) => sum + entry.bytes, 0),
    files,
    manifest,
  };
}

export function publicCandidateIdentity(identity) {
  return {
    schemaVersion: identity.schemaVersion,
    sourceDigest: identity.sourceDigest,
    packageInputDigest: identity.packageInputDigest,
    pipelineDefinitionDigest: identity.pipelineDefinitionDigest,
    policyDigest: identity.policyDigest,
    sourceManifestSha256: identity.sourceManifestSha256,
    releaseCandidateId: identity.releaseCandidateId,
    fileCount: identity.fileCount,
    totalBytes: identity.totalBytes,
  };
}

export function validateCandidateIdentity(value) {
  assert(value && typeof value === "object" && !Array.isArray(value));
  assert.deepEqual(Object.keys(value).sort(), [
    "fileCount", "packageInputDigest", "pipelineDefinitionDigest", "policyDigest", "releaseCandidateId",
    "schemaVersion", "sourceDigest", "sourceManifestSha256", "totalBytes",
  ].sort());
  assert.equal(value.schemaVersion, 1);
  for (const key of ["sourceDigest", "packageInputDigest", "pipelineDefinitionDigest", "policyDigest", "releaseCandidateId", "sourceManifestSha256"]) {
    assert.match(value[key], sha256Pattern, `candidate.${key} is invalid`);
  }
  assert(Number.isSafeInteger(value.fileCount) && value.fileCount > 0);
  assert(Number.isSafeInteger(value.totalBytes) && value.totalBytes > 0);
  assert.equal(value.releaseCandidateId, sha256(canonicalJson({
    sourceDigest: value.sourceDigest,
    packageInputDigest: value.packageInputDigest,
    pipelineDefinitionDigest: value.pipelineDefinitionDigest,
    policyDigest: value.policyDigest,
  })), "releaseCandidateId is inconsistent");
}

export async function copyCandidateSnapshot(projectRoot, destination, identity) {
  await mkdir(destination, { recursive: false });
  for (let index = 0; index < identity.files.length; index += 1) {
    const source = identity.files[index];
    const entry = identity.manifest[index];
    const relative = toPosix(path.relative(projectRoot, source));
    assert.equal(relative, entry.path, "candidate manifest/file order mismatch");
    const target = path.join(destination, ...relative.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await copyFile(source, target, fsConstants.COPYFILE_EXCL);
    const copied = await readFile(target);
    assert.equal(copied.length, entry.bytes, `snapshot byte count changed: ${relative}`);
    assert.equal(sha256(copied), entry.sha256, `snapshot hash changed: ${relative}`);
  }
  const copiedIdentity = await computeCandidateIdentity(destination);
  assert.deepEqual(publicCandidateIdentity(copiedIdentity), publicCandidateIdentity(identity), "copied candidate identity differs");
  return copiedIdentity;
}

export async function assertEmptyFormalOutputs(workspace) {
  for (const relative of ["build-info.json", "dist-integrity.json", "dist", ".electron-app", "release", "coverage", "test-results/package-artifact.json"]) {
    try {
      const info = await stat(path.join(workspace, ...relative.split("/")));
      throw new Error(`formal output must be absent before package: ${relative} (${info.isDirectory() ? "directory" : "file"})`);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
}
