// The renderer needs the desktop service. A directly opened HTML file is a launch guide.
(() => {
  if (window.location.protocol !== "file:") return;

  document.documentElement.classList.add("file-launch");
  document.addEventListener("DOMContentLoaded", () => {
    const main = document.createElement("main");
    main.className = "file-launch-guide";
    const wordmark = document.createElement("p");
    wordmark.className = "file-launch-wordmark";
    wordmark.textContent = "RainyDays";
    const heading = document.createElement("h1");
    heading.textContent = "从桌面应用开始";
    const description = document.createElement("p");
    description.textContent = "你打开的是界面文件。请启动 RainyDays 桌面应用，加载完整界面并连接对话、文件和工具。";
    const steps = document.createElement("ol");
    const folder = document.createElement("li");
    folder.textContent = "返回 RainyDays 项目文件夹。";
    const launch = document.createElement("li");
    launch.append("双击 ");
    const filename = document.createElement("strong");
    filename.textContent = "启动 RainyDays.cmd";
    launch.append(filename, "，稍等片刻，应用会自动打开。");
    steps.append(folder, launch);
    const note = document.createElement("p");
    note.className = "file-launch-note";
    note.textContent = "首次使用可在应用的「设置 → 模型配置」中配置模型。";
    main.append(wordmark, heading, description, steps, note);
    document.body.replaceChildren(main);
  }, { once: true });
})();
