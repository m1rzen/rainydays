import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeTempDir, projectRoot, removeFixture } from "../helpers.mjs";
import {
  appendSecurityAuditEvent,
  createSecurityAuditCommitment,
  verifySecurityAuditChain,
} from "../../dist/security-audit.js";

function assistant(content, toolCalls) {
  return { role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) };
}

function toolCall(id, name, args) {
  return { id, type: "function", function: { name, arguments: args } };
}

class FakeLlm {
  responses = [];
  seenTools = [];
  seenMessages = [];
  queue(...responses) { this.responses.push(...responses); }
  async chat() { throw new Error("unexpected non-streaming LLM call"); }
  async *chatStream(messages, tools) {
    this.seenMessages.push(messages.map(message => ({ ...message })));
    this.seenTools.push(tools);
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

function createMemoryAuditJournal() {
  const key = Buffer.alloc(32, 0x55);
  const events = [];
  return {
    events,
    journal: Object.freeze({
      append: async input => {
        const event = appendSecurityAuditEvent(events, input, key);
        events.push(event);
        return event;
      },
      commit: value => createSecurityAuditCommitment(key, value),
      verify: async () => ({ schemaVersion: 1, integrity: "verified", ...verifySecurityAuditChain(events, key) }),
      close: () => key.fill(0),
    }),
  };
}

test("RT-05 production Agent enforces the eight-stage tool pipeline", async () => {
  const fixture = await makeTempDir("mini-lux-rt05-pipeline-");
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
    { capabilityBroker, MAX_TOOL_OUTPUT_BYTES, registerDynamicTool },
    { pathPolicy },
    { registerNativeProcessConsentHandler },
    { RunCancellationError },
    { disableSupervisor },
    { setAskUserSseCallback, submitAnswer },
    { cronScheduleDef },
  ] = await Promise.all([
    import("../../dist/agent.js"),
    import("../../dist/memory.js"),
    import("../../dist/persona.js"),
    import("../../dist/session.js"),
    import("../../dist/db.js"),
    import("../../dist/tools/index.js"),
    import("../../dist/path-runtime.js"),
    import("../../dist/native-process-consent.js"),
    import("../../dist/run-cancellation.js"),
    import("../../dist/supervisor.js"),
    import("../../dist/tools/ask-user-tool.js"),
    import("../../dist/tools/cron-tools.js"),
  ]);

  const persona = createEffectivePersona({
    name: "rt05-pipeline",
    displayName: "RT-05 Pipeline",
    description: "RT-05 production pipeline fixture",
    tools: ["cron_schedule", "subagent", "supervise"],
    env: { WORKSPACE_ROOT: fixture },
    allowedRoots: [fixture],
    networkPolicy: { mode: "unrestricted" },
    systemPrompt: "RT-05 production pipeline fixture",
  });
  const pathAuthority = await pathPolicy.createAuthority([{
    rootId: "workspace",
    role: "workspace",
    configuredPath: fixture,
    permissions: [
      "read-file", "read-directory", "search-tree", "create-file", "replace-file",
      "create-directory", "watch-directory", "initial-cwd", "reveal",
    ],
  }]);
  const authority = capabilityBroker.createRuntimeAuthority({
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

  let executorCalls = 0;
  registerDynamicTool(authority, {
    name: "subagent",
    definition: {
      type: "function",
      function: {
        name: "subagent",
        description: "RT-05 dynamic adapter fixture",
        parameters: {
          type: "object",
          properties: {
            value: { type: "string" },
            options: { type: "object", properties: { mode: { type: "string", enum: ["safe"] } } },
          },
          required: ["value"],
        },
      },
    },
    executor: async (args, _env, invocation) => {
      executorCalls += 1;
      assert(invocation, "RT-05 invocation services are missing");
      if (args.value === "nested-loop" || args.value === "nested-schema") {
        const child = invocation.deriveChild({ principal: "subagent", tools: ["supervise"] });
        try {
          if (args.value === "nested-schema") {
            await invocation.executeTool(child, "supervise", "{bad-json", "rt05-nested-schema-inner");
          } else {
            for (let index = 0; index < 4; index += 1) {
              await invocation.executeTool(child, "supervise", "{}", `rt05-nested-${index}`);
            }
          }
        } finally {
          invocation.finishChild(child);
        }
      }
      if (args.value === "error") throw new Error("synthetic RT-05 executor failure");
      if (args.value === "non-string") return { invalid: true };
      if (args.value === "timeout") throw new RunCancellationError("RUN_TIMEOUT", "synthetic RT-05 timeout");
      if (args.value === "large") return "界".repeat(50_000);
      if (args.value === "escaped") return `"\0`.repeat(100_000);
      return "dynamic adapter succeeded";
    },
  });
  registerDynamicTool(authority, {
    name: "cron_schedule",
    definition: cronScheduleDef,
    executor: async () => assert.fail("denied cron schedule reached executor"),
  });

  const llm = new FakeLlm();
  const audit = createMemoryAuditJournal();
  const memory = new ConversationMemory(120);
  const committedToolMessages = [];
  const addMany = memory.addMany.bind(memory);
  memory.addMany = messages => {
    committedToolMessages.push(...messages.filter(message => message.role === "tool").map(message => ({ ...message })));
    return addMany(messages);
  };
  const agent = new Agent(llm, memory, persona, authority, audit.journal);
  const session = createSession(persona, "RT-05 pipeline");
  agent.setSession(session.id);
  disableSupervisor();
  const unregisterConsent = registerNativeProcessConsentHandler(() => "approve");

  try {
    const committedBeforeInvalidIds = committedToolMessages.length;
    llm.queue(assistant("", [
      toolCall("x".repeat(257), "subagent", JSON.stringify({ value: "must-not-run-long-id" })),
      toolCall('"\\'.repeat(100), "subagent", JSON.stringify({ value: "must-not-run-escaped-id" })),
    ]));
    const invalidIdEvents = await collect(agent, "reject invalid tool call identities");
    assert(invalidIdEvents.some(event => event.type === "error" && /tool_call_id/u.test(event.content)));
    assert.equal(invalidIdEvents.some(event => event.type === "tool_call" || event.type === "tool_result"), false);
    assert.equal(executorCalls, 0);
    assert.equal(committedToolMessages.length, committedBeforeInvalidIds);
    const invalidIdAudits = audit.events.filter(event => event.code === "SEC06_TOOL_CALL_ID_INVALID");
    assert.equal(invalidIdAudits.length, 4);
    assert(invalidIdAudits.every(event => event.correlation.toolCallId === null));
    assert.deepEqual(invalidIdAudits.filter(event => event.phase === "result").map(event => event.outcome), ["denied", "denied"]);

    llm.queue(
      assistant("", [toolCall("rt05-schema", "subagent", JSON.stringify({
        value: "schema",
        options: { mode: "safe", unexpected: true },
      }))]),
      assistant("schema denial observed"),
    );
    const schemaEvents = await collect(agent, "reject nested unknown schema key");
    const schemaResult = schemaEvents.find(event => event.type === "tool_result");
    assert.equal(schemaResult?.toolStatus, "denied");
    assert.equal(schemaResult?.toolCode, "TOOL_ARGUMENTS_INVALID");
    assert.equal(schemaResult?.toolStages[0].stage, "schema");
    assert.equal(schemaResult?.toolStages[0].state, "denied");
    assert.equal(schemaResult?.toolStages.find(stage => stage.stage === "execute")?.state, "skipped");
    assert.equal(executorCalls, 0);
    const publishedSubagent = llm.seenTools[0].find(tool => tool.function.name === "subagent");
    assert.equal(publishedSubagent.function.parameters.additionalProperties, false);
    assert.equal(publishedSubagent.function.parameters.properties.options.additionalProperties, false);
    assert(Object.isFrozen(publishedSubagent));
    assert(Object.isFrozen(publishedSubagent.function.parameters.properties.options));

    llm.queue(
      assistant("", [toolCall("rt05-loop-1", "supervise", "{}")]),
      assistant("", [toolCall("rt05-loop-2", "supervise", "{}")]),
      assistant("", [toolCall("rt05-loop-3", "supervise", "{}")]),
      assistant("", [toolCall("rt05-loop-4", "supervise", "{}")]),
      assistant("loop denial observed"),
    );
    const loopEvents = await collect(agent, "repeat an identical tool call");
    const loopResults = loopEvents.filter(event => event.type === "tool_result" && event.toolName === "supervise");
    assert.deepEqual(loopResults.map(event => event.toolStatus), ["success", "success", "success", "denied"]);
    assert.equal(loopResults.at(-1)?.toolCode, "TOOL_LOOP_DETECTED");
    assert.equal(loopResults.at(-1)?.toolStages.find(stage => stage.stage === "approval")?.state, "skipped");

    llm.queue(
      assistant("", [toolCall("rt05-nested-loop", "subagent", JSON.stringify({ value: "nested-loop" }))]),
      assistant("nested loop denial observed"),
    );
    const nestedEvents = await collect(agent, "repeat an identical nested tool call");
    const nestedResult = nestedEvents.find(event => event.type === "tool_result");
    assert.equal(nestedResult?.toolStatus, "denied");
    assert.equal(nestedResult?.toolCode, "TOOL_LOOP_DETECTED");
    assert.equal(executorCalls, 1);

    llm.queue(
      assistant("", [toolCall("rt05-nested-schema", "subagent", JSON.stringify({ value: "nested-schema" }))]),
      assistant("nested schema denial observed"),
    );
    const nestedSchemaEvents = await collect(agent, "reject malformed nested adapter arguments");
    const nestedSchemaResult = nestedSchemaEvents.find(event => event.type === "tool_result");
    assert.equal(nestedSchemaResult?.toolStatus, "denied");
    assert.equal(nestedSchemaResult?.toolCode, "TOOL_ARGUMENTS_INVALID");
    const nestedSchemaAudit = audit.events.filter(event => event.correlation.toolCallId === "rt05-nested-schema-inner");
    assert.deepEqual(nestedSchemaAudit.map(event => event.outcome), ["received", "denied", "not_started", "denied"]);
    assert.equal(executorCalls, 2);

    llm.queue(
      assistant("", [toolCall("rt05-error", "subagent", JSON.stringify({ value: "error" }))]),
      assistant("typed error observed"),
    );
    const errorEvents = await collect(agent, "preserve executor failure type");
    const errorResult = errorEvents.find(event => event.type === "tool_result");
    assert.equal(errorResult?.toolStatus, "error");
    assert.equal(errorResult?.toolCode, "TOOL_EXECUTION_FAILED");
    assert.equal(errorResult?.toolStages.find(stage => stage.stage === "execute")?.state, "error");
    const persistedError = JSON.parse(memory.getAll().find(message => message.role === "tool" && message.tool_call_id === "rt05-error")?.content ?? "null");
    assert.equal(persistedError.status, "error");
    assert.equal(persistedError.code, "TOOL_EXECUTION_FAILED");

    llm.queue(
      assistant("", [toolCall("rt05-non-string", "subagent", JSON.stringify({ value: "non-string" }))]),
      assistant("non-string error observed"),
    );
    const nonStringEvents = await collect(agent, "reject non-string executor result");
    const nonStringResult = nonStringEvents.find(event => event.type === "tool_result");
    assert.equal(nonStringResult?.toolStatus, "error");
    assert.equal(nonStringResult?.toolCode, "TOOL_EXECUTION_FAILED");
    assert.match(nonStringResult?.content ?? "", /non-string result/u);

    llm.queue(
      assistant("", [toolCall("rt05-timeout", "subagent", JSON.stringify({ value: "timeout" }))]),
    );
    const timeoutEvents = await collect(agent, "preserve timeout outcome type").catch(error => {
      assert.equal(error?.code, "RUN_TIMEOUT");
      return [];
    });
    const timeoutAudit = audit.events.find(event => event.phase === "result" && event.correlation.toolCallId === "rt05-timeout");
    assert.equal(timeoutAudit?.outcome, "timeout");
    assert.equal(timeoutAudit?.code, "RUN_TIMEOUT");
    assert.deepEqual(timeoutEvents, []);
    const persistedTimeout = JSON.parse(memory.getAll().find(message => message.role === "tool" && message.tool_call_id === "rt05-timeout")?.content ?? "null");
    assert.equal(persistedTimeout.status, "timeout");
    assert.equal(persistedTimeout.code, "RUN_TIMEOUT");

    llm.queue(
      assistant("", [toolCall("rt05-large", "subagent", JSON.stringify({ value: "large" }))]),
      assistant("bounded output observed"),
    );
    const outputEvents = await collect(agent, "bound UTF-8 tool output");
    const outputResult = outputEvents.find(event => event.type === "tool_result");
    assert.equal(outputResult?.toolStatus, "success");
    assert.equal(outputResult?.toolOriginalOutputBytes, 150_000);
    assert.equal(outputResult?.toolOutputBytes, Buffer.byteLength(outputResult?.content ?? "", "utf8"));
    assert.equal(outputResult?.toolOutputTruncated, true);
    assert(Buffer.byteLength(outputResult?.content ?? "", "utf8") <= 128 * 1024);
    assert.match(outputResult?.content ?? "", /\[tool output truncated\]$/u);
    assert.equal(outputResult?.content.includes("�"), false);
    assert.deepEqual(outputResult?.toolStages.map(stage => stage.stage), [
      "schema", "capability", "loop", "approval", "policy", "execute", "output", "audit",
    ]);
    assert.equal(outputResult?.toolStages.find(stage => stage.stage === "output")?.state, "truncated");
    assert(outputResult?.toolStages.every(stage => stage.state !== "skipped"));
    const persistedLarge = committedToolMessages.find(message => message.tool_call_id === "rt05-large")?.content ?? "";
    assert(Buffer.byteLength(JSON.stringify({ role: "tool", content: persistedLarge, tool_call_id: "rt05-large" }), "utf8") <= MAX_TOOL_OUTPUT_BYTES);
    assert.equal(JSON.parse(persistedLarge).originalOutputBytes, 150_000);

    llm.queue(
      assistant("", [toolCall("rt05-escaped", "subagent", JSON.stringify({ value: "escaped" }))]),
      assistant("escaped output bounded"),
    );
    const escapedEvents = await collect(agent, "bound escaped tool output envelope");
    const escapedResult = escapedEvents.find(event => event.type === "tool_result");
    assert.equal(escapedResult?.toolOutputTruncated, true);
    const persistedEscaped = committedToolMessages.find(message => message.tool_call_id === "rt05-escaped")?.content ?? "";
    assert(Buffer.byteLength(JSON.stringify({ role: "tool", content: persistedEscaped, tool_call_id: "rt05-escaped" }), "utf8") <= MAX_TOOL_OUTPUT_BYTES);
    const parsedEscaped = JSON.parse(persistedEscaped);
    assert.equal(parsedEscaped.originalOutputBytes, 200_000);
    assert.equal(parsedEscaped.outputBytes, Buffer.byteLength(parsedEscaped.content, "utf8"));
    assert.equal(parsedEscaped.truncated, true);
    const llmFacingToolMessages = llm.seenMessages.flat().filter(message => message.role === "tool");
    assert(llmFacingToolMessages.every(message => Buffer.byteLength(JSON.stringify(message), "utf8") <= MAX_TOOL_OUTPUT_BYTES));
    const llmFacingEscaped = llmFacingToolMessages.find(message => message.tool_call_id === "rt05-escaped");
    if (llmFacingEscaped) assert(Buffer.byteLength(JSON.stringify(llmFacingEscaped), "utf8") <= MAX_TOOL_OUTPUT_BYTES);

    const deniedAnswer = `not-approved-${"x".repeat(150_000)}`;
    setAskUserSseCallback(event => {
      if (event?.type === "ask_user") assert.equal(submitAnswer(event.questionId, deniedAnswer), true);
    });
    llm.queue(
      assistant("", [toolCall("rt05-large-denial", "cron_schedule", JSON.stringify({ message: "never", delay: "1h" }))]),
      assistant("large denial bounded"),
    );
    const denialEvents = await collect(agent, "audit a bounded user denial");
    const denialResult = denialEvents.find(event => event.type === "tool_result");
    assert.equal(denialResult?.toolStatus, "denied");
    assert.equal(denialResult?.toolOriginalOutputBytes, Buffer.byteLength(`⛔ 用户拒绝执行（${deniedAnswer}）`, "utf8"));
    assert.equal(denialResult?.toolOutputBytes, Buffer.byteLength(denialResult?.content ?? "", "utf8"));
    assert.equal(denialResult?.toolOutputTruncated, true);
    const denialAudit = audit.events.find(event => event.phase === "result" && event.correlation.toolCallId === "rt05-large-denial");
    assert.equal(denialAudit?.outcome, "denied");
    assert.equal(denialAudit?.safePayload.outputBytes, denialResult?.toolOutputBytes);
    assert.equal(denialAudit?.safePayload.truncated, true);
    assert.equal(denialAudit?.safePayload.resultCommitment, audit.journal.commit(denialResult?.content));

    const errorAudit = audit.events.find(event => event.phase === "result" && event.correlation.toolCallId === "rt05-error");
    assert.equal(errorAudit?.outcome, "error");
    assert.equal(errorAudit?.code, "TOOL_EXECUTION_FAILED");
    const outputAudit = audit.events.find(event => event.phase === "result" && event.correlation.toolCallId === "rt05-large");
    assert.equal(outputAudit?.outcome, "success");
    assert.equal(outputAudit?.safePayload.outputBytes, outputResult?.toolOutputBytes);
    assert.equal(outputAudit?.safePayload.truncated, true);
    assert.equal(outputAudit?.safePayload.resultCommitment, audit.journal.commit(outputResult?.content));
    assert.equal((await audit.journal.verify()).integrity, "verified");
  } finally {
    setAskUserSseCallback(() => undefined);
    unregisterConsent();
    audit.journal.close();
    capabilityBroker.revokeAuthority(authority);
    closeDb();
    await removeFixture(fixture);
  }
});
