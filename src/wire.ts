// ===========================================
// Wire events — owner-bound PathPolicy watcher leases
// ===========================================

import { randomUUID } from "node:crypto";
import {
  assertResourceOwner,
  registerOwnedResource,
  type ResourceOwner,
} from "./resource-owner.js";
import type { PathWatchEvent } from "./path-policy.js";
import type { ScopedPathGateway, ScopedWatchLease } from "./types.js";

interface Subscription {
  readonly id: string;
  readonly owner: ResourceOwner;
  readonly source: string;
  readonly requestedPath: string;
  readonly callbacks: Set<(event: WireEvent) => void>;
  lease: ScopedWatchLease | null;
  unregisterOwnedResource: () => void;
  closed: boolean;
}

export interface WireEvent extends PathWatchEvent {
  readonly source: string;
}

const subscriptions = new Map<string, Subscription>();

function requireSubscription(owner: ResourceOwner, id: string): Subscription | null {
  assertResourceOwner(owner);
  const subscription = subscriptions.get(id);
  return subscription?.owner === owner && !subscription.closed ? subscription : null;
}

async function closeSubscription(subscription: Subscription): Promise<void> {
  if (subscription.closed) return;
  subscription.closed = true;
  subscriptions.delete(subscription.id);
  subscription.unregisterOwnedResource();
  if (subscription.lease) await subscription.lease.close();
  subscription.callbacks.clear();
}

/** Create a persistent watcher lease governed by the invocation's scoped gateway. */
export async function subscribe(
  owner: ResourceOwner,
  gateway: ScopedPathGateway,
  watchPath: string,
  source?: string
): Promise<{ id: string; error?: string }> {
  assertResourceOwner(owner);
  const id = `sub_${randomUUID().slice(0, 8)}`;
  const sourceName = typeof source === "string" && source.trim()
    ? source.trim().slice(0, 120)
    : "file-watch";
  const subscription: Subscription = {
    id,
    owner,
    source: sourceName,
    requestedPath: watchPath,
    callbacks: new Set(),
    lease: null,
    unregisterOwnedResource: () => undefined,
    closed: false,
  };

  subscriptions.set(id, subscription);
  try {
    subscription.unregisterOwnedResource = registerOwnedResource(owner, () => closeSubscription(subscription));
    const lease = await gateway.watchDirectory(watchPath, { defaultRootId: gateway.rootIdForEnv("DATA_ROOT") ?? undefined }, async event => {
      const current = subscriptions.get(id);
      if (!current || current !== subscription || current.closed) return;
      const wireEvent: WireEvent = Object.freeze({ ...event, source: current.source });
      for (const callback of [...current.callbacks]) {
        try { callback(wireEvent); }
        catch { /* One consumer cannot bypass or disrupt the governed watcher. */ }
      }
    });
    subscription.lease = lease;
    void lease.closed.then(() => closeSubscription(subscription)).catch(() => undefined);
    if (subscription.closed || !lease.isOpen()) {
      await closeSubscription(subscription);
      return { id, error: "watcher authority retired or closed during creation" };
    }
    return { id };
  } catch (error) {
    await closeSubscription(subscription).catch(() => undefined);
    return { id, error: error instanceof Error ? error.message : String(error) };
  }
}

/** Cancel only a subscription owned by the current runtime authority/session/principal. */
export async function unsubscribe(owner: ResourceOwner, id: string): Promise<boolean> {
  const subscription = requireSubscription(owner, id);
  if (!subscription) return false;
  await closeSubscription(subscription);
  return true;
}

/** List only subscriptions owned by the current runtime authority/session/principal. */
export function listSubscriptions(owner: ResourceOwner): { id: string; source: string; path: string }[] {
  assertResourceOwner(owner);
  return [...subscriptions.values()]
    .filter(subscription => subscription.owner === owner && !subscription.closed)
    .map(subscription => ({ id: subscription.id, source: subscription.source, path: subscription.requestedPath }));
}

/** Register an in-process callback without exposing the watcher or its authority. */
export function onEvent(owner: ResourceOwner, subId: string, callback: (event: WireEvent) => void): () => void {
  const subscription = requireSubscription(owner, subId);
  if (!subscription) return () => undefined;
  subscription.callbacks.add(callback);
  return () => subscription.callbacks.delete(callback);
}

/** Shutdown-only global drain. Normal callers must use owner-scoped operations. */
export async function disposeAll(): Promise<void> {
  const outcomes = await Promise.allSettled([...subscriptions.values()].map(closeSubscription));
  const failure = outcomes.find(outcome => outcome.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
}
