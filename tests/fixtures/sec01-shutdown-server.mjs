import { access } from "node:fs/promises";
import { ready, shutdown } from "../../dist/index.js";

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
