/* MCP settings stay separate from the conversation renderer. Secret fields start blank. */
(() => {
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
  function environment(container, key = "") {
    const row = document.createElement("div"); row.className = "mcp-env-row";
    field(row, "变量名", "env-key", key); field(row, "秘密值", "env-value", "", "password");
    row.append(button("移除变量", () => { row.remove(); container.dispatchEvent(new Event("input", { bubbles: true })); })); container.append(row);
  }
  function serverRow(server) {
    const row = document.createElement("fieldset"); row.className = "mcp-server";
    const legend = document.createElement("legend"); legend.textContent = server.name || "新服务器"; row.append(legend);
    field(row, "名称（改名作为新服务器，需重填环境变量值）", "name", server.name); const enabled = field(row, "启用", "enabled", "", "checkbox"); enabled.checked = server.enabled;
    field(row, "命令（例如 node.exe）", "command", server.command);
    field(row, "参数（每行一个，不添加引号）", "args", (server.args || []).join("\n"), "textarea");
    field(row, "工作目录（须位于授权目录内）", "cwd", server.cwd);
    const env = document.createElement("div"); env.dataset.mcpEnvironment = "";
    for (const key of Object.keys(server.env || {})) environment(env, key);
    row.append(env, button("添加环境变量", () => { environment(env); row.dispatchEvent(new Event("input", { bubbles: true })); }));
    const state = document.createElement("p"); state.dataset.mcpStatus = server.name; state.setAttribute("role", "status"); state.textContent = `${server.tools?.length || 0} 个工具 · ${server.protocolVersion ? "已测试 · 调用时连接" : "尚未测试"}`;
    row.append(state, button("测试已保存的设置", async event => {
      const target = event.currentTarget; target.disabled = true;
      state.textContent = "连接中…";
      try {
        if (options.dirty()) throw new Error("请先保存MCP设置后再测试");
        if (!settings.domains.mcp.servers.some(item => item.name === row.querySelector('[data-mcp-field="name"]').value)) throw new Error("请先保存MCP设置");
        const response = await fetch("/api/mcp/test", { method: "POST", headers: options.headers(), body: JSON.stringify({ name: server.name, expectedRevision: settings.revision }) });
        const data = await response.json(); if (!response.ok) throw new Error(data.error || "测试失败");
        options.saved(data.settings);
      } catch (error) { state.textContent = error.message; }
      finally { target.disabled = false; }
    }), button("移除服务器", () => { row.remove(); root().dispatchEvent(new Event("input", { bubbles: true })); }));
    // Catalogs belong to the last explicit test; changing launch data is checked again on call.
    row.mcpCatalog = { tools: server.tools || [], protocolVersion: server.protocolVersion || "", transport: server.transport || "stdio", url: server.url || "" };
    return row;
  }
  function collect() {
    const envValues = Object.create(null);
    const servers = [...root().querySelectorAll(".mcp-server")].map(row => {
      const value = key => row.querySelector(`[data-mcp-field="${key}"]`).value;
      const name = value("name").trim(), env = Object.create(null), secrets = Object.create(null);
      for (const entry of row.querySelectorAll(".mcp-env-row")) {
        const key = entry.querySelector('[data-mcp-field="env-key"]').value.trim();
        if (!key) throw new Error("请填写环境变量名"); if (Object.hasOwn(env, key)) throw new Error("环境变量名称重复");
        env[key] = ""; const secret = entry.querySelector('[data-mcp-field="env-value"]').value; if (secret) secrets[key] = secret;
      }
      envValues[name] = secrets;
      return { ...row.mcpCatalog, name, enabled: row.querySelector('[data-mcp-field="enabled"]').checked, command: value("command"), args: value("args") ? value("args").split(/\r?\n/u) : [], cwd: value("cwd"), env };
    });
    return { servers, envValues };
  }
  function render(next, callbacks) {
    settings = next; options = callbacks;
    const container = root(); if (!container) return;
    if (!options.dirty() || !container.children.length) container.replaceChildren(...(next.domains.mcp?.servers || []).map(serverRow));
    document.getElementById("mcp-add-server").onclick = () => { container.append(serverRow({ name: "", command: "", args: [], cwd: "", enabled: false })); container.dispatchEvent(new Event("input", { bubbles: true })); };
    fetch("/api/mcp/status").then(response => response.json()).then(data => {
      if (settings !== next) return;
      for (const server of data.servers || []) for (const node of container.querySelectorAll("[data-mcp-status]")) if (node.dataset.mcpStatus === server.name) node.textContent = `${labels[server.state] || server.state} · ${server.toolCount} 个工具${server.error ? ` · ${server.error}` : ""}`;
    }).catch(() => {});
  }
  window.McpSettings = { render, collect };
})();
