import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const source = await fs.readFile(path.resolve(import.meta.dirname, "../../public/mcp-settings.js"), "utf8");
const httpServer = {
  name: "remote", enabled: true, transport: "http", command: "", args: [], cwd: "", env: {}, url: "https://fixture.invalid/mcp",
  tools: [{ name: "search", description: "", inputSchema: { type: "object", properties: {} } }], protocolVersion: "2025-11-25", resources: true,
  auth: { mode: "oauth", clientId: "client-1", authorizationId: "00000000-0000-4000-8000-000000000000" },
};

function mount(servers, routes = {}) {
  const { window, document } = parseHTML('<div id="mcp-server-list"></div><button id="mcp-add-server"></button>');
  const requests = [];
  const respond = (body, ok = true) => ({ ok, json: async () => body });
  const fetch = async (url, init = {}) => {
    requests.push({ url, init });
    const route = routes[url.split("?")[0]];
    return route ? respond(route) : respond({ servers: [], state: "signed-out" });
  };
  const context = { window, document, fetch, Event: window.Event, setTimeout: () => 0, clearTimeout: () => {}, console };
  vm.runInNewContext(source, context);
  const saved = [];
  const options = { headers: () => ({ "Content-Type": "application/json" }), dirty: () => false, saved: value => saved.push(value) };
  window.McpSettings.render({ revision: "rev-1", domains: { mcp: { servers } } }, options);
  return { window, document, requests, saved, options };
}
const input = (document, key) => document.querySelector(`[data-mcp-field="${key}"]`);
const buttonNamed = (document, label) => [...document.querySelectorAll("button")].find(node => node.textContent === label);
const settle = () => new Promise(resolve => setImmediate(resolve));

test("A06 saving the MCP form keeps the HTTP transport, auth and resource capability", () => {
  const { window } = mount([httpServer]);
  const { servers, authValues } = window.McpSettings.collect();
  assert.equal(servers[0].transport, "http");
  assert.equal(servers[0].url, httpServer.url);
  assert.equal(servers[0].auth.mode, "oauth");
  assert.equal(servers[0].auth.clientId, "client-1");
  assert.equal(servers[0].resources, true);
  assert.equal(Object.hasOwn(servers[0].auth, "credentialRef"), false);
  assert.deepEqual({ ...authValues }, {});
});

test("A06 a remote server can be configured from the form with a token that starts blank", () => {
  const { window, document } = mount([{ ...httpServer, name: "token-server", auth: { mode: "token", clientId: "", authorizationId: "" } }]);
  assert.equal(input(document, "auth-token").value, "");
  input(document, "auth-token").value = "obviously-fake-token";
  const { servers, authValues } = window.McpSettings.collect();
  assert.equal(servers[0].auth.mode, "token");
  assert.equal(authValues["token-server"], "obviously-fake-token");
});

test("A06 changing the transport switches between local and remote fields", () => {
  const { window, document } = mount([{ ...httpServer, name: "local", transport: "stdio", command: "node", url: "", auth: { mode: "none", clientId: "", authorizationId: "" } }]);
  const remote = document.querySelector('[data-mcp-group="remote"]'), local = document.querySelector('[data-mcp-group="stdio"]');
  assert.equal(remote.hidden, true); assert.equal(local.hidden, false);
  const select = input(document, "transport");
  for (const option of select.querySelectorAll("option")) option.selected = option.value === "http";
  select.dispatchEvent(new window.Event("change", { bubbles: true }));
  assert.equal(remote.hidden, false); assert.equal(local.hidden, true);
});

test("A06 OAuth login and disconnect use the guarded routes with the saved revision", async () => {
  const { document, requests, saved } = mount([httpServer], { "/api/mcp/oauth/start": { pending: true, settings: { revision: "rev-2" } }, "/api/mcp/oauth/disconnect": { pending: false, settings: { revision: "rev-3" } } });
  buttonNamed(document, "登录").dispatchEvent(new document.defaultView.Event("click"));
  await settle();
  const start = requests.find(entry => entry.url === "/api/mcp/oauth/start");
  assert.deepEqual(JSON.parse(start.init.body), { name: "remote", expectedRevision: "rev-1" });
  assert.equal(start.init.method, "POST");
  assert.equal(saved[0].revision, "rev-2");
  buttonNamed(document, "断开").dispatchEvent(new document.defaultView.Event("click"));
  await settle();
  assert(requests.some(entry => entry.url === "/api/mcp/oauth/disconnect"));
});
