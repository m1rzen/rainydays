import assert from "node:assert/strict";
import { AsyncLocalStorage, createHook } from "node:async_hooks";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CapabilityBroker } from "../../dist/capability-broker.js";
import { PathDeniedError, PathPolicy } from "../../dist/path-policy.js";
import { DIRECT_OPERATION_POLICIES } from "../../dist/tool-policies.js";
import { executeCommandExec } from "../../dist/tools/shell.js";
import { scriptExec } from "../../dist/tools/script.js";
import { shellStartExec } from "../../dist/tools/terminal-tools.js";
import { createSec02Recorder } from "../sec02-receipts.mjs";

const processRecorder = await createSec02Recorder(
  import.meta.url,
  "SEC-02 Shell and Script use authorized initial CWD and deny external CWD before spawn"
);
const toolTerminalRecorder = await createSec02Recorder(
  import.meta.url,
  "SEC-02 tool Terminal binds CWD and controls to one runtime authority"
);
const pathAuditKeys = ["authorityEpoch", "code", "event", "inputFingerprint", "operation", "operationId", "principal", "rootId", "runId", "sessionId", "timestamp"].sort();
const terminalAuditKeys = ["code", "event", "operation", "terminalFingerprint"].sort();
const processObservation = new AsyncLocalStorage();
const processHook = createHook({
  init(_asyncId, type) {
    if (type === "PROCESSWRAP") {
      const counter = processObservation.getStore();
      if (counter) counter.processStarts += 1;
    }
  },
});
processHook.enable();

async function exists(target) {
  try { await fs.access(target); return true; }
  catch { return false; }
}

function redactedPathAuditEvidence(events, rawInput) {
  return {
    auditAttempts: events.length,
    auditAllowedFieldsExact: events.every(event => JSON.stringify(Object.keys(event).sort()) === JSON.stringify(pathAuditKeys)),
    rawPathsAbsent: events.every(event => !Object.values(event).some(value => typeof value === "string" && value.includes(rawInput))),
  };
}

function redactedTerminalAuditEvidence(events, terminalId) {
  return {
    auditAttempts: events.length,
    auditAllowedFieldsExact: events.every(event => JSON.stringify(Object.keys(event).sort()) === JSON.stringify(terminalAuditKeys)),
    rawPathsAbsent: events.every(event => !Object.values(event).some(value => typeof value === "string" && value.includes(terminalId))),
  };
}

async function captureRuntimeProcessDenial(rawInput, invoke, isDenied) {
  const events = [];
  const counter = { processStarts: 0 };
  const originalWarn = console.warn;
  console.warn = (...args) => {
    let parsed = null;
    try { parsed = typeof args[0] === "string" ? JSON.parse(args[0]) : null; }
    catch { parsed = null; }
    if (parsed?.component === "path-policy") {
      const { component: _component, ...event } = parsed;
      events.push(event);
      return;
    }
    originalWarn(...args);
  };
  let value;
  let error;
  try {
    await processObservation.run(counter, async () => {
      try { value = await invoke(); }
      catch (caught) { error = caught; }
    });
  } finally {
    console.warn = originalWarn;
  }
  assert.equal(isDenied({ value, error }), true, `unexpected denial result: ${error?.name || "no-error"}/${error?.code || "no-code"} ${String(value)}`);
  const actual = {
    denied: true,
    processStarts: counter.processStarts,
    ...redactedPathAuditEvidence(events, rawInput),
  };
  assert.deepEqual(actual, {
    denied: true,
    processStarts: 0,
    auditAttempts: 1,
    auditAllowedFieldsExact: true,
    rawPathsAbsent: true,
  });
  return actual;
}

const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec02-process-"));
const workspace = path.join(fixture, "workspace");
const outside = path.join(fixture, "outside");
const data = path.join(fixture, "data");
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(outside, { recursive: true });
await fs.mkdir(data, { recursive: true });
process.env.RAINYDAYS_USER_DATA_DIR = fixture;
process.env.RAINYDAYS_DATA_DIR = data;

const [personaModule, sessionModule, dbModule, toolsModule, pathRuntimeModule, terminalModule] = await Promise.all([
  import("../../dist/persona.js"),
  import("../../dist/session.js"),
  import("../../dist/db.js"),
  import("../../dist/tools/index.js"),
  import("../../dist/path-runtime.js"),
  import("../../dist/terminal-facade.js"),
]);

const localApiPrincipal = toolsModule.capabilityBroker.createLocalApiPrincipal();
const tools = ["execute_command", "script", "shell_start", "shell_input", "shell_output", "shell_list", "shell_kill"];
const persona = personaModule.createEffectivePersona({
  name: "sec02-process",
  displayName: "SEC02 Process",
  description: "isolated process CWD test",
  tools,
  env: { WORKSPACE_ROOT: workspace, DATA_ROOT: workspace },
  allowedRoots: [workspace],
  networkPolicy: { mode: "unrestricted" },
  systemPrompt: "SEC-02 process CWD",
});
const session = sessionModule.createSession(persona, "SEC-02 process CWD");

async function makeAuthority(env = persona.env) {
  const pathAuthority = await pathRuntimeModule.pathPolicy.createAuthority([{
    rootId: "workspace",
    role: "workspace",
    configuredPath: workspace,
    permissions: ["initial-cwd"],
  }]);
  return toolsModule.capabilityBroker.createRuntimeAuthority({
    name: persona.name,
    tools,
    env,
    systemPrompt: persona.systemPrompt,
    allowedRoots: [...new Set(Object.values(env))],
    rootEnv: { WORKSPACE_ROOT: "workspace", DATA_ROOT: "workspace" },
    pathAuthority,
    networkPolicy: persona.networkPolicy,
  });
}

async function directTerminalStart(authority, options) {
  const context = toolsModule.capabilityBroker.issueLocalApiContext({
    authority,
    principal: localApiPrincipal,
    sessionId: session.id,
    operation: "terminal:start",
    args: options,
  });
  try {
    const authorized = toolsModule.capabilityBroker.authorizeDirectOperation(context, "terminal:start", options);
    return await toolsModule.capabilityBroker.withDirectExecutionRoot(
      context,
      "terminal:start",
      String(authorized.cwd),
      "WORKSPACE_ROOT",
      () => { throw new Error("Denied direct Terminal fixture unexpectedly reached execution"); }
    );
  } finally {
    if (toolsModule.capabilityBroker.isContextActive(context)) toolsModule.capabilityBroker.finishContext(context);
  }
}

async function directTerminalStartWithPolicy(policy, pathAuthority, options) {
  const broker = new CapabilityBroker({
    pathPolicy: policy,
    resolveSessionPersona: sessionId => sessionId === session.id ? persona.name : null,
  });
  broker.registerDirectOperation("terminal:start", DIRECT_OPERATION_POLICIES["terminal:start"]);
  const authority = broker.createRuntimeAuthority({
    name: persona.name,
    tools: [],
    env: persona.env,
    systemPrompt: persona.systemPrompt,
    allowedRoots: [workspace],
    rootEnv: { WORKSPACE_ROOT: "workspace", DATA_ROOT: "workspace" },
    pathAuthority,
    networkPolicy: persona.networkPolicy,
  });
  const principal = broker.createLocalApiPrincipal();
  const context = broker.issueLocalApiContext({
    authority,
    principal,
    sessionId: session.id,
    operation: "terminal:start",
    args: options,
  });
  try {
    const authorized = broker.authorizeDirectOperation(context, "terminal:start", options);
    return await broker.withDirectExecutionRoot(
      context,
      "terminal:start",
      String(authorized.cwd),
      "WORKSPACE_ROOT",
      () => { throw new Error("Denied direct Terminal fixture unexpectedly reached execution"); }
    );
  } finally {
    if (broker.isContextActive(context)) broker.finishContext(context);
    await broker.retireAuthority(authority);
  }
}

async function observeBeforeSpawnSwap(surface) {
  const targetName = `swap-${surface}`;
  const target = path.join(workspace, targetName);
  const preserved = path.join(workspace, `${targetName}-preserved`);
  await fs.mkdir(target);
  const events = [];
  const counter = { processStarts: 0 };
  let swapped = false;
  const policy = new PathPolicy({
    auditKey: Buffer.alloc(32, 28),
    auditSink: event => events.push(event),
    barrier: async point => {
      if (point !== "beforeProcessSpawn" || swapped) return;
      swapped = true;
      await fs.rename(target, preserved);
      await fs.symlink(outside, target, "junction");
    },
  });
  const authority = await policy.createAuthority([{
    rootId: "workspace",
    role: "workspace",
    configuredPath: workspace,
    permissions: ["initial-cwd"],
  }]);
  const cwdRequest = (input, options) => ({
    input,
    operation: "initial-cwd",
    defaultRootId: options.defaultRootId,
    auditIdentity: { sessionId: session.id, runId: `sec02-${surface}-swap`, principal: "local-user-api" },
  });
  const withInitialCwd = (input, options, use) => policy.withInitialCwd(authority, cwdRequest(input, options), use);
  const withExecutionRoot = (input, options, use) => policy.withExecutionRoot(authority, cwdRequest(input, options), "read-write", use);
  const invocation = {
    path: {
      rootIdForEnv: key => key === "WORKSPACE_ROOT" || key === "DATA_ROOT" ? "workspace" : null,
      withInitialCwd,
      withExecutionRoot,
    },
    resourceOwner: null,
  };
  let value;
  let error;
  try {
    await processObservation.run(counter, async () => {
      try {
        if (surface === "shell") {
          value = await executeCommandExec({ command: "echo must-not-spawn", cwd: targetName }, persona.env, invocation);
        } else if (surface === "script") {
          value = await scriptExec({ code: "console.log('must-not-spawn')" }, { WORKSPACE_ROOT: targetName }, invocation);
        } else if (surface === "tool-terminal") {
          value = await shellStartExec({ shell: "cmd", cwd: targetName, name: "must-not-spawn" }, persona.env, invocation);
        } else if (surface === "http-terminal") {
          value = await directTerminalStartWithPolicy(policy, authority, {
            shell: "cmd",
            cwd: targetName,
            name: "must-not-spawn",
          });
        } else {
          throw new Error(`unknown process surface: ${surface}`);
        }
      } catch (caught) {
        error = caught;
      }
    });
  } finally {
    if (policy.isActive(authority)) policy.revoke(authority);
  }
  const denied = surface === "shell"
    ? error === undefined && /命令执行出错/.test(value)
    : surface === "script"
      ? error === undefined && /代码执行出错/.test(value)
      : error instanceof PathDeniedError;
  const actual = {
    denied,
    processStarts: counter.processStarts,
    ...redactedPathAuditEvidence(events, targetName),
  };
  assert.equal(swapped, true, `${surface}: beforeProcessSpawn barrier was not reached`);
  assert.deepEqual(actual, {
    denied: true,
    processStarts: 0,
    auditAttempts: 1,
    auditAllowedFieldsExact: true,
    rawPathsAbsent: true,
  });
  if (processRecorder.enabled) await processRecorder.observe(`SEC02-P28-${surface}-before-spawn-swap`, actual);
}

async function approved(context, name, args) {
  const inspected = toolsModule.inspectToolCall(context, name, args);
  const challenge = toolsModule.capabilityBroker.createApprovalChallenge(context, inspected);
  const grant = toolsModule.capabilityBroker.resolveApprovalChallenge({
    challengeId: challenge.challengeId,
    choice: "approve",
    sessionId: context.sessionId,
    runId: context.runId,
    responsePrincipal: challenge.responsePrincipal,
    responseChannel: challenge.responseChannel,
  });
  assert(grant);
  try { return await toolsModule.executeInspectedTool(grant, inspected); }
  finally { toolsModule.capabilityBroker.finishContext(grant); }
}

async function waitForTerminalOutput(owner, id, text) {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const output = terminalModule.terminalFacade.output(owner, id, 0, 100_000);
    if (output.data.includes(text)) return output.data;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`terminal output did not contain ${text}`);
}

test.after(async () => {
  processHook.disable();
  await processRecorder.close();
  await toolTerminalRecorder.close();
  await terminalModule.terminalFacade.disposeAllForShutdown();
  dbModule.closeDb();
  await fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("SEC-02 Shell and Script use authorized initial CWD and deny external CWD before spawn", async () => {
  const authority = await makeAuthority();
  const root = toolsModule.capabilityBroker.beginAgentRun(authority, session.id);
  try {
    const shell = await approved(root, "execute_command", { command: process.platform === "win32" ? "cd" : "pwd", cwd: workspace });
    assert.match(shell.toLowerCase(), new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").toLowerCase()));
    if (processRecorder.enabled) await processRecorder.positive("SEC02-POS-shell-cwd");

    const script = await approved(root, "script", {
      code: "import path from 'node:path'; await Promise.resolve(); console.log(path.basename(process.cwd()), 42);",
    });
    assert.match(script, /workspace 42/);
    if (processRecorder.enabled) await processRecorder.positive("SEC02-POS-script-cwd");
  } finally {
    toolsModule.capabilityBroker.finishContext(root);
    await toolsModule.capabilityBroker.retireAuthority(authority);
  }

  const markerFile = path.join(fixture, "must-not-spawn.marker");
  const deniedCommand = JSON.stringify(process.execPath) + " -e \"require('node:fs').writeFileSync(process.argv[1],'spawned')\" " + JSON.stringify(markerFile);
  const deniedScript = "await import('node:fs/promises').then(fs => fs.writeFile(" + JSON.stringify(markerFile) + ", 'spawned'));";
  const externalAuthority = await makeAuthority({ WORKSPACE_ROOT: outside, DATA_ROOT: outside });
  const externalRoot = toolsModule.capabilityBroker.beginAgentRun(externalAuthority, session.id);
  try {
    const shellActual = await captureRuntimeProcessDenial(
      outside,
      () => approved(externalRoot, "execute_command", { command: deniedCommand, cwd: outside }),
      ({ value, error }) => error === undefined && /命令执行出错/.test(value)
    );
    if (processRecorder.enabled) await processRecorder.observe("SEC02-P28-shell-external-cwd", shellActual);

    const scriptActual = await captureRuntimeProcessDenial(
      outside,
      () => approved(externalRoot, "script", { code: deniedScript }),
      ({ value, error }) => error === undefined && /代码执行出错/.test(value)
    );
    if (processRecorder.enabled) await processRecorder.observe("SEC02-P28-script-external-cwd", scriptActual);

    const toolTerminalActual = await captureRuntimeProcessDenial(
      outside,
      () => approved(externalRoot, "shell_start", { shell: "cmd", cwd: outside, name: "denied-external-tool" }),
      ({ error }) => error instanceof PathDeniedError
    );
    if (processRecorder.enabled) await processRecorder.observe("SEC02-P28-tool-terminal-external-cwd", toolTerminalActual);

    const httpTerminalActual = await captureRuntimeProcessDenial(
      outside,
      () => directTerminalStart(externalAuthority, { shell: "cmd", cwd: outside, name: "denied-external-http" }),
      ({ error }) => error instanceof PathDeniedError
    );
    if (processRecorder.enabled) await processRecorder.observe("SEC02-P28-http-terminal-external-cwd", httpTerminalActual);
    assert.equal(await exists(markerFile), false);
  } finally {
    toolsModule.capabilityBroker.finishContext(externalRoot);
    await toolsModule.capabilityBroker.retireAuthority(externalAuthority);
  }

  const reparse = path.join(workspace, "outside-junction");
  await fs.symlink(outside, reparse, "junction");
  const reparseAuthority = await makeAuthority({ WORKSPACE_ROOT: reparse, DATA_ROOT: reparse });
  const reparseRoot = toolsModule.capabilityBroker.beginAgentRun(reparseAuthority, session.id);
  try {
    const shellActual = await captureRuntimeProcessDenial(
      reparse,
      () => approved(reparseRoot, "execute_command", { command: deniedCommand, cwd: reparse }),
      ({ value, error }) => error === undefined && /命令执行出错/.test(value)
    );
    if (processRecorder.enabled) await processRecorder.observe("SEC02-P28-shell-reparse-cwd", shellActual);

    const scriptActual = await captureRuntimeProcessDenial(
      reparse,
      () => approved(reparseRoot, "script", { code: deniedScript }),
      ({ value, error }) => error === undefined && /代码执行出错/.test(value)
    );
    if (processRecorder.enabled) await processRecorder.observe("SEC02-P28-script-reparse-cwd", scriptActual);

    const toolTerminalActual = await captureRuntimeProcessDenial(
      reparse,
      () => approved(reparseRoot, "shell_start", { shell: "cmd", cwd: reparse, name: "denied-reparse-tool" }),
      ({ error }) => error instanceof PathDeniedError
    );
    if (processRecorder.enabled) await processRecorder.observe("SEC02-P28-tool-terminal-reparse-cwd", toolTerminalActual);

    const httpTerminalActual = await captureRuntimeProcessDenial(
      reparse,
      () => directTerminalStart(reparseAuthority, { shell: "cmd", cwd: reparse, name: "denied-reparse-http" }),
      ({ error }) => error instanceof PathDeniedError
    );
    if (processRecorder.enabled) await processRecorder.observe("SEC02-P28-http-terminal-reparse-cwd", httpTerminalActual);
    assert.equal(await exists(markerFile), false);
  } finally {
    toolsModule.capabilityBroker.finishContext(reparseRoot);
    await toolsModule.capabilityBroker.retireAuthority(reparseAuthority);
  }

  for (const surface of ["shell", "script", "tool-terminal", "http-terminal"]) {
    await observeBeforeSpawnSwap(surface);
  }

  const terminalAuthority = await makeAuthority();
  const terminalRoot = toolsModule.capabilityBroker.beginAgentRun(terminalAuthority, session.id);
  const terminalOwner = toolsModule.capabilityBroker.getResourceOwner(terminalRoot);
  let terminalId;
  let terminalEvents = [];
  let newAuthorityControlDenied = false;
  let newAuthorityIsolated = false;
  try {
    const started = await approved(terminalRoot, "shell_start", { shell: "cmd", cwd: workspace, name: "sec02-old-authority" });
    terminalId = /ID:\s*(term_[a-z0-9]+)/i.exec(started)?.[1];
    assert(terminalId, started);

    const nextAuthority = await makeAuthority();
    const nextRoot = toolsModule.capabilityBroker.beginAgentRun(nextAuthority, session.id);
    const nextOwner = toolsModule.capabilityBroker.getResourceOwner(nextRoot);
    try {
      newAuthorityIsolated = terminalModule.terminalFacade.list(nextOwner).length === 0;
      const originalLog = console.log;
      console.log = (...args) => {
        if (args[1] === "terminal-owner-denied" && typeof args[2] === "string") {
          try { terminalEvents.push(JSON.parse(args[2])); }
          catch { originalLog(...args); }
          return;
        }
        originalLog(...args);
      };
      try {
        const oldOutput = await toolsModule.executeTool(nextRoot, "shell_output", { terminalId });
        newAuthorityControlDenied = /终端不存在/.test(oldOutput);
      } finally {
        console.log = originalLog;
      }
    } finally {
      toolsModule.capabilityBroker.finishContext(nextRoot);
      await toolsModule.capabilityBroker.retireAuthority(nextAuthority);
    }
  } finally {
    if (toolsModule.capabilityBroker.isContextActive(terminalRoot)) toolsModule.capabilityBroker.finishContext(terminalRoot);
    await toolsModule.capabilityBroker.retireAuthority(terminalAuthority);
  }

  let oldOwnerStale = false;
  try { terminalModule.terminalFacade.list(terminalOwner); }
  catch (error) { oldOwnerStale = error?.code === "PATH_AUTHORITY_STALE"; }
  const terminalActual = {
    oldResourceClosedOrIsolated: oldOwnerStale && newAuthorityIsolated,
    newAuthorityControlDenied,
    denied: newAuthorityControlDenied,
    ...redactedTerminalAuditEvidence(terminalEvents, terminalId),
  };
  assert.deepEqual(terminalActual, {
    oldResourceClosedOrIsolated: true,
    newAuthorityControlDenied: true,
    denied: true,
    auditAttempts: 1,
    auditAllowedFieldsExact: true,
    rawPathsAbsent: true,
  });
  if (processRecorder.enabled) {
    await processRecorder.observe("SEC02-P28-new-authority-old-terminal-control-denied", terminalActual);
  }
});

test("SEC-02 tool Terminal binds CWD and controls to one runtime authority", async () => {
  const authority = await makeAuthority();
  const root = toolsModule.capabilityBroker.beginAgentRun(authority, session.id);
  const owner = toolsModule.capabilityBroker.getResourceOwner(root);
  try {
    const started = await approved(root, "shell_start", { shell: "cmd", cwd: workspace, name: "sec02-process" });
    const id = /ID:\s*(term_[a-z0-9]+)/i.exec(started)?.[1];
    assert(id, started);
    assert.match(started, /PID:\s*null\b/u, "Terminal projection exposed or invented a host PID");

    const cwdCommand = process.platform === "win32"
      ? "echo SEC02_TERMINAL_CWD:%CD%"
      : "printf 'SEC02_TERMINAL_CWD:%s\\n' \"$PWD\"";
    await approved(root, "shell_input", { terminalId: id, input: cwdCommand });
    const output = await waitForTerminalOutput(owner, id, "SEC02_TERMINAL_CWD:");
    assert.match(output.toLowerCase(), new RegExp(workspace.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").toLowerCase()));
    if (toolTerminalRecorder.enabled) await toolTerminalRecorder.positive("SEC02-POS-tool-terminal-cwd");
  } finally {
    if (toolsModule.capabilityBroker.isContextActive(root)) toolsModule.capabilityBroker.finishContext(root);
    await toolsModule.capabilityBroker.retireAuthority(authority);
  }
});
