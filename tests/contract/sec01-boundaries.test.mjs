import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { collectSourceFiles, toPosix } from "../../scripts/build-inputs.mjs";
import { projectRoot } from "../helpers.mjs";
import { assertSec01Probe } from "../sec01-probe.mjs";

async function source(relative) {
  return readFile(path.join(projectRoot, ...relative.split("/")), "utf8");
}

function namesFromPolicyBlock(text, exportName) {
  const start = text.indexOf(`export const ${exportName}`);
  assert(start >= 0, `${exportName} block missing`);
  const end = text.indexOf("});", start);
  assert(end > start, `${exportName} block terminator missing`);
  return [...text.slice(start, end).matchAll(/^\s{2}(?:"([^"]+)"|([a-z0-9_]+)):\s*policy/gm)]
    .map((match) => match[1] ?? match[2]);
}

async function verifyPolicyRegistryBoundary() {
  const [registry, policies] = await Promise.all([
    source("src/tools/index.ts"),
    source("src/tool-policies.ts"),
  ]);
  const staticBlock = registry.slice(registry.indexOf("const rawStaticTools"), registry.indexOf("const staticNames"));
  const staticNames = [...staticBlock.matchAll(/\{ name:\s*"([a-z0-9_]+)"/g)].map((match) => match[1]);
  const staticPolicies = namesFromPolicyBlock(policies, "STATIC_TOOL_POLICIES");
  const runtimePolicies = namesFromPolicyBlock(policies, "RUNTIME_TOOL_POLICIES");

  assert.equal(staticNames.length, 48);
  assert.equal(runtimePolicies.length, 10);
  assert.deepEqual([...staticNames].sort(), [...staticPolicies].sort());
  assert.equal(new Set([...staticNames, ...runtimePolicies]).size, 58);
  assert.match(registry, /registerDynamicTool\(authority: RuntimeAuthority/);
  assert.doesNotMatch(registry, /registerRuntimeTool\([^,]+,\s*tool\)(?![\s\S]*policy)/);
  return true;
}

async function verifyDispatcherBoundary() {
  const [dispatcher, agent, subagent, playbook, searchTools] = await Promise.all([
    source("src/tools/index.ts"),
    source("src/agent.ts"),
    source("src/subagent.ts"),
    source("src/playbook.ts"),
    source("src/tools/phase1-tools.ts"),
  ]);

  assert.match(dispatcher, /export async function executeTool\(\s*context: CapabilityContext,/);
  assert.doesNotMatch(dispatcher, /executeTool\(\s*name:\s*string/);
  assert.doesNotMatch(`${agent}\n${subagent}\n${playbook}`, /getToolDefinitions\(persona\.tools\)/);
  assert.doesNotMatch(`${agent}\n${subagent}\n${playbook}`, /catch\s*\{\s*[a-zA-Z]+\s*=\s*\{\};?\s*\}/);
  assert.doesNotMatch(subagent, /from\s+"\.\/tools\/index\.js"/);
  assert.doesNotMatch(playbook, /from\s+"\.\/tools\/index\.js"/);
  assert.match(agent, /inspectToolCall\(capabilityContext,/);
  assert.match(agent, /createApprovalChallenge\(capabilityContext,/);
  assert.match(searchTools, /invocation\.listCurrentToolDefinitions\(\)/);
  assert.doesNotMatch(searchTools, /getAllToolNames/);
  return true;
}

async function verifySupervisorBoundary() {
  const advanced = await source("src/tools/advanced-tools.ts");
  const section = advanced.slice(advanced.indexOf("export const superviseDef"), advanced.indexOf("// ==========", advanced.indexOf("export const superviseDef") + 20));
  assert.match(section, /Agent 无权开启、关闭或修改 Supervisor/);
  assert.doesNotMatch(section, /enableSupervisor|disableSupervisor|setSupervisorRules/);
  assert.doesNotMatch(section, /enum:\s*\["on",\s*"off"/);
  return true;
}

async function verifyTerminalFacadeBoundary() {
  const index = await source("src/index.ts");
  const operations = [
    "file:reveal", "terminal:list", "terminal:start", "terminal:output", "terminal:input",
    "terminal:clear", "terminal:kill", "terminal:close", "terminal:subscribe",
  ];
  for (const operation of operations) {
    assert.equal(index.split(`runDirectOperation("${operation}"`).length - 1, 1, `${operation} must have one facade call`);
  }

  for (const match of index.matchAll(/terminalFacade\.(list|start|output|input|get|clear|kill|close|subscribe)\(/g)) {
    const routeStart = index.lastIndexOf("app.", match.index);
    const local = index.slice(routeStart, match.index);
    assert(local.includes("runDirectOperation("), `${match[0]} bypasses direct-operation authorization`);
  }
  assert.match(index, /terminalFacade\.disposeAllForShutdown\(\)/);
  assert.doesNotMatch(index, /terminalManager/);

  const [terminalTools, terminalFacade] = await Promise.all([
    source("src/tools/terminal-tools.ts"),
    source("src/terminal-facade.ts"),
  ]);
  assert.match(terminalTools, /function terminalOwner\(invocation\?/);
  assert.match(terminalTools, /return invocation\.resourceOwner/);
  assert.doesNotMatch(terminalTools, /terminalManager/);
  assert.match(terminalTools, /invocation\.path\.withInitialCwd\([\s\S]*terminalFacade\.start\(terminalOwner\(invocation\),/);
  assert.doesNotMatch(terminalTools, /\{\s*sessionId\s*:[\s\S]*principal\s*:/);
  assert.match(index, /withDirectInitialCwd\([\s\S]*"terminal:start"[\s\S]*terminalFacade\.start\(owner,/);
  assert.match(terminalFacade, /export\s*\{\s*terminalFacade\s*\}\s*from "\.\/terminal\.js"/);
  assert.doesNotMatch(terminalFacade, /TerminalManager|terminalManager/);

  const terminalSource = await source("src/terminal.ts");
  assert.match(terminalSource, /class\s+TerminalManager\s*\{/);
  assert.match(terminalSource, /const\s+terminalManager\s*=\s*new\s+TerminalManager\(\)/);
  assert.doesNotMatch(terminalSource, /export\s+(?:class|const)\s+(?:TerminalManager|terminalManager)/);
  for (const absolute of await collectSourceFiles(projectRoot)) {
    const relative = toPosix(path.relative(projectRoot, absolute));
    if (!relative.startsWith("src/") || !relative.endsWith(".ts") || relative === "src/terminal.ts") continue;
    const text = await readFile(absolute, "utf8");
    assert.doesNotMatch(text, /\b(?:TerminalManager|terminalManager)\b/, `${relative} references raw Terminal manager`);
  }
  return true;
}

test("SEC-01 static and runtime tool policy manifests exactly cover the registry", verifyPolicyRegistryBoundary);
test("SEC-01 has one context-required dispatcher and no legacy Persona execution path", verifyDispatcherBoundary);
test("SEC-01 model Supervisor control is status-only", verifySupervisorBoundary);
test("SEC-01 direct Terminal and reveal routes invoke managers only inside Broker facades", verifyTerminalFacadeBoundary);

test("SEC-01 complete static source boundaries remain closed", async () => {
  const state = {
    policyRegistry: await verifyPolicyRegistryBoundary(),
    dispatcher: await verifyDispatcherBoundary(),
    supervisor: await verifySupervisorBoundary(),
    terminalFacade: await verifyTerminalFacadeBoundary(),
  };
  const expected = { policyRegistry: true, dispatcher: true, supervisor: true, terminalFacade: true };
  assertSec01Probe("SEC01-A31", "static-boundary-state", state, expected);
});
