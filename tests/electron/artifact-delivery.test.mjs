import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  boundedFetch, connectCdp, freeDistinctPorts, makeTempDir, projectRoot,
  removeFixture, spawnManaged, terminateProcessTreeAsync, waitFor,
} from "../helpers.mjs";

test("registered file roles and incomplete recovery are correct in the real desktop", { timeout: 120_000 }, async () => {
  const fixture = await makeTempDir("rainydays-gcable-desktop-");
  const userData = path.join(fixture, "user-data");
  let child, client, provider;
  let logs = "";
  try {
    const [httpPort, cdpPort] = await freeDistinctPorts(2);
    const settings = { workspaceRoot: path.join(userData, "workspace"), departmentDataRoot: path.join(userData, "department"), outputDir: path.join(userData, "output") };
    await Promise.all(Object.values(settings).map(directory => mkdir(directory, { recursive: true })));

    const files=[{name:'source.pdf',kind:'source',bytes:Buffer.from('%PDF-1.4\n% source')},{name:'result.mp4',kind:'deliverable',bytes:Buffer.from('000000186674797069736f6d00000200','hex')},{name:'工作.md',kind:'intermediate',bytes:Buffer.from('# 成果\n' + '汉'.repeat(1800) + '\n预览末行')}];
    await Promise.all(files.map(file=>writeFile(path.join(settings.outputDir,file.name),file.bytes)));
    let streams=0;
    provider=createServer(async(req,res)=>{
      const chunks=[];for await(const chunk of req)chunks.push(chunk);const body=JSON.parse(Buffer.concat(chunks).toString());
      if(!body.stream){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({choices:[{message:{role:'assistant',content:'文件登记'},finish_reason:'stop'}]}));return;}
      streams++;res.writeHead(200,{'Content-Type':'text/event-stream'});
      const call=(index,id,name,args)=>({index,id,type:'function',function:{name,arguments:JSON.stringify(args)}});
      const delta=streams===1?{tool_calls:[call(0,'discover','search_tools',{keywords:'register_output'})]}:streams===2?{tool_calls:files.map((f,i)=>call(i,'register-'+i,'register_output',{path:path.join(settings.outputDir,f.name),kind:f.kind}))}:{content:'下一部分仍待完成'};
      const finish=streams<=2?'tool_calls':'length';
      res.end('data: '+JSON.stringify({choices:[{delta,finish_reason:null}]})+'\n\ndata: '+JSON.stringify({choices:[{delta:{},finish_reason:finish}]})+'\n\ndata: [DONE]\n\n');
    });
    await new Promise(resolve=>provider.listen(0,'127.0.0.1',resolve));
    await writeFile(path.join(userData,'config.json'),JSON.stringify({defaultProfile:'company',profiles:{company:{model:'ui-fixture',apiKey:'ui-fixture-only',baseURL:'http://127.0.0.1:'+provider.address().port+'/v1'}},settings:{...settings,defaultPersona:'general'}}));
    const env = { ...process.env, npm_node_execpath: process.execPath, PORT: String(httpPort), RAINYDAYS_ALLOW_LOOPBACK_HTTP_PROVIDER: "1" };
    delete env.RAINYDAYS_E2E_USE_DIST; delete env.RAINYDAYS_E2E_NODE_EXECUTABLE; delete env.ELECTRON_RUN_AS_NODE;
    child = spawnManaged(path.join(projectRoot, "node_modules", "electron", "dist", "electron.exe"), [projectRoot, `--user-data-dir=${userData}`, `--remote-debugging-port=${cdpPort}`, "--disable-gpu"], { env });
    for (const stream of [child.stdout, child.stderr]) {
      stream.setEncoding("utf8"); stream.on("data", chunk => { logs = (logs + chunk).slice(-20_000); });
    }
    await waitFor(async () => {
      if (child.exitCode !== null) throw new Error(`Desktop exited: ${logs}`);
      try { return (await boundedFetch(`http://127.0.0.1:${httpPort}/`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
    }, { timeoutMs: 45_000, label: "Gcable desktop service" });
    client = await connectCdp(cdpPort);
    await waitFor(() => client.evaluate("typeof openSettings === 'function' && Boolean(currentSessionId)"), { label: "Gcable desktop renderer" });


    const session=await client.evaluate('currentSessionId');
    await client.evaluate('inputEl.focus()');
    await client.send('Input.insertText',{text:'登记已有文件并交付'});
    await client.send('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await client.send('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await waitFor(()=>client.evaluate('document.querySelectorAll("#document-output-list .document-output-row").length===3 && !isSessionRunning(currentSessionId)'),{timeoutMs:45000,label:'normal UI to API to persisted output list'});
    const rows=await client.evaluate('Array.from(document.querySelectorAll("#document-output-list .document-output-row"),e=>({name:e.querySelector("a").textContent,kind:e.dataset.artifactKind,meta:e.querySelector(".document-output-meta").textContent}))');
    assert.match(rows.find(r=>r.name==='source.pdf').meta,/PDF.*原始资料/u);
    assert.match(rows.find(r=>r.name==='result.mp4').meta,/MP4.*交付件/u);
    assert.match(rows.find(r=>r.name==='工作.md').meta,/Markdown.*中间产物/u);
    assert.equal(rows.some(r=>r.meta.includes('Excel')),false);
    assert(await client.evaluate('Array.from(document.querySelectorAll(".run-status-note")).some(e=>e.textContent.includes("任务尚未完成"))'));
    await client.send('Page.reload',{ignoreCache:true});
    await waitFor(()=>client.evaluate('typeof currentSessionId!=="undefined" && currentSessionId==='+JSON.stringify(session)+' && Boolean(document.getElementById("checkpoint-notice"))'),{timeoutMs:30000,label:'persisted checkpoint shown after reload'});
    await client.evaluate('if(!document.getElementById("document-outputs").open)document.querySelector("#document-outputs > summary").click()');
    for(const width of [1440,900]){
      await client.send('Emulation.setDeviceMetricsOverride',{width,height:1000,deviceScaleFactor:1,mobile:false});
      await client.evaluate('new Promise(resolve=>requestAnimationFrame(()=>{document.getElementById("document-outputs").scrollIntoView({block:"center"});requestAnimationFrame(resolve)}))');
      assert(await client.evaluate('Array.from(document.querySelectorAll("#document-output-list .document-output-row")).every(e=>e.getBoundingClientRect().height>0)'));
      if(process.env.RAINYDAYS_QA_NO_SCREENSHOTS!=='1'){
        const screenshot=await client.send('Page.captureScreenshot',{format:'png'});
        await writeFile(path.join(projectRoot,'test-results/glm-fix-artifact-'+width+'.png'),Buffer.from(screenshot.data,'base64'));
      }
    }
    await client.evaluate('Array.from(document.querySelectorAll(".document-output-row")).find(e=>e.querySelector("a").textContent==="工作.md").querySelector("button").click()');
    await waitFor(()=>client.evaluate('document.getElementById("file-preview-content").textContent.includes("预览末行")'),{timeoutMs:20000,label:'open registered Markdown in real preview'});
    console.log(JSON.stringify({rows,persistedCheckpoint:true,normalUserFlow:true}));
  } finally {
    client?.close();if(child)await terminateProcessTreeAsync(child);
    if(provider){provider.closeAllConnections();await new Promise(resolve=>provider.close(resolve));}
    await removeFixture(fixture);
  }
});
