import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

function identity(value) {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function canonicalPath(raw, projectRoot) {
  const absolute = raw.startsWith("file:") ? fileURLToPath(raw) : path.resolve(raw);
  const relative = path.relative(projectRoot, absolute);
  assert(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), `coverage path escapes project root: ${raw}`);
  return relative.replaceAll("\\", "/");
}

function counter(value, metric, file) {
  const item = value?.[metric];
  assert(item && Number.isSafeInteger(item.total) && item.total >= 0, `${file} ${metric}.total is invalid`);
  assert(Number.isSafeInteger(item.covered) && item.covered >= 0 && item.covered <= item.total, `${file} ${metric}.covered is invalid`);
  return { total: item.total, covered: item.covered, uncovered: item.total - item.covered };
}

export function meetsPercent(covered, total, threshold) {
  return Number.isSafeInteger(covered) && Number.isSafeInteger(total) && total > 0 && covered >= 0 && covered <= total
    && Number.isInteger(threshold) && threshold >= 0 && threshold <= 100
    && BigInt(covered) * 100n >= BigInt(total) * BigInt(threshold);
}

export function evaluateCoverageSummary(summary, scope, projectRoot) {
  assert(summary && typeof summary === "object" && !Array.isArray(summary), "coverage summary must be an object");
  const entries = new Map();
  for (const [raw, value] of Object.entries(summary)) {
    if (raw === "total") continue;
    const relative = canonicalPath(raw, projectRoot);
    const key = identity(relative);
    assert(!entries.has(key), `duplicate or remapped coverage path: ${relative}`);
    entries.set(key, { relative, value });
  }
  const expected = new Map(scope.overall.map((entry) => [identity(entry), entry]));
  const missingFiles = [...expected].filter(([key]) => !entries.has(key)).map(([, entry]) => entry);
  const unexpectedFiles = [...entries].filter(([key]) => !expected.has(key)).map(([, entry]) => entry.relative);
  const security = new Set(scope.securityCritical.map(identity));
  const files = [];
  let overallCovered = 0;
  let overallTotal = 0;
  let securityCovered = 0;
  let securityTotal = 0;
  for (const entry of scope.overall) {
    const found = entries.get(identity(entry));
    if (!found) continue;
    const lines = counter(found.value, "lines", entry);
    const branches = counter(found.value, "branches", entry);
    const isSecurityCritical = security.has(identity(entry));
    const lineMinimum = scope.perFileLineMinimum[entry] ?? null;
    const lineFloorPassed = lineMinimum === null || meetsPercent(lines.covered, lines.total, lineMinimum);
    const securityDenominatorPassed = !isSecurityCritical || branches.total > 0;
    files.push({
      path: entry,
      lines,
      branches,
      securityCritical: isSecurityCritical,
      lineMinimum,
      lineFloorPassed,
      securityDenominatorPassed,
      zeroHit: lines.covered === 0 && branches.covered === 0,
    });
    overallCovered += lines.covered;
    overallTotal += lines.total;
    assert(Number.isSafeInteger(overallCovered) && Number.isSafeInteger(overallTotal), "aggregate line counters exceed safe integers");
    if (isSecurityCritical) {
      securityCovered += branches.covered;
      securityTotal += branches.total;
      assert(Number.isSafeInteger(securityCovered) && Number.isSafeInteger(securityTotal), "aggregate branch counters exceed safe integers");
    }
  }
  const overallLines = {
    covered: overallCovered,
    total: overallTotal,
    threshold: scope.thresholds.overallLines,
    passed: meetsPercent(overallCovered, overallTotal, scope.thresholds.overallLines),
  };
  const securityBranches = {
    covered: securityCovered,
    total: securityTotal,
    threshold: scope.thresholds.securityBranches,
    passed: meetsPercent(securityCovered, securityTotal, scope.thresholds.securityBranches),
  };
  const perFilePassed = files.every((entry) => entry.lineFloorPassed && entry.securityDenominatorPassed);
  const passed = missingFiles.length === 0 && unexpectedFiles.length === 0 && files.length === scope.overall.length
    && overallLines.passed && securityBranches.passed && perFilePassed;
  return {
    passed,
    overallLines,
    securityBranches,
    files,
    zeroHitFiles: files.filter((entry) => entry.zeroHit).map((entry) => entry.path),
    missingFiles,
    unexpectedFiles,
    perFilePassed,
  };
}
