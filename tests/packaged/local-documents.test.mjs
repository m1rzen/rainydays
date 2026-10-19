import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { boundedFetch, connectCdp, freeDistinctPorts, makeTempDir, projectRoot, removeFixture, terminateProcessTreeAsync, waitFor, waitForChildExit } from "../helpers.mjs";
import { launchTracked } from "./smoke-helpers.mjs";

test("D13 packaged app reads local input, creates and reopens DOCX without developer PATH", { timeout: 180_000, skip: process.platform !== "win32" }, async () => {
  const fixture = await makeTempDir("rainydays-d13-package-");
  const userData = path.join(fixture, "中文 用户资料");
  const workspace = path.join(fixture, "中文 工作资料");
  const output = path.join(fixture, "中文 成果");
  const documentPath = path.join(output, "资料简报.docx");
  await Promise.all([userData, workspace, output].map(dir => mkdir(dir)));
  await writeFile(path.join(workspace, "输入.txt"), "D13唯一核对事实：57");
  let stage = 0, modelFailure = null, instance, client;
  const call = (name, args) => [{ index: 0, id: `d13-${stage}`, type: "function", function: { name, arguments: JSON.stringify(args) } }];
  const server = createServer(async (request, response) => {
    try {
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (!body.stream) { response.setHeader("Content-Type", "application/json"); response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "本地文档核对" }, finish_reason: "stop" }] })); return; }
      let calls;
      if (stage === 0) calls = call("read", { file_path: path.join(workspace, "输入.txt") });
      if (stage === 1) {
        assert.match(JSON.stringify(body.messages), /D13唯一核对事实：57/);
        calls = call("create_docx", { path: "资料简报.docx", title: "资料核对", paragraphs: ["D13唯一核对事实：57。来源：输入.txt。"] });
      }
      if (stage === 3) calls = call("read", { file_path: documentPath });
      if (stage === 4) assert.match(JSON.stringify(body.messages.filter(message => message.role === "tool").at(-1)), /D13唯一核对事实：57/);
      stage++;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: calls ? { tool_calls: calls } : { content: "已核对57，成果可以继续使用。" }, finish_reason: null }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: calls ? "tool_calls" : "stop" }] })}\n\n`);
      response.end("data: [DONE]\n\n");
    } catch (error) { modelFailure = error; response.statusCode = 500; response.end(String(error)); }
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  await writeFile(path.join(userData, "config.json"), JSON.stringify({ defaultProfile: "default", profiles: { default: {
    model: "isolated-fixture", apiKey: "fixture-only", baseURL: `http://127.0.0.1:${server.address().port}/v1`, providerType: "openai-compatible",
  } }, settings: { defaultPersona: "general", workspaceRoot: workspace, outputDir: output, departmentDataRoot: "", departmentEnabled: false } }));
  const executable = path.resolve(process.env.RAINYDAYS_D13_EXECUTABLE || path.join(projectRoot, "release", "win-unpacked", "RainyDays.exe"));
  const readyTimes = [];
  async function launch() {
    const [httpPort, cdpPort] = await freeDistinctPorts(2);
    const systemDir = path.join(process.env.SystemRoot, "System32");
    const env = { ...process.env, PORT: String(httpPort), PATH: systemDir, NODE_PATH: "", npm_node_execpath: "", npm_execpath: "", RAINYDAYS_ALLOW_LOOPBACK_HTTP_PROVIDER: "1" };
    delete env.ELECTRON_RUN_AS_NODE; delete env.RAINYDAYS_E2E_NODE_EXECUTABLE; delete env.RAINYDAYS_E2E_USE_DIST;
    const started = Date.now();
    instance = launchTracked(executable, [`--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`, "--disable-gpu"], {
      env, cwd: systemDir, timeoutMs: 45000, label: "D13 packaged local service", readyProbe: async () => (await boundedFetch(`http://127.0.0.1:${httpPort}/`).catch(()=>null))?.ok === true,
    });
    await instance.ready; client = await connectCdp(cdpPort);
    await waitFor(() => client.evaluate("Boolean(desktopNavigationReady && currentSessionId)"), { timeoutMs: 20000, label: "D13 packaged local workbench" });
    readyTimes.push(Date.now() - started);
  }
  async function stop() {
    const closing = client.send("Browser.close").catch(()=>undefined);
    assert.equal(await waitForChildExit(instance.child, 20000), true, "packaged application must exit cleanly");
    client.close(); client = null; await closing; instance = null;
  }
  const send = text => client.evaluate(`(() => { inputEl.value=${JSON.stringify(text)}; inputEl.dispatchEvent(new Event('input')); document.getElementById('input-form').requestSubmit(); return true; })()`);
  try {
    await launch();
    await send("读取输入.txt并生成一份Word简报");
    await waitFor(() => client.evaluate("document.getElementById('ask-modal').classList.contains('visible')"), { timeoutMs: 30000, label: "D13 document consent" });
    assert.equal(await client.evaluate("(() => { const button=[...document.querySelectorAll('#ask-options button')].find(button=>button.textContent==='本次任务允许新建文档'); button?.click(); return Boolean(button); })()"), true);
    await waitFor(() => client.evaluate("!isSessionRunning() && document.querySelectorAll('.document-output-row .local-file-link').length===1"), { timeoutMs: 30000, label: "D13 packaged document" });
    assert.equal(modelFailure, null);
    const original = await readFile(documentPath);
    assert.equal(original.subarray(0, 2).toString(), "PK");
    await stop(); await launch();
    await waitFor(() => client.evaluate("document.querySelectorAll('.document-output-row .local-file-link').length===1"), { timeoutMs: 10000, label: "D13 restored output" });
    await client.evaluate("document.querySelector('.document-output-row .local-file-link').click(); true");
    await waitFor(() => client.evaluate("document.getElementById('file-preview-content').textContent.includes('D13唯一核对事实：57')"), { timeoutMs: 15000, label: "D13 packaged parser worker preview" });
    await client.evaluate("selectWorkbenchTab(workbenchPanes().flatMap(pane=>pane.tabs).find(tab=>tab.kind==='session').id).then(()=>true)");
    await send("重新读取简报，核对其中的事实");
    await waitFor(() => client.evaluate("!isSessionRunning() && [...document.querySelectorAll('#messages .msg-assistant .bubble')].at(-1)?.textContent.includes('已核对57')"), { timeoutMs: 30000, label: "D13 reopened document read" });
    assert.equal(stage, 5); assert.equal(modelFailure, null);
    assert.deepEqual(await readFile(documentPath), original);
    console.log(`[D13] packaged no developer PATH, normal starts: ${readyTimes.join(', ')}ms; DOCX/parser/restart passed`);
    await stop();
  } catch (error) {
    throw new Error(`${error.message}\nstage=${stage}, model=${modelFailure?.message || 'ok'}\n${JSON.stringify(instance?.logs())}`, { cause: error });
  } finally {
    client?.close(); if (instance) await terminateProcessTreeAsync(instance.child);
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await removeFixture(fixture);
  }
});
