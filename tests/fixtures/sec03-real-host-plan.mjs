const A01_VARIABLES = Object.freeze({
  "A01-01": "DEEPSEEK_API_KEY",
  "A01-02": "MINI_LUX_API_TOKEN",
  "A01-03": "AWS_SECRET_ACCESS_KEY",
  "A01-04": "SSH_AUTH_SOCK",
  "A01-05": "SEC03_PARENT_SENTINEL",
  "A01-06": "HTTP_PROXY",
  "A01-07": "NODE_OPTIONS",
  "A01-08": "PATH",
});

export const A01_PATH_SENTINEL = "SEC03_PARENT_PATH_SENTINEL";
export const A01_OUTPUT_MARKER = "SEC03_A01_ENV_ABSENT";

export function a01ParentMutation(variantId, previousValue = "") {
  const name = A01_VARIABLES[variantId];
  if (!name) throw new Error(`Unsupported SEC-03 A01 variant: ${variantId}`);
  return Object.freeze({
    name,
    value: name === "PATH" ? `${previousValue};${A01_PATH_SENTINEL}` : `sec03-parent-only-${variantId.toLowerCase()}`,
  });
}

export function a01Probe(variantId, profileId) {
  const name = A01_VARIABLES[variantId];
  if (!name || !["E1", "E2", "E3", "E4"].includes(profileId)) throw new Error(`Unsupported SEC-03 A01 record: ${variantId}/${profileId}`);
  const pathProbe = name === "PATH";
  if (profileId === "E3") {
    const condition = pathProbe
      ? `(process.env.PATH ?? "").includes(${JSON.stringify(A01_PATH_SENTINEL)})`
      : `process.env[${JSON.stringify(name)}] !== undefined`;
    return `if (${condition}) process.exit(91); console.log(${JSON.stringify(A01_OUTPUT_MARKER)});`;
  }
  const condition = pathProbe
    ? `not "%PATH:${A01_PATH_SENTINEL}=%"=="%PATH%"`
    : `defined ${name}`;
  if (profileId === "E1") return `if ${condition} (exit /b 91) else (exit /b 0)`;
  return `if ${condition} (exit 91) else (echo ${A01_OUTPUT_MARKER})`;
}

export const A17_OUTPUT_MARKER = "SEC03_A17_SCRIPT_DENIED";
const denied = expression => `try { ${expression}; throw new Error("SEC03_CAPABILITY_SUCCEEDED"); } catch (error) { if (error?.message === "SEC03_CAPABILITY_SUCCEEDED") throw error; console.log(${JSON.stringify(A17_OUTPUT_MARKER)}); }`;

export function a17Probe(variantId) {
  const probes = {
    "A17-01": `import { createRequire } from "node:module"; ${denied(`createRequire(import.meta.url)(process.env.MINI_LUX_ROOT_0 + "\\\\sandbox-launcher.node")`)}`,
    "A17-02": `import { Worker } from "node:worker_threads"; ${denied(`new Worker("", { eval: true })`)}`,
    "A17-03": `import { spawn } from "node:child_process"; ${denied(`spawn(process.execPath, ["--version"], { stdio: "ignore" })`)}`,
    "A17-04": `import inspector from "node:inspector"; ${denied(`inspector.open(0, "127.0.0.1", false)`)}`,
    "A17-05": `import { WASI } from "node:wasi"; ${denied(`new WASI({ version: "preview1" })`)}`,
    "A17-06": `import { readFile } from "node:fs/promises"; ${denied(`await readFile(process.env.MINI_LUX_ROOT_0 + "\\\\..\\\\outside.txt", "utf8")`)}`,
    "A17-07": `import { connect } from "node:net"; await new Promise((resolve, reject) => { const socket = connect(47831, "127.0.0.1"); socket.once("connect", () => reject(new Error("SEC03_CAPABILITY_SUCCEEDED"))); socket.once("error", () => { console.log(${JSON.stringify(A17_OUTPUT_MARKER)}); resolve(); }); });`,
  };
  const probe = probes[variantId];
  if (!probe) throw new Error(`Unsupported SEC-03 A17 variant: ${variantId}`);
  return probe;
}

const A08_BASE_LIMITS = Object.freeze({
  E1: Object.freeze({ activeProcesses: 16, processMemoryBytes: 512 * 2 ** 20, jobMemoryBytes: 2 ** 30, cpuRatePercent: 50, jobUserTimeMs: 30_000, wallTimeMs: 30_000, idleTimeMs: null, aggregateOutputBytes: 2 ** 20, retainedOutputBytes: 2 ** 20, inputBytes: 128 * 2 ** 10 }),
  E2: Object.freeze({ activeProcesses: 32, processMemoryBytes: 512 * 2 ** 20, jobMemoryBytes: 2 ** 30, cpuRatePercent: 25, jobUserTimeMs: 600_000, wallTimeMs: 1_800_000, idleTimeMs: 300_000, aggregateOutputBytes: 10 * 2 ** 20, retainedOutputBytes: 2 ** 20, inputBytes: 64 * 2 ** 10 }),
  E3: Object.freeze({ activeProcesses: 1, processMemoryBytes: 256 * 2 ** 20, jobMemoryBytes: 256 * 2 ** 20, cpuRatePercent: 20, jobUserTimeMs: 10_000, wallTimeMs: 10_000, idleTimeMs: null, aggregateOutputBytes: 2 ** 20, retainedOutputBytes: 2 ** 20, inputBytes: 128 * 2 ** 10 }),
  E4: Object.freeze({ activeProcesses: 16, processMemoryBytes: 512 * 2 ** 20, jobMemoryBytes: 2 ** 30, cpuRatePercent: 25, jobUserTimeMs: 600_000, wallTimeMs: 14_400_000, idleTimeMs: 1_800_000, aggregateOutputBytes: 10 * 2 ** 20, retainedOutputBytes: 2 ** 20, inputBytes: 256 * 2 ** 10 }),
});

export function a08Case(variantId, profileId) {
  const base = A08_BASE_LIMITS[profileId];
  if (!base) throw new Error(`Unsupported SEC-03 A08 profile: ${profileId}`);
  if (variantId === "A08-05") {
    const payload = profileId === "E3" ? `console.log("x".repeat(8192));` : `for /L %i in (1,1,5000) do @echo 0123456789abcdef0123456789abcdef`;
    return Object.freeze({ payload, input: profileId === "E2" || profileId === "E4" ? payload : null, limits: Object.freeze({ ...base, aggregateOutputBytes: 1024, retainedOutputBytes: 1024 }), nativeReason: "limit-output", expectedCode: "EXEC_LIMIT_OUTPUT" });
  }
  if (variantId === "A08-06") {
    const payload = profileId === "E3" ? `await new Promise(resolve => setTimeout(resolve, 60_000));` : profileId === "E1" ? `for /L %i in (1,1,2000000000) do @rem` : "cmd";
    return Object.freeze({ payload, input: null, limits: Object.freeze({ ...base, wallTimeMs: 250, idleTimeMs: profileId === "E2" || profileId === "E4" ? 5_000 : null }), nativeReason: "limit-wall", expectedCode: "EXEC_LIMIT_WALL" });
  }
  if (variantId === "A08-07" && (profileId === "E2" || profileId === "E4")) return Object.freeze({ payload: "cmd", input: null, limits: Object.freeze({ ...base, wallTimeMs: 5_000, idleTimeMs: 250 }), nativeReason: "limit-idle", expectedCode: "EXEC_LIMIT_IDLE" });
  throw new Error(`Unsupported SEC-03 A08 record: ${variantId}/${profileId}`);
}

export function a08JobPolicyMaterial(limits) {
  return [limits.activeProcesses, limits.processMemoryBytes, limits.jobMemoryBytes, limits.cpuRatePercent, limits.jobUserTimeMs, limits.wallTimeMs, limits.idleTimeMs ?? "null", limits.aggregateOutputBytes, limits.retainedOutputBytes, limits.inputBytes].join(":");
}
