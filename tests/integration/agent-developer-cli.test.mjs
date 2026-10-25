import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { AsyncResource } from "node:async_hooks";
import test from "node:test";
import { waitFor, terminateProcessTreeAsync } from "../helpers.mjs";

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "rainydays-a03-dev-cli-"));
const workspace = path.join(fixture, "中文 项目"), appRoot = path.resolve(import.meta.dirname, "../..");
await fs.mkdir(workspace);
Object.assign(process.env, {
  RAINYDAYS_APP_ROOT: appRoot, RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data"),
  RAINYDAYS_CONFIG_PATH: path.join(fixture, "config.json"), RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(appRoot, "personas"),
  RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(appRoot, "skills"),
});
const credentials = await import("../../src/credential-store.ts");
credentials.configureCredentialProtector({ protect: value => Buffer.from(value), unprotect: value => Buffer.from(value).toString() });
const [{ Agent }, { ConversationMemory }, { getPersona, createEffectivePersona }, { createSession }, { capabilityBroker }, { pathPolicy }, config, interaction, { closeDb }] = await Promise.all([
  import("../../src/agent.ts"), import("../../src/memory.ts"), import("../../src/persona.ts"), import("../../src/session.ts"),
  import("../../src/tools/index.ts"), import("../../src/path-runtime.ts"), import("../../src/config.ts"),
  import("../../src/tools/ask-user-tool.ts"), import("../../src/db.ts"),
]);
await config.initializeConfig();
await config.updateSettingsDomain("shell", { defaultShell: "auto", initializationScript: "", developerMode: true });
const builtin = await getPersona("general"); assert(builtin);
// Keep every declared general-assistant tool; only index.ts's unrelated runtime
// persona-management hooks are absent from this isolated Agent fixture.
const { PERSONA_MANAGEMENT_TOOLS } = await import("../../src/persona.ts");
const persona = createEffectivePersona({ ...builtin, tools: builtin.tools.filter(name => !PERSONA_MANAGEMENT_TOOLS.includes(name)), env: { WORKSPACE_ROOT: workspace }, allowedRoots: [workspace] });
const authorities = [];
const requestScope = new AsyncResource("a03-separate-requests");
test.after(async () => {
  for (const authority of authorities) await capabilityBroker.retireAuthority(authority);
  closeDb();
  assert.equal(path.dirname(fixture), path.resolve(os.tmpdir())); assert(path.basename(fixture).startsWith("rainydays-a03-dev-cli-"));
  await fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

async function defaultAgent(next) {
  const pathAuthority = await pathPolicy.createAuthority([{ rootId: "workspace", role: "workspace", configuredPath: workspace, permissions: ["initial-cwd", "read-file", "read-directory"] }]);
  const authority = capabilityBroker.createRuntimeAuthority({ ...persona, rootEnv: { WORKSPACE_ROOT: "workspace" }, pathAuthority }); authorities.push(authority);
  const llm = { async chat() { return { role: "assistant", content: "CLI" }; }, async *chatStream(messages, tools) {
    const last = messages.at(-1);
    const content = last.role === "tool" ? JSON.parse(last.content).content : last.content;
    const action = await next(content, tools.map(tool => tool.function.name));
    yield { type: "result", message: action ? { role: "assistant", content: "", tool_calls: [{ id: crypto.randomUUID(), type: "function", function: { name: action.name, arguments: JSON.stringify(action.args) } }] } : { role: "assistant", content: "已核对真实命令结果。" } };
  } };
  const agent = new Agent(llm, new ConversationMemory(), persona, authority);
  const session = createSession(persona, "A03 开发模式 CLI"); agent.setSession(session.id);
  return { agent, session, questions: [] };
}
async function run(holder, id, signal) {
  return requestScope.runInAsyncScope(() => interaction.runWithInteractionChannel({ sessionId: holder.session.id, runId: id }, { emit(event) {
    if (event.type !== "ask_user") return;
    holder.questions.push(event); assert(interaction.submitAnswer(holder.session.id, id, event.questionId, "本次任务允许运行命令"));
  } }, async () => { const events = []; for await (const event of holder.agent.run("检查本机 CLI 和终端", id, signal)) events.push(event); assert.equal(events.some(event => event.type === "error"), false, JSON.stringify(events.filter(event => event.type === "error"))); return events; }));
}
const command = text => ({ name: "execute_command", args: { command: text, cwd: workspace } });
const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

test("A03 default developer Agent distinguishes missing dependencies from ordinary command failures", async () => {
  let round = 0;
  const holder = await defaultAgent((last, schemas) => {
    switch (round++) {
      case 0:
        assert(schemas.includes("execute_command"));
        return command("rainydays_a03_missing_cli_97e821 --version");
      case 1:
        assert.match(last, /退出码 (?:1|9009)/u);
        assert.match(last, /不是内部或外部命令|is not recognized as an internal or external command/iu);
        assert.doesNotMatch(last, /\ufffd/u);
        assert.match(last, /命令未找到/u);
        assert.match(last, /PATH/u);
        assert.match(last, /安装/u);
        return command("node -e \"console.error('PROJECT_ASSERTION_FAILED'); process.exit(7)\"");
      default:
        assert.match(last, /PROJECT_ASSERTION_FAILED/u); assert.match(last, /退出码 7/u);
        assert.doesNotMatch(last, /命令未找到/u);
    }
  });
  const events = await run(holder, "a03-dependency");
  assert.deepEqual(events.filter(event => event.type === "tool_result").map(event => event.toolStatus), ["error", "error"]);
  assert.equal(holder.questions.length, 1);
});

test("A03 default developer Agent pages a live 61 second terminal, routes stdin and executes alongside it", { timeout: 95_000 }, async () => {
  await fs.writeFile(path.join(workspace, "long.mjs"), "console.log('CLI_READY'); process.stdin.once('data', b => { console.log('STDIN=' + b.toString().trim()); for(let i=0;i<1600;i++) console.log('PAGE_' + i + '_中文'); }); setTimeout(() => { console.log('CLI_DONE'); process.exit(0); }, 61000);\n");
  let round = 0, terminalId, reader, offset = 0, paged = "", pages = 0, started;
  const holder = await defaultAgent(async (last, schemas) => {
    switch (round++) {
      case 0:
        assert(["execute_command", "shell_start", "shell_input", "shell_output"].every(name => schemas.includes(name)));
        return { name: "shell_start", args: { shell: "cmd", cwd: workspace } };
      case 1:
        terminalId = /ID: (term_[a-f0-9]+)/u.exec(last)?.[1]; assert(terminalId);
        reader = holder.agent.getTerminalReader(); assert(reader.isCurrent());
        return command("node -e \"console.log('CONCURRENT_CWD=' + process.cwd())\"");
      case 2:
        assert(last.includes(`CONCURRENT_CWD=${workspace}`));
        started = Date.now(); return { name: "shell_input", args: { terminalId, input: "node long.mjs" } };
      case 3: {
        await waitFor(() => /CLI_READY/u.test(reader.output(terminalId, 0).data), { timeoutMs: 5000 });
        let otherRound = 0;
        const other = await defaultAgent(lastOther => {
          if (otherRound++ === 0) return { name: "shell_input", args: { terminalId, input: "WRONG_OWNER" } };
          assert.match(lastOther, /终端不存在/u);
        });
        const denied = await run(other, "a03-other-owner");
        assert.equal(denied.find(event => event.type === "tool_result").toolStatus, "error");
        assert.equal(reader.get(terminalId).status, "running", "another run ending must preserve this terminal");
        return { name: "shell_input", args: { terminalId, input: "张三" } };
      }
      case 4:
        await waitFor(() => /PAGE_1599_中文/u.test(reader.output(terminalId, 0, 100000).data), { timeoutMs: 5000 });
        break;
      default:
        if (last.includes("退出码: 7")) { assert.match(last, /child-failed/u); return; }
        if (last.includes("nextOffset=")) {
          const next = Number(/nextOffset=(\d+)/u.exec(last)?.[1]); assert(next > offset);
          paged += last.slice(last.indexOf("\n\n") + 2); offset = next; pages++;
        } else if (last.includes("已向")) {
          await waitFor(() => reader.get(terminalId).status !== "running", { timeoutMs: 5000 });
          return { name: "shell_output", args: { terminalId, offset: 0, limit: 1000 } };
        }
        break;
    }
    if (offset < reader.get(terminalId).outputEnd) return { name: "shell_output", args: { terminalId, offset, limit: 1000 } };
    assert(pages > 10); assert.match(paged, /STDIN=张三/u); assert.doesNotMatch(paged, /WRONG_OWNER/u);
    const lines = [...paged.matchAll(/^PAGE_(\d+)_中文\r?$/gmu)].map(match => Number(match[1]));
    assert.deepEqual(lines, Array.from({ length: 1600 }, (_, i) => i));
    await waitFor(() => /CLI_DONE/u.test(reader.output(terminalId, offset, 1000).data), { timeoutMs: 70_000 });
    assert(Date.now() - started >= 60_000);
    return { name: "shell_input", args: { terminalId, input: "exit 7" } };
  });
  const events = await run(holder, "a03-long-terminal");
  assert(events.filter(event => event.type === "tool_result").every(event => event.toolStatus === "success"));
  assert.equal(holder.questions.length, 1); assert.equal(holder.agent.getTerminalReader(), null);
  assert.equal(reader.isCurrent(), false); assert.throws(() => reader.output(terminalId), /结束|失效/u);
});

test("A03 cancelling a default developer Agent cleans its active terminal tree and preserves an unrelated process", { timeout: 20_000 }, async () => {
  await fs.writeFile(path.join(workspace, "heartbeat.mjs"), "import fs from 'node:fs'; import {spawn} from 'node:child_process'; const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}); let tick=0; setInterval(()=>fs.writeFileSync('heartbeat.json',JSON.stringify({pid:process.pid,child:child.pid,tick:++tick})),50);\n");
  const independent = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
  const controller = new AbortController(); let round = 0, terminalId, reader, state, cancelledAt;
  const holder = await defaultAgent(async last => {
    switch (round++) {
      case 0: return { name: "shell_start", args: { shell: "cmd", cwd: workspace } };
      case 1:
        terminalId = /ID: (term_[a-f0-9]+)/u.exec(last)?.[1]; assert(terminalId); reader = holder.agent.getTerminalReader();
        return { name: "shell_input", args: { terminalId, input: "node heartbeat.mjs" } };
      default:
        state = await waitFor(async () => { try { return JSON.parse(await fs.readFile(path.join(workspace, "heartbeat.json"), "utf8")); } catch { return false; } }, { timeoutMs: 5000 });
        assert(alive(state.pid) && alive(state.child)); cancelledAt = Date.now(); controller.abort();
        assert(Date.now() - cancelledAt < 1000);
        return command("echo MUST_NOT_RUN>after-cancel.txt");
    }
  });
  try {
    await assert.rejects(run(holder, "a03-cancel-terminal", controller.signal), error => error.code === "RUN_CANCELLED");
    assert(Date.now() - cancelledAt < 5000);
    assert(!alive(state.pid) && !alive(state.child)); assert(alive(independent.pid));
    const settled = await fs.readFile(path.join(workspace, "heartbeat.json"), "utf8");
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(await fs.readFile(path.join(workspace, "heartbeat.json"), "utf8"), settled);
    await assert.rejects(fs.access(path.join(workspace, "after-cancel.txt")));
    assert.equal(reader.isCurrent(), false);
  } finally { await terminateProcessTreeAsync(independent); }
});
