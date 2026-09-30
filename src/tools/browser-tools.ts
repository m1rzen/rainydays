import { browserSessions, type BrowserTabSelector } from "../browser.js";
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
    description: "Open or navigate a Session-isolated browser using CDP or the Chrome Extension backend.",
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
    description: "Capture a ref-bearing accessibility-style DOM snapshot and bounded page text. Refs expire after navigation or mutation.",
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

export const browserClickDef: ToolDefinition = { type: "function", function: { name: "browser_click", description: "Click an element by ref from the latest snapshot.", parameters: { type: "object", properties: { ref: { type: "string" }, tab: tabProperty }, required: ["ref"], ...noExtra } } };
export const browserClickExec: ToolExecutor = async (args, env, invocation) => { await browserSessions.click(prepare(env, invocation), args.ref as string, args.tab as BrowserTabSelector); return "Browser element clicked; snapshot refs invalidated"; };

export const browserFillDef: ToolDefinition = { type: "function", function: { name: "browser_fill", description: "Clear and fill an input by snapshot ref.", parameters: { type: "object", properties: { ref: { type: "string" }, value: { type: "string" }, tab: tabProperty }, required: ["ref", "value"], ...noExtra } } };
export const browserFillExec: ToolExecutor = async (args, env, invocation) => { await browserSessions.fill(prepare(env, invocation), args.ref as string, args.value as string, args.tab as BrowserTabSelector); return "Browser field filled; snapshot refs invalidated"; };

export const browserTypeDef: ToolDefinition = { type: "function", function: { name: "browser_type", description: "Type text character-by-character into an element by snapshot ref.", parameters: { type: "object", properties: { ref: { type: "string" }, text: { type: "string" }, delay: { type: "number", minimum: 0, maximum: 2000 }, tab: tabProperty }, required: ["ref", "text"], ...noExtra } } };
export const browserTypeExec: ToolExecutor = async (args, env, invocation) => { await browserSessions.type(prepare(env, invocation), args.ref as string, args.text as string, args.delay as number | undefined, args.tab as BrowserTabSelector); return "Browser text typed; snapshot refs invalidated"; };

export const browserPressDef: ToolDefinition = { type: "function", function: { name: "browser_press", description: "Dispatch a keyboard key to the active page element.", parameters: { type: "object", properties: { key: { type: "string" }, tab: tabProperty }, required: ["key"], ...noExtra } } };
export const browserPressExec: ToolExecutor = async (args, env, invocation) => { await browserSessions.press(prepare(env, invocation), args.key as string, args.tab as BrowserTabSelector); return "Browser key pressed"; };

export const browserScrollDef: ToolDefinition = { type: "function", function: { name: "browser_scroll", description: "Scroll the page or a ref-selected scroll container.", parameters: { type: "object", properties: { direction: { type: "string", enum: ["up", "down", "left", "right"] }, amount: { type: "number" }, ref: { type: "string" }, tab: tabProperty }, required: ["direction"], ...noExtra } } };
export const browserScrollExec: ToolExecutor = async (args, env, invocation) => { await browserSessions.scroll(prepare(env, invocation), args.direction as "up" | "down" | "left" | "right", args.amount as number | undefined, args.ref as string | undefined, args.tab as BrowserTabSelector); return "Browser scrolled"; };

export const browserScreenshotDef: ToolDefinition = { type: "function", function: { name: "browser_screenshot", description: "Capture a PNG screenshot and persist it as a Session-namespaced browser artifact.", parameters: { type: "object", properties: { fullPage: { type: "boolean" }, tab: tabProperty }, ...noExtra } } };
export const browserScreenshotExec: ToolExecutor = async (args, env, invocation) => json(await browserSessions.screenshot(prepare(env, invocation), args.fullPage === true, args.tab as BrowserTabSelector));

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
