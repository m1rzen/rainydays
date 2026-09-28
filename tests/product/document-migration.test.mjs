import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";
import test from "node:test";

test("Schema 11 附件升级到 12，消息、字节、索引与再次启动保持一致", async () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const fixture = await mkdtemp(path.join(os.tmpdir(), "rainydays-r2-migration-"));
  const data = path.join(fixture, "data"); await mkdir(data);
  const env = { ...process.env, RAINYDAYS_APP_ROOT: root, RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: data };
  const run = source => execFileSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", source], { cwd: root, env, windowsHide: true, stdio: "pipe" });
  try {
    run(`const db = await import('./src/db.ts'); const store = await import('./src/attachment-store.ts');
      db.insertSession({ id:'legacy', persona_name:'fixture', title:'旧会话', created_at:'2026-09-28', updated_at:'2026-09-28' });
      const bytes = Buffer.from('旧附件内容'); const draft = store.reserveAttachment('legacy', {name:'旧资料.txt',mime:'text/plain',size:bytes.length});
      const attachment = store.completeAttachment('legacy',draft.id,bytes);
      const { ConversationMemory } = await import('./src/memory.ts'); const memory = new ConversationMemory(); memory.setSessionId('legacy');
      memory.add({ role:'user', content:'读取旧资料', attachments:[attachment] }); db.closeDb();`);
    // Runtime database filename is part of the existing bootstrap layout.
    const { readdir } = await import("node:fs/promises");
    const dbName = (await readdir(data)).find(name => name.endsWith(".db"));
    assert(dbName);
    const dbPath = path.join(data, dbName);
    const database = new Database(dbPath);
    const before = database.prepare("SELECT * FROM attachments").all();
    const table = database.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='attachments'").get().sql;
    const objects = database.prepare("SELECT sql FROM sqlite_master WHERE tbl_name='attachments' AND type IN ('index','trigger') AND sql IS NOT NULL").all();
    const oldTable = table.replace(", 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'", "");
    database.transaction(() => {
      database.exec("CREATE TEMP TABLE old_attachments AS SELECT * FROM attachments; DROP TABLE attachments;");
      database.exec(oldTable);
      for (const { sql } of objects) database.exec(sql);
      database.exec("INSERT INTO attachments SELECT * FROM old_attachments; DROP TABLE old_attachments; PRAGMA user_version=11;");
    })();
    database.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      run("const db = await import('./src/db.ts'); db.closeDb();");
      const upgraded = new Database(dbPath, { readonly: true });
      try {
        assert.equal(upgraded.pragma("user_version", { simple: true }), 12);
        assert.deepEqual(upgraded.prepare("SELECT * FROM attachments").all(), before);
        assert.equal(upgraded.prepare("SELECT title FROM sessions WHERE id='legacy'").get().title, "旧会话");
        assert.equal(upgraded.prepare("SELECT content FROM messages WHERE session_id='legacy'").get().content, "读取旧资料");
        assert.deepEqual(upgraded.pragma("foreign_key_check"), []);
      } finally { upgraded.close(); }
    }
  } finally {
    assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
    assert(path.basename(fixture).startsWith("rainydays-r2-migration-"));
    await rm(fixture, { recursive: true, force: true });
  }
});
