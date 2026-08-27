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
const canonicalWorkspace = await fs.realpath(workspace);
const canonicalOutside = await fs.realpath(outside);
const externalSecret = "EXTERNAL-WATCHER-SECRET";
await fs.writeFile(path.join(outside, "secret.txt"), externalSecret);
process.env.RAINYDAYS_USER_DATA_DIR = fixture;
process.env.RAINYDAYS_DATA_DIR = data;

const [personaModule, sessionModule, dbModule, toolsModule, pathRuntimeModule, pathPolicyModule, wireModule, pollModule, eventBusModule] = await Promise.all([
  import("../../dist/persona.js"),
  import("../../dist/session.js"),
  import("../../dist/db.js"),
  import("../../dist/tools/index.js"),
  import("../../dist/path-runtime.js"),
  import("../../dist/path-policy.js"),
  import("../../dist/wire.js"),
  import("../../dist/poll.js"),
  import("../../dist/event-bus.js"),
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

const wireGateways = new WeakMap();

async function makeAuthority() {
  const pathAuthority = await pathRuntimeModule.pathPolicy.createAuthority([{
    rootId: "workspace",
    role: "workspace",
    configuredPath: workspace,
    permissions: ["watch-directory"],
  }]);
  const authority = toolsModule.capabilityBroker.createRuntimeAuthority({
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
  wireGateways.set(authority, {
    rootIdForEnv: key => key === "DATA_ROOT" || key === "WORKSPACE_ROOT" ? "workspace" : null,
    watchDirectory: (input, options, publish) => pathRuntimeModule.pathPolicy.watchDirectory(
      pathAuthority,
      { input, operation: "watch-directory", defaultRootId: options.defaultRootId },
      publish
    ),
  });
  return authority;
}

function subscribeWire(authority, owner, watchPath, source) {
  const gateway = wireGateways.get(authority);
  assert(gateway, "wire gateway missing");
  return wireModule.subscribe(owner, gateway, watchPath, source);
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
      const relative = path.relative(canonicalOutside, target);
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
  const subscribed = await subscribeWire(authority, owner, watchName, observationId);
  assert.equal(subscribed.error, undefined);
  const subscriptionId = subscribed.id;
  const events = [];
  const stopEvents = wireModule.onEvent(owner, subscriptionId, event => events.push(event));
  const linkName = "external-link";
  const linkedEntry = path.join(parent, linkName);
  const canonicalLinkedEntry = path.join(await fs.realpath(parent), linkName);
  const auditStart = pathAuditEvents.length;
  try {
    await fs.symlink(outside, linkedEntry, "junction");
    await waitFor(
      async () => wireModule.listSubscriptions(owner).length === 0,
      `${observationId} did not close its denied watcher`
    );
    const audits = pathAuditEvents.slice(auditStart);
    const common = {
      escapedWatcherPublished: events.some(event => event.path.toLowerCase() === canonicalLinkedEntry.toLowerCase())
        || outsideEventCount(events, canonicalOutside) > 0,
      revokedWatcherClosed: wireModule.listSubscriptions(owner).length === 0,
      auditAttempts: audits.length,
      externalAccesses: outsideEventCount(events, canonicalOutside),
      eventRejected: events.every(event => event.path.toLowerCase() !== canonicalLinkedEntry.toLowerCase()),
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
      escapedWatcherPublished: outsideEventCount(published, canonicalOutside) > 0,
      revokedWatcherClosed: !lease.isOpen(),
      auditAttempts: audits.length,
      externalAccesses: outsideEventCount(published, canonicalOutside),
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
  const eventBus = eventBusModule.getDefaultEventBus();
  eventBus.attachStore(dbModule.createEventStore());
  const pollManager = pollModule.getDefaultPollManager();
  pollManager.attachStore(dbModule.createPollStore());
  pollManager.subscribe(firstOwner, { source: "wire:file", tagFilters: { adapter: "file", source: "authority-one" }, debounceMs: 0 });
  const pollDeliveries = [];
  eventBus.setSessionDelivery(event => {
    if (event.type === "poll.external_event") pollDeliveries.push(event);
    return { outcome: "acked" };
  });
  const subscribed = await subscribeWire(firstAuthority, firstOwner, "", "authority-one");
  assert.equal(subscribed.error, undefined);
  const subscriptionId = subscribed.id;
  const events = [];
  const stopEvents = wireModule.onEvent(firstOwner, subscriptionId, event => events.push(event));

  const validFile = path.join(workspace, "valid.txt");
  await fs.writeFile(validFile, "value");
  const canonicalValidFile = path.join(canonicalWorkspace, "valid.txt");
  await waitFor(
    () => events.find(event => event.path.toLowerCase() === canonicalValidFile.toLowerCase()),
    "authorized watcher event was not published"
  );
  await waitFor(async () => (await pollManager.dispatchDueBatches()).delivered === 1, "Wire adapter event did not enter Poll batch");
  await eventBus.dispatchDueEvents();
  assert.equal(pollDeliveries.length, 1);
  assert.equal(pollDeliveries[0].targetSessionId, session.id);
  assert.equal(pollDeliveries[0].payload.events[0].source, "wire:file");
  assert.equal(pollDeliveries[0].payload.events[0].tags.source, "authority-one");

  const secondAuthority = await makeAuthority();
  const secondRoot = toolsModule.capabilityBroker.beginAgentRun(secondAuthority, session.id);
  const secondOwner = toolsModule.capabilityBroker.getResourceOwner(secondRoot);
  let secondList;
  let secondUnsubscribe;
  try {
    secondList = wireModule.listSubscriptions(secondOwner);
    secondUnsubscribe = await wireModule.unsubscribe(secondOwner, subscriptionId);
    assert.deepEqual(secondList, []);
    assert.equal(secondUnsubscribe, false);
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
    newAuthorityControlDenied: secondList.length === 0 && secondUnsubscribe === false,
    auditAttempts: pathAuditEvents.length - sessionAuditStart,
    externalAccesses: outsideEventCount(events, canonicalOutside),
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
  const revokeSubscribed = await subscribeWire(revokeAuthority, revokeOwner, "", "revoke-close");
  assert.equal(revokeSubscribed.error, undefined);
  const revokeSubscriptionId = revokeSubscribed.id;
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
    escapedWatcherPublished: outsideEventCount(revokeEvents, canonicalOutside) > 0,
    revokedWatcherClosed: revokedOwnerStale && revokeEvents.length === revokeEventCount,
    auditAttempts: pathAuditEvents.length - revokeAuditStart,
    externalAccesses: outsideEventCount(revokeEvents, canonicalOutside),
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
  const owner = toolsModule.capabilityBroker.getResourceOwner(root);
  try {
    const result = await subscribeWire(authority, owner, "linked-target", "junction-test");
    assert.equal(typeof result.error, "string");
    assert(result.error.length > 0);
    assert.deepEqual(wireModule.listSubscriptions(owner), []);
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
