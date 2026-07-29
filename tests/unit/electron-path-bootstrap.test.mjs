import assert from "node:assert/strict";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import test from "node:test";
import * as asar from "@electron/asar";

const require = createRequire(import.meta.url);
const { ElectronBootstrapPathStore, ElectronPathError } = require("../../electron/path-bootstrap.cjs");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-electron-bootstrap-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const app = path.join(root, "app");
  const electron = path.join(app, "electron");
  const userData = path.join(root, "user-data");
  const outside = path.join(root, "outside");
  await Promise.all([electron, userData, outside].map(directory => fs.mkdir(directory, { recursive: true })));
  return { root, app, electron, userData, outside };
}

function expectCode(action, code) {
  assert.throws(action, error => error instanceof ElectronPathError && error.code === code);
}

test("SEC-02 Electron bootstrap file leases are handle-backed and reject pathname replacement", async t => {
  const dirs = await fixture(t);
  const metadata = path.join(dirs.app, "build-info.json");
  await fs.writeFile(metadata, "ORIGINAL-METADATA");
  await fs.writeFile(path.join(dirs.electron, "preload.cjs"), "PRELOAD");
  const store = new ElectronBootstrapPathStore({
    appRoot: dirs.app,
    electronRoot: dirs.electron,
    userDataRoot: dirs.userData,
  });

  const lease = store.openAppFile("build-info.json", "metadata-test");
  assert.equal(lease.readBytes(1024).toString("utf8"), "ORIGINAL-METADATA");
  await fs.rename(metadata, path.join(dirs.app, "old-build-info.json"));
  await fs.writeFile(metadata, "REPLACEMENT-METADATA");
  assert.equal(lease.readBytes(1024).toString("utf8"), "ORIGINAL-METADATA");
  expectCode(() => lease.verify(), "PATH_IDENTITY_CHANGED");
  lease.close();
  expectCode(() => lease.readBytes(1024), "PATH_LEASE_CLOSED");

  const preload = store.openElectronFile("preload.cjs", "preload-test");
  assert.equal(preload.readBytes(1024).toString("utf8"), "PRELOAD");
  preload.verify();
  preload.close();

  const mutablePath = path.join(dirs.app, "mutable.txt");
  await fs.writeFile(mutablePath, "MUTABLE");
  const mutable = store.openAppFile("mutable.txt", "mutable-test");
  await fs.writeFile(mutablePath, "MUTATED-LONGER");
  expectCode(() => mutable.verify(), "PATH_IDENTITY_CHANGED");
  mutable.close();

  const equalLengthPath = path.join(dirs.app, "equal-length.txt");
  const fixedTime = new Date("2024-01-01T00:00:00.000Z");
  await fs.writeFile(equalLengthPath, "ORIGINAL-CONTENT");
  await fs.utimes(equalLengthPath, fixedTime, fixedTime);
  const equalLength = store.openAppFile("equal-length.txt", "equal-length-test");
  await fs.writeFile(equalLengthPath, "MUTATED!-CONTENT");
  await fs.utimes(equalLengthPath, fixedTime, fixedTime);
  assert.equal((await fs.stat(equalLengthPath)).size, Buffer.byteLength("ORIGINAL-CONTENT"));
  expectCode(() => equalLength.verify("before-equal-length-consumer"), "PATH_IDENTITY_CHANGED");
  equalLength.close();
});

test("SEC-02 Electron bootstrap deterministic execution barrier rejects pathname replacement before use", async t => {
  const dirs = await fixture(t);
  const entry = path.join(dirs.app, "entry.js");
  const original = path.join(dirs.app, "original-entry.js");
  await fs.writeFile(entry, "ORIGINAL");
  let barrierCalls = 0;
  const store = new ElectronBootstrapPathStore({
    appRoot: dirs.app,
    electronRoot: dirs.electron,
    userDataRoot: dirs.userData,
    barrier(point, role) {
      if (point !== "before-test-execution" || role !== "entry-test") return;
      barrierCalls += 1;
      nodeFs.renameSync(entry, original);
      nodeFs.writeFileSync(entry, "MALICIOUS");
    },
  });
  const lease = store.openAppFile("entry.js", "entry-test");
  expectCode(() => lease.verify("before-test-execution"), "PATH_IDENTITY_CHANGED");
  assert.equal(barrierCalls, 1);
  assert.equal(await fs.readFile(original, "utf8"), "ORIGINAL");
  assert.equal(await fs.readFile(entry, "utf8"), "MALICIOUS");
  lease.close();
});

test("SEC-02 Electron bootstrap binds an outer ASAR lifetime lease to strict internal bytes", async t => {
  const dirs = await fixture(t);
  const source = path.join(dirs.root, "asar-source");
  const archivePath = path.join(dirs.root, "app.asar");
  await fs.mkdir(path.join(source, "electron"), { recursive: true });
  await fs.writeFile(path.join(source, "build-info.json"), "ARCHIVE-METADATA");
  await fs.writeFile(path.join(source, "electron", "preload.cjs"), "ARCHIVE-PRELOAD");
  await asar.createPackage(source, archivePath);
  await fs.mkdir(`${archivePath}.unpacked`);
  const archiveFs = {
    statSync(candidate) {
      const relative = path.relative(archivePath, candidate);
      const metadata = asar.statFile(archivePath, relative, false);
      return { size: BigInt(metadata.size), isFile: () => "size" in metadata };
    },
    readFileSync(candidate) {
      return asar.extractFile(archivePath, path.relative(archivePath, candidate), false);
    },
  };
  const store = new ElectronBootstrapPathStore({
    appRoot: archivePath,
    electronRoot: path.join(archivePath, "electron"),
    userDataRoot: dirs.userData,
    nativeFs: nodeFs,
    archiveFs,
  });
  assert.equal(store.runtimeRoots().appRoot, await fs.realpath(`${archivePath}.unpacked`));
  const metadata = store.openAppFile("build-info.json", "archive-metadata");
  assert.equal(metadata.readBytes(1024).toString("utf8"), "ARCHIVE-METADATA");
  metadata.verify("before-archive-consumer");
  const preload = store.openElectronFile("preload.cjs", "archive-preload");
  assert.equal(preload.readBytes(1024).toString("utf8"), "ARCHIVE-PRELOAD");
  expectCode(() => store.openAppFile("..\\outside.txt", "archive-traversal"), "PATH_INPUT_INVALID");
  await assert.rejects(() => store.withAppRootDirectory("archive-cwd", async () => undefined), error => error instanceof ElectronPathError && error.code === "PATH_TYPE_DENIED");
  store.close();
  expectCode(() => metadata.verify(), "PATH_LEASE_CLOSED");
  expectCode(() => preload.verify(), "PATH_LEASE_CLOSED");
  metadata.close();
  preload.close();
});

test("SEC-02 Electron bootstrap rejects junction traversal and validates process identity", async t => {
  const dirs = await fixture(t);
  await fs.writeFile(path.join(dirs.app, "safe.txt"), "SAFE");
  await fs.writeFile(path.join(dirs.outside, "secret.txt"), "SECRET");
  await fs.symlink(dirs.outside, path.join(dirs.app, "linked"), "junction");
  const store = new ElectronBootstrapPathStore({
    appRoot: dirs.app,
    electronRoot: dirs.electron,
    userDataRoot: dirs.userData,
  });

  expectCode(() => store.openAppFile(path.join("linked", "secret.txt"), "junction-test"), "PATH_REDIRECT_DENIED");
  expectCode(() => store.openAppFile("..\\outside\\secret.txt", "traversal-test"), "PATH_INPUT_INVALID");

  const executable = store.openExternalTestExecutable(process.execPath);
  executable.verify();
  executable.close();

  const observed = await store.withAppRootDirectory("cwd-test", async canonical => {
    assert.equal(canonical, await fs.realpath(dirs.app));
    return "used";
  });
  assert.equal(observed, "used");
});
