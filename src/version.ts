import { getBootstrapPathStore } from "./bootstrap-path-store.js";

export interface ProtocolCapability {
  version: number | null;
  enabled: boolean;
  transport: string | null;
}

export interface BuildInfo {
  schemaVersion: 1;
  product: "RainyDays";
  appVersion: string;
  buildId: string;
  buildIdSource: "derived" | "ci";
  candidateId: string;
  sourceDigest: string;
  distIntegritySha256: string | null;
  builtAt: string;
  versions: {
    databaseSchema: number;
    sessionExport: number;
    executionIsolation: {
      architectureSha256: string;
      protocolVersion: number;
      nativeSourceDigest: string;
      toolchainDigest: string;
      signatureStatus: "unsigned-local";
      artifacts: readonly Readonly<{ path: string; bytes: number; sha256: string; machine: "AMD64" }>[];
      testProjection: Readonly<{ manifest: Readonly<{ path: string; bytes: number; sha256: string }> }>;
    };
    protocols: {
      link: ProtocolCapability;
      worker: ProtocolCapability;
      mcp: ProtocolCapability;
    };
    luxBaseline: {
      schemaVersion: number;
      targetVersion: string;
      manifestSha256: string;
    };
  };
}

const semverPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const hashPattern = /^[a-f0-9]{64}$/;
const buildIdPattern = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;
const SUPPORTED_DATABASE_SCHEMA_VERSION = 1;
const SUPPORTED_SESSION_EXPORT_VERSION = 1;
const EXPECTED_BASELINE = Object.freeze({
  schemaVersion: 1,
  targetVersion: "0.1.898",
  manifestSha256: "1126d7449fca392e64721d5e7e86169158bc8c72ea72f9d414fa0fe93ab445df",
});

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value);
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[], field: string): void {
  const allowedSet = new Set(allowed);
  const missing = allowed.filter((key) => !Object.hasOwn(value, key));
  const extra = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (missing.length > 0 || extra.length > 0) throw new Error(`build-info ${field} fields are invalid`);
}

function assertProtocol(name: string, value: unknown): asserts value is ProtocolCapability {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`build-info protocol ${name} is missing`);
  assertExactKeys(value as Record<string, unknown>, ["version", "enabled", "transport"], `protocol ${name}`);
  const capability = value as Record<string, unknown>;
  if (typeof capability.enabled !== "boolean") throw new Error(`build-info protocol ${name}.enabled is invalid`);
  if (capability.version !== null && (!Number.isInteger(capability.version) || Number(capability.version) < 1)) {
    throw new Error(`build-info protocol ${name}.version is invalid`);
  }
  if (capability.enabled && capability.version === null) throw new Error(`build-info protocol ${name} is enabled without a version`);
  if (!capability.enabled && capability.version !== null) throw new Error(`build-info protocol ${name} is disabled but advertises a version`);
  if (capability.transport !== null && typeof capability.transport !== "string") throw new Error(`build-info protocol ${name}.transport is invalid`);
}

function validateBuildInfo(value: unknown): BuildInfo {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("build-info must be an object");
  const info = value as Partial<BuildInfo>;
  assertExactKeys(info as Record<string, unknown>, ["schemaVersion", "product", "appVersion", "buildId", "buildIdSource", "candidateId", "sourceDigest", "distIntegritySha256", "builtAt", "versions"], "root");
  if (info.schemaVersion !== 1 || info.product !== "RainyDays") throw new Error("build-info identity/schema is invalid");
  if (typeof info.appVersion !== "string" || !semverPattern.test(info.appVersion)) throw new Error("build-info appVersion is invalid");
  if (typeof info.buildId !== "string" || !buildIdPattern.test(info.buildId)) throw new Error("build-info buildId is invalid");
  if (info.buildIdSource !== "derived" && info.buildIdSource !== "ci") throw new Error("build-info buildIdSource is invalid");
  if (typeof info.candidateId !== "string" || !hashPattern.test(info.candidateId)) throw new Error("build-info candidateId is invalid");
  if (typeof info.sourceDigest !== "string" || !hashPattern.test(info.sourceDigest)) throw new Error("build-info sourceDigest is invalid");
  if (info.distIntegritySha256 !== null && (typeof info.distIntegritySha256 !== "string" || !hashPattern.test(info.distIntegritySha256))) {
    throw new Error("build-info distIntegritySha256 is invalid");
  }
  if (info.buildIdSource === "derived" && (info.buildId !== `${info.appVersion}+local.${info.sourceDigest.slice(0, 12)}` || info.candidateId !== info.sourceDigest)) {
    throw new Error("build-info derived identity does not match sourceDigest");
  }
  if (info.buildIdSource === "ci" && info.buildId !== `${info.appVersion}+ci.${info.candidateId}`) throw new Error("build-info CI identity is inconsistent");
  if (typeof info.builtAt !== "string") throw new Error("build-info builtAt is invalid");
  const builtAtDate = new Date(info.builtAt);
  if (Number.isNaN(builtAtDate.getTime()) || builtAtDate.toISOString() !== info.builtAt) throw new Error("build-info builtAt is invalid");
  if (!info.versions || typeof info.versions !== "object") throw new Error("build-info versions are missing");
  assertExactKeys(info.versions as unknown as Record<string, unknown>, ["databaseSchema", "sessionExport", "executionIsolation", "protocols", "luxBaseline"], "versions");
  if (info.versions.databaseSchema !== SUPPORTED_DATABASE_SCHEMA_VERSION) throw new Error("build-info database schema version is unsupported");
  if (info.versions.sessionExport !== SUPPORTED_SESSION_EXPORT_VERSION) throw new Error("build-info Session Export version is unsupported");
  const isolation = info.versions.executionIsolation;
  if (!isolation || typeof isolation !== "object") throw new Error("build-info execution isolation metadata is missing");
  assertExactKeys(isolation as unknown as Record<string, unknown>, ["architectureSha256", "protocolVersion", "nativeSourceDigest", "toolchainDigest", "signatureStatus", "artifacts", "testProjection"], "execution isolation");
  if (!hashPattern.test(isolation.architectureSha256) || isolation.protocolVersion !== 1 || !hashPattern.test(isolation.nativeSourceDigest)
    || !hashPattern.test(isolation.toolchainDigest) || isolation.signatureStatus !== "unsigned-local" || !Array.isArray(isolation.artifacts) || isolation.artifacts.length !== 2) throw new Error("build-info execution isolation metadata is invalid");
  for (const artifact of isolation.artifacts) {
    assertExactKeys(artifact as unknown as Record<string, unknown>, ["path", "bytes", "sha256", "machine"], "execution isolation artifact");
    if (typeof artifact.path !== "string" || !Number.isSafeInteger(artifact.bytes) || artifact.bytes < 1 || !hashPattern.test(artifact.sha256) || artifact.machine !== "AMD64") throw new Error("build-info execution isolation artifact is invalid");
  }
  const testProjection = isolation.testProjection;
  if (!testProjection || typeof testProjection !== "object" || Array.isArray(testProjection)) throw new Error("build-info execution isolation test projection is invalid");
  assertExactKeys(testProjection as unknown as Record<string, unknown>, ["manifest"], "execution isolation test projection");
  const testManifest = testProjection.manifest;
  if (!testManifest || typeof testManifest !== "object" || Array.isArray(testManifest)) throw new Error("build-info execution isolation test projection is invalid");
  assertExactKeys(testManifest as unknown as Record<string, unknown>, ["path", "bytes", "sha256"], "execution isolation test projection manifest");
  if (testManifest.path !== ".sec03-native-test/sec03-native-test-manifest.json" || !Number.isSafeInteger(testManifest.bytes)
    || testManifest.bytes < 1 || !hashPattern.test(testManifest.sha256)) throw new Error("build-info execution isolation test projection is invalid");
  if (!info.versions.protocols || typeof info.versions.protocols !== "object") throw new Error("build-info protocols are missing");
  assertExactKeys(info.versions.protocols as unknown as Record<string, unknown>, ["link", "worker", "mcp"], "protocols");
  assertProtocol("link", info.versions.protocols?.link);
  assertProtocol("worker", info.versions.protocols?.worker);
  assertProtocol("mcp", info.versions.protocols?.mcp);
  const protocols = info.versions.protocols;
  if (protocols.link.version !== 1 || !protocols.link.enabled || protocols.link.transport !== "in-process"
    || protocols.worker.version !== null || protocols.worker.enabled || protocols.worker.transport !== null
    || protocols.mcp.version !== null || protocols.mcp.enabled || protocols.mcp.transport !== null) {
    throw new Error("build-info protocol capability registry is unsupported");
  }
  const baseline = info.versions.luxBaseline;
  if (!baseline || typeof baseline !== "object") throw new Error("build-info Lux baseline metadata is missing");
  assertExactKeys(baseline as unknown as Record<string, unknown>, ["schemaVersion", "targetVersion", "manifestSha256"], "Lux baseline");
  if (baseline.schemaVersion !== EXPECTED_BASELINE.schemaVersion
    || baseline.targetVersion !== EXPECTED_BASELINE.targetVersion
    || baseline.manifestSha256 !== EXPECTED_BASELINE.manifestSha256) {
    throw new Error("build-info Lux baseline metadata is unsupported");
  }
  return deepFreeze(info as BuildInfo);
}

async function loadBuildInfo(): Promise<BuildInfo> {
  const store = getBootstrapPathStore();
  let raw: string;
  let packageRaw: string;
  try {
    [raw, packageRaw] = await Promise.all([
      store.readAppFile("build-info.json"),
      store.readAppFile("package.json"),
    ]).then((values) => values.map((value) => value.toString("utf8")) as [string, string]);
  } catch {
    throw new Error("RainyDays build metadata is missing or inaccessible");
  }
  try {
    const info = validateBuildInfo(JSON.parse(raw));
    const packageJson = JSON.parse(packageRaw) as { version?: unknown };
    if (packageJson.version !== info.appVersion) throw new Error(`package.json version ${String(packageJson.version)} does not match ${info.appVersion}`);
    return info;
  } catch (error) {
    throw new Error(`RainyDays build metadata is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export const BUILD_INFO = await loadBuildInfo();
export const APP_VERSION = BUILD_INFO.appVersion;
export const BUILD_ID = BUILD_INFO.buildId;
export const DATABASE_SCHEMA_VERSION = SUPPORTED_DATABASE_SCHEMA_VERSION;
export const SESSION_EXPORT_VERSION = SUPPORTED_SESSION_EXPORT_VERSION;
export const PROTOCOL_CAPABILITIES = BUILD_INFO.versions.protocols;

export function getPublicVersionInfo(): BuildInfo {
  return structuredClone(BUILD_INFO);
}
