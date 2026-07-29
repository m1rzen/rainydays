import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256File } from "../../tests/helpers.mjs";
import { sha256 } from "./identity.mjs";
import { runBoundedProcess, safeChildEnvironment } from "./process.mjs";

function normalizeThumbprint(value) {
  return typeof value === "string" ? value.replaceAll(/\s/g, "").toUpperCase() : null;
}

function publicEvidence(mode, status, artifactSha256, allowlisted = false, timestamped = false) {
  return { mode, status, allowlisted, timestamped, artifactSha256 };
}

export async function runSignaturePolicy({ workspace, artifactPath, mode, policy, signers, evidenceDirectory, timeoutMs = 60_000 }) {
  assert(["unsigned-test", "trusted-release"].includes(mode));
  if (process.platform !== "win32") {
    return { passed: false, failureClass: "SIGNATURE_PLATFORM_UNSUPPORTED", exitCode: 2, signal: null, timedOut: false, timeoutTermination: null, command: ["powershell", "authenticode.ps1", "<artifact>"], childReportSha256: null, evidence: null };
  }
  const before = await sha256File(artifactPath);
  const script = path.join(workspace, "scripts", "gov04", "authenticode.ps1");
  let result;
  try {
    result = await runBoundedProcess("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-ArtifactPath", artifactPath], { cwd: workspace, timeoutMs, maxOutputBytes: 1024 * 1024, env: safeChildEnvironment() });
  } catch (error) {
    return { passed: false, failureClass: error?.timedOut ? (error.code === "PROCESS_TIMEOUT_CLEANUP_FAILED" ? "TIMEOUT_CLEANUP_FAILED" : "TIMEOUT") : "SIGNATURE_TOOL_UNAVAILABLE", exitCode: null, signal: null, timedOut: error?.timedOut === true, timeoutTermination: error?.termination ?? null, command: ["powershell", "authenticode.ps1", "<artifact>"], childReportSha256: null, evidence: null };
  }
  const after = await sha256File(artifactPath);
  if (before !== after) return { passed: false, failureClass: "ARTIFACT_MUTATION", exitCode: result.code, signal: result.signal, timedOut: false, timeoutTermination: null, command: ["powershell", "authenticode.ps1", "<artifact>"], childReportSha256: null, evidence: null };
  let signature;
  try {
    signature = JSON.parse(result.stdout.trim());
    assert(signature && typeof signature === "object" && !Array.isArray(signature));
    assert.deepEqual(Object.keys(signature).sort(), ["status", "signerThumbprint", "signerSubject", "timestampThumbprint", "timestampSubject"].sort());
  } catch {
    return { passed: false, failureClass: "SIGNATURE_REPORT_INVALID", exitCode: result.code, signal: result.signal, timedOut: false, timeoutTermination: null, command: ["powershell", "authenticode.ps1", "<artifact>"], childReportSha256: null, evidence: null };
  }
  const rawReport = `${JSON.stringify(signature, null, 2)}\n`;
  const rawHash = sha256(rawReport);
  await writeFile(path.join(evidenceDirectory, "signature.json"), rawReport, { encoding: "utf8", flag: "wx" });
  if (result.code !== 0) {
    return { passed: false, failureClass: "SIGNATURE_TOOL_FAILED", exitCode: result.code, signal: result.signal, timedOut: false, timeoutTermination: null, command: ["powershell", "authenticode.ps1", "<artifact>"], childReportSha256: rawHash, evidence: null };
  }
  const status = signature.status;
  if (mode === "unsigned-test") {
    const passed = status === policy.unsignedTestStatus && signature.signerThumbprint === null && signature.timestampThumbprint === null;
    return {
      passed,
      failureClass: passed ? null : "UNSIGNED_TEST_POLICY_MISMATCH",
      exitCode: passed ? 0 : 1,
      signal: null,
      timedOut: false,
      timeoutTermination: null,
      command: ["powershell", "authenticode.ps1", "<artifact>"],
      childReportSha256: rawHash,
      evidence: publicEvidence(mode, status, before),
    };
  }
  if (signers.state !== "configured" || signers.allowedSigners.length === 0) {
    return { passed: false, failureClass: "SIGNER_POLICY_UNCONFIGURED", exitCode: 2, signal: null, timedOut: false, timeoutTermination: null, command: ["powershell", "authenticode.ps1", "<artifact>"], childReportSha256: rawHash, evidence: publicEvidence(mode, status, before) };
  }
  const thumbprint = normalizeThumbprint(signature.signerThumbprint);
  const matched = signers.allowedSigners.some((entry) => normalizeThumbprint(entry.thumbprint) === thumbprint && entry.subject === signature.signerSubject);
  const timestamped = typeof signature.timestampThumbprint === "string" && signature.timestampThumbprint.length > 0;
  if (status !== policy.trustedStatus || !matched || (policy.requireTimestamp && !timestamped)) {
    return { passed: false, failureClass: status !== policy.trustedStatus ? "SIGNATURE_INVALID" : !matched ? "SIGNER_NOT_ALLOWED" : "SIGNATURE_TIMESTAMP_MISSING", exitCode: 1, signal: null, timedOut: false, timeoutTermination: null, command: ["powershell", "authenticode.ps1", "<artifact>"], childReportSha256: rawHash, evidence: publicEvidence(mode, status, before, matched, timestamped) };
  }
  const signtool = process.env.SIGNTOOL_PATH;
  if (!signtool) return { passed: false, failureClass: "SIGNTOOL_UNAVAILABLE", exitCode: 2, signal: null, timedOut: false, timeoutTermination: null, command: ["powershell", "authenticode.ps1", "<artifact>"], childReportSha256: rawHash, evidence: publicEvidence(mode, status, before, matched, timestamped) };
  let verify;
  try { verify = await runBoundedProcess(signtool, ["verify", "/pa", "/all", "/tw", artifactPath], { cwd: workspace, timeoutMs, maxOutputBytes: 4 * 1024 * 1024, env: safeChildEnvironment() }); }
  catch (error) { return { passed: false, failureClass: "SIGNTOOL_UNAVAILABLE", exitCode: null, signal: null, timedOut: error?.timedOut === true, timeoutTermination: error?.termination ?? null, command: ["powershell", "authenticode.ps1", "<artifact>"], childReportSha256: rawHash, evidence: publicEvidence(mode, status, before, matched, timestamped) }; }
  const passed = verify.code === 0 && await sha256File(artifactPath) === before;
  return { passed, failureClass: passed ? null : "SIGNTOOL_VERIFY_FAILED", exitCode: verify.code, signal: verify.signal, timedOut: false, timeoutTermination: null, command: ["powershell", "authenticode.ps1", "<artifact>"], childReportSha256: rawHash, evidence: publicEvidence(mode, status, before, matched, timestamped) };
}
