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

async function installAxe(client) {
  const source = await readFile(path.join(projectRoot, "node_modules", "axe-core", "axe.min.js"), "utf8");
  await client.evaluate(`${source}\n;typeof axe==='object'`, 30_000);
}

async function wcag21AaViolations(client) {
  return client.evaluate(`axe.run(document,{runOnly:{type:'tag',values:['wcag2a','wcag2aa','wcag21a','wcag21aa']},resultTypes:['violations']}).then(result=>result.violations.map(item=>({id:item.id,impact:item.impact,nodes:item.nodes.map(node=>({target:node.target,html:node.html,failureSummary:node.failureSummary}))})))`, 30_000);
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
        health: await (await fetch('/api/health')).json(),
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
    "terminalKill", "terminalResize", "terminalStart", "updateTrayState", "windowAction", "windowState",
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
  assert.equal(value.health.live, true);
  assert.equal(value.health.ready, true);
  assert.equal(value.health.buildId, buildInfo.buildId);
  assert(["ready", "degraded"].includes(value.health.status));
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
  const alreadyActive = await client.evaluate(`currentSessionId === ${JSON.stringify(sessionId)}`);
  if (!alreadyActive) {
    const clicked = await client.evaluate(`(()=>{const target=document.querySelector(${JSON.stringify(selector)});if(!target)return false;target.click();return true})()`);
    assert.equal(clicked, true, `renderer Session button is missing: ${sessionId}`);
  }
  try {
    await waitFor(async () => {
      try {
        return await client.evaluate(`(async()=>{await sessionSelectionQueue;return currentSessionId === ${JSON.stringify(sessionId)}})()`);
      } catch { return false; }
    }, { timeoutMs: 10_000, label: `renderer session ${sessionId}` });
  } catch (error) {
    const diagnostic = await client.evaluate(`(async()=>({
      requested:${JSON.stringify(sessionId)},
      active:document.querySelector('.session-item.active')?.dataset.sessionId||null,
      currentSessionId,
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
  await client.evaluate("(()=>{if(document.getElementById('settings-modal').classList.contains('visible'))closeSettings();return true})()");

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
    try {
      return await client.evaluate(`window.__rt01RendererProbe.cancels.length === 0
        && document.getElementById('submit').disabled
        && activeRunsBySession.get(${JSON.stringify(sessions.b)})?.runId === 'run-cancel-b'`);
    } catch { return false; }
  }, { timeoutMs: 10_000, label: "RT-04 renderer run identity" });
  await delay(100);
  await client.evaluate("(()=>{if(document.getElementById('settings-modal').classList.contains('visible'))closeSettings();return true})()");
  await waitFor(async () => {
    try { return await client.evaluate("dialogStack.length === 0"); }
    catch { return false; }
  }, { timeoutMs: 10_000, label: "RT-04 cancellation dialog precondition" });
  await client.evaluate(`(()=>{
    const event=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});
    const result=document.body.dispatchEvent(event);
    window.__rt01RendererProbe.escapeDispatch={result,defaultPrevented:event.defaultPrevented,currentSessionId,running:isSessionRunning()};
    return true;
  })()`);
  try {
    await waitFor(async () => {
      try {
        return await client.evaluate("window.__rt01RendererProbe.cancels.length === 1 && !document.getElementById('submit').disabled && document.getElementById('messages').textContent.includes('已中断')");
      } catch { return false; }
    }, { timeoutMs: 10_000, label: "RT-04 renderer cancellation" });
  } catch (error) {
    const diagnostic = await client.evaluate(`(()=>{
      const token=activeRunsBySession.get(${JSON.stringify(sessions.b)});
      const synthetic=new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true});
      return {
        cancels:window.__rt01RendererProbe.cancels,
        escapeDispatch:window.__rt01RendererProbe.escapeDispatch,
        currentSessionId,
        running:isSessionRunning(),
        token:token?{runId:token.runId,cancelling:token.cancelling,aborted:token.controller.signal.aborted}:null,
        submitDisabled:document.getElementById('submit').disabled,
        messages:document.getElementById('messages').textContent.slice(-500),
        activeElement:document.activeElement?.id||document.activeElement?.className||null,
        activeDialog:dialogStack.at(-1)?.id||null,
        cancelBinding:shortcutBindings.cancelRun,
        syntheticAction:keyboardManager.actionForEvent(synthetic,shortcutBindings,window.electronAPI?.platform||navigator.platform),
      };
    })()`);
    throw new Error(`${error instanceof Error ? error.message : String(error)}; diagnostic=${JSON.stringify(diagnostic)}`);
  }
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
      ["open File", `ensureWorkbenchTab({id:workbenchId('tab'),kind:'file',title:'文件',sessionId:${JSON.stringify(sessionId)},rootId:'workspace',path:'.'})`],
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

async function probeDs04Xterm(client) {
  return await client.evaluate(`(async()=>{
    const terminal=ensureXtermTerminal();
    const write=value=>new Promise(resolve=>terminal.write(value,resolve));
    await write('\\x1b[?1049h\\x1b[38;2;1;2;3mX');
    const line=terminal.buffer.active.getLine(terminal.buffer.active.cursorY);
    const cell=line?.getCell(Math.max(0,terminal.buffer.active.cursorX-1));
    const alternate={
      type:terminal.buffer.active.type,
      fgRgb:cell?.isFgRGB?.()===true,
      fgColor:cell?.getFgColor?.(),
    };
    await write('\\x1b[0m\\x1b[?1049l');
    return {
      terminalGlobal:typeof window.Terminal,
      fitGlobal:typeof window.FitAddon?.FitAddon,
      node:Boolean(document.querySelector('#terminal-screen .xterm')),
      alternate,
      restoredType:terminal.buffer.active.type,
      rawInputContract:/appendNewline:\\s*false/u.test(sendTerminalInput.toString()),
      resizeContract:/terminalResize/u.test(scheduleTerminalResize.toString()),
    };
  })()`);
}

async function createDs05AttachmentDrafts(client) {
  return client.evaluate(`(async()=>{
    await newChat();
    const sessionId=currentSessionId;
    const fromBase64=value=>Uint8Array.from(atob(value),character=>character.charCodeAt(0));
    if(document.getElementById('settings-modal').classList.contains('visible')) closeSettings();
    inputEl.focus();
    let altVInvoked=false;
    attachmentFileInputEl.addEventListener('click',event=>{event.preventDefault();altVInvoked=true;},{once:true});
    const altVEvent=new KeyboardEvent('keydown',{bubbles:true,cancelable:true,altKey:true,key:'v'});
    inputEl.dispatchEvent(altVEvent);

    const pasteTransfer=new DataTransfer();
    pasteTransfer.items.add(new File([
      fromBase64('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAX+XDSwAAAABJRU5ErkJggg==')
    ],'clipboard.png',{type:'image/png'}));
    const pasteEvent=new Event('paste',{bubbles:true,cancelable:true});
    Object.defineProperty(pasteEvent,'clipboardData',{value:pasteTransfer});
    inputEl.dispatchEvent(pasteEvent);

    const dropTransfer=new DataTransfer();
    dropTransfer.items.add(new File(['dropped attachment'], 'dropped.txt', {type:'text/plain'}));
    const dropEvent=new Event('drop',{bubbles:true,cancelable:true});
    Object.defineProperty(dropEvent,'dataTransfer',{value:dropTransfer});
    document.getElementById('chat-view').dispatchEvent(dropEvent);

    const deadline=Date.now()+15000;
    while(Date.now()<deadline){
      if(attachmentDrafts.length===2&&attachmentDrafts.every(value=>value.state==='ready')) break;
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    return {
      sessionId,
      prevented:{altV:altVEvent.defaultPrevented,paste:pasteEvent.defaultPrevented,drop:dropEvent.defaultPrevented},
      altVInvoked,
      shortcut:{
        binding:shortcutBindings.attachFile,
        action:keyboardManager.actionForEvent(altVEvent,shortcutBindings,window.electronAPI?.platform||navigator.platform),
        altKey:altVEvent.altKey,
        key:altVEvent.key,
        activeKind:activeWorkbenchTab()?.kind||null,
        activeElement:document.activeElement?.id||document.activeElement?.className||null,
      },
      xhrContract:/new XMLHttpRequest\\(\\)/u.test(uploadReservedAttachment.toString()),
      drafts:attachmentDrafts.map(({id,name,mime,size,state,kind})=>({id,name,mime,size,state,kind})),
      chips:[...document.querySelectorAll('#attachment-draft-list .attachment-chip')].map(chip=>({
        name:chip.querySelector('.attachment-name')?.textContent,
        state:chip.querySelector('.attachment-state')?.textContent,
        image:Boolean(chip.querySelector('img.attachment-thumb')),
      })),
    };
  })()`);
}

test("RT-01 renderer source keeps runs and questions session-bound", async () => {
  const source = await readFile(path.join(projectRoot, "public", "renderer.js"), "utf8");
  assert.doesNotMatch(source, /\blet\s+(?:isRunning|currentQuestion)\b/u);
  assert.match(source, /const activeRunsBySession = new Map\(\);/u);
  assert.match(source, /const questionsBySession = new Map\(\);/u);
  assert.match(source, /activeRunsBySession\.get\(sessionId\) === token/u);
  assert.match(source, /if \(!chatSessionId \|\| isSessionRunning\(chatSessionId\)\) return;/u);
  assert.match(source, /finally \{ completeAccessibleResponse\(bubbleEl\.textContent\); finishSessionRun\(chatSessionId, runToken\); if \(currentSessionId === chatSessionId\) inputEl\.focus\(\); \}/u);
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
    const xtermProbe = await probeDs04Xterm(client);
    assert.deepEqual({
      terminalGlobal: xtermProbe.terminalGlobal,
      fitGlobal: xtermProbe.fitGlobal,
      node: xtermProbe.node,
      rawInputContract: xtermProbe.rawInputContract,
      resizeContract: xtermProbe.resizeContract,
    }, { terminalGlobal: "function", fitGlobal: "function", node: true, rawInputContract: true, resizeContract: true });
    assert.deepEqual(xtermProbe.alternate, { type: "alternate", fgRgb: true, fgColor: 0x010203 });
    assert.equal(xtermProbe.restoredType, "normal");
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

test("DS-04 real Electron loads the offline xterm truecolor and alternate-screen renderer", { timeout: 90_000 }, async (context) => {
  const fixture = await makeTempDir("mini-lux-ds04-electron-");
  const userData = path.join(fixture, "user-data");
  const buildInfo = JSON.parse(await readFile(path.join(projectRoot, "build-info.json"), "utf8"));
  let instance;
  let client;
  try {
    const [httpPort, cdpPort] = await freeDistinctPorts(2);
    instance = await startElectron(userData, httpPort, cdpPort, context.signal);
    client = await connectCdp(cdpPort);
    await probeIdentity(client, buildInfo, httpPort);
    const probe = await probeDs04Xterm(client);
    assert.deepEqual({
      terminalGlobal: probe.terminalGlobal,
      fitGlobal: probe.fitGlobal,
      node: probe.node,
      rawInputContract: probe.rawInputContract,
      resizeContract: probe.resizeContract,
    }, { terminalGlobal: "function", fitGlobal: "function", node: true, rawInputContract: true, resizeContract: true });
    assert.deepEqual(probe.alternate, { type: "alternate", fgRgb: true, fgColor: 0x010203 });
    assert.equal(probe.restoredType, "normal");
    client.close(); client = null;
    await stopElectron(instance, httpPort, cdpPort); instance = null;
  } finally {
    client?.close();
    if (instance) await terminateProcessTreeAsync(instance.child);
    await removeFixture(fixture);
  }
  assert.equal(await pathExists(fixture), false);
});

test("DS-05 real Electron persists clipboard and drop File uploads across reload", { timeout: 90_000 }, async (context) => {
  const fixture = await makeTempDir("mini-lux-ds05-electron-");
  const userData = path.join(fixture, "user-data");
  const buildInfo = JSON.parse(await readFile(path.join(projectRoot, "build-info.json"), "utf8"));
  let instance;
  let client;
  try {
    const [httpPort, cdpPort] = await freeDistinctPorts(2);
    instance = await startElectron(userData, httpPort, cdpPort, context.signal);
    client = await connectCdp(cdpPort);
    await probeIdentity(client, buildInfo, httpPort);
    await waitFor(async () => {
      try { return await client.evaluate("Boolean(workbenchLayout && currentSessionId && activeWorkbenchTab()?.kind === 'session')"); }
      catch { return false; }
    }, { timeoutMs: 20_000, label: "DS-05 initialized Session workbench" });
    const created = await createDs05AttachmentDrafts(client);
    assert.deepEqual(created.prevented, { altV: true, paste: true, drop: true }, JSON.stringify(created.shortcut));
    assert.equal(created.altVInvoked, true);
    assert.equal(created.xhrContract, true);
    assert.deepEqual(created.drafts.map(value => ({ name: value.name, mime: value.mime, size: value.size, state: value.state, kind: value.kind })).sort((a, b) => a.name.localeCompare(b.name)), [
      { name: "clipboard.png", mime: "image/png", size: 70, state: "ready", kind: "image" },
      { name: "dropped.txt", mime: "text/plain", size: 18, state: "ready", kind: "text" },
    ]);
    assert.deepEqual(created.chips.map(value => value.name).sort(), ["clipboard.png", "dropped.txt"]);
    assert.equal(created.chips.find(value => value.name === "clipboard.png")?.image, true);

    await client.evaluate("location.reload(); true");
    await waitFor(async () => {
      try { return await client.evaluate("document.readyState === 'complete' && typeof selectSession === 'function'"); }
      catch { return false; }
    }, { timeoutMs: 20_000, label: "DS-05 renderer reload" });
    await client.evaluate(`selectSession(${JSON.stringify(created.sessionId)}).then(()=>true)`);
    const restored = await client.evaluate(`(async()=>{
      const deadline=Date.now()+10000;
      while(Date.now()<deadline){
        if(currentSessionId===${JSON.stringify(created.sessionId)}&&attachmentDrafts.length===2&&attachmentDrafts.every(value=>value.state==='ready')) break;
        await new Promise(resolve=>setTimeout(resolve,50));
      }
      const contents=[];
      for(const attachment of attachmentDrafts){
        const response=await fetch(attachmentContentUrl(currentSessionId,attachment.id),{headers:sessionHeaders(currentSessionId)});
        contents.push({name:attachment.name,status:response.status,size:(await response.arrayBuffer()).byteLength});
      }
      return {
        currentSessionId,
        drafts:attachmentDrafts.map(({name,state})=>({name,state})),
        chips:[...document.querySelectorAll('#attachment-draft-list .attachment-chip')].map(chip=>chip.querySelector('.attachment-name')?.textContent),
        contents,
      };
    })()`);
    assert.equal(restored.currentSessionId, created.sessionId);
    assert.deepEqual(restored.drafts.sort((a, b) => a.name.localeCompare(b.name)), [
      { name: "clipboard.png", state: "ready" },
      { name: "dropped.txt", state: "ready" },
    ]);
    assert.deepEqual(restored.chips.sort(), ["clipboard.png", "dropped.txt"]);
    assert.deepEqual(restored.contents.sort((a, b) => a.name.localeCompare(b.name)), [
      { name: "clipboard.png", status: 200, size: 70 },
      { name: "dropped.txt", status: 200, size: 18 },
    ]);
    client.close(); client = null;
    await stopElectron(instance, httpPort, cdpPort); instance = null;
  } finally {
    client?.close();
    if (instance) await terminateProcessTreeAsync(instance.child);
    await removeFixture(fixture);
  }
  assert.equal(await pathExists(fixture), false);
});

test("DS-06 real Electron edits, sandboxes, refreshes and streams File Tabs offline", { timeout: 90_000 }, async (context) => {
  const fixture = await makeTempDir("mini-lux-ds06-electron-");
  const userData = path.join(fixture, "user-data");
  const workspace = path.join(userData, "workspace");
  const buildInfo = JSON.parse(await readFile(path.join(projectRoot, "build-info.json"), "utf8"));
  let instance;
  let client;
  try {
    const [httpPort, cdpPort] = await freeDistinctPorts(2);
    instance = await startElectron(userData, httpPort, cdpPort, context.signal);
    await Promise.all([
      writeFile(path.join(workspace, "preview.html"), "<h1>DS-06</h1><script>parent.__ds06HtmlPwned=true</script>"),
      writeFile(path.join(workspace, "note.md"), "# Initial\n"),
      writeFile(path.join(workspace, "sample.mp3"), Buffer.from("ID3-DS06-ELECTRON-AUDIO")),
      writeFile(path.join(workspace, "large.txt"), `${"0123456789abcdef".repeat(70_000)}\nlast`),
    ]);
    client = await connectCdp(cdpPort);
    await probeIdentity(client, buildInfo, httpPort);
    const sessionId = await client.evaluate("newChat().then(()=>currentSessionId)");
    assert.equal(typeof sessionId, "string");
    await client.evaluate("toggleFileViewer(true)");
    await client.evaluate("previewFile('preview.html',1,'','workspace')");
    const htmlProbe = await client.evaluate(`(()=>{
      const frame=document.querySelector('#file-preview-content iframe');
      return {
        kind:selectedFilePreview?.kind,
        sandbox:frame?.getAttribute('sandbox'),
        csp:frame?.srcdoc?.includes("default-src 'none'"),
        pwned:Boolean(window.__ds06HtmlPwned),
        remoteAssets:[...document.querySelectorAll('script[src],link[href]')].some(node=>new URL(node.src||node.href,location.href).origin!==location.origin),
      };
    })()`);
    assert.deepEqual(htmlProbe, { kind: "html", sandbox: "", csp: true, pwned: false, remoteAssets: false });
    await client.evaluate("showFileSource()");
    assert.match(await client.evaluate("document.querySelector('#file-preview-content code')?.textContent||''"), /parent\.__ds06HtmlPwned/u);
    await client.evaluate("previewFile('note.md',1,'','workspace')");
    await client.evaluate(`(()=>{
      editSelectedFile();
      const editor=document.querySelector('.file-editor');
      editor.value='# Saved in Electron\\n';
      editor.dispatchEvent(new Event('input',{bubbles:true}));
      window.__ds06SaveError=null;
      void saveSelectedFile().catch(error=>{window.__ds06SaveError=String(error)});
      return true;
    })()`);
    await waitFor(async () => client.evaluate("fileSaving===false && fileEditing===false && fileEditDirty===false"), {
      timeoutMs: 20_000, label: "DS-06 renderer save settlement",
    });
    const saved = await client.evaluate("({editing:fileEditing,dirty:fileEditDirty,text:selectedFilePreview?.fullText,error:window.__ds06SaveError})");
    assert.deepEqual(saved, { editing: false, dirty: false, text: "# Saved in Electron\n", error: null });
    assert.equal(await readFile(path.join(workspace, "note.md"), "utf8"), "# Saved in Electron\n");
    await client.evaluate(`(()=>{
      editSelectedFile();
      const editor=document.querySelector('.file-editor');
      editor.value='# Unsaved editor\\n';
      editor.dispatchEvent(new Event('input',{bubbles:true}));
      return true;
    })()`);
    await client.evaluate("previewFile('sample.mp3',1,'','workspace')");
    const blockedNavigation = await client.evaluate(`({
      path:selectedFilePath,
      editing:fileEditing,
      dirty:fileEditDirty,
      editor:Boolean(document.querySelector('.file-editor')),
    })`);
    assert.deepEqual(blockedNavigation, { path: "note.md", editing: true, dirty: true, editor: true });
    await writeFile(path.join(workspace, "note.md"), "# External change\n");
    await waitFor(async () => client.evaluate("fileEditConflict===true && document.getElementById('file-save').disabled===true"), {
      timeoutMs: 10_000, label: "DS-06 renderer conflict",
    });
    await client.evaluate("reloadSelectedFile()");
    await waitFor(async () => client.evaluate("selectedFilePreview?.fullText==='# External change\\n' && fileEditConflict===false"), {
      timeoutMs: 10_000, label: "DS-06 renderer reload",
    });
    await client.evaluate("previewFile('sample.mp3',1,'','workspace')");
    const media = await client.evaluate(`(()=>{
      const audio=document.querySelector('#file-preview-content audio');
      return {kind:selectedFilePreview?.kind,controls:audio?.controls,origin:audio?new URL(audio.src).origin:null,session:new URL(audio.src).searchParams.get('sessionId')};
    })()`);
    assert.deepEqual(media, { kind: "audio", controls: true, origin: `http://127.0.0.1:${httpPort}`, session: sessionId });
    await client.evaluate("previewFile('large.txt',1,'','workspace')");
    const large = await client.evaluate(`({
      editable:selectedFilePreview?.editable,
      fullText:selectedFilePreview?.fullText,
      renderedLines:(document.querySelector('#file-preview-content code')?.textContent||'').split('\\n').length,
      pager:!document.getElementById('file-preview-pager').hidden,
      editHidden:document.getElementById('file-edit').hidden,
    })`);
    assert.deepEqual({ editable: large.editable, fullText: large.fullText, pager: large.pager, editHidden: large.editHidden }, {
      editable: false, fullText: null, pager: true, editHidden: true,
    });
    assert(large.renderedLines >= 1 && large.renderedLines <= 8, `large preview rendered ${large.renderedLines} virtual lines`);
    await client.evaluate("closeFileEvents(); true");

    client.close(); client = null;
    await stopElectron(instance, httpPort, cdpPort); instance = null;
  } finally {
    client?.close();
    if (instance) await terminateProcessTreeAsync(instance.child);
    await removeFixture(fixture);
  }
  assert.equal(await pathExists(fixture), false);
});

test("DS-07 real Electron prioritizes editing, history, Escape and Workbench shortcuts", { timeout: 90_000 }, async (context) => {
  const fixture = await makeTempDir("mini-lux-ds07-electron-");
  const userData = path.join(fixture, "user-data");
  const buildInfo = JSON.parse(await readFile(path.join(projectRoot, "build-info.json"), "utf8"));
  let instance;
  let client;
  try {
    const [httpPort, cdpPort] = await freeDistinctPorts(2);
    instance = await startElectron(userData, httpPort, cdpPort, context.signal);
    client = await connectCdp(cdpPort);
    await probeIdentity(client, buildInfo, httpPort);
    const sessionId = await client.evaluate("newChat().then(()=>currentSessionId)");

    const history = await client.evaluate(`(()=>{
      pushSessionHistory(currentSessionId,'first command');
      pushSessionHistory(currentSessionId,'second command');
      inputEl.value='draft text'; saveDraft(currentSessionId,inputEl.value); inputEl.focus(); inputEl.setSelectionRange(0,0);
      inputEl.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowUp',bubbles:true,cancelable:true}));
      const previous=inputEl.value;
      inputEl.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true}));
      return {previous,restored:inputEl.value};
    })()`);
    assert.deepEqual(history, { previous: "second command", restored: "draft text" });

    const editingGuard = await client.evaluate(`(async()=>{
      const before=knownSessions.length;
      inputEl.focus();
      inputEl.dispatchEvent(new KeyboardEvent('keydown',{key:'n',ctrlKey:true,bubbles:true,cancelable:true}));
      await new Promise(resolve=>setTimeout(resolve,100));
      return {before,after:knownSessions.length,value:inputEl.value};
    })()`);
    assert.deepEqual(editingGuard, { before: editingGuard.before, after: editingGuard.before, value: "draft text" });

    const escapePriority = await client.evaluate(`(async()=>{
      const makeToken=()=>({controller:new AbortController(),runId:null,cancelling:false,bubble:null});
      const settingsToken=makeToken(); activeRunsBySession.set(currentSessionId,settingsToken);
      await openSettings();
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
      const settings={visible:document.getElementById('settings-modal').classList.contains('visible'),aborted:settingsToken.controller.signal.aborted};
      activeRunsBySession.delete(currentSessionId);

      const slashToken=makeToken(); activeRunsBySession.set(currentSessionId,slashToken);
      slashMenu.classList.add('visible'); inputEl.focus();
      inputEl.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
      const slash={visible:slashMenu.classList.contains('visible'),aborted:slashToken.controller.signal.aborted};
      activeRunsBySession.delete(currentSessionId);

      const terminalToken=makeToken(); activeRunsBySession.set(currentSessionId,terminalToken);
      const xterm=document.createElement('div'); xterm.className='xterm';
      const helper=document.createElement('textarea'); xterm.appendChild(helper); document.getElementById('terminal-screen').appendChild(xterm);
      helper.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
      const terminal={aborted:terminalToken.controller.signal.aborted}; xterm.remove(); activeRunsBySession.delete(currentSessionId);

      const runToken=makeToken(); activeRunsBySession.set(currentSessionId,runToken);
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}));
      await new Promise(resolve=>setTimeout(resolve,0));
      const run={aborted:runToken.controller.signal.aborted,cancelling:runToken.cancelling}; activeRunsBySession.delete(currentSessionId); refreshRunControls();
      return {settings,slash,terminal,run};
    })()`);
    assert.deepEqual(escapePriority, {
      settings: { visible: false, aborted: false },
      slash: { visible: false, aborted: false },
      terminal: { aborted: false },
      run: { aborted: true, cancelling: true },
    });

    const initialPanes = await client.evaluate("workbenchPanes().length");
    await client.evaluate(`(()=>{
      inputEl.blur();
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',altKey:true,shiftKey:true,bubbles:true,cancelable:true}));
      return true;
    })()`);
    await waitFor(async () => client.evaluate(`workbenchPanes().length===${initialPanes + 1}`), { timeoutMs: 10_000, label: "DS-07 split shortcut" });
    await client.evaluate(`(()=>{
      document.dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}));
      return true;
    })()`);
    await waitFor(async () => client.evaluate("activeWorkbenchTab()?.kind==='file'"), { timeoutMs: 10_000, label: "DS-07 File shortcut" });
    const shortcutState = await client.evaluate(`({
      sessionId:currentSessionId,
      panes:workbenchPanes().length,
      file:activeWorkbenchTab()?.kind,
      commandMapping:RainyDaysKeyboard.eventMatches({key:'n',ctrlKey:false,metaKey:true,altKey:false,shiftKey:false},'Primary+N','darwin'),
      settingsApi:Object.keys(window.rainyDaysShortcutSettings).sort(),
    })`);
    assert.deepEqual(shortcutState, {
      sessionId, panes: initialPanes + 1, file: "file", commandMapping: true, settingsApi: ["get", "reset", "set"],
    });

    client.close(); client = null;
    await stopElectron(instance, httpPort, cdpPort); instance = null;
  } finally {
    client?.close();
    if (instance) await terminateProcessTreeAsync(instance.child);
    await removeFixture(fixture);
  }
  assert.equal(await pathExists(fixture), false);
});

test("DS-09 real Electron renders typed Settings and hot-applies TTS without secret disclosure", { timeout: 90_000 }, async (context) => {
  const fixture = await makeTempDir("mini-lux-ds09-electron-");
  const userData = path.join(fixture, "user-data");
  const buildInfo = JSON.parse(await readFile(path.join(projectRoot, "build-info.json"), "utf8"));
  let instance;
  let client;
  try {
    const [httpPort, cdpPort] = await freeDistinctPorts(2);
    instance = await startElectron(userData, httpPort, cdpPort, context.signal);
    client = await connectCdp(cdpPort);
    await probeIdentity(client, buildInfo, httpPort);
    await client.evaluate("(async()=>{await openSettings();return true})()");
    await waitFor(async () => client.evaluate("Boolean(settingsState && document.querySelectorAll('.settings-domain-tab').length===11)"), { timeoutMs: 10_000, label: "DS-09 Settings tabs" });
    const initial = await client.evaluate(`({
      labels:[...document.querySelectorAll('.settings-domain-tab')].map(button=>button.querySelector('span')?.textContent),
      sections:[...document.querySelectorAll('[data-settings-domain]')].map(section=>section.dataset.settingsDomain),
      providerSecret:document.getElementById('provider-api-key').value,
      asrSecret:document.getElementById('setting-asr-api-key').value,
      relaySecret:document.getElementById('setting-relay-token').value,
      nativeDirectory:typeof window.electronAPI.selectDirectory,
    })`);
    assert.deepEqual(initial, {
      labels: ["Common", "Profiles", "MCP", "Wire", "Animas", "Nous", "TTS", "ASR", "Shell", "Relay", "Update"],
      sections: ["common", "profiles", "mcp", "wire", "animas", "nous", "tts", "asr", "shell", "relay", "update"],
      providerSecret: "", asrSecret: "", relaySecret: "", nativeDirectory: "function",
    });
    await client.evaluate(`(async()=>{
      switchSettingsDomain('tts');
      document.getElementById('setting-tts-enabled').checked=true;
      document.getElementById('setting-tts-voice').value='Electron Fixture Voice';
      document.getElementById('setting-tts-language').value='en-US';
      document.getElementById('setting-tts-rate').value='1.2';
      await saveSettingsDomain('tts');
      return true;
    })()`);
    await waitFor(async () => client.evaluate("settingsState?.domains?.tts?.enabled===true && ttsEnabled===true"), { timeoutMs: 10_000, label: "DS-09 TTS hot apply" });
    const applied = await client.evaluate(`({
      active:activeSettingsDomain,
      tts:settingsState.domains.tts,
      runtime:{enabled:ttsEnabled,language:ttsPreferences.language,rate:ttsPreferences.rate},
      message:document.getElementById('settings-message').textContent,
    })`);
    assert.deepEqual(applied, {
      active: "tts",
      tts: { enabled: true, voice: "Electron Fixture Voice", language: "en-US", rate: 1.2 },
      runtime: { enabled: true, language: "en-US", rate: 1.2 },
      message: "tts 设置已保存。",
    });
    await client.evaluate("closeSettings(); openSettings()");
    await waitFor(async () => client.evaluate("settingsState?.domains?.tts?.voice==='Electron Fixture Voice'"), { timeoutMs: 10_000, label: "DS-09 Settings reopen" });
    assert.equal(await client.evaluate("document.getElementById('setting-tts-voice').value"), "Electron Fixture Voice");
    client.close(); client = null;
    await stopElectron(instance, httpPort, cdpPort); instance = null;
  } finally {
    client?.close();
    if (instance) await terminateProcessTreeAsync(instance.child);
    await removeFixture(fixture);
  }
  assert.equal(await pathExists(fixture), false);
});

test("DS-10 real Electron passes axe, keyboard focus, reflow and accessibility media gates", { timeout: 120_000 }, async (context) => {
  const fixture = await makeTempDir("mini-lux-ds10-electron-");
  const userData = path.join(fixture, "user-data");
  const buildInfo = JSON.parse(await readFile(path.join(projectRoot, "build-info.json"), "utf8"));
  let instance;
  let client;
  try {
    const [httpPort, cdpPort] = await freeDistinctPorts(2);
    instance = await startElectron(userData, httpPort, cdpPort, context.signal);
    client = await connectCdp(cdpPort);
    await probeIdentity(client, buildInfo, httpPort);
    await waitFor(async () => {
      try { return await client.evaluate("Boolean(desktopNavigationReady && workbenchLayout && currentSessionId && document.getElementById('input')?.getClientRects().length)"); }
      catch { return false; }
    }, { timeoutMs: 20_000, label: "DS-10 initialized accessible workbench" });
    await delay(350);
    await client.evaluate("(async()=>{await sessionSelectionQueue;if(document.getElementById('settings-modal').classList.contains('visible'))closeSettings();return true})()");
    await waitFor(async () => {
      try { return await client.evaluate("dialogStack.length === 0 && !document.getElementById('settings-modal').classList.contains('visible')"); }
      catch { return false; }
    }, { timeoutMs: 10_000, label: "DS-10 Workbench dialog precondition" });
    await installAxe(client);
    const violations = [];
    violations.push(...(await wcag21AaViolations(client)).map(item => ({ surface: "workbench", ...item })));
    await client.send("Accessibility.enable");
    await client.send("DOM.enable");
    const documentNode = await client.send("DOM.getDocument", { depth: 1, pierce: true });
    const inputNode = await client.send("DOM.querySelector", { nodeId: documentNode.root.nodeId, selector: "#input" });
    assert(inputNode.nodeId > 0, "DS-10 message input DOM node is missing");
    let lastInputAxTree = null;
    try {
      await waitFor(async () => {
        lastInputAxTree = await client.send("Accessibility.getPartialAXTree", { nodeId: inputNode.nodeId, fetchRelatives: true });
        return lastInputAxTree.nodes.some(node => !node.ignored && node.role?.value === "combobox" && node.name?.value === "消息");
      }, { timeoutMs: 10_000, label: "DS-10 message input AX node" });
    } catch (error) {
      const state = await client.evaluate(`({
        stack:dialogStack.map(modal=>modal.id),
        settingsVisible:document.getElementById('settings-modal').classList.contains('visible'),
        settingsHidden:document.getElementById('settings-modal').getAttribute('aria-hidden'),
        inputInert:Boolean(document.getElementById('input').closest('[inert]')),
        inputRects:document.getElementById('input').getClientRects().length,
        bodyInert:[...document.body.children].filter(child=>child.inert).map(child=>child.id||child.className||child.tagName),
      })`);
      const nodes = lastInputAxTree?.nodes?.map(node => ({ ignored: node.ignored, role: node.role?.value, name: node.name?.value, reasons: node.ignoredReasons })) || [];
      throw new Error(`${error instanceof Error ? error.message : String(error)}; state=${JSON.stringify(state)}; ax=${JSON.stringify(nodes)}`);
    }
    await client.evaluate("(async()=>{document.querySelector('.new-chat-btn').focus();await openSettings();return true})()");
    await waitFor(() => client.evaluate("Boolean(settingsState && document.querySelectorAll('.settings-domain-tab').length===11)"), { timeoutMs: 10_000, label: "DS-10 Settings tabs" });
    const domains = await client.evaluate("settingsState.domainManifest.map(domain=>domain.id)");
    for (const domainId of domains) {
      await client.evaluate(`switchSettingsDomain(${JSON.stringify(domainId)});true`);
      violations.push(...(await wcag21AaViolations(client)).map(item => ({ surface: `settings:${domainId}`, ...item })));
    }
    assert.deepEqual(violations, []);
    const settingsAxTree = await client.send("Accessibility.getFullAXTree");
    const settingsAx = settingsAxTree.nodes.filter(node => !node.ignored).map(node => ({ role: node.role?.value, name: node.name?.value || "" }));
    assert(settingsAx.some(node => node.role === "dialog" && node.name.includes("RainyDays Settings")), JSON.stringify(settingsAx));
    const expectedSettingsTabs = ["Common", "Profiles", "MCP", "Wire", "Animas", "Nous", "TTS", "ASR", "Shell", "Relay", "Update"];
    assert(expectedSettingsTabs.every(label => settingsAx.some(node => node.role === "tab" && node.name.startsWith(label))), JSON.stringify(settingsAx));

    const focusTrap = await client.evaluate(`(()=>{
      const modal=document.getElementById('settings-modal');
      const items=visibleFocusableElements(modal);
      items.at(-1).focus();
      return {before:document.activeElement===items.at(-1),count:items.length};
    })()`);
    assert.equal(focusTrap.before, true);
    assert(focusTrap.count > 2);
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    assert.equal(await client.evaluate("document.activeElement===visibleFocusableElements(document.getElementById('settings-modal'))[0]"), true);
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Tab", code: "Tab", modifiers: 8, windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Tab", code: "Tab", modifiers: 8, windowsVirtualKeyCode: 9, nativeVirtualKeyCode: 9 });
    assert.equal(await client.evaluate("document.activeElement===visibleFocusableElements(document.getElementById('settings-modal')).at(-1)"), true);
    await client.evaluate("document.querySelector('.settings-domain-tab.active').focus();true");
    const previousDomain = await client.evaluate("activeSettingsDomain");
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "ArrowDown", code: "ArrowDown", windowsVirtualKeyCode: 40, nativeVirtualKeyCode: 40 });
    assert.equal(await client.evaluate(`activeSettingsDomain!==${JSON.stringify(previousDomain)} && document.activeElement===document.querySelector('.settings-domain-tab.active')`), true);
    await client.evaluate("closeSettings()");
    await delay(50);
    const settingsRestore = await client.evaluate(`({
      activeTag:document.activeElement?.tagName,
      activeClass:document.activeElement?.className,
      newChatFocused:document.activeElement===document.querySelector('.new-chat-btn'),
      newChatInert:Boolean(document.querySelector('.new-chat-btn').closest('[inert]')),
      stack:dialogStack.map(modal=>modal.id),
      settingsHidden:document.getElementById('settings-modal').getAttribute('aria-hidden'),
    })`);
    assert.equal(settingsRestore.newChatFocused, true, JSON.stringify(settingsRestore));

    const beforeSessions = await client.evaluate("knownSessions.length");
    await client.evaluate("document.querySelector('.new-chat-btn').focus();true");
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: " ", code: "Space", text: " ", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: " ", code: "Space", windowsVirtualKeyCode: 32, nativeVirtualKeyCode: 32 });
    await waitFor(() => client.evaluate(`knownSessions.length>${beforeSessions}`), { timeoutMs: 10_000, label: "DS-10 keyboard new Session" });

    const installQuestion = `(()=>{
      questionsBySession.set(currentSessionId,Object.freeze({sessionId:currentSessionId,runId:'ds10-run',questionId:'ds10-question',question:'Accessible question',options:Object.freeze(['First','Second'])}));
      refreshQuestionForCurrentSession();
      return true;
    })()`;
    await client.evaluate("(async()=>{document.querySelector('.new-chat-btn').focus();await openSettings();return true})()");
    await client.evaluate(installQuestion);
    await waitFor(() => client.evaluate("dialogStack.length===2 && dialogStack.at(-1).id==='ask-modal'"), { timeoutMs: 5_000, label: "DS-10 nested Settings ask dialog" });
    assert.deepEqual(await wcag21AaViolations(client), []);
    assert.equal(await client.evaluate("document.activeElement===document.getElementById('ask-input') && document.getElementById('settings-modal').inert"), true);
    const askAxTree = await client.send("Accessibility.getFullAXTree");
    assert(askAxTree.nodes.some(node => !node.ignored && node.role?.value === "dialog" && String(node.name?.value).includes("Agent 需要你的回答")));
    await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    await client.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27, nativeVirtualKeyCode: 27 });
    assert.equal(await client.evaluate("document.getElementById('settings-modal').classList.contains('visible') && document.getElementById('ask-modal').classList.contains('visible')"), true);
    await client.evaluate("closeSettings();true");
    assert.equal(await client.evaluate("dialogStack.length===1 && dialogStack[0].id==='ask-modal' && document.activeElement===document.getElementById('ask-input')"), true);
    await client.evaluate("questionsBySession.delete(currentSessionId);refreshQuestionForCurrentSession();true");
    await waitFor(() => client.evaluate("dialogStack.length===0 && document.activeElement===document.querySelector('.new-chat-btn')"), { timeoutMs: 5_000, label: "DS-10 non-top dialog focus rebase" });

    await client.evaluate("document.querySelector('.new-chat-btn').focus();true");
    await client.evaluate(installQuestion);
    await client.evaluate("(async()=>{await openSettings();return true})()");
    await waitFor(() => client.evaluate("dialogStack.length===2 && dialogStack.at(-1).id==='settings-modal'"), { timeoutMs: 5_000, label: "DS-10 reverse nested dialogs" });
    await client.evaluate("questionsBySession.delete(currentSessionId);refreshQuestionForCurrentSession();true");
    assert.equal(await client.evaluate("dialogStack.length===1 && dialogStack[0].id==='settings-modal' && document.activeElement.closest('#settings-modal')!==null"), true);
    await client.evaluate("closeSettings()");
    await waitFor(() => client.evaluate("dialogStack.length===0 && document.activeElement===document.querySelector('.new-chat-btn')"), { timeoutMs: 5_000, label: "DS-10 reverse nested focus restore" });

    for (const width of [640, 320]) {
      await client.send("Emulation.setDeviceMetricsOverride", { width, height: 720, deviceScaleFactor: 1, mobile: false });
      await delay(50);
      const reflow = await client.evaluate(`(()=>{
        const sidebar=document.getElementById('sidebar').getBoundingClientRect();
        const main=document.getElementById('main').getBoundingClientRect();
        const input=document.getElementById('input').getBoundingClientRect();
        return {innerWidth,scrollWidth:document.documentElement.scrollWidth,sidebarRight:sidebar.right,mainLeft:main.left,mainRight:main.right,inputWidth:input.width};
      })()`);
      assert(reflow.scrollWidth <= reflow.innerWidth + 1, JSON.stringify(reflow));
      assert(reflow.mainRight <= reflow.innerWidth + 1, JSON.stringify(reflow));
      assert(reflow.mainLeft >= reflow.sidebarRight - 1, JSON.stringify(reflow));
      assert(reflow.inputWidth >= 40, JSON.stringify(reflow));
    }
    await client.send("Emulation.setDeviceMetricsOverride", { width: 320, height: 720, deviceScaleFactor: 1, mobile: false });
    await client.evaluate("(async()=>{await openSettings();return true})()");
    const settingsReflow = await client.evaluate(`(()=>{
      const panel=document.getElementById('settings-panel');const rect=panel.getBoundingClientRect();
      return {left:rect.left,right:rect.right,bottom:rect.bottom,innerWidth,innerHeight,scrollWidth:panel.scrollWidth,clientWidth:panel.clientWidth};
    })()`);
    assert(settingsReflow.left >= 0 && settingsReflow.right <= settingsReflow.innerWidth + 1 && settingsReflow.bottom <= settingsReflow.innerHeight + 1, JSON.stringify(settingsReflow));
    assert(settingsReflow.scrollWidth <= settingsReflow.clientWidth + 1, JSON.stringify(settingsReflow));
    await client.evaluate("closeSettings()");
    await client.evaluate("toggleFileViewer(true)", 30_000);
    const fileReflow = await client.evaluate(`(()=>{const view=document.getElementById('file-viewer');const rect=view.getBoundingClientRect();return {kind:activeWorkbenchTab()?.kind,left:rect.left,right:rect.right,innerWidth,scrollWidth:view.scrollWidth,clientWidth:view.clientWidth};})()`);
    assert.equal(fileReflow.kind, "file");
    assert(fileReflow.left >= 0 && fileReflow.right <= fileReflow.innerWidth + 1 && fileReflow.scrollWidth <= fileReflow.clientWidth + 1, JSON.stringify(fileReflow));
    await client.evaluate("toggleTerminal(true)", 30_000);
    const terminalReflow = await client.evaluate(`(()=>{const view=document.getElementById('terminal-panel');const rect=view.getBoundingClientRect();return {kind:activeWorkbenchTab()?.kind,left:rect.left,right:rect.right,innerWidth,scrollWidth:view.scrollWidth,clientWidth:view.clientWidth};})()`);
    assert.equal(terminalReflow.kind, "terminal");
    assert(terminalReflow.left >= 0 && terminalReflow.right <= terminalReflow.innerWidth + 1 && terminalReflow.scrollWidth <= terminalReflow.clientWidth + 1, JSON.stringify(terminalReflow));

    await client.send("Emulation.setEmulatedMedia", { features: [
      { name: "prefers-reduced-motion", value: "reduce" },
      { name: "forced-colors", value: "active" },
    ] });
    const media = await client.evaluate(`(()=>{
      const probe=document.createElement('div');probe.className='msg';document.body.appendChild(probe);
      const animation=getComputedStyle(probe).animationDuration;probe.remove();
      return {
        reduced:matchMedia('(prefers-reduced-motion: reduce)').matches,
        forced:matchMedia('(forced-colors: active)').matches,
        animation,
        buttonBorder:getComputedStyle(document.querySelector('.new-chat-btn')).borderTopStyle,
        selectedOutline:getComputedStyle(document.querySelector('.workbench-tab.active')).outlineStyle,
      };
    })()`);
    assert.equal(media.reduced, true);
    assert.equal(media.forced, true);
    assert.match(media.animation, /^(?:0\.00001s|1e-05s|0\.01ms)$/u);
    assert.equal(media.buttonBorder, "solid");
    assert.equal(media.selectedOutline, "solid");
    client.close(); client = null;
    await stopElectron(instance, httpPort, cdpPort); instance = null;
  } finally {
    client?.close();
    if (instance) await terminateProcessTreeAsync(instance.child);
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
