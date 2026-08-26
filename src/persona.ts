// ===========================================
// Persona 管理器 —— 加载、切换工作模式
// 每个 persona = system prompt + 工具集 + 环境变量
// ===========================================

import matter from "gray-matter";
import type { PersonaDefinition, PersonaNetworkPolicy, PersonaPermissionLevel } from "./types.js";
import { canonicalDigest } from "./capability-broker.js";
import { RUNTIME_TOOL_POLICIES, STATIC_TOOL_POLICIES } from "./tool-policies.js";
import { getManagedPathStore, validateManagedIdentifier, type ManagedStoreRole } from "./managed-path-store.js";
import { PathDeniedError } from "./path-policy.js";

const PERSONA_ROLES: readonly ManagedStoreRole[] = Object.freeze(["builtin-personas", "user-personas"]);
const SKILL_ROLES: readonly ManagedStoreRole[] = Object.freeze(["user-skills", "builtin-skills"]);
const PERMISSION_LEVELS: readonly PersonaPermissionLevel[] = Object.freeze(["minimal", "read_only", "coding", "guarded", "full"]);
export const PERSONA_MANAGEMENT_TOOLS = Object.freeze(["list_personas", "current_persona", "find_personas", "switch_persona"] as const);
const MINIMAL_TOOLS = new Set<string>([...PERSONA_MANAGEMENT_TOOLS, "get_current_time", "ask_user"]);

const RESERVED_ENV_KEYS = new Set([
  "_SESSION_ID",
  "_CAPABILITY_CONTEXT_ID",
  "_CAPABILITY_RUN_ID",
  "_CAPABILITY_PRINCIPAL",
  "_CAPABILITY_ALLOWED_ROOTS",
]);

function freezeNetworkPolicy(value: unknown, originsValue: unknown): PersonaNetworkPolicy {
  if (value === undefined || value === "deny") return Object.freeze({ mode: "deny" });
  if (value === "loopback" || value === "unrestricted") return Object.freeze({ mode: value });
  if (value === "allowlist") {
    if (!Array.isArray(originsValue) || originsValue.some((entry) => typeof entry !== "string" || !entry)) throw new Error("network_origins 必须是非空字符串数组");
    if (new Set(originsValue).size !== originsValue.length) throw new Error("network_origins 不能重复");
    return Object.freeze({ mode: "allowlist", origins: Object.freeze([...originsValue]) });
  }
  throw new Error("network_policy 必须是 deny、loopback、allowlist 或 unrestricted");
}

function permissionLevel(value: unknown): PersonaPermissionLevel {
  const level = value === undefined ? "guarded" : value;
  if (typeof level !== "string" || !PERMISSION_LEVELS.includes(level as PersonaPermissionLevel)) {
    throw new Error(`permission_level 必须是 ${PERMISSION_LEVELS.join("、")}`);
  }
  return level as PersonaPermissionLevel;
}

function toolList(value: unknown, field: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.some(tool => typeof tool !== "string" || !tool)) throw new Error(`${field} 必须是非空字符串数组`);
  if (new Set(value).size !== value.length) throw new Error(`${field} 不能重复`);
  return [...value];
}

function assertPermissionEnvelope(level: PersonaPermissionLevel, tools: readonly string[]): void {
  for (const tool of tools) {
    if (level === "minimal" && !MINIMAL_TOOLS.has(tool)) throw new Error(`minimal Persona 不允许工具: ${tool}`);
    const policy = STATIC_TOOL_POLICIES[tool] ?? RUNTIME_TOOL_POLICIES[tool];
    if (level === "read_only" && policy?.riskClasses.some(risk => risk === "write" || risk === "process")) {
      throw new Error(`read_only Persona 不允许写入或进程工具: ${tool}`);
    }
  }
}

export function personaPermissionLevel(persona: PersonaDefinition): PersonaPermissionLevel {
  return permissionLevel(persona.permissionLevel);
}

export function personaPermissionRank(level: PersonaPermissionLevel): number {
  return PERMISSION_LEVELS.indexOf(level);
}

function securityDigest(input: Omit<PersonaDefinition, "digest" | "displayName" | "description">): string {
  return canonicalDigest({
    name: input.name,
    permissionLevel: personaPermissionLevel(input as PersonaDefinition),
    tools: input.tools,
    allowTools: input.allowTools ?? [],
    denyTools: input.denyTools ?? [],
    env: input.env,
    allowedRoots: input.allowedRoots,
    networkPolicy: input.networkPolicy,
    systemPrompt: input.systemPrompt,
  });
}

export function createEffectivePersona(input: Omit<PersonaDefinition, "digest">): PersonaDefinition {
  if (!input.name || typeof input.name !== "string" || typeof input.systemPrompt !== "string") throw new Error("Persona 名称或 system prompt 无效");
  if (!Array.isArray(input.tools) || input.tools.some((tool) => typeof tool !== "string" || !tool)) throw new Error(`Persona ${input.name} 的 tools 无效`);
  if (new Set(input.tools).size !== input.tools.length) throw new Error(`Persona ${input.name} 的 tools 存在重复项`);
  const level = permissionLevel(input.permissionLevel);
  const allowTools = toolList(input.allowTools, `Persona ${input.name} allowTools`);
  const denyTools = toolList(input.denyTools, `Persona ${input.name} denyTools`);
  if (allowTools.some(tool => denyTools.includes(tool))) throw new Error(`Persona ${input.name} 的 allow/deny 工具重叠`);
  assertPermissionEnvelope(level, input.tools);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input.env)) {
    if (!key || typeof value !== "string" || RESERVED_ENV_KEYS.has(key)) throw new Error(`Persona ${input.name} 的 env 字段无效: ${key}`);
    env[key] = value;
  }
  if (!Array.isArray(input.allowedRoots) || input.allowedRoots.some((root) => typeof root !== "string" || !root)) throw new Error(`Persona ${input.name} 的 allowedRoots 无效`);
  const roots = [...new Set(input.allowedRoots)];
  const base = {
    name: input.name,
    displayName: input.displayName,
    description: input.description,
    permissionLevel: level,
    tools: Object.freeze([...input.tools]),
    allowTools: Object.freeze(allowTools),
    denyTools: Object.freeze(denyTools),
    env: Object.freeze(env),
    allowedRoots: Object.freeze(roots),
    networkPolicy: input.networkPolicy,
    systemPrompt: input.systemPrompt,
  };
  const digest = securityDigest(base);
  return Object.freeze({ ...base, sourceDigest: input.sourceDigest ?? digest, digest });
}

/** persona 文件缓存 */
const cache = new Map<string, PersonaDefinition>();

function isNotFound(error: unknown): boolean {
  return error instanceof PathDeniedError && error.code === "PATH_NOT_FOUND";
}

/** 加载 skill 文件内容。用户 skill 优先；仅“文件不存在”允许回退。 */
async function loadSkill(skillName: string): Promise<string | null> {
  const safeName = validateManagedIdentifier(skillName);
  const store = await getManagedPathStore();
  for (const role of SKILL_ROLES) {
    try {
      return (await store.readNamed(role, safeName, ".md")).toString("utf8").trim();
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  console.warn(`⚠️ Skill 文件不存在: ${safeName}.md`);
  return null;
}

export async function validatePersonaSource(
  fileName: string,
  bytes: Uint8Array,
  resolveSkill: (name: string) => Promise<string | null>
): Promise<PersonaDefinition> {
  const safeFileName = validateManagedIdentifier(fileName);
  if (!(bytes instanceof Uint8Array) || typeof resolveSkill !== "function") throw new TypeError("Persona source is invalid");
  const raw = Buffer.from(bytes).toString("utf8");
  const { data, content } = matter(raw);

  const declaredName = data.name === undefined ? safeFileName : validateManagedIdentifier(data.name);
  if (declaredName !== safeFileName) throw new Error(`Persona 文件名与 name 不一致: ${safeFileName}`);
  const name = safeFileName;
  const skillsList: string[] = Array.isArray(data.skills) ? data.skills.map(validateManagedIdentifier) : [];
  const level = permissionLevel(data.permission_level);
  const baseTools = toolList(data.tools, `Persona ${name} tools`);
  const allowTools = toolList(data.allow_tools, `Persona ${name} allow_tools`);
  const denyTools = toolList(data.deny_tools, `Persona ${name} deny_tools`);
  if (allowTools.some(tool => denyTools.includes(tool))) throw new Error(`Persona ${name} 的 allow_tools/deny_tools 重叠`);
  const protectedManagement = new Set<string>(PERSONA_MANAGEMENT_TOOLS);
  if (denyTools.some(tool => protectedManagement.has(tool))) throw new Error(`Persona ${name} 不能 deny Persona 管理工具`);
  const tools = [...new Set([...baseTools, ...allowTools, ...PERSONA_MANAGEMENT_TOOLS])].filter(tool => !denyTools.includes(tool));
  assertPermissionEnvelope(level, tools);

  // 加载 skill 文件内容
  const skillContents: string[] = [];
  for (const skillName of skillsList) {
    const skillContent = await resolveSkill(skillName);
    if (skillContent) {
      skillContents.push(`## Skill: ${skillName}\n\n${skillContent}`);
    }
  }

  // 拼接 system prompt：persona body + skills
  let systemPrompt = content.trim();
  if (skillContents.length > 0) {
    systemPrompt += "\n\n---\n\n" + skillContents.join("\n\n---\n\n");
  }

  const env = (data.env as Record<string, string>) || {};
  return createEffectivePersona({
    name,
    displayName: data.display_name || data.displayName || name,
    description: data.description || "",
    permissionLevel: level,
    tools,
    allowTools,
    denyTools,
    env,
    allowedRoots: Object.values(env),
    networkPolicy: freezeNetworkPolicy(data.network_policy, data.network_origins),
    systemPrompt,
  });
}

/** 从受管 markdown+frontmatter 载入 Persona，并绑定文件 stem 与声明名称。 */
async function loadPersonaFile(role: ManagedStoreRole, fileName: string): Promise<PersonaDefinition> {
  const safeFileName = validateManagedIdentifier(fileName);
  const store = await getManagedPathStore();
  return validatePersonaSource(safeFileName, await store.readNamed(role, safeFileName, ".md"), loadSkill);
}

/**
 * 列出所有可用 persona
 */
export async function listPersonas(): Promise<PersonaDefinition[]> {
  const byName = new Map<string, PersonaDefinition>();
  const store = await getManagedPathStore();

  // 内置先加载、用户后覆盖。用户同名文件即使无效也不得静默降级到内置版本。
  for (const role of PERSONA_ROLES) {
    const names = await store.listNames(role, ".md");
    for (const name of names) {
      if (role === "user-personas") byName.delete(name);
      try {
        const persona = await loadPersonaFile(role, name);
        byName.set(persona.name, persona);
      } catch (error) {
        console.error(`加载 persona 失败: ${role}/${name}.md:`, error);
      }
    }
  }

  const personas = [...byName.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, "zh-CN"));
  cache.clear();
  for (const persona of personas) cache.set(persona.name, persona);
  return personas;
}

/**
 * 清空缓存并重新加载 persona 列表。
 * save_persona 等运行时写入 persona 文件后调用，避免必须重启服务器。
 */
export async function reloadPersonas(): Promise<PersonaDefinition[]> {
  cache.clear();
  return listPersonas();
}

/**
 * 获取指定 persona
 */
export async function getPersona(name: string): Promise<PersonaDefinition | null> {
  const safeName = validateManagedIdentifier(name);
  if (cache.has(safeName)) return cache.get(safeName)!;

  for (const role of ["user-personas", "builtin-personas"] as const) {
    try {
      const persona = await loadPersonaFile(role, safeName);
      cache.set(safeName, persona);
      return persona;
    } catch (error) {
      if (!isNotFound(error)) throw error;
    }
  }
  return null;
}

/** 列出受管 skill 名称。 */
export async function listAvailableSkills(): Promise<string[]> {
  const store = await getManagedPathStore();
  const names = new Set<string>();
  for (const role of ["builtin-skills", "user-skills"] as const) {
    for (const name of await store.listNames(role, ".md")) names.add(name);
  }
  return [...names].sort();
}

/**
 * 加载单个 skill 内容
 */
export async function loadSkillContent(skillName: string): Promise<string | null> {
  return loadSkill(skillName);
}
