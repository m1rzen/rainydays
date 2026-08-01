import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const checkOnly = process.argv.slice(2).includes("--check");
if (process.argv.slice(2).some((arg) => arg !== "--check")) throw new Error("Usage: node scripts/build-sec03-native.mjs [--check]");
if (process.platform !== "win32" || process.arch !== "x64") throw new Error("SEC-03 native build requires Windows x64");

const versions = Object.freeze({ msvc: "14.43.34808", sdk: "10.0.22621.0", electron: "43.1.1", napi: 8, machine: 0x8664 });
const sourceRelative = Object.freeze([
  "native/sandbox-host/protocol.h",
  "native/sandbox-host/journal.h",
  "native/sandbox-host/attestation.h",
  "native/sandbox-host/sandbox-host.cpp",
  "native/sandbox-host/sandbox-launcher.cpp",
  "scripts/build-sec03-native.mjs",
]);
const outputRelative = Object.freeze([
  "dist/native/sandbox-host.exe",
  "dist/native/sandbox-launcher.node",
]);
const manifestRelative = "dist/native/sec03-native-manifest.json";
const testOutputRelative = Object.freeze([
  ".sec03-native-test/sandbox-host.exe",
  ".sec03-native-test/sandbox-launcher.node",
]);
const testManifestRelative = ".sec03-native-test/sec03-native-test-manifest.json";

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, { cwd: projectRoot, encoding: "utf8", windowsHide: true, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${path.basename(executable)} failed (${result.status})\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  return `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
}

function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }
async function fileRecord(relative) {
  const bytes = await readFile(path.join(projectRoot, ...relative.split("/")));
  return { path: relative, bytes: bytes.length, sha256: sha256(bytes) };
}
async function digestRecords(records, domain) {
  const hash = createHash("sha256");
  hash.update(`${domain}\0`);
  for (const record of records) hash.update(`${record.path}\0${record.bytes}\0${record.sha256}\0`);
  return hash.digest("hex");
}
async function electronHeaderTree(versionRoot) {
  const records = [];
  async function walk(directory) {
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Electron header tree contains a non-directory or link");
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(absolute);
      } else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        records.push({ path: path.relative(versionRoot, absolute).replaceAll("\\", "/"), bytes: bytes.length, sha256: sha256(bytes) });
      } else {
        throw new Error("Electron header tree contains a non-file entry");
      }
    }
  }
  await walk(path.join(versionRoot, "include", "node"));
  records.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const bytes = records.reduce((sum, record) => sum + record.bytes, 0);
  const digest = await digestRecords(records, "rainydays-electron-header-tree-v1");
  return { path: versionRoot, files: records.length, bytes, sha256: digest };
}
function parsePeMachine(bytes) {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error("Output is not a PE image");
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 0x40 || pe + 6 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550) throw new Error("Output has invalid PE headers");
  return bytes.readUInt16LE(pe + 4);
}

const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
const vswhere = path.join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
const instances = JSON.parse(run(vswhere, ["-products", "*", "-version", "[17.0,18.0)", "-format", "json", "-utf8"]));
if (!Array.isArray(instances) || instances.length !== 1) throw new Error(`Expected exactly one eligible Visual Studio 2022 instance, found ${instances.length}`);
const vsInstance = instances[0];
const allowedVsProducts = new Set(["Microsoft.VisualStudio.Product.BuildTools", "Microsoft.VisualStudio.Product.Community"]);
if (!allowedVsProducts.has(vsInstance.productId) || vsInstance.installationVersion !== "17.13.35825.156") throw new Error("Pinned Visual Studio 2022 instance identity differs");
const vsRoot = vsInstance.installationPath;
const msvcRoot = path.join(vsRoot, "VC", "Tools", "MSVC", versions.msvc);
const toolBin = path.join(msvcRoot, "bin", "Hostx64", "x64");
const cl = path.join(toolBin, "cl.exe");
const link = path.join(toolBin, "link.exe");
const sdkRoot = path.join(programFilesX86, "Windows Kits", "10");
const electronCache = path.join(process.env.USERPROFILE ?? "", ".electron-gyp", versions.electron);
const nodeInclude = path.join(electronCache, "include", "node");
const nodeLib = path.join(electronCache, "x64", "node.lib");

const required = [cl, link, nodeLib, path.join(nodeInclude, "node_api.h"),
  path.join(sdkRoot, "Include", versions.sdk, "um", "Windows.h"),
  path.join(sdkRoot, "Lib", versions.sdk, "um", "x64", "kernel32.lib")];
for (const file of required) await stat(file).catch(() => { throw new Error(`Pinned SEC-03 native dependency missing: ${file}`); });
const electronHeaders = await electronHeaderTree(electronCache);
if (electronHeaders.files !== 124 || electronHeaders.bytes !== 1570824 || electronHeaders.sha256 !== "956c2a3dda4622f75093a7adf5e19bbc09d760e166afb092e9d0e62be9e8873d") {
  throw new Error("Pinned Electron 43.1.1 header tree identity differs");
}

const include = [
  path.join(msvcRoot, "include"),
  path.join(sdkRoot, "Include", versions.sdk, "ucrt"),
  path.join(sdkRoot, "Include", versions.sdk, "shared"),
  path.join(sdkRoot, "Include", versions.sdk, "um"),
  path.join(sdkRoot, "Include", versions.sdk, "winrt"),
  nodeInclude,
];
const lib = [
  path.join(msvcRoot, "lib", "x64"),
  path.join(sdkRoot, "Lib", versions.sdk, "ucrt", "x64"),
  path.join(sdkRoot, "Lib", versions.sdk, "um", "x64"),
];
const buildEnv = {
  ...process.env,
  INCLUDE: include.join(";"),
  LIB: lib.join(";"),
  LIBPATH: lib.join(";"),
  PATH: `${toolBin};${path.join(sdkRoot, "bin", versions.sdk, "x64")};${process.env.SystemRoot}\\System32`,
};

const common = Object.freeze(["/nologo", "/std:c++20", "/EHsc", "/O2", "/GL", "/GS", "/guard:cf", "/Gy", "/MD", "/W4", "/WX", "/DUNICODE", "/D_UNICODE", "/DNOMINMAX"]);
const canonicalArguments = Object.freeze({
  launcherCompile: [...common, `/DNAPI_VERSION=${versions.napi}`, "/LD", "native/sandbox-host/sandbox-launcher.cpp", "/link", "advapi32.lib", "bcrypt.lib", "crypt32.lib", "userenv.lib", "shell32.lib", "ole32.lib", "delayimp.lib", "/DELAYLOAD:node.exe", nodeLib, "/OPT:REF", "/OPT:ICF", "/DYNAMICBASE", "/NXCOMPAT", "/HIGHENTROPYVA", "/MACHINE:X64"],
  hostCompile: [...common, "native/sandbox-host/sandbox-host.cpp", "/link", "advapi32.lib", "bcrypt.lib", "crypt32.lib", "userenv.lib", "shell32.lib", "ole32.lib", "/OPT:REF", "/OPT:ICF", "/DYNAMICBASE", "/NXCOMPAT", "/HIGHENTROPYVA", "/MACHINE:X64", "/SUBSYSTEM:CONSOLE"],
});
function testArguments(args) {
  const link = args.indexOf("/link");
  return [...args.slice(0, link), "/DMINI_LUX_SEC03_NATIVE_TEST", ...args.slice(link)];
}
const canonicalTestArguments = Object.freeze({
  launcherCompile: testArguments(canonicalArguments.launcherCompile),
  hostCompile: testArguments(canonicalArguments.hostCompile),
});

const sourceFiles = await Promise.all(sourceRelative.map(fileRecord));
const sourceDigest = await digestRecords(sourceFiles, "mini-lux-sec03-native-source-v1");
const compiler = await fileRecord(path.relative(projectRoot, cl).replaceAll("\\", "/")).catch(async () => {
  const bytes = await readFile(cl); return { path: cl, bytes: bytes.length, sha256: sha256(bytes) };
});
const linker = await (async () => { const bytes = await readFile(link); return { path: link, bytes: bytes.length, sha256: sha256(bytes) }; })();
const probeId = randomUUID();
const probeSource = path.join(os.tmpdir(), `rainydays-cl-probe-${probeId}.cpp`);
const probeObject = path.join(os.tmpdir(), `rainydays-cl-probe-${probeId}.obj`);
await writeFile(probeSource, "int rainydays_toolchain_probe;", { flag: "wx" });
let versionProbe;
try {
  versionProbe = spawnSync(cl, ["/nologo", "/Bv", "/c", probeSource, `/Fo${probeObject}`], { cwd: projectRoot, encoding: "utf8", windowsHide: true, env: buildEnv });
} finally {
  await Promise.all([rm(probeSource, { force: true }), rm(probeObject, { force: true })]);
}
if (versionProbe.error || versionProbe.status !== 0) throw new Error(`Pinned MSVC compiler version probe failed (${versionProbe.status ?? "spawn"})`);
const versionText = `${versionProbe.stdout ?? ""}${versionProbe.stderr ?? ""}`;
const versionMatch = versionText.match(/\\cl\.exe:[^\r\n]*19\.43\.34808\.0\s*$/im);
if (!versionMatch) throw new Error("Pinned MSVC compiler version probe did not report the exact cl.exe 19.43.34808.0 identity");
const compilerVersion = "19.43.34808.0";
const toolchain = {
  architecture: "x64",
  compiler: { path: cl, bytes: compiler.bytes, sha256: compiler.sha256, version: compilerVersion },
  electron: versions.electron,
  electronHeaders,
  linker: { path: link, bytes: linker.bytes, sha256: linker.sha256 },
  msvc: versions.msvc,
  napi: versions.napi,
  nodeImportLibrary: await (async () => { const bytes = await readFile(nodeLib); return { path: nodeLib, bytes: bytes.length, sha256: sha256(bytes) }; })(),
  sdk: versions.sdk,
  vsInstance: { installationPath: vsRoot, installationVersion: vsInstance.installationVersion, productId: vsInstance.productId },
};
const toolchainDigest = sha256(Buffer.from(JSON.stringify({ toolchain, canonicalArguments })));

async function outputRecords(relativePaths) {
  const outputs = [];
  for (const relative of relativePaths) {
    const record = await fileRecord(relative);
    const bytes = await readFile(path.join(projectRoot, ...relative.split("/")));
    const machine = parsePeMachine(bytes);
    if (machine !== versions.machine) throw new Error(`${relative} is not AMD64 PE (machine=0x${machine.toString(16)})`);
    outputs.push({ ...record, machine: "AMD64" });
  }
  return outputs;
}

async function expectedTestManifest() {
  return {
    schemaVersion: 1,
    architecture: "x64",
    canonicalArguments: canonicalTestArguments,
    outputs: await outputRecords(testOutputRelative),
    sourceDigest,
    toolchainDigest,
  };
}

async function expectedTestManifestBytes() {
  return Buffer.from(`${JSON.stringify(await expectedTestManifest(), null, 2)}\n`, "utf8");
}

function testManifestRecord(bytes) {
  return { path: testManifestRelative, bytes: bytes.length, sha256: sha256(bytes) };
}

async function expectedManifest() {
  const testManifestBytes = await expectedTestManifestBytes();
  return {
    schemaVersion: 1,
    architecture: "x64",
    canonicalArguments,
    outputs: await outputRecords(outputRelative),
    signatureStatus: "unsigned-local",
    sourceDigest,
    sourceFiles,
    testProjection: { manifest: testManifestRecord(testManifestBytes) },
    toolchain,
    toolchainDigest,
  };
}

async function exactManifest(relative, expected) {
  try {
    const actual = await readFile(path.join(projectRoot, ...relative.split("/")), "utf8");
    return actual === `${JSON.stringify(await expected(), null, 2)}\n`;
  } catch {
    return false;
  }
}

async function productionCommitsCurrentTestManifest() {
  try {
    const [production, testManifestBytes] = await Promise.all([
      readFile(path.join(projectRoot, ...manifestRelative.split("/")), "utf8").then(JSON.parse),
      readFile(path.join(projectRoot, ...testManifestRelative.split("/"))),
    ]);
    return JSON.stringify(production.testProjection) === JSON.stringify({ manifest: testManifestRecord(testManifestBytes) });
  } catch {
    return false;
  }
}

const distNative = path.join(projectRoot, "dist", "native");
const testNative = path.join(projectRoot, ".sec03-native-test");
const productionExpectedNames = ["sandbox-host.exe", "sandbox-launcher.node", "sec03-native-manifest.json"].sort();
const testExpectedNames = ["sandbox-host.exe", "sandbox-launcher.node", "sec03-native-test-manifest.json"].sort();
if (checkOnly) {
  const [names, testNames] = await Promise.all([readdir(distNative), readdir(testNative)]);
  names.sort();
  testNames.sort();
  if (JSON.stringify(names) !== JSON.stringify(productionExpectedNames)) throw new Error(`SEC-03 native output set mismatch: ${names.join(", ")}`);
  if (JSON.stringify(testNames) !== JSON.stringify(testExpectedNames)) throw new Error(`SEC-03 native test output set mismatch: ${testNames.join(", ")}`);
  if (!await exactManifest(testManifestRelative, expectedTestManifest)) throw new Error("SEC-03 native test manifest is stale or does not match source/toolchain/output identity");
  const actual = JSON.parse(await readFile(path.join(projectRoot, ...manifestRelative.split("/")), "utf8"));
  const expected = await expectedManifest();
  if (`${JSON.stringify(actual, null, 2)}\n` !== `${JSON.stringify(expected, null, 2)}\n`) throw new Error("SEC-03 native manifest is stale or does not match source/toolchain/output identity");
  console.log(`SEC-03 native check PASS ${sourceDigest}`);
  process.exit(0);
}

const temp = path.join(projectRoot, ".sec03-native-build");
const productionNames = await readdir(distNative).catch(() => []);
const productionReusable = JSON.stringify(productionNames.sort()) === JSON.stringify(productionExpectedNames)
  && await exactManifest(manifestRelative, expectedManifest);
const testNames = await readdir(testNative).catch(() => []);
const testReusable = JSON.stringify(testNames.sort()) === JSON.stringify(testExpectedNames)
  && await exactManifest(testManifestRelative, expectedTestManifest)
  && await productionCommitsCurrentTestManifest();
if (productionReusable && testReusable) {
  console.log(`SEC-03 native build REUSED ${sourceDigest}`);
  process.exit(0);
}

function compile(args, executable, object) {
  const link = args.indexOf("/link");
  run(cl, [...args.slice(0, link), `/Fe:${executable}`, `/Fo:${object}`, ...args.slice(link)], { env: buildEnv });
}

await rm(temp, { recursive: true, force: true });
await mkdir(temp, { recursive: true });
await mkdir(distNative, { recursive: true });
await mkdir(testNative, { recursive: true });
try {
  if (!productionReusable) {
    const launcherOut = path.join(temp, "sandbox-launcher.node");
    const hostOut = path.join(temp, "sandbox-host.exe");
    compile(canonicalArguments.launcherCompile, launcherOut, path.join(temp, "sandbox-launcher.obj"));
    compile(canonicalArguments.hostCompile, hostOut, path.join(temp, "sandbox-host.obj"));
    await rm(path.join(distNative, "sandbox-launcher.node"), { force: true });
    await rm(path.join(distNative, "sandbox-host.exe"), { force: true });
    await rename(launcherOut, path.join(distNative, "sandbox-launcher.node"));
    await rename(hostOut, path.join(distNative, "sandbox-host.exe"));
  }
  if (!testReusable) {
    const launcherOut = path.join(temp, "sandbox-launcher-test.node");
    const hostOut = path.join(temp, "sandbox-host-test.exe");
    compile(canonicalTestArguments.launcherCompile, launcherOut, path.join(temp, "sandbox-launcher-test.obj"));
    compile(canonicalTestArguments.hostCompile, hostOut, path.join(temp, "sandbox-host-test.obj"));
    await rm(path.join(testNative, "sandbox-launcher.node"), { force: true });
    await rm(path.join(testNative, "sandbox-host.exe"), { force: true });
    await rename(launcherOut, path.join(testNative, "sandbox-launcher.node"));
    await rename(hostOut, path.join(testNative, "sandbox-host.exe"));
    await writeFile(path.join(projectRoot, ...testManifestRelative.split("/")), await expectedTestManifestBytes());
  }
  if (!productionReusable || !testReusable) {
    const manifest = await expectedManifest();
    await writeFile(path.join(projectRoot, ...manifestRelative.split("/")), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  }
  console.log(`SEC-03 native build PASS ${sourceDigest}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
