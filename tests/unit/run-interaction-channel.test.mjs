import assert from "node:assert/strict";
import test from "node:test";

const {
  askUserConfirm,
  askUserDef,
  askUserExec,
  askUserQuestion,
  cancelRunInteraction,
  emitRunNotification,
  getRunInteractionIdentity,
  runOutsideInteractionChannel,
  runWithInteractionChannel,
  setAskUserSseCallback,
  submitAnswer,
} = await import("../../dist/tools/ask-user-tool.js");

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

test("RT-01 run-local questions bind random IDs to exact session and run identities", async () => {
  const firstEvent = deferred();
  const secondEvent = deferred();
  const first = runWithInteractionChannel(
    { sessionId: "session-a", runId: "run-a" },
    { emit: event => firstEvent.resolve(event) },
    () => askUserQuestion("first question", ["a"], 5_000)
  );
  const second = runWithInteractionChannel(
    { sessionId: "session-b", runId: "run-b" },
    { emit: event => secondEvent.resolve(event) },
    () => askUserQuestion("second question", ["b"], 5_000)
  );

  const [firstQuestion, secondQuestion] = await Promise.all([firstEvent.promise, secondEvent.promise]);
  assert.match(firstQuestion.questionId, /^q_[a-f0-9]{32}$/u);
  assert.match(secondQuestion.questionId, /^q_[a-f0-9]{32}$/u);
  assert.notEqual(firstQuestion.questionId, secondQuestion.questionId);
  assert.deepEqual(
    [firstQuestion.sessionId, firstQuestion.runId, secondQuestion.sessionId, secondQuestion.runId],
    ["session-a", "run-a", "session-b", "run-b"]
  );

  assert.equal(submitAnswer(firstQuestion.questionId, "legacy bypass"), false);
  assert.equal(submitAnswer("session-a", "run-b", firstQuestion.questionId, "cross-run bypass"), false);
  assert.equal(submitAnswer("session-b", "run-b", firstQuestion.questionId, "cross-session bypass"), false);
  assert.equal(submitAnswer("session-a", "run-a", firstQuestion.questionId, "first answer"), true);
  assert.equal(submitAnswer("session-b", "run-b", secondQuestion.questionId, "second answer"), true);
  assert.deepEqual(await Promise.all([first, second]), ["first answer", "second answer"]);
  assert.equal(submitAnswer("session-a", "run-a", firstQuestion.questionId, "duplicate"), false);
});

test("RT-01 disconnect cancellation settles only the selected run", async () => {
  const firstEvent = deferred();
  const secondEvent = deferred();
  let lateNotification;
  const first = runWithInteractionChannel(
    { sessionId: "session", runId: "run-cancel" },
    { emit: event => firstEvent.resolve(event) },
    async () => {
      const initial = await askUserQuestion("cancel this", [], 5_000);
      const late = await askUserQuestion("must not reopen", [], 5_000);
      lateNotification = emitRunNotification("late", "must not emit");
      return [initial, late];
    }
  );
  const second = runWithInteractionChannel(
    { sessionId: "session", runId: "run-keep" },
    { emit: event => secondEvent.resolve(event) },
    () => askUserQuestion("keep this", [], 5_000)
  );
  const [, secondQuestion] = await Promise.all([firstEvent.promise, secondEvent.promise]);

  assert.equal(cancelRunInteraction({ sessionId: "session", runId: "other" }), false);
  assert.equal(cancelRunInteraction({ sessionId: "session", runId: "run-cancel" }), true);
  assert.deepEqual(await first, ["(当前运行连接已断开)", "(当前运行连接已断开)"]);
  assert.equal(lateNotification, false);
  assert.equal(submitAnswer("session", "run-keep", secondQuestion.questionId, "still isolated"), true);
  assert.equal(await second, "still isolated");
});

test("RT-01 notifications emit only through the current run channel", async () => {
  const first = [];
  const second = [];
  await Promise.all([
    runWithInteractionChannel(
      { sessionId: "session-a", runId: "notify-a" },
      { emit: event => first.push(event) },
      async () => assert.equal(emitRunNotification("A", "body-a"), true)
    ),
    runWithInteractionChannel(
      { sessionId: "session-b", runId: "notify-b" },
      { emit: event => second.push(event) },
      async () => assert.equal(emitRunNotification("B", "body-b"), true)
    ),
  ]);
  assert.deepEqual(first.map(event => [event.sessionId, event.runId, event.title, event.body]), [["session-a", "notify-a", "A", "body-a"]]);
  assert.deepEqual(second.map(event => [event.sessionId, event.runId, event.title, event.body]), [["session-b", "notify-b", "B", "body-b"]]);
  assert.equal(emitRunNotification("outside", "legacy boundary"), null);
});

test("RT-01 legacy fallback remains isolated from the secure run-local answer API", async () => {
  try {
    setAskUserSseCallback(event => {
      assert.equal("sessionId" in event, false);
      assert.equal("runId" in event, false);
      assert.equal(submitAnswer(event.questionId, "确认执行"), true);
    });
    assert.deepEqual(await askUserConfirm("legacy confirmation"), { approved: true, answer: "确认执行" });
  } finally {
    setAskUserSseCallback(() => undefined);
  }
});

test("RT-01 detached async descendants cannot reopen a completed run channel", async () => {
  const events = [];
  let detached;
  await runWithInteractionChannel(
    { sessionId: "session", runId: "detached-run" },
    { emit: event => events.push(event) },
    async () => {
      detached = new Promise(resolve => {
        setImmediate(async () => resolve({
          answer: await askUserQuestion("must not reopen", [], 5_000),
          notification: emitRunNotification("must not emit", "closed"),
        }));
      });
      return "completed";
    }
  );
  assert.deepEqual(await detached, { answer: "(当前运行已结束)", notification: false });
  assert.deepEqual(events, []);
});

test("EVT-02 background event flow can explicitly detach an inherited run-local scope", async () => {
  let background;
  await runWithInteractionChannel(
    { sessionId: "origin", runId: "origin-run" },
    { emit: () => undefined },
    async () => {
      assert.deepEqual(getRunInteractionIdentity(), { sessionId: "origin", runId: "origin-run" });
      background = new Promise((resolve, reject) => {
        setImmediate(() => {
          try {
            resolve(runOutsideInteractionChannel(() => ({
              identity: getRunInteractionIdentity(),
              nested: runWithInteractionChannel(
                { sessionId: "target", runId: "event-run" },
                { emit: () => undefined },
                () => "started",
              ),
            })));
          } catch (error) { reject(error); }
        });
      });
    },
  );
  const detached = await background;
  assert.equal(detached.identity, null);
  assert.equal(await detached.nested, "started");
  assert.throws(() => runOutsideInteractionChannel(null), /action is invalid/u);
});

test("RT-01 run completion cancels questions left pending by that run", async () => {
  let question;
  let pending;
  const completed = await runWithInteractionChannel(
    { sessionId: "session", runId: "short-run" },
    { emit: event => { question = event; } },
    async () => {
      pending = askUserQuestion("left pending", [], 5_000);
      await Promise.resolve();
      return "run returned";
    }
  );
  assert.equal(completed, "run returned");
  assert(question);
  assert.equal(await pending, "(当前运行已结束)");
  assert.equal(submitAnswer("session", "short-run", question.questionId, "late answer"), false);
});

test("RT-01 interaction channel rejects malformed identities, handlers, actions and pre-aborted runs", async () => {
  const emit = () => undefined;
  const action = () => undefined;
  await assert.rejects(() => runWithInteractionChannel({ sessionId: "", runId: "run" }, { emit }, action), /sessionId is invalid/u);
  await assert.rejects(() => runWithInteractionChannel({ sessionId: "session", runId: "x\0y" }, { emit }, action), /runId is invalid/u);
  await assert.rejects(() => runWithInteractionChannel({ sessionId: "s".repeat(257), runId: "run" }, { emit }, action), /sessionId is invalid/u);
  await assert.rejects(() => runWithInteractionChannel({ sessionId: "session", runId: "run" }, null, action), /emit handler is invalid/u);
  await assert.rejects(() => runWithInteractionChannel({ sessionId: "session", runId: "run" }, { emit: null }, action), /emit handler is invalid/u);
  await assert.rejects(() => runWithInteractionChannel({ sessionId: "session", runId: "run" }, { emit, notify: true }, action), /notification handler is invalid/u);
  await assert.rejects(() => runWithInteractionChannel({ sessionId: "session", runId: "run" }, { emit }, null), /action is invalid/u);

  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => runWithInteractionChannel({ sessionId: "session", runId: "aborted" }, { emit, signal: controller.signal }, action),
    /channel is aborted/u
  );
  assert.throws(() => cancelRunInteraction({ sessionId: "", runId: "run" }), /sessionId is invalid/u);
  assert.equal(getRunInteractionIdentity(), null);
});

test("RT-01 interaction scopes reject nesting and duplicate active identities", async () => {
  const hold = deferred();
  const started = deferred();
  const active = runWithInteractionChannel(
    { sessionId: "session", runId: "duplicate" },
    { emit: () => undefined },
    async () => {
      started.resolve();
      await hold.promise;
      return "released";
    }
  );
  await started.promise;
  await assert.rejects(
    () => runWithInteractionChannel({ sessionId: "session", runId: "duplicate" }, { emit: () => undefined }, () => undefined),
    /identity is already active/u
  );
  hold.resolve();
  assert.equal(await active, "released");

  await runWithInteractionChannel(
    { sessionId: "session", runId: "outer" },
    { emit: () => undefined },
    async () => {
      const identity = getRunInteractionIdentity();
      assert.deepEqual(identity, { sessionId: "session", runId: "outer" });
      assert(Object.isFrozen(identity));
      await assert.rejects(
        () => runWithInteractionChannel({ sessionId: "session", runId: "inner" }, { emit: () => undefined }, () => undefined),
        /already active in this async context/u
      );
    }
  );
});

test("RT-01 AbortSignal settles only that run and removes its listener", async () => {
  const controller = new AbortController();
  const emitted = deferred();
  const result = runWithInteractionChannel(
    { sessionId: "session", runId: "abort-pending" },
    { emit: event => emitted.resolve(event), signal: controller.signal },
    () => askUserQuestion("abort me", [], 5_000)
  );
  const event = await emitted.promise;
  controller.abort();
  assert.equal(await result, "(当前运行已取消)");
  assert.equal(submitAnswer("session", "abort-pending", event.questionId, "late"), false);
  assert.equal(cancelRunInteraction({ sessionId: "session", runId: "abort-pending" }), false);
});

test("RT-04 ask_user closes the listener-registration race without emitting a stale question", async () => {
  const reason = new Error("abort during listener registration");
  let aborted = false;
  const signal = {
    get aborted() { return aborted; },
    get reason() { return reason; },
    addEventListener(type, listener) {
      assert.equal(type, "abort");
      aborted = true;
      listener();
    },
    removeEventListener(type) { assert.equal(type, "abort"); },
  };
  const events = [];
  await assert.rejects(
    () => runWithInteractionChannel(
      { sessionId: "session", runId: "abort-registration-race" },
      { emit: event => events.push(event) },
      () => askUserQuestion("must not emit", [], 5_000, signal),
    ),
    error => error?.code === "RUN_CANCELLED" && error.cause === reason,
  );
  assert.deepEqual(events, []);
});

test("RT-01 notification delivery uses the scoped notifier and fails closed on handler errors", async () => {
  const notifications = [];
  await runWithInteractionChannel(
    { sessionId: "session", runId: "native-notify" },
    { emit: () => assert.fail("emit fallback must not run"), notify: (title, body) => notifications.push([title, body]) },
    async () => assert.equal(emitRunNotification("title", "body"), true)
  );
  assert.deepEqual(notifications, [["title", "body"]]);

  await runWithInteractionChannel(
    { sessionId: "session", runId: "notify-error" },
    { emit: () => undefined, notify: () => { throw new Error("notifier failed"); } },
    async () => assert.equal(emitRunNotification("title", "body"), false)
  );
  await runWithInteractionChannel(
    { sessionId: "session", runId: "emit-error" },
    { emit: () => { throw new Error("stream failed"); } },
    async () => assert.equal(emitRunNotification("title", "body"), false)
  );
});

test("RT-01 unavailable, throwing and timed-out legacy channels settle without leaking questions", async () => {
  try {
    setAskUserSseCallback(null);
    assert.equal(await askUserQuestion("unavailable", [], 5_000), "(用户交互通道不可用)");

    setAskUserSseCallback(() => { throw new Error("stream failed"); });
    assert.equal(await askUserQuestion("throwing", [], 5_000), "(用户交互通道不可用)");

    setAskUserSseCallback(() => undefined);
    assert.equal(await askUserQuestion("timeout", [], 5), "(用户未在5分钟内回答)");
  } finally {
    setAskUserSseCallback(() => undefined);
  }
});

test("RT-01 answer overloads, confirmation vocabulary and executor remain fail-closed", async () => {
  assert.equal(submitAnswer("missing", "answer"), false);
  assert.equal(submitAnswer("session", "run", 42, "answer"), false);
  assert.equal(submitAnswer("session", "run", "question"), false);

  const answers = ["拒绝", "YES", "maybe", "custom answer"];
  try {
    setAskUserSseCallback(event => {
      const answer = answers.shift();
      assert.equal(submitAnswer(event.questionId, answer), true);
    });
    assert.deepEqual(await askUserConfirm("reject"), { approved: false, answer: "拒绝" });
    assert.deepEqual(await askUserConfirm("approve"), { approved: true, answer: "YES" });
    assert.deepEqual(await askUserConfirm("unknown"), { approved: false, answer: "maybe" });
    assert.equal(await askUserExec({ question: "tool question", options: ["one"] }), "用户回答: custom answer");
  } finally {
    setAskUserSseCallback(() => undefined);
  }
  assert.equal(askUserDef.function.name, "ask_user");
  assert.deepEqual(askUserDef.function.parameters.required, ["question"]);
});
