import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { collectSourceFiles, toPosix } from "./build-inputs.mjs";

export const crosscheckPolicyPath = "tests/sec02-sink-crosscheck-policy.json";

const sourceExtensions = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
const callableMembers = new Set(`
  access accessSync appendFile appendFileSync chmod chmodSync chown chownSync copyFile copyFileSync cp cpSync
  createReadStream createWriteStream existsSync glob globSync link linkSync lstat lstatSync mkdir mkdirSync
  mkdtemp mkdtempSync open openSync openAsBlob opendir opendirSync readFile readFileSync readdir readdirSync
  readlink readlinkSync realpath realpathSync rename renameSync rm rmSync rmdir rmdirSync stat statSync statfs
  statfsSync symlink symlinkSync truncate truncateSync unlink unlinkSync unwatchFile utimes utimesSync lutimes
  lutimesSync watch watchFile writeFile writeFileSync exec execFile execFileSync execSync fork spawn spawnSync
  Worker Database createFromPath createThumbnailFromPath openPath showItemInFolder loadFile loadExtension setPath
  setAppLogsPath showOpenDialog showOpenDialogSync showSaveDialog showSaveDialogSync sendFile download attachment
  static extractRawText convertToHtml readFileAsync writeFileAsync
`.trim().split(/\s+/u));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalize(value[key])]));
  return value;
}

export function canonicalCrosscheckJson(value) {
  return JSON.stringify(canonicalize(value));
}

function normalizeNodeText(node, sourceFile) {
  return node.getText(sourceFile).replace(/\s+/gu, " ").trim();
}

function nodeIdentity(node, sourceFile) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return Object.freeze({
    line: position.line + 1,
    column: position.character + 1,
    nodeKind: ts.SyntaxKind[node.kind],
    normalizedNodeSha256: sha256(normalizeNodeText(node, sourceFile)),
  });
}

function moduleText(node) {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function unwrap(expression) {
  let current = expression;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current) || ts.isNonNullExpression(current) || ts.isAwaitExpression(current))) {
    current = current.expression;
  }
  return current;
}

function bindingNames(name) {
  if (ts.isIdentifier(name)) return [name.text];
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    return name.elements.flatMap(element => ts.isBindingElement(element) ? bindingNames(element.name) : []);
  }
  return [];
}

function isTypePosition(node) {
  let current = node.parent;
  while (current) {
    if (ts.isTypeNode(current) || ts.isImportTypeNode(current)) return true;
    if (ts.isExpression(current) || ts.isStatement(current) || ts.isSourceFile(current)) return false;
    current = current.parent;
  }
  return false;
}

function adapterMap(policy) {
  return new Map(policy.adapters.map(adapter => [adapter.sourcePath, new Set(adapter.modules)]));
}

function exceptionKey(value) {
  return `${value.sourcePath}\0${value.kind}\0${value.normalizedNodeSha256}`;
}

function policyPayload(policy) {
  const { canonicalPayloadSha256: _digest, ...payload } = policy;
  return payload;
}

export function validateSec02DialectPolicy(policy, analyzerSha256) {
  assert.deepEqual(Object.keys(policy).sort(), [
    "schemaVersion", "task", "domain", "analyzerSha256", "sourceRoots", "packageRoots", "extensions",
    "governedModules", "adapters", "reviewedSyntaxExceptions", "canonicalPayloadSha256",
  ].sort(), "Restricted runtime dialect policy keys differ");
  assert.equal(policy.schemaVersion, 2);
  assert.equal(policy.task, "SEC-02");
  assert.equal(policy.domain, "mini-lux/sec02/restricted-runtime-dialect/v1");
  assert.equal(policy.analyzerSha256, analyzerSha256, "Restricted runtime dialect policy targets a different checker");
  assert.equal(policy.canonicalPayloadSha256, sha256(canonicalCrosscheckJson(policyPayload(policy))), "Restricted runtime dialect policy digest differs");
  assert.deepEqual(policy.sourceRoots, ["src/", "electron/"]);
  assert.deepEqual(policy.packageRoots, ["dist/", "electron/"]);
  assert.deepEqual(policy.extensions, [".ts", ".tsx", ".js", ".mjs", ".cjs"]);
  assert(Array.isArray(policy.governedModules) && policy.governedModules.length > 0);
  assert.equal(new Set(policy.governedModules).size, policy.governedModules.length, "Governed module list contains duplicates");
  assert(Array.isArray(policy.adapters) && policy.adapters.length > 0);
  assert.equal(new Set(policy.adapters.map(item => item.sourcePath)).size, policy.adapters.length, "Adapter paths contain duplicates");
  const governed = new Set(policy.governedModules);
  for (const adapter of policy.adapters) {
    assert.deepEqual(Object.keys(adapter).sort(), ["sourcePath", "modules"].sort(), `Adapter keys differ: ${adapter.sourcePath}`);
    assert(policy.sourceRoots.some(root => adapter.sourcePath.startsWith(root)), `Adapter is outside source roots: ${adapter.sourcePath}`);
    assert(Array.isArray(adapter.modules) && adapter.modules.length > 0);
    assert(adapter.modules.every(moduleName => governed.has(moduleName)), `Adapter contains an ungoverned module: ${adapter.sourcePath}`);
  }
  assert(Array.isArray(policy.reviewedSyntaxExceptions));
  assert.equal(new Set(policy.reviewedSyntaxExceptions.map(exceptionKey)).size, policy.reviewedSyntaxExceptions.length, "Dialect exceptions contain duplicates");
  for (const exception of policy.reviewedSyntaxExceptions) {
    assert.deepEqual(Object.keys(exception).sort(), ["sourcePath", "kind", "normalizedNodeSha256", "rationale"].sort(), `Dialect exception keys differ: ${exception.sourcePath}`);
    assert(["nonliteral-dynamic-import", "module-namespace-normalization"].includes(exception.kind));
    assert.match(exception.normalizedNodeSha256, /^[a-f0-9]{64}$/u);
    assert.equal(typeof exception.rationale, "string");
    assert(exception.rationale.length > 0);
  }
  return Object.freeze({ governed, adapters: adapterMap(policy), exceptions: new Map(policy.reviewedSyntaxExceptions.map(item => [exceptionKey(item), item])), policy });
}

function packagePath(sourcePath) {
  if (sourcePath.startsWith("src/") && /\.(?:ts|tsx)$/u.test(sourcePath)) return `dist/${sourcePath.slice(4).replace(/\.(?:ts|tsx)$/u, ".js")}`;
  return sourcePath;
}

function stateForMode(state, mode) {
  if (mode === "source") return Object.freeze({ ...state, exceptionPairs: null });
  assert.equal(mode, "package", "Restricted runtime dialect mode is invalid");
  const adapters = new Map(state.policy.adapters.map(adapter => [packagePath(adapter.sourcePath), new Set(adapter.modules)]));
  const exceptionPairs = new Set(state.policy.reviewedSyntaxExceptions.map(item => `${packagePath(item.sourcePath)}\0${item.kind}`));
  return Object.freeze({ ...state, adapters, exceptionPairs });
}

function importBindingRecords(sourceFile, governed, violations, imports, relative, allowedModules) {
  const origins = new Map();
  const register = (name, moduleName, member) => origins.set(name, Object.freeze({ moduleName, member }));
  const approveModule = (node, moduleName, kind) => {
    const identity = nodeIdentity(node, sourceFile);
    imports.push(Object.freeze({ sourcePath: relative, moduleName, kind, ...identity }));
    if (!allowedModules?.has(moduleName)) violations.push(Object.freeze({ code: "UNAPPROVED_GOVERNED_IMPORT", sourcePath: relative, moduleName, ...identity }));
  };
  const visit = node => {
    if (ts.isImportDeclaration(node)) {
      const moduleName = moduleText(node.moduleSpecifier);
      if (moduleName && governed.has(moduleName)) {
        approveModule(node, moduleName, "static-import");
        const clause = node.importClause;
        if (clause && !clause.isTypeOnly) {
          if (clause.name) register(clause.name.text, moduleName, "default");
          if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) register(clause.namedBindings.name.text, moduleName, "*");
          if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const element of clause.namedBindings.elements) if (!element.isTypeOnly) register(element.name.text, moduleName, element.propertyName?.text ?? element.name.text);
          }
        }
      }
    }
    if (ts.isExportDeclaration(node)) {
      const moduleName = node.moduleSpecifier ? moduleText(node.moduleSpecifier) : null;
      if (moduleName && governed.has(moduleName)) violations.push(Object.freeze({ code: "GOVERNED_REEXPORT", sourcePath: relative, moduleName, ...nodeIdentity(node, sourceFile) }));
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      const moduleName = node.arguments.length === 1 ? moduleText(node.arguments[0]) : null;
      if (moduleName && governed.has(moduleName)) {
        approveModule(node, moduleName, "require");
        const declaration = node.parent && ts.isVariableDeclaration(node.parent) ? node.parent : null;
        if (!declaration) violations.push(Object.freeze({ code: "UNSUPPORTED_RUNTIME_DIALECT", sourcePath: relative, detail: "governed require must initialize one binding", ...nodeIdentity(node, sourceFile) }));
        else for (const name of bindingNames(declaration.name)) register(name, moduleName, ts.isIdentifier(declaration.name) ? "default" : name);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return origins;
}

function originOf(expression, origins, violations, sourceFile, relative) {
  const value = unwrap(expression);
  if (!value) return null;
  if (ts.isIdentifier(value)) return origins.get(value.text) ?? null;
  if (ts.isPropertyAccessExpression(value)) {
    const parent = originOf(value.expression, origins, violations, sourceFile, relative);
    return parent ? { moduleName: parent.moduleName, member: value.name.text } : null;
  }
  if (ts.isElementAccessExpression(value)) {
    const parent = originOf(value.expression, origins, violations, sourceFile, relative);
    if (parent) violations.push(Object.freeze({ code: "UNSUPPORTED_RUNTIME_DIALECT", sourcePath: relative, detail: "computed governed member", ...nodeIdentity(value, sourceFile) }));
    return parent ? { moduleName: parent.moduleName, member: "<computed>" } : null;
  }
  return null;
}

function checkGovernedReexports(sourceFile, origins, violations, relative) {
  const reject = (node, origin) => violations.push(Object.freeze({
    code: "GOVERNED_REEXPORT",
    sourcePath: relative,
    moduleName: origin.moduleName,
    detail: "imported governed binding re-export",
    ...nodeIdentity(node, sourceFile),
  }));
  const exportedModifier = node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword);
  const origin = expression => originOf(expression, origins, violations, sourceFile, relative);
  const isCommonJsExportTarget = expression => {
    const value = unwrap(expression);
    if (ts.isPropertyAccessExpression(value)) {
      if (ts.isIdentifier(value.expression) && value.expression.text === "exports") return true;
      if (ts.isPropertyAccessExpression(value.expression)
        && ts.isIdentifier(value.expression.expression) && value.expression.expression.text === "module"
        && value.expression.name.text === "exports") return true;
    }
    return ts.isPropertyAccessExpression(value)
      && ts.isIdentifier(value.expression) && value.expression.text === "module" && value.name.text === "exports";
  };
  const visit = node => {
    if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const element of node.exportClause.elements) {
        if (element.isTypeOnly) continue;
        const local = element.propertyName ?? element.name;
        const governedOrigin = origin(local);
        if (governedOrigin) reject(element, governedOrigin);
      }
    }
    if (ts.isExportAssignment(node)) {
      const governedOrigin = origin(node.expression);
      if (governedOrigin) reject(node, governedOrigin);
    }
    if (ts.isVariableStatement(node) && exportedModifier(node)) {
      for (const declaration of node.declarationList.declarations) {
        if (!declaration.initializer) continue;
        const governedOrigin = origin(declaration.initializer);
        if (governedOrigin) reject(declaration, governedOrigin);
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && isCommonJsExportTarget(node.left)) {
      const governedOrigin = origin(node.right);
      if (governedOrigin) reject(node, governedOrigin);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

function checkCallableEscapes(sourceFile, origins, violations, relative) {
  const isCallable = expression => {
    const origin = originOf(expression, origins, violations, sourceFile, relative);
    return origin && (callableMembers.has(origin.member) || (origin.member === "default" && ["better-sqlite3"].includes(origin.moduleName)));
  };
  const collectionStoresCallable = node => {
    if (ts.isArrayLiteralExpression(node)) {
      return node.elements.some(element => {
        const value = ts.isSpreadElement(element) ? element.expression : element;
        return isCallable(value) || collectionStoresCallable(unwrap(value));
      });
    }
    if (ts.isObjectLiteralExpression(node)) {
      return node.properties.some(property => {
        if (ts.isPropertyAssignment(property)) {
          return isCallable(property.initializer) || collectionStoresCallable(unwrap(property.initializer));
        }
        if (ts.isShorthandPropertyAssignment(property)) return isCallable(property.name);
        if (ts.isSpreadAssignment(property)) {
          return isCallable(property.expression) || originOf(property.expression, origins, violations, sourceFile, relative) !== null;
        }
        return false;
      });
    }
    return false;
  };
  const visit = node => {
    if ((ts.isArrayLiteralExpression(node) || ts.isObjectLiteralExpression(node)) && collectionStoresCallable(node)) {
      violations.push(Object.freeze({ code: "UNSUPPORTED_RUNTIME_DIALECT", sourcePath: relative, detail: "governed callable stored in collection", ...nodeIdentity(node, sourceFile) }));
    }
    if (ts.isVariableDeclaration(node) && node.initializer && isCallable(node.initializer)) {
      violations.push(Object.freeze({ code: "UNSUPPORTED_RUNTIME_DIALECT", sourcePath: relative, detail: "governed callable alias", ...nodeIdentity(node, sourceFile) }));
    }
    if (ts.isReturnStatement(node) && node.expression && isCallable(node.expression)) {
      violations.push(Object.freeze({ code: "UNSUPPORTED_RUNTIME_DIALECT", sourcePath: relative, detail: "governed callable return", ...nodeIdentity(node, sourceFile) }));
    }
    if (ts.isConditionalExpression(node) && (isCallable(node.whenTrue) || isCallable(node.whenFalse))) {
      violations.push(Object.freeze({ code: "UNSUPPORTED_RUNTIME_DIALECT", sourcePath: relative, detail: "conditional governed callable", ...nodeIdentity(node, sourceFile) }));
    }
    if (ts.isCallExpression(node)) {
      isCallable(node.expression);
      for (const argument of node.arguments) if (isCallable(argument)) {
        violations.push(Object.freeze({ code: "UNSUPPORTED_RUNTIME_DIALECT", sourcePath: relative, detail: "governed callable passed as argument", ...nodeIdentity(node, sourceFile) }));
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && (isCallable(node.left) || isCallable(node.right))) {
      violations.push(Object.freeze({ code: "UNSUPPORTED_RUNTIME_DIALECT", sourcePath: relative, detail: "governed callable assignment", ...nodeIdentity(node, sourceFile) }));
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
}

export function scanSec02RestrictedSource(relative, bytes, policyState) {
  const sourceFile = ts.createSourceFile(relative, bytes, ts.ScriptTarget.Latest, true,
    relative.endsWith(".ts") || relative.endsWith(".tsx") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  assert.equal(sourceFile.parseDiagnostics.length, 0, `restricted runtime source has parse diagnostics: ${relative}`);
  const violations = [];
  const imports = [];
  const usedExceptions = [];
  const allowedModules = policyState.adapters.get(relative);
  const approvedException = (kind, normalizedNodeSha256) => {
    const pair = `${relative}\0${kind}`;
    if (policyState.exceptionPairs?.has(pair)) return pair;
    const exact = exceptionKey({ sourcePath: relative, kind, normalizedNodeSha256 });
    if (policyState.exceptions.has(exact)) return exact;
    return null;
  };
  const origins = importBindingRecords(sourceFile, policyState.governed, violations, imports, relative, allowedModules);
  const dynamicBindingDeclarations = new Set();
  const dynamicBindingNames = new Set();

  const visitLoaders = node => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const moduleName = node.arguments.length === 1 ? moduleText(node.arguments[0]) : null;
      const identity = nodeIdentity(node, sourceFile);
      if (moduleName) {
        imports.push(Object.freeze({ sourcePath: relative, moduleName, kind: "dynamic-import", ...identity }));
        if (policyState.governed.has(moduleName)) {
          if (!allowedModules?.has(moduleName)) violations.push(Object.freeze({ code: "UNAPPROVED_GOVERNED_IMPORT", sourcePath: relative, moduleName, ...identity }));
          const awaited = node.parent && ts.isAwaitExpression(node.parent) ? node.parent : node;
          const declaration = awaited.parent && ts.isVariableDeclaration(awaited.parent) ? awaited.parent : null;
          if (!declaration) violations.push(Object.freeze({ code: "UNSUPPORTED_RUNTIME_DIALECT", sourcePath: relative, detail: "governed dynamic import must initialize one binding", ...identity }));
          else {
            dynamicBindingDeclarations.add(declaration);
            for (const name of bindingNames(declaration.name)) {
              dynamicBindingNames.add(name);
              origins.set(name, Object.freeze({ moduleName, member: "*" }));
            }
          }
        }
      } else {
        const key = approvedException("nonliteral-dynamic-import", identity.normalizedNodeSha256);
        if (key) usedExceptions.push(key);
        else violations.push(Object.freeze({ code: "UNSUPPORTED_RUNTIME_DIALECT", sourcePath: relative, detail: "non-literal dynamic import", ...identity }));
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "require") {
      const moduleName = node.arguments.length === 1 ? moduleText(node.arguments[0]) : null;
      if (!moduleName) violations.push(Object.freeze({ code: "UNSUPPORTED_RUNTIME_DIALECT", sourcePath: relative, detail: "non-literal require", ...nodeIdentity(node, sourceFile) }));
    }
    ts.forEachChild(node, visitLoaders);
  };
  visitLoaders(sourceFile);

  const referencedDynamicOrigin = node => {
    let found = null;
    const visit = current => {
      if (found || ts.isFunctionLike(current)) return;
      if (ts.isIdentifier(current) && dynamicBindingNames.has(current.text)) found = origins.get(current.text);
      else ts.forEachChild(current, visit);
    };
    visit(node);
    return found;
  };
  const visitNormalizations = node => {
    if (ts.isVariableDeclaration(node) && node.initializer && !dynamicBindingDeclarations.has(node)) {
      const unwrapped = unwrap(node.initializer);
      const directExecution = unwrapped && (ts.isCallExpression(unwrapped) || ts.isNewExpression(unwrapped));
      const origin = directExecution ? null : referencedDynamicOrigin(node.initializer);
      if (origin) {
        const identity = nodeIdentity(node, sourceFile);
        const key = approvedException("module-namespace-normalization", identity.normalizedNodeSha256);
        if (!key) violations.push(Object.freeze({ code: "UNSUPPORTED_RUNTIME_DIALECT", sourcePath: relative, detail: "module namespace alias", ...identity }));
        else {
          usedExceptions.push(key);
          for (const name of bindingNames(node.name)) origins.set(name, Object.freeze({ moduleName: origin.moduleName, member: "*" }));
        }
      }
    }
    ts.forEachChild(node, visitNormalizations);
  };
  visitNormalizations(sourceFile);
  checkGovernedReexports(sourceFile, origins, violations, relative);
  checkCallableEscapes(sourceFile, origins, violations, relative);
  return Object.freeze({
    sourcePath: relative,
    bytes: Buffer.byteLength(bytes, "utf8"),
    sha256: sha256(Buffer.from(bytes, "utf8")),
    imports: Object.freeze(imports),
    usedExceptions: Object.freeze(usedExceptions),
    violations: Object.freeze(violations),
  });
}

export function validateSec02RestrictedSourceSet(sourceInput, policy, analyzerSha256, mode = "source") {
  const baseState = validateSec02DialectPolicy(policy, analyzerSha256);
  const policyState = stateForMode(baseState, mode);
  const sources = sourceInput instanceof Map ? sourceInput : new Map(Object.entries(sourceInput));
  const records = [...sources].sort(([left], [right]) => left.localeCompare(right, "en"))
    .map(([relative, bytes]) => scanSec02RestrictedSource(relative, bytes, policyState));
  const violations = records.flatMap(record => record.violations);
  const usedExceptions = records.flatMap(record => record.usedExceptions);
  const expectedExceptions = mode === "source"
    ? [...policyState.exceptions.keys()].sort()
    : [...policyState.exceptionPairs].sort();
  assert.deepEqual([...new Set(usedExceptions)].sort(), expectedExceptions, "Restricted runtime dialect exceptions are missing or stale");
  assert.deepEqual(violations, [], "UNSUPPORTED_RUNTIME_DIALECT violations remain");
  const files = records.map(record => ({ sourcePath: record.sourcePath, bytes: record.bytes, sha256: record.sha256 }));
  const imports = records.flatMap(record => record.imports);
  return Object.freeze({
    fileCount: files.length,
    fileManifestSha256: sha256(canonicalCrosscheckJson(files)),
    importCount: imports.length,
    importSetSha256: sha256(canonicalCrosscheckJson(imports)),
    exceptionCount: usedExceptions.length,
    complete: true,
  });
}

export async function scanSec02RestrictedRuntime(projectRoot, policy, analyzerSha256) {
  const files = (await collectSourceFiles(projectRoot)).filter(absolute => {
    const relative = toPosix(path.relative(projectRoot, absolute));
    return (relative.startsWith("src/") || relative.startsWith("electron/")) && sourceExtensions.has(path.extname(relative).toLowerCase());
  });
  const sources = new Map();
  for (const absolute of files) sources.set(toPosix(path.relative(projectRoot, absolute)), await readFile(absolute, "utf8"));
  return validateSec02RestrictedSourceSet(sources, policy, analyzerSha256);
}
