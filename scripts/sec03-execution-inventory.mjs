import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import { canonicalJson, collectSec03AuthoredSources, SEC03_ARCHITECTURE_SHA256, sec03ExecutionClass } from "./sec03-execution-scanner.mjs";
import { crosscheckSec03SourceSet, loadSec03ExecutionPolicy } from "./sec03-execution-crosscheck.mjs";

export const executionInventoryPath = "tests/sec03-execution-inventory.json";
export const executionInventorySchemaPath = "tests/sec03-execution-inventory.schema.json";
function sha256(value) { return createHash("sha256").update(value).digest("hex"); }
function payloadOf(value) { const { canonicalPayloadSha256: _digest, ...payload } = value; return payload; }
function relativeFile(root, name) { return path.join(root, ...name.split("/")); }

export async function buildSec03ExecutionInventory(projectRoot) {
  const [sources, policy, scannerBytes, crosscheckBytes] = await Promise.all([
    collectSec03AuthoredSources(projectRoot),
    loadSec03ExecutionPolicy(projectRoot),
    readFile(path.join(projectRoot, "scripts", "sec03-execution-scanner.mjs")),
    readFile(path.join(projectRoot, "scripts", "sec03-execution-crosscheck.mjs")),
  ]);
  const checked = crosscheckSec03SourceSet(sources, policy);
  const files = [...sources].sort(([a], [b]) => a.localeCompare(b)).map(([sourcePath, source]) => ({ sourcePath, bytes: Buffer.byteLength(source), sha256: sha256(source), executionClass: sec03ExecutionClass(sourcePath) }));
  const sites = checked.sites.map(site => ({ ...site }));
  const payload = {
    schemaVersion: 1,
    task: "SEC-03",
    architectureSha256: SEC03_ARCHITECTURE_SHA256,
    scannerSha256: sha256(scannerBytes),
    crosscheckSha256: sha256(crosscheckBytes),
    policySha256: sha256(canonicalJson(policy)),
    sourceSetSha256: sha256(canonicalJson(files.map(({ sourcePath, bytes, sha256: digest }) => ({ sourcePath, bytes, sha256: digest })))),
    files,
    sites,
    violations: checked.violations,
    migrated: checked.migrated,
  };
  return Object.freeze({ ...payload, canonicalPayloadSha256: sha256(canonicalJson(payload)) });
}

export async function validateSec03ExecutionInventory(inventory, { projectRoot, requireMigrated = true } = {}) {
  assert(projectRoot && path.isAbsolute(projectRoot), "SEC-03 project root must be absolute");
  const schema = JSON.parse(await readFile(relativeFile(projectRoot, executionInventorySchemaPath), "utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  assert(validate(inventory), `SEC-03 inventory schema failed: ${ajv.errorsText(validate.errors)}`);
  assert.equal(inventory.canonicalPayloadSha256, sha256(canonicalJson(payloadOf(inventory))), "SEC-03 inventory payload digest differs");
  const expected = await buildSec03ExecutionInventory(projectRoot);
  assert.deepEqual(inventory, expected, "SEC-03 execution inventory drift: regenerate with node scripts/sec03-execution-inventory.mjs");
  if (requireMigrated) assert.equal(inventory.migrated, true, `SEC-03 migration incomplete:\n${inventory.violations.map(item => `${item.code} ${item.sourcePath}:${item.line} ${item.detail}`).join("\n")}`);
  return Object.freeze({ migrated: inventory.migrated, siteCount: inventory.sites.length, violationCount: inventory.violations.length, inventoryComplete: true });
}

export async function writeSec03ExecutionInventory(projectRoot) {
  const inventory = await buildSec03ExecutionInventory(projectRoot);
  await writeFile(relativeFile(projectRoot, executionInventoryPath), `${JSON.stringify(inventory, null, 2)}\n`, "utf8");
  return inventory;
}

async function main() {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  if (process.argv.slice(2).some(argument => !["--check"].includes(argument))) throw new Error("usage: node scripts/sec03-execution-inventory.mjs [--check]");
  if (process.argv.includes("--check")) {
    const inventory = JSON.parse(await readFile(relativeFile(projectRoot, executionInventoryPath), "utf8"));
    await validateSec03ExecutionInventory(inventory, { projectRoot, requireMigrated: true });
    process.stdout.write("SEC-03 execution inventory is current and fully migrated.\n");
    return;
  }
  const inventory = await writeSec03ExecutionInventory(projectRoot);
  process.stdout.write(`Wrote ${executionInventoryPath}: ${inventory.sites.length} sites, ${inventory.violations.length} migration violations.\n`);
  if (!inventory.migrated) process.stdout.write("CURRENT SOURCE DRIFT (expected until SEC-03 product migration): inventory generated, completion remains blocked.\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main().catch(error => { process.stderr.write(`${error.stack ?? error}\n`); process.exitCode = 1; });
