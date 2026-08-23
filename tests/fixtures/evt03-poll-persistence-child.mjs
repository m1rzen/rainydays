import fs from "node:fs/promises";
import path from "node:path";

const mode = process.argv[2];
const userData = process.env.EVT03_USER_DATA_DIR;
const dataDir = process.env.EVT03_DATA_DIR;
if (!userData || !dataDir || (mode !== "seed" && mode !== "drain")) throw new Error("EVT-03 child arguments are invalid");
await fs.mkdir(dataDir, { recursive: true });
Object.assign(process.env, {
  RAINYDAYS_APP_ROOT: path.resolve(import.meta.dirname, "../.."),
  RAINYDAYS_USER_DATA_DIR: userData,
  RAINYDAYS_DATA_DIR: dataDir,
});

const [{ createPollStore, insertSession, closeDb, getSession }, { PollManager }, { issueResourceOwner }] = await Promise.all([
  import("../../dist/db.js"),
  import("../../dist/poll.js"),
  import("../../dist/resource-owner.js"),
]);

const sessionId = "evt03-restart-session";
const owner = issueResourceOwner({
  authorityId: "evt03-restart-authority",
  authorityEpoch: 1,
  sessionId,
  principal: "agent",
  rootIds: [],
});

try {
  if (!getSession(sessionId)) {
    const now = new Date().toISOString();
    insertSession({ id: sessionId, persona_name: "general", title: "EVT-03 restart", created_at: now, updated_at: now });
  }
  if (mode === "seed") {
    const manager = new PollManager({ publish: async () => { throw new Error("seed must not publish"); } });
    manager.attachStore(createPollStore());
    const subscription = manager.subscribe(owner, {
      source: "webhook:*",
      tagFilters: { team: "开发*" },
      persistent: true,
      debounceMs: 5_000,
    }).subscription;
    const first = await manager.ingest({
      sourceEventId: "restart-1",
      source: "webhook:message",
      tags: { team: "开发一组" },
      payload: { index: 1 },
    });
    const second = await manager.ingest({
      sourceEventId: "restart-2",
      source: "webhook:message",
      tags: { team: "开发二组" },
      payload: { index: 2 },
    });
    const duplicate = await manager.ingest({
      sourceEventId: "restart-2",
      source: "webhook:message",
      tags: { team: "开发二组" },
      payload: { index: 2 },
    });
    console.log(JSON.stringify({ subscriptionId: subscription.id, first, second, duplicate }));
  } else {
    const published = [];
    const manager = new PollManager({
      publish: async input => {
        published.push(input);
        return { status: "published", id: "evt_evt03_restart", persisted: true };
      },
    });
    manager.attachStore(createPollStore());
    const before = manager.list(owner);
    const dispatched = await manager.dispatchDueBatches(Date.now() + 10_000);
    const after = manager.list(owner);
    console.log(JSON.stringify({ before, dispatched, after, published }));
  }
} finally {
  closeDb();
}
