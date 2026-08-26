import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { makeTempDir, projectRoot, removeFixture } from "../helpers.mjs";

const root = await makeTempDir("mini-lux-pers01-");
const dataDir = path.join(root, "data");
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-pers01-path-"));
await fs.mkdir(dataDir, { recursive: true });
Object.assign(process.env, {
  RAINYDAYS_APP_ROOT: projectRoot,
  RAINYDAYS_USER_DATA_DIR: root,
  RAINYDAYS_DATA_DIR: dataDir,
});

const [{ createEffectivePersona }, sessionModule, dbModule, brokerModule, { PathPolicy }] = await Promise.all([
  import("../../dist/persona.js"),
  import("../../dist/session.js"),
  import("../../dist/db.js"),
  import("../../dist/capability-broker.js"),
  import("../../dist/path-policy.js"),
]);

after(async () => {
  dbModule.closeDb();
  await Promise.all([
    removeFixture(root),
    fs.rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }),
  ]);
});

function persona(name, permissionLevel) {
  return createEffectivePersona({
    name,
    displayName: name,
    description: `${permissionLevel} fixture`,
    permissionLevel,
    tools: [],
    allowTools: [],
    denyTools: [],
    env: {},
    allowedRoots: [],
    networkPolicy: { mode: "deny" },
    systemPrompt: name,
  });
}

test("PERS-01 Persona rebind is digest-bound and isolated to one Session", () => {
  const source = persona("reader", "read_only");
  const target = persona("developer", "coding");
  const first = sessionModule.createSession(source, "first");
  const second = sessionModule.createSession(source, "second");

  assert.equal(sessionModule.rebindSessionPersona(first.id, source, target), true);
  assert.deepEqual(
    {
      name: sessionModule.getSessionInfo(first.id).persona_name,
      digest: sessionModule.sessionPersonaBinding(first.id).persona_digest,
      level: sessionModule.sessionPersonaBinding(first.id).permission_level,
    },
    { name: target.name, digest: target.sourceDigest, level: "coding" },
  );
  assert.equal(sessionModule.getSessionInfo(second.id).persona_name, source.name);
  assert.equal(sessionModule.sessionPersonaBinding(second.id).persona_digest, source.sourceDigest);
  assert.equal(sessionModule.rebindSessionPersona(first.id, source, target), false, "stale source digest must fail CAS");
});

test("PERS-01 Broker blocks read-only dynamic write aliases and direct writes", async () => {
  const pathPolicy = new PathPolicy({ auditKey: Buffer.alloc(32, 19) });
  const pathAuthority = await pathPolicy.createAuthority([{
    rootId: "workspace",
    role: "workspace",
    configuredPath: workspace,
    permissions: ["read-file", "create-file", "replace-file"],
  }]);
  const broker = new brokerModule.CapabilityBroker({
    pathPolicy,
    resolveSessionPersona: sessionId => sessionId === "reader-session" ? "reader" : null,
  });
  const definition = {
    type: "function",
    function: { name: "dynamic_write_alias", description: "write alias", parameters: { type: "object", properties: {} } },
  };
  const writePolicy = {
    minimumPermissionLevel: "coding",
    riskClasses: ["write"],
    approval: "none",
    effects: ["filesystem"],
    pathOperations: ["create-file", "replace-file"],
  };
  broker.registerDirectOperation("file:save-alias", writePolicy);
  const authority = broker.createRuntimeAuthority({
    name: "reader",
    permissionLevel: "read_only",
    tools: ["dynamic_write_alias"],
    env: { WORKSPACE_ROOT: workspace },
    systemPrompt: "reader",
    allowedRoots: [workspace],
    rootEnv: { WORKSPACE_ROOT: "workspace" },
    pathAuthority,
    networkPolicy: { mode: "deny" },
  });
  broker.registerRuntimeTool(authority, {
    name: "dynamic_write_alias",
    definition,
    policy: writePolicy,
    executor: async () => "unexpected",
  });

  assert.throws(
    () => broker.beginAgentRun(authority, "reader-session"),
    error => error instanceof brokerModule.CapabilityDeniedError && error.code === "CAPABILITY_TOOL_DENIED",
  );
  const principal = broker.createLocalApiPrincipal();
  assert.throws(
    () => broker.issueLocalApiContext({ authority, principal, sessionId: "reader-session", operation: "file:save-alias", args: {} }),
    error => error instanceof brokerModule.CapabilityDeniedError && error.code === "CAPABILITY_DIRECT_OPERATION_DENIED",
  );
  await broker.retireAuthority(authority);
});
