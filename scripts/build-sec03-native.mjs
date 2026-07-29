import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
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
function parsePeMachine(bytes) {
  if (bytes.length < 0x40 || bytes.readUInt16LE(0) !== 0x5a4d) throw new Error("Output is not a PE image");
  const pe = bytes.readUInt32LE(0x3c);
  if (pe < 0x40 || pe + 6 > bytes.length || bytes.readUInt32LE(pe) !== 0x4550) throw new Error("Output has invalid PE headers");
  return bytes.readUInt16LE(pe + 4);
}

const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
const vswhere = path.join(programFilesX86, "Microsoft Visual Studio", "Installer", "vswhere.exe");
const instances = JSON.parse(run(vswhere, ["-products", "*", "-requires", "Microsoft.VisualStudio.Component.VC.Tools.x86.x64", "-format", "json", "-utf8"]));
if (!Array.isArray(instances) || instances.length !== 1) throw new Error(`Expected exactly one eligible Visual Studio instance, found ${instances.length}`);
const vsRoot = instances[0].installationPath;
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

const sourceFiles = await Promise.all(sourceRelative.map(fileRecord));
const sourceDigest = await digestRecords(sourceFiles, "mini-lux-sec03-native-source-v1");
const compiler = await fileRecord(path.relative(projectRoot, cl).replaceAll("\\", "/")).catch(async () => {
  const bytes = await readFile(cl); return { path: cl, bytes: bytes.length, sha256: sha256(bytes) };
});
const linker = await (async () => { const bytes = await readFile(link); return { path: link, bytes: bytes.length, sha256: sha256(bytes) }; })();
const versionProbe = spawnSync(cl, ["/Bv"], { cwd: projectRoot, encoding: "utf8", windowsHide: true, env: buildEnv });
const versionText = `${versionProbe.stdout ?? ""}${versionProbe.stderr ?? ""}`;
const versionMatch = versionText.match(/19\.43\.34808\.0/);
if (!versionMatch) throw new Error("Pinned MSVC compiler version probe did not report 19.43.34808.0");
const compilerVersion = versionMatch[0];
const toolchain = {
  architecture: "x64",
  compiler: { path: cl, bytes: compiler.bytes, sha256: compiler.sha256, version: compilerVersion },
  electron: versions.electron,
  linker: { path: link, bytes: linker.bytes, sha256: linker.sha256 },
  msvc: versions.msvc,
  napi: versions.napi,
  nodeImportLibrary: await (async () => { const bytes = await readFile(nodeLib); return { path: nodeLib, bytes: bytes.length, sha256: sha256(bytes) }; })(),
  sdk: versions.sdk,
  vsInstance: { installationPath: vsRoot, installationVersion: instances[0].installationVersion },
};
const toolchainDigest = sha256(Buffer.from(JSON.stringify({ toolchain, canonicalArguments })));

async function expectedManifest() {
  const outputs = [];
  for (const relative of outputRelative) {
    const record = await fileRecord(relative);
    const bytes = await readFile(path.join(projectRoot, ...relative.split("/")));
    const machine = parsePeMachine(bytes);
    if (machine !== versions.machine) throw new Error(`${relative} is not AMD64 PE (machine=0x${machine.toString(16)})`);
    outputs.push({ ...record, machine: "AMD64" });
  }
  return {
    schemaVersion: 1,
    architecture: "x64",
    canonicalArguments,
    outputs,
    signatureStatus: "unsigned-local",
    sourceDigest,
    sourceFiles,
    toolchain,
    toolchainDigest,
  };
}

const distNative = path.join(projectRoot, "dist", "native");
if (checkOnly) {
  const names = (await readdir(distNative)).sort();
  const expectedNames = ["sandbox-host.exe", "sandbox-launcher.node", "sec03-native-manifest.json"].sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) throw new Error(`SEC-03 native output set mismatch: ${names.join(", ")}`);
  const actual = JSON.parse(await readFile(path.join(projectRoot, ...manifestRelative.split("/")), "utf8"));
  const expected = await expectedManifest();
  if (`${JSON.stringify(actual, null, 2)}\n` !== `${JSON.stringify(expected, null, 2)}\n`) throw new Error("SEC-03 native manifest is stale or does not match source/toolchain/output identity");
  console.log(`SEC-03 native check PASS ${sourceDigest}`);
  process.exit(0);
}

const temp = path.join(projectRoot, ".sec03-native-build");
const testNative = path.join(projectRoot, ".sec03-native-test");
await rm(temp, { recursive: true, force: true });
await mkdir(temp, { recursive: true });
await mkdir(distNative, { recursive: true });
await mkdir(testNative, { recursive: true });
try {
  const launcherOut = path.join(temp, "sandbox-launcher.node");
  const hostOut = path.join(temp, "sandbox-host.exe");
  const testLauncherOut = path.join(temp, "sandbox-launcher-test.node");
  const testHostOut = path.join(temp, "sandbox-host-test.exe");
  const launcherLink = canonicalArguments.launcherCompile.indexOf("/link");
  const hostLink = canonicalArguments.hostCompile.indexOf("/link");
  run(cl, [...canonicalArguments.launcherCompile.slice(0, launcherLink), `/Fe:${launcherOut}`, `/Fo:${path.join(temp, "sandbox-launcher.obj")}`, ...canonicalArguments.launcherCompile.slice(launcherLink)], { env: buildEnv });
  run(cl, [...canonicalArguments.hostCompile.slice(0, hostLink), `/Fe:${hostOut}`, `/Fo:${path.join(temp, "sandbox-host.obj")}`, ...canonicalArguments.hostCompile.slice(hostLink)], { env: buildEnv });
  run(cl, [...canonicalArguments.launcherCompile.slice(0, launcherLink), "/DMINI_LUX_SEC03_NATIVE_TEST", `/Fe:${testLauncherOut}`, `/Fo:${path.join(temp, "sandbox-launcher-test.obj")}`, ...canonicalArguments.launcherCompile.slice(launcherLink)], { env: buildEnv });
  run(cl, [...canonicalArguments.hostCompile.slice(0, hostLink), "/DMINI_LUX_SEC03_NATIVE_TEST", `/Fe:${testHostOut}`, `/Fo:${path.join(temp, "sandbox-host-test.obj")}`, ...canonicalArguments.hostCompile.slice(hostLink)], { env: buildEnv });
  await rm(path.join(distNative, "sandbox-launcher.node"), { force: true });
  await rm(path.join(distNative, "sandbox-host.exe"), { force: true });
  await rm(path.join(testNative, "sandbox-launcher.node"), { force: true });
  await rm(path.join(testNative, "sandbox-host.exe"), { force: true });
  await rename(launcherOut, path.join(distNative, "sandbox-launcher.node"));
  await rename(hostOut, path.join(distNative, "sandbox-host.exe"));
  await rename(testLauncherOut, path.join(testNative, "sandbox-launcher.node"));
  await rename(testHostOut, path.join(testNative, "sandbox-host.exe"));
  const manifest = await expectedManifest();
  await writeFile(path.join(projectRoot, ...manifestRelative.split("/")), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(`SEC-03 native build PASS ${sourceDigest}`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
