import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const appRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixture = await mkdtemp(path.join(os.tmpdir(), "rainydays-repository-"));
const repository = path.join(fixture, "中文 项目"), outside = path.join(fixture, "outside");
await mkdir(path.join(repository, "src"), { recursive: true }); await mkdir(outside);
const git = process.platform === "win32" ? (execFileSync(path.join(process.env.SystemRoot, "System32", "where.exe"), ["git.exe"], { encoding: "utf8", windowsHide: true }).split(/\r?\n/u).find(Boolean)) : "/usr/bin/git";
Object.assign(process.env, { RAINYDAYS_APP_ROOT: appRoot, RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data"), RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(appRoot,"personas"), RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(appRoot,"skills"), RAINYDAYS_GIT_EXECUTABLE: await realpath(git) });
const runGit = args => execFileSync(git, args, { cwd: repository, windowsHide: true, encoding: "utf8" });
await writeFile(path.join(repository, ".gitignore"), "ignored/\n");
await writeFile(path.join(repository, "package.json"), JSON.stringify({ name: "project-context", scripts: { test: "node --test", build: "tsc" } }));
await writeFile(path.join(repository, "src", "原始.ts"), "export const value = 1;\n");
await writeFile(path.join(repository, "deleted.txt"), "must not be restored");
runGit(["init","--quiet"]); runGit(["add","--","."]);
await writeFile(path.join(repository, "src", "原始.ts"), "export const value = 1;\n// 用户未提交改动\n");
await rm(path.join(repository,"deleted.txt"));
await writeFile(path.join(repository,"src","未跟踪 文件.ts"), "export const pending = 'USER_NEW';\n");
await mkdir(path.join(repository,"ignored")); await writeFile(path.join(repository,"ignored","private.txt"), "ignored-content");
const [{ capabilityBroker, executeTool }, { pathPolicy }, { getPersona, createEffectivePersona }, { createSession }, { Agent }, { ConversationMemory }, { closeDb }] = await Promise.all([
  import("../../src/tools/index.ts"), import("../../src/path-runtime.ts"), import("../../src/persona.ts"), import("../../src/session.ts"), import("../../src/agent.ts"), import("../../src/memory.ts"), import("../../src/db.ts"),
]);
const builtin = await getPersona("general"); assert(builtin);
// Server-only persona management hooks are not installed in this isolated tool fixture.
const persona = createEffectivePersona({ ...builtin, tools: builtin.tools.filter(name=>["read_repo","read","search_tools"].includes(name)), env: { WORKSPACE_ROOT: repository }, allowedRoots: [repository], networkPolicy: { mode: "deny" } });
const authority = capabilityBroker.createRuntimeAuthority({ ...persona, rootEnv: { WORKSPACE_ROOT: "workspace" }, pathAuthority: await pathPolicy.createAuthority([{ rootId: "workspace", role: "workspace", configuredPath: repository, permissions: ["initial-cwd","search-tree","read-file","read-directory"] }]) });
test.after(async () => { await capabilityBroker.retireAuthority(authority); await closeDb(); assert.equal(path.dirname(fixture), path.resolve(os.tmpdir())); assert(path.basename(fixture).startsWith("rainydays-repository-")); await rm(fixture,{ recursive:true, force:true }); });
const session = () => createSession(persona,"项目上下文");

test("A02 selected project context includes scripts, modified/untracked/deleted state and preserves the worktree", async () => {
  const root = capabilityBroker.beginAgentRun(authority, session().id);
  const before = runGit(["status","--porcelain=v1","-z","--untracked-files=all"]);
  try {
    const summary = await executeTool(root,"read_repo",{path:repository,level:"summary"});
    assert.match(summary,/Repository root:/); assert.match(summary,/Working directory:/);
    assert.match(summary,/node --test/); assert.match(summary,/tsc/);
    assert.match(summary,/untracked/); assert.match(summary,/deleted%2Etxt/);
    const full = await executeTool(root,"read_repo",{path:repository,level:"all",include:"*.ts"});
    assert.match(full,/USER_NEW/); assert.match(full,/用户未提交改动/); assert.doesNotMatch(full,/ignored-content/);
    assert.equal(runGit(["status","--porcelain=v1","-z","--untracked-files=all"]),before);
    assert.equal(await readFile(path.join(repository,"src","未跟踪 文件.ts"),"utf8"),"export const pending = 'USER_NEW';\n");
    await assert.rejects(readFile(path.join(repository,"deleted.txt")),error=>error.code==="ENOENT");
    const child = await executeTool(root,"read_repo",{path:path.join(repository,"src"),level:"all"});
    assert.match(child,/USER_NEW/); assert.doesNotMatch(child,/node --test|package%2Ejson/);
    await assert.rejects(executeTool(root,"read_repo",{path:outside,level:"tree"}),error=>error.code==="PATH_ROOT_DENIED");
  } finally { capabilityBroker.finishContext(root); }
});

test("A02 the built-in default Agent discovers and reads a project during an ordinary task", async () => {
  let round=0;
  const call=(id,name,args)=>({id,type:"function",function:{name,arguments:JSON.stringify(args)}});
  const llm={async chat(){return {role:"assistant",content:"项目上下文"};},async *chatStream(messages,tools){
    if(round++===0) { assert(!tools.some(tool=>tool.function.name==="read_repo")); yield {type:"result",message:{role:"assistant",content:"",tool_calls:[call("discover-repo","search_tools",{keywords:"read_repo 项目仓库"})]}}; }
    else if(round===2) { assert(tools.some(tool=>tool.function.name==="read_repo"),"default assistant must discover repository context"); yield {type:"result",message:{role:"assistant",content:"",tool_calls:[call("read-project","read_repo",{path:repository,level:"summary"})]}}; }
    else { assert.match(messages.at(-1).content,/node --test/); yield {type:"result",message:{role:"assistant",content:"已识别项目与用户已有工作。"}}; }
  }};
  const agent=new Agent(llm,new ConversationMemory(),persona,authority); agent.setSession(session().id);
  const events=[]; for await(const event of agent.run("理解这个项目并保留我的修改","a02-project-context")) events.push(event);
  assert.equal(events.some(event=>event.type==="error"),false,JSON.stringify(events.filter(event=>event.type==="error")));
  assert.equal(events.find(event=>event.type==="tool_result"&&event.toolName==="read_repo")?.toolStatus,"success");
});

test("A02 installed Git is found without a developer environment override; missing explicit configuration is actionable", async () => {
  const { getBootstrapPathStore }=await import("../../src/bootstrap-path-store.ts");
  const previous=process.env.RAINYDAYS_GIT_EXECUTABLE;
  delete process.env.RAINYDAYS_GIT_EXECUTABLE;
  try {
    const lease=await getBootstrapPathStore().openGitExecutable();
    try { assert.equal(path.basename(lease.canonicalPath).toLowerCase(),process.platform==="win32"?"git.exe":"git"); await lease.assertCurrent(); }
    finally { await lease.close(); }
    process.env.RAINYDAYS_GIT_EXECUTABLE=path.join(fixture,"missing-git.exe");
    await assert.rejects(getBootstrapPathStore().openGitExecutable(),error=>error.code==="PATH_ROOT_UNAVAILABLE" && /安装Git/u.test(error.message));
  } finally { process.env.RAINYDAYS_GIT_EXECUTABLE=previous; }
});
