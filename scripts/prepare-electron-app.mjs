import { createHash } from "crypto";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { expectedElectronStagePackage, writeElectronStageManifest } from "./electron-stage-integrity.mjs";
import { validateSec03NativeProjection } from "./build-inputs.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stageDir = path.join(projectRoot, ".electron-app");

async function copyDirectory(name) {
  await fs.cp(path.join(projectRoot, name), path.join(stageDir, name), { recursive: true });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function listFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`dist must not contain symbolic links: ${absolute}`);
    if (entry.isDirectory()) files.push(...await listFiles(absolute));
    else if (entry.isFile()) files.push(absolute);
    else throw new Error(`dist contains unsupported filesystem entry: ${absolute}`);
  }
  return files;
}

async function compareDirectoryBytes(expectedDirectory, actualDirectory, label, include = () => true) {
  const relativePaths = async (directory) => (await listFiles(directory))
    .map((absolute) => path.relative(directory, absolute).replaceAll("\\", "/"))
    .filter(include)
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const expectedPaths = await relativePaths(expectedDirectory);
  const actualPaths = await relativePaths(actualDirectory);
  if (JSON.stringify(expectedPaths) !== JSON.stringify(actualPaths)) throw new Error(`${label} file set mismatch`);
  for (const relative of expectedPaths) {
    const expected = await fs.readFile(path.join(expectedDirectory, ...relative.split("/")));
    const actual = await fs.readFile(path.join(actualDirectory, ...relative.split("/")));
    if (!expected.equals(actual)) throw new Error(`${label} byte mismatch: ${relative}`);
  }
}

async function verifyFreshCompilation() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-stage-compile-"));
  const temporaryDist = path.join(temporaryRoot, "dist");
  try {
    await runDirect(process.execPath, [
      path.join(projectRoot, "node_modules", "typescript", "bin", "tsc"),
      "--project", path.join(projectRoot, "tsconfig.json"),
      "--outDir", temporaryDist,
    ], projectRoot);
    await compareDirectoryBytes(temporaryDist, path.join(projectRoot, "dist"), "dist fresh JavaScript compilation", relative => !relative.startsWith("native/"));
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

async function verifyDistIntegrity(buildInfo) {
  const manifestPath = path.join(projectRoot, "dist-integrity.json");
  const manifestBytes = await fs.readFile(manifestPath);
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  const native = await validateSec03NativeProjection(projectRoot, { buildInfo });
  if (typeof buildInfo.distIntegritySha256 !== "string" || !/^[a-f0-9]{64}$/.test(buildInfo.distIntegritySha256)
    || buildInfo.distIntegritySha256 !== sha256(manifestBytes)
    || manifest?.schemaVersion !== 2 || manifest?.sourceDigest !== buildInfo.sourceDigest || !Array.isArray(manifest.files)
    || JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(["files", "native", "schemaVersion", "sourceDigest"])
    || JSON.stringify(manifest.native) !== JSON.stringify(native)) {
    throw new Error("dist integrity manifest does not match build metadata and native identity");
  }
  const listed = new Map();
  for (const entry of manifest.files) {
    if (!entry || JSON.stringify(Object.keys(entry).sort()) !== JSON.stringify(["bytes", "path", "sha256"])
      || typeof entry.path !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || !Number.isInteger(entry.bytes) || entry.bytes < 0 || listed.has(entry.path)
      || path.posix.normalize(entry.path) !== entry.path || entry.path.startsWith("../")) {
      throw new Error("dist integrity manifest entry is invalid");
    }
    listed.set(entry.path, entry);
  }
  const actualPaths = (await listFiles(path.join(projectRoot, "dist")))
    .map((absolute) => path.relative(path.join(projectRoot, "dist"), absolute).replaceAll("\\", "/"))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (actualPaths.length !== listed.size || actualPaths.some((entry, index) => entry !== [...listed.keys()].sort((left, right) => left < right ? -1 : left > right ? 1 : 0)[index])) {
    throw new Error("dist files do not match integrity manifest");
  }
  for (const relative of actualPaths) {
    const bytes = await fs.readFile(path.join(projectRoot, "dist", ...relative.split("/")));
    const entry = listed.get(relative);
    if (entry.bytes !== bytes.length || entry.sha256 !== sha256(bytes)) throw new Error(`dist integrity mismatch: ${relative}`);
  }
}

function runDirect(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: "inherit", shell: false, windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} ${args.join(" ")} exited with ${code}`)));
  });
}

async function recordGovernedStagingInstall() {
  const markerPath = process.env.RAINYDAYS_GOV04_STAGING_INSTALL_MARKER;
  if (!markerPath) return;
  const fields = {
    schemaVersion: 1,
    role: "electron-staging",
    runId: process.env.RAINYDAYS_GOV04_RUN_ID,
    challenge: process.env.RAINYDAYS_GOV04_CHALLENGE,
    candidateId: process.env.RAINYDAYS_GOV04_CANDIDATE_ID,
    command: ["npm", "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"],
  };
  if (!/^[0-9a-f-]{36}$/.test(fields.runId || "") || !/^[a-f0-9]{64}$/.test(fields.challenge || "") || !/^[a-f0-9]{64}$/.test(fields.candidateId || "")) {
    throw new Error("GOV-04 staging install identity is invalid");
  }
  await fs.writeFile(markerPath, `${JSON.stringify(fields, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

await runDirect(process.execPath, [path.join(projectRoot, "scripts", "build-sec03-native.mjs"), "--check"], projectRoot);
await runDirect(process.execPath, [path.join(projectRoot, "scripts", "generate-build-info.mjs"), "--check"], projectRoot);

const sourcePackage = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
const buildInfo = JSON.parse(await fs.readFile(path.join(projectRoot, "build-info.json"), "utf8"));
if (buildInfo.appVersion !== sourcePackage.version) throw new Error("build-info appVersion does not match package.json version");
if (!/^[a-f0-9]{64}$/.test(buildInfo.candidateId)
  || !/^[a-f0-9]{64}$/.test(buildInfo.sourceDigest)
  || !/^[a-f0-9]{64}$/.test(buildInfo.distIntegritySha256 || "")
  || (buildInfo.buildIdSource !== "derived" && buildInfo.buildIdSource !== "ci")
  || (buildInfo.buildIdSource === "derived" && (buildInfo.buildId !== `${buildInfo.appVersion}+local.${buildInfo.sourceDigest.slice(0, 12)}` || buildInfo.candidateId !== buildInfo.sourceDigest))
  || (buildInfo.buildIdSource === "ci" && buildInfo.buildId !== `${buildInfo.appVersion}+ci.${buildInfo.candidateId}`)
  || buildInfo.versions?.databaseSchema !== 1 || buildInfo.versions?.sessionExport !== 1
  || buildInfo.versions?.executionIsolation?.architectureSha256 !== "849fc25a5e32eabdaa3b1285a14218f9877d46ecdc650a0e52a2120772e1cad1"
  || buildInfo.versions?.executionIsolation?.protocolVersion !== 1
  || !/^[a-f0-9]{64}$/.test(buildInfo.versions?.executionIsolation?.nativeSourceDigest || "")
  || !/^[a-f0-9]{64}$/.test(buildInfo.versions?.executionIsolation?.toolchainDigest || "")
  || buildInfo.versions?.executionIsolation?.signatureStatus !== "unsigned-local"
  || !Array.isArray(buildInfo.versions?.executionIsolation?.artifacts)
  || buildInfo.versions.executionIsolation.artifacts.length !== 2
  || buildInfo.versions?.executionIsolation?.testProjection?.manifest?.path !== ".sec03-native-test/sec03-native-test-manifest.json"
  || !Number.isSafeInteger(buildInfo.versions?.executionIsolation?.testProjection?.manifest?.bytes)
  || buildInfo.versions.executionIsolation.testProjection.manifest.bytes < 1
  || !/^[a-f0-9]{64}$/.test(buildInfo.versions?.executionIsolation?.testProjection?.manifest?.sha256 || "")
  || buildInfo.versions?.luxBaseline?.schemaVersion !== 1
  || buildInfo.versions?.luxBaseline?.targetVersion !== "0.1.898"
  || buildInfo.versions?.luxBaseline?.manifestSha256 !== "1126d7449fca392e64721d5e7e86169158bc8c72ea72f9d414fa0fe93ab445df") {
  throw new Error("build-info semantic contract is invalid for Electron staging");
}
await verifyFreshCompilation();
await verifyDistIntegrity(buildInfo);

await fs.rm(stageDir, { recursive: true, force: true });
await fs.mkdir(stageDir, { recursive: true });
await Promise.all(["dist", "electron", "public", "personas", "skills", "models", "scripts", "build"].map(copyDirectory));
await compareDirectoryBytes(path.join(projectRoot, "dist", "native"), path.join(stageDir, "dist", "native"), "SEC-03 staged native projection");
await fs.copyFile(path.join(projectRoot, "package-lock.json"), path.join(stageDir, "package-lock.json"));
await fs.copyFile(path.join(projectRoot, "build-info.json"), path.join(stageDir, "build-info.json"));
await fs.copyFile(path.join(projectRoot, "dist-integrity.json"), path.join(stageDir, "dist-integrity.json"));

const stagePackage = expectedElectronStagePackage(projectRoot, sourcePackage, buildInfo);
await fs.writeFile(path.join(stageDir, "package.json"), JSON.stringify(stagePackage, null, 2) + "\n");

console.log(`Installing isolated production dependencies in ${stageDir}`);
const governedNpmCli = process.env.RAINYDAYS_NPM_CLI_PATH || process.env.npm_execpath;
if (!governedNpmCli) throw new Error("npm CLI path is unavailable for Electron staging");
await recordGovernedStagingInstall();
await runDirect(process.execPath, [governedNpmCli, "ci", "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund"], stageDir);

// Transformers.js 2.x 静态导入 sharp，即使只运行文本模型也会加载 native binding。
// 正式版只启用文本 Embedding；用延迟失败的 JS 兼容层避免无用且不稳定的 Sharp native 重编。
const sharpDir = path.join(stageDir, "node_modules", "sharp");
await fs.rm(path.join(sharpDir, "build"), { recursive: true, force: true });
await fs.rm(path.join(sharpDir, "src"), { recursive: true, force: true });
await fs.rm(path.join(sharpDir, "binding.gyp"), { force: true });
await fs.writeFile(
  path.join(sharpDir, "lib", "index.js"),
  '"use strict";\nmodule.exports = function sharpTextRuntimeStub() { throw new Error("RainyDays 文本运行时未启用本地图像 Transformer"); };\n',
  "utf8"
);
const stageIdentity = await writeElectronStageManifest(projectRoot, stageDir);
console.log(`Electron staging app is ready: ${stageIdentity.canonicalPayloadSha256}`);
