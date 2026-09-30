import Ajv, { type ValidateFunction } from "ajv";
import { getManagedPathStore, validateManagedIdentifier } from "./managed-path-store.js";
import { parseScriptTimeout } from "./script-runtime.js";

export interface RoutineMetadata {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly timeoutMs: number;
}

export interface RoutineProject extends RoutineMetadata {
  readonly source: string;
}

export interface RoutineSummary {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly timeoutMs: number;
}

export interface CreateRoutineInput extends RoutineMetadata {
  readonly source?: string;
}

export type RoutineRunner = (project: RoutineProject, input: unknown) => Promise<unknown>;

const SOURCE_BYTES = 128 * 1024;
const ajv = new Ajv({ allErrors: true, coerceTypes: false, removeAdditional: false, useDefaults: false, strict: false });
const activeRoutineIds = new Set<string>();

function record(value: unknown, label: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} must be a JSON Schema object`);
  return structuredClone(value as Record<string, unknown>);
}

function exactText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum || value.includes("\0")) throw new TypeError(`${label} is invalid`);
  return value;
}

function description(value: unknown, label: string): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length > 1_000 || value.includes("\0")) throw new TypeError(`${label} is invalid`);
  return value;
}

function validator(schema: Readonly<Record<string, unknown>>, label: string): ValidateFunction {
  try {
    return ajv.compile(schema);
  } catch (error) {
    throw new TypeError(`${label} is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function validationMessage(validate: ValidateFunction): string {
  return ajv.errorsText(validate.errors, { separator: "; ", dataVar: "value" });
}

function metadataFromPackage(id: string, value: unknown): RoutineMetadata {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`Routine ${id} package.json is invalid`);
  const root = value as Record<string, unknown>;
  const lux = root.lux;
  if (!lux || typeof lux !== "object" || Array.isArray(lux)) throw new TypeError(`Routine ${id} package.json has no lux metadata`);
  const routine = (lux as Record<string, unknown>).routine;
  if (!routine || typeof routine !== "object" || Array.isArray(routine)) throw new TypeError(`Routine ${id} metadata is invalid`);
  const item = routine as Record<string, unknown>;
  if (item.id !== id) throw new TypeError(`Routine ${id} metadata id differs`);
  const inputSchema = record(item.inputSchema, `Routine ${id} inputSchema`);
  const outputSchema = record(item.outputSchema, `Routine ${id} outputSchema`);
  validator(inputSchema, `Routine ${id} inputSchema`);
  validator(outputSchema, `Routine ${id} outputSchema`);
  return Object.freeze({
    id,
    name: exactText(item.name, `Routine ${id} name`, 120),
    description: description(item.description, `Routine ${id} description`),
    inputSchema,
    outputSchema,
    timeoutMs: parseScriptTimeout(item.timeoutMs),
  });
}

async function loadRoutine(idInput: string): Promise<RoutineProject> {
  const id = validateManagedIdentifier(idInput);
  const store = await getManagedPathStore();
  const packageBytes = await store.readRoutineFile(id, "package.json");
  const sourceBytes = await store.readRoutineFile(id, "routine.mjs");
  let packageValue: unknown;
  try {
    packageValue = JSON.parse(packageBytes.toString("utf8"));
  } catch (error) {
    throw new TypeError(`Routine ${id} package.json is invalid`, { cause: error });
  }
  const metadata = metadataFromPackage(id, packageValue);
  const source = sourceBytes.toString("utf8");
  exactText(source, `Routine ${id} source`, SOURCE_BYTES);
  return Object.freeze({ ...metadata, source });
}

export async function searchRoutines(query = ""): Promise<RoutineSummary[]> {
  const store = await getManagedPathStore();
  const needle = query.trim().toLocaleLowerCase();
  const results: RoutineSummary[] = [];
  for (const id of await store.listRoutineIds()) {
    try {
      const project = await loadRoutine(id);
      const text = `${project.id}\n${project.name}\n${project.description}`.toLocaleLowerCase();
      if (!needle || text.includes(needle)) results.push(Object.freeze({ id: project.id, name: project.name, description: project.description, timeoutMs: project.timeoutMs }));
    } catch (error) {
      console.error(`Skipping invalid Routine ${id}:`, error);
    }
  }
  return results;
}

export async function getRoutine(id: string): Promise<RoutineProject> {
  return loadRoutine(id);
}

export async function createRoutine(input: CreateRoutineInput): Promise<RoutineMetadata> {
  const id = validateManagedIdentifier(input.id);
  const name = exactText(input.name, "Routine name", 120);
  const routineDescription = description(input.description, "Routine description");
  const inputSchema = record(input.inputSchema, "Routine inputSchema");
  const outputSchema = record(input.outputSchema, "Routine outputSchema");
  validator(inputSchema, "Routine inputSchema");
  validator(outputSchema, "Routine outputSchema");
  const timeoutMs = parseScriptTimeout(input.timeoutMs);
  const source = input.source === undefined ? "lux.done(lux.input);" : exactText(input.source, "Routine source", SOURCE_BYTES);
  const metadata: RoutineMetadata = Object.freeze({ id, name, description: routineDescription, inputSchema, outputSchema, timeoutMs });
  const packageValue = {
    name: `@rainydays/routine-${id}`,
    private: true,
    type: "module",
    lux: { routine: metadata },
  };
  const store = await getManagedPathStore();
  await store.createRoutineProject(
    id,
    Buffer.from(`${JSON.stringify(packageValue, null, 2)}\n`, "utf8"),
    Buffer.from(`${source.trim()}\n`, "utf8"),
  );
  return metadata;
}

export async function deleteRoutine(idInput: string): Promise<void> {
  const id = validateManagedIdentifier(idInput);
  if (activeRoutineIds.has(id)) throw new Error(`Routine ${id} is running and cannot be deleted`);
  const store = await getManagedPathStore();
  await store.removeRoutineProject(id);
}

export async function runRoutine(idInput: string, input: unknown, run: RoutineRunner): Promise<unknown> {
  const id = validateManagedIdentifier(idInput);
  if (activeRoutineIds.has(id)) throw new Error(`Routine ${id} is already running`);
  activeRoutineIds.add(id);
  try {
    const project = await loadRoutine(id);
    const validateInput = validator(project.inputSchema, `Routine ${id} inputSchema`);
    const stableInput = structuredClone(input);
    if (!validateInput(stableInput)) throw new TypeError(`Routine ${id} input rejected: ${validationMessage(validateInput)}`);
    const output = await run(project, stableInput);
    const validateOutput = validator(project.outputSchema, `Routine ${id} outputSchema`);
    if (!validateOutput(output)) throw new TypeError(`Routine ${id} output rejected: ${validationMessage(validateOutput)}`);
    return structuredClone(output);
  } finally {
    activeRoutineIds.delete(id);
  }
}

export function isRoutineRunning(idInput: string): boolean {
  return activeRoutineIds.has(validateManagedIdentifier(idInput));
}
