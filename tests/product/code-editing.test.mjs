import assert from "node:assert/strict";
import {createHash} from "node:crypto";
import {mkdtemp,mkdir,readFile,rm,writeFile} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import test from "node:test";

const fixture=await mkdtemp(path.join(os.tmpdir(),"rainydays-code-edit-")), workspace=path.join(fixture,"中文 项目");
await mkdir(workspace);
Object.assign(process.env,{RAINYDAYS_APP_ROOT:fileURLToPath(new URL("../../",import.meta.url)),RAINYDAYS_USER_DATA_DIR:fixture,RAINYDAYS_DATA_DIR:path.join(fixture,"data")});
const [{capabilityBroker,inspectToolCall,prepareInspectedToolExecution,executeTool},{pathPolicy},{createEffectivePersona},{createSession},{ConversationMemory},{closeDb}]=await Promise.all([
  import("../../src/tools/index.ts"),import("../../src/path-runtime.ts"),import("../../src/persona.ts"),import("../../src/session.ts"),import("../../src/memory.ts"),import("../../src/db.ts"),
]);
const hash=text=>createHash("sha256").update(text).digest("hex");
const persona=createEffectivePersona({name:"code-edit-fixture",displayName:"Code",description:"",permissionLevel:"full",tools:["read","write","edit_files","undo_edits"],env:{WORKSPACE_ROOT:workspace,OUTPUT_DIR:workspace},allowedRoots:[workspace],systemPrompt:"fixture",networkPolicy:{mode:"deny"}});
const authority=capabilityBroker.createRuntimeAuthority({...persona,rootEnv:{WORKSPACE_ROOT:"workspace",OUTPUT_DIR:"workspace"},pathAuthority:await pathPolicy.createAuthority([{rootId:"workspace",role:"workspace",configuredPath:workspace,permissions:["read-file","read-directory","create-file","replace-file"]}])});
test.after(async()=>{await capabilityBroker.retireAuthority(authority);await closeDb();assert.equal(path.dirname(fixture),path.resolve(os.tmpdir()));assert(path.basename(fixture).startsWith("rainydays-code-edit-"));await rm(fixture,{recursive:true,force:true});});
async function scenario(run){const session=createSession(persona,"编辑"),root=capabilityBroker.beginAgentRun(authority,session.id);try{await run(root,session);}finally{capabilityBroker.finishContext(root);}}
async function approved(root,name,args){const inspected=inspectToolCall(root,name,args),challenge=capabilityBroker.createApprovalChallenge(root,inspected);const grant=capabilityBroker.resolveApprovalChallenge({challengeId:challenge.challengeId,choice:"approve",sessionId:root.sessionId,runId:root.runId,responsePrincipal:"local-user-api",responseChannel:"ask-user"});assert(grant);try{return await prepareInspectedToolExecution(grant,inspected).execute();}finally{capabilityBroker.finishContext(grant);}}
const file=(file_path,source,old_string,new_string)=>({file_path,expected_revision:hash(source),edits:[{old_string,new_string}]});
function persist(session,receipt,name="edit_files"){const memory=new ConversationMemory();memory.setSessionId(session.id);memory.addMany([{role:"assistant",content:"",tool_calls:[{id:"edit-receipt",type:"function",function:{name,arguments:"{}"}}]},{role:"tool",tool_call_id:"edit-receipt",content:JSON.stringify(receipt)}]);return memory;}

test("A02 edits two UTF-8 files from read revisions, preserves existing work and can undo after restoring memory",async()=>scenario(async(root,session)=>{
  const first=path.join(workspace,"第一 文件.ts"),second=path.join(workspace,"未跟踪.py");
  const before="\ufeff// 用户已改\r\nexport const value = 1;\r\n",other="# 用户新文件\nvalue = 1\n";
  await writeFile(first,before);await writeFile(second,other);
  const read=await executeTool(root,"read",{file_path:first});assert.match(read,new RegExp(hash(before)));
  const outcome=await approved(root,"edit_files",{files:[file(first,before,"value = 1","value = 2"),file(second,other,"value = 1","value = 2")]});
  assert.equal(outcome.status,"success");const receipt=JSON.parse(outcome.content);assert.equal(receipt.changes.length,2);
  assert.equal(await readFile(first,"utf8"),before.replace("value = 1","value = 2"));
  assert.equal(await readFile(second,"utf8"),other.replace("value = 1","value = 2"));
  assert.match(receipt.changes[0].diff,/-value = 1/);assert.match(receipt.changes[0].diff,/\+value = 2/);
  persist(session,outcome);const restored=new ConversationMemory();restored.loadFromDb(session.id);assert(restored.getAll().some(message=>message.role==="tool"));
  const undone=await approved(root,"undo_edits",{change_id:receipt.changeId});assert.equal(undone.status,"success");
  assert.equal(await readFile(first,"utf8"),before);assert.equal(await readFile(second,"utf8"),other);
}));

test("A02 read-then-save conflict stops the batch without changing any file",async()=>scenario(async root=>{
  const first=path.join(workspace,"safe.ts"),second=path.join(workspace,"race.ts");
  await writeFile(first,"value = 1\n");await writeFile(second,"value = 1\n// 用户保存\n");
  const outcome=await approved(root,"edit_files",{files:[file(first,"value = 1\n","1","2"),file(second,"value = 1\n","1","2")]});
  assert.equal(outcome.status,"error");const receipt=JSON.parse(outcome.content);assert.equal(receipt.changes[1].status,"conflict");assert.equal(receipt.changes[0].status,"not_started");
  assert.equal(await readFile(first,"utf8"),"value = 1\n");assert.match(await readFile(second,"utf8"),/用户保存/);
}));

test("A02 undo refuses external saves and another session's receipt",async()=>{
  let changeId;
  await scenario(async(root,session)=>{
  const target=path.join(workspace,"undo.ts");await writeFile(target,"value = 1\n");
  const outcome=await approved(root,"edit_files",{files:[file(target,"value = 1\n","1","2")]});persist(session,outcome);
  const receipt=JSON.parse(outcome.content);await writeFile(target,"value = 2\n// 外部后续修改\n");
  const undone=await approved(root,"undo_edits",{change_id:receipt.changeId});assert.equal(undone.status,"error");assert.match(await readFile(target,"utf8"),/外部后续修改/);
  changeId=receipt.changeId;
  });
  await scenario(async otherRoot=>{await assert.rejects(approved(otherRoot,"undo_edits",{change_id:changeId}),error=>error.code==="TOOL_ARGUMENTS_INVALID");});
});

test("A02 a competing save during a batch preserves completed diffs and stops remaining writes",async()=>scenario(async root=>{
  const first=path.join(workspace,"partial-a.ts"),second=path.join(workspace,"partial-b.ts");for(const target of[first,second])await writeFile(target,"value = 1\n");
  const args={files:[file(first,"value = 1\n","1","2"),file(second,"value = 1\n","1","2")]};
  const inspected=inspectToolCall(root,"edit_files",args),challenge=capabilityBroker.createApprovalChallenge(root,inspected);
  const grant=capabilityBroker.resolveApprovalChallenge({challengeId:challenge.challengeId,choice:"approve",sessionId:root.sessionId,runId:root.runId,responsePrincipal:"local-user-api",responseChannel:"ask-user"});
  const issued=capabilityBroker.issueToolPathGateway(grant,inspected);let writes=0;
  try{const content=await capabilityBroker.invokeTool(grant,inspected,{capabilityContext:grant,signal:new AbortController().signal,path:{...issued.gateway,replaceFile:async(...params)=>{const result=await issued.gateway.replaceFile(...params);if(++writes===1)await writeFile(second,"value = 1\n// 外部竞争\n");return result;}}});const receipt=JSON.parse(content);assert.equal(receipt.status,"partial");assert.deepEqual(receipt.changes.map(change=>change.status),["written","conflict"]);assert.match(receipt.changes[0].diff,/\+2/);assert.equal(await readFile(first,"utf8"),"value = 2\n");assert.match(await readFile(second,"utf8"),/外部竞争/);}finally{issued.close();capabilityBroker.finishContext(grant);}
}));

test("A02 write without a read revision creates only and preserves existing content",async()=>scenario(async root=>{
  const target=path.join(workspace,"new-only.txt");await writeFile(target,"用户原文");
  await assert.rejects(approved(root,"write",{file_path:target,content:"不能覆盖"}));assert.equal(await readFile(target,"utf8"),"用户原文");
  const created=path.join(workspace,"new-file.txt");await approved(root,"write",{file_path:created,content:"新建原文"});assert.equal(await readFile(created,"utf8"),"新建原文");
}));

test("A02 complete multi-file receipts survive transport limits and compaction for undo",async()=>scenario(async(root,session)=>{
  const source='const value = "'+"\\".repeat(300)+'";\n';
  const files=[];for(let index=0;index<8;index++){const target=path.join(workspace,`bounded-${index}.ts`);await writeFile(target,source);files.push(file(target,source,source,source+"// changed\n"));}
  const outcome=await approved(root,"edit_files",{files});assert.equal(outcome.status,"success");assert.equal(outcome.truncated,false);
  const receipt=JSON.parse(outcome.content),memory=persist(session,outcome);
  for(let index=0;index<18;index++)memory.add({role:"assistant",content:"旧资料".repeat(2000)});
  await memory.compact({chat:async()=>({role:"assistant",content:"较早修改已收起，需要时取回真实记录。"})});
  assert.equal(JSON.stringify(memory.getAll()).includes(receipt.changeId),false);
  const undone=await approved(root,"undo_edits",{change_id:receipt.changeId});assert.equal(undone.status,"success");assert.equal(undone.truncated,false);
  for(const entry of files)assert.equal(await readFile(entry.file_path,"utf8"),source);
  const huge=path.join(workspace,"diff-too-large.ts"),old="\\".repeat(8000);await writeFile(huge,old);
  await assert.rejects(approved(root,"edit_files",{files:[file(huge,old,old,old+"x")]}),error=>error.code==="TOOL_ARGUMENTS_INVALID");
  assert.equal(await readFile(huge,"utf8"),old);
}));

test("A02 deleted and sequential replacement fragments undo exactly; out-of-scope files stay unchanged",async()=>scenario(async(root,session)=>{
  const target=path.join(workspace,"delete-fragment.ts"),source="\ufeff// 用户🙂\r\nconst a=1;\r\nconst b=2;\r\n";await writeFile(target,source);
  const outcome=await approved(root,"edit_files",{files:[{file_path:target,expected_revision:hash(source),edits:[{old_string:"const a=1;\r\n",new_string:""},{old_string:"b=2",new_string:"b=3"}]}]});assert.equal(outcome.status,"success");persist(session,outcome);
  assert.equal((await approved(root,"undo_edits",{change_id:JSON.parse(outcome.content).changeId})).status,"success");assert.equal(await readFile(target,"utf8"),source);
  const outside=path.join(fixture,"outside.ts");await writeFile(outside,"keep");
  const denied=await approved(root,"edit_files",{files:[file(outside,"keep","keep","lost")]});assert.equal(denied.status,"error");assert.equal(await readFile(outside,"utf8"),"keep");
}));

test("A02 cancellation between saves retains the first receipt and stops the next file",async()=>scenario(async root=>{
  const first=path.join(workspace,"cancel-a.ts"),second=path.join(workspace,"cancel-b.ts");for(const target of[first,second])await writeFile(target,"value = 1\n");
  const args={files:[file(first,"value = 1\n","1","2"),file(second,"value = 1\n","1","2")]},controller=new AbortController();
  const inspected=inspectToolCall(root,"edit_files",args),challenge=capabilityBroker.createApprovalChallenge(root,inspected),grant=capabilityBroker.resolveApprovalChallenge({challengeId:challenge.challengeId,choice:"approve",sessionId:root.sessionId,runId:root.runId,responsePrincipal:"local-user-api",responseChannel:"ask-user"}),issued=capabilityBroker.issueToolPathGateway(grant,inspected);
  try{const content=await capabilityBroker.invokeTool(grant,inspected,{capabilityContext:grant,signal:controller.signal,path:{...issued.gateway,replaceFile:async(...params)=>{const result=await issued.gateway.replaceFile(...params);controller.abort();return result;}}});const receipt=JSON.parse(content);assert.equal(receipt.status,"cancelled");assert.deepEqual(receipt.changes.map(change=>change.status),["written","not_started"]);assert.equal(await readFile(first,"utf8"),"value = 2\n");assert.equal(await readFile(second,"utf8"),"value = 1\n");}finally{issued.close();capabilityBroker.finishContext(grant);}
}));
