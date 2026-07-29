import assert from "node:assert/strict";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import {
  CapabilityBroker,
  CapabilityDeniedError,
  canonicalDigest,
} from "../../dist/capability-broker.js";
import { PathPolicy } from "../../dist/path-policy.js";
import { assertResourceOwner, registerOwnedResource } from "../../dist/resource-owner.js";
import { assertSec01Probe } from "../sec01-probe.mjs";
import { createSec02Recorder } from "../sec02-receipts.mjs";

const brokerPathFixture = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec02-broker-unit-"));
await fs.writeFile(path.join(brokerPathFixture, "inside.txt"), "inside");
const brokerPathPolicy = new PathPolicy({ auditKey: Buffer.alloc(32, 31) });
const brokerBasePathAuthority = await brokerPathPolicy.createAuthority([{
  rootId: "workspace",
  role: "workspace",
  configuredPath: brokerPathFixture,
  permissions: ["read-file", "read-directory", "search-tree", "create-file", "replace-file"],
}]);
after(async () => fs.rm(brokerPathFixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));

const p33SubsetRecorder = await createSec02Recorder(import.meta.url, "SEC-02 child PathAuthority and ResourceOwner preserve only the exact root subset");
const p33SameStringRecorder = await createSec02Recorder(import.meta.url, "SEC-02 same configured root string cannot substitute a new filesystem identity");
const p33ReplacementRecorder = await createSec02Recorder(import.meta.url, "SEC-02 Broker gateway denies root object replacement during an in-flight read");
const p33FallbackRecorder = await createSec02Recorder(import.meta.url, "SEC-02 attenuated child gateway cannot fall back to broader parent roots");
const sessionLeaseRecorder = await createSec02Recorder(import.meta.url, "SEC-02 Session deletion closes PathPolicy leases before removing the session identity");
after(async () => {
  await p33SubsetRecorder.close();
  await p33SameStringRecorder.close();
  await p33ReplacementRecorder.close();
  await p33FallbackRecorder.close();
  await sessionLeaseRecorder.close();
});
const pathAuditKeys = ["authorityEpoch", "code", "event", "inputFingerprint", "operation", "operationId", "principal", "rootId", "runId", "sessionId", "timestamp"].sort();

function createBroker(options) {
  return new CapabilityBroker({ ...options, pathPolicy: brokerPathPolicy });
}

function authorityInput(input) {
  const usesWorkspace = Array.isArray(input.allowedRoots) && input.allowedRoots.length > 0;
  return {
    ...input,
    rootEnv: usesWorkspace && Object.hasOwn(input.env ?? {}, "WORKSPACE_ROOT") ? { WORKSPACE_ROOT: "workspace" } : {},
    pathAuthority: brokerPathPolicy.deriveAuthority(brokerBasePathAuthority, usesWorkspace ? ["workspace"] : []),
  };
}

function createAuthority(broker, input) {
  return broker.createRuntimeAuthority(authorityInput(input));
}

const readPolicy = Object.freeze({ riskClasses: ["read"], approval: "none", effects: [] });
const filesystemReadPolicy = Object.freeze({ riskClasses: ["read"], approval: "none", effects: ["filesystem"], pathOperations: ["read-file"] });
const filesystemWritePolicy = Object.freeze({ riskClasses: ["write"], approval: "none", effects: ["filesystem"], pathOperations: ["create-file", "replace-file"] });
const writePolicy = Object.freeze({ riskClasses: ["write"], approval: "user", effects: ["filesystem"] });
const networkPolicy = Object.freeze({ riskClasses: ["network"], approval: "none", effects: ["network"] });
const approvalResponse = Object.freeze({ responsePrincipal: "local-user-api", responseChannel: "ask-user" });

function definition(name, description = name) {
  return {
    type: "function",
    function: {
      name,
      description,
      parameters: { type: "object", properties: { value: { type: "string" } } },
    },
  };
}

function registered(name, policy = readPolicy, marker = name) {
  const counter = { calls: 0 };
  const tool = {
    name,
    definition: definition(name),
    policy,
    executor: async () => {
      counter.calls += 1;
      return marker;
    },
  };
  return { tool, counter };
}

function expectCode(fn, code) {
  let observed = null;
  assert.throws(fn, (error) => {
    observed = error instanceof CapabilityDeniedError ? error.code : null;
    return observed === code;
  });
  return observed;
}


function fixture(options = {}) {
  let now = 1_800_000_000_000;
  const sessions = new Map([
    ["session-a", "developer"],
    ["session-b", "developer"],
    ["session-other", "reviewer"],
  ]);
  const broker = createBroker({
    resolveSessionPersona: (id) => sessions.get(id) ?? null,
    now: () => now,
  });
  const read = registered("read_value");
  const write = registered("write_value", writePolicy);
  const network = registered("fetch_value", networkPolicy);
  broker.registerStaticTool(read.tool);
  broker.registerStaticTool(write.tool);
  broker.registerStaticTool(network.tool);
  const authority = createAuthority(broker, {
    name: "developer",
    tools: options.tools ?? ["read_value", "write_value"],
    env: { WORKSPACE_ROOT: "C:/workspace" },
    systemPrompt: "developer",
    allowedRoots: ["C:/workspace"],
    networkPolicy: options.networkPolicy ?? { mode: "deny" },
  });
  return {
    broker,
    authority,
    sessions,
    counters: { read: read.counter, write: write.counter, network: network.counter },
    advance(ms) { now += ms; },
  };
}

function prepare(broker, context, name, args = {}) {
  return broker.inspectToolCall(context, name, args);
}

async function invoke(broker, context, name, args = {}) {
  const inspected = prepare(broker, context, name, args);
  return broker.invokeTool(context, inspected);
}

async function p33TempFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec02-p33-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return root;
}

function p33Root(rootId, role, configuredPath) {
  return { rootId, role, configuredPath, permissions: ["read-file"] };
}

function registerP33ReadTool(broker, name = "p33_read") {
  broker.registerStaticTool({
    name,
    definition: definition(name),
    policy: filesystemReadPolicy,
    executor: async (_args, _env, invocation) => {
      const read = await invocation.path.readFile("inside.txt", { defaultRootId: "workspace", maxBytes: 1024 });
      return read.bytes.toString();
    },
  });
}

function createP33RuntimeAuthority(broker, pathAuthority, configuredRoots, tool = "p33_read") {
  return broker.createRuntimeAuthority({
    name: "developer",
    tools: [tool],
    env: {},
    rootEnv: {},
    systemPrompt: "SEC-02 P33",
    allowedRoots: configuredRoots,
    pathAuthority,
    networkPolicy: { mode: "deny" },
  });
}

async function invokeP33Read(broker, context, tool = "p33_read") {
  const inspected = broker.inspectToolCall(context, tool, {});
  const issued = broker.issueToolPathGateway(context, inspected);
  return broker.invokeTool(context, inspected, { path: issued.gateway });
}

function p33AuditEvidence(events, rawInput) {
  return {
    auditAttempts: events.length,
    auditAllowedFieldsExact: events.every(event => JSON.stringify(Object.keys(event).sort()) === JSON.stringify(pathAuditKeys)),
    rawPathsAbsent: events.every(event => !Object.values(event).some(value => typeof value === "string" && value.includes(rawInput))),
  };
}

test("SEC01 context authenticity is object-identity based and deeply frozen", () => {
  const { broker, authority, counters } = fixture();
  const context = broker.beginAgentRun(authority, "session-a");
  assert(Object.isFrozen(context));
  assert(Object.isFrozen(context.persona));
  assert(Object.isFrozen(context.allowedTools));
  assert(Object.isFrozen(context.networkPolicy));
  assert.deepEqual(context.allowedTools, ["read_value", "write_value"]);

  expectCode(() => broker.getToolDefinitions({ ...context }), "CAPABILITY_CONTEXT_FORGED");
  expectCode(() => broker.getToolDefinitions(JSON.parse(JSON.stringify(context))), "CAPABILITY_CONTEXT_FORGED");
  expectCode(() => broker.getToolDefinitions(structuredClone(context)), "CAPABILITY_CONTEXT_FORGED");
  assert.throws(() => { context.allowedTools.push("fetch_value"); }, TypeError);
  assert.throws(() => { context.allowedRoots.push("D:/outside"); }, TypeError);

  const allowFixture = fixture({ networkPolicy: { mode: "allowlist", origins: ["https://example.test"] } });
  const allowContext = allowFixture.broker.beginAgentRun(allowFixture.authority, "session-a");
  assert(Object.isFrozen(allowContext.networkPolicy.origins));
  assert.throws(() => { allowContext.networkPolicy.origins.push("https://evil.test"); }, TypeError);
  allowFixture.broker.finishContext(allowContext);

  const other = createBroker({ resolveSessionPersona: () => "developer" });
  expectCode(() => other.getToolDefinitions(context), "CAPABILITY_CONTEXT_FORGED");
  assertSec01Probe("SEC01-A02", "private-context-identity", broker.isContextActive({ ...context }), false);
  assertSec01Probe("SEC01-A02", "executor-call-count", counters.read.calls + counters.write.calls, 0);
  assertSec01Probe("SEC01-A03", "deep-freeze", [Object.isFrozen(context), Object.isFrozen(context.persona), Object.isFrozen(context.allowedTools), Object.isFrozen(context.networkPolicy)], [true, true, true, true]);
  assertSec01Probe("SEC01-A03", "immutable-snapshot", context.allowedTools, ["read_value", "write_value"]);
  broker.finishContext(context);
  expectCode(() => broker.getToolDefinitions(context), "CAPABILITY_CONTEXT_STALE");
  assertSec01Probe("SEC01-A07", "context-active-state", broker.isContextActive(context), false);
});

test("SEC01 root run is single-flight and session-persona mismatch fails closed", () => {
  const { broker, authority, counters } = fixture();
  expectCode(() => broker.beginAgentRun(authority, "session-other"), "CAPABILITY_SESSION_MISMATCH");
  expectCode(() => broker.beginAgentRun(authority, "missing"), "CAPABILITY_SESSION_MISMATCH");
  const context = broker.beginAgentRun(authority, "session-a");
  expectCode(() => broker.beginAgentRun(authority, "session-a"), "CAPABILITY_RUN_BUSY");
  assert.equal(counters.read.calls + counters.write.calls, 0);
  assertSec01Probe("SEC01-A08", "executor-call-count", counters.read.calls + counters.write.calls, 0);
  broker.finishContext(context);
  const next = broker.beginAgentRun(authority, "session-a");
  broker.finishContext(next);
});

test("SEC01 revoked authority and switched session invalidate descendants", () => {
  const { broker, authority, sessions, counters } = fixture();
  const root = broker.beginAgentRun(authority, "session-a");
  const child = broker.deriveChild(root, { principal: "subagent", tools: ["read_value"] });
  sessions.set("session-a", "reviewer");
  expectCode(() => prepare(broker, root, "read_value"), "CAPABILITY_SESSION_MISMATCH");
  sessions.set("session-a", "developer");
  expectCode(() => prepare(broker, root, "read_value"), "CAPABILITY_CONTEXT_STALE");
  expectCode(() => prepare(broker, child, "read_value"), "CAPABILITY_CONTEXT_STALE");
  assertSec01Probe("SEC01-A06", "context-active-state", broker.isContextActive(root), false);
  assertSec01Probe("SEC01-A06", "executor-call-count", counters.read.calls, 0);
  broker.revokeAuthority(authority);
});

test("SEC01 runtime registrations cannot override, mutate or cross authorities", async () => {
  const { broker, authority } = fixture({ tools: ["runtime_probe"] });
  const staticCollision = registered("read_value");
  expectCode(() => broker.registerRuntimeTool(authority, staticCollision.tool), "CAPABILITY_REGISTRATION_INVALID");
  const mismatch = registered("runtime_probe");
  mismatch.tool.definition.function.name = "different";
  expectCode(() => broker.registerRuntimeTool(authority, mismatch.tool), "CAPABILITY_REGISTRATION_INVALID");

  const probeA = registered("runtime_probe", { riskClasses: ["read"], approval: "none", effects: [] }, "A");
  const callerPolicy = probeA.tool.policy;
  broker.registerRuntimeTool(authority, probeA.tool);
  probeA.tool.definition.function.description = "mutated after registration";
  callerPolicy.riskClasses.push("network");
  callerPolicy.effects.push("network");
  const contextA = broker.beginAgentRun(authority, "session-a");
  assert.equal(broker.getToolDefinitions(contextA)[0].function.description, "runtime_probe");
  const beforePostIssuanceRegistration = broker.getToolDefinitions(contextA).map((entry) => entry.function.name);
  expectCode(() => broker.registerRuntimeTool(authority, registered("runtime_probe").tool), "CAPABILITY_REGISTRATION_INVALID");
  const afterPostIssuanceRegistration = broker.getToolDefinitions(contextA).map((entry) => entry.function.name);

  const authorityB = createAuthority(broker, {
    name: "developer", tools: ["runtime_probe"], env: {}, systemPrompt: "B",
    allowedRoots: ["C:/workspace"], networkPolicy: { mode: "deny" },
  });
  const probeB = registered("runtime_probe", readPolicy, "B");
  broker.registerRuntimeTool(authorityB, probeB.tool);
  const contextB = broker.beginAgentRun(authorityB, "session-b");
  assert.equal(await invoke(broker, contextA, "runtime_probe"), "A");
  assert.equal(await invoke(broker, contextB, "runtime_probe"), "B");
  assert.equal(probeA.counter.calls, 1);
  assert.equal(probeB.counter.calls, 1);
  assertSec01Probe("SEC01-A10", "registry-state", broker.getToolDefinitions(contextA).map((entry) => entry.function.name), ["runtime_probe"]);
  assertSec01Probe("SEC01-A11", "registry-state", { before: beforePostIssuanceRegistration, after: afterPostIssuanceRegistration }, { before: ["runtime_probe"], after: ["runtime_probe"] });
  assertSec01Probe("SEC01-A12", "per-authority-marker-count", [probeA.counter.calls, probeB.counter.calls], [1, 1]);
  assertSec01Probe("SEC01-A13", "immutable-registration-snapshot", broker.getToolDefinitions(contextA)[0].function.description, "runtime_probe");
  broker.finishContext(contextA);
  broker.finishContext(contextB);
});

test("SEC01 child derivation attenuates bindings, roots, risks, network and recursion", () => {
  const { broker, authority, counters } = fixture();
  const root = broker.beginAgentRun(authority, "session-a");
  const child = broker.deriveChild(root, {
    principal: "subagent",
    tools: ["read_value", "subagent"],
    allowedRoots: ["workspace"],
    allowedRiskClasses: ["read"],
    networkPolicy: { mode: "deny" },
  });
  assert.deepEqual(child.allowedTools, ["read_value"]);
  const defaultChild = broker.deriveChild(root, { principal: "playbook" });
  assert.deepEqual(defaultChild.allowedTools, ["read_value"], "approval-bound tools must not be delegated by default");
  const explicitPlaybookChild = broker.deriveChild(root, { principal: "playbook", tools: ["read_value", "playbook_execute"] });
  assert.deepEqual(explicitPlaybookChild.allowedTools, ["read_value"]);
  expectCode(() => prepare(broker, child, "write_value", { value: "x" }), "CAPABILITY_TOOL_DENIED");
  expectCode(() => broker.deriveChild(root, { principal: "subagent", tools: ["write_value"] }), "CAPABILITY_ATTENUATION_INVALID");
  expectCode(() => broker.deriveChild(root, { principal: "playbook", tools: ["forbidden"] }), "CAPABILITY_ATTENUATION_INVALID");
  expectCode(() => broker.deriveChild(root, { principal: "subagent", allowedRoots: ["D:/outside"] }), "CAPABILITY_ATTENUATION_INVALID");
  expectCode(() => broker.deriveChild(root, { principal: "subagent", networkPolicy: { mode: "unrestricted" } }), "CAPABILITY_ATTENUATION_INVALID");
  assert.equal(counters.write.calls, 0);
  assertSec01Probe("SEC01-A17", "executor-call-count", counters.write.calls, 0);
  assertSec01Probe("SEC01-A17", "binding-identity", child.allowedTools, ["read_value"]);
  assert.deepEqual(defaultChild.allowedTools, ["read_value"]);
  assert.deepEqual(explicitPlaybookChild.allowedTools, ["read_value"]);
  broker.finishContext(root);
  expectCode(() => prepare(broker, child, "read_value"), "CAPABILITY_CONTEXT_STALE");
});

test("SEC01 recursion tools are stripped even when present in the parent binding", () => {
  const broker = createBroker({ resolveSessionPersona: (id) => id === "session-a" ? "developer" : null });
  const read = registered("read_value");
  const subagent = registered("subagent");
  const playbook = registered("playbook_execute");
  broker.registerStaticTool(read.tool);
  broker.registerStaticTool(subagent.tool);
  broker.registerStaticTool(playbook.tool);
  const authority = createAuthority(broker, {
    name: "developer", tools: ["read_value", "subagent", "playbook_execute"], env: {}, systemPrompt: "recursion",
    allowedRoots: ["C:/workspace"], networkPolicy: { mode: "deny" },
  });
  const root = broker.beginAgentRun(authority, "session-a");
  const subagentChild = broker.deriveChild(root, { principal: "subagent", tools: ["read_value", "subagent"] });
  const playbookChild = broker.deriveChild(root, { principal: "playbook", tools: ["read_value", "playbook_execute"] });
  assertSec01Probe("SEC01-A18", "child-binding-set", subagentChild.allowedTools, ["read_value"]);
  assertSec01Probe("SEC01-A18", "executor-call-count", subagent.counter.calls, 0);
  assertSec01Probe("SEC01-A19", "child-binding-set", playbookChild.allowedTools, ["read_value"]);
  assertSec01Probe("SEC01-A19", "executor-call-count", playbook.counter.calls, 0);
  broker.finishContext(root);
});

test("SEC01 approval challenge and grant are exact, structured and one-use", async () => {
  const { broker, authority, counters, advance } = fixture();
  const root = broker.beginAgentRun(authority, "session-a");
  const args = { value: "approved" };
  const inspected = prepare(broker, root, "write_value", args);
  expectCode(() => broker.invokeTool(root, inspected), "CAPABILITY_GRANT_REQUIRED");
  const challenge = broker.createApprovalChallenge(root, inspected);
  assert.match(challenge.challengeId, /^[a-f0-9]{64}$/);
  const wrongRunCode = expectCode(() => broker.resolveApprovalChallenge({ ...approvalResponse, challengeId: challenge.challengeId, choice: "approve", sessionId: "session-a", runId: "wrong" }), "CAPABILITY_APPROVAL_CHALLENGE_INVALID");
  const wrongSessionCode = expectCode(() => broker.resolveApprovalChallenge({ ...approvalResponse, challengeId: challenge.challengeId, choice: "approve", sessionId: "session-b", runId: root.runId }), "CAPABILITY_APPROVAL_CHALLENGE_INVALID");
  const wrongChannelCode = expectCode(() => broker.resolveApprovalChallenge({ ...approvalResponse, responseChannel: "other", challengeId: challenge.challengeId, choice: "approve", sessionId: "session-a", runId: root.runId }), "CAPABILITY_APPROVAL_CHALLENGE_INVALID");
  const ambiguousChoiceCode = expectCode(() => broker.resolveApprovalChallenge({ ...approvalResponse, challengeId: challenge.challengeId, choice: "yes", sessionId: "session-a", runId: root.runId }), "CAPABILITY_APPROVAL_CHALLENGE_INVALID");
  const granted = broker.resolveApprovalChallenge({ ...approvalResponse, challengeId: challenge.challengeId, choice: "approve", sessionId: "session-a", runId: root.runId });
  assert(granted);
  assert(Object.isFrozen(granted.approvalGrant));
  assert.throws(() => { granted.approvalGrant.toolOrOperation = "read_value"; }, TypeError);
  const invocationChild = broker.deriveInvocationChild(granted, { principal: "subagent" });
  assert.deepEqual(invocationChild.allowedTools, ["read_value"], "approved orchestrators derive from the root but never inherit approval-bound tools");
  const duplicateChallengeCode = expectCode(() => broker.resolveApprovalChallenge({ ...approvalResponse, challengeId: challenge.challengeId, choice: "approve", sessionId: "session-a", runId: root.runId }), "CAPABILITY_APPROVAL_CHALLENGE_INVALID");
  const changed = prepare(broker, root, "write_value", { value: "changed" });
  const changedGrantCode = expectCode(() => broker.invokeTool(granted, changed), "CAPABILITY_GRANT_INVALID");
  assert.equal(counters.write.calls, 0);
  assert.equal(await broker.invokeTool(granted, inspected), "write_value");
  assert.equal(counters.write.calls, 1);
  const replayCode = expectCode(() => broker.invokeTool(granted, inspected), "CAPABILITY_GRANT_REPLAYED");
  assert.equal(counters.write.calls, 1);
  const expiredInspected = prepare(broker, root, "write_value", { value: "expired challenge" });
  const expiringChallenge = broker.createApprovalChallenge(root, expiredInspected, 1000);
  advance(1001);
  const expiredChallengeCode = expectCode(() => broker.resolveApprovalChallenge({ ...approvalResponse, challengeId: expiringChallenge.challengeId, choice: "approve", sessionId: "session-a", runId: root.runId }), "CAPABILITY_APPROVAL_CHALLENGE_INVALID");
  assertSec01Probe("SEC01-A16", "argument-digest", { before: challenge.argumentsDigest, after: inspected.argumentsDigest }, { before: inspected.argumentsDigest, after: inspected.argumentsDigest });
  assertSec01Probe("SEC01-A18", "grant-ledger", invocationChild.approvalGrant, null);
  const challengeCodes = [wrongRunCode, wrongSessionCode, wrongChannelCode, ambiguousChoiceCode, duplicateChallengeCode, expiredChallengeCode];
  assertSec01Probe("SEC01-A22", "challenge-ledger", challengeCodes, Array(6).fill("CAPABILITY_APPROVAL_CHALLENGE_INVALID"));
  assertSec01Probe("SEC01-A22", "executor-call-count", counters.write.calls, 1);
  assert.deepEqual([changedGrantCode, replayCode], ["CAPABILITY_GRANT_INVALID", "CAPABILITY_GRANT_REPLAYED"]);
  broker.finishContext(root);
});

test("SEC01 grant rejects changed registration, tool and arguments", async () => {
  const sessions = new Map([["session-a", "developer"], ["session-b", "developer"]]);
  const broker = createBroker({ resolveSessionPersona: (id) => sessions.get(id) ?? null });
  const read = registered("read_value");
  broker.registerStaticTool(read.tool);
  const authorityA = createAuthority(broker, {
    name: "developer", tools: ["runtime_write", "read_value"], env: {}, systemPrompt: "A",
    allowedRoots: ["C:/workspace"], networkPolicy: { mode: "deny" },
  });
  const authorityB = createAuthority(broker, {
    name: "developer", tools: ["runtime_write", "read_value"], env: {}, systemPrompt: "B",
    allowedRoots: ["C:/workspace"], networkPolicy: { mode: "deny" },
  });
  const runtimeA = registered("runtime_write", writePolicy, "A");
  const runtimeB = registered("runtime_write", writePolicy, "B");
  broker.registerRuntimeTool(authorityA, runtimeA.tool);
  broker.registerRuntimeTool(authorityB, runtimeB.tool);
  const rootA = broker.beginAgentRun(authorityA, "session-a");
  const rootB = broker.beginAgentRun(authorityB, "session-b");
  const inspectedA = prepare(broker, rootA, "runtime_write", { value: "exact" });
  const inspectedB = prepare(broker, rootB, "runtime_write", { value: "exact" });
  const challenge = broker.createApprovalChallenge(rootA, inspectedA);
  const granted = broker.resolveApprovalChallenge({ ...approvalResponse, challengeId: challenge.challengeId, choice: "approve", sessionId: "session-a", runId: rootA.runId });
  assert(granted);
  const changedRegistrationCode = expectCode(() => broker.invokeTool(granted, inspectedB), "CAPABILITY_BINDING_MISMATCH");
  const changedToolCode = expectCode(() => prepare(broker, granted, "read_value"), "CAPABILITY_TOOL_DENIED");
  const changedArgs = prepare(broker, rootA, "runtime_write", { value: "changed" });
  const changedArgumentsCode = expectCode(() => broker.invokeTool(granted, changedArgs), "CAPABILITY_GRANT_INVALID");
  assert.equal(await broker.invokeTool(granted, inspectedA), "A");
  const replayCode = expectCode(() => broker.invokeTool(granted, inspectedA), "CAPABILITY_GRANT_REPLAYED");
  assertSec01Probe("SEC01-A23", "grant-ledger", [changedRegistrationCode, changedToolCode, changedArgumentsCode, replayCode], [
    "CAPABILITY_BINDING_MISMATCH", "CAPABILITY_TOOL_DENIED", "CAPABILITY_GRANT_INVALID", "CAPABILITY_GRANT_REPLAYED",
  ]);
  assertSec01Probe("SEC01-A23", "executor-call-count", [runtimeA.counter.calls, runtimeB.counter.calls], [1, 0]);
  broker.finishContext(rootA);
  broker.finishContext(rootB);
});

test("SEC01 approval expiry and concurrent grant reuse fail closed", async () => {
  const { broker, authority, advance, counters } = fixture();
  const root = broker.beginAgentRun(authority, "session-a");
  const expired = prepare(broker, root, "write_value", { value: "late" });
  const expiredChallenge = broker.createApprovalChallenge(root, expired, 1000);
  advance(1001);
  expectCode(() => broker.resolveApprovalChallenge({ ...approvalResponse, challengeId: expiredChallenge.challengeId, choice: "approve", sessionId: "session-a", runId: root.runId }), "CAPABILITY_APPROVAL_CHALLENGE_INVALID");

  const inspected = prepare(broker, root, "write_value", { value: "once" });
  const challenge = broker.createApprovalChallenge(root, inspected);
  const granted = broker.resolveApprovalChallenge({ ...approvalResponse, challengeId: challenge.challengeId, choice: "approve", sessionId: "session-a", runId: root.runId });
  assert(granted);
  const outcomes = await Promise.allSettled([
    Promise.resolve().then(() => broker.invokeTool(granted, inspected)),
    Promise.resolve().then(() => broker.invokeTool(granted, inspected)),
  ]);
  assert.equal(outcomes.filter((entry) => entry.status === "fulfilled").length, 1);
  assert.equal(outcomes.filter((entry) => entry.status === "rejected" && entry.reason?.code === "CAPABILITY_GRANT_REPLAYED").length, 1);
  assert.equal(counters.write.calls, 1);
  assertSec01Probe("SEC01-A24", "executor-call-count", counters.write.calls, 1);
  assertSec01Probe("SEC01-A24", "grant-ledger", outcomes.map((entry) => entry.status).sort(), ["fulfilled", "rejected"]);
  broker.finishContext(root);
});

test("SEC01 expired, foreign and revoked grants fail closed and executor failure is one-use", async () => {
  const expired = fixture();
  const expiredRoot = expired.broker.beginAgentRun(expired.authority, "session-a");
  const expiredCall = prepare(expired.broker, expiredRoot, "write_value", { value: "expired" });
  const expiredChallenge = expired.broker.createApprovalChallenge(expiredRoot, expiredCall, 1000);
  const expiredGrant = expired.broker.resolveApprovalChallenge({ ...approvalResponse, challengeId: expiredChallenge.challengeId, choice: "approve", sessionId: "session-a", runId: expiredRoot.runId });
  assert(expiredGrant);
  expired.advance(1001);
  const expiredGrantCode = expectCode(() => expired.broker.invokeTool(expiredGrant, expiredCall), "CAPABILITY_GRANT_INVALID");
  expired.broker.finishContext(expiredRoot);

  const crossRun = fixture();
  const firstRun = crossRun.broker.beginAgentRun(crossRun.authority, "session-a");
  const firstRunCall = prepare(crossRun.broker, firstRun, "write_value", { value: "same-session" });
  const firstRunChallenge = crossRun.broker.createApprovalChallenge(firstRun, firstRunCall);
  const firstRunGrant = crossRun.broker.resolveApprovalChallenge({ ...approvalResponse, challengeId: firstRunChallenge.challengeId, choice: "approve", sessionId: "session-a", runId: firstRun.runId });
  assert(firstRunGrant);
  crossRun.broker.finishContext(firstRun);
  const secondRun = crossRun.broker.beginAgentRun(crossRun.authority, "session-a");
  const secondRunCall = prepare(crossRun.broker, secondRun, "write_value", { value: "same-session" });
  const crossRunCode = expectCode(() => crossRun.broker.invokeTool(firstRunGrant, secondRunCall), "CAPABILITY_CONTEXT_STALE");
  crossRun.broker.finishContext(secondRun);

  const foreign = fixture();
  const foreignRootA = foreign.broker.beginAgentRun(foreign.authority, "session-a");
  const callA = prepare(foreign.broker, foreignRootA, "write_value", { value: "A" });
  const foreignChallenge = foreign.broker.createApprovalChallenge(foreignRootA, callA);
  const foreignGrant = foreign.broker.resolveApprovalChallenge({ ...approvalResponse, challengeId: foreignChallenge.challengeId, choice: "approve", sessionId: "session-a", runId: foreignRootA.runId });
  assert(foreignGrant);
  foreign.broker.finishContext(foreignRootA);
  const foreignRootB = foreign.broker.beginAgentRun(foreign.authority, "session-b");
  const callB = prepare(foreign.broker, foreignRootB, "write_value", { value: "A" });
  const crossSessionCode = expectCode(() => foreign.broker.invokeTool(foreignGrant, callB), "CAPABILITY_CONTEXT_STALE");
  assert.equal(foreign.broker.isContextActive(foreignGrant), false);
  assert.equal(foreign.broker.isContextActive(foreignRootB), true);
  foreign.broker.finishContext(foreignRootB);

  const revoked = fixture();
  const revokedRoot = revoked.broker.beginAgentRun(revoked.authority, "session-a");
  const revokedCall = prepare(revoked.broker, revokedRoot, "write_value", { value: "revoked" });
  const revokedChallenge = revoked.broker.createApprovalChallenge(revokedRoot, revokedCall);
  const revokedGrant = revoked.broker.resolveApprovalChallenge({ ...approvalResponse, challengeId: revokedChallenge.challengeId, choice: "approve", sessionId: "session-a", runId: revokedRoot.runId });
  assert(revokedGrant);
  revoked.broker.revokeAuthority(revoked.authority);
  const revokedCode = expectCode(() => revoked.broker.invokeTool(revokedGrant, revokedCall), "CAPABILITY_CONTEXT_STALE");

  const failingFixture = fixture({ tools: ["throw_write"] });
  const failing = registered("throw_write", writePolicy);
  failing.tool.executor = async () => {
    failing.counter.calls += 1;
    throw new Error("synthetic executor failure");
  };
  failingFixture.broker.registerRuntimeTool(failingFixture.authority, failing.tool);
  const failingRoot = failingFixture.broker.beginAgentRun(failingFixture.authority, "session-a");
  const failingCall = prepare(failingFixture.broker, failingRoot, "throw_write", { value: "once" });
  const failingChallenge = failingFixture.broker.createApprovalChallenge(failingRoot, failingCall);
  const failingGrant = failingFixture.broker.resolveApprovalChallenge({ ...approvalResponse, challengeId: failingChallenge.challengeId, choice: "approve", sessionId: "session-a", runId: failingRoot.runId });
  assert(failingGrant);
  await assert.rejects(() => failingFixture.broker.invokeTool(failingGrant, failingCall), /synthetic executor failure/);
  const retryCode = expectCode(() => failingFixture.broker.invokeTool(failingGrant, failingCall), "CAPABILITY_GRANT_REPLAYED");

  assertSec01Probe("SEC01-A25", "grant-ledger", [expiredGrantCode, crossRunCode, crossSessionCode, revokedCode, retryCode], [
    "CAPABILITY_GRANT_INVALID", "CAPABILITY_CONTEXT_STALE", "CAPABILITY_CONTEXT_STALE", "CAPABILITY_CONTEXT_STALE", "CAPABILITY_GRANT_REPLAYED",
  ]);
  assertSec01Probe("SEC01-A25", "executor-call-count", [
    expired.counters.write.calls, crossRun.counters.write.calls, foreign.counters.write.calls, revoked.counters.write.calls, failing.counter.calls,
  ], [0, 0, 0, 0, 1]);
  failingFixture.broker.finishContext(failingRoot);
});

test("SEC01 authorized arguments and executor environment are private frozen snapshots", async () => {
  const { broker, authority } = fixture({ tools: ["snapshot_probe"] });
  let capturedArgs;
  let capturedEnv;
  let getterReads = 0;
  broker.registerRuntimeTool(authority, {
    name: "snapshot_probe",
    definition: definition("snapshot_probe"),
    policy: readPolicy,
    executor: async (args, env) => {
      capturedArgs = args;
      capturedEnv = env;
      return "snapshot";
    },
  });
  const root = broker.beginAgentRun(authority, "session-a");
  const nested = { flag: true };
  const args = {
    get value() {
      getterReads += 1;
      return "original";
    },
    nested,
  };
  const inspected = prepare(broker, root, "snapshot_probe", args);
  nested.flag = false;
  assert.equal(getterReads, 1);
  assert.deepEqual(inspected.args, { value: "original", nested: { flag: true } });
  assert(Object.isFrozen(inspected.args));
  assert(Object.isFrozen(inspected.args.nested));
  assert.equal(await broker.invokeTool(root, inspected), "snapshot");
  assert.equal(getterReads, 1, "executor must not reread caller-owned accessors");
  assert.strictEqual(capturedArgs, inspected.args);
  assert.equal(capturedEnv._SESSION_ID, "session-a");
  assert.equal(capturedEnv._CAPABILITY_RUN_ID, root.runId);
  assert(Object.isFrozen(capturedEnv));
  assert.throws(() => { capturedEnv._SESSION_ID = "session-b"; }, TypeError);
  assertSec01Probe("SEC01-A16", "immutable-snapshot", [capturedArgs === inspected.args, Object.isFrozen(capturedArgs), getterReads], [true, true, 1]);
  broker.finishContext(root);
});

test("SEC01 network envelope denies network-risk tools before invocation", async () => {
  const deniedFixture = fixture({ tools: ["fetch_value"], networkPolicy: { mode: "deny" } });
  const deniedContext = deniedFixture.broker.beginAgentRun(deniedFixture.authority, "session-a");
  expectCode(() => prepare(deniedFixture.broker, deniedContext, "fetch_value"), "CAPABILITY_RISK_DENIED");
  assert.equal(deniedFixture.counters.network.calls, 0);

  const allowedFixture = fixture({ tools: ["fetch_value"], networkPolicy: { mode: "unrestricted" } });
  const allowedContext = allowedFixture.broker.beginAgentRun(allowedFixture.authority, "session-a");
  await invoke(allowedFixture.broker, allowedContext, "fetch_value");
  assert.equal(allowedFixture.counters.network.calls, 1);
});

test("SEC01 direct-operation contexts are exact, expiring, one-use and separated from agent tools", () => {
  const { broker, authority, advance, counters } = fixture();
  broker.registerDirectOperation("terminal:input", { riskClasses: ["process"], approval: "none", effects: ["process"] });
  broker.registerDirectOperation("file:reveal", { riskClasses: ["process", "control"], approval: "none", effects: ["process", "control"] });
  broker.registerDirectOperation("terminal:network", { riskClasses: ["network"], approval: "none", effects: ["network"] });
  broker.registerDirectOperation("supervisor:update", { riskClasses: ["control"], approval: "user", effects: ["control"] });
  const principal = broker.createLocalApiPrincipal();
  let managerCalls = 0;
  const invokeDirectManager = (context, operation, args) => {
    const authorized = broker.authorizeDirectOperation(context, operation, args);
    managerCalls += 1;
    return authorized;
  };
  expectCode(() => broker.issueLocalApiContext({ authority, principal, sessionId: "session-a", operation: "terminal:network", args: {} }), "CAPABILITY_RISK_DENIED");
  expectCode(() => broker.issueLocalApiContext({ authority, principal, sessionId: "session-a", operation: "supervisor:update", args: {} }), "CAPABILITY_DIRECT_OPERATION_DENIED");
  const forgedPrincipalCode = expectCode(() => broker.issueLocalApiContext({
    authority,
    principal: Object.freeze({ principalId: principal.principalId }),
    sessionId: "session-a",
    operation: "terminal:input",
    args: { terminalId: "term-a", input: "dir" },
  }), "CAPABILITY_CONTEXT_FORGED");
  const missingContextCode = expectCode(() => invokeDirectManager(undefined, "terminal:input", { terminalId: "term-a", input: "dir" }), "CAPABILITY_CONTEXT_REQUIRED");

  const forgeryTarget = broker.issueLocalApiContext({
    authority,
    principal,
    sessionId: "session-a",
    operation: "terminal:input",
    args: { terminalId: "term-forgery", input: "dir" },
  });
  const spreadContextCode = expectCode(() => invokeDirectManager({ ...forgeryTarget }, "terminal:input", { terminalId: "term-forgery", input: "dir" }), "CAPABILITY_CONTEXT_FORGED");
  const jsonContextCode = expectCode(() => invokeDirectManager(JSON.parse(JSON.stringify(forgeryTarget)), "terminal:input", { terminalId: "term-forgery", input: "dir" }), "CAPABILITY_CONTEXT_FORGED");
  const clonedContextCode = expectCode(() => invokeDirectManager(structuredClone(forgeryTarget), "terminal:input", { terminalId: "term-forgery", input: "dir" }), "CAPABILITY_CONTEXT_FORGED");
  const otherBroker = createBroker({ resolveSessionPersona: (id) => id === "session-a" ? "developer" : null });
  otherBroker.registerDirectOperation("terminal:input", { riskClasses: ["process"], approval: "none", effects: ["process"] });
  const otherAuthority = createAuthority(otherBroker, { name: "developer", tools: [], env: {}, systemPrompt: "other", allowedRoots: [], networkPolicy: { mode: "deny" } });
  const otherPrincipal = otherBroker.createLocalApiPrincipal();
  const otherContext = otherBroker.issueLocalApiContext({ authority: otherAuthority, principal: otherPrincipal, sessionId: "session-a", operation: "terminal:input", args: { terminalId: "term-forgery", input: "dir" } });
  const foreignContextCode = expectCode(() => invokeDirectManager(otherContext, "terminal:input", { terminalId: "term-forgery", input: "dir" }), "CAPABILITY_CONTEXT_FORGED");

  const reveal = broker.issueLocalApiContext({
    authority,
    principal,
    sessionId: "session-a",
    operation: "file:reveal",
    args: { root: "workspace", path: "evidence.txt" },
  });
  assert.deepEqual(
    broker.authorizeDirectOperation(reveal, "file:reveal", { root: "workspace", path: "evidence.txt" }),
    { root: "workspace", path: "evidence.txt" }
  );
  broker.finishContext(reveal);

  const direct = broker.issueLocalApiContext({
    authority,
    principal,
    sessionId: "session-a",
    operation: "terminal:input",
    args: { terminalId: "term-a", input: "dir" },
  });
  expectCode(() => broker.getToolDefinitions(direct), "CAPABILITY_TOOL_DENIED");
  expectCode(() => prepare(broker, direct, "read_value"), "CAPABILITY_TOOL_DENIED");
  const root = broker.beginAgentRun(authority, "session-a");
  const wrongPrincipalCode = expectCode(() => invokeDirectManager(root, "terminal:input", { terminalId: "term-a", input: "dir" }), "CAPABILITY_DIRECT_OPERATION_DENIED");
  expectCode(() => invokeDirectManager(direct, "terminal:input", { terminalId: "term-b", input: "dir" }), "CAPABILITY_DIRECT_OPERATION_DENIED");
  assert.deepEqual(broker.authorizeDirectOperation(direct, "terminal:input", { terminalId: "term-a", input: "dir" }), { terminalId: "term-a", input: "dir" });
  expectCode(() => broker.authorizeDirectOperation(direct, "terminal:input", { terminalId: "term-a", input: "dir" }), "CAPABILITY_GRANT_REPLAYED");
  assertSec01Probe("SEC01-A28", "principal-separation", [direct.principal, root.principal], ["local-user-api", "agent"]);
  assertSec01Probe("SEC01-A28", "executor-call-count", counters.read.calls + counters.write.calls, 0);

  const expiring = broker.issueLocalApiContext({
    authority,
    principal,
    sessionId: "session-a",
    operation: "terminal:input",
    args: { terminalId: "term-a", input: "late" },
    ttlMs: 1000,
  });
  advance(1001);
  const expiredCode = expectCode(() => invokeDirectManager(expiring, "terminal:input", { terminalId: "term-a", input: "late" }), "CAPABILITY_DIRECT_OPERATION_DENIED");
  const a27Codes = [missingContextCode, forgedPrincipalCode, spreadContextCode, jsonContextCode, clonedContextCode, foreignContextCode, expiredCode, wrongPrincipalCode];
  assertSec01Probe("SEC01-A27", "direct-operation-ledger", a27Codes, [
    "CAPABILITY_CONTEXT_REQUIRED", "CAPABILITY_CONTEXT_FORGED", "CAPABILITY_CONTEXT_FORGED", "CAPABILITY_CONTEXT_FORGED",
    "CAPABILITY_CONTEXT_FORGED", "CAPABILITY_CONTEXT_FORGED", "CAPABILITY_DIRECT_OPERATION_DENIED", "CAPABILITY_DIRECT_OPERATION_DENIED",
  ]);
  assertSec01Probe("SEC01-A27", "manager-invocation-count", managerCalls, 0);

  const routeBound = broker.issueLocalApiContext({
    authority,
    principal,
    sessionId: "session-a",
    operation: "terminal:input",
    args: { terminalId: "term-route", input: "dir" },
  });
  const wrongRouteCode = expectCode(() => invokeDirectManager(routeBound, "terminal:output", { terminalId: "term-route", input: "dir" }), "CAPABILITY_DIRECT_OPERATION_DENIED");
  const wrongTerminalCode = expectCode(() => invokeDirectManager(routeBound, "terminal:input", { terminalId: "term-other", input: "dir" }), "CAPABILITY_DIRECT_OPERATION_DENIED");
  const wrongBodyCode = expectCode(() => invokeDirectManager(routeBound, "terminal:input", { terminalId: "term-route", input: "whoami" }), "CAPABILITY_DIRECT_OPERATION_DENIED");
  const managerCallsAfterDenials = managerCalls;
  invokeDirectManager(routeBound, "terminal:input", { terminalId: "term-route", input: "dir" });
  const managerCallsAfterExact = managerCalls;
  const routeReplayCode = expectCode(() => invokeDirectManager(routeBound, "terminal:input", { terminalId: "term-route", input: "dir" }), "CAPABILITY_GRANT_REPLAYED");
  assertSec01Probe("SEC01-A30", "direct-operation-ledger", [wrongRouteCode, wrongTerminalCode, wrongBodyCode, routeReplayCode], [
    "CAPABILITY_DIRECT_OPERATION_DENIED", "CAPABILITY_DIRECT_OPERATION_DENIED", "CAPABILITY_DIRECT_OPERATION_DENIED", "CAPABILITY_GRANT_REPLAYED",
  ]);
  assertSec01Probe("SEC01-A30", "manager-invocation-count", [managerCallsAfterDenials, managerCallsAfterExact, managerCalls], [0, 1, 1]);
  broker.finishContext(routeBound);
  broker.finishContext(expiring);
  broker.finishContext(direct);
  broker.finishContext(forgeryTarget);
  broker.finishContext(root);
  otherBroker.finishContext(otherContext);
  otherBroker.revokeAuthority(otherAuthority);
});

test("SEC01 denial paths never invoke executors", () => {
  const { broker, authority, counters } = fixture();
  const root = broker.beginAgentRun(authority, "session-a");
  expectCode(() => prepare(broker, root, "unknown"), "CAPABILITY_TOOL_DENIED");
  const write = prepare(broker, root, "write_value", { value: "x" });
  expectCode(() => broker.invokeTool(root, write), "CAPABILITY_GRANT_REQUIRED");
  expectCode(() => prepare(broker, { ...root }, "read_value"), "CAPABILITY_CONTEXT_FORGED");
  assert.deepEqual(counters, {
    read: { calls: 0 },
    write: { calls: 0 },
    network: { calls: 0 },
  });
  assertSec01Probe("SEC01-A05", "executor-call-count", counters.read.calls + counters.write.calls + counters.network.calls, 0);
  broker.finishContext(root);
});

test("SEC01 malformed identities, policies, lifetimes and direct operations fail closed", () => {
  assert.throws(() => canonicalDigest(Number.NaN), /unsupported data/);
  assert.throws(() => canonicalDigest(Symbol("forged")), /unsupported data/);
  assert.throws(() => canonicalDigest(Object.create({ inherited: true })), /plain JSON data/);

  const sessions = new Map([["session-a", "developer"]]);
  const broker = createBroker({ resolveSessionPersona: (id) => sessions.get(id) ?? null });
  const read = registered("read_value");
  broker.registerStaticTool(read.tool);
  expectCode(() => broker.registerStaticTool(read.tool), "CAPABILITY_REGISTRATION_INVALID");
  expectCode(() => broker.registerDirectOperation("", readPolicy), "CAPABILITY_REGISTRATION_INVALID");
  broker.registerDirectOperation("terminal:list", readPolicy);
  expectCode(() => broker.registerDirectOperation("terminal:list", readPolicy), "CAPABILITY_REGISTRATION_INVALID");

  for (const [name, policy] of [
    ["bad_risk", { riskClasses: ["unknown"], approval: "none", effects: [] }],
    ["bad_effect", { riskClasses: ["read"], approval: "none", effects: ["unknown"] }],
    ["bad_path", { riskClasses: ["read"], approval: "none", effects: ["filesystem"], pathOperations: ["unknown"] }],
    ["bad_path_risk", { riskClasses: ["read"], approval: "none", effects: ["filesystem"], pathOperations: ["create-file"] }],
    ["bad_approval", { riskClasses: ["read"], approval: "maybe", effects: [] }],
  ]) {
    assert.throws(() => broker.registerStaticTool(registered(name, policy).tool), TypeError);
  }
  expectCode(() => broker.registerStaticTool(registered("empty_risk", { riskClasses: [], approval: "none", effects: [] }).tool), "CAPABILITY_REGISTRATION_INVALID");
  expectCode(() => broker.registerStaticTool({ ...registered("mismatch").tool, definition: definition("other") }), "CAPABILITY_REGISTRATION_INVALID");

  assert.throws(() => createAuthority(broker, { name: "", tools: [], env: {}, systemPrompt: "x", allowedRoots: [], networkPolicy: { mode: "deny" } }), /identity is invalid/);
  assert.throws(() => createAuthority(broker, { name: "developer", tools: ["read_value", "read_value"], env: {}, systemPrompt: "x", allowedRoots: [], networkPolicy: { mode: "deny" } }), /duplicates/);
  assert.throws(() => createAuthority(broker, { name: "developer", tools: [], env: { _SESSION_ID: "forged" }, systemPrompt: "x", allowedRoots: [], networkPolicy: { mode: "deny" } }), /env key is invalid/);
  assert.throws(() => createAuthority(broker, { name: "developer", tools: [], env: {}, systemPrompt: "x", allowedRoots: [], networkPolicy: { mode: "invalid" } }), /network policy is invalid/);
  assert.throws(() => createAuthority(broker, { name: "developer", tools: [], env: {}, systemPrompt: "x", allowedRoots: [], networkPolicy: { mode: "allowlist", origins: ["https://a.test", "https://a.test"] } }), /duplicates/);
  expectCode(() => createAuthority(broker, { name: "developer", tools: [], env: {}, systemPrompt: "x", allowedRoots: [], networkPolicy: { mode: "deny" }, digest: "0".repeat(64) }), "CAPABILITY_REGISTRATION_INVALID");

  const missingAuthority = createAuthority(broker, { name: "developer", tools: ["missing_tool"], env: {}, systemPrompt: "x", allowedRoots: [], networkPolicy: { mode: "deny" } });
  expectCode(() => broker.beginAgentRun(missingAuthority, "session-a"), "CAPABILITY_TOOL_DENIED");
  broker.revokeAuthority(missingAuthority);
  expectCode(() => broker.revokeAuthority(missingAuthority), "CAPABILITY_CONTEXT_FORGED");

  const authority = createAuthority(broker, { name: "developer", tools: ["read_value"], env: {}, systemPrompt: "x", allowedRoots: [], networkPolicy: { mode: "deny" } });
  const root = broker.beginAgentRun(authority, "session-a");
  const readCall = prepare(broker, root, "read_value");
  expectCode(() => broker.createApprovalChallenge(root, readCall), "CAPABILITY_APPROVAL_CHALLENGE_INVALID");
  expectCode(() => broker.finishContext({ ...root }), "CAPABILITY_CONTEXT_FORGED");
  expectCode(() => broker.finishContext(null), "CAPABILITY_CONTEXT_REQUIRED");
  assert.equal(broker.isContextActive({ ...root }), false);

  const principal = broker.createLocalApiPrincipal();
  expectCode(() => broker.issueLocalApiContext({ authority, principal, sessionId: "session-a", operation: "unknown", args: {} }), "CAPABILITY_DIRECT_OPERATION_DENIED");
  assert.throws(() => broker.issueLocalApiContext({ authority, principal, sessionId: "session-a", operation: "terminal:list", args: {}, ttlMs: 0 }), /lifetime is invalid/);
  const direct = broker.issueLocalApiContext({ authority, principal, sessionId: "session-a", operation: "terminal:list", args: {} });
  expectCode(() => broker.deriveChild(direct, { principal: "subagent" }), "CAPABILITY_ATTENUATION_INVALID");
  expectCode(() => broker.inspectToolCall(direct, "read_value", {}), "CAPABILITY_TOOL_DENIED");
  broker.finishContext(direct);
  broker.finishContext(root);
});

test("SEC02 Broker binds one-invocation PathGateway to the authentic tool policy and context", async () => {
  const broker = createBroker({ resolveSessionPersona: () => "developer" });
  let searchDenied = null;
  broker.registerStaticTool({
    name: "read_path",
    definition: definition("read_path"),
    policy: filesystemReadPolicy,
    executor: async (_args, _env, invocation) => {
      const read = await invocation.path.readFile("inside.txt", { defaultRootId: "workspace", maxBytes: 1024 });
      try { await invocation.path.searchDirectory("", { defaultRootId: "workspace" }); }
      catch (error) { searchDenied = error?.code; }
      return read.bytes.toString();
    },
  });
  const authority = createAuthority(broker, {
    name: "developer", tools: ["read_path"], env: { WORKSPACE_ROOT: "C:/workspace" }, systemPrompt: "x",
    allowedRoots: ["C:/workspace"], networkPolicy: { mode: "deny" },
  });
  const root = broker.beginAgentRun(authority, "session-a");
  assert.deepEqual(root.allowedRoots, ["workspace"]);
  assert(!JSON.stringify(root).includes(brokerPathFixture));
  const inspected = broker.inspectToolCall(root, "read_path", {});
  const issued = broker.issueToolPathGateway(root, inspected);
  assert.deepEqual(Object.keys(issued.gateway).sort(), [
    "createFile", "listDirectory", "readFile", "replaceFile", "reserveFile", "rootIdForEnv", "searchDirectory", "searchFile", "watchDirectory", "withExecutionRoot", "withInitialCwd", "writeFile",
  ]);
  assert(!Object.hasOwn(issued.gateway, "authority"));
  expectCode(() => issued.gateway.rootIdForEnv("WORKSPACE_ROOT"), "CAPABILITY_BINDING_MISMATCH");
  expectCode(() => broker.issueToolPathGateway(root, inspected), "CAPABILITY_GRANT_REPLAYED");
  const result = await broker.invokeTool(root, inspected, { path: issued.gateway });
  assert.equal(result, "inside");
  assert.equal(searchDenied, "CAPABILITY_RISK_DENIED");
  expectCode(() => issued.gateway.rootIdForEnv("WORKSPACE_ROOT"), "CAPABILITY_CONTEXT_STALE");
  expectCode(() => broker.issueToolPathGateway(root, inspected), "CAPABILITY_GRANT_REPLAYED");
  broker.finishContext(root);
});

test("SEC03 Broker resource owner is run-scoped and each run drains before authority retirement", async () => {
  const { broker, authority } = fixture();
  const firstContext = broker.beginAgentRun(authority, "session-a");
  const firstOwner = broker.getResourceOwner(firstContext);
  let firstCloses = 0;
  registerOwnedResource(firstOwner, async () => { firstCloses += 1; });
  broker.finishContext(firstContext);
  await broker.retireSessionResources(authority, "session-a");
  assert.equal(firstCloses, 1);
  assert.throws(() => assertResourceOwner(firstOwner), error => error?.code === "PATH_AUTHORITY_STALE");

  const secondContext = broker.beginAgentRun(authority, "session-a");
  const secondOwner = broker.getResourceOwner(secondContext);
  assert.notEqual(firstOwner, secondOwner);
  let secondCloses = 0;
  registerOwnedResource(secondOwner, async () => { secondCloses += 1; });
  broker.finishContext(secondContext);
  await broker.retireAuthority(authority);
  assert.equal(secondCloses, 1);
  assert.throws(() => assertResourceOwner(secondOwner), error => error?.code === "PATH_AUTHORITY_STALE");
});

test("SEC03 a replacement run cannot mint an owner until the previous run drain converges", async () => {
  const { broker, authority } = fixture();
  const firstContext = broker.beginAgentRun(authority, "session-a");
  const firstOwner = broker.getResourceOwner(firstContext);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  registerOwnedResource(firstOwner, async () => gate);
  broker.finishContext(firstContext);

  const secondContext = broker.beginAgentRun(authority, "session-a");
  assert.throws(() => broker.getResourceOwner(secondContext), error => error?.code === "CAPABILITY_RUN_BUSY");
  release();
  await broker.retireSessionResources(authority, "session-a");
  const secondOwner = broker.getResourceOwner(secondContext);
  assert.notEqual(secondOwner, firstOwner);
  broker.finishContext(secondContext);
  await broker.retireAuthority(authority);
});

test("SEC-02 Session deletion closes PathPolicy leases before removing the session identity", async t => {
  const base = await p33TempFixture(t);
  const workspace = path.join(base, "workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "inside.png"), "SESSION-LEASE-BYTES");
  const events = [];
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 87), auditSink: event => events.push(event) });
  const pathAuthority = await policy.createAuthority([p33Root("workspace", "workspace", workspace)]);
  const sessions = new Map([["session-delete-a", "developer"]]);
  const broker = new CapabilityBroker({ resolveSessionPersona: id => sessions.get(id) ?? null, pathPolicy: policy });
  const authority = broker.createRuntimeAuthority({
    name: "developer",
    tools: [],
    env: {},
    rootEnv: {},
    systemPrompt: "SEC-02 Session lease retirement",
    allowedRoots: [workspace],
    pathAuthority,
    networkPolicy: { mode: "deny" },
  });
  t.after(async () => broker.retireAuthority(authority).catch(() => undefined));
  const context = broker.beginAgentRun(authority, "session-delete-a");
  const owner = broker.getResourceOwner(context);
  const lease = await policy.openReadLease(pathAuthority, {
    input: "inside.png",
    operation: "read-file",
    defaultRootId: "workspace",
    auditIdentity: { sessionId: "session-delete-a", runId: context.runId, principal: "local-user-api" },
  }, 1024);
  let closerCalls = 0;
  registerOwnedResource(owner, async () => {
    closerCalls += 1;
    await lease.close();
  });
  broker.finishContext(context);

  await broker.retireSessionResources(authority, "session-delete-a");
  sessions.delete("session-delete-a");
  let oldOwnerStale = false;
  try { assertResourceOwner(owner); }
  catch (error) { oldOwnerStale = error?.code === "PATH_AUTHORITY_STALE"; }
  let denied = false;
  try { await lease.readRange(0, 0); }
  catch (error) { denied = error?.code === "PATH_AUTHORITY_STALE"; }
  const newContextCode = expectCode(
    () => broker.beginAgentRun(authority, "session-delete-a"),
    "CAPABILITY_SESSION_MISMATCH"
  );
  const actual = {
    oldResourceClosedOrIsolated: closerCalls === 1 && oldOwnerStale,
    newAuthorityControlDenied: newContextCode === "CAPABILITY_SESSION_MISMATCH",
    denied,
    ...p33AuditEvidence(events, "inside.png"),
  };
  assert.deepEqual(actual, {
    oldResourceClosedOrIsolated: true,
    newAuthorityControlDenied: true,
    denied: true,
    auditAttempts: 1,
    auditAllowedFieldsExact: true,
    rawPathsAbsent: true,
  });
  if (sessionLeaseRecorder.enabled) await sessionLeaseRecorder.observe("SEC02-P15-session-delete-closes-leases", actual);
});

test("SEC02 failed session retirement retains the stale owner and blocks replacement", async () => {
  const { broker, authority } = fixture();
  const firstContext = broker.beginAgentRun(authority, "session-a");
  const owner = broker.getResourceOwner(firstContext);
  registerOwnedResource(owner, async () => { throw new Error("synthetic lifecycle failure"); });
  broker.finishContext(firstContext);
  await assert.rejects(() => broker.retireSessionResources(authority, "session-a"), /synthetic lifecycle failure/);

  const secondContext = broker.beginAgentRun(authority, "session-a");
  assert.throws(() => broker.getResourceOwner(secondContext), error => error?.code === "CAPABILITY_CONTEXT_STALE");
  broker.finishContext(secondContext);
  await assert.rejects(() => broker.retireAuthority(authority), /synthetic lifecycle failure/);
});

test("SEC02 watcher initialization is owner-registered before native creation and drains on retirement", async () => {
  let nativeWatchCalls = 0;
  let releaseBarrier;
  let enterBarrier;
  const entered = new Promise(resolve => { enterBarrier = resolve; });
  const release = new Promise(resolve => { releaseBarrier = resolve; });
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 37),
    barrier: async point => {
      if (point !== "beforeWatcherCreate") return;
      enterBarrier();
      await release;
    },
    watchFactory: (target, options, listener) => {
      nativeWatchCalls += 1;
      return nodeFs.watch(target, options, listener);
    },
  });
  const pathAuthority = await policy.createAuthority([{
    rootId: "workspace",
    role: "workspace",
    configuredPath: brokerPathFixture,
    permissions: ["watch-directory"],
  }]);
  const broker = new CapabilityBroker({ resolveSessionPersona: () => "developer", pathPolicy: policy });
  broker.registerStaticTool({
    name: "watch_probe",
    definition: definition("watch_probe"),
    policy: { riskClasses: ["read", "control"], approval: "none", effects: ["filesystem", "control"], pathOperations: ["watch-directory"] },
    executor: async (_args, _env, invocation) => {
      const lease = await invocation.path.watchDirectory("", { defaultRootId: "workspace" }, () => undefined);
      await lease.close();
      return "watch-created";
    },
  });
  const authority = broker.createRuntimeAuthority({
    name: "developer",
    tools: ["watch_probe"],
    env: { DATA_ROOT: brokerPathFixture },
    rootEnv: { DATA_ROOT: "workspace" },
    systemPrompt: "watch retirement",
    allowedRoots: [brokerPathFixture],
    pathAuthority,
    networkPolicy: { mode: "deny" },
  });
  const context = broker.beginAgentRun(authority, "session-a");
  const inspected = broker.inspectToolCall(context, "watch_probe", {});
  const issued = broker.issueToolPathGateway(context, inspected);
  const invocation = broker.invokeTool(context, inspected, { path: issued.gateway });
  await entered;
  let retirementSettled = false;
  const retirement = broker.retireAuthority(authority).then(() => { retirementSettled = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(retirementSettled, false);
  releaseBarrier();
  await assert.rejects(invocation, error => error?.code === "PATH_AUTHORITY_STALE");
  await retirement;
  assert.equal(retirementSettled, true);
  assert.equal(nativeWatchCalls, 0, "retirement must linearize before native watcher creation");
});

test("SEC-02 child PathAuthority and ResourceOwner preserve only the exact root subset", async t => {
  const base = await p33TempFixture(t);
  const workspace = path.join(base, "workspace");
  const output = path.join(base, "output");
  await fs.mkdir(workspace);
  await fs.mkdir(output);
  await fs.writeFile(path.join(workspace, "inside.txt"), "WORKSPACE");
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 81) });
  const pathAuthority = await policy.createAuthority([
    p33Root("workspace", "workspace", workspace),
    p33Root("output", "output", output),
  ]);
  const broker = new CapabilityBroker({ resolveSessionPersona: () => "developer", pathPolicy: policy });
  registerP33ReadTool(broker);
  const authority = createP33RuntimeAuthority(broker, pathAuthority, [workspace, output]);
  const root = broker.beginAgentRun(authority, "session-a");
  const child = broker.deriveChild(root, { principal: "subagent", tools: ["p33_read"], allowedRoots: ["workspace"] });
  const parentOwner = broker.getResourceOwner(root);
  const childOwner = broker.getResourceOwner(child);
  const value = await invokeP33Read(broker, child);
  const broadenCode = expectCode(
    () => broker.deriveChild(child, { principal: "subagent", tools: ["p33_read"], allowedRoots: ["workspace", "output"] }),
    "CAPABILITY_ATTENUATION_INVALID"
  );
  const childMetadata = assertResourceOwner(childOwner);
  const actual = {
    exactIdentityRequired: value === "WORKSPACE" && childOwner !== parentOwner,
    noBroaderFallback: broadenCode === "CAPABILITY_ATTENUATION_INVALID" && !child.allowedRoots.includes("output"),
    passed: value === "WORKSPACE",
    exactSubset: JSON.stringify(child.allowedRoots) === JSON.stringify(["workspace"])
      && JSON.stringify(childMetadata.rootIds) === JSON.stringify(["workspace"]),
  };
  assert.deepEqual(actual, {
    exactIdentityRequired: true,
    noBroaderFallback: true,
    passed: true,
    exactSubset: true,
  });
  if (p33SubsetRecorder.enabled) await p33SubsetRecorder.observe("SEC02-P33-child-subset", actual);
  broker.finishContext(child);
  broker.finishContext(root);
  broker.revokeAuthority(authority);
});

test("SEC-02 same configured root string cannot substitute a new filesystem identity", async t => {
  const base = await p33TempFixture(t);
  const workspace = path.join(base, "workspace");
  const preserved = path.join(base, "preserved-workspace");
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "inside.txt"), "OLD");
  const events = [];
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 82), auditSink: event => events.push(event) });
  const broker = new CapabilityBroker({ resolveSessionPersona: () => "developer", pathPolicy: policy });
  registerP33ReadTool(broker);

  const oldPathAuthority = await policy.createAuthority([p33Root("workspace", "workspace", workspace)]);
  const oldAuthority = createP33RuntimeAuthority(broker, oldPathAuthority, [workspace]);
  const oldRoot = broker.beginAgentRun(oldAuthority, "session-a");
  const oldChild = broker.deriveChild(oldRoot, { principal: "subagent", tools: ["p33_read"], allowedRoots: ["workspace"] });
  const oldOwner = broker.getResourceOwner(oldChild);

  await fs.rename(workspace, preserved);
  await fs.mkdir(workspace);
  await fs.writeFile(path.join(workspace, "inside.txt"), "NEW");
  const newPathAuthority = await policy.createAuthority([p33Root("workspace", "workspace", workspace)]);
  const newAuthority = createP33RuntimeAuthority(broker, newPathAuthority, [workspace]);
  const newRoot = broker.beginAgentRun(newAuthority, "session-b");
  const newChild = broker.deriveChild(newRoot, { principal: "subagent", tools: ["p33_read"], allowedRoots: ["workspace"] });
  const newOwner = broker.getResourceOwner(newChild);

  let denied = false;
  let oldValue = null;
  try { oldValue = await invokeP33Read(broker, oldChild); }
  catch (error) { denied = error?.code === "PATH_IDENTITY_CHANGED"; }
  const newValue = await invokeP33Read(broker, newChild);
  const actual = {
    exactIdentityRequired: denied && newValue === "NEW" && oldOwner !== newOwner,
    noBroaderFallback: denied && oldValue === null,
    denied,
    ...p33AuditEvidence(events, "inside.txt"),
  };
  assert.deepEqual(actual, {
    exactIdentityRequired: true,
    noBroaderFallback: true,
    denied: true,
    auditAttempts: 1,
    auditAllowedFieldsExact: true,
    rawPathsAbsent: true,
  });
  if (p33SameStringRecorder.enabled) await p33SameStringRecorder.observe("SEC02-P33-same-string-new-identity", actual);
  broker.finishContext(oldChild);
  broker.finishContext(oldRoot);
  broker.finishContext(newChild);
  broker.finishContext(newRoot);
  broker.revokeAuthority(oldAuthority);
  broker.revokeAuthority(newAuthority);
});

test("SEC-02 Broker gateway denies root object replacement during an in-flight read", async t => {
  const base = await p33TempFixture(t);
  const workspace = path.join(base, "workspace");
  const preserved = path.join(base, "preserved-workspace");
  const outside = path.join(base, "outside");
  await fs.mkdir(workspace);
  await fs.mkdir(outside);
  await fs.writeFile(path.join(workspace, "inside.txt"), "ORIGINAL");
  await fs.writeFile(path.join(outside, "inside.txt"), "OUTSIDE");
  const events = [];
  let replaced = false;
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 83),
    auditSink: event => events.push(event),
    barrier: async point => {
      if (point !== "afterLexicalContainment" || replaced) return;
      replaced = true;
      await fs.rename(workspace, preserved);
      await fs.symlink(outside, workspace, "junction");
    },
  });
  const pathAuthority = await policy.createAuthority([p33Root("workspace", "workspace", workspace)]);
  const broker = new CapabilityBroker({ resolveSessionPersona: () => "developer", pathPolicy: policy });
  registerP33ReadTool(broker);
  const authority = createP33RuntimeAuthority(broker, pathAuthority, [workspace]);
  const root = broker.beginAgentRun(authority, "session-a");
  const child = broker.deriveChild(root, { principal: "subagent", tools: ["p33_read"], allowedRoots: ["workspace"] });
  let denied = false;
  let returned = null;
  try { returned = await invokeP33Read(broker, child); }
  catch (error) { denied = error?.code === "PATH_IDENTITY_CHANGED"; }
  const actual = {
    exactIdentityRequired: denied && replaced,
    noBroaderFallback: denied && returned === null,
    denied,
    ...p33AuditEvidence(events, "inside.txt"),
  };
  assert.deepEqual(actual, {
    exactIdentityRequired: true,
    noBroaderFallback: true,
    denied: true,
    auditAttempts: 1,
    auditAllowedFieldsExact: true,
    rawPathsAbsent: true,
  });
  if (p33ReplacementRecorder.enabled) await p33ReplacementRecorder.observe("SEC02-P33-root-replacement", actual);
  broker.finishContext(child);
  broker.finishContext(root);
  broker.revokeAuthority(authority);
});

test("SEC-02 attenuated child gateway cannot fall back to broader parent roots", async t => {
  const base = await p33TempFixture(t);
  const workspace = path.join(base, "workspace");
  const output = path.join(base, "output");
  await fs.mkdir(workspace);
  await fs.mkdir(output);
  await fs.writeFile(path.join(workspace, "inside.txt"), "PARENT-WORKSPACE");
  const events = [];
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 84), auditSink: event => events.push(event) });
  const pathAuthority = await policy.createAuthority([
    p33Root("workspace", "workspace", workspace),
    p33Root("output", "output", output),
  ]);
  const broker = new CapabilityBroker({ resolveSessionPersona: () => "developer", pathPolicy: policy });
  registerP33ReadTool(broker);
  const authority = createP33RuntimeAuthority(broker, pathAuthority, [workspace, output]);
  const root = broker.beginAgentRun(authority, "session-a");
  const child = broker.deriveChild(root, { principal: "subagent", tools: ["p33_read"], allowedRoots: ["output"] });
  const parentValue = await invokeP33Read(broker, root);
  let denied = false;
  let childValue = null;
  try { childValue = await invokeP33Read(broker, child); }
  catch (error) { denied = error?.code === "PATH_ROOT_DENIED"; }
  const actual = {
    exactIdentityRequired: denied && JSON.stringify(assertResourceOwner(broker.getResourceOwner(child)).rootIds) === JSON.stringify(["output"]),
    noBroaderFallback: denied && parentValue === "PARENT-WORKSPACE" && childValue === null,
    denied,
    ...p33AuditEvidence(events, "inside.txt"),
  };
  assert.deepEqual(actual, {
    exactIdentityRequired: true,
    noBroaderFallback: true,
    denied: true,
    auditAttempts: 1,
    auditAllowedFieldsExact: true,
    rawPathsAbsent: true,
  });
  if (p33FallbackRecorder.enabled) await p33FallbackRecorder.observe("SEC02-P33-broader-parent-fallback-denied", actual);
  broker.finishContext(child);
  broker.finishContext(root);
  broker.revokeAuthority(authority);
});

test("SEC02 new authority cannot reuse the previous ResourceOwner", async () => {
  const sessions = new Map([["session-a", "developer"]]);
  const broker = createBroker({ resolveSessionPersona: id => sessions.get(id) ?? null });
  const input = {
    name: "developer", tools: [], env: { WORKSPACE_ROOT: "C:/workspace" }, systemPrompt: "x",
    allowedRoots: ["C:/workspace"], networkPolicy: { mode: "deny" },
  };
  const firstAuthority = createAuthority(broker, input);
  const firstContext = broker.beginAgentRun(firstAuthority, "session-a");
  const firstOwner = broker.getResourceOwner(firstContext);
  broker.finishContext(firstContext);
  await broker.retireAuthority(firstAuthority);
  const secondAuthority = createAuthority(broker, input);
  const secondContext = broker.beginAgentRun(secondAuthority, "session-a");
  const secondOwner = broker.getResourceOwner(secondContext);
  assert.notEqual(firstOwner, secondOwner);
  assert.throws(() => assertResourceOwner(firstOwner), error => error?.code === "PATH_AUTHORITY_STALE");
  assert.equal(assertResourceOwner(secondOwner).authorityId, secondAuthority.authorityId);
  broker.finishContext(secondContext);
  broker.revokeAuthority(secondAuthority);
});

test("SEC02 output reservation is authentic, one-use, and invocation-bound", async () => {
  const broker = createBroker({ resolveSessionPersona: () => "developer" });
  let replayCode = null;
  broker.registerStaticTool({
    name: "reserve_output",
    definition: definition("reserve_output"),
    policy: filesystemWritePolicy,
    executor: async (_args, _env, invocation) => {
      const reservation = await invocation.path.reserveFile("reserved-output.txt", {
        defaultRootId: "workspace",
        maxBytes: 1024,
        requiredExtension: ".txt",
      });
      await reservation.commit(Buffer.from("reserved"));
      try { await reservation.commit(Buffer.from("replay")); }
      catch (error) { replayCode = error?.code; }
      return "reserved";
    },
  });
  const authority = createAuthority(broker, {
    name: "developer", tools: ["reserve_output"], env: { WORKSPACE_ROOT: "C:/workspace" }, systemPrompt: "x",
    allowedRoots: ["C:/workspace"], networkPolicy: { mode: "deny" },
  });
  const context = broker.beginAgentRun(authority, "session-a");
  const inspected = broker.inspectToolCall(context, "reserve_output", {});
  const issued = broker.issueToolPathGateway(context, inspected);
  assert.equal(await broker.invokeTool(context, inspected, { path: issued.gateway }), "reserved");
  assert.equal(replayCode, "CAPABILITY_GRANT_REPLAYED");
  assert.equal(await fs.readFile(path.join(brokerPathFixture, "reserved-output.txt"), "utf8"), "reserved");
  issued.close();
  broker.finishContext(context);
});

test("SEC02 Broker rejects forged or multiply-bound PathAuthority", async () => {
  const broker = createBroker({ resolveSessionPersona: () => "developer" });
  const prepared = authorityInput({ name: "developer", tools: [], env: {}, systemPrompt: "x", allowedRoots: [], networkPolicy: { mode: "deny" } });
  broker.createRuntimeAuthority(prepared);
  expectCode(() => broker.createRuntimeAuthority(prepared), "CAPABILITY_REGISTRATION_INVALID");

  const foreignPolicy = new PathPolicy({ auditKey: Buffer.alloc(32, 32) });
  const foreignAuthority = await foreignPolicy.createAuthority([]);
  expectCode(() => broker.createRuntimeAuthority({
    name: "developer", tools: [], env: {}, systemPrompt: "x", allowedRoots: [], rootEnv: {},
    pathAuthority: foreignAuthority, networkPolicy: { mode: "deny" },
  }), "CAPABILITY_REGISTRATION_INVALID");
});

test("SEC02 unavailable root env never reaches an executor", async () => {
  let capturedEnv;
  const broker = createBroker({ resolveSessionPersona: () => "developer" });
  broker.registerStaticTool({
    name: "capture_env",
    definition: definition("capture_env"),
    policy: readPolicy,
    executor: async (_args, env) => { capturedEnv = env; return "ok"; },
  });
  const pathAuthority = brokerPathPolicy.deriveAuthority(brokerBasePathAuthority, []);
  const authority = broker.createRuntimeAuthority({
    name: "developer",
    tools: ["capture_env"],
    env: { WORKSPACE_ROOT: "C:/must-not-leak", MODE: "safe" },
    systemPrompt: "x",
    allowedRoots: ["C:/must-not-leak"],
    rootEnv: { WORKSPACE_ROOT: null },
    pathAuthority,
    networkPolicy: { mode: "deny" },
  });
  const context = broker.beginAgentRun(authority, "session-a");
  assert.equal(await invoke(broker, context, "capture_env"), "ok");
  assert.equal(capturedEnv.WORKSPACE_ROOT, undefined);
  assert.equal(capturedEnv.MODE, "safe");
  assert.equal(capturedEnv._CAPABILITY_ALLOWED_ROOTS, "[]");
  broker.finishContext(context);
});

test("SEC-02 coverage recovery closes Broker constructor, root mapping and direct API edge branches", async () => {
  assert.throws(() => new CapabilityBroker(null), /requires PathPolicy/);
  assert.throws(() => canonicalDigest(Number.NaN), TypeError);
  const sessions = new Map([["session-a", "developer"]]);
  const broker = createBroker({ resolveSessionPersona: id => sessions.get(id) ?? null });
  const read = registered("coverage_read");
  const approved = registered("coverage_approved", writePolicy);
  broker.registerStaticTool(read.tool);
  broker.registerStaticTool(approved.tool);
  assert.throws(() => broker.registerStaticTool(registered("bad_empty_risk", { riskClasses: [""], approval: "none", effects: [] }).tool), TypeError);
  assert.throws(() => broker.registerStaticTool(registered("bad_null_risk", { riskClasses: null, approval: "none", effects: [] }).tool), TypeError);
  assert.throws(() => broker.registerStaticTool(registered("bad_path_effect", { riskClasses: ["read"], approval: "none", effects: [], pathOperations: ["read-file"] }).tool), TypeError);

  const authorityFor = (rootEnv, env = {}) => broker.createRuntimeAuthority({
    name: "developer",
    tools: ["coverage_read", "coverage_approved"],
    env,
    rootEnv,
    systemPrompt: "coverage",
    allowedRoots: [],
    pathAuthority: brokerPathPolicy.deriveAuthority(brokerBasePathAuthority, []),
    networkPolicy: { mode: "deny" },
  });
  assert.throws(() => authorityFor(null), /root env mapping is invalid/);
  expectCode(() => authorityFor({ MISSING: null }), "CAPABILITY_REGISTRATION_INVALID");
  expectCode(() => authorityFor({ WORKSPACE_ROOT: "workspace" }, { WORKSPACE_ROOT: "hidden" }), "CAPABILITY_REGISTRATION_INVALID");

  const authority = authorityFor({}, {});
  const root = broker.beginAgentRun(authority, "session-a");
  assert.throws(() => broker.inspectToolCall(root, "coverage_read", []), /plain object/);
  assert.throws(() => broker.inspectToolCall(root, "coverage_read", new Date()), /plain object/);
  const approvedCall = broker.inspectToolCall(root, "coverage_approved", { value: "x" });
  assert.throws(() => broker.createApprovalChallenge(root, approvedCall, 0), /lifetime is invalid/);
  assert.throws(() => broker.createApprovalChallenge(root, approvedCall, 60_001), /lifetime is invalid/);
  await assert.rejects(() => broker.retireSessionResources(authority, ""), TypeError);

  broker.registerDirectOperation("coverage:user", writePolicy);
  broker.registerDirectOperation("coverage:network", networkPolicy);
  broker.registerDirectOperation("coverage:cwd", { riskClasses: ["read", "write", "process"], approval: "none", effects: ["filesystem", "process"], pathOperations: ["initial-cwd"], executionRootAccess: "read-write" });
  const principal = broker.createLocalApiPrincipal();
  expectCode(() => broker.issueLocalApiContext({ authority, principal: { ...principal }, sessionId: "session-a", operation: "coverage:cwd", args: {} }), "CAPABILITY_CONTEXT_FORGED");
  expectCode(() => broker.issueLocalApiContext({ authority, principal, sessionId: "session-a", operation: "coverage:user", args: {} }), "CAPABILITY_DIRECT_OPERATION_DENIED");
  expectCode(() => broker.issueLocalApiContext({ authority, principal, sessionId: "session-a", operation: "coverage:network", args: {} }), "CAPABILITY_RISK_DENIED");
  expectCode(() => broker.authorizeDirectOperation(root, "coverage:cwd", {}), "CAPABILITY_DIRECT_OPERATION_DENIED");

  const direct = broker.issueLocalApiContext({ authority, principal, sessionId: "session-a", operation: "coverage:cwd", args: { cwd: "" } });
  await assert.rejects(() => broker.withDirectExecutionRoot(direct, "coverage:cwd", "", "WORKSPACE_ROOT", () => undefined), error => error?.code === "CAPABILITY_DIRECT_OPERATION_DENIED");
  expectCode(() => broker.authorizeDirectOperation(direct, "coverage:other", { cwd: "" }), "CAPABILITY_DIRECT_OPERATION_DENIED");
  expectCode(() => broker.authorizeDirectOperation(direct, "coverage:cwd", { cwd: "changed" }), "CAPABILITY_DIRECT_OPERATION_DENIED");
  assert.deepEqual(broker.authorizeDirectOperation(direct, "coverage:cwd", { cwd: "" }), { cwd: "" });
  expectCode(() => broker.authorizeDirectOperation(direct, "coverage:cwd", { cwd: "" }), "CAPABILITY_GRANT_REPLAYED");
  await assert.rejects(() => broker.withDirectExecutionRoot(direct, "coverage:cwd", "", "WORKSPACE_ROOT", () => undefined), error => error?.code === "CAPABILITY_RISK_DENIED");
  expectCode(() => broker.invokeTool(direct, broker.inspectToolCall(root, "coverage_read", {})), "CAPABILITY_TOOL_DENIED");
  broker.finishContext(direct);
  broker.finishContext(root);
  await broker.retireAuthority(authority);
});

test("SEC01 network and risk attenuation covers loopback and allowlist subsets", () => {
  const loopback = fixture({ networkPolicy: { mode: "loopback" } });
  const loopRoot = loopback.broker.beginAgentRun(loopback.authority, "session-a");
  const loopChild = loopback.broker.deriveChild(loopRoot, { principal: "subagent", networkPolicy: { mode: "loopback" } });
  assert.equal(loopChild.networkPolicy.mode, "loopback");
  expectCode(() => loopback.broker.deriveChild(loopRoot, { principal: "subagent", tools: ["read_value"], allowedRiskClasses: ["write"] }), "CAPABILITY_ATTENUATION_INVALID");
  expectCode(() => loopback.broker.deriveChild(loopRoot, { principal: "subagent", allowedRiskClasses: ["unknown"] }), "CAPABILITY_ATTENUATION_INVALID");
  expectCode(() => loopback.broker.deriveChild(loopRoot, { principal: "subagent", networkPolicy: { mode: "allowlist", origins: ["https://a.test"] } }), "CAPABILITY_ATTENUATION_INVALID");
  loopback.broker.finishContext(loopRoot);

  const allowed = fixture({ networkPolicy: { mode: "allowlist", origins: ["https://a.test", "https://b.test"] } });
  const allowedRoot = allowed.broker.beginAgentRun(allowed.authority, "session-a");
  const narrowed = allowed.broker.deriveChild(allowedRoot, { principal: "subagent", networkPolicy: { mode: "allowlist", origins: ["https://a.test"] } });
  assert.deepEqual(narrowed.networkPolicy, { mode: "allowlist", origins: ["https://a.test"] });
  expectCode(() => allowed.broker.deriveChild(allowedRoot, { principal: "subagent", networkPolicy: { mode: "allowlist", origins: ["https://evil.test"] } }), "CAPABILITY_ATTENUATION_INVALID");
  allowed.broker.finishContext(allowedRoot);
});
