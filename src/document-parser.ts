import { Worker } from "node:worker_threads";
import { getBootstrapPathStore } from "./bootstrap-path-store.js";
import { assertResourceOwner, registerOwnedResource, type ResourceOwner } from "./resource-owner.js";
import { cancellationError, NEVER_ABORT_SIGNAL, RunSettlementError, throwIfCancelled } from "./run-cancellation.js";
import type { ParseResult } from "./tools/parsers.js";

const PARSER_TIMEOUT_MS = 20_000;

export async function parseDocumentIsolated(
  fileName: string,
  bytes: Uint8Array,
  owner: ResourceOwner,
  signal: AbortSignal = NEVER_ABORT_SIGNAL
): Promise<ParseResult> {
  assertResourceOwner(owner);
  throwIfCancelled(signal);
  const codeLease = await getBootstrapPathStore().openDocumentParserWorker();
  try {
    await codeLease.assertCurrent("beforeProcessSpawn");
    throwIfCancelled(signal);
  } catch (error) {
    try { await codeLease.close(); }
    catch (cleanupError) { throw new RunSettlementError(error, [cleanupError], "Parser code lease cleanup failed"); }
    throw error;
  }

  return await new Promise<ParseResult>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(codeLease.canonicalPath, { workerData: { fileName, bytes: Buffer.from(bytes) } });
    } catch (error) {
      void codeLease.close().then(
        () => reject(error),
        cleanupError => reject(new RunSettlementError(error, [cleanupError], "Parser code lease cleanup failed"))
      );
      return;
    }

    let settled = false;
    let terminated = false;
    let codeLeaseClosed = false;
    let unregister: () => void = () => undefined;
    const closeCodeLease = async (): Promise<void> => {
      if (codeLeaseClosed) return;
      codeLeaseClosed = true;
      await codeLease.close();
    };
    const terminate = async (): Promise<void> => {
      if (!terminated) {
        terminated = true;
        try { await worker.terminate(); }
        finally { await closeCodeLease(); }
        return;
      }
      await closeCodeLease();
    };
    const settle = (error: unknown, result?: ParseResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      unregister();
      void terminate().then(
        () => error ? reject(error) : resolve(result!),
        cleanupError => reject(error === null
          ? cleanupError
          : new RunSettlementError(error, [cleanupError], "Document parser cleanup failed"))
      );
    };
    const onAbort = (): void => settle(cancellationError(signal, "Document parsing was cancelled"));
    const timer = setTimeout(
      () => settle(new Error(`解析 Office 文件超时（${PARSER_TIMEOUT_MS / 1000}秒）`)),
      PARSER_TIMEOUT_MS
    );
    timer.unref?.();

    try {
      unregister = registerOwnedResource(owner, terminate);
    } catch (error) {
      settle(error);
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    worker.once("online", () => {
      void closeCodeLease().catch(error => settle(error));
    });
    worker.once("message", (message: { ok: boolean; result?: ParseResult; error?: string }) => {
      settle(message.ok && message.result ? null : new Error(message.error || "Office 文件解析失败"), message.result);
    });
    worker.once("error", error => settle(error));
    worker.once("exit", code => {
      if (code !== 0) settle(new Error(`Office 解析 Worker 异常退出（${code}）`));
    });
  });
}
