import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { access, lstat, mkdir, mkdtemp, readFile, readlink, realpath, readdir, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  currentResolvedManifestPath as sec02ResolvedManifestRelative,
  validateSec02ResolvedManifest,
} from "../scripts/sec02-governance.mjs";
import {
  resolvedManifestPath as sec03ResolvedManifestRelative,
  validateSec03ResolvedManifest,
} from "../scripts/sec03-governance.mjs";

export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const layerNames = Object.freeze(["unit", "contract", "integration", "electron", "packaged"]);
const expectedBaselineHash = "1126d7449fca392e64721d5e7e86169158bc8c72ea72f9d414fa0fe93ab445df";
const expectedPersonaChains = Object.freeze({
  "GOV-03": Object.freeze(["planner", "architect", "developer", "debugger", "reviewer"]),
  "SEC-01": Object.freeze(["architect", "sentinel", "developer", "debugger", "reviewer"]),
  "SEC-02": Object.freeze(["architect", "sentinel", "developer", "debugger", "reviewer"]),
});
const globMetaPattern = /[*?[\]{}!]/;

export function artifactSafeBuildId(value) {
  return String(value).replace(/[^A-Za-z0-9._-]/g, (character) =>
    `~${character.codePointAt(0).toString(16).toUpperCase().padStart(2, "0")}`
  );
}

export function assertExactKeys(value, keys, field) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${field} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${field} keys differ`);
}

export function safeRelativePath(value, field = "path") {
  assert.equal(typeof value, "string", `${field} must be a string`);
  assert(value.length > 0 && !value.includes("\\") && !value.includes("\0") && !path.posix.isAbsolute(value) && !/^[A-Za-z]:/.test(value), `${field} must be a non-empty POSIX relative path`);
  assert(!globMetaPattern.test(value), `${field} must name one exact file, not a glob`);
  assert.equal(path.posix.normalize(value), value, `${field} is not normalized`);
  assert(!value.startsWith("../") && !value.includes("/../"), `${field} escapes project root`);
  return value;
}

export function pathIdentity(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

export async function pathExists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

export async function assertRegularProjectFile(relative, field = "path", root = projectRoot) {
  safeRelativePath(relative, field);
  let cursor = root;
  for (const segment of relative.split("/")) {
    cursor = path.join(cursor, segment);
    const info = await lstat(cursor);
    assert(!info.isSymbolicLink(), `${field} must not traverse a symbolic link: ${relative}`);
  }
  assert((await stat(cursor)).isFile(), `${field} must name a regular file: ${relative}`);
  const containment = path.relative(await realpath(root), await realpath(cursor));
  assert(containment && containment !== ".." && !containment.startsWith(`..${path.sep}`) && !path.isAbsolute(containment), `${field} escapes project root: ${relative}`);
  return cursor;
}

function isContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export async function validateReportPath(filePath) {
  const absolute = path.resolve(filePath);
  assert.equal(path.extname(absolute).toLowerCase(), ".json", "report path must end in .json");
  const projectReports = path.resolve(path.join(projectRoot, "test-results"));
  const projectAbsolute = path.resolve(projectRoot);
  if (isContained(projectAbsolute, absolute)) {
    assert(isContained(projectReports, absolute), "reports inside the project must remain inside test-results");
  }
  const allowedRoots = [projectReports, path.resolve(os.tmpdir())];
  const allowed = allowedRoots.find((root) => isContained(root, absolute));
  assert(allowed, "report path must be inside test-results or the OS temporary directory");

  await mkdir(allowed, { recursive: true });
  assert(!(await lstat(allowed)).isSymbolicLink(), "report root must not be a symbolic link");
  const allowedReal = await realpath(allowed);
  const requestedParent = path.dirname(absolute);
  let walk = allowed;
  for (const segment of path.relative(allowed, requestedParent).split(path.sep).filter(Boolean)) {
    walk = path.join(walk, segment);
    if (!await pathExists(walk)) await mkdir(walk);
    const info = await lstat(walk);
    assert(!info.isSymbolicLink(), "report path must not traverse a symbolic link");
    assert(info.isDirectory(), "report parent must be a directory");
  }
  const parentReal = await realpath(requestedParent);
  assert(isContained(allowedReal, parentReal), "report path ancestor escapes its allowed root");
  const canonical = path.join(parentReal, path.basename(absolute));
  assert(isContained(allowedReal, canonical), "canonical report path escapes its allowed root");
  if (await pathExists(canonical)) assert(!(await lstat(canonical)).isSymbolicLink(), "report path must not be a symbolic link");
  return canonical;
}

export async function prepareReportPath(filePath) {
  const absolute = await validateReportPath(filePath);
  await rm(absolute, { force: true });
  return absolute;
}

export async function atomicWriteJson(filePath, value) {
  const absolute = await validateReportPath(filePath);
  const temporary = `${absolute}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  try {
    const revalidated = await validateReportPath(filePath);
    assert.equal(revalidated, absolute, "canonical report destination changed before publication");
    await rename(temporary, revalidated);
  } catch (error) { await rm(temporary, { force: true }); throw error; }
}

export async function sha256File(filePath) {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

async function listTreeEntries(directory, root = directory) {
  const entries = [];
  if (!await pathExists(directory)) return entries;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    if (entry.isDirectory()) {
      entries.push({ absolute, relative, type: "directory" });
      entries.push(...await listTreeEntries(absolute, root));
    } else if (entry.isFile()) entries.push({ absolute, relative, type: "file" });
    else if (entry.isSymbolicLink()) entries.push({ absolute, relative, type: "symlink" });
    else entries.push({ absolute, relative, type: "other" });
  }
  return entries;
}

export async function hashTree(directory) {
  const hash = createHash("sha256");
  const exists = await pathExists(directory);
  hash.update(exists ? "tree-v2-present\0" : "tree-v2-missing\0", "utf8");
  if (!exists) return hash.digest("hex");
  const entries = await listTreeEntries(directory);
  entries.sort((left, right) => left.relative.localeCompare(right.relative, "en"));
  for (const entry of entries) {
    const relative = Buffer.from(entry.relative, "utf8");
    const type = Buffer.from(entry.type, "utf8");
    let bytes = Buffer.alloc(0);
    if (entry.type === "file") bytes = await readFile(entry.absolute);
    else if (entry.type === "symlink") bytes = Buffer.from(await readlink(entry.absolute), "utf8");
    const frame = Buffer.alloc(16);
    frame.writeUInt32BE(type.length, 0);
    frame.writeUInt32BE(relative.length, 4);
    frame.writeBigUInt64BE(BigInt(bytes.length), 8);
    hash.update(frame);
    hash.update(type);
    hash.update(relative);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

export async function formalArtifactSnapshot() {
  const buildInfoPath = path.join(projectRoot, "build-info.json");
  const buildInfo = JSON.parse(await readFile(buildInfoPath, "utf8"));
  const candidates = {
    buildInfo: buildInfoPath,
    distIntegrity: path.join(projectRoot, "dist-integrity.json"),
    packageArtifactManifest: path.join(projectRoot, "test-results", "package-artifact.json"),
    installer: path.join(projectRoot, "release", `RainyDays Setup ${buildInfo.appVersion}-${artifactSafeBuildId(buildInfo.buildId)}.exe`),
    appAsar: path.join(projectRoot, "release", "win-unpacked", "resources", "app.asar"),
  };
  const hashes = {};
  for (const [name, filePath] of Object.entries(candidates)) hashes[name] = await pathExists(filePath) ? await sha256File(filePath) : null;
  hashes.distTree = await hashTree(path.join(projectRoot, "dist"));
  hashes.electronAppTree = await hashTree(path.join(projectRoot, ".electron-app"));
  hashes.releaseTree = await hashTree(path.join(projectRoot, "release"));
  return hashes;
}

function assertUniquePaths(entries, field) {
  const seen = new Set();
  for (const entry of entries) {
    safeRelativePath(entry, `${field} entry`);
    const identity = pathIdentity(entry);
    assert(!seen.has(identity), `duplicate or case-alias ${field} path: ${entry}`);
    seen.add(identity);
  }
}

export async function loadSourceTaskManifest(taskId, root = projectRoot) {
  assert.match(taskId, /^[A-Z]+-\d{2}$/);
  const filePath = path.join(root, "tests", "manifests", `${taskId.toLowerCase()}.json`);
  const manifest = JSON.parse(await readFile(filePath, "utf8"));
  assertExactKeys(manifest, ["schemaVersion", "taskId", "baseline", "personaChain", "changedRuntimeFiles", "coverageExemptions", "layers"], "manifest");
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.taskId, taskId);
  assertExactKeys(manifest.baseline, ["product", "version", "manifestSha256"], "manifest.baseline");
  assert.deepEqual(manifest.baseline, { product: "Lux Desktop", version: "0.1.898", manifestSha256: expectedBaselineHash });
  const expectedPersonaChain = expectedPersonaChains[taskId];
  assert(expectedPersonaChain, `unsupported task manifest: ${taskId}`);
  assert.deepEqual(manifest.personaChain, expectedPersonaChain);
  assert(Array.isArray(manifest.changedRuntimeFiles));
  assertUniquePaths(manifest.changedRuntimeFiles, "changedRuntimeFiles");
  for (const entry of manifest.changedRuntimeFiles) await assertRegularProjectFile(entry, "changedRuntimeFiles entry", root);
  assert(manifest.coverageExemptions && typeof manifest.coverageExemptions === "object" && !Array.isArray(manifest.coverageExemptions));
  assertUniquePaths(Object.keys(manifest.coverageExemptions), "coverage exemptions");
  for (const [entry, exemption] of Object.entries(manifest.coverageExemptions)) {
    safeRelativePath(entry, "coverage exemption path");
    assert(manifest.changedRuntimeFiles.includes(entry), `coverage exemption casing/path must exactly match changedRuntimeFiles: ${entry}`);
    assertExactKeys(exemption, ["reason", "evidenceLayer"], `coverage exemption ${entry}`);
    assert.equal(typeof exemption.reason, "string");
    assert(exemption.reason.trim().length >= 12, `coverage exemption reason is too short: ${entry}`);
    assert(layerNames.includes(exemption.evidenceLayer), `coverage exemption evidence layer is invalid: ${entry}`);
  }
  assertExactKeys(manifest.layers, layerNames, "manifest.layers");
  const allTests = [];
  for (const layer of layerNames) {
    assert(Array.isArray(manifest.layers[layer]) && manifest.layers[layer].length > 0, `${layer} must contain tests`);
    assertUniquePaths(manifest.layers[layer], `${layer} tests`);
    for (const entry of manifest.layers[layer]) {
      allTests.push(entry);
      await assertRegularProjectFile(entry, `${layer} test path`, root);
    }
  }
  assertUniquePaths(allTests, "all layer tests");
  return { manifest, filePath };
}

export async function loadResolvedManifest(root = projectRoot) {
  const filePath = path.join(root, ...sec02ResolvedManifestRelative.split("/"));
  const manifest = JSON.parse(await readFile(filePath, "utf8"));
  await validateSec02ResolvedManifest(manifest, { root });
  return { manifest, filePath };
}

export async function loadResolvedTaskView(taskId, root = projectRoot) {
  assert(["SEC-02", "GOV-03"].includes(taskId), `task has no SEC-02 resolved view: ${taskId}`);
  const target = await loadSourceTaskManifest(taskId, root);
  const resolved = await loadResolvedManifest(root);
  const view = resolved.manifest.cumulativeViews.find(entry => entry.taskId === taskId);
  assert(view, `resolved task view is missing: ${taskId}`);
  const layers = Object.fromEntries(layerNames.map(layer => [layer, []]));
  for (const record of view.tests) {
    assert(layerNames.includes(record.layer), `resolved test layer is invalid: ${record.layer}`);
    layers[record.layer].push(record.exactCasePath);
  }
  for (const layer of layerNames) assert(layers[layer].length > 0, `resolved ${taskId} ${layer} layer is empty`);
  const coverageExemptions = {};
  for (const record of view.coverageExemptions) {
    coverageExemptions[record.exactCasePath] = {
      reason: record.reason,
      evidenceLayer: record.evidenceLayer,
    };
  }
  const manifest = {
    schemaVersion: 1,
    taskId,
    baseline: target.manifest.baseline,
    personaChain: target.manifest.personaChain,
    changedRuntimeFiles: [...view.changedRuntimeFiles],
    coverageExemptions,
    layers,
  };
  await validateCoverageGovernance(manifest, (await loadCoverageScope(undefined, root)).scope);
  return {
    manifest,
    filePath: target.filePath,
    sourceManifestPaths: resolved.manifest.sourceManifests.map(source => path.join(root, ...source.exactCasePath.split("/"))),
    resolvedManifest: resolved.manifest,
    resolvedManifestPath: resolved.filePath,
  };
}

export async function loadSec03ResolvedManifest(root = projectRoot) {
  const filePath = path.join(root, ...sec03ResolvedManifestRelative.split("/"));
  const manifest = JSON.parse(await readFile(filePath, "utf8"));
  await validateSec03ResolvedManifest(manifest, { root });
  return { manifest, filePath };
}

export async function loadSec03ResolvedTaskView(root = projectRoot) {
  const resolved = await loadSec03ResolvedManifest(root);
  const sourcePath = path.join(root, "tests", "manifests", "sec-03.json");
  const source = JSON.parse(await readFile(sourcePath, "utf8"));
  const layers = Object.fromEntries(layerNames.map((layer) => [layer, []]));
  for (const record of resolved.manifest.cumulativeEntries) {
    if (record.kind === "test") layers[record.layer].push(record.exactCasePath);
  }
  for (const layer of layerNames) assert(layers[layer].length > 0, `resolved SEC-03 ${layer} layer is empty`);
  const coverageExemptions = {};
  for (const record of resolved.manifest.coverageExemptions) {
    coverageExemptions[record.exactCasePath] = { reason: record.reason, evidenceLayer: record.evidenceLayer };
  }
  return {
    manifest: {
      schemaVersion: 1,
      taskId: "SEC-03",
      baseline: source.baseline,
      personaChain: source.personaChain,
      changedRuntimeFiles: resolved.manifest.cumulativeEntries.filter((record) => record.kind === "runtime").map((record) => record.exactCasePath),
      coverageExemptions,
      layers,
    },
    filePath: sourcePath,
    sourceManifestPaths: [path.join(root, ...resolved.manifest.predecessor.exactCasePath.split("/")), sourcePath],
    resolvedManifest: resolved.manifest,
    resolvedManifestPath: resolved.filePath,
  };
}

export async function loadTaskManifest(taskId = "GOV-03", root = projectRoot) {
  if (taskId === "SEC-03") return loadSec03ResolvedTaskView(root);
  if (taskId === "SEC-02" || taskId === "GOV-03") return loadResolvedTaskView(taskId, root);
  return loadSourceTaskManifest(taskId, root);
}

function assertPercent(value, field, minimum = 0) {
  assert(Number.isInteger(value) && value >= minimum && value <= 100, `${field} must be an integer in ${minimum}..100`);
}

export async function loadCoverageScope(scopePath, root = projectRoot) {
  const filePath = scopePath ? path.resolve(scopePath) : path.join(root, "tests", "coverage-scope.json");
  const scope = JSON.parse(await readFile(filePath, "utf8"));
  assertExactKeys(scope, ["schemaVersion", "additionalTestsByTask", "overall", "securityCritical", "thresholds", "perFileLineMinimum"], "coverage scope");
  assert.equal(scope.schemaVersion, 3);
  assert(scope.additionalTestsByTask && typeof scope.additionalTestsByTask === "object" && !Array.isArray(scope.additionalTestsByTask), "additionalTestsByTask must be an object");
  const sourceManifestCache = new Map();
  for (const [taskId, entries] of Object.entries(scope.additionalTestsByTask)) {
    assert.match(taskId, /^[A-Z]+-\d{2}$/, "additional coverage task ID is invalid");
    assert(Array.isArray(entries) && entries.length > 0, `additional coverage tests are empty: ${taskId}`);
    assertUniquePaths(entries.map(entry => entry?.exactCasePath), `additional coverage tests ${taskId}`);
    for (const entry of entries) {
      assertExactKeys(entry, ["sourceTask", "exactCasePath"], `additional coverage test ${taskId}`);
      assert.match(entry.sourceTask, /^[A-Z]+-\d{2}$/, "additional coverage source task ID is invalid");
      await assertRegularProjectFile(entry.exactCasePath, `additional coverage test ${taskId}`, root);
      if (!sourceManifestCache.has(entry.sourceTask)) sourceManifestCache.set(entry.sourceTask, await loadTaskManifest(entry.sourceTask, root));
      const source = sourceManifestCache.get(entry.sourceTask);
      assert(source.resolvedManifest?.cumulativeEntries, `additional coverage source task lacks a resolved manifest: ${entry.sourceTask}`);
      const records = source.resolvedManifest.cumulativeEntries.filter(record => record.exactCasePath === entry.exactCasePath);
      assert.equal(records.length, 1, `additional coverage test is not exact in ${entry.sourceTask}: ${entry.exactCasePath}`);
      const record = records[0];
      assert.equal(record.owner, entry.sourceTask, `additional coverage test owner differs: ${entry.exactCasePath}`);
      assert.equal(record.kind, "test", `additional coverage entry is not a test: ${entry.exactCasePath}`);
      assert(layerNames.includes(record.layer), `additional coverage test layer is invalid: ${entry.exactCasePath}`);
      assert.equal(await sha256File(path.join(root, ...entry.exactCasePath.split("/"))), record.sha256, `additional coverage test hash differs: ${entry.exactCasePath}`);
    }
  }
  assert(Array.isArray(scope.overall) && scope.overall.length > 0);
  assert(Array.isArray(scope.securityCritical) && scope.securityCritical.length > 0);
  assertUniquePaths(scope.overall, "coverage overall");
  assertUniquePaths(scope.securityCritical, "coverage securityCritical");
  assertExactKeys(scope.thresholds, ["overallLines", "securityBranches"], "coverage thresholds");
  assertPercent(scope.thresholds.overallLines, "overallLines threshold", 80);
  assertPercent(scope.thresholds.securityBranches, "securityBranches threshold", 90);
  assert(scope.perFileLineMinimum && typeof scope.perFileLineMinimum === "object" && !Array.isArray(scope.perFileLineMinimum), "perFileLineMinimum must be an object");
  assertUniquePaths(Object.keys(scope.perFileLineMinimum), "perFileLineMinimum");
  const overallIdentities = new Set(scope.overall.map(pathIdentity));
  const exactOverall = new Set(scope.overall);
  for (const entry of scope.overall) await assertRegularProjectFile(entry, "coverage path", root);
  for (const entry of scope.securityCritical) assert(overallIdentities.has(pathIdentity(entry)), `security file not in overall scope: ${entry}`);
  for (const [entry, minimum] of Object.entries(scope.perFileLineMinimum)) {
    safeRelativePath(entry, "per-file minimum path");
    assert(exactOverall.has(entry), `per-file minimum casing/path must exactly match overall scope: ${entry}`);
    assertPercent(minimum, `per-file minimum ${entry}`);
  }
  return { scope, filePath };
}

export async function validateCoverageGovernance(manifest, scope) {
  const governed = new Set(scope.overall.map(pathIdentity));
  for (const entry of manifest.changedRuntimeFiles) {
    const exemptionEntry = Object.entries(manifest.coverageExemptions).find(([candidate]) => pathIdentity(candidate) === pathIdentity(entry));
    const exemption = exemptionEntry?.[1];
    assert(governed.has(pathIdentity(entry)) || exemption, `changed runtime file lacks coverage or exemption: ${entry}`);
    if (exemption) assert(manifest.layers[exemption.evidenceLayer]?.length > 0, `coverage exemption has no evidence tests: ${entry}`);
  }
  for (const entry of Object.keys(manifest.coverageExemptions)) assert(!governed.has(pathIdentity(entry)), `governed file must not also be exempt: ${entry}`);
}

export async function makeTempDir(prefix) {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

export async function removeFixture(directory, junctionNames = []) {
  for (const name of junctionNames) {
    try { await unlink(path.join(directory, name)); } catch {}
  }
  await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

export async function freeDistinctPorts(count = 2) {
  assert(Number.isInteger(count) && count > 0 && count <= 8);
  const servers = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = net.createServer();
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
      });
      servers.push(server);
    }
    const ports = servers.map((server) => server.address().port);
    assert.equal(new Set(ports).size, count);
    return ports;
  } finally {
    await Promise.all(servers.map((server) => new Promise((resolve) => server.close(resolve))));
  }
}

export async function freePort() {
  return (await freeDistinctPorts(1))[0];
}

export async function waitFor(check, { timeoutMs = 20_000, intervalMs = 100, label = "condition" } = {}) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      const result = await check();
      if (result) return result;
    } catch (error) { lastError = error; }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out waiting for ${label}${lastError ? `: ${lastError.message}` : ""}`);
}

export function terminateProcessTree(child) {
  if (!child || child.exitCode !== null || !child.pid) return { attempted: false, exitCode: 0 };
  if (process.platform === "win32") {
    const result = spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    return { attempted: true, exitCode: result.status ?? 1 };
  }
  try { process.kill(-child.pid, "SIGTERM"); return { attempted: true, exitCode: 0 }; }
  catch {
    try { child.kill("SIGTERM"); return { attempted: true, exitCode: 0 }; }
    catch { return { attempted: true, exitCode: 1 }; }
  }
}

export async function waitForChildExit(child, timeoutMs = 15_000) {
  if (!child || child.exitCode !== null) return true;
  return Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

export async function terminateProcessTreeAsync(child, timeoutMs = 10_000) {
  if (!child || child.exitCode !== null || !child.pid) return { attempted: false, exitCode: 0, childExited: true };
  if (process.platform !== "win32") {
    const result = terminateProcessTree(child);
    return { ...result, childExited: await waitForChildExit(child, timeoutMs) };
  }
  const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, shell: false });
  const outcome = await Promise.race([
    new Promise((resolve) => killer.once("exit", (code) => resolve({ completed: true, exitCode: code ?? 1 }))),
    new Promise((resolve) => setTimeout(() => resolve({ completed: false, exitCode: 1 }), timeoutMs)),
  ]);
  if (!outcome.completed) {
    killer.kill("SIGKILL");
    try { child.kill("SIGKILL"); } catch {}
  }
  return { attempted: true, exitCode: outcome.exitCode, childExited: await waitForChildExit(child, 5_000) };
}

export function spawnManaged(command, args, options = {}) {
  return spawn(command, args, {
    cwd: options.cwd ?? projectRoot,
    env: options.env ?? process.env,
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    windowsHide: true,
    detached: process.platform !== "win32",
    shell: false,
  });
}

export async function runProcess(command, args, { cwd = projectRoot, env = process.env, timeoutMs = 120_000, echo = false } = {}) {
  const child = spawnManaged(command, args, { cwd, env });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout += chunk; if (echo) process.stdout.write(chunk); });
  child.stderr?.on("data", (chunk) => { stderr += chunk; if (echo) process.stderr.write(chunk); });
  let timer;
  let timedOut = false;
  const result = await new Promise((resolve, reject) => {
    timer = setTimeout(async () => {
      timedOut = true;
      let termination;
      try { termination = await terminateProcessTreeAsync(child); }
      catch { termination = { attempted: true, exitCode: 1, childExited: false }; }
      const cleanupPassed = termination.exitCode === 0 && termination.childExited;
      const error = new Error(`${cleanupPassed ? "Process timeout" : "Process timeout cleanup failed"}: ${command} ${args.join(" ")}`);
      error.code = cleanupPassed ? "PROCESS_TIMEOUT" : "PROCESS_TIMEOUT_CLEANUP_FAILED";
      error.timedOut = true;
      error.termination = termination;
      reject(error);
    }, timeoutMs);
    child.once("error", (error) => { if (!timedOut) reject(error); });
    child.once("exit", (code, signal) => { if (!timedOut) resolve({ code, signal }); });
  }).finally(() => clearTimeout(timer));
  return { ...result, stdout, stderr };
}

export function parseTapSummary(output) {
  const number = (label) => {
    const prefix = `# ${label} `;
    const line = output.split(/\r?\n/).find((entry) => entry.startsWith(prefix));
    return line ? Number(line.slice(prefix.length).trim()) : null;
  };
  return {
    tests: number("tests"),
    passed: number("pass"),
    failed: number("fail"),
    skipped: number("skipped"),
    cancelled: number("cancelled"),
    todo: number("todo"),
  };
}

export function classifyProcessResult({ code, signal, timedOut = false }) {
  if (timedOut) return "timed-out";
  if (signal) return "crashed";
  return code === 0 ? "passed" : "failed";
}

export function sameSnapshot(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function randomToken() {
  return randomBytes(32).toString("hex");
}

export function boundedFetch(url, options = {}, timeoutMs = 2_000) {
  return fetch(url, { ...options, signal: options.signal ?? AbortSignal.timeout(timeoutMs) });
}

export async function connectCdp(cdpPort) {
  const page = await waitFor(async () => {
    const response = await boundedFetch(`http://127.0.0.1:${cdpPort}/json/list`);
    if (!response.ok) return null;
    const targets = await response.json();
    return targets.find((entry) => entry.type === "page" && entry.webSocketDebuggerUrl) ?? null;
  }, { timeoutMs: 30_000, label: "Electron CDP page" });
  const client = await CdpClient.open(page.webSocketDebuggerUrl);
  client.target = page;
  return client;
}

export class CdpClient {
  static async open(url) {
    const client = new CdpClient(url);
    await client.ready;
    return client;
  }

  constructor(url) {
    this.nextId = 1;
    this.pending = new Map();
    this.socket = new WebSocket(url);
    this.ready = new Promise((resolve, reject) => {
      this.socket.addEventListener("open", resolve, { once: true });
      this.socket.addEventListener("error", () => reject(new Error("CDP WebSocket connection failed")), { once: true });
    });
    this.socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data));
      if (!message.id || !this.pending.has(message.id)) return;
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
    });
  }

  async send(method, params = {}, timeoutMs = 15_000) {
    await this.ready;
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression) {
    const result = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.text || "Renderer evaluation failed");
    return result.result?.value;
  }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("CDP closed"));
    }
    this.pending.clear();
    this.socket.close();
  }
}
