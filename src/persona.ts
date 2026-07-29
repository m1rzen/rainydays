// ===========================================
// Persona 管理器 —— 加载、切换工作模式
// 每个 persona = system prompt + 工具集 + 环境变量
// ===========================================

import matter from "gray-matter";
import type { PersonaDefinition, PersonaNetworkPolicy } from "./types.js";
import { canonicalDigest } from "./capability-broker.js";
import { getManagedPathStore, validateManagedIdentifier, type ManagedStoreRole } from "./managed-path-store.js";
import { PathDeniedError } from "./path-policy.js";

const PERSONA_ROLES: readonly ManagedStoreRole[] = Object.freeze(["builtin-personas", "user-personas"]);
const SKILL_ROLES: readonly ManagedStoreRole[] = Object.freeze(["user-skills", "builtin-skills"]);
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

function securityDigest(input: Omit<PersonaDefinition, "digest" | "displayName" | "description">): string {
  return canonicalDigest({
    name: input.name,
    tools: input.tools,
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
    tools: Object.freeze([...input.tools]),
    env: Object.freeze(env),
    allowedRoots: Object.freeze(roots),
    networkPolicy: input.networkPolicy,
    systemPrompt: input.systemPrompt,
  };
  return Object.freeze({ ...base, digest: securityDigest(base) });
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

/** 从受管 markdown+frontmatter 载入 Persona，并绑定文件 stem 与声明名称。 */
async function loadPersonaFile(role: ManagedStoreRole, fileName: string): Promise<PersonaDefinition> {
  const safeFileName = validateManagedIdentifier(fileName);
  const store = await getManagedPathStore();
  const raw = (await store.readNamed(role, safeFileName, ".md")).toString("utf8");
  const { data, content } = matter(raw);

  const declaredName = data.name === undefined ? safeFileName : validateManagedIdentifier(data.name);
  if (declaredName !== safeFileName) throw new Error(`Persona 文件名与 name 不一致: ${safeFileName}`);
  const name = safeFileName;
  const skillsList: string[] = Array.isArray(data.skills) ? data.skills.map(validateManagedIdentifier) : [];

  // 加载 skill 文件内容
  const skillContents: string[] = [];
  for (const skillName of skillsList) {
    const skillContent = await loadSkill(skillName);
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
    tools: Array.isArray(data.tools) ? data.tools : [],
    env,
    allowedRoots: Object.values(env),
    networkPolicy: freezeNetworkPolicy(data.network_policy, data.network_origins),
    systemPrompt,
  });
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
