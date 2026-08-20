import { createHash } from "node:crypto";

const credentialStore = await import("../../dist/credential-store.js");
const testScope = createHash("sha256")
  .update("rainydays-test-security-audit-protector-v1\0", "utf8")
  .update(process.env.RAINYDAYS_USER_DATA_DIR || process.cwd(), "utf8")
  .digest("hex");
credentialStore.configureCredentialProtector(Object.freeze({
  protect: plaintext => Buffer.from(`test-protected:${testScope}:${plaintext}`, "utf8"),
  unprotect: ciphertext => {
    const value = Buffer.from(ciphertext).toString("utf8");
    const prefix = `test-protected:${testScope}:`;
    if (!value.startsWith(prefix)) throw new Error("Test credential scope mismatch");
    return value.slice(prefix.length);
  },
}));

const serverModule = await import("../../dist/index.js");

if (typeof process.send === "function") {
  const presence = Object.freeze({
    windowId: 1,
    webContentsId: 1,
    topFrame: true,
    windowVisible: true,
    windowFocused: true,
  });
  process.on("message", async message => {
    if (!message || typeof message !== "object" || typeof message.requestId !== "string") return;
    try {
      let value;
      if (message.type === "rt01-manual-consent-prepare") {
        value = await serverModule.prepareManualTerminalConsent(message.operation, message.request, presence);
      } else if (message.type === "rt01-manual-consent-decide") {
        value = await serverModule.decideManualTerminalConsent(
          message.challengeId,
          message.decision,
          message.operation,
          message.argumentsDigest,
          presence,
        );
      } else if (message.type === "rt01-shutdown") {
        await serverModule.shutdown(false);
        value = { shutDown: true };
      } else {
        return;
      }
      process.send?.({ requestId: message.requestId, ok: true, value });
    } catch (error) {
      process.send?.({ requestId: message.requestId, ok: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}
