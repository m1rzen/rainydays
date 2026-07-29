import { parentPort, workerData } from "node:worker_threads";
import { parseFileBuffer } from "./tools/parsers.js";

const data = workerData as { fileName?: unknown; bytes?: unknown };
const fileName = typeof data?.fileName === "string" ? data.fileName : "";
const bytes = data?.bytes instanceof Uint8Array ? Buffer.from(data.bytes) : null;
if (!fileName || !bytes) {
  parentPort?.postMessage({ ok: false, error: "Office parser worker input is invalid" });
} else {
  parseFileBuffer(fileName, bytes)
    .then(result => parentPort?.postMessage({ ok: true, result }))
    .catch(error => parentPort?.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) }));
}
