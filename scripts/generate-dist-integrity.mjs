import { createHash } from "node:crypto";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { validateSec03NativeProjection } from "./build-inputs.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distDirectory = path.join(projectRoot, "dist");
const outputPath = path.join(projectRoot, "dist-integrity.json");

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function listFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`dist must not contain symbolic links: ${absolute}`);
    if (entry.isDirectory()) files.push(...await listFiles(absolute));
    else if (entry.isFile()) files.push(absolute);
    else throw new Error(`dist contains unsupported filesystem entry: ${absolute}`);
  }
  return files;
}

const buildInfo = JSON.parse(await readFile(path.join(projectRoot, "build-info.json"), "utf8"));
if (typeof buildInfo.sourceDigest !== "string" || !/^[a-f0-9]{64}$/.test(buildInfo.sourceDigest)) {
  throw new Error("build-info sourceDigest is invalid before dist integrity generation");
}
const native = await validateSec03NativeProjection(projectRoot);
buildInfo.versions.executionIsolation = {
  architectureSha256: native.architectureSha256,
  protocolVersion: 1,
  nativeSourceDigest: native.sourceDigest,
  toolchainDigest: native.toolchainDigest,
  signatureStatus: native.signatureStatus,
  artifacts: native.binaries,
  testProjection: native.testProjection,
};
await validateSec03NativeProjection(projectRoot, { buildInfo });

const files = await listFiles(distDirectory);
const manifest = {
  schemaVersion: 2,
  sourceDigest: buildInfo.sourceDigest,
  native,
  files: await Promise.all(files
    .map((absolute) => path.relative(distDirectory, absolute).replaceAll("\\", "/"))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map(async (relative) => {
      const absolute = path.join(distDirectory, ...relative.split("/"));
      const bytes = await readFile(absolute);
      const fileStat = await stat(absolute);
      return { path: relative, bytes: fileStat.size, sha256: sha256(bytes) };
    })),
};

const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + "\n", "utf8");
await writeFile(outputPath, manifestBytes);
buildInfo.distIntegritySha256 = sha256(manifestBytes);
await writeFile(path.join(projectRoot, "build-info.json"), JSON.stringify(buildInfo, null, 2) + "\n", "utf8");
console.log(JSON.stringify({ output: outputPath, sourceDigest: manifest.sourceDigest, sha256: buildInfo.distIntegritySha256, files: manifest.files.length }, null, 2));
