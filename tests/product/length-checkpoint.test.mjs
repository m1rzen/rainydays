import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// length 截断检查点（2026-11-14 审阅补充切片4，沿 D04）：length 是确定性结束，
// 不自动重试；本轮已有成功写入的文件时，保留已完成章节作为检查点并给出续接说明，
// 说明随消息持久化（重启后回放），截断残文不执行工具也不被补接。断线（EOF）仍走
// 原有 retry/interrupted 路径，两者互不影响。
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixture = await mkdtemp(path.join(os.tmpdir(), "rainydays-lengthck-"));
const workspace = path.join(fixture, "检查点 工作区");
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
const { Agent, setSessionAutoApproveEnabled } = await import("../../src/agent.ts");
const { ConversationMemory } = await import("../../src/memory.ts");
const { createEffectivePersona, getPersona } = await import("../../src/persona.ts");
const { createSession } = await import("../../src/session.ts");
const { capabilityBroker } = await import("../../src/tools/index.ts");
const { pathPolicy } = await import("../../src/path-runtime.ts");

test.after(async () => {
  closeDb();
  assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
  assert(path.basename(fixture).startsWith("rainydays-lengthck-"));
  await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function toolCall(id, name, args) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

async function buildAgent(script) {
  const builtin = await getPersona("general");
  const persona = createEffectivePersona({ ...builtin, tools: ["write", "read"], env: { WORKSPACE_ROOT: workspace }, allowedRoots: [workspace] });
  const authority = capabilityBroker.createRuntimeAuthority({
    ...persona, rootEnv: { WORKSPACE_ROOT: "workspace" },
    pathAuthority: await pathPolicy.createAuthority([{ rootId: "workspace", role: "workspace", configuredPath: workspace, permissions: ["initial-cwd", "read-file", "read-directory", "create-file"] }]),
  });
  const requests = [];
  const llm = {
    async chat() { return { role: "assistant", content: "摘要" }; },
    async *chatStream(messages) {
      requests.push(messages.map(message => ({ role: message.role, content: message.content })));
      const next = script.shift();
      if (typeof next === "string") throw new Error(next);
      yield { type: "result", message: next ?? { role: "assistant", content: "完成。" } };
    },
  };
  const agent = new Agent(llm, new ConversationMemory(), persona, authority);
  const session = createSession(persona, "length 检查点");
  agent.setSession(session.id);
  setSessionAutoApproveEnabled(session.id, true);
  return { agent, session, requests, cleanup: async () => { await capabilityBroker.retireAuthority(authority); } };
}

async function collect(agent, input, runId) {
  const events = [];
  for await (const event of agent.run(input, runId)) events.push(event);
  return events;
}

test("length 截断时保留已写入章节为检查点，说明持久化并在续接请求中回放", async () => {
  const target = path.join(workspace, "长文报告.md");
  const { agent, session, requests, cleanup } = await buildAgent([
    { role: "assistant", content: "", tool_calls: [toolCall("ck-1", "write", { file_path: target, content: "# 第一章\n已完成内容" })] },
    "回答未完整结束 (length)",
    { role: "assistant", content: "已核对文件并补齐第二章。" },
  ]);
  try {
    const events = await collect(agent, "写一份长报告并交付", "length-run");
    // 不抛出、无 error 事件：检查点说明作为本轮收束输出。
    assert.equal(events.some(event => event.type === "error"), false, "length + 已有写入不再作为 error 丢弃");
    const notice = events.find(event => event.type === "answer_chunk" && /长度限制/u.test(event.content));
    assert(notice, "输出检查点说明");
    assert.match(notice.content, /长文报告\.md/u, "说明列出已写入文件");
    assert.match(notice.content, /不会?被续写补接/u, "残文不补接");
    assert(events.some(event => event.type === "answer_done"));
    // 说明持久化在会话消息中；用户"继续"后下一轮模型请求可见检查点（重启回放同路径）。
    const resumeEvents = await collect(agent, "继续", "length-resume");
    assert(resumeEvents.some(event => event.type === "answer_done"));
    const resumeRequest = requests[2];
    assert(resumeRequest, "续接请求发生");
    assert(resumeRequest.some(message => /长度限制/u.test(message.content) && /长文报告\.md/u.test(message.content)), "检查点说明进入续接请求");
  } finally {
    setSessionAutoApproveEnabled(session.id, false);
    await cleanup();
  }
});

test("无已写入文件时 length 维持确定性错误，不产生检查点", async () => {
  const { agent, session, cleanup } = await buildAgent(["回答未完整结束 (length)"]);
  try {
    const events = await collect(agent, "随便聊聊", "plain-run");
    const error = events.find(event => event.type === "error");
    assert(error, "无写入时 length 仍是错误收束");
    assert.match(error.content, /未完整结束/u);
    assert.equal(events.some(event => event.type === "answer_chunk" && /长度限制/u.test(event.content)), false);
  } finally {
    setSessionAutoApproveEnabled(session.id, false);
    await cleanup();
  }
});
