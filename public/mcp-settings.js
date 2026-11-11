/* MCP settings stay separate from the conversation renderer. Secret fields start blank. */
(() => {
  const oauthLabels = { pending: "等待浏览器完成登录", authorized: "已登录", "signed-out": "未登录", error: "登录状态读取失败" };
  const labels = { "colleague-disabled": "同事模式停用", disabled: "已停用", connected: "已连接", "tested-on-demand": "已测试 · 调用时连接", untested: "尚未测试", connecting: "连接中", error: "连接失败" };
  let settings, options;
  const root = () => document.getElementById("mcp-server-list");
  function button(label, use) { const node = document.createElement("button"); node.type = "button"; node.className = "settings-btn"; node.textContent = label; node.addEventListener("click", use); return node; }
  function field(container, title, key, value = "", type = "text") {
    const label = document.createElement("label"); label.className = "settings-block-label"; label.textContent = title;
    const input = document.createElement(type === "textarea" ? "textarea" : "input"); input.dataset.mcpField = key;
    if (type !== "textarea") input.type = type;
    input.className = "settings-input"; input.value = value; if (type === "password") { input.autocomplete = "new-password"; input.placeholder = "留空保留已保存的值"; }
    label.append(input); container.append(label); return input;
  }
  function select(container, title, key, value, choices) {
    const label = document.createElement("label"); label.className = "settings-block-label"; label.textContent = title;
    const input = document.createElement("select"); input.dataset.mcpField = key; input.className = "settings-input";
    for (const [id, text] of choices) { const option = document.createElement("option"); option.value = id; option.textContent = text; if (id === value) option.selected = true; input.append(option); }
    input.value = value; label.append(input); container.append(label); return input;
  }
  function group(name) { const node = document.createElement("div"); node.dataset.mcpGroup = name; return node; }
  /* The browser callback saves tokens on the server, which moves the settings revision; pick it up so the next action is not refused. */
  function reloadSettings() {
    if (options.dirty()) return Promise.resolve();
    return fetch("/api/settings", { headers: options.headers() }).then(response => response.ok ? response.json() : null).then(value => { if (value && !options.dirty()) options.saved(value); }).catch(() => {});
  }
  function refreshOAuth(node, name, attempts = 150, wasPending = false) {
    fetch(`/api/mcp/oauth/status?name=${encodeURIComponent(name)}`, { headers: options.headers() }).then(response => response.json()).then(data => {
      if (!node.isConnected) return;
      node.textContent = oauthLabels[data.state] || data.state;
      if (data.state === "pending" && attempts > 0) setTimeout(() => refreshOAuth(node, name, attempts - 1, true), 2000);
      else if (wasPending) void reloadSettings();
    }).catch(() => {});
  }
  async function oauthAction(action, server, target, state) {
    target.disabled = true;
    try {
      if (options.dirty()) throw new Error("请先保存MCP设置");
      const response = await fetch(`/api/mcp/oauth/${action}`, { method: "POST", headers: options.headers(), body: JSON.stringify({ name: server.name, expectedRevision: settings.revision }) });
      const data = await response.json();
      if (response.status === 409) void reloadSettings();
      if (!response.ok) throw new Error(data.error || "MCP登录失败");
      state.textContent = action === "disconnect" ? oauthLabels["signed-out"] : oauthLabels[data.pending ? "pending" : "authorized"];
      options.saved(data.settings);
    } catch (error) { state.textContent = error.message; }
    finally { target.disabled = false; }
  }
  function environment(container, key = "") {
    const row = document.createElement("div"); row.className = "mcp-env-row";
    field(row, "变量名", "env-key", key); field(row, "秘密值", "env-value", "", "password");
    row.append(button("移除变量", () => { row.remove(); container.dispatchEvent(new Event("input", { bubbles: true })); })); container.append(row);
  }
  function serverRow(server) {
    const row = document.createElement("fieldset"); row.className = "mcp-server";
    const legend = document.createElement("legend"); legend.textContent = server.name || "新服务器"; row.append(legend);
    field(row, "名称（改名作为新服务器，需重填环境变量值）", "name", server.name); const enabled = field(row, "启用", "enabled", "", "checkbox"); enabled.checked = server.enabled;
    const transport = select(row, "连接方式", "transport", server.transport || "stdio", [["stdio", "本地命令（stdio）"], ["http", "远端 HTTP"], ["sse", "远端 SSE（旧版）"]]);
    const local = group("stdio"), remote = group("remote");
    field(local, "命令（例如 node.exe）", "command", server.command);
    field(local, "参数（每行一个，不添加引号）", "args", (server.args || []).join("\n"), "textarea");
    field(local, "工作目录（须位于授权目录内）", "cwd", server.cwd);
    const env = document.createElement("div"); env.dataset.mcpEnvironment = "";
    for (const key of Object.keys(server.env || {})) environment(env, key);
    local.append(env, button("添加环境变量", () => { environment(env); row.dispatchEvent(new Event("input", { bubbles: true })); }));
    const auth = server.auth || { mode: "none", clientId: "" };
    field(remote, "服务器地址（HTTPS，或本机 HTTP，不含查询参数）", "url", server.url);
    const mode = select(remote, "认证方式", "auth-mode", auth.mode, [["none", "无需认证"], ["token", "Token"], ["oauth", "OAuth 登录"]]);
    const tokenGroup = group("auth-token"), oauthGroup = group("auth-oauth");
    field(tokenGroup, "Token", "auth-token", "", "password");
    field(oauthGroup, "OAuth 客户端 ID（服务器支持自动注册时可留空）", "auth-client", auth.clientId);
    const oauthState = document.createElement("p"); oauthState.dataset.mcpOauth = server.name; oauthState.setAttribute("role", "status"); oauthState.textContent = oauthLabels["signed-out"];
    oauthGroup.append(oauthState, button("登录", event => oauthAction("start", server, event.currentTarget, oauthState)), button("断开", event => oauthAction("disconnect", server, event.currentTarget, oauthState)));
    remote.append(tokenGroup, oauthGroup); row.append(local, remote);
    const sync = () => { local.hidden = transport.value !== "stdio"; remote.hidden = !local.hidden; tokenGroup.hidden = mode.value !== "token"; oauthGroup.hidden = mode.value !== "oauth"; };
    transport.addEventListener("change", sync); mode.addEventListener("change", sync); sync();
    const state = document.createElement("p"); state.dataset.mcpStatus = server.name; state.setAttribute("role", "status"); state.textContent = `${server.tools?.length || 0} 个工具 · ${server.protocolVersion ? "已测试 · 调用时连接" : "尚未测试"}`;
    row.append(state, button("测试已保存的设置", async event => {
      const target = event.currentTarget; target.disabled = true;
      state.textContent = "连接中…";
      try {
        if (options.dirty()) throw new Error("请先保存MCP设置后再测试");
        if (!settings.domains.mcp.servers.some(item => item.name === row.querySelector('[data-mcp-field="name"]').value)) throw new Error("请先保存MCP设置");
        const response = await fetch("/api/mcp/test", { method: "POST", headers: options.headers(), body: JSON.stringify({ name: server.name, expectedRevision: settings.revision }) });
        const data = await response.json();
        if (response.status === 409) void reloadSettings();
        if (!response.ok) throw new Error(data.error || "测试失败");
        options.saved(data.settings);
      } catch (error) { state.textContent = error.message; }
      finally { target.disabled = false; }
    }), button("移除服务器", () => { row.remove(); root().dispatchEvent(new Event("input", { bubbles: true })); }));
    // Catalogs belong to the last explicit test; changing launch data is checked again on call.
    row.mcpCatalog = { tools: server.tools || [], protocolVersion: server.protocolVersion || "", resources: server.resources === true };
    return row;
  }
  function collect() {
    const envValues = Object.create(null), authValues = Object.create(null);
    const servers = [...root().querySelectorAll(".mcp-server")].map(row => {
      const value = key => row.querySelector(`[data-mcp-field="${key}"]`).value;
      const name = value("name").trim(), env = Object.create(null), secrets = Object.create(null);
      for (const entry of row.querySelectorAll(".mcp-env-row")) {
        const key = entry.querySelector('[data-mcp-field="env-key"]').value.trim();
        if (!key) throw new Error("请填写环境变量名"); if (Object.hasOwn(env, key)) throw new Error("环境变量名称重复");
        env[key] = ""; const secret = entry.querySelector('[data-mcp-field="env-value"]').value; if (secret) secrets[key] = secret;
      }
      envValues[name] = secrets;
      const transport = value("transport"), remote = transport !== "stdio", mode = remote ? value("auth-mode") : "none";
      if (mode === "token" && value("auth-token")) authValues[name] = value("auth-token");
      return { ...row.mcpCatalog, name, enabled: row.querySelector('[data-mcp-field="enabled"]').checked, transport, url: remote ? value("url").trim() : "", command: remote ? "" : value("command"), args: !remote && value("args") ? value("args").split(/\r?\n/u) : [], cwd: remote ? "" : value("cwd"), env, auth: { mode, clientId: mode === "oauth" ? value("auth-client").trim() : "" } };
    });
    return { servers, envValues, authValues };
  }
  function render(next, callbacks) {
    settings = next; options = callbacks;
    const container = root(); if (!container) return;
    if (!options.dirty() || !container.children.length) container.replaceChildren(...(next.domains.mcp?.servers || []).map(serverRow));
    document.getElementById("mcp-add-server").onclick = () => { container.append(serverRow({ name: "", command: "", args: [], cwd: "", enabled: false })); container.dispatchEvent(new Event("input", { bubbles: true })); };
    for (const node of container.querySelectorAll("[data-mcp-oauth]")) if (node.dataset.mcpOauth) refreshOAuth(node, node.dataset.mcpOauth);
    fetch("/api/mcp/status").then(response => response.json()).then(data => {
      if (settings !== next) return;
      for (const server of data.servers || []) for (const node of container.querySelectorAll("[data-mcp-status]")) if (node.dataset.mcpStatus === server.name) node.textContent = `${labels[server.state] || server.state} · ${server.toolCount} 个工具${server.error ? ` · ${server.error}` : ""}`;
    }).catch(() => {});
  }
  window.McpSettings = { render, collect };
})();
