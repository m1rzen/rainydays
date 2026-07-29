// ===========================================
// 数据库层 —— SQLite 持久化存储
// 存储：会话(sessions) + 消息(messages) + 记忆(memories)
// ===========================================

import { createInMemoryBootstrapDatabase, openBootstrapDatabase } from "./bootstrap-database.js";
import { DATABASE_SCHEMA_VERSION } from "./version.js";

/** 仅在受管bootstrap identity与只读兼容探测通过后建立可写连接。 */
const persistentConnection = await openBootstrapDatabase(DATABASE_SCHEMA_VERSION);
const db = persistentConnection.database;

// ===========================================
// 数据库版本与迁移
// ===========================================

const CURRENT_SCHEMA_SQL = `
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

function createCurrentSchema(): void {
  db.exec(CURRENT_SCHEMA_SQL);
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

function tableInfo(table: string): Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }> {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>;
}

function tableHasColumn(table: string, column: string): boolean {
  return tableInfo(table).some((entry) => entry.name === column);
}

function indexColumns(index: string): string[] {
  return (db.prepare(`PRAGMA index_info(${index})`).all() as Array<{ name: string }>).map((entry) => entry.name);
}

function normalizeSchemaSql(sql: string): string {
  return sql
    .replace(/\bIF\s+NOT\s+EXISTS\b/gi, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim()
    .toUpperCase();
}

function assertCurrentSchema(): void {
  const reference = createInMemoryBootstrapDatabase();
  try {
    reference.pragma("foreign_keys = ON");
    reference.exec(CURRENT_SCHEMA_SQL);
    const objects = [
      ...Object.keys(EXPECTED_COLUMNS).map((name) => ({ type: "table", name })),
      ...Object.keys(EXPECTED_INDEXES).map((name) => ({ type: "index", name })),
    ];
    for (const object of objects) {
      const actual = db.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(object.type, object.name) as { sql?: string } | undefined;
      const expected = reference.prepare("SELECT sql FROM sqlite_master WHERE type = ? AND name = ?").get(object.type, object.name) as { sql?: string } | undefined;
      if (!actual?.sql || !expected?.sql || normalizeSchemaSql(actual.sql) !== normalizeSchemaSql(expected.sql)) {
        throw new Error(`数据库 Schema 1 不兼容: ${object.type} ${object.name} SQL 定义错误`);
      }
    }
    const objectSignature = (database: typeof db): string[] => (database.prepare(
      "SELECT type, name, tbl_name FROM sqlite_master WHERE type IN ('table', 'index', 'trigger', 'view') ORDER BY type, name"
    ).all() as Array<{ type: string; name: string; tbl_name: string }>).map((entry) => `${entry.type}|${entry.name}|${entry.tbl_name}`);
    if (JSON.stringify(objectSignature(db)) !== JSON.stringify(objectSignature(reference))) {
      throw new Error("数据库 Schema 1 不兼容: 存在未知或缺失的 Schema 对象");
    }
  } finally {
    reference.close();
  }

  for (const [table, expected] of Object.entries(EXPECTED_COLUMNS)) {
    const actual = tableInfo(table);
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
    const listed = (db.prepare(`PRAGMA index_list(${expected.table})`).all() as Array<{ name: string; unique: number }>).find((entry) => entry.name === index);
    if (!listed || listed.unique !== expected.unique
      || JSON.stringify(indexColumns(index)) !== JSON.stringify(expected.columns)) {
      throw new Error(`数据库 Schema 1 不兼容: 索引 ${index} 定义错误`);
    }
  }

  for (const table of ["messages", "memories", "tasks", "cron_jobs", "memos", "entities", "edges", "pins"]) {
    const row = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { sql?: string } | undefined;
    if (!row?.sql || !/\bINTEGER\s+PRIMARY\s+KEY\s+AUTOINCREMENT\b/i.test(row.sql)) {
      throw new Error(`数据库 Schema 1 不兼容: ${table}.id 缺少 AUTOINCREMENT`);
    }
  }

  const entityIndexes = db.prepare("PRAGMA index_list(entities)").all() as Array<{ name: string; unique: number }>;
  const hasUniqueEntityName = entityIndexes.some((entry) => entry.unique === 1
    && JSON.stringify(indexColumns(entry.name)) === JSON.stringify(["name"]));
  if (!hasUniqueEntityName) throw new Error("数据库 Schema 1 不兼容: entities.name 缺少唯一约束");

  for (const table of Object.keys(EXPECTED_COLUMNS)) {
    const actual = (db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
      table: string; from: string; to: string; on_delete: string; on_update: string;
    }>).map((entry) => `${entry.from}|${entry.table}|${entry.to}|${entry.on_delete.toUpperCase()}|${entry.on_update.toUpperCase()}`).sort();
    const expected = [...(EXPECTED_FOREIGN_KEYS[table] || [])].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`数据库 Schema 1 不兼容: ${table} 外键定义错误`);
    }
  }

  const foreignKeyViolations = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeyViolations.length > 0) throw new Error("数据库 Schema 1 不兼容: 存在外键完整性错误");
}

function migrateDatabase(): void {
  const foundVersion = Number(db.pragma("user_version", { simple: true }));
  if (!Number.isInteger(foundVersion) || foundVersion < 0) throw new Error(`数据库 Schema 版本无效: ${foundVersion}`);
  if (foundVersion > DATABASE_SCHEMA_VERSION) {
    throw new Error(`数据库 Schema 版本在只读探测后发生变化: 当前 ${foundVersion}，本应用最多支持 ${DATABASE_SCHEMA_VERSION}`);
  }

  if (foundVersion < 1) {
    db.transaction(() => {
      createCurrentSchema();
      if (!tableHasColumn("memories", "embedding")) db.exec("ALTER TABLE memories ADD COLUMN embedding BLOB");
      assertCurrentSchema();
      db.pragma("user_version = 1");
    })();
  }

  const migratedVersion = Number(db.pragma("user_version", { simple: true }));
  if (migratedVersion !== DATABASE_SCHEMA_VERSION) {
    throw new Error(`数据库 Schema 迁移未达到目标版本: 当前 ${migratedVersion}，目标 ${DATABASE_SCHEMA_VERSION}`);
  }
  assertCurrentSchema();
}

migrateDatabase();
// 仅在版本兼容检查和迁移成功后启用持久 WAL 模式，确保未来版本拒绝为零修改。
db.pragma("journal_mode = WAL");

export function getDatabaseSchemaVersion(): number {
  return Number(db.pragma("user_version", { simple: true }));
}

export function withTransaction<T>(action: () => T): T {
  return db.transaction(action)();
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
// Tasks CRUD（任务系统）
// ===========================================

export interface TaskRow {
  id: number;
  session_id: string;
  parent_id: number | null;
  subject: string;
  status: string; // pending | in_progress | completed | failed
  active_form: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

/** 批量插入任务 */
export function insertTasks(sessionId: string, subjects: string[]): number[] {
  const now = new Date().toISOString();
  const ids: number[] = [];
  const stmt = db.prepare(
    `INSERT INTO tasks (session_id, subject, status, sort_order, created_at, updated_at)
     VALUES (?, ?, 'pending', ?, ?, ?)`
  );
  subjects.forEach((subject, i) => {
    const result = stmt.run(sessionId, subject, i, now, now);
    ids.push(Number(result.lastInsertRowid));
  });
  return ids;
}

/** 获取会话的所有任务（按 sort_order 正序） */
export function getTasksBySessionId(sessionId: string): TaskRow[] {
  return db.prepare(
    `SELECT * FROM tasks WHERE session_id = ? ORDER BY sort_order ASC, id ASC`
  ).all(sessionId) as TaskRow[];
}

/** 获取单个任务 */
export function getTask(id: number): TaskRow | undefined {
  return db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(id) as TaskRow | undefined;
}

/** 更新任务状态 */
export function updateTaskStatusInDb(id: number, status: string, activeForm?: string): void {
  const now = new Date().toISOString();
  if (activeForm !== undefined) {
    db.prepare(`UPDATE tasks SET status = ?, active_form = ?, updated_at = ? WHERE id = ?`)
      .run(status, activeForm, now, id);
  } else {
    db.prepare(`UPDATE tasks SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, now, id);
  }
}

/** 更新任务标题 */
export function updateTaskSubject(id: number, subject: string): void {
  db.prepare(`UPDATE tasks SET subject = ?, updated_at = ? WHERE id = ?`)
    .run(subject, new Date().toISOString(), id);
}

/** 删除任务 */
export function deleteTask(id: number): void {
  db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
}

// ===========================================
// Cron Jobs CRUD（定时任务）
// ===========================================

export interface CronJobRow {
  id: number;
  session_id: string | null;
  message: string;
  fire_at: string;
  interval: string | null;
  tag: string | null;
  active: number;
  last_fired: string | null;
  created_at: string;
}

export function insertCronJob(job: Omit<CronJobRow, "id" | "active" | "last_fired" | "created_at"> & { active?: number }): number {
  const now = new Date().toISOString();
  const result = db.prepare(
    `INSERT INTO cron_jobs (session_id, message, fire_at, interval, tag, active, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(job.session_id || null, job.message, job.fire_at, job.interval || null, job.tag || null, job.active ?? 1, now);
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
