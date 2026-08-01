import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import ts from "typescript";
import { collectSourceFiles } from "./build-inputs.mjs";

const fsModules = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
const childProcessModules = new Set(["child_process", "node:child_process"]);
const workerModules = new Set(["worker_threads", "node:worker_threads"]);
const electronPathOperands = Object.freeze({
  createFromPath: ["argument:0"],
  createThumbnailFromPath: ["argument:0"],
  openPath: ["argument:0"],
  showItemInFolder: ["argument:0"],
  loadFile: ["argument:0"],
  loadExtension: ["argument:0"],
  setPath: ["argument:1"],
  setAppLogsPath: ["argument:0"],
});
const electronPathMethods = new Set(Object.keys(electronPathOperands));
const electronDialogMethods = new Set(["showOpenDialog", "showOpenDialogSync", "showSaveDialog", "showSaveDialogSync"]);
const xlsxPathOperands = Object.freeze({ readFile: ["argument:0"], readFileSync: ["argument:0"], writeFile: ["argument:1"], writeFileAsync: ["argument:0"] });
const xlsxPathMethods = new Set(Object.keys(xlsxPathOperands));
const mammothPathMethods = new Set(["extractRawText", "convertToHtml"]);
const thirdPartyPathModules = new Set(["express", "xlsx", "sheetjs", "mammoth", "better-sqlite3"]);
const fsPathMethods = new Set([
  "access", "accessSync", "appendFile", "appendFileSync", "chmod", "chmodSync", "chown", "chownSync",
  "copyFile", "copyFileSync", "cp", "cpSync", "createReadStream", "createWriteStream", "existsSync",
  "link", "linkSync", "lstat", "lstatSync", "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync", "open", "openSync", "openAsBlob", "opendir",
  "opendirSync", "readFile", "readFileSync", "readdir", "readdirSync", "readlink", "readlinkSync", "realpath",
  "realpathSync", "rename", "renameSync", "rm", "rmSync", "rmdir", "rmdirSync", "stat", "statSync", "symlink",
  "symlinkSync", "truncate", "truncateSync", "unlink", "unlinkSync", "utimes", "utimesSync", "lutimes", "lutimesSync", "watch", "watchFile", "writeFile", "writeFileSync",
]);
const processMethods = new Set(["exec", "execFile", "execFileSync", "execSync", "fork", "spawn", "spawnSync"]);
const multiPathFsOperands = Object.freeze({
  copyFile: ["argument:0", "argument:1"], copyFileSync: ["argument:0", "argument:1"],
  cp: ["argument:0", "argument:1"], cpSync: ["argument:0", "argument:1"],
  link: ["argument:0", "argument:1"], linkSync: ["argument:0", "argument:1"],
  rename: ["argument:0", "argument:1"], renameSync: ["argument:0", "argument:1"],
  symlink: ["argument:0", "argument:1"], symlinkSync: ["argument:0", "argument:1"],
});

function isGovernedOrigin(origin) {
  return origin && (fsModules.has(origin.moduleName) || childProcessModules.has(origin.moduleName)
    || workerModules.has(origin.moduleName) || origin.moduleName === "electron" || thirdPartyPathModules.has(origin.moduleName));
}

function isGovernedCallableOrigin(origin) {
  if (!origin || origin.instanceOf) return false;
  if (fsModules.has(origin.moduleName)) return fsPathMethods.has(origin.member)
    || (origin.member === "native" && ["realpath", "realpathSync"].includes(origin.receiver));
  if (childProcessModules.has(origin.moduleName)) return processMethods.has(origin.member);
  if (workerModules.has(origin.moduleName)) return origin.member === "Worker";
  if (origin.moduleName === "electron") return electronPathMethods.has(origin.member) || electronDialogMethods.has(origin.member) || ["BrowserWindow", "Tray"].includes(origin.member);
  if (["xlsx", "sheetjs"].includes(origin.moduleName)) return xlsxPathMethods.has(origin.member);
  if (origin.moduleName === "mammoth") return mammothPathMethods.has(origin.member);
  return origin.moduleName === "better-sqlite3";
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function toPosix(value) {
  return value.replaceAll("\\", "/");
}

function normalizeNodeText(node, sourceFile) {
  return node.getText(sourceFile).replace(/\s+/gu, " ").trim();
}

function enclosingContainer(node, sourceFile) {
  let current = node.parent;
  while (current && current !== sourceFile) {
    if (ts.isMethodDeclaration(current) || ts.isMethodSignature(current) || ts.isGetAccessorDeclaration(current)
      || ts.isSetAccessorDeclaration(current) || ts.isConstructorDeclaration(current)) {
      const member = ts.isConstructorDeclaration(current) ? "constructor" : propertyName(current.name) ?? current.name?.getText(sourceFile) ?? "<computed>";
      const owner = current.parent?.name && ts.isIdentifier(current.parent.name) ? current.parent.name.text : "<class>";
      return `${owner}.${member}`;
    }
    if (ts.isFunctionDeclaration(current) && current.name) return current.name.text;
    if ((ts.isArrowFunction(current) || ts.isFunctionExpression(current)) && ts.isVariableDeclaration(current.parent)
      && ts.isIdentifier(current.parent.name)) return current.parent.name.text;
    current = current.parent;
  }
  return "<top-level>";
}

function moduleSpecifierText(node) {
  return ts.isStringLiteralLike(node) ? node.text : null;
}

function propertyName(node) {
  if (!node) return null;
  if (ts.isIdentifier(node) || ts.isPrivateIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  return null;
}

function collectBindings(sourceFile, externalBindings = new Map()) {
  const bindings = new Map(externalBindings);
  const requireNames = new Map([["require", "require"]]);
  const declarations = [];
  const propertyDeclarations = [];
  const callableDeclarations = [];
  const classDeclarations = [];
  const callExpressions = [];
  const newExpressions = [];
  const parameterBindings = new Map();
  const declarationOrigins = new Map();
  const propertyBindings = new Map();
  const propertyAssignments = [];
  const identifierAssignments = [];
  const objectProperties = [];
  const visitDeclarations = node => {
    if (ts.isVariableDeclaration(node) || (ts.isParameter(node) && node.initializer) || (ts.isBindingElement(node) && node.initializer)) declarations.push(node);
    if (ts.isPropertyDeclaration(node) && node.initializer) propertyDeclarations.push(node);
    if (ts.isFunctionDeclaration(node) && node.name) {
      callableDeclarations.push({ name: node.name.text, declaration: node, owner: null });
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      callableDeclarations.push({ name: node.name.text, declaration: node.initializer, owner: node });
    }
    if (ts.isCallExpression(node)) callExpressions.push(node);
    if (ts.isNewExpression(node)) newExpressions.push(node);
    if (ts.isClassDeclaration(node) && node.name) classDeclarations.push(node);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left)) propertyAssignments.push(node);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(node.left)) identifierAssignments.push(node);
    if (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) objectProperties.push(node);
    ts.forEachChild(node, visitDeclarations);
  };
  visitDeclarations(sourceFile);
  const lexicalScope = node => {
    let current = node;
    while (current && current !== sourceFile) {
      if (ts.isFunctionLike(current) || ts.isBlock(current)) return current;
      current = current.parent;
    }
    return sourceFile;
  };
  const visibleDeclaration = identifier => {
    const scopes = [];
    let current = identifier;
    while (current) {
      if (current === sourceFile || ts.isFunctionLike(current) || ts.isBlock(current)) scopes.push(current);
      if (current === sourceFile) break;
      current = current.parent;
    }
    for (const scope of scopes) {
      const candidates = declarations.filter(declaration => ts.isVariableDeclaration(declaration)
        && ts.isIdentifier(declaration.name) && declaration.name.text === identifier.text
        && lexicalScope(declaration) === scope);
      if (candidates.length > 0) return candidates.at(-1);
    }
    return null;
  };
  const propertyKey = expression => {
    const text = expression.getText(sourceFile);
    if (!text.startsWith("this.")) return text;
    let current = expression.parent;
    while (current && current !== sourceFile) {
      if (ts.isClassDeclaration(current) || ts.isClassExpression(current)) {
        const owner = current.name && ts.isIdentifier(current.name) ? current.name.text : "<class>";
        return `${owner}:${text}`;
      }
      current = current.parent;
    }
    return `<class>:${text}`;
  };
  const calledIdentifiers = new Set(callExpressions.filter(call => ts.isIdentifier(call.expression)).map(call => call.expression.text));
  const governedOrigin = isGovernedOrigin;
  const bindInto = (map, name, value) => {
    if (!name || !value) return false;
    const prior = map.get(name);
    if (prior && JSON.stringify(prior) === JSON.stringify(value)) return false;
    if (prior) return false;
    map.set(name, value);
    return true;
  };
  const bind = (name, value) => bindInto(bindings, name, value);
  const bindDeclaration = (declaration, value) => {
    if (!value || !ts.isIdentifier(declaration.name)) return false;
    const prior = declarationOrigins.get(declaration);
    if (prior && JSON.stringify(prior) === JSON.stringify(value)) return false;
    if (prior) return false;
    declarationOrigins.set(declaration, value);
    return bind(declaration.name.text, value) || true;
  };
  const bindProperty = (name, value) => {
    if (!name || !value) return false;
    const prior = propertyBindings.get(name);
    if (!prior) {
      propertyBindings.set(name, value);
      return true;
    }
    if (JSON.stringify(prior) === JSON.stringify(value)) return false;
    if (prior.unresolved && prior.unresolvedApi === "conflicting-property-alias") return false;
    const governed = governedOrigin(prior) ? prior : governedOrigin(value) ? value : null;
    if (!governed) return false;
    propertyBindings.set(name, { ...governed, unresolved: true, unresolvedApi: "conflicting-property-alias", derived: "property-conflict" });
    return true;
  };
  const bindDeclarationAssignment = (declaration, value) => {
    if (!declaration || !value) return false;
    const prior = declarationOrigins.get(declaration);
    if (!prior) {
      declarationOrigins.set(declaration, value);
      return ts.isIdentifier(declaration.name) ? (bind(declaration.name.text, value) || true) : true;
    }
    if (JSON.stringify(prior) === JSON.stringify(value)) return false;
    if (prior.unresolved && prior.unresolvedApi === "conflicting-alias") return false;
    const governed = governedOrigin(prior) ? prior : governedOrigin(value) ? value : null;
    if (!governed) return false;
    declarationOrigins.set(declaration, { ...governed, unresolved: true, unresolvedApi: "conflicting-alias", derived: "assignment-conflict" });
    return true;
  };
  const bindAssignment = (name, value) => {
    if (!name || !value) return false;
    const prior = bindings.get(name);
    if (!prior) {
      bindings.set(name, value);
      return true;
    }
    if (JSON.stringify(prior) === JSON.stringify(value)) return false;
    if (prior.unresolved && prior.unresolvedApi === "conflicting-alias") return false;
    const governed = governedOrigin(prior) ? prior : governedOrigin(value) ? value : null;
    if (!governed) return false;
    bindings.set(name, { ...governed, unresolved: true, unresolvedApi: "conflicting-alias", derived: "assignment-conflict" });
    return true;
  };
  const bindParameter = (name, value) => {
    if (!name || !value) return false;
    const prior = parameterBindings.get(name);
    if (!prior) {
      parameterBindings.set(name, value);
      return true;
    }
    if (JSON.stringify(prior) === JSON.stringify(value)) return false;
    if (prior.unresolved) return false;
    parameterBindings.set(name, { ...prior, unresolved: true, derived: "conflicting-callers" });
    return true;
  };
  bindings.set("require", { moduleName: "<module-loader>", member: "require", chain: [], loader: true, loaderApi: "require" });
  for (const callable of callableDeclarations) {
    const origin = { moduleName: "<authored-function>", member: callable.name, chain: [], authoredCallable: true };
    bindings.set(callable.name, origin);
    if (callable.owner) declarationOrigins.set(callable.owner, origin);
  }
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const moduleName = moduleSpecifierText(statement.moduleSpecifier);
    if (!moduleName || !statement.importClause) continue;
    const clause = statement.importClause;
    if (clause.name) bind(clause.name.text, { moduleName, member: "default", chain: ["default"] });
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      bind(clause.namedBindings.name.text, { moduleName, member: "*", chain: [] });
    } else if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) {
        const member = element.propertyName?.text ?? element.name.text;
        bind(element.name.text, { moduleName, member, chain: [member] });
      }
    }
  }
  for (const declaration of declarations) {
    if (ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name)) {
      const external = externalBindings.get(declaration.name.text);
      if (external) declarationOrigins.set(declaration, external);
    }
  }
  const shadowingParameter = identifier => {
    const find = (name, initializer) => {
      if (ts.isIdentifier(name)) return name.text === identifier.text ? { name, initializer } : undefined;
      if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
        for (const element of name.elements) {
          if (!ts.isBindingElement(element)) continue;
          const found = find(element.name, element.initializer ?? initializer);
          if (found !== undefined) return found;
        }
      }
      return undefined;
    };
    let current = identifier.parent;
    while (current && current !== sourceFile) {
      if (ts.isFunctionLike(current)) {
        for (const parameter of current.parameters) {
          const found = find(parameter.name, parameter.initializer);
          if (found !== undefined) return found;
        }
      }
      current = current.parent;
    }
    return undefined;
  };
  const resolve = expression => {
    if (!expression) return null;
    if (ts.isParenthesizedExpression(expression)) return resolve(expression.expression);
    if (ts.isIdentifier(expression)) {
      const parameter = shadowingParameter(expression);
      if (parameter) return parameterBindings.get(parameter.name) ?? resolve(parameter.initializer);
      const declaration = visibleDeclaration(expression);
      if (declaration) return declarationOrigins.get(declaration) ?? null;
      return bindings.get(expression.text) ?? null;
    }
    if (ts.isObjectLiteralExpression(expression)) {
      const properties = {};
      let hasGoverned = false;
      let unresolved = false;
      for (const property of expression.properties) {
        if (ts.isSpreadAssignment(property)) {
          const spread = resolve(property.expression);
          if (spread?.properties) Object.assign(properties, spread.properties);
          if (isGovernedOrigin(spread)) hasGoverned = true;
          if (!spread) unresolved = true;
          continue;
        }
        if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
        const name = propertyName(property.name);
        const value = ts.isShorthandPropertyAssignment(property) ? resolve(property.name) : resolve(property.initializer);
        if (name && value) {
          properties[name] = value;
          if (isGovernedOrigin(value)) hasGoverned = true;
        }
      }
      return { moduleName: "<object>", member: "*", chain: [], properties, governedProperties: hasGoverned, unresolved };
    }
    if (ts.isArrayLiteralExpression(expression)) {
      const elements = expression.elements.map(element => resolve(element));
      return { moduleName: "<array>", member: "*", chain: [], elements, governedProperties: elements.some(isGovernedOrigin) };
    }
    if (ts.isPropertyAccessExpression(expression)) {
      const parent = resolve(expression.expression);
      if (parent?.properties) return parent.properties[expression.name.text] ?? null;
      if (parent?.exports?.[expression.name.text]) return parent.exports[expression.name.text];
      const exactProperty = propertyBindings.get(propertyKey(expression));
      if (exactProperty) return exactProperty;
      if (!parent) return null;
      return { moduleName: parent.moduleName, member: expression.name.text, receiver: parent.member, chain: [...(parent.chain ?? []), expression.name.text], derived: parent.derived, unresolved: parent.unresolved };
    }
    if (ts.isElementAccessExpression(expression)) {
      const parent = resolve(expression.expression);
      if (!parent) return null;
      if (ts.isNumericLiteral(expression.argumentExpression) && parent.elements) return parent.elements[Number(expression.argumentExpression.text)] ?? null;
      if (ts.isStringLiteralLike(expression.argumentExpression)) {
        if (parent.properties) return parent.properties[expression.argumentExpression.text] ?? null;
        return { moduleName: parent.moduleName, member: expression.argumentExpression.text, receiver: parent.member, chain: [...(parent.chain ?? []), expression.argumentExpression.text], derived: parent.derived, unresolved: parent.unresolved };
      }
      return { ...parent, member: "<computed>", receiver: parent.member, unresolved: true };
    }
    if (ts.isConditionalExpression(expression)) {
      const whenTrue = resolve(expression.whenTrue);
      const whenFalse = resolve(expression.whenFalse);
      if (whenTrue && whenFalse && JSON.stringify(whenTrue) === JSON.stringify(whenFalse)) return whenTrue;
      const governed = governedOrigin(whenTrue) ? whenTrue : governedOrigin(whenFalse) ? whenFalse : null;
      return governed ? { ...governed, unresolved: true, unresolvedApi: "conditional-alias", derived: "conditional-origin" } : null;
    }
    if (ts.isBinaryExpression(expression)
      && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.QuestionQuestionToken].includes(expression.operatorToken.kind)) {
      const left = resolve(expression.left);
      const right = resolve(expression.right);
      if (left && right && JSON.stringify(left) === JSON.stringify(right)) return left;
      const governed = governedOrigin(left) ? left : governedOrigin(right) ? right : null;
      return governed ? { ...governed, unresolved: true, unresolvedApi: "conditional-alias", derived: "logical-origin" } : null;
    }
    if (ts.isNewExpression(expression)) {
      const constructor = resolve(expression.expression);
      return constructor ? { ...constructor, instanceOf: constructor.member } : null;
    }
    if (ts.isCallExpression(expression)) {
      if (ts.isIdentifier(expression.expression) && requireNames.has(expression.expression.text) && expression.arguments.length === 1) {
        const moduleName = moduleSpecifierText(expression.arguments[0]);
        return moduleName ? { moduleName, member: "default", chain: [] } : null;
      }
      const callable = resolve(expression.expression);
      if (callable?.loader && expression.arguments.length === 1) {
        const moduleName = moduleSpecifierText(expression.arguments[0]);
        return moduleName ? { moduleName, member: "default", chain: [] } : { ...callable };
      }
      if (callable?.moduleName === "node:module" && callable.member === "createRequire") {
        return { moduleName: "<module-loader>", member: "createRequire-call", chain: [], loader: true, loaderApi: "createRequire-call" };
      }
      if (ts.isPropertyAccessExpression(expression.expression)
        && ts.isIdentifier(expression.expression.expression) && expression.expression.expression.text === "Object"
        && ["freeze", "seal", "preventExtensions"].includes(expression.expression.name.text)
        && expression.arguments.length === 1) return resolve(expression.arguments[0]);
      if (callable?.moduleName === "node:util" && callable.member === "promisify" && expression.arguments.length === 1) {
        const target = resolve(expression.arguments[0]);
        return target ? { ...target, derived: "promisify" } : null;
      }
      if (ts.isPropertyAccessExpression(expression.expression) && expression.expression.name.text === "bind") {
        const target = resolve(expression.expression.expression);
        return target ? { ...target, derived: "bind" } : null;
      }
      if (callable?.returns) return callable.returns;
    }
    return null;
  };
  const mergeOrigins = (origins, unresolvedApi) => {
    const resolved = origins.filter(Boolean);
    if (resolved.length === 0) return null;
    if (resolved.length === origins.length && resolved.every(origin => JSON.stringify(origin) === JSON.stringify(resolved[0]))) return resolved[0];
    const governed = resolved.find(governedOrigin);
    return governed ? { ...governed, unresolved: true, unresolvedApi, derived: unresolvedApi } : null;
  };
  const returnOrigin = callable => {
    const body = callable.declaration.body;
    if (!body) return null;
    if (!ts.isBlock(body)) return resolve(body);
    const expressions = [];
    const visitReturns = node => {
      if (node !== body && ts.isFunctionLike(node)) return;
      if (ts.isReturnStatement(node)) {
        expressions.push(node.expression ?? null);
        return;
      }
      ts.forEachChild(node, visitReturns);
    };
    visitReturns(body);
    return mergeOrigins(expressions.map(expression => resolve(expression)), "conditional-return");
  };
  const bindParameterPattern = (name, argument) => {
    if (ts.isIdentifier(name)) return bindParameter(name, resolve(argument));
    if (ts.isObjectBindingPattern(name)) {
      let changed = false;
      for (const element of name.elements) {
        if (!ts.isBindingElement(element)) continue;
        const member = propertyName(element.propertyName) ?? (ts.isIdentifier(element.name) ? element.name.text : null);
        if (!member) continue;
        const property = objectProperty(argument, member, sourceFile);
        const value = property ? propertyValue(property) : element.initializer;
        if (value) changed = bindParameterPattern(element.name, value) || changed;
      }
      return changed;
    }
    if (ts.isArrayBindingPattern(name) && ts.isArrayLiteralExpression(argument)) {
      let changed = false;
      for (let index = 0; index < name.elements.length; index += 1) {
        const element = name.elements[index];
        if (ts.isBindingElement(element) && argument.elements[index]) changed = bindParameterPattern(element.name, argument.elements[index]) || changed;
      }
      return changed;
    }
    return false;
  };
  for (let pass = 0; pass < declarations.length + propertyDeclarations.length + 2; pass += 1) {
    let changed = false;
    for (const declaration of declarations) {
      const initializer = declaration.initializer;
      if (!initializer) continue;
      if (ts.isIdentifier(declaration.name)) {
        const resolved = resolve(initializer);
        if (resolved) changed = bindDeclaration(declaration, resolved) || changed;
        if (!resolved && ts.isCallExpression(initializer) && calledIdentifiers.has(declaration.name.text)) {
          const governedArgument = initializer.arguments.map(argument => resolve(argument)).find(governedOrigin);
          if (governedArgument) changed = bindDeclaration(declaration, { ...governedArgument, unresolved: true, derived: "unknown-wrapper" }) || changed;
        }
        if (ts.isCallExpression(initializer)) {
          const factory = resolve(initializer.expression);
          if (factory?.moduleName === "node:module" && factory.member === "createRequire") requireNames.set(declaration.name.text, "createRequire-call");
        }
      } else if (ts.isObjectBindingPattern(declaration.name)) {
        const parent = resolve(initializer);
        if (!parent) continue;
        const bindPattern = (pattern, origin) => {
          for (const element of pattern.elements) {
            if (!ts.isBindingElement(element)) continue;
            const member = propertyName(element.propertyName) ?? (ts.isIdentifier(element.name) ? element.name.text : null);
            if (!member) continue;
            const child = origin.properties?.[member]
              ?? { moduleName: origin.moduleName, member, receiver: origin.member, chain: [...(origin.chain ?? []), member], derived: origin.derived };
            if (ts.isIdentifier(element.name)) changed = bind(element.name.text, child) || changed;
            else if (ts.isObjectBindingPattern(element.name)) bindPattern(element.name, child);
          }
        };
        bindPattern(declaration.name, parent);
      } else if (ts.isArrayBindingPattern(declaration.name)) {
        const parent = resolve(initializer);
        const bindArrayPattern = (pattern, origin) => {
          for (let index = 0; index < pattern.elements.length; index += 1) {
            const bindingElement = pattern.elements[index];
            const child = origin?.elements?.[index] ?? null;
            if (!ts.isBindingElement(bindingElement) || !child) continue;
            if (ts.isIdentifier(bindingElement.name)) changed = bind(bindingElement.name.text, child) || changed;
            else if (ts.isArrayBindingPattern(bindingElement.name)) bindArrayPattern(bindingElement.name, child);
          }
        };
        bindArrayPattern(declaration.name, parent);
      }
    }
    for (const callable of callableDeclarations) {
      const returns = returnOrigin(callable);
      if (!returns) continue;
      const prior = callable.owner ? declarationOrigins.get(callable.owner) : bindings.get(callable.name);
      const next = { ...(prior ?? { moduleName: "<authored-function>", member: callable.name, chain: [], authoredCallable: true }), returns };
      if (JSON.stringify(prior) === JSON.stringify(next)) continue;
      bindings.set(callable.name, next);
      if (callable.owner) declarationOrigins.set(callable.owner, next);
      changed = true;
    }
    for (const call of callExpressions) {
      if (!ts.isIdentifier(call.expression)) continue;
      const callable = callableDeclarations.find(candidate => candidate.name === call.expression.text);
      if (!callable) continue;
      for (let index = 0; index < callable.declaration.parameters.length; index += 1) {
        const parameter = callable.declaration.parameters[index];
        const argument = call.arguments[index] ?? parameter.initializer;
        if (argument) changed = bindParameterPattern(parameter.name, argument) || changed;
      }
    }
    for (const expression of newExpressions) {
      if (!ts.isIdentifier(expression.expression)) continue;
      const declaration = classDeclarations.find(candidate => candidate.name.text === expression.expression.text);
      const constructor = declaration?.members.find(member => ts.isConstructorDeclaration(member));
      if (!constructor) continue;
      for (let index = 0; index < constructor.parameters.length; index += 1) {
        const parameter = constructor.parameters[index];
        const argument = expression.arguments?.[index] ?? parameter.initializer;
        if (argument) changed = bindParameterPattern(parameter.name, argument) || changed;
      }
    }
    for (const declaration of propertyDeclarations) {
      const origin = resolve(declaration.initializer);
      const member = propertyName(declaration.name);
      if (!origin || !member) continue;
      const isStatic = ts.getModifiers(declaration)?.some(modifier => modifier.kind === ts.SyntaxKind.StaticKeyword) === true;
      const owner = declaration.parent?.name && ts.isIdentifier(declaration.parent.name) ? declaration.parent.name.text : "<class>";
      changed = bindProperty(isStatic ? `${owner}.${member}` : `${owner}:this.${member}`, origin) || changed;
    }
    for (const assignment of identifierAssignments) {
      const resolved = resolve(assignment.right);
      if (!resolved) continue;
      const declaration = visibleDeclaration(assignment.left);
      changed = declaration
        ? bindDeclarationAssignment(declaration, resolved) || changed
        : bindAssignment(assignment.left.text, resolved) || changed;
    }
    for (const assignment of propertyAssignments) {
      const resolved = resolve(assignment.right);
      if (!resolved) continue;
      changed = bindProperty(propertyKey(assignment.left), resolved) || changed;
    }
    for (const property of objectProperties) {
      if (!property.parent || !ts.isObjectLiteralExpression(property.parent) || !ts.isVariableDeclaration(property.parent.parent)) continue;
      const declaration = property.parent.parent;
      if (!ts.isIdentifier(declaration.name)) continue;
      const name = propertyName(property.name);
      const value = ts.isShorthandPropertyAssignment(property) ? resolve(property.name) : resolve(property.initializer);
      if (name && value) changed = bindProperty(`${declaration.name.text}.${name}`, value) || changed;
    }
    if (!changed) break;
  }
  return { bindings, requireNames, resolve, authoredCallableNames: new Set(callableDeclarations.map(candidate => candidate.name)) };
}

function objectDetails(object, sourceFile) {
  let target = object;
  const assignments = [];
  if (target && ts.isIdentifier(target)) {
    const identifier = target.text;
    let latest = null;
    const visit = node => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === identifier
        && node.initializer && node.getStart(sourceFile) < object.getStart(sourceFile)
        && (!latest || node.getStart(sourceFile) > latest.getStart(sourceFile))) latest = node;
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isPropertyAccessExpression(node.left) && ts.isIdentifier(node.left.expression)
        && node.left.expression.text === identifier && node.getStart(sourceFile) < object.getStart(sourceFile)) assignments.push(node);
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
    target = latest?.initializer ?? target;
  }
  return {
    literal: target && ts.isObjectLiteralExpression(target) ? target : null,
    assignments,
  };
}

function objectProperty(object, name, sourceFile) {
  const details = objectDetails(object, sourceFile);
  const assigned = details.assignments.filter(assignment => assignment.left.name.text === name).at(-1);
  if (assigned) return assigned;
  return details.literal?.properties.find(property => (ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property))
    && propertyName(property.name) === name) ?? null;
}

function objectHasSpread(object, sourceFile) {
  return objectDetails(object, sourceFile).literal?.properties.some(property => ts.isSpreadAssignment(property)) === true;
}

function looksLikeOptions(object, sourceFile) {
  const details = objectDetails(object, sourceFile);
  return details.literal !== null || details.assignments.length > 0;
}

function propertyValue(property) {
  if (ts.isPropertyAssignment(property)) return property.initializer;
  if (ts.isShorthandPropertyAssignment(property)) return property.name;
  if (ts.isBinaryExpression(property)) return property.right;
  return null;
}

function objectFieldPaths(object, sourceFile, seen = new Set()) {
  const identity = object && ts.isIdentifier(object) ? object.text : null;
  if (identity && seen.has(identity)) return [];
  const nextSeen = identity ? new Set([...seen, identity]) : seen;
  const details = objectDetails(object, sourceFile);
  const values = new Map();
  for (const assignment of details.assignments) values.set(assignment.left.name.text, assignment.right);
  for (const property of details.literal?.properties ?? []) {
    if (ts.isSpreadAssignment(property)) values.set("<unresolved-spread>", null);
    else {
      const name = propertyName(property.name);
      if (name) values.set(name, propertyValue(property));
    }
  }
  const paths = [];
  for (const [name, value] of [...values].sort(([left], [right]) => left.localeCompare(right, "en"))) {
    if (!value || name === "<unresolved-spread>") {
      paths.push(name);
      continue;
    }
    const nested = objectFieldPaths(value, sourceFile, nextSeen);
    if (nested.length > 0) paths.push(...nested.map(entry => `${name}.${entry}`));
    else paths.push(name);
  }
  return paths;
}

export function sec02ExecutionClass(relative) {
  if (relative.startsWith("src/")) return relative === "src/daemon.ts" ? "source-runtime" : "product-runtime";
  if (relative.startsWith("electron/")) return "electron-runtime";
  if (relative === "scripts/after-pack.cjs") return "package-hook";
  if (relative.startsWith("scripts/")) return "build-governance";
  if (relative.startsWith("parity/scripts/")) return "parity-governance";
  if (relative.startsWith("tests/")) return "test-only";
  if (relative.startsWith("public/vendor/")) return "renderer-vendored";
  return "configuration-only";
}

function packageExpectation(relative) {
  if (relative.startsWith("src/")) return "compiled-to-asar";
  if (relative.startsWith("electron/")) return "included-in-asar";
  if (relative === "scripts/after-pack.cjs") return "builder-hook-only";
  if (relative.startsWith("public/vendor/")) return "included-in-asar";
  return "excluded-from-asar";
}

export function scanSec02Source(relative, bytes, externalBindings = new Map()) {
  const sourceFile = ts.createSourceFile(relative, bytes, ts.ScriptTarget.Latest, true,
    relative.endsWith(".ts") || relative.endsWith(".tsx") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  assert.equal(sourceFile.parseDiagnostics.length, 0, `sink source has parse diagnostics: ${relative}`);
  const { requireNames, resolve, authoredCallableNames } = collectBindings(sourceFile, externalBindings);
  const candidates = [];
  const add = (node, family, api, pathOperands = []) => {
    const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    candidates.push({
      sourcePath: relative,
      fileSha256: sha256(bytes),
      line: position.line + 1,
      column: position.character + 1,
      nodeKind: ts.SyntaxKind[node.kind],
      container: enclosingContainer(node, sourceFile),
      family,
      api,
      pathOperands,
      normalizedNodeSha256: sha256(normalizeNodeText(node, sourceFile)),
      executionClass: sec02ExecutionClass(relative),
      packageExpectation: packageExpectation(relative),
    });
  };
  const visit = node => {
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        add(node, "module-loader", "import", ["argument:0"]);
      } else {
        const resolved = resolve(node.expression);
        const nestedWrapperOrigin = ts.isCallExpression(node.expression)
          ? node.expression.arguments.map(argument => resolve(argument)).find(origin => origin && (fsModules.has(origin.moduleName)
            || childProcessModules.has(origin.moduleName) || workerModules.has(origin.moduleName) || origin.moduleName === "electron"))
          : null;
        if (nestedWrapperOrigin) {
          add(node, "unresolved-governed-call", "unknown-wrapper-result", ["callee"]);
        } else if (resolved?.moduleName === "node:module" && resolved.member === "createRequire") {
          add(node, "module-loader", "createRequire", ["argument:0"]);
        } else if (resolved?.loader) {
          add(node, "module-loader", resolved.loaderApi, ["argument:0"]);
        } else if (resolved?.unresolved && (fsModules.has(resolved.moduleName) || childProcessModules.has(resolved.moduleName)
          || workerModules.has(resolved.moduleName) || resolved.moduleName === "electron")) {
          add(node, "unresolved-governed-call", resolved.unresolvedApi ?? "computed-alias", ["callee-member"]);
        } else if (resolved && fsModules.has(resolved.moduleName) && fsPathMethods.has(resolved.member)) {
          add(node, "node-fs", resolved.member, multiPathFsOperands[resolved.member] ?? ["argument:0"]);
        } else if (resolved && fsModules.has(resolved.moduleName) && resolved.member === "native" && resolved.receiver === "realpath") {
          add(node, "node-fs", "realpath.native", ["argument:0"]);
        } else if (resolved && fsModules.has(resolved.moduleName) && resolved.member === "native" && resolved.receiver === "realpathSync") {
          add(node, "node-fs", "realpathSync", ["argument:0"]);
        } else if (resolved && childProcessModules.has(resolved.moduleName) && processMethods.has(resolved.member)) {
          let hasArgv = resolved.member === "fork" || resolved.member.startsWith("execFile") || resolved.member.startsWith("spawn");
          let optionsIndex = hasArgv ? 2 : 1;
          let ambiguousOverload = false;
          const second = node.arguments[1];
          if (hasArgv && looksLikeOptions(second, sourceFile)) {
            hasArgv = false;
            optionsIndex = 1;
          } else if (hasArgv && node.arguments.length === 2 && second && !ts.isArrayLiteralExpression(second)) {
            const secondOrigin = resolve(second);
            const knownCallback = ts.isArrowFunction(second) || ts.isFunctionExpression(second) || secondOrigin?.authoredCallable === true;
            if (knownCallback && resolved.member.startsWith("execFile")) {
              hasArgv = false;
              optionsIndex = -1;
            } else ambiguousOverload = true;
          }
          if (ambiguousOverload) {
            add(node, "unresolved-governed-call", "process-overload", ["argument:1"]);
          } else {
            const operands = ["argument:0"];
            if (hasArgv) operands.push("argument:1");
            if (optionsIndex >= 0 && objectProperty(node.arguments[optionsIndex], "cwd", sourceFile)) operands.push(`argument:${optionsIndex}.cwd`);
            if (optionsIndex >= 0 && objectProperty(node.arguments[optionsIndex], "shell", sourceFile)) operands.push(`argument:${optionsIndex}.shell`);
            if (optionsIndex >= 0 && objectHasSpread(node.arguments[optionsIndex], sourceFile)) operands.push(`argument:${optionsIndex}.unresolved-spread`);
            add(node, "child-process", resolved.member, operands);
          }
        } else if (resolved?.moduleName === "express" && resolved.member === "static") {
          add(node, "express-path-api", "static", ["argument:0"]);
        } else if (resolved?.moduleName === "electron" && electronPathMethods.has(resolved.member)) {
          add(node, "electron-path-api", resolved.member, electronPathOperands[resolved.member]);
        } else if (resolved?.moduleName === "electron" && electronDialogMethods.has(resolved.member)) {
          const operands = node.arguments.flatMap((argument, index) => objectProperty(argument, "defaultPath", sourceFile)
            ? [`argument:${index}.defaultPath`] : []);
          if (operands.length > 0) add(node, "electron-path-api", resolved.member, operands);
        } else if (["xlsx", "sheetjs"].includes(resolved?.moduleName) && xlsxPathMethods.has(resolved.member)) {
          add(node, "third-party-path-api", `xlsx.${resolved.member}`, xlsxPathOperands[resolved.member]);
        } else if (resolved?.moduleName === "mammoth" && mammothPathMethods.has(resolved.member)
          && objectProperty(node.arguments[0], "path", sourceFile)) {
          add(node, "third-party-path-api", `mammoth.${resolved.member}`, ["argument:0.path"]);
        } else if (ts.isElementAccessExpression(node.expression)) {
          const computedName = ts.isStringLiteralLike(node.expression.argumentExpression) ? node.expression.argumentExpression.text : null;
          const base = resolve(node.expression.expression);
          if (["sendFile", "download", "attachment"].includes(computedName) && base?.moduleName === "express") {
            const operands = ["argument:0", ...node.arguments.flatMap((argument, index) => index > 0 && objectProperty(argument, "root", sourceFile)
              ? [`argument:${index}.root`] : [])];
            add(node, "express-path-api", computedName, operands);
          } else if (base && (fsModules.has(base.moduleName) || childProcessModules.has(base.moduleName) || base.moduleName === "electron")) {
            add(node, "unresolved-governed-call", "computed-member", ["callee-member"]);
          }
        } else if (resolved?.moduleName === "express" && ["sendFile", "download", "attachment"].includes(resolved.member)) {
          const operands = ["argument:0", ...node.arguments.flatMap((argument, index) => index > 0 && objectProperty(argument, "root", sourceFile)
            ? [`argument:${index}.root`] : [])];
          add(node, "express-path-api", resolved.member, operands);
        } else if (ts.isIdentifier(node.expression) && requireNames.has(node.expression.text)) {
          add(node, "module-loader", requireNames.get(node.expression.text), ["argument:0"]);
        } else {
          const governedCallbacks = node.arguments
            .map((argument, index) => ({ index, origin: resolve(argument) }))
            .filter(candidate => isGovernedCallableOrigin(candidate.origin));
          const authoredCall = ts.isIdentifier(node.expression) && authoredCallableNames.has(node.expression.text);
          const knownWrapper = resolved?.moduleName === "node:util" && resolved.member === "promisify";
          if (governedCallbacks.length > 0 && !authoredCall && !knownWrapper) {
            add(node, "unresolved-governed-call", "governed-callback", governedCallbacks.map(candidate => `argument:${candidate.index}`));
          }
        }
      }
    }
    if (ts.isNewExpression(node)) {
      const resolved = resolve(node.expression);
      if (resolved && workerModules.has(resolved.moduleName) && resolved.member === "Worker") {
        const operands = ["argument:0"];
        const workerDataProperty = objectProperty(node.arguments?.[1], "workerData", sourceFile);
        if (workerDataProperty) {
          const fields = objectFieldPaths(propertyValue(workerDataProperty), sourceFile);
          if (fields.length === 0) operands.push("argument:1.workerData.<unresolved>");
          else operands.push(...fields.map(field => `argument:1.workerData.${field}`));
        }
        if (objectHasSpread(node.arguments?.[1], sourceFile)) operands.push("argument:1.<unresolved-spread>");
        add(node, "worker", "Worker", operands);
      } else if (resolved?.moduleName === "better-sqlite3") {
        add(node, "third-party-path-api", "better-sqlite3.Database", ["argument:0"]);
      } else if (resolved?.moduleName === "electron" && resolved.member === "BrowserWindow") {
        const operands = [];
        if (objectProperty(node.arguments?.[0], "icon", sourceFile)) operands.push("argument:0.icon");
        const webPreferences = objectProperty(node.arguments?.[0], "webPreferences", sourceFile);
        if (webPreferences && objectProperty(propertyValue(webPreferences), "preload", sourceFile)) operands.push("argument:0.webPreferences.preload");
        if (objectHasSpread(node.arguments?.[0], sourceFile)) operands.push("argument:0.<unresolved-spread>");
        if (operands.length > 0) add(node, "electron-path-property", "BrowserWindow", operands);
      } else if (resolved?.moduleName === "electron" && resolved.member === "Tray") {
        add(node, "electron-path-property", "Tray", ["argument:0"]);
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isPropertyAccessExpression(node.left)
      && ["localModelPath", "cacheDir"].includes(node.left.name.text)) {
      add(node, "third-party-path-property", node.left.name.text, ["right-hand-side"]);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  const occurrences = new Map();
  return candidates.map(candidate => {
    const fingerprint = `${candidate.sourcePath}\0${candidate.nodeKind}\0${candidate.family}\0${candidate.api}\0${candidate.normalizedNodeSha256}`;
    const occurrence = (occurrences.get(fingerprint) ?? 0) + 1;
    occurrences.set(fingerprint, occurrence);
    return Object.freeze({
      id: `sink-${sha256(`${fingerprint}\0${occurrence}`).slice(0, 24)}`,
      occurrence,
      ...candidate,
    });
  });
}

function localModuleTarget(from, specifier, sources) {
  if (!specifier.startsWith(".")) return null;
  const joined = toPosix(path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier)));
  const stem = joined.replace(/\.(?:js|jsx|mjs|cjs)$/u, "");
  const candidates = [joined, stem, ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map(extension => `${stem}${extension}`),
    ...[".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"].map(extension => `${stem}/index${extension}`)];
  return candidates.find(candidate => sources.has(candidate)) ?? null;
}

function directModuleOrigin(moduleName, member) {
  return Object.freeze({ moduleName, member, chain: member === "default" ? [] : [member] });
}

function importedBindings(relative, sourceFile, sources, exportsByFile) {
  const seeds = new Map();
  const bindFromTarget = (localName, target, exportedName) => {
    const exports = exportsByFile.get(target) ?? new Map();
    const origin = exports.get(exportedName);
    if (origin) seeds.set(localName, origin);
    else if (exportedName === "default" && exports.size > 0) {
      seeds.set(localName, { moduleName: "<authored-namespace>", member: "*", chain: [], exports: Object.fromEntries(exports) });
    }
  };
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
    const specifier = moduleSpecifierText(statement.moduleSpecifier);
    const target = specifier ? localModuleTarget(relative, specifier, sources) : null;
    if (!target) continue;
    const clause = statement.importClause;
    if (clause.name) bindFromTarget(clause.name.text, target, "default");
    if (clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)) {
      const exports = Object.fromEntries(exportsByFile.get(target) ?? []);
      if (Object.keys(exports).length > 0) seeds.set(clause.namedBindings.name.text, { moduleName: "<authored-namespace>", member: "*", chain: [], exports });
    }
    if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
      for (const element of clause.namedBindings.elements) bindFromTarget(element.name.text, target, element.propertyName?.text ?? element.name.text);
    }
  }
  const visit = node => {
    if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)
      && ts.isIdentifier(node.initializer.expression) && node.initializer.expression.text === "require"
      && node.initializer.arguments.length === 1 && ts.isStringLiteralLike(node.initializer.arguments[0])) {
      const target = localModuleTarget(relative, node.initializer.arguments[0].text, sources);
      if (target && ts.isObjectBindingPattern(node.name)) {
        for (const element of node.name.elements) {
          if (ts.isBindingElement(element) && ts.isIdentifier(element.name)) {
            bindFromTarget(element.name.text, target, propertyName(element.propertyName) ?? element.name.text);
          }
        }
      } else if (target && ts.isIdentifier(node.name)) bindFromTarget(node.name.text, target, "default");
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return seeds;
}

function exportedBindings(relative, sourceFile, sources, exportsByFile, seeds) {
  const output = new Map();
  const { resolve } = collectBindings(sourceFile, seeds);
  const originFromModule = (specifier, member) => {
    const target = localModuleTarget(relative, specifier, sources);
    return target ? exportsByFile.get(target)?.get(member) ?? null : directModuleOrigin(specifier, member);
  };
  const resolveExportOrigin = expression => {
    const resolved = resolve(expression);
    if (resolved) return resolved;
    if (!ts.isPropertyAccessExpression(expression) || !ts.isIdentifier(expression.expression)) return null;
    const declaration = sourceFile.statements
      .filter(ts.isVariableStatement)
      .flatMap(statement => [...statement.declarationList.declarations])
      .find(candidate => ts.isIdentifier(candidate.name) && candidate.name.text === expression.expression.text);
    if (!declaration?.initializer || !ts.isCallExpression(declaration.initializer)
      || !ts.isIdentifier(declaration.initializer.expression) || declaration.initializer.expression.text !== "require"
      || declaration.initializer.arguments.length !== 1 || !ts.isStringLiteralLike(declaration.initializer.arguments[0])) return null;
    return directModuleOrigin(declaration.initializer.arguments[0].text, expression.name.text);
  };
  for (const statement of sourceFile.statements) {
    if (ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier ? moduleSpecifierText(statement.moduleSpecifier) : null;
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const importedName = element.propertyName?.text ?? element.name.text;
          const origin = specifier ? originFromModule(specifier, importedName) : resolve(element.propertyName ?? element.name);
          if (origin) output.set(element.name.text, origin);
        }
      } else if (specifier) {
        const target = localModuleTarget(relative, specifier, sources);
        for (const [name, origin] of exportsByFile.get(target) ?? []) output.set(name, origin);
      }
    }
    if (ts.isVariableStatement(statement) && ts.getModifiers(statement)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          const origin = resolve(declaration.initializer);
          if (origin) output.set(declaration.name.text, origin);
        }
      }
    }
    if (ts.isExportAssignment(statement) && !statement.isExportEquals) {
      const origin = resolve(statement.expression);
      if (origin) output.set("default", origin);
    }
    if (ts.isExpressionStatement(statement) && ts.isBinaryExpression(statement.expression)
      && statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const { left, right } = statement.expression;
      const directExport = ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression) && left.expression.text === "exports"
        ? left.name.text
        : ts.isPropertyAccessExpression(left) && ts.isPropertyAccessExpression(left.expression)
          && ts.isIdentifier(left.expression.expression) && left.expression.expression.text === "module" && left.expression.name.text === "exports"
          ? left.name.text
          : null;
      if (directExport) {
        const origin = resolveExportOrigin(right);
        if (origin) output.set(directExport, origin);
      } else if (ts.isPropertyAccessExpression(left) && ts.isIdentifier(left.expression)
        && left.expression.text === "module" && left.name.text === "exports") {
        if (ts.isCallExpression(right) && ts.isIdentifier(right.expression) && right.expression.text === "require"
          && right.arguments.length === 1 && ts.isStringLiteralLike(right.arguments[0])) {
          const target = localModuleTarget(relative, right.arguments[0].text, sources);
          for (const [name, origin] of exportsByFile.get(target) ?? []) output.set(name, origin);
        } else {
          const origin = resolve(right);
          if (origin?.properties) for (const [name, value] of Object.entries(origin.properties)) output.set(name, value);
          else if (origin?.exports) for (const [name, value] of Object.entries(origin.exports)) output.set(name, value);
          else if (origin) output.set("default", origin);
        }
      }
    }
  }
  return output;
}

function sameOriginMaps(left, right) {
  if (left.size !== right.size) return false;
  for (const [key, value] of left) if (JSON.stringify(value) !== JSON.stringify(right.get(key))) return false;
  return true;
}

export function scanSec02SourceSet(sourceInput) {
  const sources = sourceInput instanceof Map ? sourceInput : new Map(Object.entries(sourceInput));
  const parsed = new Map([...sources].map(([relative, bytes]) => [relative, ts.createSourceFile(relative, bytes, ts.ScriptTarget.Latest, true,
    relative.endsWith(".ts") || relative.endsWith(".tsx") ? ts.ScriptKind.TS : ts.ScriptKind.JS)]));
  const exportsByFile = new Map([...sources.keys()].map(relative => [relative, new Map()]));
  for (let pass = 0; pass < sources.size + 2; pass += 1) {
    let changed = false;
    for (const [relative, sourceFile] of parsed) {
      const seeds = importedBindings(relative, sourceFile, sources, exportsByFile);
      const next = exportedBindings(relative, sourceFile, sources, exportsByFile, seeds);
      if (!sameOriginMaps(exportsByFile.get(relative), next)) {
        exportsByFile.set(relative, next);
        changed = true;
      }
    }
    if (!changed) break;
    assert.notEqual(pass, sources.size + 1, "sink module origin graph did not converge");
  }
  const sites = [];
  for (const [relative, bytes] of sources) {
    const seeds = importedBindings(relative, parsed.get(relative), sources, exportsByFile);
    sites.push(...scanSec02Source(relative, bytes, seeds));
  }
  sites.sort((left, right) => left.sourcePath.localeCompare(right.sourcePath, "en") || left.line - right.line || left.column - right.column);
  assert.equal(new Set(sites.map(site => site.id)).size, sites.length, "sink scanner produced duplicate IDs");
  return Object.freeze(sites);
}

export async function collectSec02RuntimeSources(projectRoot) {
  const executableExtension = new Set([".ts", ".tsx", ".js", ".mjs", ".cjs"]);
  const sources = new Map();
  for (const absolute of await collectSourceFiles(projectRoot)) {
    const relative = toPosix(path.relative(projectRoot, absolute));
    if (!(relative.startsWith("src/") || relative.startsWith("electron/"))) continue;
    if (!executableExtension.has(path.extname(relative).toLowerCase())) continue;
    sources.set(relative, await readFile(absolute, "utf8"));
  }
  return sources;
}

export async function scanSec02Sinks(projectRoot) {
  return scanSec02SourceSet(await collectSec02RuntimeSources(projectRoot));
}
