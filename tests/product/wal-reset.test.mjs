import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";

test("SQLite reset WAL retains committed data and ignores checkpointed frames from the previous generation", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "rainydays-wal-reset-"));
  let connection, store;
  try {
    const writerPath = path.join(fixture, "writer.db");
    const writer = new Database(writerPath);
    const data = path.join(fixture, "data"); await fs.mkdir(data);
    try {
      writer.pragma("journal_mode=WAL"); writer.pragma("wal_autocheckpoint=0");
      writer.exec("CREATE TABLE sample(value TEXT); PRAGMA user_version=12");
      writer.transaction(() => { for (let i = 0; i < 50; i++) writer.prepare("INSERT INTO sample VALUES (?)").run("x".repeat(2000)); })();
      writer.pragma("wal_checkpoint(RESTART)");
      writer.prepare("UPDATE sample SET value=? WHERE rowid=1").run("latest committed value");
      const wal = await fs.readFile(`${writerPath}-wal`);
      const frame = 24 + wal.readUInt32BE(8);
      let oldTail = false;
      for (let pos = 32; pos < wal.length; pos += frame) if (wal.readUInt32BE(pos + 8) !== wal.readUInt32BE(16)) oldTail = true;
      assert(oldTail, "fixture must contain a real SQLite reset tail");
      for (const suffix of ["", "-wal", "-shm"]) await fs.copyFile(writerPath + suffix, path.join(data, "mini-lux.db") + suffix);
    } finally { writer.close(); }
    Object.assign(process.env, { RAINYDAYS_APP_ROOT: fileURLToPath(new URL("../../", import.meta.url)), RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: data });
    const { openBootstrapDatabase } = await import("../../src/bootstrap-database.ts");
    const { getBootstrapPathStore } = await import("../../src/bootstrap-path-store.ts"); store = getBootstrapPathStore();
    connection = await openBootstrapDatabase(12);
    assert.equal(connection.probedVersion, 12);
    assert.equal(connection.database.prepare("SELECT value FROM sample WHERE rowid=1").get().value, "latest committed value");
    assert.equal(connection.database.prepare("SELECT COUNT(*) AS n FROM sample").get().n, 50);
  } finally {
    await connection?.close(); await store?.close();
    assert.equal(path.dirname(fixture), path.resolve(os.tmpdir())); assert(path.basename(fixture).startsWith("rainydays-wal-reset-"));
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
