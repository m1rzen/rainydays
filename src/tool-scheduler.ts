import type { ToolPolicy } from "./capability-broker.js";

export type ToolExecutionBatchMode = "parallel-read" | "serial";

export interface SchedulableToolCall {
  readonly originalIndex: number;
  readonly policy: ToolPolicy;
  readonly dependsOn?: readonly number[];
}

export interface ToolExecutionBatch<T extends SchedulableToolCall = SchedulableToolCall> {
  readonly mode: ToolExecutionBatchMode;
  readonly calls: readonly T[];
}

const PARALLEL_RISKS = new Set(["read", "network"]);
const PARALLEL_EFFECTS = new Set(["filesystem", "network"]);
const PARALLEL_PATH_OPERATIONS = new Set(["read-file", "read-directory", "search-tree"]);

export function isParallelReadPolicy(policy: ToolPolicy): boolean {
  if (policy.concurrency !== "parallel-read") return false;
  const risks = policy.riskClasses;
  const effects = policy.effects;
  const pathOperations = policy.pathOperations ?? [];
  return policy.approval === "none"
    && policy.executionRootAccess === undefined
    && risks.length > 0
    && risks.includes("read")
    && risks.every(risk => PARALLEL_RISKS.has(risk))
    && effects.every(effect => PARALLEL_EFFECTS.has(effect))
    && pathOperations.every(operation => PARALLEL_PATH_OPERATIONS.has(operation))
    && (!effects.includes("filesystem") || risks.includes("read"))
    && (!effects.includes("network") || risks.includes("network"));
}

function dependencies(call: SchedulableToolCall): readonly number[] {
  return call.dependsOn ?? [];
}

function validateCall(call: SchedulableToolCall, knownIndices: ReadonlySet<number>): void {
  if (!Number.isSafeInteger(call.originalIndex) || call.originalIndex < 0) {
    throw new TypeError("Tool scheduling index is invalid");
  }
  const seen = new Set<number>();
  for (const dependency of dependencies(call)) {
    if (!Number.isSafeInteger(dependency) || dependency < 0 || dependency >= call.originalIndex || seen.has(dependency)) {
      throw new TypeError("Tool scheduling dependency is invalid");
    }
    if (!knownIndices.has(dependency)) throw new TypeError("Tool scheduling dependency is missing");
    seen.add(dependency);
  }
  if (call.policy.concurrency === "parallel-read" && !isParallelReadPolicy(call.policy)) {
    throw new TypeError("Parallel tool metadata is outside the read-only scheduling envelope");
  }
}

export function toolCallsConflict(left: SchedulableToolCall, right: SchedulableToolCall): boolean {
  if (!isParallelReadPolicy(left.policy) || !isParallelReadPolicy(right.policy)) return true;
  return dependencies(left).includes(right.originalIndex) || dependencies(right).includes(left.originalIndex);
}

export function buildToolExecutionBatches<T extends SchedulableToolCall>(calls: readonly T[]): readonly ToolExecutionBatch<T>[] {
  const knownIndices = new Set<number>();
  for (const call of calls) {
    if (knownIndices.has(call.originalIndex)) throw new TypeError("Tool scheduling index is duplicated");
    validateCall(call, knownIndices);
    knownIndices.add(call.originalIndex);
  }

  const batches: ToolExecutionBatch<T>[] = [];
  let parallel: T[] = [];
  const flushParallel = (): void => {
    if (parallel.length === 0) return;
    batches.push(Object.freeze({ mode: "parallel-read" as const, calls: Object.freeze([...parallel]) }));
    parallel = [];
  };

  for (const call of calls) {
    if (!isParallelReadPolicy(call.policy)) {
      flushParallel();
      batches.push(Object.freeze({ mode: "serial" as const, calls: Object.freeze([call]) }));
      continue;
    }
    if (parallel.some(existing => toolCallsConflict(existing, call))) flushParallel();
    parallel.push(call);
  }
  flushParallel();
  return Object.freeze(batches);
}
