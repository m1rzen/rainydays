import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const personaModule = await import("../../dist/persona.js");
const personaTools = await import("../../dist/tools/persona-tools.js");
const { RUNTIME_TOOL_POLICIES } = await import("../../dist/tool-policies.js");

function source(frontmatter, body = "Persona prompt") {
  return Buffer.from(`---\n${frontmatter}\n---\n${body}\n`, "utf8");
}

function invocation(sessionId = "session-a", principal = "agent") {
  return { capabilityContext: { sessionId, principal } };
}

test("PERS-01 Persona source applies permission levels and allow/deny overlays", async () => {
  const persona = await personaModule.validatePersonaSource(
    "reader",
    source(`name: reader\ndisplay_name: Reader\ndescription: Read-only\npermission_level: read_only\ntools:\n  - read\n  - grep\nallow_tools:\n  - web_search\ndeny_tools:\n  - grep\nenv: {}\nnetwork_policy: deny`),
    async () => null,
  );
  assert.equal(persona.permissionLevel, "read_only");
  assert(persona.tools.includes("read"));
  assert(persona.tools.includes("web_search"));
  assert(!persona.tools.includes("grep"));
  for (const name of personaModule.PERSONA_MANAGEMENT_TOOLS) assert(persona.tools.includes(name));
  assert.deepEqual(persona.allowTools, ["web_search"]);
  assert.deepEqual(persona.denyTools, ["grep"]);

  await assert.rejects(
    () => personaModule.validatePersonaSource(
      "unsafe-reader",
      source(`name: unsafe-reader\npermission_level: read_only\ntools:\n  - write\nenv: {}\nnetwork_policy: deny`),
      async () => null,
    ),
    /read_only Persona/u,
  );
  await assert.rejects(
    () => personaModule.validatePersonaSource(
      "minimal-writer",
      source(`name: minimal-writer\npermission_level: minimal\ntools:\n  - write\nenv: {}\nnetwork_policy: deny`),
      async () => null,
    ),
    /minimal Persona/u,
  );
  await assert.rejects(
    () => personaModule.validatePersonaSource(
      "deny-control",
      source(`name: deny-control\npermission_level: guarded\ntools: []\ndeny_tools:\n  - switch_persona\nenv: {}\nnetwork_policy: deny`),
      async () => null,
    ),
    /不能 deny Persona 管理工具/u,
  );
});

test("PERS-01 locked Lux baseline built-in Personas are present and valid", async () => {
  const names = [
    "default", "developer", "explorer", "reviewer", "architect", "quick-fix", "debugger", "writer", "daily",
    "analyst", "planner", "skill-crafter", "prompt-designer", "playbook", "routine", "sentinel", "overseer",
  ];
  for (const name of names) {
    const bytes = await fs.readFile(path.join(projectRoot, "personas", `${name}.md`));
    const persona = await personaModule.validatePersonaSource(name, bytes, async () => null);
    assert.equal(persona.name, name);
    assert(persona.permissionLevel);
    for (const tool of personaModule.PERSONA_MANAGEMENT_TOOLS) assert(persona.tools.includes(tool));
  }
});

test("PERS-01 management tools bind current Session and expose elevation", async () => {
  const current = personaModule.createEffectivePersona({
    name: "reader", displayName: "Reader", description: "", permissionLevel: "read_only",
    tools: [...personaModule.PERSONA_MANAGEMENT_TOOLS], allowTools: [], denyTools: [],
    env: {}, allowedRoots: [], networkPolicy: { mode: "deny" }, systemPrompt: "reader",
  });
  const target = personaModule.createEffectivePersona({
    name: "developer", displayName: "Developer", description: "", permissionLevel: "coding",
    tools: [...personaModule.PERSONA_MANAGEMENT_TOOLS], allowTools: [], denyTools: [],
    env: {}, allowedRoots: [], networkPolicy: { mode: "deny" }, systemPrompt: "developer",
  });
  const switched = [];
  const executors = personaTools.createPersonaManagementExecutors({
    list: () => [current, target],
    current: () => current,
    switchCurrentSession: async (sessionId, name, expectedDigest) => {
      switched.push({ sessionId, name, expectedDigest });
      return target;
    },
  });

  const listed = JSON.parse(await executors.list_personas({}, {}, invocation()));
  assert.deepEqual(listed.personas.map(persona => persona.name), ["reader", "developer"]);
  const found = JSON.parse(await executors.find_personas({ keyword: "develop" }, {}, invocation()));
  assert.deepEqual(found.personas.map(persona => persona.name), ["developer"]);
  const active = JSON.parse(await executors.current_persona({}, {}, invocation("session-a")));
  assert.equal(active.sessionId, "session-a");
  assert.equal(active.permissionLevel, "read_only");
  assert.equal(Object.hasOwn(active, "systemPrompt"), false);

  const result = JSON.parse(await executors.switch_persona({ name: "developer", expected_digest: target.digest }, {}, invocation("session-a")));
  assert.deepEqual(switched, [{ sessionId: "session-a", name: "developer", expectedDigest: target.digest }]);
  assert.equal(result.elevation, true);
  assert.equal(result.effective, "next-run");
  await assert.rejects(
    () => executors.switch_persona({ name: "developer", expected_digest: target.digest }, {}, invocation("session-b", "subagent")),
    /Only the owning Session agent/u,
  );
  assert.equal(RUNTIME_TOOL_POLICIES.switch_persona.approval, "user");
});
