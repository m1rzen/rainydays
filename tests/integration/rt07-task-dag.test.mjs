import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeTempDir, projectRoot, removeFixture, runProcess, terminateProcessTreeAsync } from "../helpers.mjs";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

function parseLastJson(stdout) {
  const line = stdout.trim().split(/\r?\n/u).filter(Boolean).at(-1);
  assert(line, "RT-07 fixture output is missing");
  return JSON.parse(line);
}

function environment(fixture) {
  return {
    ...process.env,
    RAINYDAYS_APP_ROOT: projectRoot,
    RAINYDAYS_USER_DATA_DIR: fixture,
    RAINYDAYS_DATA_DIR: path.join(fixture, "data"),
    RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"),
    RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"),
  };
}

test("RT-07 runtime configuration exposes only the five-tool DAG surface and blocked UI projection", async () => {
  const toolNames = ["task_create", "task_update", "task_list", "task_get", "task_delete"];
  for (const name of ["architect", "debugger", "developer", "general", "planner", "rds-assistant"]) {
    const source = await readFile(path.join(projectRoot, "personas", `${name}.md`), "utf8");
    for (const toolName of toolNames) assert.match(source, new RegExp("^ {2}- " + toolName + "$", "mu"), `${name} lacks ${toolName}`);
    assert.doesNotMatch(source, /^ {2}- (?:create_tasks|update_task|list_tasks)$/mu, `${name} retains a legacy task alias`);
  }
  const renderer = await readFile(path.join(projectRoot, "public", "renderer.js"), "utf8");
  assert.match(renderer, /t\.status === "pending" && t\.blocked/u);
  assert.match(renderer, /t\.owner \? `\[O:\$\{escapeHtml\(t\.owner\)\}\]`/u);
  assert.match(renderer, /tasks\.every\(t => t\.status === "completed"\)/u);
  const planning = await readFile(path.join(projectRoot, "skills", "planning.md"), "utf8");
  assert.match(planning, /Task DAG 拆解（task_create \/ task_update \/ task_list）/u);
});

test("RT-07 Schema 2 migration preserves legacy tasks in the strict Schema 3 DAG", async () => {
  const fixture = await makeTempDir("mini-lux-rt07-schema-two-");
  await mkdir(path.join(fixture, "data"), { recursive: true });
  const helper = path.join(projectRoot, "scripts", "version-test-child.mjs");
  try {
    const initial = await runProcess(process.execPath, [helper, "db-version"], {
      cwd: projectRoot,
      env: environment(fixture),
      timeoutMs: 20_000,
    });
    assert.equal(initial.code, 0, initial.stderr);
    const databasePath = path.join(fixture, "data", "mini-lux.db");
    let database = new Database(databasePath);
    try {
      database.pragma("journal_mode = DELETE");
      database.pragma("foreign_keys = OFF");
      database.exec(`
        DROP INDEX idx_task_dependencies_blocker;
        DROP TABLE task_dependencies;
        DROP INDEX idx_tasks_session_status_order;
        DROP INDEX idx_tasks_session;
        ALTER TABLE tasks RENAME TO tasks_schema_three;
        CREATE TABLE tasks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL,
          parent_id INTEGER,
          subject TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          active_form TEXT,
          sort_order INTEGER DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
        DROP TABLE tasks_schema_three;
        CREATE INDEX idx_tasks_session ON tasks(session_id);
        INSERT INTO sessions(id, persona_name, title, created_at, updated_at)
          VALUES ('schema-two-session', 'general', 'Schema Two', '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z');
        INSERT INTO tasks(id, session_id, parent_id, subject, status, active_form, sort_order, created_at, updated_at)
          VALUES
            (41, 'schema-two-session', NULL, 'Legacy pending', 'pending', NULL, 0, '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z'),
            (42, 'schema-two-session', 41, 'Legacy failed', 'failed', 'legacy reason', 1, '2026-08-18T00:00:00.000Z', '2026-08-18T00:00:00.000Z');
        PRAGMA user_version = 2;
      `);
      assert.equal(database.pragma("user_version", { simple: true }), 2);
    } finally {
      database.close();
    }

    const crashed = await runProcess(process.execPath, [helper, "db-migration-crash"], {
      cwd: projectRoot,
      env: environment(fixture),
      timeoutMs: 20_000,
      onSpawn: async child => {
        await new Promise((resolve, reject) => {
          let output = "";
          const timer = setTimeout(() => reject(new Error("RT-07 migration crash barrier timed out")), 10_000);
          child.stdout.on("data", chunk => {
            output += chunk;
            if (!output.includes("MIGRATION_READY")) return;
            clearTimeout(timer);
            resolve();
          });
          child.once("exit", code => {
            clearTimeout(timer);
            reject(new Error(`RT-07 migration child exited before barrier: ${code}`));
          });
        });
        const termination = await terminateProcessTreeAsync(child);
        assert.equal(termination.childExited, true);
      },
    });
    assert.notEqual(crashed.code, 0);
    database = new Database(databasePath);
    try {
      assert.equal(database.pragma("user_version", { simple: true }), 2);
      const legacyColumns = database.prepare("PRAGMA table_info(tasks)").all().map(entry => entry.name);
      assert(legacyColumns.includes("parent_id"));
      assert(!legacyColumns.includes("task_id"));
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'task_dependencies'").get().count, 0);
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM tasks WHERE session_id = ?").get("schema-two-session").count, 2);
    } finally {
      database.close();
    }

    const migrated = await runProcess(process.execPath, [helper, "db-version"], {
      cwd: projectRoot,
      env: environment(fixture),
      timeoutMs: 20_000,
    });
    assert.equal(migrated.code, 0, migrated.stderr);
    assert.equal(parseLastJson(migrated.stdout).userVersion, 3);

    database = new Database(databasePath, { readonly: true, fileMustExist: true });
    try {
      const rows = database.prepare("SELECT task_id, status, active_form, metadata_json FROM tasks WHERE session_id = ? ORDER BY id").all("schema-two-session");
      assert.deepEqual(JSON.parse(JSON.stringify(rows)), [
        { task_id: "legacy_41", status: "pending", active_form: null, metadata_json: "{}" },
        { task_id: "legacy_42", status: "completed", active_form: "legacy reason", metadata_json: '{"legacyStatus":"failed","legacyParentId":41}' },
      ]);
      assert(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_dependencies'").get());
      assert.equal(database.prepare("SELECT COUNT(*) AS count FROM task_dependencies").get().count, 0);
      assert.equal(database.pragma("foreign_key_check").length, 0);
    } finally {
      database.close();
    }
  } finally {
    await removeFixture(fixture);
  }
});

test("RT-07 Agent resumes a persisted DAG and suppresses success events for blocked mutations", async () => {
  const fixture = await makeTempDir("mini-lux-rt07-agent-");
  await mkdir(path.join(fixture, "data"), { recursive: true });
  const child = path.join(projectRoot, "tests", "fixtures", "rt07-task-dag-child.mjs");
  try {
    const result = await runProcess(process.execPath, [child, "agent"], {
      cwd: projectRoot,
      env: environment(fixture),
      timeoutMs: 20_000,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(parseLastJson(result.stdout), {
      resumedPersistedDag: true,
      selectedTask: "root",
      blockedFailureEventSuppressed: true,
    });
  } finally {
    await removeFixture(fixture);
  }
});

test("RT-07 five-tool surface is Session-scoped and projects blocked and owner state", async () => {
  const fixture = await makeTempDir("mini-lux-rt07-tools-");
  await mkdir(path.join(fixture, "data"), { recursive: true });
  const child = path.join(projectRoot, "tests", "fixtures", "rt07-task-dag-child.mjs");
  try {
    const result = await runProcess(process.execPath, [child, "tools"], {
      cwd: projectRoot,
      env: environment(fixture),
      timeoutMs: 20_000,
    });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(parseLastJson(result.stdout), {
      names: ["task_create", "task_update", "task_list", "task_get", "task_delete"],
      sessionScopedClear: true,
      blockedProjection: true,
    });
  } finally {
    await removeFixture(fixture);
  }
});

test("RT-07 Task DAG is atomic, Session-scoped, fork-safe, and restart-persistent", async () => {
  const fixture = await makeTempDir("mini-lux-rt07-task-dag-");
  await mkdir(path.join(fixture, "data"), { recursive: true });
  const child = path.join(projectRoot, "tests", "fixtures", "rt07-task-dag-child.mjs");
  try {
    const seeded = await runProcess(process.execPath, [child, "seed"], {
      cwd: projectRoot,
      env: environment(fixture),
      timeoutMs: 20_000,
    });
    assert.equal(seeded.code, 0, seeded.stderr);
    const identity = parseLastJson(seeded.stdout);
    assert.deepEqual(identity.source.map(entry => entry.id), ["setup", "release"]);
    assert.deepEqual(identity.isolated.map(entry => entry.id), ["setup"]);
    assert.deepEqual(identity.fork.map(entry => entry.id), ["setup", "build", "release"]);

    const verified = await runProcess(process.execPath, [child, "verify"], {
      cwd: projectRoot,
      env: {
        ...environment(fixture),
        RT07_SOURCE_ID: identity.sourceId,
        RT07_ISOLATED_ID: identity.isolatedId,
        RT07_FORK_ID: identity.forkId,
      },
      timeoutMs: 20_000,
    });
    assert.equal(verified.code, 0, verified.stderr);
    const persisted = parseLastJson(verified.stdout);
    assert.equal(persisted.schemaVersion, 3);
    assert.deepEqual(persisted.fork.find(entry => entry.id === "build").metadata, { verified: true });
    assert.equal(persisted.fork.find(entry => entry.id === "build").owner, "worker-b");
  } finally {
    await removeFixture(fixture);
  }
});
