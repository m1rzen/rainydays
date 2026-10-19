// Bounded A03 experiment only. Builds a temporary CLI executable; does not
// install a runtime, change the application's Node, or grant filesystem access.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFileSync } from "node:child_process";

const version = "24.14.1", upstream = "2cadaa40167050baf7c6905ac897e6fb57afb2c6";
const project = path.resolve(import.meta.dirname, "../../../.."), archiveName = `node-v${version}.tar.xz`;
const location = path.join(project, "test-results", "a03-node-build-location.json");
assert(process.argv.slice(2).every(value => value === "--resume"));
const previous = process.argv.includes("--resume") ? JSON.parse(await fs.readFile(location, "utf8")) : null;
const root = previous?.root ?? await fs.mkdtemp(path.join(os.tmpdir(), "rainydays-node-uv-"));
assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
assert(path.basename(root).startsWith("rainydays-node-uv-")); assert(!(await fs.lstat(root)).isSymbolicLink());
const source = path.join(root, `node-v${version}`);
const metadata = { purpose: "A03 experiment; not a delivery runtime", version, upstream, root, source, log: path.join(root, "build.log"), executable: path.join(source, "Release", "node.exe"), state: "downloading" };
const record = async () => fs.writeFile(location, JSON.stringify(metadata, null, 2));
await fs.mkdir(path.dirname(location), { recursive: true }); await record();
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
async function download(url, maxBytes) {
  const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
  assert(response.ok, `Download status ${response.status}`);
  assert(Number(response.headers.get("content-length") || 0) <= maxBytes);
  const bytes = Buffer.from(await response.arrayBuffer()); assert(bytes.length <= maxBytes); return bytes;
}
try {
  const sums = (await download(`https://nodejs.org/dist/v${version}/SHASUMS256.txt`, 100000)).toString();
  const expected = sums.split(/\r?\n/u).find(line => line.endsWith(`  ${archiveName}`))?.split(" ")[0];
  assert.match(expected ?? "", /^[a-f0-9]{64}$/u);
  const archivePath = path.join(root, archiveName);
  const archive = previous ? await fs.readFile(archivePath) : await download(`https://nodejs.org/dist/v${version}/${archiveName}`, 100 * 1024 ** 2);
  assert.equal(hash(archive), expected); metadata.sourceSha256 = expected;
  if (!previous) await fs.writeFile(archivePath, archive, { flag: "wx" });
  // Python's data filter handles Windows Unicode and rejects escaping links.
  // This builds the executable, not Node's internal test binaries or docs.
  metadata.excludedTestFixtures = [`node-v${version}/test/`, `node-v${version}/deps/v8/test/`, `node-v${version}/doc/`];
  metadata.state = "extracting"; await record();
  const extract = "import sys,tarfile\nfrom pathlib import PurePosixPath\nwith tarfile.open(sys.argv[1],'r:xz') as archive:\n members=archive.getmembers()\n assert all((m.name=='node-v24.14.1' or m.name.startswith('node-v24.14.1/')) and '..' not in PurePosixPath(m.name).parts for m in members)\n excluded=('node-v24.14.1/test/','node-v24.14.1/deps/v8/test/','node-v24.14.1/doc/')\n archive.extractall(sys.argv[2],members=(m for m in members if not m.name.startswith(excluded)),filter='data')\n";
  execFileSync("python.exe", ["-I", "-c", extract, archivePath, root], { windowsHide: true });
  const fullPatch = (await download(`https://github.com/libuv/libuv/commit/${upstream}.patch`, 200000)).toString();
  const marker = "diff --git a/src/win/pipe.c b/src/win/pipe.c";
  const start = fullPatch.indexOf(marker); assert(start >= 0);
  const end = fullPatch.indexOf("\ndiff --git ", start + marker.length); assert(end > start);
  const patch = (fullPatch.slice(start, end) + "\n").replaceAll("a/src/win/pipe.c", "a/deps/uv/src/win/pipe.c").replaceAll("b/src/win/pipe.c", "b/deps/uv/src/win/pipe.c");
  assert(patch.length < 6000); metadata.patchSha256 = hash(patch);
  const patchPath = path.join(root, "upstream-pipe-only.patch"); await fs.writeFile(patchPath, patch);
  execFileSync("git.exe", ["apply", "--check", patchPath], { cwd: source, windowsHide: true });
  execFileSync("git.exe", ["apply", patchPath], { cwd: source, windowsHide: true });
  metadata.state = "building"; await record();
  console.log(JSON.stringify({ stage: "building", root, log: metadata.log, sourceSha256: expected, patchSha256: metadata.patchSha256 }));
  const log = await fs.open(metadata.log, previous ? "a" : "wx");
  const environment = { ...process.env }; delete environment.NODE_OPTIONS;
  const child = spawn(path.join(process.env.SystemRoot, "System32", "cmd.exe"), ["/d", "/s", "/c", "vcbuild.bat release x64 vs2022 openssl-no-asm no-cctest nonpm nocorepack"], { cwd: source, env: environment, stdio: ["ignore", log.fd, log.fd], windowsHide: true });
  try { metadata.exitCode = await new Promise((resolve, reject) => { child.once("error", reject); child.once("exit", code => resolve(code)); }); }
  finally { await log.close(); }
  assert.equal(metadata.exitCode, 0, `Build failed; see ${metadata.log}`);
  metadata.runtimeSha256 = hash(await fs.readFile(metadata.executable)); metadata.state = "built"; await record();
  console.log(JSON.stringify({ stage: "built", executable: metadata.executable, sha256: metadata.runtimeSha256 }));
} catch (error) { metadata.state = "failed"; metadata.error = error.message; await record(); throw error; }
