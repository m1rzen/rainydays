import assert from "node:assert/strict";
import test from "node:test";

test("intentional GOV-03 gate failure", () => {
  assert.fail("intentional assertion failure must propagate non-zero");
});
