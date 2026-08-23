import assert from "node:assert/strict";
import test from "node:test";
import { createScopedNetworkGateway } from "../../dist/network-policy.js";

function context(networkPolicy) {
  return { networkPolicy };
}

function inspected(network = true) {
  return {
    policy: {
      riskClasses: network ? ["network"] : ["read"],
      effects: network ? ["network"] : [],
    },
  };
}

function response(body = "ok", init = {}) {
  return new Response(body, { status: 200, ...init });
}

test("RT-05 scoped network gateway enforces effective policy before transport", async () => {
  let calls = 0;
  const fetchImpl = async url => {
    calls += 1;
    return response(url);
  };

  const denied = createScopedNetworkGateway({
    context: context({ mode: "deny" }), inspected: inspected(), signal: new AbortController().signal, fetchImpl,
  });
  await assert.rejects(() => denied.fetch("https://example.test/"), error => error?.code === "NETWORK_POLICY_DENIED");
  assert.equal(calls, 0);

  const loopback = createScopedNetworkGateway({
    context: context({ mode: "loopback" }), inspected: inspected(), signal: new AbortController().signal, fetchImpl,
  });
  assert.match(await (await loopback.fetch("http://127.0.0.2:8080/path")).text(), /127\.0\.0\.2/u);
  await assert.rejects(() => loopback.fetch("https://outside.test/"), error => error?.code === "NETWORK_POLICY_DENIED");
  await assert.rejects(() => loopback.fetch("file:///etc/passwd"), error => error?.code === "NETWORK_POLICY_DENIED");
  await assert.rejects(() => loopback.fetch("http://user:pass@127.0.0.1/"), error => error?.code === "NETWORK_POLICY_DENIED");

  const allowlist = createScopedNetworkGateway({
    context: context({ mode: "allowlist", origins: ["https://allowed.test"] }),
    inspected: inspected(), signal: new AbortController().signal, fetchImpl,
  });
  await allowlist.fetch("https://allowed.test/path");
  await assert.rejects(() => allowlist.fetch("https://other.test/path"), error => error?.code === "NETWORK_POLICY_DENIED");

  assert.throws(
    () => createScopedNetworkGateway({
      context: context({ mode: "allowlist", origins: ["https://allowed.test/path"] }),
      inspected: inspected(), signal: new AbortController().signal, fetchImpl,
    }),
    error => error?.code === "NETWORK_POLICY_DENIED",
  );

  const noCapability = createScopedNetworkGateway({
    context: context({ mode: "unrestricted" }), inspected: inspected(false), signal: new AbortController().signal, fetchImpl,
  });
  await assert.rejects(() => noCapability.fetch("https://example.test/"), error => error?.code === "NETWORK_POLICY_DENIED");
});

test("RT-05 scoped network gateway revalidates redirects and preserves cancellation", async () => {
  const visited = [];
  const redirecting = createScopedNetworkGateway({
    context: context({ mode: "allowlist", origins: ["https://allowed.test"] }),
    inspected: inspected(),
    signal: new AbortController().signal,
    fetchImpl: async url => {
      visited.push(url);
      return new Response("redirect", { status: 302, headers: { location: "https://outside.test/secret" } });
    },
  });
  await assert.rejects(() => redirecting.fetch("https://allowed.test/start"), error => error?.code === "NETWORK_POLICY_DENIED");
  assert.deepEqual(visited, ["https://allowed.test/start"]);

  const controller = new AbortController();
  controller.abort(new Error("cancelled"));
  const cancelled = createScopedNetworkGateway({
    context: context({ mode: "unrestricted" }), inspected: inspected(), signal: controller.signal,
    fetchImpl: async () => assert.fail("cancelled request reached transport"),
  });
  await assert.rejects(() => cancelled.fetch("https://example.test/"), error => error?.code === "RUN_CANCELLED");
});

test("RT-05 scoped network gateway closes malformed, liveness, redirect, and request-budget branches", async () => {
  const unrestricted = policy => createScopedNetworkGateway({
    context: context(policy ?? { mode: "unrestricted" }),
    inspected: inspected(),
    signal: new AbortController().signal,
    fetchImpl: async url => response(url),
  });
  for (const value of [undefined, "", `https://example.test/${"x".repeat(8_200)}`, "https://example.test/\0", "not a url"]) {
    await assert.rejects(() => unrestricted().fetch(value), error => error?.code === "NETWORK_POLICY_DENIED");
  }

  const loopback = unrestricted({ mode: "loopback" });
  await loopback.fetch("http://localhost/");
  await loopback.fetch("http://[::1]/");
  await assert.rejects(() => loopback.fetch("http://127.999.0.1/"), error => error?.code === "NETWORK_POLICY_DENIED");

  const unavailable = createScopedNetworkGateway({
    context: context({ mode: "unrestricted" }), inspected: inspected(), signal: new AbortController().signal,
    assertActive: () => false, fetchImpl: async () => assert.fail("inactive capability reached transport"),
  });
  await assert.rejects(() => unavailable.fetch("https://example.test/"), error => error?.code === "NETWORK_POLICY_DENIED");

  let activeChecks = 0;
  const revoked = createScopedNetworkGateway({
    context: context({ mode: "unrestricted" }), inspected: inspected(), signal: new AbortController().signal,
    assertActive: () => ++activeChecks === 1, fetchImpl: async () => assert.fail("revoked capability reached transport"),
  });
  await assert.rejects(() => revoked.fetch("https://example.test/"), error => error?.code === "NETWORK_POLICY_DENIED");

  let requests = 0;
  const bounded = createScopedNetworkGateway({
    context: context({ mode: "unrestricted" }), inspected: inspected(), signal: new AbortController().signal,
    fetchImpl: async () => { requests += 1; return response(); },
  });
  for (let index = 0; index < 7; index += 1) await bounded.fetch(`https://example.test/${index}`);
  await assert.rejects(() => bounded.fetch("https://example.test/overflow"), error => error?.code === "NETWORK_POLICY_DENIED");
  assert.equal(requests, 7);

  const noLocation = createScopedNetworkGateway({
    context: context({ mode: "unrestricted" }), inspected: inspected(), signal: new AbortController().signal,
    fetchImpl: async () => new Response(null, { status: 302 }),
  });
  assert.equal((await noLocation.fetch("https://example.test/no-location")).status, 302);

  const redirectMethods = [];
  const rewrite = createScopedNetworkGateway({
    context: context({ mode: "unrestricted" }), inspected: inspected(), signal: new AbortController().signal,
    fetchImpl: async (_url, init) => {
      redirectMethods.push({ method: init.method, contentType: new Headers(init.headers).get("content-type") });
      return redirectMethods.length === 1
        ? new Response(null, { status: 303, headers: { location: "/done" } })
        : response();
    },
  });
  await rewrite.fetch("https://example.test/start", { method: "POST", body: "x", headers: { "content-type": "text/plain", "content-length": "1" } });
  assert.deepEqual(redirectMethods, [{ method: "POST", contentType: "text/plain" }, { method: "GET", contentType: null }]);

  let redirects = 0;
  const looping = createScopedNetworkGateway({
    context: context({ mode: "unrestricted" }), inspected: inspected(), signal: new AbortController().signal,
    fetchImpl: async () => {
      redirects += 1;
      return new Response(null, { status: 307, headers: { location: "/again" } });
    },
  });
  await assert.rejects(() => looping.fetch("https://example.test/start"), error => error?.code === "NETWORK_POLICY_DENIED");
  assert.equal(redirects, 6);
});
