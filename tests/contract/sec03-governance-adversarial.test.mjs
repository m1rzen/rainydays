import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { canonicalJson, scanSec03SourceSet, SEC03_ARCHITECTURE_SHA256 } from "../../scripts/sec03-execution-scanner.mjs";
import { crosscheckSec03SourceSet, validateSec03ExecutionPolicy } from "../../scripts/sec03-execution-crosscheck.mjs";

function policyFor(sourceSet, kind = "fixedPurposeProduction") {
  const sites = scanSec03SourceSet(sourceSet).filter(site => site.executionClass !== "build-test" && site.family !== "unknown-execution-sink");
  const entry = site => ({ sourcePath: site.sourcePath, family: site.family, api: site.api, container: site.container, occurrenceId: site.id });
  const payload = { schemaVersion: 1, task: "SEC-03", architectureSha256: SEC03_ARCHITECTURE_SHA256, domain: "mini-lux/sec03/restricted-execution-dialect/v1", sourceRoots: ["src/", "electron/", "scripts/", "tests/", "native/", "public/**/*.html"], extensions: [".ts", ".tsx", ".js", ".cjs", ".mjs", ".cpp", ".cc", ".h", ".hpp", ".html"], governedEntryPaths: [], governedAdapters: [], fixedPurposeProduction: [], fixedDynamicLoads: [], nativeHostAdapters: [] };
  payload[kind] = sites.map(entry); payload.canonicalPayloadSha256 = createHash("sha256").update(canonicalJson(payload)).digest("hex"); return validateSec03ExecutionPolicy(payload);
}
function assertBlocked(sources, policy, label) { const result = crosscheckSec03SourceSet(sources, policy); assert.equal(result.migrated, false, `${label} unexpectedly passed`); assert(result.violations.length > 0, `${label} emitted no violation`); return result; }

test("SEC-03 exact occurrence IDs reject a second spawn in the same function", () => {
  const baseline = new Map([["src/adapter.ts", `import { spawn } from "node:child_process"; export function run() { return spawn("fixed.exe"); }`]]); const policy = policyFor(baseline); const mutated = new Map([["src/adapter.ts", `import { spawn } from "node:child_process"; export function run() { spawn("fixed.exe"); return spawn("second.exe"); }`]]); const result = assertBlocked(mutated, policy, "same-function second spawn"); assert(result.violations.some(item => item.code === "UNCLASSIFIED_EXECUTION_SINK"));
});

test("SEC-03 native adapter occurrence rejects a second CreateProcess", () => {
  const baseline = new Map([["native/sandbox-host/launcher.cpp", `int Launch() { return CreateProcessW(app, cmd, 0, 0, TRUE, flags, env, cwd, startup, process); }`]]); const policy = policyFor(baseline, "nativeHostAdapters"); const mutated = new Map([["native/sandbox-host/launcher.cpp", `int Launch() { CreateProcessW(app, cmd, 0, 0, TRUE, flags, env, cwd, startup, process); return CreateProcessW(app2, cmd2, 0, 0, TRUE, flags, env, cwd, startup, process); }`]]); const result = assertBlocked(mutated, policy, "second native CreateProcess"); assert(result.violations.some(item => item.code === "UNCLASSIFIED_EXECUTION_SINK"));
});

test("SEC-03 public inline/module projection rejects an unclassified second fetch and ignores text/comments", () => {
  const baseline = new Map([["public/index.html", `<p>fetch("text-only")</p><script type="module">async function load(){ return fetch("/api/one"); }</script>`]]); const sites = scanSec03SourceSet(baseline); assert.equal(sites.length, 1, "HTML text must not become a sink"); const policy = policyFor(baseline); const mutated = new Map([["public/index.html", `<p>fetch("text-only")</p><script type="module">async function load(){ /* fetch("comment") */ await fetch("/api/one"); return fetch("/api/two"); }</script>`]]); const result = assertBlocked(mutated, policy, "public inline second fetch"); assert(result.violations.some(item => item.code === "UNCLASSIFIED_EXECUTION_SINK"));
});

test("SEC-03 native scanner ignores comments and strings while recognizing security primitives", () => {
  const sources = new Map([["native/sandbox-host/host.cpp", `// CreateProcessW(fake);\nconst char* text = "CreateJobObjectW(fake)"; int Launch(){ auto j=CreateJobObjectW(nullptr,nullptr); auto p=CreateAppContainerProfile(name,name,desc,nullptr,0,&sid); return CreateProcessAsUserW(token,app,cmd,0,0,FALSE,flags,env,cwd,startup,process); }`]]); const sites = scanSec03SourceSet(sources); assert.deepEqual(sites.map(site => site.api).sort(), ["CreateAppContainerProfile", "CreateJobObjectW", "CreateProcessAsUserW"]);
});

test("SEC-03 product-to-build-test reachability is a hard fail", () => {
  const sources = new Map([["src/product.ts", `import { helper } from "../scripts/helper.mjs"; export const run = helper;`], ["scripts/helper.mjs", `import { spawn } from "node:child_process"; export const helper = () => spawn("x");`]]); const result = assertBlocked(sources, policyFor(new Map()), "product build-test import"); assert(result.violations.some(item => /build-test/u.test(item.detail)));
});

test("SEC-03 finite dialect rejects call/apply/bind, bound invocation, re-export, storage escape, and dynamic loaders", () => {
  const fixtures = [
    ["call", `import { spawn } from "node:child_process"; spawn.call(null,"x");`],
    ["apply", `import { spawn } from "node:child_process"; spawn.apply(null,["x"]);`],
    ["bind", `import { spawn } from "node:child_process"; const bound=spawn.bind(null,"x"); bound();`],
    ["destructure-storage", `const { spawn: launch } = require("node:child_process"); export default { launch };`],
    ["re-export", `export { spawn as launch } from "node:child_process";`],
    ["module-require", `const cp = module.require(name); cp.spawn("x");`],
    ["builtin-loader", `const cp = process.getBuiltinModule(name); cp.spawn("x");`],
    ["computed-import", `export async function load(name){ return import(name); }`],
    ["eval", `eval(source);`],
    ["function", `const f = new Function(source); f();`],
    ["vm", `import vm from "node:vm"; vm.runInThisContext(source);`],
  ];
  for (const [label, source] of fixtures) assertBlocked(new Map([[`src/${label}.ts`, source]]), policyFor(new Map()), label);
});

test("SEC-03 exact caller governance rejects authority consumers outside their sole product modules", () => {
  const calls = ["consumeExecutionRootLease(lease,request,cb)", "bindNativeRootAuthority(root)", "service.issueExecutionGrant(request)", "service.issueInputGrant(request)", "issueResourceOwner(meta)"]; for (const [index, call] of calls.entries()) { const result = assertBlocked(new Map([[`src/unauthorized-${index}.ts`, `${call};`]]), policyFor(new Map()), call); assert(result.violations.some(item => /may only be called/u.test(item.detail))); }
});
