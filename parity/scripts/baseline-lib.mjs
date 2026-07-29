import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

export const SCHEMA_VERSION = 1;

const BASELINE_SCHEMA = JSON.parse(readFileSync(new URL("../schema/lux-desktop-baseline.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: true, allowUnionTypes: true });
addFormats(ajv);
const validateBaselineSchema = ajv.compile(BASELINE_SCHEMA);

export function toPosix(value) {
  return value.replaceAll("\\", "/");
}

export async function sha256File(filePath) {
  const bytes = await readFile(filePath);
  return createHash("sha256").update(bytes).digest("hex");
}

export async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

export function canonicalize(value, seen = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Non-finite number cannot be canonicalized");
    return value;
  }
  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") {
    throw new Error(`Unsupported canonical value: ${typeof value}`);
  }
  if (seen.has(value)) throw new Error("Circular object cannot be canonicalized");
  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => canonicalize(item, seen));
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key], seen)]));
  } finally {
    seen.delete(value);
  }
}

function splitTableRow(line) {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  return trimmed.split("|").map((cell) => cell.trim());
}

function isSeparator(line) {
  return /^\s*\|?\s*:?-{3,}/.test(line) && line.includes("|");
}

function cleanInline(value) {
  return value
    .replace(/\*\*/g, "")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .trim();
}

function identifiers(value) {
  return [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
}

export function parseMarkdown(relativePath, content) {
  const lines = content.split(/\r?\n/);
  const headings = [];
  const tables = [];
  const stack = [];

  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(lines[index]);
    if (heading) {
      const level = heading[1].length;
      const title = cleanInline(heading[2]);
      stack.length = level - 1;
      stack[level - 1] = title;
      headings.push({ level, line: index + 1, title });
      continue;
    }

    if (!lines[index].trim().startsWith("|") || index + 1 >= lines.length || !isSeparator(lines[index + 1])) continue;
    const headers = splitTableRow(lines[index]).map(cleanInline);
    const rows = [];
    let cursor = index + 2;
    while (cursor < lines.length && lines[cursor].trim().startsWith("|")) {
      const cells = splitTableRow(lines[cursor]);
      const values = Object.fromEntries(headers.map((header, cellIndex) => [header || `column${cellIndex + 1}`, cleanInline(cells[cellIndex] ?? "")]));
      rows.push({ line: cursor + 1, values, identifiers: identifiers(lines[cursor]) });
      cursor += 1;
    }
    tables.push({ line: index + 1, headingPath: stack.filter(Boolean), headers, rows });
    index = cursor - 1;
  }

  return { path: relativePath, headings, tables };
}

function tablesUnder(document, titleFragment) {
  return document.tables.filter((table) => table.headingPath.some((title) => title.includes(titleFragment)));
}

function rowsFrom(document, titleFragment) {
  return tablesUnder(document, titleFragment).flatMap((table) => table.rows.map((row) => ({ ...row, headingPath: table.headingPath })));
}

function normalizedRows(document, titleFragment) {
  return rowsFrom(document, titleFragment).map((row) => ({
    id: `${document.path}:${row.line}`,
    line: row.line,
    headingPath: row.headingPath,
    values: row.values,
    identifiers: row.identifiers,
    source: document.path,
  }));
}

export function deriveContracts(helpDocuments, installedSkills, installedPersonas) {
  const byName = new Map(helpDocuments.map((document) => [document.path.split("/").at(-1), document]));
  const tools = byName.get("tools.md");
  const personaSkills = byName.get("personas-skills.md");
  const config = byName.get("config.md");
  const sessions = byName.get("sessions.md");
  const shortcuts = byName.get("keyboard-shortcuts.md");
  const slash = byName.get("slash-commands.md");
  const platforms = byName.get("platforms.md");
  for (const [name, value] of [["tools.md", tools], ["personas-skills.md", personaSkills], ["config.md", config], ["sessions.md", sessions], ["keyboard-shortcuts.md", shortcuts], ["slash-commands.md", slash], ["platforms.md", platforms]]) {
    if (!value) throw new Error(`Required Help document missing: ${name}`);
  }

  const expandToolExpression = (expression) => {
    const parts = expression.split("/");
    if (parts.length === 1) return parts;
    const first = parts[0];
    const separator = first.lastIndexOf("_");
    const prefix = separator >= 0 ? first.slice(0, separator + 1) : "";
    return [first, ...parts.slice(1).map((part) => part.includes("_") ? part : `${prefix}${part}`)];
  };
  const documentedToolRows = tools.tables.flatMap((table) => table.rows
    .map((row) => {
      const toolCell = row.values["工具"] ?? Object.values(row.values)[0] ?? "";
      const expressions = identifiers(toolCell).filter((value) => /^[a-z][a-z0-9_]*(?:\/[a-z0-9_]+)*$/.test(value));
      return {
        group: table.headingPath.at(-1) ?? "",
        line: row.line,
        expressions,
        candidateNames: expressions.flatMap(expandToolExpression),
        values: row.values,
        source: tools.path,
      };
    })
    .filter((row) => row.expressions.length > 0));

  return canonicalize({
    toolDocumentation: {
      sourceKind: "documentation",
      rows: documentedToolRows,
      rawExpressions: [...new Set(documentedToolRows.flatMap((row) => row.expressions))].sort(),
      candidateNames: [...new Set(documentedToolRows.flatMap((row) => row.candidateNames))].sort(),
    },
    personas: {
      sourceKind: "documentation-and-installed-json",
      builtIn: normalizedRows(personaSkills, "内建人格"),
      permissionLevels: normalizedRows(personaSkills, "权限等级"),
      installed: installedPersonas,
    },
    skills: installedSkills,
    settings: {
      sourceKind: "documentation",
      tabs: normalizedRows(config, "Settings 面板"),
      providerTypes: normalizedRows(config, "Provider 类型"),
      fields: normalizedRows(config, "关键配置项"),
      paths: normalizedRows(config, "重要路径"),
    },
    sessions: {
      sourceKind: "documentation",
      headings: sessions.headings,
      tables: sessions.tables,
    },
    shortcuts: shortcuts.tables.flatMap((table) => table.rows.map((row) => ({
      shortcut: Object.values(row.values)[0] ?? "",
      action: Object.values(row.values)[1] ?? "",
      line: row.line,
      group: table.headingPath.at(-1) ?? "",
      source: shortcuts.path,
    }))),
    slashCommands: slash.tables.flatMap((table) => table.rows.map((row) => ({
      command: Object.values(row.values)[0] ?? "",
      parameters: Object.values(row.values)[1] ?? "",
      action: Object.values(row.values)[2] ?? "",
      line: row.line,
      group: table.headingPath.at(-1) ?? "",
      source: slash.path,
    }))),
    platforms: {
      sourceKind: "documentation",
      headings: platforms.headings,
      tables: platforms.tables,
    },
    help: Object.fromEntries(helpDocuments.map((document) => [document.path, {
      headings: document.headings,
      tableCount: document.tables.length,
    }])),
  });
}

export function validateManifest(manifest) {
  const errors = [];
  if (!validateBaselineSchema(manifest)) {
    for (const error of validateBaselineSchema.errors ?? []) {
      const location = error.instancePath || "/";
      const detail = error.keyword === "additionalProperties"
        ? ` (${error.params.additionalProperty})`
        : "";
      errors.push(`schema ${location}: ${error.message}${detail}`);
    }
  }
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return errors.length > 0 ? errors : ["manifest must be an object"];
  if (errors.length > 0) return errors;

  const contracts = manifest.contracts && typeof manifest.contracts === "object" && !Array.isArray(manifest.contracts)
    ? manifest.contracts
    : {};
  const tools = contracts.tools;
  if (Array.isArray(tools)) {
    const names = new Set();
    for (const tool of tools) {
      if (!tool || typeof tool !== "object") continue;
      if (typeof tool.name === "string" && names.has(tool.name)) errors.push(`duplicate tool name: ${tool.name}`);
      if (typeof tool.name === "string") names.add(tool.name);
    }
  }

  const catalog = contracts.toolCatalog;
  if (catalog && typeof catalog === "object" && !Array.isArray(catalog)) {
    if (catalog.toolCount !== tools?.length) errors.push("contracts.toolCatalog.toolCount must match contracts.tools length");
    if (Array.isArray(catalog.baseRegistryNames)) {
      if (catalog.baseRegistryNames.length !== catalog.baseRegistryToolCount) errors.push("contracts.toolCatalog base Registry count is invalid");
      if (new Set(catalog.baseRegistryNames).size !== catalog.baseRegistryNames.length) errors.push("contracts.toolCatalog.baseRegistryNames contains duplicates");
      const modelNames = new Set(Array.isArray(tools) ? tools.map((tool) => tool?.name) : []);
      for (const name of catalog.baseRegistryNames) if (!modelNames.has(name)) errors.push(`base Registry tool is missing from model contract: ${name}`);
    }
  }

  if (Array.isArray(manifest.sources)) {
    const sourcePaths = new Set();
    for (const source of manifest.sources) {
      if (!source || typeof source.path !== "string") continue;
      if (sourcePaths.has(source.path)) errors.push(`duplicate source path: ${source.path}`);
      sourcePaths.add(source.path);
    }
  }
  return [...new Set(errors)];
}

function identityForArrays(expected, actual) {
  const arrays = [expected, actual];
  if (!arrays.every((array) => array.every((item) => item && typeof item === "object" && !Array.isArray(item)))) return null;
  for (const key of ["name", "path", "id", "command", "shortcut"]) {
    const valid = arrays.every((array) => {
      const values = array.map((item) => item[key]);
      return values.every((value) => typeof value === "string" && value.length > 0)
        && new Set(values).size === values.length;
    });
    if (valid && (expected.length > 0 || actual.length > 0)) return key;
  }
  return null;
}

function pointerEscape(value) {
  return String(value).replaceAll("~", "~0").replaceAll("/", "~1");
}

function diffValues(expected, actual, path, differences) {
  if (Object.is(expected, actual)) return;
  if (Array.isArray(expected) && Array.isArray(actual)) {
    const identity = identityForArrays(expected, actual);
    if (identity) {
      const left = new Map(expected.map((item) => [item[identity], item]));
      const right = new Map(actual.map((item) => [item[identity], item]));
      for (const key of [...new Set([...left.keys(), ...right.keys()])].sort()) {
        const next = `${path}/by-${identity}/${pointerEscape(key)}`;
        if (!right.has(key)) differences.push({ kind: "removed", path: next, expected: left.get(key) });
        else if (!left.has(key)) differences.push({ kind: "added", path: next, actual: right.get(key) });
        else diffValues(left.get(key), right.get(key), next, differences);
      }
      return;
    }
    if (JSON.stringify(expected) !== JSON.stringify(actual)) differences.push({ kind: "changed", path, expected, actual });
    return;
  }
  if (expected && actual && typeof expected === "object" && typeof actual === "object" && !Array.isArray(expected) && !Array.isArray(actual)) {
    for (const key of [...new Set([...Object.keys(expected), ...Object.keys(actual)])].sort()) {
      const next = `${path}/${pointerEscape(key)}`;
      if (!(key in actual)) differences.push({ kind: "removed", path: next, expected: expected[key] });
      else if (!(key in expected)) differences.push({ kind: "added", path: next, actual: actual[key] });
      else diffValues(expected[key], actual[key], next, differences);
    }
    return;
  }
  differences.push({ kind: "changed", path: path || "/", expected, actual });
}

export function compareManifests(expectedInput, actualInput) {
  const expected = structuredClone(expectedInput);
  const actual = structuredClone(actualInput);
  delete expected.capture;
  delete actual.capture;
  const differences = [];
  diffValues(expected, actual, "", differences);
  return {
    equal: differences.length === 0,
    summary: {
      added: differences.filter((item) => item.kind === "added").length,
      removed: differences.filter((item) => item.kind === "removed").length,
      changed: differences.filter((item) => item.kind === "changed").length,
    },
    differences,
  };
}
