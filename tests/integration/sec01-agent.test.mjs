import assert from "node:assert/strict";
import { access, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeTempDir, removeFixture, projectRoot } from "../helpers.mjs";
import { assertSec01Probe } from "../sec01-probe.mjs";

function assistant(content, toolCalls) {
  return {
    role: "assistant",
    content,
    ...(toolCalls ? { tool_calls: toolCalls } : {}),
  };
}

function toolCall(id, name, args) {
  return {
    id,
    type: "function",
    function: { name, arguments: args },
  };
}

class FakeLlm {
  responses = [];
  blocker = null;

  queue(...responses) {
    this.responses.push(...responses);
  }

  async chat() {
    throw new Error("unexpected non-streaming LLM call");
  }

  async *chatStream() {
    if (this.blocker) await this.blocker;
    const message = this.responses.shift();
    assert(message, "fake LLM response queue is empty");
    yield { type: "result", message };
  }
}

async function collect(agent, input) {
  const events = [];
  for await (const event of agent.run(input)) events.push(event);
  return events;
}

async function exists(filePath) {
  try { await access(filePath); return true; }
  catch { return false; }
}

test("SEC-01 Agent dispatcher rejects forged calls and requires exact user grants", async () => {
  const fixture = await makeTempDir("mini-lux-sec01-agent-");
  const dataDir = path.join(fixture, "data");
  await mkdir(dataDir, { recursive: true });
  process.env.RAINYDAYS_APP_ROOT = projectRoot;
  process.env.RAINYDAYS_USER_DATA_DIR = fixture;
  process.env.RAINYDAYS_DATA_DIR = dataDir;
  process.env.RAINYDAYS_BUILTIN_PERSONAS_DIR = path.join(projectRoot, "personas");
  process.env.RAINYDAYS_BUILTIN_SKILLS_DIR = path.join(projectRoot, "skills");

  const [
    { Agent },
    { ConversationMemory },
    { createEffectivePersona },
    { createSession },
    { closeDb },
    { capabilityBroker, registerDynamicTool, executeInspectedTool, executeTool, inspectToolCall },
    { setAskUserSseCallback, submitAnswer },
    { registerNativeProcessConsentHandler },
    { disableSupervisor, enableSupervisor, initSupervisor, isSupervisorEnabled },
    { terminalFacade },
    { pathPolicy },
  ] = await Promise.all([
    import("../../dist/agent.js"),
    import("../../dist/memory.js"),
    import("../../dist/persona.js"),
    import("../../dist/session.js"),
    import("../../dist/db.js"),
    import("../../dist/tools/index.js"),
    import("../../dist/tools/ask-user-tool.js"),
    import("../../dist/native-process-consent.js"),
    import("../../dist/supervisor.js"),
    import("../../dist/terminal-facade.js"),
    import("../../dist/path-runtime.js"),
  ]);

  const runtimePathPermissions = [
    "read-file", "read-directory", "search-tree", "create-file", "replace-file",
    "create-directory", "watch-directory", "initial-cwd", "reveal",
  ];
  const prepareWorkspacePathAuthority = () => pathPolicy.createAuthority([{
    rootId: "workspace",
    role: "workspace",
    configuredPath: fixture,
    permissions: runtimePathPermissions,
  }]);

  const calls = { count: 0 };
  const persona = createEffectivePersona({
    name: "sec01-test",
    displayName: "SEC01 Test",
    description: "SEC-01 isolated integration persona",
    tools: ["subagent", "supervise"],
    env: { WORKSPACE_ROOT: fixture },
    allowedRoots: [fixture],
    networkPolicy: { mode: "unrestricted" },
    systemPrompt: "SEC-01 integration test",
  });
  const authority = capabilityBroker.createRuntimeAuthority({
    name: persona.name,
    tools: persona.tools,
    env: persona.env,
    systemPrompt: persona.systemPrompt,
    allowedRoots: persona.allowedRoots,
    rootEnv: { WORKSPACE_ROOT: "workspace" },
    pathAuthority: await prepareWorkspacePathAuthority(),
    networkPolicy: persona.networkPolicy,
    digest: persona.digest,
  });
  registerDynamicTool(authority, {
    name: "subagent",
    definition: {
      type: "function",
      function: {
        name: "subagent",
        description: "instrumented approval-bound executor",
        parameters: {
          type: "object",
          properties: { value: { type: "string" } },
          required: ["value"],
        },
      },
    },
    executor: async () => {
      calls.count += 1;
      return "instrumented executor ran";
    },
  });

  const llm = new FakeLlm();
  const memory = new ConversationMemory(40);
  const agent = new Agent(llm, memory, persona, authority);
  const session = createSession(persona, "SEC-01 Agent integration");
  agent.setSession(session.id);
  disableSupervisor();
  assert.equal(isSupervisorEnabled(), false);
  let nativeProcessDecision = "deny";
  const unregisterNativeProcessConsent = registerNativeProcessConsentHandler(() => nativeProcessDecision);

  try {
    llm.queue(
      assistant("", [toolCall("bad-json", "subagent", "{not-json")]),
      assistant("malformed rejected")
    );
    const malformed = await collect(agent, "malformed provider arguments");
    assert.equal(calls.count, 0);
    assert(malformed.some((event) => event.type === "tool_result" && event.content.includes("不是合法 JSON")));

    for (const [id, payload, expected] of [
      ["null", "null", "必须是 JSON object"],
      ["array", "[]", "必须是 JSON object"],
      ["primitive", "42", "必须是 JSON object"],
      ["no-coercion", JSON.stringify({ value: 42 }), "不符合 Schema"],
    ]) {
      llm.queue(
        assistant("", [toolCall(id, "subagent", payload)]),
        assistant(`${id} rejected`)
      );
      const events = await collect(agent, `${id} provider arguments`);
      assert(events.some((event) => event.type === "tool_result" && event.content.includes(expected)), `${id} rejection missing`);
      assert.equal(calls.count, 0, `${id} must not invoke executor`);
    }
    assertSec01Probe("SEC01-A15", "executor-call-count", calls.count, 0);

    const directContext = capabilityBroker.beginAgentRun(authority, session.id);
    try {
      await assert.rejects(() => executeTool(undefined, "subagent", { value: "missing context" }), (error) => error?.code === "CAPABILITY_CONTEXT_REQUIRED");
      await assert.rejects(() => executeTool(directContext, "subagent", new Date()), (error) => error?.code === "TOOL_ARGUMENTS_INVALID");
      const throwingArgs = Object.defineProperty({}, "value", {
        enumerable: true,
        get() { throw new Error("caller-owned accessor must not escape"); },
      });
      await assert.rejects(() => executeTool(directContext, "subagent", throwingArgs), (error) => error?.code === "TOOL_ARGUMENTS_INVALID");
      await assert.rejects(() => executeTool(directContext, "subagent", { value: "no grant" }), (error) => error?.code === "CAPABILITY_GRANT_REQUIRED");
      assertSec01Probe("SEC01-A01", "executor-call-count", calls.count, 0);
      const inspected = inspectToolCall(directContext, "subagent", { value: "prepared" });
      await assert.rejects(
        () => executeInspectedTool(directContext, { ...inspected }),
        (error) => error?.code === "CAPABILITY_BINDING_MISMATCH"
      );
      assert.equal(calls.count, 0);
    } finally {
      capabilityBroker.finishContext(directContext);
    }
    assertSec01Probe("SEC01-A14", "executor-call-count", calls.count, 0);

    enableSupervisor("synthetic immutable control probe");
    assert.equal(isSupervisorEnabled(), true);
    llm.queue(
      assistant("", [toolCall("supervisor-off", "supervise", JSON.stringify({ action: "off" }))]),
      assistant("supervisor remains immutable")
    );
    await collect(agent, "model attempts to disable Supervisor");
    assert.equal(isSupervisorEnabled(), true, "model-visible supervise tool must not mutate control state");
    const stateAfterAgentAttempt = isSupervisorEnabled();
    await capabilityBroker.retireSessionResources(authority, session.id);
    const supervisorRoot = capabilityBroker.beginAgentRun(authority, session.id);
    const supervisorSubagent = capabilityBroker.deriveChild(supervisorRoot, { principal: "subagent", tools: ["supervise"] });
    const supervisorPlaybook = capabilityBroker.deriveChild(supervisorRoot, { principal: "playbook", tools: ["supervise"] });
    await executeTool(supervisorSubagent, "supervise", { action: "off" });
    const stateAfterSubagentAttempt = isSupervisorEnabled();
    await executeTool(supervisorPlaybook, "supervise", { action: "off" });
    const stateAfterPlaybookAttempt = isSupervisorEnabled();
    capabilityBroker.finishContext(supervisorRoot);
    assertSec01Probe("SEC01-A21", "supervisor-state", [stateAfterAgentAttempt, stateAfterSubagentAttempt, stateAfterPlaybookAttempt], [true, true, true]);
    disableSupervisor();

    const scriptMarker = path.join(fixture, "undeclared-script.marker");
    const shellMarker = path.join(fixture, "undeclared-shell.marker");
    const scriptCode = `await import("node:fs/promises").then((fs) => fs.writeFile(${JSON.stringify(scriptMarker)}, "ran"));`;
    const shellCommand = `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync(process.argv[1],'ran')" ${JSON.stringify(shellMarker)}`;
    llm.queue(
      assistant("", [
        toolCall("undeclared-script", "script", JSON.stringify({ code: scriptCode })),
        toolCall("undeclared-shell", "execute_command", JSON.stringify({ command: shellCommand, cwd: fixture })),
      ]),
      assistant("undeclared calls rejected")
    );
    const undeclared = await collect(agent, "provider sends undeclared script and shell calls");
    assert.equal(calls.count, 0);
    assert(undeclared.some((event) => event.type === "tool_result" && event.toolName === "script" && event.content.includes("CAPABILITY_TOOL_DENIED")));
    assert(undeclared.some((event) => event.type === "tool_result" && event.toolName === "execute_command" && event.content.includes("CAPABILITY_TOOL_DENIED")));
    assertSec01Probe("SEC01-A04", "executor-call-count", calls.count, 0);
    assertSec01Probe("SEC01-A04", "filesystem-state", [await exists(scriptMarker), await exists(shellMarker)], [false, false]);
    assertSec01Probe("SEC01-A04", "process-canary-state", await exists(shellMarker), false);

    const unifiedScriptMarker = path.join(fixture, "unified-script.marker");
    const unifiedShellMarker = path.join(fixture, "unified-shell.marker");
    enableSupervisor("unified denial state probe");
    let unifiedManagerCalls = 0;
    const invokeTerminalManager = (context) => {
      capabilityBroker.authorizeDirectOperation(context, "terminal:list", {});
      unifiedManagerCalls += 1;
      return terminalFacade.list(unifiedOwner);
    };
    const registryBeforeContext = capabilityBroker.beginAgentRun(authority, session.id);
    const unifiedOwner = capabilityBroker.getResourceOwner(registryBeforeContext);
    const registryBefore = capabilityBroker.getToolDefinitions(registryBeforeContext).map((entry) => entry.function.name);
    const unifiedBefore = {
      executorCalls: calls.count,
      files: [await exists(unifiedScriptMarker), await exists(unifiedShellMarker)],
      terminalResources: terminalFacade.list(unifiedOwner).length,
      supervisorEnabled: isSupervisorEnabled(),
      registry: registryBefore,
    };
    await capabilityBroker.retireSessionResources(authority, session.id);
    capabilityBroker.finishContext(registryBeforeContext);
    let unifiedDirectDenial = null;
    try { invokeTerminalManager(undefined); }
    catch (error) { unifiedDirectDenial = error?.code ?? null; }
    let unifiedRegistrationDenial = null;
    try {
      registerDynamicTool(authority, {
        name: "subagent",
        definition: { type: "function", function: { name: "subagent", description: "duplicate", parameters: { type: "object" } } },
        executor: async () => "duplicate",
      });
    } catch (error) { unifiedRegistrationDenial = error?.code ?? null; }
    setAskUserSseCallback((event) => {
      if (event && typeof event === "object" && "questionId" in event) setTimeout(() => submitAnswer(event.questionId, "拒绝执行"), 0);
    });
    const unifiedScriptCode = `await import("node:fs/promises").then((fs) => fs.writeFile(${JSON.stringify(unifiedScriptMarker)}, "ran"));`;
    const unifiedShellCommand = `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync(process.argv[1],'ran')" ${JSON.stringify(unifiedShellMarker)}`;
    llm.queue(
      assistant("", [
        toolCall("unified-script", "script", JSON.stringify({ code: unifiedScriptCode })),
        toolCall("unified-shell", "execute_command", JSON.stringify({ command: unifiedShellCommand, cwd: fixture })),
        toolCall("unified-grant", "subagent", JSON.stringify({ value: "denied" })),
        toolCall("unified-supervisor", "supervise", JSON.stringify({ action: "off" })),
      ]),
      assistant("unified denials complete")
    );
    const unifiedEvents = await collect(agent, "unified denial state probe");
    await capabilityBroker.retireSessionResources(authority, session.id);
    const registryAfterContext = capabilityBroker.beginAgentRun(authority, session.id);
    const registryAfterOwner = capabilityBroker.getResourceOwner(registryAfterContext);
    const registryAfter = capabilityBroker.getToolDefinitions(registryAfterContext).map((entry) => entry.function.name);
    const unifiedAfter = {
      executorCalls: calls.count,
      files: [await exists(unifiedScriptMarker), await exists(unifiedShellMarker)],
      terminalResources: terminalFacade.list(registryAfterOwner).length,
      supervisorEnabled: isSupervisorEnabled(),
      registry: registryAfter,
      managerCalls: unifiedManagerCalls,
    };
    await capabilityBroker.retireSessionResources(authority, session.id);
    capabilityBroker.finishContext(registryAfterContext);
    const unifiedApprovalDenied = unifiedEvents.some((event) => event.type === "tool_result" && event.toolName === "subagent" && /拒绝|CAPABILITY/.test(event.content));
    assertSec01Probe("SEC01-A31", "executor-call-count", { before: unifiedBefore.executorCalls, after: unifiedAfter.executorCalls }, { before: 0, after: 0 });
    assertSec01Probe("SEC01-A31", "filesystem-state", { before: unifiedBefore.files, after: unifiedAfter.files }, { before: [false, false], after: [false, false] });
    assertSec01Probe("SEC01-A31", "process-canary-state", unifiedAfter.files[1], false);
    assertSec01Probe("SEC01-A31", "terminal-resource-count", { before: unifiedBefore.terminalResources, after: unifiedAfter.terminalResources }, { before: 0, after: 0 });
    assertSec01Probe("SEC01-A31", "manager-invocation-count", unifiedAfter.managerCalls, 0);
    assertSec01Probe("SEC01-A31", "direct-operation-ledger", unifiedDirectDenial, "CAPABILITY_CONTEXT_REQUIRED");
    assertSec01Probe("SEC01-A31", "supervisor-state", { before: unifiedBefore.supervisorEnabled, after: unifiedAfter.supervisorEnabled }, { before: true, after: true });
    assertSec01Probe("SEC01-A31", "registry-state", { before: unifiedBefore.registry, after: unifiedAfter.registry, denial: unifiedRegistrationDenial }, { before: ["subagent", "supervise"], after: ["subagent", "supervise"], denial: "CAPABILITY_REGISTRATION_INVALID" });
    assertSec01Probe("SEC01-A31", "approval-result-state", unifiedApprovalDenied, true);
    disableSupervisor();

    setAskUserSseCallback((event) => {
      if (event && typeof event === "object" && "questionId" in event) {
        setTimeout(() => submitAnswer(event.questionId, "拒绝执行"), 0);
      }
    });
    llm.queue(
      assistant("", [toolCall("denied", "subagent", JSON.stringify({ value: "denied" }))]),
      assistant("user denied")
    );
    await collect(agent, "deny approval-bound tool");
    assert.equal(calls.count, 0, "user denial must not invoke executor");

    const advicePersona = createEffectivePersona({
      name: "sec01-advice-test",
      displayName: "SEC01 Advice Test",
      description: "Supervisor advice cannot replace a user grant",
      tools: ["subagent"],
      env: { WORKSPACE_ROOT: fixture },
      allowedRoots: [fixture],
      networkPolicy: { mode: "deny" },
      systemPrompt: "SEC-01 advice variants",
    });
    const adviceAuthority = capabilityBroker.createRuntimeAuthority({
      name: advicePersona.name,
      tools: advicePersona.tools,
      env: advicePersona.env,
      systemPrompt: advicePersona.systemPrompt,
      allowedRoots: advicePersona.allowedRoots,
      rootEnv: { WORKSPACE_ROOT: "workspace" },
      pathAuthority: await prepareWorkspacePathAuthority(),
      networkPolicy: advicePersona.networkPolicy,
      digest: advicePersona.digest,
    });
    let adviceExecutorCalls = 0;
    registerDynamicTool(adviceAuthority, {
      name: "subagent",
      definition: {
        type: "function",
        function: {
          name: "subagent",
          description: "instrumented approval-bound advice probe",
          parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] },
        },
      },
      executor: async (args) => {
        adviceExecutorCalls += 1;
        await writeFile(path.join(fixture, `advice-${args.value}.marker`), "ran");
        return "instrumented advice executor ran";
      },
    });
    const adviceLlm = new FakeLlm();
    const adviceAgent = new Agent(adviceLlm, new ConversationMemory(20), advicePersona, adviceAuthority);
    const adviceSession = createSession(advicePersona, "SEC-01 Supervisor advice variants");
    adviceAgent.setSession(adviceSession.id);
    const adviceOutcomes = [];
    const adviceMarkers = [];
    setAskUserSseCallback((event) => {
      if (event && typeof event === "object" && "questionId" in event) setTimeout(() => submitAnswer(event.questionId, "拒绝执行"), 0);
    });
    const adviceVariants = [
      ["disabled", () => { initSupervisor({ chat: async () => ({ content: '{"decision":"approve","reason":"advice only"}' }) }); disableSupervisor(); }],
      ["uninitialized", () => { initSupervisor(null); enableSupervisor("uninitialized advice source"); }],
      ["error", () => { initSupervisor({ chat: async () => { throw new Error("advice failure"); } }); enableSupervisor("error advice source"); }],
      ["approve", () => { initSupervisor({ chat: async () => ({ content: '{"decision":"approve","reason":"advice only"}' }) }); enableSupervisor("approve advice source"); }],
    ];
    try {
      for (const [label, configure] of adviceVariants) {
        configure();
        const marker = path.join(fixture, `advice-${label}.marker`);
        adviceMarkers.push(marker);
        adviceLlm.queue(
          assistant("", [toolCall(`advice-${label}`, "subagent", JSON.stringify({ value: label }))]),
          assistant(`${label} advice did not grant execution`)
        );
        const events = await collect(adviceAgent, `${label} Supervisor advice variant`);
        adviceOutcomes.push(events.some((event) => event.type === "tool_result" && /拒绝|CAPABILITY/.test(event.content)));
      }
      assertSec01Probe("SEC01-A20", "filesystem-state", await Promise.all(adviceMarkers.map(exists)), [false, false, false, false]);
      assertSec01Probe("SEC01-A20", "executor-call-count", adviceExecutorCalls, 0);
      assertSec01Probe("SEC01-A20", "approval-result-state", adviceOutcomes, [true, true, true, true]);
    } finally {
      initSupervisor(llm);
      disableSupervisor();
      capabilityBroker.revokeAuthority(adviceAuthority);
    }

    nativeProcessDecision = "approve";
    setAskUserSseCallback((event) => {
      if (event && typeof event === "object" && "questionId" in event) {
        setTimeout(() => submitAnswer(event.questionId, "确认执行"), 0);
      }
    });
    llm.queue(
      assistant("", [toolCall("approved", "subagent", JSON.stringify({ value: "approved" }))]),
      assistant("user approved")
    );
    await collect(agent, "approve exact tool call");
    assert.equal(calls.count, 1, "exact one-use grant must invoke executor once");

    llm.queue(
      assistant("", [
        toolCall("batch-approved", "subagent", JSON.stringify({ value: "batch" })),
        toolCall("batch-denied", "script", "{}"),
      ]),
      assistant("mixed batch complete")
    );
    const mixed = await collect(agent, "mixed authorized and unauthorized batch");
    assert.equal(calls.count, 2, "authorized batch member must run exactly once");
    assert(mixed.some((event) => event.type === "tool_result" && event.toolName === "script" && event.content.includes("CAPABILITY_TOOL_DENIED")));
    assertSec01Probe("SEC01-A26", "per-tool-executor-call-count", [calls.count, mixed.filter((event) => event.type === "tool_result" && event.toolName === "script").length], [2, 1]);

    let release;
    llm.blocker = new Promise((resolve) => { release = resolve; });
    llm.queue(assistant("first run done"), assistant("unexpected second run"));
    const firstIterator = agent.run("hold first run");
    const firstNext = firstIterator.next();
    await new Promise((resolve) => setTimeout(resolve, 10));
    const messagesBeforeRejectedRun = memory.getMessageCount();
    const secondEvents = await collect(agent, "parallel second run");
    assert(secondEvents.some((event) => event.type === "error" && event.content.includes("CAPABILITY_RUN_BUSY")));
    assertSec01Probe("SEC01-A09", "memory-message-count", { before: messagesBeforeRejectedRun, after: memory.getMessageCount() }, { before: messagesBeforeRejectedRun, after: messagesBeforeRejectedRun });
    assertSec01Probe("SEC01-A09", "executor-call-count", calls.count, 2);
    assert.throws(() => agent.setSession(session.id), /正在运行/);
    release();
    await firstNext;
    await firstIterator.return();
    assert.equal(calls.count, 2, "parallel denial must add no executor calls");
  } finally {
    setAskUserSseCallback(() => undefined);
    unregisterNativeProcessConsent();
    capabilityBroker.revokeAuthority(authority);
    closeDb();
    await removeFixture(fixture);
  }
});
