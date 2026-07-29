import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import { isPipelineDefinitionInput } from "../../scripts/gov04/identity.mjs";

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(?:[A-Za-z]:)/, m => m.slice(1))), "../..");
const ARCH_PATH = path.join(ROOT, "parity", "SEC-02-PATH-POLICY-ARCHITECTURE.md");
const MATRIX_PATH = path.join(ROOT, "tests", "sec02-attack-matrix.json");
const SCHEMA_PATH = path.join(ROOT, "tests", "sec02-attack-matrix.schema.json");
const GOVERNANCE_PATH = path.join(ROOT, "parity", "schema", "sec-02-governance-contract.json");
const FREEZE_REPORT_PATH = path.join(ROOT, "parity", "reports", "sec-02-architect-freeze.json");
const EXPECTED_FREEZE = Object.freeze({
  architectureSha256: "0d78af1054c316022330f51fe8f68288782de9b6ce1bacb78a094df1aa7c0ada",
  matrixSha256: "fdba733fec94a6bd7930605555e8306730ac9c7e762e6c9c9c0bbe04694a3574",
  schemaSha256: "147c54072f9ab879e3d4cbe7a69dc7433d427f7d07190e87b442d175e08f7262",
  governanceSha256: "39860fcd602a7084e075d4a3179c253e66298217dc7af10119ec31a2140141de"
});

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function assertProfileSubset(profile, actual, label) {
  assert.ok(isObject(actual), `${label}: expected object`);
  for (const [key, value] of Object.entries(profile)) {
    assert.ok(Object.hasOwn(actual, key), `${label}: missing profile key ${key}`);
    assert.equal(canonical(actual[key]), canonical(value), `${label}: profile key ${key} changed`);
  }
}

function parseArchitecture(architecture) {
  const scenarios = [...architecture.matchAll(/^\d+\. `(SEC02-P\d{2})` (.+)$/gm)]
    .map(match => ({ id: match[1], title: match[2] }));
  const positiveBlock = architecture.slice(
    architecture.indexOf("## 16. Fixed positive receipts"),
    architecture.indexOf("## 17. Resolved cumulative governance")
  );
  const positives = [...positiveBlock.matchAll(/`(SEC02-POS-[a-z0-9-]+)`/g)].map(match => match[1]);
  return { scenarios, positives };
}

export async function validateSec02Architecture(options = {}) {
  const architecturePath = options.architecturePath ?? ARCH_PATH;
  const matrixPath = options.matrixPath ?? MATRIX_PATH;
  const schemaPath = options.schemaPath ?? SCHEMA_PATH;
  const [architectureBytes, matrixBytes, schemaBytes, governanceBytes] = await Promise.all([
    fs.readFile(architecturePath),
    fs.readFile(matrixPath),
    fs.readFile(schemaPath),
    fs.readFile(GOVERNANCE_PATH)
  ]);
  assert.equal(sha256(architectureBytes), EXPECTED_FREEZE.architectureSha256, "frozen SEC-02 architecture bytes changed");
  assert.equal(sha256(matrixBytes), EXPECTED_FREEZE.matrixSha256, "frozen SEC-02 matrix bytes changed");
  assert.equal(sha256(schemaBytes), EXPECTED_FREEZE.schemaSha256, "frozen SEC-02 schema bytes changed");
  assert.equal(sha256(governanceBytes), EXPECTED_FREEZE.governanceSha256, "frozen SEC-02 governance contract changed");
  const architecture = architectureBytes.toString("utf8");
  const matrix = JSON.parse(matrixBytes.toString("utf8"));
  const schema = JSON.parse(schemaBytes.toString("utf8"));
  const governance = JSON.parse(governanceBytes.toString("utf8"));
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  const validate = ajv.compile(schema);
  assert.ok(validate(matrix), `SEC-02 matrix schema failed: ${ajv.errorsText(validate.errors, { separator: "; " })}`);
  assert.equal(matrix.state, "architecture-frozen");
  assert.match(architecture, /^Status: \*\*FROZEN — REVISION 3\*\*/m);

  assert.equal(governance.schemaVersion, 1);
  assert.equal(governance.task, "SEC-02");
  assert.equal(governance.phase, "architecture-freeze");
  for (const predecessor of governance.predecessorManifests) {
    const bytes = await fs.readFile(path.join(ROOT, ...predecessor.path.split("/")));
    assert.equal(sha256(bytes), predecessor.sha256, `${predecessor.task} predecessor manifest changed`);
  }
  assert.equal(governance.successorManifest.path, "tests/manifests/sec-02.json");
  assert.equal(governance.successorManifest.allowedAbsentDuringArchitectureFreeze, true);
  assert.equal(governance.successorManifest.requiredBeforeDeveloperCandidate, true);
  for (const relative of governance.pipelineDefinitionRequiredPaths) {
    assert.equal(isPipelineDefinitionInput(relative), true, `pipelineDefinitionDigest omits ${relative}`);
    await fs.access(path.join(ROOT, ...relative.split("/")));
  }
  assert.deepEqual(governance.gov04StateMachine, {
    stepCount: 16,
    stepAtMostOnce: true,
    firstFailureBlocksLaterSteps: true,
    finalizeExactlyOnce: true,
    cleanInstallCount: 3,
    packageCount: 1,
    workspaceCount: 2,
    oneCandidateIdentityAcrossWorkspaces: true
  });

  const parsed = parseArchitecture(architecture);
  assert.equal(parsed.scenarios.length, 36, "architecture must contain 36 scenarios");
  assert.equal(new Set(parsed.scenarios.map(item => item.id)).size, 36, "architecture scenario IDs must be unique");
  assert.equal(parsed.positives.length, 22, "architecture must contain 22 positive receipt IDs");
  assert.equal(new Set(parsed.positives).size, 22, "architecture positive IDs must be unique");
  assert.equal(canonical(matrix.positiveReceiptIds), canonical(parsed.positives), "matrix positive IDs/order differ from architecture");

  const expectedScenarioIds = Array.from({ length: 36 }, (_, index) => `SEC02-P${String(index + 1).padStart(2, "0")}`);
  assert.equal(canonical(matrix.scenarios.map(item => item.id)), canonical(expectedScenarioIds), "matrix scenario order is not P01..P36");
  assert.equal(canonical(matrix.scenarios.map(({ id, title }) => ({ id, title }))), canonical(parsed.scenarios), "matrix titles differ from architecture");

  const observations = matrix.scenarios.flatMap(scenario => scenario.observations.map(observation => ({ scenario, observation })));
  const observationIds = observations.map(({ observation }) => observation.id);
  assert.equal(observations.length, matrix.requiredObservationCount, "required observation count mismatch");
  assert.equal(new Set(observationIds).size, observationIds.length, "observation IDs must be unique");

  for (const { scenario, observation } of observations) {
    assert.ok(observation.id.startsWith(`${scenario.id}-`), `${observation.id}: scenario prefix mismatch`);
    assert.ok(Object.hasOwn(matrix.profiles, observation.expectedProfile), `${observation.id}: unknown expected profile`);
    assertProfileSubset(matrix.profiles[observation.expectedProfile], observation.expected, observation.id);
    assert.ok(Object.keys(observation.stimulus).length > 0, `${observation.id}: stimulus must not be empty`);
    assert.ok(canonical(observation.stimulus).length > 2, `${observation.id}: stimulus must be canonicalizable`);
    if (observation.id !== "SEC02-P12-short-name-alias-probe") {
      assert.equal(observation.environmentPolicy, matrix.defaultEnvironmentPolicy[observation.evidenceTier], `${observation.id}: evidence tier downgraded`);
    }
    if (observation.outcomeClass === "denial") {
      assert.equal(observation.expected.denied, true, `${observation.id}: denial not bound`);
      assert.equal(observation.expected.auditAttempts, 1, `${observation.id}: audit attempt not bound`);
      assert.equal(observation.expected.auditAllowedFieldsExact, true, `${observation.id}: audit fields not exact`);
      assert.equal(observation.expected.rawPathsAbsent, true, `${observation.id}: raw path redaction not bound`);
    }
  }

  const denialIds = observations
    .filter(({ observation }) => observation.outcomeClass === "denial")
    .map(({ observation }) => observation.id)
    .sort();
  assert.equal(canonical(matrix.denialObservationIds), canonical(denialIds), "denial observation index mismatch");
  assert.equal(matrix.scenarioCount, matrix.scenarios.length, "scenario count mismatch");
  assert.equal(matrix.positiveReceiptCount, matrix.positiveReceiptIds.length, "positive count mismatch");

  const byId = new Map(observations.map(({ observation }) => [observation.id, observation]));
  const requiredIds = [
    "SEC02-P15-lease-issued-before-retire-open-denied",
    "SEC02-P15-opened-handle-retire-drain-only",
    "SEC02-P15-session-delete-closes-leases",
    "SEC02-P20-post-create-identity-rollback",
    "SEC02-P28-new-authority-old-terminal-control-denied",
    "SEC02-P29-session-delete-close",
    "SEC02-P30-opened-range-retire-drain-only",
    "SEC02-P31-concurrent-stale-base",
    "SEC02-P34-audit-sink-throw"
  ];
  for (const id of requiredIds) assert.ok(byId.has(id), `missing mandatory Revision 3 observation ${id}`);
  assert.equal(byId.get("SEC02-P20-post-create-identity-rollback").expected.finalExternalArtifacts, undefined, "post-create race must not claim zero final artifact");
  assert.equal(byId.get("SEC02-P34-audit-sink-throw").evidenceTier, "runtime-contract", "audit sink throw must execute runtime contract");
  assert.equal(byId.get("SEC02-P36-runtime-adapter-canaries").evidenceTier, "windows-native", "runtime canary cannot be static");
  assert.equal(byId.get("SEC02-P36-packaged-asar-bound").evidenceTier, "contract-validation", "package binding must inspect package");
  assert.equal(byId.get("SEC02-P34-all-denial-receipts-audited").expected.denialObservationCount, denialIds.length, "P34 denial join count changed");
  const recoveryStates = ["fresh-old-config-new-epoch", "stopped-fail-closed"];
  for (const id of ["SEC02-P31-persist-failure", "SEC02-P31-publication-failure-rollback"]) {
    assert.deepEqual(byId.get(id).expected.allowedFinalStates, recoveryStates, `${id}: forbidden recovery state`);
    assert.equal(byId.get(id).expected.retiredAuthorityReactivated, false);
    assert.equal(byId.get(id).expected.oldTokensStale, true);
    assert.equal(byId.get(id).expected.staleCandidatePublished, false);
  }
  assert.equal(byId.get("SEC02-P12-short-name-alias-probe").environmentPolicy, "mandatory-neutral-if-not-exposed");

  const freezeReport = JSON.parse(await fs.readFile(FREEZE_REPORT_PATH, "utf8"));
  assert.equal(freezeReport.reportVersion, 1);
  assert.equal(freezeReport.task, "SEC-02");
  assert.equal(freezeReport.persona, "architect");
  assert.equal(freezeReport.state, "architecture-frozen-awaiting-independent-confirmation");
  assert.deepEqual(freezeReport.assets, {
    architecture: { path: "parity/SEC-02-PATH-POLICY-ARCHITECTURE.md", sha256: EXPECTED_FREEZE.architectureSha256 },
    matrix: { path: "tests/sec02-attack-matrix.json", sha256: EXPECTED_FREEZE.matrixSha256 },
    schema: { path: "tests/sec02-attack-matrix.schema.json", sha256: EXPECTED_FREEZE.schemaSha256 },
    governance: { path: "parity/schema/sec-02-governance-contract.json", sha256: EXPECTED_FREEZE.governanceSha256 },
    validator: { path: "parity/scripts/validate-sec02-architecture.mjs", sha256: freezeReport.assets.validator.sha256 }
  });
  assert.equal(freezeReport.assets.validator.sha256, sha256(await fs.readFile(new URL(import.meta.url))), "freeze report validator hash changed");
  assert.deepEqual(freezeReport.matrix, { schemaVersion: 2, scenarios: 36, observations: 411, denials: 380, positives: 22 });
  assert.deepEqual(freezeReport.blockingFindings, []);

  return {
    schemaVersion: matrix.schemaVersion,
    state: matrix.state,
    scenarios: matrix.scenarioCount,
    observations: matrix.requiredObservationCount,
    denials: matrix.denialObservationIds.length,
    positives: matrix.positiveReceiptCount
  };
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  try {
    const matrixArg = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
    console.log(JSON.stringify(await validateSec02Architecture({ matrixPath: matrixArg }), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
