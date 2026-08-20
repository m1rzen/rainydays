import assert from "node:assert/strict";

const action = process.argv[2];
const task = await import("../../dist/task.js");
const session = await import("../../dist/session.js");
const db = await import("../../dist/db.js");
const persona = { name: "general" };

function exactRows(sessionId) {
  return {
    tasks: db.getTasksBySessionId(sessionId),
    dependencies: db.getTaskDependenciesBySessionId(sessionId),
  };
}

if (action === "seed") {
  const source = session.createSession(persona, "RT-07 source");
  const isolated = session.createSession(persona, "RT-07 isolated");
  const concurrent = session.createSession(persona, "RT-07 concurrent");
  const competingCreates = await Promise.allSettled(Array.from({ length: 8 }, () =>
    Promise.resolve().then(() => task.createTask(concurrent.id, { id: "single_winner", subject: "Single winner" }))
  ));
  assert.equal(competingCreates.filter(result => result.status === "fulfilled").length, 1);
  assert.equal(competingCreates.filter(result => result.status === "rejected" && result.reason?.code === "TASK_ALREADY_EXISTS").length, 7);
  assert.equal(task.getTasksBySession(concurrent.id).length, 1);

  const degreeLimit = session.createSession(persona, "RT-07 degree limit");
  const degreeTimestamp = new Date().toISOString();
  const blockerIds = Array.from({ length: 129 }, (_, index) => `blocker_${String(index).padStart(3, "0")}`);
  db.withTransaction(() => {
    db.insertTaskRow({
      session_id: degreeLimit.id, task_id: "target", subject: "Target", description: null,
      status: "pending", active_form: null, owner: null, metadata_json: "{}", sort_order: 0,
      created_at: degreeTimestamp, updated_at: degreeTimestamp,
    });
    blockerIds.forEach((blockerId, index) => db.insertTaskRow({
      session_id: degreeLimit.id, task_id: blockerId, subject: blockerId, description: null,
      status: "pending", active_form: null, owner: null, metadata_json: "{}", sort_order: index + 1,
      created_at: degreeTimestamp, updated_at: degreeTimestamp,
    }));
  });
  task.updateTask(degreeLimit.id, "target", { addBlockedBy: blockerIds.slice(0, 128) });
  const beforeDegreeOverflow = JSON.stringify(exactRows(degreeLimit.id));
  assert.throws(
    () => task.updateTask(degreeLimit.id, "target", { addBlockedBy: [blockerIds[128]] }),
    error => error?.code === "TASK_LIMIT_EXCEEDED",
  );
  assert.equal(JSON.stringify(exactRows(degreeLimit.id)), beforeDegreeOverflow, "cumulative dependency overflow must be zero-modification");
  assert.equal(task.getTask(degreeLimit.id, "target").blockedBy.length, 128);

  task.createTask(source.id, { id: "setup", subject: "Setup" });
  task.createTask(source.id, {
    id: "build",
    subject: "Build",
    blockedBy: ["setup"],
    owner: "worker-a",
    metadata: { priority: 2, removeMe: true },
  });
  task.createTask(source.id, { id: "release", subject: "Release" });
  task.updateTask(source.id, "build", { addBlocks: ["release"] });

  const beforeBlockedTransitions = JSON.stringify(exactRows(source.id));
  assert.throws(
    () => task.updateTask(source.id, "build", { status: "in_progress" }),
    error => error?.code === "TASK_BLOCKED",
  );
  assert.throws(
    () => task.updateTask(source.id, "build", { status: "completed" }),
    error => error?.code === "TASK_BLOCKED",
  );
  assert.equal(JSON.stringify(exactRows(source.id)), beforeBlockedTransitions, "blocked status transitions must be zero-modification");
  assert.equal(task.getNextPendingTask(source.id)?.id, "setup");
  task.updateTask(source.id, "setup", { status: "completed" });
  task.updateTask(source.id, "build", { status: "in_progress" });

  const beforeCycle = JSON.stringify(exactRows(source.id));
  assert.throws(
    () => task.updateTask(source.id, "setup", { addBlockedBy: ["release"] }),
    error => error?.code === "TASK_CYCLE",
  );
  assert.equal(JSON.stringify(exactRows(source.id)), beforeCycle, "cycle rejection must be zero-modification");
  const beforePrototypeAttack = JSON.stringify(exactRows(source.id));
  assert.throws(
    () => task.updateTask(source.id, "build", { metadata: JSON.parse('{"__proto__":{"polluted":true}}') }),
    error => error?.code === "TASK_INVALID",
  );
  assert.equal(Object.prototype.polluted, undefined);
  assert.equal(JSON.stringify(exactRows(source.id)), beforePrototypeAttack, "invalid metadata must be zero-modification");

  const merged = task.updateTask(source.id, "build", {
    owner: "worker-b",
    metadata: { priority: null, removeMe: null, verified: true },
  });
  assert.equal(JSON.stringify(merged.metadata), '{"verified":true}');
  assert.equal(merged.owner, "worker-b");
  assert.throws(
    () => task.updateTask(source.id, "setup", { status: "pending" }),
    error => error?.code === "TASK_REOPEN_DENIED",
  );

  const fork = session.forkSession(source.id, null, persona);
  assert.equal(
    JSON.stringify(task.getTasksBySession(fork.id)),
    JSON.stringify(task.getTasksBySession(source.id)),
    "forked Task DAG must preserve the exact public projection",
  );

  task.updateTask(source.id, "build", { status: "completed" });
  assert.equal(task.getTask(source.id, "release").blocked, false);
  task.updateTask(source.id, "release", { status: "completed" });
  assert.equal(task.allTasksCompleted(source.id), true);
  task.createTask(source.id, { id: "late", subject: "Late blocker" });
  const beforeCompletedEdge = JSON.stringify(exactRows(source.id));
  assert.throws(
    () => task.updateTask(source.id, "late", { addBlocks: ["release"] }),
    error => error?.code === "TASK_BLOCKED",
  );
  assert.equal(JSON.stringify(exactRows(source.id)), beforeCompletedEdge, "completed task blocker mutation must be zero-modification");
  task.removeTask(source.id, "late");

  task.createTask(isolated.id, { id: "setup", subject: "Independent setup" });
  assert.equal(task.getTask(isolated.id, "setup").subject, "Independent setup");
  assert.throws(
    () => task.updateTask(isolated.id, "build", { status: "completed" }),
    error => error?.code === "TASK_NOT_FOUND",
  );
  assert.equal(task.getTask(source.id, "build").status, "completed");

  task.removeTask(source.id, "build");
  assert.equal(task.getTask(source.id, "setup").blocks.length, 0);
  assert.equal(task.getTask(source.id, "release").blockedBy.length, 0);
  assert.equal(task.getTask(fork.id, "release").blockedBy.join(","), "build");

  console.log(JSON.stringify({
    sourceId: source.id,
    isolatedId: isolated.id,
    forkId: fork.id,
    source: task.getTasksBySession(source.id),
    isolated: task.getTasksBySession(isolated.id),
    fork: task.getTasksBySession(fork.id),
  }));
  db.closeDb();
} else if (action === "agent") {
  const [{ Agent }, { ConversationMemory }, { createEffectivePersona }, toolRegistry, { pathPolicy }, { disableSupervisor }] = await Promise.all([
    import("../../dist/agent.js"),
    import("../../dist/memory.js"),
    import("../../dist/persona.js"),
    import("../../dist/tools/index.js"),
    import("../../dist/path-runtime.js"),
    import("../../dist/supervisor.js"),
  ]);
  class FakeLlm {
    responses = [];
    seenMessages = [];
    queue(...responses) { this.responses.push(...responses); }
    async chat() { throw new Error("unexpected non-streaming LLM call"); }
    async *chatStream(messages) {
      this.seenMessages.push(messages.map(message => ({ ...message })));
      const message = this.responses.shift();
      assert(message, "RT-07 fake LLM response queue is empty");
      yield { type: "result", message };
    }
  }
  const assistant = (content, toolCalls) => ({ role: "assistant", content, ...(toolCalls ? { tool_calls: toolCalls } : {}) });
  const personaDefinition = createEffectivePersona({
    name: "rt07-agent",
    displayName: "RT-07 Agent",
    description: "RT-07 task driver fixture",
    tools: ["task_create", "task_update", "task_list", "task_get", "task_delete"],
    env: { WORKSPACE_ROOT: process.env.RAINYDAYS_USER_DATA_DIR },
    allowedRoots: [process.env.RAINYDAYS_USER_DATA_DIR],
    networkPolicy: { mode: "deny" },
    systemPrompt: "RT-07 task driver fixture",
  });
  const pathAuthority = await pathPolicy.createAuthority([{
    rootId: "workspace",
    role: "workspace",
    configuredPath: process.env.RAINYDAYS_USER_DATA_DIR,
    permissions: ["read-file", "read-directory", "search-tree", "create-file", "replace-file", "create-directory", "watch-directory", "initial-cwd", "reveal"],
  }]);
  const authority = toolRegistry.capabilityBroker.createRuntimeAuthority({
    name: personaDefinition.name,
    tools: personaDefinition.tools,
    env: personaDefinition.env,
    systemPrompt: personaDefinition.systemPrompt,
    allowedRoots: personaDefinition.allowedRoots,
    rootEnv: { WORKSPACE_ROOT: "workspace" },
    pathAuthority,
    networkPolicy: personaDefinition.networkPolicy,
    digest: personaDefinition.digest,
  });
  const source = session.createSession(personaDefinition, "RT-07 Agent driver");
  task.createTask(source.id, { id: "root", subject: "Root" });
  task.createTask(source.id, { id: "child", subject: "Child", blockedBy: ["root"] });
  const llm = new FakeLlm();
  const memory = new ConversationMemory(80);
  const agent = new Agent(llm, memory, personaDefinition, authority, null);
  agent.setSession(source.id);
  disableSupervisor();
  const collect = async input => {
    const events = [];
    for await (const event of agent.run(input)) events.push(event);
    return events;
  };
  try {
    llm.queue(assistant("driver resumed"));
    await collect("continue the persisted task plan");
    const firstPrompt = llm.seenMessages[0].filter(message => message.role === "system").map(message => message.content).join("\n");
    assert.match(firstPrompt, /下一个未阻塞任务: \[root\]/u);
    assert.doesNotMatch(firstPrompt, /下一个未阻塞任务: \[child\]/u);

    llm.queue(
      assistant("", [{ id: "blocked-update", type: "function", function: { name: "task_update", arguments: JSON.stringify({ task_id: "child", status: "in_progress" }) } }]),
      assistant("blocked update observed"),
    );
    const events = await collect("try the blocked child");
    const result = events.find(event => event.type === "tool_result");
    assert.equal(result?.toolStatus, "error");
    assert.equal(events.some(event => event.type === "task_update"), false);
    assert.equal(task.getTask(source.id, "child").status, "pending");
    console.log(JSON.stringify({ resumedPersistedDag: true, selectedTask: "root", blockedFailureEventSuppressed: true }));
  } finally {
    toolRegistry.capabilityBroker.revokeAuthority(authority);
    db.closeDb();
  }
} else if (action === "tools") {
  const tools = await import("../../dist/tools/task-tools.js");
  const source = session.createSession(persona, "RT-07 tools");
  const isolated = session.createSession(persona, "RT-07 tools isolated");
  const env = { _SESSION_ID: source.id };
  assert.equal(
    [tools.taskCreateDef, tools.taskUpdateDef, tools.taskListDef, tools.taskGetDef, tools.taskDeleteDef].map(entry => entry.function.name).join(","),
    "task_create,task_update,task_list,task_get,task_delete",
  );
  await assert.rejects(() => tools.taskCreateExec({ id: "missing", subject: "Missing" }), /当前会话/u);
  await tools.taskCreateExec({ id: "root", subject: "Root" }, env);
  await tools.taskCreateExec({ id: "child", subject: "Child", blocked_by: ["root"], owner: "agent-a" }, env);
  await tools.taskCreateExec({
    id: "peer",
    subject: "Peer",
    description: "full create adapter",
    metadata: { kind: "coverage" },
    active_form: "preparing peer",
    owner: "agent-b",
  }, env);
  await tools.taskUpdateExec({
    task_id: "root",
    subject: "Root updated",
    description: "full update adapter",
    active_form: "waiting for peer",
    owner: "agent-c",
    metadata: { updated: true },
    add_blocked_by: ["peer"],
    add_blocks: ["child"],
  }, env);
  const blockedList = await tools.taskListExec({}, env);
  assert.match(blockedList, /\[B\].*\[O:agent-a\].*child/u);
  const detail = JSON.parse(await tools.taskGetExec({ task_id: "child" }, env));
  assert.equal(detail.blocked, true);
  assert.equal(detail.blockedBy.join(","), "root");
  await tools.taskUpdateExec({ task_id: "peer", status: "completed" }, env);
  await tools.taskUpdateExec({ task_id: "root", status: "completed" }, env);
  assert.match(await tools.taskListExec({ filter: "completed" }, env), /Root updated/u);
  const active = await tools.taskUpdateExec({ task_id: "child", status: "in_progress", metadata: { attempt: 1 } }, env);
  assert.match(active, /in_progress/u);
  await tools.taskUpdateExec({ task_id: "child", status: "deleted" }, env);
  assert.throws(() => task.getTask(source.id, "child"), error => error?.code === "TASK_NOT_FOUND");
  await tools.taskCreateExec({ id: "removable", subject: "Removable" }, env);
  assert.match(await tools.taskDeleteExec({ task_id: "removable" }, env), /removable/u);

  task.createTask(isolated.id, { id: "root", subject: "Isolated root" });
  const cleared = await tools.taskDeleteExec({ all: true }, env);
  assert.match(cleared, /2 个任务/u);
  assert.equal(await tools.taskListExec({}, env), "当前会话没有匹配的任务。");
  assert.equal(task.getTasksBySession(source.id).length, 0);
  assert.equal(task.getTasksBySession(isolated.id).length, 1);
  await assert.rejects(() => tools.taskDeleteExec({}, env), /必须且只能/u);
  console.log(JSON.stringify({ names: ["task_create", "task_update", "task_list", "task_get", "task_delete"], sessionScopedClear: true, blockedProjection: true }));
  db.closeDb();
} else if (action === "verify") {
  const sourceId = process.env.RT07_SOURCE_ID;
  const isolatedId = process.env.RT07_ISOLATED_ID;
  const forkId = process.env.RT07_FORK_ID;
  assert(sourceId && isolatedId && forkId, "RT-07 verification identities are missing");
  assert.equal(db.getDatabaseSchemaVersion(), 3);
  const source = task.getTasksBySession(sourceId);
  const isolated = task.getTasksBySession(isolatedId);
  const fork = task.getTasksBySession(forkId);
  assert.equal(source.map(entry => entry.id).join(","), "setup,release");
  assert.equal(isolated.map(entry => entry.id).join(","), "setup");
  assert.equal(fork.map(entry => entry.id).join(","), "setup,build,release");
  assert.equal(fork.find(entry => entry.id === "build")?.blockedBy.join(","), "setup");
  assert.equal(fork.find(entry => entry.id === "release")?.blockedBy.join(","), "build");
  console.log(JSON.stringify({ schemaVersion: 3, source, isolated, fork }));
  db.closeDb();
} else {
  throw new Error(`Unknown RT-07 fixture action: ${action}`);
}
