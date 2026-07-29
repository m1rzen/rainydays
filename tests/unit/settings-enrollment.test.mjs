import assert from "node:assert/strict";
import test from "node:test";
import {
  executeSettingsEnrollment,
  SettingsEnrollmentStaleError,
} from "../../dist/settings-enrollment.js";
import { createSec02Recorder } from "../sec02-receipts.mjs";

const staleRecorder = await createSec02Recorder(import.meta.url, "SEC-02 concurrent winner makes the stale Settings base permanently unusable");
test.after(async () => {
  await staleRecorder.close();
});

function harness(options = {}) {
  const events = [];
  const oldAuthority = { epoch: 1, active: true };
  const candidateAuthority = { epoch: 2, active: true };
  const state = {
    config: "old-config",
    authority: oldAuthority,
    stopped: false,
    revision: 1,
  };
  const plan = {
    config: "candidate-config",
    authority: candidateAuthority,
    lease: "issued",
  };
  const adapter = {
    captureBase: () => {
      events.push("capture");
      return { config: state.config, authority: state.authority, revision: state.revision };
    },
    prepareCandidate: async () => {
      events.push("prepare");
      return plan;
    },
    isBaseCurrent: base => {
      events.push("cas");
      if (options.concurrentWinner) {
        oldAuthority.active = false;
        state.config = "winner-config";
        state.authority = { epoch: 4, active: true };
        state.revision += 1;
      }
      return !options.stale && !options.concurrentWinner
        && state.config === base.config && state.authority === base.authority && state.revision === base.revision;
    },
    retireBase: async base => {
      events.push("retire-base");
      base.authority.active = false;
      if (options.retireFailure) throw new Error("retire failed");
      state.authority = null;
    },
    persistCandidate: async candidate => {
      events.push("persist-candidate");
      if (options.persistFailure) throw new Error("persist failed");
      state.config = candidate.config;
      state.revision += 1;
    },
    publishCandidate: candidate => {
      events.push("publish-candidate");
      if (options.publicationFailure) throw new Error("publish failed");
      state.authority = candidate.authority;
    },
    commitCandidate: candidate => {
      events.push("commit-candidate");
      assert.equal(candidate.lease, "issued");
      candidate.lease = "committed";
    },
    discardCandidate: async candidate => {
      events.push("discard-candidate");
      candidate.authority.active = false;
      candidate.lease = "rolled-back";
    },
    recoverBase: async base => {
      events.push("recover-base");
      if (options.recoveryFailure) throw new Error("recovery failed");
      state.config = base.config;
      state.revision += 1;
      state.authority = { epoch: 3, active: true };
    },
    stopFailClosed: () => {
      events.push("stop");
      state.stopped = true;
      state.authority = null;
    },
  };
  return { adapter, events, state, oldAuthority, candidateAuthority, plan };
}

test("SEC-02 Settings enrollment publishes only after retire and persistence", async () => {
  const probe = harness();
  await executeSettingsEnrollment(probe.adapter);
  assert.deepEqual(probe.events, ["capture", "prepare", "cas", "retire-base", "persist-candidate", "publish-candidate", "commit-candidate"]);
  assert.equal(probe.oldAuthority.active, false);
  assert.equal(probe.state.authority, probe.candidateAuthority);
  assert.equal(probe.state.config, "candidate-config");
  assert.equal(probe.plan.lease, "committed");
  assert.equal(probe.state.stopped, false);
});

test("SEC-02 stale Settings candidate is discarded before retire, persist or publication", async () => {
  const probe = harness({ stale: true });
  await assert.rejects(() => executeSettingsEnrollment(probe.adapter), error => error instanceof SettingsEnrollmentStaleError);
  assert.deepEqual(probe.events, ["capture", "prepare", "cas", "discard-candidate"]);
  assert.equal(probe.oldAuthority.active, true);
  assert.equal(probe.state.authority, probe.oldAuthority);
  assert.equal(probe.state.config, "old-config");
  assert.equal(probe.plan.lease, "rolled-back");
});

test("SEC-02 concurrent winner makes the stale Settings base permanently unusable", async () => {
  const probe = harness({ concurrentWinner: true });
  await assert.rejects(() => executeSettingsEnrollment(probe.adapter), error => error instanceof SettingsEnrollmentStaleError);
  assert.deepEqual(probe.events, ["capture", "prepare", "cas", "discard-candidate"]);
  assert.equal(probe.oldAuthority.active, false);
  assert.equal(probe.candidateAuthority.active, false);
  assert.equal(probe.state.config, "winner-config");
  assert.equal(probe.state.authority.epoch, 4);
  assert.notEqual(probe.state.authority, probe.oldAuthority);
  assert.equal(probe.plan.lease, "rolled-back");
  if (staleRecorder.enabled) {
    await staleRecorder.observe("SEC02-P31-concurrent-stale-base", {
      diskRuntimeConsistent: probe.state.config === "winner-config" && probe.state.authority.epoch === 4,
      retiredAuthorityReactivated: probe.oldAuthority.active,
      oldTokensStale: !probe.oldAuthority.active,
      staleCandidatePublished: probe.state.authority === probe.candidateAuthority,
      finalState: "candidate-new-epoch",
    });
  }
});

test("SEC-02 persistence failure restores old config with a fresh authority epoch", async () => {
  const probe = harness({ persistFailure: true });
  await assert.rejects(() => executeSettingsEnrollment(probe.adapter), /persist failed/);
  assert.deepEqual(probe.events, ["capture", "prepare", "cas", "retire-base", "persist-candidate", "discard-candidate", "recover-base"]);
  assert.equal(probe.oldAuthority.active, false);
  assert.equal(probe.candidateAuthority.active, false);
  assert.equal(probe.state.config, "old-config");
  assert.equal(probe.state.authority.epoch, 3);
  assert.notEqual(probe.state.authority, probe.oldAuthority);
  assert.equal(probe.state.stopped, false);
});

test("SEC-02 publication failure restores disk and runtime using a fresh old-config authority", async () => {
  const probe = harness({ publicationFailure: true });
  await assert.rejects(() => executeSettingsEnrollment(probe.adapter), /publish failed/);
  assert.deepEqual(probe.events, ["capture", "prepare", "cas", "retire-base", "persist-candidate", "publish-candidate", "discard-candidate", "recover-base"]);
  assert.equal(probe.state.config, "old-config");
  assert.equal(probe.state.authority.epoch, 3);
  assert.equal(probe.oldAuthority.active, false);
  assert.equal(probe.candidateAuthority.active, false);
  assert.equal(probe.plan.lease, "rolled-back");
});

test("SEC-02 retirement or recovery failure leaves the runtime stopped fail-closed", async () => {
  const retirement = harness({ retireFailure: true });
  await assert.rejects(() => executeSettingsEnrollment(retirement.adapter), /retire failed/);
  assert.deepEqual(retirement.events, ["capture", "prepare", "cas", "retire-base", "discard-candidate", "stop"]);
  assert.equal(retirement.state.stopped, true);
  assert.equal(retirement.state.authority, null);

  const recovery = harness({ persistFailure: true, recoveryFailure: true });
  await assert.rejects(
    () => executeSettingsEnrollment(recovery.adapter),
    error => error instanceof AggregateError && /runtime recovery failed/.test(error.message)
  );
  assert.deepEqual(recovery.events, ["capture", "prepare", "cas", "retire-base", "persist-candidate", "discard-candidate", "recover-base", "stop"]);
  assert.equal(recovery.state.stopped, true);
  assert.equal(recovery.state.authority, null);
});
