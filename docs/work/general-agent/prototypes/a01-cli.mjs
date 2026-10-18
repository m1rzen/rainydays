// Throwaway A01 probe: actual Broker/native E1, only disposable projects and test credentials.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "rainydays-a01-cli-"));
const workspace = path.join(root, "workspace");
await fs.mkdir(workspace);
const project = path.resolve(import.meta.dirname, "../../../..");
Object.assign(process.env, { RAINYDAYS_APP_ROOT: project, RAINYDAYS_USER_DATA_DIR: root,
  RAINYDAYS_DATA_DIR: path.join(root, "data"), RAINYDAYS_CONFIG_PATH: path.join(root, "config.json"),
  RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(project, "personas"), RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(project, "skills") });
const load = name => import(pathToFileURL(path.join(project, "dist", name + ".js")));
const credentials = await load("credential-store");
credentials.configureCredentialProtector({ protect: value => Buffer.from(value), unprotect: value => Buffer.from(value).toString() });
const config = await load("config"), personas = await load("persona"), sessions = await load("session"), db = await load("db");
const tools = await load("tools/index"), { pathPolicy } = await load("path-runtime"), execution = await load("execution-runtime");
let authority, context;
try {
  await config.initializeConfig();
  const persona = personas.createEffectivePersona({ name: "a01-cli", displayName: "A01", description: "test",
    tools: ["execute_command", "script"], env: { WORKSPACE_ROOT: workspace }, allowedRoots: [workspace], networkPolicy: { mode: "unrestricted" }, systemPrompt: "test" });
  const pathAuthority = await pathPolicy.createAuthority([{ rootId: "workspace", role: "workspace", configuredPath: workspace, permissions: ["initial-cwd"] }]);
  authority = tools.capabilityBroker.createRuntimeAuthority({ name: persona.name, tools: persona.tools, env: persona.env,
    systemPrompt: persona.systemPrompt, allowedRoots: persona.allowedRoots, rootEnv: { WORKSPACE_ROOT: "workspace" },
    pathAuthority, networkPolicy: persona.networkPolicy, digest: persona.digest });
  const session = sessions.createSession(persona, "A01 CLI");
  context = tools.capabilityBroker.beginAgentRun(authority, session.id);
  async function invoke(name, args) {
    const inspected = tools.inspectToolCall(context, name, args);
    const challenge = tools.capabilityBroker.createApprovalChallenge(context, inspected);
    const grant = tools.capabilityBroker.resolveApprovalChallenge({ challengeId: challenge.challengeId, choice: "approve",
      sessionId: context.sessionId, runId: context.runId, responsePrincipal: "local-user-api", responseChannel: "native-process" });
    assert(grant);
    try { return await tools.executeInspectedTool(grant, inspected); }
    finally { tools.capabilityBroker.finishContext(grant); }
  }
  const command = value => invoke("execute_command", { command: value });
  const script = () => invoke("script", { lang: "node", code: `await import(${JSON.stringify(pathToFileURL(path.join(workspace, "sum.test.mjs")).href)});console.log('MODULE_TEST_PASSED');` });
  const builtin = await command("echo A01_PIPE_OK");
  await fs.writeFile(path.join(workspace, "sum.mjs"), "export const sum=(a,b)=>a-b;\n");
  await fs.writeFile(path.join(workspace, "sum.test.mjs"), "import assert from 'node:assert/strict';import{sum}from'./sum.mjs';assert.equal(sum(3,5),8);\n");
  let failed, moduleFailure;
  const node = `call "${process.execPath}" --test sum.test.mjs`;
  try { await command(node); } catch (error) { failed = error.message; }
  try { await script(); } catch (error) { moduleFailure = error.message; }
  assert(failed, "broken project must fail");
  await fs.writeFile(path.join(workspace, "sum.mjs"), "export const sum=(a,b)=>a+b;\n");
  let nodePass, nodeError;
  try { nodePass = await command(node); } catch (error) { nodeError = error.message; }
  let modulePass, correctedModuleError;
  if (/AssertionError|ERR_ASSERTION/u.test(moduleFailure || "")) {
    try { modulePass = await script(); } catch (error) { correctedModuleError = error.message; }
  }
  await fs.writeFile(path.join(workspace, "test_sum.py"), "import unittest\nclass Sum(unittest.TestCase):\n def test_sum(self): self.assertEqual(sum([3,5,13]),21)\nunittest.main()\n");
  let pythonPass, pythonError;
  try { pythonPass = await command('call "C:\\Python314\\python.exe" -I test_sum.py'); } catch (error) { pythonError = error.message; }
  console.log(JSON.stringify({ builtin: /A01_PIPE_OK/u.test(builtin), nodeModuleViaE3: {
    failedAssertionThenPassed: Boolean(modulePass && /MODULE_TEST_PASSED/u.test(modulePass)),
    failure: (correctedModuleError || moduleFailure || "").slice(0, 800) },
    node: { initialCommandFailed: true, correctedCommandPass: Boolean(nodePass), output: nodePass ?? nodeError },
    python: { passed: Boolean(pythonPass), output: pythonPass ?? pythonError } }, null, 2));
} finally {
  if (context) tools.capabilityBroker.finishContext(context);
  if (authority) await tools.capabilityBroker.retireAuthority(authority);
  await execution.shutdownExecutionRuntime(); db.closeDb();
  assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
  assert(path.basename(root).startsWith("rainydays-a01-cli-"));
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
