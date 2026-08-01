import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";

export const sourceDirectories = Object.freeze([
  ".github",
  "build",
  "electron",
  "models",
  "native",
  "parity/policies",
  "parity/probes",
  "parity/schema",
  "parity/scripts",
  "personas",
  "public",
  "scripts",
  "skills",
  "src",
  "tests",
  "vendor",
]);

export const sourceFiles = Object.freeze([
  ".gitignore",
  ".gitleaks.toml",
  "LUX-DESKTOP-100-PARITY-EXECUTION-SPEC.md",
  "config.example.json",
  "models-manifest.json",
  "eslint.config.mjs",
  "package-lock.json",
  "package.json",
  "parity/BASELINE-DESIGN.md",
  "parity/GOV-02-VERSION-MODEL.md",
  "parity/GOV-03-TEST-ARCHITECTURE.md",
  "parity/GOV-04-CI-ARCHITECTURE.md",
  "parity/GOV-04-ARCHITECT-AMENDMENT-01.md",
  "parity/SEC-01-CAPABILITY-BROKER-ARCHITECTURE.md",
  "parity/SEC-02-PATH-POLICY-ARCHITECTURE.md",
  "parity/SEC-02-P36-RUNTIME-DIALECT-AMENDMENT-01.md",
  "parity/SEC-03-EXECUTION-ISOLATION-ARCHITECTURE.md",
  "parity/reports/sec-02-architect-freeze.json",
  "parity/reports/sec-02-p36-runtime-dialect-freeze.json",
  "parity/reports/sec-03-architect-freeze.json",
  "parity/README.md",
  "parity/baselines/lux-desktop-0.1.898.json",
  "tsconfig.json",
]);

export const sec03ArchitectureSha256 = "849fc25a5e32eabdaa3b1285a14218f9877d46ecdc650a0e52a2120772e1cad1";
export const sec03NativeManifestRelative = "dist/native/sec03-native-manifest.json";
export const sec03NativeBinaryRelatives = Object.freeze([
  "dist/native/sandbox-host.exe",
  "dist/native/sandbox-launcher.node",
]);
export const sec03NativeOutputRelatives = Object.freeze([
  ...sec03NativeBinaryRelatives,
  sec03NativeManifestRelative,
]);
export const sec03NativeTestManifestRelative = ".sec03-native-test/sec03-native-test-manifest.json";
export const sec03NativeTestBinaryRelatives = Object.freeze([
  ".sec03-native-test/sandbox-host.exe",
  ".sec03-native-test/sandbox-launcher.node",
]);
export const sec03NativeTestOutputRelatives = Object.freeze([
  ...sec03NativeTestBinaryRelatives,
  sec03NativeTestManifestRelative,
]);

const sha256Pattern = /^[a-f0-9]{64}$/u;
const sec03NativeSourceDomain = "mini-lux-sec03-native-source-v1";

export function toPosix(value) {
  return value.replaceAll("\\", "/");
}

function pathIdentity(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

async function listRegularFiles(directory, root) {
  const info = await lstat(directory);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Build input directory is not a regular directory: ${toPosix(path.relative(root, directory))}`);
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Build input must not contain links: ${toPosix(path.relative(root, absolute))}`);
    if (entry.isDirectory()) files.push(...await listRegularFiles(absolute, root));
    else if (entry.isFile()) files.push(absolute);
    else throw new Error(`Unsupported build input entry: ${toPosix(path.relative(root, absolute))}`);
  }
  return files;
}

export async function collectSourceFiles(projectRoot) {
  const rootReal = await realpath(projectRoot);
  const files = sourceFiles.map((relative) => path.join(projectRoot, ...relative.split("/")));
  for (const directory of sourceDirectories) files.push(...await listRegularFiles(path.join(projectRoot, ...directory.split("/")), projectRoot));
  const byIdentity = new Map();
  for (const absolute of files) {
    const info = await lstat(absolute);
    if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Build input is not a regular file: ${toPosix(path.relative(projectRoot, absolute))}`);
    const resolved = await realpath(absolute);
    const containment = path.relative(rootReal, resolved);
    if (!containment || containment === ".." || containment.startsWith(`..${path.sep}`) || path.isAbsolute(containment)) {
      throw new Error(`Build input escapes project root: ${toPosix(path.relative(projectRoot, absolute))}`);
    }
    const relative = toPosix(path.relative(projectRoot, absolute));
    const identity = pathIdentity(relative);
    if (byIdentity.has(identity) && byIdentity.get(identity) !== relative) throw new Error(`Build input case alias: ${relative}`);
    byIdentity.set(identity, relative);
  }
  return [...byIdentity.values()]
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0)
    .map((relative) => path.join(projectRoot, ...relative.split("/")));
}

export async function digestFiles(projectRoot, files, domain) {
  const hash = createHash("sha256");
  hash.update(`${domain}\0`, "utf8");
  for (const absolute of files) {
    const relativeBytes = Buffer.from(toPosix(path.relative(projectRoot, absolute)), "utf8");
    const bytes = await readFile(absolute);
    const frame = Buffer.alloc(12);
    frame.writeUInt32BE(relativeBytes.length, 0);
    frame.writeBigUInt64BE(BigInt(bytes.length), 4);
    hash.update(frame);
    hash.update(relativeBytes);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export async function sourceDigest(projectRoot, files = null) {
  const inputs = files ?? await collectSourceFiles(projectRoot);
  return digestFiles(projectRoot, inputs, "mini-lux-source-digest-v3");
}

export async function fileManifest(projectRoot, files) {
  const entries = [];
  for (const absolute of files) {
    const relative = toPosix(path.relative(projectRoot, absolute));
    const info = await stat(absolute);
    const bytes = await readFile(absolute);
    entries.push({ path: relative, bytes: info.size, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  return entries;
}

function exactKeys(value, expected, field) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) throw new Error(`${field} keys differ`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function digestElectronHeaders(versionRoot) {
  const records = [];
  async function walk(directory) {
    const info = await lstat(directory);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("SEC-03 Electron header tree contains a non-directory or link");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const info = await lstat(absolute);
        if (info.isSymbolicLink()) throw new Error("SEC-03 Electron header tree contains a link");
        const bytes = await readFile(absolute);
        records.push({ path: toPosix(path.relative(versionRoot, absolute)), bytes: bytes.length, sha256: sha256(bytes) });
      } else {
        throw new Error("SEC-03 Electron header tree contains a non-file entry");
      }
    }
  }
  await walk(path.join(versionRoot, "include", "node"));
  records.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const digest = createHash("sha256");
  digest.update("rainydays-electron-header-tree-v1\0");
  for (const record of records) digest.update(`${record.path}\0${record.bytes}\0${record.sha256}\0`);
  return { files: records.length, bytes: records.reduce((sum, record) => sum + record.bytes, 0), sha256: digest.digest("hex") };
}

function assertHash(value, field) {
  if (typeof value !== "string" || !sha256Pattern.test(value)) throw new Error(`${field} is invalid`);
}

function assertSafeRecord(record, expectedPath, field) {
  exactKeys(record, ["path", "bytes", "sha256"], field);
  if (record.path !== expectedPath || !Number.isSafeInteger(record.bytes) || record.bytes < 1) throw new Error(`${field} is invalid`);
  assertHash(record.sha256, `${field}.sha256`);
}

export function parsePeMachine(bytes, field = "SEC-03 native output") {
  if (!Buffer.isBuffer(bytes) || bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error(`${field} is not a PE image`);
  const peOffset = bytes.readUInt32LE(0x3c);
  if (peOffset < 0x40 || peOffset + 6 > bytes.length || bytes.readUInt32LE(peOffset) !== 0x4550) throw new Error(`${field} has invalid PE headers`);
  return bytes.readUInt16LE(peOffset + 4);
}

async function assertFileRecord(projectRoot, record, field) {
  const absolute = path.join(projectRoot, ...record.path.split("/"));
  const info = await lstat(absolute);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`${field} is not a regular file`);
  const bytes = await readFile(absolute);
  if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) throw new Error(`${field} byte identity differs`);
  return bytes;
}

async function nativeSourcePaths(projectRoot) {
  const directory = path.join(projectRoot, "native", "sandbox-host");
  const sources = (await listRegularFiles(directory, projectRoot))
    .map((absolute) => toPosix(path.relative(projectRoot, absolute)));
  sources.push("scripts/build-sec03-native.mjs");
  return sources.sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
}

async function validateToolRecord(record, field) {
  exactKeys(record, ["path", "bytes", "sha256", ...(field.endsWith("compiler") ? ["version"] : [])], field);
  if (typeof record.path !== "string" || record.path.length === 0 || !Number.isSafeInteger(record.bytes) || record.bytes < 1) throw new Error(`${field} is invalid`);
  assertHash(record.sha256, `${field}.sha256`);
  if (field.endsWith("compiler") && record.version !== "19.43.34808.0") throw new Error(`${field}.version is invalid`);
  const bytes = await readFile(record.path);
  if (bytes.length !== record.bytes || sha256(bytes) !== record.sha256) throw new Error(`${field} byte identity differs`);
}

export async function validateSec03NativeProjection(projectRoot, options = {}) {
  const nativeDirectory = path.join(projectRoot, "dist", "native");
  const directoryInfo = await lstat(nativeDirectory);
  if (directoryInfo.isSymbolicLink() || !directoryInfo.isDirectory()) throw new Error("SEC-03 native output directory is invalid");
  const actualPaths = (await listRegularFiles(nativeDirectory, projectRoot))
    .map((absolute) => toPosix(path.relative(projectRoot, absolute)))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const expectedPaths = [...sec03NativeOutputRelatives].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) throw new Error(`SEC-03 native output set mismatch: ${actualPaths.join(", ")}`);

  const manifestBytes = await readFile(path.join(projectRoot, ...sec03NativeManifestRelative.split("/")));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  exactKeys(manifest, ["schemaVersion", "architecture", "canonicalArguments", "outputs", "signatureStatus", "sourceDigest", "sourceFiles", "testProjection", "toolchain", "toolchainDigest"], "SEC-03 native manifest");
  if (manifest.schemaVersion !== 1 || manifest.architecture !== "x64" || manifest.signatureStatus !== "unsigned-local") throw new Error("SEC-03 native manifest semantic identity is invalid");
  assertHash(manifest.sourceDigest, "SEC-03 native sourceDigest");
  assertHash(manifest.toolchainDigest, "SEC-03 native toolchainDigest");
  exactKeys(manifest.testProjection, ["manifest"], "SEC-03 native testProjection");
  assertSafeRecord(manifest.testProjection.manifest, sec03NativeTestManifestRelative, "SEC-03 native testProjection.manifest");

  exactKeys(manifest.canonicalArguments, ["launcherCompile", "hostCompile"], "SEC-03 native canonicalArguments");
  for (const [name, args] of Object.entries(manifest.canonicalArguments)) {
    if (!Array.isArray(args) || args.length === 0 || args.some((entry) => typeof entry !== "string" || entry.length === 0)) throw new Error(`SEC-03 native ${name} is invalid`);
  }
  exactKeys(manifest.toolchain, ["architecture", "compiler", "electron", "electronHeaders", "linker", "msvc", "napi", "nodeImportLibrary", "sdk", "vsInstance"], "SEC-03 native toolchain");
  if (manifest.toolchain.architecture !== "x64" || manifest.toolchain.electron !== "43.1.1" || manifest.toolchain.msvc !== "14.43.34808"
    || manifest.toolchain.napi !== 8 || manifest.toolchain.sdk !== "10.0.22621.0") throw new Error("SEC-03 native pinned toolchain differs");
  exactKeys(manifest.toolchain.vsInstance, ["installationPath", "installationVersion", "productId"], "SEC-03 native toolchain.vsInstance");
  if (typeof manifest.toolchain.vsInstance.installationPath !== "string" || manifest.toolchain.vsInstance.installationVersion !== "17.13.35825.156"
    || !["Microsoft.VisualStudio.Product.BuildTools", "Microsoft.VisualStudio.Product.Community"].includes(manifest.toolchain.vsInstance.productId)) throw new Error("SEC-03 native Visual Studio identity is invalid");
  exactKeys(manifest.toolchain.electronHeaders, ["path", "files", "bytes", "sha256"], "SEC-03 native toolchain.electronHeaders");
  if (typeof manifest.toolchain.electronHeaders.path !== "string" || !path.isAbsolute(manifest.toolchain.electronHeaders.path)
    || manifest.toolchain.electronHeaders.files !== 124 || manifest.toolchain.electronHeaders.bytes !== 1570824
    || manifest.toolchain.electronHeaders.sha256 !== "956c2a3dda4622f75093a7adf5e19bbc09d760e166afb092e9d0e62be9e8873d") throw new Error("SEC-03 Electron header identity is invalid");
  const actualElectronHeaders = await digestElectronHeaders(manifest.toolchain.electronHeaders.path);
  if (JSON.stringify(actualElectronHeaders) !== JSON.stringify({ files: manifest.toolchain.electronHeaders.files, bytes: manifest.toolchain.electronHeaders.bytes, sha256: manifest.toolchain.electronHeaders.sha256 })) throw new Error("SEC-03 Electron header tree byte identity differs");
  await Promise.all([
    validateToolRecord(manifest.toolchain.compiler, "SEC-03 native toolchain.compiler"),
    validateToolRecord(manifest.toolchain.linker, "SEC-03 native toolchain.linker"),
    validateToolRecord(manifest.toolchain.nodeImportLibrary, "SEC-03 native toolchain.nodeImportLibrary"),
  ]);
  const actualToolchainDigest = sha256(Buffer.from(JSON.stringify({ toolchain: manifest.toolchain, canonicalArguments: manifest.canonicalArguments }), "utf8"));
  if (actualToolchainDigest !== manifest.toolchainDigest) throw new Error("SEC-03 native toolchain digest differs");

  if (!Array.isArray(manifest.sourceFiles) || manifest.sourceFiles.length === 0) throw new Error("SEC-03 native sourceFiles is invalid");
  const expectedSources = await nativeSourcePaths(projectRoot);
  const observedSources = [];
  const sourceHash = createHash("sha256");
  sourceHash.update(`${sec03NativeSourceDomain}\0`, "utf8");
  for (const [index, record] of manifest.sourceFiles.entries()) {
    if (!record || !expectedSources.includes(record.path)) throw new Error(`Unexpected SEC-03 native sourceFiles[${index}] path`);
    assertSafeRecord(record, record.path, `SEC-03 native sourceFiles[${index}]`);
    if (observedSources.includes(record.path)) throw new Error(`Duplicate SEC-03 native source: ${record.path}`);
    observedSources.push(record.path);
    await assertFileRecord(projectRoot, record, `SEC-03 native source ${record.path}`);
    sourceHash.update(`${record.path}\0${record.bytes}\0${record.sha256}\0`, "utf8");
  }
  if (JSON.stringify([...observedSources].sort()) !== JSON.stringify(expectedSources)) throw new Error("SEC-03 native source file set is stale");
  if (sourceHash.digest("hex") !== manifest.sourceDigest) throw new Error("SEC-03 native source digest differs");

  if (!Array.isArray(manifest.outputs) || manifest.outputs.length !== sec03NativeBinaryRelatives.length) throw new Error("SEC-03 native outputs are invalid");
  const binaries = [];
  for (const [index, expectedPath] of sec03NativeBinaryRelatives.entries()) {
    const record = manifest.outputs[index];
    exactKeys(record, ["path", "bytes", "sha256", "machine"], `SEC-03 native outputs[${index}]`);
    if (record.machine !== "AMD64") throw new Error(`SEC-03 native output machine differs: ${expectedPath}`);
    assertSafeRecord({ path: record.path, bytes: record.bytes, sha256: record.sha256 }, expectedPath, `SEC-03 native outputs[${index}]`);
    const bytes = await assertFileRecord(projectRoot, record, `SEC-03 native output ${expectedPath}`);
    if (parsePeMachine(bytes, expectedPath) !== 0x8664) throw new Error(`${expectedPath} is not AMD64 PE`);
    binaries.push(Object.freeze({ path: expectedPath, bytes: bytes.length, sha256: sha256(bytes), machine: "AMD64" }));
  }

  const testProjection = Object.freeze({
    manifest: Object.freeze({ ...manifest.testProjection.manifest }),
  });
  if (options.buildInfo) {
    const isolation = options.buildInfo.versions?.executionIsolation;
    if (isolation) {
      exactKeys(isolation, ["architectureSha256", "protocolVersion", "nativeSourceDigest", "toolchainDigest", "signatureStatus", "artifacts", "testProjection"], "build-info SEC-03 executionIsolation");
      exactKeys(isolation.testProjection, ["manifest"], "build-info SEC-03 testProjection");
      assertSafeRecord(isolation.testProjection.manifest, sec03NativeTestManifestRelative, "build-info SEC-03 testProjection.manifest");
    }
    if (!isolation || isolation.architectureSha256 !== sec03ArchitectureSha256 || isolation.protocolVersion !== 1
      || isolation.nativeSourceDigest !== manifest.sourceDigest || isolation.toolchainDigest !== manifest.toolchainDigest
      || isolation.signatureStatus !== manifest.signatureStatus || JSON.stringify(isolation.artifacts) !== JSON.stringify(binaries)
      || isolation.testProjection.manifest.bytes !== testProjection.manifest.bytes
      || isolation.testProjection.manifest.sha256 !== testProjection.manifest.sha256) {
      throw new Error("build-info SEC-03 native identity differs from current outputs");
    }
  }

  return Object.freeze({
    architectureSha256: sec03ArchitectureSha256,
    manifest: Object.freeze({ path: sec03NativeManifestRelative, bytes: manifestBytes.length, sha256: sha256(manifestBytes) }),
    sourceDigest: manifest.sourceDigest,
    toolchainDigest: manifest.toolchainDigest,
    signatureStatus: manifest.signatureStatus,
    binaries: Object.freeze(binaries),
    testProjection,
  });
}

function expectedTestCompileArguments(argumentsList, field) {
  const linkIndexes = argumentsList.flatMap((entry, index) => entry === "/link" ? [index] : []);
  if (linkIndexes.length !== 1 || argumentsList.includes("/DMINI_LUX_SEC03_NATIVE_TEST")) {
    throw new Error(`${field} cannot derive the SEC-03 native test argument identity`);
  }
  const linkIndex = linkIndexes[0];
  return [...argumentsList.slice(0, linkIndex), "/DMINI_LUX_SEC03_NATIVE_TEST", ...argumentsList.slice(linkIndex)];
}

export async function validateSec03NativeTestProjection(projectRoot, options = {}) {
  if (!options.buildInfo) throw new Error("build-info is required for SEC-03 native test projection validation");
  const production = await validateSec03NativeProjection(projectRoot, { buildInfo: options.buildInfo });
  const productionManifestBytes = await readFile(path.join(projectRoot, ...sec03NativeManifestRelative.split("/")));
  if (productionManifestBytes.length !== production.manifest.bytes || sha256(productionManifestBytes) !== production.manifest.sha256) {
    throw new Error("SEC-03 native manifest changed during test projection validation");
  }
  const productionManifest = JSON.parse(productionManifestBytes.toString("utf8"));
  if (JSON.stringify(productionManifest.testProjection) !== JSON.stringify(production.testProjection)) {
    throw new Error("SEC-03 native test projection commitment differs");
  }

  const testDirectory = path.join(projectRoot, ".sec03-native-test");
  const testDirectoryInfo = await lstat(testDirectory);
  if (testDirectoryInfo.isSymbolicLink() || !testDirectoryInfo.isDirectory()) throw new Error("SEC-03 native test output directory is invalid");
  const actualPaths = (await listRegularFiles(testDirectory, projectRoot))
    .map((absolute) => toPosix(path.relative(projectRoot, absolute)))
    .sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  const expectedPaths = [...sec03NativeTestOutputRelatives].sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  if (JSON.stringify(actualPaths) !== JSON.stringify(expectedPaths)) throw new Error(`SEC-03 native test output set mismatch: ${actualPaths.join(", ")}`);

  const committedManifest = production.testProjection.manifest;
  const testManifestBytes = await assertFileRecord(projectRoot, committedManifest, "SEC-03 native test manifest");
  const testManifest = JSON.parse(testManifestBytes.toString("utf8"));
  exactKeys(testManifest, ["schemaVersion", "architecture", "canonicalArguments", "outputs", "sourceDigest", "toolchainDigest"], "SEC-03 native test manifest");
  if (testManifest.schemaVersion !== 1 || testManifest.architecture !== "x64"
    || testManifest.sourceDigest !== production.sourceDigest || testManifest.toolchainDigest !== production.toolchainDigest) {
    throw new Error("SEC-03 native test manifest identity differs from production");
  }

  exactKeys(testManifest.canonicalArguments, ["launcherCompile", "hostCompile"], "SEC-03 native test canonicalArguments");
  for (const name of ["launcherCompile", "hostCompile"]) {
    const productionArguments = productionManifest.canonicalArguments[name];
    const testArguments = testManifest.canonicalArguments[name];
    if (!Array.isArray(productionArguments) || !Array.isArray(testArguments)
      || JSON.stringify(testArguments) !== JSON.stringify(expectedTestCompileArguments(productionArguments, `SEC-03 native ${name}`))) {
      throw new Error(`SEC-03 native test ${name} differs from the one allowed test define`);
    }
  }

  if (!Array.isArray(testManifest.outputs) || testManifest.outputs.length !== sec03NativeTestBinaryRelatives.length) {
    throw new Error("SEC-03 native test outputs are invalid");
  }
  const binaries = [];
  for (const [index, expectedPath] of sec03NativeTestBinaryRelatives.entries()) {
    const record = testManifest.outputs[index];
    exactKeys(record, ["path", "bytes", "sha256", "machine"], `SEC-03 native test outputs[${index}]`);
    if (record.machine !== "AMD64") throw new Error(`SEC-03 native test output machine differs: ${expectedPath}`);
    assertSafeRecord({ path: record.path, bytes: record.bytes, sha256: record.sha256 }, expectedPath, `SEC-03 native test outputs[${index}]`);
    const bytes = await assertFileRecord(projectRoot, record, `SEC-03 native test output ${expectedPath}`);
    if (parsePeMachine(bytes, expectedPath) !== 0x8664) throw new Error(`${expectedPath} is not AMD64 PE`);
    binaries.push(Object.freeze({ path: expectedPath, bytes: bytes.length, sha256: sha256(bytes), machine: "AMD64" }));
  }

  return Object.freeze({
    manifest: Object.freeze({ ...committedManifest }),
    binaries: Object.freeze(binaries),
    addon: binaries[1],
  });
}
