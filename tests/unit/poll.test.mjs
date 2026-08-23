import assert from "node:assert/strict";
import test from "node:test";

import {
  globMatches,
  normalizeExternalEvent,
  normalizePollSubscriptionInput,
  PollManager,
  subscriptionMatches,
} from "../../dist/poll.js";
import { issueResourceOwner } from "../../dist/resource-owner.js";

function owner(sessionId) {
  return issueResourceOwner({
    authorityId: `authority-${sessionId}`,
    authorityEpoch: 1,
    sessionId,
    principal: "agent",
    rootIds: [],
  });
}

function fakeStore() {
  const subscriptions = [];
  const batches = [];
  const seen = new Set();
  return {
    subscriptions,
    batches,
    recovered: 0,
    settled: [],
    retried: [],
    recoverInterruptedBatches() { this.recovered += 1; },
    createSubscription(subscription, maxPerSession, maxGlobal) {
      const existing = subscriptions.find(candidate => candidate.sessionId === subscription.sessionId
        && candidate.sourcePattern === subscription.sourcePattern
        && JSON.stringify(candidate.tagFilters) === JSON.stringify(subscription.tagFilters)
        && candidate.persistent === subscription.persistent
        && candidate.debounceMs === subscription.debounceMs);
      if (existing) return { created: false, subscription: existing };
      assert(subscriptions.filter(candidate => candidate.sessionId === subscription.sessionId).length < maxPerSession);
      assert(subscriptions.length < maxGlobal);
      subscriptions.push(subscription);
      return { created: true, subscription };
    },
    listSubscriptions(sessionId) { return subscriptions.filter(candidate => candidate.sessionId === sessionId); },
    listActiveSubscriptions() { return [...subscriptions]; },
    deleteSubscriptions(sessionId, selector) {
      let removed = 0;
      for (let index = subscriptions.length - 1; index >= 0; index -= 1) {
        const subscription = subscriptions[index];
        if (subscription.sessionId !== sessionId) continue;
        if (selector !== null && subscription.id !== selector && subscription.sourcePattern !== selector) continue;
        subscriptions.splice(index, 1);
        removed += 1;
      }
      return removed;
    },
    enqueueEvent(subscription, event) {
      const identity = `${subscription.id}\0${event.source}\0${event.sourceEventId}`;
      if (seen.has(identity)) return { status: "duplicate", batchId: null };
      seen.add(identity);
      const batch = { id: `pb_${batches.length}`, subscription, events: [event] };
      batches.push(batch);
      return { status: "enqueued", batchId: batch.id };
    },
    claimDueBatches(_now, limit) { return batches.splice(0, limit); },
    settleBatch(batchId, deactivate) {
      this.settled.push({ batchId, deactivate });
      if (deactivate) {
        const index = subscriptions.findIndex(candidate => candidate.id === this.lastSubscriptionId);
        if (index >= 0) subscriptions.splice(index, 1);
      }
    },
    retryBatch(batchId, nextAttemptAt, error) { this.retried.push({ batchId, nextAttemptAt, error }); },
    pruneDeliveredBatches() { return 0; },
  };
}

test("EVT-03 glob matcher supports only deterministic star wildcards", () => {
  assert.equal(globMatches("*", "wechat:message"), true);
  assert.equal(globMatches("wechat:*", "wechat:message"), true);
  assert.equal(globMatches("*开发*", "产品研发开发群"), true);
  assert.equal(globMatches("俊朗*", "俊朗-销售"), true);
  assert.equal(globMatches("wechat:*", "webhook:event"), false);
  assert.equal(globMatches("a*b*c", "axbyc"), true);
  assert.equal(globMatches("a*b*c", "acb"), false);
});

test("EVT-03 subscription normalization is canonical and fail-closed", () => {
  const normalized = normalizePollSubscriptionInput({
    source: "wechat:*",
    tagFilters: { sender_name: "俊朗*", is_group: "true" },
    persistent: false,
    debounceMs: 5_000,
  });
  assert.deepEqual(normalized, {
    sourcePattern: "wechat:*",
    tagFilters: { is_group: "true", sender_name: "俊朗*" },
    mode: "wake",
    persistent: false,
    debounceMs: 5_000,
  });
  assert.throws(() => normalizePollSubscriptionInput({ source: "wechat:?" }), /source pattern/u);
  assert.throws(() => normalizePollSubscriptionInput({ source: "x", mode: "inject" }), /wake mode/u);
  assert.throws(() => normalizePollSubscriptionInput({ source: "x", debounceMs: 60_001 }), /0\.\.60000/u);
  assert.throws(() => normalizePollSubscriptionInput({ source: "x", persistent: "yes" }), /boolean/u);
  assert.throws(() => normalizePollSubscriptionInput({ source: "x", tagFilters: { "bad key": "x" } }), /key/u);
  assert.throws(() => normalizePollSubscriptionInput({ source: "x", tagFilters: JSON.parse('{"__proto__":"never"}') }), /key/u);
  assert.throws(() => normalizeExternalEvent({ sourceEventId: "x", source: "test:event", tags: JSON.parse('{"constructor":"x"}'), payload: {} }), /key/u);
});

test("EVT-03 external event validation and tag filters use AND matching", () => {
  const subscription = {
    id: "p_12345678",
    sessionId: "session-a",
    sourcePattern: "wechat:*",
    tagFilters: { is_group: "true", sender_name: "俊朗*" },
    mode: "wake",
    persistent: true,
    debounceMs: 0,
    createdAt: 1,
  };
  const matching = normalizeExternalEvent({
    sourceEventId: "wx-1",
    source: "wechat:message",
    tags: { sender_name: "俊朗", is_group: "true", room: "研发" },
    payload: { text: "hello" },
  });
  assert.equal(subscriptionMatches(subscription, matching), true);
  assert.equal(subscriptionMatches(subscription, { ...matching, tags: { ...matching.tags, is_group: "false" } }), false);
  assert.equal(subscriptionMatches(subscription, { ...matching, tags: { sender_name: "俊朗" } }), false);
  assert.throws(() => normalizeExternalEvent({ sourceEventId: "x", source: "bad*", payload: {} }), /source 无效/u);
  assert.throws(() => normalizeExternalEvent({ sourceEventId: "x", source: "test:event", payload: "x".repeat(40_000) }), /大小/u);
});

test("EVT-03 PollManager scopes rules by Session, dedupes ingress and publishes targeted batches", async () => {
  const store = fakeStore();
  const published = [];
  const manager = new PollManager({
    publish: async input => {
      published.push(input);
      return { status: "published", id: `evt_${published.length}`, persisted: true };
    },
  });
  manager.attachStore(store);
  const sessionA = owner("session-a");
  const sessionB = owner("session-b");
  const first = manager.subscribe(sessionA, { source: "webhook:*", tagFilters: { team: "研发*" }, persistent: false });
  const duplicate = manager.subscribe(sessionA, { source: "webhook:*", tagFilters: { team: "研发*" }, persistent: false });
  manager.subscribe(sessionB, { source: "wechat:*" });
  assert.equal(first.created, true);
  assert.equal(duplicate.created, false);
  assert.equal(duplicate.subscription.id, first.subscription.id);
  assert.equal(manager.list(sessionA).length, 1);
  assert.equal(manager.list(sessionB).length, 1);

  const input = { sourceEventId: "hook-1", source: "webhook:push", tags: { team: "研发一组" }, payload: { ok: true } };
  assert.deepEqual(await manager.ingest(input), { matched: 1, enqueued: 1, duplicates: 0 });
  assert.deepEqual(await manager.ingest(input), { matched: 1, enqueued: 0, duplicates: 1 });
  store.lastSubscriptionId = first.subscription.id;
  assert.deepEqual(await manager.dispatchDueBatches(), { delivered: 1, retried: 0 });
  assert.equal(published.length, 1);
  assert.equal(published[0].targetSessionId, "session-a");
  assert.equal(published[0].sourceEventId, `poll:${first.subscription.id}:pb_0`);
  assert.equal(published[0].type, "poll.external_event");
  assert.deepEqual(store.settled, [{ batchId: "pb_0", deactivate: true }]);
  assert.equal(manager.list(sessionA).length, 0);
  assert.equal(manager.unsubscribe(sessionB), 1);
});

test("EVT-03 rejected EventBus publication keeps a durable batch for retry", async () => {
  const store = fakeStore();
  const manager = new PollManager({
    publish: async () => ({ status: "rejected", error: "store unavailable" }),
  });
  manager.attachStore(store);
  const subscription = manager.subscribe(owner("retry-session"), { source: "test:*" }).subscription;
  await manager.ingest({ sourceEventId: "test-1", source: "test:event", payload: {} });
  const result = await manager.dispatchDueBatches(1_000);
  assert.deepEqual(result, { delivered: 0, retried: 1 });
  assert.equal(store.retried.length, 1);
  assert.equal(store.retried[0].batchId, "pb_0");
  assert.equal(store.retried[0].nextAttemptAt, 2_000);
  assert.equal(manager.list(owner("other-session")).length, 0);
  assert.equal(subscription.sessionId, "retry-session");
});
