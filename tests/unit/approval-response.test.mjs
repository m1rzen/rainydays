import assert from "node:assert/strict";
import test from "node:test";
import { askUserConfirm, setAskUserSseCallback, submitAnswer } from "../../dist/tools/ask-user-tool.js";
import { assertSec01Probe } from "../sec01-probe.mjs";

async function answerWith(value) {
  setAskUserSseCallback((event) => {
    if (event && typeof event === "object" && "questionId" in event) {
      setTimeout(() => submitAnswer(event.questionId, value), 0);
    }
  });
  return askUserConfirm("approve exact operation?");
}

test("SEC-01 approval accepts only exact structured positive choices", async () => {
  try {
    const outcomes = [];
    for (const answer of ["确认执行", "approve", "拒绝执行", "不要确认执行", "yes, but change the arguments", "maybe approve"]) {
      outcomes.push((await answerWith(answer)).approved);
    }
    assert.deepEqual(outcomes, [true, true, false, false, false, false]);
    assertSec01Probe("SEC01-A22", "structured-approval-state", outcomes, [true, true, false, false, false, false]);
  } finally {
    setAskUserSseCallback(() => undefined);
  }
});
