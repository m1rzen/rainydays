import assert from "node:assert/strict";
import test from "node:test";
import { logger, redactLogData } from "../../dist/logger.js";

test("SEC-05 logger recursively redacts credential fields and authorization text", () => {
  const secret = "sec05-plaintext-never-log";
  const redacted = redactLogData({
    apiKey: secret,
    nested: { Authorization: `Bearer ${secret}`, values: [{ password: secret }] },
    safe: "retained",
  });
  const serialized = JSON.stringify(redacted);
  assert.equal(serialized.includes(secret), false);
  assert.equal(redacted.safe, "retained");

  const calls = [];
  const original = console.log;
  console.log = (...args) => calls.push(args.join(" "));
  try {
    logger.error("provider", `authorization=Bearer ${secret}`, {
      credentialRef: "cred_0123456789abcdef0123456789abcdef",
      child: { token: secret, safe: "ok" },
    });
  } finally {
    console.log = original;
  }
  assert.equal(calls.length, 1);
  assert.equal(calls[0].includes(secret), false);
  assert.equal(calls[0].includes("cred_0123456789abcdef0123456789abcdef"), false);
  assert.match(calls[0], /\[REDACTED\]/u);
  assert.match(calls[0], /"safe":"ok"/u);
});
