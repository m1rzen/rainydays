import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { makeTempDir, removeFixture } from "../helpers.mjs";
import { pathPolicy, createRuntimePathAuthority } from "../../dist/path-runtime.js";

test("D05 a stalled directory connection times out and revokes its late authority", async () => {
  const fixture = await makeTempDir("rainydays-d05-timeout-");
  const originalLstat = fs.lstat;
  const originalCreate = pathPolicy.createAuthority.bind(pathPolicy);
  let delayed = false, lateAuthority;
  fs.lstat = async (...args) => {
    if (!delayed) { delayed = true; await new Promise(resolve => setTimeout(resolve, 160)); }
    return originalLstat(...args);
  };
  pathPolicy.createAuthority = async (...args) => { lateAuthority = await originalCreate(...args); return lateAuthority; };
  try {
    const started = Date.now();
    await assert.rejects(createRuntimePathAuthority([{ rootId: "workspace", role: "workspace", configuredPath: fixture, permissions: ["read-file"] }], 30),
      error => error.code === "PATH_ROOT_UNAVAILABLE" && /重新选择/.test(error.message));
    assert(Date.now() - started < 130, "the caller must not wait for the blocked filesystem operation");
    await new Promise(resolve => setTimeout(resolve, 350));
    assert(lateAuthority);
    assert.equal(pathPolicy.isActive(lateAuthority), false);
    const local = await createRuntimePathAuthority([{ rootId: "output", role: "output", configuredPath: fixture, permissions: ["read-file"] }]);
    assert.equal(pathPolicy.isActive(local), true);
    pathPolicy.revoke(local);
  } finally {
    fs.lstat = originalLstat; pathPolicy.createAuthority = originalCreate;
    await removeFixture(fixture);
  }
});
