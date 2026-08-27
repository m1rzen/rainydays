import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CapabilityBroker } from "../../dist/capability-broker.js";
import { PathPolicy } from "../../dist/path-policy.js";
import { assertResourceOwner, registerOwnedResource } from "../../dist/resource-owner.js";

const readPolicy = Object.freeze({ riskClasses: ["read"], approval: "none", effects: [] });
const approvalPolicy = Object.freeze({ riskClasses: ["write"], approval: "user", effects: ["filesystem"] });
const definition = name => ({ type: "function", function: { name, description: name, parameters: { type: "object", properties: {} } } });

function registration(name, policy) {
  return { name, definition: definition(name), policy, executor: async () => name };
}

test("RT-08 detached child survives parent finish, strips recursion and approval tools, then drains only its owner", async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-rt08-capability-"));
  t.after(async () => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const pathPolicy = new PathPolicy({ auditKey: Buffer.alloc(32, 18) });
  const base = await pathPolicy.createAuthority([{ rootId: "workspace", role: "workspace", configuredPath: root, permissions: ["read-file"] }]);
  const broker = new CapabilityBroker({ resolveSessionPersona: id => id === "session-a" ? "developer" : null, pathPolicy });
  for (const entry of [
    registration("read_value", readPolicy),
    registration("write_value", approvalPolicy),
    registration("subagent", readPolicy),
    registration("subagent_wait", readPolicy),
  ]) broker.registerStaticTool(entry);
  const authority = broker.createRuntimeAuthority({
    name: "developer",
    tools: ["read_value", "write_value", "subagent", "subagent_wait"],
    env: {},
    rootEnv: {},
    systemPrompt: "RT-08",
    allowedRoots: [root],
    pathAuthority: pathPolicy.deriveAuthority(base, ["workspace"]),
    networkPolicy: { mode: "deny" },
  });
  const parent = broker.beginAgentRun(authority, "session-a", "parent-run");
  assert.deepEqual([...broker.getUnattendedChildToolNames(parent)].sort(), ["read_value", "subagent", "subagent_wait"]);
  const child = broker.deriveDetachedInvocationChild(parent, {
    principal: "subagent",
    tools: broker.getUnattendedChildToolNames(parent),
    allowedRoots: parent.allowedRoots,
    networkPolicy: { mode: "deny" },
  }, "subagent:child-a");
  assert.deepEqual(child.allowedTools, ["read_value"]);
  const owner = broker.getResourceOwner(child);
  let closed = 0;
  registerOwnedResource(owner, () => { closed += 1; });

  broker.finishContext(parent);
  assert.equal(broker.isContextActive(child), true);
  assert.equal(await broker.invokeTool(child, broker.inspectToolCall(child, "read_value", {})), "read_value");
  await broker.finishDetachedContext(child);
  assert.equal(closed, 1);
  assert.throws(() => assertResourceOwner(owner), error => error?.code === "PATH_AUTHORITY_STALE");
  assert.equal(broker.isContextActive(child), false);

  const next = broker.beginAgentRun(authority, "session-a", "next-run");
  assert.equal(await broker.invokeTool(next, broker.inspectToolCall(next, "read_value", {})), "read_value");
  broker.finishContext(next);
  await broker.retireAuthority(authority);
});
