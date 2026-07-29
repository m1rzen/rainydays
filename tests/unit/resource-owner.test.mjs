import assert from "node:assert/strict";
import test from "node:test";
import {
  assertResourceOwner,
  issueResourceOwner,
  registerOwnedResource,
  retireResourceOwner,
  sameResourceOwner,
} from "../../dist/resource-owner.js";
import { PathDeniedError } from "../../dist/path-policy.js";

function metadata(authorityId = "authority-a") {
  return { authorityId, authorityEpoch: 1, sessionId: "session-a", principal: "agent", rootIds: ["workspace"] };
}

test("SEC-02 ResourceOwner authenticity uses object identity and exact metadata", () => {
  const owner = issueResourceOwner(metadata());
  assert.deepEqual(assertResourceOwner(owner), metadata());
  assert.equal(sameResourceOwner(owner, owner), true);
  assert.throws(
    () => assertResourceOwner({ ...owner }),
    error => error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_FORGED"
  );
});

test("SEC-02 ResourceOwner retirement closes registered resources exactly once", async () => {
  const owner = issueResourceOwner(metadata());
  let closes = 0;
  const unregister = registerOwnedResource(owner, async () => { closes += 1; });
  await retireResourceOwner(owner);
  await retireResourceOwner(owner);
  unregister();
  assert.equal(closes, 1);
  assert.throws(
    () => assertResourceOwner(owner),
    error => error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_STALE"
  );
  assert.throws(
    () => registerOwnedResource(owner, () => undefined),
    error => error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_STALE"
  );
});

test("SEC-02 ResourceOwner drain failure is a hard lifecycle failure", async () => {
  const owner = issueResourceOwner(metadata());
  registerOwnedResource(owner, async () => { throw new Error("synthetic close failure"); });
  await assert.rejects(() => retireResourceOwner(owner), /synthetic close failure/);
  assert.throws(
    () => assertResourceOwner(owner),
    error => error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_STALE"
  );
});

test("SEC-02 ResourceOwner drain deadline fails closed", async () => {
  const owner = issueResourceOwner(metadata());
  registerOwnedResource(owner, () => new Promise(() => undefined));
  await assert.rejects(
    () => retireResourceOwner(owner, 20),
    error => error instanceof PathDeniedError && error.code === "PATH_LIFECYCLE_FAILED"
  );
  assert.throws(
    () => assertResourceOwner(owner),
    error => error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_STALE"
  );
});

test("SEC-02 ResourceOwner rejects malformed, forged, stale and duplicate lifecycle operations", async () => {
  for (const invalid of [
    { ...metadata(), authorityId: "" },
    { ...metadata(), authorityEpoch: 0 },
    { ...metadata(), sessionId: "" },
    { ...metadata(), principal: "" },
    { ...metadata(), rootIds: null },
    { ...metadata(), rootIds: ["INVALID"] },
    { ...metadata(), rootIds: ["workspace", "workspace"] },
  ]) assert.throws(() => issueResourceOwner(invalid), TypeError);

  const forged = Object.freeze({ ownerId: "forged" });
  assert.throws(() => registerOwnedResource(forged, () => undefined), error => error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_FORGED");
  await assert.rejects(() => retireResourceOwner(forged), error => error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_FORGED");

  const owner = issueResourceOwner(metadata("authority-edge"));
  assert.throws(() => registerOwnedResource(owner, null), TypeError);
  const unregister = registerOwnedResource(owner, () => undefined);
  unregister();
  unregister();
  for (const timeout of [0, 60_001, Number.NaN]) assert.throws(() => retireResourceOwner(owner, timeout), TypeError);
  await retireResourceOwner(owner);
  assert.throws(() => registerOwnedResource(owner, () => undefined), error => error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_STALE");
});
