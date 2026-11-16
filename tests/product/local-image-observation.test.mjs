import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// 本地图像观察（2026-11-14 审阅补充切片2，A08 缺失入口）：read 授权读取的本地
// PNG/JPEG 注册为会话观察并随工具结果附给模型，带文件版本摘要；相同文件重复读取
// 复用同一观察；损坏图片保持原有文本提示，不影响读取。文本读取不产生观察。
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixture = await mkdtemp(path.join(os.tmpdir(), "rainydays-localimg-"));
const workspace = path.join(fixture, "图片 工作区");
await mkdir(path.join(fixture, "data"));
await mkdir(workspace);
Object.assign(process.env, {
  RAINYDAYS_APP_ROOT: projectRoot, RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data"),
  RAINYDAYS_CONFIG_PATH: path.join(fixture, "config.json"),
  RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"), RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"),
});
const credentials = await import("../../src/credential-store.ts");
credentials.configureCredentialProtector({ protect: value => Buffer.from(value), unprotect: value => Buffer.from(value).toString() });
const config = await import("../../src/config.ts");
await config.initializeConfig();
const { closeDb } = await import("../../src/db.ts");

const PNG_1X1 = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
const JPEG_1X1 = Buffer.from("/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AVN//2Q==", "base64");
const pngPath = path.join(workspace, "sample.png");
const jpegPath = path.join(workspace, "sample.jpg");
const brokenPath = path.join(workspace, "broken.png");
const notesPath = path.join(workspace, "notes.txt");
await writeFile(pngPath, PNG_1X1);
await writeFile(jpegPath, JPEG_1X1);
await writeFile(brokenPath, Buffer.from("89504e470d0a1a0a", "hex"));
const { createHash } = await import("node:crypto");
const pngSha = createHash("sha256").update(PNG_1X1).digest("hex");
const jpegSha = createHash("sha256").update(JPEG_1X1).digest("hex");

test.after(async () => {
  closeDb();
  assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
  assert(path.basename(fixture).startsWith("rainydays-localimg-"));
  await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function toolCall(id, name, args) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

async function buildAgent(script) {
  const [{ Agent }, { ConversationMemory }, { createEffectivePersona, getPersona }, { createSession }, { capabilityBroker }, { pathPolicy }] = await Promise.all([
    import("../../src/agent.ts"), import("../../src/memory.ts"), import("../../src/persona.ts"), import("../../src/session.ts"),
    import("../../src/tools/index.ts"), import("../../src/path-runtime.ts"),
  ]);
  const builtin = await getPersona("general");
  const persona = createEffectivePersona({ ...builtin, tools: ["read"], env: { WORKSPACE_ROOT: workspace }, allowedRoots: [workspace] });
  const authority = capabilityBroker.createRuntimeAuthority({
    ...persona, rootEnv: { WORKSPACE_ROOT: "workspace" },
    pathAuthority: await pathPolicy.createAuthority([{ rootId: "workspace", role: "workspace", configuredPath: workspace, permissions: ["initial-cwd", "read-file", "read-directory"] }]),
  });
  const committedToolMessages = [];
  const requests = [];
  const llm = {
    async chat() { return { role: "assistant", content: "摘要" }; },
    async *chatStream(messages) {
      requests.push(messages);
      for (const message of messages) if (message.role === "tool") committedToolMessages.push(message);
      const next = script.shift();
      yield { type: "result", message: next ?? { role: "assistant", content: "已观察图片。" } };
    },
  };
  const agent = new Agent(llm, new ConversationMemory(), persona, authority);
  const session = createSession(persona, "本地图片观察");
  agent.setSession(session.id);
  return {
    agent, authority, requests,
    cleanup: async () => {
      await capabilityBroker.retireAuthority(authority);
    },
  };
}

async function collect(agent, input, runId) {
  const events = [];
  for await (const event of agent.run(input, runId)) events.push(event);
  return events;
}

test("本地图片观察：read PNG/JPEG 注册为观察并随工具结果附给模型，携带版本摘要", async () => {
  const { agent, authority, requests, cleanup } = await buildAgent([
    { role: "assistant", content: "", tool_calls: [toolCall("img-1", "read", { file_path: pngPath })] },
    { role: "assistant", content: "", tool_calls: [toolCall("img-2", "read", { file_path: jpegPath })] },
    { role: "assistant", content: "两张图片都已作为观察附上。" },
  ]);
  try {
    const events = await collect(agent, "看一下这两张图片", "img-run");
    const pngResult = events.find(event => event.type === "tool_result" && event.toolName === "read" && String(event.content).includes("sample.png"));
    assert(pngResult, "PNG 读取结果已交给用户");
    const pngPayload = JSON.parse(pngResult.content);
    assert.equal(pngPayload.mime, "image/png");
    assert.equal(pngPayload.width, 1);
    assert.equal(pngPayload.version, pngSha);
    assert.equal(pngPayload.rainydaysObservation.sha256, pngSha);
    // 工具消息上的观察：模型下一轮请求可见。
    const toolMessages = requests.flatMap(request => request.filter(message => message.role === "tool"));
    const pngObservation = toolMessages.find(message => String(message.content).includes("sample.png"))?.observations?.[0];
    assert(pngObservation, "PNG 观察已附在工具消息上");
    assert.equal(pngObservation.mime, "image/png");
    assert.equal(pngObservation.sha256, pngSha);
    const jpegObservation = toolMessages.find(message => String(message.content).includes("sample.jpg"))?.observations?.[0];
    assert(jpegObservation, "JPEG 观察已附在工具消息上");
    assert.equal(jpegObservation.mime, "image/jpeg");
    assert.equal(jpegObservation.sha256, jpegSha);
  } finally {
    await cleanup();
  }
});

test("本地图片观察：相同文件重复读取复用同一版本；损坏图片保持文本提示；文本读取无观察", async () => {
  const { agent, authority, requests, cleanup } = await buildAgent([
    { role: "assistant", content: "", tool_calls: [toolCall("img-3", "read", { file_path: pngPath })] },
    { role: "assistant", content: "", tool_calls: [toolCall("img-4", "read", { file_path: brokenPath })] },
    { role: "assistant", content: "", tool_calls: [toolCall("img-5", "read", { file_path: notesPath })] },
    { role: "assistant", content: "完成。" },
  ]);
  try {
    await writeFile(path.join(workspace, "notes.txt"), "普通文本");
    const events = await collect(agent, "检查这些文件", "reuse-run");
    const reread = events.find(event => event.type === "tool_result" && String(event.content).includes("sample.png"));
    assert.equal(JSON.parse(reread.content).version, pngSha, "相同文件复用同一版本摘要");
    const broken = events.find(event => event.type === "tool_result" && String(event.content).includes("broken.png"));
    assert.match(broken.content, /图片签名与扩展名不匹配/u, "损坏图片被既有签名校验拒绝，不进入观察");
    const plain = events.find(event => event.type === "tool_result" && String(event.content).includes("notes.txt"));
    assert.equal(JSON.stringify(plain.content).includes("rainydaysObservation"), false);
    const observed = new Map();
    for (const message of requests.flatMap(request => request.filter(m => m.role === "tool"))) {
      if (message.observations?.length) observed.set(message.content, message);
    }
    assert.equal(observed.size, 1, "只有合法 PNG/JPEG 读取产生观察");
    assert.equal([...observed.values()][0].observations[0].sha256, pngSha);
  } finally {
    await cleanup();
  }
});
