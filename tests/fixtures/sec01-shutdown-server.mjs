import { createHash } from "node:crypto";
import { access } from "node:fs/promises";

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
const { ready, shutdown } = await import("../../dist/index.js");

const signalPath = process.argv[2];
if (!signalPath) throw new Error("shutdown signal path is required");

try {
  await ready;
  while (true) {
    try {
      await access(signalPath);
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
  const shutdownPromise = shutdown(false);
  await import("node:fs/promises").then(({ writeFile }) => writeFile(`${signalPath}.started`, "started\n", "utf8"));
  await shutdownPromise;
  process.exit(0);
} catch (error) {
  console.error(error instanceof Error ? error.stack || error.message : String(error));
  process.exit(1);
}
