import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { canonicalJson, scanSec03SourceSet } from "./sec03-execution-scanner.mjs";

export const executionPolicyPath = "tests/sec03-execution-policy.json";
const classifications = new Set(["governed-adapter", "fixed-purpose-production", "build-test", "native-host-adapter", "unclassified"]);
const governedSpecifiers = new Set(["child_process", "node:child_process", "worker_threads", "node:worker_threads", "electron", "net", "node:net", "tls", "node:tls", "dgram", "node:dgram", "http", "node:http", "https", "node:https", "vm", "node:vm"]);
const scriptExtensions = [".ts", ".tsx", ".js", ".cjs", ".mjs"];
function vmModulesLike(specifier) { return specifier === "vm" || specifier === "node:vm"; }
function moduleText(node) { return ts.isStringLiteralLike(node) ? node.text : null; }
function parserKind(name) { return name.endsWith(".tsx") ? ts.ScriptKind.TSX : name.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS; }
function canonicalPayload(value) { const { canonicalPayloadSha256: _digest, ...payload } = value; return payload; }
function exactKeys(value, keys, label) { assert(value && typeof value === "object" && !Array.isArray(value), `${label} must be an object`); assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} keys differ`); }
function sha256Sync(value) { return createHash("sha256").update(value).digest("hex"); }
const exactEntryKeys = ["sourcePath", "family", "api", "container", "occurrenceId"];
function validateEntry(entry, label) { exactKeys(entry, exactEntryKeys, label); assert.match(entry.sourcePath, /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$)).+$/u); assert.equal(typeof entry.family, "string"); assert.equal(typeof entry.api, "string"); assert.equal(typeof entry.container, "string"); assert.match(entry.occurrenceId, /^exec-[a-f0-9]{24}$/u); }

export function validateSec03ExecutionPolicy(policy) {
  exactKeys(policy, ["schemaVersion", "task", "architectureSha256", "domain", "sourceRoots", "extensions", "governedEntryPaths", "governedAdapters", "fixedPurposeProduction", "fixedDynamicLoads", "nativeHostAdapters", "canonicalPayloadSha256"], "SEC-03 policy");
  assert.equal(policy.schemaVersion, 1); assert.equal(policy.task, "SEC-03"); assert.equal(policy.architectureSha256, "849fc25a5e32eabdaa3b1285a14218f9877d46ecdc650a0e52a2120772e1cad1"); assert.equal(policy.domain, "mini-lux/sec03/restricted-execution-dialect/v1");
  assert.deepEqual(policy.sourceRoots, ["src/", "electron/", "scripts/", "tests/", "native/", "public/**/*.html"]); assert.deepEqual(policy.extensions, [".ts", ".tsx", ".js", ".cjs", ".mjs", ".cpp", ".cc", ".h", ".hpp", ".html"]);
  assert.equal(policy.fixedDynamicLoads.length, 0, "computed/dynamic loaders cannot be allowlisted in SEC-03 finite dialect");
  for (const [name, entries] of [["governed adapter", policy.governedAdapters], ["fixed-purpose allowlist item", policy.fixedPurposeProduction], ["native-host adapter", policy.nativeHostAdapters]]) for (const entry of entries) validateEntry(entry, name);
  const all = [...policy.governedAdapters, ...policy.fixedPurposeProduction, ...policy.nativeHostAdapters]; assert.equal(new Set(all.map(item => item.occurrenceId)).size, all.length, "SEC-03 occurrence allowlist contains duplicates");
  assert.equal(policy.canonicalPayloadSha256, sha256Sync(canonicalJson(canonicalPayload(policy))), "SEC-03 policy digest differs"); return policy;
}
function entryMatches(site, entry) { return site.id === entry.occurrenceId && site.sourcePath === entry.sourcePath && site.family === entry.family && site.api === entry.api && site.container === entry.container; }
function classify(site, policy) { if (site.executionClass === "build-test") return "build-test"; if (policy.nativeHostAdapters.some(entry => entryMatches(site, entry))) return "native-host-adapter"; if (policy.governedAdapters.some(entry => entryMatches(site, entry))) return "governed-adapter"; if (policy.fixedPurposeProduction.some(entry => entryMatches(site, entry))) return "fixed-purpose-production"; return "unclassified"; }
function position(sourceFile, node) { return sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1; }
function unwrap(node) { let current = node; while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) || ts.isAwaitExpression(current))) current = current.expression; return current; }
function localSpecifier(sourcePath, specifier, sourceSet) {
  if (!specifier?.startsWith(".")) return null; const base = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier));
  const candidates = [base, ...scriptExtensions.map(extension => `${base}${extension}`), ...scriptExtensions.map(extension => base.replace(/\.js$/u, extension)), ...scriptExtensions.map(extension => `${base}/index${extension}`)]; return candidates.find(candidate => sourceSet.has(candidate)) ?? null;
}
function sourceDependencies(sourcePath, source, sourceSet) {
  const sf = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, parserKind(sourcePath)); const dependencies = new Set();
  const add = node => { const spec = moduleText(node); const local = localSpecifier(sourcePath, spec, sourceSet); if (local) dependencies.add(local); else if (spec?.startsWith(".") && /(?:^|\/)(?:scripts|tests)(?:\/|$)/u.test(path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), spec)))) dependencies.add(`!build-test:${spec}`); };
  const visit = node => { if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) add(node.moduleSpecifier); if (ts.isCallExpression(node) && ((ts.isIdentifier(node.expression) && node.expression.text === "require") || node.expression.kind === ts.SyntaxKind.ImportKeyword) && node.arguments[0]) add(node.arguments[0]); ts.forEachChild(node, visit); }; visit(sf); return dependencies;
}
function buildTestReachability(sourceSet) {
  const scripts = new Map([...sourceSet].filter(([name]) => scriptExtensions.includes(path.extname(name)))); const graph = new Map([...scripts].map(([name, source]) => [name, sourceDependencies(name, source, scripts)])); const violations = [];
  for (const sourcePath of scripts.keys()) {
    if (sourcePath.startsWith("scripts/") || sourcePath.startsWith("tests/")) continue; const seen = new Set(); const stack = [...(graph.get(sourcePath) ?? [])];
    while (stack.length) { const target = stack.pop(); if (seen.has(target)) continue; seen.add(target); if (target.startsWith("!build-test:") || target.startsWith("scripts/") || target.startsWith("tests/")) { violations.push({ code: "UNSUPPORTED_RUNTIME_DIALECT", sourcePath, line: 1, detail: `product runtime reaches build-test code: ${target.replace(/^!build-test:/u, "")}` }); break; } for (const next of graph.get(target) ?? []) stack.push(next); }
  }
  return violations;
}
function governedBindings(sourcePath, sourceFile, sourceSet) {
  const governed = new Set(); const namespaces = new Set(); const callableMembers = new Set(["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync", "Worker", "connect", "createConnection", "createServer", "request", "get", "fetch", "WebSocket", "send", "bind", "utilityProcess"]); const bindPattern = (name, namespace = false) => { if (ts.isIdentifier(name)) (namespace ? namespaces : governed).add(name.text); else if (ts.isObjectBindingPattern(name)) for (const element of name.elements) if (ts.isBindingElement(element)) { const member = element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName)) ? element.propertyName.text : ts.isIdentifier(element.name) ? element.name.text : null; if (member && callableMembers.has(member)) bindPattern(element.name); } };
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && governedSpecifiers.has(moduleText(statement.moduleSpecifier))) { const clause = statement.importClause; if (clause?.name) namespaces.add(clause.name.text); if (clause?.namedBindings && ts.isNamespaceImport(clause.namedBindings)) namespaces.add(clause.namedBindings.name.text); if (clause?.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const element of clause.namedBindings.elements) { const member = element.propertyName?.text ?? element.name.text; if (callableMembers.has(member) || vmModulesLike(moduleText(statement.moduleSpecifier))) governed.add(element.name.text); } }
    if (ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (declaration.initializer && ts.isCallExpression(declaration.initializer) && ((ts.isIdentifier(declaration.initializer.expression) && declaration.initializer.expression.text === "require") || (ts.isPropertyAccessExpression(declaration.initializer.expression) && ts.isIdentifier(declaration.initializer.expression.expression) && declaration.initializer.expression.expression.text === "process" && declaration.initializer.expression.name.text === "getBuiltinModule"))) { const spec = moduleText(declaration.initializer.arguments[0]); if (governedSpecifiers.has(spec) || !spec) bindPattern(declaration.name, ts.isIdentifier(declaration.name)); }
  }
  const reference = input => { const node = unwrap(input); if (!node) return false; if (ts.isIdentifier(node)) return governed.has(node.text) || namespaces.has(node.text); if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) return reference(node.expression); if (ts.isConditionalExpression(node)) return reference(node.whenTrue) || reference(node.whenFalse); if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "bind") return reference(node.expression.expression); return false; };
  for (let round = 0; round < 8; round += 1) { let changed = false; const visit = node => { if (ts.isVariableDeclaration(node) && node.initializer && reference(node.initializer)) { const before = governed.size; bindPattern(node.name); changed ||= governed.size !== before; } if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left) && reference(node.right) && !governed.has(node.left.text)) { governed.add(node.left.text); changed = true; } ts.forEachChild(node, visit); }; visit(sourceFile); if (!changed) break; }
  return { governed, namespaces, reference };
}
function staticViolations(sourceSet) {
  const violations = [...buildTestReachability(sourceSet)];
  for (const [sourcePath, source] of sourceSet) {
    if (!scriptExtensions.includes(path.extname(sourcePath)) || sourcePath.startsWith("tests/") || sourcePath.startsWith("scripts/")) continue;
    const sf = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, parserKind(sourcePath)); const { governed, reference } = governedBindings(sourcePath, sf, sourceSet); const report = (code, node, detail) => violations.push({ code, sourcePath, line: position(sf, node), detail });
    const visit = node => {
      if (ts.isExportDeclaration(node)) { if (node.moduleSpecifier && governedSpecifiers.has(moduleText(node.moduleSpecifier))) report("GOVERNED_REEXPORT", node, "governed module re-export is forbidden"); if (!node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause) && node.exportClause.elements.some(element => governed.has((element.propertyName ?? element.name).text))) report("GOVERNED_REEXPORT", node, "governed callable re-export is forbidden"); }
      if (ts.isExportAssignment(node) && reference(node.expression)) report("CALLABLE_ESCAPE", node, "governed callable escapes through export assignment");
      if (ts.isReturnStatement(node) && node.expression && reference(node.expression)) report("CALLABLE_ESCAPE", node, "governed callable escapes through return");
      if (ts.isPropertyAssignment(node) && reference(node.initializer)) report("CALLABLE_ESCAPE", node, "governed callable escapes through object storage");
      if (ts.isShorthandPropertyAssignment(node) && governed.has(node.name.text)) report("CALLABLE_ESCAPE", node, "governed callable escapes through object storage");
      if (ts.isArrayLiteralExpression(node) && node.elements.some(reference)) report("CALLABLE_ESCAPE", node, "governed callable escapes through array storage");
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) && reference(node.right)) report("CALLABLE_ESCAPE", node, "governed callable escapes through property assignment");
      if (ts.isCallExpression(node)) {
        const expression = unwrap(node.expression); const calledName = ts.isIdentifier(expression) ? expression.text : ts.isPropertyAccessExpression(expression) ? expression.name.text : null;
        const exactCallers = new Map([["consumeExecutionRootLease", "src/execution-runtime.ts"], ["bindNativeRootAuthority", "src/execution-runtime.ts"], ["issueExecutionGrant", "src/execution-runtime.ts"], ["issueInputGrant", "src/execution-runtime.ts"], ["issueResourceOwner", "src/capability-broker.ts"]]);
        if (exactCallers.has(calledName) && sourcePath !== exactCallers.get(calledName)) report("UNSUPPORTED_RUNTIME_DIALECT", node, `${calledName} may only be called by ${exactCallers.get(calledName)}`);
        const indirect = ts.isPropertyAccessExpression(expression) && ["call", "apply", "bind"].includes(expression.name.text) && reference(expression.expression); if (indirect) report("UNSUPPORTED_RUNTIME_DIALECT", node, "call/apply/bind on governed callable is forbidden");
        for (const argument of node.arguments) if (reference(argument)) report("CALLABLE_ESCAPE", argument, "governed callable passed to unknown caller");
        if (ts.isIdentifier(expression) && ["eval", "Function"].includes(expression.text)) report("UNSUPPORTED_RUNTIME_DIALECT", node, `${expression.text} is outside the finite dialect`);
        if (ts.isIdentifier(expression) && expression.text === "require" && !moduleText(node.arguments[0])) report("UNSUPPORTED_RUNTIME_DIALECT", node, "computed require is outside the finite dialect");
        if (expression.kind === ts.SyntaxKind.ImportKeyword && !moduleText(node.arguments[0])) report("UNSUPPORTED_RUNTIME_DIALECT", node, "computed import is outside the finite dialect");
        if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === "module" && expression.name.text === "require") report("UNSUPPORTED_RUNTIME_DIALECT", node, "module.require is outside the finite dialect");
        if (ts.isPropertyAccessExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === "process" && expression.name.text === "getBuiltinModule") report("UNSUPPORTED_RUNTIME_DIALECT", node, "process.getBuiltinModule is outside the finite dialect");
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "Function") report("UNSUPPORTED_RUNTIME_DIALECT", node, "new Function is outside the finite dialect");
      ts.forEachChild(node, visit);
    }; visit(sf);
  }
  return violations;
}
export function crosscheckSec03SourceSet(input, policy) {
  validateSec03ExecutionPolicy(policy); const sourceSet = input instanceof Map ? input : new Map(Object.entries(input)); const rawSites = scanSec03SourceSet(sourceSet); const sites = rawSites.map(site => Object.freeze({ ...site, classification: classify(site, policy) })); const violations = staticViolations(sourceSet);
  for (const site of sites) { assert(classifications.has(site.classification)); if (site.classification === "unclassified") violations.push({ code: "UNCLASSIFIED_EXECUTION_SINK", sourcePath: site.sourcePath, line: site.line, detail: `${site.family}.${site.api} occurrence ${site.id} is not in an exact SEC-03 class` }); if (policy.governedEntryPaths.includes(site.sourcePath) && site.classification !== "governed-adapter") violations.push({ code: "E1_E4_DIRECT_SINK", sourcePath: site.sourcePath, line: site.line, detail: `${site.family}.${site.api} remains directly reachable from E1-E4` }); }
  for (const [label, entries] of [["governed-adapter", policy.governedAdapters], ["fixed-purpose-production", policy.fixedPurposeProduction], ["native-host-adapter", policy.nativeHostAdapters]]) for (const entry of entries) { const matches = sites.filter(site => entryMatches(site, entry)); if (matches.length !== 1) violations.push({ code: "ALLOWLIST_DRIFT", sourcePath: entry.sourcePath, line: 1, detail: `${label} occurrence ${entry.occurrenceId} matched ${matches.length} sites, expected exactly one` }); }
  const unique = new Map(); for (const violation of violations) unique.set(`${violation.code}\0${violation.sourcePath}\0${violation.line}\0${violation.detail}`, violation); const sorted = [...unique.values()].sort((a, b) => a.sourcePath.localeCompare(b.sourcePath) || a.line - b.line || a.code.localeCompare(b.code)); return Object.freeze({ sites, violations: sorted, migrated: sorted.length === 0 });
}
export async function loadSec03ExecutionPolicy(projectRoot) { return validateSec03ExecutionPolicy(JSON.parse(await readFile(path.join(projectRoot, ...executionPolicyPath.split("/")), "utf8"))); }
