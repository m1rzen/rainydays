import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { aggregateSec03Receipts } from "../../scripts/sec03-receipt-set.mjs";
import { canonicalSec03Json, createSec03Receipt, testOnlyNativeVerifier, validateSec03Matrix, validateSec03Receipt } from "../sec03-receipts.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const hash = value => createHash("sha256").update(value).digest("hex");
const matrixBytes = await readFile(path.join(projectRoot, "tests", "sec03-attack-matrix.json"));
const schemaBytes = await readFile(path.join(projectRoot, "tests", "sec03-attack-matrix.schema.json"));
const matrix = validateSec03Matrix(JSON.parse(matrixBytes));
const digest = seed => hash(`sec03-${seed}`);
const identity = Object.freeze({ runId: "123e4567-e89b-42d3-a456-426614174000", candidateId: digest("candidate"), buildId: digest("build"), matrixSha256: hash(matrixBytes), schemaSha256: hash(schemaBytes), sourceSha256: digest("source"), launcherSha256: digest("launcher"), hostSha256: digest("host"), packageSha256: digest("package") });
function envelope(record, overrides = {}) {
  return { producer: { kind: "sandbox-host", hostSha256: identity.hostSha256, launcherSha256: identity.launcherSha256, instanceSha256: digest("instance") }, runId: identity.runId, candidateId: identity.candidateId, buildId: identity.buildId, executionNonce: digest(`nonce-${record.layer}-${record.familyId}-${record.variantId}-${record.profileId}`), layer: record.layer, familyId: record.familyId, variantId: record.variantId, profileId: record.profileId, observedCode: record.expectedCode, observedSubcode: record.expectedSubcode, transcriptSha256: digest("transcript"), transcriptMac: digest("proof-mac"), launcherChannelMarker: digest("proof-channel"), sideEffects: { processStarts: 0, aclMutations: 0, stdinWrites: 0 }, token: { isAppContainer: true, packageSidSha256: digest("sid"), capabilityCount: 0, integrity: "low" }, job: { policySha256: digest("job"), activeProcessZero: true }, root: { identitySha256: digest("root"), accessProfileSha256: digest("access") }, environment: { nameSetSha256: digest("env-names"), valueSetSha256: digest("env-values"), ambientLeakCount: 0 }, network: { mode: "deny", attemptCount: 0, acceptedCount: 0 }, termination: { reason: "completed", exitCode: 0, treeTerminated: true, activeProcessZero: true }, cleanup: { jobClosed: true, handlesDrained: true, hostExited: true, aclProfileSha256: digest("acl") }, nativeProof: { kind: "execution-proof", proofBase64: Buffer.from("test-only-proof\n").toString("base64"), mac: digest("proof-mac"), keyId: digest("proof-key"), channelMarker: digest("proof-channel") }, ...overrides };
}
const record = matrix.records[0];
const testReceipt = () => createSec03Receipt(record, identity, envelope(record), testOnlyNativeVerifier);

test("SEC-03 482 closure contract freezes only matrix cardinality and never synthesizes native PASS evidence", () => { assert.equal(matrix.records.length, 482); assert.deepEqual(Object.fromEntries(matrix.layers.map(layer => [layer, matrix.records.filter(item => item.layer === layer).length])), { "real-host": 386, electron: 48, packaged: 48 }); });

test("SEC-03 receipt creation requires a complete authenticated evidence envelope and verifier", () => {
  assert.throws(() => createSec03Receipt(record, identity), /envelope|required/u);
  assert.throws(() => createSec03Receipt(record, identity, envelope(record)), /verifier/u);
  assert.throws(() => createSec03Receipt(record, identity, { ...envelope(record), producer: "sandbox-host" }, testOnlyNativeVerifier), /native producer/u);
  assert.throws(() => createSec03Receipt(record, identity, { ...envelope(record), observedCode: undefined }, testOnlyNativeVerifier), /observedCode/u);
});

test("SEC-03 explicit test-only verifier produces non-completable receipts", () => {
  const receipt = testReceipt(); assert.equal(receipt.testOnly, true); validateSec03Receipt(receipt, { matrix, identity, nativeVerifier: testOnlyNativeVerifier }); const result = aggregateSec03Receipts([receipt], { matrix, identity, nativeVerifier: testOnlyNativeVerifier }); assert.equal(result.complete, false); assert.equal(result.testOnlyCount, 1); assert.equal(result.mockCount, 1); assert.equal(result.validCount, 1); assert.equal(result.missingKeys.length, 481);
});

test("SEC-03 validation rejects tamper, raw evidence, missing attestation, and wrong verifier", () => {
  const receipt = testReceipt(); const tampered = { ...receipt, actualCode: "OBS_TAMPERED" }; assert.throws(() => validateSec03Receipt(tampered, { matrix, identity, nativeVerifier: testOnlyNativeVerifier }), /actual|hash/u);
  const unsafe = { ...receipt, cleanup: { ...receipt.cleanup, aclProfileSha256: "C:\\Users\\victim\\secret" } }; unsafe.receiptSha256 = hash(canonicalSec03Json(Object.fromEntries(Object.entries(unsafe).filter(([key]) => key !== "receiptSha256")))); assert.throws(() => validateSec03Receipt(unsafe, { matrix, identity, nativeVerifier: testOnlyNativeVerifier }), /invalid|raw absolute path/u);
  assert.throws(() => validateSec03Receipt(receipt, { matrix, identity }), /verifier/u);
});

test("SEC-03 parent aggregation rejects duplicate, extra, cross-run, skipped, todo, default-like, and mock evidence", () => {
  const receipt = testReceipt(); const duplicate = aggregateSec03Receipts([receipt, receipt], { matrix, identity, nativeVerifier: testOnlyNativeVerifier }); assert.equal(duplicate.complete, false); assert.equal(duplicate.duplicateKeys.length, 1);
  const crossRun = { ...receipt, runId: "123e4567-e89b-42d3-a456-426614174001" }; const cross = aggregateSec03Receipts([crossRun], { matrix, identity, nativeVerifier: testOnlyNativeVerifier }); assert.equal(cross.complete, false); assert.equal(cross.crossRunCount, 1);
  for (const field of ["skipped", "todo", "mockSubstitution"]) { const changed = { ...receipt, [field]: true }; changed.receiptSha256 = hash(canonicalSec03Json(Object.fromEntries(Object.entries(changed).filter(([key]) => key !== "receiptSha256")))); const result = aggregateSec03Receipts([changed], { matrix, identity, nativeVerifier: testOnlyNativeVerifier }); assert.equal(result.complete, false, `${field} must fail aggregation`); assert(result.invalidKeys.length > 0); }
  const extra = { ...receipt, variantId: "A01-99" }; extra.receiptSha256 = hash(canonicalSec03Json(Object.fromEntries(Object.entries(extra).filter(([key]) => key !== "receiptSha256")))); const extraResult = aggregateSec03Receipts([extra], { matrix, identity, nativeVerifier: testOnlyNativeVerifier }); assert.equal(extraResult.complete, false); assert(extraResult.invalidKeys.length + extraResult.extraKeys.length > 0);
});
