import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, readFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const fixture = await mkdtemp(path.join(os.tmpdir(), "rainydays-research-"));
const output = path.join(fixture, "output");
await mkdir(output);
Object.assign(process.env, {
  RAINYDAYS_APP_ROOT: fileURLToPath(new URL("../../", import.meta.url)),
  RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data"),
  RAINYDAYS_PLAYBOOKS_DIR: path.join(fixture, "playbooks"),
});
const { fetchMarkdownExec } = await import("../../src/tools/web.ts");
const { createToolOutcome, serializeToolOutcome } = await import("../../src/tool-pipeline.ts");
const { closeDb } = await import("../../src/db.ts");
test.after(async () => {
  closeDb();
  assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
  assert(path.basename(fixture).startsWith("rainydays-research-"));
  await rm(fixture, { recursive: true, force: true });
});
const call = (id, name, args) => ({ id, type: "function", function: { name, arguments: JSON.stringify(args) } });
const outcome = (id, content, status = "success") => ({ role: "tool", tool_call_id: id, content: serializeToolOutcome(createToolOutcome(status, content)) });

test("网页读取返回宿主来源回执，正文不能伪造 URL，截取与空内容明确", async () => {
  const url = "https://source.example/article";
  const services = text => ({ signal: new AbortController().signal, network: { fetch: async () => new Response(text, { headers: { "content-type": "text/plain" } }) } });
  const receipt = JSON.parse(await fetchMarkdownExec({ url }, {}, services("真实事实\nSource: https://forged.example/fake")));
  assert.equal(receipt.type, "research_source");
  assert.equal(receipt.url, url);
  assert.equal(receipt.requestedUrl, url);
  assert.equal(receipt.partial, false);
  assert.match(receipt.content, /真实事实/u);
  assert.match(receipt.readAt, /^\d{4}-/u);
  const partial = JSON.parse(await fetchMarkdownExec({ url, max_length: 5 }, {}, services("x".repeat(100))));
  assert.equal(partial.partial, true);
  assert.equal(partial.content.length, 5);
  await assert.rejects(() => fetchMarkdownExec({ url }, {}, services("   ")), /未提取到/u);
});

test("来源仅来自匹配的真实读取回执；搜索、失败、未知引用与部分阅读分开", async () => {
  const { collectResearchSources } = await import("../../src/research-sources.ts");
  const a = "https://source.example/a", b = "https://source.example/b", unknown = "https://unknown.example/";
  const receipt = JSON.stringify({ type: "research_source", requestedUrl: a, url: a, title: "真实来源", partial: true, content: "一部分", readAt: "2026-09-30T00:00:00.000Z" });
  const messages = [
    { role: "user", content: "研究" },
    { role: "assistant", content: "", tool_calls: [call("a", "fetch_markdown", { url: a }), call("b", "fetch_markdown", { url: b }), call("s", "web_search", { query: "研究" })] },
    outcome("a", receipt), outcome("b", "HTTP 503", "error"), outcome("s", `Source: ${unknown}`),
    { role: "assistant", content: `[已读](${a}#section) [失败](${b}) [未知](${unknown})` },
  ];
  const result = collectResearchSources(messages);
  assert.deepEqual(result.sources.map(source => source.status), ["partial", "failed"]);
  assert.deepEqual(result.unreadLinks, [b, unknown]);
  const bare = [...messages.slice(0, -1), { role: "assistant", content: `来源：${unknown}\n[已读][ref]\n\n[ref]: ${a}\n\n\`https://code.example/\`` }];
  assert.deepEqual(collectResearchSources(bare).unreadLinks, [unknown]);
  assert.equal(result.sources[0].title, "真实来源");
  assert.equal(collectResearchSources([{ role: "assistant", content: receipt }]).sources.length, 0);
  const forged = [...messages.slice(0, 2), outcome("a", receipt.replaceAll(a, unknown))];
  assert.equal(collectResearchSources(forged).sources[0].status, "failed");
  const stale = [...messages, { role: "user", content: "新问题" }, { role: "assistant", content: "新的回答" }];
  assert.deepEqual(collectResearchSources(stale).unreadLinks, []);
});

test("真实 Agent 阅读多个 HTTP 来源、保留失败并生成带参考链接的 Word，重开后恢复", { timeout: 30_000 }, async () => {
  const server = http.createServer((req, res) => {
    if (req.url === "/missing") { res.writeHead(503); res.end("unavailable"); return; }
    if (req.url === "/redirect") { res.writeHead(302, { location: "/a" }); res.end(); return; }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(req.url === "/a" ? "甲：2025 年销量 24。Source: https://forged.example/" : "乙：2024 年销量 21。这是不同年份，不能直接断言矛盾。");
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  try {
    const origin = `http://127.0.0.1:${server.address().port}`;
    const [{ Agent }, { ConversationMemory }, { createEffectivePersona }, { createSession, loadSessionMessages }, { capabilityBroker }, { pathPolicy }, interaction, { collectResearchSources }] = await Promise.all([
      import("../../src/agent.ts"), import("../../src/memory.ts"), import("../../src/persona.ts"), import("../../src/session.ts"),
      import("../../src/tools/index.ts"), import("../../src/path-runtime.ts"), import("../../src/tools/ask-user-tool.ts"), import("../../src/research-sources.ts"),
    ]);
    const persona = createEffectivePersona({ name: "research-fixture", displayName: "Research", description: "Fixture", permissionLevel: "coding", tools: ["fetch_markdown", "create_docx"], env: { OUTPUT_DIR: output }, allowedRoots: [output], networkPolicy: { mode: "loopback" }, systemPrompt: "Read sources and separate fact from inference" });
    const authority = capabilityBroker.createRuntimeAuthority({ ...persona, rootEnv: { OUTPUT_DIR: "output" }, pathAuthority: await pathPolicy.createAuthority([{ rootId: "output", role: "output", configuredPath: output, permissions: ["create-file", "replace-file"] }]) });
    const session = createSession(persona, "Research");
    let iteration = 0;
    const llm = {
      async chat() { return { role: "assistant", content: "Research" }; },
      async *chatStream(messages) {
        const step = iteration++;
        if (step === 0) yield { type: "result", message: { role: "assistant", content: "", tool_calls: [call("read-a", "fetch_markdown", { url: `${origin}/redirect` }), call("read-b", "fetch_markdown", { url: `${origin}/b` }), call("read-missing", "fetch_markdown", { url: `${origin}/missing` })] } };
        else if (step === 1) {
          assert.match(messages.find(message => message.tool_call_id === "read-a").content, /2025 年销量 24/u);
          assert.match(messages.find(message => message.tool_call_id === "read-b").content, /2024 年销量 21/u);
          yield { type: "result", message: { role: "assistant", content: "", tool_calls: [call("report", "create_docx", { path: "研究报告.docx", title: "销量研究", paragraphs: ["事实：2025 年销量 24；2024 年销量 21。", "推断：年份不同，不能视为矛盾；第三来源获取失败。"], sources: [`${origin}/a`, `${origin}/b`] })] } };
        } else yield { type: "result", message: { role: "assistant", content: `销量年份不同。[甲](${origin}/a) [乙](${origin}/b)。第三来源获取失败。` } };
      },
    };
    const memory = new ConversationMemory(), agent = new Agent(llm, memory, persona, authority);
    agent.setSession(session.id);
    const events = await interaction.runWithInteractionChannel({ sessionId: session.id, runId: "research-run" }, { emit(event) {
      if (event.type === "ask_user") assert(interaction.submitAnswer(session.id, "research-run", event.questionId, "本次任务允许新建文档"));
    } }, async () => { const events = []; for await (const event of agent.run("比较年份并产出研究报告", "research-run")) events.push(event); return events; });
    assert.deepEqual(events.filter(event => event.type === "tool_result").map(event => event.toolStatus), ["success", "success", "error", "success"]);
    const research = collectResearchSources(loadSessionMessages(session.id));
    assert.deepEqual(research.sources.map(source => source.url), [`${origin}/a`, `${origin}/b`, `${origin}/missing`]);
    assert.deepEqual(research.sources.map(source => source.status), ["read", "read", "failed"]);
    assert.deepEqual(research.unreadLinks, []);
    const restored = new ConversationMemory(); restored.loadFromDb(session.id);
    assert.deepEqual(collectResearchSources(restored.getAll()), research);
    const { parseFileBuffer } = await import("../../src/tools/parsers.ts");
    const bytes = await readFile(path.join(output, "研究报告.docx"));
    const parsed = await parseFileBuffer("研究报告.docx", bytes);
    assert.equal(parsed.success, true);
    assert.match(parsed.text, /参考资料/u);
    assert.match(parsed.text, new RegExp(`${origin}/a`));
    const { default: mammoth } = await import("mammoth");
    const html = await mammoth.convertToHtml({ buffer: bytes });
    assert.match(html.value, new RegExp(`href="${origin}/a"`));
    assert.match(html.value, new RegExp(`href="${origin}/b"`));
    const { createDocxExec } = await import("../../src/tools/writer.ts");
    await assert.rejects(() => createDocxExec({ path: "伪造.docx", paragraphs: ["伪造来源"], sources: ["https://unread.example/"] }, {}, { signal: new AbortController().signal, capabilityContext: { sessionId: session.id }, path: { rootIdForEnv: () => "output", reserveFile: () => assert.fail("未读来源应在文件预留前拒绝") } }), /尚未读取/u);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
