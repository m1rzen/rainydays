import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import Database from "better-sqlite3";

test("history recovery appends missing sessions and attachments, preserves new history and is repeatable", { timeout: 60_000 }, async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "rainydays-history-recovery-"));
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const source = path.join(fixture, "source"), target = path.join(fixture, "target");
  let db;
  try {
    for (const dir of [source, target]) await fs.mkdir(path.join(dir, "data"), { recursive: true });
    Object.assign(process.env, { RAINYDAYS_APP_ROOT: root, RAINYDAYS_USER_DATA_DIR: source, RAINYDAYS_DATA_DIR: path.join(source, "data") });
    db = await import("../../src/db.ts");
    const session = await import("../../src/session.ts");
    const { listPersonas } = await import("../../src/persona.ts");
    const persona = (await listPersonas()).find(p => p.name === "general"); assert(persona);
    const common = session.createSession(persona, "共同保留");
    const addMessage = (id, content) => db.insertMessage({ session_id:id, role:"user",content,tool_calls:null,tool_call_id:null,created_at:new Date().toISOString() });
    addMessage(common.id, "共同消息");
    const targetPath = path.join(target, "data", "mini-lux.db");
    const snapshot = await db.createConsistentDatabaseSnapshot(); await fs.writeFile(targetPath, snapshot.bytes);
    const missing = session.createSession(persona, "待恢复");
    const messageId = addMessage(missing.id, "迁出前的消息"); session.createSession(persona, "空会话也要恢复");
    for (const name of ["甲.txt", "乙.txt", "丙.txt"]) {
      const content=Buffer.from(`附件 ${name}`);
      db.insertImportedAttachment({sessionId:missing.id,messageId,state:"ready",kind:"text",name,mime:"text/plain",size:content.length,sha256:createHash("sha256").update(content).digest("hex"),content,errorCode:null,createdAt:1,updatedAt:1});
    }
    await db.closeDb(); db=null;
    const existing=new Database(targetPath);const newId=randomUUID();const now=new Date().toISOString();
    existing.prepare("INSERT INTO sessions(id,persona_name,title,created_at,updated_at) VALUES (?,?,?,?,?)").run(newId,"general","当前的新会话",now,now);
    existing.prepare("INSERT INTO messages(session_id,role,content,tool_calls,tool_call_id,created_at) VALUES (?,?,?,?,?,?)").run(newId,"user","恢复后新增，不得覆盖",null,null,now);existing.close();
    const cli=(apply=false)=>{
      const result=spawnSync(process.execPath,["--import","tsx",path.join(root,"scripts/recover-session-history.mjs"),"--source",path.join(source,"data","mini-lux.db"),"--user-data",target,...(apply?["--apply"]:[])],{cwd:root,encoding:"utf8",timeout:30_000,windowsHide:true});
      assert.equal(result.status,0,`${result.stdout}\n${result.stderr}`);return JSON.parse(result.stdout.trim().split(/\r?\n/u).at(-1));
    };
    const before=await fs.readFile(targetPath);assert.equal(cli().missingSessions,2);assert.deepEqual(await fs.readFile(targetPath),before);
    const result=cli(true);assert.equal(result.restoredSessions,2);assert.equal(result.restoredMessages,1);assert.equal(result.restoredAttachments,3);
    const recovered=new Database(targetPath,{readonly:true});
    try {
      assert.equal(recovered.prepare("SELECT content FROM messages WHERE session_id=?").get(newId).content,"恢复后新增，不得覆盖");
      assert.equal(recovered.prepare("SELECT COUNT(*) AS n FROM sessions").get().n,4);
      assert.equal(recovered.prepare("SELECT COUNT(*) AS n FROM attachments").get().n,3);
      assert.equal(recovered.pragma("foreign_key_check").length,0);
    }finally{recovered.close();}
    assert.equal(cli(true).restoredSessions,0);
  } finally {
    await db?.closeDb();
    assert.equal(path.dirname(fixture),path.resolve(os.tmpdir()));assert(path.basename(fixture).startsWith("rainydays-history-recovery-"));await fs.rm(fixture,{recursive:true,force:true});
  }
});
