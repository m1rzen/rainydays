import { randomBytes } from "node:crypto";
import type { ToolDefinition, ToolExecutor } from "../types.js";
import { getManagedPathStore } from "../managed-path-store.js";
import { ROUTINE_DONE_PREFIX } from "../script-runtime.js";
import { createRoutine, deleteRoutine, getRoutine, runRoutine, searchRoutines, type RoutineProject } from "../routine.js";

const idProperty = { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$", description: "Routine project id" } as const;

export const routineSearchDef: ToolDefinition = {
  type: "function",
  function: {
    name: "routine_search",
    description: "Search managed npm Routine projects by id, name, or description.",
    parameters: {
      type: "object",
      properties: { query: { type: "string", maxLength: 200 } },
      additionalProperties: false,
    },
  },
};

export const routineGetDef: ToolDefinition = {
  type: "function",
  function: {
    name: "routine_get",
    description: "Read one managed Routine project, including schemas and routine.mjs source.",
    parameters: { type: "object", properties: { id: idProperty }, required: ["id"], additionalProperties: false },
  },
};

export const routineCreateDef: ToolDefinition = {
  type: "function",
  function: {
    name: "routine_create",
    description: "Create an exclusive managed npm Routine project with strict JSON Schema input/output contracts.",
    parameters: {
      type: "object",
      properties: {
        id: idProperty,
        name: { type: "string", minLength: 1, maxLength: 120 },
        description: { type: "string", maxLength: 1000 },
        inputSchema: { type: "object" },
        outputSchema: { type: "object" },
        timeoutMs: { type: "integer", minimum: 100, maximum: 10000 },
        source: { type: "string", minLength: 1, maxLength: 131072, description: "Node ESM routine.mjs source; call lux.done(value) exactly once." },
      },
      required: ["id", "name", "inputSchema", "outputSchema", "timeoutMs"],
      additionalProperties: false,
    },
  },
};

export const routineDeleteDef: ToolDefinition = {
  type: "function",
  function: {
    name: "routine_delete",
    description: "Delete a managed Routine project. Deletion is denied while the same Routine is running.",
    parameters: { type: "object", properties: { id: idProperty }, required: ["id"], additionalProperties: false },
  },
};

export const routineRunDef: ToolDefinition = {
  type: "function",
  function: {
    name: "routine_run",
    description: "Run a managed Routine in the finite SEC-03 E3 runtime after input validation, then validate its lux.done output.",
    parameters: {
      type: "object",
      properties: { id: idProperty, input: { description: "JSON value validated by the Routine input schema" } },
      required: ["id", "input"],
      additionalProperties: false,
    },
  },
};

export const routineSearchExec: ToolExecutor = async (args) => JSON.stringify(await searchRoutines(typeof args.query === "string" ? args.query : ""), null, 2);

export const routineGetExec: ToolExecutor = async (args) => JSON.stringify(await getRoutine(args.id as string), null, 2);

export const routineCreateExec: ToolExecutor = async (args) => {
  const metadata = await createRoutine({
    id: args.id as string,
    name: args.name as string,
    description: typeof args.description === "string" ? args.description : "",
    inputSchema: args.inputSchema as Readonly<Record<string, unknown>>,
    outputSchema: args.outputSchema as Readonly<Record<string, unknown>>,
    timeoutMs: args.timeoutMs as number,
    source: typeof args.source === "string" ? args.source : undefined,
  });
  return JSON.stringify(metadata, null, 2);
};

export const routineDeleteExec: ToolExecutor = async (args) => {
  await deleteRoutine(args.id as string);
  return `Routine ${args.id as string} deleted`;
};

function parseRoutineCompletion(project: RoutineProject, stdout: string, completionToken: string): unknown {
  const prefix = `${ROUTINE_DONE_PREFIX}${completionToken}:`;
  const markers = stdout.split(/\r?\n/u).filter((line) => line.startsWith(prefix));
  if (markers.length !== 1) throw new Error(`Routine ${project.id} must call lux.done exactly once`);
  const payload = markers[0].slice(prefix.length);
  try {
    return JSON.parse(payload);
  } catch (error) {
    throw new Error(`Routine ${project.id} produced invalid lux.done JSON`, { cause: error });
  }
}

export const routineRunExec: ToolExecutor = async (args, _env, invocation) => {
  if (!invocation) throw new Error("Routine execution gateway is required");
  const id = args.id as string;
  return JSON.stringify(await runRoutine(id, args.input, async (project, input) => {
    const completionToken = randomBytes(16).toString("hex");
    const store = await getManagedPathStore();
    const result = await store.withRoutineExecutionRoot(project.id, (_cwd, rootLease) => invocation.execution.executeScript({
      code: project.source,
      lang: "node",
      timeoutMs: project.timeoutMs,
      rootLease,
      mode: "routine",
      routineId: project.id,
      routineInput: input,
      completionToken,
    }));
    if (result.reason !== "completed" || result.exitCode !== 0) {
      const detail = [result.stdout, result.stderr].filter(Boolean).join("\n");
      throw new Error(`Routine ${project.id} execution failed (${result.reason}; exit ${result.exitCode ?? "none"})${detail ? `\n${detail}` : ""}`);
    }
    return parseRoutineCompletion(project, result.stdout, completionToken);
  }), null, 2);
};
