import assert from "node:assert/strict";
import test from "node:test";
import { createScriptPayload, parseScriptTimeout, scriptLimits } from "../../dist/script-runtime.js";
import { scriptExec } from "../../dist/tools/script.js";

const maximum = Object.freeze({
  activeProcesses: 1,
  processMemoryBytes: 256 * 2 ** 20,
  jobMemoryBytes: 256 * 2 ** 20,
  cpuRatePercent: 20,
  jobUserTimeMs: 10_000,
  wallTimeMs: 10_000,
  idleTimeMs: null,
  aggregateOutputBytes: 2 ** 20,
  retainedOutputBytes: 2 ** 20,
  inputBytes: 128 * 2 ** 10,
});

test("TOOL-04 Node ESM payload preserves raw code and installs a frozen cwd-scoped bridge", () => {
  const code = `import path from "node:path";\nconsole.log(path.basename("a\\\\b"), "'quoted'");`;
  const result = createScriptPayload({ code, lang: "node" });
  assert.equal(result.lang, "node");
  assert(result.payload.endsWith(`${code}\n`));
  assert.match(result.payload, /Object\.defineProperty\(globalThis, "lux"/u);
  assert.match(result.payload, /Object\.freeze/u);
  assert.match(result.payload, /lux bridge path must be relative to cwd/u);
  assert.match(result.payload, /lux bridge path escapes cwd/u);
});

test("TOOL-04 node-cjs payload exposes require without interpolating source", () => {
  const code = `const value = "\\"]; process.exit(99); //";\nconsole.log(require("node:path").basename("x/y"), value);`;
  const result = createScriptPayload({ code, lang: "node-cjs" });
  assert.equal(result.lang, "node-cjs");
  assert.match(result.payload, /createRequire/u);
  assert.match(result.payload, /new AsyncFunction/u);
  assert(result.payload.includes(JSON.stringify(code)));
  assert.equal(result.payload.includes(`constructor, ${code}`), false);
  assert.equal(result.payload.includes("const __luxReadFile"), false);
});

test("TOOL-04 timeout is bounded and attenuates native E3 limits", () => {
  assert.equal(parseScriptTimeout(undefined), 10_000);
  assert.equal(parseScriptTimeout(100), 100);
  assert.throws(() => parseScriptTimeout(99), /100-10000/u);
  assert.throws(() => parseScriptTimeout(10_001), /100-10000/u);
  assert.throws(() => parseScriptTimeout(1.5), /100-10000/u);
  const limited = scriptLimits(maximum, 750);
  assert.equal(limited.wallTimeMs, 750);
  assert.equal(limited.jobUserTimeMs, 750);
  assert.equal(limited.activeProcesses, 1);
  assert.equal(limited.aggregateOutputBytes, maximum.aggregateOutputBytes);
});

test("TOOL-04 isolated runner rejects unleased language and malformed code", async () => {
  assert.throws(() => createScriptPayload({ code: "print(1)", lang: "python" }), /unsupported/u);
  await assert.rejects(() => scriptExec({ code: "print(1)", lang: "python" }, {}), /separately leased interpreter/u);
  assert.throws(() => createScriptPayload({ code: "", lang: "node" }), /invalid/u);
  assert.throws(() => createScriptPayload({ code: "a\0b", lang: "node" }), /invalid/u);
});
