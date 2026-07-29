import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  freePort,
  makeTempDir,
  projectRoot,
  removeFixture,
  spawnManaged,
  terminateProcessTreeAsync,
  waitFor,
} from "../helpers.mjs";

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
      MINI_LUX_API_TOKEN: token,
      MINI_LUX_USER_DATA_DIR: fixture,
      MINI_LUX_DATA_DIR: path.join(fixture, "data"),
      MINI_LUX_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"),
      MINI_LUX_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"),
      MINI_LUX_PUBLIC_DIR: path.join(projectRoot, "public"),
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
      const response = await fetch(`${origin}/api/status`, { headers: { "X-Mini-Lux-Token": token } }).catch(() => null);
      return response?.ok === true;
    }, { timeoutMs: 30_000, label: "SEC-03 private-header server" }).catch(error => {
      throw new Error(`${error.message}\nstdout=${stdout}\nstderr=${stderr}`);
    });

    const page = await fetch(`${origin}/`);
    assert.equal(page.status, 200);
    assert.equal(page.headers.get("set-cookie"), null, "ordinary navigation received browser authority");

    const rejected = [
      await fetch(`${origin}/api/status?token=${encodeURIComponent(token)}`),
      await fetch(`${origin}/api/status`, { headers: { "X-Mini-Lux-Bootstrap": token } }),
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
      headers: { "X-Mini-Lux-Token": token, Origin: "http://127.0.0.1:65534" },
    });
    assert.equal(headerClient.status, 200, "explicit trusted-header client compatibility regressed");

    const html = await page.text();
    assert.doesNotMatch(html, /miniLuxApiToken|withApiToken|X-Mini-Lux-Token|sessionStorage\.setItem\([^)]*token|[?&#]token=/iu);
  } finally {
    const termination = await terminateProcessTreeAsync(child);
    assert.equal(termination.childExited, true, `auth server cleanup failed\nstdout=${stdout}\nstderr=${stderr}`);
    await removeFixture(fixture);
  }
});
