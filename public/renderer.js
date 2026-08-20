
    // ========== 全局状态 ==========
    const messagesEl = document.getElementById("messages");
    const inputEl = document.getElementById("input");
    const formEl = document.getElementById("input-form");
    const submitBtn = document.getElementById("submit");
    const personaSelect = document.getElementById("persona-select");
    const personaInfo = document.getElementById("persona-info");
    const sessionListEl = document.getElementById("session-list");
    const currentTitleEl = document.getElementById("current-title");
    const taskPanel = document.getElementById("task-panel");
    const taskListEl = document.getElementById("task-list");
    const taskProgressText = document.getElementById("task-progress-text");
    const subagentPanel = document.getElementById("subagent-panel");
    const subagentListEl = document.getElementById("subagent-list");
    const subagentProgressText = document.getElementById("subagent-progress-text");
    const slashMenu = document.getElementById("slash-menu");
    const pinArea = document.getElementById("pin-area");
    const statusDot = document.getElementById("status-dot");
    const statusText = document.getElementById("status-text");
    const statusTokens = document.getElementById("status-tokens");
    const statusModel = document.getElementById("status-model");
    const statusPersona = document.getElementById("status-persona");
    const appVersionEl = document.getElementById("app-version");

    let currentSessionId = null;
    const inputHistoryBySession = new Map();
    let historyNavIndex = -1;
    function sessionHistory(sessionId) {
      if (!inputHistoryBySession.has(sessionId)) {
        try { inputHistoryBySession.set(sessionId, JSON.parse(localStorage.getItem("rd-history-" + sessionId) || "[]")); }
        catch { inputHistoryBySession.set(sessionId, []); }
      }
      return inputHistoryBySession.get(sessionId);
    }
    function pushSessionHistory(sessionId, text) {
      if (!sessionId || !text) return;
      const history = sessionHistory(sessionId);
      if (history[history.length - 1] !== text) history.push(text);
      if (history.length > 50) history.splice(0, history.length - 50);
      try { localStorage.setItem("rd-history-" + sessionId, JSON.stringify(history)); } catch {}
    }
    function saveDraft(sessionId, value) {
      if (!sessionId) return;
      try { localStorage.setItem("rd-draft-" + sessionId, value); } catch {}
    }
    function restoreDraft(sessionId) {
      historyNavIndex = -1;
      let value = "";
      try { value = localStorage.getItem("rd-draft-" + sessionId) || ""; } catch {}
      inputEl.value = value;
      resizeMessageInput();
    }
    const activeRunsBySession = new Map();
    const questionsBySession = new Map();
    let subagentPollTimer = null;

    function sessionHeaders(sessionId = currentSessionId, json = false) {
      const headers = {};
      if (json) headers["Content-Type"] = "application/json";
      if (sessionId) headers["X-RainyDays-Session"] = sessionId;
      return headers;
    }

    if (typeof marked !== "undefined") { marked.setOptions({ breaks: true, gfm: true }); }

    function sanitizeHtml(html) {
      const template = document.createElement("template");
      template.innerHTML = html;
      const allowedTags = new Set([
        "P", "BR", "PRE", "CODE", "STRONG", "B", "EM", "I", "DEL", "S", "BLOCKQUOTE",
        "UL", "OL", "LI", "H1", "H2", "H3", "H4", "H5", "H6", "HR", "A", "IMG",
        "TABLE", "THEAD", "TBODY", "TFOOT", "TR", "TH", "TD", "DETAILS", "SUMMARY",
      ]);
      const allowedAttributes = new Set(["href", "src", "alt", "title", "class", "colspan", "rowspan", "start"]);
      const dangerousTags = new Set(["SCRIPT", "STYLE", "IFRAME", "OBJECT", "EMBED", "LINK", "META", "FORM", "INPUT", "BUTTON", "SVG", "MATH", "TEMPLATE"]);

      for (const el of Array.from(template.content.querySelectorAll("*")).reverse()) {
        if (dangerousTags.has(el.tagName)) { el.remove(); continue; }
        if (!allowedTags.has(el.tagName)) {
          el.replaceWith(document.createTextNode(el.textContent || ""));
          continue;
        }
        for (const attr of Array.from(el.attributes)) {
          const name = attr.name.toLowerCase();
          if (!allowedAttributes.has(name)) { el.removeAttribute(attr.name); continue; }
          if (name === "href" || name === "src") {
            const normalized = attr.value.replace(/[\u0000-\u0020\u007f-\u009f]/g, "");
            try {
              const parsed = new URL(normalized, location.href);
              const allowedProtocols = name === "href" ? new Set(["http:", "https:", "mailto:"]) : new Set(["http:", "https:"]);
              if (!allowedProtocols.has(parsed.protocol)) el.removeAttribute(attr.name);
              else el.setAttribute(attr.name, normalized);
            } catch { el.removeAttribute(attr.name); }
          }
        }
        if (el.tagName === "A") {
          el.setAttribute("rel", "noopener noreferrer");
          el.setAttribute("target", "_blank");
        }
      }
      return template.innerHTML;
    }

    function highlightRenderedCode() {
      if (typeof hljs === "undefined") return;
      document.querySelectorAll("pre code:not([data-highlighted])").forEach(block => {
        try { hljs.highlightElement(block); block.dataset.highlighted = "true"; } catch(e) {}
      });
    }

    function renderMarkdown(text) {
      if (typeof marked !== "undefined") {
        try {
          const html = sanitizeHtml(marked.parse(text));
          setTimeout(highlightRenderedCode, 0);
          return html;
        } catch(e) { return escapeHtml(text); }
      }
      return escapeHtml(text);
    }

    const slashCommands = [
      { cmd: "/clear", desc: "清空当前对话记忆", action: () => clearChat() },
      { cmd: "/compact", desc: "手动压缩对话历史", action: () => sendSlashMessage("请压缩对话历史") },
      { cmd: "/persona", desc: "切换 Persona（后接名称）", action: null },
      { cmd: "/pin", desc: "固定一条持久指令（后接内容）", action: null },
      { cmd: "/pins", desc: "列出所有固定指令", action: () => loadPins() },
      { cmd: "/unpin", desc: "移除固定指令（后接序号）", action: null },
      { cmd: "/rollback", desc: "回退到上一个用户消息", action: () => rollback() },
      { cmd: "/regenerate", desc: "重新生成上一轮回复", action: () => regenerateResponse() },
      { cmd: "/fork", desc: "从当前位置分叉新对话", action: () => forkCurrentSession() },
      { cmd: "/export", desc: "导出当前对话", action: () => exportCurrentSession() },
      { cmd: "/import", desc: "导入对话文件", action: () => document.getElementById("import-file").click() },
      { cmd: "/search", desc: "搜索对话（后接关键词）", action: null },
      { cmd: "/task", desc: "显示当前任务列表", action: () => sendMessage("列出当前任务") },
      { cmd: "/time", desc: "获取当前时间", action: () => sendMessage("现在几点了？") },
      { cmd: "/tts", desc: "开启/关闭语音播报", action: () => toggleTTS() },
      { cmd: "/voice", desc: "开始语音输入", action: () => toggleASR() },
      { cmd: "/settings", desc: "打开设置面板", action: () => openSettings() },
      { cmd: "/files", desc: "打开文件查看器", action: () => toggleFileViewer(true) },
      { cmd: "/terminal", desc: "打开持久终端面板", action: () => toggleTerminal(true) },
    ];

    let slashSelectedIdx = 0;

    function showSlashMenu(query) {
      const filtered = slashCommands.filter(c => c.cmd.startsWith(query));
      if (filtered.length === 0) { slashMenu.classList.remove("visible"); return; }
      slashSelectedIdx = 0;
      slashMenu.innerHTML = filtered.map((c, i) =>
        `<div class="slash-item ${i === 0 ? "selected" : ""}" data-cmd="${c.cmd}" data-idx="${i}"><span class="cmd">${c.cmd}</span><span class="desc">${c.desc}</span></div>`
      ).join("");
      slashMenu.classList.add("visible");
      slashMenu.querySelectorAll(".slash-item").forEach(item => {
        item.addEventListener("click", () => { inputEl.value = item.dataset.cmd + " "; slashMenu.classList.remove("visible"); inputEl.focus(); });
      });
    }

    function handleSlashCommand(text) {
      const parts = text.trim().split(/\\s+/);
      const cmd = parts[0]; const arg = parts.slice(1).join(" ");
      const match = slashCommands.find(c => c.cmd === cmd);
      if (match && match.action) { match.action(); return true; }
      if (cmd === "/pin" && arg) { addPin(arg); return true; }
      if (cmd === "/unpin" && arg) { removePin(parseInt(arg)); return true; }
      if (cmd === "/persona" && arg) { personaSelect.value = arg; switchPersona(); return true; }
      if (cmd === "/search" && arg) { document.getElementById("search-input").value = arg; doSearch(arg); return true; }
      return false;
    }

    // ========== 搜索 ==========
    let searchTimer = null;
    document.getElementById("search-input").addEventListener("input", (e) => {
      clearTimeout(searchTimer);
      const q = e.target.value.trim();
      if (!q) {
        document.getElementById("session-list").hidden = false;
        document.getElementById("search-results").hidden = true;
        return;
      }
      searchTimer = setTimeout(() => doSearch(q), 300);
    });

    async function doSearch(query) {
      try {
        const res = await fetch(`/api/search?q=${encodeURIComponent(query)}`);
        const data = await res.json();
        const resultsEl = document.getElementById("search-results");
        const sessionList = document.getElementById("session-list");
        sessionList.hidden = true;
        resultsEl.hidden = false;
        resultsEl.innerHTML = "";

        if (!data.results || data.results.length === 0) {
          resultsEl.innerHTML = '<div class="empty-sessions">未找到匹配的对话</div>';
          return;
        }

        // 按会话分组
        const grouped = {};
        for (const r of data.results) {
          if (!grouped[r.session_id]) {
            grouped[r.session_id] = { title: r.session_title, persona: r.session_persona, items: [] };
          }
          grouped[r.session_id].items.push(r);
        }

        for (const [sid, group] of Object.entries(grouped)) {
          for (const item of group.items.slice(0, 2)) {
            const el = document.createElement("div");
            el.className = "search-result-item";
            const snippet = item.content.slice(0, 80).replace(/\\n/g, " ");
            el.innerHTML = `<div class="sr-title">${escapeHtml(group.title)}</div><div class="sr-snippet">${escapeHtml(snippet)}...</div>`;
            el.addEventListener("click", () => {
              document.getElementById("search-input").value = "";
              resultsEl.hidden = true;
              sessionList.hidden = false;
              selectSession(sid);
            });
            resultsEl.appendChild(el);
          }
        }
      } catch (err) { console.error("搜索失败:", err); }
    }

    // ========== Fork ==========
    async function forkCurrentSession(messageId) {
      if (!currentSessionId) { addSystemMessage("⚠️ 请先选择一个对话"); return; }
      try {
        const res = await fetch(`/api/sessions/${currentSessionId}/fork`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageId: messageId || null }),
        });
        const data = await res.json();
        if (data.session) {
          addSystemMessage("🔱 已从当前对话分叉出新对话: " + data.session.title);
          await loadSessions();
          await selectSession(data.session.id);
        } else if (data.error) {
          addSystemMessage("⚠️ Fork 失败: " + data.error);
        }
      } catch (err) { addSystemMessage("⚠️ Fork 错误: " + err.message); }
    }

    // ========== 导出 ==========
    async function exportCurrentSession() {
      if (!currentSessionId) { addSystemMessage("⚠️ 请先选择一个对话"); return; }
      try {
        const res = await fetch(`/api/sessions/${currentSessionId}/export`);
        const data = await res.json();
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url; a.download = `${data.session.title || "对话"}.json`;
        a.click(); URL.revokeObjectURL(url);
        addSystemMessage("📥 已导出: " + (data.session.title || "对话"));
      } catch (err) { addSystemMessage("⚠️ 导出失败: " + err.message); }
    }

    // ========== 导入 ==========
    async function importSession(event) {
      const file = event.target.files[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        const res = await fetch("/api/sessions/import", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify(data),
        });
        const result = await res.json();
        if (result.session) {
          addSystemMessage("📤 已导入: " + result.session.title);
          await loadSessions();
          await selectSession(result.session.id);
        } else if (result.error) {
          addSystemMessage("⚠️ 导入失败: " + result.error);
        }
      } catch (err) { addSystemMessage("⚠️ 导入错误: " + err.message); }
      event.target.value = "";
    }

    async function addPin(content) {
      if (!currentSessionId) await newChat();
      await fetch(`/api/sessions/${currentSessionId}/pins`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content }) });
      loadPins(); addSystemMessage("📌 已固定指令: " + content);
    }
    async function removePin(index) {
      const pins = pinArea.querySelectorAll(".pin-item"); if (index < 1 || index > pins.length) return;
      const pinId = pins[index - 1].dataset.pinId;
      await fetch(`/api/sessions/${currentSessionId}/pins/${pinId}`, { method: "DELETE" });
      loadPins(); addSystemMessage("📌 已移除指令 #" + index);
    }
    async function loadPins() {
      if (!currentSessionId) { pinArea.classList.remove("visible"); return; }
      try {
        const res = await fetch(`/api/sessions/${currentSessionId}/pins`); const data = await res.json();
        if (data.pins && data.pins.length > 0) {
          pinArea.classList.add("visible");
          pinArea.innerHTML = data.pins.map((p, i) => `<div class="pin-item" data-pin-id="${escapeHtml(p.id)}"><span class="pin-icon">📌</span><span>${escapeHtml(p.content)}</span><button class="pin-del" data-action="remove-pin" data-pin-index="${i + 1}" aria-label="移除固定指令">✕</button></div>`).join("");
        } else pinArea.classList.remove("visible");
      } catch {}
    }

    async function rollback() {
      if (!currentSessionId) return;
      const res = await fetch(`/api/sessions/${currentSessionId}/rollback`, { method: "POST" }); const data = await res.json();
      addSystemMessage("⏪ 已回退 " + data.deletedMessages + " 条消息"); await selectSession(currentSessionId);
    }

    async function regenerateResponse() {
      if (!currentSessionId) return;
      if (isSessionRunning(currentSessionId)) { addSystemMessage("⚠️ 当前会话正在运行，稍后再试"); return; }
      const res = await fetch(`/api/sessions/${currentSessionId}/rollback`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { addSystemMessage("⚠️ " + (data.error || "回退失败")); return; }
      const mres = await fetch(`/api/sessions/${currentSessionId}/messages`);
      const mdata = await mres.json().catch(() => ({}));
      const lastUser = [...(mdata.messages || [])].reverse().find(m => m.role === "user");
      await selectSession(currentSessionId);
      if (!lastUser) { addSystemMessage("⚠️ 没有可重新生成的用户消息"); return; }
      sendMessage(lastUser.content);
    }

    // ========== Persistent Terminal ==========
    let terminalSessions = [];
    let activeTerminalId = null;
    let terminalEvents = null;
    let terminalHistory = [];
    let terminalHistoryIndex = -1;

    async function toggleTerminal(forceOpen) {
      const panel = document.getElementById("terminal-panel");
      const shouldOpen = forceOpen === true || !panel.classList.contains("visible");
      panel.classList.toggle("visible", shouldOpen);
      if (shouldOpen) {
        await loadTerminals();
        document.getElementById("terminal-input").focus();
      }
    }

    async function loadTerminals() {
      try {
        const res = await fetch("/api/terminals", { headers: sessionHeaders() });
        const data = await res.json();
        terminalSessions = data.terminals || [];
        renderTerminalTabs();
        if (activeTerminalId && !terminalSessions.some(t => t.id === activeTerminalId)) activeTerminalId = null;
        if (!activeTerminalId && terminalSessions.length > 0) await selectTerminal(terminalSessions[0].id);
        else updateTerminalInputState();
      } catch (err) { addSystemMessage("⚠️ 终端列表加载失败: " + err.message); }
    }

    function renderTerminalTabs() {
      const tabs = document.getElementById("terminal-tabs");
      tabs.replaceChildren();
      for (const terminal of terminalSessions) {
        const tab = document.createElement("button");
        tab.className = `terminal-tab ${terminal.id === activeTerminalId ? "active" : ""}`;
        tab.dataset.action = "select-terminal";
        tab.dataset.terminalId = terminal.id;
        const dot = document.createElement("span");
        dot.className = `term-dot ${terminal.status === "running" ? "" : "stopped"}`;
        const name = document.createElement("span");
        name.textContent = terminal.name;
        tab.append(dot, name);
        tabs.appendChild(tab);
      }
      if (terminalSessions.length === 0) {
        const empty = document.createElement("span");
        empty.className = "terminal-empty-label";
        empty.textContent = "无终端";
        tabs.appendChild(empty);
        document.getElementById("terminal-output").innerHTML = '<div id="terminal-empty">点击 ＋ 创建持久终端</div>';
      }
    }

    async function createTerminal() {
      try {
        const shell = document.getElementById("terminal-shell-select").value;
        if (typeof window.electronAPI?.terminalStart !== "function") throw new Error("manual terminal unavailable");
        const data = await window.electronAPI.terminalStart({ shell });
        terminalSessions.unshift(data.terminal);
        await selectTerminal(data.terminal.id);
      } catch (err) { addSystemMessage("⚠️ " + err.message); }
    }

    async function selectTerminal(id) {
      activeTerminalId = id;
      if (terminalEvents) { terminalEvents.close(); terminalEvents = null; }
      renderTerminalTabs();
      const output = document.getElementById("terminal-output");
      output.textContent = "";

      const eventSessionId = currentSessionId;
      terminalEvents = new EventSource(`/api/terminals/${encodeURIComponent(id)}/events?sessionId=${encodeURIComponent(eventSessionId || "")}`);
      terminalEvents.onmessage = (event) => {
        const data = JSON.parse(event.data);
        if (data.type === "snapshot") {
          output.textContent = data.data || "";
          updateTerminalInfo(data.info);
        } else if (data.type === "output") {
          appendTerminalOutput(data.data || "");
        } else if (data.type === "status") {
          const terminal = terminalSessions.find(t => t.id === id);
          if (terminal) { terminal.status = data.status; terminal.exitCode = data.exitCode; }
          renderTerminalTabs(); updateTerminalInputState();
          appendTerminalOutput(`\n[进程状态: ${data.status}${data.exitCode === null ? "" : `, exit ${data.exitCode}`} ]\n`);
        }
      };
      terminalEvents.onerror = () => {
        if (terminalEvents && activeTerminalId === id) updateTerminalInputState();
      };
      updateTerminalInputState();
      document.getElementById("terminal-input").focus();
    }

    function updateTerminalInfo(info) {
      if (!info) return;
      const index = terminalSessions.findIndex(t => t.id === info.id);
      if (index >= 0) terminalSessions[index] = info;
      else terminalSessions.unshift(info);
      renderTerminalTabs(); updateTerminalInputState();
    }

    function appendTerminalOutput(text) {
      const output = document.getElementById("terminal-output");
      output.textContent += text;
      if (output.textContent.length > 500000) output.textContent = output.textContent.slice(-500000);
      output.scrollTop = output.scrollHeight;
    }

    function updateTerminalInputState() {
      const input = document.getElementById("terminal-input");
      const terminal = terminalSessions.find(t => t.id === activeTerminalId);
      input.disabled = !terminal || terminal.status !== "running";
      input.placeholder = input.disabled ? "终端未运行" : `发送到 ${terminal.name}`;
    }

    async function sendTerminalInput() {
      const input = document.getElementById("terminal-input");
      const command = input.value;
      if (!activeTerminalId || !command || input.disabled) return;
      try {
        if (typeof window.electronAPI?.terminalInput !== "function") throw new Error("manual terminal unavailable");
        await window.electronAPI.terminalInput({ id:activeTerminalId, input:command });
        terminalHistory.push(command); terminalHistoryIndex = terminalHistory.length;
        input.value = "";
      } catch (err) { appendTerminalOutput(`\n[发送失败] ${err.message}\n`); }
    }

    async function clearActiveTerminal() {
      if (!activeTerminalId) return;
      if (typeof window.electronAPI?.terminalClear !== "function") throw new Error("manual terminal unavailable");
      await window.electronAPI.terminalClear({ id:activeTerminalId });
      document.getElementById("terminal-output").textContent = "";
    }

    async function killActiveTerminal() {
      if (!activeTerminalId) return;
      if (typeof window.electronAPI?.terminalKill !== "function") throw new Error("manual terminal unavailable");
      try {
        const data = await window.electronAPI.terminalKill({ id:activeTerminalId });
        updateTerminalInfo(data.terminal);
      } catch (err) { appendTerminalOutput(`\n[终止失败] ${err.message}\n`); }
    }

    async function closeActiveTerminal() {
      if (!activeTerminalId) return;
      const closingId = activeTerminalId;
      if (typeof window.electronAPI?.terminalClose !== "function") throw new Error("manual terminal unavailable");
      if (terminalEvents) { terminalEvents.close(); terminalEvents = null; }
      try { await window.electronAPI.terminalClose({ id:closingId }); }
      catch { return; }
      terminalSessions = terminalSessions.filter(t => t.id !== closingId);
      activeTerminalId = null;
      renderTerminalTabs();
      if (terminalSessions.length > 0) await selectTerminal(terminalSessions[0].id);
      else updateTerminalInputState();
    }

    const terminalInputEl = document.getElementById("terminal-input");
    terminalInputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); sendTerminalInput(); }
      else if (e.ctrlKey && e.key.toLowerCase() === "l") { e.preventDefault(); clearActiveTerminal(); }
      else if (e.key === "ArrowUp" && terminalHistory.length > 0) { e.preventDefault(); terminalHistoryIndex = Math.max(0, terminalHistoryIndex - 1); terminalInputEl.value = terminalHistory[terminalHistoryIndex] || ""; }
      else if (e.key === "ArrowDown" && terminalHistory.length > 0) { e.preventDefault(); terminalHistoryIndex = Math.min(terminalHistory.length, terminalHistoryIndex + 1); terminalInputEl.value = terminalHistory[terminalHistoryIndex] || ""; }
    });

    // ========== File Viewer ==========
    let fileRoots = [];
    let currentFileRoot = "workspace";
    let currentFilePath = "";
    let fileEntries = [];
    let fileOffset = 0;
    let fileHasMore = false;
    let selectedFilePath = "";
    let selectedAbsoluteFilePath = "";
    let selectedFileRoot = "workspace";
    let filePreviewOffset = 1;
    const filePageSize = 200;
    const previewPageSize = 500;
    let fileDirectoryGeneration = 0;
    let filePreviewGeneration = 0;

    async function toggleFileViewer(forceOpen) {
      const panel = document.getElementById("file-viewer");
      const shouldOpen = forceOpen === true || (forceOpen !== false && !panel.classList.contains("visible"));
      panel.classList.toggle("visible", shouldOpen);
      if (!shouldOpen) return;
      try {
        await ensureFileRoots();
        await openFileDirectory(currentFilePath, false);
      } catch (err) { showFileError(err.message); }
    }

    async function ensureFileRoots(force = false) {
      if (fileRoots.length > 0 && !force) return fileRoots;
      const res = await fetch("/api/files/roots", { headers: sessionHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "根目录加载失败");
      fileRoots = data.roots || [];
      const select = document.getElementById("file-root-select");
      select.innerHTML = "";
      for (const root of fileRoots) {
        const option = document.createElement("option");
        option.value = root.id;
        option.textContent = `${root.name}${root.available ? "" : "（不可用）"}`;
        option.disabled = !root.available;
        select.appendChild(option);
      }
      if (!fileRoots.some(root => root.id === currentFileRoot && root.available)) {
        currentFileRoot = fileRoots.find(root => root.available)?.id || "workspace";
      }
      select.value = currentFileRoot;
      return fileRoots;
    }

    async function changeFileRoot() {
      currentFileRoot = document.getElementById("file-root-select").value;
      currentFilePath = "";
      selectedFilePath = "";
      document.getElementById("file-search").value = "";
      try { await openFileDirectory("", false); }
      catch (err) { showFileDirectoryError(err.message); }
    }

    async function refreshFileDirectory() {
      try {
        await ensureFileRoots(true);
        document.getElementById("file-root-select").value = currentFileRoot;
        await openFileDirectory(currentFilePath, false);
      } catch (err) { showFileDirectoryError(err.message); }
    }

    async function openFileDirectory(relativePath = "", append = false) {
      const generation = ++fileDirectoryGeneration;
      const requestedRoot = currentFileRoot;
      const offset = append ? fileOffset : 0;
      const query = new URLSearchParams({ root: requestedRoot, path: relativePath, offset: String(offset), limit: String(filePageSize) });
      const res = await fetch(`/api/files/list?${query}`, { headers: sessionHeaders() });
      const data = await res.json();
      if (generation !== fileDirectoryGeneration || requestedRoot !== currentFileRoot) return;
      if (!res.ok) throw new Error(data.error || "目录加载失败");
      currentFilePath = data.path || "";
      fileOffset = data.offset + data.entries.length;
      fileHasMore = Boolean(data.hasMore);
      fileEntries = append ? fileEntries.concat(data.entries || []) : (data.entries || []);
      if (!append) {
        selectedFilePath = "";
        selectedAbsoluteFilePath = "";
        selectedFileRoot = currentFileRoot;
        clearFilePreview();
      }
      renderFileBreadcrumbs();
      renderFileEntries();
      document.getElementById("file-list-count").textContent = `${fileEntries.length}/${data.total} 项`;
      document.getElementById("file-load-more").hidden = !fileHasMore;
    }

    async function loadMoreFiles() {
      if (!fileHasMore) return;
      try { await openFileDirectory(currentFilePath, true); }
      catch (err) { showFileError(err.message); }
    }

    function renderFileBreadcrumbs() {
      const container = document.getElementById("file-breadcrumbs");
      container.innerHTML = "";
      const root = fileRoots.find(item => item.id === currentFileRoot);
      const parts = currentFilePath ? currentFilePath.split(/[\\/]/).filter(Boolean) : [];
      const addCrumb = (label, target) => {
        const button = document.createElement("button");
        button.className = "file-crumb";
        button.textContent = label;
        button.addEventListener("click", () => openFileDirectory(target, false).catch(err => showFileError(err.message)));
        container.appendChild(button);
      };
      addCrumb(root?.name || currentFileRoot, "");
      let accumulated = "";
      for (const part of parts) {
        const separator = accumulated ? "\\" : "";
        accumulated += separator + part;
        const divider = document.createElement("span"); divider.textContent = "›"; container.appendChild(divider);
        addCrumb(part, accumulated);
      }
    }

    function renderFileEntries() {
      const list = document.getElementById("file-list");
      const filter = document.getElementById("file-search").value.trim().toLocaleLowerCase();
      const visible = fileEntries.filter(entry => !filter || entry.name.toLocaleLowerCase().includes(filter));
      list.innerHTML = "";
      if (visible.length === 0) {
        list.innerHTML = `<div class="file-list-message">${filter ? "当前页没有匹配项" : "目录为空"}</div>`;
        return;
      }
      for (const entry of visible) {
        const row = document.createElement("div");
        row.className = `file-entry ${entry.path === selectedFilePath ? "active" : ""}`;
        row.title = entry.path;
        const icon = document.createElement("span"); icon.textContent = entry.type === "directory" ? "📁" : fileIcon(entry.extension);
        const name = document.createElement("span"); name.className = "file-entry-name"; name.textContent = entry.name;
        const meta = document.createElement("span"); meta.className = "file-entry-meta"; meta.textContent = entry.type === "file" ? formatBytes(entry.size) : "";
        row.append(icon, name, meta);
        row.addEventListener("click", () => {
          if (entry.type === "directory") openFileDirectory(entry.path, false).catch(err => showFileError(err.message));
          else previewFile(entry.path, 1, entry.absolutePath).catch(err => showFileError(err.message));
        });
        list.appendChild(row);
      }
    }

    function fileIcon(ext) {
      if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"].includes(ext)) return "🖼️";
      if (ext === ".pdf") return "📕";
      if ([".docx", ".doc"].includes(ext)) return "📘";
      if ([".xlsx", ".xls"].includes(ext)) return "📊";
      if ([".md", ".markdown"].includes(ext)) return "📝";
      return "📄";
    }

    function formatBytes(value) {
      if (value === null || value === undefined) return "";
      if (value < 1024) return `${value} B`;
      if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
      return `${(value / 1024 / 1024).toFixed(1)} MB`;
    }

    function showFileDirectoryError(message) {
      fileEntries = [];
      document.getElementById("file-list").innerHTML = `<div class="file-list-message">⚠️ ${escapeHtml(message)}</div>`;
      document.getElementById("file-list-count").textContent = "加载失败";
      document.getElementById("file-load-more").hidden = true;
      clearFilePreview();
    }

    function clearFilePreview() {
      filePreviewGeneration++;
      document.getElementById("file-preview-meta").textContent = "选择文件以预览";
      document.getElementById("file-preview-actions").hidden = true;
      document.getElementById("file-preview-content").innerHTML = '<div class="file-preview-empty">支持文本、代码、Markdown、图片、PDF、DOCX 和 XLSX</div>';
      document.getElementById("file-preview-pager").hidden = true;
    }

    async function previewFile(relativePath, lineOffset = 1, absolutePath = selectedAbsoluteFilePath, rootId = currentFileRoot) {
      const generation = ++filePreviewGeneration;
      selectedFilePath = relativePath;
      selectedAbsoluteFilePath = absolutePath || "";
      selectedFileRoot = rootId;
      filePreviewOffset = lineOffset;
      renderFileEntries();
      const content = document.getElementById("file-preview-content");
      const meta = document.getElementById("file-preview-meta");
      const pager = document.getElementById("file-preview-pager");
      content.innerHTML = '<div class="file-preview-empty">正在加载预览...</div>';
      meta.textContent = selectedAbsoluteFilePath ? `${relativePath}\n${selectedAbsoluteFilePath}` : relativePath;
      document.getElementById("file-preview-actions").hidden = !selectedAbsoluteFilePath;
      pager.hidden = true;

      const query = new URLSearchParams({ root: rootId, path: relativePath, lineOffset: String(lineOffset), lineLimit: String(previewPageSize) });
      const res = await fetch(`/api/files/preview?${query}`, { headers: sessionHeaders() });
      const data = await res.json();
      if (generation !== filePreviewGeneration || selectedFilePath !== relativePath || selectedFileRoot !== rootId) return;
      if (!res.ok) throw new Error(data.error || "文件预览失败");

      selectedAbsoluteFilePath = data.absolutePath || selectedAbsoluteFilePath;
      document.getElementById("file-preview-actions").hidden = !selectedAbsoluteFilePath;
      meta.textContent = `${data.name} · ${formatBytes(data.size)} · ${data.modifiedAt ? new Date(data.modifiedAt).toLocaleString("zh-CN") : ""}\n${data.absolutePath || data.path}`;
      content.innerHTML = "";
      if (data.kind === "image") {
        const contentUrl = new URL(data.contentUrl, location.href); contentUrl.searchParams.set("sessionId", currentSessionId || "");
        const image = document.createElement("img"); image.src = contentUrl.href; image.alt = data.name; content.appendChild(image);
      } else if (data.kind === "pdf") {
        const contentUrl = new URL(data.contentUrl, location.href); contentUrl.searchParams.set("sessionId", currentSessionId || "");
        const frame = document.createElement("iframe"); frame.src = contentUrl.href; frame.title = data.name; content.appendChild(frame);
      } else if (data.kind === "markdown") {
        const article = document.createElement("article"); article.className = "markdown-preview"; article.innerHTML = renderMarkdown(data.text || ""); content.appendChild(article);
      } else if (data.kind === "text" || data.kind === "office") {
        const pre = document.createElement("pre");
        const code = document.createElement("code"); code.className = `language-${data.language || "plaintext"}`; code.textContent = data.text || "";
        pre.appendChild(code); content.appendChild(pre); setTimeout(highlightRenderedCode, 0);
      } else {
        const empty = document.createElement("div"); empty.className = "file-preview-empty"; empty.textContent = data.message || "暂不支持此文件类型"; content.appendChild(empty);
      }

      if (["text", "markdown", "office"].includes(data.kind)) {
        pager.hidden = false;
        document.getElementById("file-preview-page").textContent = `第 ${data.lineOffset}-${data.lineEnd} 行 / 共 ${data.totalLines} 行`;
        document.getElementById("file-preview-prev").disabled = data.lineOffset <= 1;
        document.getElementById("file-preview-next").disabled = !data.hasMore;
      }
    }

    async function pageFilePreview(direction) {
      if (!selectedFilePath) return;
      const next = Math.max(1, filePreviewOffset + direction * previewPageSize);
      try { await previewFile(selectedFilePath, next, selectedAbsoluteFilePath, selectedFileRoot); }
      catch (err) { showFileError(err.message); }
    }

    async function copySelectedFilePath() {
      if (!selectedAbsoluteFilePath) return;
      try {
        await navigator.clipboard.writeText(selectedAbsoluteFilePath);
        document.getElementById("file-preview-meta").textContent = `已复制路径\n${selectedAbsoluteFilePath}`;
      } catch {
        const helper = document.createElement("textarea");
        helper.value = selectedAbsoluteFilePath; helper.className = "clipboard-helper";
        document.body.appendChild(helper); helper.select();
        const copied = document.execCommand("copy"); helper.remove();
        if (!copied) addSystemMessage("⚠️ 无法复制路径，请手动复制预览标题中的路径。");
      }
    }

    async function revealSelectedFile() {
      if (!selectedFilePath) return;
      try {
        const res = await fetch("/api/files/reveal", {
          method: "POST", headers: sessionHeaders(currentSessionId, true),
          body: JSON.stringify({ root: selectedFileRoot, path: selectedFilePath }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "无法在资源管理器中定位");
      } catch (err) { showFileError(err.message); }
    }

    function useSelectedFileWithAgent() {
      if (!selectedAbsoluteFilePath) return;
      inputEl.value = `请处理这个文件：${selectedAbsoluteFilePath}`;
      inputEl.dispatchEvent(new Event("input"));
      toggleFileViewer(false);
      inputEl.focus();
    }

    function showFileError(message) {
      const content = document.getElementById("file-preview-content");
      const error = document.createElement("div"); error.className = "file-preview-empty"; error.textContent = `⚠️ ${message}`;
      content.innerHTML = ""; content.appendChild(error);
      document.getElementById("file-preview-meta").textContent = selectedAbsoluteFilePath ? `预览失败\n${selectedAbsoluteFilePath}` : "预览失败";
      document.getElementById("file-preview-actions").hidden = !selectedAbsoluteFilePath;
      document.getElementById("file-preview-pager").hidden = true;
    }

    function relativeDirectory(relativePath) {
      const parts = String(relativePath || "").split(/[\\/]/).filter(Boolean);
      parts.pop();
      return parts.join("\\");
    }

    async function openResolvedFilePath(absolutePath) {
      try {
        const res = await fetch(`/api/files/resolve?path=${encodeURIComponent(absolutePath)}`, { headers: sessionHeaders() });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "无法打开该路径");
        currentFileRoot = data.rootId;
        currentFilePath = data.type === "directory" ? data.path : relativeDirectory(data.path);
        await toggleFileViewer(true);
        document.getElementById("file-root-select").value = currentFileRoot;
        if (data.type === "file") await previewFile(data.path, 1, absolutePath, data.rootId);
      } catch (err) {
        addSystemMessage("⚠️ 文件查看器: " + err.message);
      }
    }

    const resolvedPathCache = new Map();
    const linkedFileExtensions = "txt|md|markdown|csv|log|json|jsonl|xml|ya?ml|toml|ini|conf|config|env|js|mjs|cjs|jsx|ts|tsx|css|scss|less|html?|vue|svelte|py|java|c|h|cpp|hpp|cs|go|rs|php|rb|sh|bash|ps1|bat|cmd|sql|graphql|gql|docx?|xlsx?|pdf|png|jpe?g|gif|webp|bmp";

    async function pathExistsInViewer(absolutePath) {
      if (resolvedPathCache.has(absolutePath)) return resolvedPathCache.get(absolutePath);
      const request = fetch(`/api/files/resolve?path=${encodeURIComponent(absolutePath)}`, { headers: sessionHeaders() })
        .then(res => res.ok)
        .catch(() => false);
      resolvedPathCache.set(absolutePath, request);
      return request;
    }

    function extractLocalPathCandidates(sourceText, roots) {
      const candidates = [];
      const source = String(sourceText || "");
      const add = candidate => {
        const cleaned = String(candidate || "").replace(/[\s，。；;：:!！?？)）\]\}]+$/g, "");
        if (cleaned && !candidates.some(item => item.toLocaleLowerCase() === cleaned.toLocaleLowerCase())) candidates.push(cleaned);
      };

      // 先识别任意 Windows 文件绝对路径；服务端会验证其真实目标是否属于允许根目录。
      const boundary = "(?=$|[\\s，。；;：:!！?？)）\\]\\}])";
      const drivePattern = new RegExp(`[A-Za-z]:[\\\\/][^\\r\\n\u0060\"'<>|]*?\\.(?:${linkedFileExtensions})${boundary}`, "gi");
      const uncPattern = new RegExp(`\\\\\\\\[^\\\\\\r\\n\u0060\"'<>|]+\\\\[^\\r\\n\u0060\"'<>|]*?\\.(?:${linkedFileExtensions})${boundary}`, "gi");
      for (const match of source.matchAll(drivePattern)) add(match[0]);
      for (const match of source.matchAll(uncPattern)) add(match[0]);

      // 根前缀识别保留目录路径和 POSIX 路径支持。
      const lower = source.toLocaleLowerCase();
      for (const root of roots) {
        const rootLower = root.path.toLocaleLowerCase();
        let searchFrom = 0;
        while (searchFrom < source.length) {
          const start = lower.indexOf(rootLower, searchFrom);
          if (start < 0) break;
          const lineRemainder = source.slice(start).split(/[\r\n`"'<>|]/, 1)[0].trim();
          const extensionMatch = lineRemainder.match(new RegExp(`^(.+?\\.(?:${linkedFileExtensions}))${boundary}`, "i"));
          add(extensionMatch ? extensionMatch[1] : lineRemainder);
          searchFrom = start + root.path.length;
        }
      }
      return candidates;
    }

    function createLocalFileLink(absolutePath) {
      const link = document.createElement("a");
      link.href = "#"; link.className = "local-file-link"; link.textContent = absolutePath; link.dataset.path = absolutePath; link.title = "在文件查看器中打开";
      link.addEventListener("click", (event) => { event.preventDefault(); openResolvedFilePath(absolutePath); });
      return link;
    }

    function replaceTextPathWithLink(container, absolutePath) {
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        if (!parent || parent.closest("a,.local-file-link") || ["SCRIPT", "STYLE"].includes(parent.tagName)) continue;
        const text = node.nodeValue || "";
        const start = text.toLocaleLowerCase().indexOf(absolutePath.toLocaleLowerCase());
        if (start < 0) continue;
        const fragment = document.createDocumentFragment();
        fragment.appendChild(document.createTextNode(text.slice(0, start)));
        fragment.appendChild(createLocalFileLink(absolutePath));
        fragment.appendChild(document.createTextNode(text.slice(start + absolutePath.length)));
        node.replaceWith(fragment);
        return true;
      }
      return false;
    }

    async function enhanceLocalFileLinks(container, sourceText) {
      if (!container || !container.isConnected) return;
      try { await ensureFileRoots(); } catch { return; }
      const availableRoots = fileRoots.filter(root => root.available && root.path).sort((a, b) => b.path.length - a.path.length);
      const candidates = extractLocalPathCandidates(sourceText === undefined ? container.innerText : sourceText, availableRoots);
      for (const absolutePath of candidates) {
        if (!(await pathExistsInViewer(absolutePath)) || !container.isConnected) continue;
        if (Array.from(container.querySelectorAll(".local-file-link")).some(link => link.dataset.path === absolutePath)) continue;
        if (replaceTextPathWithLink(container, absolutePath)) continue;
        const row = document.createElement("div"); row.className = "attachment-row";
        const label = document.createElement("span"); label.textContent = "📎 ";
        const link = createLocalFileLink(absolutePath); link.dataset.path = absolutePath;
        row.append(label, link); container.appendChild(row);
      }
    }

    // ========== Settings ==========
    let settingsState = null;
    let editingProviderName = null;

    function showSettingsMessage(message, type = "") {
      const el = document.getElementById("settings-message");
      el.textContent = message || "";
      el.className = type;
    }

    async function openSettings() {
      document.getElementById("settings-modal").classList.add("visible");
      showSettingsMessage("正在加载设置...");
      try {
        const res = await fetch("/api/settings");
        settingsState = await res.json();
        if (!res.ok) throw new Error(settingsState.error || "加载设置失败");
        renderSettings();
        showSettingsMessage(`配置文件: ${settingsState.configPath}`);
      } catch (err) {
        showSettingsMessage(err.message, "error");
      }
    }

    function closeSettings() {
      document.getElementById("settings-modal").classList.remove("visible");
    }

    function renderSettings() {
      if (!settingsState) return;
      const profiles = settingsState.profiles || [];
      const providerList = document.getElementById("settings-provider-list");
      providerList.replaceChildren();
      for (const profile of profiles) {
        const item = document.createElement("button");
        item.className = `settings-provider-item ${profile.name === editingProviderName ? "active" : ""}`;
        item.dataset.action = "select-provider";
        item.dataset.providerName = profile.name;
        const name = document.createElement("span");
        name.textContent = profile.name;
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = profile.isCurrent ? "当前" : profile.isDefault ? "默认" : "";
        item.append(name, badge);
        providerList.appendChild(item);
      }

      const defaultProfile = document.getElementById("setting-default-profile");
      defaultProfile.innerHTML = profiles.map(p => `<option value="${escapeHtml(p.name)}">${escapeHtml(p.name)} · ${escapeHtml(p.model)}</option>`).join("");
      defaultProfile.value = settingsState.defaultProfile;

      const defaultPersona = document.getElementById("setting-default-persona");
      defaultPersona.innerHTML = Array.from(personaSelect.options).map(o => `<option value="${escapeHtml(o.value)}">${escapeHtml(o.textContent)}</option>`).join("");
      defaultPersona.value = settingsState.settings.defaultPersona;
      document.getElementById("setting-workspace-root").value = settingsState.settings.workspaceRoot || "";
      document.getElementById("setting-department-root").value = settingsState.settings.departmentDataRoot || "";
      document.getElementById("setting-output-dir").value = settingsState.settings.outputDir || "";

      if (!editingProviderName && profiles.length > 0) editingProviderName = settingsState.currentProfile || profiles[0].name;
      const editing = profiles.find(p => p.name === editingProviderName);
      if (editing) fillProviderEditor(editing);
      else newProviderEditor(false);
    }

    function fillProviderEditor(profile) {
      editingProviderName = profile.name;
      document.getElementById("provider-name").value = profile.name;
      document.getElementById("provider-name").disabled = true;
      document.getElementById("provider-model").value = profile.model || "";
      document.getElementById("provider-base-url").value = profile.baseURL || "";
      document.getElementById("provider-type").value = profile.providerType || "openai-compatible";
      document.getElementById("provider-api-key").value = "";
      document.getElementById("provider-key-hint").textContent = profile.hasApiKey
        ? `已配置密钥：${profile.apiKeyHint}。留空将保留。`
        : "尚未配置 API Key。";
      document.getElementById("provider-delete-btn").disabled = (settingsState.profiles || []).length <= 1 || profile.isDefault || profile.isCurrent;
      document.getElementById("provider-switch-btn").disabled = profile.isCurrent;
      renderProviderSelection();
    }

    function renderProviderSelection() {
      document.querySelectorAll(".settings-provider-item").forEach(el => {
        const name = el.querySelector("span")?.textContent;
        el.classList.toggle("active", name === editingProviderName);
      });
    }

    function selectProviderEditor(name) {
      const profile = settingsState?.profiles?.find(p => p.name === name);
      if (profile) fillProviderEditor(profile);
    }

    function newProviderEditor(clearMessage = true) {
      editingProviderName = null;
      document.getElementById("provider-name").disabled = false;
      document.getElementById("provider-name").value = "";
      document.getElementById("provider-model").value = "";
      document.getElementById("provider-base-url").value = "";
      document.getElementById("provider-type").value = "openai-compatible";
      document.getElementById("provider-api-key").value = "";
      document.getElementById("provider-key-hint").textContent = "新 Provider 需要填写 API Key 才能对话。";
      document.getElementById("provider-delete-btn").disabled = true;
      document.getElementById("provider-switch-btn").disabled = true;
      renderProviderSelection();
      if (clearMessage) showSettingsMessage("");
    }

    async function refreshSettingsState() {
      const res = await fetch("/api/settings");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "刷新设置失败");
      settingsState = data;
      renderSettings();
      fileRoots = [];
      resolvedPathCache.clear();
      currentFilePath = "";
      await ensureFileRoots(true);
      if (document.getElementById("file-viewer").classList.contains("visible")) await openFileDirectory("", false);
      await loadPersonas();
      await updateStatus();
    }

    async function saveGeneralSettings() {
      try {
        const body = {
          defaultProfile: document.getElementById("setting-default-profile").value,
          defaultPersona: document.getElementById("setting-default-persona").value,
          workspaceRoot: document.getElementById("setting-workspace-root").value.trim(),
          departmentDataRoot: document.getElementById("setting-department-root").value.trim(),
          outputDir: document.getElementById("setting-output-dir").value.trim(),
        };
        const res = await fetch("/api/settings/general", { method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "保存失败");
        await refreshSettingsState();
        showSettingsMessage("通用设置已保存并热生效。", "success");
      } catch (err) { showSettingsMessage(err.message, "error"); }
    }

    async function saveProvider() {
      try {
        const name = document.getElementById("provider-name").value.trim();
        if (!name) throw new Error("请填写 Profile 名称");
        const body = {
          model: document.getElementById("provider-model").value.trim(),
          baseURL: document.getElementById("provider-base-url").value.trim(),
          providerType: document.getElementById("provider-type").value.trim(),
          apiKey: document.getElementById("provider-api-key").value.trim(),
        };
        const res = await fetch(`/api/settings/providers/${encodeURIComponent(name)}`, { method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify(body) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "保存失败");
        editingProviderName = name;
        await refreshSettingsState();
        showSettingsMessage(`Provider ${name} 已保存。`, "success");
      } catch (err) { showSettingsMessage(err.message, "error"); }
    }

    async function switchCurrentProvider() {
      if (!editingProviderName) return;
      try {
        const res = await fetch("/api/providers/switch", { method:"POST", headers:{"Content-Type":"application/json"}, body:JSON.stringify({name:editingProviderName}) });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "切换失败");
        await refreshSettingsState();
        showSettingsMessage(`已切换到 ${editingProviderName}。`, "success");
      } catch (err) { showSettingsMessage(err.message, "error"); }
    }

    async function deleteCurrentProvider() {
      if (!editingProviderName || !confirm(`确认删除 Provider ${editingProviderName}？`)) return;
      try {
        const res = await fetch(`/api/settings/providers/${encodeURIComponent(editingProviderName)}`, { method:"DELETE" });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || "删除失败");
        editingProviderName = null;
        await refreshSettingsState();
        showSettingsMessage("Provider 已删除。", "success");
      } catch (err) { showSettingsMessage(err.message, "error"); }
    }

    async function init() {
      await loadPersonas();
      await loadSessions();
      // 自动恢复：如果有 current session，加载它的消息
      if (currentSessionId) {
        await selectSession(currentSessionId);
      }
      const initialStatus = await updateStatus();
      if (initialStatus && !initialStatus.configured) {
        addSystemMessage("⚠️ 当前 Provider 尚未配置 API Key，请在 Settings 中完成配置后再开始对话。");
        setTimeout(openSettings, 200);
      }
      setInterval(updateStatus, 5000);
    }
    async function loadPersonas() {
      const res = await fetch("/api/personas"); const data = await res.json();
      personaSelect.innerHTML = data.personas.map(p => `<option value="${p.name}">${p.displayName}</option>`).join("");
      if (data.current) { personaSelect.value = data.current; showPersonaInfo(data.personas.find(p => p.name === data.current)); }
    }
    function showPersonaInfo(p) {
      if (!p) { personaInfo.hidden = true; personaInfo.replaceChildren(); return; }
      personaInfo.hidden = false;
      const mode = document.createTextNode("模式: ");
      const name = document.createElement("strong");
      name.textContent = p.displayName;
      const description = document.createTextNode(` · ${p.description} · 工具: `);
      const tools = document.createElement("span");
      tools.className = "tools";
      tools.textContent = `${p.tools.length}个`;
      personaInfo.replaceChildren(mode, name, description, tools);
    }
    async function switchPersona() {
      const name = personaSelect.value; if (!name) return;
      await fetch("/api/switch-persona", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) });
      await loadSessions(); updateStatus();
    }

    async function loadSessions() {
      const res = await fetch("/api/sessions"); const data = await res.json();
      currentSessionId = data.current;
      refreshRunControls();
      refreshQuestionForCurrentSession();
      sessionListEl.replaceChildren();
      if (!data.sessions || data.sessions.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty-sessions";
        empty.append("还没有对话", document.createElement("br"), "点击上方开始");
        sessionListEl.appendChild(empty);
        return;
      }
      for (const session of data.sessions) {
        const item = document.createElement("button");
        item.className = `session-item ${session.id === currentSessionId ? "active" : ""}`;
        item.dataset.action = "select-session";
        item.dataset.sessionId = session.id;
        const icon = document.createElement("span");
        icon.className = "icon";
        icon.textContent = "💬";
        const name = document.createElement("span");
        name.className = "name";
        name.textContent = session.title;
        const remove = document.createElement("span");
        remove.className = "del";
        remove.dataset.action = "delete-session";
        remove.dataset.sessionId = session.id;
        remove.setAttribute("role", "button");
        remove.setAttribute("aria-label", "删除对话");
        remove.textContent = "✕";
        item.append(icon, name, remove);
        sessionListEl.appendChild(item);
      }
    }
    async function newChat() {
      const res = await fetch("/api/sessions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({}) }); const data = await res.json();
      if (data.session) { currentSessionId = data.session.id; currentTitleEl.textContent = data.session.title; messagesEl.innerHTML = ""; restoreDraft(data.session.id); taskPanel.classList.remove("visible"); subagentPanel.classList.remove("visible"); subagentListEl.replaceChildren(); stopSubagentPolling(); refreshRunControls(); refreshQuestionForCurrentSession(); await loadSessions(); await loadPins(); inputEl.focus(); updateStatus(); }
    }
    async function selectSession(id) {
      const res = await fetch(`/api/sessions/${id}/select`, { method: "POST" }); const data = await res.json(); if (!data.session) return;
      currentSessionId = id; currentTitleEl.textContent = data.session.title; refreshRunControls(); refreshQuestionForCurrentSession(); restoreDraft(id);
      if (data.persona && personaSelect.value !== data.persona) { personaSelect.value = data.persona; const pres = await fetch("/api/personas"); const pdata = await pres.json(); showPersonaInfo(pdata.personas.find(p => p.name === data.persona)); }
      const mres = await fetch(`/api/sessions/${id}/messages`); const mdata = await mres.json();
      messagesEl.innerHTML = "";
      for (const msg of mdata.messages) { if (msg.role === "user") addMessage("user", msg.content, msg.id); else if (msg.role === "assistant" && msg.content) addMessage("assistant", msg.content, msg.id); }
      await loadSessions(); await loadPins(); await loadSessionTasks(id); await loadSessionSubagents(id); updateStatus();
    }
    async function deleteSession(id) {
      const response = await fetch(`/api/sessions/${id}`, { method: "DELETE" });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        if (currentSessionId === id) addSystemMessage("⚠️ " + (error.error || "删除对话失败"));
        return;
      }
      activeRunsBySession.delete(id);
      questionsBySession.delete(id);
      if (currentSessionId === id) { currentSessionId = null; currentTitleEl.textContent = "未选择对话"; messagesEl.innerHTML = '<div class="msg msg-assistant"><div class="bubble">对话已删除。</div></div>'; subagentPanel.classList.remove("visible"); subagentListEl.replaceChildren(); stopSubagentPolling(); refreshRunControls(); refreshQuestionForCurrentSession(); }
      await loadSessions();
    }

    function isSessionRunning(sessionId = currentSessionId) { return Boolean(sessionId && activeRunsBySession.has(sessionId)); }
    function refreshRunControls() {
      const running = isSessionRunning();
      submitBtn.disabled = running;
      statusDot.className = running ? "status-dot busy" : "status-dot";
      statusText.textContent = running ? "思考中..." : "就绪";
    }
    function beginSessionRun(sessionId) {
      const token = { controller: new AbortController(), runId: null, cancelling: false, bubble: null };
      activeRunsBySession.set(sessionId, token);
      refreshRunControls();
      return token;
    }
    function finishSessionRun(sessionId, token) {
      if (activeRunsBySession.get(sessionId) === token) activeRunsBySession.delete(sessionId);
      refreshRunControls();
    }
    async function cancelSessionRun(sessionId = currentSessionId) {
      const token = sessionId ? activeRunsBySession.get(sessionId) : null;
      if (!token || token.cancelling) return false;
      token.cancelling = true;
      try {
        if (token.runId) {
          await fetch("/api/chat/cancel", {
            method: "POST",
            headers: sessionHeaders(sessionId, true),
            body: JSON.stringify({ sessionId, runId: token.runId }),
          });
        }
      } finally {
        if (token.bubble) {
          token.bubble.innerHTML = "";
          token.bubble.textContent = "已中断";
        }
        token.controller.abort(new DOMException("Run cancelled by the local user", "AbortError"));
      }
      return true;
    }
    function sendMessage(text) { inputEl.value = text; formEl.requestSubmit(); }
    function sendSlashMessage(text) { if (!currentSessionId) newChat().then(() => sendMessage(text)); else sendMessage(text); }

    function resizeMessageInput() {
      inputEl.rows = 1;
      inputEl.rows = Math.min(5, Math.max(1, Math.ceil(inputEl.scrollHeight / 24)));
    }

    inputEl.addEventListener("input", () => {
      resizeMessageInput();
      const val = inputEl.value;
      historyNavIndex = -1;
      saveDraft(currentSessionId, val);
      if (val.startsWith("/")) showSlashMenu(val.split(/\\s/)[0]); else slashMenu.classList.remove("visible");
    });
    document.addEventListener("keydown", (event) => {
      if (event.key !== "Escape" || !isSessionRunning()) return;
      event.preventDefault();
      void cancelSessionRun().catch(() => undefined);
    });
    inputEl.addEventListener("keydown", (e) => {
      if (slashMenu.classList.contains("visible")) {
        if (e.key === "ArrowDown") { e.preventDefault(); slashSelectedIdx = Math.min(slashSelectedIdx + 1, slashMenu.children.length - 1); updateSlashSelection(); }
        else if (e.key === "ArrowUp") { e.preventDefault(); slashSelectedIdx = Math.max(slashSelectedIdx - 1, 0); updateSlashSelection(); }
        else if (e.key === "Tab" || (e.key === "Enter" && slashMenu.children.length > 0)) { const item = slashMenu.children[slashSelectedIdx]; if (item) { e.preventDefault(); inputEl.value = item.dataset.cmd + " "; slashMenu.classList.remove("visible"); inputEl.focus(); } }
        else if (e.key === "Escape") slashMenu.classList.remove("visible");
      }
      if (e.key === "Enter" && !e.shiftKey && !slashMenu.classList.contains("visible")) { e.preventDefault(); formEl.requestSubmit(); }
    });
    inputEl.addEventListener("keydown", (e) => {
      if (slashMenu.classList.contains("visible")) return;
      if (e.key !== "ArrowUp" && e.key !== "ArrowDown") return;
      if (!currentSessionId) return;
      const history = sessionHistory(currentSessionId);
      if (history.length === 0) return;
      const atStart = inputEl.selectionStart === 0 && inputEl.selectionEnd === 0;
      if (e.key === "ArrowUp" && atStart) {
        if (historyNavIndex === -1) historyNavIndex = history.length;
        if (historyNavIndex > 0) { historyNavIndex -= 1; inputEl.value = history[historyNavIndex]; e.preventDefault(); resizeMessageInput(); }
      } else if (e.key === "ArrowDown" && historyNavIndex !== -1) {
        if (historyNavIndex < history.length - 1) { historyNavIndex += 1; inputEl.value = history[historyNavIndex]; }
        else { historyNavIndex = -1; inputEl.value = ""; saveDraft(currentSessionId, ""); }
        e.preventDefault(); resizeMessageInput();
      }
    });
    function updateSlashSelection() { slashMenu.querySelectorAll(".slash-item").forEach((el, i) => el.classList.toggle("selected", i === slashSelectedIdx)); }

    formEl.addEventListener("submit", async (e) => {
      e.preventDefault(); const text = inputEl.value.trim(); if (!text || isSessionRunning()) return;
      if (text.startsWith("/")) { const handled = handleSlashCommand(text); if (handled) { inputEl.value = ""; inputEl.rows = 1; slashMenu.classList.remove("visible"); return; } }
      if (!currentSessionId) await newChat();
      const chatSessionId = currentSessionId;
      if (!chatSessionId || isSessionRunning(chatSessionId)) return;
      const runToken = beginSessionRun(chatSessionId);
      addMessage("user", text); inputEl.value = ""; inputEl.rows = 1; slashMenu.classList.remove("visible");
      historyNavIndex = -1; saveDraft(chatSessionId, ""); pushSessionHistory(chatSessionId, text);
      const assistantEl = addMessage("assistant", ""); const bubbleEl = assistantEl.querySelector(".bubble");
      runToken.bubble = bubbleEl;
      bubbleEl.innerHTML = '<div class="typing"><span></span><span></span><span></span></div>';
      let streamingStarted = false; let fullText = "";
      try {
        const response = await fetch("/api/chat", { method: "POST", headers: sessionHeaders(chatSessionId, true), body: JSON.stringify({ sessionId: chatSessionId, message: text }), signal: runToken.controller.signal });
        if (!response.ok) { const err = await response.json(); bubbleEl.innerHTML = ""; bubbleEl.textContent = "⚠️ " + (err.error || "请求失败"); return; }
        const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
        while (true) {
          const { done, value } = await reader.read(); if (done) break;
          buffer += decoder.decode(value); const lines = buffer.split("\n"); buffer = lines.pop();
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            const step = JSON.parse(line.slice(6));
            if (step.type === "run_started") {
              if (activeRunsBySession.get(chatSessionId) === runToken && step.sessionId === chatSessionId && typeof step.runId === "string") runToken.runId = step.runId;
              continue;
            }
            if (step.type === "ask_user") {
              if (rememberAskQuestion(step, chatSessionId) && currentSessionId === chatSessionId) refreshQuestionForCurrentSession();
              continue;
            }
            if (currentSessionId !== chatSessionId) continue;
            if (step.type === "notification") {
              if (typeof window.electronAPI?.notify === "function") {
                void window.electronAPI.notify({ id: `run-${step.runId}`, title: step.title, body: step.body }).catch(() => undefined);
              }
              continue;
            }
            if (step.type === "answer_chunk") { if (!streamingStarted) { bubbleEl.innerHTML = ""; streamingStarted = true; } fullText += step.content; bubbleEl.innerHTML = renderMarkdown(fullText); messagesEl.scrollTop = messagesEl.scrollHeight; }
            else if (step.type === "tool_call") { if (!streamingStarted) bubbleEl.innerHTML = ""; addToolCard(bubbleEl, step); }
            else if (step.type === "tool_result") updateLastToolCard(bubbleEl, step);
            else if (step.type === "task_created" || step.type === "task_update") { if (step.tasks && step.tasks.length > 0) renderTasks(step.tasks); }
            else if (step.type === "answer_done") { if (!streamingStarted && step.content) { bubbleEl.innerHTML = ""; fullText = step.content; bubbleEl.innerHTML = renderMarkdown(fullText); } else if (!streamingStarted && !step.content) { bubbleEl.innerHTML = ""; bubbleEl.textContent = "(无回复)"; } if (fullText) { speakText(fullText.slice(0, 200)); enhanceLocalFileLinks(bubbleEl, fullText); } }
            else if (step.type === "run_cancelled") { bubbleEl.innerHTML = ""; bubbleEl.textContent = "已中断"; }
            else if (step.type === "error") { bubbleEl.innerHTML = ""; bubbleEl.textContent = "⚠️ " + step.content; }
          }
        }
      } catch (err) {
        bubbleEl.innerHTML = "";
        bubbleEl.textContent = runToken.controller.signal.aborted || err?.name === "AbortError" ? "已中断" : "⚠️ 连接错误: " + err.message;
      }
      finally { finishSessionRun(chatSessionId, runToken); if (currentSessionId === chatSessionId) inputEl.focus(); }
      await loadSessions(); await loadPins(); await loadPersonas(); if (currentSessionId === chatSessionId) await loadSessionSubagents(chatSessionId);
      if (currentSessionId) { const sres = await fetch(`/api/sessions/${currentSessionId}/messages`); const sdata = await sres.json(); if (sdata.session) currentTitleEl.textContent = sdata.session.title; }
      messagesEl.scrollTop = messagesEl.scrollHeight; updateStatus();
    });

    function addMessage(role, content, messageId) {
      const el = document.createElement("div");
      el.className = `msg msg-${role} message-relative`;
      const bubble = document.createElement("div");
      bubble.className = "bubble";
      if (role === "user") bubble.textContent = content;
      else if (content) bubble.innerHTML = renderMarkdown(content);
      el.appendChild(bubble);
      if (messageId) {
        const actions = document.createElement("div");
        actions.className = "msg-actions";
        const fork = document.createElement("button");
        fork.className = "msg-action-btn";
        fork.dataset.action = "fork-message";
        fork.dataset.messageId = String(messageId);
        fork.textContent = "🔱 Fork";
        actions.appendChild(fork);
        el.appendChild(actions);
      }
      messagesEl.appendChild(el); messagesEl.scrollTop = messagesEl.scrollHeight;
      if (content) setTimeout(() => enhanceLocalFileLinks(bubble, content), 0);
      return el;
    }
    function addSystemMessage(text) {
      const el = document.createElement("div");
      el.className = "msg msg-assistant";
      const bubble = document.createElement("div");
      bubble.className = "bubble system-message";
      bubble.textContent = text;
      el.appendChild(bubble);
      messagesEl.appendChild(el); messagesEl.scrollTop = messagesEl.scrollHeight;
    }
    function addToolCard(parent, step) {
      const card = document.createElement("div");
      card.className = "tool-card";
      const icon = document.createElement("span");
      icon.className = "icon";
      icon.textContent = "⚙";
      const body = document.createElement("div");
      body.className = "tool-card-body";
      const label = document.createElement("span");
      label.className = "label";
      label.textContent = step.toolName;
      const status = document.createElement("span");
      status.className = "tool-card-status";
      status.textContent = " — 执行中...";
      body.append(label, status);
      if (step.toolArgs) {
        const args = document.createElement("pre");
        args.textContent = Object.entries(step.toolArgs).map(([key, value]) => `  ${key}: ${value}`).join("\n");
        body.appendChild(args);
      }
      card.append(icon, body);
      parent.appendChild(card);
    }
    function updateLastToolCard(parent, step) {
      const cards = parent.querySelectorAll(".tool-card"); const last = cards[cards.length - 1]; if (!last) return;
      const s = last.querySelector("span:nth-child(2)"); if (s) s.textContent = " — 完成";
      const preview = step.content.length > 300 ? step.content.slice(0, 300) + "..." : step.content;
      const pre = document.createElement("pre"); pre.textContent = preview; last.querySelector("div").appendChild(pre);
      setTimeout(() => enhanceLocalFileLinks(pre, step.content), 0);
    }
    async function clearChat() {
      const sessionId = currentSessionId;
      if (!sessionId) return;
      const response = await fetch("/api/clear", { method: "POST", headers: sessionHeaders(sessionId, true), body: JSON.stringify({ sessionId }) });
      if (!response.ok) {
        const error = await response.json().catch(() => ({}));
        if (currentSessionId === sessionId) addSystemMessage("⚠️ " + (error.error || "清空对话失败"));
        return;
      }
      if (currentSessionId !== sessionId) return;
      const all = messagesEl.querySelectorAll(".msg");
      for (let i = 1; i < all.length; i++) all[i].remove();
      addSystemMessage("🧹 对话记忆已清空");
    }
    function renderTasks(tasks) {
      if (!tasks || tasks.length === 0 || tasks.every(t => t.status === "completed")) {
        taskPanel.classList.remove("visible");
        taskListEl.textContent = "";
        return;
      }
      taskPanel.classList.add("visible");
      taskListEl.innerHTML = tasks.map(t => {
        const icon = t.status === "pending" && t.blocked ? "⛔" : ({ pending: "⏳", in_progress: "🔄", completed: "✅" }[t.status] || "?");
        const indicators = [t.blocked ? "[B]" : "", t.owner ? `[O:${escapeHtml(t.owner)}]` : ""].filter(Boolean).join(" ");
        const blockers = t.blockedBy && t.blockedBy.length > 0 ? ` blocked by ${t.blockedBy.map(escapeHtml).join(", ")}` : "";
        const detail = [indicators, t.activeForm ? escapeHtml(t.activeForm) : "", blockers].filter(Boolean).join(" · ");
        return `<div class="task-item"><span class="t-icon">${icon}</span><span class="t-id">${escapeHtml(t.id)}</span><span class="t-subject">${escapeHtml(t.subject)}${detail ? ` <span class="t-active">${detail}</span>` : ""}</span></div>`;
      }).join("");
      taskProgressText.textContent = `${tasks.filter(t => t.status === "completed").length}/${tasks.length} 完成`;
    }
    async function loadSessionTasks(sessionId) { try { const res = await fetch(`/api/sessions/${sessionId}/tasks`); const data = await res.json(); if (data.tasks && data.tasks.length > 0) renderTasks(data.tasks); else taskPanel.classList.remove("visible"); } catch {} }
    function stopSubagentPolling() {
      if (subagentPollTimer !== null) clearTimeout(subagentPollTimer);
      subagentPollTimer = null;
    }
    function scheduleSubagentPolling(sessionId) {
      stopSubagentPolling();
      if (currentSessionId !== sessionId) return;
      subagentPollTimer = setTimeout(() => { void loadSessionSubagents(sessionId); }, 1000);
    }
    function renderSubagents(subagents, sessionId) {
      if (currentSessionId !== sessionId) return;
      subagentListEl.replaceChildren();
      if (!Array.isArray(subagents) || subagents.length === 0) {
        subagentPanel.classList.remove("visible");
        subagentProgressText.textContent = "";
        stopSubagentPolling();
        return;
      }
      const icons = { running: "🔄", completed: "✅", failed: "❌", aborted: "⏹" };
      for (const child of subagents) {
        const item = document.createElement("div");
        item.className = "subagent-item";
        const icon = document.createElement("span");
        icon.className = "sa-icon";
        icon.textContent = icons[child.status] || "?";
        const id = document.createElement("span");
        id.className = "sa-id";
        id.textContent = child.taskId;
        const description = document.createElement("span");
        description.className = "sa-description";
        description.textContent = child.description;
        const persona = document.createElement("span");
        persona.className = "sa-persona";
        persona.textContent = child.persona;
        item.append(icon, id, description, persona);
        subagentListEl.appendChild(item);
      }
      const running = subagents.filter(child => child.status === "running").length;
      subagentProgressText.textContent = running > 0 ? `${running} 运行中 · ${subagents.length} 总计` : `${subagents.length} 已结束`;
      subagentPanel.classList.add("visible");
      if (running > 0) scheduleSubagentPolling(sessionId);
      else stopSubagentPolling();
    }
    async function loadSessionSubagents(sessionId) {
      stopSubagentPolling();
      if (!sessionId || currentSessionId !== sessionId) return;
      try {
        const response = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/subagents`);
        if (!response.ok) throw new Error("Subagent status unavailable");
        const data = await response.json();
        renderSubagents(data.subagents, sessionId);
      } catch {
        if (currentSessionId === sessionId) scheduleSubagentPolling(sessionId);
      }
    }
    async function updateStatus() {
      try {
        const res = await fetch("/api/status");
        const data = await res.json();
        statusTokens.textContent = `${data.tokens} tokens · ${data.messageCount} msgs`;
        statusModel.textContent = `${data.profile || "--"} · ${data.model}`;
        statusPersona.textContent = data.persona || "未选择";
        const version = data.version;
        let versionMismatch = false;
        if (version) {
          const shortBuild = String(version.buildId || "").split(".").at(-1).slice(0, 8);
          appVersionEl.textContent = `v${version.appVersion}${shortBuild ? ` · ${shortBuild}` : ""}`;
          appVersionEl.title = `RainyDays ${version.appVersion}\nBuild ID: ${version.buildId}\n点击下载诊断信息`;
          document.title = `RainyDays ${version.appVersion} (${version.buildId})`;
          const electron = window.electronAPI;
          versionMismatch = Boolean(electron?.isElectron && (electron.appVersion !== version.appVersion || electron.buildId !== version.buildId));
        }
        statusDot.classList.toggle("danger", versionMismatch || !data.configured);
        if (versionMismatch) statusText.textContent = "版本不一致";
        return data;
      } catch { return null; }
    }

    async function downloadDiagnostics() {
      try {
        const res = await fetch("/api/diagnostics");
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const disposition = res.headers.get("Content-Disposition") || "";
        const match = /filename="([^"]+)"/.exec(disposition);
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.download = match?.[1] || "rainydays-diagnostics.json";
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
      } catch (error) {
        statusText.textContent = `诊断下载失败: ${error.message}`;
      }
    }
    // ========== TTS 语音输出 ==========
    let ttsEnabled = false;
    let ttsUtterance = null;

    function toggleTTS() {
      ttsEnabled = !ttsEnabled;
      const btn = document.getElementById("tts-toggle");
      btn.textContent = ttsEnabled ? "🔊" : "🔇";
      btn.title = ttsEnabled ? "语音播报已开启" : "语音播报已关闭";
      if (!ttsEnabled && window.speechSynthesis) window.speechSynthesis.cancel();
    }

    function speakText(text) {
      if (!ttsEnabled || !window.speechSynthesis) return;
      window.speechSynthesis.cancel();
      ttsUtterance = new SpeechSynthesisUtterance(text);
      ttsUtterance.lang = "zh-CN";
      ttsUtterance.rate = 1.0;
      window.speechSynthesis.speak(ttsUtterance);
    }

    // ========== ASR 语音输入 ==========
    let asrRecognition = null;
    let asrActive = false;

    function toggleASR() {
      const btn = document.getElementById("mic-btn");
      if (asrActive) {
        if (asrRecognition) asrRecognition.stop();
        asrActive = false;
        btn.classList.remove("recording");
        btn.title = "语音输入";
        return;
      }

      const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
      if (!SpeechRecognition) {
        addSystemMessage("⚠️ 当前浏览器不支持语音输入");
        return;
      }

      asrRecognition = new SpeechRecognition();
      asrRecognition.lang = "zh-CN";
      asrRecognition.continuous = false;
      asrRecognition.interimResults = true;

      asrRecognition.onresult = (event) => {
        let transcript = "";
        for (let i = 0; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
        }
        inputEl.value = transcript;
        resizeMessageInput();
      };

      asrRecognition.onerror = (event) => {
        addSystemMessage("⚠️ 语音识别错误: " + event.error);
      };

      asrRecognition.onend = () => {
        asrActive = false;
        btn.classList.remove("recording");
        btn.title = "语音输入";
      };

      asrRecognition.start();
      asrActive = true;
      btn.classList.add("recording");
      btn.title = "正在录音... 点击停止";
    }

    function escapeHtml(str) { const div = document.createElement("div"); div.textContent = str || ""; return div.innerHTML; }

    function rememberAskQuestion(event, expectedSessionId) {
      if (!event || event.sessionId !== expectedSessionId
        || typeof event.runId !== "string" || !event.runId
        || typeof event.questionId !== "string" || !event.questionId
        || typeof event.question !== "string" || !event.question) return false;
      const options = Array.isArray(event.options) && event.options.every(option => typeof option === "string")
        ? Object.freeze([...event.options])
        : Object.freeze([]);
      questionsBySession.set(expectedSessionId, Object.freeze({
        sessionId: expectedSessionId,
        runId: event.runId,
        questionId: event.questionId,
        question: event.question,
        options,
      }));
      return true;
    }
    function refreshQuestionForCurrentSession() {
      const modal = document.getElementById("ask-modal");
      const optsEl = document.getElementById("ask-options");
      const question = currentSessionId ? questionsBySession.get(currentSessionId) : null;
      if (!question) {
        modal.classList.remove("visible");
        document.getElementById("ask-question-text").textContent = "";
        document.getElementById("ask-input").value = "";
        optsEl.replaceChildren();
        return;
      }
      document.getElementById("ask-question-text").textContent = question.question;
      optsEl.replaceChildren();
      for (const option of question.options) {
        const btn = document.createElement("div");
        btn.className = "ask-option";
        btn.textContent = option;
        btn.addEventListener("click", () => { document.getElementById("ask-input").value = option; submitAskAnswer(); });
        optsEl.appendChild(btn);
      }
      document.getElementById("ask-input").value = "";
      modal.classList.add("visible");
      document.getElementById("ask-input").focus();
    }
    async function submitAskAnswer() {
      const answer = document.getElementById("ask-input").value.trim();
      const answerSessionId = currentSessionId;
      const question = answerSessionId ? questionsBySession.get(answerSessionId) : null;
      if (!answer || !question || question.sessionId !== answerSessionId) return;
      document.getElementById("ask-modal").classList.remove("visible");
      const response = await fetch("/api/ask-user/answer", {
        method: "POST",
        headers: sessionHeaders(answerSessionId, true),
        body: JSON.stringify({ sessionId: question.sessionId, runId: question.runId, questionId: question.questionId, answer }),
      });
      if (response.ok && questionsBySession.get(answerSessionId) === question) questionsBySession.delete(answerSessionId);
      refreshQuestionForCurrentSession();
    }
    const actionHandlers = Object.freeze({
      "download-diagnostics": () => downloadDiagnostics(),
      "new-chat": () => newChat(),
      "toggle-file-viewer": () => toggleFileViewer(),
      "close-file-viewer": () => toggleFileViewer(false),
      "toggle-terminal": () => toggleTerminal(),
      "open-settings": () => openSettings(),
      "close-settings": () => closeSettings(),
      "export-session": () => exportCurrentSession(),
      "choose-import": () => document.getElementById("import-file").click(),
      "toggle-asr": () => toggleASR(),
      "create-terminal": () => createTerminal(),
      "clear-terminal": () => clearActiveTerminal(),
      "kill-terminal": () => killActiveTerminal(),
      "close-terminal": () => closeActiveTerminal(),
      "toggle-tts": () => toggleTTS(),
      "refresh-files": () => refreshFileDirectory(),
      "load-more-files": () => loadMoreFiles(),
      "copy-file-path": () => copySelectedFilePath(),
      "reveal-file": () => revealSelectedFile(),
      "use-file": () => useSelectedFileWithAgent(),
      "previous-file-page": () => pageFilePreview(-1),
      "next-file-page": () => pageFilePreview(1),
      "new-provider": () => newProviderEditor(),
      "save-general-settings": () => saveGeneralSettings(),
      "delete-provider": () => deleteCurrentProvider(),
      "switch-provider": () => switchCurrentProvider(),
      "save-provider": () => saveProvider(),
      "submit-ask-answer": () => submitAskAnswer(),
      "switch-persona": () => switchPersona(),
      "change-file-root": () => changeFileRoot(),
      "filter-files": () => renderFileEntries(),
      "import-session": event => importSession(event),
      "remove-pin": (_event, target) => {
        const index = Number(target.dataset.pinIndex);
        if (Number.isSafeInteger(index) && index > 0) return removePin(index);
      },
      "select-terminal": (_event, target) => target.dataset.terminalId ? selectTerminal(target.dataset.terminalId) : undefined,
      "select-provider": (_event, target) => target.dataset.providerName ? selectProviderEditor(target.dataset.providerName) : undefined,
      "select-session": (_event, target) => target.dataset.sessionId ? selectSession(target.dataset.sessionId) : undefined,
      "delete-session": (event, target) => {
        event.stopPropagation();
        if (target.dataset.sessionId) return deleteSession(target.dataset.sessionId);
      },
      "fork-message": (_event, target) => {
        const messageId = Number(target.dataset.messageId);
        if (Number.isSafeInteger(messageId) && messageId > 0) return forkCurrentSession(messageId);
      },
    });

    function dispatchAction(event) {
      const target = event.target instanceof Element ? event.target.closest("[data-action]") : null;
      if (!target) return;
      const expectedEvent = target.dataset.event || "click";
      if (expectedEvent !== event.type) return;
      const handler = actionHandlers[target.dataset.action];
      if (typeof handler !== "function") return;
      Promise.resolve(handler(event, target)).catch(error => addSystemMessage(`⚠️ 操作失败: ${error instanceof Error ? error.message : String(error)}`));
    }

    document.addEventListener("click", dispatchAction);
    document.addEventListener("change", dispatchAction);
    document.addEventListener("input", dispatchAction);
    document.getElementById("settings-modal").addEventListener("click", event => { if (event.target === event.currentTarget) closeSettings(); });
    document.getElementById("ask-input").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); submitAskAnswer(); } });
    document.addEventListener("keydown", (e) => {
      if ((e.key === "Enter" || e.key === " ") && document.activeElement?.dataset?.action && document.activeElement.tagName !== "BUTTON") {
        e.preventDefault();
        document.activeElement.click();
      }
      if (e.key === "Escape" && document.getElementById("settings-modal").classList.contains("visible")) closeSettings();
    });

    init();
