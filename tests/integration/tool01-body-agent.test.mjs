import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeTempDir, projectRoot, removeFixture } from "../helpers.mjs";

class FakeLlm {
  responses = [];
  seenMessages = [];
  seenTools = [];
  queue(...responses) { this.responses.push(...responses); }
  async chat() { return { role: "assistant", content: "fixture title" }; }
  async *chatStream(messages, tools) {
    this.seenMessages.push(messages.map(message => structuredClone(message)));
    this.seenTools.push(tools);
    const message = this.responses.shift();
    assert(message, "fake LLM response queue is empty");
    yield { type: "result", message };
  }
}

function assistant(content, toolCalls) {
  return { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
}

function toolCall(id, name, args) {
  return { id, type: "function", function: { name, arguments: args } };
}

async function collect(agent, input) {
  const events = [];
  for await (const event of agent.run(input)) events.push(event);
  return events;
}

test("TOOL-01 Agent executes body and JSON invocations through one fail-closed pipeline", { timeout: 90_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-tool01-agent-");
  const dataDir = path.join(fixture, "data");
  const workspace = path.join(fixture, "workspace");
  await Promise.all([mkdir(dataDir, { recursive: true }), mkdir(workspace, { recursive: true })]);
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
    { Agent },
    { ConversationMemory },
    { createEffectivePersona },
    { createSession },
    { closeDb },
    { capabilityBroker, executeTool, getToolProtocolDescriptors, inspectToolCall },
    { pathPolicy },
    { registerNativeProcessConsentHandler },
    { disableSupervisor },
  ] = await Promise.all([
    import("../../dist/config.js"),
    import("../../dist/agent.js"),
    import("../../dist/memory.js"),
    import("../../dist/persona.js"),
    import("../../dist/session.js"),
    import("../../dist/db.js"),
    import("../../dist/tools/index.js"),
    import("../../dist/path-runtime.js"),
    import("../../dist/native-process-consent.js"),
    import("../../dist/supervisor.js"),
  ]);

  let authority;
  let unregisterConsent = () => undefined;
  try {
    await config.initializeConfig();
    const common = config.getConfigSnapshot().domains.common;
    await config.updateSettingsDomain("common", { ...common, orgMode: true });

    const persona = createEffectivePersona({
      name: "tool01-agent",
      displayName: "TOOL-01 Agent",
      description: "TOOL-01 body protocol fixture",
      tools: ["script"],
      env: { WORKSPACE_ROOT: workspace },
      allowedRoots: [workspace],
      networkPolicy: { mode: "unrestricted" },
      systemPrompt: "TOOL-01 fixture",
    });
    const pathAuthority = await pathPolicy.createAuthority([{
      rootId: "workspace",
      role: "workspace",
      configuredPath: workspace,
      permissions: ["read-file", "read-directory", "search-tree", "create-file", "replace-file", "create-directory", "initial-cwd"],
    }]);
    authority = capabilityBroker.createRuntimeAuthority({
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
    const session = createSession(persona, "TOOL-01 protocol");
    const protocolContext = capabilityBroker.beginAgentRun(authority, session.id, "tool01-descriptor-probe");
    const protocols = getToolProtocolDescriptors(protocolContext);
    assert.equal(protocols.length, 1);
    assert.deepEqual({
      name: protocols[0].name,
      invocation: protocols[0].invocation,
      sideEffects: protocols[0].sideEffects,
      hostBound: protocols[0].hostBound,
      concurrency: protocols[0].concurrency,
      timeoutMs: protocols[0].timeoutMs,
      approval: protocols[0].permissions.approval,
    }, {
      name: "script",
      invocation: { json: true, body: { kind: "raw", blockName: "SCRIPT", bodyParameter: "code", headers: [] } },
      sideEffects: ["filesystem", "network", "process", "control"],
      hostBound: true,
      concurrency: "serial",
      timeoutMs: 60_000,
      approval: "user",
    });
    assert.equal(protocols[0].schema.function.name, "script");
    assert.equal(protocols[0].schema.function.parameters.additionalProperties, false);

    const nestedCode = "console.log('nested body enabled')";
    const nestedBody = `#+BEGIN_SCRIPT\n${nestedCode}\n#+END_SCRIPT`;
    const nestedInspected = inspectToolCall(protocolContext, "script", { code: nestedCode });
    const nestedChallenge = capabilityBroker.createApprovalChallenge(protocolContext, nestedInspected);
    const nestedGrant = capabilityBroker.resolveApprovalChallenge({
      challengeId: nestedChallenge.challengeId,
      choice: "approve",
      sessionId: session.id,
      runId: protocolContext.runId,
      responsePrincipal: "local-user-api",
      responseChannel: "native-process",
    });
    assert(nestedGrant);
    await assert.rejects(
      () => executeTool(nestedGrant, "script", nestedBody, null, null, undefined, null, false),
      error => error?.code === "TOOL_ARGUMENTS_INVALID",
    );
    assert.match(await executeTool(nestedGrant, "script", nestedBody, null, null, undefined, null, true), /nested body enabled/u);
    capabilityBroker.finishContext(protocolContext);

    const memory = new ConversationMemory(80);
    const llm = new FakeLlm();
    const agent = new Agent(llm, memory, persona, authority, null);
    agent.setSession(session.id);
    disableSupervisor();
    unregisterConsent = registerNativeProcessConsentHandler(() => "approve");

    const rawCode = `console.log("body 'quoted' \\\\ path");`;
    llm.queue(
      assistant(`#+BEGIN_SCRIPT\n${rawCode}\n#+END_SCRIPT`),
      assistant("body complete"),
    );
    const bodyEvents = await collect(agent, "run body script");
    const bodyCall = bodyEvents.find(event => event.type === "tool_call");
    const bodyResult = bodyEvents.find(event => event.type === "tool_result");
    assert.equal(bodyCall?.toolName, "script");
    assert.deepEqual({ ...bodyCall?.toolArgs }, { code: rawCode });
    assert.equal(bodyResult?.toolStatus, "success", JSON.stringify(bodyResult));
    assert.match(bodyResult?.content || "", /body 'quoted' \\ path/u);
    assert.equal(bodyEvents.some(event => event.type === "answer_chunk" && event.content.includes("#+BEGIN_SCRIPT")), false);
    assert.match(llm.seenMessages[0][0].content, /## Org-mode Body Tools/u);
    assert.match(llm.seenMessages[0][0].content, /#\+BEGIN_SCRIPT/u);
    assert(llm.seenTools[0].every(tool => Object.keys(tool).sort().join(",") === "function,type"));
    const persistedBodyCall = memory.getAll().find(message => message.role === "assistant" && message.tool_calls?.some(call => call.function.name === "script"));
    assert(persistedBodyCall);
    assert.deepEqual(JSON.parse(persistedBodyCall.tool_calls[0].function.arguments), { code: rawCode });
    assert.equal(persistedBodyCall.tool_calls[0].function.arguments.includes("#+BEGIN_SCRIPT"), false);

    llm.queue(
      assistant("mixed preface\n#+BEGIN_SCRIPT\nconsole.log('body mixed')\n#+END_SCRIPT", [
        toolCall("tool01-json-mixed", "script", JSON.stringify({ code: "console.log('json mixed')" })),
      ]),
      assistant("mixed complete"),
    );
    const mixedEvents = await collect(agent, "run native JSON and Body together");
    assert.deepEqual(mixedEvents.filter(event => event.type === "tool_call").map(event => event.toolName), ["script", "script"]);
    const mixedResults = mixedEvents.filter(event => event.type === "tool_result");
    assert.equal(mixedResults.length, 2);
    assert(mixedResults.every(event => event.toolStatus === "success"), JSON.stringify(mixedResults));
    assert(mixedResults.some(event => /json mixed/u.test(event.content)));
    assert(mixedResults.some(event => /body mixed/u.test(event.content)));
    assert.equal(mixedEvents.some(event => event.type === "answer_chunk" && event.content.includes("#+BEGIN_SCRIPT")), false);
    assert(mixedEvents.some(event => event.type === "answer_chunk" && event.content === "mixed preface"));

    llm.queue(
      assistant("#+BEGIN_SCRIPT\nconsole.log('missing end')\nordinary answer remains visible"),
      assistant("body denial recovered"),
    );
    const malformedBody = await collect(agent, "reject malformed body");
    const bodyDenial = malformedBody.find(event => event.type === "tool_result");
    assert.equal(bodyDenial?.toolStatus, "denied");
    assert.equal(bodyDenial?.toolCode, "TOOL_ARGUMENTS_INVALID");
    assert.equal(bodyDenial?.toolStages?.[0]?.stage, "schema");
    assert.equal(bodyDenial?.toolStages?.[0]?.state, "denied");
    assert.equal(bodyDenial?.toolStages?.find(stage => stage.stage === "execute")?.state, "skipped");
    assert(malformedBody.some(event => event.type === "answer_chunk" && event.content.includes("ordinary answer remains visible")));

    llm.queue(
      assistant("", [toolCall("tool01-json-invalid", "script", "{bad-json")]),
      assistant("json denial recovered"),
    );
    const malformedJson = await collect(agent, "reject malformed json");
    const jsonDenial = malformedJson.find(event => event.type === "tool_result");
    assert.equal(jsonDenial?.toolStatus, "denied");
    assert.equal(jsonDenial?.toolCode, bodyDenial?.toolCode);
    assert.deepEqual(
      jsonDenial?.toolStages?.map(stage => [stage.stage, stage.state, stage.code]),
      bodyDenial?.toolStages?.map(stage => [stage.stage, stage.state, stage.code]),
    );

    await config.updateSettingsDomain("common", { ...common, orgMode: false });
    llm.queue(
      assistant("", [toolCall("tool01-body-disabled", "script", "#+BEGIN_SCRIPT\nconsole.log('must not run')\n#+END_SCRIPT")]),
      assistant("disabled body recovered"),
    );
    const disabledBody = await collect(agent, "reject body when org mode is disabled");
    const disabledDenial = disabledBody.find(event => event.type === "tool_result");
    assert.equal(disabledDenial?.toolStatus, "denied");
    assert.equal(disabledDenial?.toolCode, "TOOL_ARGUMENTS_INVALID");
    assert.equal(disabledBody.some(event => event.type === "tool_result" && /must not run/u.test(event.content)), false);
    assert.equal(llm.seenMessages.at(-2)[0].content.includes("## Org-mode Body Tools"), false);
  } finally {
    unregisterConsent();
    if (authority) await capabilityBroker.retireAuthority(authority).catch(() => undefined);
    closeDb();
    await removeFixture(fixture);
  }
});
