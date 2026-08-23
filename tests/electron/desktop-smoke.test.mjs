import assert from "node:assert/strict";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { emitSec03ProjectionReceipts } from "../sec03-projection-receipts.mjs";
import {
  boundedFetch,
  connectCdp,
  freeDistinctPorts,
  makeTempDir,
  observeWindowsFileHandleInProcessTree,
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

async function startElectron(userData, httpPort, cdpPort, signal) {
  // Keep all three runtime roots distinct and fixture-local. Inheriting the host default
  // department root (for example an unavailable network drive) makes this smoke nondeterministic.
  const workspaceRoot = path.join(userData, "workspace");
  const departmentDataRoot = path.join(userData, "department");
  const outputDir = path.join(userData, "output");
  await Promise.all([
    mkdir(workspaceRoot, { recursive: true }),
    mkdir(departmentDataRoot, { recursive: true }),
    mkdir(outputDir, { recursive: true }),
  ]);
  // Electron intentionally strips root env variables before spawning the daemon. Seed the
  // managed config instead so both launches use the same self-contained path identities.
  await writeFile(path.join(userData, "config.json"), JSON.stringify({
    defaultProfile: "default",
    profiles: {
      default: {
        model: "electron-smoke-model",
        apiKey: "",
        baseURL: "https://provider.invalid/v1",
        providerType: "openai-compatible",
      },
    },
    settings: {
      defaultPersona: "general",
      workspaceRoot,
      departmentDataRoot,
      outputDir,
    },
  }, null, 2));
  const child = spawnManaged(electronExecutable, [projectRoot, `--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`, "--disable-gpu"], {
    env: {
      ...process.env,
      PORT: String(httpPort),
      RAINYDAYS_E2E_USE_DIST: "1",
      RAINYDAYS_E2E_NODE_EXECUTABLE: process.execPath,
      RAINYDAYS_API_TOKEN: "sec04-forged-environment-token",
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
  const readinessSignal = AbortSignal.any([signal, AbortSignal.timeout(45_000)]);
  try {
    while (true) {
      if (readinessSignal.aborted) throw readinessSignal.reason ?? new Error("Electron startup deadline reached");
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`Electron exited ${child.exitCode ?? child.signalCode}: ${stdout}\n${stderr}`);
      try {
        const response = await boundedFetch(`http://127.0.0.1:${httpPort}/`, {
          signal: AbortSignal.any([readinessSignal, AbortSignal.timeout(2_000)]),
        });
        if (response.ok) break;
      } catch (error) {
        if (readinessSignal.aborted) throw readinessSignal.reason ?? error;
      }
      await delay(100, undefined, { signal: readinessSignal });
    }
  } catch (error) {
    const termination = await terminateProcessTreeAsync(child).catch(() => ({ attempted: true, exitCode: 1, childExited: false }));
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nElectron cleanup: ${JSON.stringify(termination)}\nElectron stdout:\n${stdout}\nElectron stderr:\n${stderr}`);
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
        preloadKeys: Object.keys(window.electronAPI || {}).sort(),
        capabilities: await window.electronAPI?.capabilities?.(),
        windowState: await window.electronAPI?.windowState?.(),
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
  assert.deepEqual(value.preloadKeys, [
    "appVersion", "buildId", "capabilities", "isElectron", "notify", "onNotificationClicked", "platform",
    "selectDirectory", "selectFile", "selectSavePath", "terminalClear", "terminalClose", "terminalInput",
    "terminalKill", "terminalStart", "windowAction", "windowState",
  ]);
  assert.equal("invoke" in value.preload, false);
  assert.deepEqual(value.capabilities, {
    platform: process.platform,
    dialogs: true,
    notifications: true,
    windowControls: true,
    updates: false,
  });
  assert.equal(typeof value.windowState?.bounds?.width, "number");
  assert.equal(typeof value.windowState?.bounds?.height, "number");
  assert.deepEqual(value.version, buildInfo);
  assert.deepEqual(value.status.version, buildInfo);
  assert.equal((await boundedFetch(`http://127.0.0.1:${httpPort}/api/version`)).status, 401);
  assert.equal((await boundedFetch(`http://127.0.0.1:${httpPort}/api/version`, {
    headers: { "X-RainyDays-Token": "sec04-forged-environment-token" },
  })).status, 401, "ambient environment fixed the Electron control-plane token");
  return value;
}

async function assertRendererHardening(client, httpPort) {
  const canonicalUrl = `http://127.0.0.1:${httpPort}/`;
  const probe = await client.evaluate(`(async()=>{
    const response=await fetch('/');
    const csp=response.headers.get('content-security-policy')||'';
    window.__sec07InlineScript=false;
    const script=document.createElement('script');
    script.textContent='window.__sec07InlineScript=true';
    document.body.appendChild(script);
    const button=document.createElement('button');
    button.setAttribute('onclick','window.__sec07InlineHandler=true');
    window.__sec07InlineHandler=false;
    document.body.appendChild(button);
    button.click();
    const styled=document.createElement('div');
    styled.setAttribute('style','position:fixed');
    document.body.appendChild(styled);
    const popup=window.open('https://example.invalid/sec07','_blank');
    window.__sec07MarkdownXss=false;
    const markdownHost=document.createElement('div');
    markdownHost.innerHTML=renderMarkdown('<img src="javascript:alert(1)" onerror="window.__sec07MarkdownXss=true"><a href="java&#x09;script:alert(1)" onclick="window.__sec07MarkdownXss=true">x</a><svg onload="window.__sec07MarkdownXss=true"><circle></circle></svg><math><mtext>x</mtext></math><iframe srcdoc="<script>window.__sec07MarkdownXss=true</script>"></iframe><script>window.__sec07MarkdownXss=true</script>');
    document.body.appendChild(markdownHost);
    let permission='unavailable';
    try{permission=(await navigator.permissions.query({name:'geolocation'})).state}catch(error){permission=String(error)}
    await new Promise(resolve=>setTimeout(resolve,50));
    const unsafeUrl=Array.from(markdownHost.querySelectorAll('[href],[src]')).some(element=>/^(?:javascript|data):/iu.test((element.getAttribute('href')||element.getAttribute('src')||'').replace(/[\u0000-\u0020\u007f-\u009f]/gu,'')));
    const eventAttribute=Array.from(markdownHost.querySelectorAll('*')).some(element=>Array.from(element.attributes).some(attribute=>attribute.name.toLowerCase().startsWith('on')));
    const result={
      url:location.href,
      csp,
      requireType:typeof window.require,
      processType:typeof window.process,
      moduleType:typeof window.module,
      inlineScript:window.__sec07InlineScript,
      inlineHandler:window.__sec07InlineHandler,
      inlineStyle:getComputedStyle(styled).position,
      popupIsNull:popup===null,
      permission,
      markdownXss:window.__sec07MarkdownXss,
      markdownDangerousNodes:markdownHost.querySelectorAll('script,style,iframe,object,embed,svg,math,form,input,button').length,
      markdownEventAttribute:eventAttribute,
      markdownUnsafeUrl:unsafeUrl,
    };
    script.remove();button.remove();styled.remove();markdownHost.remove();
    delete window.__sec07InlineScript;delete window.__sec07InlineHandler;delete window.__sec07MarkdownXss;
    return result;
  })()`);
  assert.equal(probe.url, canonicalUrl);
  assert.equal(probe.requireType, "undefined");
  assert.equal(probe.processType, "undefined");
  assert.equal(probe.moduleType, "undefined");
  assert.equal(probe.inlineScript, false);
  assert.equal(probe.inlineHandler, false);
  assert.notEqual(probe.inlineStyle, "fixed");
  assert.equal(probe.popupIsNull, true);
  assert.equal(probe.permission, "denied");
  assert.equal(probe.markdownXss, false);
  assert.equal(probe.markdownDangerousNodes, 0);
  assert.equal(probe.markdownEventAttribute, false);
  assert.equal(probe.markdownUnsafeUrl, false);
  assert.doesNotMatch(probe.csp, /unsafe-inline|unsafe-eval/u);
  assert.match(probe.csp, /script-src 'self'/u);
  assert.match(probe.csp, /style-src 'self'/u);
  assert.match(probe.csp, /frame-ancestors 'none'/u);
  await client.evaluate(`location.assign(${JSON.stringify(`http://127.0.0.1:${httpPort}/api/status`)});true`);
  await delay(100);
  assert.equal(await client.evaluate("location.href"), canonicalUrl);
  await client.evaluate("location.assign('https://example.invalid/sec07');true");
  await delay(100);
  assert.equal(await client.evaluate("location.href"), canonicalUrl);
}

async function selectRendererSession(client, sessionId) {
  const selector = `.session-item[data-session-id="${sessionId}"]`;
  const alreadyActive = await client.evaluate(`document.querySelector('.session-item.active')?.dataset.sessionId === ${JSON.stringify(sessionId)}`);
  if (alreadyActive) return;
  const clicked = await client.evaluate(`(()=>{const target=document.querySelector(${JSON.stringify(selector)});if(!target)return false;target.click();return true})()`);
  assert.equal(clicked, true, `renderer Session button is missing: ${sessionId}`);
  try {
    await waitFor(async () => {
      try { return await client.evaluate(`document.querySelector('.session-item.active')?.dataset.sessionId === ${JSON.stringify(sessionId)}`); }
      catch { return false; }
    }, { timeoutMs: 10_000, label: `renderer session ${sessionId}` });
  } catch (error) {
    const diagnostic = await client.evaluate(`(async()=>({
      requested:${JSON.stringify(sessionId)},
      active:document.querySelector('.session-item.active')?.dataset.sessionId||null,
      listed:Array.from(document.querySelectorAll('.session-item')).map(item=>item.dataset.sessionId),
      system:Array.from(document.querySelectorAll('.msg-system,.msg-assistant')).slice(-3).map(item=>item.textContent),
      server:await fetch('/api/sessions').then(response=>response.json()).catch(error=>({error:String(error)}))
    }))()`).catch(diagnosticError => ({ diagnosticError: String(diagnosticError) }));
    throw new Error(`${error instanceof Error ? error.message : String(error)}; diagnostic=${JSON.stringify(diagnostic)}`);
  }
}

async function assertRendererSessionIsolation(client, restoreSessionId) {
  const sessions = await client.evaluate(`(async()=>{
    const create=title=>fetch('/api/sessions',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title})}).then(response=>response.json());
    const a=await create('RT-01 renderer A');
    const b=await create('RT-01 renderer B');
    return {a:a.session.id,b:b.session.id};
  })()`);
  await client.evaluate("location.reload(); true");
  await waitFor(async () => {
    try { return await client.evaluate(`document.querySelectorAll('.session-item').length >= 3`); }
    catch { return false; }
  }, { timeoutMs: 20_000, label: "RT-01 renderer reload" });

  await client.evaluate(`(()=>{
    const originalFetch=window.fetch.bind(window);
    const encoder=new TextEncoder();
    const state={originalFetch,encoder,chats:[],answers:[],cancels:[],controllers:Object.create(null)};
    window.__rt01RendererProbe=state;
    window.fetch=async(input,options={})=>{
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      if(url.pathname==='/api/chat'){
        const body=JSON.parse(options.body);
        state.chats.push(body);
        return new Response(new ReadableStream({start(controller){
          state.controllers[body.sessionId]=controller;
          options.signal?.addEventListener('abort',()=>controller.error(new DOMException('renderer run aborted','AbortError')),{once:true});
        }}),{status:200,headers:{'Content-Type':'text/event-stream'}});
      }
      if(url.pathname==='/api/chat/cancel'){
        state.cancels.push(JSON.parse(options.body));
        return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}});
      }
      if(url.pathname==='/api/ask-user/answer'){
        state.answers.push(JSON.parse(options.body));
        return new Response('{}',{status:200,headers:{'Content-Type':'application/json'}});
      }
      return originalFetch(input,options);
    };
  })();true`);

  const submit = async (sessionId, text) => {
    await selectRendererSession(client, sessionId);
    const before = await client.evaluate("window.__rt01RendererProbe.chats.length");
    await client.evaluate(`(()=>{const input=document.getElementById('input');input.value=${JSON.stringify(text)};input.dispatchEvent(new Event('input',{bubbles:true}));document.getElementById('input-form').requestSubmit();return true})()`);
    await waitFor(async () => {
      try { return await client.evaluate(`window.__rt01RendererProbe.chats.length === ${before + 1}`); }
      catch { return false; }
    }, { timeoutMs: 10_000, label: `RT-01 chat ${sessionId}` });
  };

  await submit(sessions.a, "run A");
  await selectRendererSession(client, sessions.b);
  assert.equal(await client.evaluate("document.getElementById('submit').disabled"), false, "A run must not disable B controls");
  await submit(sessions.b, "run B");
  assert.equal(await client.evaluate("document.getElementById('submit').disabled"), true);

  await client.evaluate(`(()=>{
    const state=window.__rt01RendererProbe;
    const emit=value=>state.controllers[${JSON.stringify(sessions.a)}].enqueue(state.encoder.encode('data: '+JSON.stringify(value)+'\\n\\n'));
    emit({type:'answer_chunk',content:'A-BACKGROUND-CONTENT'});
    emit({type:'ask_user',sessionId:${JSON.stringify(sessions.a)},runId:'run-a',questionId:'question-a',question:'A-BACKGROUND-QUESTION',options:['A-OPTION']});
    emit({type:'notification',sessionId:${JSON.stringify(sessions.a)},runId:'run-a',title:'A-BACKGROUND-NOTIFICATION',body:'must stay with A'});
    return true;
  })()`);
  await delay(100);
  const backgroundState = await client.evaluate(`({
    active:document.querySelector('.session-item.active')?.dataset.sessionId,
    modal:document.getElementById('ask-modal').classList.contains('visible'),
    question:document.getElementById('ask-question-text').textContent,
    messages:document.getElementById('messages').textContent,
    busy:document.getElementById('submit').disabled,
  })`);
  assert.equal(backgroundState.active, sessions.b);
  assert.equal(backgroundState.modal, false);
  assert.equal(backgroundState.question, "");
  assert.equal(backgroundState.messages.includes("A-BACKGROUND-CONTENT"), false);
  assert.equal(backgroundState.messages.includes("A-BACKGROUND-QUESTION"), false);
  assert.equal(backgroundState.busy, true);

  await client.evaluate(`window.__rt01RendererProbe.controllers[${JSON.stringify(sessions.a)}].close();true`);
  await delay(150);
  assert.equal(await client.evaluate("document.getElementById('submit').disabled"), true, "A finally must not clear B run state");

  await selectRendererSession(client, sessions.a);
  const restoredQuestion = await client.evaluate(`({
    busy:document.getElementById('submit').disabled,
    modal:document.getElementById('ask-modal').classList.contains('visible'),
    question:document.getElementById('ask-question-text').textContent,
  })`);
  assert.equal(restoredQuestion.busy, false);
  assert.equal(restoredQuestion.modal, true);
  assert.equal(restoredQuestion.question, "A-BACKGROUND-QUESTION");
  await client.evaluate(`(()=>{document.getElementById('ask-input').value='answer A';document.querySelector('[data-action="submit-ask-answer"]').click();return true})()`);
  await waitFor(async () => {
    try { return await client.evaluate("window.__rt01RendererProbe.answers.length === 1"); }
    catch { return false; }
  }, { timeoutMs: 10_000, label: "RT-01 scoped answer" });
  assert.deepEqual(await client.evaluate("window.__rt01RendererProbe.answers[0]"), {
    sessionId: sessions.a,
    runId: "run-a",
    questionId: "question-a",
    answer: "answer A",
  });

  await selectRendererSession(client, sessions.b);
  assert.equal(await client.evaluate("document.getElementById('submit').disabled"), true);
  await client.evaluate(`window.__rt01RendererProbe.controllers[${JSON.stringify(sessions.b)}].close();true`);
  await waitFor(async () => {
    try { return !(await client.evaluate("document.getElementById('submit').disabled")); }
    catch { return false; }
  }, { timeoutMs: 10_000, label: "RT-01 B run completion" });

  await submit(sessions.b, "cancel B");
  await client.evaluate(`(()=>{
    const state=window.__rt01RendererProbe;
    state.controllers[${JSON.stringify(sessions.b)}].enqueue(state.encoder.encode('data: '+JSON.stringify({type:'run_started',sessionId:${JSON.stringify(sessions.b)},runId:'run-cancel-b'})+'\\n\\n'));
    return true;
  })()`);
  await waitFor(async () => {
    try { return await client.evaluate("window.__rt01RendererProbe.cancels.length === 0 && document.getElementById('submit').disabled"); }
    catch { return false; }
  }, { timeoutMs: 10_000, label: "RT-04 renderer run identity" });
  await delay(100);
  await client.evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));true");
  await waitFor(async () => {
    try {
      return await client.evaluate("window.__rt01RendererProbe.cancels.length === 1 && !document.getElementById('submit').disabled && document.getElementById('messages').textContent.includes('已中断')");
    } catch { return false; }
  }, { timeoutMs: 10_000, label: "RT-04 renderer cancellation" });
  assert.deepEqual(await client.evaluate("window.__rt01RendererProbe.cancels[0]"), {
    sessionId: sessions.b,
    runId: "run-cancel-b",
  });
  assert.match(await client.evaluate("document.getElementById('messages').textContent"), /已中断/u);

  await selectRendererSession(client, restoreSessionId);
  await client.evaluate("window.fetch=window.__rt01RendererProbe.originalFetch;delete window.__rt01RendererProbe;true");
}

async function rendererRequest(client, route, options = undefined, sessionId = null) {
  const requestOptions = {
    ...options,
    headers: { ...options?.headers, ...(sessionId ? { "X-RainyDays-Session": sessionId } : {}) },
  };
  return client.evaluate(`(async()=>{const response=await fetch(${JSON.stringify(route)},${JSON.stringify(requestOptions)});let body;try{body=await response.json()}catch{body=await response.text()}return {status:response.status,body}})()`);
}

async function assertCanonicalPathPolicy(client, userData, launchIndex, applicationRootPid, sessionId) {
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

  const internal = await rendererRequest(client, `/api/files/preview?root=workspace&path=${encodeURIComponent(internalName)}`, undefined, sessionId);
  assert.equal(internal.status, 200, "real Electron API rejected a root-internal file");
  assert.equal(internal.body.text, internalValue);

  const traversal = await rendererRequest(client, `/api/files/preview?root=workspace&path=${encodeURIComponent(`../${prefix}-outside/secret.txt`)}`, undefined, sessionId);
  assert.equal(traversal.status, 400, "real Electron API accepted traversal");
  assert(!JSON.stringify(traversal.body).includes(externalValue), "traversal denial disclosed external bytes");

  const redirected = await rendererRequest(client, `/api/files/preview?root=workspace&path=${encodeURIComponent(`${prefix}-junction/secret.txt`)}`, undefined, sessionId);
  assert.equal(redirected.status, 400, "real Electron API followed a junction");
  assert(!JSON.stringify(redirected.body).includes(externalValue), "junction denial disclosed external bytes");

  const mediaName = `${prefix}-range.png`;
  const mediaPath = path.join(workspace, mediaName);
  const originalPath = path.join(workspace, `${prefix}-range-original.png`);
  const replacementPath = path.join(workspace, `${prefix}-range-replacement.png`);
  const mediaSize = 96 * 1024 * 1024;
  await writeFile(mediaPath, Buffer.alloc(mediaSize, 0x41));
  await writeFile(replacementPath, "ATTACKER-REPLACEMENT");
  await client.evaluate(`(()=>{const state={error:null,ready:null,response:null};window.__rainydaysRangeProbe=state;fetch('/api/files/content?root=workspace&path=${encodeURIComponent(mediaName)}',{headers:{'X-RainyDays-Session':${JSON.stringify(sessionId)},Range:'bytes=0-${mediaSize - 1}'}}).then(response=>{state.response=response;state.ready={status:response.status,contentRange:response.headers.get('content-range')}}).catch(error=>{state.error=String(error)});return true})()`);
  const rangeReady = await waitFor(async () => client.evaluate(`(()=>{const state=window.__rainydaysRangeProbe;return state?.error?{error:state.error}:state?.ready})()`), {
    timeoutMs: 20_000,
    label: "File Viewer range lease headers",
  });
  assert.deepEqual(rangeReady, { status: 206, contentRange: `bytes 0-${mediaSize - 1}/${mediaSize}` });
  const beforeReplacement = await observeWindowsFileHandleInProcessTree(mediaPath, applicationRootPid);
  assert.equal(beforeReplacement.matched, true, "Electron application tree did not hold the original media object before pathname replacement");
  await rename(mediaPath, originalPath);
  await rename(replacementPath, mediaPath);
  const afterReplacement = await observeWindowsFileHandleInProcessTree(originalPath, applicationRootPid);
  assert.equal(afterReplacement.matched, true, "Electron application tree did not retain the original media object after pathname replacement");
  const range = await client.evaluate(`(async()=>{const state=window.__rainydaysRangeProbe;const response=state.response;const bytes=new Uint8Array(await response.arrayBuffer());let originalOnly=true;for(let i=0;i<bytes.length;i++){if(bytes[i]!==65){originalOnly=false;break}}delete window.__rainydaysRangeProbe;return {status:response.status,length:bytes.length,originalOnly,contentRange:response.headers.get('content-range')}})()`);
  assert.deepEqual(range, {
    status: 206,
    length: mediaSize,
    originalOnly: true,
    contentRange: `bytes 0-${mediaSize - 1}/${mediaSize}`,
  }, "File Viewer range lease did not return only original-handle bytes after pathname replacement");

  const terminalsBefore = await rendererRequest(client, "/api/terminals", undefined, sessionId);
  assert.equal(terminalsBefore.status, 200);
  const deniedTerminalMutations = [
    ["/api/terminals", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: prefix, shell: "cmd", cwd: outside }) }],
    ["/api/terminals/forged/input", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ input: "dir" }) }],
    ["/api/terminals/forged/clear", { method: "POST" }],
    ["/api/terminals/forged/kill", { method: "POST" }],
    ["/api/terminals/forged", { method: "DELETE" }],
  ];
  for (const [route, options] of deniedTerminalMutations) {
    const denied = await rendererRequest(client, route, options, sessionId);
    assert.equal(denied.status, 403, `${route} bypassed native consent`);
    assert.equal(denied.body.code, "EXEC_DIRECT_MUTATION_DENIED");
  }
  const terminalsAfter = await rendererRequest(client, "/api/terminals", undefined, sessionId);
  assert.equal(terminalsAfter.status, 200);
  assert.equal(terminalsAfter.body.terminals.length, terminalsBefore.body.terminals.length, "external CWD denial created a Terminal process record");
}

async function probeWorkbench(client, sessionId, configure) {
  let lastState = "not evaluated";
  if (configure) {
    const steps = [
      ["select Session", `selectSession(${JSON.stringify(sessionId)})`],
      ["horizontal split", "splitWorkbenchPane(workbenchLayout.focusedPaneId,'horizontal')"],
      ["open Terminal", "toggleTerminal(true)"],
      ["vertical split", "splitWorkbenchPane(workbenchLayout.focusedPaneId,'vertical')"],
      ["open File", "toggleFileViewer(true)"],
    ];
    for (const [label, expression] of steps) {
      try { await client.evaluate(expression); }
      catch (error) { throw new Error(`DS-03 ${label} failed: ${error instanceof Error ? error.message : String(error)}`); }
    }
  }
  try {
    return await waitFor(async () => {
      try {
        const value = await client.evaluate(`(async()=>{
        if(!document.querySelector('#workbench-pane-tree .workbench-pane'))return null;
        const response=await fetch('/api/workbench/layout');
        const stored=await response.json();
        const active=[];
        const visit=node=>{if(node.type==='pane'){const tab=node.tabs.find(candidate=>candidate.id===node.activeTabId);active.push(tab?.kind||null);return}visit(node.first);visit(node.second)};
        if(stored.layout)visit(stored.layout.root);
        return {
          status:response.status,
          revision:stored.revision,
          paneCount:document.querySelectorAll('#workbench-pane-tree .workbench-pane').length,
          active,
          mounted:{
            session:Boolean(document.getElementById('chat-view')?.closest('.workbench-pane')),
            terminal:Boolean(document.getElementById('terminal-panel')?.closest('.workbench-pane')),
            file:Boolean(document.getElementById('file-viewer')?.closest('.workbench-pane')),
          },
        };
      })()`);
        lastState = JSON.stringify(value);
        return value?.status === 200 && (!configure || value.paneCount === 3) ? value : null;
      } catch (error) { lastState = error instanceof Error ? error.stack || error.message : String(error); return null; }
    }, { timeoutMs: 20_000, label: configure ? "DS-03 workbench configuration" : "DS-03 workbench restore" });
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; last DS-03 state: ${lastState}`);
  }
}

test("RT-01 renderer source keeps runs and questions session-bound", async () => {
  const source = await readFile(path.join(projectRoot, "public", "renderer.js"), "utf8");
  assert.doesNotMatch(source, /\blet\s+(?:isRunning|currentQuestion)\b/u);
  assert.match(source, /const activeRunsBySession = new Map\(\);/u);
  assert.match(source, /const questionsBySession = new Map\(\);/u);
  assert.match(source, /activeRunsBySession\.get\(sessionId\) === token/u);
  assert.match(source, /if \(!chatSessionId \|\| isSessionRunning\(chatSessionId\)\) return;/u);
  assert.match(source, /finally \{ finishSessionRun\(chatSessionId, runToken\); if \(currentSessionId === chatSessionId\) inputEl\.focus\(\); \}/u);
  assert.match(source, /questionsBySession\.get\(answerSessionId\)/u);
  assert.match(source, /question\.sessionId !== answerSessionId/u);
  const askBranch = source.indexOf('if (step.type === "ask_user")');
  const currentSessionGate = source.indexOf("if (currentSessionId !== chatSessionId) continue;", askBranch);
  const notificationBranch = source.indexOf('if (step.type === "notification")', askBranch);
  assert(askBranch >= 0 && currentSessionGate > askBranch && notificationBranch > currentSessionGate, "ask storage and notification visibility must remain behind the session boundary");
  assert.match(source.slice(askBranch, currentSessionGate), /currentSessionId === chatSessionId/u);
  assert.match(source, /async function deleteSession\(id\)[\s\S]*?if \(!response\.ok\)[\s\S]*?activeRunsBySession\.delete\(id\)/u);
  assert.match(source, /async function clearChat\(\)[\s\S]*?if \(!response\.ok\)[\s\S]*?if \(currentSessionId !== sessionId\) return;/u);
});

test("real Electron main, preload and renderer preserve identity and session across restart", { timeout: 300_000 }, async (context) => {
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
    first = await startElectron(userData, firstHttpPort, firstCdpPort, context.signal);
    console.log("[electron-e2e] first CDP");
    try { client = await connectCdp(firstCdpPort); }
    catch (error) {
      const logs = first.logs();
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nElectron stdout:\n${logs.stdout}\nElectron stderr:\n${logs.stderr}`);
    }
    await probeIdentity(client, buildInfo, firstHttpPort);
    await assertRendererHardening(client, firstHttpPort);
    console.log("[electron-e2e] first identity and renderer hardening passed");
    let created;
    try {
      created = await client.evaluate(`fetch('/api/sessions', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:'GOV-03 Electron persistence'})}).then(r=>r.json())`);
    } catch (error) {
      const logs = first.logs();
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nElectron stdout:\n${logs.stdout}\nElectron stderr:\n${logs.stderr}`);
    }
    sessionId = created.session.id;
    assert.match(sessionId, /^[0-9a-f-]{36}$/);
    console.log("[electron-e2e] first path policy");
    await assertCanonicalPathPolicy(client, userData, 1, first.child.pid, sessionId);
    console.log("[electron-e2e] first path policy passed");
    await assertRendererSessionIsolation(client, sessionId);
    console.log("[electron-e2e] renderer session isolation passed");
    const workbenchFirst = await probeWorkbench(client, sessionId, true);
    assert.deepEqual([...workbenchFirst.active].sort(), ["file", "session", "terminal"]);
    assert.deepEqual(workbenchFirst.mounted, { session: true, terminal: true, file: true });
    assert(workbenchFirst.revision >= 5);
    await client.evaluate("location.reload(); true");
    const afterReload = await waitFor(async () => {
      try {
        const value = await client.evaluate("fetch('/api/sessions').then(r=>r.json())");
        return Array.isArray(value?.sessions) ? value : null;
      } catch { return null; }
    }, { timeoutMs: 20_000, label: "renderer reload" });
    assert(afterReload.sessions.some((entry) => entry.id === sessionId));
    const workbenchReload = await probeWorkbench(client, sessionId, false);
    assert.equal(workbenchReload.revision, workbenchFirst.revision);
    assert.equal(workbenchReload.paneCount, 3);
    assert.deepEqual([...workbenchReload.active].sort(), ["file", "session", "terminal"]);
    assert.deepEqual(workbenchReload.mounted, { session: true, terminal: true, file: true });
    assert(first.logs().stdout.includes(buildInfo.buildId));
    client.close(); client = null;
    console.log("[electron-e2e] stopping first launch");
    await stopElectron(first, firstHttpPort, firstCdpPort); first = null;
    console.log("[electron-e2e] first launch stopped");

    const [secondHttpPort, secondCdpPort] = await freeDistinctPorts(2);
    console.log("[electron-e2e] second launch");
    second = await startElectron(userData, secondHttpPort, secondCdpPort, context.signal);
    client = await connectCdp(secondCdpPort);
    await probeIdentity(client, buildInfo, secondHttpPort);
    await assertRendererHardening(client, secondHttpPort);
    console.log("[electron-e2e] second identity and renderer hardening passed");
    console.log("[electron-e2e] second path policy");
    await assertCanonicalPathPolicy(client, userData, 2, second.child.pid, sessionId);
    console.log("[electron-e2e] second path policy passed");
    const afterRestart = await client.evaluate("fetch('/api/sessions').then(r=>r.json())");
    assert(afterRestart.sessions.some((entry) => entry.id === sessionId));
    assert.equal(afterRestart.current, sessionId);
    const workbenchRestart = await probeWorkbench(client, sessionId, false);
    assert.equal(workbenchRestart.revision, workbenchFirst.revision);
    assert.equal(workbenchRestart.paneCount, 3);
    assert.deepEqual([...workbenchRestart.active].sort(), ["file", "session", "terminal"]);
    assert.deepEqual(workbenchRestart.mounted, { session: true, terminal: true, file: true });
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

test("SEC-03 Electron stage emits all 48 authenticated projection receipts", { timeout: 120_000 }, async () => {
  const result = await emitSec03ProjectionReceipts({
    layer: "electron",
    addonPath: path.join(projectRoot, ".electron-app", "dist", "native", "sandbox-launcher.node"),
  });
  assert.equal(result.enabled ? result.count : 0, result.enabled ? 48 : 0);
});
