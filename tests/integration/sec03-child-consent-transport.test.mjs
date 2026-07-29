import assert from "node:assert/strict";
import { createReadStream, createWriteStream } from "node:fs";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { PassThrough, Transform } from "node:stream";
import test from "node:test";
import {
  canonicalNativeConsentJson,
  createNativeProcessConsentChildTransport,
  createNativeProcessConsentParentTransport,
  installInheritedNativeProcessConsentTransport,
} from "../../dist/native-process-consent-transport.js";

const isChild = process.argv.at(-1) === "--sec03-consent-child";

function challenge() {
  return Object.freeze({
    nonce: "1".repeat(64),
    runtimeAuthorityId: "authority-a",
    authorityEpoch: 1,
    sessionId: "session-a",
    runId: "run-a",
    contextId: "context-a",
    registrationId: "registration-a",
    toolName: "execute_command",
    argumentsDigest: "2".repeat(64),
    argumentsBytesSha256: "3".repeat(64),
    argumentsUtf8Bytes: 16,
    expiresAt: new Date(Date.now() + 15_000).toISOString(),
    profile: "developer",
    rootAliases: Object.freeze(["workspace"]),
    cwd: "C:/workspace",
    preview: "command",
    previewTruncated: false,
  });
}

if (isChild) {
  const transport = createNativeProcessConsentChildTransport({
    request: createReadStream("", { fd: 3, autoClose: true }),
    response: createWriteStream("", { fd: 4, autoClose: true }),
  });
  try {
    await transport.ready;
    const decision = await transport.requestDecision(challenge());
    process.stdout.write(`${decision}\n`);
  } finally {
    transport.close();
  }
} else {
  function spawnConsentChild(decide) {
    const child = spawn(process.execPath, [import.meta.filename, "--sec03-consent-child"], {
      cwd: process.cwd(),
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot },
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
    });
    const transport = createNativeProcessConsentParentTransport({
      request: child.stdio[3],
      response: child.stdio[4],
      decide,
    });
    return { child, transport };
  }

  async function collect(instance) {
    let stdout = "";
    let stderr = "";
    instance.child.stdout.setEncoding("utf8");
    instance.child.stderr.setEncoding("utf8");
    instance.child.stdout.on("data", chunk => { stdout += chunk; });
    instance.child.stderr.on("data", chunk => { stderr += chunk; });
    await instance.transport.ready;
    const code = await new Promise((resolve, reject) => {
      instance.child.once("error", reject);
      instance.child.once("exit", resolve);
    });
    instance.transport.close();
    assert.equal(code, 0, stderr);
    return stdout.trim();
  }

  class FramedMutationStream extends Transform {
    constructor(mutate) {
      super();
      this.mutate = mutate;
      this.buffer = Buffer.alloc(0);
      this.frameIndex = 0;
      this.secret = null;
    }

    _transform(chunk, _encoding, callback) {
      this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
      while (this.buffer.length >= 4) {
        const length = this.buffer.readUInt32BE(0);
        if (this.buffer.length < length + 4) break;
        const frame = this.buffer.subarray(0, length + 4);
        this.buffer = this.buffer.subarray(length + 4);
        this.frameIndex += 1;
        const parsed = JSON.parse(frame.subarray(4).toString("utf8"));
        if (this.frameIndex === 1 && typeof parsed.secret === "string") this.secret = parsed.secret;
        const outputs = this.mutate({ frame, frameIndex: this.frameIndex, parsed, secret: this.secret });
        for (const output of Array.isArray(outputs) ? outputs : [outputs]) this.push(output);
      }
      callback();
    }
  }

  function encodeCanonical(value) {
    const payload = Buffer.from(canonicalNativeConsentJson(value), "utf8");
    const frame = Buffer.alloc(payload.length + 4);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, 4);
    return frame;
  }

  async function inProcessPair(decide, requestStream = new PassThrough()) {
    const responseStream = new PassThrough();
    const child = createNativeProcessConsentChildTransport({ request: requestStream, response: responseStream, timeoutMs: 2_000 });
    const parent = createNativeProcessConsentParentTransport({ request: requestStream, response: responseStream, decide, timeoutMs: 2_000 });
    await Promise.all([child.ready, parent.ready]);
    return { child, parent, close: () => { child.close(); parent.close(); } };
  }

  test("SEC-03 inherited anonymous pipes carry one parent-only approval", { timeout: 30_000 }, async () => {
    let observed;
    const instance = spawnConsentChild(value => { observed = value; return "approve"; });
    assert.equal(await collect(instance), "approve");
    assert.equal(observed.runtimeAuthorityId, "authority-a");
    assert.equal(observed.registrationId, "registration-a");
  });

  test("SEC-03 inherited anonymous pipes preserve a parent-only denial", { timeout: 30_000 }, async () => {
    const instance = spawnConsentChild(() => "deny");
    assert.equal(await collect(instance), "deny");
  });

  test("SEC-03 child transport rejects concurrent cross-request substitution", async () => {
    let release;
    const decisionGate = new Promise(resolve => { release = resolve; });
    const pair = await inProcessPair(async () => decisionGate);
    try {
      const first = pair.child.requestDecision(challenge());
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(await pair.child.requestDecision({ ...challenge(), nonce: "4".repeat(64) }), "deny");
      release("approve");
      assert.equal(await first, "approve");
    } finally {
      pair.close();
    }
  });

  test("SEC-03 child transport rejects a valid-MAC decision bound to another request", async () => {
    const requestStream = new FramedMutationStream(({ frame, frameIndex, parsed, secret }) => {
      if (frameIndex !== 2) return frame;
      assert.equal(typeof secret, "string");
      const changed = { ...parsed, body: { ...parsed.body, requestId: "f".repeat(64) } };
      changed.mac = createHmac("sha256", Buffer.from(secret, "hex"))
        .update(canonicalNativeConsentJson({ body: changed.body, nonce: changed.nonce, seq: changed.seq }), "utf8")
        .digest("hex");
      return encodeCanonical(changed);
    });
    const pair = await inProcessPair(() => "approve", requestStream);
    try {
      assert.equal(await pair.child.requestDecision(challenge()), "deny");
      assert.equal(pair.child.isReady(), false);
    } finally {
      pair.close();
    }
  });

  test("SEC-03 child transport rejects decision MAC tampering", async () => {
    const requestStream = new FramedMutationStream(({ frame, frameIndex, parsed }) => {
      if (frameIndex !== 2) return frame;
      return encodeCanonical({ ...parsed, body: { ...parsed.body, decision: "deny" } });
    });
    const pair = await inProcessPair(() => "approve", requestStream);
    try {
      assert.equal(await pair.child.requestDecision(challenge()), "deny");
      assert.equal(pair.child.isReady(), false);
    } finally {
      pair.close();
    }
  });

  test("SEC-03 replayed decision invalidates the private channel", async () => {
    const requestStream = new FramedMutationStream(({ frame, frameIndex }) => frameIndex === 2 ? [frame, Buffer.from(frame)] : frame);
    const pair = await inProcessPair(() => "approve", requestStream);
    try {
      assert.equal(await pair.child.requestDecision(challenge()), "approve");
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(pair.child.isReady(), false);
      assert.equal(await pair.child.requestDecision({ ...challenge(), nonce: "5".repeat(64) }), "deny");
    } finally {
      pair.close();
    }
  });

  test("SEC-03 child EOF invalidates the private channel", { timeout: 30_000 }, async () => {
    const child = spawn(process.execPath, ["-e", "process.exit(0)"], {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"],
    });
    const transport = createNativeProcessConsentParentTransport({
      request: child.stdio[3],
      response: child.stdio[4],
      decide: () => "approve",
      timeoutMs: 2_000,
    });
    await assert.rejects(transport.ready, /unavailable/u);
    transport.close();
  });

  test("SEC-03 direct server mode has no inherited consent handler", async () => {
    assert.equal(await installInheritedNativeProcessConsentTransport(), null);
  });
}
