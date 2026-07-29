import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import test from "node:test";
import { createSec02Recorder } from "../sec02-receipts.mjs";

const attackMatrix = JSON.parse(await fs.readFile(new URL("../sec02-attack-matrix.json", import.meta.url), "utf8"));
const observationById = new Map(attackMatrix.scenarios.flatMap(scenario => scenario.observations).map(observation => [observation.id, observation]));
const managedRootsRecorder = await createSec02Recorder(import.meta.url, "SEC-02 managed Persona and Skill roots bootstrap independently from Oracle");
const savePersonaRecorder = await createSec02Recorder(import.meta.url, "SEC-02 save_persona exclusively creates a user definition and hot reloads it");
const playbookRecorder = await createSec02Recorder(import.meta.url, "SEC-02 Playbook definitions use strict names, schema, and exclusive create");

const root = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec02-managed-"));
const appRoot = path.join(root, "app");
const userData = path.join(root, "user-data");
const builtinPersonas = path.join(appRoot, "personas");
const builtinSkills = path.join(appRoot, "skills");
await fs.mkdir(builtinPersonas, { recursive: true });
await fs.mkdir(builtinSkills, { recursive: true });
await fs.mkdir(userData, { recursive: true });
await fs.writeFile(path.join(builtinSkills, "base-skill.md"), "managed skill content");
await fs.writeFile(path.join(builtinPersonas, "base.md"), `---
name: base
display_name: Base Persona
description: builtin base
tools: []
skills:
  - base-skill
env: {}
network_policy: deny
---
Builtin prompt`);

process.env.MINI_LUX_APP_ROOT = appRoot;
process.env.MINI_LUX_USER_DATA_DIR = userData;
process.env.MINI_LUX_DATA_DIR = path.join(userData, "data");
process.env.MINI_LUX_BUILTIN_PERSONAS_DIR = builtinPersonas;
process.env.MINI_LUX_BUILTIN_SKILLS_DIR = builtinSkills;
delete process.env.MINI_LUX_USER_PERSONAS_DIR;
delete process.env.MINI_LUX_USER_SKILLS_DIR;
delete process.env.MINI_LUX_PLAYBOOKS_DIR;
// This path is intentionally unusable. Persona/Skill/Playbook must not eagerly prepare Oracle.
process.env.MINI_LUX_ORACLE_PATH = path.join(root, "outside-oracle", "LUX.oracle");

const [{ PathDeniedError }, personaModule, savePersonaModule, playbookModule] = await Promise.all([
  import("../../dist/path-policy.js"),
  import("../../dist/persona.js"),
  import("../../dist/tools/save-persona.js"),
  import("../../dist/playbook.js"),
]);

async function snapshotDirectory(directory) {
  const snapshot = [];
  for (const name of await fs.readdir(directory).catch(error => error?.code === "ENOENT" ? [] : Promise.reject(error))) {
    const file = path.join(directory, name);
    const info = await fs.lstat(file);
    if (info.isSymbolicLink()) snapshot.push([name, "link", await fs.readlink(file)]);
    else if (info.isFile()) snapshot.push([name, "file", (await fs.readFile(file)).toString("base64")]);
    else snapshot.push([name, info.isDirectory() ? "directory" : "other"]);
  }
  return snapshot;
}

async function captureDeniedOperation({ directory, rawPath, operation, countPublications = value => Number(value !== undefined) }) {
  const before = await snapshotDirectory(directory);
  const errors = [];
  let publications = 0;
  try {
    publications = countPublications(await operation());
  } catch (error) {
    errors.push(error);
  }
  const after = await snapshotDirectory(directory);
  const rawPathPublished = errors.some(error => Object.values(error).some(value => typeof value === "string" && value.includes(rawPath)));
  return {
    error: errors[0],
    actual: {
      denied: errors.length === 1,
      publications,
      managedWrites: Number(JSON.stringify(before) !== JSON.stringify(after)),
      auditAttempts: errors.length,
      auditAllowedFieldsExact: errors.every(error => !("path" in error) && !("filename" in error)),
      rawPathsAbsent: !rawPathPublished,
    },
  };
}

async function observe(recorder, id, actual) {
  assert.deepEqual(actual, observationById.get(id).expected, `${id} evidence differs`);
  if (recorder.enabled) await recorder.observe(id, actual);
}

test.after(async () => {
  await managedRootsRecorder.close();
  await savePersonaRecorder.close();
  await playbookRecorder.close();
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

test("SEC-02 managed Persona and Skill roots bootstrap independently from Oracle", async () => {
  const personas = await personaModule.listPersonas();
  const base = personas.find(persona => persona.name === "base");
  assert(base);
  assert.match(base.systemPrompt, /Builtin prompt/);
  assert.match(base.systemPrompt, /managed skill content/);
  assert.deepEqual(await personaModule.listAvailableSkills(), ["base-skill"]);
  const skillContent = await personaModule.loadSkillContent("base-skill");
  assert.equal(skillContent, "managed skill content");
  if (managedRootsRecorder.enabled) await managedRootsRecorder.positive("SEC02-POS-skill");

  const personaDirectory = path.join(userData, "data", "personas");
  const skillDirectory = path.join(userData, "data", "skills");
  const externalDirectory = path.join(root, "external-managed-definitions");
  await fs.mkdir(externalDirectory);

  const personaTraversal = await captureDeniedOperation({
    directory: personaDirectory,
    rawPath: "../escape",
    operation: () => personaModule.getPersona("../escape"),
    countPublications: value => Number(value !== null),
  });
  assert(personaTraversal.error instanceof PathDeniedError);
  assert.equal(personaTraversal.error.code, "PATH_INPUT_INVALID");
  {
    const { publications: promptPublications, ...actual } = personaTraversal.actual;
    await observe(managedRootsRecorder, "SEC02-P26-persona-traversal", { ...actual, promptPublications });
  }

  const personaDevice = await captureDeniedOperation({
    directory: personaDirectory,
    rawPath: "con",
    operation: () => personaModule.getPersona("con"),
    countPublications: value => Number(value !== null),
  });
  assert(personaDevice.error instanceof PathDeniedError);
  assert.equal(personaDevice.error.code, "PATH_NAMESPACE_DENIED");
  {
    const { publications: promptPublications, ...actual } = personaDevice.actual;
    await observe(managedRootsRecorder, "SEC02-P26-persona-device", { ...actual, promptPublications });
  }

  const externalPersona = path.join(externalDirectory, "linked-persona.md");
  await fs.writeFile(externalPersona, `---
name: linked-persona
display_name: Linked Persona
tools: []
env: {}
network_policy: deny
---
external prompt`);
  const personaLink = path.join(personaDirectory, "linked-persona.md");
  await fs.symlink(externalPersona, personaLink, "file");
  let personaExternalBytesRead = 0;
  const linkedPersona = await captureDeniedOperation({
    directory: personaDirectory,
    rawPath: externalPersona,
    operation: () => personaModule.getPersona("linked-persona"),
    countPublications: value => {
      personaExternalBytesRead += Buffer.byteLength(value?.systemPrompt ?? "");
      return Number(value !== null);
    },
  });
  assert(linkedPersona.error instanceof PathDeniedError);
  assert.equal(linkedPersona.error.code, "PATH_REDIRECT_DENIED");
  {
    const { publications: promptPublications, ...actual } = linkedPersona.actual;
    await observe(managedRootsRecorder, "SEC02-P26-persona-link", { ...actual, promptPublications, rootExternalBytesRead: personaExternalBytesRead });
  }
  await fs.rm(personaLink);

  const mismatchedPersona = path.join(personaDirectory, "base.md");
  await fs.writeFile(mismatchedPersona, `---
name: different-name
display_name: Forged Override
tools: []
env: {}
network_policy: deny
---
forged`);
  const reloaded = await personaModule.reloadPersonas();
  assert.equal(reloaded.some(persona => persona.name === "base"), false);
  const personaMismatch = await captureDeniedOperation({
    directory: personaDirectory,
    rawPath: mismatchedPersona,
    operation: () => personaModule.getPersona("base"),
    countPublications: value => Number(value !== null),
  });
  assert.match(personaMismatch.error?.message ?? "", /文件名与 name 不一致/);
  {
    const { publications: promptPublications, ...actual } = personaMismatch.actual;
    await observe(managedRootsRecorder, "SEC02-P26-persona-name-mismatch", { ...actual, promptPublications });
  }
  await fs.rm(mismatchedPersona);
  await personaModule.reloadPersonas();

  const skillTraversal = await captureDeniedOperation({
    directory: skillDirectory,
    rawPath: "../escape",
    operation: () => personaModule.loadSkillContent("../escape"),
    countPublications: value => Number(value !== null),
  });
  assert(skillTraversal.error instanceof PathDeniedError);
  assert.equal(skillTraversal.error.code, "PATH_INPUT_INVALID");
  {
    const { publications: promptPublications, ...actual } = skillTraversal.actual;
    await observe(managedRootsRecorder, "SEC02-P26-skill-traversal", { ...actual, promptPublications });
  }

  const skillDevice = await captureDeniedOperation({
    directory: skillDirectory,
    rawPath: "con",
    operation: () => personaModule.loadSkillContent("con"),
    countPublications: value => Number(value !== null),
  });
  assert(skillDevice.error instanceof PathDeniedError);
  assert.equal(skillDevice.error.code, "PATH_NAMESPACE_DENIED");
  {
    const { publications: promptPublications, ...actual } = skillDevice.actual;
    await observe(managedRootsRecorder, "SEC02-P26-skill-device", { ...actual, promptPublications });
  }

  const externalSkill = path.join(externalDirectory, "linked-skill.md");
  await fs.writeFile(externalSkill, "external skill bytes");
  const skillLink = path.join(skillDirectory, "linked-skill.md");
  await fs.symlink(externalSkill, skillLink, "file");
  let skillExternalBytesRead = 0;
  const linkedSkill = await captureDeniedOperation({
    directory: skillDirectory,
    rawPath: externalSkill,
    operation: () => personaModule.loadSkillContent("linked-skill"),
    countPublications: value => {
      skillExternalBytesRead += Buffer.byteLength(value ?? "");
      return Number(value !== null);
    },
  });
  assert(linkedSkill.error instanceof PathDeniedError);
  assert.equal(linkedSkill.error.code, "PATH_REDIRECT_DENIED");
  {
    const { publications: promptPublications, ...actual } = linkedSkill.actual;
    await observe(managedRootsRecorder, "SEC02-P26-skill-link", { ...actual, promptPublications, rootExternalBytesRead: skillExternalBytesRead });
  }
  await fs.rm(skillLink);

  assert.equal(await fs.readFile(path.join(personaDirectory, ".mini-lux-managed-root"), "utf8"), "");
  assert.equal(await fs.readFile(path.join(skillDirectory, ".mini-lux-managed-root"), "utf8"), "");
  await assert.rejects(() => fs.access(path.join(root, "outside-oracle")));
});

test("SEC-02 save_persona exclusively creates a user definition and hot reloads it", async () => {
  let saved = null;
  const exec = savePersonaModule.createSavePersonaExec(
    () => ({
      tools: ["read_file"],
      env: { DATA_ROOT: root },
      networkPolicy: { mode: "deny" },
      systemPrompt: "Saved managed prompt",
    }),
    async name => { saved = name; await personaModule.reloadPersonas(); }
  );
  const first = await exec({ name: "saved-persona", displayName: "Saved Persona", description: "managed" }, {});
  assert.match(first, /已保存/);
  assert.equal(saved, "saved-persona");
  const loaded = await personaModule.getPersona("saved-persona");
  assert(loaded);
  assert.equal(loaded.displayName, "Saved Persona");
  assert.match(loaded.systemPrompt, /Saved managed prompt/);
  if (savePersonaRecorder.enabled) await savePersonaRecorder.positive("SEC02-POS-persona");
  const second = await exec({ name: "saved-persona", displayName: "Duplicate" }, {});
  assert.match(second, /已存在/);
  const invalid = await exec({ name: "../escape", displayName: "Escape" }, {});
  assert.match(invalid, /Persona 名称必须/);
  await assert.rejects(() => fs.access(path.join(userData, "escape.md")));
});

test("SEC-02 malformed same-name user Persona suppresses builtin fallback", async () => {
  await fs.writeFile(path.join(userData, "data", "personas", "base.md"), `---
name: different-name
display_name: Forged Override
tools: []
env: {}
network_policy: deny
---
forged`);
  const personas = await personaModule.reloadPersonas();
  assert.equal(personas.some(persona => persona.name === "base"), false);
  await assert.rejects(() => personaModule.getPersona("base"), /文件名与 name 不一致/);
});

test("SEC-02 Playbook definitions use strict names, schema, and exclusive create", async () => {
  const playbook = {
    name: "managed-run",
    description: "managed playbook",
    steps: [{ message: "step one" }, { message: "step two", description: "second" }],
  };
  const created = await playbookModule.createPlaybook(playbook);
  assert.match(created, /已创建/);
  if (playbookRecorder.enabled) await playbookRecorder.positive("SEC02-POS-playbook-create");
  const listed = await playbookModule.listPlaybooks();
  const loaded = await playbookModule.getPlaybook("managed-run");
  assert.deepEqual(listed, [{ name: "managed-run", description: "managed playbook", steps: 2 }]);
  assert.deepEqual(loaded, playbook);
  if (playbookRecorder.enabled) await playbookRecorder.positive("SEC02-POS-playbook-read");

  const playbookDirectory = path.join(userData, "playbooks");
  let llmCalls = 0;
  let executorCalls = 0;
  const traversal = await captureDeniedOperation({
    directory: playbookDirectory,
    rawPath: "../escape",
    operation: () => playbookModule.createPlaybook({ name: "../escape", description: "x", steps: [{ message: "x" }] }),
    countPublications: () => 0,
  });
  assert(traversal.error instanceof PathDeniedError);
  assert.equal(traversal.error.code, "PATH_INPUT_INVALID");
  {
    const { publications: _publications, ...actual } = traversal.actual;
    await observe(playbookRecorder, "SEC02-P27-traversal", { ...actual, llmCalls, executorCalls });
  }

  const externalPlaybook = path.join(root, "external-linked-playbook.json");
  await fs.writeFile(externalPlaybook, JSON.stringify({ name: "linked-run", description: "external", steps: [{ message: "x" }] }));
  const linkedPlaybookPath = path.join(playbookDirectory, "linked-run.json");
  await fs.symlink(externalPlaybook, linkedPlaybookPath, "file");
  let externalPlaybookBytesRead = 0;
  const linked = await captureDeniedOperation({
    directory: playbookDirectory,
    rawPath: externalPlaybook,
    operation: () => playbookModule.getPlaybook("linked-run"),
    countPublications: value => {
      externalPlaybookBytesRead += Buffer.byteLength(JSON.stringify(value ?? ""));
      return Number(value !== null);
    },
  });
  assert(linked.error instanceof PathDeniedError);
  assert.equal(linked.error.code, "PATH_REDIRECT_DENIED");
  {
    const { publications: _publications, ...actual } = linked.actual;
    await observe(playbookRecorder, "SEC02-P27-linked-json", {
      ...actual,
      llmCalls,
      executorCalls,
      rootExternalBytesRead: externalPlaybookBytesRead,
    });
  }
  await fs.rm(linkedPlaybookPath);

  const exclusive = await captureDeniedOperation({
    directory: playbookDirectory,
    rawPath: path.join(playbookDirectory, "managed-run.json"),
    operation: () => playbookModule.createPlaybook(playbook),
    countPublications: () => 0,
  });
  assert(exclusive.error instanceof PathDeniedError);
  assert.equal(exclusive.error.code, "PATH_OPERATION_DENIED");
  assert.deepEqual(await playbookModule.getPlaybook("managed-run"), playbook);
  {
    const { publications: _publications, ...actual } = exclusive.actual;
    await observe(playbookRecorder, "SEC02-P27-exclusive-overwrite", { ...actual, llmCalls: 0, executorCalls: 0 });
  }

  const invalidPlaybookPath = path.join(playbookDirectory, "invalid-schema.json");
  await fs.writeFile(invalidPlaybookPath, JSON.stringify({ name: "invalid-schema", description: 7, steps: [] }));
  const schemaInvalid = await captureDeniedOperation({
    directory: playbookDirectory,
    rawPath: invalidPlaybookPath,
    operation: () => playbookModule.getPlaybook("invalid-schema"),
    countPublications: value => Number(value !== null),
  });
  assert.match(schemaInvalid.error?.message ?? "", /定义无效/);
  {
    const { publications: _publications, ...actual } = schemaInvalid.actual;
    await observe(playbookRecorder, "SEC02-P27-schema-invalid", { ...actual, llmCalls: 0, executorCalls: 0 });
  }

  llmCalls = 0;
  executorCalls = 0;
  const executionDenied = await captureDeniedOperation({
    directory: playbookDirectory,
    rawPath: invalidPlaybookPath,
    operation: () => playbookModule.executePlaybook(
      "invalid-schema",
      { chat: async () => { llmCalls += 1; return { content: "unexpected" }; } },
      { systemPrompt: "managed" },
      { sessionId: "managed-test-session", runId: "managed-test-run" },
      {
        getToolDefinitions: () => [],
        executeTool: async () => { executorCalls += 1; return "unexpected"; },
      }
    ),
    countPublications: value => Number(value !== undefined),
  });
  assert.match(executionDenied.error?.message ?? "", /定义无效/);
  {
    const { publications: _publications, ...actual } = executionDenied.actual;
    await observe(playbookRecorder, "SEC02-P27-llm-execution-zero", { ...actual, llmCalls, executorCalls });
  }
  await fs.rm(invalidPlaybookPath);
  await assert.rejects(() => fs.access(path.join(userData, "escape.json")));
});

test("SEC-02 bootstrap environment path candidates reject relative and escaped roots before use", async t => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec02-bootstrap-env-"));
  t.after(async () => fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const candidateApp = path.join(fixture, "app");
  const candidateUser = path.join(fixture, "user");
  const outside = path.join(fixture, "outside");
  await Promise.all([candidateApp, candidateUser, outside].map(directory => fs.mkdir(directory, { recursive: true })));
  const runtimePathsUrl = new URL("../../dist/runtime-paths.js", import.meta.url).href;
  const baseEnv = { ...process.env };
  for (const key of Object.keys(baseEnv)) if (key.startsWith("MINI_LUX_") && key.endsWith("_DIR")) delete baseEnv[key];
  delete baseEnv.MINI_LUX_CONFIG_PATH;
  delete baseEnv.MINI_LUX_ORACLE_PATH;

  for (const scenario of [
    { value: "relative-data", key: "MINI_LUX_DATA_DIR", code: "PATH_INPUT_INVALID" },
    { value: outside, key: "MINI_LUX_PUBLIC_DIR", code: "PATH_ROOT_DENIED" },
  ]) {
    const childCode = `try { await import(${JSON.stringify(runtimePathsUrl)}); console.log("UNEXPECTED_PASS"); process.exitCode = 2; } catch (error) { console.log(error?.code || error?.name); }`;
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", childCode], {
        windowsHide: true,
        env: {
          ...baseEnv,
          MINI_LUX_APP_ROOT: candidateApp,
          MINI_LUX_USER_DATA_DIR: candidateUser,
          [scenario.key]: scenario.value,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", chunk => { stdout += chunk; });
      child.stderr.on("data", chunk => { stderr += chunk; });
      child.once("error", reject);
      child.once("close", code => resolve({ code, stdout, stderr }));
    });
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(scenario.code));
    assert(!result.stdout.includes("UNEXPECTED_PASS"));
  }
});

test("SEC-02 a managed user Persona junction is rejected in a fresh process", async t => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec02-managed-junction-"));
  t.after(async () => fs.rm(fixture, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const childApp = path.join(fixture, "app");
  const childData = path.join(fixture, "data");
  const external = path.join(fixture, "external");
  await fs.mkdir(path.join(childApp, "personas"), { recursive: true });
  await fs.mkdir(path.join(childApp, "skills"), { recursive: true });
  await fs.mkdir(childData, { recursive: true });
  await fs.mkdir(external, { recursive: true });
  await fs.symlink(external, path.join(childData, "personas"), "junction");
  const childCode = `
    for (const key of ["MINI_LUX_DATA_DIR", "MINI_LUX_CONFIG_PATH", "MINI_LUX_PUBLIC_DIR", "MINI_LUX_MODELS_DIR", "MINI_LUX_USER_SKILLS_DIR", "MINI_LUX_PLAYBOOKS_DIR", "MINI_LUX_ORACLE_PATH"]) delete process.env[key];
    process.env.MINI_LUX_APP_ROOT = ${JSON.stringify(childApp)};
    process.env.MINI_LUX_USER_DATA_DIR = ${JSON.stringify(childData)};
    process.env.MINI_LUX_USER_PERSONAS_DIR = ${JSON.stringify(path.join(childData, "personas"))};
    process.env.MINI_LUX_BUILTIN_PERSONAS_DIR = ${JSON.stringify(path.join(childApp, "personas"))};
    process.env.MINI_LUX_BUILTIN_SKILLS_DIR = ${JSON.stringify(path.join(childApp, "skills"))};
    const { listPersonas } = await import(${JSON.stringify(new URL("../../dist/persona.js", import.meta.url).href)});
    try { await listPersonas(); console.log("UNEXPECTED_PASS"); process.exitCode = 2; }
    catch (error) { console.log(error?.code || error?.name); }
  `;
  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", childCode], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", code => resolve({ code, stdout, stderr }));
  });
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /PATH_REDIRECT_DENIED/);
  assert(!result.stdout.includes("UNEXPECTED_PASS"));
  assert.deepEqual(await fs.readdir(external), []);
});
