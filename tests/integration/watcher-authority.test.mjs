import assert from "node:assert/strict";
import nodeFs from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createSec02Recorder } from "../sec02-receipts.mjs";

const watcherRecorder = await createSec02Recorder(
  import.meta.url,
  "SEC-02 watcher events and controls remain bound to one runtime authority"
);
const auditKeys = ["authorityEpoch", "code", "event", "inputFingerprint", "operation", "operationId", "principal", "rootId", "runId", "sessionId", "timestamp"].sort();
const pathAuditEvents = [];
const originalConsoleWarn = console.warn;
console.warn = (...args) => {
  try {
    const parsed = typeof args[0] === "string" ? JSON.parse(args[0]) : null;
    if (parsed?.component === "path-policy") {
      const { component: _component, ...event } = parsed;
      pathAuditEvents.push(event);
    }
  } catch {
    // Non-JSON warnings are unrelated to PathPolicy evidence.
  }
  originalConsoleWarn(...args);
};

function auditEvidence(events, rawInputs) {
  return {
    auditAttempts: events.length,
    auditAllowedFieldsExact: events.every(event => JSON.stringify(Object.keys(event).sort()) === JSON.stringify(auditKeys)),
    rawPathsAbsent: events.every(event => !Object.values(event).some(value => typeof value === "string" && rawInputs.some(raw => value.includes(raw)))),
  };
}

function outsideEventCount(events, outsideRoot) {
  return events.filter(event => {
    const relative = path.relative(outsideRoot, event.path);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  }).length;
}

async function waitFor(predicate, message, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(message);
}

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec02-watcher-"));
const workspace = path.join(fixture, "workspace");
const outside = path.join(fixture, "outside");
const data = path.join(fixture, "data");
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(outside, { recursive: true });
await fs.mkdir(data, { recursive: true });
const externalSecret = "EXTERNAL-WATCHER-SECRET";
await fs.writeFile(path.join(outside, "secret.txt"), externalSecret);
process.env.RAINYDAYS_USER_DATA_DIR = fixture;
process.env.RAINYDAYS_DATA_DIR = data;

const [personaModule, sessionModule, dbModule, toolsModule, pathRuntimeModule, pathPolicyModule, wireModule] = await Promise.all([
  import("../../dist/persona.js"),
  import("../../dist/session.js"),
  import("../../dist/db.js"),
  import("../../dist/tools/index.js"),
  import("../../dist/path-runtime.js"),
  import("../../dist/path-policy.js"),
  import("../../dist/wire.js"),
]);

const persona = personaModule.createEffectivePersona({
  name: "sec02-watcher",
  displayName: "SEC02 Watcher",
  description: "isolated watcher authority test",
  tools: ["poll_subscribe", "poll_unsubscribe", "poll_list"],
  env: { DATA_ROOT: workspace, WORKSPACE_ROOT: workspace },
  allowedRoots: [workspace],
  networkPolicy: { mode: "deny" },
  systemPrompt: "SEC-02 watcher",
});
const session = sessionModule.createSession(persona, "SEC-02 watcher authority");

async function makeAuthority() {
  const pathAuthority = await pathRuntimeModule.pathPolicy.createAuthority([{
    rootId: "workspace",
    role: "workspace",
    configuredPath: workspace,
    permissions: ["watch-directory"],
  }]);
  return toolsModule.capabilityBroker.createRuntimeAuthority({
    name: persona.name,
    tools: persona.tools,
    env: persona.env,
    systemPrompt: persona.systemPrompt,
    allowedRoots: persona.allowedRoots,
    rootEnv: { DATA_ROOT: "workspace", WORKSPACE_ROOT: "workspace" },
    pathAuthority,
    networkPolicy: persona.networkPolicy,
    digest: persona.digest,
  });
}

async function approved(context, name, args) {
  const inspected = toolsModule.inspectToolCall(context, name, args);
  const challenge = toolsModule.capabilityBroker.createApprovalChallenge(context, inspected);
  const grant = toolsModule.capabilityBroker.resolveApprovalChallenge({
    challengeId: challenge.challengeId,
    choice: "approve",
    sessionId: context.sessionId,
    runId: context.runId,
    responsePrincipal: "local-user-api",
    responseChannel: "ask-user",
  });
  assert(grant);
  try { return await toolsModule.executeInspectedTool(grant, inspected); }
  finally { toolsModule.capabilityBroker.finishContext(grant); }
}

async function observeExternalTarget() {
  const targetName = "external-target-link";
  const linkedTarget = path.join(workspace, targetName);
  await fs.symlink(outside, linkedTarget, "junction");
  const audits = [];
  const published = [];
  let watchCreateCalls = 0;
  let externalAccesses = 0;
  let lease;
  let error;
  const policy = new pathPolicyModule.PathPolicy({
    auditKey: Buffer.alloc(32, 51),
    auditSink: event => audits.push(event),
    watchFactory: (target, options, listener) => {
      watchCreateCalls += 1;
      const relative = path.relative(outside, target);
      if (relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) externalAccesses += 1;
      return nodeFs.watch(target, options, listener);
    },
  });
  const authority = await policy.createAuthority([{
    rootId: "workspace",
    role: "workspace",
    configuredPath: workspace,
    permissions: ["watch-directory"],
  }]);
  try {
    try {
      lease = await policy.watchDirectory(
        authority,
        { input: targetName, operation: "watch-directory", defaultRootId: "workspace" },
        event => published.push(event)
      );
    } catch (caught) {
      error = caught;
    }
    const actual = {
      escapedWatcherPublished: published.length > 0,
      revokedWatcherClosed: lease === undefined || !lease.isOpen(),
      auditAttempts: audits.length,
      externalAccesses,
      denied: error !== undefined,
      watchCreateCalls,
      auditAllowedFieldsExact: audits.every(event => JSON.stringify(Object.keys(event).sort()) === JSON.stringify(auditKeys)),
      rawPathsAbsent: audits.every(event => !Object.values(event).some(value => typeof value === "string" && value.includes(targetName))),
    };
    assert.equal(error?.code, "PATH_REDIRECT_DENIED");
    assert.deepEqual(actual, {
      escapedWatcherPublished: false,
      revokedWatcherClosed: true,
      auditAttempts: 1,
      externalAccesses: 0,
      denied: true,
      watchCreateCalls: 0,
      auditAllowedFieldsExact: true,
      rawPathsAbsent: true,
    });
    if (watcherRecorder.enabled) await watcherRecorder.observe("SEC02-P29-external-target", actual);
  } finally {
    await lease?.close();
    if (policy.isActive(authority)) policy.revoke(authority);
    await fs.unlink(linkedTarget);
  }
}

async function observeRejectedEvent(observationId, nested) {
  const watchName = observationId.endsWith("event-traversal") ? "event-traversal-watch" : "event-reparse-watch";
  const watchRoot = path.join(workspace, watchName);
  const parent = nested ? path.join(watchRoot, "nested") : watchRoot;
  await fs.mkdir(parent, { recursive: true });
  const authority = await makeAuthority();
  const root = toolsModule.capabilityBroker.beginAgentRun(authority, session.id);
  const owner = toolsModule.capabilityBroker.getResourceOwner(root);
  const subscribed = await approved(root, "poll_subscribe", { path: watchName, source: observationId });
  const subscriptionId = /ID:\s*(sub_[a-z0-9]+)/i.exec(subscribed)?.[1];
  assert(subscriptionId, subscribed);
  const events = [];
  const stopEvents = wireModule.onEvent(owner, subscriptionId, event => events.push(event));
  const linkName = "external-link";
  const linkedEntry = path.join(parent, linkName);
  const auditStart = pathAuditEvents.length;
  try {
    await fs.symlink(outside, linkedEntry, "junction");
    await waitFor(
      async () => (await toolsModule.executeTool(root, "poll_list", {})) === "没有活跃的订阅。",
      `${observationId} did not close its denied watcher`
    );
    const audits = pathAuditEvents.slice(auditStart);
    const common = {
      escapedWatcherPublished: events.some(event => event.path.toLowerCase() === linkedEntry.toLowerCase())
        || outsideEventCount(events, outside) > 0,
      revokedWatcherClosed: (await toolsModule.executeTool(root, "poll_list", {})) === "没有活跃的订阅。",
      auditAttempts: audits.length,
      externalAccesses: outsideEventCount(events, outside),
      eventRejected: events.every(event => event.path.toLowerCase() !== linkedEntry.toLowerCase()),
      denied: audits.some(event => event.code === "PATH_REDIRECT_DENIED"),
      ...auditEvidence(audits, [linkName, linkedEntry]),
    };
    const actual = nested
      ? { ...common, eventCallbacksAuthorized: audits.length }
      : {
          ...common,
          externalBytesRead: JSON.stringify({ events, audits }).includes(externalSecret) ? Buffer.byteLength(externalSecret) : 0,
        };
    const expected = nested
      ? {
          escapedWatcherPublished: false,
          revokedWatcherClosed: true,
          auditAttempts: 1,
          externalAccesses: 0,
          eventRejected: true,
          eventCallbacksAuthorized: 1,
          denied: true,
          auditAllowedFieldsExact: true,
          rawPathsAbsent: true,
        }
      : {
          escapedWatcherPublished: false,
          revokedWatcherClosed: true,
          auditAttempts: 1,
          externalAccesses: 0,
          eventRejected: true,
          externalBytesRead: 0,
          denied: true,
          auditAllowedFieldsExact: true,
          rawPathsAbsent: true,
        };
    assert.deepEqual(actual, expected);
    if (watcherRecorder.enabled) await watcherRecorder.observe(observationId, actual);
  } finally {
    stopEvents();
    toolsModule.capabilityBroker.finishContext(root);
    await toolsModule.capabilityBroker.retireAuthority(authority);
    await fs.rm(watchRoot, { recursive: true, force: true });
  }
}

async function observeBeforePublishSwap() {
  const watchRoot = path.join(workspace, "before-publish-watch");
  await fs.mkdir(watchRoot);
  const audits = [];
  const published = [];
  let authority;
  let revoked = false;
  const policy = new pathPolicyModule.PathPolicy({
    auditKey: Buffer.alloc(32, 52),
    auditSink: event => audits.push(event),
    barrier: point => {
      if (point !== "beforeWatcherPublish" || revoked) return;
      revoked = true;
      policy.revoke(authority);
    },
  });
  authority = await policy.createAuthority([{
    rootId: "workspace",
    role: "workspace",
    configuredPath: workspace,
    permissions: ["watch-directory"],
  }]);
  const lease = await policy.watchDirectory(
    authority,
    { input: "before-publish-watch", operation: "watch-directory", defaultRootId: "workspace" },
    event => published.push(event)
  );
  try {
    const eventName = "must-not-publish.txt";
    await fs.writeFile(path.join(watchRoot, eventName), "value");
    await waitFor(() => audits.length === 1 && !lease.isOpen(), "before-publish denial did not close the watcher");
    const actual = {
      escapedWatcherPublished: outsideEventCount(published, outside) > 0,
      revokedWatcherClosed: !lease.isOpen(),
      auditAttempts: audits.length,
      externalAccesses: outsideEventCount(published, outside),
      denied: audits.some(event => event.code === "PATH_AUTHORITY_STALE"),
      watcherPublished: published.length > 0,
      auditAllowedFieldsExact: audits.every(event => JSON.stringify(Object.keys(event).sort()) === JSON.stringify(auditKeys)),
      rawPathsAbsent: audits.every(event => !Object.values(event).some(value => typeof value === "string" && value.includes(eventName))),
    };
    assert.deepEqual(actual, {
      escapedWatcherPublished: false,
      revokedWatcherClosed: true,
      auditAttempts: 1,
      externalAccesses: 0,
      denied: true,
      watcherPublished: false,
      auditAllowedFieldsExact: true,
      rawPathsAbsent: true,
    });
    if (watcherRecorder.enabled) await watcherRecorder.observe("SEC02-P29-before-publish-swap", actual);
  } finally {
    await lease.close();
    if (policy.isActive(authority)) policy.revoke(authority);
    await fs.rm(watchRoot, { recursive: true, force: true });
  }
}

test.after(async () => {
  console.warn = originalConsoleWarn;
  await watcherRecorder.close();
  await wireModule.disposeAll();
  dbModule.closeDb();
  await fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("SEC-02 watcher events and controls remain bound to one runtime authority", async () => {
  await observeExternalTarget();
  await observeBeforePublishSwap();
  await observeRejectedEvent("SEC02-P29-event-traversal", true);
  await observeRejectedEvent("SEC02-P29-event-reparse", false);

  const firstAuthority = await makeAuthority();
  const firstRoot = toolsModule.capabilityBroker.beginAgentRun(firstAuthority, session.id);
  const firstOwner = toolsModule.capabilityBroker.getResourceOwner(firstRoot);
  const subscribed = await approved(firstRoot, "poll_subscribe", { path: "", source: "authority-one" });
  const subscriptionId = /ID:\s*(sub_[a-z0-9]+)/i.exec(subscribed)?.[1];
  assert(subscriptionId, subscribed);
  const events = [];
  const stopEvents = wireModule.onEvent(firstOwner, subscriptionId, event => events.push(event));

  const validFile = path.join(workspace, "valid.txt");
  await fs.writeFile(validFile, "value");
  await waitFor(
    () => events.find(event => event.path.toLowerCase() === validFile.toLowerCase()),
    "authorized watcher event was not published"
  );

  const secondAuthority = await makeAuthority();
  const secondRoot = toolsModule.capabilityBroker.beginAgentRun(secondAuthority, session.id);
  let secondList;
  let secondUnsubscribe;
  try {
    secondList = await toolsModule.executeTool(secondRoot, "poll_list", {});
    secondUnsubscribe = await toolsModule.executeTool(secondRoot, "poll_unsubscribe", { id: subscriptionId });
    assert.equal(secondList, "没有活跃的订阅。");
    assert.match(secondUnsubscribe, /不存在/);
  } finally {
    toolsModule.capabilityBroker.finishContext(secondRoot);
    await toolsModule.capabilityBroker.retireAuthority(secondAuthority);
  }

  const sessionAuditStart = pathAuditEvents.length;
  const eventCountBeforeSessionRetirement = events.length;
  await toolsModule.capabilityBroker.retireSessionResources(firstAuthority, session.id);
  let oldOwnerStale = false;
  try { wireModule.listSubscriptions(firstOwner); }
  catch (error) { oldOwnerStale = error?.code === "PATH_AUTHORITY_STALE"; }
  await fs.writeFile(path.join(workspace, "after-session-retirement.txt"), "value");
  await new Promise(resolve => setTimeout(resolve, 250));
  const sessionActual = {
    oldResourceClosedOrIsolated: oldOwnerStale && events.length === eventCountBeforeSessionRetirement,
    newAuthorityControlDenied: secondList === "没有活跃的订阅。" && /不存在/.test(secondUnsubscribe),
    auditAttempts: pathAuditEvents.length - sessionAuditStart,
    externalAccesses: outsideEventCount(events, outside),
  };
  assert.deepEqual(sessionActual, {
    oldResourceClosedOrIsolated: true,
    newAuthorityControlDenied: true,
    auditAttempts: 0,
    externalAccesses: 0,
  });
  if (watcherRecorder.enabled) {
    await watcherRecorder.observe("SEC02-P29-session-delete-close", sessionActual);
    await watcherRecorder.positive("SEC02-POS-watcher-create-close");
  }
  stopEvents();
  toolsModule.capabilityBroker.finishContext(firstRoot);
  await toolsModule.capabilityBroker.retireAuthority(firstAuthority);

  const revokeAuthority = await makeAuthority();
  const revokeRoot = toolsModule.capabilityBroker.beginAgentRun(revokeAuthority, session.id);
  const revokeOwner = toolsModule.capabilityBroker.getResourceOwner(revokeRoot);
  const revokeSubscribed = await approved(revokeRoot, "poll_subscribe", { path: "", source: "revoke-close" });
  const revokeSubscriptionId = /ID:\s*(sub_[a-z0-9]+)/i.exec(revokeSubscribed)?.[1];
  assert(revokeSubscriptionId, revokeSubscribed);
  const revokeEvents = [];
  const stopRevokeEvents = wireModule.onEvent(revokeOwner, revokeSubscriptionId, event => revokeEvents.push(event));
  const revokeAuditStart = pathAuditEvents.length;
  toolsModule.capabilityBroker.finishContext(revokeRoot);
  await toolsModule.capabilityBroker.retireAuthority(revokeAuthority);
  let revokedOwnerStale = false;
  try { wireModule.listSubscriptions(revokeOwner); }
  catch (error) { revokedOwnerStale = error?.code === "PATH_AUTHORITY_STALE"; }
  const revokeEventCount = revokeEvents.length;
  await fs.writeFile(path.join(workspace, "after-authority-retirement.txt"), "value");
  await new Promise(resolve => setTimeout(resolve, 250));
  const revokeActual = {
    escapedWatcherPublished: outsideEventCount(revokeEvents, outside) > 0,
    revokedWatcherClosed: revokedOwnerStale && revokeEvents.length === revokeEventCount,
    auditAttempts: pathAuditEvents.length - revokeAuditStart,
    externalAccesses: outsideEventCount(revokeEvents, outside),
  };
  assert.deepEqual(revokeActual, {
    escapedWatcherPublished: false,
    revokedWatcherClosed: true,
    auditAttempts: 0,
    externalAccesses: 0,
  });
  if (watcherRecorder.enabled) await watcherRecorder.observe("SEC02-P29-revoke-close", revokeActual);
  stopRevokeEvents();
});

test("SEC-02 watcher target junction is denied before a subscription is published", async () => {
  const linkedTarget = path.join(workspace, "linked-target");
  await fs.symlink(outside, linkedTarget, "junction");
  const authority = await makeAuthority();
  const root = toolsModule.capabilityBroker.beginAgentRun(authority, session.id);
  try {
    const result = await approved(root, "poll_subscribe", { path: "linked-target" });
    assert.match(result, /订阅失败/);
    assert.equal(await toolsModule.executeTool(root, "poll_list", {}), "没有活跃的订阅。");
  } finally {
    toolsModule.capabilityBroker.finishContext(root);
    await toolsModule.capabilityBroker.retireAuthority(authority);
  }
});

test("SEC-02 native watcher failure settles the lease and removes its Wire subscription", async () => {
  const authority = await makeAuthority();
  const root = toolsModule.capabilityBroker.beginAgentRun(authority, session.id);
  const owner = toolsModule.capabilityBroker.getResourceOwner(root);
  const faultPolicy = new pathPolicyModule.PathPolicy({
    auditKey: Buffer.alloc(32, 45),
    watchFactory: (target, options, listener) => {
      const watcher = nodeFs.watch(target, options, listener);
      setImmediate(() => watcher.emit("error", new Error("synthetic native watcher failure")));
      return watcher;
    },
  });
  const faultAuthority = await faultPolicy.createAuthority([{
    rootId: "workspace",
    role: "workspace",
    configuredPath: workspace,
    permissions: ["watch-directory"],
  }]);
  const gateway = {
    rootIdForEnv: key => key === "DATA_ROOT" ? "workspace" : null,
    watchDirectory: (input, options, publish) => faultPolicy.watchDirectory(
      faultAuthority,
      { input, operation: "watch-directory", defaultRootId: options.defaultRootId },
      publish
    ),
  };
  try {
    const result = await wireModule.subscribe(owner, gateway, "", "native-error");
    assert.equal(result.error, undefined);
    await waitFor(
      () => wireModule.listSubscriptions(owner).length === 0,
      "native watcher failure did not remove the Wire subscription"
    );
  } finally {
    if (faultPolicy.isActive(faultAuthority)) faultPolicy.revoke(faultAuthority);
    toolsModule.capabilityBroker.finishContext(root);
    await toolsModule.capabilityBroker.retireAuthority(authority);
  }
});
