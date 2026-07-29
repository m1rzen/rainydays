import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";

export const SEC03_ARCHITECTURE_SHA256 = "849fc25a5e32eabdaa3b1285a14218f9877d46ecdc650a0e52a2120772e1cad1";
export const sourceExtensions = new Set([".ts", ".tsx", ".js", ".cjs", ".mjs", ".cpp", ".cc", ".h", ".hpp", ".html"]);
const scriptExtensions = new Set([".ts", ".tsx", ".js", ".cjs", ".mjs"]);
const nativeExtensions = new Set([".cpp", ".cc", ".h", ".hpp"]);
const childModules = new Set(["child_process", "node:child_process"]);
const workerModules = new Set(["worker_threads", "node:worker_threads"]);
const networkModules = new Set(["net", "node:net", "tls", "node:tls", "dgram", "node:dgram", "http", "node:http", "https", "node:https"]);
const vmModules = new Set(["vm", "node:vm"]);
const childApis = new Set(["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"]);
const networkApis = new Set(["connect", "createConnection", "createServer", "request", "get", "fetch", "WebSocket", "send", "bind"]);
const governedModules = new Set([...childModules, ...workerModules, ...networkModules, ...vmModules, "electron"]);
const nativeApis = new Map([
  ["CreateProcess", ["child-process", "CreateProcess"]], ["CreateProcessA", ["child-process", "CreateProcessA"]], ["CreateProcessW", ["child-process", "CreateProcessW"]],
  ["CreateProcessAsUser", ["child-process", "CreateProcessAsUser"]], ["CreateProcessAsUserA", ["child-process", "CreateProcessAsUserA"]], ["CreateProcessAsUserW", ["child-process", "CreateProcessAsUserW"]],
  ["ShellExecute", ["child-process", "ShellExecute"]], ["ShellExecuteA", ["child-process", "ShellExecuteA"]], ["ShellExecuteW", ["child-process", "ShellExecuteW"]],
  ["ShellExecuteEx", ["child-process", "ShellExecuteEx"]], ["ShellExecuteExA", ["child-process", "ShellExecuteExA"]], ["ShellExecuteExW", ["child-process", "ShellExecuteExW"]],
  ["WinExec", ["child-process", "WinExec"]], ["popen", ["child-process", "popen"]], ["_popen", ["child-process", "_popen"]], ["system", ["child-process", "system"]],
  ["LoadLibrary", ["native-addon", "LoadLibrary"]], ["LoadLibraryA", ["native-addon", "LoadLibraryA"]], ["LoadLibraryW", ["native-addon", "LoadLibraryW"]],
  ["LoadLibraryEx", ["native-addon", "LoadLibraryEx"]], ["LoadLibraryExA", ["native-addon", "LoadLibraryExA"]], ["LoadLibraryExW", ["native-addon", "LoadLibraryExW"]], ["GetProcAddress", ["native-addon", "GetProcAddress"]],
  ["socket", ["network", "socket"]], ["connect", ["network", "connect"]],
  ["CreatePseudoConsole", ["native-addon", "CreatePseudoConsole"]], ["ResizePseudoConsole", ["native-addon", "ResizePseudoConsole"]], ["ClosePseudoConsole", ["native-addon", "ClosePseudoConsole"]],
  ["CreateJobObject", ["native-addon", "CreateJobObject"]], ["CreateJobObjectA", ["native-addon", "CreateJobObjectA"]], ["CreateJobObjectW", ["native-addon", "CreateJobObjectW"]],
  ["OpenJobObject", ["native-addon", "OpenJobObject"]], ["AssignProcessToJobObject", ["native-addon", "AssignProcessToJobObject"]], ["SetInformationJobObject", ["native-addon", "SetInformationJobObject"]], ["TerminateJobObject", ["native-addon", "TerminateJobObject"]],
  ["CreateAppContainerProfile", ["native-addon", "CreateAppContainerProfile"]], ["DeleteAppContainerProfile", ["native-addon", "DeleteAppContainerProfile"]], ["DeriveAppContainerSidFromAppContainerName", ["native-addon", "DeriveAppContainerSidFromAppContainerName"]],
]);

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
export function canonicalize(value) { if (Array.isArray(value)) return value.map(canonicalize); if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])])); return value; }
export function canonicalJson(value) { return JSON.stringify(canonicalize(value)); }
function toPosix(value) { return value.replaceAll("\\", "/"); }
function moduleText(node) { return ts.isStringLiteralLike(node) ? node.text : null; }
function propertyName(node) { if (!node) return null; if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) return node.text; return null; }
function unwrap(node) { let current = node; while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) || ts.isAwaitExpression(current))) current = current.expression; return current; }
function parserKind(sourcePath) { if (sourcePath.endsWith(".tsx")) return ts.ScriptKind.TSX; if (sourcePath.endsWith(".ts")) return ts.ScriptKind.TS; return ts.ScriptKind.JS; }
function tokenNormalize(text, kind = ts.ScriptKind.JS) {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, kind, text); const tokens = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if ([ts.SyntaxKind.WhitespaceTrivia, ts.SyntaxKind.NewLineTrivia, ts.SyntaxKind.SingleLineCommentTrivia, ts.SyntaxKind.MultiLineCommentTrivia, ts.SyntaxKind.ShebangTrivia].includes(token)) continue;
    tokens.push(`${ts.SyntaxKind[token]}:${scanner.getTokenText()}`);
  }
  return tokens.join("|");
}
function functionNode(node, sourceFile) { let current = node; while (current && current !== sourceFile) { if (ts.isFunctionLike(current)) return current; current = current.parent; } return sourceFile; }
function containerName(node, sourceFile) {
  let current = node.parent;
  while (current && current !== sourceFile) {
    if (ts.isMethodDeclaration(current) || ts.isGetAccessorDeclaration(current) || ts.isSetAccessorDeclaration(current) || ts.isConstructorDeclaration(current)) { const owner = current.parent?.name && ts.isIdentifier(current.parent.name) ? current.parent.name.text : "<class>"; return `${owner}.${ts.isConstructorDeclaration(current) ? "constructor" : propertyName(current.name) ?? "<computed>"}`; }
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isVariableDeclaration(current.parent) && ts.isIdentifier(current.parent.name)) return current.parent.name.text;
    current = current.parent;
  }
  return "<top-level>";
}
export function sec03ExecutionClass(sourcePath) { if (sourcePath.startsWith("tests/") || sourcePath.startsWith("scripts/")) return "build-test"; if (sourcePath.startsWith("electron/")) return "electron-runtime"; if (sourcePath.startsWith("native/sandbox-host/")) return "native-host"; return "product-runtime"; }
function bindingNames(name) { if (ts.isIdentifier(name)) return [name.text]; if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) return name.elements.flatMap(element => ts.isBindingElement(element) ? bindingNames(element.name) : []); return []; }
function localSpecifier(sourcePath, specifier, sourceSet) {
  if (!specifier?.startsWith(".")) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(sourcePath), specifier));
  const candidates = [base, base.replace(/\.js$/u, ".ts"), base.replace(/\.js$/u, ".tsx"), base.replace(/\.js$/u, ".cjs"), base.replace(/\.js$/u, ".mjs"), `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.cjs`, `${base}.mjs`, `${base}/index.ts`, `${base}/index.tsx`, `${base}/index.js`, `${base}/index.cjs`, `${base}/index.mjs`];
  return candidates.find(candidate => sourceSet.has(candidate)) ?? null;
}
function exportedOrigins(sourceSet) {
  const tables = new Map([...sourceSet].map(([name]) => [name, new Map()]));
  for (let round = 0; round < sourceSet.size + 2; round += 1) { let changed = false;
    for (const [sourcePath, source] of sourceSet) { const sf = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, parserKind(sourcePath)); const table = tables.get(sourcePath); const assign = (name, origin) => { if (name && origin && !table.has(name)) { table.set(name, origin); changed = true; } };
      for (const statement of sf.statements) {
        if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) { const spec = moduleText(statement.moduleSpecifier); const local = localSpecifier(sourcePath, spec, sourceSet); if (statement.exportClause && ts.isNamedExports(statement.exportClause)) for (const element of statement.exportClause.elements) { const imported = element.propertyName?.text ?? element.name.text; if (governedModules.has(spec)) assign(element.name.text, { moduleName: spec, member: imported }); else if (local) assign(element.name.text, tables.get(local)?.get(imported)); } }
        const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
        if (modifiers?.some(item => item.kind === ts.SyntaxKind.ExportKeyword) && ts.isVariableStatement(statement)) for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name) && declaration.initializer) assign(declaration.name.text, null);
      }
    }
    if (!changed) break;
  }
  return tables;
}
function originsForFile(sourcePath, sourceFile, sourceSet, exportTables) {
  const origins = new Map(); const bind = (name, origin) => { if (name && origin) origins.set(name, origin); };
  for (const statement of sourceFile.statements) if (ts.isImportDeclaration(statement)) { const spec = moduleText(statement.moduleSpecifier); const local = localSpecifier(sourcePath, spec, sourceSet); const clause = statement.importClause; if (!clause || clause.isTypeOnly) continue; if (clause.name) bind(clause.name.text, { moduleName: spec, member: "default" }); if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) bind(clause.namedBindings.name.text, local ? { moduleName: local, member: "*", local: true } : { moduleName: spec, member: "*" }); if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) for (const element of clause.namedBindings.elements) { const member = element.propertyName?.text ?? element.name.text; bind(element.name.text, local ? exportTables.get(local)?.get(member) ?? { moduleName: local, member, unresolvedLocal: true } : { moduleName: spec, member }); } }
  const resolve = expression => {
    const value = unwrap(expression); if (!value) return null;
    if (ts.isIdentifier(value)) { if (value.text === "fetch") return { moduleName: "global", member: "fetch" }; if (value.text === "WebSocket") return { moduleName: "global", member: "WebSocket" }; if (value.text === "eval") return { moduleName: "dynamic-code", member: "eval", unsupported: true }; if (value.text === "Function") return { moduleName: "dynamic-code", member: "Function", unsupported: true }; return origins.get(value.text) ?? null; }
    if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) { const expressionNode = value.expression; const member = ts.isPropertyAccessExpression(value) ? value.name.text : value.argumentExpression && ts.isStringLiteralLike(value.argumentExpression) ? value.argumentExpression.text : null; if (ts.isIdentifier(expressionNode) && expressionNode.text === "process" && member === "env") return { moduleName: "process", member: "env" }; if (ts.isIdentifier(expressionNode) && expressionNode.text === "process" && member === "dlopen") return { moduleName: "process", member: "dlopen" }; if (ts.isIdentifier(expressionNode) && expressionNode.text === "process" && member === "getBuiltinModule") return { moduleName: "dynamic-loader", member: "process.getBuiltinModule", unsupported: true }; if (ts.isIdentifier(expressionNode) && expressionNode.text === "module" && member === "require") return { moduleName: "dynamic-loader", member: "module.require", unsupported: true }; const parent = resolve(expressionNode); if (!parent) return null; if (!member) return { ...parent, member: "computed", unresolved: true, unsupported: true }; if (parent.local && parent.member === "*") return exportTables.get(parent.moduleName)?.get(member) ?? { ...parent, member, unresolvedLocal: true }; return { ...parent, member }; }
    if (ts.isCallExpression(value)) { const callee = resolve(value.expression); if (callee && ["bind"].includes(callee.member)) { const target = resolve(value.expression.expression); return target ? { ...target, bound: true, unsupported: true } : null; } if (ts.isIdentifier(value.expression) && value.expression.text === "require") { const spec = value.arguments.length === 1 ? moduleText(value.arguments[0]) : null; const local = localSpecifier(sourcePath, spec, sourceSet); return spec ? (local ? { moduleName: local, member: "*", local: true } : { moduleName: spec, member: "*" }) : { moduleName: "dynamic-loader", member: "require", unresolved: true, unsupported: true }; } if (callee?.moduleName === "node:module" && callee.member === "createRequire") return { moduleName: "dynamic-loader", member: "require", loader: true }; }
    if (ts.isConditionalExpression(value)) { const left = resolve(value.whenTrue); const right = resolve(value.whenFalse); if (left || right) return { ...(left ?? right), unresolved: true, member: "conditional", unsupported: true }; }
    return null;
  };
  for (let round = 0; round < 12; round += 1) { let changed = false; const visit = node => { if (ts.isVariableDeclaration(node) && node.initializer) { const origin = resolve(node.initializer); if (origin && ts.isObjectBindingPattern(node.name) && origin.member === "*") for (const element of node.name.elements) { if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) continue; const member = element.propertyName && (ts.isIdentifier(element.propertyName) || ts.isStringLiteralLike(element.propertyName)) ? element.propertyName.text : element.name.text; if (!origins.has(element.name.text)) { bind(element.name.text, { ...origin, member }); changed = true; } } else if (origin) for (const name of bindingNames(node.name)) if (!origins.has(name)) { bind(name, origin); changed = true; } } if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) { const origin = resolve(node.right); if (origin && !origins.has(node.left.text)) { bind(node.left.text, origin); changed = true; } } ts.forEachChild(node, visit); }; visit(sourceFile); if (!changed) break; }
  return { resolve };
}
function processOperands(api, call) { const argc = call.arguments?.length ?? 0; if (api === "fork") return ["argument:0", "argument:1", "argument:2.env", "argument:2.cwd", "argument:2.shell", "argument:2.stdio", "argument:2.detached", "argument:2.windowsVerbatimArguments"]; if (["spawn", "spawnSync", "execFile", "execFileSync"].includes(api)) { const option = argc >= 3 ? 2 : argc >= 2 ? 1 : null; return ["argument:0", ...(argc >= 3 ? ["argument:1"] : []), ...(option === null ? [] : [`argument:${option}.env`, `argument:${option}.cwd`, `argument:${option}.shell`, `argument:${option}.stdio`, `argument:${option}.detached`, `argument:${option}.windowsVerbatimArguments`])]; } return ["argument:0", "argument:1.env", "argument:1.cwd", "argument:1.shell"]; }
function makeSite({ sourcePath, sourceFile, node, family, api, operands, lineOffset = 0, nodeKind = null, normalizedNode = null, container = null, containerText = null }) { const position = sourceFile ? sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)) : { line: 0, character: 0 }; const normalized = normalizedNode ?? tokenNormalize(node.getText(sourceFile), parserKind(sourcePath)); const owner = container ?? containerName(node, sourceFile); const ownerNode = sourceFile ? functionNode(node, sourceFile) : null; const ownerNormalized = tokenNormalize(containerText ?? ownerNode?.getText(sourceFile) ?? "<top-level>", parserKind(sourcePath)); const operandProfile = [...new Set(operands)]; return { sourcePath, line: position.line + 1 + lineOffset, column: position.character + 1, nodeKind: nodeKind ?? ts.SyntaxKind[node.kind], container: owner, family, api, operands: operandProfile, normalizedNodeSha256: sha256(normalized), containerSha256: sha256(ownerNormalized), operandProfileSha256: sha256(canonicalJson(operandProfile)), executionClass: sec03ExecutionClass(sourcePath) }; }
function isProcessEnvironmentForwarding(node) { const parent = node.parent; if (!parent) return true; if ((ts.isPropertyAccessExpression(parent) || ts.isElementAccessExpression(parent)) && parent.expression === node) return false; if (ts.isVariableDeclaration(parent) && parent.initializer === node && ts.isObjectBindingPattern(parent.name)) return false; return true; }
function scanScriptUnit(sourcePath, source, sourceSet, exportTables, lineOffset = 0) {
  const sf = ts.createSourceFile(sourcePath, source, ts.ScriptTarget.Latest, true, parserKind(sourcePath)); const { resolve } = originsForFile(sourcePath, sf, sourceSet, exportTables); const sites = [];
  const emit = (node, family, api, operands) => sites.push(makeSite({ sourcePath, sourceFile: sf, node, family, api, operands, lineOffset }));
  const visit = node => {
    if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
      const callee = node.expression; const origin = resolve(callee);
      if (origin) {
        const api = origin.member;
        const governedOrigin = governedModules.has(origin.moduleName) || ["dynamic-loader", "dynamic-code", "process"].includes(origin.moduleName);
        if ((origin.unsupported || origin.bound) && governedOrigin) emit(node, "unknown-execution-sink", api, ["callee", origin.bound ? "bound-invocation" : "unsupported-dialect"]);
        else if (childModules.has(origin.moduleName) && childApis.has(api)) emit(node, "child-process", api, processOperands(api, node));
        else if (workerModules.has(origin.moduleName) && api === "Worker") emit(node, "worker", api, ["argument:0", "argument:1.env", "argument:1.workerData", "argument:1.resourceLimits"]);
        else if (origin.moduleName === "electron" && ["fork", "utilityProcess.fork"].includes(api)) emit(node, "electron-utility", api, ["argument:0", "argument:1", "argument:2.env", "argument:2.stdio"]);
        else if (origin.moduleName === "process" && api === "dlopen") emit(node, "native-addon", "dlopen", ["argument:1"]);
        else if (origin.moduleName === "dynamic-loader") { const spec = node.arguments?.length === 1 ? moduleText(node.arguments[0]) : null; if (spec?.endsWith(".node")) emit(node, "native-addon", "require.node", ["argument:0"]); else if (!spec) emit(node, "unknown-execution-sink", api, ["callee", "dynamic-loader"]); }
        else if (vmModules.has(origin.moduleName)) emit(node, "unknown-execution-sink", api, ["callee", "vm-api"]);
        else if ((networkModules.has(origin.moduleName) && networkApis.has(api)) || (origin.moduleName === "global" && ["fetch", "WebSocket"].includes(api))) emit(node, "network", api, ["argument:0", "argument:1"]);
        else if (origin.unresolved && governedModules.has(origin.moduleName)) emit(node, "unknown-execution-sink", api, ["callee"]);
      }
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && ["call", "apply", "bind"].includes(node.expression.name.text)) { const target = resolve(node.expression.expression); if (target && (governedModules.has(target.moduleName) || target.moduleName === "dynamic-loader" || target.moduleName === "process")) emit(node, "unknown-execution-sink", `${target.member}.${node.expression.name.text}`, ["callable-indirection"]); }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && !moduleText(node.arguments[0])) emit(node, "unknown-execution-sink", "computed-import", ["argument:0"]);
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") { const spec = node.arguments.length === 1 ? moduleText(node.arguments[0]) : null; if (spec?.endsWith(".node")) emit(node, "native-addon", "require.node", ["argument:0"]); else if (!spec) emit(node, "unknown-execution-sink", "dynamic-require", ["argument:0"]); }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "process" && node.name.text === "env" && isProcessEnvironmentForwarding(node)) emit(node, "process-environment", "process.env", ["forwarded-value"]);
    ts.forEachChild(node, visit);
  };
  visit(sf); return sites;
}
function scriptUnits(sourceSet) {
  const units = [];
  for (const [sourcePath, source] of sourceSet) {
    if (scriptExtensions.has(path.extname(sourcePath))) units.push({ sourcePath, source, lineOffset: 0 });
    else if (sourcePath.endsWith(".html")) {
      const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu; let match;
      while ((match = pattern.exec(source))) { const attributes = match[1]; if (/\bsrc\s*=/iu.test(attributes)) continue; const type = /\btype\s*=\s*["']?([^\s"'>]+)/iu.exec(attributes)?.[1]?.toLowerCase(); if (type && !["module", "text/javascript", "application/javascript"].includes(type)) continue; const contentStart = match.index + match[0].indexOf(match[2]); const lineOffset = source.slice(0, contentStart).split("\n").length - 1; units.push({ sourcePath, source: match[2], lineOffset }); }
    }
  }
  return units;
}
function sanitizeNative(source) {
  const chars = [...source]; let state = "code";
  for (let index = 0; index < chars.length; index += 1) { const char = chars[index]; const next = chars[index + 1];
    if (state === "code" && char === "/" && next === "/") { chars[index] = chars[index + 1] = " "; state = "line"; index += 1; continue; }
    if (state === "code" && char === "/" && next === "*") { chars[index] = chars[index + 1] = " "; state = "block"; index += 1; continue; }
    if (state === "code" && (char === '"' || char === "'")) { chars[index] = " "; state = char === '"' ? "string" : "char"; continue; }
    if (state === "line") { if (char === "\n") state = "code"; else chars[index] = " "; continue; }
    if (state === "block") { if (char === "*" && next === "/") { chars[index] = chars[index + 1] = " "; state = "code"; index += 1; } else if (char !== "\n") chars[index] = " "; continue; }
    if (state === "string" || state === "char") { if (char === "\\") { chars[index] = " "; if (index + 1 < chars.length) chars[++index] = " "; continue; } const terminator = state === "string" ? '"' : "'"; if (char === terminator) state = "code"; if (char !== "\n") chars[index] = " "; }
  }
  return chars.join("");
}
function nativeTokenNormalize(text) { return text.replace(/\/\/[^\n]*|\/\*[\s\S]*?\*\//gu, " ").match(/[A-Za-z_]\w*|0x[\da-fA-F]+|\d+|::|->|==|!=|<=|>=|&&|\|\||\S/gu)?.join("|") ?? ""; }
function matchingDelimiter(text, start, open = "(", close = ")") { let depth = 0; for (let index = start; index < text.length; index += 1) { if (text[index] === open) depth += 1; else if (text[index] === close && --depth === 0) return index; } return text.length - 1; }
function nativeFunctions(sanitized) {
  const ranges = []; const pattern = /\b([A-Za-z_]\w*(?:::[A-Za-z_]\w*)*)\s*\([^;{}]*\)\s*(?:const\s*)?\{/gu; let match;
  const controls = new Set(["if", "for", "while", "switch", "catch"]);
  while ((match = pattern.exec(sanitized))) { const name = match[1]; if (controls.has(name)) continue; const open = match.index + match[0].lastIndexOf("{"); const close = matchingDelimiter(sanitized, open, "{", "}"); ranges.push({ name, start: match.index, open, end: close + 1 }); }
  return ranges;
}
function nativeOperands(api) { if (api.startsWith("CreateProcess")) return ["application", "command-line", "inherit-handles", "creation-flags", "environment", "cwd", "startup-info"]; if (api.startsWith("ShellExecute")) return ["file", "parameters", "directory", "show-mode"]; if (["WinExec", "popen", "_popen", "system"].includes(api)) return ["command"]; if (api.startsWith("LoadLibrary")) return ["library-path", "flags"]; if (api === "GetProcAddress") return ["module-handle", "symbol"]; if (["socket", "connect"].includes(api)) return ["address-family", "endpoint"]; if (api.includes("JobObject")) return ["job-handle", "policy-or-process"]; if (api.includes("AppContainer")) return ["profile-or-sid", "capabilities"]; if (api.includes("PseudoConsole")) return ["conpty-handle", "stdio-handles", "size"]; return ["arguments"];
}
function scanNativeSource(sourcePath, source) {
  const sanitized = sanitizeNative(source); const functions = nativeFunctions(sanitized); const sites = [];
  const pattern = /\b([A-Za-z_]\w*)\s*\(/gu; let match;
  while ((match = pattern.exec(sanitized))) { const mapped = nativeApis.get(match[1]); if (!mapped) continue; const open = sanitized.indexOf("(", match.index); const end = matchingDelimiter(sanitized, open) + 1; const owner = functions.filter(item => item.open < match.index && item.end >= end).sort((a, b) => b.start - a.start)[0]; const line = source.slice(0, match.index).split("\n").length; const column = match.index - source.lastIndexOf("\n", match.index - 1); const normalizedNode = nativeTokenNormalize(source.slice(match.index, end)); const containerText = owner ? source.slice(owner.start, owner.end) : "<top-level>"; sites.push({ sourcePath, line, column, nodeKind: "NativeCallExpression", container: owner?.name ?? "<top-level>", family: mapped[0], api: mapped[1], operands: nativeOperands(mapped[1]), normalizedNodeSha256: sha256(normalizedNode), containerSha256: sha256(nativeTokenNormalize(containerText)), operandProfileSha256: sha256(canonicalJson(nativeOperands(mapped[1]))), executionClass: sec03ExecutionClass(sourcePath) });
  }
  return sites;
}
function finalizeSites(sites) {
  const counts = new Map();
  return sites.sort((a, b) => a.sourcePath.localeCompare(b.sourcePath) || a.line - b.line || a.column - b.column || a.api.localeCompare(b.api)).map(site => { const base = `${site.sourcePath}\0${site.normalizedNodeSha256}\0${site.containerSha256}\0${site.operandProfileSha256}\0${site.family}\0${site.api}`; const occurrence = (counts.get(base) ?? 0) + 1; counts.set(base, occurrence); const id = `exec-${sha256(`${base}\0${occurrence}`).slice(0, 24)}`; const { containerSha256: _container, operandProfileSha256: _operands, ...publicSite } = site; return Object.freeze({ id, occurrence, ...publicSite }); });
}
export function scanSec03SourceSet(input) {
  const sourceSet = input instanceof Map ? new Map([...input].map(([key, value]) => [toPosix(key), value])) : new Map(Object.entries(input).map(([key, value]) => [toPosix(key), value]));
  for (const sourcePath of sourceSet.keys()) if (!sourceExtensions.has(path.extname(sourcePath))) throw new Error(`UNSUPPORTED_RUNTIME_DIALECT: ${sourcePath}`);
  const scriptSet = new Map([...sourceSet].filter(([name]) => scriptExtensions.has(path.extname(name)))); const exports = exportedOrigins(scriptSet); const sites = [];
  for (const unit of scriptUnits(sourceSet)) sites.push(...scanScriptUnit(unit.sourcePath, unit.source, scriptSet, exports, unit.lineOffset));
  for (const [sourcePath, source] of sourceSet) if (nativeExtensions.has(path.extname(sourcePath))) sites.push(...scanNativeSource(sourcePath, source));
  return finalizeSites(sites);
}
export function scanSec03Source(sourcePath, source) { return scanSec03SourceSet(new Map([[sourcePath, source]])); }
async function walk(root, relative, out, accept) { const absolute = path.join(root, ...relative.split("/").filter(Boolean)); for (const entry of await readdir(absolute, { withFileTypes: true })) { const child = relative ? `${relative}/${entry.name}` : entry.name; if (entry.isDirectory()) await walk(root, child, out, accept); else if (entry.isFile() && accept(child)) out.set(toPosix(child), await readFile(path.join(root, ...child.split("/")), "utf8")); } }
export async function collectSec03AuthoredSources(projectRoot) {
  const out = new Map();
  for (const root of ["src", "electron", "scripts", "tests"]) await walk(projectRoot, root, out, name => scriptExtensions.has(path.extname(name)));
  await walk(projectRoot, "native", out, name => nativeExtensions.has(path.extname(name)));
  await walk(projectRoot, "public", out, name => name.endsWith(".html"));
  return out;
}
export async function scanSec03ExecutionSinks(projectRoot) { return scanSec03SourceSet(await collectSec03AuthoredSources(projectRoot)); }
