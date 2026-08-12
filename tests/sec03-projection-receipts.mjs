import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { recomputeSec03Evidence } from "../scripts/report-schema.mjs";
import { createSec03NativeVerifier } from "../scripts/sec03-native-verifier.mjs";
import { createSec03Recorder, validateSec03Matrix } from "./sec03-receipts.mjs";

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const HASH = /^[a-f0-9]{64}$/u;
const SOURCE_CASES = Object.freeze({
  P01: Object.freeze({ familyId: "A01", variantId: "A01-01" }),
  P02: Object.freeze({ familyId: "A01", variantId: "A01-02" }),
  P03: Object.freeze({ familyId: "A01", variantId: "A01-03" }),
  P04: Object.freeze({ familyId: "A01", variantId: "A01-04" }),
  P05: Object.freeze({ familyId: "A16", variantId: "A16-01" }),
  P06: Object.freeze({ familyId: "A02", variantId: "A02-01" }),
  P07: Object.freeze({ familyId: "A04", variantId: "A04-02" }),
  P08: Object.freeze({ familyId: "A06", variantId: "A06-02" }),
  P09: Object.freeze({ familyId: "A08", variantId: "A08-05" }),
  P10: Object.freeze({ familyId: "A09", variantId: "A09-03" }),
  P11: Object.freeze({ familyId: "A11", variantId: "A11-05", manualFamilyId: "A12", manualVariantId: "A12-05" }),
  P12: Object.freeze({ familyId: "A09", variantId: "A09-07" }),
});

function sha256(value) { return createHash("sha256").update(value).digest("hex"); }

async function trustedFile(value, label) {
  assert(value && path.isAbsolute(value) && path.resolve(value) === value, `${label} must be an exact absolute path`);
  let cursor = path.parse(value).root;
  for (const segment of value.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    assert(!(await lstat(cursor)).isSymbolicLink(), `${label} must not traverse a link`);
  }
  const info = await lstat(value);
  assert(info.isFile() && !info.isSymbolicLink(), `${label} must be a regular file`);
  assert.equal(await realpath(value), value, `${label} must be canonical`);
  return value;
}

function parseProof(nativeObservation) {
  assert(nativeObservation && Buffer.isBuffer(nativeObservation.proof));
  const fields = Object.fromEntries(nativeObservation.proof.toString("utf8").trimEnd().split("\n").map(line => {
    const separator = line.indexOf("=");
    assert(separator > 0 && separator === line.lastIndexOf("="), "projection proof line is invalid");
    return [line.slice(0, separator), line.slice(separator + 1)];
  }));
  assert.equal(fields.kind, "launcher-observation");
  return fields;
}

function envelopeFromProjection(nativeObservation, identity, layer, record) {
  const fields = parseProof(nativeObservation);
  assert.equal(fields.operation, "projection");
  assert.equal(fields.decisionState, record.variantId);
  assert.equal(fields.observedCode, record.expectedCode);
  assert.equal(fields.entryPoint, record.profileId);
  return Object.freeze({
    producer: Object.freeze({
      kind: "sandbox-host",
      hostSha256: identity.hostSha256,
      launcherSha256: identity.launcherSha256,
      instanceSha256: sha256(`${nativeObservation.keyId}\0${fields.execution}`),
    }),
    runId: fields.run,
    candidateId: fields.candidate,
    buildId: fields.buildIdSha256,
    executionNonce: fields.execution,
    layer,
    familyId: record.familyId,
    variantId: record.variantId,
    profileId: record.profileId,
    observedCode: fields.observedCode,
    observedSubcode: fields.observedSubcode === "none" ? null : fields.observedSubcode,
    transcriptSha256: fields.transcriptSha256,
    transcriptMac: null,
    launcherChannelMarker: nativeObservation.channelMarker,
    sideEffects: Object.freeze({ processStarts: Number(fields.processStarts), aclMutations: Number(fields.aclMutations), stdinWrites: Number(fields.stdinWrites) }),
    token: Object.freeze({ isAppContainer: fields.tokenIsAppContainer === "1", packageSidSha256: fields.packageSidSha256, capabilityCount: Number(fields.capabilityCount), integrity: fields.lowIntegrity === "1" ? "low" : "other" }),
    job: Object.freeze({ policySha256: fields.jobPolicySha256, activeProcessZero: fields.activeProcessZero === "1" }),
    root: Object.freeze({ identitySha256: fields.rootIdentityDigest, accessProfileSha256: fields.rootAccessProfileSha256 }),
    environment: Object.freeze({ nameSetSha256: fields.environmentNameDigest, valueSetSha256: fields.environmentValueDigest, ambientLeakCount: Number(fields.ambientLeakCount) }),
    network: Object.freeze({ mode: fields.networkMode, attemptCount: Number(fields.networkAttemptCount), acceptedCount: Number(fields.networkAcceptedCount) }),
    termination: Object.freeze({ reason: fields.completionReason, exitCode: null, treeTerminated: fields.treeTerminated === "1", activeProcessZero: fields.activeProcessZero === "1" }),
    cleanup: Object.freeze({ jobClosed: fields.jobClosed === "1", handlesDrained: fields.handlesDrained === "1", hostExited: fields.hostExited === "1", aclProfileSha256: fields.aclProfileSha256 }),
    nativeProof: Object.freeze({ kind: "launcher-observation", proofBase64: nativeObservation.proof.toString("base64"), mac: nativeObservation.mac, keyId: nativeObservation.keyId, channelMarker: nativeObservation.channelMarker }),
  });
}

function sourceFor(projectionId, profileId) {
  const source = SOURCE_CASES[projectionId];
  assert(source, `projection source is missing: ${projectionId}`);
  if (profileId === "E4" && source.manualFamilyId) {
    return { familyId: source.manualFamilyId, variantId: source.manualVariantId, profileId };
  }
  return {
    familyId: source.familyId,
    variantId: source.variantId,
    profileId: projectionId === "P08" && profileId === "E3" ? "E3A" : profileId,
  };
}

export async function emitSec03ProjectionReceipts({ layer, addonPath }) {
  assert(["electron", "packaged"].includes(layer), "projection layer is invalid");
  if (!process.env.RAINYDAYS_SEC03_RECEIPT_DIR && !process.env.RAINYDAYS_SEC03_IDENTITY_FILE && !process.env.RAINYDAYS_SEC03_SOURCE_REPORT_FILE) return Object.freeze({ enabled: false, count: 0 });
  assert(process.env.RAINYDAYS_SEC03_RECEIPT_DIR && process.env.RAINYDAYS_SEC03_IDENTITY_FILE && process.env.RAINYDAYS_SEC03_SOURCE_REPORT_FILE, "projection receipt configuration is incomplete");

  const [identityFile, sourceReportFile, trustedAddon] = await Promise.all([
    trustedFile(path.resolve(process.env.RAINYDAYS_SEC03_IDENTITY_FILE), "SEC-03 identity file"),
    trustedFile(path.resolve(process.env.RAINYDAYS_SEC03_SOURCE_REPORT_FILE), "SEC-03 source report"),
    trustedFile(path.resolve(addonPath), "SEC-03 projected addon"),
  ]);
  const [identity, report, matrixBytes, schemaBytes] = await Promise.all([
    readFile(identityFile, "utf8").then(JSON.parse),
    readFile(sourceReportFile, "utf8").then(JSON.parse),
    readFile(path.join(projectRoot, "tests", "sec03-attack-matrix.json")),
    readFile(path.join(projectRoot, "tests", "sec03-attack-matrix.schema.json")),
  ]);
  const matrix = validateSec03Matrix(JSON.parse(matrixBytes));
  const effectiveIdentity = Object.freeze({ ...identity, matrixSha256: sha256(matrixBytes), schemaSha256: sha256(schemaBytes) });
  for (const key of ["candidateId", "buildId", "sourceSha256", "hostSha256", "launcherSha256", "packageSha256"]) assert.match(effectiveIdentity[key], HASH, `SEC-03 identity ${key} is invalid`);
  assert.equal(report.taskId, "SEC-03", "projection source report task differs");
  assert.equal(report.layer, "integration", "projection source report layer differs");
  assert.equal(report.state, "passed", "projection source report did not pass");

  const nativeVerifier = await createSec03NativeVerifier(effectiveIdentity);
  const sourceEvidence = recomputeSec03Evidence(report.sec03Evidence?.receipts, {
    matrix,
    identity: effectiveIdentity,
    nativeVerifier,
    layer: "integration",
  });
  assert.deepEqual(report.sec03Evidence, sourceEvidence, "projection source evidence differs from authenticated recomputation");
  assert.equal(sourceEvidence.status, "complete", "projection source receipt set is incomplete");
  assert.equal(sourceEvidence.rawCount, 386, "projection source receipt count differs");
  assert.equal(sourceEvidence.validCount, 386, "projection source authenticated receipt count differs");
  const sourceReceipts = sourceEvidence.receipts;

  const addon = require(trustedAddon);
  assert.equal(addon.protocolVersion, 1);
  const verifier = addon.openEvidenceVerifier(effectiveIdentity.candidateId, effectiveIdentity.buildId, effectiveIdentity.sourceSha256, effectiveIdentity.hostSha256, effectiveIdentity.launcherSha256);
  assert(verifier && typeof verifier.createProjectionObservation === "function", "projection native ABI is unavailable");
  const recorder = await createSec03Recorder(import.meta.url, effectiveIdentity, nativeVerifier);
  assert.equal(recorder.enabled, true, "projection receipt recorder is disabled");
  let count = 0;
  try {
    for (const record of matrix.records.filter(value => value.layer === layer)) {
      const source = sourceFor(record.variantId, record.profileId);
      const receipt = sourceReceipts.find(value => value.layer === "real-host" && value.familyId === source.familyId && value.variantId === source.variantId && value.profileId === source.profileId);
      assert(receipt, `projection source receipt is missing: ${record.variantId}/${record.profileId}`);
      const proof = receipt.nativeProof;
      const observation = verifier.createProjectionObservation(Object.freeze({
        v: 1,
        layer,
        projectionId: record.variantId,
        familyId: record.familyId,
        sourceVariant: record.variantId <= "P04" ? null : source.variantId,
        profileId: record.profileId,
        expectedCode: record.expectedCode,
        innerEvidence: Object.freeze({ kind: proof.kind, proof: Buffer.from(proof.proofBase64, "base64"), mac: proof.mac, marker: proof.channelMarker }),
      }));
      const envelope = envelopeFromProjection(observation, effectiveIdentity, layer, record);
      await recorder.record(layer, record.familyId, record.variantId, record.profileId, envelope);
      count += 1;
    }
  } finally {
    await recorder.close();
  }
  assert.equal(count, 48);
  return Object.freeze({ enabled: true, count });
}
