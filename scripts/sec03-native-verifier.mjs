import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { a01Probe, a08Case, a08JobPolicyMaterial, a17Probe } from "../tests/fixtures/sec03-real-host-plan.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const addonPath = path.join(projectRoot, "dist", "native", "sandbox-launcher.node");
const manifestPath = path.join(projectRoot, "dist", "native", "sec03-native-manifest.json");
const require = createRequire(import.meta.url);
const shaPattern = /^[a-f0-9]{64}$/u;
const profileNames = Object.freeze({ E1: "one-shot-shell", E2: "agent-shell", E3: "script", E4: "manual-terminal" });

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
  assert(Number(fields.get("processStarts")) >= 1, "native observation did not start a process");
  assert.equal(envelope.network.attemptCount, 0);
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
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const host = manifest.outputs?.find(value => value.path === "dist/native/sandbox-host.exe");
  const launcher = manifest.outputs?.find(value => value.path === "dist/native/sandbox-launcher.node");
  assert.equal(host?.sha256, identity.hostSha256, "fixed host differs from SEC-03 identity");
  assert.equal(launcher?.sha256, identity.launcherSha256, "fixed launcher differs from SEC-03 identity");
  const addon = require(addonPath);
  assert.deepEqual(Object.keys(addon).sort(), ["openEvidenceVerifier", "openExclusiveHostLease", "protocolVersion"]);
  const verifier = addon.openEvidenceVerifier(identity.candidateId, identity.buildId, identity.sourceSha256, identity.hostSha256, identity.launcherSha256);
  assert(verifier && typeof verifier.verifyExecutionProof === "function" && shaPattern.test(verifier.keyId));

  return Object.freeze({
    verificationKind: "fixed-native-execution-proof-v1",
    verifyNativeEvidence(envelope, context) {
      assert.equal(envelope.nativeProof.kind, "execution-proof", "unsupported native proof kind");
      const proof = Buffer.from(envelope.nativeProof.proofBase64, "base64");
      assert.equal(envelope.nativeProof.keyId, verifier.keyId, "native proof key differs");
      assert.equal(envelope.nativeProof.mac, envelope.transcriptMac, "native proof MAC differs from transcript binding");
      assert.equal(envelope.nativeProof.channelMarker, envelope.launcherChannelMarker, "native launcher marker differs from envelope");
      const verified = verifier.verifyExecutionProof(proof, envelope.nativeProof.mac, envelope.nativeProof.channelMarker);
      const fields = parseProof(proof);
      assert.equal(fields.get("candidate"), identity.candidateId);
      assert.equal(fields.get("buildIdSha256"), identity.buildId);
      assert.equal(fields.get("sourceSha256"), identity.sourceSha256);
      assert.equal(fields.get("hostSha256"), identity.hostSha256);
      assert.equal(fields.get("launcher"), identity.launcherSha256);
      assert.equal(fields.get("execution"), envelope.executionNonce);
      assert.equal(fields.get("run"), identity.runId);
      assert.equal(fields.get("profile"), profileNames[envelope.profileId]);
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
      assert.equal(Number(fields.get("childExit")), envelope.termination.exitCode);
      assert.equal(fields.get("treeTerminated"), envelope.termination.treeTerminated ? "1" : "0");
      assert.equal(fields.get("activeProcessZero"), envelope.termination.activeProcessZero ? "1" : "0");
      assert.equal(fields.get("handlesDrained"), envelope.cleanup.handlesDrained ? "1" : "0");
      assert.equal(fields.get("aclProfileSha256"), envelope.cleanup.aclProfileSha256);
      assert.equal(fields.get("cleanupComplete"), envelope.cleanup.jobClosed && envelope.cleanup.handlesDrained && envelope.cleanup.hostExited ? "1" : "0");
      assert.equal(envelope.producer.instanceSha256, hash(`${verifier.keyId}\0${envelope.executionNonce}`), "native producer instance differs");
      assert.equal(context.identity.candidateId, identity.candidateId);
      validateObservedOutcome(envelope, context, fields);
      assert.equal(verified.testOnly, false);
      return Object.freeze(verified);
    },
  });
}
