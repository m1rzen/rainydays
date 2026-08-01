import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  sinkInventoryPath,
  validateSec02SinkInventory,
  validateSec02SinkPolicy,
} from "../../scripts/sec02-sink-inventory.mjs";
import { validatePackagedExecutableProjection } from "../../scripts/electron-asar-integrity.mjs";
import { scanSec02Source, scanSec02SourceSet, scanSec02Sinks } from "../../scripts/sec02-sink-scanner.mjs";
import {
  canonicalCrosscheckJson,
  crosscheckPolicyPath,
  scanSec02RestrictedRuntime,
  validateSec02RestrictedSourceSet,
} from "../../scripts/sec02-sink-crosscheck.mjs";
import { createSec02Recorder } from "../sec02-receipts.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const staticObservationIds = Object.freeze([
  "SEC02-P36-sink-inventory-complete",
  "SEC02-P36-legacy-helper-absent",
  "SEC02-P36-third-party-path-api-absent",
  "SEC02-P36-worker-path-absent",
  "SEC02-P36-electron-route-bound",
]);
const testCaseId = "SEC-02 sink inventory exactly matches AST closure and package projection";

test("SEC-02 sink inventory exactly matches AST closure and package projection", { timeout: 120_000 }, async t => {
  const recorder = await createSec02Recorder(import.meta.url, testCaseId);
  t.after(() => recorder.close());
  const result = await validateSec02SinkInventory(projectRoot);
  assert(result.executableFileCount > 0);
  assert(result.sinkCount >= result.runtimeSinkCount);
  const actual = {
    inventoryComplete: result.inventoryComplete,
    runtimeCanaryComplete: result.runtimeCanaryComplete,
    packagedBound: result.packagedBound,
  };
  if (recorder.enabled) {
    for (const id of staticObservationIds) await recorder.observe(id, actual);
  }
});

test("SEC-02 sink detector follows aliases, all process operands, multi-path APIs and unresolved governed calls", () => {
  const source = `
    import * as fs from "node:fs";
    import { exec } from "node:child_process";
    import { promisify } from "node:util";
    const promises = fs.promises;
    const { readFile: readAlias } = promises;
    const execute = promisify(exec);
    const options = { cwd: root, shell: shellPath };
    readAlias(input);
    execute(command, options);
    fs.rename(oldPath, newPath);
    fs[method](input);
    function shadow(fs) { fs.readFile(input); }
  `;
  const sites = scanSec02Source("src/synthetic-inventory-attack.ts", source);
  assert.deepEqual(sites.map(site => [site.family, site.api, site.pathOperands]), [
    ["node-fs", "readFile", ["argument:0"]],
    ["child-process", "exec", ["argument:0", "argument:1.cwd", "argument:1.shell"]],
    ["node-fs", "rename", ["argument:0", "argument:1"]],
    ["unresolved-governed-call", "computed-alias", ["callee-member"]],
  ]);
});

test("SEC-02 sink detector closes nested destructuring, computed aliases, native members and module loaders", () => {
  const source = `
    import * as fs from "node:fs";
    import * as mod from "node:module";
    const { promises: { readFile } } = fs;
    const { promises: { writeFile } } = require("node:fs");
    const fn = fs[method];
    const req = mod.createRequire(import.meta.url);
    readFile(input);
    writeFile(output, bytes);
    fn(other);
    fs.realpath.native(input, callback);
    fs.realpathSync.native(input);
    req(userSpecifier);
    await import("file:///C:/attacker/payload.mjs");
  `;
  const sites = scanSec02Source("src/synthetic-origin-attacks.ts", source);
  assert.deepEqual(sites.map(site => [site.family, site.api, site.pathOperands]), [
    ["module-loader", "require", ["argument:0"]],
    ["module-loader", "createRequire", ["argument:0"]],
    ["node-fs", "readFile", ["argument:0"]],
    ["node-fs", "writeFile", ["argument:0"]],
    ["unresolved-governed-call", "computed-alias", ["callee-member"]],
    ["node-fs", "realpath.native", ["argument:0"]],
    ["node-fs", "realpathSync", ["argument:0"]],
    ["module-loader", "createRequire-call", ["argument:0"]],
    ["module-loader", "import", ["argument:0"]],
  ]);
});

test("SEC-02 sink detector resolves re-export and CJS aliases across the authored source graph", () => {
  const sites = scanSec02SourceSet(new Map([
    ["src/fs-facade.ts", `export { readFile as unsafeRead } from "node:fs/promises";`],
    ["src/fs-chain.ts", `export { unsafeRead as chainedRead } from "./fs-facade.js";`],
    ["src/consumer.ts", `import { chainedRead } from "./fs-chain.js"; chainedRead(userPath);`],
    ["src/cjs-consumer.cjs", `const { unsafeRead } = require("./fs-facade.js"); unsafeRead(otherPath);`],
    ["src/namespace-consumer.ts", `import * as facade from "./fs-facade.js"; facade.unsafeRead(namespacePath);`],
  ]));
  assert.deepEqual(sites.filter(site => site.family === "node-fs").map(site => [site.sourcePath, site.api, site.pathOperands]), [
    ["src/cjs-consumer.cjs", "readFile", ["argument:0"]],
    ["src/consumer.ts", "readFile", ["argument:0"]],
    ["src/namespace-consumer.ts", "readFile", ["argument:0"]],
  ]);
});

test("SEC-02 sink detector follows assignment aliases and rejects conflicting governed reassignment", () => {
  const source = `
    import * as fs from "node:fs";
    import { exec } from "node:child_process";
    let assigned;
    assigned = fs.readFile;
    assigned(first);
    let conflict = fs.readFile;
    conflict = exec;
    conflict(second);
  `;
  const sites = scanSec02Source("src/synthetic-assignment-attacks.ts", source);
  assert.deepEqual(sites.map(site => [site.family, site.api]), [
    ["node-fs", "readFile"],
    ["unresolved-governed-call", "conflicting-alias"],
  ]);
});

test("SEC-02 sink detector propagates callable returns and parameters and rejects unknown wrappers", () => {
  const source = `
    import * as fs from "node:fs";
    const unknown = unknownFactory(fs.readFile);
    function getReader() { return fs.readFile; }
    function invoke(callable, value) { callable(value); }
    unknown(first);
    const returned = getReader();
    returned(second);
    invoke(fs.readFile, third);
  `;
  const sites = scanSec02Source("src/synthetic-call-flow-attacks.ts", source);
  assert.deepEqual(sites.map(site => [site.family, site.api, site.pathOperands]), [
    ["unresolved-governed-call", "governed-callback", ["argument:0"]],
    ["node-fs", "readFile", ["argument:0"]],
    ["unresolved-governed-call", "computed-alias", ["callee-member"]],
    ["node-fs", "readFile", ["argument:0"]],
  ]);
});

test("SEC-02 sink detector closes class fields, array aliases, arrow wrappers, callbacks and conditional origins", () => {
  const source = `
    import fs from "node:fs";
    class PrivateReader { #io = fs; read(value) { this.#io.readFileSync(value); } }
    class PublicReader { io = fs; read(value) { this.io.readFileSync(value); } }
    const [arrayRead] = [fs.readFileSync];
    const invoke = (callable, value) => callable(value);
    const conditional = flag ? fs.readFileSync : other;
    arrayRead(arrayPath);
    invoke(fs.readFileSync, wrapperPath);
    external(fs.readFileSync, callbackPath);
    conditional(conditionalPath);
  `;
  const sites = scanSec02Source("src/synthetic-class-flow-attacks.ts", source);
  assert.deepEqual(sites.map(site => [site.family, site.api, site.pathOperands]), [
    ["node-fs", "readFileSync", ["argument:0"]],
    ["node-fs", "readFileSync", ["argument:0"]],
    ["node-fs", "readFileSync", ["argument:0"]],
    ["node-fs", "readFileSync", ["argument:0"]],
    ["unresolved-governed-call", "governed-callback", ["argument:0"]],
    ["unresolved-governed-call", "conditional-alias", ["callee-member"]],
  ]);
});

test("SEC-02 sink detector resolves process overloads and fails closed on spread options", () => {
  const source = `
    import { spawn, fork, execFile } from "node:child_process";
    const two = { cwd: cwdA, shell: shellA };
    const three = {};
    three.cwd = cwdB;
    three.shell = shellB;
    spawn(command, two);
    spawn(command, argv, three);
    fork(modulePath, two);
    execFile(binary, two, callback);
    spawn(command, argv, { ...unknown, cwd: cwdC });
  `;
  const sites = scanSec02Source("src/synthetic-process-attacks.ts", source);
  assert.deepEqual(sites.map(site => [site.api, site.pathOperands]), [
    ["spawn", ["argument:0", "argument:1.cwd", "argument:1.shell"]],
    ["spawn", ["argument:0", "argument:1", "argument:2.cwd", "argument:2.shell"]],
    ["fork", ["argument:0", "argument:1.cwd", "argument:1.shell"]],
    ["execFile", ["argument:0", "argument:1.cwd", "argument:1.shell"]],
    ["spawn", ["argument:0", "argument:1", "argument:2.cwd", "argument:2.unresolved-spread"]],
  ]);
});

test("SEC-02 sink detector records exact Worker, Electron, Express and third-party option fields", () => {
  const source = `
    import { Worker } from "node:worker_threads";
    import { BrowserWindow } from "electron";
    import express from "express";
    import mammoth from "mammoth";
    const workerOptions = {};
    workerOptions.workerData = { bytes, fileName, path: userPath };
    new Worker(workerEntry, workerOptions);
    const windowOptions = {};
    windowOptions.icon = userIcon;
    windowOptions.webPreferences = { preload: userPreload };
    new BrowserWindow(windowOptions);
    express.static(userRoot);
    const response = express.response;
    response["sendFile"](userFile);
    const mammothOptions = {};
    mammothOptions.path = userDocument;
    mammoth.extractRawText(mammothOptions);
  `;
  const sites = scanSec02Source("src/synthetic-options-attacks.ts", source);
  assert.deepEqual(sites.map(site => [site.family, site.api, site.pathOperands]), [
    ["worker", "Worker", ["argument:0", "argument:1.workerData.bytes", "argument:1.workerData.fileName", "argument:1.workerData.path"]],
    ["electron-path-property", "BrowserWindow", ["argument:0.icon", "argument:0.webPreferences.preload"]],
    ["express-path-api", "static", ["argument:0"]],
    ["express-path-api", "sendFile", ["argument:0"]],
    ["third-party-path-api", "mammoth.extractRawText", ["argument:0.path"]],
  ]);
});

test("SEC-02 sink detector resolves CJS exports, reexports and loader aliases", () => {
  const sites = scanSec02SourceSet(new Map([
    ["src/facade.cjs", `const fs = require("node:fs"); exports.read = fs.readFileSync; module.exports.write = fs.writeFileSync;`],
    ["src/bridge.cjs", `module.exports = require("./facade.cjs");`],
    ["src/consumer.cjs", `const api = require("./bridge.cjs"); api.read(readPath); api.write(writePath, bytes);`],
  ]));
  assert.deepEqual(sites.filter(site => site.sourcePath === "src/consumer.cjs" && site.family === "node-fs")
    .map(site => [site.api, site.pathOperands]), [
    ["readFileSync", ["argument:0"]],
    ["writeFileSync", ["argument:0"]],
  ]);

  const loaders = scanSec02Source("src/loader-aliases.ts", `
    import { createRequire } from "node:module";
    let req;
    req = createRequire(import.meta.url);
    const alias = req;
    alias(firstSpecifier);
    createRequire(import.meta.url)(secondSpecifier);
    const loadRequire = require;
    loadRequire(thirdSpecifier);
  `).filter(site => site.family === "module-loader");
  assert.deepEqual(loaders.map(site => [site.api, site.pathOperands]), [
    ["createRequire", ["argument:0"]],
    ["createRequire-call", ["argument:0"]],
    ["createRequire-call", ["argument:0"]],
    ["createRequire", ["argument:0"]],
    ["require", ["argument:0"]],
  ]);
});

test("SEC-02 sink detector resolves nested destructuring and fails closed on conditional returns", () => {
  const source = `
    import fs from "node:fs";
    const [[deepRead]] = [[fs.readFileSync]];
    const methods = [fs.writeFileSync];
    const [arrayWrite] = methods;
    const holder = { nested: { read: fs.readFileSync } };
    const { nested: { read } } = holder;
    function choose(flag) { if (flag) return fs.readFileSync; return fs.writeFileSync; }
    deepRead(readPath);
    arrayWrite(writePath, bytes);
    read(nestedPath);
    const selected = choose(flag);
    selected(conditionalPath);
  `;
  const sites = scanSec02Source("src/nested-flow.ts", source);
  assert.deepEqual(sites.map(site => [site.family, site.api, site.pathOperands]), [
    ["node-fs", "readFileSync", ["argument:0"]],
    ["node-fs", "writeFileSync", ["argument:0"]],
    ["node-fs", "readFileSync", ["argument:0"]],
    ["unresolved-governed-call", "conditional-return", ["callee-member"]],
  ]);
});

test("SEC-02 sink detector respects lexical object and class shadowing", () => {
  const source = `
    import fs from "node:fs";
    function harmless() { const fs = { readFile(value) { return value; } }; fs.readFile(notAPath); }
    const dangerous = { read: fs.readFileSync };
    const safe = { read(value) { return value; } };
    safe.read(notAPath);
    class A { io = fs; }
    class B { io = { readFileSync(value) { return value; } }; run() { this.io.readFileSync(notAPath); } }
  `;
  assert.deepEqual(scanSec02Source("src/shadowing.ts", source), []);
});

test("SEC-02 sink detector records Electron, Express, XLSX, Worker and process operands exactly", () => {
  const source = `
    import { app, dialog, session, nativeImage, BrowserWindow } from "electron";
    import express from "express";
    import XLSX from "xlsx";
    import { Worker } from "node:worker_threads";
    import { execFile } from "node:child_process";
    app.setPath("userData", userDir);
    dialog.showOpenDialog({ defaultPath: dialogRoot });
    session.defaultSession.loadExtension(extensionDir);
    nativeImage.createThumbnailFromPath(imagePath, size);
    const window = new BrowserWindow();
    window.webContents.loadFile(rendererPath);
    const response = express.response;
    response.sendFile(fileName, { root: sendRoot });
    response.download(fileName, downloadName, { root: downloadRoot });
    unrelated.sendFile(notExpress);
    XLSX.writeFile(workbook, outputFile);
    XLSX.writeFileAsync(asyncFile, workbook, callback);
    new Worker(workerEntry, { workerData: { bytes, nested: { inputPath } } });
    execFile(binary, callback);
  `;
  const sites = scanSec02Source("src/api-operands.ts", source);
  assert.deepEqual(sites.map(site => [site.family, site.api, site.pathOperands]), [
    ["electron-path-api", "setPath", ["argument:1"]],
    ["electron-path-api", "showOpenDialog", ["argument:0.defaultPath"]],
    ["electron-path-api", "loadExtension", ["argument:0"]],
    ["electron-path-api", "createThumbnailFromPath", ["argument:0"]],
    ["electron-path-api", "loadFile", ["argument:0"]],
    ["express-path-api", "sendFile", ["argument:0", "argument:1.root"]],
    ["express-path-api", "download", ["argument:0", "argument:2.root"]],
    ["third-party-path-api", "xlsx.writeFile", ["argument:1"]],
    ["third-party-path-api", "xlsx.writeFileAsync", ["argument:0"]],
    ["worker", "Worker", ["argument:0", "argument:1.workerData.bytes", "argument:1.workerData.nested.inputPath"]],
    ["unresolved-governed-call", "process-overload", ["argument:1"]],
  ]);
});

test("SEC-02 production Electron bootstrap private-field and default-parameter filesystem sinks are visible", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(path.join(projectRoot, "electron", "path-bootstrap.cjs"), "utf8");
  const sites = scanSec02Source("electron/path-bootstrap.cjs", source);
  assert(sites.length >= 12);
  assert(sites.some(site => site.api === "realpathSync"));
  assert(sites.some(site => site.line === 217 && site.api === "realpathSync"));
  assert(sites.some(site => site.line === 218 && site.api === "statSync"));
  assert(sites.some(site => site.api === "openSync"));
  assert(sites.some(site => site.api === "readFileSync"));
});

test("SEC-02 reviewed sink policy rejects every new, unresolved and stale site before inventory generation", () => {
  const detector = "a".repeat(64);
  const makePolicy = bindings => {
    const payload = { schemaVersion: 1, task: "SEC-02", detectorPolicySha256: detector, bindings };
    return { ...payload, canonicalPayloadSha256: createHash("sha256").update(canonicalJson(payload)).digest("hex") };
  };
  const discovered = scanSec02Source("src/new-runtime-sink.ts", `import fs from "node:fs"; fs.readFile(userPath, callback);`);
  assert.throws(() => validateSec02SinkPolicy(makePolicy([]), discovered, detector), /UNBOUND_SINK/);
  const unresolved = scanSec02Source("src/new-runtime-sink.ts", `import fs from "node:fs"; fs[method](userPath);`);
  assert.throws(() => validateSec02SinkPolicy(makePolicy([]), unresolved, detector), /UNRESOLVED_GOVERNED_SINK/);
  const stale = makePolicy([{
    siteId: "sink-000000000000000000000000",
    sourcePath: "src/stale.ts",
    normalizedNodeSha256: "b".repeat(64),
    container: "<top-level>",
    family: "node-fs",
    api: "readFile",
    pathOperands: ["argument:0"],
    executionClass: "product-runtime",
    packageExpectation: "compiled-to-asar",
    binding: { kind: "runtime-canary", anchor: "stale", evidenceIds: ["dispatcher-gateway"], operands: [{ selector: "argument:0", classification: "runtime-gateway-path", anchor: "stale" }] },
  }]);
  assert.throws(() => validateSec02SinkPolicy(stale, [], detector), /STALE_SINK_POLICY/);
});

function dialectPolicy(analyzer, adapters, reviewedSyntaxExceptions = []) {
  const payload = {
    schemaVersion: 2,
    task: "SEC-02",
    domain: "mini-lux/sec02/restricted-runtime-dialect/v1",
    analyzerSha256: analyzer,
    sourceRoots: ["src/", "electron/"],
    packageRoots: ["dist/", "electron/"],
    extensions: [".ts", ".tsx", ".js", ".mjs", ".cjs"],
    governedModules: ["node:fs"],
    adapters,
    reviewedSyntaxExceptions,
  };
  return { ...payload, canonicalPayloadSha256: createHash("sha256").update(canonicalCrosscheckJson(payload)).digest("hex") };
}

test("SEC-02 restricted runtime dialect rejects unapproved imports, callable aliases and computed members", () => {
  const analyzer = "a".repeat(64);
  const policy = dialectPolicy(analyzer, [{ sourcePath: "src/adapter.ts", modules: ["node:fs"] }]);
  const direct = new Map([["src/adapter.ts", `import fs from "node:fs"; fs.readFile(userPath, callback);`]]);
  assert.equal(validateSec02RestrictedSourceSet(direct, policy, analyzer).complete, true);
  assert.throws(() => validateSec02RestrictedSourceSet(new Map([["src/other.ts", direct.values().next().value]]), policy, analyzer), /UNAPPROVED_GOVERNED_IMPORT/);
  assert.throws(() => validateSec02RestrictedSourceSet(new Map([["src/adapter.ts", `import fs from "node:fs"; const read = fs.readFile; read(userPath);`]]), policy, analyzer), /governed callable alias/);
  for (const source of [
    `import fs from "node:fs"; const bag = [fs.readFile]; bag[0](userPath);`,
    `import fs from "node:fs"; const bag = { read: fs.readFile }; bag.read(userPath);`,
    `import { readFile } from "node:fs"; const bag = { readFile }; bag.readFile(userPath);`,
    `import fs from "node:fs"; const bag = [[fs.readFile]]; bag[0][0](userPath);`,
  ]) {
    assert.throws(() => validateSec02RestrictedSourceSet(new Map([["src/adapter.ts", source]]), policy, analyzer), /governed callable stored in collection/);
  }
  assert.throws(() => validateSec02RestrictedSourceSet(new Map([["src/adapter.ts", `import fs from "node:fs"; fs[method](userPath);`]]), policy, analyzer), /computed governed member/);
  for (const source of [
    `import { readFile } from "node:fs"; export { readFile };`,
    `import { readFile } from "node:fs"; export { readFile as load };`,
    `export { readFile }; import { readFile } from "node:fs";`,
    `import { readFile } from "node:fs"; export default readFile;`,
    `import fs from "node:fs"; export default fs.readFile;`,
    `import fs from "node:fs"; export const nativeFs = fs;`,
    `const { readFile } = require("node:fs"); exports.readFile = readFile;`,
  ]) {
    assert.throws(() => validateSec02RestrictedSourceSet(new Map([["src/adapter.ts", source]]), policy, analyzer), /GOVERNED_REEXPORT/);
  }
  assert.throws(() => validateSec02RestrictedSourceSet(new Map([["src/adapter.ts", `await import(userSpecifier);`]]), policy, analyzer), /non-literal dynamic import/);
});

test("SEC-02 current restricted runtime domain and reviewed exceptions are exact", { timeout: 120_000 }, async () => {
  const { readFile } = await import("node:fs/promises");
  const [policy, analyzerBytes] = await Promise.all([
    readFile(path.join(projectRoot, ...crosscheckPolicyPath.split("/")), "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "scripts", "sec02-sink-crosscheck.mjs")),
  ]);
  const analyzer = createHash("sha256").update(analyzerBytes).digest("hex");
  const result = await scanSec02RestrictedRuntime(projectRoot, policy, analyzer);
  assert.equal(result.fileCount, 71);
  assert.equal(result.importCount, 33);
  assert.equal(result.exceptionCount, 2);
  assert.equal(result.complete, true);
  assert.throws(() => validateSec02RestrictedSourceSet(new Map([["src/adapter.ts", `import fs from "node:fs"; fs.readFile(userPath, callback);`]]), policy, "b".repeat(64)), /different checker/);
});

test("SEC-02 packaged executable projection rejects extra files and same-path sink mutation", () => {
  const expected = new Map([
    ["dist/runtime.js", `export const ready = true;`],
    ["electron/main.cjs", `module.exports = { ready: true };`],
  ]);
  const analyzer = "a".repeat(64);
  const policy = dialectPolicy(analyzer, [{ sourcePath: "src/runtime.ts", modules: ["node:fs"] }]);
  const exact = validatePackagedExecutableProjection(expected, new Map(expected), { policy, checkerSha256: analyzer });
  assert.match(exact.sourceProjectionSha256, /^[a-f0-9]{64}$/u);
  assert.match(exact.packagedSinkSetSha256, /^[a-f0-9]{64}$/u);
  assert.match(exact.packagedDialectImportSetSha256, /^[a-f0-9]{64}$/u);

  const extra = new Map(expected);
  extra.set("dist/bypass.js", `require("node:fs").readFileSync(userPath);`);
  assert.throws(() => validatePackagedExecutableProjection(expected, extra, { policy, checkerSha256: analyzer }), /executable projection differs/);

  const mutated = new Map(expected);
  mutated.set("dist/runtime.js", `require("node:fs").readFileSync(userPath);`);
  assert.throws(() => validatePackagedExecutableProjection(expected, mutated, { policy, checkerSha256: analyzer }), /sink set differs/);
});

test("SEC-02 sink inventory rejects missing sites, changed bindings and producer summaries", async () => {
  const inventory = JSON.parse(await (await import("node:fs/promises")).readFile(path.join(projectRoot, ...sinkInventoryPath.split("/")), "utf8"));
  const missing = structuredClone(inventory);
  missing.sinks.pop();
  await assert.rejects(validateSec02SinkInventory(projectRoot, missing), /digest differs|differs from canonical/);

  const changedBinding = structuredClone(inventory);
  changedBinding.sinks[0].binding.kind = "governance-only";
  const { createHash } = await import("node:crypto");
  const { canonicalJson } = await import("../../scripts/sec02-sink-inventory.mjs");
  const { canonicalPayloadSha256: _ignored, ...payload } = changedBinding;
  changedBinding.canonicalPayloadSha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex");
  await assert.rejects(validateSec02SinkInventory(projectRoot, changedBinding), /schema failed|differs from canonical/);

  const producerSummary = structuredClone(inventory);
  producerSummary.packageProjection.installedOwner.testCaseId = "builder says passed";
  const { canonicalPayloadSha256: _old, ...producerPayload } = producerSummary;
  producerSummary.canonicalPayloadSha256 = createHash("sha256").update(canonicalJson(producerPayload)).digest("hex");
  await assert.rejects(validateSec02SinkInventory(projectRoot, producerSummary), /schema failed|differs from canonical/);
});
