import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { a01Probe, a02Case, a03Case, a04Case, a06Case, a07Case, a08Case, a08JobPolicyMaterial, a09Case, a11Case, a12Case, a17Probe, a19Case } from "../tests/fixtures/sec03-real-host-plan.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const addonPath = path.join(projectRoot, "dist", "native", "sandbox-launcher.node");
const manifestPath = path.join(projectRoot, "dist", "native", "sec03-native-manifest.json");
const require = createRequire(import.meta.url);
const shaPattern = /^[a-f0-9]{64}$/u;
const profileNames = Object.freeze({ E1: "one-shot-shell", E2: "agent-shell", E3: "script", E4: "manual-terminal" });
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
    assert.equal(fields.get("childExit"), "0");
    assert.equal(fields.get("payloadDigest"), hash(planned.payload));
    assert.equal(fields.get("inputDigestSetSha256"), hash(planned.input === null ? "" : `${hash(planned.input)}\n`));
    assert.equal(fields.get("stdinWrites"), planned.input === null && record.profileId !== "E3" ? "0" : "1");
    assert.equal(fields.get("processCreatedSuspended"), "1");
    if (record.variantId === "A07-04") {
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
    const childExit = { "A09-01": 0, "A09-02": 0xE083, "A09-03": 0xE088, "A09-04": 0xE089, "A09-05": 0xE08A }[record.variantId];
    assert.notEqual(childExit, undefined);
    assert.equal(fields.get("childExit"), String(childExit));
    assert.equal(fields.get("conpty"), persistent ? "1" : "0");
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
  assert(verifier && typeof verifier.verifyExecutionProof === "function" && typeof verifier.verifyLauncherObservation === "function" && shaPattern.test(verifier.keyId));

  return Object.freeze({
    verificationKind: "fixed-native-execution-proof-v1",
    verifyNativeEvidence(envelope, context) {
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

      if (launcherObservation) {
        const record = context.record;
        assert.equal(record.layer, "real-host");
        assert.equal(record.profileId, envelope.profileId);
        assert.equal(envelope.observedCode, record.expectedCode);
        assert.equal(envelope.observedSubcode, record.expectedSubcode);
        assert.equal(fields.get("observedSubcode"), "none");
        assert.equal(fields.get("entryPoint"), record.profileId);
        if (record.familyId === "A03" && record.variantId === "A03-01") {
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
        assert.equal(fields.get("processStarts"), "0");
        assert.equal(fields.get("profileCreates"), "0");
        assert.equal(fields.get("journalWrites"), "0");
        assert.equal(fields.get("aclMutations"), "0");
        assert.equal(fields.get("stdinWrites"), "0");
        assert.equal(fields.get("networkAttemptCount"), "0");
        assert.equal(envelope.network.attemptCount, 0);
        assert.equal(fields.get("childExit"), "none");
        assert.equal(envelope.termination.exitCode, null);
        assert.equal(fields.get("completionReason"), "pre-host-denial");
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
