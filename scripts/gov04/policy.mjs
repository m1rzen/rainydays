import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { sha256 } from "./identity.mjs";

function exactKeys(value, expected, field) {
  assert(value && typeof value === "object" && !Array.isArray(value), `${field} must be an object`);
  assert.deepEqual(Object.keys(value).sort(), [...expected].sort(), `${field} keys differ`);
}

export async function loadGov04Policy(projectRoot) {
  const policyPath = path.join(projectRoot, "parity", "policies", "gov-04-policy.json");
  const signerPath = path.join(projectRoot, "parity", "policies", "gov-04-signer-allowlist.json");
  const policyBytes = await readFile(policyPath);
  const signerBytes = await readFile(signerPath);
  const policy = JSON.parse(policyBytes.toString("utf8"));
  const signers = JSON.parse(signerBytes.toString("utf8"));
  exactKeys(policy, ["schemaVersion", "taskId", "toolchain", "sca", "secretScan", "signature", "trustedRelease", "artifactRetentionDays", "retry"], "GOV-04 policy");
  assert.equal(policy.schemaVersion, 1);
  assert.equal(policy.taskId, "GOV-04");
  exactKeys(policy.toolchain, ["node", "npm", "typescript", "eslint", "c8"], "toolchain policy");
  for (const value of Object.values(policy.toolchain)) assert.match(value, /^\d+\.\d+\.\d+$/);
  exactKeys(policy.sca, ["registry", "auditReportVersion", "maximumCritical", "maximumHigh", "exceptions"], "SCA policy");
  assert.equal(policy.sca.registry, "https://registry.npmjs.org");
  assert.equal(policy.sca.auditReportVersion, 2);
  assert.equal(policy.sca.maximumCritical, 0);
  assert.equal(policy.sca.maximumHigh, 0);
  assert.deepEqual(policy.sca.exceptions, []);
  exactKeys(policy.secretScan, ["tool", "version", "windowsX64ZipUrl", "windowsX64ZipSha256", "windowsX64ExecutableSha256", "redactionPercent", "allowlist"], "secret scan policy");
  assert.equal(policy.secretScan.tool, "gitleaks");
  assert.match(policy.secretScan.windowsX64ZipSha256, /^[a-f0-9]{64}$/);
  assert.match(policy.secretScan.windowsX64ExecutableSha256, /^[a-f0-9]{64}$/);
  assert.equal(policy.secretScan.redactionPercent, 100);
  assert.deepEqual(policy.secretScan.allowlist, []);
  exactKeys(policy.signature, ["unsignedTestStatus", "trustedStatus", "requireTimestamp", "signerAllowlistPath"], "signature policy");
  assert.equal(policy.signature.unsignedTestStatus, "NotSigned");
  assert.equal(policy.signature.trustedStatus, "Valid");
  assert.equal(policy.signature.requireTimestamp, true);
  assert.equal(policy.signature.signerAllowlistPath, "parity/policies/gov-04-signer-allowlist.json");
  exactKeys(policy.trustedRelease, ["state", "provider", "repository", "workflow", "event", "environment", "requireProtectedRef"], "trusted release policy");
  assert(["unconfigured", "configured"].includes(policy.trustedRelease.state));
  assert.equal(policy.trustedRelease.provider, "github-actions");
  assert(policy.trustedRelease.repository === null || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(policy.trustedRelease.repository));
  assert.equal(policy.trustedRelease.workflow, ".github/workflows/gov-04-trusted-release.yml");
  assert.equal(policy.trustedRelease.event, "workflow_dispatch");
  assert.equal(policy.trustedRelease.environment, "mini-lux-trusted-release");
  assert.equal(policy.trustedRelease.requireProtectedRef, true);
  assert.equal(policy.trustedRelease.state === "configured", policy.trustedRelease.repository !== null);
  exactKeys(policy.retry, ["maximumAttemptsPerStep", "allowWithinRunRetry"], "retry policy");
  assert.equal(policy.retry.maximumAttemptsPerStep, 1);
  assert.equal(policy.retry.allowWithinRunRetry, false);
  exactKeys(signers, ["schemaVersion", "taskId", "state", "allowedSigners", "note"], "signer allowlist");
  assert.equal(signers.schemaVersion, 1);
  assert.equal(signers.taskId, "GOV-04");
  assert(["unconfigured", "configured"].includes(signers.state));
  assert(Array.isArray(signers.allowedSigners));
  for (const signer of signers.allowedSigners) {
    exactKeys(signer, ["thumbprint", "subject"], "allowed signer");
    assert.match(signer.thumbprint, /^[A-F0-9]{40}$/);
    assert.equal(typeof signer.subject, "string");
  }
  assert.equal(signers.state === "configured", signers.allowedSigners.length > 0);
  return {
    policy,
    signers,
    public: {
      path: "parity/policies/gov-04-policy.json",
      sha256: sha256(policyBytes),
      signerAllowlistSha256: sha256(signerBytes),
      trustedRelease: { ...policy.trustedRelease },
    },
  };
}
