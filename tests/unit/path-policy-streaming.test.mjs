import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PathDeniedError, PathPolicy } from "../../dist/path-policy.js";

async function fixture(t, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-tool06-path-"));
  t.after(() => fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  const policy = new PathPolicy({ auditKey: Buffer.alloc(32, 91), ...options });
  const authority = await policy.createAuthority([{
    rootId: "output",
    role: "output",
    configuredPath: root,
    permissions: ["create-file"],
  }]);
  t.after(() => { if (policy.isActive(authority)) policy.revoke(authority); });
  return { root, policy, authority };
}

function request(input) {
  return Object.freeze({ input, operation: "create-file", defaultRootId: "output" });
}

async function lease(policy, authority, filename, resumeId, maxBytes = 1024 * 1024) {
  const preflight = await policy.preflightWrite(authority, request(filename));
  return policy.beginStreamingWrite(authority, preflight, maxBytes, resumeId);
}

test("TOOL-06 streaming lease resumes a partial and atomically publishes the expected checksum", async t => {
  const { root, policy, authority } = await fixture(t);
  const first = await lease(policy, authority, "large.bin", "0123456789abcdef-data");
  assert.equal((await first.write(Buffer.from("stream-"))).bytesWritten, 7);
  const preserved = await first.preserve();
  assert.equal(preserved.bytesWritten, 7);

  const resumed = await lease(policy, authority, "large.bin", "0123456789abcdef-data");
  assert.equal(resumed.snapshot().bytesWritten, 7);
  await resumed.write(Buffer.from("resume"));
  const expected = createHash("sha256").update("stream-resume").digest("hex");
  const result = await resumed.commit(expected);
  assert.equal(result.bytesWritten, 13);
  assert.equal(result.sha256, expected);
  assert.equal(await fs.readFile(path.join(root, "large.bin"), "utf8"), "stream-resume");
  assert.equal((await fs.readdir(root)).some(name => name.endsWith(".part")), false);
});

test("TOOL-06 binds a persisted partial to its exact target identity", async t => {
  const { policy, authority } = await fixture(t);
  const first = await lease(policy, authority, "one.bin", "feedfacecafebeef-data");
  await first.write(Buffer.from("one"));
  await first.preserve();
  const other = await lease(policy, authority, "two.bin", "feedfacecafebeef-data");
  assert.equal(other.snapshot().bytesWritten, 0);
  await other.cancel();
  const resumed = await lease(policy, authority, "one.bin", "feedfacecafebeef-data");
  assert.equal(resumed.snapshot().bytesWritten, 3);
  await resumed.cancel();
});

test("TOOL-06 reset safely handles a server that ignores Range", async t => {
  const { root, policy, authority } = await fixture(t);
  const first = await lease(policy, authority, "reset.bin", "abcdef0123456789-data");
  await first.write(Buffer.from("stale"));
  await first.preserve();
  const resumed = await lease(policy, authority, "reset.bin", "abcdef0123456789-data");
  assert.equal((await resumed.reset()).bytesWritten, 0);
  await resumed.write(Buffer.from("fresh"));
  await resumed.commit();
  assert.equal(await fs.readFile(path.join(root, "reset.bin"), "utf8"), "fresh");
});

test("TOOL-06 cancellation removes unpublished bytes and never creates the final file", async t => {
  const { root, policy, authority } = await fixture(t);
  const active = await lease(policy, authority, "cancel.bin", "1111222233334444-data");
  await active.write(Buffer.alloc(128 * 1024, 7));
  await active.cancel();
  await assert.rejects(() => fs.access(path.join(root, "cancel.bin")));
  assert.equal((await fs.readdir(root)).some(name => name.endsWith(".part")), false);
});

test("TOOL-06 cleanup removes a partial after its parent authority is retired", async t => {
  const { root, policy, authority } = await fixture(t);
  const active = await lease(policy, authority, "retired.bin", "aaaabbbbccccdddd-data");
  await active.write(Buffer.from("partial"));
  policy.revoke(authority);
  await active.cancel();
  assert.equal((await fs.readdir(root)).some(name => name.endsWith(".part")), false);
  await assert.rejects(() => fs.access(path.join(root, "retired.bin")));
});

test("TOOL-06 rolls back its exact published inode when post-rename verification fails", async t => {
  let rootPath = "";
  const runtime = await fixture(t, {
    barrier: async point => {
      if (point === "afterStreamingRename") await fs.appendFile(path.join(rootPath, "rollback.bin"), "tamper");
    },
  });
  rootPath = runtime.root;
  const active = await lease(runtime.policy, runtime.authority, "rollback.bin", "0000111122223333-data");
  await active.write(Buffer.from("expected"));
  await assert.rejects(() => active.commit(), error => error instanceof PathDeniedError);
  await assert.rejects(() => fs.access(path.join(runtime.root, "rollback.bin")));
});

test("TOOL-06 checksum mismatch and target races fail without false success", async t => {
  const { root, policy, authority } = await fixture(t);
  const checksum = await lease(policy, authority, "checksum.bin", "5555666677778888-data");
  await checksum.write(Buffer.from("content"));
  await assert.rejects(() => checksum.commit("0".repeat(64)), error => error instanceof PathDeniedError);
  await checksum.cancel();
  await assert.rejects(() => fs.access(path.join(root, "checksum.bin")));

  const raced = await lease(policy, authority, "raced.bin", "9999aaaabbbbcccc-data");
  await raced.write(Buffer.from("download"));
  await fs.writeFile(path.join(root, "raced.bin"), "sentinel");
  await assert.rejects(() => raced.commit(), error => error instanceof PathDeniedError);
  await raced.cancel();
  assert.equal(await fs.readFile(path.join(root, "raced.bin"), "utf8"), "sentinel");
});

test("TOOL-06 rejects a hardlinked partial before further streaming", { skip: process.platform !== "win32" }, async t => {
  const { root, policy, authority } = await fixture(t);
  const active = await lease(policy, authority, "hardlink.bin", "ddddeeeeffff0000-data");
  await active.write(Buffer.from("partial"));
  const partialName = (await fs.readdir(root)).find(name => name.startsWith(".rainydays-stream-ddddeeeeffff0000-data-") && name.endsWith(".part"));
  assert(partialName);
  const partial = path.join(root, partialName);
  await fs.link(partial, path.join(root, "partial-alias.bin"));
  await assert.rejects(() => active.write(Buffer.from("more")), error => error instanceof PathDeniedError);
  await assert.rejects(() => active.cancel(), error => error instanceof PathDeniedError);
  await assert.rejects(() => fs.access(path.join(root, "hardlink.bin")));
});
