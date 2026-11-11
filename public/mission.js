/* Mission panel: draws the stripe's position, the run clock, the step list and the context dial from real run state. */
(() => {
  const DIAL_LENGTH = 220, COMPACT_AT = 80, EXPAND_AT = 8, BAND_STEP = 7;
  const STATUS_LABELS = {
    idle: "待命", run: "进行中", hold: "等待你批准", completed: "已完成",
    partial: "部分完成", failed: "执行失败", cancelled: "已停止", unknown: "结果未确认",
  };
  const byId = id => document.getElementById(id);
  const runStarts = new Map(), runElapsed = new Map();
  let state = { sessionId: null, running: false, hold: false, tasks: [] };
  let timer = null;

  function currentStepIndex(tasks) {
    return tasks.findIndex(task => task.status === "in_progress");
  }

  function elapsedMs(sessionId) {
    const start = runStarts.get(sessionId);
    return (runElapsed.get(sessionId) ?? 0) + (start ? Date.now() - start : 0);
  }

  function drawClock() {
    const clock = byId("mission-time");
    if (!clock) return;
    const seconds = Math.floor(elapsedMs(state.sessionId) / 1000);
    const text = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(value => String(value).padStart(2, "0")).join(":");
    if (clock.dataset.text === text) return;
    clock.dataset.text = text;
    clock.setAttribute("aria-label", `已运行 ${text}`);
    if (clock.children.length !== text.length) clock.replaceChildren(...[...text].map(character => { const cell = document.createElement("span"); if (character === ":") cell.className = "colon"; return cell; }));
    [...text].forEach((character, index) => { clock.children[index].textContent = character; });
  }

  function trackRun(sessionId, running) {
    if (!sessionId) return;
    const started = runStarts.get(sessionId);
    if (running && !started) { runElapsed.set(sessionId, 0); runStarts.set(sessionId, Date.now()); }
    if (!running && started) { runElapsed.set(sessionId, Date.now() - started); runStarts.delete(sessionId); }
  }

  function stepNote(task, isHold) {
    if (isHold) return "等待你批准";
    if (task.status === "completed") return "完成";
    if (task.status === "in_progress") return task.activeForm || "进行中";
    return task.blocked ? "等待前置步骤" : "待开始";
  }

  function drawSteps() {
    const list = byId("mission-steps");
    if (!list) return;
    const tasks = state.tasks;
    const current = currentStepIndex(tasks);
    const rows = tasks.map((task, index) => {
      const row = document.createElement("li");
      const isHold = state.hold && index === current;
      row.className = `mission-step${task.status === "pending" ? " todo" : ""}${isHold ? " hold" : ""}`;
      if (index === current) row.setAttribute("aria-current", "step");
      const title = document.createElement("b"), note = document.createElement("small");
      title.textContent = task.subject;
      note.textContent = stepNote(task, isHold);
      row.append(title, note);
      return row;
    });
    if (rows.length) list.replaceChildren(...rows);
    else {
      const empty = document.createElement("li");
      empty.className = "mission-empty";
      empty.textContent = "这个任务没有拆分步骤。需要多步完成时，进度会显示在这里。";
      list.replaceChildren(empty);
    }
    const completed = tasks.filter(task => task.status === "completed").length;
    const active = tasks[current];
    setText("task-current-step", active ? `${STATUS_LABELS[missionStatus()]} · ${active.subject}` : STATUS_LABELS[missionStatus()]);
    setText("task-progress-text", `已完成 ${completed}/${tasks.length}`);
    document.documentElement.style.setProperty("--mission-prog", String(Math.max(tasks.length ? completed / tasks.length : 0, 0.04)));
    placeBands();
  }

  /* The stripe stops at the step the task has reached; the dotted line shows what is left. */
  function placeBands() {
    const bands = byId("mission-bands"), dots = byId("mission-dots"), list = byId("mission-steps");
    if (!bands || !dots || !list) return;
    const tasks = state.tasks;
    const current = currentStepIndex(tasks);
    const reached = current >= 0 ? current : tasks.findLastIndex(task => task.status === "completed");
    const rows = list.querySelectorAll(".mission-step");
    const stepTop = index => rows[index].offsetTop - bands.offsetTop + 11;
    const height = rows[reached] ? Math.max(0, stepTop(reached)) : 0;
    [...bands.children].forEach((band, index) => band.style.setProperty("height", `${Math.max(0, height - (bands.children.length - 1 - index) * BAND_STEP)}px`));
    dots.style.setProperty("height", `${rows.length ? Math.max(0, stepTop(rows.length - 1)) : 0}px`);
  }

  function missionStatus() {
    if (state.hold) return "hold";
    if (state.running) return "run";
    if (Object.hasOwn(STATUS_LABELS, state.outcome)) return state.outcome;
    return state.tasks.length && state.tasks.every(task => task.status === "completed") ? "completed" : "idle";
  }

  function drawStatus() {
    const status = missionStatus();
    document.body.dataset.mission = status;
    setText("mission-status", `任务时钟 · ${STATUS_LABELS[status]}`);
    drawClock();
    clearInterval(timer);
    timer = state.running ? setInterval(drawClock, 1000) : null;
  }

  function drawRows(rowState) {
    if (!rowState) return;
    for (const item of document.querySelectorAll(".session-item[data-session-id]")) {
      const mark = rowState(item.dataset.sessionId);
      if (mark) item.dataset.mission = mark; else delete item.dataset.mission;
    }
  }

  function setText(id, value) { const node = byId(id); if (node && node.textContent !== value) node.textContent = value; }

  /* Same measure as compaction: estimated input (messages + tool definitions) plus the reply reserve, over the window. */
  function contextUse({ tokens, contextWindowTokens, outputReserveTokens, lastRequest }) {
    if (lastRequest && lastRequest.contextWindowTokens > 0) {
      return { used: lastRequest.estimatedInputTokens + lastRequest.outputReserveTokens, window: lastRequest.contextWindowTokens, full: true };
    }
    return { used: (tokens || 0) + (outputReserveTokens || 0), window: contextWindowTokens || 0, full: false };
  }

  function updateContext(data) {
    const dial = byId("mission-dial"), value = byId("mission-dial-value");
    if (!dial || !value) return;
    const { used, window, full } = contextUse(data);
    const percent = window > 0 ? Math.min(100, Math.round(used / window * 100)) : 0;
    value.setAttribute("stroke-dasharray", `${DIAL_LENGTH * percent / 100} ${DIAL_LENGTH}`);
    dial.dataset.level = percent >= 90 ? "high" : "normal";
    const basis = full ? "按上一轮请求估算，含工具定义和回复预留" : "尚未发出请求，按对话记录和回复预留估算";
    dial.setAttribute("aria-label", `上下文约用 ${percent}%（${basis}），50% 开始整理，90% 压缩`);
    dial.title = `约 ${(used / 1000).toFixed(1)}k / ${(window / 1000).toFixed(1)}k tokens · ${basis}`;
    setText("mission-percent", `${percent}%`);
    setText("mission-model", data.model || data.profile || "未配置");
    setText("mission-messages", String(data.messageCount ?? 0));
  }

  function sync(next) {
    state = { ...state, ...next };
    trackRun(state.sessionId, state.running);
    drawSteps();
    drawStatus();
    drawRows(next.rowState);
  }

  /* Idle view and title compaction follow the message list itself. */
  function watchMessages() {
    const messages = byId("messages");
    if (!messages) return;
    const applyView = () => { document.body.dataset.missionView = messages.querySelector(".welcome-state") ? "idle" : "task"; };
    new MutationObserver(applyView).observe(messages, { childList: true });
    applyView();
    let compact = false;
    messages.addEventListener("scroll", () => {
      const next = compact ? messages.scrollTop > EXPAND_AT : messages.scrollTop > COMPACT_AT;
      if (next !== compact) { compact = next; document.body.classList.toggle("mission-compact", compact); }
    }, { passive: true });
  }

  document.addEventListener("DOMContentLoaded", () => {
    watchMessages();
    const track = byId("mission-track");
    if (track && "ResizeObserver" in window) new ResizeObserver(placeBands).observe(track);
    document.fonts?.ready.then(placeBands);
    drawSteps();
    drawStatus();
  });

  window.MissionPanel = Object.freeze({ sync, updateContext });
})();
