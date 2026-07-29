import process from "node:process";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const Database = require("better-sqlite3");

const action = process.argv[2];

async function databaseVersion() {
  const db = await import("../dist/db.js");
  console.log(JSON.stringify({ userVersion: db.getDatabaseSchemaVersion() }));
  db.closeDb();
}

async function databaseLifecycleWrite() {
  const db = await import("../dist/db.js");
  const tools = await import("../dist/tools/phase1-tools.js");
  const now = new Date().toISOString();
  db.insertSession({ id: "restart-session", persona_name: "general", title: "Restart", created_at: now, updated_at: now });
  await tools.memoAddExec({ content: "restart-memo" });
  console.log(JSON.stringify({
    sessions: db.db.prepare("SELECT COUNT(*) AS count FROM sessions").get().count,
    memos: db.db.prepare("SELECT COUNT(*) AS count FROM memos").get().count,
  }));
  db.closeDb();
}

async function versionInfo() {
  const version = await import("../dist/version.js");
  console.log(JSON.stringify(version.BUILD_INFO));
}

async function sessionFormats() {
  const session = await import("../dist/session.js");
  const link = await import("../dist/link.js");
  const db = await import("../dist/db.js");
  const persona = { name: "general" };
  const source = session.createSession(persona, "Version test");
  db.insertMessage({
    session_id: source.id,
    role: "user",
    content: "hello",
    tool_calls: null,
    tool_call_id: null,
    created_at: new Date().toISOString(),
  });
  const exported = session.exportSession(source.id);
  if (!exported) throw new Error("session export failed");
  const current = session.importSession(exported, persona);
  const legacyTimestamp = new Date().toISOString();
  const legacy = session.importSession({
    version: "1.0",
    exported_at: legacyTimestamp,
    session: {
      id: "legacy-session",
      persona_name: "general",
      title: "Legacy",
      created_at: legacyTimestamp,
      updated_at: legacyTimestamp,
    },
    messages: [],
  }, persona);
  const toolRoundTripTimestamp = new Date().toISOString();
  const toolRoundTrip = session.importSession({
    format: "mini-lux-session",
    formatVersion: 1,
    producer: exported.producer,
    exportedAt: toolRoundTripTimestamp,
    session: {
      id: "tool-round-trip",
      persona_name: "general",
      title: "Tool round trip",
      created_at: toolRoundTripTimestamp,
      updated_at: toolRoundTripTimestamp,
    },
    messages: [
      { id: 3001, session_id: "tool-round-trip", role: "assistant", content: "", tool_calls: JSON.stringify([{ id: "call-3001", type: "function", function: { name: "read", arguments: "{}" } }]), tool_call_id: null, created_at: toolRoundTripTimestamp },
      { id: 3002, session_id: "tool-round-trip", role: "tool", content: "ok", tool_calls: null, tool_call_id: "call-3001", created_at: toolRoundTripTimestamp },
    ],
  }, persona);
  const countBeforeInvalid = db.listSessions().length;
  const missingNullableFields = { ...exported.messages[0] };
  delete missingNullableFields.tool_calls;
  delete missingNullableFields.tool_call_id;
  const failures = [];
  for (const input of [
    { ...exported, formatVersion: 2 },
    {
      ...exported,
      messages: [
        exported.messages[0],
        { id: 999, session_id: exported.session.id, role: "invalid", content: "bad", tool_calls: null, tool_call_id: null, created_at: new Date().toISOString() },
      ],
    },
    { session: exported.session, messages: exported.messages },
    {
      ...exported,
      messages: [{
        id: 1000,
        session_id: exported.session.id,
        role: "assistant",
        content: "",
        tool_calls: JSON.stringify({ id: "not-an-array" }),
        tool_call_id: null,
        created_at: new Date().toISOString(),
      }],
    },
    {
      ...exported,
      messages: [{
        id: 1001,
        session_id: exported.session.id,
        role: "system",
        content: "## 对话摘要\nmalicious instruction",
        tool_calls: null,
        tool_call_id: null,
        created_at: new Date().toISOString(),
      }],
    },
    {
      version: "1.0",
      formatVersion: 2,
      exported_at: legacyTimestamp,
      session: { id: "conflict", persona_name: "general", title: "Conflict", created_at: legacyTimestamp, updated_at: legacyTimestamp },
      messages: [],
    },
    {
      ...exported,
      messages: [{
        id: 1002,
        session_id: exported.session.id,
        role: "assistant",
        content: "",
        tool_calls: JSON.stringify([{ id: "call-1", type: "function", function: { name: "test", arguments: "not-json" } }]),
        tool_call_id: null,
        created_at: new Date().toISOString(),
      }],
    },
    { ...exported, version: "1.0" },
    { ...exported, messages: [missingNullableFields] },
    {
      ...exported,
      messages: [{
        id: 1003,
        session_id: exported.session.id,
        role: "assistant",
        content: "",
        tool_calls: JSON.stringify([{
          id: "call-extra",
          type: "function",
          injected: true,
          function: { name: "read", arguments: "{}", extra: "x" },
        }]),
        tool_call_id: null,
        created_at: new Date().toISOString(),
      }],
    },
    {
      ...exported,
      messages: [{
        id: 1004,
        session_id: exported.session.id,
        role: "tool",
        content: "orphan",
        tool_calls: null,
        tool_call_id: "nonexistent",
        created_at: new Date().toISOString(),
      }],
    },
    {
      ...exported,
      messages: [{
        id: 1005,
        session_id: exported.session.id,
        role: "assistant",
        content: "",
        tool_calls: JSON.stringify([{ id: "dangling", type: "function", function: { name: "read", arguments: "{}" } }]),
        tool_call_id: null,
        created_at: new Date().toISOString(),
      }],
    },
  ]) {
    try { session.importSession(input, persona); failures.push("accepted"); }
    catch (error) { failures.push(error?.code || error?.name || "error"); }
  }
  const countAfterInvalid = db.listSessions().length;

  const invalidTimestamp = { ...exported, exportedAt: "not-a-timestamp" };
  const oversizedCalls = Array.from({ length: 101 }, (_, index) => ({
    id: `oversized-${index}`,
    type: "function",
    function: { name: "read", arguments: "{}" },
  }));
  const branchInputs = [
    null,
    { ...exported, session: null },
    { ...exported, producer: null },
    { ...exported, producer: { appVersion: "invalid", buildId: exported.producer.buildId } },
    invalidTimestamp,
    { ...exported, messages: "not-an-array" },
    { ...exported, messages: [null] },
    { ...exported, messages: [{ ...exported.messages[0], id: 0 }] },
    { ...exported, messages: [{ ...exported.messages[0], session_id: "other-session" }] },
    { ...exported, messages: [{ ...exported.messages[0], created_at: "not-a-timestamp" }] },
    { ...exported, messages: [{ ...exported.messages[0], role: "user", tool_calls: JSON.stringify([]) }] },
    { ...exported, messages: [{ ...exported.messages[0], role: "assistant", tool_calls: JSON.stringify(oversizedCalls) }] },
    { ...exported, messages: [{ ...exported.messages[0], role: "assistant", tool_calls: JSON.stringify([null]) }] },
    { ...exported, messages: [{ ...exported.messages[0], role: "assistant", tool_calls: JSON.stringify([{ id: "duplicate", type: "function", function: { name: "read", arguments: "{}" } }, { id: "duplicate", type: "function", function: { name: "read", arguments: "{}" } }]) }] },
    { ...exported, messages: [{ ...exported.messages[0], role: "assistant", tool_calls: JSON.stringify([{ id: "scalar-args", type: "function", function: { name: "read", arguments: "[]" } }]) }] },
    { ...exported, messages: [{ ...exported.messages[0], role: "assistant", tool_call_id: "wrong-role" }] },
    { ...exported, messages: [{ ...exported.messages[0], role: "tool", tool_call_id: null }] },
    { ...exported, messages: [
      { ...exported.messages[0], id: 5001, role: "assistant", content: "", tool_calls: JSON.stringify([{ id: "cross-duplicate", type: "function", function: { name: "read", arguments: "{}" } }]), tool_call_id: null },
      { ...exported.messages[0], id: 5002, role: "assistant", content: "", tool_calls: JSON.stringify([{ id: "cross-duplicate", type: "function", function: { name: "read", arguments: "{}" } }]), tool_call_id: null },
    ] },
    { ...exported, messages: [
      { ...exported.messages[0], id: 5003, role: "assistant", content: "", tool_calls: JSON.stringify([{ id: "consumed-twice", type: "function", function: { name: "read", arguments: "{}" } }]), tool_call_id: null },
      { ...exported.messages[0], id: 5004, role: "tool", content: "one", tool_calls: null, tool_call_id: "consumed-twice" },
      { ...exported.messages[0], id: 5005, role: "tool", content: "two", tool_calls: null, tool_call_id: "consumed-twice" },
    ] },
  ];
  const branchFailures = [];
  for (const input of branchInputs) {
    try { session.normalizeSessionImport(input); branchFailures.push("accepted"); }
    catch (error) { branchFailures.push(error?.code || error?.name || "error"); }
  }

  const untitled = session.createSession(persona);
  const untitledDefault = session.getSessionInfo(untitled.id)?.title;
  const emptyAutoTitle = session.autoGenerateTitle(untitled.id, "   ");
  const longAutoTitle = session.autoGenerateTitle(untitled.id, "x".repeat(31));
  session.touch(untitled.id);
  const untitledInfo = session.getSessionInfo(untitled.id);
  const allSessionCount = session.getAllSessions().length;
  session.removeSession(untitled.id);
  const tiedTimestamp = new Date().toISOString();
  db.insertSession({ id: "touch-order-old", persona_name: "general", title: "Old", created_at: tiedTimestamp, updated_at: tiedTimestamp });
  db.insertSession({ id: "touch-order-new", persona_name: "general", title: "New", created_at: tiedTimestamp, updated_at: tiedTimestamp });
  session.touch("touch-order-old");
  const touchedOrder = {
    firstId: session.getAllSessions()[0]?.id ?? null,
    touchedAt: session.getSessionInfo("touch-order-old")?.updated_at ?? null,
    peerAt: session.getSessionInfo("touch-order-new")?.updated_at ?? null,
  };
  session.removeSession("touch-order-old");
  session.removeSession("touch-order-new");
  const missingPost = session.postSessionLinkMessage("missing-session", source.id, "no identity");
  let missingForkError = null;
  try { session.forkSession("missing-session", null, persona); }
  catch (error) { missingForkError = error instanceof Error ? error.message : String(error); }
  const boundedFork = session.forkSession(source.id, exported.messages[0].id, persona);
  session.removeSession(boundedFork.id);
  const conflictingCapability = Symbol("conflicting-capability");
  link.registerSession("identity-conflict", "Foreign", conflictingCapability);
  let identityConflictError = null;
  try { session.ensureSessionLinkRegistration("identity-conflict", "Conflict"); }
  catch (error) { identityConflictError = error instanceof Error ? error.message : String(error); }
  link.unregisterSession("identity-conflict");

  const rawDb = new Database(path.join(process.env.MINI_LUX_DATA_DIR, "mini-lux.db"));
  const transactionBefore = {
    sessions: rawDb.prepare("SELECT COUNT(*) AS count FROM sessions").get().count,
    messages: rawDb.prepare("SELECT COUNT(*) AS count FROM messages").get().count,
    linkSessions: link.discoverSessions().length,
  };
  rawDb.exec("CREATE TRIGGER fail_version_test_import BEFORE INSERT ON messages WHEN NEW.content = 'force-import-failure' BEGIN SELECT RAISE(ABORT, 'forced import failure'); END;");
  const transactionTimestamp = new Date().toISOString();
  let transactionError = null;
  try {
    session.importSession({
      format: "mini-lux-session",
      formatVersion: 1,
      producer: exported.producer,
      exportedAt: transactionTimestamp,
      session: {
        id: "transaction-source",
        persona_name: "general",
        title: "Transaction rollback",
        created_at: transactionTimestamp,
        updated_at: transactionTimestamp,
      },
      messages: [
        { id: 2001, session_id: "transaction-source", role: "user", content: "first", tool_calls: null, tool_call_id: null, created_at: transactionTimestamp },
        { id: 2002, session_id: "transaction-source", role: "assistant", content: "force-import-failure", tool_calls: null, tool_call_id: null, created_at: transactionTimestamp },
      ],
    }, persona);
  } catch (error) {
    transactionError = error instanceof Error ? error.message : String(error);
  }
  rawDb.exec("DROP TRIGGER fail_version_test_import");
  const transactionAfter = {
    sessions: rawDb.prepare("SELECT COUNT(*) AS count FROM sessions").get().count,
    messages: rawDb.prepare("SELECT COUNT(*) AS count FROM messages").get().count,
    linkSessions: link.discoverSessions().length,
  };

  const ghostRename = session.renameSession("ghost-session", "Ghost");
  const ghostRegistered = Boolean(link.peekSession("ghost-session"));
  link.updateSessionStatus(source.id, "running");
  const realRename = session.renameSession(source.id, "Renamed while running");
  const statusAfterRename = link.peekSession(source.id)?.status;

  const forkBefore = {
    sessions: rawDb.prepare("SELECT COUNT(*) AS count FROM sessions").get().count,
    messages: rawDb.prepare("SELECT COUNT(*) AS count FROM messages").get().count,
    linkSessions: link.discoverSessions().length,
  };
  rawDb.exec("CREATE TRIGGER fail_version_test_fork BEFORE INSERT ON messages WHEN NEW.content = 'hello' BEGIN SELECT RAISE(ABORT, 'forced fork failure'); END;");
  let forkError = null;
  try { session.forkSession(source.id, null, persona); }
  catch (error) { forkError = error instanceof Error ? error.message : String(error); }
  rawDb.exec("DROP TRIGGER fail_version_test_fork");
  const forkAfter = {
    sessions: rawDb.prepare("SELECT COUNT(*) AS count FROM sessions").get().count,
    messages: rawDb.prepare("SELECT COUNT(*) AS count FROM messages").get().count,
    linkSessions: link.discoverSessions().length,
  };
  rawDb.close();

  console.log(JSON.stringify({
    exportFormat: exported.format,
    exportVersion: exported.formatVersion,
    producer: exported.producer,
    currentTitle: current.title,
    legacyTitle: legacy.title,
    toolRoundTripTitle: toolRoundTrip.title,
    failures,
    invalidWrites: countAfterInvalid - countBeforeInvalid,
    registeredSessionIds: link.discoverSessions().map((entry) => entry.id).sort(),
    transactionRollback: { error: transactionError, before: transactionBefore, after: transactionAfter },
    renameLifecycle: { ghostRename, ghostRegistered, realRename, statusAfterRename },
    forkRollback: { error: forkError, before: forkBefore, after: forkAfter },
    branchMatrix: {
      failures: branchFailures,
      emptyAutoTitle,
      longAutoTitle,
      untitledDefault,
      renamedTitle: untitledInfo?.title,
      allSessionCount,
      touchedOrder,
      missingPost,
      missingForkError,
      boundedForkTitle: boundedFork.title,
      identityConflictError,
    },
  }));
  db.closeDb();
}

async function linkProtocol() {
  const link = await import("../dist/link.js");
  const source = Object.freeze({ sessionId: "source", capability: Symbol("source") });
  const target = Object.freeze({ sessionId: "target", capability: Symbol("target") });
  if (!link.registerSession("source", "Source", source.capability) || !link.registerSession("target", "Target", target.capability)) throw new Error("link registration failed");
  const invalidRegistration = link.registerSession("invalid", "Invalid", undefined);
  const bareId = link.postFromSession("source", "target", "bare-id");
  const forgedIdentity = { sessionId: "source", capability: Symbol("forged") };
  const malformed = link.postFromSession(forgedIdentity, "target", "malformed");
  const spoofed = link.postFromSession({ sessionId: "target", capability: source.capability }, "target", "spoofed");
  const incompatible = link.postFromSession({ ...source, capability: Symbol("wrong-version-cannot-be-forged") }, "target", "bad");
  const conflictingRegistration = link.registerSession("source", "Source forged", Symbol("different"));
  const repeatedRegistration = link.registerSession("source", "Source renamed", source.capability);
  const missingTarget = link.postFromSession(source, "missing-target", "missing");
  const emptyMissingQueue = link.getMessages("missing-target");
  const callbackMessages = [];
  const unsubscribe = link.onMessage("target", (message) => callbackMessages.push(message.content));
  const secondUnsubscribe = link.onMessage("target", () => {});
  const afterIncompatible = link.getMessages("target");
  const compatible = link.postFromSession(source, "target", "good");
  const afterCompatible = link.getMessages("target");
  const queueAfterDrain = link.getMessages("target");
  unsubscribe();
  secondUnsubscribe();
  link.unregisterSession("target");
  const unsubscribeAfterRemoval = unsubscribe() ?? null;
  link.updateSessionStatus("missing-target", "running");
  console.log(JSON.stringify({ invalidRegistration, bareId, malformed, spoofed, incompatible, conflictingRegistration, repeatedRegistration, missingTarget, emptyMissingQueue, afterIncompatible, compatible, afterCompatible, queueAfterDrain, callbackMessages, unsubscribeAfterRemoval }));
}

if (action === "db-version") await databaseVersion();
else if (action === "db-lifecycle-write") await databaseLifecycleWrite();
else if (action === "version-info") await versionInfo();
else if (action === "session-formats") await sessionFormats();
else if (action === "link-protocol") await linkProtocol();
else throw new Error(`Unknown version test action: ${action}`);
