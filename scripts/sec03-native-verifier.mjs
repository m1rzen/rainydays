import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { A14_INVALID_JOURNAL, A15_EXTRA_ARTIFACT, a01Probe, a02Case, a03Case, a04Case, a06Case, a07Case, a08Case, a08JobPolicyMaterial, a09Case, a10Case, a11Case, a12Case, a13Case, a15Case, a17Probe, a19Case, e3aCase } from "../tests/fixtures/sec03-real-host-plan.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const addonPath = path.join(projectRoot, "dist", "native", "sandbox-launcher.node");
const manifestPath = path.join(projectRoot, "dist", "native", "sec03-native-manifest.json");
const require = createRequire(import.meta.url);
const shaPattern = /^[a-f0-9]{64}$/u;
const profileNames = Object.freeze({ E1: "one-shot-shell", E2: "agent-shell", E3: "script", E3A: "fixed-adversary", E4: "manual-terminal", HOST: "agent-shell" });
const a18RootFailureClasses = Object.freeze({ "A18-01": "unc", "A18-02": "mapped-remote", "A18-03": "non-ntfs", "A18-04": "removable-ntfs", "A18-05": "reparse-root" });

function parseProof(bytes) {
  assert(Buffer.isBuffer(bytes) && bytes.length >= 1 && bytes.length <= 64 * 1024, "native proof bytes are invalid");
  const text = bytes.toString("utf8");
  assert.equal(Buffer.from(text, "utf8").compare(bytes), 0, "native proof UTF-8 is invalid");
  const fields = new Map();
  for (const line of text.slice(0, -1).split("\n")) {
    const separator = line.indexOf("=");
    assert(separator > 0 && separator === line.lastIndexOf("="), "native proof line is invalid");
    const key = line.slice(0, separator); const value = line.slice(separator + 1);
    assert(value && !fields.has(key), "native proof field is invalid"); fields.set(key, value);
  }
  assert(text.endsWith("\n"), "native proof is not terminated");
  return fields;
}

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function canonicalHash(value) {
  const canonicalize = input => Array.isArray(input) ? input.map(canonicalize) : input && typeof input === "object"
    ? Object.fromEntries(Object.keys(input).sort().map(key => [key, canonicalize(input[key])])) : input;
  return hash(JSON.stringify(canonicalize(value)));
}
function nativeManifestMismatchBytes(text, manifest) {
  let result = text;
  for (const [key, value, replacement] of [["sourceDigest", manifest.sourceDigest, "0"], ["toolchainDigest", manifest.toolchainDigest, "1"]]) {
    assert.match(value, shaPattern, `native manifest ${key} is invalid`);
    const needle = `"${key}": "${value}"`;
    assert.equal(result.indexOf(needle), result.lastIndexOf(needle), `native manifest ${key} is ambiguous`);
    assert.notEqual(result.indexOf(needle), -1, `native manifest ${key} is absent`);
    result = result.replace(needle, `"${key}": "${replacement.repeat(64)}"`);
  }
  return Buffer.from(result, "utf8");
}
function nativeManifestImportMismatchBytes(text, manifest) {
  const host = manifest.outputs?.find(value => value.path === "dist/native/sandbox-host.exe");
  assert.match(host?.importedDllAllowlistDigest, shaPattern, "native host import allowlist digest is invalid");
  assert.notEqual(host.importedDllAllowlistDigest, "0".repeat(64), "native host import allowlist digest cannot be the mutation sentinel");
  const pathField = `"path": "${host.path}"`;
  const pathPosition = text.indexOf(pathField);
  const importField = `"importedDllAllowlistDigest": "${host.importedDllAllowlistDigest}"`;
  const importPosition = text.indexOf(importField, pathPosition);
  assert(pathPosition >= 0 && importPosition > pathPosition && importPosition < pathPosition + 384, "native host import allowlist field is not canonical");
  return Buffer.from(`${text.slice(0, importPosition)}"importedDllAllowlistDigest": "${"0".repeat(64)}"${text.slice(importPosition + importField.length)}`, "utf8");
}
function sequenceDigest(domain, values) {
  const chunks = [Buffer.from(domain, "utf8"), Buffer.from([0])];
  for (const value of values) {
    const bytes = Buffer.from(value, "utf8");
    const length = Buffer.alloc(4);
    length.writeUInt32LE(bytes.length);
    chunks.push(length, bytes);
  }
  return hash(Buffer.concat(chunks));
}

function validateProjectionOutcome(envelope, context, fields) {
  const record = context.record;
  assert(["electron", "packaged"].includes(record.layer), "projection layer is invalid");
  assert.match(record.variantId, /^P(?:0[1-9]|1[0-2])$/u, "projection ID is invalid");
  assert.equal(record.familyId, record.variantId, "projection family differs");
  assert.equal(fields.get("operation"), "projection");
  assert.equal(fields.get("decisionState"), record.variantId);
  assert.equal(fields.get("entryPoint"), record.profileId);
  assert.equal(fields.get("profile"), profileNames[record.profileId]);
  assert.equal(fields.get("observationClass"), "projection-observation");
  assert.equal(fields.get("raceStage"), record.layer === "electron" ? "electron-stage" : "packaged-installed");
  assert.equal(fields.get("rootFailureClass"), "none");
  assert.equal(fields.get("observedCode"), record.expectedCode);
  assert.equal(fields.get("observedSubcode"), "none");
  assert.equal(fields.get("expectedRootIdentityDigest"), fields.get("observedRootIdentityDigest"));
  assert.equal(fields.get("personaDigest"), sequenceDigest("mini-lux/sec03/projection-layer/v1", [record.layer]));
  const sourceVariant = record.variantId <= "P04" ? "none" : record.variantId === "P11" && record.profileId === "E4" ? "A12-05" : record.stimulus.sourceVariant;
  assert.equal(fields.get("policyDigest"), sequenceDigest("mini-lux/sec03/projection-case/v1", [record.layer, record.variantId, record.familyId, record.profileId, sourceVariant, record.expectedCode, fields.get("payloadDigest"), fields.get("expectedRootIdentityDigest")]));
  for (const key of ["payloadDigest", "requestDigest", "rootRequestDigest", "stimulusDigest", "transcriptSha256", "expectedRootIdentityDigest"]) assert.match(fields.get(key), shaPattern, `projection ${key} is invalid`);
  assert.equal(fields.get("cleanupComplete"), "1");
  assert.equal(fields.get("handlesDrained"), "1");
  assert.equal(fields.get("treeTerminated"), "1");
  assert.equal(fields.get("networkMode"), "deny");
  if (record.variantId !== "P12") {
    assert.equal(fields.get("hostExitCode"), "none");
    assert.equal(fields.get("recoveryJournalState"), "none");
    assert.equal(fields.get("recoveryJournalGeneration"), "0");
  }
  if (record.variantId === "P02") {
    assert.equal(fields.get("tokenIsAppContainer"), "1");
    assert.equal(fields.get("capabilityCount"), "0");
    assert.equal(fields.get("lowIntegrity"), "1");
  } else if (record.variantId === "P03") {
    assert.equal(fields.get("jobConstrained"), "1");
    assert.equal(fields.get("activeProcessZero"), "1");
  } else if (record.variantId === "P04") assert.equal(fields.get("ambientLeakCount"), "0");
  else if (["P05", "P06", "P07", "P08"].includes(record.variantId)) assert.equal(fields.get("completionReason"), "completed");
  else if (record.variantId === "P09") assert.equal(fields.get("completionReason"), "limit-output");
  else if (record.variantId === "P10") assert.equal(fields.get("completionReason"), "owner-retired");
  else if (record.variantId === "P11") {
    assert.equal(fields.get("completionReason"), "pre-host-denial");
    assert.equal(fields.get("processStarts"), "0");
  } else if (record.variantId === "P12") {
    assert.equal(fields.get("completionReason"), "host-lost-recovered");
    assert.equal(fields.get("hostExitCode"), "58279");
    assert.equal(fields.get("recoveryJournalState"), "applied");
    assert.equal(fields.get("recoveryJournalGeneration"), "2");
    assert.equal(fields.get("hostExited"), "1");
  }
  if (record.variantId === "P07") {
    assert.equal(fields.get("networkAttemptCount"), "1");
    assert.equal(fields.get("networkAcceptedCount"), "0");
  }
  assert.equal(envelope.observedCode, record.expectedCode);
  assert.equal(envelope.observedSubcode, record.expectedSubcode);
}

function validateBrokerOutcome(envelope, context, fields) {
  const record = context.record;
  assert.equal(record.layer, "real-host");
  assert.equal(record.familyId, "A05");
  assert.match(record.variantId, /^A05-(?:0[1-9]|10)$/u);
  const code = record.expectedCode;
  const allowed = code === "OBS_BROKER_ALLOWED";
  assert.equal(fields.get("operation"), "broker");
  assert.equal(fields.get("decisionState"), code);
  assert.equal(fields.get("observationClass"), "broker-observation");
  assert.equal(fields.get("raceStage"), "trusted-network-broker");
  assert.equal(fields.get("rootFailureClass"), "none");
  assert.equal(fields.get("observedCode"), code);
  assert.equal(fields.get("observedSubcode"), "none");
  assert.equal(fields.get("networkMode"), "brokered");
  assert.equal(fields.get("expectedRootIdentityDigest"), fields.get("observedRootIdentityDigest"));
  assert.equal(fields.get("expectedRootIdentityDigest"), fields.get("rootIdentityDigest"));
  assert.equal(fields.get("expectedRootIdentityDigest"), fields.get("aclProfileSha256"));
  assert.equal(fields.get("payloadDigest"), fields.get("environmentNameDigest"));
  assert.equal(fields.get("requestDigest"), fields.get("rootAccessProfileSha256"));
  assert.equal(fields.get("rootRequestDigest"), fields.get("environmentValueDigest"));
  assert.equal(fields.get("packageSidSha256").length, 64);
  assert.equal(Number(fields.get("journalWrites")) % 1, 0);
  assert.equal(Number(fields.get("aclMutations")) % 1, 0);
  assert.equal(Number(fields.get("stdinWrites")) % 1, 0);
  assert.equal(Number(fields.get("aggregateOutputBytes")) % 1, 0);
  assert.equal(fields.get("processStarts"), "0");
  assert.equal(fields.get("profileCreates"), "0");
  assert.equal(fields.get("completionReason"), allowed ? "broker-completed" : "broker-denied");
  assert.equal(fields.get("networkAcceptedCount"), allowed ? "1" : "0");
  assert.equal(fields.get("cleanupComplete"), "1");
  assert.equal(fields.get("jobClosed"), "1");
  assert.equal(fields.get("handlesDrained"), "1");
  assert.equal(fields.get("hostExited"), "1");
  assert.equal(fields.get("treeTerminated"), "1");
  const values = [
    code, fields.get("candidate"), fields.get("buildIdSha256"), fields.get("sourceSha256"), fields.get("hostSha256"), fields.get("launcher"),
    fields.get("execution"), fields.get("context"), fields.get("session"), fields.get("run"), fields.get("authorityEpoch"), fields.get("entryPoint"), fields.get("profile"), fields.get("personaDigest"), fields.get("policyDigest"),
    fields.get("payloadDigest"), fields.get("requestDigest"), fields.get("rootRequestDigest"), fields.get("expectedRootIdentityDigest"), fields.get("packageSidSha256"), fields.get("jobPolicySha256"), fields.get("inputDigestSetSha256"),
    fields.get("networkAttemptCount"), fields.get("journalWrites"), fields.get("aclMutations"), fields.get("stdinWrites"), fields.get("aggregateOutputBytes"), fields.get("hostExitCode"), allowed ? "1" : "0",
  ];
  assert.equal(fields.get("stimulusDigest"), sequenceDigest("mini-lux/sec03/broker-observation-stimulus/v1", values));
  assert.equal(fields.get("transcriptSha256"), sequenceDigest("mini-lux/sec03/broker-observation-transcript/v1", [fields.get("stimulusDigest"), code, ...values.slice(15)]));
  assert.equal(envelope.network.mode, "brokered");
  assert.equal(envelope.network.attemptCount, Number(fields.get("networkAttemptCount")));
  assert.equal(envelope.network.acceptedCount, allowed ? 1 : 0);
}

function validateExactProbe(fields, planned, profileId, label) {
  const persistent = profileId === "E2" || profileId === "E4";
  assert.equal(fields.get("payloadDigest"), hash(planned.payload), `${label} launch probe differs`);
  const inputMaterial = persistent ? `${hash(planned.input)}\n${hash("exit")}\n` : "";
  assert.equal(fields.get("inputDigestSetSha256"), hash(inputMaterial), `${label} input probe differs`);
  assert.equal(fields.get("stdinWrites"), persistent ? "2" : profileId === "E3" ? "1" : "0", `${label} stdin count differs`);
}

function validateObservedOutcome(envelope, context, fields) {
  const record = context?.record;
  assert(record && record.layer === envelope.layer && record.familyId === envelope.familyId && record.variantId === envelope.variantId && record.profileId === envelope.profileId, "native evidence matrix binding differs");
  assert.equal(envelope.observedCode, record.expectedCode, "native evidence observed code differs");
  assert.equal(envelope.observedSubcode, record.expectedSubcode, "native evidence observed subcode differs");
  assert.equal(record.layer, "real-host", "native observation layer is not implemented");
  assert.equal(fields.get("cleanupComplete"), "1");
  assert.equal(fields.get("handlesDrained"), "1");
  assert.equal(fields.get("treeTerminated"), "1");
  assert.equal(fields.get("rootFixedNtfs"), "1");
  if (record.familyId === "A14" && ["A14-03", "A14-04", "A14-05"].includes(record.variantId)) {
    const expected = record.variantId === "A14-03" ? ["EXEC_ACL_SHARING_FAILED", "acl-sharing-failed"] : record.variantId === "A14-04" ? ["EXEC_ACL_PROPAGATION_FAILED", "acl-propagation-failed"] : ["EXEC_ACL_CONFLICT", "acl-conflict"];
    assert.equal(envelope.observedCode, expected[0]);
    assert.equal(fields.get("completionReason"), expected[1]);
    assert.equal(fields.get("childExit"), "0");
    assert.equal(fields.get("processStarts"), "0");
    assert.equal(fields.get("aclMutations"), "0");
    assert.equal(fields.get("tokenIsAppContainer"), "0");
    assert.equal(fields.get("lowIntegrity"), "0");
    assert.equal(fields.get("jobConstrained"), "0");
    assert.equal(fields.get("processCreatedSuspended"), "0");
    assert.equal(envelope.network.attemptCount, 0);
    return;
  }
  assert(Number(fields.get("processStarts")) >= 1, "native observation did not start a process");
  assert.equal(envelope.network.attemptCount, record.familyId === "A04" ? 1 : 0);
  if (record.familyId === "A01") {
    assert.equal(envelope.observedCode, "OBS_ENV_ABSENT");
    assert.equal(fields.get("completionReason"), "completed");
    assert.equal(fields.get("childExit"), "0");
    const probe = a01Probe(record.variantId, record.profileId);
    if (record.profileId === "E1" || record.profileId === "E3") {
      assert.equal(fields.get("payloadDigest"), hash(probe), "A01 launch probe differs");
      assert.equal(fields.get("stdinWrites"), record.profileId === "E3" ? "1" : "0");
      assert.equal(fields.get("inputDigestSetSha256"), hash(""));
    } else {
      assert.equal(fields.get("payloadDigest"), hash("cmd"));
      assert.equal(fields.get("stdinWrites"), "2");
      assert.equal(fields.get("inputDigestSetSha256"), hash(`${hash(probe)}\n${hash("exit")}\n`), "A01 ConPTY probe differs");
    }
    return;
  }
  if (record.familyId === "A03") {
    const planned = a03Case(record.variantId, record.profileId);
    const persistent = record.profileId === "E2" || record.profileId === "E4";
    assert.equal(envelope.observedCode, "OBS_ROOT_REPLACEMENT_BLOCKED");
    assert.equal(fields.get("completionReason"), "completed");
    assert.equal(fields.get("childExit"), "0");
    assert.equal(fields.get("payloadDigest"), hash(planned.payload));
    assert.equal(fields.get("inputDigestSetSha256"), hash(planned.input === null ? "" : `${hash(planned.input)}\n`));
    assert.equal(fields.get("stdinWrites"), record.profileId === "E3" || planned.input !== null ? "1" : "0");
    assert.equal(fields.get("postAclRootDeleteOpenWin32"), "32");
    assert.equal(fields.get("postAclCwdDeleteOpenWin32"), "32");
    assert.equal(fields.get("postAclReplacementBlocked"), "1");
    assert.equal(fields.get("processCreatedSuspended"), "1");
    assert.equal(fields.get("postCreateRootDeleteOpenWin32"), "32");
    assert.equal(fields.get("postCreateCwdDeleteOpenWin32"), "32");
    assert.equal(fields.get("postCreateReplacementBlocked"), "1");
    assert.equal(fields.get("preResumePathIdentityMatch"), "1");
    assert.equal(fields.get("resumeAfterRecheck"), "1");
    assert.equal(fields.get("conpty"), persistent ? "1" : "0");
    return;
  }
  if (record.familyId === "A02" || record.familyId === "A04") {
    const planned = record.familyId === "A02" ? a02Case(record.variantId, record.profileId) : a04Case(record.variantId, record.profileId);
    assert.equal(envelope.observedCode, record.familyId === "A02" ? "OBS_FS_DENIED" : "OBS_NETWORK_DENIED");
    assert.equal(fields.get("completionReason"), "completed");
    assert.equal(fields.get("childExit"), "0");
    assert.equal(envelope.network.acceptedCount, 0, `${record.familyId} host listener accepted a sandbox operation`);
    assert.equal(fields.get("networkAcceptedCount"), "0", `${record.familyId} native network count differs`);
    validateExactProbe(fields, planned, record.profileId, record.familyId);
    return;
  }
  if (record.profileId === "E3A") {
    const planned = e3aCase(record.variantId, record.profileId);
    assert.equal(envelope.observedCode, planned.expectedCode);
    assert.equal(fields.get("profile"), "fixed-adversary");
    assert.equal(fields.get("payloadDigest"), hash(planned.payload), "E3A fixed tuple payload differs");
    assert.equal(fields.get("inputDigestSetSha256"), hash(""));
    assert.equal(fields.get("stdinWrites"), "0");
    assert.equal(fields.get("completionReason"), planned.nativeReason);
    assert.equal(fields.get("childExit"), String(planned.childExit));
    assert.equal(fields.get("jobPolicySha256"), hash(a08JobPolicyMaterial(planned.limits)), "E3A fixed Job policy differs");
    assert.equal(fields.get("executableLease"), "1");
    assert.equal(fields.get("aclMutations"), "4");
    assert.equal(fields.get("processCreatedSuspended"), "1");
    assert(Number(fields.get("observedDescendantCount")) >= planned.minimumDescendants, "E3A fixed descendant stimulus was not observed");
    assert.equal(fields.get("descendantValidationFailures"), "0", "E3A descendant escaped token or Job validation");
    assert.equal(fields.get("activeProcessZero"), "1");
    return;
  }
  if (record.familyId === "A06") {
    const planned = a06Case(record.variantId, record.profileId);
    assert.equal(envelope.observedCode, planned.expectedCode);
    assert.equal(fields.get("completionReason"), "completed");
    assert.equal(fields.get("childExit"), "0");
    assert.equal(fields.get("payloadDigest"), hash(planned.payload));
    assert.equal(fields.get("inputDigestSetSha256"), hash(planned.input === null ? "" : `${hash(planned.input)}\n`));
    assert.equal(fields.get("stdinWrites"), planned.input === null ? "0" : "1");
    assert(Number(fields.get("observedProcessCount")) >= planned.minimumDescendants + 1, "A06 did not observe the root and descendants");
    assert(Number(fields.get("observedDescendantCount")) >= planned.minimumDescendants, "A06 descendant topology was not observed");
    assert.equal(fields.get("descendantValidationFailures"), "0", "A06 descendant escaped token or Job validation");
    assert.equal(fields.get("activeProcessZero"), "1");
    return;
  }
  if (record.familyId === "A07") {
    const planned = a07Case(record.variantId, record.profileId);
    assert.equal(envelope.observedCode, planned.expectedCode);
    assert.equal(fields.get("completionReason"), "completed");
    assert.equal(fields.get("childExit"), String(planned.expectedExit));
    assert.equal(fields.get("payloadDigest"), hash(planned.payload));
    assert.equal(fields.get("jobBreakawayAllowed"), "0");
    assert.equal(fields.get("jobSilentBreakawayAllowed"), "0");
    assert.equal(fields.get("inputDigestSetSha256"), hash(planned.input === null ? "" : `${hash(planned.input)}\n`));
    assert.equal(fields.get("stdinWrites"), planned.input === null && record.profileId !== "E3" ? "0" : "1");
    assert.equal(fields.get("processCreatedSuspended"), "1");
    if (["A07-01", "A07-02", "A07-03"].includes(record.variantId)) {
      assert(Number(fields.get("observedDescendantCount")) >= planned.minimumDescendants, "A07 fixed Win32 stimulus descendant was not observed");
      assert.equal(fields.get("descendantValidationFailures"), "0", "A07 fixed Win32 stimulus escaped token or Job validation");
    } else if (record.variantId === "A07-04") {
      assert.equal(fields.get("hostDupOpenWin32"), "5");
      assert.equal(fields.get("jobHandleInheritable"), "0");
      assert.equal(fields.get("jobHandleDuplicateWin32"), "5");
      assert.equal(fields.get("jobHandleDuplicateBlocked"), "1");
    } else if (record.variantId === "A07-05") {
      assert.equal(fields.get("hostDupOpenWin32"), "5");
      assert.equal(fields.get("controlHandleInheritable"), "0");
      assert.equal(fields.get("controlHandleDuplicateWin32"), "5");
      assert.equal(fields.get("controlHandleDuplicateBlocked"), "1");
    } else {
      assert.equal(fields.get("sentinelHandleInheritable"), "1");
      assert.equal(fields.get("sentinelHandleListed"), "0");
      assert.equal(fields.get("sentinelHandleObserved"), "0");
      assert(["0", "6"].includes(fields.get("sentinelProbeWin32")), "A07 sentinel probe did not produce an exact absent-or-different-object result");
      assert.equal(fields.get("unlistedSentinelBlocked"), "1");
    }
    assert.equal(fields.get("resumeAfterRecheck"), "1");
    return;
  }
  if (record.familyId === "A08") {
    const planned = a08Case(record.variantId, record.profileId);
    assert.equal(envelope.observedCode, planned.expectedCode);
    assert.equal(fields.get("completionReason"), planned.nativeReason);
    assert.equal(fields.get("jobPolicySha256"), hash(a08JobPolicyMaterial(planned.limits)), "A08 attenuated Job policy differs");
    const persistent = record.profileId === "E2" || record.profileId === "E4";
    assert.equal(fields.get("payloadDigest"), hash(persistent ? "cmd" : planned.payload));
    const inputMaterial = planned.input === null ? "" : `${hash(planned.input)}\n`;
    assert.equal(fields.get("inputDigestSetSha256"), hash(inputMaterial));
    assert.equal(fields.get("stdinWrites"), record.profileId === "E3" || planned.input !== null ? "1" : "0");
    return;
  }
  if (record.familyId === "A09") {
    const planned = a09Case(record.variantId, record.profileId);
    const persistent = record.profileId === "E2" || record.profileId === "E4";
    assert.equal(envelope.observedCode, planned.expectedCode);
    assert.equal(fields.get("completionReason"), planned.nativeReason);
    assert.equal(fields.get("payloadDigest"), hash(planned.payload));
    const inputMaterial = planned.input === null ? "" : `${hash(planned.input)}\n`;
    assert.equal(fields.get("inputDigestSetSha256"), hash(inputMaterial));
    assert.equal(fields.get("stdinWrites"), record.profileId === "E3" || planned.input !== null ? "1" : "0");
    const childExit = { "A09-01": 0, "A09-02": 0xE083, "A09-03": 0xE088, "A09-04": 0xE089, "A09-05": 0xE08A, "A09-08": 0xE08C }[record.variantId];
    assert.notEqual(childExit, undefined);
    assert.equal(fields.get("childExit"), String(childExit));
    assert.equal(fields.get("conpty"), persistent ? "1" : "0");
    return;
  }
  if (record.familyId === "A10") {
    const planned = a10Case(record.variantId, record.profileId);
    assert.equal(fields.get("profile"), planned.carrierProfile);
    assert.equal(envelope.observedCode, "EXEC_PROTOCOL_INVALID");
    assert.equal(envelope.observedSubcode, planned.subcode);
    assert.equal(fields.get("completionReason"), "protocol-invalid");
    assert.equal(fields.get("protocolSubcode"), planned.subcode);
    assert.equal(fields.get("childExit"), "57457");
    assert.equal(fields.get("stdinWrites"), planned.subcode === "replay" ? "1" : "0");
    assert.equal(fields.get("activeProcessZero"), "1");
    return;
  }
  if (record.familyId === "A17") {
    assert.equal(record.profileId, "E3");
    assert.equal(fields.get("completionReason"), "completed");
    assert.equal(fields.get("childExit"), "0");
    assert.equal(envelope.observedCode, "OBS_SCRIPT_DENIED");
    assert.equal(fields.get("payloadDigest"), hash(a17Probe(record.variantId)), "A17 script probe differs");
    assert.equal(fields.get("stdinWrites"), "1");
    assert.equal(fields.get("inputDigestSetSha256"), hash(""));
    return;
  }
  if (record.familyId !== "A16" || !["A16-01", "A16-02", "A16-03"].includes(record.variantId)) throw new Error("native observation mapping is not implemented for this SEC-03 record");
  assert.equal(envelope.observedCode, "OBS_POSITIVE_COMPLETE");
  assert.equal(fields.get("completionReason"), "completed");
  assert.equal(fields.get("childExit"), "0");
  if (record.variantId === "A16-01") {
    assert.equal(fields.get("rootSameSystemVolume"), "1");
    assert.equal(fields.get("rootHasSpace"), "0");
    assert.equal(fields.get("rootHasNonAscii"), "0");
  } else if (record.variantId === "A16-02") {
    assert.equal(fields.get("rootSameSystemVolume"), "1");
    assert.equal(fields.get("rootHasSpace"), "1");
    assert.equal(fields.get("rootHasNonAscii"), "1");
  } else {
    assert.equal(fields.get("rootSameSystemVolume"), "0");
  }
}

export async function createSec03NativeVerifier(identity) {
  for (const key of ["candidateId", "buildId", "sourceSha256", "hostSha256", "launcherSha256"]) assert.match(identity?.[key], shaPattern, `SEC-03 identity ${key} is invalid`);
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText);
  const a15ManifestMutantSha256 = hash(nativeManifestMismatchBytes(manifestText, manifest));
  const a15ImportMutantSha256 = hash(nativeManifestImportMismatchBytes(manifestText, manifest));
  const host = manifest.outputs?.find(value => value.path === "dist/native/sandbox-host.exe");
  const launcher = manifest.outputs?.find(value => value.path === "dist/native/sandbox-launcher.node");
  assert.equal(host?.sha256, identity.hostSha256, "fixed host differs from SEC-03 identity");
  assert.equal(launcher?.sha256, identity.launcherSha256, "fixed launcher differs from SEC-03 identity");
  const addon = require(addonPath);
  assert.deepEqual(Object.keys(addon).sort(), ["openEvidenceVerifier", "openExclusiveHostLease", "protocolVersion"]);
  const verifier = addon.openEvidenceVerifier(identity.candidateId, identity.buildId, identity.sourceSha256, identity.hostSha256, identity.launcherSha256);
  assert(verifier && typeof verifier.verifyExecutionProof === "function" && typeof verifier.verifyLauncherObservation === "function" && shaPattern.test(verifier.keyId));

  return Object.freeze({
    verificationKind: "fixed-native-execution-proof-v1",
    verifyNativeEvidence(envelope, context) {
      const record = context?.record;
      assert(record && record.layer === envelope.layer && record.familyId === envelope.familyId && record.variantId === envelope.variantId && record.profileId === envelope.profileId, "native evidence matrix binding differs");
      const launcherObservation = envelope.nativeProof.kind === "launcher-observation";
      assert(launcherObservation || envelope.nativeProof.kind === "execution-proof", "unsupported native proof kind");
      const proof = Buffer.from(envelope.nativeProof.proofBase64, "base64");
      assert.equal(envelope.nativeProof.keyId, verifier.keyId, "native proof key differs");
      assert.equal(envelope.nativeProof.channelMarker, envelope.launcherChannelMarker, "native launcher marker differs from envelope");
      if (launcherObservation) assert.equal(envelope.transcriptMac, null, "launcher observation must not claim a host transcript MAC");
      else assert.equal(envelope.nativeProof.mac, envelope.transcriptMac, "native proof MAC differs from transcript binding");
      const verified = launcherObservation
        ? verifier.verifyLauncherObservation(proof, envelope.nativeProof.mac, envelope.nativeProof.channelMarker)
        : verifier.verifyExecutionProof(proof, envelope.nativeProof.mac, envelope.nativeProof.channelMarker);
      const fields = parseProof(proof);
      assert.equal(fields.get("candidate"), identity.candidateId);
      assert.equal(fields.get("buildIdSha256"), identity.buildId);
      assert.equal(fields.get("sourceSha256"), identity.sourceSha256);
      assert.equal(fields.get("hostSha256"), identity.hostSha256);
      assert.equal(fields.get("launcher"), identity.launcherSha256);
      assert.equal(fields.get("execution"), envelope.executionNonce);
      assert.equal(fields.get("run"), identity.runId);
      assert.equal(fields.get("profile"), profileNames[envelope.profileId]);
      if (launcherObservation && record.familyId === "A09" && ["A09-06", "A09-07"].includes(record.variantId)) {
        const serviceLost = record.variantId === "A09-06";
        const tuple = `${record.variantId}/${record.profileId}`;
        const observedCode = serviceLost ? "EXEC_SERVICE_LOST" : "EXEC_HOST_LOST";
        const hostExitCode = serviceLost ? "58278" : "58279";
        assert.equal(fields.get("stimulusDigest"), sequenceDigest("mini-lux/sec03/fixed-lifecycle-recovery-stimulus/v1", [tuple, serviceLost ? "service-job-termination" : "host-process-termination", observedCode, fields.get("requestDigest"), fields.get("payloadDigest"), fields.get("candidate"), fields.get("buildIdSha256"), fields.get("sourceSha256"), fields.get("hostSha256"), fields.get("launcher"), fields.get("execution"), fields.get("context"), fields.get("session"), fields.get("run"), fields.get("authorityEpoch"), fields.get("entryPoint"), fields.get("profile"), fields.get("personaDigest"), fields.get("policyDigest"), fields.get("rootRequestDigest"), fields.get("expectedRootIdentityDigest"), "applied", "2", hostExitCode, fields.get("aclProfileSha256"), fields.get("processStarts"), fields.get("aggregateOutputBytes")]), "fixed lifecycle variant/request binding differs");
        assert.equal(fields.get("decisionState"), serviceLost ? "service-lost-recovered" : "host-lost-recovered", "fixed lifecycle recovery variant differs");
        assert.equal(fields.get("observedCode"), observedCode, "fixed lifecycle recovery code differs");
        assert.equal(fields.get("hostExitCode"), hostExitCode, "fixed lifecycle recovery exit differs");
      }
      if (launcherObservation && record.familyId === "A14" && ["A14-01", "A14-02"].includes(record.variantId)) {
        const pristine = record.variantId === "A14-01";
        const tuple = `${record.variantId}/${record.profileId}`;
        const descriptor = pristine ? "pre-mutation-crash" : "post-apply-crash";
        const observedCode = pristine ? "OBS_ACL_PRISTINE" : "OBS_ACL_RECOVERED";
        const journalState = pristine ? "prepared" : "applied";
        const journalGeneration = pristine ? "1" : "2";
        const hostExitCode = pristine ? "58273" : "58274";
        assert.equal(fields.get("stimulusDigest"), sequenceDigest("mini-lux/sec03/fixed-acl-recovery-stimulus/v1", [tuple, descriptor, observedCode, fields.get("requestDigest"), fields.get("payloadDigest"), fields.get("candidate"), fields.get("buildIdSha256"), fields.get("sourceSha256"), fields.get("hostSha256"), fields.get("launcher"), fields.get("execution"), fields.get("context"), fields.get("session"), fields.get("run"), fields.get("authorityEpoch"), fields.get("entryPoint"), fields.get("profile"), fields.get("personaDigest"), fields.get("policyDigest"), fields.get("rootRequestDigest"), fields.get("expectedRootIdentityDigest"), journalState, journalGeneration, hostExitCode, fields.get("aclProfileSha256")]), "fixed ACL recovery variant/request binding differs");
        assert.equal(fields.get("decisionState"), pristine ? "acl-pristine-recovered" : "acl-applied-recovered", "fixed ACL recovery variant differs");
        assert.equal(fields.get("observedCode"), observedCode, "fixed ACL recovery code differs");
        assert.equal(fields.get("hostExitCode"), hostExitCode, "fixed ACL recovery exit differs");
      }
      assert.equal(fields.get("transcriptSha256"), envelope.transcriptSha256);
      assert.equal(fields.get("tokenIsAppContainer"), envelope.token.isAppContainer ? "1" : "0");
      assert.equal(fields.get("packageSidSha256"), envelope.token.packageSidSha256);
      assert.equal(Number(fields.get("capabilityCount")), envelope.token.capabilityCount);
      assert.equal(fields.get("lowIntegrity"), envelope.token.integrity === "low" ? "1" : "0");
      assert.equal(fields.get("jobPolicySha256"), envelope.job.policySha256);
      assert.equal(fields.get("activeProcessZero"), envelope.job.activeProcessZero ? "1" : "0");
      assert.equal(Number(fields.get("processStarts")), envelope.sideEffects.processStarts);
      assert.equal(Number(fields.get("aclMutations")), envelope.sideEffects.aclMutations);
      assert.equal(Number(fields.get("stdinWrites")), envelope.sideEffects.stdinWrites);
      assert.equal(fields.get("rootIdentityDigest"), envelope.root.identitySha256);
      assert.equal(fields.get("rootAccessProfileSha256"), envelope.root.accessProfileSha256);
      assert.equal(fields.get("environmentNameDigest"), envelope.environment.nameSetSha256);
      assert.equal(fields.get("environmentValueDigest"), envelope.environment.valueSetSha256);
      assert.equal(Number(fields.get("ambientLeakCount")), envelope.environment.ambientLeakCount);
      assert.equal(fields.get("networkMode"), envelope.network.mode);
      assert.equal(Number(fields.get("networkAcceptedCount")), envelope.network.acceptedCount);
      assert.equal(fields.get("completionReason"), envelope.termination.reason);
      assert.equal(fields.get("treeTerminated"), envelope.termination.treeTerminated ? "1" : "0");
      assert.equal(fields.get("activeProcessZero"), envelope.termination.activeProcessZero ? "1" : "0");
      assert.equal(fields.get("handlesDrained"), envelope.cleanup.handlesDrained ? "1" : "0");
      assert.equal(fields.get("aclProfileSha256"), envelope.cleanup.aclProfileSha256);
      assert.equal(envelope.producer.instanceSha256, hash(`${verifier.keyId}\0${envelope.executionNonce}`), "native producer instance differs");
      assert.equal(context.identity.candidateId, identity.candidateId);

      if (launcherObservation && record.familyId === "A05") {
        validateBrokerOutcome(envelope, context, fields);
        assert.equal(verified.testOnly, false);
        return Object.freeze(verified);
      }

      if (launcherObservation && record.layer !== "real-host") {
        validateProjectionOutcome(envelope, context, fields);
        assert.equal(verified.testOnly, false);
        return Object.freeze(verified);
      }

      if (launcherObservation) {
        const record = context.record;
        const fixedLifecycleRecovery = record.familyId === "A09" && ["A09-06", "A09-07"].includes(record.variantId);
        const fixedAclRecovery = record.familyId === "A14" && ["A14-01", "A14-02"].includes(record.variantId);
        assert.equal(record.layer, "real-host");
        assert.equal(record.profileId, envelope.profileId);
        assert.equal(envelope.observedCode, record.expectedCode);
        assert.equal(envelope.observedSubcode, record.expectedSubcode);
        assert.equal(fields.get("observedSubcode"), "none");
        assert.equal(fields.get("entryPoint"), record.profileId);
        if ((record.familyId === "A03" && record.variantId === "A03-01") || (record.familyId === "A14" && record.variantId === "A14-06")) {
          assert.equal(fields.get("operation"), "launch");
          assert.equal(fields.get("decisionState"), "none");
          assert.equal(fields.get("observationClass"), "root-identity-changed");
          assert.equal(fields.get("raceStage"), "before-retained-handle");
          assert.equal(fields.get("rootFailureClass"), "none");
          assert.equal(fields.get("observedCode"), "EXEC_ROOT_IDENTITY_CHANGED");
          assert.notEqual(fields.get("expectedRootIdentityDigest"), fields.get("observedRootIdentityDigest"));
          assert.equal(fields.get("rootIdentityDigest"), fields.get("expectedRootIdentityDigest"));
          assert.equal(fields.get("rootFixedNtfs"), "1");
        } else if (record.familyId === "A11") {
          const planned = a11Case(record.variantId, record.profileId);
          assert.equal(fields.get("operation"), planned.operation);
          assert.equal(fields.get("decisionState"), planned.decisionState);
          assert.equal(fields.get("observedCode"), planned.expectedCode);
          assert.equal(fields.get("payloadDigest"), hash(planned.attemptedPayload));
          assert.equal(fields.get("observationClass"), "service-denial");
          assert.equal(fields.get("raceStage"), "trusted-service-decision");
          assert.equal(fields.get("rootFailureClass"), "none");
          assert.equal(fields.get("expectedRootIdentityDigest"), fields.get("observedRootIdentityDigest"));
          assert.equal(fields.get("rootIdentityDigest"), fields.get("expectedRootIdentityDigest"));
          assert.equal(fields.get("rootFixedNtfs"), "0");
        } else if (record.familyId === "A12") {
          const planned = a12Case(record.variantId, record.profileId);
          assert.equal(fields.get("operation"), planned.operation);
          assert.equal(fields.get("decisionState"), planned.decisionState);
          assert.equal(fields.get("observedCode"), planned.expectedCode);
          assert.equal(fields.get("payloadDigest"), hash(JSON.stringify(planned.request)));
          assert.equal(fields.get("observationClass"), "service-denial");
          assert.equal(fields.get("raceStage"), "trusted-service-decision");
          assert.equal(fields.get("rootFailureClass"), "none");
          assert.equal(fields.get("expectedRootIdentityDigest"), fields.get("observedRootIdentityDigest"));
          assert.equal(fields.get("rootIdentityDigest"), fields.get("expectedRootIdentityDigest"));
          assert.equal(fields.get("rootFixedNtfs"), "0");
        } else if (record.familyId === "A13") {
          const planned = a13Case(record.variantId, record.profileId);
          assert.equal(fields.get("operation"), planned.operation);
          assert.equal(fields.get("decisionState"), planned.decisionState);
          assert.equal(fields.get("observedCode"), planned.expectedCode);
          assert.equal(fields.get("entryPoint"), planned.entryPoint);
          assert.equal(fields.get("profile"), planned.profile);
          if (record.variantId === "A13-01" || record.variantId === "A13-02") {
            const event = record.variantId === "A13-01" ? "start" : "input";
            assert.equal(fields.get("payloadDigest"), canonicalHash({ schema: "mini-lux/sec03/terminal-direct-denial-payload/v1", method: "POST", route: event === "start" ? "/api/terminals" : "/api/terminals/:id/input" }));
          } else assert.match(fields.get("payloadDigest"), /^[a-f0-9]{64}$/u);
          assert.equal(fields.get("requestDigest"), canonicalHash({ schema: "mini-lux/sec03/service-denial-request/v1", operation: fields.get("operation"), entryPoint: "E4", profile: "manual-terminal", contextId: fields.get("context"), sessionId: fields.get("session"), runId: fields.get("run"), principal: "local-user-api", authorityEpoch: Number(fields.get("authorityEpoch")), personaDigest: fields.get("personaDigest"), policyDigest: fields.get("policyDigest"), payloadDigest: fields.get("payloadDigest") }));
          assert.equal(fields.get("observationClass"), "service-denial");
          assert.equal(fields.get("raceStage"), "trusted-service-decision");
          assert.equal(fields.get("rootFailureClass"), "none");
          assert.equal(fields.get("rootFixedNtfs"), "0");
        } else if (record.familyId === "A09" && ["A09-06", "A09-07"].includes(record.variantId)) {
          const planned = a09Case(record.variantId, record.profileId);
          const serviceLost = record.variantId === "A09-06";
          const tuple = `${record.variantId}/${record.profileId}`;
          const hostExitCode = serviceLost ? "58278" : "58279";
          assert.equal(fields.get("operation"), "launch");
          assert.equal(fields.get("decisionState"), planned.nativeReason);
          assert.equal(fields.get("observedCode"), planned.expectedCode);
          assert.equal(fields.get("observationClass"), "lifecycle-crash-recovery");
          assert.equal(fields.get("raceStage"), serviceLost ? "post-service-job-termination" : "post-host-termination");
          assert.equal(fields.get("rootFailureClass"), "none");
          assert.equal(fields.get("expectedRootIdentityDigest"), fields.get("observedRootIdentityDigest"));
          assert.equal(fields.get("rootIdentityDigest"), fields.get("expectedRootIdentityDigest"));
          assert.equal(fields.get("hostExitCode"), hostExitCode);
          assert.equal(fields.get("recoveryJournalState"), "applied");
          assert.equal(fields.get("recoveryJournalGeneration"), "2");
          assert.equal(fields.get("journalWrites"), "2");
          assert.equal(fields.get("aclMutations"), "2");
          assert(Number(fields.get("processStarts")) >= 1, "lifecycle crash did not observe the sandbox process tree");
          assert(Number(fields.get("aggregateOutputBytes")) >= 1, "lifecycle crash occurred before native output established process readiness");
          assert.equal(fields.get("stimulusDigest"), sequenceDigest("mini-lux/sec03/fixed-lifecycle-recovery-stimulus/v1", [tuple, serviceLost ? "service-job-termination" : "host-process-termination", planned.expectedCode, fields.get("requestDigest"), fields.get("payloadDigest"), fields.get("candidate"), fields.get("buildIdSha256"), fields.get("sourceSha256"), fields.get("hostSha256"), fields.get("launcher"), fields.get("execution"), fields.get("context"), fields.get("session"), fields.get("run"), fields.get("authorityEpoch"), fields.get("entryPoint"), fields.get("profile"), fields.get("personaDigest"), fields.get("policyDigest"), fields.get("rootRequestDigest"), fields.get("expectedRootIdentityDigest"), "applied", "2", hostExitCode, fields.get("aclProfileSha256"), fields.get("processStarts"), fields.get("aggregateOutputBytes")]));
          assert.equal(fields.get("transcriptSha256"), sequenceDigest("mini-lux/sec03/fixed-lifecycle-recovery-transcript/v1", [fields.get("requestDigest"), fields.get("rootRequestDigest"), tuple, planned.nativeReason, planned.expectedCode, "applied", "2", "2", "2", fields.get("expectedRootIdentityDigest"), fields.get("aclProfileSha256"), fields.get("processStarts"), fields.get("aggregateOutputBytes")]));
          assert.equal(fields.get("profileCreates"), "1");
          assert.equal(fields.get("stdinWrites"), record.profileId === "E3" ? "1" : "0");
          assert.equal(fields.get("conpty"), ["E2", "E4"].includes(record.profileId) ? "1" : "0");
          assert.equal(fields.get("executableLease"), record.profileId === "E1" ? "0" : "1");
          assert.equal(fields.get("childExit"), "none");
          assert.equal(fields.get("completionReason"), planned.nativeReason);
          assert.equal(fields.get("jobConstrained"), "1");
          assert.equal(fields.get("rootFixedNtfs"), "1");
          assert.equal(fields.get("networkAttemptCount"), "0");
        } else if (record.familyId === "A14" && ["A14-01", "A14-02"].includes(record.variantId)) {
          const pristine = record.variantId === "A14-01";
          const tuple = `${record.variantId}/${record.profileId}`;
          const descriptor = pristine ? "pre-mutation-crash" : "post-apply-crash";
          const decisionState = pristine ? "acl-pristine-recovered" : "acl-applied-recovered";
          const observedCode = pristine ? "OBS_ACL_PRISTINE" : "OBS_ACL_RECOVERED";
          const hostExitCode = pristine ? "58273" : "58274";
          const journalState = pristine ? "prepared" : "applied";
          const journalGeneration = pristine ? "1" : "2";
          const journalWrites = pristine ? "1" : "2";
          const aclMutations = pristine ? "0" : "2";
          assert.equal(fields.get("operation"), "launch");
          assert.equal(fields.get("decisionState"), decisionState);
          assert.equal(fields.get("observedCode"), observedCode);
          assert.equal(fields.get("observationClass"), "acl-crash-recovery");
          assert.equal(fields.get("raceStage"), "post-host-recovery");
          assert.equal(fields.get("rootFailureClass"), "none");
          assert.equal(fields.get("expectedRootIdentityDigest"), fields.get("observedRootIdentityDigest"));
          assert.equal(fields.get("rootIdentityDigest"), fields.get("expectedRootIdentityDigest"));
          assert.equal(fields.get("hostExitCode"), hostExitCode);
          assert.equal(fields.get("recoveryJournalState"), journalState);
          assert.equal(fields.get("recoveryJournalGeneration"), journalGeneration);
          assert.equal(fields.get("journalWrites"), journalWrites);
          assert.equal(fields.get("aclMutations"), aclMutations);
          assert.equal(fields.get("stimulusDigest"), sequenceDigest("mini-lux/sec03/fixed-acl-recovery-stimulus/v1", [tuple, descriptor, observedCode, fields.get("requestDigest"), fields.get("payloadDigest"), fields.get("candidate"), fields.get("buildIdSha256"), fields.get("sourceSha256"), fields.get("hostSha256"), fields.get("launcher"), fields.get("execution"), fields.get("context"), fields.get("session"), fields.get("run"), fields.get("authorityEpoch"), fields.get("entryPoint"), fields.get("profile"), fields.get("personaDigest"), fields.get("policyDigest"), fields.get("rootRequestDigest"), fields.get("expectedRootIdentityDigest"), journalState, journalGeneration, hostExitCode, fields.get("aclProfileSha256")]));
          assert.equal(fields.get("transcriptSha256"), sequenceDigest("mini-lux/sec03/fixed-acl-recovery-transcript/v1", [fields.get("requestDigest"), fields.get("rootRequestDigest"), tuple, decisionState, observedCode, journalState, journalGeneration, journalWrites, aclMutations, fields.get("expectedRootIdentityDigest"), fields.get("aclProfileSha256")]));
          assert.equal(fields.get("processStarts"), "0");
          assert.equal(fields.get("profileCreates"), "1");
          assert.equal(fields.get("stdinWrites"), "0");
          assert.equal(fields.get("executableLease"), record.profileId === "E3" ? "1" : "0");
          assert.equal(fields.get("childExit"), "none");
          assert.equal(fields.get("completionReason"), "host-crash-recovered");
          assert.equal(fields.get("rootFixedNtfs"), "1");
          assert.equal(fields.get("networkAttemptCount"), "0");
        } else if (record.familyId === "A14" && record.variantId === "A14-07") {
          assert.equal(fields.get("operation"), "launch");
          assert.equal(fields.get("decisionState"), "recovery-journal-invalid");
          assert.equal(fields.get("observedCode"), "EXEC_RECOVERY_JOURNAL_INVALID");
          assert.equal(fields.get("payloadDigest"), hash(A14_INVALID_JOURNAL));
          assert.equal(fields.get("requestDigest"), sequenceDigest("mini-lux/sec03/recovery-observation-request/v1", [fields.get("candidate"), fields.get("buildIdSha256"), fields.get("sourceSha256"), fields.get("execution"), fields.get("context"), fields.get("session"), fields.get("run"), fields.get("authorityEpoch"), fields.get("entryPoint"), fields.get("profile"), fields.get("personaDigest"), fields.get("policyDigest"), fields.get("payloadDigest")]));
          assert.equal(fields.get("observationClass"), "recovery-denial");
          assert.equal(fields.get("raceStage"), "startup-recovery");
          assert.equal(fields.get("rootFailureClass"), "none");
          assert.equal(fields.get("rootFixedNtfs"), "0");
        } else if (record.familyId === "A15") {
          const planned = a15Case(record.variantId, record.profileId);
          assert.equal(fields.get("operation"), "launch");
          assert.equal(fields.get("decisionState"), planned.decisionState);
          assert.equal(fields.get("observedCode"), planned.expectedCode);
          assert.equal(fields.get("entryPoint"), planned.entryPoint);
          assert.equal(fields.get("profile"), planned.profile);
          const launcherState = planned.launcherState === "launcher-exact" ? identity.launcherSha256 : planned.launcherState;
          const hostState = planned.hostState === "host-exact" ? identity.hostSha256 : planned.hostState === "manifest-mutant-sha256" ? a15ManifestMutantSha256 : planned.hostState === "manifest-import-mutant-sha256" ? a15ImportMutantSha256 : planned.hostState;
          const extraState = record.variantId === "A15-03" ? hash(A15_EXTRA_ARTIFACT) : "none";
          const subjectDigest = sequenceDigest("mini-lux/sec03/native-identity-subject/v1", [record.variantId, "sandbox-launcher.node", launcherState, "sandbox-host.exe", hostState, "unexpected-native.bin", extraState]);
          assert.equal(fields.get("payloadDigest"), subjectDigest);
          assert.equal(fields.get("requestDigest"), sequenceDigest("mini-lux/sec03/native-identity-request/v1", [fields.get("candidate"), fields.get("buildIdSha256"), fields.get("sourceSha256"), fields.get("execution"), fields.get("context"), fields.get("session"), fields.get("run"), fields.get("authorityEpoch"), fields.get("entryPoint"), fields.get("profile"), fields.get("personaDigest"), fields.get("policyDigest"), subjectDigest]));
          assert.equal(fields.get("observationClass"), "native-identity-denial");
          assert.equal(fields.get("raceStage"), "native-projection-validation");
          assert.equal(fields.get("rootFailureClass"), "none");
          assert.equal(fields.get("rootFixedNtfs"), "0");
        } else if (record.familyId === "A19") {
          const planned = a19Case(record.variantId, record.profileId);
          assert.equal(fields.get("operation"), planned.operation);
          assert.equal(fields.get("decisionState"), planned.decisionState);
          assert.equal(fields.get("observedCode"), planned.expectedCode);
          assert.equal(fields.get("payloadDigest"), hash(planned.payload));
          assert.equal(fields.get("observationClass"), "service-denial");
          assert.equal(fields.get("raceStage"), "trusted-service-decision");
          assert.equal(fields.get("rootFailureClass"), "none");
          assert.equal(fields.get("expectedRootIdentityDigest"), fields.get("observedRootIdentityDigest"));
          assert.equal(fields.get("rootIdentityDigest"), fields.get("expectedRootIdentityDigest"));
          assert.equal(fields.get("rootFixedNtfs"), "0");
        } else {
          assert.equal(record.familyId, "A18", "launcher observation cannot prove another family");
          assert.equal(fields.get("operation"), "launch");
          assert.equal(fields.get("decisionState"), "none");
          assert.equal(fields.get("observationClass"), "unsupported-root");
          assert.equal(fields.get("raceStage"), "root-qualification");
          assert.equal(fields.get("observedCode"), "EXEC_ROOT_UNSUPPORTED");
          assert.equal(fields.get("rootFailureClass"), a18RootFailureClasses[record.variantId], "native root failure class differs from matrix variant");
          assert.equal(fields.get("expectedRootIdentityDigest"), fields.get("observedRootIdentityDigest"));
          assert.equal(fields.get("rootFixedNtfs"), "0");
        }
        if (fixedLifecycleRecovery) {
          assert(Number(fields.get("processStarts")) >= 1);
          assert.equal(fields.get("stdinWrites"), record.profileId === "E3" ? "1" : "0");
        } else {
          assert.equal(fields.get("processStarts"), "0");
          assert.equal(fields.get("stdinWrites"), "0");
        }
        assert.equal(fields.get("networkAttemptCount"), "0");
        assert.equal(envelope.network.attemptCount, 0);
        assert.equal(fields.get("childExit"), "none");
        assert.equal(envelope.termination.exitCode, null);
        if (fixedLifecycleRecovery) {
          assert.equal(fields.get("profileCreates"), "1");
          assert.equal(fields.get("completionReason"), record.variantId === "A09-06" ? "service-lost-recovered" : "host-lost-recovered");
        } else if (fixedAclRecovery) {
          assert.equal(fields.get("profileCreates"), "1");
          assert.equal(fields.get("completionReason"), "host-crash-recovered");
        } else {
          assert.equal(fields.get("profileCreates"), "0");
          assert.equal(fields.get("journalWrites"), "0");
          assert.equal(fields.get("aclMutations"), "0");
          assert.equal(fields.get("hostExitCode"), "none");
          assert.equal(fields.get("recoveryJournalState"), "none");
          assert.equal(fields.get("recoveryJournalGeneration"), "0");
          assert.equal(fields.get("completionReason"), "pre-host-denial");
        }
        assert.equal(fields.get("jobClosed"), envelope.cleanup.jobClosed ? "1" : "0");
        assert.equal(fields.get("hostExited"), envelope.cleanup.hostExited ? "1" : "0");
        assert.equal(fields.get("cleanupComplete"), envelope.cleanup.jobClosed && envelope.cleanup.handlesDrained && envelope.cleanup.hostExited ? "1" : "0");
      } else {
        assert.equal(Number(fields.get("childExit")), envelope.termination.exitCode);
        assert.equal(fields.get("cleanupComplete"), envelope.cleanup.jobClosed && envelope.cleanup.handlesDrained && envelope.cleanup.hostExited ? "1" : "0");
        validateObservedOutcome(envelope, context, fields);
      }
      assert.equal(verified.testOnly, false);
      return Object.freeze(verified);
    },
  });
}
