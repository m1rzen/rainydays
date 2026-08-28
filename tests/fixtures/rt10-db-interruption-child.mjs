import fs from "node:fs";
import { closeDb, insertSession, listSessions, withTransaction } from "../../dist/db.js";

const mode = process.env.RT10_DB_MODE;
const sessionId = process.env.RT10_DB_SESSION_ID;
if (!mode || !sessionId) throw new Error("RT-10 DB fixture configuration is missing");

const row = {
  id: sessionId,
  persona_name: "general",
  title: `RT-10 ${sessionId}`,
  created_at: "2026-08-28T00:00:00.000Z",
  updated_at: "2026-08-28T00:00:00.000Z",
};

if (mode === "commit") {
  withTransaction(() => insertSession(row));
  await closeDb();
} else if (mode === "interrupt") {
  const marker = process.env.RT10_DB_MARKER;
  if (!marker) throw new Error("RT-10 DB interruption marker is missing");
  withTransaction(() => {
    insertSession(row);
    fs.writeFileSync(marker, "transaction-open", "utf8");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60_000);
  });
  await closeDb();
} else if (mode === "verify") {
  const sessions = listSessions();
  const result = {
    baseline: sessions.filter(session => session.id === "rt10-baseline").length,
    interrupted: sessions.filter(session => session.id === "rt10-interrupted").length,
  };
  process.stdout.write(`${JSON.stringify(result)}\n`);
  await closeDb();
} else {
  throw new Error(`Unknown RT-10 DB fixture mode: ${mode}`);
}
