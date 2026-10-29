import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import Database from "better-sqlite3";
import {
  boundedFetch, connectCdp, freeDistinctPorts, makeTempDir, projectRoot,
  removeFixture, spawnManaged, terminateProcessTreeAsync, waitFor, waitForChildExit,
} from "../helpers.mjs";

async function fixtureDesktop(options = {}, profile = {}) {
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
    default: { model: "fixture-model", apiKey: "", baseURL: "https://provider.invalid/v1", providerType: "openai-compatible", ...profile },
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
    const env = { ...process.env, npm_node_execpath: process.execPath, PORT: String(httpPort), ...(String(profile.baseURL || "").startsWith("http://127.0.0.1:") ? { RAINYDAYS_ALLOW_LOOPBACK_HTTP_PROVIDER: "1" } : {}) };
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

test("D03 real Electron retrieves early facts through Agent read after 20 rounds and process restart", { timeout: 180_000 }, async () => {
  let streams = 0, summaries = 0, retrievedId, failure = null, desktop;
  const server = createServer(async (request, response) => {
    try {
      const chunks=[]; for await (const chunk of request) chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks).toString());
      if (!body.stream) {
        const summary=body.messages[0]?.content.includes('对话摘要器'); if(summary) summaries++;
        response.setHeader('Content-Type','application/json');
        response.end(JSON.stringify({choices:[{message:{role:'assistant',content:summary?'已收起早期资料；具体事实请取回原文核对。':'长对话核对'},finish_reason:'stop'}]})); return;
      }
      streams++;
      let calls, content;
      if(streams<=20) content=`ROUND_${streams} ${streams===1?'唯一早期事实EARLY_F57。':''}${'日常资料x'.repeat(500)}`;
      else if(streams===21) {
        assert.equal(JSON.stringify(body.messages).includes('EARLY_F57'),false,'early fact must be retrieved from original history');
        const match=/来源范围history:(\d+)/u.exec(JSON.stringify(body.messages)); assert(match,'compacted context must expose its original history reference'); retrievedId=Number(match[1]);
        calls=[{index:0,id:'recover-original',type:'function',function:{name:'read',arguments:JSON.stringify({file_path:`history:${retrievedId}`,offset:1,limit:12})}}];
      } else {
        assert.equal(streams,22);
        assert.match(JSON.stringify(body.messages.filter(message=>message.role==='tool').at(-1)),/EARLY_F57/);
        content=`找回早期事实EARLY_F57，依据history:${retrievedId}原文。`;
      }
      response.writeHead(200,{'Content-Type':'text/event-stream'});
      response.write(`data: ${JSON.stringify({choices:[{delta:calls?{tool_calls:calls}:{content},finish_reason:null}]})}\n\n`);
      response.end(`data: ${JSON.stringify({choices:[{delta:{},finish_reason:calls?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);
    } catch(error) { failure=error; response.statusCode=500; response.end(String(error)); }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    desktop=await fixtureDesktop({}, {apiKey:'fixture-only',baseURL:`http://127.0.0.1:${server.address().port}/v1`,contextWindowTokens:16384,outputReserveTokens:1024});
    let client=await desktop.start();
    const session=await client.evaluate('currentSessionId');
    const send=async text=>client.evaluate(`(() => { inputEl.value=${JSON.stringify(text)}; inputEl.dispatchEvent(new Event('input')); document.getElementById('input-form').requestSubmit(); return true; })()`);
    for(let index=1;index<=20;index++) {
      await send(`第${index}轮：只整理本轮资料，不要覆盖原文件。`);
      await waitFor(()=>client.evaluate(`!isSessionRunning() && [...document.querySelectorAll('#messages .msg-assistant .bubble')].at(-1)?.textContent.includes('ROUND_${index} ')`),{timeoutMs:15000,label:`D03 round ${index}`});
    }
    assert.equal(streams,20); assert.equal(failure,null);
    await desktop.stop(); client=await desktop.start();
    assert.equal(await client.evaluate('currentSessionId'),session);
    await send('请找回最早那项事实，必须取回原文核对，不要覆盖原文件。');
    await waitFor(()=>client.evaluate("!isSessionRunning() && [...document.querySelectorAll('#messages .msg-assistant .bubble')].at(-1)?.textContent.includes('找回早期事实EARLY_F57')"),{timeoutMs:30000,label:'D03 restored Agent history read'});
    assert.equal(failure,null); assert.equal(streams,22); assert(summaries>0);
    const messages=await client.evaluate(`fetch('/api/sessions/${session}/messages',{headers:sessionHeaders()}).then(r=>r.json())`);
    assert.match(JSON.stringify(messages),/唯一早期事实EARLY_F57/);
    assert.match(await client.evaluate('messagesEl.textContent'),/history:/);
    console.log(`[D03] 20 rounds, ${summaries} bounded summaries, process restart and real Agent read(history:${retrievedId}) passed`);
  } catch(error) { throw new Error(`${error.message}\nstreams=${streams}, summaries=${summaries}, model=${failure?.message||'ok'}\n${desktop?.logs()||''}`,{cause:error}); }
  finally { if(desktop) await desktop.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});

test("A04 real Electron default assistant edits, runs real tests and displays remaining dependency failure", { timeout: 120_000 }, async () => {
  let desktop, stage = 0, failure = null, revision;
  const server = createServer(async (request, response) => {
    try {
      const bytes = []; for await (const part of request) bytes.push(part);
      const body = JSON.parse(Buffer.concat(bytes).toString());
      if (!body.stream) { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "代码验证" }, finish_reason: "stop" }] })); return; }
      const root = desktop.settings.workspaceRoot, target = path.join(root, "sum.mjs");
      const last = body.messages.at(-1), outcome = last.role === "tool" ? JSON.parse(last.content) : null;
      let call;
      switch (++stage) {
        case 1: call = { name: "read_repo", arguments: JSON.stringify({ path: root, level: "summary" }) }; break;
        case 2: assert.match(outcome.content, /untracked/u); call = { name: "read", arguments: JSON.stringify({ file_path: target }) }; break;
        case 3:
          revision = /版本: ([a-f0-9]{64})/u.exec(outcome.content)?.[1]; assert(revision);
          call = { name: "execute_command", arguments: JSON.stringify({ command: "node --test", cwd: root }) }; break;
        case 4:
          assert.equal(outcome.status, "error"); assert.match(outcome.content, /退出码 1/u);
          call = { name: "edit_files", arguments: JSON.stringify({ files: [{ file_path: target, expected_revision: revision, edits: [{ old_string: "a - b", new_string: "a + b" }] }] }) }; break;
        case 5:
          assert.equal(outcome.status, "success"); assert.match(JSON.parse(outcome.content).changes[0].diff, /\+a \+ b/u);
          call = { name: "execute_command", arguments: JSON.stringify({ command: "node --test", cwd: root }) }; break;
        case 6:
          assert.equal(outcome.status, "success"); assert.match(outcome.content, /退出码 0/u); assert.match(outcome.content, /pass 1/u);
          call = { name: "execute_command", arguments: JSON.stringify({ command: "rainydays_a04_missing_cli_1d72 --version", cwd: root }) }; break;
        default: assert.equal(stage, 7); assert.equal(outcome.status, "error"); assert.match(outcome.content, /命令未找到/u);
      }
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.end(`data: ${JSON.stringify({ choices: [{ delta: call ? { tool_calls: [{ index: 0, id: `coding-${stage}`, type: "function", function: call }] } : { content: "node --test 实际退出0。缺依赖检查仍失败，未安装软件；差异见代码修改记录。" }, finish_reason: call ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) { failure = error; response.statusCode = 500; response.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    desktop = await fixtureDesktop({}, { apiKey: "fixture-only", baseURL: `http://127.0.0.1:${server.address().port}/v1` });
    const root = desktop.settings.workspaceRoot;
    await writeFile(path.join(root, "sum.mjs"), "export const sum = (a, b) => a - b;\n");
    await writeFile(path.join(root, "sum.test.mjs"), "import test from 'node:test'; import assert from 'node:assert/strict'; import {sum} from './sum.mjs'; test('sum',()=>assert.equal(sum(2,3),5));\n");
    const git = execFileSync(path.join(process.env.SystemRoot, "System32/where.exe"), ["git.exe"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/u).find(Boolean);
    execFileSync(git, ["init", "-q"], { cwd: root, windowsHide: true }); execFileSync(git, ["add", "--", "."], { cwd: root, windowsHide: true });
    await writeFile(path.join(root, "sum.mjs"), "export const sum = (a, b) => a - b;\n// USER_DIRTY_KEEP\n");
    await writeFile(path.join(root, "user-note.txt"), "USER_UNTRACKED_KEEP\n");
    const client = await desktop.start();
    assert.equal(await client.evaluate(`(async () => { const settings = await fetch('/api/settings').then(r => r.json()); return fetch('/api/settings/domains/shell', {method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({expectedRevision:settings.revision,value:{...settings.domains.shell,developerMode:true}})}).then(r => r.status); })()`), 200);
    await client.evaluate("inputEl.value='修复项目，运行测试并区分缺依赖失败，保留我的改动。';document.getElementById('input-form').requestSubmit()");
    for (const answer of ["本次任务允许运行命令", "确认执行"]) {
      await waitFor(() => client.evaluate(`document.getElementById('ask-modal').classList.contains('visible') && [...document.querySelectorAll('#ask-options button')].some(button => button.textContent === ${JSON.stringify(answer)})`), { timeoutMs: 20000, label: `A04 ${answer}` });
      await client.evaluate(`[...document.querySelectorAll('#ask-options button')].find(button => button.textContent === ${JSON.stringify(answer)}).click()`);
    }
    await waitFor(() => client.evaluate("!isSessionRunning() && messagesEl.textContent.includes('缺依赖检查仍失败')"), { timeoutMs: 30000, label: "A04 coding task complete" });
    assert.equal(failure, null); assert.equal(stage, 7);
    assert.match(await readFile(path.join(root, "sum.mjs"), "utf8"), /a \+ b;\n\/\/ USER_DIRTY_KEEP/u);
    assert.equal(await readFile(path.join(root, "user-note.txt"), "utf8"), "USER_UNTRACKED_KEEP\n");
    assert.equal(await client.evaluate("Boolean(document.querySelector('.code-changes'))"), true);
    assert.match(await client.evaluate("document.querySelector('.code-changes').textContent"), /a \+ b/u);
  } catch (error) { throw new Error(`${error.message}\nstage=${stage}, model=${failure?.message || 'ok'}\n${desktop?.logs() || ''}`, { cause: error }); }
  finally { if (desktop) await desktop.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test("A02 real Electron default conversation discovers project context including existing and untracked work", { timeout: 120_000 }, async () => {
  let desktop, streams=0, failure=null;
  const server=createServer(async (request,response)=>{
    try {
      const chunks=[]; for await(const chunk of request) chunks.push(chunk);
      const body=JSON.parse(Buffer.concat(chunks).toString());
      if(!body.stream) { response.setHeader('Content-Type','application/json'); response.end(JSON.stringify({choices:[{message:{role:'assistant',content:'项目资料'},finish_reason:'stop'}]})); return; }
      let call,content='已识别脚本 node --test、用户改动与未跟踪资料，未修改项目。';
      const step=++streams;
      if(step===1) call={name:'search_tools',arguments:JSON.stringify({keywords:'read_repo 项目仓库'})};
      else if(step===2) {
        assert(body.tools.some(tool=>tool.function.name==='read_repo'));
        call={name:'read_repo',arguments:JSON.stringify({path:desktop.settings.workspaceRoot,level:'summary'})};
      } else if(step===3) {
        const result=JSON.stringify(body.messages.filter(message=>message.role==='tool').at(-1));
        assert.match(result,/node --test/); assert.match(result,/untracked/);
        call={name:'read_repo',arguments:JSON.stringify({path:desktop.settings.workspaceRoot,level:'all',include:'*.ts'})};
      } else { assert.equal(step,4); const result=JSON.stringify(body.messages.at(-1)); assert.match(result,/USER_NEW/); assert.match(result,/用户改动/); }
      response.writeHead(200,{'Content-Type':'text/event-stream'});
      response.end(`data: ${JSON.stringify({choices:[{delta:call?{tool_calls:[{index:0,id:`project-${step}`,type:'function',function:call}]}:{content},finish_reason:call?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);
    } catch(error) { failure=error; response.statusCode=500; response.end(String(error)); }
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    desktop=await fixtureDesktop({}, {apiKey:'fixture-only',baseURL:`http://127.0.0.1:${server.address().port}/v1`});
    const root=desktop.settings.workspaceRoot;
    const git=process.platform==='win32'?execFileSync(path.join(process.env.SystemRoot,'System32','where.exe'),['git.exe'],{encoding:'utf8',windowsHide:true}).split(/\r?\n/u).find(Boolean):'/usr/bin/git';
    await writeFile(path.join(root,'package.json'),JSON.stringify({scripts:{test:'node --test'}}));
    await writeFile(path.join(root,'原始 文件.ts'),'export const value = 1;\n');
    execFileSync(git,['init','--quiet'],{cwd:root,windowsHide:true}); execFileSync(git,['add','--','.'],{cwd:root,windowsHide:true});
    await writeFile(path.join(root,'原始 文件.ts'),'export const value = 1;\n// 用户改动\n');
    await writeFile(path.join(root,'新资料.ts'),"export const note = 'USER_NEW';\n");
    const client=await desktop.start();
    await client.evaluate("(() => { inputEl.value='理解当前项目，给出脚本和已有改动，保留未跟踪文件，不要修改或提交。'; inputEl.dispatchEvent(new Event('input')); document.getElementById('input-form').requestSubmit(); return true; })()");
    await waitFor(()=>client.evaluate("!isSessionRunning() && messagesEl.textContent.includes('已识别脚本 node --test')"),{timeoutMs:30000,label:'A02 default project conversation'});
    assert.equal(failure,null); assert.equal(streams,4);
    assert.match(await readFile(path.join(root,'原始 文件.ts'),'utf8'),/用户改动/);
    assert.match(await readFile(path.join(root,'新资料.ts'),'utf8'),/USER_NEW/);
    assert.match(await client.evaluate('messagesEl.textContent'),/read_repo/);
  } catch(error) { throw new Error(`${error.message}\nstreams=${streams}, model=${failure?.message||'ok'}\n${desktop?.logs()||''}`,{cause:error}); }
  finally { if(desktop) await desktop.close(); server.closeAllConnections(); await new Promise(resolve=>server.close(resolve)); }
});

test("A02 real Electron edits multiple files, restores complete diffs and undoes from original receipts after restart", { timeout: 150_000 }, async () => {
  let desktop,streams=0,failure=null,changeId,targets,before;
  const server=createServer(async(request,response)=>{
    try {
      const chunks=[];for await(const chunk of request)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());
      if(!body.stream){response.setHeader('Content-Type','application/json');response.end(JSON.stringify({choices:[{message:{role:'assistant',content:'项目修改'},finish_reason:'stop'}]}));return;}
      const step=++streams;let calls,content;
      const call=(id,name,args,index=0)=>({index,id,type:'function',function:{name,arguments:JSON.stringify(args)}});
      if(step===1)calls=[call('find-edits','search_tools',{keywords:'edit_files undo_edits'})];
      else if(step===2)calls=targets.map((target,index)=>call(`read-${index}`,'read',{file_path:target},index));
      else if(step===3){
        const results=body.messages.filter(message=>message.role==='tool').slice(-2).map(message=>JSON.parse(message.content).content);
        const versions=results.map((result,index)=>{assert.match(result,/用户/);const value=/版本: ([a-f0-9]{64})/.exec(result)?.[1];assert.equal(value,createHash('sha256').update(before[index]).digest('hex'));return value;});
        calls=[call('edit-batch','edit_files',{files:targets.map((target,index)=>({file_path:target,expected_revision:versions[index],edits:index===0?[{old_string:'value = 1',new_string:'value = 2'},{old_string:'// 文件结束',new_string:'// '+ '完整差异'.repeat(120)+' DIFF_END_649'}]:[{old_string:'value = 1',new_string:'value = 2'}]}))})];
      }else if(step===4){const outcome=JSON.parse(body.messages.at(-1).content),receipt=JSON.parse(outcome.content);assert.equal(outcome.status,'success');assert.equal(receipt.changes.length,2);changeId=receipt.changeId;content='两个文件已修改，用户原有内容保留，请展开查看本次差异。';}
      else if(step===5){assert(JSON.stringify(body.messages.filter(message=>message.role==='user').at(-1)).includes(changeId));calls=[call('find-undo','search_tools',{keywords:'undo_edits'})];}
      else if(step===6)calls=[call('undo-batch','undo_edits',{change_id:changeId})];
      else{assert.equal(step,7);const outcome=JSON.parse(body.messages.at(-1).content),receipt=JSON.parse(outcome.content);assert.equal(outcome.status,'success');assert.equal(receipt.undoOf,changeId);content='已撤回这组修改，用户原始改动与未跟踪文件保留。';}
      response.writeHead(200,{'Content-Type':'text/event-stream'});response.end(`data: ${JSON.stringify({choices:[{delta:calls?{tool_calls:calls}:{content},finish_reason:calls?'tool_calls':'stop'}]})}\n\ndata: [DONE]\n\n`);
    }catch(error){failure=error;response.statusCode=500;response.end(String(error));}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    desktop=await fixtureDesktop({}, {apiKey:'fixture-only',baseURL:`http://127.0.0.1:${server.address().port}/v1`});
    const root=desktop.settings.workspaceRoot;targets=[path.join(root,'已有 改动.ts'),path.join(root,'未跟踪.py')];
    const git=process.platform==='win32'?execFileSync(path.join(process.env.SystemRoot,'System32','where.exe'),['git.exe'],{encoding:'utf8',windowsHide:true}).split(/\r?\n/u).find(Boolean):'/usr/bin/git';
    await writeFile(targets[0],'export const value = 1;\n// 文件结束\n');execFileSync(git,['init','--quiet'],{cwd:root,windowsHide:true});execFileSync(git,['add','--','.'],{cwd:root,windowsHide:true});
    before=['// 用户已有改动\nexport const value = 1;\n// 文件结束\n','# 用户未跟踪文件\nvalue = 1\n'];for(let index=0;index<2;index++)await writeFile(targets[index],before[index]);
    const gitBefore=execFileSync(git,['status','--porcelain=v1','-z','--untracked-files=all'],{cwd:root,windowsHide:true,encoding:'utf8'});
    let client=await desktop.start();const session=await client.evaluate('currentSessionId');
    await client.evaluate("(() => { inputEl.value='将项目中两个文件的value从1改为2，并补充说明，保留我已有的改动；展示差异，不要提交。'; inputEl.dispatchEvent(new Event('input')); document.getElementById('input-form').requestSubmit(); return true; })()");
    const approve=async()=>{await waitFor(()=>client.evaluate("[...document.querySelectorAll('#ask-options button')].some(button=>button.textContent==='确认执行')"),{timeoutMs:15000,label:'A02 one batch confirmation'});const question=await client.evaluate("document.getElementById('ask-question-text').textContent");assert(question.includes(targets[0])&&question.includes(targets[1]),question);await client.evaluate("[...document.querySelectorAll('#ask-options button')].find(button=>button.textContent==='确认执行').click()");};
    await approve();await waitFor(()=>client.evaluate("!isSessionRunning() && messagesEl.textContent.includes('两个文件已修改')"),{timeoutMs:15000,label:'A02 code edit completed'});
    assert.equal(failure,null);assert.equal(streams,4);assert.match(await readFile(targets[0],'utf8'),/用户已有改动/);assert.match(await client.evaluate("document.querySelector('.code-changes').textContent"),/DIFF_END_649/);
    await desktop.stop();client=await desktop.start();assert.equal(await client.evaluate('currentSessionId'),session);
    await waitFor(()=>client.evaluate("Boolean(document.querySelector('.code-changes [data-action=undo-code-change]:not(:disabled)'))"),{timeoutMs:10000,label:'A02 restored complete diff and undo'});
    assert.match(await client.evaluate("document.querySelector('.code-changes').textContent"),/DIFF_END_649/);
    await client.evaluate("document.querySelector('.code-changes [data-action=undo-code-change]').click()");await approve();
    await waitFor(()=>client.evaluate("!isSessionRunning() && messagesEl.textContent.includes('已撤回这组修改')"),{timeoutMs:15000,label:'A02 undo after process restart'});
    assert.equal(failure,null);assert.equal(streams,7);for(let index=0;index<2;index++)assert.equal(await readFile(targets[index],'utf8'),before[index]);
    assert.equal(execFileSync(git,['status','--porcelain=v1','-z','--untracked-files=all'],{cwd:root,windowsHide:true,encoding:'utf8'}),gitBefore);
  }catch(error){throw new Error(`${error.message}\nstreams=${streams}, model=${failure?.message||'ok'}\n${desktop?.logs()||''}`,{cause:error});}
  finally{if(desktop)await desktop.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
});

test("D03 real Electron saves per-model request limits and restores them after restart", { timeout: 120_000 }, async () => {
  const desktop = await fixtureDesktop();
  try {
    let client = await desktop.start();
    await waitFor(() => client.evaluate("activeSettingsDomain==='profiles' && document.getElementById('provider-context-window').value==='32768'"), { timeoutMs: 8000, label: "D03 budget form" });
    await client.evaluate("(() => { document.getElementById('provider-context-window').value='2048'; document.getElementById('provider-output-reserve').value='256'; document.getElementById('provider-output-reserve').dispatchEvent(new Event('input',{bubbles:true})); return saveProvider(); })()");
    assert.equal(await client.evaluate("settingsState.profiles.find(profile=>profile.name==='default').contextWindowTokens"), 2048);
    await desktop.stop(); client = await desktop.start();
    await waitFor(() => client.evaluate("activeSettingsDomain==='profiles' && document.getElementById('provider-context-window').value==='2048'"), { timeoutMs: 8000, label: "D03 restored budget form" });
    assert.equal(await client.evaluate("document.getElementById('provider-output-reserve').value"), "256");
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
