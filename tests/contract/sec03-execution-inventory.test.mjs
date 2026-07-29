import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { scanSec03Source, scanSec03SourceSet } from "../../scripts/sec03-execution-scanner.mjs";
import { crosscheckSec03SourceSet, validateSec03ExecutionPolicy } from "../../scripts/sec03-execution-crosscheck.mjs";
import { validateSec03ExecutionInventory } from "../../scripts/sec03-execution-inventory.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const load = async name => JSON.parse(await readFile(path.join(projectRoot, ...name.split("/")), "utf8"));

test("SEC-03 frozen matrix is an exact 386 plus 96 machine-readable closure", async () => {
  const [matrix, schema] = await Promise.all([load("tests/sec03-attack-matrix.json"), load("tests/sec03-attack-matrix.schema.json")]);
  const validate = new Ajv2020({ strict: true, allErrors: true }).compile(schema);
  assert.equal(validate(matrix), true, JSON.stringify(validate.errors));
  assert.equal(matrix.records.length, 482);
  assert.deepEqual(Object.fromEntries(matrix.layers.map(layer => [layer, matrix.records.filter(item => item.layer === layer).length])), { "real-host": 386, electron: 48, packaged: 48 });
  const keys = matrix.records.map(item => [item.layer, item.familyId, item.variantId, item.profileId].join("\0"));
  assert.equal(new Set(keys).size, 482);
  const reduced = structuredClone(matrix); reduced.records.pop(); reduced.runtimeReceiptCount = 481;
  assert.equal(validate(reduced), false, "matrix shrinkage must fail schema validation");
});

test("SEC-03 scanner recognizes finite process worker utility addon environment network and handle sinks", () => {
  const source = `
    import { spawn as launch } from "node:child_process";
    import { Worker as Thread } from "node:worker_threads";
    import { utilityProcess } from "electron";
    import net from "node:net";
    const cp = launch;
    cp(binary, argv, { env: process.env, cwd, shell, stdio: [sentinel], detached: true });
    new Thread(worker, { workerData, resourceLimits });
    utilityProcess.fork(modulePath, args, { env: process.env, stdio: "pipe" });
    process.dlopen(module, addonPath);
    net.connect(port, host);
    fetch(url);
    new WebSocket(url);
  `;
  const sites = scanSec03Source("src/synthetic.ts", source);
  for (const family of ["child-process", "worker", "electron-utility", "native-addon", "process-environment", "network"]) assert(sites.some(site => site.family === family), `missing ${family}`);
  const child = sites.find(site => site.family === "child-process");
  assert(child.operands.includes("argument:2.env") && child.operands.includes("argument:2.stdio") && child.operands.includes("argument:2.detached"));
});

test("SEC-03 independent crosscheck rejects alias re-export callable escape and unknown sink", async () => {
  const policy = validateSec03ExecutionPolicy(await load("tests/sec03-execution-policy.json"));
  const sources = new Map([
    ["src/reexport.ts", `export { spawn as escape } from "node:child_process";`],
    ["src/escape.ts", `import { spawn } from "node:child_process"; export default { spawn };`],
    ["src/unknown.ts", `import * as cp from "node:child_process"; const f = cp[name]; f(input);`],
  ]);
  const scan = scanSec03SourceSet(sources);
  assert(scan.some(site => site.family === "unknown-execution-sink"));
  const result = crosscheckSec03SourceSet(sources, policy);
  assert(result.violations.some(item => item.code === "GOVERNED_REEXPORT"));
  assert(result.violations.some(item => item.code === "CALLABLE_ESCAPE"));
  assert(result.violations.some(item => item.code === "UNCLASSIFIED_EXECUTION_SINK"));
  assert.equal(result.migrated, false);
});

test("SEC-03 authored projection includes native host sources and public HTML inline scripts", () => {
  const native = scanSec03Source("native/sandbox-host/synthetic.cpp", `// CreateProcessW(fake);\nconst char* text="CreateJobObjectW(fake)"; int run(){ auto job=CreateJobObjectW(nullptr,nullptr); return CreateProcessW(app,cmd,0,0,TRUE,flags,env,cwd,startup,process); }`);
  assert.deepEqual(native.map(site => site.api).sort(), ["CreateJobObjectW", "CreateProcessW"]);
  const html = scanSec03Source("public/synthetic.html", `<p>fetch("not-code")</p><script type="module">// fetch("comment")\nfetch("/api/runtime")</script>`);
  assert.equal(html.length, 1); assert.equal(html[0].family, "network"); assert.equal(html[0].api, "fetch");
});

test("SEC-03 inventory reports current product migration drift without disguising scanner correctness", { timeout: 120_000 }, async () => {
  const inventory = await load("tests/sec03-execution-inventory.json");
  const result = await validateSec03ExecutionInventory(inventory, { projectRoot, requireMigrated: false });
  assert.equal(result.inventoryComplete, true);
  assert(inventory.sites.length > 0);
  assert(inventory.files.some(file => file.sourcePath.startsWith("native/sandbox-host/") && file.executionClass === "native-host"));
  assert(inventory.files.some(file => file.sourcePath === "public/index.html"));
  assert.equal(new Set(inventory.sites.map(site => site.id)).size, inventory.sites.length, "occurrence IDs must be globally exact");
  if (!inventory.migrated) assert(inventory.violations.length > 0, "unmigrated source must expose concrete drift");
  else assert.deepEqual(inventory.violations, []);
  const sourceDigest = createHash("sha256").update(JSON.stringify(inventory.files)).digest("hex");
  assert.match(sourceDigest, /^[a-f0-9]{64}$/u);
});
