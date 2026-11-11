/* A11 skill packages in settings: what is installed, where it came from, and whether the assistant may use it. */
(() => {
  const sourceLabels = { user: "用户技能", builtin: "内置技能" };
  let headers = () => ({});

  function row(skill) {
    const item = document.createElement("div"); item.className = "skill-package"; item.setAttribute("role", "listitem"); item.dataset.skillId = skill.id;
    const toggle = document.createElement("input"); toggle.type = "checkbox"; toggle.id = `skill-package-${skill.id}`; toggle.checked = skill.enabled; toggle.disabled = Boolean(skill.problem);
    const label = document.createElement("label"); label.htmlFor = toggle.id;
    const name = document.createElement("b"); name.textContent = skill.name;
    const meta = document.createElement("small"); meta.textContent = `${skill.id} · ${sourceLabels[skill.source] || skill.source}`;
    label.append(name, meta);
    const description = document.createElement("p"); description.textContent = skill.problem ? `无法使用：${skill.problem}` : skill.description;
    if (skill.problem) description.className = "skill-package-problem";
    const state = document.createElement("span"); state.className = "skill-package-state"; state.setAttribute("role", "status");
    toggle.addEventListener("change", async event => {
      event.stopPropagation(); // Not part of the "save general settings" form.
      toggle.disabled = true; state.textContent = "保存中…";
      try {
        const response = await fetch(`/api/skill-packages/${encodeURIComponent(skill.id)}`, { method: "PUT", headers: { ...headers(), "Content-Type": "application/json" }, body: JSON.stringify({ enabled: toggle.checked }) });
        const data = await response.json(); if (!response.ok) throw new Error(data.error || "保存失败");
        state.textContent = toggle.checked ? "已启用" : "已停用";
      } catch (error) { toggle.checked = !toggle.checked; state.textContent = error.message; }
      finally { toggle.disabled = false; }
    });
    toggle.addEventListener("input", event => event.stopPropagation());
    item.append(toggle, label, description, state);
    return item;
  }

  async function refresh(options = {}) {
    if (options.headers) headers = options.headers;
    const list = document.getElementById("skill-package-list");
    if (!list) return;
    try {
      const response = await fetch("/api/skill-packages", { headers: headers() });
      const data = await response.json(); if (!response.ok) throw new Error(data.error || "读取技能失败");
      const directory = document.getElementById("skill-packages-directory");
      if (directory && data.userDirectory) { directory.textContent = ` ${data.userDirectory} `; directory.title = data.userDirectory; }
      if (!data.skills.length) { const empty = document.createElement("p"); empty.className = "settings-help"; empty.textContent = "还没有安装技能。"; list.replaceChildren(empty); return; }
      list.replaceChildren(...data.skills.map(row));
    } catch (error) { const failure = document.createElement("p"); failure.className = "settings-help"; failure.textContent = error.message; list.replaceChildren(failure); }
  }

  window.SkillSettings = Object.freeze({ refresh });
})();
