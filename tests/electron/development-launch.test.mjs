import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  boundedFetch, connectCdp, freeDistinctPorts, makeTempDir, projectRoot,
  removeFixture, spawnManaged, terminateProcessTreeAsync, waitFor,
} from "../helpers.mjs";

test("development desktop uses npm Node, loads native storage and renders the working application", { timeout: 90_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-development-launch-");
  const userData = path.join(fixture, "user-data");
  let child;
  let client;
  let logs = "";
  try {
    const [httpPort, cdpPort] = await freeDistinctPorts(2);
    const settings = {
      workspaceRoot: path.join(userData, "workspace"),
      departmentDataRoot: path.join(userData, "department"),
      outputDir: path.join(userData, "output"),
    };
    await Promise.all(Object.values(settings).map(directory => mkdir(directory, { recursive: true })));
    await writeFile(path.join(userData, "config.json"), JSON.stringify({
      defaultProfile: "default",
      profiles: { default: { model: "fixture-model", apiKey: "fixture-only", baseURL: "https://provider.invalid/v1", providerType: "openai-compatible" } },
      settings: { ...settings, defaultPersona: "general" },
    }));
    const env = { ...process.env, npm_node_execpath: process.execPath, PORT: String(httpPort) };
    delete env.RAINYDAYS_E2E_USE_DIST;
    delete env.RAINYDAYS_E2E_NODE_EXECUTABLE;
    delete env.ELECTRON_RUN_AS_NODE;
    child = spawnManaged(path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe"),
      [projectRoot, `--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`, "--disable-gpu"], { env });
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8");
      stream.on("data", chunk => { logs = (logs + chunk).slice(-20_000); });
    }
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`Development desktop exited: ${logs}`);
      try { return (await boundedFetch(`http://127.0.0.1:${httpPort}/`, { signal: AbortSignal.timeout(1_000) })).ok; }
      catch { return false; }
    }, { timeoutMs: 45_000, label: "source desktop service" });
    client = await connectCdp(cdpPort);
    await waitFor(async () => {
      try { return await client.evaluate("Boolean(currentSessionId && document.getElementById('app-version').textContent.includes('v'))"); }
      catch { return false; }
    }, { timeoutMs: 15_000, label: "source desktop renderer" });
    const actual = await client.evaluate(`(async () => {
      const response = await fetch('/api/sessions');
      const icon = document.querySelector('#sidebar svg').getBoundingClientRect();
      return { status: response.status, background: getComputedStyle(document.body).backgroundColor,
        iconWidth: icon.width, iconHeight: icon.height, fileGuide: document.documentElement.classList.contains('file-launch') };
    })()`);
    assert.equal(actual.status, 200);
    assert.equal(actual.background, "rgb(241, 237, 225)");
    assert(actual.iconWidth > 0 && actual.iconWidth <= 40);
    assert.equal(actual.iconWidth, actual.iconHeight);
    assert.equal(actual.fileGuide, false);
    const sizing = await client.evaluate(`(() => {
      const input = document.getElementById('input');
      const measure = value => {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return { height: input.getBoundingClientRect().height, style: input.getAttribute('style'),
          scrollHeight: input.scrollHeight, clientHeight: input.clientHeight };
      };
      return { short: measure('简短消息'), multiline: measure('第一行\\n第二行\\n第三行'),
        long: measure('长内容\\n'.repeat(40)), empty: measure('') };
    })()`);
    for (const size of Object.values(sizing)) assert.equal(size.style, null, "composer must not use inline style");
    const restingHeight = await client.evaluate("document.body.dataset.missionView === 'idle' ? 62 : 43");
    assert.equal(sizing.short.height, restingHeight);
    assert(sizing.multiline.height > sizing.short.height);
    assert.equal(sizing.long.height, 150);
    assert(sizing.long.scrollHeight > sizing.long.clientHeight);
    assert.equal(sizing.empty.height, restingHeight);
    await client.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 1, mobile: false });
    const narrow = await client.evaluate(`(() => {
      const input = document.getElementById('input'); input.value = '窄窗口长消息'.repeat(100);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const rect = input.getBoundingClientRect();
      return { height: rect.height, left: rect.left, right: rect.right, viewport: innerWidth };
    })()`);
    assert.equal(narrow.height, 150);
    assert(narrow.left >= 0 && narrow.right <= narrow.viewport);
    await waitFor(() => client.evaluate("desktopNavigationReady && document.body.dataset.missionView === 'idle'"), { label: "welcome view" });
    const navigation = await client.evaluate(`(() => {
      const button = Array.from(document.querySelectorAll(".sidebar-open")).find(element => element.getClientRects().length);
      if (!button) return false;
      button.focus();
      button.click();
      return true;
    })()`);
    assert.equal(navigation, true, "welcome view exposes the sidebar trigger");
    await waitFor(() => client.evaluate("document.activeElement.classList.contains('sidebar-close') && document.getElementById('main').inert"), { label: "sidebar focus" });
    await client.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await waitFor(() => client.evaluate("document.activeElement.classList.contains('sidebar-open') && !document.getElementById('main').inert"), { label: "sidebar focus restored" });

    await client.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1.25, mobile: false });
    await client.evaluate("newChat()");
    for (const width of [1440, 680]) {
      await client.send("Emulation.setDeviceMetricsOverride", { width, height: 900, deviceScaleFactor: 1.25, mobile: false });
      const welcomeGeometry = await client.evaluate(`(() => {
        const chat = document.getElementById("chat-view");
        const tabs = chat.closest(".workbench-pane").querySelector(".workbench-tabs");
        const stripe = document.getElementById("mission-welcome-stripe").getBoundingClientRect();
        const nav = document.getElementById("mission-welcome-nav").getBoundingClientRect();
        return {
          tabs: tabs.querySelectorAll(".workbench-tab").length,
          tabBottom: tabs.getBoundingClientRect().bottom,
          stripeTop: stripe.top,
          stripeBottom: stripe.bottom,
          navTop: nav.height ? nav.top : null,
        };
      })()`);
      assert.equal(welcomeGeometry.tabs, 2);
      assert(welcomeGeometry.stripeTop >= welcomeGeometry.tabBottom, JSON.stringify(welcomeGeometry));
      if (width === 680) assert(welcomeGeometry.navTop >= welcomeGeometry.stripeBottom, JSON.stringify(welcomeGeometry));
    }

    await client.send("Emulation.setDeviceMetricsOverride", { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
    await client.evaluate(`(() => {
      inputEl.value = "";
      inputEl.dispatchEvent(new Event("input"));
      currentTitleEl.textContent = "整理十月渠道经营数据";
      addMessage("user", "请整理十月各渠道的销售数据，找出异常项，并导出一份可编辑的经营简报。");
      addMessage("assistant", "我会先核对各渠道的统计口径，再按渠道汇总。");
      const token = beginSessionRun(currentSessionId);
      token.runId = "ui-fixture";
      renderTasks([
        {id:"1", subject:"校验资料", status:"completed"},
        {id:"2", subject:"汇总数据", status:"in_progress", activeForm:"核对渠道口径"},
        {id:"3", subject:"复核异常", status:"pending"},
        {id:"4", subject:"导出简报", status:"pending"},
      ]);
    })()`);
    await waitFor(() => client.evaluate(`(() => {
      const band = document.querySelector("#mission-bands i:last-child");
      const current = document.querySelector("#mission-steps [aria-current=step]");
      return current && Math.abs(band.getBoundingClientRect().bottom - current.getBoundingClientRect().top - 11) < 1;
    })()`), { label: "stripe aligned to current step" });
    assert.equal(await client.evaluate("document.getElementById('mission-panel').offsetWidth"), 300);
    assert.equal(await client.evaluate("document.getElementById('mission-status').textContent"), "任务时钟 · 进行中");

    await client.send("Emulation.setDeviceMetricsOverride", { width: 1160, height: 720, deviceScaleFactor: 1, mobile: false });
    assert.deepEqual(await client.evaluate(`(() => ({
      open: taskPanel.open,
      current: document.getElementById("task-current-step").textContent,
      count: document.getElementById("task-progress-text").textContent,
    }))()`), { open: false, current: "进行中 · 汇总数据", count: "已完成 1/4" });
    await client.evaluate("document.getElementById('task-panel-header').click()");
    assert.equal(await client.evaluate("taskPanel.open && taskListEl.children.length === 4 && taskListEl.offsetHeight > 0"), true);
    await client.evaluate("document.getElementById('task-panel-header').click()");
    assert.equal(await client.evaluate("taskPanel.open"), false);

    await client.evaluate(`(() => {
      rememberAskQuestion({sessionId:currentSessionId, runId:"ui-fixture", questionId:"ui-question", question:"允许新建文档？",
        options:["本次任务允许新建文档", "仅这一次", "拒绝执行"]}, currentSessionId);
      refreshQuestionForCurrentSession();
    })()`);
    await waitFor(() => client.evaluate("document.activeElement.classList.contains('ask-option-reject')"), { label: "initial approval focus" });
    assert.deepEqual(await client.evaluate(`(() => ({
      immediate:[...document.querySelectorAll(".ask-immediate button")].map(button => [button.textContent, button.value]),
      scope:[...document.querySelectorAll(".ask-broader button")].map(button => Boolean(document.getElementById(button.getAttribute("aria-describedby")))),
      customOpen:document.getElementById("ask-custom").open,
      status:document.getElementById("task-current-step").textContent,
    }))()`), { immediate: [["仅允许这一次", "仅这一次"], ["拒绝", "拒绝执行"]], scope: [true, true], customOpen: false, status: "等待你批准 · 汇总数据" });
    await client.evaluate(`(() => {
      questionsBySession.delete(currentSessionId);
      refreshQuestionForCurrentSession();
      renderTasks(missionTasks.map(task => ({...task, status:"completed"})));
      const token = activeRunsBySession.get(currentSessionId);
      token.outcome = "completed";
      finishSessionRun(currentSessionId, token);
    })()`);
    assert.equal(await client.evaluate("document.getElementById('mission-status').textContent"), "任务时钟 · 已完成");
    assert.equal(await client.evaluate("document.getElementById('task-progress-text').textContent"), "已完成 4/4");
    await client.send("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await waitFor(() => client.evaluate(`(() => {
      const band = document.querySelector("#mission-bands i:last-child");
      const last = document.querySelector("#mission-steps li:last-child");
      return last && Math.abs(band.getBoundingClientRect().bottom - last.getBoundingClientRect().top - 11) < 1;
    })()`), { label: "stripe aligned to final completed step" });
    await client.evaluate(`(() => {
      const token = beginSessionRun(currentSessionId);
      token.outcome = "failed";
      finishSessionRun(currentSessionId, token);
    })()`);
    assert.equal(await client.evaluate("document.getElementById('mission-status').textContent"), "任务时钟 · 执行失败");
    assert.equal((await boundedFetch(`http://127.0.0.1:${httpPort}/api/sessions`)).status, 401);
    assert.doesNotMatch(logs, /ERR_DLOPEN_FAILED|NODE_MODULE_VERSION|EPIPE/u);
  } catch (error) {
    throw new Error(`${error.message}\n${logs}`, { cause: error });
  } finally {
    client?.close();
    if (child) await terminateProcessTreeAsync(child);
    await removeFixture(fixture);
  }
});

for (const launcher of ["simple", "powershell"]) {
  test(`demo desktop ${launcher} launcher starts from a non-npm environment`, { timeout: 90_000 }, async () => {
    const fixture = await makeTempDir("mini-lux-demo-launch-");
    const userData = path.join(fixture, "user-data");
    let child, client, logs = "";
    try {
      const [httpPort, cdpPort] = await freeDistinctPorts(2);
      const settings = { workspaceRoot:path.join(userData,"workspace"), departmentDataRoot:path.join(userData,"department"), outputDir:path.join(userData,"output") };
      await Promise.all(Object.values(settings).map(directory => mkdir(directory,{recursive:true})));
      await writeFile(path.join(userData,"config.json"),JSON.stringify({defaultProfile:"default",profiles:{default:{model:"fixture-model",apiKey:"",baseURL:"https://provider.invalid/v1",providerType:"openai-compatible"}},settings:{...settings,defaultPersona:"general"}}));
      const env={...process.env,PORT:String(httpPort),APPDATA:fixture};
      for(const key of ["npm_node_execpath","RAINYDAYS_E2E_USE_DIST","RAINYDAYS_E2E_NODE_EXECUTABLE","ELECTRON_RUN_AS_NODE"])delete env[key];
      const electronArgs=[`--user-data-dir=${userData}`,`--remote-debugging-port=${cdpPort}`,"--disable-gpu"];
      if(launcher==="simple"){
        const batch=path.join(projectRoot,"演示啟動（簡易）RainyDays.cmd");
        const command=`"${batch}" ${electronArgs.map(argument=>`"${argument}"`).join(" ")}`;
        child=spawnManaged("cmd.exe",["/d","/s","/c",`"${command}"`],{env,windowsVerbatimArguments:true});
      }else{
        assert.match(await readFile(path.join(projectRoot,"演示啟動 RainyDays.cmd"),"utf8"),/deliverables\\demo-tools\\start-demo\.ps1/u);
        child=spawnManaged("powershell.exe",["-NoProfile","-ExecutionPolicy","Bypass","-File",path.join(projectRoot,"deliverables/demo-tools/start-demo.ps1"),...electronArgs],{env});
      }
      for(const stream of [child.stdout,child.stderr]){stream.setEncoding("utf8");stream.on("data",chunk=>{logs=(logs+chunk).slice(-12_000);});}
      await waitFor(async()=>{
        if(child.exitCode!==null)throw new Error(`Launcher exited: ${logs}`);
        try{return(await boundedFetch(`http://127.0.0.1:${httpPort}/`,{signal:AbortSignal.timeout(1_000)})).ok;}catch{return false;}
      },{timeoutMs:55_000,label:`${launcher} source service`});
      client=await connectCdp(cdpPort);
      await waitFor(async()=>{try{return await client.evaluate("Boolean(desktopNavigationReady && currentSessionId)");}catch{return false;}},{timeoutMs:15_000,label:"demo working UI"});
      assert.equal(await client.evaluate("fetch('/api/sessions').then(r=>r.status)"),200);
      assert.equal((await boundedFetch(`http://127.0.0.1:${httpPort}/api/sessions`)).status,401);
      assert.doesNotMatch(logs,/NODE_MODULE_VERSION|ERR_DLOPEN_FAILED/u);
    }finally{
      client?.close();if(child)await terminateProcessTreeAsync(child);await removeFixture(fixture);
    }
  });
}
