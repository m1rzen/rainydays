import assert from "node:assert/strict";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  boundedFetch,
  connectCdp,
  freeDistinctPorts,
  makeTempDir,
  pathExists,
  projectRoot,
  removeFixture,
  spawnManaged,
  terminateProcessTreeAsync,
  waitFor,
} from "../helpers.mjs";

const electronExecutable = path.join(projectRoot, "node_modules", "electron", "dist", process.platform === "win32" ? "electron.exe" : "electron");

function expectedUi(buildInfo) {
  const shortBuild = String(buildInfo.buildId).split(".").at(-1).slice(0, 8);
  return `v${buildInfo.appVersion}${shortBuild ? ` · ${shortBuild}` : ""}`;
}

async function startElectron(userData, httpPort, cdpPort) {
  const child = spawnManaged(electronExecutable, [projectRoot, `--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`, "--disable-gpu"], {
    env: {
      ...process.env,
      PORT: String(httpPort),
      RAINYDAYS_E2E_USE_DIST: "1",
      RAINYDAYS_E2E_NODE_EXECUTABLE: process.execPath,
      ELECTRON_ENABLE_LOGGING: "1",
    },
  });
  console.log("[electron-e2e] spawn returned");
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`Electron exited ${child.exitCode}: ${stdout}\n${stderr}`);
      try { return (await boundedFetch(`http://127.0.0.1:${httpPort}/`)).ok; } catch { return false; }
    }, { timeoutMs: 40_000, label: "Electron application service" });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nElectron stdout:\n${stdout}\nElectron stderr:\n${stderr}`);
  }
  return { child, logs: () => ({ stdout, stderr }) };
}

async function stopElectron(instance, httpPort, cdpPort) {
  const termination = await terminateProcessTreeAsync(instance.child);
  assert.equal(termination.exitCode, 0, "Electron PID tree termination failed");
  assert(termination.childExited, "Electron direct child did not exit");
  await waitFor(async () => {
    try { await boundedFetch(`http://127.0.0.1:${httpPort}/`); return false; } catch { return true; }
  }, { timeoutMs: 20_000, label: "Electron HTTP shutdown" });
  await waitFor(async () => {
    try { await boundedFetch(`http://127.0.0.1:${cdpPort}/json/version`); return false; } catch { return true; }
  }, { timeoutMs: 20_000, label: "Electron CDP shutdown" });
}

async function probeIdentity(client, buildInfo, httpPort) {
  assert.equal(new URL(client.target.url).origin, `http://127.0.0.1:${httpPort}`);
  const value = await waitFor(async () => {
    try {
      const result = await client.evaluate(`(async()=>({
        ui: document.getElementById('app-version')?.textContent,
        documentTitle: document.title,
        preload: window.electronAPI,
        status: await (await fetch('/api/status')).json(),
        version: await (await fetch('/api/version')).json()
      }))()`);
      return result?.ui === expectedUi(buildInfo) ? result : null;
    } catch { return null; }
  }, { timeoutMs: 20_000, label: "renderer version state" });
  assert.equal(value.ui, expectedUi(buildInfo));
  assert.equal(value.documentTitle, `RainyDays ${buildInfo.appVersion} (${buildInfo.buildId})`);
  assert.equal(value.preload.appVersion, buildInfo.appVersion);
  assert.equal(value.preload.buildId, buildInfo.buildId);
  assert.deepEqual(value.version, buildInfo);
  assert.deepEqual(value.status.version, buildInfo);
  assert.equal((await boundedFetch(`http://127.0.0.1:${httpPort}/api/version`)).status, 401);
  return value;
}

async function rendererRequest(client, route, options = undefined) {
  return client.evaluate(`(async()=>{const response=await fetch(${JSON.stringify(route)},${JSON.stringify(options)});let body;try{body=await response.json()}catch{body=await response.text()}return {status:response.status,body}})()`);
}

async function assertCanonicalPathPolicy(client, userData, launchIndex) {
  assert.equal(process.platform, "win32", "SEC-02 Electron junction assertion requires Windows");
  const workspace = path.join(userData, "workspace");
  const prefix = `sec02-electron-launch-${launchIndex}`;
  const outside = path.join(userData, `${prefix}-outside`);
  const junction = path.join(workspace, `${prefix}-junction`);
  const internalName = `${prefix}-internal.txt`;
  const internalValue = `INTERNAL-${launchIndex}`;
  const externalValue = `EXTERNAL-${launchIndex}`;
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(workspace, internalName), internalValue);
  await writeFile(path.join(outside, "secret.txt"), externalValue);
  await symlink(outside, junction, "junction");

  const internal = await rendererRequest(client, `/api/files/preview?root=workspace&path=${encodeURIComponent(internalName)}`);
  assert.equal(internal.status, 200, "real Electron API rejected a root-internal file");
  assert.equal(internal.body.text, internalValue);

  const traversal = await rendererRequest(client, `/api/files/preview?root=workspace&path=${encodeURIComponent(`../${prefix}-outside/secret.txt`)}`);
  assert.equal(traversal.status, 400, "real Electron API accepted traversal");
  assert(!JSON.stringify(traversal.body).includes(externalValue), "traversal denial disclosed external bytes");

  const redirected = await rendererRequest(client, `/api/files/preview?root=workspace&path=${encodeURIComponent(`${prefix}-junction/secret.txt`)}`);
  assert.equal(redirected.status, 400, "real Electron API followed a junction");
  assert(!JSON.stringify(redirected.body).includes(externalValue), "junction denial disclosed external bytes");

  const mediaName = `${prefix}-range.png`;
  const mediaPath = path.join(workspace, mediaName);
  const originalPath = path.join(workspace, `${prefix}-range-original.png`);
  const replacementPath = path.join(workspace, `${prefix}-range-replacement.png`);
  const mediaSize = 96 * 1024 * 1024;
  await writeFile(mediaPath, Buffer.alloc(mediaSize, 0x41));
  await writeFile(replacementPath, "ATTACKER-REPLACEMENT");
  const rangePromise = client.evaluate(`(async()=>{const response=await fetch('/api/files/content?root=workspace&path=${encodeURIComponent(mediaName)}',{headers:{Range:'bytes=0-${mediaSize - 1}'}});const bytes=new Uint8Array(await response.arrayBuffer());let originalOnly=true;for(let i=0;i<bytes.length;i++){if(bytes[i]!==65){originalOnly=false;break}}return {status:response.status,length:bytes.length,originalOnly,contentRange:response.headers.get('content-range')}})()`);
  let rangeSettled = false;
  rangePromise.then(() => { rangeSettled = true; }, () => { rangeSettled = true; });
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(rangeSettled, false, "File Viewer range completed before replacement fixture could exercise the open handle");
  await rename(mediaPath, originalPath);
  await rename(replacementPath, mediaPath);
  const range = await rangePromise;
  assert.deepEqual(range, {
    status: 206,
    length: mediaSize,
    originalOnly: true,
    contentRange: `bytes 0-${mediaSize - 1}/${mediaSize}`,
  }, "File Viewer range lease did not return only original-handle bytes after pathname replacement");

  const terminalsBefore = await rendererRequest(client, "/api/terminals");
  assert.equal(terminalsBefore.status, 200);
  const terminalDenied = await rendererRequest(client, "/api/terminals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: prefix, shell: "cmd", cwd: outside }),
  });
  assert.equal(terminalDenied.status, 403, "direct HTTP Terminal mutation bypassed native consent");
  assert.equal(terminalDenied.body.code, "EXEC_DIRECT_MUTATION_DENIED");
  const terminalsAfter = await rendererRequest(client, "/api/terminals");
  assert.equal(terminalsAfter.status, 200);
  assert.equal(terminalsAfter.body.terminals.length, terminalsBefore.body.terminals.length, "external CWD denial created a Terminal process record");
}

test("real Electron main, preload and renderer preserve identity and session across restart", { timeout: 180_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-gov03-electron-");
  const userData = path.join(fixture, "user-data");
  const buildInfo = JSON.parse(await readFile(path.join(projectRoot, "build-info.json"), "utf8"));
  let first;
  let second;
  let client;
  let sessionId;
  try {
    console.log("[electron-e2e] first launch");
    const [firstHttpPort, firstCdpPort] = await freeDistinctPorts(2);
    console.log("[electron-e2e] ports allocated");
    first = await startElectron(userData, firstHttpPort, firstCdpPort);
    console.log("[electron-e2e] first CDP");
    try { client = await connectCdp(firstCdpPort); }
    catch (error) {
      const logs = first.logs();
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nElectron stdout:\n${logs.stdout}\nElectron stderr:\n${logs.stderr}`);
    }
    await probeIdentity(client, buildInfo, firstHttpPort);
    console.log("[electron-e2e] first identity passed");
    const created = await client.evaluate(`fetch('/api/sessions', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'GOV-03 Electron persistence'})}).then(r=>r.json())`);
    sessionId = created.session.id;
    assert.match(sessionId, /^[0-9a-f-]{36}$/);
    await assertCanonicalPathPolicy(client, userData, 1);
    await client.evaluate("location.reload(); true");
    const afterReload = await waitFor(async () => {
      try {
        const value = await client.evaluate("fetch('/api/sessions').then(r=>r.json())");
        return Array.isArray(value?.sessions) ? value : null;
      } catch { return null; }
    }, { timeoutMs: 20_000, label: "renderer reload" });
    assert(afterReload.sessions.some((entry) => entry.id === sessionId));
    assert(first.logs().stdout.includes(buildInfo.buildId));
    client.close(); client = null;
    console.log("[electron-e2e] stopping first launch");
    await stopElectron(first, firstHttpPort, firstCdpPort); first = null;
    console.log("[electron-e2e] first launch stopped");

    const [secondHttpPort, secondCdpPort] = await freeDistinctPorts(2);
    console.log("[electron-e2e] second launch");
    second = await startElectron(userData, secondHttpPort, secondCdpPort);
    client = await connectCdp(secondCdpPort);
    await probeIdentity(client, buildInfo, secondHttpPort);
    console.log("[electron-e2e] second identity passed");
    await assertCanonicalPathPolicy(client, userData, 2);
    const afterRestart = await client.evaluate("fetch('/api/sessions').then(r=>r.json())");
    assert(afterRestart.sessions.some((entry) => entry.id === sessionId));
    assert.equal(afterRestart.current, sessionId);
    client.close(); client = null;
    await stopElectron(second, secondHttpPort, secondCdpPort); second = null;
  } finally {
    client?.close();
    if (first) await terminateProcessTreeAsync(first.child);
    if (second) await terminateProcessTreeAsync(second.child);
    await removeFixture(fixture);
  }
  assert.equal(await pathExists(fixture), false);
});
