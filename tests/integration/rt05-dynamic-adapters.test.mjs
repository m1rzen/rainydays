import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeTempDir, projectRoot, removeFixture } from "../helpers.mjs";

test("RT-05 production runtime wires every dynamic adapter through the unified registrar", async () => {
  const expected = [
    "consolidate", "cron_cancel", "cron_schedule", "curate", "muse", "oracle_query",
    "playbook_abort", "playbook_execute", "save_persona", "subagent", "subagent_list",
    "subagent_output", "subagent_peek", "subagent_post", "subagent_stop", "subagent_wait",
  ];
  for (const exactCasePath of ["src/index.ts", "dist/index.js"]) {
    const source = await readFile(path.join(projectRoot, exactCasePath), "utf8");
    const names = [...source.matchAll(/registerDynamicTool\(authority,\s*\{\s*name:\s*"([a-z_]+)"/gu)]
      .map(match => match[1])
      .sort();
    assert.deepEqual(names, expected, `${exactCasePath} dynamic registrations differ`);
    assert.equal((source.match(/registerDynamicTools\(authority, persona, memory, runtimeLlm, subagents, settings\);/gu) ?? []).length, 1);
    assert.equal(source.includes("capabilityBroker.registerRuntimeTool("), false);
  }
});

test("RT-05 LLM-backed dynamic adapters use the run-scoped network transport", async () => {
  const { LLMClient } = await import("../../dist/llm.js");
  const originalFetch = globalThis.fetch;
  let ambientFetches = 0;
  let scopedFetches = 0;
  let scopedUrl = "";
  const scopedFetch = async (url, init) => {
    scopedFetches += 1;
    scopedUrl = url;
    assert.equal(init?.method, "POST");
    return new Response(JSON.stringify({
      id: "chatcmpl-rt05",
      object: "chat.completion",
      created: 1,
      model: "rt05-model",
      choices: [{ index: 0, message: { role: "assistant", content: "scoped" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  globalThis.fetch = async () => {
    ambientFetches += 1;
    throw new Error("ambient fetch must not be used");
  };
  try {
    const client = new LLMClient({ apiKey: "rt05-key", baseURL: "https://provider.example/v1", model: "rt05-model" });
    const response = await client.chat([{ role: "user", content: "probe" }], undefined, undefined, scopedFetch);
    assert.equal(response.content, "scoped");
    assert.equal(scopedFetches, 1);
    assert.equal(ambientFetches, 0);
    assert.equal(scopedUrl, "https://provider.example/v1/chat/completions");

    const transportBindings = [
      ["src/tools/phase1-tools.ts", /invocation\.signal, invocation\.network\.fetch/u],
      ["src/tools/knowledge-tools.ts", /invocation\.signal, invocation\.network\.fetch/u],
      ["src/tools/advanced-tools.ts", /invocation\.signal, invocation\.network\.fetch/u],
      ["src/tools/curate-tool.ts", /invocation\.signal, invocation\.network\.fetch/u],
      ["src/subagent.ts", /invocation\.signal, invocation\.network\.fetch/u],
      ["src/playbook.ts", /invocation\.signal, invocation\.network\.fetch/u],
      ["src/memory.ts", /undefined, signal, transport/u],
      ["src/oracle.ts", /undefined, signal, transport/u],
    ];
    for (const [exactCasePath, pattern] of transportBindings) {
      assert.match(await readFile(path.join(projectRoot, exactCasePath), "utf8"), pattern, exactCasePath);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("RT-05 dynamic adapters preserve strict schemas and typed failures", async () => {
  const fixture = await makeTempDir("mini-lux-rt05-adapters-");
  const dataDir = path.join(fixture, "data");
  await mkdir(dataDir, { recursive: true });
  Object.assign(process.env, {
    RAINYDAYS_APP_ROOT: projectRoot,
    RAINYDAYS_USER_DATA_DIR: fixture,
    RAINYDAYS_DATA_DIR: dataDir,
    RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"),
    RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"),
  });

  const [
    { createCronScheduleExec, cronCancelDef, cronScheduleDef },
    { createConsolidateExec },
    { createOracleQueryExec, pollSubscribeDef, pollUnsubscribeDef },
    { createMuseExec, mascotNotifyExec },
    { createSubagentExecutors, subagentDef },
    { createPlaybookExecuteExec },
    { savePersonaDef },
    { runWithInteractionChannel },
    { closeDb },
  ] = await Promise.all([
    import("../../dist/tools/cron-tools.js"),
    import("../../dist/tools/knowledge-tools.js"),
    import("../../dist/tools/advanced-tools.js"),
    import("../../dist/tools/phase1-tools.js"),
    import("../../dist/tools/subagent-tools.js"),
    import("../../dist/playbook.js"),
    import("../../dist/tools/save-persona.js"),
    import("../../dist/tools/ask-user-tool.js"),
    import("../../dist/db.js"),
  ]);

  try {
    assert.equal(cronScheduleDef.function.parameters.properties.delay.pattern, "^(?:\\d+d)?(?:\\d+h)?(?:\\d+m)?(?:\\d+s)?$");
    assert.deepEqual(cronCancelDef.function.parameters.anyOf, [{ required: ["id"] }, { required: ["tag"] }]);
    assert.equal(subagentDef.function.parameters.properties.prompt.minLength, 1);
    assert.equal(savePersonaDef.function.parameters.properties.name.pattern, "^[a-z0-9][a-z0-9-]{0,63}$");
    assert.deepEqual(pollSubscribeDef.function.parameters.required, ["source"]);
    assert.equal(pollSubscribeDef.function.parameters.properties.path, undefined);
    assert.deepEqual(pollSubscribeDef.function.parameters.properties.mode.enum, ["wake"]);
    assert.equal(pollSubscribeDef.function.parameters.properties.tagFilters.additionalProperties.type, "string");
    assert.deepEqual(pollUnsubscribeDef.function.parameters.required, undefined);

    const schedule = createCronScheduleExec(() => assert.fail("invalid schedule reached publication"));
    await assert.rejects(() => schedule({ message: "x", delay: "invalid" }, { _SESSION_ID: "rt05-schema" }), /无效的时间格式/u);

    let museTransport;
    const llm = { chat: async (...args) => {
      museTransport = args[3];
      return { role: "assistant", content: "complete" };
    } };
    const networkFetch = async () => new Response("unreachable");
    const invocation = { signal: new AbortController().signal, network: { fetch: networkFetch } };
    assert.match(await createMuseExec(llm)({ topic: "network" }, undefined, invocation), /complete/u);
    assert.equal(museTransport, networkFetch);

    await assert.rejects(
      () => runWithInteractionChannel(
        { sessionId: "rt05-notify", runId: "delivery-failure" },
        { emit: () => undefined, notify: () => { throw new Error("closed channel"); } },
        () => mascotNotifyExec({ title: "blocked", body: "not delivered" }),
      ),
      /通知通道不可用/u,
    );

    await assert.rejects(() => createConsolidateExec(llm)({}), /invocation services are required/iu);
    await assert.rejects(() => createOracleQueryExec(llm)({ question: "x" }), /invocation services are required/iu);
    await assert.rejects(() => createMuseExec(llm)({ topic: "x" }), /invocation services are required/iu);
    await assert.rejects(
      () => createSubagentExecutors({
        registry: {},
        llm,
        persona: { name: "fixture", systemPrompt: "fixture" },
        memory: {},
        resolvePersona: () => null,
      }).subagent({ description: "child", prompt: "work" }),
      /缺少受控工具调用服务/u,
    );
    await assert.rejects(
      () => createPlaybookExecuteExec(llm, { systemPrompt: "fixture" })({ name: "missing" }),
      /缺少受控工具调用服务/u,
    );
  } finally {
    closeDb();
    await removeFixture(fixture);
  }
});
