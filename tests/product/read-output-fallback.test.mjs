// A relative read misses DATA_ROOT but the file was just written to OUTPUT_DIR: read it from there and say so.
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixture = await mkdtemp(path.join(os.tmpdir(), "rainydays-read-fallback-"));
const workspace = path.join(fixture, "workspace"), output = path.join(fixture, "output");
for (const dir of [path.join(fixture, "data"), workspace, output]) await mkdir(dir, { recursive: true });
Object.assign(process.env, {
  RAINYDAYS_APP_ROOT: projectRoot, RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data"),
  RAINYDAYS_CONFIG_PATH: path.join(fixture, "config.json"),
  RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"), RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"),
});
const credentials = await import("../../src/credential-store.ts");
credentials.configureCredentialProtector({ protect: value => Buffer.from(value), unprotect: value => Buffer.from(value).toString() });
const config = await import("../../src/config.ts");
await config.initializeConfig();
const [{ Agent }, { ConversationMemory }, { createEffectivePersona }, { createSession }, { capabilityBroker }, { pathPolicy }, { closeDb }] = await Promise.all([
  import("../../src/agent.ts"), import("../../src/memory.ts"), import("../../src/persona.ts"), import("../../src/session.ts"),
  import("../../src/tools/index.ts"), import("../../src/path-runtime.ts"), import("../../src/db.ts"),
]);
test.after(async () => {
  closeDb();
  assert.equal(path.dirname(fixture), path.resolve(os.tmpdir())); assert(path.basename(fixture).startsWith("rainydays-read-fallback-"));
  await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("a relative read finds a result that exists only in the output folder, and says where it came from", async () => {
  await writeFile(path.join(output, "report.csv"), "城市,销量\n北京,120\n");
  await writeFile(path.join(workspace, "notes.txt"), "资料原文\n");
  const persona = createEffectivePersona({ name: "general", displayName: "Test", description: "", permissionLevel: "read_only", tools: ["read"], env: { DATA_ROOT: workspace, OUTPUT_DIR: output }, allowedRoots: [], networkPolicy: { mode: "deny" }, systemPrompt: "Fixture" });
  const authority = capabilityBroker.createRuntimeAuthority({ ...persona, rootEnv: { DATA_ROOT: "workspace", OUTPUT_DIR: "output" }, pathAuthority: await pathPolicy.createAuthority([
    { rootId: "workspace", role: "workspace", configuredPath: workspace, permissions: ["read-file", "read-directory"] },
    { rootId: "output", role: "output", configuredPath: output, permissions: ["read-file", "read-directory"] },
  ]) });
  const plan = [
    [{ id: "r1", type: "function", function: { name: "read", arguments: JSON.stringify({ file_path: "report.csv" }) } }],
    [{ id: "r2", type: "function", function: { name: "read", arguments: JSON.stringify({ file_path: "notes.txt" }) } }],
    [{ id: "r3", type: "function", function: { name: "read", arguments: JSON.stringify({ file_path: "missing.csv" }) } }],
  ];
  let stage = 0;
  const agent = new Agent({ async chat() { return { role: "assistant", content: "x" }; }, async *chatStream() {
    const calls = plan[stage++];
    yield { type: "result", message: calls ? { role: "assistant", content: "", tool_calls: calls } : { role: "assistant", content: "完成" } };
  } }, new ConversationMemory(), persona, authority);
  agent.setSession(createSession(persona, "fallback").id);
  const events = []; for await (const event of agent.run("核对文件", "fallback-run")) events.push(event);
  const [report, notes, missing] = events.filter(event => event.type === "tool_result");
  assert.equal(report.toolStatus, "success"); assert.match(report.content, /北京,120/u); assert.match(report.content, /成果目录中的同名文件/u);
  assert.equal(notes.toolStatus, "success"); assert.doesNotMatch(notes.content, /成果目录/u, "a file found in DATA_ROOT carries no note");
  assert.notEqual(missing.toolStatus, "success"); assert.match(missing.content, /不存在|PATH_NOT_FOUND/u, "a file in neither root is still reported missing");
});
