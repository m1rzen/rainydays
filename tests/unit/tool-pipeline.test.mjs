import assert from "node:assert/strict";
import test from "node:test";
import {
  createToolOutcome,
  MAX_TOOL_OUTPUT_BYTES,
  parseToolArguments,
  serializeToolOutcome,
  TOOL_PIPELINE_STAGES,
  ToolExecutionError,
  ToolLoopDetector,
  ToolStageTrace,
} from "../../dist/tool-pipeline.js";

test("RT-05 tool pipeline exposes one frozen eight-stage diagnostic order", () => {
  assert.deepEqual(TOOL_PIPELINE_STAGES, [
    "schema", "capability", "loop", "approval", "policy", "execute", "output", "audit",
  ]);
  const trace = new ToolStageTrace();
  trace.record("schema", "passed");
  trace.record("capability", "denied", "CAPABILITY_TOOL_DENIED");
  const snapshot = trace.snapshot();
  assert.deepEqual(snapshot.map(stage => [stage.stage, stage.state, stage.code]), [
    ["schema", "passed", null],
    ["capability", "denied", "CAPABILITY_TOOL_DENIED"],
    ["loop", "skipped", null],
    ["approval", "skipped", null],
    ["policy", "skipped", null],
    ["execute", "skipped", null],
    ["output", "skipped", null],
    ["audit", "skipped", null],
  ]);
  assert(Object.isFrozen(snapshot));
  assert(snapshot.every(Object.isFrozen));
  assert.throws(() => trace.record("schema", "passed"), /stage order is invalid/u);
  const reverse = new ToolStageTrace();
  reverse.record("policy", "passed");
  assert.throws(() => reverse.record("approval", "passed"), /stage order is invalid/u);
});

test("RT-05 raw argument parser rejects malformed and non-object JSON without fallback", () => {
  assert.deepEqual(parseToolArguments('{"value":1}'), { value: 1 });
  for (const raw of ["{bad", "null", "[]", "42", '"text"']) {
    assert.throws(() => parseToolArguments(raw), error => error?.code === "TOOL_ARGUMENTS_INVALID");
  }
  assert.throws(() => parseToolArguments({}), error => error?.code === "TOOL_ARGUMENTS_INVALID");
});

test("RT-05 loop detector permits three identical calls and rejects the fourth before execution", () => {
  const detector = new ToolLoopDetector();
  detector.observe("read_file", "a".repeat(64));
  detector.observe("read_file", "a".repeat(64));
  detector.observe("read_file", "a".repeat(64));
  assert.throws(
    () => detector.observe("read_file", "a".repeat(64)),
    error => error?.code === "TOOL_LOOP_DETECTED" && /Repeated identical/u.test(error.message),
  );
  detector.observe("read_file", "b".repeat(64));
  detector.observe("list_directory", "a".repeat(64));
});

test("RT-05 loop detector bounds adversarial call diversity", () => {
  const detector = new ToolLoopDetector();
  for (let index = 0; index < 256; index += 1) detector.observe("read_file", index.toString(16).padStart(64, "0"));
  assert.throws(
    () => detector.observe("read_file", "f".repeat(64)),
    error => error?.code === "TOOL_LOOP_DETECTED" && /diversity/u.test(error.message),
  );
});

test("RT-05 output control preserves small results and safely truncates UTF-8", () => {
  assert.deepEqual(createToolOutcome("success", "ok"), {
    status: "success",
    content: "ok",
    code: null,
    outputBytes: 2,
    originalOutputBytes: 2,
    truncated: false,
  });

  const large = createToolOutcome("success", "界".repeat(50_000));
  assert.equal(large.originalOutputBytes, 150_000);
  assert.equal(large.outputBytes, Buffer.byteLength(large.content, "utf8"));
  assert.equal(large.truncated, true);
  assert(Buffer.byteLength(serializeToolOutcome(large), "utf8") <= MAX_TOOL_OUTPUT_BYTES);
  assert.match(large.content, /\n…\[tool output truncated\]$/u);
  assert.equal(large.content.includes("�"), false);
  assert(Object.isFrozen(large));

  for (const value of ['"'.repeat(150_000), "\\".repeat(200_000), "\0".repeat(150_000), "😀".repeat(80_000)]) {
    const escaped = createToolOutcome("success", value);
    const serialized = serializeToolOutcome(escaped);
    const toolMessage = JSON.stringify({ role: "tool", content: serialized, tool_call_id: "x".repeat(256) });
    assert.equal(escaped.truncated, true);
    assert(Buffer.byteLength(toolMessage, "utf8") <= MAX_TOOL_OUTPUT_BYTES);
    assert.equal(JSON.parse(serialized).content.includes("�"), false);
  }
  assert.throws(
    () => serializeToolOutcome({ ...large, content: '"'.repeat(MAX_TOOL_OUTPUT_BYTES), originalOutputBytes: MAX_TOOL_OUTPUT_BYTES }),
    /serialized tool message exceeds/iu,
  );
});

test("RT-05 executor failures remain typed and retain their cause", () => {
  const cause = new Error("synthetic executor failure");
  const error = new ToolExecutionError("read_file", cause);
  assert.equal(error.code, "TOOL_EXECUTION_FAILED");
  assert.equal(error.cause, cause);
  assert.match(error.message, /read_file execution failed/u);
});
