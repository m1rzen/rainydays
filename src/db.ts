// ===========================================
// 数据库层 —— SQLite 持久化存储
// 存储：会话(sessions) + 消息(messages) + 记忆(memories)
// ===========================================

import fs from "node:fs";
import { getBootstrapPathStore } from "./bootstrap-path-store.js";
import { createInMemoryBootstrapDatabase, openBootstrapDatabase, validateDatabaseSnapshotFile, writeConsistentDatabaseSnapshot, type DatabaseSnapshotValidation } from "./bootstrap-database.js";
import { verifySecurityAuditChain, verifySecurityAuditCheckpoint, type SecurityAuditCheckpoint, type SecurityAuditEvent } from "./security-audit.js";
import { DATABASE_SCHEMA_VERSION } from "./version.js";

/** 仅在受管bootstrap identity与只读兼容探测通过后建立可写连接。 */
const persistentConnection = await openBootstrapDatabase(DATABASE_SCHEMA_VERSION);
const db = persistentConnection.database;

// ===========================================
// 数据库版本与迁移
// ===========================================

const SCHEMA_V2_OBJECT_NAMES = Object.freeze(new Set([
  "security_audit_state",
  "security_audit_state_no_update",
  "security_audit_state_no_delete",
  "security_audit_head",
  "security_audit_head_no_delete",
  "security_audit_events",
  "idx_security_audit_request",
  "idx_security_audit_session",
  "idx_security_audit_run",
  "security_audit_events_no_update",
  "security_audit_events_no_delete",
]));

const SCHEMA_V2_SQL = `
    CREATE TABLE security_audit_state (
      singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version  INTEGER NOT NULL CHECK (schema_version = 1),
      algorithm       TEXT NOT NULL CHECK (algorithm = 'electron-safe-storage'),
      scope           TEXT NOT NULL CHECK (scope = 'windows-dpapi-current-user-v1'),
      wrapped_key     BLOB NOT NULL CHECK (length(wrapped_key) BETWEEN 1 AND 65536),
      created_at      TEXT NOT NULL
    );
    CREATE TRIGGER security_audit_state_no_update
      BEFORE UPDATE ON security_audit_state
      BEGIN SELECT RAISE(ABORT, 'security audit state is immutable'); END;
    CREATE TRIGGER security_audit_state_no_delete
      BEFORE DELETE ON security_audit_state
      BEGIN SELECT RAISE(ABORT, 'security audit state is immutable'); END;
    CREATE TABLE security_audit_head (
      singleton       INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version  INTEGER NOT NULL CHECK (schema_version = 1),
      event_count     INTEGER NOT NULL CHECK (event_count >= 0),
      head_hash       TEXT NOT NULL CHECK (length(head_hash) IN (64, 76)),
      checkpoint_mac  TEXT NOT NULL CHECK (length(checkpoint_mac) = 76)
    );
    CREATE TRIGGER security_audit_head_no_delete
      BEFORE DELETE ON security_audit_head
      BEGIN SELECT RAISE(ABORT, 'security audit head cannot be deleted'); END;
    CREATE TABLE security_audit_events (
      sequence             INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id             TEXT NOT NULL UNIQUE,
      recorded_at          TEXT NOT NULL,
      phase                TEXT NOT NULL CHECK (phase IN ('request', 'authorization', 'execution', 'result')),
      session_id           TEXT,
      run_id               TEXT NOT NULL,
      request_id           TEXT NOT NULL,
      parent_request_id    TEXT,
      tool_call_id         TEXT,
      context_id           TEXT,
      execution_id         TEXT,
      principal            TEXT NOT NULL CHECK (principal IN ('agent', 'subagent', 'playbook', 'local-user-api', 'system')),
      operation_kind       TEXT NOT NULL CHECK (operation_kind IN ('tool', 'api', 'terminal', 'native', 'system')),
      operation_name       TEXT NOT NULL,
      outcome              TEXT NOT NULL,
      code                 TEXT,
      request_commitment   TEXT NOT NULL,
      safe_payload         TEXT NOT NULL,
      previous_event_hash  TEXT NOT NULL,
      event_hash           TEXT NOT NULL UNIQUE,
      UNIQUE (request_id, phase)
    );
    CREATE INDEX idx_security_audit_request ON security_audit_events(request_id, sequence);
    CREATE INDEX idx_security_audit_session ON security_audit_events(session_id, sequence);
    CREATE INDEX idx_security_audit_run ON security_audit_events(run_id, sequence);
    CREATE TRIGGER security_audit_events_no_update
      BEFORE UPDATE ON security_audit_events
      BEGIN SELECT RAISE(ABORT, 'security audit events are append-only'); END;
    CREATE TRIGGER security_audit_events_no_delete
      BEFORE DELETE ON security_audit_events
      BEGIN SELECT RAISE(ABORT, 'security audit events are append-only'); END;
  `;

function applySchemaV3(database: typeof db): void {
  database.exec(`
    ALTER TABLE tasks RENAME TO tasks_v2_legacy;
    CREATE TABLE tasks (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL,
      task_id       TEXT NOT NULL CHECK (
        length(task_id) BETWEEN 1 AND 64
        AND instr(task_id, char(0)) = 0
        AND substr(task_id, 1, 1) GLOB '[a-z0-9]'
        AND task_id NOT GLOB '*[^a-z0-9_-]*'
      ),
      subject       TEXT NOT NULL,
      description   TEXT,
      status        TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed')),
      active_form   TEXT,
      owner         TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json) AND json_type(metadata_json) = 'object' AND length(metadata_json) <= 65536),
      sort_order    INTEGER NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
      created_at    TEXT NOT NULL,
      updated_at    TEXT NOT NULL,
      UNIQUE (session_id, task_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    INSERT INTO tasks (
      id, session_id, task_id, subject, description, status, active_form, owner,
      metadata_json, sort_order, created_at, updated_at
    )
    SELECT
      id,
      session_id,
      'legacy_' || id,
      subject,
      NULL,
      CASE status WHEN 'in_progress' THEN 'in_progress' WHEN 'completed' THEN 'completed' WHEN 'failed' THEN 'completed' ELSE 'pending' END,
      active_form,
      NULL,
      json_patch(
        CASE WHEN status IN ('pending', 'in_progress', 'completed') THEN '{}' ELSE json_object('legacyStatus', status) END,
        CASE WHEN parent_id IS NULL THEN '{}' ELSE json_object('legacyParentId', parent_id) END
      ),
      CASE WHEN sort_order >= 0 THEN sort_order ELSE 0 END,
      created_at,
      updated_at
    FROM tasks_v2_legacy
    ORDER BY id;
    DROP TABLE tasks_v2_legacy;
    CREATE INDEX idx_tasks_session ON tasks(session_id);
    CREATE INDEX idx_tasks_session_status_order ON tasks(session_id, status, sort_order, id);
    CREATE TABLE task_dependencies (
      session_id TEXT NOT NULL,
      task_id    TEXT NOT NULL,
      blocker_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (session_id, task_id, blocker_id),
      CHECK (task_id <> blocker_id),
      FOREIGN KEY (session_id, task_id) REFERENCES tasks(session_id, task_id) ON DELETE CASCADE,
      FOREIGN KEY (session_id, blocker_id) REFERENCES tasks(session_id, task_id) ON DELETE CASCADE
    );
    CREATE INDEX idx_task_dependencies_blocker ON task_dependencies(session_id, blocker_id, task_id);
  `);
}

const SCHEMA_V1_SQL = `
    CREATE TABLE IF NOT EXISTS sessions (
      id           TEXT PRIMARY KEY,
      persona_name TEXT NOT NULL,
      title        TEXT NOT NULL DEFAULT '新对话',
      created_at   TEXT NOT NULL,
      updated_at   TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id    TEXT NOT NULL,
      role          TEXT NOT NULL,
      content       TEXT NOT NULL DEFAULT '',
      tool_calls    TEXT,
      tool_call_id  TEXT,
      created_at    TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

    CREATE TABLE IF NOT EXISTS memories (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      content    TEXT NOT NULL,
      kind       TEXT NOT NULL DEFAULT 'observation',
      tags       TEXT,
      created_at TEXT NOT NULL,
      embedding BLOB
    );
    CREATE INDEX IF NOT EXISTS idx_memories_content ON memories(content);
    CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories(tags);

    CREATE TABLE IF NOT EXISTS tasks (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id  TEXT NOT NULL,
      parent_id   INTEGER,
      subject     TEXT NOT NULL,
      status      TEXT NOT NULL DEFAULT 'pending',
      active_form TEXT,
      sort_order  INTEGER DEFAULT 0,
      created_at  TEXT NOT NULL,
      updated_at  TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_session ON tasks(session_id);

    CREATE TABLE IF NOT EXISTS cron_jobs (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      message    TEXT NOT NULL,
      fire_at    TEXT NOT NULL,
      interval   TEXT,
      tag        TEXT,
      active     INTEGER NOT NULL DEFAULT 1,
      last_fired TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS memos (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      content     TEXT NOT NULL,
      remind_at   TEXT,
      repeat_rule TEXT,
      status      TEXT NOT NULL DEFAULT 'active',
      tags        TEXT,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS entities (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL UNIQUE,
      kind       TEXT NOT NULL DEFAULT 'thing',
      props      TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_entities_name ON entities(name);

    CREATE TABLE IF NOT EXISTS edges (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      src_id     INTEGER NOT NULL,
      dst_id     INTEGER NOT NULL,
      type       TEXT NOT NULL,
      props      TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY (src_id) REFERENCES entities(id) ON DELETE CASCADE,
      FOREIGN KEY (dst_id) REFERENCES entities(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_edges_src ON edges(src_id);
    CREATE INDEX IF NOT EXISTS idx_edges_dst ON edges(dst_id);

    CREATE TABLE IF NOT EXISTS pins (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      content    TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_pins_session ON pins(session_id);
  `;

function createSchemaV1(database: typeof db): void {
  database.exec(SCHEMA_V1_SQL);
}

interface ColumnSignature {
  name: string;
  type: string;
  notnull: number;
  defaultValue: string | null;
  pk: number;
}

const EXPECTED_COLUMNS: Record<string, ColumnSignature[]> = {
  sessions: [
    { name: "id", type: "TEXT", notnull: 0, defaultValue: null, pk: 1 },
    { name: "persona_name", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "title", type: "TEXT", notnull: 1, defaultValue: "'新对话'", pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "updated_at", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
  ],
  messages: [
    { name: "id", type: "INTEGER", notnull: 0, defaultValue: null, pk: 1 },
    { name: "session_id", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "role", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "content", type: "TEXT", notnull: 1, defaultValue: "''", pk: 0 },
    { name: "tool_calls", type: "TEXT", notnull: 0, defaultValue: null, pk: 0 },
    { name: "tool_call_id", type: "TEXT", notnull: 0, defaultValue: null, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
  ],
  memories: [
    { name: "id", type: "INTEGER", notnull: 0, defaultValue: null, pk: 1 },
    { name: "content", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "kind", type: "TEXT", notnull: 1, defaultValue: "'observation'", pk: 0 },
    { name: "tags", type: "TEXT", notnull: 0, defaultValue: null, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "embedding", type: "BLOB", notnull: 0, defaultValue: null, pk: 0 },
  ],
  tasks: [
    { name: "id", type: "INTEGER", notnull: 0, defaultValue: null, pk: 1 },
    { name: "session_id", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "parent_id", type: "INTEGER", notnull: 0, defaultValue: null, pk: 0 },
    { name: "subject", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "status", type: "TEXT", notnull: 1, defaultValue: "'pending'", pk: 0 },
    { name: "active_form", type: "TEXT", notnull: 0, defaultValue: null, pk: 0 },
    { name: "sort_order", type: "INTEGER", notnull: 0, defaultValue: "0", pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "updated_at", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
  ],
  cron_jobs: [
    { name: "id", type: "INTEGER", notnull: 0, defaultValue: null, pk: 1 },
    { name: "session_id", type: "TEXT", notnull: 0, defaultValue: null, pk: 0 },
    { name: "message", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "fire_at", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "interval", type: "TEXT", notnull: 0, defaultValue: null, pk: 0 },
    { name: "tag", type: "TEXT", notnull: 0, defaultValue: null, pk: 0 },
    { name: "active", type: "INTEGER", notnull: 1, defaultValue: "1", pk: 0 },
    { name: "last_fired", type: "TEXT", notnull: 0, defaultValue: null, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
  ],
  memos: [
    { name: "id", type: "INTEGER", notnull: 0, defaultValue: null, pk: 1 },
    { name: "content", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "remind_at", type: "TEXT", notnull: 0, defaultValue: null, pk: 0 },
    { name: "repeat_rule", type: "TEXT", notnull: 0, defaultValue: null, pk: 0 },
    { name: "status", type: "TEXT", notnull: 1, defaultValue: "'active'", pk: 0 },
    { name: "tags", type: "TEXT", notnull: 0, defaultValue: null, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
  ],
  entities: [
    { name: "id", type: "INTEGER", notnull: 0, defaultValue: null, pk: 1 },
    { name: "name", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "kind", type: "TEXT", notnull: 1, defaultValue: "'thing'", pk: 0 },
    { name: "props", type: "TEXT", notnull: 0, defaultValue: null, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "updated_at", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
  ],
  edges: [
    { name: "id", type: "INTEGER", notnull: 0, defaultValue: null, pk: 1 },
    { name: "src_id", type: "INTEGER", notnull: 1, defaultValue: null, pk: 0 },
    { name: "dst_id", type: "INTEGER", notnull: 1, defaultValue: null, pk: 0 },
    { name: "type", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "props", type: "TEXT", notnull: 0, defaultValue: null, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
  ],
  pins: [
    { name: "id", type: "INTEGER", notnull: 0, defaultValue: null, pk: 1 },
    { name: "session_id", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "content", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
    { name: "created_at", type: "TEXT", notnull: 1, defaultValue: null, pk: 0 },
  ],
};

const EXPECTED_INDEXES: Record<string, { table: string; columns: string[]; unique: number }> = {
  idx_messages_session: { table: "messages", columns: ["session_id"], unique: 0 },
  idx_memories_content: { table: "memories", columns: ["content"], unique: 0 },
  idx_memories_tags: { table: "memories", columns: ["tags"], unique: 0 },
  idx_tasks_session: { table: "tasks", columns: ["session_id"], unique: 0 },
  idx_entities_name: { table: "entities", columns: ["name"], unique: 0 },
  idx_edges_src: { table: "edges", columns: ["src_id"], unique: 0 },
  idx_edges_dst: { table: "edges", columns: ["dst_id"], unique: 0 },
  idx_pins_session: { table: "pins", columns: ["session_id"], unique: 0 },
};

const EXPECTED_FOREIGN_KEYS: Record<string, string[]> = {
  messages: ["session_id|sessions|id|CASCADE|NO ACTION"],
  tasks: ["session_id|sessions|id|CASCADE|NO ACTION"],
  edges: ["dst_id|entities|id|CASCADE|NO ACTION", "src_id|entities|id|CASCADE|NO ACTION"],
  pins: ["session_id|sessions|id|CASCADE|NO ACTION"],
};

function tableInfo(database: typeof db, table: string): Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }> {
  return database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>;
}

function tableHasColumn(database: typeof db, table: string, column: string): boolean {
  return tableInfo(database, table).some((entry) => entry.name === column);
}

function indexColumns(database: typeof db, index: string): string[] {
  return (database.prepare(`PRAGMA index_info(${index})`).all() as Array<{ name: string }>).map((entry) => entry.name);
}

function normalizeSchemaSql(sql: string): string {
  return sql
    .replace(/\bIF\s+NOT\s+EXISTS\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim()
    .toUpperCase();
}

function assertSchemaV1(database: typeof db = db, allowSchemaV2Objects = false): void {
  const reference = createInMemoryBootstrapDatabase();
  try {
    reference.pragma("foreign_keys = ON");
    reference.exec(SCHEMA_V1_SQL);
    const objects = [
      ...Object.keys(EXPECTED_COLUMNS).map((name) => ({ type: "table", name })),
      ...Object.keys(EXPECTED_INDEXES).map((name) => ({ type: "index", name })),
    ];
    for (const object of objects) {
      const actual = database.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(object.type, object.name) as { sql?: string } | undefined;
      const expected = reference.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(object.type, object.name) as { sql?: string } | undefined;
      if (!actual?.sql || !expected?.sql || normalizeSchemaSql(actual.sql) !== normalizeSchemaSql(expected.sql)) {
        throw new Error(`数据库 Schema 1 不兼容: ${object.type} ${object.name} SQL 定义错误`);
      }
    }
    const objectSignature = (target: typeof db, allowV2Objects: boolean): string[] => (target.prepare(
      "SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger', 'view') ORDER BY type, name"
    ).all() as Array<{ type: string; name: string; tbl_name: string }>)
      .filter(entry => !allowV2Objects || (!SCHEMA_V2_OBJECT_NAMES.has(entry.name) && entry.tbl_name !== "security_audit_events"))
      .map((entry) => `${entry.type}|${entry.name}|${entry.tbl_name}`);
    if (JSON.stringify(objectSignature(database, allowSchemaV2Objects)) !== JSON.stringify(objectSignature(reference, false))) {
      throw new Error("数据库 Schema 1 不兼容: 存在未知或缺失的 Schema 对象");
    }
  } finally {
    reference.close();
  }

  for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
    const actual = tableInfo(database, table);
    if (actual.length !== expected.length) throw new Error(`数据库 Schema 1 不兼容: ${table} 列数量错误`);
    for (let index = 0; index < expected.length; index++) {
      const found = actual[index];
      const wanted = expected[index];
      if (found.name !== wanted.name || found.type.toUpperCase() !== wanted.type
        || found.notnull !== wanted.notnull || found.dflt_value !== wanted.defaultValue || found.pk !== wanted.pk) {
        throw new Error(`数据库 Schema 1 不兼容: ${table}.${wanted.name} 定义错误`);
      }
    }
  }

  for (const [index, expected] of Object.entries(EXPECTED_INDEXES)) {
    const listed = (database.prepare(`PRAGMA index_list(${expected.table})`).all() as Array<{ name: string; unique: number }>).find((entry) => entry.name === index);
    if (!listed || listed.unique !== expected.unique
      || JSON.stringify(indexColumns(database, index)) !== JSON.stringify(expected.columns)) {
      throw new Error(`数据库 Schema 1 不兼容: 索引 ${index} 定义错误`);
    }
  }

  for (const table of ["messages", "memories", "tasks", "cron_jobs", "memos", "entities", "edges", "pins"]) {
    const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql?: string } | undefined;
    if (!row?.sql || !/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/i.test(row.sql)) {
      throw new Error(`数据库 Schema 1 不兼容: ${table}.id 缺少 AUTOINCREMENT`);
    }
  }

  const entityIndexes = database.prepare("PRAGMA index_list(entities)").all() as Array<{ name: string; unique: number }>;
  const hasUniqueEntityName = entityIndexes.some((entry) => entry.unique === 1
    && JSON.stringify(indexColumns(database, entry.name)) === JSON.stringify(["name"]));
  if (!hasUniqueEntityName) throw new Error("数据库 Schema 1 不兼容: entities.name 缺少唯一约束");

  for (const table of Object.keys(EXPECTED_COLUMNS)) {
    const actual = (database.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
      table: string; from: string; to: string; on_delete: string; on_update: string;
    }>).map((entry) => `${entry.from}|${entry.table}|${entry.to}|${entry.on_delete.toUpperCase()}|${entry.on_update.toUpperCase()}`).sort();
    const expected = [...(EXPECTED_FOREIGN_KEYS[table] || [])].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`数据库 Schema 1 不兼容: ${table} 外键定义错误`);
    }
  }

  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length > 0) throw new Error("数据库 Schema 1 不兼容: 存在外键完整性错误");
}

function assertSchemaV2(database: typeof db = db): void {
  assertSchemaV1(database, true);
  const reference = createInMemoryBootstrapDatabase();
  try {
    reference.pragma("foreign_keys = ON");
    reference.exec(SCHEMA_V1_SQL);
    reference.exec(SCHEMA_V2_SQL);
    const objectRows = (target: typeof db): Array<{ type: string; name: string; tbl_name: string; sql: string | null }> => target.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table', 'index', 'trigger', 'view') ORDER BY type, name"
    ).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
    const actual = objectRows(database);
    const expected = objectRows(reference);
    const signatures = (rows: typeof actual): string[] => rows.map(entry => `${entry.type}|${entry.name}|${entry.tbl_name}`);
    if (JSON.stringify(signatures(actual)) !== JSON.stringify(signatures(expected))) {
      throw new Error("数据库 Schema 2 不兼容: 存在未知或缺失的 Schema 对象");
    }
    for (let index = 0; index < expected.length; index += 1) {
      const wanted = expected[index];
      if (!SCHEMA_V2_OBJECT_NAMES.has(wanted.name)) continue;
      const found = actual[index];
      if (!found.sql || !wanted.sql || normalizeSchemaSql(found.sql) !== normalizeSchemaSql(wanted.sql)) {
        throw new Error(`数据库 Schema 2 不兼容: ${wanted.type} ${wanted.name} SQL 定义错误`);
      }
    }
  } finally {
    reference.close();
  }
  const integrity = database.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check?: string }>;
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") throw new Error("数据库 Schema 2 不兼容: 完整性检查失败");
}

function assertSchemaV3(database: typeof db = db): void {
  const reference = createInMemoryBootstrapDatabase();
  try {
    reference.pragma("foreign_keys = ON");
    reference.exec(SCHEMA_V1_SQL);
    reference.exec(SCHEMA_V2_SQL);
    applySchemaV3(reference);
    const objectRows = (target: typeof db): Array<{ type: string; name: string; tbl_name: string; sql: string | null }> => target.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table', 'index', 'trigger', 'view') ORDER BY type, name"
    ).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
    const actual = objectRows(database);
    const expected = objectRows(reference);
    const signatures = (rows: typeof actual): string[] => rows.map(entry => `${entry.type}|${entry.name}|${entry.tbl_name}`);
    if (JSON.stringify(signatures(actual)) !== JSON.stringify(signatures(expected))) {
      throw new Error("数据库 Schema 3 不兼容: 存在未知或缺失的 Schema 对象");
    }
    for (let index = 0; index < expected.length; index += 1) {
      const found = actual[index];
      const wanted = expected[index];
      if ((found.sql === null) !== (wanted.sql === null)
        || (found.sql !== null && wanted.sql !== null && normalizeSchemaSql(found.sql) !== normalizeSchemaSql(wanted.sql))) {
        throw new Error(`数据库 Schema 3 不兼容: ${wanted.type} ${wanted.name} SQL 定义错误`);
      }
    }
  } finally {
    reference.close();
  }
  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length > 0) throw new Error("数据库 Schema 3 不兼容: 存在外键完整性错误");
  const integrity = database.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check?: string }>;
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") throw new Error("数据库 Schema 3 不兼容: 完整性检查失败");
}

const SCHEMA_V4_SQL = `
    CREATE TABLE IF NOT EXISTS events (
      id                TEXT PRIMARY KEY NOT NULL CHECK (length(id) BETWEEN 4 AND 128 AND substr(id, 1, 4) = 'evt_'),
      schema_version    INTEGER NOT NULL CHECK (schema_version = 1),
      type              TEXT NOT NULL CHECK (length(type) BETWEEN 3 AND 64),
      source            TEXT NOT NULL CHECK (source IN ('cron', 'link', 'wire', 'poll', 'system', 'ui')),
      source_event_id   TEXT CHECK (source_event_id IS NULL OR length(source_event_id) BETWEEN 1 AND 128),
      target_session_id TEXT CHECK (target_session_id IS NULL OR length(target_session_id) BETWEEN 1 AND 128),
      tags_json         TEXT NOT NULL CHECK (json_valid(tags_json) AND json_type(tags_json) = 'array' AND length(tags_json) <= 2048),
      payload_json      TEXT NOT NULL CHECK (json_valid(payload_json) AND length(payload_json) <= 131072),
      created_at        INTEGER NOT NULL CHECK (created_at >= 0),
      expires_at        INTEGER CHECK (expires_at IS NULL OR expires_at > 0),
      status            TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'delivered', 'dead', 'expired')),
      attempts          INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
      next_attempt_at   INTEGER NOT NULL DEFAULT 0 CHECK (next_attempt_at >= 0),
      last_error        TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_events_due ON events (status, next_attempt_at);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_source_dedupe ON events (source, source_event_id) WHERE source_event_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_events_target ON events (target_session_id, status) WHERE target_session_id IS NOT NULL;
  `;

function assertSchemaV4(database: typeof db = db): void {
  const reference = createInMemoryBootstrapDatabase();
  try {
    reference.pragma("foreign_keys = ON");
    reference.exec(SCHEMA_V1_SQL);
    reference.exec(SCHEMA_V2_SQL);
    applySchemaV3(reference);
    reference.exec(SCHEMA_V4_SQL);
    const objectRows = (target: typeof db): Array<{ type: string; name: string; tbl_name: string; sql: string | null }> => target.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table', 'index', 'trigger', 'view') ORDER BY type, name"
    ).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
    const actual = objectRows(database);
    const expected = objectRows(reference);
    const signatures = (rows: typeof actual): string[] => rows.map(entry => `${entry.type}|${entry.name}|${entry.tbl_name}`);
    if (JSON.stringify(signatures(actual)) !== JSON.stringify(signatures(expected))) {
      throw new Error("数据库 Schema 4 不兼容: 存在未知或缺失的 Schema 对象");
    }
    for (let index = 0; index < expected.length; index += 1) {
      const found = actual[index];
      const wanted = expected[index];
      if ((found.sql === null) !== (wanted.sql === null)
        || (found.sql !== null && wanted.sql !== null && normalizeSchemaSql(found.sql) !== normalizeSchemaSql(wanted.sql))) {
        throw new Error(`数据库 Schema 4 不兼容: ${wanted.type} ${wanted.name} SQL 定义错误`);
      }
    }
  } finally {
    reference.close();
  }
  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length > 0) throw new Error("数据库 Schema 4 不兼容: 存在外键完整性错误");
  const integrity = database.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check?: string }>;
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") throw new Error("数据库 Schema 4 不兼容: 完整性检查失败");
}

const SCHEMA_V5_SQL = `
    ALTER TABLE cron_jobs ADD COLUMN target_session_id TEXT
      CHECK (target_session_id IS NULL OR length(target_session_id) BETWEEN 1 AND 128);
    ALTER TABLE cron_jobs ADD COLUMN broadcast INTEGER NOT NULL DEFAULT 0
      CHECK (broadcast IN (0, 1));
  `;

function assertSchemaV5(database: typeof db = db): void {
  const reference = createInMemoryBootstrapDatabase();
  try {
    reference.pragma("foreign_keys = ON");
    reference.exec(SCHEMA_V1_SQL);
    reference.exec(SCHEMA_V2_SQL);
    applySchemaV3(reference);
    reference.exec(SCHEMA_V4_SQL);
    reference.exec(SCHEMA_V5_SQL);
    const objectRows = (target: typeof db): Array<{ type: string; name: string; tbl_name: string; sql: string | null }> => target.prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE type IN ('table', 'index', 'trigger', 'view') ORDER BY type, name"
    ).all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
    const actual = objectRows(database);
    const expected = objectRows(reference);
    const signatures = (rows: typeof actual): string[] => rows.map(entry => `${entry.type}|${entry.name}|${entry.tbl_name}`);
    if (JSON.stringify(signatures(actual)) !== JSON.stringify(signatures(expected))) {
      throw new Error("数据库 Schema 5 不兼容: 存在未知或缺失的 Schema 对象");
    }
    for (let index = 0; index < expected.length; index += 1) {
      const found = actual[index];
      const wanted = expected[index];
      if ((found.sql === null) !== (wanted.sql === null)
        || (found.sql !== null && wanted.sql !== null && normalizeSchemaSql(found.sql) !== normalizeSchemaSql(wanted.sql))) {
        throw new Error(`数据库 Schema 5 不兼容: ${wanted.type} ${wanted.name} SQL 定义错误`);
      }
    }
  } finally {
    reference.close();
  }
  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length > 0) throw new Error("数据库 Schema 5 不兼容: 存在外键完整性错误");
  const integrity = database.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check?: string }>;
  if (integrity.length !== 1 || integrity[0].integrity_check !== "ok") throw new Error("数据库 Schema 5 不兼容: 完整性检查失败");
}

interface DatabaseMigration {
  readonly from: number;
  readonly to: number;
  readonly apply: (database: typeof db) => void;
}

const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = Object.freeze([
  Object.freeze({
    from: 0,
    to: 1,
    apply: (database: typeof db): void => {
      createSchemaV1(database);
      if (!tableHasColumn(database, "memories", "embedding")) database.exec("ALTER TABLE memories ADD COLUMN embedding BLOB");
      assertSchemaV1(database);
    },
  }),
  Object.freeze({
    from: 1,
    to: 2,
    apply: (database: typeof db): void => {
      assertSchemaV1(database);
      database.exec(SCHEMA_V2_SQL);
      assertSchemaV2(database);
    },
  }),
  Object.freeze({
    from: 2,
    to: 3,
    apply: (database: typeof db): void => {
      assertSchemaV2(database);
      applySchemaV3(database);
      assertSchemaV3(database);
    },
  }),
  Object.freeze({
    from: 3,
    to: 4,
    apply: (database: typeof db): void => {
      assertSchemaV3(database);
      database.exec(SCHEMA_V4_SQL);
      assertSchemaV4(database);
    },
  }),
  Object.freeze({
    from: 4,
    to: 5,
    apply: (database: typeof db): void => {
      assertSchemaV4(database);
      database.exec(SCHEMA_V5_SQL);
      assertSchemaV5(database);
    },
  }),
]);

function assertMigrationRegistry(): void {
  if (DATABASE_MIGRATIONS.length !== DATABASE_SCHEMA_VERSION) throw new Error("数据库迁移注册表不完整");
  DATABASE_MIGRATIONS.forEach((migration, index) => {
    if (!Object.isFrozen(migration) || migration.from !== index || migration.to !== index + 1) {
      throw new Error("数据库迁移注册表不是连续不可变序列");
    }
  });
  if (!Object.isFrozen(DATABASE_MIGRATIONS)) throw new Error("数据库迁移注册表必须不可变");
}

function readSchemaVersion(database: typeof db): number {
  const version = Number(database.pragma("user_version", { simple: true }));
  if (!Number.isInteger(version) || version < 0) throw new Error(`数据库 Schema 版本无效: ${version}`);
  return version;
}

function migrateDatabase(): void {
  assertMigrationRegistry();
  let version = readSchemaVersion(db);
  if (version > DATABASE_SCHEMA_VERSION) {
    throw new Error(`数据库 Schema 版本在只读探测后发生变化: 当前 ${version}，本应用最多支持 ${DATABASE_SCHEMA_VERSION}`);
  }

  while (version < DATABASE_SCHEMA_VERSION) {
    const migration = DATABASE_MIGRATIONS.find(candidate => candidate.from === version);
    if (!migration || migration.to !== version + 1) throw new Error(`缺少数据库迁移: ${version} -> ${version + 1}`);
    db.transaction(() => {
      if (readSchemaVersion(db) !== migration.from) throw new Error("数据库版本在迁移前发生变化");
      migration.apply(db);
      db.pragma(`user_version = ${migration.to}`);
      if (readSchemaVersion(db) !== migration.to) throw new Error("数据库迁移版本写入失败");
    })();
    version = migration.to;
  }

  if (version !== DATABASE_SCHEMA_VERSION) {
    throw new Error(`数据库 Schema 迁移未达到目标版本: 当前 ${version}，目标 ${DATABASE_SCHEMA_VERSION}`);
  }
  assertSchemaV5(db);
}

try {
  migrateDatabase();
  // 仅在版本兼容检查和迁移成功后启用持久 WAL 模式，确保未来版本拒绝为零修改。
  db.pragma("journal_mode = WAL");
} catch (error) {
  try {
    await persistentConnection.close();
  } catch (closeError) {
    throw new AggregateError([error, closeError], "数据库初始化失败且bootstrap lease清理失败");
  }
  throw error;
}

export function getDatabaseSchemaVersion(): number {
  return Number(db.pragma("user_version", { simple: true }));
}

export function withTransaction<T>(action: () => T): T {
  return db.transaction(action)();
}

export function validateDatabaseRestoreCandidate(
  databasePath: string,
  declaredSchemaVersion: number
): DatabaseSnapshotValidation {
  if (declaredSchemaVersion !== DATABASE_SCHEMA_VERSION) {
    throw new Error(`Database restore Schema version is incompatible: ${declaredSchemaVersion}`);
  }
  const validation = validateDatabaseSnapshotFile(databasePath, DATABASE_SCHEMA_VERSION);
  if (validation.schemaVersion !== declaredSchemaVersion) {
    throw new Error("Database restore Schema version differs from the backup manifest");
  }
  const bytes = fs.readFileSync(databasePath);
  const candidate = createInMemoryBootstrapDatabase(bytes);
  try { assertSchemaV5(candidate); }
  finally { candidate.close(); }
  return validation;
}

export async function createConsistentDatabaseSnapshot(): Promise<Readonly<{ bytes: Buffer; validation: DatabaseSnapshotValidation }>> {
  return getBootstrapPathStore().withDatabaseSnapshotFile(async snapshotPath => {
    await writeConsistentDatabaseSnapshot(db, snapshotPath);
    const validation = validateDatabaseRestoreCandidate(snapshotPath, DATABASE_SCHEMA_VERSION);
    return Object.freeze({ bytes: fs.readFileSync(snapshotPath), validation });
  });
}

export interface SecurityAuditStateRow {
  readonly schemaVersion: 1;
  readonly algorithm: "electron-safe-storage";
  readonly scope: "windows-dpapi-current-user-v1";
  readonly wrappedKey: Buffer;
  readonly createdAt: string;
}

export function getSecurityAuditState(): SecurityAuditStateRow | null {
  const row = db.prepare("SELECT schema_version, algorithm, scope, wrapped_key, created_at FROM security_audit_state WHERE singleton = 1").get() as {
    schema_version: number; algorithm: string; scope: string; wrapped_key: Buffer; created_at: string;
  } | undefined;
  if (!row) return null;
  return Object.freeze({
    schemaVersion: row.schema_version as 1,
    algorithm: row.algorithm as "electron-safe-storage",
    scope: row.scope as "windows-dpapi-current-user-v1",
    wrappedKey: Buffer.from(row.wrapped_key),
    createdAt: row.created_at,
  });
}

export function insertSecurityAuditState(state: SecurityAuditStateRow): void {
  db.prepare("INSERT INTO security_audit_state(singleton,schema_version,algorithm,scope,wrapped_key,created_at) VALUES (1,?,?,?,?,?)")
    .run(state.schemaVersion, state.algorithm, state.scope, state.wrappedKey, state.createdAt);
}

export function getSecurityAuditHead(): SecurityAuditCheckpoint | null {
  const row = db.prepare("SELECT schema_version,event_count,head_hash,checkpoint_mac FROM security_audit_head WHERE singleton = 1").get() as {
    schema_version: number; event_count: number; head_hash: string; checkpoint_mac: string;
  } | undefined;
  if (!row) return null;
  return Object.freeze({
    schemaVersion: row.schema_version as 1,
    eventCount: row.event_count,
    headHash: row.head_hash,
    checkpointMac: row.checkpoint_mac,
  });
}

export function insertSecurityAuditHead(head: SecurityAuditCheckpoint): void {
  db.prepare("INSERT INTO security_audit_head(singleton,schema_version,event_count,head_hash,checkpoint_mac) VALUES (1,?,?,?,?)")
    .run(head.schemaVersion, head.eventCount, head.headHash, head.checkpointMac);
}

export function updateSecurityAuditHead(expected: SecurityAuditCheckpoint, next: SecurityAuditCheckpoint): void {
  const result = db.prepare("UPDATE security_audit_head SET schema_version=?,event_count=?,head_hash=?,checkpoint_mac=? WHERE singleton=1 AND schema_version=? AND event_count=? AND head_hash=? AND checkpoint_mac=?")
    .run(next.schemaVersion, next.eventCount, next.headHash, next.checkpointMac,
      expected.schemaVersion, expected.eventCount, expected.headHash, expected.checkpointMac);
  if (result.changes !== 1) throw new Error("Security audit head changed concurrently");
}

interface SecurityAuditEventDatabaseRow {
  sequence: number;
  event_id: string;
  recorded_at: string;
  phase: string;
  session_id: string | null;
  run_id: string;
  request_id: string;
  parent_request_id: string | null;
  tool_call_id: string | null;
  context_id: string | null;
  execution_id: string | null;
  principal: string;
  operation_kind: string;
  operation_name: string;
  outcome: string;
  code: string | null;
  request_commitment: string;
  safe_payload: string;
  previous_event_hash: string;
  event_hash: string;
}

function mapSecurityAuditEvent(row: SecurityAuditEventDatabaseRow): SecurityAuditEvent {
  let safePayload: unknown;
  try { safePayload = JSON.parse(row.safe_payload); }
  catch { throw new Error("Security audit payload is not valid JSON"); }
  return Object.freeze({
    schemaVersion: 1,
    eventId: row.event_id,
    sequence: row.sequence,
    recordedAt: row.recorded_at,
    phase: row.phase,
    correlation: Object.freeze({
      sessionId: row.session_id,
      runId: row.run_id,
      requestId: row.request_id,
      parentRequestId: row.parent_request_id,
      toolCallId: row.tool_call_id,
      contextId: row.context_id,
      executionId: row.execution_id,
    }),
    principal: row.principal,
    operationKind: row.operation_kind,
    operationName: row.operation_name,
    outcome: row.outcome,
    code: row.code,
    requestCommitment: row.request_commitment,
    safePayload,
    previousEventHash: row.previous_event_hash,
    eventHash: row.event_hash,
  } as SecurityAuditEvent);
}

export async function validateDatabaseRestoreSecurityAudit(
  databaseBytes: Buffer,
  unwrapKey: (wrappedKey: Uint8Array) => Promise<Buffer>
): Promise<void> {
  if (!Buffer.isBuffer(databaseBytes) || databaseBytes.length === 0) throw new TypeError("Database restore audit snapshot is invalid");
  if (typeof unwrapKey !== "function") throw new TypeError("Database restore audit key unwrapper is invalid");
  const candidate = createInMemoryBootstrapDatabase(databaseBytes);
  try {
    const stateRows = candidate.prepare("SELECT schema_version,algorithm,scope,wrapped_key,created_at FROM security_audit_state ORDER BY singleton").all() as Array<{
      schema_version: number; algorithm: string; scope: string; wrapped_key: Buffer; created_at: string;
    }>;
    const headRows = candidate.prepare("SELECT schema_version,event_count,head_hash,checkpoint_mac FROM security_audit_head ORDER BY singleton").all() as Array<{
      schema_version: number; event_count: number; head_hash: string; checkpoint_mac: string;
    }>;
    const eventRows = candidate.prepare("SELECT sequence,event_id,recorded_at,phase,session_id,run_id,request_id,parent_request_id,tool_call_id,context_id,execution_id,principal,operation_kind,operation_name,outcome,code,request_commitment,safe_payload,previous_event_hash,event_hash FROM security_audit_events ORDER BY sequence ASC").all() as SecurityAuditEventDatabaseRow[];
    if (stateRows.length === 0) {
      if (headRows.length !== 0 || eventRows.length !== 0) throw new Error("Database restore audit state is incomplete");
      return;
    }
    if (stateRows.length !== 1 || headRows.length !== 1) throw new Error("Database restore audit state is incomplete");
    const state = stateRows[0];
    if (state.schema_version !== 1 || state.algorithm !== "electron-safe-storage" || state.scope !== "windows-dpapi-current-user-v1"
      || !Buffer.isBuffer(state.wrapped_key) || state.wrapped_key.length === 0 || state.wrapped_key.length > 64 * 1024
      || Number.isNaN(new Date(state.created_at).getTime())) throw new Error("Database restore audit state is invalid");
    const masterKey = await unwrapKey(Buffer.from(state.wrapped_key));
    if (!Buffer.isBuffer(masterKey) || masterKey.length !== 32) {
      masterKey?.fill(0);
      throw new Error("Database restore audit key is unavailable");
    }
    try {
      const events = eventRows.map(mapSecurityAuditEvent);
      const summary = verifySecurityAuditChain(events, masterKey);
      const head = headRows[0];
      verifySecurityAuditCheckpoint(Object.freeze({
        schemaVersion: head.schema_version as 1,
        eventCount: head.event_count,
        headHash: head.head_hash,
        checkpointMac: head.checkpoint_mac,
      }), summary, masterKey);
    } finally {
      masterKey.fill(0);
    }
  } finally {
    candidate.close();
  }
}

export function listSecurityAuditEvents(): readonly SecurityAuditEvent[] {
  const rows = db.prepare("SELECT sequence,event_id,recorded_at,phase,session_id,run_id,request_id,parent_request_id,tool_call_id,context_id,execution_id,principal,operation_kind,operation_name,outcome,code,request_commitment,safe_payload,previous_event_hash,event_hash FROM security_audit_events ORDER BY sequence ASC")
    .all() as SecurityAuditEventDatabaseRow[];
  return Object.freeze(rows.map(mapSecurityAuditEvent));
}

export function insertSecurityAuditEvent(event: SecurityAuditEvent): void {
  db.prepare("INSERT INTO security_audit_events(sequence,event_id,recorded_at,phase,session_id,run_id,request_id,parent_request_id,tool_call_id,context_id,execution_id,principal,operation_kind,operation_name,outcome,code,request_commitment,safe_payload,previous_event_hash,event_hash) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(
      event.sequence,
      event.eventId,
      event.recordedAt,
      event.phase,
      event.correlation.sessionId,
      event.correlation.runId,
      event.correlation.requestId,
      event.correlation.parentRequestId,
      event.correlation.toolCallId,
      event.correlation.contextId,
      event.correlation.executionId,
      event.principal,
      event.operationKind,
      event.operationName,
      event.outcome,
      event.code,
      event.requestCommitment,
      JSON.stringify(event.safePayload),
      event.previousEventHash,
      event.eventHash
    );
}

// ===========================================
// 类型
// ===========================================
export interface SessionRow {
  id: string;
  persona_name: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  tool_calls: string | null;
  tool_call_id: string | null;
  created_at: string;
}

// ===========================================
// Sessions CRUD
// ===========================================

/** 插入新会话 */
export function insertSession(session: SessionRow): void {
  db.prepare(
    `INSERT INTO sessions (id, persona_name, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(session.id, session.persona_name, session.title, session.created_at, session.updated_at);
}

/** 列出所有会话（julianday 保留毫秒精度并兼容可解析的导入时间）。 */
export function listSessions(): SessionRow[] {
  return db.prepare(
    `SELECT * FROM sessions ORDER BY julianday(updated_at) DESC, rowid DESC`
  ).all() as SessionRow[];
}

/** 获取单个会话 */
export function getSession(id: string): SessionRow | undefined {
  return db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id) as SessionRow | undefined;
}

/** 更新会话标题 */
export function updateSessionTitle(id: string, title: string): boolean {
  const result = db.prepare(`UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?`).run(
    title, new Date().toISOString(), id
  );
  return result.changes === 1;
}

/** 更新会话的 updated_at，并确保同毫秒内的选择仍有确定顺序。 */
export function touchSession(id: string): void {
  const latest = db.prepare(`SELECT updated_at AS value FROM sessions ORDER BY julianday(updated_at) DESC LIMIT 1`).get() as { value: string } | undefined;
  const latestMs = latest ? Date.parse(latest.value) : Number.NaN;
  const nextMs = Number.isFinite(latestMs) ? Math.max(Date.now(), latestMs + 1) : Date.now();
  db.prepare(`UPDATE sessions SET updated_at = ? WHERE id = ?`).run(
    new Date(nextMs).toISOString(), id
  );
}

/** 删除会话（消息会因外键级联自动删除） */
export function deleteSession(id: string): void {
  db.prepare(`DELETE FROM sessions WHERE id = ?`).run(id);
}

// ===========================================
// Messages CRUD
// ===========================================

/** 插入消息 */
export function insertMessage(msg: Omit<MessageRow, "id">): void {
  db.prepare(
    `INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    msg.session_id,
    msg.role,
    msg.content,
    msg.tool_calls || null,
    msg.tool_call_id || null,
    msg.created_at
  );
}

/** 获取会话的所有消息（按时间正序） */
export function getMessagesBySession(sessionId: string): MessageRow[] {
  return db.prepare(
    `SELECT * FROM messages WHERE session_id = ? ORDER BY id ASC`
  ).all(sessionId) as MessageRow[];
}

/** 删除会话的所有消息 */
export function deleteMessagesBySession(sessionId: string): void {
  db.prepare(`DELETE FROM messages WHERE session_id = ?`).run(sessionId);
}

/** 关闭数据库并释放受管bootstrap lifetime lease。 */
export async function closeDb(): Promise<void> {
  await persistentConnection.close();
}

// ===========================================
// Memories CRUD（跨会话知识）
// ===========================================

export interface MemoryRow {
  id: number;
  content: string;
  kind: string;
  tags: string | null; // JSON array
  created_at: string;
  embedding: Buffer | null; // 向量数据
}

/** 插入记忆（含 embedding 向量） */
export function insertMemory(
  content: string,
  kind: string,
  tags: string[],
  embedding?: Buffer | null
): number {
  const result = db.prepare(
    `INSERT INTO memories (content, kind, tags, created_at, embedding) VALUES (?, ?, ?, ?, ?)`
  ).run(content, kind, JSON.stringify(tags), new Date().toISOString(), embedding || null);
  return Number(result.lastInsertRowid);
}

/** 给已有记忆补充 embedding（迁移用） */
export function updateMemoryEmbedding(id: number, embedding: Buffer): void {
  db.prepare(`UPDATE memories SET embedding = ? WHERE id = ?`).run(embedding, id);
}

/** 搜索记忆（LIKE 模糊匹配 content + tags）—— 向量不可用时的回退 */
export function searchMemories(query: string, limit: number = 20): MemoryRow[] {
  const pattern = `%${query}%`;
  return db.prepare(
    `SELECT * FROM memories
     WHERE content LIKE ? OR tags LIKE ?
     ORDER BY datetime(created_at) DESC
     LIMIT ?`
  ).all(pattern, pattern, limit) as MemoryRow[];
}

/** 获取所有有 embedding 的记忆（用于向量检索） */
export function getAllMemoriesWithEmbedding(): MemoryRow[] {
  return db.prepare(
    `SELECT * FROM memories WHERE embedding IS NOT NULL ORDER BY datetime(created_at) DESC`
  ).all() as MemoryRow[];
}

/** 获取所有没有 embedding 的记忆（用于迁移补全） */
export function getMemoriesWithoutEmbedding(): MemoryRow[] {
  return db.prepare(
    `SELECT * FROM memories WHERE embedding IS NULL`
  ).all() as MemoryRow[];
}

/** 列出所有记忆（按时间倒序） */
export function listMemories(limit: number = 50): MemoryRow[] {
  return db.prepare(
    `SELECT * FROM memories ORDER BY datetime(created_at) DESC LIMIT ?`
  ).all(limit) as MemoryRow[];
}

/** 获取最近的 N 条记忆（用于注入 system prompt） */
export function getRecentMemories(limit: number = 10): MemoryRow[] {
  return db.prepare(
    `SELECT * FROM memories ORDER BY datetime(created_at) DESC LIMIT ?`
  ).all(limit) as MemoryRow[];
}

/** 删除指定记忆 */
export function deleteMemory(id: number): void {
  db.prepare(`DELETE FROM memories WHERE id = ?`).run(id);
}

// ===========================================
// 跨会话搜索
// ===========================================

export interface SearchResultRow {
  session_id: string;
  session_title: string;
  session_persona: string;
  message_id: number;
  role: string;
  content: string;
  created_at: string;
}

/** 搜索所有会话中的消息（按关键词匹配 content） */
export function searchAcrossSessions(query: string, limit: number = 50): SearchResultRow[] {
  const pattern = `%${query}%`;
  return db.prepare(
    `SELECT m.session_id, s.title as session_title, s.persona_name as session_persona,
            m.id as message_id, m.role, m.content, m.created_at
     FROM messages m
     JOIN sessions s ON m.session_id = s.id
     WHERE m.content LIKE ? AND m.role IN ('user', 'assistant')
     ORDER BY datetime(m.created_at) DESC
     LIMIT ?`
  ).all(pattern, limit) as SearchResultRow[];
}

/** 获取指定消息 ID 之前的所有消息（用于 fork） */
export function getMessagesUpTo(sessionId: string, messageId: number): MessageRow[] {
  return db.prepare(
    `SELECT * FROM messages WHERE session_id = ? AND id <= ? ORDER BY id ASC`
  ).all(sessionId, messageId) as MessageRow[];
}

/** 获取会话中最后一条用户消息的 ID */
export function getLastUserMessageId(sessionId: string): number | null {
  const row = db.prepare(
    `SELECT id FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1`
  ).get(sessionId) as { id: number } | undefined;
  return row?.id ?? null;
}

// ===========================================
// Tasks CRUD（Task DAG）
// ===========================================

export interface TaskRow {
  id: number;
  session_id: string;
  task_id: string;
  subject: string;
  description: string | null;
  status: "pending" | "in_progress" | "completed";
  active_form: string | null;
  owner: string | null;
  metadata_json: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export interface TaskDependencyRow {
  session_id: string;
  task_id: string;
  blocker_id: string;
  created_at: string;
}

const TASK_SELECT_COLUMNS = "id, session_id, task_id, subject, description, status, active_form, owner, metadata_json, sort_order, created_at, updated_at";

export function getTasksBySessionId(sessionId: string): TaskRow[] {
  return db.prepare(
    `SELECT ${TASK_SELECT_COLUMNS} FROM tasks WHERE session_id = ? ORDER BY sort_order ASC, id ASC`
  ).all(sessionId) as TaskRow[];
}

export function getTaskBySessionAndId(sessionId: string, taskId: string): TaskRow | undefined {
  return db.prepare(
    `SELECT ${TASK_SELECT_COLUMNS} FROM tasks WHERE session_id = ? AND task_id = ?`
  ).get(sessionId, taskId) as TaskRow | undefined;
}

export function getNextTaskSortOrder(sessionId: string): number {
  const row = db.prepare("SELECT COALESCE(MAX(sort_order), -1) + 1 AS next_order FROM tasks WHERE session_id = ?")
    .get(sessionId) as { next_order: number };
  return row.next_order;
}

export function insertTaskRow(row: Omit<TaskRow, "id">): TaskRow {
  db.prepare(
    `INSERT INTO tasks (
       session_id, task_id, subject, description, status, active_form, owner,
       metadata_json, sort_order, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.session_id, row.task_id, row.subject, row.description, row.status, row.active_form,
    row.owner, row.metadata_json, row.sort_order, row.created_at, row.updated_at,
  );
  const inserted = getTaskBySessionAndId(row.session_id, row.task_id);
  if (!inserted) throw new Error("Task insert did not publish one row");
  return inserted;
}

export function updateTaskRow(row: Omit<TaskRow, "id" | "created_at" | "sort_order">): boolean {
  const result = db.prepare(
    `UPDATE tasks
     SET subject = ?, description = ?, status = ?, active_form = ?, owner = ?, metadata_json = ?, updated_at = ?
     WHERE session_id = ? AND task_id = ?`
  ).run(
    row.subject, row.description, row.status, row.active_form, row.owner, row.metadata_json,
    row.updated_at, row.session_id, row.task_id,
  );
  return result.changes === 1;
}

export function deleteTaskBySessionAndId(sessionId: string, taskId: string): boolean {
  return db.prepare("DELETE FROM tasks WHERE session_id = ? AND task_id = ?").run(sessionId, taskId).changes === 1;
}

export function deleteTasksBySessionId(sessionId: string): number {
  return db.prepare("DELETE FROM tasks WHERE session_id = ?").run(sessionId).changes;
}

export function getTaskDependenciesBySessionId(sessionId: string): TaskDependencyRow[] {
  return db.prepare(
    "SELECT session_id, task_id, blocker_id, created_at FROM task_dependencies WHERE session_id = ? ORDER BY task_id, blocker_id"
  ).all(sessionId) as TaskDependencyRow[];
}

export function insertTaskDependency(row: TaskDependencyRow): void {
  db.prepare(
    "INSERT INTO task_dependencies (session_id, task_id, blocker_id, created_at) VALUES (?, ?, ?, ?)"
  ).run(row.session_id, row.task_id, row.blocker_id, row.created_at);
}

// ===========================================
// Cron Jobs CRUD（定时任务）
// ===========================================

export interface CronJobRow {
  id: number;
  /** 创建者/所有者 Session；用于 list/cancel 隔离。 */
  session_id: string | null;
  /** canonical 目标 Session。null 表示 legacy/self；broadcast=1 时忽略。 */
  target_session_id: string | null;
  broadcast: number;
  message: string;
  /** 下一次固定频率计划触发点。 */
  fire_at: string;
  interval: string | null;
  tag: string | null;
  active: number;
  last_fired: string | null;
  created_at: string;
}

type CronJobInsert = Omit<CronJobRow, "id" | "active" | "last_fired" | "created_at" | "target_session_id" | "broadcast"> & {
  readonly active?: number;
  readonly target_session_id?: string | null;
  readonly broadcast?: number;
};

export function insertCronJob(job: CronJobInsert): number {
  const now = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO cron_jobs (session_id, target_session_id, broadcast, message, fire_at, interval, tag, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    job.session_id || null,
    job.target_session_id || null,
    job.broadcast === 1 ? 1 : 0,
    job.message,
    job.fire_at,
    job.interval || null,
    job.tag || null,
    job.active ?? 1,
    now,
  );
  return Number(result.lastInsertRowid);
}

export function listCronJobs(activeOnly: boolean = false): CronJobRow[] {
  if (activeOnly) {
    return db.prepare(`SELECT * FROM cron_jobs WHERE active = 1 ORDER BY datetime(fire_at) ASC`).all() as CronJobRow[];
  }
  return db.prepare(`SELECT * FROM cron_jobs ORDER BY datetime(fire_at) ASC`).all() as CronJobRow[];
}

export function getCronJob(id: number): CronJobRow | undefined {
  return db.prepare(`SELECT * FROM cron_jobs WHERE id = ?`).get(id) as CronJobRow | undefined;
}

export function deactivateCronJob(id: number): void {
  db.prepare(`UPDATE cron_jobs SET active = 0 WHERE id = ?`).run(id);
}

export function updateCronJobLastFired(id: number, lastFired: string): void {
  db.prepare(`UPDATE cron_jobs SET last_fired = ? WHERE id = ?`).run(lastFired, id);
}

/** 一次原子写入完成当前 slot，并推进到下一固定频率 slot；nextFireAt=null 表示 one-shot 结束。 */
export function advanceCronJob(id: number, lastFired: string, nextFireAt: string | null): void {
  if (nextFireAt === null) {
    db.prepare(`UPDATE cron_jobs SET last_fired = ?, active = 0 WHERE id = ? AND active = 1`).run(lastFired, id);
    return;
  }
  db.prepare(`UPDATE cron_jobs SET last_fired = ?, fire_at = ? WHERE id = ? AND active = 1`).run(lastFired, nextFireAt, id);
}

// ===========================================
// Events 持久队列 (EVT-01 EventBus)
// ===========================================

interface EventRow {
  id: string;
  schema_version: number;
  type: string;
  source: string;
  source_event_id: string | null;
  target_session_id: string | null;
  tags_json: string;
  payload_json: string;
  created_at: number;
  expires_at: number | null;
  status: string;
  attempts: number;
  next_attempt_at: number;
  last_error: string | null;
}

const EVENT_SOURCE_VALUES = new Set(["cron", "link", "wire", "poll", "system", "ui"]);
const EVENT_STATUS_VALUES = new Set(["pending", "delivered", "dead", "expired"]);

function mapEventRow(row: EventRow): import("./event-bus.js").StoredEvent {
  if (row.schema_version !== 1 || !EVENT_SOURCE_VALUES.has(row.source) || !EVENT_STATUS_VALUES.has(row.status)) {
    throw new Error(`事件行损坏: ${row.id}`);
  }
  let tags: unknown;
  let payload: unknown;
  try {
    tags = JSON.parse(row.tags_json);
    payload = JSON.parse(row.payload_json);
  } catch {
    throw new Error(`事件行 JSON 损坏: ${row.id}`);
  }
  if (!Array.isArray(tags) || tags.some(tag => typeof tag !== "string")) throw new Error(`事件行 tags 损坏: ${row.id}`);
  return Object.freeze({
    schemaVersion: 1,
    id: row.id,
    type: row.type,
    source: row.source as import("./event-bus.js").EventSource,
    sourceEventId: row.source_event_id,
    targetSessionId: row.target_session_id,
    tags: Object.freeze(tags as string[]),
    payload,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    status: row.status as import("./event-bus.js").EventStatus,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
  });
}

const EVENT_COLUMNS = `id, schema_version, type, source, source_event_id, target_session_id, tags_json, payload_json, created_at, expires_at, status, attempts, next_attempt_at, last_error`;

/** EventBus 的 SQLite EventStore 实现（EVT-01）。 */
export function createEventStore(): import("./event-bus.js").EventStore {
  return {
    insertEvent(event) {
      const info = db.prepare(`
        INSERT OR IGNORE INTO events (${EVENT_COLUMNS})
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, 0, NULL)
      `).run(
        event.id,
        event.schemaVersion,
        event.type,
        event.source,
        event.sourceEventId,
        event.targetSessionId,
        JSON.stringify(event.tags),
        JSON.stringify(event.payload),
        event.createdAt,
        event.expiresAt
      );
      if (info.changes === 1) return { inserted: true, existingId: null };
      const existing = event.sourceEventId !== null
        ? db.prepare(`SELECT id FROM events WHERE source = ? AND source_event_id = ?`).get(event.source, event.sourceEventId) as { id: string } | undefined
        : db.prepare(`SELECT id FROM events WHERE id = ?`).get(event.id) as { id: string } | undefined;
      return { inserted: false, existingId: existing?.id ?? null };
    },
    dueEvents(now, limit) {
      const rows = db.prepare(`
        SELECT ${EVENT_COLUMNS} FROM events
        WHERE status = 'pending' AND next_attempt_at <= ?
        ORDER BY next_attempt_at, created_at LIMIT ?
      `).all(now, limit) as EventRow[];
      return rows.map(mapEventRow);
    },
    recordAttempt(id, now) {
      db.prepare(`UPDATE events SET attempts = attempts + 1 WHERE id = ?`).run(id);
    },
    settleEvent(id, status, lastError, now) {
      db.prepare(`UPDATE events SET status = ?, last_error = ? WHERE id = ?`).run(status, lastError, id);
    },
    scheduleRetry(id, nextAttemptAt, lastError) {
      db.prepare(`UPDATE events SET status = 'pending', next_attempt_at = ?, last_error = ? WHERE id = ?`).run(nextAttemptAt, lastError, id);
    },
    pruneEvents(now, deliveredCutoffMs, deadCutoffMs) {
      const info = db.prepare(`
        DELETE FROM events
        WHERE (status = 'delivered' AND created_at < ?)
           OR (status IN ('dead', 'expired') AND created_at < ?)
      `).run(now - deliveredCutoffMs, now - deadCutoffMs);
      return info.changes;
    },
    countByStatus() {
      const rows = db.prepare(`SELECT status, COUNT(*) AS count FROM events GROUP BY status`).all() as Array<{ status: string; count: number }>;
      const result = { pending: 0, delivered: 0, dead: 0, expired: 0 };
      for (const row of rows) {
        if (row.status === "pending" || row.status === "delivered" || row.status === "dead" || row.status === "expired") {
          result[row.status] = row.count;
        }
      }
      return result;
    },
    pendingEventsForSession(sessionId, limit) {
      const rows = db.prepare(`
        SELECT ${EVENT_COLUMNS} FROM events
        WHERE target_session_id = ? AND status = 'pending'
        ORDER BY next_attempt_at, created_at LIMIT ?
      `).all(sessionId, limit) as EventRow[];
      return rows.map(mapEventRow);
    },
  };
}

// ===========================================
// Entities CRUD（知识图谱 - 实体）
// ===========================================

export interface EntityRow {
  id: number;
  name: string;
  kind: string;
  props: string | null; // JSON
  created_at: string;
  updated_at: string;
}

/** 插入或更新实体（upsert by name） */
export function upsertEntity(name: string, kind: string, props?: Record<string, unknown>): number {
  const now = new Date().toISOString();
  const propsJson = props ? JSON.stringify(props) : null;
  const existing = db.prepare(`SELECT id FROM entities WHERE name = ?`).get(name) as { id: number } | undefined;
  if (existing) {
    db.prepare(`UPDATE entities SET kind = ?, props = COALESCE(?, props), updated_at = ? WHERE id = ?`)
      .run(kind, propsJson, now, existing.id);
    return existing.id;
  }
  const result = db.prepare(
    `INSERT INTO entities (name, kind, props, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
  ).run(name, kind, propsJson, now, now);
  return Number(result.lastInsertRowid);
}

export function getEntity(id: number): EntityRow | undefined {
  return db.prepare(`SELECT * FROM entities WHERE id = ?`).get(id) as EntityRow | undefined;
}

export function getEntityByName(name: string): EntityRow | undefined {
  return db.prepare(`SELECT * FROM entities WHERE name = ?`).get(name) as EntityRow | undefined;
}

export function searchEntities(keyword: string, limit: number = 20): EntityRow[] {
  return db.prepare(
    `SELECT * FROM entities WHERE name LIKE ? ORDER BY datetime(updated_at) DESC LIMIT ?`
  ).all(`%${keyword}%`, limit) as EntityRow[];
}

export function listEntities(limit: number = 50): EntityRow[] {
  return db.prepare(`SELECT * FROM entities ORDER BY datetime(updated_at) DESC LIMIT ?`).all(limit) as EntityRow[];
}

// ===========================================
// Edges CRUD（知识图谱 - 关系）
// ===========================================

export interface EdgeRow {
  id: number;
  src_id: number;
  dst_id: number;
  type: string;
  props: string | null;
  created_at: string;
}

/** 创建关系（避免重复） */
export function insertEdge(srcId: number, dstId: number, type: string, props?: Record<string, unknown>): void {
  const existing = db.prepare(
    `SELECT id FROM edges WHERE src_id = ? AND dst_id = ? AND type = ?`
  ).get(srcId, dstId, type);
  if (existing) return;
  db.prepare(
    `INSERT INTO edges (src_id, dst_id, type, props, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(srcId, dstId, type, props ? JSON.stringify(props) : null, new Date().toISOString());
}

/** 获取实体的所有关系（出+入） */
export function getEdgesForEntity(entityId: number): { edge: EdgeRow; direction: "out" | "in"; other: EntityRow }[] {
  const outEdges = db.prepare(
    `SELECT e.*, en.name as other_name, en.kind as other_kind, en.id as other_id
     FROM edges e JOIN entities en ON e.dst_id = en.id
     WHERE e.src_id = ?`
  ).all(entityId) as (EdgeRow & { other_name: string; other_kind: string; other_id: number })[];

  const inEdges = db.prepare(
    `SELECT e.*, en.name as other_name, en.kind as other_kind, en.id as other_id
     FROM edges e JOIN entities en ON e.src_id = en.id
     WHERE e.dst_id = ?`
  ).all(entityId) as (EdgeRow & { other_name: string; other_kind: string; other_id: number })[];

  const result: { edge: EdgeRow; direction: "out" | "in"; other: EntityRow }[] = [];

  for (const r of outEdges) {
    result.push({
      edge: { id: r.id, src_id: r.src_id, dst_id: r.dst_id, type: r.type, props: r.props, created_at: r.created_at },
      direction: "out",
      other: { id: r.other_id, name: r.other_name, kind: r.other_kind, props: null, created_at: "", updated_at: "" },
    });
  }

  for (const r of inEdges) {
    result.push({
      edge: { id: r.id, src_id: r.src_id, dst_id: r.dst_id, type: r.type, props: r.props, created_at: r.created_at },
      direction: "in",
      other: { id: r.other_id, name: r.other_name, kind: r.other_kind, props: null, created_at: "", updated_at: "" },
    });
  }

  return result;
}

// ===========================================
// Pins CRUD（固定指令）
// ===========================================

export interface PinRow {
  id: number;
  session_id: string;
  content: string;
  created_at: string;
}

export function insertPin(sessionId: string, content: string): number {
  const result = db.prepare(
    `INSERT INTO pins (session_id, content, created_at) VALUES (?, ?, ?)`
  ).run(sessionId, content, new Date().toISOString());
  return Number(result.lastInsertRowid);
}

export function getPinsBySession(sessionId: string): PinRow[] {
  return db.prepare(
    `SELECT * FROM pins WHERE session_id = ? ORDER BY id ASC`
  ).all(sessionId) as PinRow[];
}

export function deletePin(id: number): void {
  db.prepare(`DELETE FROM pins WHERE id = ?`).run(id);
}

export function deleteMessagesAfterLastUserMessage(sessionId: string): number {
  // 找到最后一条 user 消息的位置
  const messages = db.prepare(
    `SELECT id FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1`
  ).get(sessionId) as { id: number } | undefined;

  if (!messages) return 0;

  // 删除该 user 消息之后的所有消息（不含该 user 消息本身）
  const result = db.prepare(
    `DELETE FROM messages WHERE session_id = ? AND id > ?`
  ).run(sessionId, messages.id);

  return Number(result.changes);
}

export { db };
