import { createHash } from "node:crypto";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { browserSessions, type BrowserTabSelector } from "../browser.js";
import { OBSERVATION_MARKER } from "../observations.js";
import { throwIfCancelled } from "../run-cancellation.js";
import type { ToolDefinition, ToolExecutor, ToolInvocationServices } from "../types.js";

const tabProperty = { oneOf: [{ type: "number" }, { type: "string" }], description: "Exact numeric tab id or fuzzy URL/title match; omit for active tab." } as const;
const noExtra = { additionalProperties: false } as const;

function sessionId(env: Readonly<Record<string, string>> | undefined, invocation: ToolInvocationServices | undefined): string {
  const value = invocation?.capabilityContext.sessionId ?? env?._SESSION_ID;
  if (!value) throw new Error("Browser tools require a Session identity");
  return value;
}

function prepare(env: Readonly<Record<string, string>> | undefined, invocation: ToolInvocationServices | undefined): string {
  if (invocation) throwIfCancelled(invocation.signal);
  return sessionId(env, invocation);
}

function json(value: unknown): string { return JSON.stringify(value, null, 2); }

export const browserOpenDef: ToolDefinition = {
  type: "function",
  function: {
    name: "browser_open",
    description: "Open or navigate this Session's browser. By default RainyDays launches its own visible Chrome/Edge profile (downloads supported). With cdpPort/cdpUrl it attaches to a browser you already run and only sees tabs this task opens.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        backend: { type: "string", enum: ["cdp", "extension"] },
        cdpPort: { type: "number", minimum: 1024, maximum: 65535 },
        cdpUrl: { type: "string" },
        extensionUrl: { type: "string" },
        headless: { type: "boolean" },
        tab: tabProperty,
      },
      required: ["url"],
      ...noExtra,
    },
  },
};
export const browserOpenExec: ToolExecutor = async (args, env, invocation) => json(await browserSessions.open(prepare(env, invocation), {
  url: args.url as string,
  backend: args.backend as "cdp" | "extension" | undefined,
  cdpPort: args.cdpPort as number | undefined,
  cdpUrl: args.cdpUrl as string | undefined,
  extensionUrl: args.extensionUrl as string | undefined,
  headless: args.headless === true,
  tab: args.tab as BrowserTabSelector,
}));

export const browserCloseDef: ToolDefinition = { type: "function", function: { name: "browser_close", description: "Close this Session's browser connection and any browser process it launched.", parameters: { type: "object", properties: {}, ...noExtra } } };
export const browserCloseExec: ToolExecutor = async (_args, env, invocation) => { await browserSessions.close(prepare(env, invocation)); return "Browser closed"; };

export const browserTabsDef: ToolDefinition = { type: "function", function: { name: "browser_tabs", description: "List this Session's browser tabs with stable numeric ids.", parameters: { type: "object", properties: {}, ...noExtra } } };
export const browserTabsExec: ToolExecutor = async (_args, env, invocation) => json(await browserSessions.tabs(prepare(env, invocation)));

export const browserNewTabDef: ToolDefinition = { type: "function", function: { name: "browser_new_tab", description: "Open a new tab and make it active.", parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], ...noExtra } } };
export const browserNewTabExec: ToolExecutor = async (args, env, invocation) => json(await browserSessions.newTab(prepare(env, invocation), args.url as string));

export const browserCloseTabDef: ToolDefinition = { type: "function", function: { name: "browser_close_tab", description: "Close a selected or active browser tab.", parameters: { type: "object", properties: { tab: tabProperty }, ...noExtra } } };
export const browserCloseTabExec: ToolExecutor = async (args, env, invocation) => { await browserSessions.closeTab(prepare(env, invocation), args.tab as BrowserTabSelector); return "Browser tab closed"; };

export const browserSnapshotDef: ToolDefinition = {
  type: "function",
  function: {
    name: "browser_snapshot",
    description: "Capture a ref-bearing accessibility-style DOM snapshot and bounded page text. Refs stay valid until the page navigates, the element is replaced, or the browser is handed to the user; then take a new snapshot.",
    parameters: {
      type: "object",
      properties: {
        tab: tabProperty,
        interactive: { type: "boolean" },
        maxDepth: { type: "number", minimum: 0, maximum: 100 },
        maxContentLength: { type: "number", minimum: 100, maximum: 100000 },
      },
      ...noExtra,
    },
  },
};
export const browserSnapshotExec: ToolExecutor = async (args, env, invocation) => browserSessions.snapshot(prepare(env, invocation), {
  tab: args.tab as BrowserTabSelector,
  interactive: args.interactive === true,
  maxDepth: args.maxDepth as number | undefined,
  maxContentLength: args.maxContentLength as number | undefined,
});

export const browserClickDef: ToolDefinition = { type: "function", function: { name: "browser_click", description: "Real mouse click at the centre of an element from the latest snapshot. Refuses elements that are hidden or covered by another element.", parameters: { type: "object", properties: { ref: { type: "string" }, tab: tabProperty }, required: ["ref"], ...noExtra } } };
export const browserClickExec: ToolExecutor = async (args, env, invocation) => { await browserSessions.click(prepare(env, invocation), args.ref as string, args.tab as BrowserTabSelector); return "Clicked. Refs stay valid until the page navigates or the element is replaced; take a snapshot to see the effect."; };

export const browserFillDef: ToolDefinition = { type: "function", function: { name: "browser_fill", description: "Replace a field's content through real text input and verify the value the page kept.", parameters: { type: "object", properties: { ref: { type: "string" }, value: { type: "string" }, tab: tabProperty }, required: ["ref", "value"], ...noExtra } } };
export const browserFillExec: ToolExecutor = async (args, env, invocation) => { await browserSessions.fill(prepare(env, invocation), args.ref as string, args.value as string, args.tab as BrowserTabSelector); return `Filled; the field now holds ${JSON.stringify(String(args.value ?? "").slice(0, 120))}.`; };

export const browserTypeDef: ToolDefinition = { type: "function", function: { name: "browser_type", description: "Type text into an element by snapshot ref using real text input.", parameters: { type: "object", properties: { ref: { type: "string" }, text: { type: "string" }, delay: { type: "number", minimum: 0, maximum: 2000 }, tab: tabProperty }, required: ["ref", "text"], ...noExtra } } };
export const browserTypeExec: ToolExecutor = async (args, env, invocation) => { await browserSessions.type(prepare(env, invocation), args.ref as string, args.text as string, args.delay as number | undefined, args.tab as BrowserTabSelector); return "Typed. The snapshot shows each field's current value."; };

export const browserPressDef: ToolDefinition = { type: "function", function: { name: "browser_press", description: "Send a real key to the focused element: Enter submits forms, Tab moves focus. Supports Escape, Backspace, arrows, Space and modifiers such as Control+A or Shift+Tab.", parameters: { type: "object", properties: { key: { type: "string" }, tab: tabProperty }, required: ["key"], ...noExtra } } };
export const browserPressExec: ToolExecutor = async (args, env, invocation) => { await browserSessions.press(prepare(env, invocation), args.key as string, args.tab as BrowserTabSelector); return "Browser key pressed"; };

export const browserScrollDef: ToolDefinition = { type: "function", function: { name: "browser_scroll", description: "Scroll the page or a ref-selected scroll container.", parameters: { type: "object", properties: { direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "number" }, ref: { type: "string" }, tab: tabProperty }, required: ["direction"], ...noExtra } } };
export const browserScrollExec: ToolExecutor = async (args, env, invocation) => { await browserSessions.scroll(prepare(env, invocation), args.direction as "up" | "down" | "left" | "right", args.amount as number | undefined, args.ref as string | undefined, args.tab as BrowserTabSelector); return "Browser scrolled"; };

export const browserScreenshotDef: ToolDefinition = { type: "function", function: { name: "browser_screenshot", description: "Capture a PNG screenshot and persist it as a Session-namespaced browser artifact.", parameters: { type: "object", properties: { fullPage: { type: "boolean" }, tab: tabProperty }, ...noExtra } } };
export const browserScreenshotExec: ToolExecutor = async (args, env, invocation) => {
  const shot = await browserSessions.screenshot(prepare(env, invocation), args.fullPage === true, args.tab as BrowserTabSelector);
  const { observation, ...rest } = shot;
  return json({ ...rest, ...(observation ? { [OBSERVATION_MARKER]: { sha256: observation.sha256, width: observation.width, height: observation.height, scale: observation.scale, viewport: observation.viewport }, note: "截图已作为图片附在本次工具结果之后（模型配置支持图片时）。" } : {}) });
};

export const browserEvalDef: ToolDefinition = { type: "function", function: { name: "browser_eval", description: "Evaluate a bounded JavaScript expression in the selected page. This is a high-risk action requiring approval.", parameters: { type: "object", properties: { expression: { type: "string", maxLength: 32768 }, tab: tabProperty }, required: ["expression"], ...noExtra } } };
export const browserEvalExec: ToolExecutor = async (args, env, invocation) => json(await browserSessions.evaluate(prepare(env, invocation), args.expression as string, args.tab as BrowserTabSelector));

export const browserBackDef: ToolDefinition = { type: "function", function: { name: "browser_back", description: "Navigate back in the selected tab.", parameters: { type: "object", properties: { tab: tabProperty }, ...noExtra } } };
export const browserBackExec: ToolExecutor = async (args, env, invocation) => json(await browserSessions.back(prepare(env, invocation), args.tab as BrowserTabSelector));

export const browserForwardDef: ToolDefinition = { type: "function", function: { name: "browser_forward", description: "Navigate forward in the selected tab.", parameters: { type: "object", properties: { tab: tabProperty }, ...noExtra } } };
export const browserForwardExec: ToolExecutor = async (args, env, invocation) => json(await browserSessions.forward(prepare(env, invocation), args.tab as BrowserTabSelector));

export const browserFetchDef: ToolDefinition = {
  type: "function",
  function: {
    name: "browser_fetch",
    description: "Fetch a URL inside the selected browser tab, inheriting that tab's cookies and login state. Requires approval.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        method: { type: "string" },
        headers: { type: "object", additionalProperties: { type: "string" } },
        body: { type: "string" },
        tab: tabProperty,
      },
      required: ["url"],
      ...noExtra,
    },
  },
};
export const browserFetchExec: ToolExecutor = async (args, env, invocation) => json(await browserSessions.fetch(prepare(env, invocation), args.url as string, {
  method: args.method as string | undefined,
  headers: args.headers as Record<string, string> | undefined,
  body: args.body as string | undefined,
  tab: args.tab as BrowserTabSelector,
}));

const MAX_TRANSFER_BYTES = 50 * 1024 * 1024;

export const browserWaitDef: ToolDefinition = {
  type: "function",
  function: {
    name: "browser_wait",
    description: "等待页面出现某段文字、某段文字消失或网址包含某段内容（最多 60 秒）。操作后页面需要时间更新时使用；返回是否满足和当前网址。",
    parameters: { type: "object", properties: { text: { type: "string" }, textGone: { type: "string" }, urlIncludes: { type: "string" }, timeoutMs: { type: "number", minimum: 100, maximum: 60000 }, tab: tabProperty }, ...noExtra },
  },
};
export const browserWaitExec: ToolExecutor = async (args, env, invocation) => json(await browserSessions.waitFor(prepare(env, invocation), {
  text: args.text as string | undefined, textGone: args.textGone as string | undefined, urlIncludes: args.urlIncludes as string | undefined, timeoutMs: args.timeoutMs as number | undefined,
}, args.tab as BrowserTabSelector, invocation?.signal));

export const browserUploadDef: ToolDefinition = {
  type: "function",
  function: {
    name: "browser_upload",
    description: "把授权目录里的一个文件选进页面的文件上传框（按快照里的 ref）。只交出这一个文件的副本，不会交出整个目录。",
    parameters: { type: "object", properties: { ref: { type: "string" }, file_path: { type: "string", description: "绝对路径，或相对于资料目录的路径。" }, tab: tabProperty }, required: ["ref", "file_path"], ...noExtra },
  },
};
export const browserUploadExec: ToolExecutor = async (args, env, invocation) => {
  const sessionId = prepare(env, invocation);
  if (!invocation) throw new Error("browser_upload requires a scoped path gateway");
  const filePath = String(args.file_path ?? "");
  const defaultRootId = path.isAbsolute(filePath) ? undefined : invocation.path.rootIdForEnv("DATA_ROOT") ?? undefined;
  const read = await invocation.path.readFile(filePath, { defaultRootId, maxBytes: MAX_TRANSFER_BYTES });
  const name = path.basename(filePath).replace(/[^\p{L}\p{N}._ ()-]/gu, "_").slice(0, 120) || "upload.bin";
  const copy = path.join(await browserSessions.uploadDirectory(sessionId), name);
  await writeFile(copy, read.bytes, { flag: "wx" });
  await browserSessions.upload(sessionId, args.ref as string, copy, args.tab as BrowserTabSelector);
  return json({ uploaded: name, bytes: read.bytes.length, sha256: createHash("sha256").update(read.bytes).digest("hex") });
};

export const browserDownloadsDef: ToolDefinition = {
  type: "function",
  function: {
    name: "browser_downloads",
    description: "列出本会话浏览器的下载（名称、状态、字节数）。下载先放在临时目录，不算成果；需要保留时用 browser_save_download 存到成果目录。",
    parameters: { type: "object", properties: {}, ...noExtra },
  },
};
export const browserDownloadsExec: ToolExecutor = async (_args, env, invocation) => json(browserSessions.downloads(prepare(env, invocation)));

export const browserSaveDownloadDef: ToolDefinition = {
  type: "function",
  function: {
    name: "browser_save_download",
    description: "把一个已完成的浏览器下载保存到成果目录（或授权目录的指定位置），返回保存的文件名、大小和 sha256。",
    parameters: { type: "object", properties: { id: { type: "number", minimum: 1 }, file_path: { type: "string", description: "绝对路径，或相对于成果目录的路径；省略时用下载的原文件名。" } }, required: ["id"], ...noExtra },
  },
};
export const browserSaveDownloadExec: ToolExecutor = async (args, env, invocation) => {
  const sessionId = prepare(env, invocation);
  if (!invocation) throw new Error("browser_save_download requires a scoped path gateway");
  const download = await browserSessions.readDownload(sessionId, Number(args.id), MAX_TRANSFER_BYTES);
  const filePath = typeof args.file_path === "string" && args.file_path.trim() ? args.file_path.trim() : download.name.replace(/[\\/:*?"<>|]/gu, "_");
  const defaultRootId = path.isAbsolute(filePath) ? undefined : invocation.path.rootIdForEnv("OUTPUT_DIR") ?? undefined;
  await invocation.path.createFile(filePath, download.bytes, { defaultRootId, maxBytes: MAX_TRANSFER_BYTES });
  return json({ saved: filePath, bytes: download.bytes.length, sha256: createHash("sha256").update(download.bytes).digest("hex") });
};

export const browserHandoffDef: ToolDefinition = {
  type: "function",
  function: {
    name: "browser_handoff",
    description: "遇到登录、验证码、支付或需要用户本人确认的页面时，把浏览器切到前台交给用户。不要替用户输入密码或绕过验证。调用后用 ask_user 请用户完成并回复；用户确认后先 browser_snapshot 重新观察，旧 ref 全部作废。",
    parameters: { type: "object", properties: { reason: { type: "string", description: "告诉用户需要做什么，例如“请登录后回复”。" }, tab: tabProperty }, required: ["reason"], ...noExtra },
  },
};
export const browserHandoffExec: ToolExecutor = async (args, env, invocation) => {
  const tab = await browserSessions.handoff(prepare(env, invocation), args.tab as BrowserTabSelector);
  return json({ handedOff: true, reason: String(args.reason ?? "").slice(0, 300), tab, next: "调用 ask_user 请用户完成后回复；之后先 browser_snapshot，旧 ref 已作废。" });
};

export const browserClickPointDef: ToolDefinition = {
  type: "function",
  function: {
    name: "browser_click_point",
    description: "按最近一次非整页 browser_screenshot 图片上的像素坐标点击（真实鼠标）。用于画布、图形等快照里没有 ref 的目标；有 ref 时优先用 browser_click。坐标直接写图片坐标，换算由系统完成。",
    parameters: { type: "object", properties: { x: { type: "number", minimum: 0 }, y: { type: "number", minimum: 0 }, tab: tabProperty }, required: ["x", "y"], ...noExtra },
  },
};
export const browserClickPointExec: ToolExecutor = async (args, env, invocation) => {
  await browserSessions.clickPoint(prepare(env, invocation), Number(args.x), Number(args.y), args.tab as BrowserTabSelector);
  return "Clicked at the given screenshot point. Take a new screenshot or snapshot to see the effect.";
};
