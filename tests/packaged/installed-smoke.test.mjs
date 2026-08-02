import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, rename, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { validateElectronAsar } from "../../scripts/electron-asar-integrity.mjs";
import { fileSha256, verifyInstallerPreflight } from "../../scripts/package-artifact-lib.mjs";
import {
  atomicWriteJson,
  boundedFetch,
  connectCdp,
  freeDistinctPorts,
  makeTempDir,
  observeWindowsFileHandleInProcessTree,
  pathExists,
  projectRoot,
  removeFixture,
  runProcess,
  terminateProcessTreeAsync,
  waitFor,
} from "../helpers.mjs";
import { classifyInstallerResult, launchTracked, observeWindowsPowerShellOutput, observeWindowsRegistrySnapshot } from "./smoke-helpers.mjs";
import { createSec02Recorder } from "../sec02-receipts.mjs";

const pathPolicyAssertionIds = Object.freeze([
  "root-internal-success",
  "traversal-denied",
  "junction-denied",
  "viewer-range-handle-replacement",
  "terminal-cwd-denied-before-spawn",
]);

function expectedUi(buildInfo) {
  const shortBuild = String(buildInfo.buildId).split(".").at(-1).slice(0, 8);
  return `v${buildInfo.appVersion}${shortBuild ? ` · ${shortBuild}` : ""}`;
}

function pathPolicyDetails() {
  return {
    schemaVersion: 1,
    expectedLaunchCount: 2,
    assertionIds: [...pathPolicyAssertionIds],
    launches: [1, 2].map(launchIndex => ({
      launchIndex,
      assertionCount: pathPolicyAssertionIds.length,
      passed: false,
      assertions: pathPolicyAssertionIds.map(id => ({ id, passed: false })),
    })),
  };
}

function passedPathPolicyLaunch(launchIndex) {
  return {
    launchIndex,
    assertionCount: pathPolicyAssertionIds.length,
    passed: true,
    assertions: pathPolicyAssertionIds.map(id => ({ id, passed: true })),
  };
}

function launchInstalled(executable, userData, httpPort, cdpPort) {
  return launchTracked(executable, [`--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`, "--disable-gpu"], {
    env: { ...process.env, PORT: String(httpPort), ELECTRON_ENABLE_LOGGING: "1" },
    timeoutMs: 45_000,
    label: "installed application service",
    readyProbe: async () => {
      try { return (await boundedFetch(`http://127.0.0.1:${httpPort}/`)).ok; } catch { return false; }
    },
  });
}

async function listenerClosed(port) {
  try { await boundedFetch(`http://127.0.0.1:${port}/`); return false; } catch { return true; }
}

async function stopInstalled(instance, httpPort, cdpPort) {
  const termination = await terminateProcessTreeAsync(instance.child);
  assert.equal(termination.exitCode, 0, "installed PID tree termination failed");
  assert(termination.childExited, "installed direct child did not exit");
  await waitFor(() => listenerClosed(httpPort), { timeoutMs: 20_000, label: "installed HTTP shutdown" });
  await waitFor(() => listenerClosed(cdpPort), { timeoutMs: 20_000, label: "installed CDP shutdown" });
}

async function countFiles(directory) {
  if (!await pathExists(directory)) return 0;
  let count = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) count += await countFiles(path.join(directory, entry.name));
    else count += 1;
  }
  return count;
}

async function probeIdentity(client, buildInfo, httpPort) {
  assert.equal(new URL(client.target.url).origin, `http://127.0.0.1:${httpPort}`);
  const identity = await waitFor(async () => {
    try {
      const value = await client.evaluate(`(async()=>({
        ui: document.getElementById('app-version')?.textContent,
        documentTitle: document.title,
        preload: window.electronAPI,
        status: await (await fetch('/api/status')).json(),
        version: await (await fetch('/api/version')).json(),
        diagnostics: await (await fetch('/api/diagnostics')).json()
      }))()`);
      return value?.ui === expectedUi(buildInfo) ? value : null;
    } catch { return null; }
  }, { timeoutMs: 25_000, label: "installed renderer identity" });
  assert.equal(identity.ui, expectedUi(buildInfo));
  assert.equal(identity.documentTitle, `RainyDays ${buildInfo.appVersion} (${buildInfo.buildId})`);
  assert.equal(identity.preload.appVersion, buildInfo.appVersion);
  assert.equal(identity.preload.buildId, buildInfo.buildId);
  assert.deepEqual(identity.version, buildInfo);
  assert.deepEqual(identity.status.version, buildInfo);
  assert.deepEqual(identity.diagnostics.version, buildInfo);
  const diagnosticText = JSON.stringify(identity.diagnostics);
  assert(!/apiKey|miniLuxApiToken|X-RainyDays-Token/i.test(diagnosticText));
  assert(!/[A-Za-z]:\\\\Users\\\\/i.test(diagnosticText));
  assert.equal((await boundedFetch(`http://127.0.0.1:${httpPort}/api/version`)).status, 401);
}

async function rendererRequest(client, route, options = undefined) {
  return client.evaluate(`(async()=>{const response=await fetch(${JSON.stringify(route)},${JSON.stringify(options)});let body;try{body=await response.json()}catch{body=await response.text()}return {status:response.status,body}})()`);
}

async function assertPackagedPathPolicy(client, userData, launchIndex, applicationRootPid) {
  const workspace = path.join(userData, "workspace");
  const prefix = `sec02-packaged-launch-${launchIndex}`;
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
  assert.equal(internal.status, 200, `packaged launch ${launchIndex} rejected a root-internal file`);
  assert.equal(internal.body.text, internalValue);

  const traversal = await rendererRequest(client, `/api/files/preview?root=workspace&path=${encodeURIComponent(`../${prefix}-outside/secret.txt`)}`);
  assert.equal(traversal.status, 400, `packaged launch ${launchIndex} accepted traversal`);
  assert(!JSON.stringify(traversal.body).includes(externalValue), "traversal denial disclosed external bytes");

  const redirected = await rendererRequest(client, `/api/files/preview?root=workspace&path=${encodeURIComponent(`${prefix}-junction/secret.txt`)}`);
  assert.equal(redirected.status, 400, `packaged launch ${launchIndex} followed a junction`);
  assert(!JSON.stringify(redirected.body).includes(externalValue), "junction denial disclosed external bytes");

  const mediaName = `${prefix}-range.png`;
  const mediaPath = path.join(workspace, mediaName);
  const originalPath = path.join(workspace, `${prefix}-range-original.png`);
  const replacementPath = path.join(workspace, `${prefix}-range-replacement.png`);
  const mediaSize = 96 * 1024 * 1024;
  await writeFile(mediaPath, Buffer.alloc(mediaSize, 0x41));
  await writeFile(replacementPath, "ATTACKER-REPLACEMENT");
  await client.evaluate(`(()=>{const state={error:null,ready:null,response:null};window.__rainydaysRangeProbe=state;fetch('/api/files/content?root=workspace&path=${encodeURIComponent(mediaName)}',{headers:{Range:'bytes=0-${mediaSize - 1}'}}).then(response=>{state.response=response;state.ready={status:response.status,contentRange:response.headers.get('content-range')}}).catch(error=>{state.error=String(error)});return true})()`);
  const rangeReady = await waitFor(async () => client.evaluate(`(()=>{const state=window.__rainydaysRangeProbe;return state?.error?{error:state.error}:state?.ready})()`), {
    timeoutMs: 20_000,
    label: "packaged File Viewer range lease headers",
  });
  assert.deepEqual(rangeReady, { status: 206, contentRange: `bytes 0-${mediaSize - 1}/${mediaSize}` });
  const beforeReplacement = await observeWindowsFileHandleInProcessTree(mediaPath, applicationRootPid);
  assert.equal(beforeReplacement.matched, true, `packaged launch ${launchIndex} did not hold the original media object before pathname replacement`);
  await rename(mediaPath, originalPath);
  await rename(replacementPath, mediaPath);
  const afterReplacement = await observeWindowsFileHandleInProcessTree(originalPath, applicationRootPid);
  assert.equal(afterReplacement.matched, true, `packaged launch ${launchIndex} did not retain the original media object after pathname replacement`);
  const range = await client.evaluate(`(async()=>{const state=window.__rainydaysRangeProbe;const response=state.response;const bytes=new Uint8Array(await response.arrayBuffer());let originalOnly=true;for(let i=0;i<bytes.length;i++){if(bytes[i]!==65){originalOnly=false;break}}delete window.__rainydaysRangeProbe;return {status:response.status,length:bytes.length,originalOnly,contentRange:response.headers.get('content-range')}})()`);
  assert.deepEqual(range, {
    status: 206,
    length: mediaSize,
    originalOnly: true,
    contentRange: `bytes 0-${mediaSize - 1}/${mediaSize}`,
  }, "packaged File Viewer range lease did not return only original-handle bytes after pathname replacement");

  const terminalsBefore = await rendererRequest(client, "/api/terminals");
  assert.equal(terminalsBefore.status, 200);
  const terminalDenied = await rendererRequest(client, "/api/terminals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: prefix, shell: "cmd", cwd: outside }),
  });
  assert.equal(terminalDenied.status, 403, `packaged launch ${launchIndex} bypassed native consent`);
  assert.equal(terminalDenied.body.code, "EXEC_DIRECT_MUTATION_DENIED");
  const terminalsAfter = await rendererRequest(client, "/api/terminals");
  assert.equal(terminalsAfter.status, 200);
  assert.equal(terminalsAfter.body.terminals.length, terminalsBefore.body.terminals.length, "external CWD denial created a Terminal process record");
  return passedPathPolicyLaunch(launchIndex);
}

function hashText(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function knownShortcutPaths(outputPath) {
  const output = await observeWindowsPowerShellOutput("[ordered]@{ programs=[Environment]::GetFolderPath('Programs'); desktop=[Environment]::GetFolderPath('DesktopDirectory') } | ConvertTo-Json -Compress", outputPath);
  const folders = JSON.parse(output);
  assert.equal(typeof folders.programs, "string");
  assert.equal(typeof folders.desktop, "string");
  return [
    { key: "programs", filePath: path.join(folders.programs, "RainyDays.lnk") },
    { key: "desktop", filePath: path.join(folders.desktop, "RainyDays.lnk") },
  ];
}

async function systemIntegrationSnapshot(registryOutputPath, powershellOutputPath, missingRegistryRoot) {
  const missingRegistry = JSON.parse(await observeWindowsRegistrySnapshot(missingRegistryRoot, registryOutputPath));
  assert.deepEqual(missingRegistry, { rootPresent: false, items: [] }, "missing registry root was not observed as an empty set");
  const registryJson = await observeWindowsRegistrySnapshot("HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall", registryOutputPath);
  const registry = JSON.parse(registryJson);
  assert.deepEqual(Object.keys(registry), ["rootPresent", "items"], "registry observation shape is invalid");
  assert.equal(typeof registry.rootPresent, "boolean");
  assert(Array.isArray(registry.items), "registry observation items must be a canonical array");
  const shortcuts = {};
  for (const shortcut of await knownShortcutPaths(powershellOutputPath)) {
    shortcuts[shortcut.key] = await pathExists(shortcut.filePath) ? await fileSha256(shortcut.filePath) : null;
  }
  return { registryHash: hashText(JSON.stringify(registry)), shortcuts };
}

async function processReferenceCount(paths, outputPath) {
  const command = `$needles=@($env:MINI_LUX_PROCESS_NEEDLES|ConvertFrom-Json);$count=0;Get-CimInstance Win32_Process -ErrorAction Stop|ForEach-Object{$text=[string]$_.ExecutablePath+[Environment]::NewLine+[string]$_.CommandLine;foreach($needle in $needles){if($needle-and $text.IndexOf($needle,[StringComparison]::OrdinalIgnoreCase)-ge 0){$count++;break}}};$count`;
  const output = await observeWindowsPowerShellOutput(command, outputPath, { ...process.env, MINI_LUX_PROCESS_NEEDLES: JSON.stringify(paths) });
  assert.match(output, /^\d+$/);
  return Number(output);
}

async function waitForProcessConvergence(paths, label, outputPath) {
  await waitFor(async () => await processReferenceCount(paths, outputPath) === 0, { timeoutMs: 30_000, intervalMs: 250, label });
}

async function proveExecutableReleased(executable) {
  const probe = `${executable}.release-probe`;
  await waitFor(async () => {
    try {
      await rename(executable, probe);
      await rename(probe, executable);
      return true;
    } catch {
      if (await pathExists(probe) && !await pathExists(executable)) await rename(probe, executable).catch(() => {});
      return false;
    }
  }, { timeoutMs: 30_000, intervalMs: 250, label: "installer executable path release" });
}

async function publishDetails(filePath, details) {
  if (filePath) await atomicWriteJson(filePath, details);
}

test("current Windows installer repeats identity, persistence and cleanup smoke", { timeout: 300_000 }, async () => {
  assert.equal(process.platform, "win32", "UNSUPPORTED_PLATFORM: packaged E2E requires Windows");
  const recorder = await createSec02Recorder(import.meta.url, "current Windows installer repeats identity, persistence and cleanup smoke");
  const detailPath = process.env.RAINYDAYS_LAYER_DETAIL_REPORT ? path.resolve(process.env.RAINYDAYS_LAYER_DETAIL_REPORT) : null;
  const fixture = await makeTempDir("mini-lux-gov03-packaged-");
  const executionDir = path.join(fixture, "artifact-execution");
  const executionTemp = path.join(fixture, "process-temp");
  const installDir = path.join(fixture, "installed");
  const userData = path.join(fixture, "user-data");
  const registrySnapshotPath = path.join(fixture, "registry-snapshot.json");
  const powershellOutputPath = path.join(fixture, "powershell-output.txt");
  const missingRegistryRoot = `HKCU:\\Software\\RainyDays-GOV03-Missing-${hashText(fixture).slice(0, 32)}`;
  await mkdir(executionDir, { recursive: true });
  await mkdir(executionTemp, { recursive: true });
  const details = {
    phase: "preflight",
    artifactExecution: {
      sourceBytes: null,
      sourceSha256: null,
      executedBytes: null,
      executedSha256: null,
      identityMatched: false,
    },
    installerExitCode: null,
    installerSignal: null,
    installerClassification: null,
    installerConverged: false,
    packageBinding: {
      schemaVersion: null,
      buildId: null,
      sourceDigest: null,
      stageManifestSha256: null,
      buildInfoSha256: null,
      distIntegritySha256: null,
      native: {
        architectureSha256: null,
        manifest: { path: null, bytes: null, sha256: null },
        sourceDigest: null,
        toolchainDigest: null,
        signatureStatus: null,
        binaries: [],
        testProjection: { manifest: { path: null, bytes: null, sha256: null } },
      },
      sinkInventorySha256: null,
      detectorPolicySha256: null,
      reviewPolicySha256: null,
      dialectCheckerSha256: null,
      dialectPolicySha256: null,
      dialectImportSetSha256: null,
      executableManifestSha256: null,
      runtimeSinkSetSha256: null,
      authoredExecutableProjectionSha256: null,
      packagedSinkSetSha256: null,
      packagedDialectImportSetSha256: null,
      asarSha256: null,
      authoredFileCount: null,
      dependencyFileCount: null,
      unpacked: { fileCount: null, executableFileCount: null },
      missing: [],
      extra: [],
      mismatched: [],
      packageInspected: false,
      asarPayloadBound: false,
      producerSummaryTrusted: false,
    },
    pathPolicy: pathPolicyDetails(),
    uninstallerSignal: null,
    uninstallerConverged: false,
    cleanup: {
      attemptedOfficialUninstall: false,
      officialUninstallExitCode: null,
      installDirectoryEmpty: false,
      registryObserved: false,
      registryMatchesBaseline: false,
      shortcutObserved: false,
      shortcutMatchesBaseline: false,
      processesStopped: false,
      executionCopyReleased: true,
      fixtureRemoved: false,
      passed: false,
    },
  };
  let first = null;
  let second = null;
  let client = null;
  let sessionId;
  let firstPorts = null;
  let secondPorts = null;
  let officialUninstallCompleted = false;
  let systemBefore = null;
  let executedInstaller = null;
  const processEnv = { ...process.env, TEMP: executionTemp, TMP: executionTemp };
  try {
    systemBefore = await systemIntegrationSnapshot(registrySnapshotPath, powershellOutputPath, missingRegistryRoot);
    details.cleanup.registryObserved = true;
    details.cleanup.shortcutObserved = true;
    const check = await runProcess(process.execPath, ["scripts/generate-build-info.mjs", "--check"], { timeoutMs: 60_000 });
    assert.equal(check.code, 0, check.stderr);
    const buildInfo = JSON.parse(await readFile(path.join(projectRoot, "build-info.json"), "utf8"));
    const manifestPath = path.resolve(process.env.RAINYDAYS_PACKAGE_ARTIFACT_MANIFEST || path.join(projectRoot, "test-results", "package-artifact.json"));
    const { installer, manifest } = await verifyInstallerPreflight({
      manifestPath,
      installerOverride: process.env.RAINYDAYS_INSTALLER_OVERRIDE,
      buildInfo,
      projectRoot,
    });
    executedInstaller = path.join(executionDir, path.basename(installer));
    details.cleanup.executionCopyReleased = false;
    await copyFile(installer, executedInstaller);
    const sourceInfo = await stat(installer);
    const executedInfo = await stat(executedInstaller);
    details.artifactExecution.sourceBytes = sourceInfo.size;
    details.artifactExecution.sourceSha256 = await fileSha256(installer);
    details.artifactExecution.executedBytes = executedInfo.size;
    details.artifactExecution.executedSha256 = await fileSha256(executedInstaller);
    details.artifactExecution.identityMatched = details.artifactExecution.sourceBytes === manifest.artifact.bytes
      && details.artifactExecution.executedBytes === manifest.artifact.bytes
      && details.artifactExecution.sourceSha256 === manifest.artifact.sha256
      && details.artifactExecution.executedSha256 === manifest.artifact.sha256;
    assert(details.artifactExecution.identityMatched, "executed installer copy differs from the preflight artifact");

    details.phase = "install";
    let install = { code: null, signal: null, stderr: "" };
    let installTimedOut = false;
    try { install = await runProcess(executedInstaller, ["/S", `/D=${installDir}`], { env: processEnv, timeoutMs: 5 * 60_000 }); }
    catch (error) {
      installTimedOut = /Process timeout:/.test(error instanceof Error ? error.message : String(error));
      if (!installTimedOut) throw error;
    }
    details.installerExitCode = install.code;
    details.installerSignal = install.signal;
    details.installerClassification = classifyInstallerResult(install, installTimedOut);
    await waitForProcessConvergence([executionDir, executionTemp, installDir], "installer descendant convergence", powershellOutputPath);
    await proveExecutableReleased(executedInstaller);
    details.installerConverged = true;
    details.cleanup.executionCopyReleased = true;
    assert.equal(install.code, 0, `installer execution failed: ${details.installerClassification}`);
    const executable = path.join(installDir, "RainyDays.exe");
    await waitFor(() => pathExists(executable), { timeoutMs: 30_000, label: "installed executable" });
    details.packageBinding = await validateElectronAsar(projectRoot, path.join(installDir, "resources"));
    if (recorder.enabled) await recorder.observe("SEC02-P36-packaged-asar-bound", {
      packageInspected: details.packageBinding.packageInspected,
      asarPayloadBound: details.packageBinding.asarPayloadBound,
      producerSummaryTrusted: details.packageBinding.producerSummaryTrusted,
    });

    details.phase = "first-launch";
    firstPorts = await freeDistinctPorts(2);
    first = launchInstalled(executable, userData, firstPorts[0], firstPorts[1]);
    await first.ready;
    client = await connectCdp(firstPorts[1]);
    await probeIdentity(client, buildInfo, firstPorts[0]);
    const created = await client.evaluate(`fetch('/api/sessions', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'GOV-03 packaged persistence'})}).then(r=>r.json())`);
    sessionId = created.session.id;
    details.pathPolicy.launches[0] = await assertPackagedPathPolicy(client, userData, 1, first.child.pid);
    const terminalIsolation = await client.evaluate(`(async () => {
      const before = await fetch('/api/terminals').then(r=>r.json());
      const startedResponse = await fetch('/api/terminals', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'SEC-01 packaged owner',shell:'cmd'})});
      const started = await startedResponse.json();
      const secondResponse = await fetch('/api/sessions', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'SEC-01 packaged other session'})});
      const second = await secondResponse.json();
      const after = await fetch('/api/terminals').then(r=>r.json());
      const selected = await fetch('/api/sessions/${sessionId}/select', {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
      return {started:startedResponse.status,code:started.code,second:secondResponse.status,secondId:second.session.id,beforeCount:before.terminals.length,afterCount:after.terminals.length,selected:selected.status};
    })()`);
    assert.deepEqual(terminalIsolation, {started:403,code:"EXEC_DIRECT_MUTATION_DENIED",second:200,secondId:terminalIsolation.secondId,beforeCount:0,afterCount:0,selected:200});
    assert.notEqual(terminalIsolation.secondId, sessionId);
    assert(first.logs().stdout.includes(buildInfo.buildId));
    client.close(); client = null;
    await stopInstalled(first, firstPorts[0], firstPorts[1]); first = null;

    details.phase = "restart";
    secondPorts = await freeDistinctPorts(2);
    second = launchInstalled(executable, userData, secondPorts[0], secondPorts[1]);
    await second.ready;
    client = await connectCdp(secondPorts[1]);
    await probeIdentity(client, buildInfo, secondPorts[0]);
    details.pathPolicy.launches[1] = await assertPackagedPathPolicy(client, userData, 2, second.child.pid);
    const sessions = await client.evaluate("fetch('/api/sessions').then(r=>r.json())");
    assert(sessions.sessions.some((entry) => entry.id === sessionId));
    assert.equal(sessions.current, sessionId);
    client.close(); client = null;
    await stopInstalled(second, secondPorts[0], secondPorts[1]); second = null;

    details.phase = "uninstall";
    const uninstaller = path.join(installDir, "Uninstall RainyDays.exe");
    assert(await pathExists(uninstaller), "uninstaller missing");
    details.cleanup.attemptedOfficialUninstall = true;
    const uninstall = await runProcess(uninstaller, ["/S"], { env: processEnv, timeoutMs: 3 * 60_000 });
    details.cleanup.officialUninstallExitCode = uninstall.code;
    details.uninstallerSignal = uninstall.signal;
    assert.equal(uninstall.code, 0, uninstall.stderr);
    officialUninstallCompleted = true;
    await waitForProcessConvergence([executionDir, executionTemp, installDir], "uninstaller descendant convergence", powershellOutputPath);
    details.uninstallerConverged = true;
    await waitFor(async () => (await countFiles(installDir)) === 0, { timeoutMs: 30_000, label: "uninstall file cleanup" });
    details.phase = "complete";
  } finally {
    client?.close();
    for (const [instance, ports] of [[first, firstPorts], [second, secondPorts]]) {
      if (instance) {
        const termination = await terminateProcessTreeAsync(instance.child).catch(() => ({ exitCode: 1, childExited: false }));
        if (termination.exitCode !== 0 || !termination.childExited) details.cleanup.processesStopped = false;
      }
      if (ports) {
        const closed = await Promise.all(ports.map((port) => listenerClosed(port)));
        if (!closed.every(Boolean)) details.cleanup.processesStopped = false;
      }
    }
    const uninstaller = path.join(installDir, "Uninstall RainyDays.exe");
    if (!officialUninstallCompleted && await pathExists(uninstaller)) {
      details.cleanup.attemptedOfficialUninstall = true;
      const uninstall = await runProcess(uninstaller, ["/S"], { env: processEnv, timeoutMs: 180_000 }).catch(() => ({ code: null, signal: "OBSERVATION_FAILURE" }));
      details.cleanup.officialUninstallExitCode = uninstall.code;
      details.uninstallerSignal = uninstall.signal;
      officialUninstallCompleted = uninstall.code === 0 && uninstall.signal === null;
    }
    try {
      await waitForProcessConvergence([executionDir, executionTemp, installDir], "final packaged process convergence", powershellOutputPath);
      details.cleanup.processesStopped = true;
      if (executedInstaller && await pathExists(executedInstaller)) {
        await proveExecutableReleased(executedInstaller);
        details.cleanup.executionCopyReleased = true;
      }
    } catch { details.cleanup.processesStopped = false; }
    try {
      await waitFor(async () => (await countFiles(installDir)) === 0, { timeoutMs: 30_000, intervalMs: 250, label: "final install directory cleanup" });
      details.cleanup.installDirectoryEmpty = true;
    } catch { details.cleanup.installDirectoryEmpty = false; }
    let systemAfter = null;
    try {
      systemAfter = await waitFor(async () => {
        const candidate = await systemIntegrationSnapshot(registrySnapshotPath, powershellOutputPath, missingRegistryRoot);
        return systemBefore && candidate.registryHash === systemBefore.registryHash
          && JSON.stringify(candidate.shortcuts) === JSON.stringify(systemBefore.shortcuts) ? candidate : null;
      }, { timeoutMs: 30_000, intervalMs: 250, label: "uninstall registry and shortcut cleanup" });
      details.cleanup.registryObserved = true;
      details.cleanup.shortcutObserved = true;
    } catch {
      details.cleanup.registryObserved = false;
      details.cleanup.shortcutObserved = false;
    }
    details.cleanup.registryMatchesBaseline = Boolean(systemBefore && systemAfter && systemAfter.registryHash === systemBefore.registryHash);
    details.cleanup.shortcutMatchesBaseline = Boolean(systemBefore && systemAfter && JSON.stringify(systemAfter.shortcuts) === JSON.stringify(systemBefore.shortcuts));
    const restored = (!details.cleanup.attemptedOfficialUninstall || officialUninstallCompleted)
      && details.cleanup.installDirectoryEmpty && details.cleanup.registryObserved && details.cleanup.registryMatchesBaseline
      && details.cleanup.shortcutObserved && details.cleanup.shortcutMatchesBaseline
      && details.cleanup.processesStopped && details.cleanup.executionCopyReleased;
    try {
      await removeFixture(fixture);
      details.cleanup.fixtureRemoved = !await pathExists(fixture);
    } catch { details.cleanup.fixtureRemoved = false; }
    details.cleanup.passed = restored && details.cleanup.fixtureRemoved;
    await publishDetails(detailPath, details);
    await recorder.close();
    assert(details.cleanup.passed, "packaged cleanup did not restore the pre-install system state");
  }
  assert.equal(await pathExists(fixture), false);
});
