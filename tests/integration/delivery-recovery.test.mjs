import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { freePort, makeTempDir, projectRoot, removeFixture, spawnManaged, terminateProcessTreeAsync, waitFor } from "../helpers.mjs";

async function startProduct(fixture, token) {
  const workspace = path.join(fixture, "workspace");
  const department = path.join(fixture, "department");
  const output = path.join(fixture, "output");
  await Promise.all([workspace, department, output, path.join(fixture, "data")].map(directory => fs.mkdir(directory, { recursive: true })));
  const configPath = path.join(fixture, "config.json");
  try { await fs.access(configPath); }
  catch {
    await fs.writeFile(configPath, JSON.stringify({
      defaultProfile: "default",
      profiles: { default: { model: "test-model", apiKey: "provider-secret-never-public", baseURL: "https://provider.example.test", providerType: "openai-compatible" } },
      settings: { defaultPersona: "general", workspaceRoot: workspace, departmentDataRoot: department, outputDir: output },
    }));
  }
  const port = await freePort();
  const base = `http://127.0.0.1:${port}/api`;
  const child = spawnManaged(process.execPath, ["tests/fixtures/server-with-test-protector.mjs"], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      PORT: String(port), RAINYDAYS_API_TOKEN: token, RAINYDAYS_ALLOW_LOOPBACK_HTTP_PROVIDER: "1",
      RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data"), RAINYDAYS_CONFIG_PATH: configPath,
      RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"), RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"), RAINYDAYS_PUBLIC_DIR: path.join(projectRoot, "public"),
      WORKSPACE_ROOT: "", DEPARTMENT_DATA_ROOT: "", OUTPUT_DIR: "",
    },
  });
  let stdout = ""; let stderr = "";
  child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; }); child.stderr.on("data", chunk => { stderr += chunk; });
  try { await waitFor(async () => (await fetch(`${base}/status`, { headers: { "X-RainyDays-Token": token } }).catch(() => null))?.ok === true, { timeoutMs: 30_000, label: "DS-09 server" }); } catch (error) { await terminateProcessTreeAsync(child); throw new Error("Startup failed: " + stderr.slice(-5000) + stdout.slice(-3000)); }
  return { child, base, configPath, logs: () => ({ stdout, stderr }) };
}

let shutdownId = 0;
async function stopProduct(product) {
  if (!product) return;
  const requestId = `ds09-shutdown-${++shutdownId}`;
  const settled = new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 10_000);
    const onMessage = message => {
      if (message?.requestId !== requestId) return;
      clearTimeout(timer); product.child.off("message", onMessage); resolve(true);
    };
    product.child.on("message", onMessage);
  });
  product.child.send({ type: "rt01-shutdown", requestId });
  await settled;
  await terminateProcessTreeAsync(product.child);
}

async function api(product, token, route, options = {}) {
  const response = await fetch(`${product.base}${route}`, {
    ...options,
    headers: { "X-RainyDays-Token": token, "Content-Type": "application/json", ...options.headers },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

import {createServer} from 'node:http';
async function setupReviewServer(name,configured,mode){
  const fixture=await makeTempDir('rainydays-review-api-');const token='review-only-token';
  const workspace=path.join(fixture,'workspace'),output=path.join(fixture,'output'),department=path.join(fixture,'department');
  await Promise.all([workspace,output,department].map(p=>fs.mkdir(p,{recursive:true})));
  const source=path.join(workspace,'input.md'),chapter=path.join(output,'chapter.md');
  await fs.writeFile(source,'# Material\nFrozen input version');
  let streams=0;
  const requests=[];
  const provider=createServer(async(req,res)=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());
    if(!body.stream){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'OK'},finish_reason:'stop'}]}));return;}
    requests.push(body);
    streams++;res.writeHead(200,{'Content-Type':'text/event-stream'});
    const call=(index,id,name,args)=>({index,id,type:'function',function:{name,arguments:JSON.stringify(args)}});
    const write=()=>call(0,`chapter-write-${streams}`,'write',{file_path:chapter,content:'# Chapter 1\nComplete first section'});
    let delta={content:'Completed.'},reason='stop';
    if(mode!=='normal'&&streams===1){delta={tool_calls:[call(0,'source-read','read',{file_path:source}),{...write(),index:1}]};reason='tool_calls';}
    else if(mode==='hang'&&streams===2){res.write(': waiting for cancellation\n\n');return;}
    else if(mode!=='normal'&&streams===2){delta={content:'Second chapter is truncated'};reason='length';}
    else if(mode!=='normal'&&streams===3){delta={tool_calls:[write()]};reason='tool_calls';}
    else if(mode!=='normal'&&streams===4){delta={tool_calls:[call(0,'chapter-two','edit',{file_path:chapter,old_string:'# Chapter 1\nComplete first section',new_string:'# Chapter 1\nComplete first section\n# Chapter 2\nSecond section'})]};reason='tool_calls';}
    else if(mode!=='normal'&&streams===5){delta={tool_calls:[call(0,'discover-output','search_tools',{keywords:'register_output'})]};reason='tool_calls';}
    else if(mode!=='normal'&&streams===6){delta={tool_calls:[call(0,'publish','register_output',{path:chapter,kind:'deliverable'})]};reason='tool_calls';}
    res.end('data: '+JSON.stringify({choices:[{delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:reason}]})+'\n\ndata: [DONE]\n\n');
  });
  await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
  await fs.writeFile(path.join(fixture,'config.json'),JSON.stringify({defaultProfile:'default',profiles:{default:{model:'review-fixture',apiKey:configured?'review-fixture-only':'',baseURL:'http://127.0.0.1:'+provider.address().port+'/v1'}},settings:{defaultPersona:'general',workspaceRoot:workspace,outputDir:output,departmentDataRoot:department}}));
  let product;try{product=await startProduct(fixture,token);}catch(error){provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await removeFixture(fixture);throw error;}
  const created=await api(product,token,'/sessions',{method:'POST',body:JSON.stringify({title:name})});assert.equal(created.status,200,JSON.stringify(created.body));
  return{fixture,token,session:created.body.session.id,output,source,chapter,requests,
    get product(){return product;},get streams(){return streams;},
    restart:async(crash=false)=>{const pid=product.child.pid;if(crash)await terminateProcessTreeAsync(product.child);else await stopProduct(product);product=await startProduct(fixture,token);assert.notEqual(product.child.pid,pid);},
    close:async()=>{await stopProduct(product);provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));await removeFixture(fixture);}};
}
async function postChat(s,message,key){return fetch(s.product.base+'/chat',{method:'POST',headers:{'Content-Type':'application/json','X-RainyDays-Token':s.token},body:JSON.stringify({sessionId:s.session,message,clientRequestId:key,autoApprove:true})});}

async function eventsOf(response,events=[]){
  assert.equal(response.status,200);
  let pending='';
  for await(const chunk of response.body){pending+=Buffer.from(chunk).toString('utf8');const lines=pending.split('\n');pending=lines.pop();for(const line of lines)if(line.startsWith('data: '))events.push(JSON.parse(line.slice(6)));}
  return events;
}
const history=async s=>(await api(s.product,s.token,'/sessions/'+s.session+'/messages')).body;

test('regression: a rejected preflight must not consume an idempotency key',{timeout:60000},async()=>{
  const s=await setupReviewServer('idempotency preflight',false,'normal');
  try{
    const first=await postChat(s,'One logical user message','review-retry-key');assert.equal(first.status,400);await first.text();
    const settings=(await api(s.product,s.token,'/settings')).body;
    const updated=await api(s.product,s.token,'/settings/providers/default',{method:'PUT',body:JSON.stringify({expectedRevision:settings.revision,apiKey:'review-fixture-only'})});assert.equal(updated.status,200,JSON.stringify(updated.body));
    const retried=await postChat(s,'One logical user message','review-retry-key');const reply=await retried.text();const history=await api(s.product,s.token,'/sessions/'+s.session+'/messages');
    console.log(JSON.stringify({probe:'preflight-idempotency',firstStatus:first.status,retryStatus:retried.status,userMessages:history.body.messages.filter(m=>m.role==='user').length,retryMessage:retried.status===409?JSON.parse(reply).error:undefined}));
    assert.equal(retried.status,200,'a request that failed before a run started must remain retryable');
    assert.equal(history.body.messages.filter(m=>m.role==='user').length,1);
    const replay=await postChat(s,'One logical user message','review-retry-key');assert.equal(replay.status,409);await replay.text();
    await eventsOf(await postChat(s,'One logical user message','review-new-key'));
    const concurrent=await Promise.all([postChat(s,'concurrent','review-parallel-key'),postChat(s,'concurrent','review-parallel-key')]);
    assert.deepEqual(concurrent.map(r=>r.status).sort(),[200,409]);await Promise.all(concurrent.map(r=>r.text()));
    assert.equal((await api(s.product,s.token,'/sessions/'+s.session+'/messages')).body.messages.filter(m=>m.role==='user').length,3);
  }finally{await s.close();}
});

test('regression: length stays incomplete and resumes verified chapters after a real restart',{timeout:120000},async()=>{
  const s=await setupReviewServer('length task status',true,'length');
  try{
    const response=await postChat(s,'请写报告并交付','review-length-status');assert.equal(response.status,200);const text=await response.text();
    const events=text.split('\n').filter(l=>l.startsWith('data: ')).map(l=>JSON.parse(l.slice(6)));
    const finished=events.find(e=>e.type==='run_finished');const chapter=await fs.readFile(path.join(s.output,'chapter.md'),'utf8');
    console.log(JSON.stringify({probe:'length-run-status',chapterPreserved:chapter.includes('Complete first section'),checkpointNotice:events.some(e=>/长度限制/.test(e.content||'')),outcome:finished?.outcome}));
    assert.equal(finished?.outcome,'incomplete','waiting for the user to resume is an incomplete task');
    const before=(await history(s)).checkpoint;
    assert.equal(before.state,'awaiting_resume');assert.equal(before.inputs.length,1);assert.equal(before.artifacts.length,1);
    assert.deepEqual(before.artifacts[0].savedHeadings,['# Chapter 1']);assert.equal(before.completedMutations.length,1);assert(before.nextStep);
    await s.restart();assert.equal((await history(s)).checkpoint.originRunId,before.originRunId);
    const resumed=await eventsOf(await postChat(s,'继续','review-resume-key'));
    assert(resumed.some(e=>e.type==='tool_result'&&/阻止重复执行/u.test(e.content)));
    assert(s.requests[2].messages.some(m=>/宿主任务检查点/u.test(m.content||'')));
    const complete=await fs.readFile(s.chapter,'utf8');assert.equal(complete.split('# Chapter 1').length,2);assert.equal(complete.split('# Chapter 2').length,2);
    const after=await history(s);assert.equal(after.checkpoint.state,'completed');assert.equal(after.outputs.length,1,JSON.stringify(resumed.filter(e=>e.type==='tool_result')));assert.equal(after.outputs[0].kind,'deliverable');
  }finally{await s.close();}
});

test('changed input invalidates a checkpoint before any new model or mutation call',{timeout:90000},async()=>{
  const s=await setupReviewServer('stale input',true,'length');
  try{
    await eventsOf(await postChat(s,'写报告','review-stale-01'));await s.restart();
    await fs.writeFile(s.source,'# Material\nUser changed the input');const before=s.streams;
    const events=await eventsOf(await postChat(s,'继续','review-stale-02'));
    assert.equal(s.streams,before);assert.equal(events.find(e=>e.type==='run_finished').outcome,'incomplete');
    assert(events.some(e=>/文件版本已变化/u.test(e.content||'')));
    assert.equal(await fs.readFile(s.chapter,'utf8'),'# Chapter 1\nComplete first section');
  }finally{await s.close();}
});

test('cancelled work persists a checkpoint and resumes without duplicate chapters',{timeout:120000},async()=>{
  const s=await setupReviewServer('cancel recovery',true,'hang');
  try{
    const received=[];const pending=eventsOf(await postChat(s,'写报告','review-cancel-01'),received);
    await waitFor(()=>s.streams===2&&received.some(e=>e.runId),{timeoutMs:30000,label:'saved first chapter'});
    const runId=received.find(e=>e.runId).runId;
    assert.equal((await api(s.product,s.token,'/chat/cancel',{method:'POST',body:JSON.stringify({sessionId:s.session,runId})})).status,200);
    await pending;assert.equal((await history(s)).checkpoint.reason,'cancelled');await s.restart();
    await eventsOf(await postChat(s,'继续','review-cancel-02'));
    assert.equal((await fs.readFile(s.chapter,'utf8')).split('# Chapter 2').length,2);
  }finally{await s.close();}
});

test('abrupt process death replays the last committed checkpoint',{timeout:120000},async()=>{
  const s=await setupReviewServer('crash recovery',true,'hang');
  try{
    const pending=eventsOf(await postChat(s,'写报告','review-crash-01')).catch(()=>[]);
    await waitFor(async()=>s.streams===2&&(await history(s)).checkpoint?.artifacts.length===1,{timeoutMs:30000,label:'durable boundary before crash'});
    await s.restart(true);await pending;assert.equal((await history(s)).checkpoint.state,'running');
    await eventsOf(await postChat(s,'继续','review-crash-02'));
    assert.equal((await history(s)).checkpoint.state,'completed');assert.equal((await fs.readFile(s.chapter,'utf8')).split('# Chapter 1').length,2);
  }finally{await s.close();}
});
