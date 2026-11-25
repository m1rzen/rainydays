import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PathPolicy } from "../../src/path-policy.ts";

async function fixture(t, barrier) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "rainydays-policy-directories-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "authorized");
  const outside = path.join(temporary, "outside");
  await fs.mkdir(root);
  await fs.mkdir(outside);
  const policy = new PathPolicy({ barrier });
  const authority = await policy.createAuthority([{
    rootId: "test-root", role: "test-directory", configuredPath: root,
    permissions: ["move-directory", "remove-directory-tree"],
  }]);
  const request = (input, operation) => ({ input, operation, defaultRootId: "test-root" });
  return { policy, authority, root, outside, request };
}

test("directory moves reject outside roots, an existing empty destination and junctions", async t => {
  const { policy, authority, root, outside, request } = await fixture(t);
  await fs.mkdir(path.join(root, "source"));
  await fs.mkdir(path.join(root, "occupied"));
  await fs.symlink(outside, path.join(root, "junction"), "junction");
  const move = (from, to) => policy.moveDirectory(authority, request(from, "move-directory"), to);
  await assert.rejects(move("source", path.join(outside, "escaped")), { code: "PATH_ROOT_DENIED" });
  await assert.rejects(move("source", "occupied"), { code: "PATH_OPERATION_DENIED" });
  await assert.rejects(move("junction", "moved"), { code: "PATH_REDIRECT_DENIED" });
  await assert.rejects(move("source", path.join("junction", "moved")), { code: "PATH_REDIRECT_DENIED" });
  assert.deepEqual((await fs.readdir(root)).sort(), ["junction", "occupied", "source"]);
  assert.deepEqual(await fs.readdir(outside), []);
});

test("directory move preserves identity and rejects a source replaced before the move", { skip: process.platform !== "win32" }, async t => {
  let swap;
  const { policy, authority, root, request } = await fixture(t, async point => {
    if (point === "beforeFinalCreate" && swap) await swap();
  });
  await fs.mkdir(path.join(root, "source"));
  const prior = await fs.stat(path.join(root, "source"), { bigint: true });
  await policy.moveDirectory(authority, request("source", "move-directory"), "archived");
  assert.equal((await fs.stat(path.join(root, "archived"), { bigint: true })).ino, prior.ino);
  swap = async () => {
    await fs.rename(path.join(root, "archived"), path.join(root, "original"));
    await fs.mkdir(path.join(root, "archived"));
  };
  await assert.rejects(policy.moveDirectory(authority, request("archived", "move-directory"), "restored"), { code: "PATH_IDENTITY_CHANGED" });
  assert.deepEqual((await fs.readdir(root)).sort(), ["archived", "original"]);
});

test("tree removal rejects outside roots and junctions before removing any files", async t => {
  const { policy, authority, root, outside, request } = await fixture(t);
  const tree = path.join(root, "tree");
  await fs.mkdir(tree);
  await fs.writeFile(path.join(outside, "sentinel"), "keep");
  await fs.writeFile(path.join(tree, "first"), "keep");
  await fs.symlink(outside, path.join(tree, "junction"), "junction");
  const remove = input => policy.removeDirectoryTree(authority, request(input, "remove-directory-tree"));
  await assert.rejects(remove(outside), { code: "PATH_ROOT_DENIED" });
  await assert.rejects(remove(path.join("tree", "junction")), { code: "PATH_REDIRECT_DENIED" });
  await assert.rejects(remove("tree"), { code: "PATH_REDIRECT_DENIED" });
  assert.equal(await fs.readFile(path.join(tree, "first"), "utf8"), "keep");
  assert.equal(await fs.readFile(path.join(outside, "sentinel"), "utf8"), "keep");
  await fs.mkdir(path.join(root, "ordinary", "nested"), { recursive: true });
  await fs.writeFile(path.join(root, "ordinary", "nested", "file"), "owned");
  await remove("ordinary");
  assert.deepEqual(await fs.readdir(root), ["tree"]);
});
