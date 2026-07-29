import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { sha256File } from "../../tests/helpers.mjs";
import { resolveNpmCli, runBoundedProcess, safeChildEnvironment } from "./process.mjs";
import { sha256 } from "./identity.mjs";

function auditArgs(scope, registry) {
  const args = ["audit", "--registry", registry, "--audit-level=high", "--json"];
  if (scope === "production") args.splice(1, 0, "--omit=dev");
  return args;
}

export function validateAuditReport(report, policy) {
  assert(report && typeof report === "object" && !Array.isArray(report));
  assert.equal(report.auditReportVersion, policy.auditReportVersion);
  assert(report.vulnerabilities && typeof report.vulnerabilities === "object" && !Array.isArray(report.vulnerabilities));
  const metadata = report.metadata;
  const counts = metadata?.vulnerabilities;
  const keys = ["info", "low", "moderate", "high", "critical", "total"];
  assert(counts && typeof counts === "object");
  assert.deepEqual(Object.keys(counts).sort(), [...keys].sort());
  for (const key of keys) assert(Number.isSafeInteger(counts[key]) && counts[key] >= 0, `audit count ${key} is invalid`);
  assert.equal(counts.total, counts.info + counts.low + counts.moderate + counts.high + counts.critical);
  assert.equal(Object.keys(report.vulnerabilities).length, counts.total, "audit vulnerability count is inconsistent");
  const recomputed = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const [name, finding] of Object.entries(report.vulnerabilities)) {
    assert.equal(finding.name, name);
    assert(Object.hasOwn(recomputed, finding.severity), `unsupported audit severity: ${finding.severity}`);
    assert(Array.isArray(finding.via));
    assert(Array.isArray(finding.nodes));
    assert.equal(typeof finding.range, "string");
    recomputed[finding.severity] += 1;
  }
  for (const key of Object.keys(recomputed)) assert.equal(counts[key], recomputed[key], `audit severity ${key} is inconsistent`);
  assert(metadata.dependencies && Number.isSafeInteger(metadata.dependencies.total) && metadata.dependencies.total > 0);
  return {
    auditReportVersion: report.auditReportVersion,
    dependencyTotal: metadata.dependencies.total,
    counts: { info: counts.info, low: counts.low, moderate: counts.moderate, high: counts.high, critical: counts.critical, total: counts.total },
  };
}

function failure(error, args, evidence, overrideClass = null) {
  const timedOut = error?.timedOut === true;
  return {
    passed: false,
    failureClass: overrideClass ?? (timedOut ? (error.code === "PROCESS_TIMEOUT_CLEANUP_FAILED" ? "TIMEOUT_CLEANUP_FAILED" : "TIMEOUT") : error?.code === "PROCESS_OUTPUT_LIMIT" ? "SCA_OUTPUT_LIMIT" : "SCA_UNAVAILABLE"),
    exitCode: null,
    signal: null,
    timedOut,
    timeoutTermination: error?.termination ?? null,
    command: ["npm", ...args],
    childReportSha256: null,
    evidence,
  };
}

export async function runSca({ workspace, scope, policy, evidenceDirectory, timeoutMs = 120_000 }) {
  assert(["production", "full"].includes(scope));
  const args = auditArgs(scope, policy.registry);
  const packagePath = path.join(workspace, "package.json");
  const lockPath = path.join(workspace, "package-lock.json");
  const packageBefore = await sha256File(packagePath);
  const lockBefore = await sha256File(lockPath);
  const baseEvidence = {
    status: "unavailable",
    registry: policy.registry,
    npmVersion: null,
    packageJsonSha256: packageBefore,
    lockfileSha256: lockBefore,
    inputsUnchanged: true,
    auditReportVersion: null,
    dependencyTotal: null,
    counts: null,
    exceptionCount: policy.exceptions.length,
    reportSha256: null,
  };
  let npmCli;
  try { npmCli = await resolveNpmCli(); }
  catch (error) { return failure(error, args, baseEvidence); }
  const userConfig = path.join(evidenceDirectory, `npm-${scope}.npmrc`);
  await writeFile(userConfig, `registry=${policy.registry}\naudit=true\n`, { encoding: "utf8", flag: "wx" });
  const env = safeChildEnvironment({ npm_config_userconfig: userConfig, npm_config_registry: policy.registry });
  let version;
  try { version = await runBoundedProcess(process.execPath, [npmCli, "--version"], { cwd: workspace, env, timeoutMs: 30_000, maxOutputBytes: 1024 * 1024 }); }
  catch (error) { return failure(error, args, baseEvidence); }
  const npmVersion = version.stdout.trim();
  const versionEvidence = { ...baseEvidence, npmVersion };
  if (version.code !== 0 || npmVersion !== policy.toolchainVersion) return failure(new Error("npm version mismatch"), args, { ...versionEvidence, status: "invalid" }, "SCA_TOOL_VERSION");
  let result;
  try { result = await runBoundedProcess(process.execPath, [npmCli, ...args], { cwd: workspace, env, timeoutMs }); }
  catch (error) { return failure(error, args, versionEvidence); }
  let report;
  let summary;
  try {
    report = JSON.parse(result.stdout);
    summary = validateAuditReport(report, policy);
  } catch {
    return failure(new Error("invalid audit report"), args, { ...versionEvidence, status: "invalid" }, result.stdout?.trim() ? "SCA_REPORT_INVALID" : "SCA_UNAVAILABLE");
  }
  const packageAfter = await sha256File(packagePath);
  const lockAfter = await sha256File(lockPath);
  const inputsUnchanged = packageBefore === packageAfter && lockBefore === lockAfter;
  const reportBytes = `${JSON.stringify(report, null, 2)}\n`;
  await writeFile(path.join(evidenceDirectory, `sca-${scope}.json`), reportBytes, { encoding: "utf8", flag: "wx" });
  const reportSha256 = sha256(reportBytes);
  const evidence = {
    status: "valid",
    registry: policy.registry,
    npmVersion,
    packageJsonSha256: packageBefore,
    lockfileSha256: lockBefore,
    inputsUnchanged,
    auditReportVersion: summary.auditReportVersion,
    dependencyTotal: summary.dependencyTotal,
    counts: summary.counts,
    exceptionCount: policy.exceptions.length,
    reportSha256,
  };
  const blocked = summary.counts.critical > policy.maximumCritical || summary.counts.high > policy.maximumHigh;
  const exitConsistent = blocked ? result.code === 1 : result.code === 0;
  const passed = !blocked && inputsUnchanged && exitConsistent;
  return {
    passed,
    failureClass: passed ? null : !inputsUnchanged ? "SCA_INPUT_MUTATION" : blocked ? "SCA_FINDINGS" : "SCA_EXIT_CONTRADICTION",
    exitCode: passed ? 0 : result.code,
    signal: result.signal,
    timedOut: false,
    timeoutTermination: null,
    command: ["npm", ...args],
    childReportSha256: reportSha256,
    evidence,
  };
}
