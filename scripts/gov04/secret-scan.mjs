import assert from "node:assert/strict";
import { lstat, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runBoundedProcess, safeChildEnvironment } from "./process.mjs";
import { sha256 } from "./identity.mjs";

export async function validateGitleaksBinary(executable, policy) {
  let info;
  let bytes;
  try {
    info = await lstat(executable);
    bytes = await readFile(executable);
  } catch { throw Object.assign(new Error("Gitleaks executable is unavailable"), { code: "SECRET_SCANNER_UNAVAILABLE" }); }
  if (info.isSymbolicLink() || !info.isFile()) throw Object.assign(new Error("Gitleaks executable is not a regular file"), { code: "SECRET_SCANNER_CHECKSUM" });
  const executableSha256 = sha256(bytes);
  if (executableSha256 !== policy.windowsX64ExecutableSha256) throw Object.assign(new Error("Gitleaks executable hash differs from policy"), { code: "SECRET_SCANNER_CHECKSUM" });
  let version;
  try { version = await runBoundedProcess(executable, ["version"], { timeoutMs: 15_000, maxOutputBytes: 1024 * 1024, env: safeChildEnvironment() }); }
  catch (error) { throw Object.assign(new Error("Gitleaks version check failed"), { code: error?.timedOut ? "SECRET_SCANNER_TIMEOUT" : "SECRET_SCANNER_UNAVAILABLE", cause: error }); }
  if (version.code !== 0 || version.stdout.trim() !== policy.version) throw Object.assign(new Error("Gitleaks version differs from policy"), { code: "SECRET_SCANNER_VERSION" });
  return { executableSha256, version: version.stdout.trim() };
}

function safeFindingPath(value) {
  assert.equal(typeof value, "string");
  const normalized = value.replaceAll("\\", "/");
  assert(normalized.length > 0 && !normalized.includes("\0") && !path.posix.isAbsolute(normalized) && !/^[A-Za-z]:/.test(normalized));
  assert.equal(path.posix.normalize(normalized), normalized);
  assert(!normalized.startsWith("../") && !normalized.includes("/../"));
  return normalized;
}

function normalizeFindings(findings) {
  return findings.map((finding) => {
    assert(finding && typeof finding === "object" && !Array.isArray(finding));
    assert.equal(typeof finding.RuleID, "string");
    assert(Number.isSafeInteger(finding.StartLine) && finding.StartLine >= 0);
    assert(Number.isSafeInteger(finding.EndLine) && finding.EndLine >= finding.StartLine);
    assert(finding.Commit === "" || /^[a-f0-9]{40}$/.test(finding.Commit));
    assert.equal(typeof finding.Fingerprint, "string");
    return {
      ruleId: finding.RuleID,
      path: safeFindingPath(finding.File),
      startLine: finding.StartLine,
      endLine: finding.EndLine,
      commit: finding.Commit || null,
      fingerprint: finding.Fingerprint,
    };
  });
}

function baseEvidence(policy, historyComplete) {
  return {
    status: "unavailable",
    scanner: "gitleaks",
    version: null,
    executableSha256: null,
    findings: null,
    redactionPercent: policy.redactionPercent,
    redacted: false,
    historyComplete,
    reportSha256: null,
  };
}

function failure({ failureClass, command, evidence, exitCode = null, signal = null, timedOut = false, timeoutTermination = null }) {
  return { passed: false, failureClass, exitCode, signal, timedOut, timeoutTermination, command, childReportSha256: null, evidence };
}

export async function runSecretScan({ scanRoot, workspace, history, historyComplete, policy, evidenceDirectory, executable, timeoutMs = 120_000 }) {
  const command = ["gitleaks", history ? "git" : "dir", ".", "--redact=100"];
  let scanner;
  try { scanner = await validateGitleaksBinary(executable, policy); }
  catch (error) {
    return failure({
      failureClass: error?.code ?? "SECRET_SCANNER_UNAVAILABLE",
      command,
      evidence: baseEvidence(policy, history ? historyComplete : false),
      timedOut: error?.code === "SECRET_SCANNER_TIMEOUT",
      timeoutTermination: error?.cause?.termination ?? null,
    });
  }
  const availableEvidence = {
    ...baseEvidence(policy, history ? historyComplete : false),
    version: scanner.version,
    executableSha256: scanner.executableSha256,
    redacted: true,
  };
  if (history && !historyComplete) {
    return { ...failure({ failureClass: "SECRET_HISTORY_UNAVAILABLE", command, evidence: { ...availableEvidence, status: "unsupported-history" }, exitCode: 2 }), unsupported: true };
  }
  const kind = history ? "history" : "current";
  const targetRoot = history ? workspace : scanRoot;
  const taintedPath = path.join(evidenceDirectory, `.secret-${kind}.${process.pid}.tainted.json`);
  const actualArgs = [
    history ? "git" : "dir",
    ".",
    `--config=${path.join(scanRoot, ".gitleaks.toml")}`,
    "--report-format=json",
    `--report-path=${taintedPath}`,
    `--redact=${policy.redactionPercent}`,
    "--log-level=error",
    "--no-banner",
    "--no-color",
    "--exit-code=23",
    `--timeout=${Math.max(1, Math.floor((timeoutMs - 10_000) / 1000))}`,
  ];
  let result;
  try { result = await runBoundedProcess(executable, actualArgs, { cwd: targetRoot, timeoutMs, env: safeChildEnvironment() }); }
  catch (error) {
    await rm(taintedPath, { force: true });
    const timedOut = error?.timedOut === true;
    return failure({
      failureClass: timedOut ? (error.code === "PROCESS_TIMEOUT_CLEANUP_FAILED" ? "TIMEOUT_CLEANUP_FAILED" : "TIMEOUT") : error?.code === "PROCESS_OUTPUT_LIMIT" ? "SECRET_OUTPUT_LIMIT" : "SECRET_SCANNER_UNAVAILABLE",
      command,
      evidence: availableEvidence,
      timedOut,
      timeoutTermination: error?.termination ?? null,
    });
  }
  let rawFindings;
  try {
    rawFindings = JSON.parse(await readFile(taintedPath, "utf8"));
    assert(Array.isArray(rawFindings));
  } catch {
    await rm(taintedPath, { force: true });
    return failure({ failureClass: "SECRET_REPORT_INVALID", command, evidence: { ...availableEvidence, status: "invalid" }, exitCode: result.code, signal: result.signal });
  }
  let findings;
  let rawRedacted;
  try {
    rawRedacted = rawFindings.every((finding) => typeof finding.Secret === "string" && /^REDACTED(?:$|[-*])/i.test(finding.Secret));
    findings = normalizeFindings(rawFindings);
  } catch {
    await rm(taintedPath, { force: true });
    return failure({ failureClass: "SECRET_REPORT_INVALID", command, evidence: { ...availableEvidence, status: "invalid" }, exitCode: result.code, signal: result.signal });
  }
  await rm(taintedPath, { force: true });
  const normalized = { schemaVersion: 1, scope: kind, findings };
  const normalizedBytes = `${JSON.stringify(normalized, null, 2)}\n`;
  assert(!/"(?:Secret|Match|Author|Email|Message)"\s*:/.test(normalizedBytes), "normalized secret report contains a forbidden field");
  const reportPath = path.join(evidenceDirectory, `secret-${kind}.json`);
  await writeFile(reportPath, normalizedBytes, { encoding: "utf8", flag: "wx" });
  const reportSha256 = sha256(normalizedBytes);
  const executableAfter = sha256(await readFile(executable));
  const toolUnchanged = executableAfter === scanner.executableSha256;
  const exitConsistent = findings.length === 0 ? result.code === 0 : result.code === 23;
  const passed = findings.length === 0 && rawRedacted && exitConsistent && toolUnchanged;
  const evidence = {
    ...availableEvidence,
    status: "valid",
    findings: findings.length,
    redacted: rawRedacted,
    reportSha256,
  };
  return {
    passed,
    failureClass: passed ? null : !toolUnchanged ? "SECRET_SCANNER_CHECKSUM" : !rawRedacted ? "SECRET_REDACTION_FAILED" : findings.length > 0 ? "SECRET_FINDINGS" : "SECRET_EXIT_CONTRADICTION",
    exitCode: passed ? 0 : result.code,
    signal: result.signal,
    timedOut: false,
    timeoutTermination: null,
    command,
    childReportSha256: reportSha256,
    evidence,
  };
}
