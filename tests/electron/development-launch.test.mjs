import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
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
      profiles: { default: { model: "fixture-model", apiKey: "", baseURL: "https://provider.invalid/v1", providerType: "openai-compatible" } },
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
    assert.equal(actual.background, "rgb(246, 245, 241)");
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
    assert.equal(sizing.short.height, 43);
    assert(sizing.multiline.height > sizing.short.height);
    assert.equal(sizing.long.height, 150);
    assert(sizing.long.scrollHeight > sizing.long.clientHeight);
    assert.equal(sizing.empty.height, 43);
    await client.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 780, deviceScaleFactor: 1, mobile: false });
    const narrow = await client.evaluate(`(() => {
      const input = document.getElementById('input'); input.value = '窄窗口长消息'.repeat(100);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const rect = input.getBoundingClientRect();
      return { height: rect.height, left: rect.left, right: rect.right, viewport: innerWidth };
    })()`);
    assert.equal(narrow.height, 150);
    assert(narrow.left >= 0 && narrow.right <= narrow.viewport);
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
