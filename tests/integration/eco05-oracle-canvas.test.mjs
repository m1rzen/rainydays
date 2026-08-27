import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeTempDir, projectRoot, removeFixture } from "../helpers.mjs";

const fixture = await makeTempDir("mini-lux-eco05-oracle-");
const dataDir = path.join(fixture, "data");
await fs.mkdir(dataDir, { recursive: true });
Object.assign(process.env, {
  RAINYDAYS_APP_ROOT: projectRoot,
  RAINYDAYS_USER_DATA_DIR: fixture,
  RAINYDAYS_DATA_DIR: dataDir,
  RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"),
  RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"),
});

const [{ createEffectivePersona }, sessionModule, db, oracleModule, { canonicalDigest }, { RUNTIME_TOOL_POLICIES }] = await Promise.all([
  import("../../dist/persona.js"),
  import("../../dist/session.js"),
  import("../../dist/db.js"),
  import("../../dist/oracle.js"),
  import("../../dist/capability-broker.js"),
  import("../../dist/tool-policies.js"),
]);

const persona = createEffectivePersona({
  name: "eco05-readonly",
  displayName: "ECO-05",
  description: "Oracle fixture",
  permissionLevel: "read_only",
  tools: [],
  env: {},
  allowedRoots: [],
  networkPolicy: { mode: "deny" },
  systemPrompt: "fixture",
});
const alpha = sessionModule.createSession(persona, "Alpha Canvas");
const beta = sessionModule.createSession(persona, "Beta Canvas");
const now = new Date().toISOString();
db.insertMessage({ session_id: alpha.id, role: "user", content: "ALPHA-CANVAS-CONTENT", tool_calls: null, tool_call_id: null, created_at: now });
db.insertMessage({ session_id: alpha.id, role: "assistant", content: "alpha decision Authorization: Bearer eco05-test-secret\nAuthorization: Basic dXNlcjpwYXNzd29yZA==\nDATABASE_URL=postgres://alice:SuperSecret@db.example/prod\ntoken=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature123\nCookie: session=deadbeefcafebabefeedface", tool_calls: null, tool_call_id: null, created_at: now });
db.insertPin(alpha.id, "ALPHA-PIN", now);
db.insertMessage({ session_id: beta.id, role: "user", content: "BETA-CANVAS-CONTENT", tool_calls: null, tool_call_id: null, created_at: now });
db.insertPin(beta.id, "BETA-PIN", now);

function makeProjectGateway(project) {
  const files = new Map();
  const canonicalRoot = `/workspace/${project}`;
  const gateway = {
    rootIdForEnv: key => key === "DATA_ROOT" || key === "WORKSPACE_ROOT" ? "workspace" : null,
    identifyDirectory: async input => {
      if (input !== "" && input !== canonicalRoot) {
        const error = new Error("Path outside project root");
        error.code = "PATH_ROOT_DENIED";
        throw error;
      }
      return {
        rootId: "workspace",
        identityDigest: canonicalDigest({ canonicalPath: canonicalRoot }),
      };
    },
    writeFile: async (input, bytes) => {
      assert.equal(input, "LUX.oracle");
      files.set(input, Buffer.from(bytes));
      return { rootId: "workspace", bytesWritten: bytes.length, createdDirectories: 0 };
    },
    readFile: async input => {
      assert.equal(input, "LUX.oracle");
      const bytes = files.get(input);
      if (!bytes) {
        const error = new Error("Path not found");
        error.code = "PATH_NOT_FOUND";
        throw error;
      }
      return { rootId: "workspace", bytes: Buffer.from(bytes) };
    },
  };
  return { files, gateway, canonicalRoot };
}

const alphaProject = makeProjectGateway("alpha");
const betaProject = makeProjectGateway("beta");
await oracleModule.saveOracle(alphaProject.gateway, alpha.id);
await oracleModule.saveOracle(betaProject.gateway, beta.id);
const alphaBytes = Buffer.from(alphaProject.files.get("LUX.oracle"));
const betaBytes = Buffer.from(betaProject.files.get("LUX.oracle"));

const calls = [];
const transport = async () => new Response("unused");
const llm = {
  chat: async (messages, tools, signal, scopedTransport) => {
    calls.push({ messages, tools, signal, scopedTransport });
    const canvas = messages.at(-1).content;
    if (canvas.includes("ALPHA-CANVAS-CONTENT")) return { role: "assistant", content: "alpha answer" };
    if (canvas.includes("BETA-CANVAS-CONTENT")) return { role: "assistant", content: "beta answer" };
    if (canvas.includes("LEGACY-TREE")) return { role: "assistant", content: "legacy answer" };
    return { role: "assistant", content: "unknown" };
  },
};

async function oracleFailure(action, code) {
  await assert.rejects(action, error => {
    assert(error instanceof oracleModule.OracleError);
    assert.equal(error.code, code);
    return true;
  });
}

test.after(async () => {
  db.closeDb();
  await removeFixture(fixture);
});

test("ECO-05 stores the complete Canvas and Pins in each project-root LUX.oracle", () => {
  const alphaSnapshot = JSON.parse(alphaBytes.toString("utf8"));
  const betaSnapshot = JSON.parse(betaBytes.toString("utf8"));
  assert.equal(alphaSnapshot.format, "mini-lux-oracle");
  assert.equal(alphaSnapshot.formatVersion, 1);
  assert.equal(alphaSnapshot.projectPath, ".");
  assert.deepEqual(alphaSnapshot.session.messages.map(message => message.content), ["ALPHA-CANVAS-CONTENT", "alpha decision Authorization: Bearer eco05-test-secret\nAuthorization: Basic dXNlcjpwYXNzd29yZA==\nDATABASE_URL=postgres://alice:SuperSecret@db.example/prod\ntoken=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature123\nCookie: session=deadbeefcafebabefeedface"]);
  assert.deepEqual(alphaSnapshot.session.canvas.pins.map(pin => pin.content), ["ALPHA-PIN"]);
  assert.equal(betaSnapshot.projectPath, ".");
  assert.deepEqual(betaSnapshot.session.messages.map(message => message.content), ["BETA-CANVAS-CONTENT"]);
  assert.deepEqual(betaSnapshot.session.canvas.pins.map(pin => pin.content), ["BETA-PIN"]);
  assert.notEqual(alphaSnapshot.snapshotDigest, betaSnapshot.snapshotDigest);
});

test("ECO-05 isolates projects and runs a tool-free read-only child flow", async () => {
  const signal = new AbortController().signal;
  assert.equal(await oracleModule.queryOracle(llm, "which project?", alphaProject.gateway, signal, transport), "alpha answer");
  assert.equal(await oracleModule.queryOracle(llm, "which project?", betaProject.gateway, signal, transport), "beta answer");
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].tools, []);
  assert.deepEqual(calls[1].tools, []);
  assert.equal(calls[0].scopedTransport, transport);
  assert.equal(calls[0].messages[0].role, "system");
  assert.match(calls[0].messages[0].content, /read-only Oracle child Session/u);
  assert.match(calls[0].messages[1].content, /ALPHA-PIN/u);
  assert.match(calls[0].messages[1].content, /Bearer \[REDACTED\]/u);
  for (const secret of ["eco05-test-secret", "dXNlcjpwYXNzd29yZA==", "SuperSecret", "signature123", "deadbeefcafebabefeedface"]) {
    assert.doesNotMatch(calls[0].messages[1].content, new RegExp(secret, "u"));
  }
  assert(Buffer.byteLength(calls[0].messages[1].content, "utf8") < 400 * 1024);
  assert.doesNotMatch(calls[0].messages[1].content, /BETA-PIN/u);
  assert.match(calls[1].messages[1].content, /BETA-PIN/u);
  assert.doesNotMatch(calls[1].messages[1].content, /ALPHA-PIN/u);
});

test("ECO-05 passes only a bounded redacted projection to the production child runner", async () => {
  let childRequest;
  const answer = await oracleModule.queryOracle(
    llm,
    "child?",
    alphaProject.gateway,
    undefined,
    transport,
    async request => {
      childRequest = request;
      return "registry child answer";
    },
  );
  assert.equal(answer, "registry child answer");
  assert(childRequest);
  assert(Buffer.byteLength(childRequest.context, "utf8") <= 384 * 1024);
  assert.match(childRequest.context, /Bearer \[REDACTED\]/u);
  for (const secret of ["eco05-test-secret", "dXNlcjpwYXNzd29yZA==", "SuperSecret", "signature123", "deadbeefcafebabefeedface"]) {
    assert.doesNotMatch(childRequest.context, new RegExp(secret, "u"));
  }
});

test("ECO-05 bounds a valid large snapshot below the real child Canvas limit without splitting UTF-8", async () => {
  const large = sessionModule.createSession(persona, "Large Canvas");
  db.insertMessage({
    session_id: large.id,
    role: "user",
    content: `HEAD-${"界".repeat(210_000)}-TAIL`,
    tool_calls: null,
    tool_call_id: null,
    created_at: now,
  });
  const largeProject = makeProjectGateway("large");
  await oracleModule.saveOracle(largeProject.gateway, large.id);
  let projection = "";
  assert.equal(await oracleModule.queryOracle(llm, "large?", largeProject.gateway, undefined, transport, async request => {
    projection = request.context;
    return "large answer";
  }), "large answer");
  assert(Buffer.byteLength(projection, "utf8") <= 384 * 1024);
  assert.match(projection, /Oracle projection omitted bounded middle content/u);
  assert.match(projection, /HEAD-/u);
  assert.match(projection, /-TAIL/u);
  assert.doesNotMatch(projection, /�/u);
});

test("ECO-05 returns structured missing, invalid, unsupported, project mismatch, and stale errors", async () => {
  const missingProject = makeProjectGateway("missing");
  await oracleFailure(() => oracleModule.queryOracle(llm, "missing", missingProject.gateway), "ORACLE_MISSING");

  betaProject.files.set("LUX.oracle", Buffer.from(alphaBytes));
  await oracleFailure(() => oracleModule.queryOracle(llm, "wrong project", betaProject.gateway), "ORACLE_PROJECT_MISMATCH");
  betaProject.files.set("LUX.oracle", Buffer.from(betaBytes));

  const invalidProject = makeProjectGateway("invalid");
  invalidProject.files.set("LUX.oracle", Buffer.from("not json"));
  await oracleFailure(() => oracleModule.queryOracle(llm, "invalid", invalidProject.gateway), "ORACLE_INVALID");

  const unsupportedProject = makeProjectGateway("unsupported");
  const unsupported = JSON.parse(alphaBytes.toString("utf8"));
  unsupported.formatVersion = 2;
  unsupportedProject.files.set("LUX.oracle", Buffer.from(JSON.stringify(unsupported)));
  await oracleFailure(() => oracleModule.queryOracle(llm, "unsupported", unsupportedProject.gateway), "ORACLE_UNSUPPORTED_VERSION");

  const tamperedProject = makeProjectGateway("alpha");
  const tampered = JSON.parse(alphaBytes.toString("utf8"));
  tampered.session.messages[0].content = "TAMPERED";
  tamperedProject.files.set("LUX.oracle", Buffer.from(JSON.stringify(tampered)));
  await oracleFailure(() => oracleModule.queryOracle(llm, "tampered", tamperedProject.gateway), "ORACLE_STALE");

  alphaProject.files.set("LUX.oracle", Buffer.from(alphaBytes));
  const changingLlm = {
    chat: async (_messages, tools) => {
      assert.deepEqual(tools, []);
      alphaProject.files.set("LUX.oracle", Buffer.from(betaBytes));
      return { role: "assistant", content: "obsolete answer" };
    },
  };
  await oracleFailure(() => oracleModule.queryOracle(changingLlm, "race", alphaProject.gateway), "ORACLE_STALE");
  alphaProject.files.set("LUX.oracle", Buffer.from(alphaBytes));
});

test("ECO-05 blocks Oracle recursion before any nested project read", async () => {
  let nestedReads = 0;
  const recursiveGateway = {
    ...alphaProject.gateway,
    readFile: async input => {
      nestedReads += 1;
      return alphaProject.gateway.readFile(input);
    },
  };
  const recursiveLlm = {
    chat: async () => {
      await oracleFailure(
        () => oracleModule.queryOracle(recursiveLlm, "nested", recursiveGateway),
        "ORACLE_RECURSION",
      );
      return { role: "assistant", content: "outer answer" };
    },
  };
  assert.equal(await oracleModule.queryOracle(recursiveLlm, "outer", recursiveGateway), "outer answer");
  assert.equal(nestedReads, 2, "only the outer before/after stale reads are allowed");
});

test("ECO-05 migrates a nested Session export v1 by synthesizing an empty Canvas", async () => {
  const nestedV1 = JSON.parse(alphaBytes.toString("utf8"));
  nestedV1.session.formatVersion = 1;
  delete nestedV1.session.canvas;
  delete nestedV1.snapshotDigest;
  nestedV1.snapshotDigest = canonicalDigest(nestedV1);
  alphaProject.files.set("LUX.oracle", Buffer.from(JSON.stringify(nestedV1)));
  assert.equal(await oracleModule.queryOracle(llm, "nested v1?", alphaProject.gateway), "alpha answer");
  assert.equal((await oracleModule.getOracleStatus(alphaProject.gateway)).formatVersion, 1);
  alphaProject.files.set("LUX.oracle", Buffer.from(alphaBytes));
});

test("ECO-05 accepts only root-bound legacy snapshots and rejects unbound migration input", async () => {
  const legacyProject = makeProjectGateway("legacy");
  legacyProject.files.set("LUX.oracle", Buffer.from(JSON.stringify({
    createdAt: now,
    projectPath: legacyProject.canonicalRoot,
    summary: "legacy summary",
    tree: "LEGACY-TREE",
    headers: { "README.md": ["legacy header"] },
  })));
  assert.equal(await oracleModule.queryOracle(llm, "legacy?", legacyProject.gateway), "legacy answer");
  assert.deepEqual(await oracleModule.getOracleStatus(legacyProject.gateway), {
    loaded: true,
    projectPath: legacyProject.canonicalRoot,
    createdAt: now,
    formatVersion: 0,
    legacy: true,
  });

  const legacyBackup = {
    createdAt: now,
    projectPath: legacyProject.canonicalRoot,
    summary: "legacy backup",
    tree: "LEGACY-TREE",
    headers: {},
  };
  assert.doesNotThrow(() => oracleModule.validateOracleBackupSnapshot(legacyBackup));
  assert.throws(
    () => oracleModule.validateOracleBackupSnapshot({ ...legacyBackup, formatVersion: 0 }),
    error => error instanceof oracleModule.OracleError && error.code === "ORACLE_INVALID",
  );
  assert.throws(
    () => oracleModule.validateOracleBackupSnapshot({ ...legacyBackup, format: "unknown-oracle" }),
    error => error instanceof oracleModule.OracleError && error.code === "ORACLE_INVALID",
  );

  const unboundProject = makeProjectGateway("unbound");
  for (const projectPath of [".", "", "./", "./.", "project/.."]) {
    unboundProject.files.set("LUX.oracle", Buffer.from(JSON.stringify({
      createdAt: now,
      projectPath,
      summary: "unbound",
      tree: "LEGACY-TREE",
      headers: {},
    })));
    await oracleFailure(() => oracleModule.queryOracle(llm, "unbound?", unboundProject.gateway), "ORACLE_MIGRATION_REQUIRED");
  }
});

test("ECO-05 production registration selects the independent oracleProfile and approves provider disclosure", async () => {
  assert.equal(RUNTIME_TOOL_POLICIES.oracle_query.approval, "user");
  assert.deepEqual(RUNTIME_TOOL_POLICIES.oracle_query.riskClasses, ["read", "network", "control"]);
  assert.deepEqual(RUNTIME_TOOL_POLICIES.oracle_query.effects, ["filesystem", "network", "control"]);
  assert.deepEqual(RUNTIME_TOOL_POLICIES.oracle_query.pathOperations, ["read-directory", "read-file"]);
  const source = await fs.readFile(path.join(projectRoot, "src", "index.ts"), "utf8");
  assert.match(source, /configuredOracleProfile = getConfigSnapshot\(\)\.domains\.common\.oracleProfile/u);
  assert.match(source, /createLlmClient\(configuredOracleProfile\)/u);
  assert.match(source, /createOracleQueryExec\(oracleLlm, invocation/u);
  assert.match(source, /projectionDigest = createHash\("sha256"\)/u);
  assert.match(source, /await askUserConfirm\(/u);
  assert.match(source, /best-effort 凭据清理/u);
  assert.match(source, /toolAllowlist: \[\]/u);
  assert.match(source, /inheritCanvas: true/u);
});
