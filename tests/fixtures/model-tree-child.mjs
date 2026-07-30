import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

const [scenario, appRoot, userDataRoot, outsideRoot] = process.argv.slice(2);
assert(["stable", "content-change", "entry-added", "redirect", "coverage"].includes(scenario));
for (const candidate of [appRoot, userDataRoot, outsideRoot]) assert(path.isAbsolute(candidate));

process.env.RAINYDAYS_APP_ROOT = appRoot;
process.env.RAINYDAYS_USER_DATA_DIR = userDataRoot;
process.env.RAINYDAYS_DATA_DIR = path.join(userDataRoot, "data");
process.env.RAINYDAYS_MODELS_DIR = path.join(appRoot, "models");

const modelRoot = path.join(appRoot, "models", "Xenova", "multilingual-e5-small");
await fs.mkdir(modelRoot, { recursive: true });
await fs.mkdir(userDataRoot, { recursive: true });
await fs.mkdir(outsideRoot, { recursive: true });
const configPath = path.join(modelRoot, "config.json");
const original = "ORIGINAL-MODEL-CONTENT";
await fs.writeFile(configPath, original);
const fixedModelTime = new Date("2024-01-01T00:00:00.000Z");
if (scenario === "content-change") await fs.utimes(configPath, fixedModelTime, fixedModelTime);
if (scenario === "coverage") {
  await fs.mkdir(path.join(appRoot, "public"), { recursive: true });
  await fs.mkdir(path.join(appRoot, "dist"), { recursive: true });
  await fs.mkdir(path.join(appRoot, "src"), { recursive: true });
  await fs.writeFile(path.join(appRoot, "public", "index.html"), "<main>index</main>");
  await fs.writeFile(path.join(appRoot, "public", "asset.txt"), "public-asset");
  await fs.writeFile(path.join(appRoot, "app-file.txt"), "app-file");
  await fs.writeFile(path.join(appRoot, "dist", "document-parser-worker.js"), "export {};\n");
  await fs.writeFile(path.join(appRoot, "src", "index.ts"), "export {};\n");
}

if (scenario === "redirect") {
  const sentinel = path.join(outsideRoot, "sentinel.bin");
  await fs.writeFile(sentinel, "EXTERNAL-SENTINEL");
  await fs.symlink(outsideRoot, path.join(modelRoot, "redirected"), "junction");
}

const { getBootstrapPathStore } = await import("../../dist/bootstrap-path-store.js");
const { PathDeniedError } = await import("../../dist/path-policy.js");
const store = getBootstrapPathStore();

if (scenario === "coverage") {
  assert.deepEqual(await store.readAppFile("app-file.txt"), Buffer.from("app-file"));
  await assert.rejects(() => store.readAppFile(path.join(appRoot, "app-file.txt")), error => error instanceof PathDeniedError && error.code === "PATH_INPUT_INVALID");
  assert.equal(await store.withAppCwd(canonical => path.basename(canonical)), path.basename(appRoot));
  assert.equal(await store.withAppFile("app-file.txt", canonical => path.basename(canonical)), "app-file.txt");
  const swappedAppFile = path.join(appRoot, "swapped.txt");
  const movedAppFile = path.join(appRoot, "swapped-original.txt");
  await fs.writeFile(swappedAppFile, "original");
  await assert.rejects(() => store.withAppFile("swapped.txt", async canonical => {
    await fs.rename(canonical, movedAppFile);
    await fs.writeFile(canonical, "replacement");
  }), error => error instanceof PathDeniedError && error.code === "PATH_IDENTITY_CHANGED");
  assert.equal((await store.readPublicAsset("/")).extension, ".html");
  assert.deepEqual((await store.readPublicAsset("/asset.txt")).bytes, Buffer.from("public-asset"));
  for (const invalid of ["asset.txt", "/%E0%A4%A", "/bad\\name"]) {
    await assert.rejects(() => store.readPublicAsset(invalid), error => error instanceof PathDeniedError && error.code === "PATH_INPUT_INVALID");
  }

  assert.equal(await store.ensureUserDataDescendantDirectory(userDataRoot), false);
  assert.equal(await store.ensureUserDataDescendantDirectory(outsideRoot), false);
  const outputDirectory = path.join(userDataRoot, "nested", "output");
  assert.equal(await store.ensureUserDataDescendantDirectory(outputDirectory), true);
  assert.equal(await store.ensureUserDataDescendantDirectory(outputDirectory), true);
  const nonDirectory = path.join(userDataRoot, "not-a-directory");
  await fs.writeFile(nonDirectory, "file");
  await assert.rejects(() => store.ensureUserDataDescendantDirectory(nonDirectory), error => error instanceof PathDeniedError && error.code === "PATH_TYPE_MISMATCH");

  const originalSystemRoot = process.env.SystemRoot;
  const originalWindir = process.env.WINDIR;
  delete process.env.SystemRoot;
  delete process.env.WINDIR;
  await assert.rejects(() => store.openRevealLauncher(), error => error instanceof PathDeniedError && error.code === "PATH_ROOT_UNAVAILABLE");
  process.env.SystemRoot = "relative-system-root";
  await assert.rejects(() => store.openRevealLauncher(), error => error instanceof PathDeniedError && error.code === "PATH_INPUT_INVALID");
  if (originalSystemRoot === undefined) delete process.env.SystemRoot;
  else process.env.SystemRoot = originalSystemRoot;
  if (originalWindir === undefined) delete process.env.WINDIR;
  else process.env.WINDIR = originalWindir;

  const configuredGit = path.join(outsideRoot, "git-probe.exe");
  await fs.writeFile(configuredGit, "git-probe");
  process.env.RAINYDAYS_GIT_EXECUTABLE = configuredGit;
  const runtimeLeases = [
    await store.openNodeExecutable(),
    await store.openProcessTreeKiller(),
    await store.openTerminalShell("cmd"),
    await store.openTerminalShell("powershell"),
    await store.openRevealLauncher(),
    await store.openGitExecutable(),
    await store.openDocumentParserWorker(),
    await store.openDaemonServerScript(),
    await store.openDaemonTsxLoader(),
  ];
  await assert.rejects(() => store.close(), /Runtime bootstrap lease is still active/);
  for (const runtimeLease of runtimeLeases) {
    assert(runtimeLease.size > 0);
    await runtimeLease.assertCurrent("beforeProcessSpawn");
    await runtimeLease.close();
    await runtimeLease.close();
    await assert.rejects(() => runtimeLease.assertCurrent(), error => error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_STALE");
  }

  const mutableRuntime = path.join(outsideRoot, "mutable-runtime.exe");
  await fs.writeFile(mutableRuntime, "ORIGINAL-RUNTIME");
  process.env.RAINYDAYS_GIT_EXECUTABLE = mutableRuntime;
  const mutableLease = await store.openGitExecutable();
  await fs.writeFile(mutableRuntime, "MUTATED!-RUNTIME");
  await assert.rejects(() => mutableLease.assertCurrent(), error => error instanceof PathDeniedError && error.code === "PATH_IDENTITY_CHANGED");
  await mutableLease.close();
  const emptyRuntime = path.join(outsideRoot, "empty-runtime.exe");
  await fs.writeFile(emptyRuntime, Buffer.alloc(0));
  process.env.RAINYDAYS_GIT_EXECUTABLE = emptyRuntime;
  await assert.rejects(() => store.openGitExecutable(), error => error instanceof PathDeniedError && error.code === "PATH_OPERATION_DENIED");

  const databaseLease = await store.openDatabaseFileLease();
  await databaseLease.assertPathCurrent();
  await databaseLease.close();
  await databaseLease.close();
  await assert.rejects(() => databaseLease.assertPathCurrent(), error => error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_STALE");
  const reusedDatabaseLease = await store.openDatabaseFileLease();
  await reusedDatabaseLease.close();

  assert.equal(await store.withModelsDirectory(canonical => path.basename(canonical)), "models");
  const injectedModel = path.join(modelRoot, "injected.json");
  await assert.rejects(() => store.withModelsDirectory(async () => {
    await fs.writeFile(injectedModel, "injected");
  }), error => error instanceof PathDeniedError && error.code === "PATH_IDENTITY_CHANGED");
  await fs.rm(injectedModel);
  await assert.rejects(() => store.withTemporaryDirectory("INVALID", () => undefined), TypeError);
  let temporaryPath = "";
  assert.equal(await store.withTemporaryDirectory("coverage", async canonical => {
    temporaryPath = canonical;
    assert.equal((await fs.stat(canonical)).isDirectory(), true);
    return "temporary-ok";
  }), "temporary-ok");
  await assert.rejects(() => fs.access(temporaryPath));
  const movedTemporary = path.join(outsideRoot, "moved-temporary");
  await assert.rejects(() => store.withTemporaryDirectory("swap", async canonical => {
    await fs.rename(canonical, movedTemporary);
    await fs.mkdir(canonical);
  }), error => error instanceof PathDeniedError && error.code === "PATH_IDENTITY_CHANGED");

  await store.close();
  console.log(JSON.stringify({ scenario, bootstrapSurfaceCovered: true, runtimeLeaseCount: runtimeLeases.length }));
  process.exit(0);
}

if (scenario === "redirect") {
  let code = null;
  await assert.rejects(() => store.openModelsTreeLease(), error => {
    code = error instanceof PathDeniedError ? error.code : null;
    return code === "PATH_REDIRECT_DENIED";
  });
  await store.close();
  console.log(JSON.stringify({ scenario, code, externalUnchanged: await fs.readFile(path.join(outsideRoot, "sentinel.bin"), "utf8") === "EXTERNAL-SENTINEL" }));
  process.exit(0);
}

const lease = await store.openModelsTreeLease();
let code = null;
if (scenario === "content-change") {
  await fs.writeFile(configPath, "MUTATED!-MODEL-CONTENT");
  await fs.utimes(configPath, fixedModelTime, fixedModelTime);
} else if (scenario === "entry-added") {
  await fs.writeFile(path.join(modelRoot, "injected.json"), "INJECTED");
}

if (scenario === "stable") await lease.assertCurrent();
else {
  await assert.rejects(() => lease.assertCurrent(), error => {
    code = error instanceof PathDeniedError ? error.code : null;
    return code === "PATH_IDENTITY_CHANGED";
  });
}
await lease.close();
await lease.close();
await store.close();
console.log(JSON.stringify({ scenario, code, fileCount: lease.fileCount, cleanClose: true }));
