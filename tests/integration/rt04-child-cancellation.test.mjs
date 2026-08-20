import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeTempDir, projectRoot, removeFixture } from "../helpers.mjs";

function heldLlm(entered) {
  return {
    chat: async (_messages, _tools, signal) => {
      entered.resolve();
      return await new Promise((resolve, reject) => {
        const onAbort = () => {
          signal.removeEventListener("abort", onAbort);
          reject(signal.reason);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        if (signal.aborted) onAbort();
      });
    },
  };
}

test("RT-04 subagent runner propagates its exact child cancellation signal", { timeout: 30_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-rt04-child-");
  const dataDir = path.join(fixture, "data");
  await mkdir(dataDir, { recursive: true });
  Object.assign(process.env, {
    RAINYDAYS_APP_ROOT: projectRoot,
    RAINYDAYS_USER_DATA_DIR: fixture,
    RAINYDAYS_DATA_DIR: dataDir,
    RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"),
    RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"),
  });

  const [
    { runSubAgent },
    { RunCancellationError },
    { closeDb },
  ] = await Promise.all([
    import("../../dist/subagent.js"),
    import("../../dist/run-cancellation.js"),
    import("../../dist/db.js"),
  ]);

  const persona = { systemPrompt: "subagent cancellation fixture" };
  const child = { sessionId: "session-a", runId: "run-a" };
  try {
    {
      const controller = new AbortController();
      const entered = Promise.withResolvers();
      const reason = new RunCancellationError("RUN_CANCELLED", "subagent parent cancelled");
      const invocation = {
        signal: controller.signal,
        network: { fetch: async () => new Response("unreachable") },
        getToolDefinitions: () => [],
        executeTool: async () => "unreachable",
      };
      const running = runSubAgent({
        llm: heldLlm(entered),
        persona,
        prompt: "hold",
        capabilityContext: child,
        invocation,
      });
      await entered.promise;
      controller.abort(reason);
      await assert.rejects(() => running, error => error === reason);
    }
  } finally {
    closeDb();
    await removeFixture(fixture);
  }
});
