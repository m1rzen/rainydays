import { spawn } from "node:child_process";
import { getBootstrapPathStore } from "../bootstrap-path-store.js";

export function validateOAuthBrowserUrl(url: URL): void {
  const local = ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname);
  if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.hash || url.href.length > 8192) throw new Error("MCP authorization URL is not allowed");
}
/** rundll32 runs only this fixed protocol-handler entry; the URL is validated above and passed as one argument. */
export const MCP_URL_HANDLER_ENTRY = "url.dll,FileProtocolHandler";
/** Only an explicit settings login opens the user's system browser. Never interpret a URL as shell source. */
export async function openMcpOAuthBrowser(url: URL): Promise<void> {
  validateOAuthBrowserUrl(url);
  if (process.platform !== "win32") throw new Error("MCP system browser integration requires Windows");
  const executable = await getBootstrapPathStore().openUrlHandler();
  try {
    await executable.assertCurrent("beforeProcessSpawn");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(executable.canonicalPath, [MCP_URL_HANDLER_ENTRY, url.href], { shell: false, windowsHide: true, stdio: "ignore" });
      child.once("spawn", () => { child.unref(); resolve(); }); child.once("error", () => reject(new Error("MCP system browser could not open")));
    });
  } finally { await executable.close(); }
}
