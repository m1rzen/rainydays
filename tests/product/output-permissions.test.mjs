import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CapabilityBroker } from "../../src/capability-broker.ts";
import { PathPolicy } from "../../src/path-policy.ts";

test("任务新建许可限制目录、工具、替换、竞争写入与生命周期", async () => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "rainydays-output-scope-"));
  try {
    const output = path.join(fixture, "output"); const outside = path.join(fixture, "outside");
    await fs.mkdir(output); await fs.mkdir(outside);
    const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 39) });
    const broker = new CapabilityBroker({ pathPolicy: policy, resolveSessionPersona: () => "writer" });
    let duringWrite = async () => {};
    for (const name of ["create_docx", "create_xlsx", "write"]) broker.registerStaticTool({
      name, definition: { type: "function", function: { name, description: "Fixture", parameters: { type: "object", properties: {} } } },
      policy: { riskClasses: ["write"], approval: "user", effects: ["filesystem"], pathOperations: ["create-file", "replace-file"] },
      executor: async (args, _env, invocation) => {
        if (args.replace) return invocation.path.replaceFile(args.path, () => ({ bytes: Buffer.from("bad"), value: null }));
        const reservation = await invocation.path.reserveFile(args.path, { defaultRootId: "output" });
        await duringWrite();
        await reservation.commit(Buffer.from("new"));
        return "created";
      },
    });
    const authority = broker.createRuntimeAuthority({ name: "writer", permissionLevel: "coding", tools: ["create_docx", "create_xlsx", "write"], env: { OUTPUT_DIR: output }, systemPrompt: "Fixture", allowedRoots: [output, outside], rootEnv: { OUTPUT_DIR: "output" }, networkPolicy: { mode: "deny" }, pathAuthority: await policy.createAuthority([
      { rootId: "output", role: "output", configuredPath: output, permissions: ["create-file", "replace-file"] },
      { rootId: "outside", role: "workspace", configuredPath: outside, permissions: ["create-file", "replace-file"] },
    ]) });
    const parent = broker.beginAgentRun(authority, "s1", "run1");
    const inspect = (file, name = "create_docx", extra = {}) => broker.inspectToolCall(parent, name, { path: file, ...extra });
    const first = inspect("first.docx");
    assert.equal(await broker.reuseNewOutputApproval(parent, first), null);
    assert.equal((await broker.getNewOutputTarget(parent, first)).directory, output);
    const challenge = broker.createApprovalChallenge(parent, first);
    const granted = broker.resolveApprovalChallenge({ challengeId: challenge.challengeId, choice: "approve", sessionId: "s1", runId: "run1", responsePrincipal: "local-user-api", responseChannel: "ask-user", allowNewOutputs: true });
    const invoke = async (context, inspected) => {
      const issued = broker.issueToolPathGateway(context, inspected);
      try { return await broker.invokeTool(context, inspected, { path: issued.gateway }); }
      finally { issued.close(); }
    };
    assert.equal(await invoke(granted, first), "created");
    assert.equal(await broker.reuseNewOutputApproval(parent, inspect("first.docx")), null);
    assert.equal(await broker.reuseNewOutputApproval(parent, inspect("other.txt", "write")), null);
    assert.equal(await broker.reuseNewOutputApproval(parent, inspect(path.join(outside, "escaped.docx"))), null);
    assert.equal(await broker.reuseNewOutputApproval(parent, inspect("../outside/escaped.docx")), null);
    assert.throws(() => broker.deriveChild(parent, { principal: "subagent", tools: ["create_docx"] }), /approval-bound/);
    const replace = inspect("new.docx", "create_docx", { replace: true });
    await assert.rejects(invoke(await broker.reuseNewOutputApproval(parent, replace), replace), /path operation/);
    // File appears after reservation: the atomic create must preserve the competing file.
    const race = inspect("race.docx");
    const raceGrant = await broker.reuseNewOutputApproval(parent, race);
    duringWrite = () => fs.writeFile(path.join(output, "race.docx"), "original");
    await assert.rejects(invoke(raceGrant, race));
    assert.equal(await fs.readFile(path.join(output, "race.docx"), "utf8"), "original");
    // File appears after scope matching but before reservation: no overwrite authority.
    const earlyRace = inspect("early.docx");
    const earlyGrant = await broker.reuseNewOutputApproval(parent, earlyRace);
    await fs.writeFile(path.join(output, "early.docx"), "original");
    await assert.rejects(invoke(earlyGrant, earlyRace), /单独确认/);
    assert.equal(await fs.readFile(path.join(output, "early.docx"), "utf8"), "original");
    duringWrite = async () => broker.finishContext(parent);
    const cancelled = inspect("cancelled.docx");
    await assert.rejects(invoke(await broker.reuseNewOutputApproval(parent, cancelled), cancelled), /stale|closed|inactive|retired/i);
    await assert.rejects(fs.access(path.join(output, "cancelled.docx")));
    await assert.rejects(broker.reuseNewOutputApproval(parent, first));
    const next = broker.beginAgentRun(authority, "s1", "run2");
    const nextCall = broker.inspectToolCall(next, "create_docx", { path: "next.docx" });
    assert.equal(await broker.reuseNewOutputApproval(next, nextCall), null);
    broker.finishContext(next);
  } finally {
    assert.equal(path.dirname(fixture), path.resolve(os.tmpdir()));
    assert(path.basename(fixture).startsWith("rainydays-output-scope-"));
    await fs.rm(fixture, { recursive: true, force: true });
  }
});
