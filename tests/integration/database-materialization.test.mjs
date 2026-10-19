import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { makeTempDir, projectRoot, removeFixture } from "../helpers.mjs";

test("D13 materialized SQL rows are snapshots; database handles and live iterators still expire", async () => {
  const fixture = await makeTempDir("rainydays-d13-data-");
  process.env.RAINYDAYS_APP_ROOT = projectRoot;
  process.env.RAINYDAYS_USER_DATA_DIR = fixture;
  process.env.RAINYDAYS_DATA_DIR = path.join(fixture, "data");
  const { openBootstrapDatabase } = await import("../../dist/bootstrap-database.js");
  const connection = await openBootstrapDatabase(12);
  const database = connection.database;
  let closed = false;
  const originalLstat = fs.lstatSync;
  try {
    database.exec("CREATE TABLE sample(value INTEGER); WITH RECURSIVE n(value) AS (SELECT 1 UNION ALL SELECT value+1 FROM n WHERE value<200) INSERT INTO sample SELECT value FROM n;");
    const statement = database.prepare("SELECT value FROM sample ORDER BY value");
    const rows = statement.all();
    let metadataReads = 0;
    fs.lstatSync = (...args) => { metadataReads++; return originalLstat(...args); };
    const started = performance.now();
    let total = 0; for (const row of rows) total += row.value;
    const elapsedMs = performance.now() - started;
    fs.lstatSync = originalLstat;
    console.log(`[D13] materialized 200 rows: ${metadataReads} extra metadata reads, ${elapsedMs.toFixed(1)}ms`);
    assert.equal(total, 20100);
    assert.equal(metadataReads, 0, "consuming rows already returned by SQLite must not perform filesystem I/O");
    const iterator = statement.iterate();
    assert.equal(iterator.next().value.value, 1);
    iterator.return();
    await connection.close(); closed = true;
    assert.equal(rows.map(row => row.value).reduce((sum, value) => sum + value, 0), 20100);
    assert.throws(() => statement.get(), error => error.code === "PATH_AUTHORITY_STALE");
    assert.throws(() => iterator.next(), error => error.code === "PATH_AUTHORITY_STALE");
  } finally {
    fs.lstatSync = originalLstat;
    if (!closed) await connection.close();
    await removeFixture(fixture);
  }
});
