import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-tool04-native-"));
const dataDir = path.join(fixture, "data");
const workspace = path.join(fixture, "workspace");
const nested = path.join(workspace, "nested");
const outside = path.join(fixture, "outside.txt");
await Promise.all([fs.mkdir(dataDir, { recursive: true }), fs.mkdir(nested, { recursive: true })]);
await Promise.all([
  fs.writeFile(path.join(workspace, "root.txt"), "root-only", "utf8"),
  fs.writeFile(path.join(nested, "input.json"), JSON.stringify({ values: [3, 5, 8, 13] }), "utf8"),
  fs.writeFile(outside, "outside-secret", "utf8"),
]);
await Promise.all([
  fs.symlink(workspace, path.join(nested, "escape-link"), "junction"),
  fs.link(path.join(workspace, "root.txt"), path.join(nested, "hardlink-root.txt")),
]);
Object.assign(process.env, {
  RAINYDAYS_APP_ROOT: projectRoot,
  RAINYDAYS_USER_DATA_DIR: fixture,
  RAINYDAYS_DATA_DIR: dataDir,
  RAINYDAYS_CONFIG_PATH: path.join(fixture, "config.json"),
  RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"),
  RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"),
});

const credentialStore = await import("../../dist/credential-store.js");
credentialStore.configureCredentialProtector({
  protect: plaintext => Buffer.from(plaintext, "utf8"),
  unprotect: ciphertext => Buffer.from(ciphertext).toString("utf8"),
});
const [
  config,
  personaModule,
  sessionModule,
  dbModule,
  tools,
  pathRuntime,
  executionRuntime,
] = await Promise.all([
  import("../../dist/config.js"),
  import("../../dist/persona.js"),
  import("../../dist/session.js"),
  import("../../dist/db.js"),
  import("../../dist/tools/index.js"),
  import("../../dist/path-runtime.js"),
  import("../../dist/execution-runtime.js"),
]);

let authority;
let rootContext;

async function approvedScript(args) {
  const inspected = tools.inspectToolCall(rootContext, "script", args);
  const challenge = tools.capabilityBroker.createApprovalChallenge(rootContext, inspected);
  const grant = tools.capabilityBroker.resolveApprovalChallenge({
    challengeId: challenge.challengeId,
    choice: "approve",
    sessionId: rootContext.sessionId,
    runId: rootContext.runId,
    responsePrincipal: "local-user-api",
    responseChannel: "native-process",
  });
  assert(grant, "script approval grant must be issued");
  try { return await tools.executeInspectedTool(grant, inspected); }
  finally { tools.capabilityBroker.finishContext(grant); }
}

test.before(async () => {
  await config.initializeConfig();
  const persona = personaModule.createEffectivePersona({
    name: "tool04-native",
    displayName: "TOOL-04 Native",
    description: "isolated script runtime fixture",
    tools: ["script"],
    env: { WORKSPACE_ROOT: workspace },
    allowedRoots: [workspace],
    networkPolicy: { mode: "unrestricted" },
    systemPrompt: "TOOL-04 native fixture",
  });
  const pathAuthority = await pathRuntime.pathPolicy.createAuthority([{
    rootId: "workspace",
    role: "workspace",
    configuredPath: workspace,
    permissions: ["initial-cwd"],
  }]);
  authority = tools.capabilityBroker.createRuntimeAuthority({
    name: persona.name,
    tools: persona.tools,
    env: persona.env,
    systemPrompt: persona.systemPrompt,
    allowedRoots: persona.allowedRoots,
    rootEnv: { WORKSPACE_ROOT: "workspace" },
    pathAuthority,
    networkPolicy: persona.networkPolicy,
    digest: persona.digest,
  });
  const session = sessionModule.createSession(persona, "TOOL-04 native");
  rootContext = tools.capabilityBroker.beginAgentRun(authority, session.id);
});

test.after(async () => {
  if (rootContext) tools.capabilityBroker.finishContext(rootContext);
  if (authority) await tools.capabilityBroker.retireAuthority(authority).catch(() => undefined);
  await executionRuntime.shutdownExecutionRuntime().catch(() => undefined);
  dbModule.closeDb();
  await fs.rm(fixture, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("TOOL-04 real E3 runs Node ESM JSON/regex with explicit cwd and lux bridge", { timeout: 60_000 }, async () => {
  const output = await approvedScript({
    lang: "node",
    cwd: "nested",
    timeout: 5_000,
    code: `
console.log("bridge-start", Object.isFrozen(lux), lux.cwd);
const input = await lux.readJson("input.json");
const selected = input.values.filter(value => /^(3|8|13)$/.test(String(value)));
await lux.writeJson("bridge.json", { selected, cwd: lux.cwd });
console.log("bridge-result", JSON.stringify({ selected, reread: await lux.readJson("bridge.json") }));`,
  });
  assert.match(output, /bridge-start true/u);
  const resultLine = output.split(/\r?\n/u).find(line => line.startsWith("bridge-result "));
  assert(resultLine, output);
  const parsed = JSON.parse(resultLine.slice("bridge-result ".length));
  assert.deepEqual(parsed.selected, [3, 8, 13]);
  assert.deepEqual(parsed.reread.selected, [3, 8, 13]);
  assert.equal(path.basename(parsed.reread.cwd), "nested");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(nested, "bridge.json"), "utf8")).selected, [3, 8, 13]);
});

test("TOOL-04 real E3 runs node-cjs require in the same sandbox", { timeout: 60_000 }, async () => {
  const output = await approvedScript({
    lang: "node-cjs",
    cwd: "nested",
    code: `const path = require("node:path"); console.log(path.basename(process.cwd()), Object.isFrozen(lux));`,
  });
  assert.match(output, /nested true/u);
});

test("TOOL-04 lux bridge and Node permission model reject cwd/root escape", { timeout: 90_000 }, async () => {
  await assert.rejects(
    () => approvedScript({ lang: "node", cwd: "nested", code: `await lux.readText("../root.txt");` }),
    /lux bridge path escapes cwd/u,
  );
  await assert.rejects(
    () => approvedScript({ lang: "node", cwd: "nested", code: `await lux.readText("escape-link/root.txt");` }),
    /lux bridge path escapes cwd through a link/u,
  );
  await assert.rejects(
    () => approvedScript({ lang: "node", cwd: "nested", code: `await lux.readText("hardlink-root.txt");` }),
    /hardlinked|permission|access|denied|EPERM/iu,
  );
  assert.match(
    await approvedScript({ lang: "node", cwd: "nested", code: `console.log(typeof __luxReadFile, typeof __luxResolve);` }),
    /undefined undefined/u,
  );
  for (const target of ["../root.txt", "escape-link/root.txt", "hardlink-root.txt"]) {
    await assert.rejects(
      () => approvedScript({ lang: "node", cwd: "nested", code: `import { readFile } from "node:fs/promises"; await readFile(${JSON.stringify(target)}, "utf8");` }),
      /permission|access|denied|ERR_ACCESS_DENIED|EPERM/iu,
    );
  }
  await assert.rejects(
    () => approvedScript({ lang: "node", cwd: "nested", code: `import { readFile } from "node:fs/promises"; await readFile(${JSON.stringify(outside)}, "utf8");` }),
    /permission|access|denied|ERR_ACCESS_DENIED/iu,
  );
});

test("TOOL-04 preserves child failures that collide with native status codes", { timeout: 60_000 }, async () => {
  await assert.rejects(
    () => approvedScript({ lang: "node", cwd: "nested", code: `process.exit(80);` }),
    error => {
      assert.match(error.message, /child-failed/u);
      assert.doesNotMatch(error.message, /EXEC_LIMIT_WALL/u);
      return true;
    },
  );
});

test("TOOL-04 real E3 enforces timeout in the native Job and settles the tree", { timeout: 60_000 }, async () => {
  const started = Date.now();
  await assert.rejects(
    () => approvedScript({ lang: "node", cwd: "nested", timeout: 300, code: `for (;;) {}` }),
    /execution|time|limit|terminated|代码执行出错/iu,
  );
  assert(Date.now() - started < 10_000, "native timeout must settle promptly");
  assert.match(await approvedScript({ lang: "node", cwd: "nested", code: `console.log("after-timeout")` }), /after-timeout/u);
});

test("TOOL-04 real E3 fails closed when aggregate output exceeds the bound", { timeout: 60_000 }, async () => {
  await assert.rejects(
    () => approvedScript({ lang: "node", cwd: "nested", code: `console.log("x".repeat(1100000));` }),
    /output|limit|代码执行出错/iu,
  );
});
