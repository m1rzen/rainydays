import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  consumeExecutionRootLease,
  PathDeniedError,
  PathPolicy,
} from "../../dist/path-policy.js";

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec03-root-"));
  const root = path.join(base, "workspace");
  const cwd = path.join(root, "cwd");
  await fs.mkdir(cwd, { recursive: true });
  t.after(() => fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  return { base, root, cwd };
}

async function authority(policy, root) {
  return policy.createAuthority([{
    rootId: "workspace",
    role: "workspace",
    configuredPath: root,
    permissions: ["initial-cwd"],
  }]);
}

function isPathCode(code) {
  return error => error instanceof PathDeniedError && error.code === code;
}

test("SEC-03 execution-root lease is opaque, one-use, exact-mask and epoch bound", async t => {
  const { root } = await fixture(t);
  let now = 1_000;
  const policy = new PathPolicy({ platform: "win32", now: () => now, auditKey: Buffer.alloc(32, 31) });
  const auth = await authority(policy, root);
  assert.throws(() => consumeExecutionRootLease(Object.freeze({}), { authorityEpoch: auth.epoch }, null), TypeError);
  await assert.rejects(
    () => policy.withExecutionRoot(auth, { input: "cwd", operation: "read-directory", defaultRootId: "workspace" }, "read", () => undefined),
    TypeError,
  );
  await assert.rejects(
    () => policy.withExecutionRoot(auth, { input: "cwd", operation: "initial-cwd", defaultRootId: "workspace" }, "write", () => undefined),
    TypeError,
  );
  await assert.rejects(
    () => policy.withExecutionRoot(auth, { input: "cwd", operation: "initial-cwd", defaultRootId: "workspace" }, "read", null),
    TypeError,
  );
  const observed = await policy.withExecutionRoot(
    auth,
    { input: "cwd", operation: "initial-cwd", defaultRootId: "workspace" },
    "read-write",
    (canonicalCwd, lease, qualificationDigest) => {
      assert.deepEqual(Object.keys(lease), []);
      assert(!JSON.stringify(lease).includes(canonicalCwd));
      assert.match(qualificationDigest, /^[a-f0-9]{64}$/u);
      return consumeExecutionRootLease(lease, {
        authorityEpoch: auth.epoch,
        rootId: "workspace",
        access: "read-write",
      }, snapshot => ({ canonicalCwd, qualificationDigest, snapshot }));
    }
  );
  assert.equal(observed.snapshot.rootId, "workspace");
  assert.equal(observed.snapshot.access, "read-write");
  assert.equal(observed.snapshot.authorityEpoch, auth.epoch);
  assert.equal(observed.snapshot.canonicalPath, path.dirname(observed.canonicalCwd));
  assert.equal(observed.snapshot.canonicalCwd, observed.canonicalCwd);
  assert.equal(observed.snapshot.identity.type, "directory");
  assert.equal(observed.snapshot.cwdIdentity.type, "directory");
  assert.notEqual(observed.snapshot.identity.deviceId, "0");
  assert.notEqual(observed.snapshot.identity.objectId, "0");
  assert.notEqual(observed.snapshot.cwdIdentity.objectId, observed.snapshot.identity.objectId);
  const repeatedDigest = await policy.withExecutionRoot(
    auth,
    { input: "cwd", operation: "initial-cwd", defaultRootId: "workspace" },
    "read-write",
    (_cwd, lease, qualificationDigest) => {
      consumeExecutionRootLease(lease, { authorityEpoch: auth.epoch, access: "read-write" }, () => undefined);
      return qualificationDigest;
    }
  );
  assert.equal(repeatedDigest, observed.qualificationDigest, "unchanged root/CWD identity produced a different qualification");

  let replayLease;
  await policy.withExecutionRoot(auth, { input: "cwd", operation: "initial-cwd", defaultRootId: "workspace" }, "read", (_cwd, lease) => {
    replayLease = lease;
    consumeExecutionRootLease(lease, { authorityEpoch: auth.epoch, access: "read" }, () => undefined);
  });
  assert.throws(
    () => consumeExecutionRootLease(replayLease, { authorityEpoch: auth.epoch }, () => undefined),
    isPathCode("PATH_OPERATION_DENIED")
  );

  let mismatchLease;
  await assert.rejects(
    () => policy.withExecutionRoot(auth, { input: "cwd", operation: "initial-cwd", defaultRootId: "workspace" }, "read", (_cwd, lease) => {
      mismatchLease = lease;
      return consumeExecutionRootLease(lease, { authorityEpoch: auth.epoch, access: "read-write" }, () => undefined);
    }),
    isPathCode("PATH_OPERATION_DENIED")
  );
  assert.throws(
    () => consumeExecutionRootLease(mismatchLease, { authorityEpoch: auth.epoch, access: "read" }, () => undefined),
    isPathCode("PATH_OPERATION_DENIED")
  );

  assert.throws(
    () => consumeExecutionRootLease(Object.freeze({}), { authorityEpoch: auth.epoch }, () => undefined),
    isPathCode("PATH_AUTHORITY_FORGED")
  );
  now += 1;
});

test("SEC-03 execution-root lease expires and authority retirement invalidates it", async t => {
  const { root } = await fixture(t);
  let now = 10_000;
  const policy = new PathPolicy({ platform: "win32", now: () => now, auditKey: Buffer.alloc(32, 32) });
  const expiringAuthority = await authority(policy, root);
  let expired;
  await policy.withExecutionRoot(expiringAuthority, { input: "cwd", operation: "initial-cwd", defaultRootId: "workspace" }, "read", (_cwd, lease) => {
    expired = lease;
  });
  now += 15_001;
  assert.throws(
    () => consumeExecutionRootLease(expired, { authorityEpoch: expiringAuthority.epoch }, () => undefined),
    isPathCode("PATH_AUTHORITY_STALE")
  );

  const retiringAuthority = await authority(policy, root);
  let retired;
  await policy.withExecutionRoot(retiringAuthority, { input: "cwd", operation: "initial-cwd", defaultRootId: "workspace" }, "read", (_cwd, lease) => {
    retired = lease;
  });
  policy.revoke(retiringAuthority);
  assert.throws(
    () => consumeExecutionRootLease(retired, { authorityEpoch: retiringAuthority.epoch }, () => undefined),
    isPathCode("PATH_AUTHORITY_STALE")
  );
});

test("SEC-03 pathname swap after validation publishes no execution-root lease", async t => {
  const { root, cwd } = await fixture(t);
  const moved = path.join(root, "original");
  let callbackCalls = 0;
  let swapped = false;
  const policy = new PathPolicy({
    platform: "win32",
    auditKey: Buffer.alloc(32, 33),
    barrier: async point => {
      if (point !== "afterCanonicalValidation" || swapped) return;
      swapped = true;
      await fs.rename(cwd, moved);
      await fs.mkdir(cwd);
    },
  });
  const auth = await authority(policy, root);
  await assert.rejects(
    () => policy.withExecutionRoot(
      auth,
      { input: "cwd", operation: "initial-cwd", defaultRootId: "workspace" },
      "read-write",
      () => { callbackCalls += 1; }
    ),
    isPathCode("PATH_IDENTITY_CHANGED")
  );
  assert.equal(callbackCalls, 0);
});
