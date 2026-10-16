// Append missing conversations using the validated session transfer format.
// node --import tsx scripts/recover-session-history.mjs --source <db> --user-data <folder> [--apply]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";

const script = fileURLToPath(import.meta.url), project = path.dirname(path.dirname(script));
const args = process.argv.slice(2), indexName = "history-recovery-index.json";
const readIndex = file => fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
function removePlanFixture(fixture) {
  if (path.dirname(fixture) !== path.resolve(os.tmpdir()) || !path.basename(fixture).startsWith("rainydays-history-plan-")) throw new Error("Recovery fixture path mismatch");
  fs.rmSync(fixture, { recursive: true, force: true });
}
async function snapshot(source, target) {
  const database = new Database(source, { readonly: true, fileMustExist: true });
  try { await database.backup(target); } finally { database.close(); }
}
async function worker() {
  const [, userData, transferFile, extra] = args;
  Object.assign(process.env, { RAINYDAYS_APP_ROOT: project, RAINYDAYS_USER_DATA_DIR: userData, RAINYDAYS_DATA_DIR: path.join(userData, "data"),
    RAINYDAYS_USER_PERSONAS_DIR: path.join(userData, "personas"), RAINYDAYS_USER_SKILLS_DIR: path.join(userData, "skills"), RAINYDAYS_PLAYBOOKS_DIR: path.join(userData, "playbooks") });
  const database = await import("../src/db.ts");
  try {
    const session = await import("../src/session.ts");
    if (args[0] === "--worker-export") {
      fs.writeFileSync(transferFile, JSON.stringify(JSON.parse(extra).map(id => {
        const exported = session.exportSession(id); if (!exported) throw new Error("Source session disappeared"); return exported;
      })), { flag: "wx" }); return;
    }
    const { listPersonas } = await import("../src/persona.ts");
    const personas = await listPersonas(), exports = JSON.parse(fs.readFileSync(transferFile, "utf8"));
    const indexFile = path.join(userData, "data", indexName), index = readIndex(indexFile);
    const result = { restoredSessions: 0, restoredMessages: 0, restoredAttachments: 0 };
    database.withTransaction(() => {
      for (const exported of exports) {
        if (session.getSessionInfo(exported.session.id) || (index[exported.session.id] && session.getSessionInfo(index[exported.session.id]))) continue;
        const persona = personas.find(item => item.name === exported.session.persona_name);
        if (!persona) throw new Error("Source assistant is unavailable; no sessions were imported");
        const restored = session.importSession({ ...exported, session: { ...exported.session, title: `${exported.session.title}（恢复）` } }, persona);
        index[exported.session.id] = restored.id;
        result.restoredSessions++; result.restoredMessages += exported.messages.length; result.restoredAttachments += exported.canvas.attachments.length;
      }
      // Publish intent before commit: rolled-back IDs are absent, allowing a safe retry.
      fs.writeFileSync(indexFile + ".tmp", JSON.stringify(index, null, 2)); fs.renameSync(indexFile + ".tmp", indexFile);
    });
    console.log(JSON.stringify(result));
  } finally { await database.closeDb(); }
}
function runWorker(mode, userData, transferFile, extra) {
  const child = spawnSync(process.execPath, ["--import", "tsx", script, mode, userData, transferFile, ...(extra ? [extra] : [])], {
    cwd: project, env: process.env, encoding: "utf8", timeout: 45_000, windowsHide: true,
  });
  if (child.status !== 0) throw new Error(`Session recovery failed; close RainyDays before applying. ${child.stderr || child.error?.message || "Worker did not finish"}`);
  return child.stdout.trim().split(/\r?\n/u).at(-1);
}
async function main() {
  if (args[0]?.startsWith("--worker-")) { await worker(); return; }
  const value = name => { const at = args.indexOf(name); if (at < 0 || !args[at + 1] || args[at + 1].startsWith("--")) throw new Error(`Required: ${name}`); return path.resolve(args[at + 1]); };
  const source = value("--source"), userData = value("--user-data"), target = path.join(userData, "data", "mini-lux.db");
  if (source.toLowerCase() === target.toLowerCase()) throw new Error("Source and target must be different databases");
  const apply = args.includes("--apply"), fixture = fs.mkdtempSync(path.join(os.tmpdir(), "rainydays-history-plan-"));
  try {
    const original = path.join(fixture, "source"), candidate = path.join(fixture, "candidate");
    for (const directory of [original, candidate]) fs.mkdirSync(path.join(directory, "data"), { recursive: true });
    await snapshot(source, path.join(original, "data", "mini-lux.db"));
    await snapshot(target, path.join(candidate, "data", "mini-lux.db"));
    const indexFile = path.join(userData, "data", indexName), index = readIndex(indexFile);
    fs.writeFileSync(path.join(candidate, "data", indexName), JSON.stringify(index));
    const before = new Database(path.join(original, "data", "mini-lux.db"), { readonly: true });
    const current = new Database(path.join(candidate, "data", "mini-lux.db"), { readonly: true });
    let missing;
    try {
      for (const db of [before, current]) if (db.pragma("quick_check", { simple: true }) !== "ok") throw new Error("Database check failed; originals were not changed");
      const present = new Set(current.prepare("SELECT id FROM sessions").all().map(row => row.id));
      missing = before.prepare("SELECT id FROM sessions").all().filter(row => !present.has(row.id) && !(index[row.id] && present.has(index[row.id]))).map(row => row.id);
    } finally { before.close(); current.close(); }
    if (!apply || !missing.length) { console.log(JSON.stringify({ missingSessions: missing.length, restoredSessions: 0, applied: false })); return; }
    const transferFile = path.join(fixture, "sessions.json");
    runWorker("--worker-export", original, transferFile, JSON.stringify(missing));
    const rehearsed = JSON.parse(runWorker("--worker-import", candidate, transferFile));
    if (rehearsed.restoredSessions !== missing.length) throw new Error("Recovery rehearsal did not match the plan");
    const backup = path.join(userData, "data", `history-recovery-${Date.now()}`); fs.mkdirSync(backup);
    await snapshot(target, path.join(backup, "before.db"));
    fs.copyFileSync(path.join(original, "data", "mini-lux.db"), path.join(backup, "source.db"));
    fs.copyFileSync(transferFile, path.join(backup, "sessions.json"));
    if (fs.existsSync(indexFile)) fs.copyFileSync(indexFile, path.join(backup, indexName));
    const result = JSON.parse(runWorker("--worker-import", userData, transferFile));
    fs.writeFileSync(path.join(backup, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, backup, applied: true }));
  } finally { removePlanFixture(fixture); }
}
try { await main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
