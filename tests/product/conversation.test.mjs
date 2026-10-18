import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixture = await mkdtemp(path.join(os.tmpdir(), "rainydays-product-"));
await mkdir(path.join(fixture, "data"));
await mkdir(path.join(fixture, "playbooks"));
Object.assign(process.env, {
  RAINYDAYS_APP_ROOT: projectRoot,
  RAINYDAYS_USER_DATA_DIR: fixture,
  RAINYDAYS_DATA_DIR: path.join(fixture, "data"),
  RAINYDAYS_PLAYBOOKS_DIR: path.join(fixture, "playbooks"),
  RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"),
  RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"),
});
const { ConversationMemory } = await import("../../src/memory.ts");
const { closeDb, insertSession } = await import("../../src/db.ts");
test.after(async () => {
  closeDb();
  assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
  assert(path.basename(fixture).startsWith("rainydays-product-"));
  await rm(fixture, { recursive: true, force: true });
});

const call = id => ({ id, type: "function", function: { name: "read", arguments: "{}" } });
test("完整资料进入上下文，恢复会话后仍保留单行和多行原文", async () => {
  const now = new Date().toISOString();
  insertSession({ id: "product-memory", persona_name: "product", title: "fixture", created_at: now, updated_at: now });
  const memory = new ConversationMemory();
  memory.setSessionId("product-memory");
  const payloads = [JSON.stringify({ rows: "正文".repeat(4000), conclusion: "最后一项不可丢" }), "前言\n" + "事实与依据\n".repeat(1000) + "结论"];
  const messages = [
    { role: "user", content: "请分析资料" },
    { role: "assistant", content: "", tool_calls: [call("a"), call("b")] },
    ...payloads.map((content, index) => ({ role: "tool", content, tool_call_id: index ? "b" : "a" })),
  ];
  memory.addMany(messages);
  assert.deepEqual(memory.getAll(), messages);
  assert.equal(await memory.compact({ chat: () => assert.fail("预算内不应摘要") }), false);
  const restored = new ConversationMemory();
  restored.loadFromDb("product-memory");
  assert.deepEqual(restored.getAll(), messages);
});

test("最近资料超预算时明确停止且不丢原文", async () => {
  const memory = new ConversationMemory();
  memory.addMany([{ role: "assistant", content: "", tool_calls: [call("large")] }, { role: "tool", tool_call_id: "large", content: "文".repeat(80000) }]);
  const before = memory.getAll();
  await assert.rejects(() => memory.compact({ chat: () => assert.fail("不能摘要当前工具结果") }), error => error.code === "CONTEXT_BUDGET_EXCEEDED");
  assert.deepEqual(memory.getAll(), before);
});

test("摘要边界保留整组工具结果，不遗漏第二个结果", async () => {
  const memory = new ConversationMemory();
  memory.addMany([
    { role: "user", content: "旧记录".repeat(25000) },
    { role: "assistant", content: "", tool_calls: [call("a"), call("b")] },
    { role: "tool", tool_call_id: "a", content: "结果甲" },
    { role: "tool", tool_call_id: "b", content: "结果乙" },
    ...Array.from({ length: 6 }, (_, i) => ({ role: "user", content: `后续 ${i}` })),
  ]);
  await memory.compact({ chat: async messages => {
    assert.match(messages[1].content, /结果甲/);
    assert.match(messages[1].content, /结果乙/);
    return { role: "assistant", content: "已记录甲乙" };
  } });
  assert(memory.hasSummary());
});

test("摘要后仍超预算时保留原上下文，不提交不合格摘要", async () => {
  const memory = new ConversationMemory();
  memory.addMany(Array.from({ length: 18 }, () => ({ role: "user", content: "x".repeat(5000) })));
  const before = memory.getAll();
  await assert.rejects(() => memory.compact({ chat: async () => ({ role: "assistant", content: "x".repeat(80000) }) }), error => error.code === "CONTEXT_BUDGET_EXCEEDED");
  assert.deepEqual(memory.getAll(), before);
});

test("Agent 断流后保存已显示文字和失败提示，重开会话可恢复", async () => {
  const [{ Agent }, { createEffectivePersona }, { createSession }, { capabilityBroker }, { pathPolicy }] = await Promise.all([
    import("../../src/agent.ts"), import("../../src/persona.ts"), import("../../src/session.ts"),
    import("../../src/tools/index.ts"), import("../../src/path-runtime.ts"),
  ]);
  const persona = createEffectivePersona({ name: "product-stream", displayName: "Product", description: "Fixture", tools: [], env: {}, allowedRoots: [fixture], networkPolicy: { mode: "unrestricted" }, systemPrompt: "Fixture" });
  const authority = capabilityBroker.createRuntimeAuthority({
    ...persona,
    rootEnv: {},
    pathAuthority: await pathPolicy.createAuthority([{ rootId: "workspace", role: "workspace", configuredPath: fixture, permissions: ["read-file"] }]),
  });
  const llm = {
    async chat() { return { role: "assistant", content: "Fixture title" }; },
    async *chatStream() {
      yield { type: "delta", content: "第一段正文\n" };
      yield { type: "delta", content: "第二段未完成" };
      throw new Error("provider stream interrupted");
    },
  };
  const memory = new ConversationMemory();
  const session = createSession(persona, "Fixture");
  const agent = new Agent(llm, memory, persona, authority);
  agent.setSession(session.id);
  const events = [];
  for await (const event of agent.run("请分析")) events.push(event);
  const partial = events.filter(event => event.type === "answer_chunk").map(event => event.content).join("");
  assert.equal(partial, "第一段正文\n第二段未完成");
  const error = events.find(event => event.type === "error");
  assert(error);
  const expected = `${partial}\n\n⚠️ ${error.content}`;
  assert.equal(memory.getAll().at(-1).content, expected);
  const restored = new ConversationMemory();
  restored.loadFromDb(session.id);
  assert.equal(restored.getAll().at(-1).content, expected);
  assert.equal(restored.getAll().at(-1).tool_calls, undefined);
});

test("D04 用户停止后保留已显示正文，重开对话可见未完成说明", async () => {
  const [{ Agent }, { createEffectivePersona }, { createSession }, { capabilityBroker }, { pathPolicy }, { cancellationError }] = await Promise.all([
    import("../../src/agent.ts"), import("../../src/persona.ts"), import("../../src/session.ts"),
    import("../../src/tools/index.ts"), import("../../src/path-runtime.ts"), import("../../src/run-cancellation.ts"),
  ]);
  const persona = createEffectivePersona({ name: "d04-cancel", displayName: "Fixture", description: "Fixture", tools: [], env: {}, allowedRoots: [fixture], networkPolicy: { mode: "deny" }, systemPrompt: "Fixture" });
  const authority = capabilityBroker.createRuntimeAuthority({ ...persona, rootEnv: {},
    pathAuthority: await pathPolicy.createAuthority([{ rootId: "workspace", role: "workspace", configuredPath: fixture, permissions: ["read-file"] }]) });
  const controller = new AbortController();
  const llm = { async chat() { return { role: "assistant", content: "Fixture" }; }, async *chatStream() {
    yield { type: "delta", content: "保留这段已生成内容" };
    throw cancellationError(controller.signal);
  } };
  try {
    const memory = new ConversationMemory();
    const session = createSession(persona, "Fixture");
    const agent = new Agent(llm, memory, persona, authority); agent.setSession(session.id);
    await assert.rejects(async () => {
      for await (const step of agent.run("生成报告", "d04-cancel-run", controller.signal)) {
        if (step.type === "answer_chunk") controller.abort(new Error("用户停止"));
      }
    }, error => error.code === "RUN_CANCELLED");
    const restored = new ConversationMemory(); restored.loadFromDb(session.id);
    assert.match(restored.getAll().at(-1).content, /保留这段已生成内容/);
    assert.match(restored.getAll().at(-1).content, /已取消|已停止/);
    assert.equal(restored.getAll().at(-1).tool_calls, undefined);
  } finally { await capabilityBroker.retireAuthority(authority); }
});

test("文档附件保留原文，模型获得索引，读取工具分段取回且拒绝跨会话", async () => {
  const store = await import("../../src/attachment-store.ts");
  const { projectMessagesForProvider } = await import("../../src/llm.ts");
  const { readExec } = await import("../../src/tools/filesystem-lux.ts");
  const { issueResourceOwner, retireResourceOwner } = await import("../../src/resource-owner.ts");
  const { createDocxExec, createXlsxExec } = await import("../../src/tools/writer.ts");
  const { parseFileBuffer } = await import("../../src/tools/parsers.ts");
  const sessionId = "product-documents";
  const now = new Date().toISOString();
  insertSession({ id: sessionId, persona_name: "product", title: "documents", created_at: now, updated_at: now });
  let docx;
  await createDocxExec({ path: "报告.docx", title: "季度报告", paragraphs: ["正文".repeat(12000), "结论：末尾事实必须读到。"] }, {}, {
    signal: new AbortController().signal,
    path: { rootIdForEnv: () => "output", reserveFile: async () => ({ commit: async bytes => { docx = bytes; } }) },
  });
  const pdf = await readFile(new URL("../fixtures/tool02-two-pages.pdf", import.meta.url));
  let xlsx;
  await createXlsxExec({ path: "数据.xlsx", sheets: [{ name: "销量", data: [["产品", "数量"], ["甲", 42]] }] }, {}, {
    signal: new AbortController().signal,
    path: { rootIdForEnv: () => "output", reserveFile: async () => ({ commit: async bytes => { xlsx = bytes; } }) },
  });
  const owner = issueResourceOwner({ authorityId: "fixture", authorityEpoch: 1, sessionId, principal: "agent", rootIds: [] });
  const invocation = { resourceOwner: owner, capabilityContext: { sessionId }, signal: new AbortController().signal };
  try {
    for (const [name, mime, bytes] of [
      ["报告.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docx],
      ["资料.pdf", "application/pdf", pdf],
      ["数据.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", xlsx],
    ]) {
      const draft = store.reserveAttachment(sessionId, { name, mime, size: bytes.length });
      const ready = store.completeAttachment(sessionId, draft.id, bytes);
      const memory = new ConversationMemory(); memory.setSessionId(sessionId);
      memory.add({ role: "user", content: "读完并引用依据", attachments: [ready] });
      const projected = projectMessagesForProvider(sessionId, memory.getAll(), store.readMessageAttachmentForSession);
      assert.match(JSON.stringify(projected), new RegExp(`attachment:${ready.id}`));
      assert(!JSON.stringify(projected).includes("PK\\u0003"));
      assert.deepEqual(store.readMessageAttachmentForSession(sessionId, ready.id).bytes, bytes);
      const first = await readExec({ file_path: `attachment:${ready.id}`, limit: 4 }, {}, invocation);
      assert.match(first, new RegExp(name.replace(".", "\\.")));
      if (name.endsWith("docx")) {
        assert.match(first, /下一页 offset=/);
        let page = first;
        const allPages = [first];
        let pages = 0;
        while (/下一页 offset=(\d+)/u.test(page)) {
          assert(++pages < 50);
          page = await readExec({ file_path: `attachment:${ready.id}`, offset: Number(/下一页 offset=(\d+)/u.exec(page)[1]), limit: 4 }, {}, invocation);
          allPages.push(page);
        }
        assert.match(allPages.join("\n"), /末尾事实必须读到/);
        assert.equal(allPages.join("\n").split("正文").length - 1, 12000);
      } else if (name.endsWith("pdf")) assert.match(first, /PDF Page 1/);
      else assert.match(first, /42/);
      await assert.rejects(() => readExec({ file_path: `attachment:${ready.id}` }, {}, { ...invocation, capabilityContext: { sessionId: "another-session" } }), /不存在|does not exist/);
      const restored = new ConversationMemory(); restored.loadFromDb(sessionId);
      assert.equal(restored.getAll().at(-1).attachments[0].sha256, ready.sha256);
    }
    let revision;
    await createDocxExec({ path: "报告-修订.docx", title: "季度报告修订版", paragraphs: ["根据原报告末尾事实修订。", "来源：报告.docx，提取文本末段。"] }, {}, {
      signal: invocation.signal,
      path: { rootIdForEnv: () => "output", reserveFile: async () => ({ commit: async bytes => { revision = bytes; } }) },
    });
    const revised = await parseFileBuffer("报告-修订.docx", revision);
    assert.equal(revised.success, true);
    assert.match(revised.text, /季度报告修订版/);
    assert.match(revised.text, /来源：报告.docx/);
  } finally { await retireResourceOwner(owner); }
});

test("长 Unicode 单行可完整翻页且输入损坏会明确报错", async () => {
  const { documentTextPage } = await import("../../src/attachment-reader.ts");
  const { parseFileBuffer } = await import("../../src/tools/parsers.ts");
  const text = "🙂".repeat(6501);
  const first = documentTextPage(text);
  const next = Number(/下一页 offset=(\d+)/u.exec(first)[1]);
  const second = documentTextPage(text, next);
  assert.equal((first + second).split("🙂").length - 1, 6501);
  assert.match(second, /已到末尾/);
  assert.equal((await parseFileBuffer("bad.docx", Buffer.from("PK\x03\x04broken"))).success, false);
  const original = await readFile(new URL("../fixtures/tool02-two-pages.pdf", import.meta.url));
  const scanned = Buffer.from(original.toString("latin1").replace(/\/Contents \d+ 0 R/gu, value => " ".repeat(value.length)), "latin1");
  const parsed = await parseFileBuffer("scan.pdf", scanned);
  assert.equal(parsed.success, false);
  assert.match(parsed.error, /未提取到文字/);
});

test("Agent 通过真实工具调度读取文档附件并获得可引用内容", async () => {
  const [{ Agent }, { createEffectivePersona }, { createSession }, { capabilityBroker }, { pathPolicy }, store] = await Promise.all([
    import("../../src/agent.ts"), import("../../src/persona.ts"), import("../../src/session.ts"),
    import("../../src/tools/index.ts"), import("../../src/path-runtime.ts"), import("../../src/attachment-store.ts"),
  ]);
  const persona = createEffectivePersona({ name: "document-reader", displayName: "Documents", description: "Fixture", tools: ["read"], env: {}, allowedRoots: [fixture], networkPolicy: { mode: "unrestricted" }, systemPrompt: "Read and cite documents" });
  const authority = capabilityBroker.createRuntimeAuthority({ ...persona, rootEnv: {}, pathAuthority: await pathPolicy.createAuthority([{ rootId: "workspace", role: "workspace", configuredPath: fixture, permissions: ["read-file"] }]) });
  const session = createSession(persona, "Documents");
  const bytes = await readFile(new URL("../fixtures/tool02-two-pages.pdf", import.meta.url));
  const draft = store.reserveAttachment(session.id, { name: "资料.pdf", mime: "application/pdf", size: bytes.length });
  const attachment = store.completeAttachment(session.id, draft.id, bytes);
  let iteration = 0;
  const llm = {
    async chat() { return { role: "assistant", content: "资料阅读" }; },
    async *chatStream(messages) {
      if (iteration++ === 0) yield { type: "result", message: { role: "assistant", content: "", tool_calls: [{ id: "read-document", type: "function", function: { name: "read", arguments: JSON.stringify({ file_path: `attachment:${attachment.id}` }) } }] } };
      else {
        const result = messages.find(message => message.tool_call_id === "read-document");
        assert.match(result.content, /FIRST_PAGE/);
        assert.match(result.content, /来源: 资料.pdf/);
        yield { type: "result", message: { role: "assistant", content: "已读取 FIRST_PAGE（资料.pdf，第 1 页）。" } };
      }
    },
  };
  const memory = new ConversationMemory(); const agent = new Agent(llm, memory, persona, authority); agent.setSession(session.id);
  const events = [];
  for await (const event of agent.run("读附件并注明出处", undefined, undefined, [attachment])) events.push(event);
  assert(events.some(event => event.type === "tool_result" && event.toolStatus === "success"));
  assert(events.some(event => event.type === "answer_done" && event.content.includes("FIRST_PAGE")));
});

test("一次任务批准连续新建，覆盖仍确认，下一次发送重新授权", async () => {
  const [{ Agent }, { createEffectivePersona }, { createSession }, { capabilityBroker }, { pathPolicy }, interaction] = await Promise.all([
    import("../../src/agent.ts"), import("../../src/persona.ts"), import("../../src/session.ts"),
    import("../../src/tools/index.ts"), import("../../src/path-runtime.ts"), import("../../src/tools/ask-user-tool.ts"),
  ]);
  const output = path.join(fixture, "outputs"); await mkdir(output);
  const persona = createEffectivePersona({ name: "product-outputs", displayName: "Product", description: "Fixture", permissionLevel: "coding", tools: ["create_docx", "create_xlsx"], env: { OUTPUT_DIR: output }, allowedRoots: [output], networkPolicy: { mode: "deny" }, systemPrompt: "Fixture" });
  const authority = capabilityBroker.createRuntimeAuthority({ ...persona, rootEnv: { OUTPUT_DIR: "output" }, pathAuthority: await pathPolicy.createAuthority([{ rootId: "output", role: "output", configuredPath: output, permissions: ["create-file", "replace-file"] }]) });
  const session = createSession(persona, "Output task");
  let calls = [
    ["create_docx", { path: "报告.docx", title: "报告", paragraphs: ["第一版"] }],
    ["create_xlsx", { path: "数据.xlsx", sheets: [{ name: "数据", data: [["数量"], [42]] }] }],
    ["create_docx", { path: "报告.docx", paragraphs: ["不应覆盖"] }],
  ];
  let counter = 0;
  const llm = {
    async chat() { return { role: "assistant", content: "Output task" }; },
    async *chatStream() {
      const next = calls.shift();
      yield { type: "result", message: next ? { role: "assistant", content: "", tool_calls: [{ id: `output-${++counter}`, type: "function", function: { name: next[0], arguments: JSON.stringify(next[1]) } }] } : { role: "assistant", content: "完成" } };
    },
  };
  const memory = new ConversationMemory(); const agent = new Agent(llm, memory, persona, authority); agent.setSession(session.id);
  const questions = [];
  const run = async (runId, decide) => interaction.runWithInteractionChannel({ sessionId: session.id, runId }, { emit(event) {
    if (event.type !== "ask_user") return;
    questions.push(event);
    assert.equal(interaction.submitAnswer("wrong-session", runId, event.questionId, "本次任务允许新建文档"), false);
    assert(interaction.submitAnswer(session.id, runId, event.questionId, decide(event)));
  } }, async () => {
    const events = []; for await (const event of agent.run("产出文档", runId)) events.push(event); return events;
  });
  const events = await run("outputs-first", event => event.options.includes("本次任务允许新建文档") ? "本次任务允许新建文档" : "拒绝执行");
  assert.equal(questions.length, 2, "新建两个文件仅一次确认，覆盖另一次");
  assert.match(questions[0].question, /outputs/);
  assert.deepEqual(events.filter(event => event.type === "tool_result").map(event => event.toolStatus), ["success", "success", "denied"]);
  const { parseFileBuffer } = await import("../../src/tools/parsers.ts");
  assert.match((await parseFileBuffer("报告.docx", await readFile(path.join(output, "报告.docx")))).text, /第一版/);
  calls = [["create_docx", { path: "修改版.docx", paragraphs: ["第二版"] }]];
  await run("outputs-second", () => "仅这一次");
  assert.equal(questions.length, 3);
  assert.match((await parseFileBuffer("修改版.docx", await readFile(path.join(output, "修改版.docx")))).text, /第二版/);
  const { collectDocumentOutputs } = await import("../../src/document-outputs.ts");
  const { loadSessionMessages } = await import("../../src/session.ts");
  const outputs = collectDocumentOutputs(loadSessionMessages(session.id));
  assert.deepEqual(outputs.map(item => item.name), ["修改版.docx", "数据.xlsx", "报告.docx"]);
  assert(outputs.every(item => path.isAbsolute(item.path)));
  assert.equal(collectDocumentOutputs([{ role: "assistant", content: JSON.stringify(outputs) }]).length, 0);
  const forged = [{ role: "assistant", content: "", tool_calls: [{ id: "fake", function: { name: "read" } }] }, { role: "tool", tool_call_id: "fake", content: JSON.stringify({ status: "success", content: JSON.stringify({ type: "document_output", format: "docx", path: path.join(output, "fake.docx") }) }) }];
  assert.equal(collectDocumentOutputs(forged).length, 0);
});
