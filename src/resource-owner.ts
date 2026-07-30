import { randomUUID } from "node:crypto";
import { PathDeniedError } from "./path-policy.js";

export interface ResourceOwner {
  readonly ownerId: string;
}

export interface ResourceOwnerMetadata {
  readonly authorityId: string;
  readonly authorityEpoch: number;
  readonly sessionId: string;
  readonly principal: string;
  readonly rootIds: readonly string[];
}

type ResourceCloser = () => void | Promise<void>;

interface ResourceOwnerRecord {
  readonly token: ResourceOwner;
  readonly metadata: ResourceOwnerMetadata;
  readonly closers: Set<ResourceCloser>;
  active: boolean;
  retiring: boolean;
  draining: Promise<void> | null;
  retirement: Promise<void> | null;
}

const records = new WeakMap<ResourceOwner, ResourceOwnerRecord>();

export function issueResourceOwner(metadata: ResourceOwnerMetadata): ResourceOwner {
  if (!metadata.authorityId || !Number.isSafeInteger(metadata.authorityEpoch) || metadata.authorityEpoch < 1
    || !metadata.sessionId || !metadata.principal || !Array.isArray(metadata.rootIds)
    || metadata.rootIds.some(rootId => typeof rootId !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(rootId))
    || new Set(metadata.rootIds).size !== metadata.rootIds.length) {
    throw new TypeError("Resource owner metadata is invalid");
  }
  const rootIds = Object.freeze([...metadata.rootIds].sort());
  const token = Object.freeze({ ownerId: randomUUID() });
  records.set(token, {
    token,
    metadata: Object.freeze({ ...metadata, rootIds }),
    closers: new Set(),
    active: true,
    retiring: false,
    draining: null,
    retirement: null,
  });
  return token;
}

export function assertResourceOwner(owner: ResourceOwner): ResourceOwnerMetadata {
  const record = owner && records.get(owner);
  if (!record || record.token !== owner) throw new PathDeniedError("PATH_AUTHORITY_FORGED", "Resource owner denied");
  if (!record.active) throw new PathDeniedError("PATH_AUTHORITY_STALE", "Resource owner stale");
  return record.metadata;
}

export function assertResourceOwnerForCleanup(owner: ResourceOwner): ResourceOwnerMetadata {
  const record = owner && records.get(owner);
  if (!record || record.token !== owner) throw new PathDeniedError("PATH_AUTHORITY_FORGED", "Resource owner denied");
  if (!record.retiring) throw new PathDeniedError("PATH_AUTHORITY_STALE", "Resource owner cleanup window is unavailable");
  return record.metadata;
}

export function sameResourceOwner(left: ResourceOwner, right: ResourceOwner): boolean {
  assertResourceOwner(left);
  assertResourceOwner(right);
  return left === right;
}

export function registerOwnedResource(owner: ResourceOwner, closer: ResourceCloser): () => void {
  const record = owner && records.get(owner);
  if (!record || record.token !== owner) throw new PathDeniedError("PATH_AUTHORITY_FORGED", "Resource owner denied");
  if (!record.active) throw new PathDeniedError("PATH_AUTHORITY_STALE", "Resource owner stale");
  if (typeof closer !== "function") throw new TypeError("Resource closer is invalid");
  record.closers.add(closer);
  let registered = true;
  return () => {
    if (!registered) return;
    registered = false;
    record.closers.delete(closer);
  };
}

export function retireResourceOwner(owner: ResourceOwner, timeoutMs = 5_000): Promise<void> {
  const record = owner && records.get(owner);
  if (!record || record.token !== owner) return Promise.reject(new PathDeniedError("PATH_AUTHORITY_FORGED", "Resource owner denied"));
  if (record.retirement) return record.retirement;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new TypeError("Resource retirement timeout is invalid");

  record.active = false;
  record.retiring = true;
  const closers = [...record.closers];
  record.closers.clear();
  record.draining = Promise.allSettled(closers.map(async (closer) => { await closer(); }))
    .then((results) => {
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map(result => result.reason);
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, "Resource retirement failed");
    })
    .finally(() => { record.retiring = false; });
  void record.draining.catch(() => undefined);
  let timeout: NodeJS.Timeout | null = null;
  const deadline = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new PathDeniedError("PATH_LIFECYCLE_FAILED", "Resource retirement deadline exceeded")), timeoutMs);
    timeout.unref?.();
  });
  record.retirement = Promise.race([record.draining, deadline]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
  return record.retirement;
}
