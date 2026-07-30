import { createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = path.join(projectRoot, "models-manifest.json");
const sha256Pattern = /^[a-f0-9]{64}$/u;
const revisionPattern = /^[a-f0-9]{40}$/u;
const expectedRepository = "Xenova/multilingual-e5-small";
const expectedPaths = Object.freeze([
  "models/Xenova/multilingual-e5-small/config.json",
  "models/Xenova/multilingual-e5-small/onnx/model_quantized.onnx",
  "models/Xenova/multilingual-e5-small/tokenizer.json",
  "models/Xenova/multilingual-e5-small/tokenizer_config.json",
]);

function exactKeys(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${field} keys differ`);
}

export function validateModelManifest(value) {
  exactKeys(value, ["schemaVersion", "repository", "revision", "files"], "model manifest");
  if (value.schemaVersion !== 1) throw new Error("model manifest schema differs");
  if (value.repository !== expectedRepository) throw new Error("model repository differs");
  if (!revisionPattern.test(value.revision)) throw new Error("model revision is invalid");
  if (!Array.isArray(value.files) || value.files.length !== expectedPaths.length) throw new Error("model file set differs");
  const seen = new Set();
  for (const [index, entry] of value.files.entries()) {
    exactKeys(entry, ["path", "url", "bytes", "sha256"], `model file ${index}`);
    if (entry.path !== expectedPaths[index] || seen.has(entry.path)) throw new Error(`model path differs: ${entry.path}`);
    seen.add(entry.path);
    if (!Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) throw new Error(`model byte length is invalid: ${entry.path}`);
    if (!sha256Pattern.test(entry.sha256)) throw new Error(`model digest is invalid: ${entry.path}`);
    const expectedUrl = `https://huggingface.co/${value.repository}/resolve/${value.revision}/${entry.path.split("/").slice(3).join("/")}`;
    if (entry.url !== expectedUrl) throw new Error(`model URL differs: ${entry.path}`);
  }
  return Object.freeze(value);
}

async function existingInfo(candidate) {
  try {
    return await lstat(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function ensureSafeDirectory(relativeDirectory) {
  let current = projectRoot;
  for (const segment of relativeDirectory.split("/")) {
    current = path.join(current, segment);
    let info = await existingInfo(current);
    if (!info) {
      try {
        await mkdir(current);
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`model parent is not a regular directory: ${relativeDirectory}`);
  }
}

async function digestFile(absolute, expectedBytes) {
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`model input is not a regular file: ${path.relative(projectRoot, absolute)}`);
  if (info.size !== expectedBytes) return { bytes: info.size, sha256: null };
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(absolute)) {
    bytes += chunk.length;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

async function verifyExisting(entry) {
  const absolute = path.join(projectRoot, ...entry.path.split("/"));
  const info = await existingInfo(absolute);
  if (!info) return false;
  const actual = await digestFile(absolute, entry.bytes);
  if (actual.bytes !== entry.bytes || actual.sha256 !== entry.sha256) throw new Error(`model asset identity differs: ${entry.path}`);
  return true;
}

async function writeAll(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    if (bytesWritten <= 0) throw new Error("model download write made no progress");
    offset += bytesWritten;
  }
}

async function downloadEntry(entry) {
  const relativeDirectory = path.posix.dirname(entry.path);
  await ensureSafeDirectory(relativeDirectory);
  const destination = path.join(projectRoot, ...entry.path.split("/"));
  const temporary = `${destination}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const handle = await open(temporary, "wx");
  let published = false;
  try {
    const response = await fetch(entry.url, { redirect: "follow", signal: AbortSignal.timeout(10 * 60 * 1000) });
    if (!response.ok || !response.body) throw new Error(`model download failed (${response.status}): ${entry.path}`);
    if (new URL(response.url).protocol !== "https:") throw new Error(`model redirect is not HTTPS: ${entry.path}`);
    const hash = createHash("sha256");
    let received = 0;
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > entry.bytes) throw new Error(`model download exceeds pinned size: ${entry.path}`);
      hash.update(chunk);
      await writeAll(handle, chunk);
    }
    if (received !== entry.bytes) throw new Error(`model download size differs: ${entry.path}`);
    if (hash.digest("hex") !== entry.sha256) throw new Error(`model download digest differs: ${entry.path}`);
    await handle.sync();
    await handle.close();
    await rename(temporary, destination);
    published = true;
  } finally {
    await handle.close().catch(() => undefined);
    if (!published) await rm(temporary, { force: true });
  }
}

export async function bootstrapModels({ checkOnly = false } = {}) {
  const manifest = validateModelManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  let downloaded = 0;
  for (const entry of manifest.files) {
    if (await verifyExisting(entry)) continue;
    if (checkOnly) throw new Error(`model asset is missing: ${entry.path}`);
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await downloadEntry(entry);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await delay(attempt * 1_000);
      }
    }
    if (lastError) throw lastError;
    if (!await verifyExisting(entry)) throw new Error(`model asset was not published: ${entry.path}`);
    downloaded += 1;
  }
  return Object.freeze({ files: manifest.files.length, downloaded, revision: manifest.revision });
}

async function main() {
  const argument = process.argv[2];
  if (argument && argument !== "--check") throw new Error("Usage: node scripts/bootstrap-models.mjs [--check]");
  const result = await bootstrapModels({ checkOnly: argument === "--check" });
  console.log(JSON.stringify(result, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(error => {
    console.error(error?.stack ?? String(error));
    process.exitCode = 1;
  });
}
