// RT-09 fixture: seeds two sessions (oldest first) into an isolated userData database,
// then prints {"ready":true} once both rows are committed.
import http from "node:http";
import { mkdir } from "node:fs/promises";
import path from "node:path";

await mkdir(process.env.RT09_DATA_DIR, { recursive: true });
Object.assign(process.env, {
  RAINYDAYS_APP_ROOT: process.cwd(),
  RAINYDAYS_USER_DATA_DIR: process.env.RT09_USER_DATA_DIR,
  RAINYDAYS_DATA_DIR: process.env.RT09_DATA_DIR,
});
const { createSession } = await import("../../dist/session.js");
const { insertMessage, closeDb } = await import("../../dist/db.js");

const persona = Object.freeze({
  name: "general",
  displayName: "通用助手",
  description: "fixture",
  tools: Object.freeze([]),
  env: Object.freeze({}),
  allowedRoots: Object.freeze([]),
  networkPolicy: Object.freeze({ mode: "deny" }),
  systemPrompt: "RT-09 restore fixture",
  digest: "rt09-restore-digest",
});

const now = new Date().toISOString();
const older = createSession(persona, "RT-09 older");
insertMessage({ session_id: older.id, role: "user", content: "older", tool_calls: null, tool_call_id: null, created_at: now });
const newer = createSession(persona, "RT-09 newer");
insertMessage({ session_id: newer.id, role: "user", content: "newer", tool_calls: null, tool_call_id: null, created_at: now });
closeDb();

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ ready: true, sessions: [older.id, newer.id] }));
});
server.listen(Number(process.env.RT09_SEED_PORT), "127.0.0.1", () => {
  process.stdout.write(`${JSON.stringify({ ready: true })}\n`);
});
