# SEC-01 CapabilityBroker Frozen Architecture

Status: frozen after two independent challenge reviews (2026-07-18)  
Canonical task: `LUX-DESKTOP-100-PARITY-EXECUTION-SPEC.md` SEC-01  
Discovery evidence: `parity/reports/sec-01-discovery.json`

## 1. Security objective

Every tool execution and every direct high-risk API operation must be authorized at the execution point by one process-local `CapabilityBroker`. Provider-visible tool definitions, Persona files, HTTP authentication and Supervisor advice are not execution authority.

A denied request must invoke no executor and produce no external side effect.

## 2. Frozen trust boundaries

Trusted in SEC-01:

- the in-process Broker implementation and its private ledgers;
- the static tool registry compiled into the application;
- explicit internal runtime-tool registration call sites;
- authenticated server middleware only as the source of a local-user API principal.

Untrusted in SEC-01:

- model/provider tool names and JSON arguments;
- serialized, cloned or caller-constructed context-shaped objects;
- Persona files after a run context has been issued;
- child Agent and Playbook requested capabilities;
- Supervisor output;
- dynamic-tool names and definitions presented by callers;
- session IDs, environment variables or grant IDs supplied as ordinary arguments.

SEC-01 does not claim that an already-authorized executor is sandboxed. That is SEC-03.

## 3. Mandatory invariants

1. **One structural authority**: `executeTool` and controlled direct-operation facades call the same process-local Broker before any executor or manager method. Static dependency tests forbid raw executor or manager mutation imports outside these boundaries.
2. **No context, no execution**: missing, serialized, cloned, forged, revoked or stale contexts are denied.
3. **Runtime authenticity**: TypeScript `readonly` is insufficient. Issued context object identity must exist in a Broker-private `WeakMap`; Broker copies inputs and deeply freezes the public object and every nested value.
4. **No capability exposure**: authentic contexts never enter Provider messages, tool arguments, HTTP JSON, persistence, logs, general executor environments or arbitrary executors. Context forwarding is capability transfer and is forbidden.
5. **Exact binding set**: an empty allowed-tool set means no tools. Private authority binds immutable tool registration IDs, exact executor identity, schema digest and policy digest—not only names.
6. **Snapshot freshness**: context binds `sessionId`, `runId`, principal kind, persisted Session↔Persona match, effective Persona digest, authority epoch, tool bindings, roots, network policy and all risk classes.
7. **Execution-point recheck**: provider definition filtering and dispatcher authorization use the same issued snapshot, but dispatcher authorization is always repeated.
8. **Broker-owned environment**: callers cannot pass `_SESSION_ID`, roots or Persona environment to `executeTool`; Broker derives a frozen minimal executor environment from its private context record.
9. **No replacement**: runtime tools cannot replace static tools, cannot be re-registered in place under the same authority, and cannot replace another authority's runtime tool. A changed executor requires a new registration and new contexts.
10. **Child attenuation only**: child bindings, roots, network policy and risk classes are subsets of the parent. They can never broaden authority or substitute a same-name registration.
11. **No grant inheritance**: SubAgent and Playbook children receive no approval challenge or grant. SEC-01 grants are one-call and non-delegable.
12. **Supervisor is advisory and model-immutable**: Supervisor may deny or request escalation. Approval/disabled/error state never creates a grant, and Agent/SubAgent/Playbook principals cannot change Supervisor state.
13. **Exact challenge and grant**: both approval challenge and resulting grant bind session, run, parent context, immutable tool binding or direct operation, canonical argument digest, expiry and one-use nonce. Cross-run response, replay or changed arguments are denied.
14. **Strict immutable input**: malformed JSON, non-object arguments, unknown tools and schema-invalid arguments are denied. Validation, approval display, digest and executor all use one canonical deep-frozen argument snapshot. No `{}` fallback or coercive reparse.
15. **Direct API separation and ownership**: a local-user API context authorizes one exact operation and argument digest only. It cannot execute Agent tools; Agent contexts cannot invoke direct facades. Terminal resources are owner-bound by Session/principal, and IDs are not capabilities.
16. **Revoke before publish**: Persona/Settings reload, Persona switch, session switch/deletion, runtime rebuild and shutdown revoke affected contexts, challenges, grants and runtime bindings before exposing replacement state. Run completion revokes only that run tree.
17. **Current-runtime single flight**: until RT-01, one shared Agent/runtime accepts at most one root run. A second chat is rejected before memory mutation or context issuance. Dispatcher/grant concurrency remains safe within the active run.
18. **Deterministic denial**: denial has a stable code and safe message; it does not expose contexts, grant tokens, internal nonces, secrets or absolute policy data.
19. **Zero-side-effect proof**: tests instrument executor/manager invocation counts, registry state, Supervisor state, filesystem/process/Terminal probes and approval ledgers; string output alone is not proof.

## 4. Types and private records

The implementation may refine names but not semantics.

```ts
type PrincipalKind = "agent" | "subagent" | "playbook" | "local-user-api";
type RiskClass = "read" | "write" | "network" | "process" | "control";
type NetworkPolicy =
  | { mode: "deny" }
  | { mode: "loopback" }
  | { mode: "allowlist"; origins: readonly string[] }
  | { mode: "unrestricted" }; // explicit transitional policy; SEC-03 must remove or enforce it

interface CapabilityContext {
  readonly contextId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly parentContextId: string | null;
  readonly principal: PrincipalKind;
  readonly persona: { readonly name: string; readonly digest: string };
  readonly authorityEpoch: number;
  readonly allowedTools: readonly string[]; // display only; private bindings are authoritative
  readonly allowedRoots: readonly string[];
  readonly networkPolicy: NetworkPolicy;
  readonly allowedRiskClasses: readonly RiskClass[];
  readonly approvalGrant: {
    readonly grantId: string;
    readonly registrationId: string;
    readonly toolOrOperation: string;
    readonly argumentsDigest: string;
    readonly expiresAt: string;
  } | null;
}

interface ToolBinding {
  readonly name: string;
  readonly registrationId: string;
  readonly ownerAuthorityId: string;
  readonly ownerEpoch: number;
  readonly definitionDigest: string;
  readonly policyDigest: string;
  readonly executorIdentity: Function;
}
```

The public object contains identifiers, not authority secrets. Authority comes from object identity and the private record:

```ts
interface PrivateCapabilityRecord {
  publicContext: CapabilityContext;
  active: boolean;
  effectivePersonaDigest: string;
  executorEnv: Readonly<Record<string, string>>;
  toolBindings: ReadonlyMap<string, ToolBinding>;
  allowedRoots: ReadonlySet<string>;
  allowedRiskClasses: ReadonlySet<RiskClass>;
  networkPolicy: NetworkPolicy;
  challengeNonce: string | null;
  challengeConsumed: boolean;
  grantNonce: string | null;
  grantConsumed: boolean;
}
```

A JSON round trip, object spread, `structuredClone`, manually copied `contextId`, or object from another Broker instance must fail authenticity validation. Broker inputs are copied before freezing; caller-owned arrays, policy objects and Persona objects are never retained. The authentic context is used only by trusted orchestration and the dispatcher. General executors receive a frozen argument snapshot, minimal environment and capability-limited invocation services—not the context itself.

## 5. Effective Persona identity

`PersonaDefinition` gains a deterministic `digest`. It is SHA-256 over canonical JSON of the effective security-relevant Persona snapshot:

- name;
- exact ordered/deduplicated tool names;
- effective runtime environment after Settings injection;
- system prompt including loaded Skills.

Persona loading rejects duplicate/non-string tool names, unknown tools, malformed environment values and reserved authority environment keys. Runtime Settings application recomputes the effective digest rather than retaining the source digest.

Effective Persona policy also declares roots and a network envelope. Missing network policy means `deny`; built-in Personas that require network access must explicitly declare `loopback`, a concrete origin allowlist or transitional `unrestricted`. An empty allowlist never means unrestricted. SEC-01 binds and attenuates this policy; socket-level enforcement remains SEC-03.

A run keeps its issued snapshot. Reloading, Settings changes or switching Persona revokes the old authority before publishing the replacement. The Broker validates that the persisted Session `persona_name` equals the effective Persona name. A missing/deleted/unloadable Persona leaves history readable but makes a tool run ineligible; it never silently falls back to the current Persona.

## 6. Broker lifecycle

### 6.1 Root run

`beginAgentRun` requires a real persisted Session whose `persona_name` matches the effective Persona. It rejects a second root run on the current shared runtime before memory mutation, creates a fresh `runId`, snapshots exact immutable tool bindings and policy, registers an active private record and returns a deeply frozen root context.

Provider definitions are obtained with `getToolDefinitions(context)`. The registry returns definitions from the exact bindings frozen into that authentic active context. Unknown Persona tools fail issuance; they are not silently dropped. A tool registered after context issuance does not appear in that context.

The Agent captures session ID, Persona snapshot, run ID, root context and bindings in run-local constants. Authorization and tool-result routing never reread mutable `this.sessionId`, `currentSessionId`, `currentPersona` or a global current context. `finishRun` revokes the root, every descendant, every attached challenge/grant and all run-scoped runtime tools in `finally`; it does not affect another authority.

### 6.2 Persona/session/runtime changes

The Broker maintains an epoch per runtime authority. These events increment or retire the epoch:

- Persona switch or reload affecting the current effective Persona;
- session switch or deletion;
- LLM/runtime Agent rebuild;
- server shutdown.

Authorization compares the private record with the current epoch and active persisted Session/Persona binding. Every transition is synchronous `revoke-before-publish`: mark old authority exiting, revoke its contexts/descendants/challenges/grants/registrations, then expose replacement runtime state. No module-level or async-local `currentContext` may select authority implicitly.

### 6.3 Child derivation

`deriveChild(parent, request)` validates the authentic active parent and computes intersections; it never trusts the child-provided final sets.

- tool authority: immutable parent bindings are intersected; a same-name different registration never qualifies.
- SubAgent: requested bindings intersect parent bindings, and `subagent` is forcibly removed.
- Playbook: requested bindings intersect parent bindings, and recursive `playbook_execute` is forcibly removed.
- roots: exact-string subset during SEC-01; canonical path semantics are added by SEC-02.
- network: may move only toward `deny`, `loopback`, a smaller concrete allowlist, or from explicit `unrestricted` to a stricter mode.
- risk classes: strict subset or equality.
- approval challenge/grant and registration authority: cleared.

Child contexts retain parent session, run, Persona digest and authority epoch. Supplying a different value is a denial, not a normalization. Playbook run/abort resources are owner-bound to the parent Session/run lineage, so a child cannot abort another Session's run.

## 7. Approval model

Tool policy metadata is complete and explicit for every static/runtime tool and direct operation:

```ts
interface ToolPolicy {
  riskClasses: readonly RiskClass[];
  approval: "none" | "user";
  effects: readonly ("filesystem" | "network" | "process" | "control")[];
}
```

Missing policy metadata prevents registration/startup. Unknown risk does not default to read-only. Composite tools such as download or shell declare every applicable risk/effect; authorization must satisfy all entries. Runtime registration cannot self-report a weaker replacement policy.

Flow:

1. Strictly parse JSON, require a plain object, schema-validate without coercion, canonicalize, copy and deeply freeze one argument snapshot.
2. Broker checks context authenticity, freshness, exact registration binding, ownership, every risk class and network envelope.
3. Supervisor may deny, request escalation or advise approve. Agent/SubAgent/Playbook cannot change Supervisor state; `supervise on/off/rules` is local-user control-plane only.
4. If user approval is required, Broker creates a cryptographically random challenge bound to session, run, parent context, registration ID, argument digest, expiry and response principal/channel.
5. Only a structured explicit positive choice can atomically consume that challenge. Free-text substring matching cannot authorize execution.
6. Broker mints a derived context containing only that exact binding and call grant.
7. Dispatcher reauthorizes, then synchronously marks the grant consumed immediately before executor invocation, with no intervening `await`.
8. Executor runs at most once. Throw, timeout or other failure does not restore the grant.

Challenge and grant lifetime is at most 60 seconds, one use and non-delegable. Parent/run revocation invalidates both. Cross-session/run responses, duplicate answers, changed bindings/arguments and concurrent replay are denied. Failed authorization does not consume unrelated grants.

Supervisor disabled/uninitialized/failed/invalid/timeout is never equivalent to approval. Supervisor `approve` remains advice; Supervisor `deny` is terminal.

## 8. Tool registry and dispatcher

Static and runtime registrations are separate.

- Static tool names are unique at startup, and every `RegisteredTool.name` equals `definition.function.name`.
- Runtime registration requires an authentic Broker-private registration authority that is never exposed to a general executor.
- Each registration gets an immutable random `registrationId`; definition/schema/policy are copied, digested and deeply frozen, and executor function identity is pinned.
- Runtime registration is indexed by authority plus registration ID. Names are lookup labels, not authority.
- A runtime name equal to any static name is rejected.
- Same-authority same-name re-registration is rejected; replacing an executor requires a new authority epoch and newly issued contexts.
- Different authorities may own same-name runtime tools, but context bindings resolve only their pinned registration/executor.
- Registration after context issuance never changes that context's bindings.
- Revoking the authority removes or invalidates its runtime tools.

Frozen dispatcher shape:

```ts
executeTool(
  context: CapabilityContext,
  name: string,
  args: Record<string, unknown>
): Promise<string>
```

No caller-supplied executor environment is accepted. The fixed order is: strict parse → non-coercive schema validation → frozen argument snapshot → authentic context/freshness/session check → pinned binding/owner check → risk/network/root envelope → exact grant check and atomic consume → invoke the already-pinned executor exactly once. No mutable global name lookup occurs after authorization.

General executors receive only the frozen arguments, Broker-owned minimal environment and capability-limited invocation services. They do not receive the root context or runtime registration authority. Child-producing executors receive a closure that can request attenuation but cannot export parent authority.

Authorization denial is represented by `CapabilityDeniedError` with stable codes such as:

- `CAPABILITY_CONTEXT_REQUIRED`
- `CAPABILITY_CONTEXT_FORGED`
- `CAPABILITY_CONTEXT_STALE`
- `CAPABILITY_SESSION_MISMATCH`
- `CAPABILITY_TOOL_DENIED`
- `CAPABILITY_BINDING_MISMATCH`
- `CAPABILITY_RISK_DENIED`
- `CAPABILITY_APPROVAL_CHALLENGE_INVALID`
- `CAPABILITY_GRANT_REQUIRED`
- `CAPABILITY_GRANT_INVALID`
- `CAPABILITY_GRANT_REPLAYED`
- `CAPABILITY_DYNAMIC_OWNER_MISMATCH`
- `CAPABILITY_RUN_BUSY`
- `TOOL_ARGUMENTS_INVALID`

The dispatcher may convert these to a safe tool-result string for the model, but tests and callers must retain the code. Executor exceptions remain distinct from authorization denial.

## 9. Agent, SubAgent and Playbook integration

### Agent

- Strict JSON parsing replaces `{}` fallback; validation, approval and execution share one frozen snapshot.
- `run()` rejects a concurrent root run before memory mutation, captures immutable run-local session/Persona values, obtains a root context after persisted Session binding and releases it in `finally`.
- definitions and executions use that same context and pinned registrations.
- `_SESSION_ID` and Persona env come from Broker private state.
- Supervisor advice occurs before optional grant derivation, never instead of Broker authorization.
- model calls to `supervise on/off/rules` are denied without changing Supervisor state; only status may remain model-visible.

### SubAgent

- the parent dynamic executor receives capability-limited derivation services, not the authentic parent context or arbitrary env authority.
- child context is derived by Broker from pinned parent bindings and always attenuated.
- definitions and executions use the child context.
- malformed JSON ends that tool call with no executor invocation.
- child approval-required tools fail closed; no parent grant is inherited.
- child context is revoked in `finally`.

### Playbook

- the parent executor uses capability-limited services to derive an attenuated Playbook context.
- it cannot broaden tools using a Persona-shaped object or replace a binding by same name.
- recursive Playbook execution is removed, and run/abort resources are Session/run owner-bound.
- context is revoked in `finally` and parent revocation cascades.

## 10. Controlled direct-operation bridge

Every Terminal operation—`list`, `start`, `output`, `input`, `clear`, `kill`, `close`, and event subscription—is explicitly classified and enters one controlled facade before the raw manager. Direct OS reveal (`file:reveal`) also enters the manifest because it launches a system process. Shutdown-only cleanup uses a separate internal lifecycle authority.

After existing API authentication, the server mints a short-lived process-local `local-user-api` context bound to the current persisted Session, exact operation, HTTP route parameters/body canonical digest, expiry and one use. No current Session means denial. Client JSON/header/query never supplies or reconstructs a context, grant, authority or owner Session. The direct context has no Agent tool bindings and cannot be passed to `executeTool`.

`terminal:start` records immutable resource ownership at least as owner Session and principal. Every later read, subscription or mutation checks that owner; list is filtered. Knowing a Terminal ID is not authority. Session B cannot read or operate Session A's Terminal.

Raw Terminal mutators are accessible only to the controlled facade and trusted shutdown adapter; Agent terminal tools and HTTP routes cannot import or call them directly. A static source-boundary test enforces this rule, so authorization is structural rather than a call-site convention.

SEC-01 proves that direct manager calls cannot bypass the Broker and resources cannot cross Session ownership. It does **not** prove a genuine UI user gesture or eliminate API-token theft/query leakage; SEC-04 must replace this provisional principal with IPC/MessagePort and short-lived user-gesture grants.

## 11. Explicit deferrals

- SEC-02: `realpath`, junction/symlink, UNC/device/ADS, new-file parent and TOCTOU PathPolicy.
- SEC-03: environment allowlist, network enforcement inside executors, OS sandbox, CPU/memory/process/output limits and process-tree termination.
- SEC-04: token transport removal, Origin precision, IPC migration and genuine short-lived UI gesture proof.
- SEC-06: durable tamper-resistant structured audit chain.
- RT-01: full independent multi-session runtime and queueing semantics.

The SEC-01 Broker fields and denial events are required seams for these cards, not claims that they are already implemented.

## 12. Fixed attack and regression contract

The implementation is not complete until machine tests prove all scenarios below and verify executor/manager invocation count remains zero on denial:

1. missing context;
2. object-spread/JSON/structured-clone/manual/other-Broker context forgery;
3. attempted mutation of every deep-frozen nested input;
4. unknown Provider tool;
5. known tool absent from Persona binding snapshot;
6. stale context after Persona/Skill/Settings reload, switch or runtime rebuild;
7. context used after session switch/deletion or run completion;
8. persisted Session Persona missing or mismatched, with no fallback;
9. second root run rejected before memory/context/approval mutation;
10. runtime tool attempting to override a static tool or mismatching definition name;
11. same-authority same-name runtime re-registration after context issuance;
12. same-name runtime bindings in authorities A/B resolve only their pinned marker executor;
13. mutation of caller-owned registration definition/policy after registration has no effect;
14. malformed JSON, null, primitive, array and non-plain-object arguments;
15. schema-invalid arguments without coercion;
16. validated arguments cannot change between approval digest and executor;
17. SubAgent requests a parent-forbidden or same-name different binding;
18. SubAgent recursion or parent grant inheritance attempt;
19. Playbook forbidden binding/recursion and cross-Session abort attempt;
20. Supervisor disabled/uninitialized/error/approve cannot authorize a user-approval tool;
21. Agent/SubAgent/Playbook attempts `supervise off` without changing state;
22. approval challenge cross-run/session swap, duplicate answer, expiry and ambiguous free text;
23. grant reused with changed registration/tool/arguments;
24. two concurrent uses of one grant invoke the executor exactly once;
25. expired/cross-run/cross-session/revoked grant and retry after executor throw;
26. parallel batch mixes one authorized and one unauthorized call without invoking the denied executor;
27. direct operation with missing/forged/expired/wrong-principal context;
28. local-user API context passed to Agent dispatcher and Agent context passed to direct facade;
29. Session B lists, reads, subscribes to or mutates Session A Terminal;
30. direct operation context replay or route/Terminal/body argument change;
31. static source-boundary checks plus unified denial probes leave executor/manager counts, filesystem, process, Terminal, Supervisor, registry and approval ledgers unchanged.

Positive regressions must cover authorized static read, authorized write with exact grant, attenuated child read, scoped runtime binding, current-session Terminal read/mutation through the facade, file reveal through the direct manifest, structured approval response and existing GOV-03/GOV-04 gates.

## 13. Implementation sequence

1. Add Broker/types/errors and unit tests for authenticity, lifecycle, single-flight, attenuation, challenges and grants.
2. Add Persona digest, explicit network envelope and persisted Session binding validation.
3. Add complete multi-risk policy manifests for every static/runtime tool and direct operation.
4. Remove duplicate dynamic registration, then refactor immutable registration bindings/runtime ownership and reject every collision.
5. Make definitions and dispatcher context-mandatory; remove caller env and add strict frozen argument validation.
6. Migrate Agent run-local snapshot, root context, structured approval challenge/grant flow and model-immutable Supervisor control.
7. Migrate SubAgent and Playbook child contexts and owner-bound Playbook control resources.
8. Add the controlled Terminal/file-reveal facade, Terminal resource ownership and static import boundary.
9. Add the fixed 31-scenario attack matrix and positive regressions.
10. Run targeted tests, GOV-03 quick/self-test, static gates and GOV-04 local gate.
11. Hand evidence to Debugger and independent Reviewer; Developer conclusions are non-authoritative.

## 14. Freeze rule

After this document reaches `frozen`, implementation may change names and internal organization but may not weaken Sections 3, 6, 7, 8, 10 or 12. Any weakening or scope change requires a numbered Architect amendment committed beside this document before code changes.
