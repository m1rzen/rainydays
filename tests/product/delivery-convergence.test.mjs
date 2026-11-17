import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// 交付收敛（2026-11-14 审阅补充切片1，沿 A14/D04）：用户明确要求交付后，宿主记录
// 复核轮次并有界约束“换命令、换脚本形式的重复检查”——先提醒，超过上限停止本轮并
// 汇报产物；任何其他工具的成功轮次重置计数；简单问答保持直接回答路径。
const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixture = await mkdtemp(path.join(os.tmpdir(), "rainydays-delivery-"));
const workspace = path.join(fixture, "交付 工作区");
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
const setDeveloperMode = enabled => config.updateSettingsDomain("shell", { defaultShell: "auto", initializationScript: "", developerMode: enabled });
test.after(async () => {
  closeDb();
  assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
  assert(path.basename(fixture).startsWith("rainydays-delivery-"));
  await rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

function toolCall(id, name, args) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

async function buildAgent(script, onDeliver = null) {
  const [{ Agent, setSessionAutoApproveEnabled }, { ConversationMemory }, { createEffectivePersona, getPersona }, { createSession }, { capabilityBroker }, { pathPolicy }, { registerDynamicTool }] = await Promise.all([
    import("../../src/agent.ts"), import("../../src/memory.ts"), import("../../src/persona.ts"), import("../../src/session.ts"),
    import("../../src/tools/index.ts"), import("../../src/path-runtime.ts"), import("../../src/tools/index.ts"),
  ]);
  await setDeveloperMode(true);
  const builtin = await getPersona("general");
  const persona = createEffectivePersona({ ...builtin, tools: ["execute_command", "agent_list"], env: { WORKSPACE_ROOT: workspace }, allowedRoots: [workspace] });
  const authority = capabilityBroker.createRuntimeAuthority({
    ...persona, rootEnv: { WORKSPACE_ROOT: "workspace" },
    pathAuthority: await pathPolicy.createAuthority([{ rootId: "workspace", role: "workspace", configuredPath: workspace, permissions: ["initial-cwd", "read-file", "read-directory"] }]),
  });
  registerDynamicTool(authority, {
    name: "agent_list",
    definition: {
      type: "function",
      function: {
        name: "agent_list",
        description: "交付产物夹具：返回已生成的产物路径",
        parameters: { type: "object", properties: { path: { type: "string" } } },
      },
    },
    executor: async args => {
      onDeliver?.(args);
      return `交付产物已生成：${args?.path ?? "fixture-result.md"}`;
    },
  });
  let modelCalls = 0;
  const requests = [];
  const llm = {
    async chat() { return { role: "assistant", content: "摘要" }; },
    async *chatStream(messages) {
      modelCalls += 1;
      requests.push(messages.map(message => ({ role: message.role, content: message.content })));
      const next = script.shift();
      yield { type: "result", message: next ?? { role: "assistant", content: "交付完成" } };
    },
  };
  const agent = new Agent(llm, new ConversationMemory(), persona, authority);
  const session = createSession(persona, "交付收敛");
  agent.setSession(session.id);
  return { agent, session, authority, requests, setSessionAutoApproveEnabled, calls: () => modelCalls };
}

async function collect(agent, input, runId) {
  const events = [];
  for await (const event of agent.run(input, runId)) events.push(event);
  return events;
}

async function cleanup(authority) {
  const { capabilityBroker } = await import("../../src/tools/index.ts");
  await capabilityBroker.retireAuthority(authority);
  await setDeveloperMode(false);
}

test("productive commands are progress and reach the final delivery response", async () => {
  const files = ["part-one.md", "part-two.md", "part-three.md"];
  const { agent, session, authority, calls, setSessionAutoApproveEnabled } = await buildAgent([
    ...files.map((file, index) => ({ role: "assistant", content: "", tool_calls: [toolCall(`produce-${index}`, "execute_command", { command: `echo actual-content > "${file}"`, cwd: workspace })] })),
    { role: "assistant", content: "三个文件均已生成，可以交付。" },
  ]);
  try {
    setSessionAutoApproveEnabled(session.id, true);
    const events = await collect(agent, "生成报告并交付", "productive-delivery");
    for (const file of files) assert.match(await readFile(path.join(workspace, file), "utf8"), /actual-content/u);
    assert.equal(calls(), 4);
    assert(events.some(event => event.type === "answer_done" && /三个文件/u.test(event.content)));
    assert.equal(events.some(event => /没有产出新成果/u.test(event.content ?? "")), false);
  } finally {
    setSessionAutoApproveEnabled(session.id, false);
    await cleanup(authority);
  }
});

test("交付收敛：明确交付要求注入收敛引导；简单问答保持直接回答路径", async () => {
  const { agent, authority, requests, calls } = await buildAgent([
    { role: "assistant", content: "这是对问题的直接回答，无需生成产物。" },
  ]);
  try {
    const events = await collect(agent, "顺便问一下，什么是发布说明？", "qa-run");
    assert.equal(calls(), 1);
    assert(events.some(event => event.type === "answer_done"));
    assert.equal(requests[0].some(m => m.role === "system" && /交付收敛模式/u.test(m.content)), false, "无交付要求时不注入收敛引导");
    assert.equal(events.some(event => event.type === "tool_call"), false);
  } finally {
    await cleanup(authority);
  }
});

test("交付收敛：连续检查先提醒、超过上限即由宿主停止并汇报产物", async () => {
  const cmd = { command: "echo 检查", cwd: workspace };
  const { agent, session, setSessionAutoApproveEnabled, authority, requests, calls } = await buildAgent([
    { role: "assistant", content: "", tool_calls: [toolCall("dc-1", "execute_command", cmd)] },
    { role: "assistant", content: "", tool_calls: [toolCall("dc-2", "execute_command", cmd)] },
    { role: "assistant", content: "", tool_calls: [toolCall("dc-3", "execute_command", cmd)] },
    { role: "assistant", content: "永远不会到达：收敛停止必须发生在第三次请求之后" },
  ]);
  try {
    setSessionAutoApproveEnabled(session.id, true);
    const events = await collect(agent, "请把当前进度整理成报告交付", "delivery-run");
    assert.equal(calls(), 3, `停止必须发生在第 3 轮之后，不再请求模型：calls=${calls()}`);
    assert.equal(requests[0].some(m => m.role === "system" && /交付收敛模式/u.test(m.content)), true, "首轮请求包含收敛引导");
    assert.equal(requests[2].some(m => m.role === "system" && /交付复核提醒/u.test(m.content)), true, "第 3 轮请求包含复核提醒");
    const halt = events.find(event => event.type === "answer_chunk" && /交付收敛规则/u.test(event.content));
    assert(halt, "停止说明已交给用户");
    assert.match(halt.content, /已完成的步骤/u);
    assert.match(halt.content, /echo 检查/u, "停止说明汇报已执行的具体步骤");
    assert(events.some(event => event.type === "answer_done"));
  } finally {
    setSessionAutoApproveEnabled(session.id, false);
    await cleanup(authority);
  }
});

test("交付收敛：其他工具成功轮次重置复核计数，不会误停有产出的任务", async () => {
  const cmd = { command: "echo 检查", cwd: workspace };
  const { agent, session, setSessionAutoApproveEnabled, authority, calls } = await buildAgent([
    { role: "assistant", content: "", tool_calls: [toolCall("dp-1", "execute_command", cmd)] },
    { role: "assistant", content: "", tool_calls: [toolCall("dp-2", "execute_command", cmd)] },
    { role: "assistant", content: "", tool_calls: [toolCall("dp-3", "agent_list", { path: "fixture-result.md" })] },
    { role: "assistant", content: "", tool_calls: [toolCall("dp-4", "execute_command", cmd)] },
    { role: "assistant", content: "产物已生成：fixture-result.md" },
  ]);
  try {
    setSessionAutoApproveEnabled(session.id, true);
    const events = await collect(agent, "生成总结并交付给我", "produce-run");
    assert.equal(calls(), 5, "产出成功后计数重置，后续检查不会触发停止");
    assert(events.some(event => event.type === "tool_result" && event.toolName === "agent_list" && event.toolStatus === "success"));
    assert.equal(events.some(event => event.type === "answer_chunk" && /交付收敛规则/u.test(event.content)), false);
  } finally {
    setSessionAutoApproveEnabled(session.id, false);
    await cleanup(authority);
  }
});

test("交付收敛：运行中追加的交付指令同样进入收敛模式", async () => {
  const { agent, authority, requests } = await buildAgent(
    [
      { role: "assistant", content: "", tool_calls: [toolCall("ds-1", "agent_list", { path: "half.md" })] },
      { role: "assistant", content: "收到，将按收敛要求交付。" },
    ],
    () => {
      assert.equal(agent.steer("steer-run", "补充：最终请交付成 Word 报告"), true);
    },
  );
  try {
    await collect(agent, "先检查现状", "steer-run");
    const steerRequest = requests[1];
    assert(steerRequest.some(m => m.role === "user" && /交付成 Word/u.test(m.content)), "追加指令进入下一轮模型请求");
    assert(steerRequest.some(m => m.role === "system" && /交付收敛模式/u.test(m.content)), "追加交付指令后下一轮注入收敛引导");
    assert.equal(requests[0].some(m => m.role === "system" && /交付收敛模式/u.test(m.content)), false, "追加前不进入收敛模式");
  } finally {
    await cleanup(authority);
  }
});
