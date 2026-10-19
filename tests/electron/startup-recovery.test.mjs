import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import {
  boundedFetch, connectCdp, freeDistinctPorts, makeTempDir, projectRoot,
  removeFixture, spawnManaged, terminateProcessTreeAsync, waitFor, waitForChildExit,
} from "../helpers.mjs";

async function fixtureDesktop(options = {}) {
  const root = await makeTempDir("rainydays-d01-");
  const userData = path.join(root, "中文 user data");
  const settings = {
    defaultPersona: "general", workspaceRoot: path.join(root, "资料 workspace"),
    departmentDataRoot: path.join(root, "missing-department"), outputDir: path.join(userData, "output"),
    ...options,
  };
  await Promise.all([userData, settings.workspaceRoot, settings.outputDir].map(dir => mkdir(dir, { recursive: true })));
  await mkdir(path.join(settings.workspaceRoot, "旧目录"));
  await writeFile(path.join(settings.workspaceRoot, "旧目录", "说明.txt"), "隔离测试文件");
  await writeFile(path.join(userData, "config.json"), JSON.stringify({ defaultProfile: "default", profiles: {
    default: { model: "fixture-model", apiKey: "", baseURL: "https://provider.invalid/v1", providerType: "openai-compatible" },
  }, settings }));
  const [httpPort, cdpPort] = await freeDistinctPorts(2);
  let child, client, logs = "";
  async function stop() {
    try {
      if (client && child?.exitCode === null) {
        const closing = client.send("Browser.close").catch(() => undefined);
        const exited = await waitForChildExit(child, 20_000);
        client.close(); client = null;
        await closing;
        assert.equal(exited, true, "D01 desktop must exit cleanly before a normal restart");
      }
    } finally {
      client?.close(); client = null;
      if (child) { await terminateProcessTreeAsync(child); child = null; }
    }
  }
  async function start() {
    logs = "";
    const env = { ...process.env, npm_node_execpath: process.execPath, PORT: String(httpPort) };
    delete env.ELECTRON_RUN_AS_NODE;
    delete env.RAINYDAYS_E2E_USE_DIST;
    delete env.RAINYDAYS_E2E_NODE_EXECUTABLE;
    child = spawnManaged(path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe"),
      [projectRoot, `--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`, "--disable-gpu"], { env });
    for (const stream of [child.stdout, child.stderr]) { stream.setEncoding("utf8"); stream.on("data", chunk => { logs = (logs + chunk).slice(-25_000); }); }
    try { await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`D01 desktop exited: ${logs}`);
      try { return (await boundedFetch(`http://127.0.0.1:${httpPort}/`, { signal: AbortSignal.timeout(1_000) })).ok; }
      catch { return false; }
    }, { timeoutMs: 45_000, label: "D01 source service" }); }
    catch (error) { throw new Error(`${error.message}\n${logs}`, { cause: error }); }
    client = await connectCdp(cdpPort);
    try {
      await waitFor(async () => { try { return await client.evaluate("Boolean(desktopNavigationReady && currentSessionId)", 2_000); } catch { return false; } },
        { timeoutMs: 20_000, label: "D01 recovered workbench" });
    } catch (error) {
      const state = await client.evaluate("({url:location.href,ready:typeof desktopNavigationReady!=='undefined'&&desktopNavigationReady,session:typeof currentSessionId!=='undefined'?currentSessionId:null,text:document.body.textContent.slice(-1500)})", 2_000).catch(reason => ({ error: reason.message }));
      throw new Error(`${error.message}\n${JSON.stringify(state)}\n${logs}`, { cause: error });
    }
    await client.evaluate("closeSettings(); true");
    return client;
  }
  return { root, userData, settings, start, stop, logs: () => logs, close: async () => { await stop(); await removeFixture(root); } };
}

function seedOldHistory(desktop, id) {
  const db = new Database(path.join(desktop.userData, "data", "mini-lux.db"));
  try {
    db.prepare("UPDATE session_persona_bindings SET persona_digest = ? WHERE session_id = ?").run("0".repeat(64), id);
    const now = new Date().toISOString();
    const message = db.prepare("INSERT INTO messages(session_id, role, content, created_at) VALUES (?, 'user', ?, ?)").run(id, "旧资料问答", now);
    const bytes = Buffer.from("旧附件仍可读取");
    db.prepare("INSERT INTO attachments(id,session_id,message_id,state,kind,name,mime,size,sha256,content,error_code,created_at,updated_at) VALUES(?,?,?,'ready','text',?,'text/plain',?,?,?,NULL,?,?)")
      .run("att_" + "d".repeat(32), id, message.lastInsertRowid, "旧资料.txt", bytes.length, createHash("sha256").update(bytes).digest("hex"), bytes, Date.now(), Date.now());
  } finally { db.close(); }
}

test("D01 old definition exposes a recovery action instead of an unexplained file-root 400", { timeout: 120_000 }, async () => {
  const desktop = await fixtureDesktop();
  try {
    let client = await desktop.start();
    const id = await client.evaluate("currentSessionId");
    const roots = await client.evaluate("fetch('/api/files/roots',{headers:sessionHeaders()}).then(async r=>({status:r.status,...await r.json()}))");
    assert.equal(roots.status, 200);
    assert.equal(roots.roots.find(root => root.id === "department").available, false);
    await client.evaluate("toggleFileViewer(true)");
    await client.evaluate("workbenchSaveQueue");
    await desktop.stop();
    seedOldHistory(desktop, id);
    client = await desktop.start();
    const refused = await client.evaluate(`fetch('/api/files/roots',{headers:sessionHeaders('${id}')}).then(async r=>({status:r.status,...await r.json()}))`);
    assert.equal(refused.status, 409, JSON.stringify(refused));
    assert.equal(refused.code, "SESSION_PERSONA_CHANGED");
    await waitFor(() => client.evaluate("Boolean(document.querySelector('[data-action=return-file-session]'))"), { timeoutMs: 5_000, label: "D01 old file recovery" });
    await client.evaluate("document.querySelector('[data-action=return-file-session]').click()");
    await waitFor(() => client.evaluate("messagesEl.textContent.includes('旧资料问答') && Boolean(document.querySelector('[data-action=continue-updated-session]'))"), { timeoutMs: 10_000, label: "D01 original history" });
    assert.match(await client.evaluate(`fetch('/api/sessions/${id}/attachments/att_${"d".repeat(32)}/content',{headers:sessionHeaders('${id}')}).then(r=>r.text())`), /旧附件仍可读取/u);
    assert.doesNotMatch(desktop.logs(), /"failure":"unexpected-exit"|EPIPE|ERR_DLOPEN_FAILED/u);
  } finally { await desktop.close(); }
});

test("D01 clean and old-data startup matrix keeps local work usable without the department drive", { timeout: 800_000 }, async () => {
  const repetitions = Number(process.env.RAINYDAYS_D01_STARTUP_RUNS || 1);
  assert(Number.isSafeInteger(repetitions) && repetitions >= 1 && repetitions <= 10);
  for (const variant of ["clean", "old"]) {
    const desktop = await fixtureDesktop();
    let originalId;
    try {
      if (variant === "old") {
        const client = await desktop.start();
        originalId = await client.evaluate("currentSessionId");
        await desktop.stop();
        seedOldHistory(desktop, originalId);
      }
      for (let run = 1; run <= repetitions; run++) {
        const started = Date.now();
        const client = await desktop.start();
        if (variant === "old") {
          await waitFor(() => client.evaluate("messagesEl.textContent.includes('旧资料问答') && Boolean(document.querySelector('[data-action=continue-updated-session]'))"),
            { timeoutMs: 8_000, label: "D01 old history and recovery" });
          assert.equal(await client.evaluate("currentSessionId"), originalId);
          assert.equal(await client.evaluate(`fetch('/api/sessions/${originalId}/attachments/att_${"d".repeat(32)}/content',{headers:sessionHeaders('${originalId}')}).then(r=>r.text())`), "旧附件仍可读取");
        } else {
          await client.evaluate("toggleFileViewer(true)");
          await waitFor(() => client.evaluate("fileEntries.some(entry=>entry.name==='旧目录')"), { timeoutMs: 8_000, label: "D01 local files" });
          assert.equal(await client.evaluate("fileRoots.find(root=>root.id==='department').available"), false);
        }
        assert.doesNotMatch(desktop.logs(), /"failure":"unexpected-exit"|EPIPE|ERR_DLOPEN_FAILED|NODE_MODULE_VERSION/u);
        console.log(`[D01] ${variant} startup ${run}/${repetitions}: ready, local/history checked, ${Date.now() - started}ms`);
        await desktop.stop();
      }
    } finally { await desktop.close(); }
  }
});

test("D01 moved workspace restores the file tab at an available root and can change directories", { timeout: 120_000 }, async () => {
  const desktop = await fixtureDesktop();
  try {
    let client = await desktop.start();
    await client.evaluate("toggleFileViewer(true)");
    await client.evaluate("openFileDirectory('旧目录',false)");
    await client.evaluate("workbenchSaveQueue");
    // Save the displayed subdirectory through the public layout API, as an old installation would.
    await client.evaluate("(() => { const tab=activeWorkbenchTab(); tab.path='旧目录'; return persistWorkbenchLayout(); })()");
    await desktop.stop();
    await rename(desktop.settings.workspaceRoot, `${desktop.settings.workspaceRoot}-moved`);
    client = await desktop.start();
    await waitFor(() => client.evaluate("currentFileRoot==='output' && currentFilePath==='' && document.getElementById('file-list-count').textContent==='0/0 项'"),
      { timeoutMs: 8_000, label: "D01 usable directory fallback" });
    assert.equal(await client.evaluate("document.querySelector('#file-root-select option[value=workspace]').disabled"), true);
    const settings = await client.evaluate("fetch('/api/settings').then(r=>r.json())");
    const changed = await client.evaluate(`fetch('/api/settings/general',{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({workspaceRoot:${JSON.stringify(`${desktop.settings.workspaceRoot}-moved`)},expectedRevision:${JSON.stringify(settings.revision)}})}).then(async r=>({status:r.status,...await r.json()}))`);
    assert.equal(changed.status, 200, JSON.stringify(changed));
    await client.evaluate("refreshFileDirectory()");
    assert.equal(await client.evaluate("fileRoots.find(root=>root.id==='workspace').available"), true);
    assert.doesNotMatch(desktop.logs(), /"failure":"unexpected-exit"|EPIPE/u);
  } finally { await desktop.close(); }
});

test("D05 real Electron saves local scope, keeps company source optional and recovers deleted output", { timeout: 150_000 }, async () => {
  const desktop = await fixtureDesktop();
  try {
    let client = await desktop.start();
    await waitFor(() => client.evaluate("activeSettingsDomain==='profiles' && document.getElementById('settings-modal').classList.contains('visible') && document.getElementById('provider-model').value==='fixture-model'"), { timeoutMs: 8000, label: "D05 first-use settings ready" });
    await client.evaluate(`(() => { const original=fetch; window.__d05SettingsReplies=[]; window.fetch=async(...args)=>{const response=await original(...args); if(String(args[0]).endsWith('/api/settings/general')) {const body=await response.clone().json(); window.__d05SettingsReplies.push({status:response.status,error:body.error});} return response;}; return true; })()`);
    await client.evaluate("openSettings().then(()=>true)");
    await client.evaluate("switchSettingsDomain('common'); true");
    await waitFor(() => client.evaluate("Boolean(settingsState?.revision)"), { timeoutMs: 8000, label: "D05 settings" });
    assert.equal(await client.evaluate("document.getElementById('setting-department-enabled').checked"), false);
    assert.equal(await client.evaluate("document.getElementById('setting-department-root').value"), desktop.settings.departmentDataRoot);
    const nextWorkspace = path.join(desktop.root, "新的 中文资料");
    const nextOutput = path.join(desktop.root, "新的 中文成果");
    const department = path.join(desktop.root, "可选 只读部门");
    await Promise.all([nextWorkspace, nextOutput, department].map(dir => mkdir(dir)));
    await writeFile(path.join(nextWorkspace, "本地.txt"), "D05本地资料42");
    await writeFile(path.join(department, "原资料.txt"), "部门原文");
    await client.evaluate(`(() => {
      document.getElementById('setting-workspace-root').value=${JSON.stringify(nextWorkspace)};
      document.getElementById('setting-output-dir').value=${JSON.stringify(nextOutput)};
      document.getElementById('setting-output-dir').dispatchEvent(new Event('input',{bubbles:true}));
      document.querySelector('[data-action=save-general-settings]').click(); return true;
    })()`);
    try {
      await waitFor(() => client.evaluate(`settingsState.settings.outputDir===${JSON.stringify(nextOutput)} && document.getElementById('composer-scope').title.includes(${JSON.stringify(nextWorkspace)})`), { timeoutMs: 12000, label: "D05 saved local scope" });
    } catch (error) {
      const state = await client.evaluate("({settings:settingsState.settings,scope:document.getElementById('composer-scope').title,message:document.getElementById('settings-message').textContent,roots:fileRoots})").catch(reason=>({error:reason.message}));
      throw new Error(`${error.message}\n${JSON.stringify(state)}\n${desktop.logs()}`, {cause:error});
    }
    assert.equal(await readFile(path.join(desktop.settings.workspaceRoot, "旧目录", "说明.txt"), "utf8"), "隔离测试文件");
    const preview = await client.evaluate("fetch('/api/files/preview?root=workspace&path='+encodeURIComponent('本地.txt'),{headers:sessionHeaders()}).then(async r=>({status:r.status,...await r.json()}))");
    assert.equal(preview.status, 200, JSON.stringify(preview));
    assert.match(JSON.stringify(preview), /D05本地资料42/);
    await client.evaluate(`(() => { document.getElementById('setting-department-root').value=${JSON.stringify(department)}; document.getElementById('setting-department-enabled').checked=true; document.querySelector('[data-action=save-general-settings]').click(); return true; })()`);
    try { await waitFor(() => client.evaluate("fileRoots.some(root=>root.id==='department' && root.available)"), { timeoutMs: 12000, label: "D05 company source explicitly enabled" }); }
    catch(error) { throw new Error(`${error.message}\n${JSON.stringify(await client.evaluate("({replies:window.__d05SettingsReplies,settings:settingsState.settings,roots:fileRoots,message:document.getElementById('settings-message').textContent})"))}\n${desktop.logs()}`,{cause:error}); }
    // Direct editor cannot gain write access to the read-only department root.
    const denied = await client.evaluate("fetch('/api/files/content',{method:'PUT',headers:{...sessionHeaders(),'Content-Type':'application/json'},body:JSON.stringify({root:'department',path:'原资料.txt',expectedRevision:'fixture',encoding:'utf-8',text:'不应覆盖'})}).then(async r=>({status:r.status,...await r.json()}))");
    assert.equal(denied.status, 400, JSON.stringify(denied));
    assert.equal(await readFile(path.join(department, "原资料.txt"), "utf8"), "部门原文");
    await client.evaluate("document.getElementById('setting-department-enabled').checked=false; document.querySelector('[data-action=save-general-settings]').click(); true");
    await waitFor(() => client.evaluate("settingsState.settings.departmentEnabled===false && fileRoots.some(root=>root.id==='department' && !root.available)"), { timeoutMs: 12000, label: "D05 disabled source" });
    await desktop.stop();
    await rename(nextOutput, `${nextOutput}-moved`);
    client = await desktop.start();
    await waitFor(() => client.evaluate("activeSettingsDomain==='profiles' && document.getElementById('settings-modal').classList.contains('visible') && document.getElementById('provider-model').value==='fixture-model'"), { timeoutMs: 8000, label: "D05 restarted settings ready" });
    await client.evaluate("openSettings().then(()=>true)");
    await waitFor(() => client.evaluate("Boolean(settingsState?.revision)"), { timeoutMs: 8000, label: "D05 settings after restart" });
    assert.equal(await client.evaluate("document.getElementById('setting-output-dir').value"), nextOutput);
    assert.equal(await client.evaluate("document.getElementById('setting-department-root').value"), department);
    assert.equal(await client.evaluate("document.getElementById('setting-department-enabled').checked"), false);
    await client.evaluate("ensureFileRoots(true).then(()=>true)");
    assert.equal(await client.evaluate("fileRoots.find(root=>root.id==='output').available"), false);
    await client.evaluate(`document.getElementById('setting-output-dir').value=${JSON.stringify(`${nextOutput}-moved`)}; document.querySelector('[data-action=save-general-settings]').click(); true`);
    await waitFor(() => client.evaluate("fileRoots.some(root=>root.id==='output' && root.available)"), { timeoutMs: 12000, label: "D05 reselected deleted output" });
    assert.doesNotMatch(desktop.logs(), /"failure":"unexpected-exit"|EPIPE/);
  } finally { await desktop.close(); }
});

test("D05 real Electron stays usable with an unavailable network source and a read-only local directory", { timeout: 120_000, skip: process.platform !== "win32" }, async () => {
  const desktop = await fixtureDesktop({ departmentEnabled: true, departmentDataRoot: "\\\\127.0.0.1\\rainydays-d05-absent-share" });
  const directory = path.resolve(desktop.settings.workspaceRoot, "只读 目录");
  assert(directory.startsWith(path.resolve(desktop.root) + path.sep));
  const icacls = path.join(process.env.SystemRoot, "System32", "icacls.exe");
  const whoami = path.join(process.env.SystemRoot, "System32", "whoami.exe");
  const sid = execFileSync(whoami, ["/user", "/fo", "csv", "/nh"], { windowsHide: true, encoding: "utf8" }).match(/S-1-[\d-]+/)[0];
  let denied = false;
  try {
    await mkdir(directory);
    await writeFile(path.join(directory, "说明.txt"), "只读目录中的原文");
    execFileSync(icacls, [directory, "/deny", `*${sid}:(OI)(CI)(WD,AD)`], { windowsHide: true, stdio: "pipe" }); denied = true;
    const started = Date.now();
    const client = await desktop.start();
    console.log(`[D05] unavailable loopback SMB source: workbench ready in ${Date.now()-started}ms`);
    await client.evaluate("toggleFileViewer(true).then(()=>true)");
    assert.equal(await client.evaluate("fileRoots.find(root=>root.id==='department').available"), false);
    assert.equal(await client.evaluate("fileRoots.find(root=>root.id==='workspace').available && fileRoots.find(root=>root.id==='output').available"), true);
    await client.evaluate(`previewFile('只读 目录/说明.txt',1,${JSON.stringify(path.join(directory, "说明.txt"))},'workspace').then(()=>true)`);
    assert.match(await client.evaluate("document.getElementById('file-preview-content').textContent"), /只读目录中的原文/);
    await client.evaluate("(() => { editSelectedFile(); const editor=document.querySelector('.file-editor'); editor.value='不能覆盖'; editor.dispatchEvent(new Event('input',{bubbles:true})); return true; })()");
    await client.evaluate("saveSelectedFile().then(()=>true)");
    assert.match(await client.evaluate("document.getElementById('file-preview-meta').textContent"), /保存失败.*检查读写权限/);
    assert.equal(await readFile(path.join(directory, "说明.txt"), "utf8"), "只读目录中的原文");
  } finally {
    if (denied) execFileSync(icacls, [directory, "/remove:d", `*${sid}`], { windowsHide: true, stdio: "pipe" });
    await desktop.close();
  }
});
