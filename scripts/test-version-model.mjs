import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runtimeRoot = process.env.RAINYDAYS_TEST_RUNTIME_ROOT ? path.resolve(process.env.RAINYDAYS_TEST_RUNTIME_ROOT) : projectRoot;
const helper = path.join(runtimeRoot, "scripts", "version-test-child.mjs");
const generator = path.join(projectRoot, "scripts", "generate-build-info.mjs");
const distIntegrityGenerator = path.join(projectRoot, "scripts", "generate-dist-integrity.mjs");
const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");
const scenarios = [];

function pass(name, evidence) {
  scenarios.push({ name, passed: true, evidence });
}

function artifactSafeBuildId(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, (character) =>
    `~${character.codePointAt(0).toString(16).toUpperCase().padStart(2, "0")}`
  );
}

function childEnvironment(root, appRoot = runtimeRoot) {
  return {
    ...process.env,
    RAINYDAYS_APP_ROOT: appRoot,
    RAINYDAYS_USER_DATA_DIR: root,
    RAINYDAYS_DATA_DIR: path.join(root, "data"),
    RAINYDAYS_CONFIG_PATH: path.join(root, "config.json"),
    OUTPUT_DIR: path.join(root, "output"),
  };
}

function runHelper(action, root, appRoot = runtimeRoot) {
  const result = spawnSync(process.execPath, [helper, action], {
    cwd: root,
    env: childEnvironment(root, appRoot),
    encoding: "utf8",
  });
  const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  let payload = null;
  try { payload = JSON.parse(lines.at(-1) || "null"); } catch {}
  return { ...result, payload };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function stopChild(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 2500)),
  ]);
  if (!exited && process.platform === "win32" && child.pid) {
    spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  }
}

async function assertElectronMetadataRejected(root, buildInfoContent, expectedError) {
  const appRoot = path.join(root, `electron-metadata-${Math.random().toString(16).slice(2)}`);
  await mkdir(path.join(appRoot, "electron"), { recursive: true });
  await cp(path.join(projectRoot, "electron", "main.cjs"), path.join(appRoot, "electron", "main.cjs"));
  await cp(path.join(projectRoot, "electron", "path-bootstrap.cjs"), path.join(appRoot, "electron", "path-bootstrap.cjs"));
  await cp(path.join(projectRoot, "electron", "preload.cjs"), path.join(appRoot, "electron", "preload.cjs"));
  await cp(path.join(projectRoot, "electron", "user-data-migration.cjs"), path.join(appRoot, "electron", "user-data-migration.cjs"));
  await writeFile(path.join(appRoot, "package.json"), JSON.stringify({
    name: `gov02-metadata-${path.basename(appRoot)}`,
    version: "0.1.0",
    main: "electron/main.cjs",
  }));
  if (buildInfoContent !== null) await writeFile(path.join(appRoot, "build-info.json"), buildInfoContent);

  const electronExecutable = path.join(runtimeRoot, "node_modules", "electron", "dist", "electron.exe");
  const logs = { stdout: "", stderr: "" };
  const child = spawn(electronExecutable, [
    appRoot,
    `--user-data-dir=${path.join(appRoot, "user-data")}`,
    "--disable-gpu",
  ], {
    cwd: appRoot,
    env: { ...process.env, ELECTRON_ENABLE_LOGGING: "1" },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { logs.stdout += chunk; });
  child.stderr.on("data", (chunk) => { logs.stderr += chunk; });
  const started = Date.now();
  try {
    while (!expectedError.test(`${logs.stdout}\n${logs.stderr}`)) {
      if (child.exitCode !== null) break;
      if (Date.now() - started > 15_000) throw new Error(`Electron metadata rejection timeout\n${logs.stdout}\n${logs.stderr}`);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const output = `${logs.stdout}\n${logs.stderr}`;
    assert.match(output, expectedError);
    assert(!output.includes("rainydays_version"));
    assert(!output.includes("已启动"));
    return output;
  } finally {
    await stopChild(child);
  }
}

async function startServer(root, buildInfo) {
  const port = await freePort();
  const token = "gov02-version-test-token";
  const logs = { stdout: "", stderr: "" };
  const child = spawn(process.execPath, [path.join(runtimeRoot, "dist", "index.js")], {
    cwd: root,
    env: { ...childEnvironment(root), RAINYDAYS_API_TOKEN: token, RAINYDAYS_ELECTRON_VERSION: "33.4.11", PORT: String(port) },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { logs.stdout += chunk; });
  child.stderr.on("data", (chunk) => { logs.stderr += chunk; });
  const started = Date.now();
  while (!logs.stdout.includes("RainyDays") || !logs.stdout.includes("已启动")) {
    if (child.exitCode !== null) throw new Error(`version test server exited ${child.exitCode}\n${logs.stdout}\n${logs.stderr}`);
    if (Date.now() - started > 20_000) throw new Error(`version test server timeout\n${logs.stdout}\n${logs.stderr}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert(logs.stdout.includes(buildInfo.buildId), "startup log must contain Build ID");
  return { child, port, token, logs };
}

async function main() {
  const started = Date.now();
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "mini-lux-gov02-"));
  try {
    const fixedEnv = { ...process.env, SOURCE_DATE_EPOCH: "1700000000" };
    const firstGeneration = spawnSync(process.execPath, [generator], { cwd: projectRoot, env: fixedEnv, encoding: "utf8" });
    assert.equal(firstGeneration.status, 0, firstGeneration.stderr);
    const firstBuild = JSON.parse(await readFile(path.join(projectRoot, "build-info.json"), "utf8"));
    const secondGeneration = spawnSync(process.execPath, [generator], { cwd: projectRoot, env: fixedEnv, encoding: "utf8" });
    assert.equal(secondGeneration.status, 0, secondGeneration.stderr);
    const secondIntegrity = spawnSync(process.execPath, [distIntegrityGenerator], { cwd: projectRoot, env: fixedEnv, encoding: "utf8" });
    assert.equal(secondIntegrity.status, 0, secondIntegrity.stderr);
    const secondBuild = JSON.parse(await readFile(path.join(projectRoot, "build-info.json"), "utf8"));
    assert.match(secondBuild.distIntegritySha256, /^[a-f0-9]{64}$/);
    assert.equal(firstBuild.buildId, secondBuild.buildId);
    assert.equal(firstBuild.sourceDigest, secondBuild.sourceDigest);
    pass("deterministic local Build ID", firstBuild.buildId);

    const invalidBuild = spawnSync(process.execPath, [generator], {
      cwd: projectRoot,
      env: { ...fixedEnv, RAINYDAYS_BUILD_ID: "invalid build id" },
      encoding: "utf8",
    });
    assert.notEqual(invalidBuild.status, 0);
    assert.match(invalidBuild.stderr, /unsupported characters/);
    for (const invalidCiId of [" CI-ID", "CI-ID ", "\tCI-ID\t", ""]) {
      const invalidCiBuild = spawnSync(process.execPath, [generator], {
        cwd: projectRoot,
        env: { ...fixedEnv, RAINYDAYS_BUILD_ID: invalidCiId },
        encoding: "utf8",
      });
      assert.notEqual(invalidCiBuild.status, 0, `CI Build ID ${JSON.stringify(invalidCiId)} must be rejected`);
      assert.match(invalidCiBuild.stderr, /unsupported characters/);
    }
    pass("invalid external Build ID rejected", "unsafe and whitespace-modified CI IDs exited non-zero without rewriting input");

    const fakeProject = path.join(tempRoot, "tampered-project");
    await mkdir(path.join(fakeProject, "scripts"), { recursive: true });
    await mkdir(path.join(fakeProject, "parity", "baselines"), { recursive: true });
    await mkdir(path.join(fakeProject, "dist", "native"), { recursive: true });
    await cp(path.join(projectRoot, "dist", "native", "sec03-native-manifest.json"), path.join(fakeProject, "dist", "native", "sec03-native-manifest.json"));
    await cp(generator, path.join(fakeProject, "scripts", "generate-build-info.mjs"));
    await cp(path.join(projectRoot, "scripts", "build-inputs.mjs"), path.join(fakeProject, "scripts", "build-inputs.mjs"));
    await writeFile(path.join(fakeProject, "package.json"), JSON.stringify({ version: "0.1.0" }));
    await writeFile(path.join(fakeProject, "package-lock.json"), "{}");
    await writeFile(path.join(fakeProject, "parity", "baselines", "lux-desktop-0.1.898.json"), "{}\n");
    const tampered = spawnSync(process.execPath, [path.join(fakeProject, "scripts", "generate-build-info.mjs")], { cwd: fakeProject, encoding: "utf8" });
    assert.notEqual(tampered.status, 0);
    assert.match(tampered.stderr, /baseline hash mismatch/);
    pass("tampered GOV-01 baseline blocks build metadata", "generator exited non-zero");

    const digestProject = path.join(tempRoot, "digest-project");
    await mkdir(digestProject, { recursive: true });
    for (const directory of [".github", "src", "electron", "public", "personas", "skills", "scripts", "tests", "build", "models", "native", "vendor"]) {
      await cp(path.join(projectRoot, directory), path.join(digestProject, directory), { recursive: true });
    }
    await mkdir(path.join(digestProject, "parity", "baselines"), { recursive: true });
    await cp(path.join(projectRoot, "dist", "native"), path.join(digestProject, "dist", "native"), { recursive: true });
    for (const directory of ["scripts", "schema", "probes", "policies"]) {
      await cp(path.join(projectRoot, "parity", directory), path.join(digestProject, "parity", directory), { recursive: true });
    }
    for (const file of [".gitignore", ".gitleaks.toml", "LUX-DESKTOP-100-PARITY-EXECUTION-SPEC.md", "config.example.json", "models-manifest.json", "eslint.config.mjs", "package.json", "package-lock.json", "tsconfig.json"]) {
      await cp(path.join(projectRoot, file), path.join(digestProject, file));
    }
    await symlink(path.join(projectRoot, "node_modules"), path.join(digestProject, "node_modules"), "junction");
    await cp(path.join(projectRoot, "parity", "baselines", "lux-desktop-0.1.898.json"), path.join(digestProject, "parity", "baselines", "lux-desktop-0.1.898.json"));
    for (const file of ["BASELINE-DESIGN.md", "GOV-02-VERSION-MODEL.md", "GOV-03-TEST-ARCHITECTURE.md", "GOV-04-CI-ARCHITECTURE.md", "GOV-04-ARCHITECT-AMENDMENT-01.md", "SEC-01-CAPABILITY-BROKER-ARCHITECTURE.md", "SEC-02-PATH-POLICY-ARCHITECTURE.md", "SEC-02-P36-RUNTIME-DIALECT-AMENDMENT-01.md", "SEC-03-EXECUTION-ISOLATION-ARCHITECTURE.md", "README.md"]) {
      await cp(path.join(projectRoot, "parity", file), path.join(digestProject, "parity", file));
    }
    await mkdir(path.join(digestProject, "parity", "reports"), { recursive: true });
    for (const file of ["sec-02-architect-freeze.json", "sec-02-p36-runtime-dialect-freeze.json", "sec-03-architect-freeze.json"]) {
      await cp(path.join(projectRoot, "parity", "reports", file), path.join(digestProject, "parity", "reports", file));
    }
    const digestGenerator = path.join(digestProject, "scripts", "generate-build-info.mjs");
    const derivedEnv = { ...fixedEnv };
    delete derivedEnv.RAINYDAYS_BUILD_ID;
    let digestRun = spawnSync(process.execPath, [digestGenerator], { cwd: digestProject, env: derivedEnv, encoding: "utf8" });
    assert.equal(digestRun.status, 0, digestRun.stderr);
    const digestBefore = JSON.parse(await readFile(path.join(digestProject, "build-info.json"), "utf8"));
    const changedTsconfig = JSON.parse(await readFile(path.join(digestProject, "tsconfig.json"), "utf8"));
    changedTsconfig.compilerOptions.target = "ES2017";
    await writeFile(path.join(digestProject, "tsconfig.json"), JSON.stringify(changedTsconfig, null, 2));
    digestRun = spawnSync(process.execPath, [digestGenerator], { cwd: digestProject, env: derivedEnv, encoding: "utf8" });
    assert.equal(digestRun.status, 0, digestRun.stderr);
    const digestAfter = JSON.parse(await readFile(path.join(digestProject, "build-info.json"), "utf8"));
    assert.notEqual(digestAfter.sourceDigest, digestBefore.sourceDigest);
    assert.notEqual(digestAfter.buildId, digestBefore.buildId);
    pass("compiler configuration changes Build ID", `${digestBefore.buildId} -> ${digestAfter.buildId}`);

    const framingAPath = path.join(digestProject, "src", "framing-a");
    const framingBPath = path.join(digestProject, "src", "framing-b");
    await writeFile(framingAPath, "x");
    await writeFile(framingBPath, "y");
    digestRun = spawnSync(process.execPath, [digestGenerator], { cwd: digestProject, env: derivedEnv, encoding: "utf8" });
    assert.equal(digestRun.status, 0, digestRun.stderr);
    const framedTreeA = JSON.parse(await readFile(path.join(digestProject, "build-info.json"), "utf8"));
    await rm(framingBPath);
    await writeFile(framingAPath, Buffer.from("x\0src/framing-b\0y"));
    digestRun = spawnSync(process.execPath, [digestGenerator], { cwd: digestProject, env: derivedEnv, encoding: "utf8" });
    assert.equal(digestRun.status, 0, digestRun.stderr);
    const framedTreeB = JSON.parse(await readFile(path.join(digestProject, "build-info.json"), "utf8"));
    assert.notEqual(framedTreeB.sourceDigest, framedTreeA.sourceDigest);
    pass("source digest framing distinguishes NUL boundary trees", `${framedTreeA.buildId} != ${framedTreeB.buildId}`);

    await writeFile(framingAPath, Buffer.from("source changed after metadata generation"));
    const staleStage = spawnSync(process.execPath, [path.join(digestProject, "scripts", "prepare-electron-app.mjs")], {
      cwd: digestProject,
      env: derivedEnv,
      encoding: "utf8",
    });
    assert.notEqual(staleStage.status, 0);
    assert.match(staleStage.stderr, /does not match current build inputs/);
    pass("Electron staging rejects stale build metadata", "source mutation blocked before staging copy or npm install");

    const distIntegrityProject = path.join(tempRoot, "dist-integrity-project");
    for (const directory of [".github", "src", "electron", "public", "personas", "skills", "scripts", "tests", "dist", "build", "models", "native", "vendor"]) {
      await cp(path.join(projectRoot, directory), path.join(distIntegrityProject, directory), { recursive: true });
    }
    await mkdir(path.join(distIntegrityProject, "parity", "baselines"), { recursive: true });
    for (const directory of ["scripts", "schema", "probes", "policies"]) {
      await cp(path.join(projectRoot, "parity", directory), path.join(distIntegrityProject, "parity", directory), { recursive: true });
    }
    for (const file of [".gitignore", ".gitleaks.toml", "LUX-DESKTOP-100-PARITY-EXECUTION-SPEC.md", "config.example.json", "models-manifest.json", "eslint.config.mjs", "package.json", "package-lock.json", "tsconfig.json", "build-info.json", "dist-integrity.json"]) {
      await cp(path.join(projectRoot, file), path.join(distIntegrityProject, file));
    }
    await symlink(path.join(projectRoot, "node_modules"), path.join(distIntegrityProject, "node_modules"), "junction");
    await cp(path.join(projectRoot, "parity", "baselines", "lux-desktop-0.1.898.json"), path.join(distIntegrityProject, "parity", "baselines", "lux-desktop-0.1.898.json"));
    for (const file of ["BASELINE-DESIGN.md", "GOV-02-VERSION-MODEL.md", "GOV-03-TEST-ARCHITECTURE.md", "GOV-04-CI-ARCHITECTURE.md", "GOV-04-ARCHITECT-AMENDMENT-01.md", "SEC-01-CAPABILITY-BROKER-ARCHITECTURE.md", "SEC-02-PATH-POLICY-ARCHITECTURE.md", "SEC-02-P36-RUNTIME-DIALECT-AMENDMENT-01.md", "SEC-03-EXECUTION-ISOLATION-ARCHITECTURE.md", "README.md"]) {
      await cp(path.join(projectRoot, "parity", file), path.join(distIntegrityProject, "parity", file));
    }
    await mkdir(path.join(distIntegrityProject, "parity", "reports"), { recursive: true });
    for (const file of ["sec-02-architect-freeze.json", "sec-02-p36-runtime-dialect-freeze.json", "sec-03-architect-freeze.json"]) {
      await cp(path.join(projectRoot, "parity", "reports", file), path.join(distIntegrityProject, "parity", "reports", file));
    }
    await writeFile(path.join(distIntegrityProject, "dist", "version.js"), `${await readFile(path.join(distIntegrityProject, "dist", "version.js"), "utf8")}\n// dist-tamper\n`);
    const tamperedDistStage = spawnSync(process.execPath, [path.join(distIntegrityProject, "scripts", "prepare-electron-app.mjs")], {
      cwd: distIntegrityProject,
      env: fixedEnv,
      encoding: "utf8",
    });
    assert.notEqual(tamperedDistStage.status, 0);
    assert.match(tamperedDistStage.stderr, /dist fresh (?:JavaScript )?compilation byte mismatch|dist integrity mismatch/);
    await assert.rejects(() => readFile(path.join(distIntegrityProject, ".electron-app", "dist", "version.js")));
    pass("Electron staging rejects tampered dist", "compiled output mismatch blocked before staging copy or npm install");

    const digestPackagePath = path.join(digestProject, "package.json");
    const validDigestPackage = JSON.parse(await readFile(digestPackagePath, "utf8"));
    for (const invalidVersion of ["01.2.3", "1.2.3-01", "1.2.3-alpha..1", "1.2.3+meta..x"]) {
      await writeFile(digestPackagePath, JSON.stringify({ ...validDigestPackage, version: invalidVersion }, null, 2));
      const invalidSemver = spawnSync(process.execPath, [digestGenerator], { cwd: digestProject, env: derivedEnv, encoding: "utf8" });
      assert.notEqual(invalidSemver.status, 0, `${invalidVersion} must be rejected`);
      assert.match(invalidSemver.stderr, /valid SemVer/);
    }
    await writeFile(digestPackagePath, JSON.stringify(validDigestPackage, null, 2) + "\n");
    digestRun = spawnSync(process.execPath, [digestGenerator], { cwd: digestProject, env: derivedEnv, encoding: "utf8" });
    assert.equal(digestRun.status, 0, digestRun.stderr);
    const invalidBuiltAtInfo = JSON.parse(await readFile(path.join(digestProject, "build-info.json"), "utf8"));
    invalidBuiltAtInfo.builtAt = "July 15, 2026";
    await writeFile(path.join(digestProject, "build-info.json"), JSON.stringify(invalidBuiltAtInfo, null, 2));
    const invalidBuiltAtStage = spawnSync(process.execPath, [path.join(digestProject, "scripts", "prepare-electron-app.mjs")], {
      cwd: digestProject,
      env: derivedEnv,
      encoding: "utf8",
    });
    assert.notEqual(invalidBuiltAtStage.status, 0);
    assert.match(invalidBuiltAtStage.stderr, /builtAt is invalid/);
    pass("strict SemVer and canonical builtAt enforced", "invalid SemVer generator inputs and non-ISO staging metadata rejected");

    await assertElectronMetadataRejected(tempRoot, null, /构建元数据缺失或损坏/);
    await assertElectronMetadataRejected(tempRoot, "{", /构建元数据缺失或损坏/);
    await assertElectronMetadataRejected(tempRoot, JSON.stringify({
      ...secondBuild,
      appVersion: "9.9.9",
      buildId: `9.9.9+local.${secondBuild.sourceDigest.slice(0, 12)}`,
    }), /应用版本不一致/);
    pass("missing, malformed or mismatched metadata blocks Electron startup", "three packaged-startup rejection paths");

    const unsupportedMetadataRoot = path.join(tempRoot, "unsupported-metadata");
    await mkdir(unsupportedMetadataRoot, { recursive: true });
    await writeFile(path.join(unsupportedMetadataRoot, "package.json"), JSON.stringify({ version: secondBuild.appVersion }));
    await writeFile(path.join(unsupportedMetadataRoot, "build-info.json"), JSON.stringify({
      ...secondBuild,
      versions: { ...secondBuild.versions, databaseSchema: 2 },
    }));
    const unsupportedMetadata = runHelper("version-info", unsupportedMetadataRoot, unsupportedMetadataRoot);
    assert.notEqual(unsupportedMetadata.status, 0);
    assert.match(unsupportedMetadata.stderr, /database schema version is unsupported/);
    pass("semantically unsupported metadata rejected", "database schema 2 rejected before runtime initialization");

    const forgedMetadataRoot = path.join(tempRoot, "forged-metadata");
    await mkdir(forgedMetadataRoot, { recursive: true });
    await writeFile(path.join(forgedMetadataRoot, "package.json"), JSON.stringify({ version: secondBuild.appVersion }));
    await writeFile(path.join(forgedMetadataRoot, "build-info.json"), JSON.stringify({ ...secondBuild, buildIdSource: "derived", buildId: "FORGED.valid-id" }));
    const forgedMetadata = runHelper("version-info", forgedMetadataRoot, forgedMetadataRoot);
    assert.notEqual(forgedMetadata.status, 0);
    assert.match(forgedMetadata.stderr, /derived (?:Build ID|identity) does not match sourceDigest/);
    pass("forged derived Build ID rejected", "Build ID/sourceDigest mismatch rejected");

    const unknownMetadataRoot = path.join(tempRoot, "unknown-metadata");
    await mkdir(unknownMetadataRoot, { recursive: true });
    await writeFile(path.join(unknownMetadataRoot, "package.json"), JSON.stringify({ version: secondBuild.appVersion }));
    await writeFile(path.join(unknownMetadataRoot, "build-info.json"), JSON.stringify({
      ...secondBuild,
      credentials: { apiKey: "SENTINEL-SECRET" },
    }));
    const unknownMetadata = runHelper("version-info", unknownMetadataRoot, unknownMetadataRoot);
    assert.notEqual(unknownMetadata.status, 0);
    assert.match(unknownMetadata.stderr, /root fields are invalid/);
    assert(!unknownMetadata.stdout.includes("SENTINEL-SECRET"));
    pass("unknown metadata fields rejected", "secret-bearing extension rejected before public version export");

    const invalidRuntimeMetadataRoot = path.join(tempRoot, "invalid-runtime-metadata");
    await mkdir(invalidRuntimeMetadataRoot, { recursive: true });
    await writeFile(path.join(invalidRuntimeMetadataRoot, "package.json"), JSON.stringify({ version: secondBuild.appVersion }));
    for (const invalidBuiltAt of ["July 15, 2026", "2026-02-30", "2026-07-15"]) {
      await writeFile(path.join(invalidRuntimeMetadataRoot, "build-info.json"), JSON.stringify({ ...secondBuild, builtAt: invalidBuiltAt }));
      const invalidRuntimeBuiltAt = runHelper("version-info", invalidRuntimeMetadataRoot, invalidRuntimeMetadataRoot);
      assert.notEqual(invalidRuntimeBuiltAt.status, 0);
      assert.match(invalidRuntimeBuiltAt.stderr, /builtAt is invalid/);
    }
    const invalidRuntimeSemver = "01.2.3";
    await writeFile(path.join(invalidRuntimeMetadataRoot, "package.json"), JSON.stringify({ version: invalidRuntimeSemver }));
    await writeFile(path.join(invalidRuntimeMetadataRoot, "build-info.json"), JSON.stringify({
      ...secondBuild,
      appVersion: invalidRuntimeSemver,
      buildId: `${invalidRuntimeSemver}+local.${secondBuild.sourceDigest.slice(0, 12)}`,
    }));
    const invalidRuntimeVersion = runHelper("version-info", invalidRuntimeMetadataRoot, invalidRuntimeMetadataRoot);
    assert.notEqual(invalidRuntimeVersion.status, 0);
    assert.match(invalidRuntimeVersion.stderr, /appVersion is invalid/);
    pass("runtime rejects noncanonical version timestamps", "strict SemVer and canonical ISO builtAt enforced before export");

    const versionBranchRoot = path.join(tempRoot, "version-branch-matrix");
    await mkdir(versionBranchRoot, { recursive: true });
    const versionBranchPackage = path.join(versionBranchRoot, "package.json");
    const versionBranchInfo = path.join(versionBranchRoot, "build-info.json");
    const invalidVersionCases = [
      ["null root", null, /must be an object/],
      ["schema identity", { ...secondBuild, schemaVersion: 2 }, /identity\/schema/],
      ["product identity", { ...secondBuild, product: "Other" }, /identity\/schema/],
      ["appVersion type", { ...secondBuild, appVersion: 1 }, /appVersion is invalid/],
      ["buildId syntax", { ...secondBuild, buildId: "" }, /buildId is invalid/],
      ["buildId source", { ...secondBuild, buildIdSource: "manual" }, /buildIdSource is invalid/],
      ["source digest", { ...secondBuild, sourceDigest: "bad" }, /sourceDigest is invalid/],
      ["dist integrity", { ...secondBuild, distIntegritySha256: "bad" }, /distIntegritySha256 is invalid/],
      ["versions missing", { ...secondBuild, versions: null }, /versions are missing/],
      ["session export version", { ...secondBuild, versions: { ...secondBuild.versions, sessionExport: 2 } }, /Session Export version is unsupported/],
      ["protocols missing", { ...secondBuild, versions: { ...secondBuild.versions, protocols: null } }, /protocols are missing/],
      ["protocol keys", { ...secondBuild, versions: { ...secondBuild.versions, protocols: { ...secondBuild.versions.protocols, extra: null } } }, /protocols fields are invalid/],
      ["protocol missing", { ...secondBuild, versions: { ...secondBuild.versions, protocols: { ...secondBuild.versions.protocols, link: null } } }, /protocol link is missing/],
      ["protocol enabled", { ...secondBuild, versions: { ...secondBuild.versions, protocols: { ...secondBuild.versions.protocols, link: { ...secondBuild.versions.protocols.link, enabled: "yes" } } } }, /enabled is invalid/],
      ["protocol version", { ...secondBuild, versions: { ...secondBuild.versions, protocols: { ...secondBuild.versions.protocols, link: { ...secondBuild.versions.protocols.link, version: 0 } } } }, /version is invalid/],
      ["enabled without version", { ...secondBuild, versions: { ...secondBuild.versions, protocols: { ...secondBuild.versions.protocols, link: { version: null, enabled: true, transport: "in-process" } } } }, /enabled without a version/],
      ["disabled with version", { ...secondBuild, versions: { ...secondBuild.versions, protocols: { ...secondBuild.versions.protocols, link: { version: 1, enabled: false, transport: "in-process" } } } }, /disabled but advertises a version/],
      ["transport type", { ...secondBuild, versions: { ...secondBuild.versions, protocols: { ...secondBuild.versions.protocols, link: { ...secondBuild.versions.protocols.link, transport: 1 } } } }, /transport is invalid/],
      ["unsupported registry", { ...secondBuild, versions: { ...secondBuild.versions, protocols: { ...secondBuild.versions.protocols, link: { version: 2, enabled: true, transport: "in-process" } } } }, /capability registry is unsupported/],
      ["baseline missing", { ...secondBuild, versions: { ...secondBuild.versions, luxBaseline: null } }, /baseline metadata is missing/],
      ["baseline keys", { ...secondBuild, versions: { ...secondBuild.versions, luxBaseline: { ...secondBuild.versions.luxBaseline, extra: true } } }, /Lux baseline fields are invalid/],
      ["baseline identity", { ...secondBuild, versions: { ...secondBuild.versions, luxBaseline: { ...secondBuild.versions.luxBaseline, targetVersion: "0.1.899" } } }, /baseline metadata is unsupported/],
    ];
    await writeFile(versionBranchPackage, JSON.stringify({ version: secondBuild.appVersion }));
    for (const [name, candidate, expectedError] of invalidVersionCases) {
      await writeFile(versionBranchInfo, JSON.stringify(candidate));
      const rejected = runHelper("version-info", versionBranchRoot, versionBranchRoot);
      assert.notEqual(rejected.status, 0, `${name} must be rejected`);
      assert.match(rejected.stderr, expectedError, name);
    }
    await writeFile(versionBranchInfo, JSON.stringify(secondBuild));
    await writeFile(versionBranchPackage, JSON.stringify({ version: "9.9.9" }));
    const mismatchedPackageVersion = runHelper("version-info", versionBranchRoot, versionBranchRoot);
    assert.notEqual(mismatchedPackageVersion.status, 0);
    assert.match(mismatchedPackageVersion.stderr, /package.json version 9.9.9 does not match/);

    const emptyDatabaseRoot = path.join(tempRoot, "empty-database");
    await mkdir(path.join(emptyDatabaseRoot, "data"), { recursive: true });
    await writeFile(path.join(emptyDatabaseRoot, "data", "mini-lux.db"), Buffer.alloc(0));
    const emptyDatabaseRun = runHelper("db-version", emptyDatabaseRoot);
    assert.equal(emptyDatabaseRun.status, 0, emptyDatabaseRun.stderr);
    assert.equal(emptyDatabaseRun.payload?.userVersion, 1);

    const invalidHeaderRoot = path.join(tempRoot, "invalid-header");
    await mkdir(path.join(invalidHeaderRoot, "data"), { recursive: true });
    const invalidHeaderPath = path.join(invalidHeaderRoot, "data", "mini-lux.db");
    await writeFile(invalidHeaderPath, Buffer.from("not-a-sqlite-database"));
    const invalidHeaderBefore = createHash("sha256").update(await readFile(invalidHeaderPath)).digest("hex");
    const invalidHeaderRun = runHelper("db-version", invalidHeaderRoot);
    assert.notEqual(invalidHeaderRun.status, 0);
    assert.match(invalidHeaderRun.stderr, /数据库文件头无效/);
    assert.equal(createHash("sha256").update(await readFile(invalidHeaderPath)).digest("hex"), invalidHeaderBefore);

    const fresh = path.join(tempRoot, "fresh");
    await mkdir(fresh, { recursive: true });
    const freshRun = runHelper("db-version", fresh);
    assert.equal(freshRun.status, 0, freshRun.stderr);
    assert.equal(freshRun.payload?.userVersion, 1);
    pass("fresh database migrates 0 to 1", "user_version=1");

    const lifecycleWrite = runHelper("db-lifecycle-write", fresh);
    assert.equal(lifecycleWrite.status, 0, lifecycleWrite.stderr);
    assert.deepEqual(lifecycleWrite.payload, { sessions: 1, memos: 1 });
    const lifecycleRestart = runHelper("db-version", fresh);
    assert.equal(lifecycleRestart.status, 0, lifecycleRestart.stderr);
    assert.equal(lifecycleRestart.payload?.userVersion, 1);
    const lifecycleDatabase = new Database(path.join(fresh, "data", "mini-lux.db"), { readonly: true });
    assert.equal(lifecycleDatabase.prepare("SELECT title FROM sessions WHERE id = 'restart-session'").get().title, "Restart");
    assert.equal(lifecycleDatabase.prepare("SELECT content FROM memos").get().content, "restart-memo");
    lifecycleDatabase.close();
    pass("legitimate memo and session writes survive database restart", "Schema 1 reopens with session and memo rows preserved");

    const legacy = path.join(tempRoot, "legacy");
    await mkdir(path.join(legacy, "data"), { recursive: true });
    const legacyPath = path.join(legacy, "data", "mini-lux.db");
    let database = new Database(legacyPath);
    database.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'observation', tags TEXT, created_at TEXT NOT NULL); INSERT INTO memories(content,kind,tags,created_at) VALUES ('preserve-me','observation',NULL,'2026-01-01T00:00:00.000Z');");
    database.close();
    const legacyRun = runHelper("db-version", legacy);
    assert.equal(legacyRun.status, 0, legacyRun.stderr);
    database = new Database(legacyPath, { readonly: true });
    assert.equal(database.pragma("user_version", { simple: true }), 1);
    assert.equal(database.prepare("SELECT content FROM memories").get().content, "preserve-me");
    assert(database.prepare("PRAGMA table_info(memories)").all().some((entry) => entry.name === "embedding"));
    database.close();
    pass("legacy database migrates without data loss", "sentinel row preserved");

    const future = path.join(tempRoot, "future");
    await mkdir(path.join(future, "data"), { recursive: true });
    const futurePath = path.join(future, "data", "mini-lux.db");
    database = new Database(futurePath); database.pragma("user_version = 2"); database.close();
    const futureHashBefore = createHash("sha256").update(await readFile(futurePath)).digest("hex");
    const futureRun = runHelper("db-version", future);
    assert.notEqual(futureRun.status, 0);
    const futureHashAfter = createHash("sha256").update(await readFile(futurePath)).digest("hex");
    assert.equal(futureHashAfter, futureHashBefore);
    database = new Database(futurePath, { readonly: true });
    assert.equal(database.pragma("user_version", { simple: true }), 2); database.close();
    pass("future database rejected without mutation", `database SHA-256 unchanged: ${futureHashBefore}`);

    const futureWal = path.join(tempRoot, "future-wal");
    await mkdir(path.join(futureWal, "data"), { recursive: true });
    const futureWalPath = path.join(futureWal, "data", "mini-lux.db");
    database = new Database(futureWalPath);
    try {
      database.pragma("journal_mode = WAL");
      database.pragma("wal_autocheckpoint = 0");
      database.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel(value) VALUES ('keep-in-wal'); PRAGMA user_version = 77;");
      const walFiles = [futureWalPath, `${futureWalPath}-wal`, `${futureWalPath}-shm`];
      const futureWalBefore = await Promise.all(walFiles.map((file) => readFile(file)));
      const futureWalRun = runHelper("db-version", futureWal);
      assert.notEqual(futureWalRun.status, 0);
      assert.match(futureWalRun.stderr, /当前 77/);
      const futureWalAfter = await Promise.all(walFiles.map((file) => readFile(file)));
      for (let index = 0; index < walFiles.length; index++) {
        assert(futureWalAfter[index].equals(futureWalBefore[index]), `${path.basename(walFiles[index])} changed during future WAL rejection`);
      }
      pass("future WAL database rejected byte-identically", "main, WAL and SHM bytes unchanged while writer remained open");
    } finally {
      database.close();
    }

    const corrupt = path.join(tempRoot, "corrupt");
    await mkdir(path.join(corrupt, "data"), { recursive: true });
    const corruptPath = path.join(corrupt, "data", "mini-lux.db");
    database = new Database(corruptPath); database.exec("CREATE TABLE memories (id INTEGER PRIMARY KEY, embedding BLOB)"); database.close();
    const corruptRun = runHelper("db-version", corrupt);
    assert.notEqual(corruptRun.status, 0);
    database = new Database(corruptPath, { readonly: true });
    assert.equal(database.pragma("user_version", { simple: true }), 0);
    assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((entry) => entry.name), ["memories"]);
    database.close();
    pass("failed migration rolls back", "user_version=0 and no partial tables");

    const impostor = path.join(tempRoot, "constraint-impostor");
    await mkdir(path.join(impostor, "data"), { recursive: true });
    const impostorPath = path.join(impostor, "data", "mini-lux.db");
    database = new Database(impostorPath);
    database.exec("CREATE TABLE sessions (id TEXT, persona_name TEXT, title TEXT, created_at TEXT, updated_at TEXT)");
    database.close();
    const impostorRun = runHelper("db-version", impostor);
    assert.notEqual(impostorRun.status, 0);
    assert.match(impostorRun.stderr, /table sessions SQL 定义错误/);
    database = new Database(impostorPath);
    assert.equal(database.pragma("user_version", { simple: true }), 0);
    database.prepare("INSERT INTO sessions(id,persona_name,title,created_at,updated_at) VALUES ('duplicate','p','a','t','t')").run();
    database.prepare("INSERT INTO sessions(id,persona_name,title,created_at,updated_at) VALUES ('duplicate','p','b','t','t')").run();
    assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sessions WHERE id='duplicate'").get().count, 2);
    assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((entry) => entry.name), ["sessions"]);
    database.close();
    pass("constraint-impostor schema rejected and rolled back", "duplicate IDs remain possible only in rejected user_version=0 fixture");

    const partialIndex = path.join(tempRoot, "partial-index-impostor");
    await mkdir(path.join(partialIndex, "data"), { recursive: true });
    const partialIndexPath = path.join(partialIndex, "data", "mini-lux.db");
    await cp(path.join(fresh, "data", "mini-lux.db"), partialIndexPath);
    database = new Database(partialIndexPath);
    try {
      database.pragma("user_version = 0");
      database.exec("DROP INDEX idx_messages_session; CREATE INDEX idx_messages_session ON messages(session_id) WHERE role = 'never'");
    } finally {
      database.close();
    }
    const partialIndexRun = runHelper("db-version", partialIndex);
    assert.notEqual(partialIndexRun.status, 0);
    assert.match(partialIndexRun.stderr, /index idx_messages_session SQL 定义错误/);
    database = new Database(partialIndexPath, { readonly: true });
    try {
      assert.equal(database.pragma("user_version", { simple: true }), 0);
    } finally {
      database.close();
    }
    pass("partial-index schema impostor rejected", "named partial index cannot impersonate Schema 1");

    const extraConstraint = path.join(tempRoot, "extra-constraint-impostor");
    await mkdir(path.join(extraConstraint, "data"), { recursive: true });
    const extraConstraintPath = path.join(extraConstraint, "data", "mini-lux.db");
    await cp(path.join(fresh, "data", "mini-lux.db"), extraConstraintPath);
    database = new Database(extraConstraintPath);
    try {
      database.pragma("foreign_keys = OFF");
      database.pragma("legacy_alter_table = ON");
      database.exec(`
        ALTER TABLE sessions RENAME TO sessions_old;
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          persona_name TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '新对话',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          CHECK(length(id) > 1000)
        );
        DROP TABLE sessions_old;
      `);
      database.pragma("user_version = 0");
    } finally {
      database.close();
    }
    const extraConstraintRun = runHelper("db-version", extraConstraint);
    assert.notEqual(extraConstraintRun.status, 0);
    assert.match(extraConstraintRun.stderr, /table sessions SQL 定义错误/);
    database = new Database(extraConstraintPath, { readonly: true });
    try {
      assert.equal(database.pragma("user_version", { simple: true }), 0);
    } finally {
      database.close();
    }
    pass("extra-constraint schema impostor rejected", "additional CHECK cannot impersonate Schema 1");

    const extraTrigger = path.join(tempRoot, "extra-trigger-impostor");
    await mkdir(path.join(extraTrigger, "data"), { recursive: true });
    const extraTriggerPath = path.join(extraTrigger, "data", "mini-lux.db");
    await cp(path.join(fresh, "data", "mini-lux.db"), extraTriggerPath);
    database = new Database(extraTriggerPath);
    try {
      database.pragma("user_version = 0");
      database.exec("CREATE TRIGGER audit_extra_trigger BEFORE INSERT ON messages BEGIN SELECT 1; END;");
    } finally {
      database.close();
    }
    const extraTriggerRun = runHelper("db-version", extraTrigger);
    assert.notEqual(extraTriggerRun.status, 0);
    assert.match(extraTriggerRun.stderr, /未知或缺失的 Schema 对象/);
    database = new Database(extraTriggerPath, { readonly: true });
    try {
      assert.equal(database.pragma("user_version", { simple: true }), 0);
    } finally {
      database.close();
    }
    pass("extra-trigger schema impostor rejected", "unknown trigger cannot alter Schema 1 writes");

    const sessionRoot = path.join(tempRoot, "sessions");
    await mkdir(sessionRoot, { recursive: true });
    const sessionRun = runHelper("session-formats", sessionRoot);
    assert.equal(sessionRun.status, 0, sessionRun.stderr);
    assert.equal(sessionRun.payload.exportFormat, "mini-lux-session");
    assert.equal(sessionRun.payload.exportVersion, 1);
    assert.deepEqual(sessionRun.payload.failures, [
      "UNSUPPORTED_SESSION_EXPORT",
      "INVALID_SESSION_EXPORT",
      "UNSUPPORTED_SESSION_EXPORT",
      "INVALID_SESSION_EXPORT",
      "INVALID_SESSION_EXPORT",
      "UNSUPPORTED_SESSION_EXPORT",
      "INVALID_SESSION_EXPORT",
      "UNSUPPORTED_SESSION_EXPORT",
      "INVALID_SESSION_EXPORT",
      "INVALID_SESSION_EXPORT",
      "INVALID_SESSION_EXPORT",
      "INVALID_SESSION_EXPORT",
    ]);
    assert.equal(sessionRun.payload.toolRoundTripTitle, "Tool round trip");
    assert.equal(sessionRun.payload.invalidWrites, 0);
    assert.equal(sessionRun.payload.registeredSessionIds.length, 4);
    assert.match(sessionRun.payload.transactionRollback.error, /forced import failure/);
    assert.deepEqual(sessionRun.payload.transactionRollback.after, sessionRun.payload.transactionRollback.before);
    assert.deepEqual(sessionRun.payload.renameLifecycle, {
      ghostRename: false,
      ghostRegistered: false,
      realRename: true,
      statusAfterRename: "running",
    });
    assert.match(sessionRun.payload.forkRollback.error, /forced fork failure/);
    assert.deepEqual(sessionRun.payload.forkRollback.after, sessionRun.payload.forkRollback.before);
    assert.equal(sessionRun.payload.branchMatrix.failures.length, 19);
    assert(sessionRun.payload.branchMatrix.failures.every((entry) => entry === "INVALID_SESSION_EXPORT"));
    assert.equal(sessionRun.payload.branchMatrix.emptyAutoTitle, "");
    assert.equal(sessionRun.payload.branchMatrix.longAutoTitle, "x".repeat(30));
    assert.equal(sessionRun.payload.branchMatrix.untitledDefault, "新对话");
    assert.equal(sessionRun.payload.branchMatrix.renamedTitle, `${"x".repeat(30)}...`);
    assert(sessionRun.payload.branchMatrix.allSessionCount > 0);
    assert.equal(sessionRun.payload.branchMatrix.touchedOrder.firstId, "touch-order-old");
    assert(Date.parse(sessionRun.payload.branchMatrix.touchedOrder.touchedAt) > Date.parse(sessionRun.payload.branchMatrix.touchedOrder.peerAt));
    assert.equal(sessionRun.payload.branchMatrix.missingPost, false);
    assert.match(sessionRun.payload.branchMatrix.missingForkError, /源会话不存在/);
    assert.match(sessionRun.payload.branchMatrix.boundedForkTitle, /\(fork\)$/);
    assert.match(sessionRun.payload.branchMatrix.identityConflictError, /身份冲突/);
    pass("Session Export current, legacy and rejection matrix", "invalid writes=0; import/fork rollback and Link lifecycle leave zero residue");

    const linkRoot = path.join(tempRoot, "link");
    await mkdir(linkRoot, { recursive: true });
    const linkRun = runHelper("link-protocol", linkRoot);
    assert.equal(linkRun.status, 0, linkRun.stderr);
    assert.equal(linkRun.payload.invalidRegistration, false);
    assert.equal(linkRun.payload.bareId, false);
    assert.equal(linkRun.payload.malformed, false);
    assert.equal(linkRun.payload.spoofed, false);
    assert.equal(linkRun.payload.incompatible, false);
    assert.equal(linkRun.payload.afterIncompatible.length, 0);
    assert.equal(linkRun.payload.compatible, true);
    assert.equal(linkRun.payload.conflictingRegistration, false);
    assert.equal(linkRun.payload.repeatedRegistration, true);
    assert.equal(linkRun.payload.missingTarget, false);
    assert.deepEqual(linkRun.payload.emptyMissingQueue, []);
    assert.deepEqual(linkRun.payload.queueAfterDrain, []);
    assert.deepEqual(linkRun.payload.callbackMessages, ["good"]);
    assert.equal(linkRun.payload.unsubscribeAfterRemoval, null);
    pass("Link protocol rejects unsupported versions", "incompatible delivery=false");

    const serverRoot = path.join(tempRoot, "server");
    await mkdir(path.join(serverRoot, "output"), { recursive: true });
    const runtimeBuild = JSON.parse(await readFile(path.join(runtimeRoot, "build-info.json"), "utf8"));
    const server = await startServer(serverRoot, runtimeBuild);
    try {
      const headers = { "X-RainyDays-Token": server.token };
      const version = await (await fetch(`http://127.0.0.1:${server.port}/api/version`, { headers })).json();
      const status = await (await fetch(`http://127.0.0.1:${server.port}/api/status`, { headers })).json();
      const diagnosticResponse = await fetch(`http://127.0.0.1:${server.port}/api/diagnostics`, { headers });
      const diagnostics = await diagnosticResponse.json();
      assert.deepEqual(version, runtimeBuild);
      assert.deepEqual(status.version, runtimeBuild);
      assert.deepEqual(diagnostics.version, runtimeBuild);
      assert.equal(diagnostics.databaseSchemaVersion, 1);
      assert.equal(diagnostics.runtime.electron, "33.4.11");
      assert.equal(diagnostics.protocols.worker.version, null);
      assert.equal(diagnostics.protocols.worker.enabled, false);
      assert.equal(diagnostics.protocols.mcp.version, null);
      const serialized = JSON.stringify(diagnostics);
      assert(!serialized.includes(server.token));
      assert(!serialized.includes(serverRoot));
      assert(!/apiKey/i.test(serialized));
      assert.equal(diagnosticResponse.headers.get("content-disposition"), `attachment; filename="rainydays-diagnostics-${artifactSafeBuildId(runtimeBuild.buildId)}.json"`);
      pass("API, log and diagnostics share one Build ID", runtimeBuild.buildId);
    } finally {
      await stopChild(server.child);
    }

    const html = await readFile(path.join(projectRoot, "public", "index.html"), "utf8");
    assert(!html.includes('<span class="ver">v1.0</span>'));
    assert(html.includes('id="app-version"'));
    pass("UI no longer hard-codes v1.0", "version rendered from /api/status");

    console.log(JSON.stringify({ passed: scenarios.length, failed: 0, durationMs: Date.now() - started, scenarios }, null, 2));
  } finally {
    await rm(tempRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
