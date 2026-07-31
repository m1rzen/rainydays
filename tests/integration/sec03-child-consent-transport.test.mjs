import assert from "node:assert/strict";
import { createReadStream, createWriteStream } from "node:fs";
import { createHmac } from "node:crypto";
import { spawn } from "node:child_process";
import { PassThrough, Transform } from "node:stream";
import test from "node:test";
import {
  canonicalNativeConsentJson,
  NATIVE_CONSENT_MAX_FRAME_BYTES,
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

  async function inProcessPair(decide, requestStream = new PassThrough(), responseStream = new PassThrough()) {
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

  function rawFrame(payload, declaredLength = payload.length) {
    const frame = Buffer.alloc(payload.length + 4);
    frame.writeUInt32BE(declaredLength, 0);
    payload.copy(frame, 4);
    return frame;
  }

  async function rejectedChildFrame(frame, options = {}) {
    const request = new PassThrough();
    const response = new PassThrough();
    const child = createNativeProcessConsentChildTransport({ request, response, timeoutMs: 2_000 });
    const rejected = assert.rejects(child.ready, /unavailable/u);
    if (options.asString) request.emit("data", frame.toString("latin1"));
    else if (options.end) request.end(frame);
    else request.write(frame);
    await rejected;
    child.close();
    return child;
  }

  test("SEC-03 bounded frame reader rejects malformed, noncanonical, empty, partial and oversized bytes", async () => {
    await rejectedChildFrame(rawFrame(Buffer.from("{", "utf8")));
    await rejectedChildFrame(rawFrame(Buffer.from('{"b":1,"a":2}', "utf8")));
    await rejectedChildFrame(Buffer.alloc(4));
    const oversizedHeader = Buffer.alloc(4);
    oversizedHeader.writeUInt32BE(NATIVE_CONSENT_MAX_FRAME_BYTES + 1, 0);
    await rejectedChildFrame(oversizedHeader);
    await rejectedChildFrame(rawFrame(Buffer.from("x"), 10), { end: true });
    await rejectedChildFrame(Buffer.alloc(NATIVE_CONSENT_MAX_FRAME_BYTES + 5));
    await rejectedChildFrame(rawFrame(Buffer.from("{}", "utf8")), { asString: true });

    const request = new PassThrough();
    const response = new PassThrough();
    const child = createNativeProcessConsentChildTransport({ request, response, timeoutMs: 2_000 });
    const rejected = assert.rejects(child.ready, /unavailable/u);
    request.emit("data", Buffer.alloc(0));
    assert.equal(child.isReady(), false);
    child.close();
    await rejected;
  });

  test("SEC-03 child handshake rejects every untrusted hello field", async () => {
    const hello = {
      challenge: "1".repeat(64),
      kind: "hello",
      protocol: "mini-lux-native-consent-v1",
      secret: "2".repeat(64),
    };
    for (const value of [
      null,
      { ...hello, extra: true },
      { ...hello, kind: "ready" },
      { ...hello, protocol: "other" },
      { ...hello, secret: 1 },
      { ...hello, secret: "bad" },
      { ...hello, challenge: 1 },
      { ...hello, challenge: "bad" },
    ]) await rejectedChildFrame(encodeCanonical(value));
  });

  async function rejectedParentHandshake(mutateBody) {
    const request = new PassThrough();
    const response = new PassThrough();
    const chunks = [];
    request.on("data", chunk => { chunks.push(Buffer.from(chunk)); });
    const parent = createNativeProcessConsentParentTransport({ request, response, decide: () => "deny", timeoutMs: 2_000 });
    const rejected = assert.rejects(parent.ready, /unavailable/u);
    await new Promise(resolve => setImmediate(resolve));
    const helloFrame = Buffer.concat(chunks);
    const helloLength = helloFrame.readUInt32BE(0);
    const hello = JSON.parse(helloFrame.subarray(4, helloLength + 4).toString("utf8"));
    const secret = Buffer.from(hello.secret, "hex");
    const body = mutateBody({ challenge: hello.challenge, kind: "ready", protocol: hello.protocol });
    const envelope = { seq: 0, nonce: "3".repeat(64), body, mac: "" };
    envelope.mac = createHmac("sha256", secret)
      .update(canonicalNativeConsentJson({ body, nonce: envelope.nonce, seq: envelope.seq }), "utf8")
      .digest("hex");
    response.write(encodeCanonical(envelope));
    await rejected;
    parent.close();
  }

  test("SEC-03 parent handshake rejects exact-key, kind, protocol and challenge drift", async () => {
    await rejectedParentHandshake(body => ({ ...body, extra: true }));
    await rejectedParentHandshake(body => ({ ...body, kind: "hello" }));
    await rejectedParentHandshake(body => ({ ...body, protocol: "other" }));
    await rejectedParentHandshake(body => ({ ...body, challenge: "4".repeat(64) }));

    const request = new PassThrough();
    const response = new PassThrough();
    request.destroy();
    const parent = createNativeProcessConsentParentTransport({ request, response, decide: () => "deny", timeoutMs: 2_000 });
    await assert.rejects(parent.ready, /unavailable/u);
    parent.close();
    parent.close();
  });

  async function rejectedPrepare(mutateBody) {
    const request = new FramedMutationStream(({ frame }) => frame);
    const response = new FramedMutationStream(({ frame, frameIndex, parsed }) => {
      if (frameIndex !== 2) return frame;
      const changed = { ...parsed, body: mutateBody({ ...parsed.body }) };
      changed.mac = createHmac("sha256", Buffer.from(request.secret, "hex"))
        .update(canonicalNativeConsentJson({ body: changed.body, nonce: changed.nonce, seq: changed.seq }), "utf8")
        .digest("hex");
      return encodeCanonical(changed);
    });
    const pair = await inProcessPair(() => "approve", request, response);
    try {
      assert.equal(await pair.child.requestDecision(challenge()), "deny");
      assert.equal(pair.parent.isReady(), false);
    } finally { pair.close(); }
  }

  test("SEC-03 parent rejects authenticated prepare kind and challenge-digest drift", async () => {
    await rejectedPrepare(body => ({ ...body, kind: "decision" }));
    await rejectedPrepare(body => ({ ...body, requestId: 1 }));
    await rejectedPrepare(body => ({ ...body, challengeDigest: 1 }));
    await rejectedPrepare(body => ({ ...body, challengeDigest: "f".repeat(64) }));
  });

  test("SEC-03 parent closure during a decision denies the pending child request", async () => {
    const request = new PassThrough();
    const response = new PassThrough();
    let parent;
    const child = createNativeProcessConsentChildTransport({ request, response, timeoutMs: 2_000 });
    parent = createNativeProcessConsentParentTransport({
      request,
      response,
      timeoutMs: 2_000,
      decide: () => {
        parent.close();
        return "approve";
      },
    });
    try {
      await Promise.all([parent.ready, child.ready]);
      assert.equal(await child.requestDecision(challenge()), "deny");
      assert.equal(parent.isReady(), false);
    } finally {
      child.close();
      parent.close();
    }
  });

  test("SEC-03 consent transport rejects malformed public inputs before authenticated IPC", async () => {
    assert.equal(canonicalNativeConsentJson({ z: [true, null, 2], a: "x" }), '{"a":"x","z":[true,null,2]}');
    const nullPrototype = Object.assign(Object.create(null), { b: 2, a: 1 });
    assert.equal(canonicalNativeConsentJson(nullPrototype), '{"a":1,"b":2}');
    for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, new Date(), new Map()]) {
      assert.throws(() => canonicalNativeConsentJson(value), /canonical JSON/u);
    }

    for (const timeoutMs of [0, 15_001, 1.5, Number.NaN]) {
      assert.throws(
        () => createNativeProcessConsentChildTransport({ request: new PassThrough(), response: new PassThrough(), timeoutMs }),
        /timeout is invalid/u,
      );
      assert.throws(
        () => createNativeProcessConsentParentTransport({ request: new PassThrough(), response: new PassThrough(), decide: () => "deny", timeoutMs }),
        /timeout is invalid/u,
      );
    }
    assert.throws(() => createNativeProcessConsentChildTransport({ request: null, response: new PassThrough() }), /child transport is invalid/u);
    assert.throws(() => createNativeProcessConsentChildTransport({ request: new PassThrough(), response: null }), /child transport is invalid/u);
    assert.throws(() => createNativeProcessConsentParentTransport({ request: null, response: new PassThrough(), decide: () => "deny" }), /parent transport is invalid/u);
    assert.throws(() => createNativeProcessConsentParentTransport({ request: new PassThrough(), response: null, decide: () => "deny" }), /parent transport is invalid/u);
    assert.throws(() => createNativeProcessConsentParentTransport({ request: new PassThrough(), response: new PassThrough(), decide: null }), /parent transport is invalid/u);
  });

  test("SEC-03 child challenge validation denies every malformed field without reaching the parent", async () => {
    let decisions = 0;
    const pair = await inProcessPair(() => { decisions += 1; return "approve"; });
    const base = challenge();
    const without = key => {
      const value = { ...base };
      delete value[key];
      return value;
    };
    const malformed = [
      null,
      [],
      { ...base, extra: true },
      without("nonce"),
      { ...base, nonce: 1 },
      { ...base, nonce: "bad" },
      { ...base, runtimeAuthorityId: 1 },
      { ...base, runtimeAuthorityId: "" },
      { ...base, authorityEpoch: 1.5 },
      { ...base, authorityEpoch: 0 },
      { ...base, sessionId: 1 },
      { ...base, sessionId: "" },
      { ...base, runId: 1 },
      { ...base, runId: "" },
      { ...base, contextId: 1 },
      { ...base, contextId: "" },
      { ...base, registrationId: 1 },
      { ...base, registrationId: "" },
      { ...base, toolName: 1 },
      { ...base, toolName: "" },
      { ...base, argumentsDigest: 1 },
      { ...base, argumentsDigest: "bad" },
      { ...base, argumentsBytesSha256: 1 },
      { ...base, argumentsBytesSha256: "bad" },
      { ...base, argumentsUtf8Bytes: 1.5 },
      { ...base, argumentsUtf8Bytes: 1 },
      { ...base, expiresAt: 1 },
      { ...base, expiresAt: "not-a-date" },
      { ...base, profile: 1 },
      { ...base, profile: "x".repeat(513) },
      { ...base, rootAliases: "workspace" },
      { ...base, rootAliases: Array.from({ length: 33 }, () => "workspace") },
      { ...base, rootAliases: [1] },
      { ...base, rootAliases: ["x".repeat(513)] },
      { ...base, cwd: 1 },
      { ...base, cwd: "x".repeat(513) },
      { ...base, preview: 1 },
      { ...base, preview: "x".repeat(2049) },
      { ...base, previewTruncated: "false" },
    ];
    try {
      for (const value of malformed) assert.equal(await pair.child.requestDecision(value), "deny");
      assert.equal(decisions, 0, "malformed challenge reached the parent decision handler");
      assert.equal(pair.child.isReady(), true, "local validation poisoned an authenticated channel");
      assert.equal(await pair.child.requestDecision(base), "approve");
      assert.equal(decisions, 1);
    } finally {
      pair.close();
      pair.close();
      assert.equal(pair.child.isReady(), false);
      assert.equal(pair.parent.isReady(), false);
      assert.equal(await pair.child.requestDecision(base), "deny");
    }
  });

  test("SEC-03 parent normalizes invalid decisions and timeout closes pending consent", async () => {
    const invalidDecision = await inProcessPair(() => "unexpected");
    try { assert.equal(await invalidDecision.child.requestDecision(challenge()), "deny"); }
    finally { invalidDecision.close(); }

    const dismiss = await inProcessPair(() => "dismiss");
    try { assert.equal(await dismiss.child.requestDecision(challenge()), "dismiss"); }
    finally { dismiss.close(); }

    const requestStream = new PassThrough();
    const responseStream = new PassThrough();
    const child = createNativeProcessConsentChildTransport({ request: requestStream, response: responseStream, timeoutMs: 25 });
    const parent = createNativeProcessConsentParentTransport({
      request: requestStream,
      response: responseStream,
      decide: () => new Promise(() => {}),
      timeoutMs: 25,
    });
    await Promise.all([child.ready, parent.ready]);
    assert.equal(await child.requestDecision(challenge()), "deny");
    assert.equal(child.isReady(), false);
    assert.equal(parent.isReady(), false);
    child.close();
    parent.close();
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
