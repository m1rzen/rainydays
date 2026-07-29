import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import path from "node:path";
import { runProcess } from "../../tests/helpers.mjs";
import { copyCandidateSnapshot, publicCandidateIdentity, computeCandidateIdentity } from "./identity.mjs";

async function exists(filePath) {
  try { await access(filePath); return true; } catch { return false; }
}

async function git(projectRoot, args, timeoutMs = 30_000) {
  return runProcess("git", args, { cwd: projectRoot, timeoutMs });
}

function hostedGitHubFields(repository, commit) {
  if (process.env.GITHUB_ACTIONS !== "true") {
    return { provider: null, event: null, ref: null, refProtected: false, workflow: null, runId: null, runAttempt: null, environment: null, headShaMatches: false };
  }
  const workflowRef = process.env.GITHUB_WORKFLOW_REF ?? "";
  const prefix = repository ? `${repository}/` : "";
  const separator = workflowRef.lastIndexOf("@");
  const workflow = prefix && workflowRef.startsWith(prefix) && separator > prefix.length
    ? workflowRef.slice(prefix.length, separator)
    : null;
  const runAttempt = Number(process.env.GITHUB_RUN_ATTEMPT);
  return {
    provider: "github-actions",
    event: process.env.GITHUB_EVENT_NAME ?? null,
    ref: process.env.GITHUB_REF ?? null,
    refProtected: process.env.GITHUB_REF_PROTECTED === "true",
    workflow,
    runId: /^\d+$/.test(process.env.GITHUB_RUN_ID ?? "") ? process.env.GITHUB_RUN_ID : null,
    runAttempt: Number.isSafeInteger(runAttempt) && runAttempt > 0 ? runAttempt : null,
    environment: process.env.MINI_LUX_TRUSTED_ENVIRONMENT ?? null,
    headShaMatches: process.env.GITHUB_SHA === commit,
  };
}

export function trustedProvenanceMatches(provenance, policy) {
  return policy?.state === "configured"
    && typeof policy.repository === "string"
    && provenance.level === "git-full-history"
    && provenance.provider === policy.provider
    && provenance.repository === policy.repository
    && provenance.historyComplete === true
    && provenance.clean === true
    && provenance.event === policy.event
    && typeof provenance.ref === "string"
    && provenance.ref.length > 0
    && (!policy.requireProtectedRef || provenance.refProtected === true)
    && provenance.workflow === policy.workflow
    && typeof provenance.runId === "string"
    && /^\d+$/.test(provenance.runId)
    && Number.isSafeInteger(provenance.runAttempt)
    && provenance.runAttempt > 0
    && provenance.environment === policy.environment
    && provenance.headShaMatches === true;
}

export async function detectProvenance(projectRoot) {
  if (!await exists(path.join(projectRoot, ".git"))) {
    return {
      level: "local-snapshot-unauthenticated", provider: null, repository: null, commit: null,
      historyComplete: false, clean: true, event: null, ref: null, refProtected: false,
      workflow: null, runId: null, runAttempt: null, environment: null, headShaMatches: false,
    };
  }
  const [head, shallow, status] = await Promise.all([
    git(projectRoot, ["rev-parse", "HEAD"]),
    git(projectRoot, ["rev-parse", "--is-shallow-repository"]),
    git(projectRoot, ["status", "--porcelain=v1", "--untracked-files=all"]),
  ]);
  if (head.code !== 0 || !/^[a-f0-9]{40}$/.test(head.stdout.trim())) throw new Error("Git HEAD provenance is invalid");
  if (shallow.code !== 0 || !["true", "false"].includes(shallow.stdout.trim())) throw new Error("Git history depth is unknown");
  const commit = head.stdout.trim();
  const repository = process.env.GITHUB_ACTIONS === "true" ? process.env.GITHUB_REPOSITORY ?? null : null;
  return {
    level: "git-full-history",
    repository,
    commit,
    historyComplete: shallow.stdout.trim() === "false",
    clean: status.code === 0 && status.stdout.trim() === "",
    ...hostedGitHubFields(repository, commit),
  };
}

export async function prepareWorkspace({ projectRoot, workspace, identity, provenance }) {
  if (provenance.level === "local-snapshot-unauthenticated") {
    await copyCandidateSnapshot(projectRoot, workspace, identity);
    return { method: "manifest-copy", historyComplete: false };
  }
  assert.equal(provenance.clean, true, "Git source must be clean before cloning");
  assert.equal(provenance.historyComplete, true, "Git source must have complete history");
  const clone = await git(projectRoot, ["clone", "--quiet", "--no-local", "--no-hardlinks", projectRoot, workspace], 180_000);
  assert.equal(clone.code, 0, clone.stderr);
  const checkout = await git(workspace, ["checkout", "--quiet", "--detach", provenance.commit], 60_000);
  assert.equal(checkout.code, 0, checkout.stderr);
  const copied = await computeCandidateIdentity(workspace);
  assert.deepEqual(publicCandidateIdentity(copied), publicCandidateIdentity(identity), "clean clone candidate identity differs from source");
  return { method: "full-history-clone", historyComplete: true };
}
