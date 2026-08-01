import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";
import {
  freePort,
  makeTempDir,
  pathExists,
  projectRoot,
  removeFixture,
  spawnManaged,
  terminateProcessTreeAsync,
  waitFor,
} from "../helpers.mjs";

const require = createRequire(import.meta.url);
const { migrateLegacyUserData } = require("../../electron/user-data-migration.cjs");

test("RainyDays migrates legacy Mini-Lux user data once without overwriting a current profile", async () => {
  const fixture = await makeTempDir("rainydays-user-data-migration-");
  const legacy = path.join(fixture, "Mini-Lux");
  const current = path.join(fixture, "RainyDays");
  try {
    await mkdir(path.join(legacy, "data"), { recursive: true });
    await writeFile(path.join(legacy, "data", "mini-lux.db"), "legacy-profile");
    const migrated = migrateLegacyUserData({ appDataRoot: fixture, currentUserData: current });
    assert.equal(migrated.state, "migrated");
    assert.equal(await readFile(path.join(current, "data", "mini-lux.db"), "utf8"), "legacy-profile");
    assert.equal(await pathExists(legacy), false);

    await mkdir(legacy, { recursive: true });
    await writeFile(path.join(legacy, "sentinel.txt"), "do-not-merge");
    const preserved = migrateLegacyUserData({ appDataRoot: fixture, currentUserData: current });
    assert.equal(preserved.state, "current-exists");
    assert.equal(await readFile(path.join(current, "data", "mini-lux.db"), "utf8"), "legacy-profile");
    assert.equal(await readFile(path.join(legacy, "sentinel.txt"), "utf8"), "do-not-merge");
  } finally {
    await removeFixture(fixture);
  }
});

test("RainyDays user-data migration rejects unsafe roots and reports every no-op state", async () => {
  assert.throws(
    () => migrateLegacyUserData({ appDataRoot: "relative", currentUserData: "also-relative" }),
    /paths must be absolute/u,
  );

  const sameRoot = await makeTempDir("rainydays-user-data-same-");
  const absentRoot = await makeTempDir("rainydays-user-data-absent-");
  const fileRoot = await makeTempDir("rainydays-user-data-file-");
  const linkRoot = await makeTempDir("rainydays-user-data-link-");
  try {
    const same = path.join(sameRoot, "Mini-Lux");
    assert.equal(migrateLegacyUserData({ appDataRoot: sameRoot, currentUserData: same }).state, "same-path");

    const absent = migrateLegacyUserData({ appDataRoot: absentRoot, currentUserData: path.join(absentRoot, "RainyDays") });
    assert.equal(absent.state, "legacy-absent");

    await writeFile(path.join(fileRoot, "Mini-Lux"), "not-a-directory");
    assert.throws(
      () => migrateLegacyUserData({ appDataRoot: fileRoot, currentUserData: path.join(fileRoot, "RainyDays") }),
      /not a real directory/u,
    );

    const target = path.join(linkRoot, "target");
    await mkdir(target);
    await symlink(target, path.join(linkRoot, "Mini-Lux"), process.platform === "win32" ? "junction" : "dir");
    assert.throws(
      () => migrateLegacyUserData({ appDataRoot: linkRoot, currentUserData: path.join(linkRoot, "RainyDays") }),
      /not a real directory/u,
    );
  } finally {
    await Promise.all([sameRoot, absentRoot, fileRoot, linkRoot].map(root => removeFixture(root)));
  }
});

test("SEC-03 local API accepts only the private trusted header and publishes no browser credential", async () => {
  const fixture = await makeTempDir("mini-lux-sec03-browser-auth-");
  const port = await freePort();
  const token = "sec03-main-private-header-token";
  const origin = `http://127.0.0.1:${port}`;
  const child = spawnManaged(process.execPath, ["dist/index.js"], {
    cwd: projectRoot,
    env: {
      ...process.env,
      PORT: String(port),
      RAINYDAYS_API_TOKEN: token,
      RAINYDAYS_USER_DATA_DIR: fixture,
      RAINYDAYS_DATA_DIR: path.join(fixture, "data"),
      RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"),
      RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"),
      RAINYDAYS_PUBLIC_DIR: path.join(projectRoot, "public"),
    },
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });

  try {
    await waitFor(async () => {
      const response = await fetch(`${origin}/api/status`, { headers: { "X-RainyDays-Token": token } }).catch(() => null);
      return response?.ok === true;
    }, { timeoutMs: 60_000, label: "SEC-03 private-header server" }).catch(error => {
      throw new Error(`${error.message}\nstdout=${stdout}\nstderr=${stderr}`);
    });

    const page = await fetch(`${origin}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("set-cookie"), null, "ordinary navigation received browser authority");

    const rejected = [
      await fetch(`${origin}/api/status?token=${encodeURIComponent(token)}`),
      await fetch(`${origin}/api/status`, { headers: { "X-RainyDays-Bootstrap": token } }),
      await fetch(`${origin}/api/status`, { headers: { Cookie: "mini_lux_session=forged" } }),
      await fetch(`${origin}/api/status`, {
        headers: { Cookie: "mini_lux_session=forged", Origin: origin, "Sec-Fetch-Site": "same-origin" },
      }),
      await fetch(`${origin}/api/status`, {
        headers: { Origin: "http://127.0.0.1:65534", Referer: `${origin}/`, "Sec-Fetch-Site": "same-origin" },
      }),
    ];
    assert(rejected.every(response => response.status === 401), "browser-controlled metadata authorized the local API");
    assert(rejected.every(response => response.headers.get("set-cookie") === null), "a rejected request received a cookie");

    const headerClient = await fetch(`${origin}/api/status`, {
      headers: { "X-RainyDays-Token": token, Origin: "http://127.0.0.1:65534" },
    });
    assert.equal(headerClient.status, 200, "explicit trusted-header client compatibility regressed");

    const html = await page.text();
    assert.doesNotMatch(html, /miniLuxApiToken|withApiToken|X-RainyDays-Token|sessionStorage\.setItem\([^)]*token|[?&#]token=/iu);
  } finally {
    const termination = await terminateProcessTreeAsync(child);
    assert.equal(termination.childExited, true, `auth server cleanup failed\nstdout=${stdout}\nstderr=${stderr}`);
    await removeFixture(fixture);
  }
});
