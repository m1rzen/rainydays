import assert from "node:assert/strict";
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
  terminateProcessTreeAsync,
  waitFor,
} from "../helpers.mjs";
import { launchTracked } from "./smoke-helpers.mjs";

const executable = path.join(projectRoot, "release", "win-unpacked", "RainyDays.exe");
const expectedKeys = [
  "appVersion", "buildId", "capabilities", "isElectron", "notify", "onNotificationClicked", "platform",
  "selectDirectory", "selectFile", "selectSavePath", "terminalClear", "terminalClose", "terminalInput",
  "terminalKill", "terminalResize", "terminalStart", "windowAction", "windowState",
];

async function listenerClosed(port) {
  try { await boundedFetch(`http://127.0.0.1:${port}/`); return false; }
  catch { return true; }
}

test("DS-02 win-unpacked exposes only the typed desktop bridge", { timeout: 90_000 }, async () => {
  assert.equal(process.platform, "win32");
  assert.equal(await pathExists(executable), true, "win-unpacked executable is missing");
  const userData = await makeTempDir("rainydays-ds02-packaged-");
  const [httpPort, cdpPort] = await freeDistinctPorts(2);
  const instance = launchTracked(executable, [`--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`, "--disable-gpu"], {
    env: { ...process.env, PORT: String(httpPort), ELECTRON_ENABLE_LOGGING: "1" },
    timeoutMs: 45_000,
    label: "DS-02 win-unpacked IPC service",
    readyProbe: async () => {
      try { return (await boundedFetch(`http://127.0.0.1:${httpPort}/`)).ok; }
      catch { return false; }
    },
  });
  let client;
  try {
    try { await instance.ready; }
    catch (error) {
      const logs = instance.logs();
      throw new Error(`${error instanceof Error ? error.message : String(error)}\nstdout:\n${logs.stdout}\nstderr:\n${logs.stderr}`);
    }
    client = await connectCdp(cdpPort);
    await waitFor(async () => {
      try {
        return await client.evaluate(`location.origin===${JSON.stringify(`http://127.0.0.1:${httpPort}`)}&&Boolean(window.electronAPI)`);
      } catch { return false; }
    }, { timeoutMs: 20_000, label: "packaged SEC-07 renderer" });
    const result = await client.evaluate(`(async()=>{
      const api=window.electronAPI;
      const reject=async action=>{try{await action();return null}catch(error){return String(error)}};
      const root=await fetch('/');
      window.__sec07InlineScript=false;
      const script=document.createElement('script');script.textContent='window.__sec07InlineScript=true';document.body.appendChild(script);
      window.__sec07InlineHandler=false;
      const button=document.createElement('button');button.setAttribute('onclick','window.__sec07InlineHandler=true');document.body.appendChild(button);button.click();
      const styled=document.createElement('div');styled.setAttribute('style','position:fixed');document.body.appendChild(styled);
      const popup=window.open('https://example.invalid/sec07','_blank');
      window.__sec07MarkdownXss=false;
      const markdownHost=document.createElement('div');
      markdownHost.innerHTML=renderMarkdown('<img src="javascript:alert(1)" onerror="window.__sec07MarkdownXss=true"><a href="java&#x09;script:alert(1)" onclick="window.__sec07MarkdownXss=true">x</a><svg onload="window.__sec07MarkdownXss=true"><circle></circle></svg><math><mtext>x</mtext></math><iframe srcdoc="<script>window.__sec07MarkdownXss=true</script>"></iframe><script>window.__sec07MarkdownXss=true</script>');
      document.body.appendChild(markdownHost);
      let permission='unavailable';try{permission=(await navigator.permissions.query({name:'geolocation'})).state}catch(error){permission=String(error)}
      await new Promise(resolve=>setTimeout(resolve,50));
      const unsafeUrl=Array.from(markdownHost.querySelectorAll('[href],[src]')).some(element=>/^(?:javascript|data):/iu.test((element.getAttribute('href')||element.getAttribute('src')||'').replace(/[\u0000-\u0020\u007f-\u009f]/gu,'')));
      const eventAttribute=Array.from(markdownHost.querySelectorAll('*')).some(element=>Array.from(element.attributes).some(attribute=>attribute.name.toLowerCase().startsWith('on')));
      return {
        keys:Object.keys(api||{}).sort(),
        hasGenericInvoke:Boolean(api?.invoke||api?.send),
        capabilities:await api.capabilities(),
        state:await api.windowState(),
        invalidNotification:await reject(()=>api.notify({id:'../escape',title:'x',body:'y'})),
        extraField:await reject(()=>api.notify({id:'safe',title:'x',body:'y',channel:'shell'})),
        nodeGlobals:[typeof window.require,typeof window.process,typeof window.module],
        csp:root.headers.get('content-security-policy')||'',
        inlineScript:window.__sec07InlineScript,
        inlineHandler:window.__sec07InlineHandler,
        inlineStyle:getComputedStyle(styled).position,
        popupIsNull:popup===null,
        permission,
        markdownXss:window.__sec07MarkdownXss,
        markdownDangerousNodes:markdownHost.querySelectorAll('script,style,iframe,object,embed,svg,math,form,input,button').length,
        markdownEventAttribute:eventAttribute,
        markdownUnsafeUrl:unsafeUrl
      };
    })()`);
    assert.deepEqual(result.keys, expectedKeys);
    assert.equal(result.hasGenericInvoke, false);
    assert.deepEqual(result.capabilities, {
      platform: "win32",
      dialogs: true,
      notifications: true,
      windowControls: true,
      updates: false,
    });
    assert.equal(typeof result.state?.bounds?.width, "number");
    assert.equal(typeof result.state?.bounds?.height, "number");
    assert.match(result.invalidNotification, /Notification id is invalid/u);
    assert.match(result.extraField, /Notification request fields are invalid/u);
    assert.deepEqual(result.nodeGlobals, ["undefined", "undefined", "undefined"]);
    assert.equal(result.inlineScript, false);
    assert.equal(result.inlineHandler, false);
    assert.notEqual(result.inlineStyle, "fixed");
    assert.equal(result.popupIsNull, true);
    assert.equal(result.permission, "denied");
    assert.equal(result.markdownXss, false);
    assert.equal(result.markdownDangerousNodes, 0);
    assert.equal(result.markdownEventAttribute, false);
    assert.equal(result.markdownUnsafeUrl, false);
    assert.doesNotMatch(result.csp, /unsafe-inline|unsafe-eval/u);
    assert.match(result.csp, /script-src 'self'/u);
    assert.match(result.csp, /style-src 'self'/u);
    assert.match(result.csp, /frame-ancestors 'none'/u);
  } finally {
    client?.close();
    await terminateProcessTreeAsync(instance.child).catch(() => undefined);
    await waitFor(() => listenerClosed(httpPort), { timeoutMs: 20_000, label: "DS-02 HTTP shutdown" });
    await waitFor(() => listenerClosed(cdpPort), { timeoutMs: 20_000, label: "DS-02 CDP shutdown" });
    await removeFixture(userData);
  }
});
