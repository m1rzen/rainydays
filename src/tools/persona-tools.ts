// ===========================================
// Persona runtime management tools
// ===========================================

import type { PersonaDefinition, ToolDefinition, ToolExecutor } from "../types.js";
import { personaPermissionLevel, personaPermissionRank } from "../persona.js";

export const listPersonasDef: ToolDefinition = {
  type: "function",
  function: {
    name: "list_personas",
    description: "List available Personas with their permission level and description.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

export const currentPersonaDef: ToolDefinition = {
  type: "function",
  function: {
    name: "current_persona",
    description: "Show the current Session's Persona, permission level, and effective tools.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
};

export const findPersonasDef: ToolDefinition = {
  type: "function",
  function: {
    name: "find_personas",
    description: "Find available Personas by name, display name, or description.",
    parameters: {
      type: "object",
      properties: { keyword: { type: "string", minLength: 1, maxLength: 100 } },
      required: ["keyword"],
      additionalProperties: false,
    },
  },
};

export const switchPersonaDef: ToolDefinition = {
  type: "function",
  function: {
    name: "switch_persona",
    description: "Switch only the current Session to another Persona. First use list_personas/find_personas and pass its exact digest. User approval is required before the digest-bound change is persisted.",
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", pattern: "^[a-z0-9][a-z0-9-]{0,63}$" },
        expected_digest: { type: "string", pattern: "^[a-f0-9]{64}$" },
      },
      required: ["name", "expected_digest"],
      additionalProperties: false,
    },
  },
};

function summary(persona: PersonaDefinition) {
  return Object.freeze({
    name: persona.name,
    displayName: persona.displayName,
    description: persona.description,
    permissionLevel: personaPermissionLevel(persona),
    digest: persona.digest,
  });
}

export function createPersonaManagementExecutors(options: Readonly<{
  list: () => readonly PersonaDefinition[] | Promise<readonly PersonaDefinition[]>;
  current: () => PersonaDefinition;
  switchCurrentSession: (sessionId: string, targetName: string, expectedDigest: string) => Promise<PersonaDefinition>;
}>): Readonly<Record<"list_personas" | "current_persona" | "find_personas" | "switch_persona", ToolExecutor>> {
  const list = async (): Promise<readonly PersonaDefinition[]> => Object.freeze([...(await options.list())]);
  return Object.freeze({
    list_personas: async () => JSON.stringify({ personas: (await list()).map(summary) }, null, 2),
    current_persona: async (_args, _env, invocation) => {
      if (!invocation) throw new Error("Persona invocation context is unavailable");
      const persona = options.current();
      return JSON.stringify({
        ...summary(persona),
        sessionId: invocation.capabilityContext.sessionId,
        tools: persona.tools,
        allowTools: persona.allowTools ?? [],
        denyTools: persona.denyTools ?? [],
        networkPolicy: persona.networkPolicy.mode,
      }, null, 2);
    },
    find_personas: async args => {
      const keyword = String(args.keyword ?? "").trim().toLocaleLowerCase();
      if (!keyword) throw new TypeError("keyword is required");
      const matches = (await list()).filter(persona =>
        persona.name.toLocaleLowerCase().includes(keyword)
        || persona.displayName.toLocaleLowerCase().includes(keyword)
        || persona.description.toLocaleLowerCase().includes(keyword)
      );
      return JSON.stringify({ keyword, personas: matches.map(summary) }, null, 2);
    },
    switch_persona: async (args, _env, invocation) => {
      if (!invocation || invocation.capabilityContext.principal !== "agent") throw new Error("Only the owning Session agent may switch Persona");
      const current = options.current();
      const targetName = String(args.name ?? "");
      const expectedDigest = String(args.expected_digest ?? "");
      const selected = (await list()).find(persona => persona.name === targetName);
      if (!selected) throw new Error(`Persona does not exist: ${targetName}`);
      if (selected.digest !== expectedDigest) throw new Error("Persona definition changed after selection; list Personas again before switching");
      const target = await options.switchCurrentSession(
        invocation.capabilityContext.sessionId,
        targetName,
        expectedDigest,
      );
      if (target.digest !== expectedDigest) throw new Error("Persona switch target differs from the approved definition");
      return JSON.stringify({
        switched: current.name !== target.name,
        sessionId: invocation.capabilityContext.sessionId,
        from: summary(current),
        to: summary(target),
        elevation: personaPermissionRank(personaPermissionLevel(target)) > personaPermissionRank(personaPermissionLevel(current)),
        effective: "next-run",
      }, null, 2);
    },
  });
}
