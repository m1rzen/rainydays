import assert from "node:assert/strict";
import { lstat, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./identity.mjs";
import { validateGov04Marker, validateGov04Report } from "./report-schema.mjs";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative !== "" && !relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative);
}

async function regularDirectory(directory, root, field) {
  const info = await lstat(directory);
  assert(info.isDirectory() && !info.isSymbolicLink(), `${field} must be a regular directory`);
  const resolved = await realpath(directory);
  assert(contained(root, resolved), `${field} escapes retry evidence root`);
  return resolved;
}

async function regularFile(filePath, root, field) {
  const info = await lstat(filePath);
  assert(info.isFile() && !info.isSymbolicLink(), `${field} must be a regular file`);
  const resolved = await realpath(filePath);
  assert(contained(root, resolved), `${field} escapes retry evidence root`);
  return resolved;
}

export async function resolveRetryEvidence({ runBase, retryOf }) {
  if (retryOf === null) return null;
  assert(uuidPattern.test(retryOf), "retry runId must be a UUID v4");
  const resolvedBase = await realpath(runBase);
  const priorRunRoot = await regularDirectory(path.join(resolvedBase, retryOf), resolvedBase, "retry run root");
  const reportsDirectory = await regularDirectory(path.join(priorRunRoot, "reports"), priorRunRoot, "retry reports directory");
  const reportPath = await regularFile(path.join(reportsDirectory, "gov04-report.json"), reportsDirectory, "retry report");
  const markerPath = await regularFile(path.join(reportsDirectory, "gov04-final-marker.json"), reportsDirectory, "retry marker");
  const [reportBytes, markerBytes] = await Promise.all([readFile(reportPath), readFile(markerPath)]);
  const report = JSON.parse(reportBytes.toString("utf8"));
  const marker = JSON.parse(markerBytes.toString("utf8"));
  validateGov04Report(report);
  await validateGov04Marker(marker, reportPath, report.artifact?.sha256 ?? null);
  assert.equal(report.runId, retryOf, "retry report runId differs from requested run");
  assert.equal(marker.runId, retryOf, "retry marker runId differs from requested run");
  assert.equal(report.state, "failed", "only a failed GOV-04 run may be retried");
  return {
    runId: retryOf,
    priorReportSha256: sha256(reportBytes),
    priorMarkerSha256: sha256(markerBytes),
    priorCandidateId: report.candidate.releaseCandidateId,
    priorState: report.state,
  };
}
