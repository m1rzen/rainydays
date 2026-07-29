import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalFacadeForTests } from "../../dist/terminal.js";
import { issueResourceOwner, retireResourceOwner } from "../../dist/resource-owner.js";
import { assertSec01Probe } from "../sec01-probe.mjs";

function owner(sessionId, principal = "local-user-api") {
  return issueResourceOwner({ authorityId: `authority-${sessionId}-${principal}`, authorityEpoch: 1, sessionId, principal, rootIds: ["workspace"] });
}

function harness() {
  const states = new WeakMap();
  const statesByTerminal = new Map();
  const terminations = [];
  const backend = {
    read(lease) {
      const state = states.get(lease);
      if (!state) throw new Error("unknown synthetic lease");
      return { stdout: state.stdout, stderr: state.stderr, outputTruncated: false, running: state.running };
    },
    async terminate(lease, _owner, reason) {
      const state = states.get(lease);
      if (!state) throw new Error("unknown synthetic lease");
      state.running = false;
      terminations.push(reason);
    },
  };
  const execution = {
    async executeCommand() { throw new Error("not available in Terminal projection test"); },
    async executeScript() { throw new Error("not available in Terminal projection test"); },
    async startShell(input) {
      const lease = Object.freeze({ leaseId: `synthetic-${input.terminalId}` });
      const state = { stdout: "", stderr: "", running: true, terminalId: input.terminalId };
      states.set(lease, state);
      statesByTerminal.set(input.terminalId, state);
      return lease;
    },
    async writeShell({ lease, terminalId, data, appendNewline }) {
      const state = states.get(lease);
      if (!state || state.terminalId !== terminalId || !state.running) throw new Error("synthetic lease binding mismatch");
      state.stdout += data + (appendNewline ? "\r\n" : "");
    },
  };
  return {
    facade: createTerminalFacadeForTests(backend),
    execution,
    terminations,
    emit(terminalId, stream, text) {
      const state = statesByTerminal.get(terminalId);
      if (!state || (stream !== "stdout" && stream !== "stderr")) throw new Error("unknown synthetic stream");
      state[stream] += text;
    },
  };
}

function startOptions(execution, overrides = {}) {
  return {
    shell: "cmd",
    authorizedCwd: process.cwd(),
    executionRootLease: Object.freeze({}),
    execution,
    name: "owner-probe",
    ...overrides,
  };
}

test("SEC-01 Terminal projection keeps opaque leases Session/principal-owned", async () => {
  const localOwner = owner("session-a");
  const agentOwner = owner("session-a", "agent");
  const otherSession = owner("session-b");
  const { facade, execution, terminations } = harness();

  assert.throws(() => facade.list({ ...localOwner }), error => error?.code === "PATH_AUTHORITY_FORGED");
  await assert.rejects(() => facade.start(localOwner, startOptions(execution, { shell: "invalid" })), /不支持的 Shell/);
  await assert.rejects(() => facade.start(localOwner, startOptions(execution, { authorizedCwd: "" })), /缺少 SEC-03 执行授权/);

  const terminal = await facade.start(localOwner, startOptions(execution));
  const events = [];
  const unsubscribe = facade.subscribe(localOwner, terminal.id, event => events.push(event));
  try {
    assert.equal(terminal.pid, null, "projection leaked or invented a host PID");
    assert.equal(facade.get(localOwner, terminal.id)?.id, terminal.id);
    assert.equal(facade.get(agentOwner, terminal.id), undefined);
    assert.equal(facade.get(otherSession, terminal.id), undefined);
    assert.equal(Object.hasOwn(facade.get(localOwner, terminal.id), "owner"), false);
    assert.deepEqual(facade.list(agentOwner), []);
    assert.deepEqual(facade.list(otherSession), []);

    const auditCalls = [];
    const originalConsoleLog = console.log;
    console.log = (...values) => { auditCalls.push(values); };
    try { assert.throws(() => facade.output(agentOwner, terminal.id), /终端不存在/); }
    finally { console.log = originalConsoleLog; }
    assert.equal(auditCalls.length, 1);
    const auditText = JSON.stringify(auditCalls[0]);
    assert.match(auditText, /terminal-owner-denied/);
    assert.match(auditText, /[a-f0-9]{64}/);
    assert.equal(auditText.includes(terminal.id), false);

    await assert.rejects(() => facade.input(otherSession, terminal.id, "echo denied", true, execution), /终端不存在/);
    assert.throws(() => facade.subscribe(agentOwner, terminal.id, () => undefined), /终端不存在/);
    await assert.rejects(() => facade.input(localOwner, terminal.id, "", true, execution), /输入不能为空/);
    await assert.rejects(() => facade.input(localOwner, terminal.id, "x".repeat(64 * 1024 + 1), true, execution), /单次输入不能超过/);
    await assert.rejects(() => facade.input(localOwner, terminal.id, "bad\0input", true, execution), /空字符/);

    assertSec01Probe("SEC01-A29", "terminal-owner-state", [facade.get(otherSession, terminal.id) ?? null, facade.list(otherSession)], [null, []]);
    assertSec01Probe("SEC01-A29", "terminal-resource-count", facade.list(localOwner).length, 1);

    await facade.input(localOwner, terminal.id, "echo SEC01_OWNER_PROBE", true, execution);
    const output = facade.output(localOwner, terminal.id, 0, 100_000);
    assert.match(output.data, /SEC01_OWNER_PROBE/);
    assert.equal(output.info.id, terminal.id);
    assert(events.some(event => event.type === "output" && event.terminalId === terminal.id));

    facade.clear(localOwner, terminal.id);
    const cleared = facade.output(localOwner, terminal.id, 0, 10);
    assert.equal(cleared.data, "");
    assert.equal(cleared.truncated, true);

    await facade.kill(localOwner, terminal.id);
    assert.equal(facade.get(localOwner, terminal.id)?.status, "killed");
    await assert.rejects(() => facade.input(localOwner, terminal.id, "echo after-kill", true, execution), /终端未运行/);
    await facade.kill(localOwner, terminal.id);
    assert.deepEqual(terminations, ["terminal-kill"]);
  } finally {
    unsubscribe();
    await facade.close(localOwner, terminal.id);
    await facade.disposeAllForShutdown();
    await Promise.all([localOwner, agentOwner, otherSession].map(value => retireResourceOwner(value)));
  }
});

test("SEC-03 Terminal projection tracks stdout and stderr independently without loss or duplication", async () => {
  const resourceOwner = owner("session-stream-order", "agent");
  const { facade, execution, emit } = harness();
  const terminal = await facade.start(resourceOwner, startOptions(execution, { name: "stream-probe" }));
  try {
    emit(terminal.id, "stdout", "out-1\r\n");
    emit(terminal.id, "stderr", "err-1\r\n");
    const first = facade.output(resourceOwner, terminal.id, 0, 1000).data;
    assert.equal((first.match(/out-1/gu) ?? []).length, 1);
    assert.equal((first.match(/err-1/gu) ?? []).length, 1);

    emit(terminal.id, "stdout", "out-2\r\n");
    const second = facade.output(resourceOwner, terminal.id, 0, 1000).data;
    assert.equal((second.match(/out-1/gu) ?? []).length, 1);
    assert.equal((second.match(/out-2/gu) ?? []).length, 1);
    assert.equal((second.match(/err-1/gu) ?? []).length, 1, "stderr was duplicated when stdout grew");

    emit(terminal.id, "stderr", "err-2\r\n");
    const third = facade.output(resourceOwner, terminal.id, 0, 1000).data;
    assert.equal((third.match(/out-2/gu) ?? []).length, 1, "stdout was lost when stderr grew");
    assert.equal((third.match(/err-1/gu) ?? []).length, 1);
    assert.equal((third.match(/err-2/gu) ?? []).length, 1);
    assert.equal((third.match(/\[stderr\]/gu) ?? []).length, 1, "stderr label was duplicated");
  } finally {
    await facade.close(resourceOwner, terminal.id);
    await retireResourceOwner(resourceOwner);
    await facade.disposeAllForShutdown();
  }
});

test("SEC-02 Terminal projection normalizes blank names without ambient shell lookup", async () => {
  const resourceOwner = owner("session-powershell");
  const { facade, execution } = harness();
  const terminal = await facade.start(resourceOwner, startOptions(execution, { shell: "powershell", name: "   " }));
  try {
    assert.equal(terminal.shell, "powershell");
    assert.match(terminal.name, /^term_/u);
    await facade.input(resourceOwner, terminal.id, "Write-Output SEC02_POWERSHELL", false, execution);
    assert.match(facade.output(resourceOwner, terminal.id, 0, 1000).data, /SEC02_POWERSHELL/);
  } finally {
    await facade.close(resourceOwner, terminal.id);
    await retireResourceOwner(resourceOwner);
    await facade.disposeAllForShutdown();
  }
});

test("SEC-02 ResourceOwner retirement terminates its opaque Terminal lease before resolving", async () => {
  const resourceOwner = owner("session-retire", "agent");
  const other = owner("session-retire", "agent");
  const { facade, execution, terminations } = harness();
  await facade.start(resourceOwner, startOptions(execution, { name: "retire-probe" }));
  await retireResourceOwner(resourceOwner);
  assert.deepEqual(terminations, ["terminal-kill"]);
  assert.throws(() => facade.list(resourceOwner), error => error?.code === "PATH_AUTHORITY_STALE");
  assert.deepEqual(facade.list(other), []);
  await retireResourceOwner(other);
  await facade.disposeAllForShutdown();
});
