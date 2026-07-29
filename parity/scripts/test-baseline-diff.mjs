import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { compareManifests, deriveContracts, parseMarkdown, validateManifest } from "./baseline-lib.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const COMPARE_SCRIPT = path.join(SCRIPT_DIR, "compare-lux-baselines.mjs");

function tool(name, extra = {}) {
  return {
    name,
    description: `${name} description`,
    parameters: {
      type: "object",
      properties: { value: { type: "string", default: "original" } },
      required: [],
    },
    sourceKind: "runtime-model-request",
    ...extra,
  };
}

function manifest() {
  return {
    $schema: "../schema/lux-desktop-baseline.schema.json",
    schemaVersion: 1,
    target: { product: "Lux Desktop", version: "0.1.898" },
    runtime: {
      nodeVersion: "25.0.0",
      electronVersion: "35.7.5",
      prebuildsHash: "a".repeat(64),
      shellHash: "b".repeat(64),
      probeVersion: "0.1.898",
    },
    sources: [{ path: "baseline.json", kind: "metadata", required: true, present: true, size: 1, sha256: "c".repeat(64) }],
    contracts: {
      tools: [tool("read"), tool("write")],
      toolCatalog: {
        scope: "isolated-default-session-model-request",
        definitionSource: "local-openai-compatible-provider-request",
        baseRegistryDefinitionSource: "runtime-mod-api",
        baseMembershipSource: "server-websocket-tool_definitions_updated",
        personaName: "default",
        toolCount: 2,
        baseRegistryToolCount: 2,
        baseRegistryNames: ["read", "write"],
        dynamicExtensionsExcluded: [],
      },
      toolDocumentation: {},
      personas: {},
      skills: [],
      settings: {},
      sessions: {},
      shortcuts: [],
      slashCommands: [],
      platforms: {},
      help: {},
    },
    capture: { capturedAt: "2026-07-15T00:00:00.000Z", hostPlatform: "win32", hostArch: "x64" },
  };
}

function clone(value) {
  return structuredClone(value);
}

function expectDifference(name, mutate, kind, pathFragment) {
  const expected = manifest();
  const actual = clone(expected);
  mutate(actual);
  const result = compareManifests(expected, actual);
  assert.equal(result.equal, false, `${name}: comparison should detect drift`);
  assert(result.differences.some((item) => item.kind === kind && item.path.includes(pathFragment)), `${name}: expected ${kind} at ${pathFragment}\n${JSON.stringify(result, null, 2)}`);
  return { name, result };
}

async function main() {
  const started = Date.now();
  const results = [];

  const timestampOnly = clone(manifest());
  timestampOnly.capture.capturedAt = "2030-01-01T00:00:00.000Z";
  assert.equal(compareManifests(manifest(), timestampOnly).equal, true, "capture metadata must be ignored");
  results.push({ name: "capture metadata ignored", passed: true });

  results.push(expectDifference("removed tool", (value) => { value.contracts.tools = value.contracts.tools.filter((entry) => entry.name !== "read"); }, "removed", "/contracts/tools/by-name/read"));
  results.push(expectDifference("added tool", (value) => { value.contracts.tools.push(tool("grep")); }, "added", "/contracts/tools/by-name/grep"));
  results.push(expectDifference("required parameter changed", (value) => { value.contracts.tools[0].parameters.required.push("value"); }, "changed", "/parameters/required"));
  results.push(expectDifference("default changed", (value) => { value.contracts.tools[0].parameters.properties.value.default = "changed"; }, "changed", "/parameters/properties/value/default"));

  const duplicate = manifest();
  duplicate.contracts.tools.push(tool("read"));
  assert(validateManifest(duplicate).some((message) => message.includes("duplicate tool name")), "duplicate tool name must fail validation");
  results.push({ name: "duplicate tool rejected", passed: true });

  const empty = manifest();
  empty.contracts.tools = [];
  assert(validateManifest(empty).some((message) => message.includes("/contracts/tools")), "zero tools must fail Schema validation");
  results.push({ name: "zero tool catalog rejected", passed: true });

  const helpDocuments = [
    parseMarkdown("help/tools.md", "# Tools\n## Group\n| 工具 | 说明 |\n|---|---|\n| `task_create/update/list/get/delete` | supports `inherit_canvas` |\n| `browser_back/forward` | uses `tail=N` |"),
    parseMarkdown("help/personas-skills.md", "# Personas\n## 内建人格\n| 名称 | 说明 |\n|---|---|\n| default | all |\n## 权限等级\n| 等级 | 说明 |\n|---|---|\n| 1 | safe |"),
    parseMarkdown("help/config.md", "# Config\n## Settings 面板\n## Provider 类型\n## 关键配置项\n## 重要路径"),
    parseMarkdown("help/sessions.md", "# Sessions"),
    parseMarkdown("help/keyboard-shortcuts.md", "# Keys"),
    parseMarkdown("help/slash-commands.md", "# Slash"),
    parseMarkdown("help/platforms.md", "# Platforms"),
  ];
  const documented = deriveContracts(helpDocuments, [], []).toolDocumentation;
  assert.deepEqual(documented.candidateNames, ["browser_back", "browser_forward", "task_create", "task_delete", "task_get", "task_list", "task_update"]);
  assert(!documented.candidateNames.includes("inherit_canvas"), "description identifiers must not be classified as tool names");
  results.push({ name: "documented shorthand expansion", passed: true });

  const directory = await mkdtemp(path.join(tmpdir(), "mini-lux-parity-"));
  try {
    const left = path.join(directory, "left.json");
    const right = path.join(directory, "right.json");
    await writeFile(left, JSON.stringify(manifest()));
    await writeFile(right, JSON.stringify(timestampOnly));
    const equalRun = spawnSync(process.execPath, [COMPARE_SCRIPT, left, right], { encoding: "utf8" });
    assert.equal(equalRun.status, 0, `equal CLI exit code: ${equalRun.stderr}`);

    const changed = manifest();
    changed.contracts.tools[0].parameters.required.push("value");
    await writeFile(right, JSON.stringify(changed));
    const driftRun = spawnSync(process.execPath, [COMPARE_SCRIPT, left, right], { encoding: "utf8" });
    assert.equal(driftRun.status, 1, `drift CLI exit code: ${driftRun.stderr}`);
    assert.match(driftRun.stdout, /parameters\/required/);

    await writeFile(right, JSON.stringify({ invalid: true }));
    const invalidRun = spawnSync(process.execPath, [COMPARE_SCRIPT, left, right], { encoding: "utf8" });
    assert.equal(invalidRun.status, 2, `invalid CLI exit code: ${invalidRun.stderr}`);
    results.push({ name: "CLI exit codes 0/1/2", passed: true });

    const invalidSchemaCases = [
      ["unknown capture field rejected", (value) => { value.capture.unexpected = true; }],
      ["invalid source hash rejected", (value) => { value.sources[0].sha256 = "not-a-hash"; }],
      ["missing runtime field rejected", (value) => { delete value.runtime.nodeVersion; }],
      ["unknown top-level field rejected", (value) => { value.unexpected = true; }],
    ];
    for (const [name, mutate] of invalidSchemaCases) {
      const invalidSchema = manifest();
      mutate(invalidSchema);
      await writeFile(right, JSON.stringify(invalidSchema));
      const schemaRun = spawnSync(process.execPath, [COMPARE_SCRIPT, left, right], { encoding: "utf8" });
      assert.equal(schemaRun.status, 2, `${name}: expected exit 2\n${schemaRun.stdout}\n${schemaRun.stderr}`);
      results.push({ name, passed: true });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }

  console.log(JSON.stringify({ passed: results.length, failed: 0, durationMs: Date.now() - started, scenarios: results.map((item) => item.name) }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
