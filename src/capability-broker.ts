import { createHash, randomBytes, randomUUID } from "node:crypto";
import { PathDeniedError, type ExecutionRootAccess, type PathAuthority, type PathOperation, type PathPolicy } from "./path-policy.js";
import type { ScopedPathGateway, ToolDefinition, ToolExecutor, ToolInvocationServices } from "./types.js";
import {
  assertResourceOwner,
  issueResourceOwner,
  registerOwnedResource,
  retireResourceOwner,
  type ResourceOwner,
} from "./resource-owner.js";

export type PrincipalKind = "agent" | "subagent" | "playbook" | "local-user-api";
export type RiskClass = "read" | "write" | "network" | "process" | "control";
export type ToolEffect = "filesystem" | "network" | "process" | "control";
export type NetworkPolicy =
  | { mode: "deny" }
  | { mode: "loopback" }
  | { mode: "allowlist"; origins: readonly string[] }
  | { mode: "unrestricted" };

export interface ToolPolicy {
  readonly riskClasses: readonly RiskClass[];
  readonly approval: "none" | "user";
  readonly effects: readonly ToolEffect[];
  /** Exact PathPolicy operations available to this binding; omitted means none. */
  readonly pathOperations?: readonly PathOperation[];
  /** Fixed execution-root mask. Omitted means the binding cannot launch a payload. */
  readonly executionRootAccess?: ExecutionRootAccess;
}

export interface CapabilityToolRegistration {
  readonly name: string;
  readonly definition: ToolDefinition;
  readonly executor: ToolExecutor;
  readonly policy: ToolPolicy;
}

export interface EffectivePersonaInput {
  readonly name: string;
  readonly tools: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly systemPrompt: string;
  /** Raw configured roots participate only in the pre-existing Persona identity, never authorization. */
  readonly allowedRoots: readonly string[];
  readonly rootEnv: Readonly<Record<string, string | null>>;
  readonly pathAuthority: PathAuthority;
  readonly networkPolicy: NetworkPolicy;
  readonly digest?: string;
}

export interface RuntimeAuthority {
  readonly authorityId: string;
}

export interface LocalApiPrincipal {
  readonly principalId: string;
}

export interface CapabilityContext {
  readonly contextId: string;
  readonly executionDomainId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly parentContextId: string | null;
  readonly principal: PrincipalKind;
  readonly persona: Readonly<{ name: string; digest: string }>;
  readonly authorityEpoch: number;
  readonly allowedTools: readonly string[];
  readonly allowedRoots: readonly string[];
  readonly networkPolicy: NetworkPolicy;
  readonly allowedRiskClasses: readonly RiskClass[];
  readonly approvalGrant: Readonly<{
    grantId: string;
    registrationId: string;
    toolOrOperation: string;
    argumentsDigest: string;
    expiresAt: string;
  }> | null;
}

export interface ApprovalChallenge {
  readonly challengeId: string;
  readonly runtimeAuthorityId: string;
  readonly authorityEpoch: number;
  readonly sessionId: string;
  readonly runId: string;
  readonly contextId: string;
  readonly registrationId: string;
  readonly toolName: string;
  readonly responsePrincipal: "local-user-api";
  readonly responseChannel: "ask-user" | "native-process";
  readonly argumentsDigest: string;
  readonly expiresAt: string;
}

export type CapabilityDenialCode =
  | "CAPABILITY_CONTEXT_REQUIRED"
  | "CAPABILITY_CONTEXT_FORGED"
  | "CAPABILITY_CONTEXT_STALE"
  | "CAPABILITY_SESSION_MISMATCH"
  | "CAPABILITY_TOOL_DENIED"
  | "CAPABILITY_BINDING_MISMATCH"
  | "CAPABILITY_RISK_DENIED"
  | "CAPABILITY_APPROVAL_CHALLENGE_INVALID"
  | "CAPABILITY_GRANT_REQUIRED"
  | "CAPABILITY_GRANT_INVALID"
  | "CAPABILITY_GRANT_REPLAYED"
  | "CAPABILITY_DYNAMIC_OWNER_MISMATCH"
  | "CAPABILITY_ATTENUATION_INVALID"
  | "CAPABILITY_RUN_BUSY"
  | "CAPABILITY_REGISTRATION_INVALID"
  | "CAPABILITY_DIRECT_OPERATION_DENIED";

export class CapabilityDeniedError extends Error {
  readonly code: CapabilityDenialCode;

  constructor(code: CapabilityDenialCode, message: string) {
    super(message);
    this.name = "CapabilityDeniedError";
    this.code = code;
  }
}

function denied(code: CapabilityDenialCode, message: string): never {
  throw new CapabilityDeniedError(code, message);
}

function cloneJsonValue(value: unknown, label: string): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((entry, index) => cloneJsonValue(entry, `${label}[${index}]`));
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError(`${label} must be plain JSON data`);
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) result[key] = cloneJsonValue(entry, `${label}.${key}`);
    return result;
  }
  throw new TypeError(`${label} contains unsupported data`);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function frozenCopy<T>(value: T, label: string): T {
  return deepFreeze(cloneJsonValue(value, label) as T);
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((key) => [key, canonicalize((value as Record<string, unknown>)[key])]));
  }
  return value;
}

export function canonicalDigest(value: unknown): string {
  const copied = cloneJsonValue(value, "digest input");
  return createHash("sha256").update(JSON.stringify(canonicalize(copied))).digest("hex");
}

const riskClasses = new Set<RiskClass>(["read", "write", "network", "process", "control"]);
const effects = new Set<ToolEffect>(["filesystem", "network", "process", "control"]);
const reservedEnv = new Set([
  "_SESSION_ID",
  "_CAPABILITY_CONTEXT_ID",
  "_CAPABILITY_RUN_ID",
  "_CAPABILITY_PRINCIPAL",
  "_CAPABILITY_ALLOWED_ROOTS",
]);

function uniqueStrings(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values) || values.some((entry) => typeof entry !== "string" || entry.length === 0)) throw new TypeError(`${label} must contain non-empty strings`);
  if (new Set(values).size !== values.length) throw new TypeError(`${label} contains duplicates`);
  return [...values];
}

function copyNetworkPolicy(policy: NetworkPolicy): NetworkPolicy {
  if (!policy || !["deny", "loopback", "allowlist", "unrestricted"].includes(policy.mode)) throw new TypeError("network policy is invalid");
  if (policy.mode === "allowlist") return deepFreeze({ mode: "allowlist", origins: deepFreeze(uniqueStrings(policy.origins, "network origins")) });
  return deepFreeze({ mode: policy.mode });
}

function copyPolicy(policy: ToolPolicy): ToolPolicy {
  const risks = uniqueStrings(policy.riskClasses, "risk classes") as RiskClass[];
  const toolEffects = uniqueStrings(policy.effects, "tool effects") as ToolEffect[];
  const pathOperations = uniqueStrings(policy.pathOperations ?? [], "path operations") as PathOperation[];
  const knownPathOperations = new Set<PathOperation>([
    "read-file", "read-directory", "search-tree", "create-file", "replace-file",
    "create-directory", "watch-directory", "initial-cwd", "reveal",
  ]);
  if (risks.some((entry) => !riskClasses.has(entry))) throw new TypeError("tool policy has an unknown risk class");
  if (toolEffects.some((entry) => !effects.has(entry))) throw new TypeError("tool policy has an unknown effect");
  if (pathOperations.some((entry) => !knownPathOperations.has(entry))) throw new TypeError("tool policy has an unknown path operation");
  if (pathOperations.length > 0 && !toolEffects.includes("filesystem") && !toolEffects.includes("process")) {
    throw new TypeError("tool path operations require a filesystem or process effect");
  }
  const requiredRisk = new Map<PathOperation, RiskClass>([
    ["read-file", "read"], ["read-directory", "read"], ["search-tree", "read"],
    ["create-file", "write"], ["replace-file", "write"], ["create-directory", "write"],
    ["watch-directory", "read"], ["initial-cwd", "process"], ["reveal", "process"],
  ]);
  if (pathOperations.some(operation => !risks.includes(requiredRisk.get(operation)!))) {
    throw new TypeError("tool path operation is outside its risk envelope");
  }
  const executionRootAccess = policy.executionRootAccess;
  if (executionRootAccess !== undefined && executionRootAccess !== "read" && executionRootAccess !== "read-write") {
    throw new TypeError("tool execution root access is invalid");
  }
  if (executionRootAccess !== undefined && (!pathOperations.includes("initial-cwd") || !toolEffects.includes("process")
    || !risks.includes("read") || (executionRootAccess === "read-write" && !risks.includes("write")))) {
    throw new TypeError("tool execution root access is outside its path and risk envelope");
  }
  if (policy.approval !== "none" && policy.approval !== "user") throw new TypeError("tool approval policy is invalid");
  return deepFreeze({
    riskClasses: deepFreeze(risks),
    approval: policy.approval,
    effects: deepFreeze(toolEffects),
    pathOperations: deepFreeze(pathOperations),
    ...(executionRootAccess === undefined ? {} : { executionRootAccess }),
  });
}

interface BindingRecord {
  readonly name: string;
  readonly registrationId: string;
  readonly ownerAuthorityId: string;
  readonly ownerEpoch: number;
  readonly definition: ToolDefinition;
  readonly definitionDigest: string;
  readonly policy: ToolPolicy;
  readonly policyDigest: string;
  readonly executor: ToolExecutor;
}

interface PersonaSnapshot {
  readonly name: string;
  readonly tools: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly systemPrompt: string;
  readonly allowedRoots: readonly string[];
  readonly rootEnv: Readonly<Record<string, string | null>>;
  readonly networkPolicy: NetworkPolicy;
  readonly digest: string;
}

interface AuthorityRecord {
  readonly authority: RuntimeAuthority;
  readonly persona: PersonaSnapshot;
  readonly pathAuthority: PathAuthority;
  readonly runtimeBindings: Map<string, BindingRecord>;
  readonly contexts: Set<CapabilityContext>;
  readonly resourceOwners: Map<string, ResourceOwner>;
  /** A retiring run prevents a replacement owner until its drain has converged. */
  readonly pendingResourceSessions: Set<string>;
  /** A failed resource drain poisons the session until this authority is retired. */
  readonly blockedResourceSessions: Set<string>;
  epoch: number;
  active: boolean;
  activeRoot: CapabilityContext | null;
  retirement: Promise<void> | null;
}

interface GrantRecord {
  readonly grantId: string;
  readonly registrationId: string;
  readonly toolName: string;
  readonly argumentsDigest: string;
  readonly expiresAtMs: number;
  consumed: boolean;
}

interface ContextRecord {
  readonly context: CapabilityContext;
  readonly authority: AuthorityRecord;
  readonly pathAuthority: PathAuthority;
  readonly parent: ContextRecord | null;
  readonly children: Set<CapabilityContext>;
  readonly bindings: ReadonlyMap<string, BindingRecord>;
  readonly roots: ReadonlySet<string>;
  readonly risks: ReadonlySet<RiskClass>;
  readonly executorEnv: Readonly<Record<string, string>>;
  readonly directOperation: { operation: string; argumentsDigest: string; expiresAtMs: number; consumed: boolean } | null;
  grant: GrantRecord | null;
  active: boolean;
}

interface ChallengeRecord {
  readonly view: ApprovalChallenge;
  readonly parent: ContextRecord;
  readonly binding: BindingRecord;
  readonly argumentsDigest: string;
  readonly expiresAtMs: number;
  consumed: boolean;
}

export interface InspectedToolCall {
  readonly name: string;
  readonly registrationId: string;
  readonly policy: ToolPolicy;
  readonly args: Readonly<Record<string, unknown>>;
  readonly argumentsDigest: string;
}

interface InspectedPathGatewayRecord {
  started: boolean;
  active: boolean;
  readonly close: () => void;
}

interface InspectedToolCallRecord {
  readonly view: InspectedToolCall;
  readonly source: ContextRecord;
  readonly binding: BindingRecord;
  readonly args: Readonly<Record<string, unknown>>;
  readonly argumentsDigest: string;
  consumed: boolean;
  pathGateway: InspectedPathGatewayRecord | null;
}

export interface ChildCapabilityRequest {
  readonly principal: "subagent" | "playbook";
  readonly tools?: readonly string[];
  readonly allowedRoots?: readonly string[];
  readonly networkPolicy?: NetworkPolicy;
  readonly allowedRiskClasses?: readonly RiskClass[];
}

export interface CapabilityBrokerOptions {
  readonly resolveSessionPersona: (sessionId: string) => string | null;
  readonly pathPolicy: PathPolicy;
  readonly now?: () => number;
}

function networkIsSubset(child: NetworkPolicy, parent: NetworkPolicy): boolean {
  if (child.mode === "deny") return true;
  if (parent.mode === "unrestricted") return true;
  if (child.mode === "loopback") return parent.mode === "loopback";
  if (child.mode === "unrestricted") return false;
  if (parent.mode !== "allowlist") return false;
  return child.origins.every((origin) => parent.origins.includes(origin));
}

export class CapabilityBroker {
  private readonly resolveSessionPersona: (sessionId: string) => string | null;
  private readonly pathPolicy: PathPolicy;
  private readonly now: () => number;
  private readonly staticBindings = new Map<string, BindingRecord>();
  private readonly directPolicies = new Map<string, ToolPolicy>();
  private readonly authorityRecords = new WeakMap<RuntimeAuthority, AuthorityRecord>();
  private readonly contextRecords = new WeakMap<CapabilityContext, ContextRecord>();
  private readonly inspectedCalls = new WeakMap<InspectedToolCall, InspectedToolCallRecord>();
  private readonly localPrincipals = new WeakSet<LocalApiPrincipal>();
  private readonly boundPathAuthorities = new WeakSet<PathAuthority>();
  private readonly challenges = new Map<string, ChallengeRecord>();

  constructor(options: CapabilityBrokerOptions) {
    if (!options?.pathPolicy) throw new TypeError("CapabilityBroker requires PathPolicy");
    this.resolveSessionPersona = options.resolveSessionPersona;
    this.pathPolicy = options.pathPolicy;
    this.now = options.now ?? Date.now;
  }

  registerStaticTool(registration: CapabilityToolRegistration): void {
    if (this.staticBindings.has(registration.name)) denied("CAPABILITY_REGISTRATION_INVALID", `duplicate static tool: ${registration.name}`);
    this.staticBindings.set(registration.name, this.makeBinding("static", 0, registration));
  }

  registerDirectOperation(operation: string, policy: ToolPolicy): void {
    if (!operation || this.directPolicies.has(operation)) denied("CAPABILITY_REGISTRATION_INVALID", `duplicate direct operation: ${operation}`);
    this.directPolicies.set(operation, copyPolicy(policy));
  }

  createRuntimeAuthority(input: EffectivePersonaInput): RuntimeAuthority {
    if (!input.name || typeof input.name !== "string" || typeof input.systemPrompt !== "string") throw new TypeError("effective persona identity is invalid");
    const tools = deepFreeze(uniqueStrings(input.tools, "persona tools"));
    const configuredRoots = deepFreeze(uniqueStrings(input.allowedRoots, "configured roots"));
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.env)) {
      if (!key || typeof value !== "string" || reservedEnv.has(key)) throw new TypeError(`persona env key is invalid: ${key}`);
      env[key] = value;
    }
    let pathDescription;
    try {
      pathDescription = this.pathPolicy.describeAuthority(input.pathAuthority);
    } catch (error) {
      if (error instanceof PathDeniedError) denied("CAPABILITY_REGISTRATION_INVALID", "prepared PathAuthority is unavailable");
      throw error;
    }
    if (this.boundPathAuthorities.has(input.pathAuthority)) denied("CAPABILITY_REGISTRATION_INVALID", "prepared PathAuthority is already bound");
    const rootIds = deepFreeze(uniqueStrings(pathDescription.rootIds, "PathAuthority root IDs"));
    const rootIdSet = new Set(rootIds);
    const rootEnv: Record<string, string | null> = {};
    if (!input.rootEnv || typeof input.rootEnv !== "object" || Array.isArray(input.rootEnv)) throw new TypeError("root env mapping is invalid");
    for (const [envKey, rootId] of Object.entries(input.rootEnv)) {
      if (!Object.hasOwn(env, envKey) || (rootId !== null && (typeof rootId !== "string" || !rootIdSet.has(rootId)))) {
        denied("CAPABILITY_REGISTRATION_INVALID", "root env mapping differs from prepared PathAuthority");
      }
      rootEnv[envKey] = rootId;
    }
    const networkPolicy = copyNetworkPolicy(input.networkPolicy);
    const personaDigestInput = { name: input.name, tools, env, systemPrompt: input.systemPrompt, allowedRoots: configuredRoots, networkPolicy };
    const personaDigest = canonicalDigest(personaDigestInput);
    if (input.digest !== undefined && input.digest !== personaDigest) denied("CAPABILITY_REGISTRATION_INVALID", "effective persona digest differs");
    const digest = canonicalDigest({ personaDigest, pathAuthorityDigest: pathDescription.digest, rootIds, rootEnv });
    const persona: PersonaSnapshot = deepFreeze({
      name: input.name,
      tools,
      env,
      systemPrompt: input.systemPrompt,
      allowedRoots: rootIds,
      rootEnv,
      networkPolicy,
      digest,
    });
    const authority = deepFreeze({ authorityId: randomUUID() });
    this.boundPathAuthorities.add(input.pathAuthority);
    this.authorityRecords.set(authority, {
      authority,
      persona,
      pathAuthority: input.pathAuthority,
      runtimeBindings: new Map(),
      contexts: new Set(),
      resourceOwners: new Map(),
      pendingResourceSessions: new Set(),
      blockedResourceSessions: new Set(),
      epoch: 1,
      active: true,
      activeRoot: null,
      retirement: null,
    });
    return authority;
  }

  registerRuntimeTool(authority: RuntimeAuthority, registration: CapabilityToolRegistration): void {
    const record = this.requireAuthority(authority);
    if (this.staticBindings.has(registration.name)) denied("CAPABILITY_REGISTRATION_INVALID", `runtime tool collides with static tool: ${registration.name}`);
    if (record.runtimeBindings.has(registration.name)) denied("CAPABILITY_REGISTRATION_INVALID", `duplicate runtime tool: ${registration.name}`);
    record.runtimeBindings.set(registration.name, this.makeBinding(authority.authorityId, record.epoch, registration));
  }

  beginAgentRun(authority: RuntimeAuthority, sessionId: string): CapabilityContext {
    const record = this.requireAuthority(authority);
    if (record.activeRoot) denied("CAPABILITY_RUN_BUSY", "runtime already has an active root run");
    this.assertSession(record, sessionId);
    const bindings = new Map<string, BindingRecord>();
    for (const name of record.persona.tools) {
      const binding = record.runtimeBindings.get(name) ?? this.staticBindings.get(name);
      if (!binding) denied("CAPABILITY_TOOL_DENIED", `persona references unavailable tool: ${name}`);
      bindings.set(name, binding);
    }
    const risks = new Set<RiskClass>();
    for (const binding of bindings.values()) for (const risk of binding.policy.riskClasses) risks.add(risk);
    const context = this.createContext({
      authority: record,
      parent: null,
      principal: "agent",
      sessionId,
      runId: randomUUID(),
      bindings,
      roots: new Set(record.persona.allowedRoots),
      risks,
      networkPolicy: record.persona.networkPolicy,
      grant: null,
      directOperation: null,
    });
    record.activeRoot = context;
    return context;
  }

  getToolDefinitions(context: CapabilityContext): ToolDefinition[] {
    const record = this.requireActiveContext(context);
    if (record.context.principal === "local-user-api") denied("CAPABILITY_TOOL_DENIED", "direct API context has no model tools");
    return [...record.bindings.values()].map((binding) => binding.definition);
  }

  getResourceOwner(context: CapabilityContext): ResourceOwner {
    const contextRecord = this.requireActiveContext(context);
    const authority = contextRecord.authority;
    if (authority.blockedResourceSessions.has(context.sessionId)) {
      denied("CAPABILITY_CONTEXT_STALE", "session resource cleanup previously failed");
    }
    if (authority.pendingResourceSessions.has(context.sessionId)) {
      denied("CAPABILITY_RUN_BUSY", "previous run resources are still retiring");
    }
    const rootIds = [...contextRecord.roots].sort();
    const executionDomain = context.principal === "local-user-api"
      ? context.executionDomainId
      : `${context.executionDomainId}\u0000${context.runId}`;
    const key = `${context.sessionId}\u0000${executionDomain}\u0000${context.principal}\u0000${rootIds.join("\u0000")}`;
    const existing = authority.resourceOwners.get(key);
    if (existing) {
      assertResourceOwner(existing);
      return existing;
    }
    const owner = issueResourceOwner({
      authorityId: authority.authority.authorityId,
      authorityEpoch: authority.epoch,
      sessionId: context.sessionId,
      principal: context.principal,
      rootIds,
    });
    authority.resourceOwners.set(key, owner);
    return owner;
  }

  issueToolPathGateway(context: CapabilityContext, inspected: InspectedToolCall): {
    readonly gateway: ScopedPathGateway;
    readonly close: () => void;
  } {
    const initial = this.requireActiveContext(context);
    const inspectedRecord = this.requireInspectedCall(inspected);
    const sourceMatches = inspectedRecord.source === initial
      || (initial.grant !== null && initial.parent === inspectedRecord.source);
    if (!sourceMatches || inspectedRecord.binding.registrationId !== inspected.registrationId) {
      denied("CAPABILITY_BINDING_MISMATCH", "path gateway prepared call binding differs");
    }
    const binding = this.requireToolBinding(initial, inspected.name);
    if (binding !== inspectedRecord.binding) denied("CAPABILITY_BINDING_MISMATCH", "path gateway tool binding differs");
    if (inspectedRecord.consumed || inspectedRecord.pathGateway) {
      denied("CAPABILITY_GRANT_REPLAYED", "prepared call already has an invocation gateway");
    }

    const allowedOperations = new Set<PathOperation>(binding.policy.pathOperations ?? []);
    const invocationAuthority = this.pathPolicy.deriveAuthority(initial.pathAuthority, [...initial.roots]);
    const auditIdentity = Object.freeze({
      sessionId: context.sessionId,
      runId: context.runId,
      principal: context.principal,
    });
    let active = true;
    const close = () => {
      if (!active) return;
      active = false;
      if (gatewayRecord) gatewayRecord.active = false;
      if (this.pathPolicy.isActive(invocationAuthority)) this.pathPolicy.revoke(invocationAuthority);
    };
    const gatewayRecord: InspectedPathGatewayRecord = { started: false, active: true, close };
    inspectedRecord.pathGateway = gatewayRecord;
    const requireInvocation = (operation?: PathOperation): ContextRecord => {
      if (!active || !gatewayRecord.active) denied("CAPABILITY_CONTEXT_STALE", "path gateway invocation is closed");
      const current = this.requireActiveContext(context);
      if (current !== initial || inspectedRecord.pathGateway !== gatewayRecord) denied("CAPABILITY_CONTEXT_FORGED", "path gateway context binding differs");
      if (!gatewayRecord.started) denied("CAPABILITY_BINDING_MISMATCH", "path gateway invocation has not started");
      if (operation && !allowedOperations.has(operation)) denied("CAPABILITY_RISK_DENIED", "tool binding does not permit this path operation");
      return current;
    };
    const request = (input: string, operation: PathOperation, defaultRootId?: string, requiredExtension?: string) => Object.freeze({
      input,
      operation,
      defaultRootId,
      requiredExtension,
      auditIdentity,
    });
    const gateway: ScopedPathGateway = {
      rootIdForEnv: (envKey) => {
        const record = requireInvocation();
        const rootId = record.authority.persona.rootEnv[envKey];
        return typeof rootId === "string" && record.roots.has(rootId) ? rootId : null;
      },
      withInitialCwd: (input, options, use) => {
        requireInvocation("initial-cwd");
        return this.pathPolicy.withInitialCwd(invocationAuthority, request(input, "initial-cwd", options.defaultRootId), use);
      },
      withExecutionRoot: (input, options, use) => {
        requireInvocation("initial-cwd");
        const access = binding.policy.executionRootAccess;
        if (!access) denied("CAPABILITY_RISK_DENIED", "tool binding has no execution-root authority");
        return this.pathPolicy.withExecutionRoot(
          invocationAuthority,
          request(input, "initial-cwd", options.defaultRootId),
          access,
          use
        );
      },
      watchDirectory: async (input, options, publish) => {
        const current = requireInvocation("watch-directory");
        const owner = this.getResourceOwner(context);
        const watchAuthority = this.pathPolicy.deriveAuthority(current.authority.pathAuthority, [...current.roots]);
        let lease: Awaited<ReturnType<PathPolicy["watchDirectory"]>> | null = null;
        let unregisterOwned: () => void = () => undefined;
        let closeRequested = false;
        let closePromise: Promise<void> | null = null;
        let settleInitialization: () => void = () => undefined;
        const initialized = new Promise<void>(resolve => { settleInitialization = resolve; });
        let resolveClosed: () => void = () => undefined;
        const closed = new Promise<void>(resolve => { resolveClosed = resolve; });
        const close = (): Promise<void> => {
          if (closePromise) return closePromise;
          closeRequested = true;
          if (this.pathPolicy.isActive(watchAuthority)) this.pathPolicy.revoke(watchAuthority);
          closePromise = (async () => {
            await initialized;
            try {
              if (lease) await lease.close();
            } finally {
              unregisterOwned();
              if (this.pathPolicy.isActive(watchAuthority)) this.pathPolicy.revoke(watchAuthority);
            }
          })().finally(resolveClosed);
          return closePromise;
        };
        try {
          unregisterOwned = registerOwnedResource(owner, close);
        } catch (error) {
          settleInitialization();
          await close().catch(() => undefined);
          throw error;
        }
        let creationError: unknown = null;
        try {
          lease = await this.pathPolicy.watchDirectory(
            watchAuthority,
            request(input, "watch-directory", options.defaultRootId),
            publish
          );
        } catch (error) {
          creationError = error;
        } finally {
          settleInitialization();
        }
        if (creationError) {
          await close().catch(() => undefined);
          throw creationError;
        }
        if (!lease) {
          await close().catch(() => undefined);
          denied("CAPABILITY_CONTEXT_STALE", "watcher initialization did not publish a lease");
        }
        void lease.closed.then(() => close()).catch(() => undefined);
        if (closeRequested || !lease.isOpen()) {
          await close();
          denied("CAPABILITY_CONTEXT_STALE", "watcher authority retired or closed during creation");
        }
        return Object.freeze({
          rootId: lease.rootId,
          close,
          closed,
          isOpen: () => !closeRequested && lease?.isOpen() === true,
        });
      },
      readFile: (input, options) => {
        requireInvocation("read-file");
        return this.pathPolicy.readFile(invocationAuthority, request(input, "read-file", options.defaultRootId), options.maxBytes);
      },
      listDirectory: (input, options = {}) => {
        requireInvocation("read-directory");
        return this.pathPolicy.listDirectory(invocationAuthority, request(input, "read-directory", options.defaultRootId), options.maxEntries);
      },
      searchFile: (input, options) => {
        requireInvocation("search-tree");
        return this.pathPolicy.searchFile(invocationAuthority, request(input, "search-tree", options.defaultRootId), options.maxBytes);
      },
      searchDirectory: (input, options = {}) => {
        requireInvocation("search-tree");
        return this.pathPolicy.searchDirectory(invocationAuthority, request(input, "search-tree", options.defaultRootId), options.maxEntries);
      },
      createFile: (input, bytes, options = {}) => {
        requireInvocation("create-file");
        return this.pathPolicy.createFile(invocationAuthority, request(input, "create-file", options.defaultRootId), bytes, options.maxBytes);
      },
      writeFile: (input, bytes, options = {}) => {
        requireInvocation("create-file");
        requireInvocation("replace-file");
        return this.pathPolicy.createOrReplaceFile(invocationAuthority, request(input, "create-file", options.defaultRootId), bytes, options.maxBytes);
      },
      reserveFile: async (input, options = {}) => {
        requireInvocation("create-file");
        requireInvocation("replace-file");
        const maxBytes = options.maxBytes ?? 64 * 1024 * 1024;
        if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new TypeError("maxBytes must be a positive safe integer");
        const reservedRequest = request(input, "create-file", options.defaultRootId, options.requiredExtension);
        const preflight = await this.pathPolicy.preflightWrite(invocationAuthority, reservedRequest);
        let consumed = false;
        return Object.freeze({
          commit: (bytes: Uint8Array) => {
            requireInvocation("create-file");
            requireInvocation("replace-file");
            if (consumed) denied("CAPABILITY_GRANT_REPLAYED", "output reservation was already consumed");
            consumed = true;
            return this.pathPolicy.commitPreflightWrite(invocationAuthority, preflight, bytes, maxBytes);
          },
        });
      },
      replaceFile: (input, transform, options = {}) => {
        requireInvocation("replace-file");
        return this.pathPolicy.replaceFile(invocationAuthority, request(input, "replace-file", options.defaultRootId), transform, options.maxBytes);
      },
    };
    return Object.freeze({ gateway: Object.freeze(gateway), close });
  }

  deriveChild(parent: CapabilityContext, request: ChildCapabilityRequest): CapabilityContext {
    const parentRecord = this.requireActiveContext(parent);
    if (parent.principal === "local-user-api") denied("CAPABILITY_ATTENUATION_INVALID", "direct API context cannot derive agent children");
    const explicitTools = request.tools === undefined ? null : uniqueStrings(request.tools, "child tools");
    const requestedTools = explicitTools ?? [...parentRecord.bindings.keys()];
    const forbiddenRecursion = request.principal === "subagent" ? "subagent" : "playbook_execute";
    const bindings = new Map<string, BindingRecord>();
    for (const name of requestedTools) {
      if (name === forbiddenRecursion) continue;
      const binding = parentRecord.bindings.get(name);
      if (!binding) denied("CAPABILITY_ATTENUATION_INVALID", `child requested forbidden binding: ${name}`);
      if (binding.policy.approval === "user") {
        if (explicitTools) denied("CAPABILITY_ATTENUATION_INVALID", `child cannot inherit approval-bound tool: ${name}`);
        continue;
      }
      bindings.set(name, binding);
    }

    const requestedRoots = request.allowedRoots === undefined ? [...parentRecord.roots] : uniqueStrings(request.allowedRoots, "child roots");
    if (requestedRoots.some((root) => !parentRecord.roots.has(root))) denied("CAPABILITY_ATTENUATION_INVALID", "child roots broaden parent authority");
    const bindingRisks = new Set<RiskClass>();
    for (const binding of bindings.values()) for (const risk of binding.policy.riskClasses) bindingRisks.add(risk);
    const requestedRisks = request.allowedRiskClasses === undefined ? [...bindingRisks] : uniqueStrings(request.allowedRiskClasses, "child risks") as RiskClass[];
    if (requestedRisks.some((risk) => !riskClasses.has(risk) || !parentRecord.risks.has(risk))) denied("CAPABILITY_ATTENUATION_INVALID", "child risks broaden parent authority");
    const requestedRiskSet = new Set(requestedRisks);
    if ([...bindings.values()].some((binding) => binding.policy.riskClasses.some((risk) => !requestedRiskSet.has(risk)))) {
      denied("CAPABILITY_ATTENUATION_INVALID", "child risk envelope does not cover requested bindings");
    }
    const networkPolicy = copyNetworkPolicy(request.networkPolicy ?? parent.networkPolicy);
    if (!networkIsSubset(networkPolicy, parent.networkPolicy)) denied("CAPABILITY_ATTENUATION_INVALID", "child network policy broadens parent authority");

    return this.createContext({
      authority: parentRecord.authority,
      parent: parentRecord,
      principal: request.principal,
      sessionId: parent.sessionId,
      runId: parent.runId,
      bindings,
      roots: new Set(requestedRoots),
      risks: new Set(requestedRisks),
      networkPolicy,
      grant: null,
      directOperation: null,
    });
  }

  inspectToolCall(context: CapabilityContext, toolName: string, args: Record<string, unknown>): InspectedToolCall {
    const contextRecord = this.requireActiveContext(context);
    if (context.principal === "local-user-api") denied("CAPABILITY_TOOL_DENIED", "direct API context cannot execute model tools");
    const binding = this.requireToolBinding(contextRecord, toolName);
    this.assertToolEnvelope(contextRecord, binding);
    const snapshot = this.prepareArguments(args);
    const argumentsDigest = canonicalDigest(snapshot);
    const view: InspectedToolCall = deepFreeze({
      name: binding.name,
      registrationId: binding.registrationId,
      policy: binding.policy,
      args: snapshot,
      argumentsDigest,
    });
    this.inspectedCalls.set(view, {
      view,
      source: contextRecord,
      binding,
      args: snapshot,
      argumentsDigest,
      consumed: false,
      pathGateway: null,
    });
    return view;
  }

  deriveInvocationChild(executionContext: CapabilityContext, request: ChildCapabilityRequest): CapabilityContext {
    const executionRecord = this.requireActiveContext(executionContext);
    const source = executionRecord.grant && executionRecord.parent
      ? executionRecord.parent.context
      : executionContext;
    return this.deriveChild(source, request);
  }

  createApprovalChallenge(parent: CapabilityContext, inspected: InspectedToolCall, ttlMs = 60_000): ApprovalChallenge {
    const parentRecord = this.requireActiveContext(parent);
    const inspectedRecord = this.requireInspectedCall(inspected);
    if (inspectedRecord.source !== parentRecord) denied("CAPABILITY_APPROVAL_CHALLENGE_INVALID", "prepared call belongs to another context");
    const binding = this.requireToolBinding(parentRecord, inspected.name);
    if (binding !== inspectedRecord.binding) denied("CAPABILITY_BINDING_MISMATCH", "prepared call binding differs");
    this.assertToolEnvelope(parentRecord, binding);
    if (binding.policy.approval !== "user") denied("CAPABILITY_APPROVAL_CHALLENGE_INVALID", "tool does not require user approval");
    if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 60_000) throw new TypeError("approval challenge lifetime is invalid");
    const expiresAtMs = this.now() + ttlMs;
    const view = deepFreeze({
      challengeId: randomBytes(32).toString("hex"),
      runtimeAuthorityId: parentRecord.authority.authority.authorityId,
      authorityEpoch: parent.authorityEpoch,
      sessionId: parent.sessionId,
      runId: parent.runId,
      contextId: parent.contextId,
      registrationId: binding.registrationId,
      toolName: binding.name,
      responsePrincipal: "local-user-api" as const,
      responseChannel: binding.policy.effects.includes("process") ? "native-process" as const : "ask-user" as const,
      argumentsDigest: inspectedRecord.argumentsDigest,
      expiresAt: new Date(expiresAtMs).toISOString(),
    });
    this.challenges.set(view.challengeId, {
      view,
      parent: parentRecord,
      binding,
      argumentsDigest: inspectedRecord.argumentsDigest,
      expiresAtMs,
      consumed: false,
    });
    return view;
  }

  resolveApprovalChallenge(input: {
    challengeId: string;
    choice: "approve" | "deny";
    sessionId: string;
    runId: string;
    responsePrincipal: "local-user-api";
    responseChannel: "ask-user" | "native-process";
  }): CapabilityContext | null {
    const challenge = this.challenges.get(input.challengeId);
    if (!challenge || challenge.consumed || this.now() > challenge.expiresAtMs) denied("CAPABILITY_APPROVAL_CHALLENGE_INVALID", "approval challenge is unavailable");
    this.requireActiveContext(challenge.parent.context);
    if (input.sessionId !== challenge.view.sessionId || input.runId !== challenge.view.runId) denied("CAPABILITY_APPROVAL_CHALLENGE_INVALID", "approval challenge belongs to another run");
    if (input.responsePrincipal !== challenge.view.responsePrincipal || input.responseChannel !== challenge.view.responseChannel) {
      denied("CAPABILITY_APPROVAL_CHALLENGE_INVALID", "approval response principal or channel differs");
    }
    if (input.choice !== "approve" && input.choice !== "deny") denied("CAPABILITY_APPROVAL_CHALLENGE_INVALID", "approval response must be structured");
    challenge.consumed = true;
    if (input.choice === "deny") return null;

    const grant: GrantRecord = {
      grantId: randomBytes(32).toString("hex"),
      registrationId: challenge.binding.registrationId,
      toolName: challenge.binding.name,
      argumentsDigest: challenge.argumentsDigest,
      expiresAtMs: challenge.expiresAtMs,
      consumed: false,
    };
    return this.createContext({
      authority: challenge.parent.authority,
      parent: challenge.parent,
      principal: challenge.parent.context.principal,
      sessionId: challenge.parent.context.sessionId,
      runId: challenge.parent.context.runId,
      bindings: new Map([[challenge.binding.name, challenge.binding]]),
      roots: new Set(challenge.parent.roots),
      risks: new Set(challenge.binding.policy.riskClasses),
      networkPolicy: challenge.parent.context.networkPolicy,
      grant,
      directOperation: null,
    });
  }

  invokeTool(
    context: CapabilityContext,
    inspected: InspectedToolCall,
    invocation?: ToolInvocationServices
  ): Promise<string> {
    const contextRecord = this.requireActiveContext(context);
    if (context.principal === "local-user-api") denied("CAPABILITY_TOOL_DENIED", "direct API context cannot execute model tools");
    const inspectedRecord = this.requireInspectedCall(inspected);
    const sourceMatches = inspectedRecord.source === contextRecord
      || (contextRecord.grant !== null && contextRecord.parent === inspectedRecord.source);
    if (!sourceMatches) denied("CAPABILITY_BINDING_MISMATCH", "prepared call belongs to another execution context");
    const binding = this.requireToolBinding(contextRecord, inspected.name);
    if (binding !== inspectedRecord.binding || binding.registrationId !== inspected.registrationId) {
      denied("CAPABILITY_BINDING_MISMATCH", "prepared call binding differs");
    }
    this.assertToolEnvelope(contextRecord, binding);
    if (inspectedRecord.consumed) denied("CAPABILITY_GRANT_REPLAYED", "prepared call was already consumed");

    if (binding.policy.approval === "user") {
      const grant = contextRecord.grant;
      if (!grant) denied("CAPABILITY_GRANT_REQUIRED", "tool requires an exact user grant");
      if (grant.registrationId !== binding.registrationId
        || grant.toolName !== binding.name
        || grant.argumentsDigest !== inspectedRecord.argumentsDigest) {
        denied("CAPABILITY_GRANT_INVALID", "grant does not match this exact call");
      }
      if (this.now() > grant.expiresAtMs) denied("CAPABILITY_GRANT_INVALID", "grant expired");
      if (grant.consumed) denied("CAPABILITY_GRANT_REPLAYED", "grant was already consumed");
      grant.consumed = true;
    }

    inspectedRecord.consumed = true;
    const pathGateway = inspectedRecord.pathGateway;
    if (pathGateway) pathGateway.started = true;
    return Promise.resolve()
      .then(() => binding.executor(inspectedRecord.args, contextRecord.executorEnv, invocation))
      .finally(() => pathGateway?.close());
  }

  createLocalApiPrincipal(): LocalApiPrincipal {
    const principal = deepFreeze({ principalId: randomUUID() });
    this.localPrincipals.add(principal);
    return principal;
  }

  issueLocalApiContext(input: {
    authority: RuntimeAuthority;
    principal: LocalApiPrincipal;
    sessionId: string;
    operation: string;
    args: Record<string, unknown>;
    ttlMs?: number;
  }): CapabilityContext {
    if (!this.localPrincipals.has(input.principal)) denied("CAPABILITY_CONTEXT_FORGED", "local API principal is forged");
    const authority = this.requireAuthority(input.authority);
    this.assertSession(authority, input.sessionId);
    const policy = this.directPolicies.get(input.operation);
    if (!policy) denied("CAPABILITY_DIRECT_OPERATION_DENIED", `unknown direct operation: ${input.operation}`);
    if (policy.approval === "user") denied("CAPABILITY_DIRECT_OPERATION_DENIED", "direct operation requires a separate explicit user grant");
    if (policy.riskClasses.includes("network") && authority.persona.networkPolicy.mode === "deny") {
      denied("CAPABILITY_RISK_DENIED", "network is denied by the direct-operation capability envelope");
    }
    const ttlMs = input.ttlMs ?? 30_000;
    if (!Number.isInteger(ttlMs) || ttlMs <= 0 || ttlMs > 60_000) throw new TypeError("direct operation lifetime is invalid");
    const snapshot = this.prepareArguments(input.args);
    const risks = new Set(policy.riskClasses);
    return this.createContext({
      authority,
      parent: null,
      principal: "local-user-api",
      sessionId: input.sessionId,
      runId: randomUUID(),
      bindings: new Map(),
      roots: new Set(authority.persona.allowedRoots),
      risks,
      networkPolicy: authority.persona.networkPolicy,
      grant: null,
      directOperation: {
        operation: input.operation,
        argumentsDigest: canonicalDigest(snapshot),
        expiresAtMs: this.now() + ttlMs,
        consumed: false,
      },
    });
  }

  authorizeDirectOperation(context: CapabilityContext, operation: string, args: Record<string, unknown>): Readonly<Record<string, unknown>> {
    const record = this.requireActiveContext(context);
    if (context.principal !== "local-user-api") denied("CAPABILITY_DIRECT_OPERATION_DENIED", "agent context cannot invoke direct operations");
    const direct = record.directOperation;
    if (!direct || direct.operation !== operation) denied("CAPABILITY_DIRECT_OPERATION_DENIED", "direct operation differs from issued capability");
    const snapshot = this.prepareArguments(args);
    if (canonicalDigest(snapshot) !== direct.argumentsDigest) denied("CAPABILITY_DIRECT_OPERATION_DENIED", "direct operation arguments differ");
    if (this.now() > direct.expiresAtMs) denied("CAPABILITY_DIRECT_OPERATION_DENIED", "direct operation capability expired");
    if (direct.consumed) denied("CAPABILITY_GRANT_REPLAYED", "direct operation capability was already consumed");
    direct.consumed = true;
    return snapshot;
  }

  async withDirectExecutionRoot<T>(
    context: CapabilityContext,
    operation: string,
    input: string,
    defaultRootEnv: string,
    use: (
      canonicalCwd: string,
      lease: import("./path-policy.js").ExecutionRootLease,
      qualificationDigest: string
    ) => T | Promise<T>
  ): Promise<T> {
    const record = this.requireActiveContext(context);
    if (context.principal !== "local-user-api") denied("CAPABILITY_DIRECT_OPERATION_DENIED", "agent context cannot invoke direct operations");
    const direct = record.directOperation;
    const policy = this.directPolicies.get(operation);
    if (!direct || direct.operation !== operation || !direct.consumed || !policy?.effects.includes("process")
      || !policy.executionRootAccess) {
      denied("CAPABILITY_DIRECT_OPERATION_DENIED", "direct execution-root capability is unavailable");
    }
    const rootId = record.authority.persona.rootEnv[defaultRootEnv];
    if (typeof rootId !== "string" || !record.roots.has(rootId)) denied("CAPABILITY_RISK_DENIED", "direct execution root is unavailable");
    const pathAuthority = this.pathPolicy.deriveAuthority(record.pathAuthority, [...record.roots]);
    try {
      return await this.pathPolicy.withExecutionRoot(pathAuthority, {
        input,
        operation: "initial-cwd",
        defaultRootId: rootId,
        auditIdentity: {
          sessionId: context.sessionId,
          runId: context.runId,
          principal: context.principal,
        },
      }, policy.executionRootAccess, use);
    } finally {
      if (this.pathPolicy.isActive(pathAuthority)) this.pathPolicy.revoke(pathAuthority);
    }
  }

  finishContext(context: CapabilityContext): void {
    const record = this.contextRecords.get(context);
    if (!record) denied(context ? "CAPABILITY_CONTEXT_FORGED" : "CAPABILITY_CONTEXT_REQUIRED", "cannot finish unknown context");
    this.revokeContext(record);
  }

  revokeAuthority(authority: RuntimeAuthority): void {
    const record = authority && this.authorityRecords.get(authority);
    if (!record || record.authority !== authority || !record.active) denied("CAPABILITY_CONTEXT_FORGED", "runtime authority is unavailable");
    const retirement = this.beginAuthorityRetirement(authority);
    void retirement.catch(() => undefined);
  }

  async retireAuthority(authority: RuntimeAuthority, timeoutMs = 5_000): Promise<void> {
    await this.beginAuthorityRetirement(authority, timeoutMs);
  }

  async retireSessionResources(authority: RuntimeAuthority, sessionId: string, timeoutMs = 5_000): Promise<void> {
    const record = authority && this.authorityRecords.get(authority);
    if (!record || record.authority !== authority) denied("CAPABILITY_CONTEXT_FORGED", "runtime authority is unavailable");
    if (!sessionId) throw new TypeError("sessionId is invalid");
    const owners: { key: string; owner: ResourceOwner }[] = [];
    for (const [key, owner] of record.resourceOwners) {
      if (!key.startsWith(`${sessionId}\u0000`)) continue;
      owners.push({ key, owner });
    }
    if (owners.length > 0) record.pendingResourceSessions.add(sessionId);
    try {
      await Promise.all(owners.map(({ owner }) => retireResourceOwner(owner, timeoutMs)));
      record.pendingResourceSessions.delete(sessionId);
    } catch (error) {
      record.pendingResourceSessions.delete(sessionId);
      record.blockedResourceSessions.add(sessionId);
      throw error;
    }
    for (const { key, owner } of owners) {
      if (record.resourceOwners.get(key) === owner) record.resourceOwners.delete(key);
    }
  }

  isContextActive(context: CapabilityContext): boolean {
    const record = this.contextRecords.get(context);
    return Boolean(record?.active && record.authority.active && context.authorityEpoch === record.authority.epoch
      && this.pathPolicy.isActive(record.pathAuthority));
  }

  private makeBinding(ownerAuthorityId: string, ownerEpoch: number, registration: CapabilityToolRegistration): BindingRecord {
    if (!registration.name || registration.definition?.function?.name !== registration.name || typeof registration.executor !== "function") {
      denied("CAPABILITY_REGISTRATION_INVALID", "tool registration identity is invalid");
    }
    const definition = frozenCopy(registration.definition, `tool definition ${registration.name}`);
    const policy = copyPolicy(registration.policy);
    if (policy.riskClasses.length === 0) denied("CAPABILITY_REGISTRATION_INVALID", `tool policy has no risk classes: ${registration.name}`);
    return Object.freeze({
      name: registration.name,
      registrationId: randomUUID(),
      ownerAuthorityId,
      ownerEpoch,
      definition,
      definitionDigest: canonicalDigest(definition),
      policy,
      policyDigest: canonicalDigest(policy),
      executor: registration.executor,
    });
  }

  private beginAuthorityRetirement(authority: RuntimeAuthority, timeoutMs = 5_000): Promise<void> {
    const record = authority && this.authorityRecords.get(authority);
    if (!record || record.authority !== authority) denied("CAPABILITY_CONTEXT_FORGED", "runtime authority is unavailable");
    if (record.retirement) return record.retirement;
    record.active = false;
    record.epoch += 1;
    this.pathPolicy.revoke(record.pathAuthority);
    for (const context of [...record.contexts]) {
      const contextRecord = this.contextRecords.get(context);
      if (contextRecord) this.revokeContext(contextRecord);
    }
    record.runtimeBindings.clear();
    record.activeRoot = null;
    const owners = [...record.resourceOwners.entries()];
    record.retirement = Promise.all(owners.map(([, owner]) => retireResourceOwner(owner, timeoutMs))).then(() => {
      for (const [key, owner] of owners) {
        if (record.resourceOwners.get(key) === owner) record.resourceOwners.delete(key);
      }
    });
    return record.retirement;
  }

  private requireAuthority(authority: RuntimeAuthority): AuthorityRecord {
    const record = authority && this.authorityRecords.get(authority);
    if (!record || !record.active || record.authority !== authority || !this.pathPolicy.isActive(record.pathAuthority)) {
      denied("CAPABILITY_CONTEXT_FORGED", "runtime authority is unavailable");
    }
    return record;
  }

  private assertSession(authority: AuthorityRecord, sessionId: string): void {
    if (!sessionId || this.resolveSessionPersona(sessionId) !== authority.persona.name) {
      denied("CAPABILITY_SESSION_MISMATCH", "session and effective persona do not match");
    }
  }

  private prepareArguments(args: Record<string, unknown>): Readonly<Record<string, unknown>> {
    if (!args || typeof args !== "object" || Array.isArray(args)) throw new TypeError("tool arguments must be a plain object");
    const prototype = Object.getPrototypeOf(args);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("tool arguments must be a plain object");
    return frozenCopy(args, "tool arguments");
  }

  private requireInspectedCall(inspected: InspectedToolCall): InspectedToolCallRecord {
    const record = inspected && this.inspectedCalls.get(inspected);
    if (!record || record.view !== inspected) denied("CAPABILITY_BINDING_MISMATCH", "prepared tool call is unavailable");
    return record;
  }

  private requireActiveContext(context: CapabilityContext): ContextRecord {
    if (!context) denied("CAPABILITY_CONTEXT_REQUIRED", "capability context is required");
    const record = this.contextRecords.get(context);
    if (!record || record.context !== context) denied("CAPABILITY_CONTEXT_FORGED", "capability context is forged");
    if (!record.active || !record.authority.active || context.authorityEpoch !== record.authority.epoch
      || !this.pathPolicy.isActive(record.pathAuthority)) {
      denied("CAPABILITY_CONTEXT_STALE", "capability context is stale");
    }
    if (context.persona.name !== record.authority.persona.name || context.persona.digest !== record.authority.persona.digest) {
      denied("CAPABILITY_CONTEXT_FORGED", "capability persona snapshot differs");
    }
    if (this.resolveSessionPersona(context.sessionId) !== record.authority.persona.name) {
      this.revokeContext(record);
      denied("CAPABILITY_SESSION_MISMATCH", "session and effective persona do not match");
    }
    if (record.parent && !record.parent.active) denied("CAPABILITY_CONTEXT_STALE", "parent capability context is stale");
    return record;
  }

  private requireToolBinding(context: ContextRecord, toolName: string): BindingRecord {
    const binding = context.bindings.get(toolName);
    if (!binding) denied("CAPABILITY_TOOL_DENIED", `tool is outside capability: ${toolName}`);
    if (binding.ownerAuthorityId !== "static"
      && (binding.ownerAuthorityId !== context.authority.authority.authorityId || binding.ownerEpoch !== context.authority.epoch)) {
      denied("CAPABILITY_DYNAMIC_OWNER_MISMATCH", "runtime tool belongs to another authority");
    }
    return binding;
  }

  private assertToolEnvelope(context: ContextRecord, binding: BindingRecord): void {
    if (binding.policy.riskClasses.some((risk) => !context.risks.has(risk))) {
      denied("CAPABILITY_RISK_DENIED", "tool risk exceeds capability envelope");
    }
    if (binding.policy.riskClasses.includes("network") && context.context.networkPolicy.mode === "deny") {
      denied("CAPABILITY_RISK_DENIED", "network is denied by capability envelope");
    }
  }

  private createContext(input: {
    authority: AuthorityRecord;
    parent: ContextRecord | null;
    principal: PrincipalKind;
    sessionId: string;
    runId: string;
    bindings: Map<string, BindingRecord>;
    roots: Set<string>;
    risks: Set<RiskClass>;
    networkPolicy: NetworkPolicy;
    grant: GrantRecord | null;
    directOperation: ContextRecord["directOperation"];
  }): CapabilityContext {
    const contextId = randomUUID();
    const executionDomainId = input.parent?.context.executionDomainId
      ?? (input.principal === "local-user-api" ? input.authority.authority.authorityId : contextId);
    const networkPolicy = copyNetworkPolicy(input.networkPolicy);
    const pathParent = input.parent?.pathAuthority ?? input.authority.pathAuthority;
    const pathAuthority = this.pathPolicy.deriveAuthority(pathParent, [...input.roots]);
    const allowedTools = deepFreeze([...input.bindings.keys()]);
    const allowedRoots = deepFreeze([...input.roots]);
    const allowedRiskClasses = deepFreeze([...input.risks].sort());
    const approvalGrant = input.grant ? deepFreeze({
      grantId: input.grant.grantId,
      registrationId: input.grant.registrationId,
      toolOrOperation: input.grant.toolName,
      argumentsDigest: input.grant.argumentsDigest,
      expiresAt: new Date(input.grant.expiresAtMs).toISOString(),
    }) : null;
    const context: CapabilityContext = deepFreeze({
      contextId,
      executionDomainId,
      sessionId: input.sessionId,
      runId: input.runId,
      parentContextId: input.parent?.context.contextId ?? null,
      principal: input.principal,
      persona: deepFreeze({ name: input.authority.persona.name, digest: input.authority.persona.digest }),
      authorityEpoch: input.authority.epoch,
      allowedTools,
      allowedRoots,
      networkPolicy,
      allowedRiskClasses,
      approvalGrant,
    });
    const executorEnvValues: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.authority.persona.env)) {
      const isRootEnv = Object.hasOwn(input.authority.persona.rootEnv, key);
      const mappedRootId = input.authority.persona.rootEnv[key];
      if (!isRootEnv || (mappedRootId !== null && input.roots.has(mappedRootId))) executorEnvValues[key] = value;
    }
    const executorEnv = deepFreeze({
      ...executorEnvValues,
      _SESSION_ID: input.sessionId,
      _CAPABILITY_CONTEXT_ID: contextId,
      _CAPABILITY_RUN_ID: input.runId,
      _CAPABILITY_PRINCIPAL: input.principal,
      _CAPABILITY_ALLOWED_ROOTS: JSON.stringify([...input.roots]),
    });
    const record: ContextRecord = {
      context,
      authority: input.authority,
      pathAuthority,
      parent: input.parent,
      children: new Set(),
      bindings: new Map(input.bindings),
      roots: new Set(input.roots),
      risks: new Set(input.risks),
      executorEnv,
      directOperation: input.directOperation,
      grant: input.grant,
      active: true,
    };
    this.contextRecords.set(context, record);
    input.authority.contexts.add(context);
    input.parent?.children.add(context);
    return context;
  }

  private revokeContext(record: ContextRecord): void {
    if (!record.active) return;
    for (const child of [...record.children]) {
      const childRecord = this.contextRecords.get(child);
      if (childRecord) this.revokeContext(childRecord);
    }
    record.active = false;
    this.pathPolicy.revoke(record.pathAuthority);
    if (record.grant) record.grant.consumed = true;
    if (record.directOperation) record.directOperation.consumed = true;
    for (const [challengeId, challenge] of this.challenges) {
      if (challenge.parent === record || !challenge.parent.active) {
        challenge.consumed = true;
        this.challenges.delete(challengeId);
      }
    }
    if (record.parent === null && record.context.principal === "agent") {
      const prefix = `${record.context.sessionId}\u0000${record.context.executionDomainId}\u0000${record.context.runId}\u0000`;
      for (const [key, owner] of [...record.authority.resourceOwners]) {
        if (!key.startsWith(prefix)) continue;
        record.authority.pendingResourceSessions.add(record.context.sessionId);
        const retirement = retireResourceOwner(owner);
        void retirement.then(() => {
          if (record.authority.resourceOwners.get(key) === owner) record.authority.resourceOwners.delete(key);
          record.authority.pendingResourceSessions.delete(record.context.sessionId);
        }).catch(() => {
          record.authority.pendingResourceSessions.delete(record.context.sessionId);
          record.authority.blockedResourceSessions.add(record.context.sessionId);
        });
      }
    }
    record.parent?.children.delete(record.context);
    record.authority.contexts.delete(record.context);
    if (record.authority.activeRoot === record.context) record.authority.activeRoot = null;
  }
}
