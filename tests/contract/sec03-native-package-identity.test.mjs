import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, cp, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  collectSourceFiles,
  sec03ArchitectureSha256,
  sec03NativeBinaryRelatives,
  sec03NativeManifestRelative,
  sec03NativeTestBinaryRelatives,
  sec03NativeTestManifestRelative,
  toPosix,
  validateSec03NativeProjection,
  validateSec03NativeTestProjection,
} from "../../scripts/build-inputs.mjs";
import { loadWindowsHandleObserverProjectionForTest, makeTempDir, projectRoot, removeFixture, runProcess } from "../helpers.mjs";

async function fixture() {
  const root = await makeTempDir("mini-lux-sec03-native-identity-");
  await mkdir(path.join(root, "native"), { recursive: true });
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "dist"), { recursive: true });
  await cp(path.join(projectRoot, "native", "sandbox-host"), path.join(root, "native", "sandbox-host"), { recursive: true });
  await cp(path.join(projectRoot, "scripts", "build-sec03-native.mjs"), path.join(root, "scripts", "build-sec03-native.mjs"));
  await cp(path.join(projectRoot, "dist", "native"), path.join(root, "dist", "native"), { recursive: true });
  await cp(path.join(projectRoot, ".sec03-native-test"), path.join(root, ".sec03-native-test"), { recursive: true });
  await cp(path.join(projectRoot, "build-info.json"), path.join(root, "build-info.json"));
  return root;
}

async function rewriteMachine(root, relative, machine) {
  const binaryPath = path.join(root, ...relative.split("/"));
  const bytes = await readFile(binaryPath);
  const offset = bytes.readUInt32LE(0x3c);
  bytes.writeUInt16LE(machine, offset + 4);
  await writeFile(binaryPath, bytes);
  const manifestPath = path.join(root, ...sec03NativeManifestRelative.split("/"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const record = manifest.outputs.find((entry) => entry.path === relative);
  record.bytes = bytes.length;
  record.sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function mutateTestManifest(root, mutate, { commit = false } = {}) {
  const testManifestPath = path.join(root, ...sec03NativeTestManifestRelative.split("/"));
  const testManifest = JSON.parse(await readFile(testManifestPath, "utf8"));
  await mutate(testManifest);
  const bytes = Buffer.from(`${JSON.stringify(testManifest, null, 2)}\n`, "utf8");
  await writeFile(testManifestPath, bytes);
  if (commit) {
    const record = { path: sec03NativeTestManifestRelative, bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    const productionManifestPath = path.join(root, ...sec03NativeManifestRelative.split("/"));
    const productionManifest = JSON.parse(await readFile(productionManifestPath, "utf8"));
    productionManifest.testProjection = { manifest: record };
    await writeFile(productionManifestPath, `${JSON.stringify(productionManifest, null, 2)}\n`);
    const buildInfoPath = path.join(root, "build-info.json");
    const buildInfo = JSON.parse(await readFile(buildInfoPath, "utf8"));
    buildInfo.versions.executionIsolation.testProjection = { manifest: record };
    await writeFile(buildInfoPath, `${JSON.stringify(buildInfo, null, 2)}\n`);
  }
}

async function fixtureBuildInfo(root) {
  return JSON.parse(await readFile(path.join(root, "build-info.json"), "utf8"));
}

test("SEC-03 source digest authored set includes native sources, build logic, runtime, governance and matrix inputs", async () => {
  const inputs = new Set((await collectSourceFiles(projectRoot)).map((absolute) => toPosix(path.relative(projectRoot, absolute))));
  for (const relative of [
    "native/sandbox-host/protocol.h",
    "native/sandbox-host/journal.h",
    "native/sandbox-host/sandbox-host.cpp",
    "native/sandbox-host/sandbox-launcher.cpp",
    "scripts/build-sec03-native.mjs",
    "src/execution-isolation.ts",
    "src/execution-native.ts",
    "src/execution-runtime.ts",
    "scripts/sec03-execution-inventory.mjs",
    "scripts/sec03-receipt-set.mjs",
    "tests/sec03-attack-matrix.json",
    "tests/sec03-attack-matrix.schema.json",
    "parity/SEC-03-EXECUTION-ISOLATION-ARCHITECTURE.md",
    "parity/reports/sec-03-architect-freeze.json",
  ]) assert(inputs.has(relative), `sourceDigest omits ${relative}`);
  assert.equal(sec03ArchitectureSha256, "849fc25a5e32eabdaa3b1285a14218f9877d46ecdc650a0e52a2120772e1cad1");
});

test("SEC-03 native projection binds the exact manifest, outputs, toolchain, freshness and AMD64 machine", async () => {
  const root = await fixture();
  try {
    const identity = await validateSec03NativeProjection(root);
    assert.deepEqual(identity.binaries.map((entry) => entry.path), sec03NativeBinaryRelatives);
    assert.equal(identity.manifest.path, sec03NativeManifestRelative);
    assert.equal(identity.architectureSha256, sec03ArchitectureSha256);

    await writeFile(path.join(root, "dist", "native", "future-helper.exe"), "extra");
    await assert.rejects(() => validateSec03NativeProjection(root), /output set mismatch/u);
    await rm(path.join(root, "dist", "native", "future-helper.exe"));

    const host = path.join(root, ...sec03NativeBinaryRelatives[0].split("/"));
    const missing = `${host}.missing`;
    await rename(host, missing);
    await assert.rejects(() => validateSec03NativeProjection(root), /output set mismatch/u);
    await rename(missing, host);

    const originalHost = await readFile(host);
    await writeFile(host, Buffer.concat([originalHost, Buffer.from([0])]));
    await assert.rejects(() => validateSec03NativeProjection(root), /byte identity differs/u);
    await writeFile(host, originalHost);

    await rewriteMachine(root, sec03NativeBinaryRelatives[0], 0x014c);
    await assert.rejects(() => validateSec03NativeProjection(root), /not AMD64 PE/u);
  } finally {
    await removeFixture(root);
  }
});

test("SEC-03 native projection rejects stale native source and manifest toolchain identity", async () => {
  const root = await fixture();
  try {
    const protocol = path.join(root, "native", "sandbox-host", "protocol.h");
    await writeFile(protocol, `${await readFile(protocol, "utf8")}\n`);
    await assert.rejects(() => validateSec03NativeProjection(root), /source .* byte identity differs/u);
  } finally {
    await removeFixture(root);
  }

  const second = await fixture();
  try {
    const manifestPath = path.join(second, ...sec03NativeManifestRelative.split("/"));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.toolchainDigest = "0".repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(() => validateSec03NativeProjection(second), /toolchain digest differs/u);
  } finally {
    await removeFixture(second);
  }
});

test("SEC-03 native test projection is committed by production identity and cannot self-sign", async () => {
  const root = await fixture();
  try {
    const buildInfo = await fixtureBuildInfo(root);
    const identity = await validateSec03NativeTestProjection(root, { buildInfo });
    assert.deepEqual(identity.binaries.map((entry) => entry.path), sec03NativeTestBinaryRelatives);
    assert.equal(identity.manifest.path, sec03NativeTestManifestRelative);
    assert.equal(identity.addon.path, sec03NativeTestBinaryRelatives[1]);

    const addonPath = path.join(root, ...sec03NativeTestBinaryRelatives[1].split("/"));
    const changedAddon = Buffer.concat([await readFile(addonPath), Buffer.from([0])]);
    await writeFile(addonPath, changedAddon);
    await mutateTestManifest(root, (manifest) => {
      const addon = manifest.outputs[1];
      addon.bytes = changedAddon.length;
      addon.sha256 = createHash("sha256").update(changedAddon).digest("hex");
    });
    await assert.rejects(
      () => validateSec03NativeTestProjection(root, { buildInfo }),
      /native test manifest byte identity differs/u,
    );
  } finally {
    await removeFixture(root);
  }
});

test("SEC-03 native test projection permits only the one test define and production source identity", async () => {
  const sourceRoot = await fixture();
  try {
    await mutateTestManifest(sourceRoot, (manifest) => { manifest.sourceDigest = "0".repeat(64); }, { commit: true });
    await assert.rejects(
      () => fixtureBuildInfo(sourceRoot).then((buildInfo) => validateSec03NativeTestProjection(sourceRoot, { buildInfo })),
      /test manifest identity differs from production/u,
    );
  } finally {
    await removeFixture(sourceRoot);
  }

  const argumentsRoot = await fixture();
  try {
    await mutateTestManifest(argumentsRoot, (manifest) => {
      const link = manifest.canonicalArguments.launcherCompile.indexOf("/link");
      manifest.canonicalArguments.launcherCompile.splice(link, 0, "/DUNREVIEWED_TEST_DEFINE");
    }, { commit: true });
    await assert.rejects(
      () => fixtureBuildInfo(argumentsRoot).then((buildInfo) => validateSec03NativeTestProjection(argumentsRoot, { buildInfo })),
      /differs from the one allowed test define/u,
    );
  } finally {
    await removeFixture(argumentsRoot);
  }
});

test("SEC-03 native addons expose exact production and test-only top-level APIs", async () => {
  assert.equal(process.platform, "win32");
  assert.equal(process.arch, "x64");
  const { production, nativeTest } = await loadWindowsHandleObserverProjectionForTest();
  assert.deepEqual(Reflect.ownKeys(production).sort(), ["openEvidenceVerifier", "openExclusiveHostLease", "protocolVersion"]);
  assert.deepEqual(Reflect.ownKeys(nativeTest).sort(), [
    "openWindowsExecutableIdentityLeaseForTest",
    "observeWindowsFileHandleInProcessTreeForTest",
    "observeWindowsKnownFolderPathsForTest",
    "observeWindowsProcessReferencesForTest",
    "observeWindowsRegistryKeyForTest",
    "observeWindowsRegistrySnapshotForTest",
    "openEvidenceVerifier",
    "openExclusiveHostLease",
    "protocolVersion",
  ].sort());
  for (const operation of [
    "openWindowsExecutableIdentityLeaseForTest",
    "observeWindowsProcessReferencesForTest",
    "observeWindowsFileHandleInProcessTreeForTest",
    "observeWindowsKnownFolderPathsForTest",
    "observeWindowsRegistryKeyForTest",
    "observeWindowsRegistrySnapshotForTest",
  ]) {
    assert.equal(production[operation], undefined);
    assert.equal(typeof nativeTest[operation], "function");
  }
  assert.equal(typeof production.openExclusiveHostLease.loadValidatedTestProjection, "function");
  assert.equal(nativeTest.protocolVersion, 1);

  const executableLeaseRoot = await makeTempDir("rainydays-executable-identity-lease-");
  const leasedExecutable = path.join(executableLeaseRoot, "leased-node.exe");
  let executableLease = null;
  try {
    await copyFile(process.execPath, leasedExecutable);
    const executableBytes = (await stat(leasedExecutable)).size;
    const executableSha256 = createHash("sha256").update(await readFile(leasedExecutable)).digest("hex");
    executableLease = nativeTest.openWindowsExecutableIdentityLeaseForTest(leasedExecutable, executableBytes, executableSha256);
    assert.deepEqual(Reflect.ownKeys(executableLease).sort(), ["assertProcessIdentity", "close"]);
    await assert.rejects(() => writeFile(leasedExecutable, "replacement"), (error) => ["EBUSY", "EACCES", "EPERM"].includes(error?.code));
    await assert.rejects(() => rm(leasedExecutable), (error) => ["EBUSY", "EACCES", "EPERM"].includes(error?.code));
    assert.throws(() => executableLease.assertProcessIdentity(process.pid), (error) => error?.code === "EXEC_NATIVE_TEST_EXECUTABLE_IDENTITY");
    const executed = await runProcess(leasedExecutable, ["-e", "setTimeout(()=>{},250)"], {
      timeoutMs: 5_000,
      onSpawn(child) { assert.equal(executableLease.assertProcessIdentity(child.pid), true); },
    });
    assert.equal(executed.code, 0);
    executableLease.close();
    executableLease = null;
    await rm(leasedExecutable);
  } finally {
    executableLease?.close();
    await removeFixture(executableLeaseRoot);
  }

  const observeKnownFolders = nativeTest.observeWindowsKnownFolderPathsForTest;
  const observeRegistryKey = nativeTest.observeWindowsRegistryKeyForTest;
  const observeRegistrySnapshot = nativeTest.observeWindowsRegistrySnapshotForTest;
  const knownFolders = observeKnownFolders();
  assert.deepEqual(Reflect.ownKeys(knownFolders).sort(), ["desktop", "programs"]);
  assert(path.isAbsolute(knownFolders.programs));
  assert(path.isAbsolute(knownFolders.desktop));
  assert.equal(Object.isFrozen(knownFolders), true);
  assert.throws(() => observeKnownFolders("unexpected"), (error) => error?.code === "EXEC_NATIVE_TEST_OBSERVER_INPUT");

  const missingRegistry = observeRegistrySnapshot(`Software\\RainyDays-Native-Missing-${Date.now()}-${process.pid}`);
  assert.deepEqual(missingRegistry, { rootPresent: false, items: [] });
  assert.equal(Object.isFrozen(missingRegistry), true);
  assert.equal(Object.isFrozen(missingRegistry.items), true);
  const missingRegistryKey = observeRegistryKey(`Software\\RainyDays-Native-Key-Missing-${Date.now()}-${process.pid}`);
  assert.deepEqual(missingRegistryKey, { rootPresent: false, items: [] });
  assert.equal(Object.isFrozen(missingRegistryKey), true);
  assert.equal(Object.isFrozen(missingRegistryKey.items), true);
  const presentRegistry = observeRegistrySnapshot("Software");
  assert.equal(presentRegistry.rootPresent, true);
  assert.equal(Object.isFrozen(presentRegistry), true);
  assert.equal(Object.isFrozen(presentRegistry.items), true);
  assert(presentRegistry.items.every((item) => Object.isFrozen(item)));
  for (const subkey of ["", "HKCU\\Software", "HKEY_CURRENT_USER\\Software", "\\Software", "Software\\..\\Other", "Software\0Other"]) {
    for (const observeRegistry of [observeRegistryKey, observeRegistrySnapshot]) {
      assert.throws(
        () => observeRegistry(subkey),
        (error) => error?.code === "EXEC_NATIVE_TEST_OBSERVER_INPUT" && (subkey.length === 0 || !String(error.message).includes(subkey)),
      );
    }
  }

  const observeProcesses = nativeTest.observeWindowsProcessReferencesForTest;
  const processObservation = observeProcesses([process.execPath]);
  assert.deepEqual(Reflect.ownKeys(processObservation).sort(), ["matchingCount", "matchingProcesses", "unknownProcessIdentityIds"]);
  assert(Number.isInteger(processObservation.matchingCount) && processObservation.matchingCount >= 1 && processObservation.matchingCount <= 65_536);
  assert.equal(processObservation.matchingProcesses.length, processObservation.matchingCount);
  assert(processObservation.matchingProcesses.some((match) => match.processId === process.pid
    && match.imageName.toLowerCase() === path.basename(process.execPath).toLowerCase() && match.imageMatched));
  for (const match of processObservation.matchingProcesses) {
    assert.deepEqual(Reflect.ownKeys(match).sort(), ["commandLineMatched", "identityId", "imageMatched", "imageName", "inheritedFromProcessId", "processId"]);
    assert.match(match.identityId, /^[a-f0-9]{64}$/u);
    assert(Number.isInteger(match.processId) && match.processId > 0 && match.processId <= 0xFFFFFFFF);
    assert(Number.isInteger(match.inheritedFromProcessId) && match.inheritedFromProcessId >= 0 && match.inheritedFromProcessId <= 0xFFFFFFFF);
    assert.equal(/[\\/\0]/u.test(match.imageName), false);
    assert(match.imageMatched || match.commandLineMatched);
    assert.equal(Object.isFrozen(match), true);
  }
  assert.equal(Object.isFrozen(processObservation.matchingProcesses), true);
  assert(Array.isArray(processObservation.unknownProcessIdentityIds));
  assert(processObservation.unknownProcessIdentityIds.every((identity) => /^[a-f0-9]{64}$/u.test(identity)));
  assert.equal(new Set(processObservation.unknownProcessIdentityIds).size, processObservation.unknownProcessIdentityIds.length);
  assert.equal(Object.isFrozen(processObservation.unknownProcessIdentityIds), true);
  assert.equal(Object.isFrozen(processObservation), true);
  for (const needles of [[], Array(17).fill(projectRoot), ["relative"], ["C:\\path\\..\\other"], ["C:\\path\0other"], Array(1)]) {
    assert.throws(() => observeProcesses(needles), (error) => error?.code === "EXEC_NATIVE_TEST_OBSERVER_INPUT");
  }

  const observe = nativeTest.observeWindowsFileHandleInProcessTreeForTest;
  const canonicalPath = path.join(projectRoot, "package.json");
  const casingAlias = canonicalPath.toLowerCase();
  assert.notEqual(casingAlias, canonicalPath);
  for (const args of [["relative.bin", 1], [`\\\\?\\${canonicalPath}`, 1], [casingAlias, 1], [canonicalPath, 0], [canonicalPath, 1.5], [canonicalPath, 0x1_0000_0000]]) {
    assert.throws(() => observe(...args), (error) => error?.code === "EXEC_NATIVE_TEST_OBSERVER_INPUT" && !String(error.message).includes(projectRoot));
  }
  const uncPath = `\\\\localhost\\${canonicalPath[0]}` + "$" + canonicalPath.slice(2);
  assert.throws(
    () => observe(uncPath, 0xFFFFFFFF),
    (error) => error?.code === "EXEC_NATIVE_TEST_OBSERVER_DOMAIN" && !String(error.message).includes(uncPath),
  );
  assert.throws(
    () => observe(uncPath.toUpperCase(), 0xFFFFFFFF),
    (error) => error?.code === "EXEC_NATIVE_TEST_OBSERVER_INPUT" && !String(error.message).includes(uncPath),
  );

  const aliasRoot = await makeTempDir("RainyDays Observer Canonical Fixture ");
  try {
    const longDirectory = path.join(aliasRoot, "Long Component Name");
    const longPath = path.join(longDirectory, "Target File.bin");
    await mkdir(longDirectory);
    await writeFile(longPath, "canonical-alias-probe");
    const shortResult = await runProcess(process.env.ComSpec || "cmd.exe", [
      "/d", "/c", 'for %I in ("%RAINYDAYS_OBSERVER_ALIAS_TARGET%") do @echo %~sI',
    ], {
      env: { ...process.env, RAINYDAYS_OBSERVER_ALIAS_TARGET: longPath },
      windowsVerbatimArguments: true,
    });
    assert.equal(shortResult.code, 0, shortResult.stderr);
    const shortPath = shortResult.stdout.trim().replace(/^"|"$/gu, "");
    assert.notEqual(shortPath.toLowerCase(), longPath.toLowerCase(), "8.3 alias was not exposed for canonical observer coverage");
    assert.throws(() => observe(shortPath, 0xFFFFFFFF), (error) => error?.code === "EXEC_NATIVE_TEST_OBSERVER_INPUT");
    assert.throws(() => observe(longPath, 0xFFFFFFFF), (error) => error?.code === "EXEC_NATIVE_TEST_OBSERVER_DOMAIN");
  } finally {
    await removeFixture(aliasRoot);
  }

  assert.throws(
    () => observe(canonicalPath, 0xFFFFFFFF),
    (error) => error?.code === "EXEC_NATIVE_TEST_OBSERVER_DOMAIN" && !String(error.message).includes(String(0xFFFFFFFF)),
  );
  assert.throws(
    () => observe(canonicalPath, process.pid),
    (error) => error?.code === "EXEC_NATIVE_TEST_OBSERVER_DOMAIN" && !String(error.message).includes(String(process.pid)),
  );
});

test("SEC-03 build metadata and electron package bind the exact current native artifacts", async () => {
  const [packageJson, buildInfo, nativeManifest] = await Promise.all([
    readFile(path.join(projectRoot, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "build-info.json"), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "dist", "native", "sec03-native-manifest.json"), "utf8").then(JSON.parse),
  ]);
  assert.match(packageJson.scripts.build, /^npm run build:native && npm run build:metadata && /u);
  assert.equal(buildInfo.versions.executionIsolation.architectureSha256, sec03ArchitectureSha256);
  assert.equal(buildInfo.versions.executionIsolation.nativeSourceDigest, nativeManifest.sourceDigest);
  assert.equal(buildInfo.versions.executionIsolation.toolchainDigest, nativeManifest.toolchainDigest);
  assert.equal(buildInfo.versions.executionIsolation.signatureStatus, nativeManifest.signatureStatus);
  assert.deepEqual(buildInfo.versions.executionIsolation.artifacts, nativeManifest.outputs);
  assert.deepEqual(buildInfo.versions.executionIsolation.testProjection, nativeManifest.testProjection);
  assert.equal(nativeManifest.testProjection.manifest.path, sec03NativeTestManifestRelative);
  for (const args of Object.values(nativeManifest.canonicalArguments)) {
    const link = args.indexOf("/link");
    assert(link > 0);
    assert.equal(args.filter((argument) => argument === "/Brepro").length, 2);
    assert(args.indexOf("/Brepro") < link);
    assert(args.lastIndexOf("/Brepro") > link);
    assert(!args.includes("/GL"));
  }
  assert(packageJson.build.files.includes("dist/native/sec03-native-manifest.json"));
  assert(packageJson.build.files.includes("electron-stage-integrity.json"));
  assert.deepEqual(
    packageJson.build.files.filter((entry) => entry.startsWith("dist/native/")),
    ["dist/native/sandbox-host.exe", "dist/native/sandbox-launcher.node", "dist/native/sec03-native-manifest.json"],
  );
  assert.deepEqual(
    packageJson.build.asarUnpack.filter((entry) => entry.startsWith("dist/native/")),
    ["dist/native/sandbox-host.exe", "dist/native/sandbox-launcher.node"],
  );
  assert(!packageJson.build.files.some((entry) => entry === "dist/**/*" || entry.startsWith("dist/native/*")));
  assert(!packageJson.build.files.some((entry) => entry.includes(".sec03-native-test")));
  assert(!packageJson.build.asarUnpack.some((entry) => entry.startsWith("dist/native/*")));
  assert(!packageJson.build.asarUnpack.some((entry) => entry.includes(".sec03-native-test")));
});
