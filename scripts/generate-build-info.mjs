import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { collectSourceFiles, sourceDigest } from "./build-inputs.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = path.join(projectRoot, "build-info.json");
const baselineRelative = "parity/baselines/lux-desktop-0.1.898.json";
const expectedBaselineSha256 = "1126d7449fca392e64721d5e7e86169158bc8c72ea72f9d414fa0fe93ab445df";
const buildIdPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const sec03ArchitectureSha256 = "849fc25a5e32eabdaa3b1285a14218f9877d46ecdc650a0e52a2120772e1cad1";
const hashPattern = /^[a-f0-9]{64}$/;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

async function main() {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  if (typeof packageJson.version !== "string" || !semverPattern.test(packageJson.version)) {
    throw new Error("package.json.version must be a valid SemVer release version");
  }
  const nativeManifest = JSON.parse(await readFile(path.join(projectRoot, "dist", "native", "sec03-native-manifest.json"), "utf8"));
  const nativeOutputs = Array.isArray(nativeManifest.outputs) ? nativeManifest.outputs : [];
  const expectedNativePaths = ["dist/native/sandbox-host.exe", "dist/native/sandbox-launcher.node"];
  if (nativeManifest.schemaVersion !== 1 || nativeManifest.architecture !== "x64"
    || !hashPattern.test(nativeManifest.sourceDigest || "") || !hashPattern.test(nativeManifest.toolchainDigest || "")
    || nativeManifest.signatureStatus !== "unsigned-local" || nativeOutputs.length !== expectedNativePaths.length
    || nativeOutputs.some((entry, index) => !entry || entry.path !== expectedNativePaths[index]
      || entry.machine !== "AMD64" || !Number.isSafeInteger(entry.bytes) || entry.bytes < 1 || !hashPattern.test(entry.sha256 || ""))) {
    throw new Error("SEC-03 native manifest is missing, stale, or has an invalid artifact identity");
  }

  const baselinePath = path.join(projectRoot, ...baselineRelative.split("/"));
  const baselineBytes = await readFile(baselinePath);
  const baselineHash = sha256(baselineBytes);
  if (baselineHash !== expectedBaselineSha256) {
    throw new Error(`Locked GOV-01 baseline hash mismatch: expected ${expectedBaselineSha256}, found ${baselineHash}`);
  }
  const baseline = JSON.parse(baselineBytes.toString("utf8"));
  if (baseline?.target?.version !== "0.1.898" || baseline?.schemaVersion !== 1) {
    throw new Error("Locked GOV-01 baseline target/schema version is incompatible with GOV-02");
  }

  const files = await collectSourceFiles(projectRoot);
  const digest = await sourceDigest(projectRoot, files);
  const suppliedBuildId = process.env.RAINYDAYS_BUILD_ID;
  if (suppliedBuildId !== undefined && !buildIdPattern.test(suppliedBuildId)) {
    throw new Error("RAINYDAYS_BUILD_ID contains unsupported characters or exceeds 128 characters");
  }
  const buildIdSource = suppliedBuildId !== undefined ? "ci" : "derived";
  const buildId = suppliedBuildId ?? `${packageJson.version}+local.${digest.slice(0, 12)}`;
  const escapedVersion = packageJson.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const ciCandidate = suppliedBuildId?.match(new RegExp(`^${escapedVersion}\\+ci\\.([a-f0-9]{64})$`));
  if (buildIdSource === "ci" && !ciCandidate) throw new Error("CI Build ID must bind one canonical GOV-04 candidate ID");
  const candidateId = ciCandidate?.[1] ?? digest;
  let builtAt;
  if (process.env.SOURCE_DATE_EPOCH) {
    const epoch = Number(process.env.SOURCE_DATE_EPOCH);
    if (!Number.isFinite(epoch)) throw new Error("SOURCE_DATE_EPOCH is invalid");
    builtAt = new Date(epoch * 1000).toISOString();
  } else {
    builtAt = new Date().toISOString();
  }

  const buildInfo = {
    schemaVersion: 1,
    product: "RainyDays",
    appVersion: packageJson.version,
    buildId,
    buildIdSource,
    candidateId,
    sourceDigest: digest,
    distIntegritySha256: null,
    builtAt,
    versions: {
      databaseSchema: 1,
      sessionExport: 1,
      executionIsolation: {
        architectureSha256: sec03ArchitectureSha256,
        protocolVersion: 1,
        nativeSourceDigest: nativeManifest.sourceDigest,
        toolchainDigest: nativeManifest.toolchainDigest,
        signatureStatus: nativeManifest.signatureStatus,
        artifacts: nativeOutputs.map((entry) => ({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256, machine: entry.machine })),
      },
      protocols: {
        link: { version: 1, enabled: true, transport: "in-process" },
        worker: { version: null, enabled: false, transport: null },
        mcp: { version: null, enabled: false, transport: null },
      },
      luxBaseline: {
        schemaVersion: baseline.schemaVersion,
        targetVersion: baseline.target.version,
        manifestSha256: baselineHash,
      },
    },
  };

  if (process.argv.includes("--check")) {
    const existing = JSON.parse(await readFile(outputPath, "utf8"));
    if (typeof existing.builtAt !== "string") throw new Error("Existing build-info builtAt is invalid");
    const existingBuiltAt = new Date(existing.builtAt);
    if (Number.isNaN(existingBuiltAt.getTime()) || existingBuiltAt.toISOString() !== existing.builtAt) throw new Error("Existing build-info builtAt is invalid");
    const comparableExisting = { ...existing, builtAt: buildInfo.builtAt };
    if (typeof comparableExisting.distIntegritySha256 !== "string" && comparableExisting.distIntegritySha256 !== null) {
      throw new Error("Existing build-info distIntegritySha256 is invalid");
    }
    comparableExisting.distIntegritySha256 = buildInfo.distIntegritySha256;
    if (JSON.stringify(canonicalize(comparableExisting)) !== JSON.stringify(canonicalize(buildInfo))) {
      throw new Error("Existing build-info does not match current build inputs");
    }
    console.log(JSON.stringify({ checked: outputPath, appVersion: buildInfo.appVersion, buildId, candidateId, sourceDigest: digest, inputFiles: files.length }, null, 2));
    return;
  }

  await writeFile(outputPath, JSON.stringify(buildInfo, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({ output: outputPath, appVersion: buildInfo.appVersion, buildId, candidateId, sourceDigest: digest, inputFiles: files.length }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
