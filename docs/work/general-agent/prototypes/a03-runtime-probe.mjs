// Disposable A03 experiment: qualify CLI runtime dependencies inside an owned test project.
// Not a production runtime installer; no user projects, keys or network are used.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const root=await fs.mkdtemp(path.join(os.tmpdir(),"rainydays-a03-runtime-")),workspace=path.join(root,"project"),project=path.resolve(import.meta.dirname,"../../../..");
await fs.mkdir(workspace);
Object.assign(process.env,{RAINYDAYS_APP_ROOT:project,RAINYDAYS_USER_DATA_DIR:root,RAINYDAYS_DATA_DIR:path.join(root,"data"),RAINYDAYS_CONFIG_PATH:path.join(root,"config.json"),RAINYDAYS_BUILTIN_PERSONAS_DIR:path.join(project,"personas"),RAINYDAYS_BUILTIN_SKILLS_DIR:path.join(project,"skills")});
const load=name=>import(pathToFileURL(path.join(project,"dist",name+".js")));
const credentials=await load("credential-store");credentials.configureCredentialProtector({protect:value=>Buffer.from(value),unprotect:value=>Buffer.from(value).toString()});
const config=await load("config"),personas=await load("persona"),sessions=await load("session"),db=await load("db"),tools=await load("tools/index"),{pathPolicy}=await load("path-runtime"),execution=await load("execution-runtime");
let authority,context;
try{
  await fs.copyFile(process.execPath,path.join(workspace,"node.exe"));
  const pythonSource="C:\\Python314",python=path.join(workspace,"python");await fs.mkdir(python);
  for(const name of ["python.exe","python314.dll","python3.dll"]){await fs.copyFile(path.join(pythonSource,name),path.join(python,name));}
  for(const name of ["vcruntime140.dll","vcruntime140_1.dll"]){try{await fs.copyFile(path.join(pythonSource,name),path.join(python,name));}catch(error){if(error.code!=="ENOENT")throw error;}}
  await fs.cp(path.join(pythonSource,"DLLs"),path.join(python,"DLLs"),{recursive:true,filter:source=>!source.toLowerCase().includes("__pycache__")});
  const packageCode="import os,sys,zipfile\nsource=os.path.join(sys.argv[1],'Lib')\nwith zipfile.ZipFile(sys.argv[2],'w',compression=zipfile.ZIP_STORED) as bundle:\n for folder,dirs,files in os.walk(source):\n  dirs[:]=[name for name in dirs if name not in ('site-packages','__pycache__','test','tests','idlelib','tkinter','turtledemo','ensurepip')]\n  for name in files:\n   if name.endswith('.py'): bundle.write(os.path.join(folder,name),os.path.relpath(os.path.join(folder,name),source))\n";
  execFileSync(path.join(pythonSource,"python.exe"),["-I","-c",packageCode,pythonSource,path.join(python,"python314.zip")],{windowsHide:true,timeout:30000,stdio:"pipe"});
  await fs.writeFile(path.join(python,"python314._pth"),"python314.zip\nDLLs\n.\n..\n");
  await fs.cp(path.join(pythonSource,"Lib","encodings"),path.join(python,"Lib","encodings"),{recursive:true,filter:source=>!source.toLowerCase().includes("__pycache__")});
  await fs.writeFile(path.join(python,"python314._pth"),"Lib\npython314.zip\nDLLs\n.\n..\n");
  const pythonControl=spawnSync(path.join(python,"python.exe"),["-I","-c","import sys; print(sys.path); import unittest; print('PYTHON_IMPORT_OK')"],{cwd:workspace,windowsHide:true,encoding:"utf8",timeout:10000});
  console.log(JSON.stringify({stage:"python-outside-container-control",result:{exitCode:pythonControl.status,stdout:pythonControl.stdout?.slice(-1200),stderr:pythonControl.stderr?.slice(-1200)}}));
  await fs.writeFile(path.join(workspace,"calc.mjs"),"export const add=(a,b)=>a-b;\n");
  await fs.writeFile(path.join(workspace,"calc.test.mjs"),"import assert from 'node:assert/strict';import{add}from'./calc.mjs';assert.equal(add(3,5),8);console.log('A03_NODE_CHECK_PASSED');\n");
  await fs.writeFile(path.join(workspace,"calc.py"),"def add(a,b): return a-b\n");
  await fs.writeFile(path.join(workspace,"test_calc.py"),"import unittest\nfrom calc import add\nclass Calc(unittest.TestCase):\n def test_add(self): self.assertEqual(add(3,5),8)\nif __name__=='__main__': unittest.main()\n");
  await config.initializeConfig();
  const persona=personas.createEffectivePersona({name:"a03-cli",displayName:"A03",description:"fixture",tools:["execute_command"],env:{WORKSPACE_ROOT:workspace},allowedRoots:[workspace],networkPolicy:{mode:"unrestricted"},systemPrompt:"fixture"});
  authority=tools.capabilityBroker.createRuntimeAuthority({...persona,rootEnv:{WORKSPACE_ROOT:"workspace"},pathAuthority:await pathPolicy.createAuthority([{rootId:"workspace",role:"workspace",configuredPath:workspace,permissions:["initial-cwd"]}])});
  context=tools.capabilityBroker.beginAgentRun(authority,sessions.createSession(persona,"A03 runtimes").id);
  const invoke=async command=>{const inspected=tools.inspectToolCall(context,"execute_command",{command}),challenge=tools.capabilityBroker.createApprovalChallenge(context,inspected),grant=tools.capabilityBroker.resolveApprovalChallenge({challengeId:challenge.challengeId,choice:"approve",sessionId:context.sessionId,runId:context.runId,responsePrincipal:"local-user-api",responseChannel:"native-process"});assert(grant);try{return await tools.executeInspectedTool(grant,inspected);}finally{tools.capabilityBroker.finishContext(grant);}};
  const nodeCommand='call "'+path.join(workspace,"node.exe")+'" --preserve-symlinks --preserve-symlinks-main --test --test-isolation=none calc.test.mjs';
  const pythonCommand='call "'+path.join(python,"python.exe")+'" -I -m unittest discover -s . -p test_calc.py -v';
  const results={};
  for(const [name,command]of [["node-version",'call "'+path.join(workspace,"node.exe")+'" --version'],["python-version",'call "'+path.join(python,"python.exe")+'" --version']]){
    try{const output=await invoke(command);results[name]={exitCode:0,output};}catch(error){results[name]={code:error.code,message:error.message};}
    console.log(JSON.stringify({stage:name,result:results[name]}));
  }
  for(const [name,command,target,fixed]of [["node",nodeCommand,"calc.mjs","export const add=(a,b)=>a+b;\n"],["python",pythonCommand,"calc.py","def add(a,b): return a+b\n"]]){
    let red="",green="",error="",redCode;try{await invoke(command);}catch(caught){red=caught.message;redCode=caught.code;}
    await fs.writeFile(path.join(workspace,target),fixed);try{green=await invoke(command);}catch(caught){error=caught.message;}
    results[name]={realAssertion:/ERR_ASSERTION|AssertionError/u.test(red),correctedPass:!!green && (name==='node'?green.includes('A03_NODE_CHECK_PASSED'):/Ran 1 test|\bOK\b/u.test(green)),redCode,red:red.slice(-1100),green:green.slice(-1100),error:error.slice(-1600)};
    console.log(JSON.stringify({stage:name,result:results[name]}));
  }
  console.log(JSON.stringify(results,null,2));
}finally{
  if(context)tools.capabilityBroker.finishContext(context);if(authority)await tools.capabilityBroker.retireAuthority(authority);await execution.shutdownExecutionRuntime();await db.closeDb();
  assert.equal(path.dirname(root),path.resolve(os.tmpdir()));assert(path.basename(root).startsWith("rainydays-a03-runtime-"));await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});
}
