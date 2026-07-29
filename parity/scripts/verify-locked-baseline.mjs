import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { canonicalize, readJson, toPosix, validateManifest } from "./baseline-lib.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PARITY_DIR = path.resolve(SCRIPT_DIR, "..");
const REPO_ROOT = path.resolve(PARITY_DIR, "..");
const COMPARE_SCRIPT = path.join(SCRIPT_DIR, "compare-lux-baselines.mjs");
const DEFAULT_BASELINE = path.join(PARITY_DIR, "baselines", "lux-desktop-0.1.898.json");
const DEFAULT_REPORT = path.join(PARITY_DIR, "reports", "gov-01-verification.json");

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fileHash(filePath) {
  return sha256(await readFile(filePath));
}

function clone(value) {
  return structuredClone(value);
}

function parseArgs(argv) {
  const result = { baseline: DEFAULT_BASELINE, report: DEFAULT_REPORT };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--baseline") result.baseline = path.resolve(argv[++index] ?? "");
    else if (argv[index] === "--report") result.report = path.resolve(argv[++index] ?? "");
    else if (argv[index] === "--help" || argv[index] === "-h") {
      console.log("Usage: node verify-locked-baseline.mjs [--baseline <path>] [--report <path>]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${argv[index]}`);
  }
  return result;
}

function runComparator(expectedPath, actualPath) {
  const result = spawnSync(process.execPath, [COMPARE_SCRIPT, expectedPath, actualPath], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  let payload = null;
  for (const candidate of [result.stdout, result.stderr]) {
    if (!candidate?.trim()) continue;
    try { payload = JSON.parse(candidate); break; } catch {}
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, payload };
}

async function main() {
  const started = Date.now();
  const args = parseArgs(process.argv.slice(2));
  const baseline = await readJson(args.baseline);
  const validationErrors = validateManifest(baseline);
  assert.deepEqual(validationErrors, [], `Locked baseline is invalid:\n${validationErrors.join("\n")}`);

  const tempDirectory = await mkdtemp(path.join(tmpdir(), "mini-lux-locked-baseline-"));
  const scenarios = [];
  try {
    async function scenario(name, mutate, expectedStatus, expectation) {
      const actual = clone(baseline);
      mutate(actual);
      const actualPath = path.join(tempDirectory, `${name}.json`);
      await writeFile(actualPath, JSON.stringify(actual, null, 2) + "\n", "utf8");
      const result = runComparator(args.baseline, actualPath);
      assert.equal(result.status, expectedStatus, `${name}: expected exit ${expectedStatus}, got ${result.status}\n${result.stdout}\n${result.stderr}`);
      if (expectation) {
        assert(result.payload?.differences?.some((difference) =>
          difference.kind === expectation.kind && difference.path === expectation.path
        ), `${name}: missing ${expectation.kind} at ${expectation.path}\n${result.stdout}`);
      }
      scenarios.push({
        name,
        expectedExitCode: expectedStatus,
        actualExitCode: result.status,
        expectedDifference: expectation ?? null,
        summary: result.payload?.summary ?? null,
        passed: true,
      });
    }

    await scenario("capture-metadata-ignored", (actual) => {
      actual.capture.capturedAt = "2030-01-01T00:00:00.000Z";
      actual.capture.hostPlatform = "verification-host";
      actual.capture.hostArch = "verification-arch";
    }, 0, null);

    await scenario("removed-tool", (actual) => {
      actual.contracts.tools = actual.contracts.tools.filter((tool) => tool.name !== "task_create");
      actual.contracts.toolCatalog.toolCount = actual.contracts.tools.length;
    }, 1, { kind: "removed", path: "/contracts/tools/by-name/task_create" });

    await scenario("changed-required-field", (actual) => {
      const read = actual.contracts.tools.find((tool) => tool.name === "read");
      assert(read, "read tool missing from locked baseline");
      read.parameters.required = [...read.parameters.required, "offset"];
    }, 1, { kind: "changed", path: "/contracts/tools/by-name/read/parameters/required" });

    await scenario("changed-documented-default", (actual) => {
      const row = actual.contracts.settings.fields.find((field) => field.id === "help/config.md:173");
      assert(row?.values?.["说明"]?.includes("默认 200"), "maxIterations documented default is missing");
      row.values["说明"] = row.values["说明"].replace("默认 200", "默认 201");
    }, 1, { kind: "changed", path: "/contracts/settings/fields/by-id/help~1config.md:173/values/说明" });

    await scenario("changed-help-source-hash", (actual) => {
      const source = actual.sources.find((entry) => entry.path === "help/tools.md");
      assert(source, "help/tools.md source missing from locked baseline");
      source.sha256 = "0".repeat(64);
    }, 1, { kind: "changed", path: "/sources/by-path/help~1tools.md/sha256" });

    await scenario("schema-rejects-unknown-capture-field", (actual) => {
      actual.capture.unexpected = true;
    }, 2, null);
    await scenario("schema-rejects-invalid-source-hash", (actual) => {
      actual.sources[0].sha256 = "not-a-hash";
    }, 2, null);
    await scenario("schema-rejects-missing-runtime-field", (actual) => {
      delete actual.runtime.nodeVersion;
    }, 2, null);
    await scenario("schema-rejects-unknown-top-level-field", (actual) => {
      actual.unexpected = true;
    }, 2, null);

    const invalid = clone(baseline);
    invalid.contracts.tools.push(clone(invalid.contracts.tools[0]));
    invalid.contracts.toolCatalog.toolCount = invalid.contracts.tools.length;
    const invalidPath = path.join(tempDirectory, "duplicate-tool.json");
    await writeFile(invalidPath, JSON.stringify(invalid, null, 2) + "\n", "utf8");
    const invalidResult = runComparator(args.baseline, invalidPath);
    assert.equal(invalidResult.status, 2, `duplicate tool must return exit 2\n${invalidResult.stdout}\n${invalidResult.stderr}`);
    assert(invalidResult.payload?.validationErrors?.actual?.some((message) => message.includes("duplicate tool name")), "duplicate validation error missing");
    scenarios.push({ name: "duplicate-tool-invalid", expectedExitCode: 2, actualExitCode: invalidResult.status, passed: true });
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }

  const baselineBytes = await readFile(args.baseline);
  const canonicalPayload = clone(baseline);
  delete canonicalPayload.capture;
  const evidenceFiles = [
    "../package.json",
    "../package-lock.json",
    "BASELINE-DESIGN.md",
    "README.md",
    "schema/lux-desktop-baseline.schema.json",
    "probes/tool-catalog-mod.mjs",
    "scripts/baseline-lib.mjs",
    "scripts/capture-lux-baseline.mjs",
    "scripts/compare-lux-baselines.mjs",
    "scripts/test-baseline-diff.mjs",
    "scripts/verify-locked-baseline.mjs",
  ];
  const evidenceHashes = {};
  for (const relative of evidenceFiles) evidenceHashes[relative] = await fileHash(path.join(PARITY_DIR, relative));

  const report = canonicalize({
    reportVersion: 1,
    task: "GOV-01",
    target: baseline.target,
    baseline: {
      path: toPosix(path.relative(REPO_ROOT, args.baseline)),
      bytes: baselineBytes.length,
      sha256: sha256(baselineBytes),
      canonicalPayloadSha256: sha256(JSON.stringify(canonicalize(canonicalPayload))),
      schemaVersion: baseline.schemaVersion,
      modelFacingToolCount: baseline.contracts.tools.length,
      baseRegistryToolCount: baseline.contracts.toolCatalog.baseRegistryToolCount,
      helpSectionCount: Object.keys(baseline.contracts.help).length,
      skillCount: baseline.contracts.skills.length,
      installedPersonaCount: baseline.contracts.personas.installed.length,
      sourceCount: baseline.sources.length,
    },
    commands: [
      "npm run parity:capture -- --lux-root <Lux v0.1.898 lux-dist> --output parity/baselines/lux-desktop-0.1.898.json",
      "npm run parity:compare -- <expected.json> <actual.json>",
      "npm run parity:test",
      "npm run parity:verify",
      "npm run build",
    ],
    scenarios,
    evidenceHashes,
    summary: {
      passed: scenarios.length,
      failed: 0,
      durationMs: Date.now() - started,
    },
    generatedAt: new Date().toISOString(),
    reviewerVerdict: "pending",
  });
  await mkdir(path.dirname(args.report), { recursive: true });
  await writeFile(args.report, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
