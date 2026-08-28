import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  freePort,
  makeTempDir,
  projectRoot,
  removeFixture,
  spawnManaged,
  terminateProcessTreeAsync,
  waitForChildExit,
} from "../helpers.mjs";

function callServiceControl(child, operation, args, timeoutMs = 5_000) {
  const requestId = "a".repeat(32);
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      if (error) reject(error);
      else resolve(value);
    };
    const onMessage = message => {
      if (message?.type !== "rainydays-control-result" || message.requestId !== requestId) return;
      if (message.ok === true) finish(null, message.value);
      else finish(new Error(message.error?.message ?? "service control failed"));
    };
    const timer = setTimeout(() => finish(new Error("service control response timed out")), timeoutMs);
    timer.unref?.();
    child.on("message", onMessage);
    child.send({ type: "rainydays-control-request", requestId, operation, args });
  });
}

function waitForReadyMessage(child, timeoutMs, logs) {
  return new Promise((resolve, reject) => {
    const finish = (error, value) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(value);
    };
    const onMessage = message => {
      if (message?.type !== "rainydays-service-ready") return;
      finish(null, message);
    };
    const onExit = (code, signal) => finish(new Error(`service exited before readiness (code ${code}, signal ${signal})\n${logs()}`));
    const timer = setTimeout(() => finish(new Error(`service readiness message timed out\n${logs()}`)), timeoutMs);
    timer.unref?.();
    child.on("message", onMessage);
    child.once("exit", onExit);
  });
}

test("RT-10 service publishes an authenticated ready handshake and exits on parent shutdown", { timeout: 60_000 }, async () => {
  const fixture = await makeTempDir("mini-lux-rt10-service-");
  const port = await freePort();
  const token = "rt10-service-control-token";
  const child = spawnManaged(process.execPath, [path.join(projectRoot, "dist", "index.js")], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      PORT: String(port),
      HOST: "127.0.0.1",
      RAINYDAYS_API_TOKEN: token,
      RAINYDAYS_APP_ROOT: projectRoot,
      RAINYDAYS_USER_DATA_DIR: fixture,
      RAINYDAYS_DATA_DIR: path.join(fixture, "data"),
      RAINYDAYS_CONFIG_PATH: path.join(fixture, "config.json"),
      RAINYDAYS_BUILTIN_PERSONAS_DIR: path.join(projectRoot, "personas"),
      RAINYDAYS_BUILTIN_SKILLS_DIR: path.join(projectRoot, "skills"),
      RAINYDAYS_PUBLIC_DIR: path.join(projectRoot, "public"),
      LLM_API_KEY: "",
      DEEPSEEK_API_KEY: "",
    },
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", chunk => { stdout += chunk; });
  child.stderr.on("data", chunk => { stderr += chunk; });
  const logs = () => `stdout=${stdout}\nstderr=${stderr}`;
  const credentialPrefix = `rt10-test-protected:${fixture}:`;
  child.on("message", message => {
    if (!message || typeof message !== "object"
      || JSON.stringify(Object.keys(message).sort()) !== JSON.stringify(["operation", "requestId", "type", "value"])
      || message.type !== "rainydays-credential-request") return;
    try {
      const value = message.operation === "protect"
        ? Buffer.from(`${credentialPrefix}${message.value}`, "utf8").toString("base64")
        : (() => {
            const plaintext = Buffer.from(message.value, "base64").toString("utf8");
            if (!plaintext.startsWith(credentialPrefix)) throw new Error("credential scope mismatch");
            return plaintext.slice(credentialPrefix.length);
          })();
      child.send({ type: "rainydays-credential-result", requestId: message.requestId, ok: true, value });
    } catch {
      child.send({ type: "rainydays-credential-result", requestId: message.requestId, ok: false });
    }
  });
  let exited = false;

  try {
    const ready = await waitForReadyMessage(child, 30_000, logs);
    assert.deepEqual(ready, {
      type: "rainydays-service-ready",
      host: "127.0.0.1",
      port,
      pid: child.pid,
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/health/ready`, {
      headers: { "X-RainyDays-Token": token },
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200);
    const health = await response.json();
    assert.equal(health.ready, true);
    assert.equal(typeof health.buildId, "string");
    assert.equal(await callServiceControl(child, "invalidate-native-consent", []), null);

    child.send({ type: "rainydays-service-shutdown", reason: "integration-test" });
    exited = await waitForChildExit(child, 15_000);
    assert.equal(exited, true, `service did not exit after parent shutdown\n${logs()}`);
    assert.equal(child.exitCode, 0, logs());
  } finally {
    if (!exited) await terminateProcessTreeAsync(child).catch(() => undefined);
    await removeFixture(fixture);
  }
});
