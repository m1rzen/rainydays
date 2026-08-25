// ===========================================
// 配置管理 —— Provider profiles + 应用设置
// 兼容旧 config.json，并以 .env 作为首次启动回退
// ===========================================

import { randomBytes } from "node:crypto";
import path from "path";
import { deleteCredentials, readCredential, reconcileCredentialRetirements, stageCredentialRetirements, storeCredential, validateCredentialReference } from "./credential-store.js";
import { getManagedPathStore } from "./managed-path-store.js";
import { pathPolicy } from "./path-runtime.js";
import type { PathAuditIdentity } from "./path-policy.js";
import { CONFIG_PATH, DEFAULT_WORKSPACE_DIR, USER_DATA_DIR } from "./runtime-paths.js";
import { cloneSettingsDomains, defaultSettingsDomains, parseSettingsDomains, publicSettingsDomains, settingsDomainManifest, type SettingsDomainId, type SettingsDomains } from "./settings-schema.js";

export interface ProviderProfile {
  model: string;
  apiKey: string;
  credentialRef?: string;
  baseURL: string;
  providerType?: string;
  codexTransport: "auto" | "websocket" | "http";
  proxy: string;
  stripImages: boolean;
  knowledgeMaxCount: number;
  personaProfileBindings: Record<string, string>;
}

export interface AppSettings {
  defaultPersona: string;
  workspaceRoot: string;
  departmentDataRoot: string;
  outputDir: string;
}

export interface Config {
  schemaVersion: 2;
  revision: string;
  defaultProfile: string;
  profiles: Record<string, ProviderProfile>;
  settings: AppSettings;
  domains: SettingsDomains;
}

export interface PublicProviderProfile {
  name: string;
  model: string;
  baseURL: string;
  providerType: string;
  codexTransport: "auto" | "websocket" | "http";
  proxy: string;
  stripImages: boolean;
  knowledgeMaxCount: number;
  personaProfileBindings: Record<string, string>;
  hasApiKey: boolean;
  isCurrent: boolean;
  isDefault: boolean;
}

let config: Config | null = null;
let currentProfileName: string | null = null;

async function failCredentialMutation(error: unknown, createdReferences: readonly string[], liveConfig: Config | null): Promise<never> {
  const cleanupFailures: unknown[] = [];
  try { await deleteCredentials(createdReferences); } catch (cleanupError) { cleanupFailures.push(cleanupError); }
  if (liveConfig) {
    try { await reconcileCredentialRetirements(configCredentialReferences(liveConfig)); }
    catch (cleanupError) { cleanupFailures.push(cleanupError); }
  }
  if (cleanupFailures.length > 0) throw new AggregateError([error, ...cleanupFailures], "Credential mutation failed and cleanup remains pending");
  throw error;
}

function defaultSettings(): AppSettings {
  return {
    defaultPersona: process.env.DEFAULT_PERSONA || "general",
    workspaceRoot: process.env.WORKSPACE_ROOT || DEFAULT_WORKSPACE_DIR,
    departmentDataRoot: process.env.DEPARTMENT_DATA_ROOT || "Z:\\产品研发室",
    outputDir: process.env.OUTPUT_DIR || path.join(USER_DATA_DIR, "output"),
  };
}

function normalizeProfile(value: Partial<ProviderProfile> | undefined): ProviderProfile {
  const profile: ProviderProfile = {
    model: typeof value?.model === "string" ? value.model : "deepseek-chat",
    apiKey: typeof value?.apiKey === "string" ? value.apiKey : "",
    baseURL: typeof value?.baseURL === "string" ? value.baseURL : "https://api.deepseek.com",
    providerType: typeof value?.providerType === "string" && ["openai-compatible", "openai-compatible-vision", "anthropic", "gemini", "codex"].includes(value.providerType) ? value.providerType : "openai-compatible",
    codexTransport: value?.codexTransport === "websocket" || value?.codexTransport === "http" ? value.codexTransport : "auto",
    proxy: typeof value?.proxy === "string" ? value.proxy : "",
    stripImages: value?.stripImages === true,
    knowledgeMaxCount: Number.isSafeInteger(value?.knowledgeMaxCount) ? Number(value?.knowledgeMaxCount) : 20,
    personaProfileBindings: value?.personaProfileBindings && typeof value.personaProfileBindings === "object" && !Array.isArray(value.personaProfileBindings) ? { ...value.personaProfileBindings } : {},
  };
  if (typeof value?.credentialRef === "string") profile.credentialRef = value.credentialRef;
  return profile;
}

function normalizeConfig(value: Partial<Config>): Config {
  const rawProfiles = value.profiles && typeof value.profiles === "object" ? value.profiles : {};
  const profiles: Record<string, ProviderProfile> = {};
  for (const [name, profile] of Object.entries(rawProfiles)) {
    validateProfileName(name);
    profiles[name] = normalizeProfile(profile);
  }

  if (Object.keys(profiles).length === 0) {
    const apiKey = process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || "";
    const baseURL = process.env.DEEPSEEK_BASE_URL || process.env.LLM_BASE_URL || "https://api.deepseek.com";
    const model = process.env.LLM_MODEL || "deepseek-chat";
    profiles.default = normalizeProfile({ model, apiKey, baseURL });
  }

  const requestedDefault = typeof value.defaultProfile === "string" ? value.defaultProfile : "";
  const defaultProfile = Object.hasOwn(profiles, requestedDefault) ? requestedDefault : Object.keys(profiles)[0];
  const defaults = defaultSettings();
  const rawSettings = value.settings || ({} as AppSettings);

  return {
    schemaVersion: 2,
    revision: typeof value.revision === "string" && /^[a-f0-9]{32}$/u.test(value.revision) ? value.revision : randomBytes(16).toString("hex"),
    defaultProfile,
    profiles,
    settings: {
      defaultPersona: typeof rawSettings.defaultPersona === "string" && rawSettings.defaultPersona
        ? rawSettings.defaultPersona
        : defaults.defaultPersona,
      workspaceRoot: typeof rawSettings.workspaceRoot === "string" && rawSettings.workspaceRoot
        ? rawSettings.workspaceRoot
        : defaults.workspaceRoot,
      departmentDataRoot: typeof rawSettings.departmentDataRoot === "string" && rawSettings.departmentDataRoot
        ? rawSettings.departmentDataRoot
        : defaults.departmentDataRoot,
      outputDir: typeof rawSettings.outputDir === "string" && rawSettings.outputDir
        ? rawSettings.outputDir
        : defaults.outputDir,
    },
    domains: value.domains === undefined ? defaultSettingsDomains() : parseSettingsDomains(value.domains),
  };
}

export function validatePersistedConfigBytes(bytes: Buffer, options: Readonly<{ allowLegacyPlaintext?: boolean }> = {}): readonly string[] {
  if (!Buffer.isBuffer(bytes) || bytes.length === 0 || bytes.length > 4 * 1024 * 1024) throw new Error("config.json 大小无效");
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("config.json 不是合法 JSON"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("config.json Schema 无效");
  const root = parsed as Record<string, unknown>;
  const legacy = root.schemaVersion === undefined && root.domains === undefined;
  const legacyV2 = root.schemaVersion === 2 && root.revision === undefined;
  const expectedRoot = legacy
    ? ["defaultProfile", "profiles", "settings"]
    : legacyV2
      ? ["schemaVersion", "defaultProfile", "profiles", "settings", "domains"]
      : ["schemaVersion", "revision", "defaultProfile", "profiles", "settings", "domains"];
  if (Object.keys(root).sort().join("\0") !== expectedRoot.sort().join("\0")
    || (!legacy && root.schemaVersion !== 2)
    || (!legacy && !legacyV2 && (typeof root.revision !== "string" || !/^[a-f0-9]{32}$/u.test(root.revision)))
    || typeof root.defaultProfile !== "string"
    || !root.profiles || typeof root.profiles !== "object" || Array.isArray(root.profiles)
    || !root.settings || typeof root.settings !== "object" || Array.isArray(root.settings)) {
    throw new Error("config.json Schema 无效");
  }
  const references: string[] = [];
  for (const [name, value] of Object.entries(root.profiles as Record<string, unknown>)) {
    validateProfileName(name);
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Provider profile Schema 无效");
    const profile = value as Record<string, unknown>;
    const legacyAllowed = new Set(["model", "credentialRef", "baseURL", "providerType", ...(options.allowLegacyPlaintext ? ["apiKey"] : [])]);
    const currentAllowed = new Set([...legacyAllowed, "codexTransport", "proxy", "stripImages", "knowledgeMaxCount", "personaProfileBindings"]);
    const allowed = legacy ? legacyAllowed : currentAllowed;
    const invalidLegacy = legacy && profile.providerType !== undefined && typeof profile.providerType !== "string";
    const invalidCurrent = !legacy && (typeof profile.providerType !== "string"
      || !["auto", "websocket", "http"].includes(String(profile.codexTransport))
      || typeof profile.proxy !== "string" || typeof profile.stripImages !== "boolean"
      || !Number.isSafeInteger(profile.knowledgeMaxCount) || Number(profile.knowledgeMaxCount) < 0 || Number(profile.knowledgeMaxCount) > 1000
      || !profile.personaProfileBindings || typeof profile.personaProfileBindings !== "object" || Array.isArray(profile.personaProfileBindings));
    if (Object.keys(profile).some(key => !allowed.has(key)) || typeof profile.model !== "string" || !profile.model
      || typeof profile.baseURL !== "string" || invalidLegacy || invalidCurrent
      || (profile.apiKey !== undefined && (!options.allowLegacyPlaintext || !legacy || typeof profile.apiKey !== "string" || Boolean(profile.credentialRef)))) {
      throw new Error("Provider profile Schema 无效");
    }
    validateBaseURL(profile.baseURL);
    if (!legacy) {
      validateProviderType(profile.providerType);
      assertProviderAdapterAvailable(profile.providerType);
      validateProxy(String(profile.proxy));
      validatePersonaProfileBindings(profile.personaProfileBindings);
    }
    if (profile.credentialRef !== undefined) references.push(validateCredentialReference(profile.credentialRef));
  }
  validateProfileName(root.defaultProfile);
  if (!Object.hasOwn(root.profiles as Record<string, unknown>, root.defaultProfile)) throw new Error("Default profile is missing");
  const settings = root.settings as Record<string, unknown>;
  const expectedSettings = ["defaultPersona", "workspaceRoot", "departmentDataRoot", "outputDir"];
  if (Object.keys(settings).sort().join("\0") !== [...expectedSettings].sort().join("\0")
    || expectedSettings.some(key => typeof settings[key] !== "string" || !(settings[key] as string))) {
    throw new Error("App settings Schema 无效");
  }
  if (!legacy) {
    const domains = parseSettingsDomains(root.domains);
    assertDomainProfileReferences(domains, root.profiles as Record<string, ProviderProfile>);
    if (domains.asr.credentialRef) references.push(validateCredentialReference(domains.asr.credentialRef));
    if (domains.relay.credentialRef) references.push(validateCredentialReference(domains.relay.credentialRef));
  }
  return Object.freeze([...new Set(references)].sort());
}

/** 启动期通过私有 managed authority 加载配置；除文件不存在外一律 fail-closed。 */
export async function initializeConfig(): Promise<Config> {
  if (config) return config;
  const store = await getManagedPathStore();
  const bytes = await store.readConfig();
  if (bytes !== null) validatePersistedConfigBytes(bytes, { allowLegacyPlaintext: true });
  let candidate: Config;
  if (bytes === null) candidate = normalizeConfig({});
  else {
    let parsed: Partial<Config>;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as Partial<Config>;
    } catch {
      throw new Error("config.json 不是合法 JSON");
    }
    const persistedProfiles = parsed.profiles && typeof parsed.profiles === "object" ? parsed.profiles : {};
    for (const profile of Object.values(persistedProfiles)) {
      if (profile?.apiKey && profile.credentialRef) throw new Error("Provider credential state is ambiguous");
    }
    candidate = normalizeConfig(parsed);
  }
  assertDomainProfileReferences(candidate.domains, candidate.profiles);
  for (const profile of Object.values(candidate.profiles)) {
    validateBaseURL(profile.baseURL);
    validateProviderType(profile.providerType);
    assertProviderAdapterAvailable(profile.providerType);
    validateProxy(profile.proxy);
    if (!Number.isSafeInteger(profile.knowledgeMaxCount) || profile.knowledgeMaxCount < 0 || profile.knowledgeMaxCount > 1000) throw new TypeError("knowledgeMaxCount 无效");
    validatePersonaProfileBindings(profile.personaProfileBindings);
  }
  const createdReferences: string[] = [];
  let migrated = false;
  try {
    for (const profile of Object.values(candidate.profiles)) {
      if (profile.apiKey) {
        profile.credentialRef = await storeCredential(profile.apiKey);
        createdReferences.push(profile.credentialRef);
        migrated = true;
      } else if (profile.credentialRef) {
        profile.apiKey = await readCredential(profile.credentialRef);
      }
    }
    for (const reference of [candidate.domains.asr.credentialRef, candidate.domains.relay.credentialRef]) {
      if (reference) await readCredential(validateCredentialReference(reference));
    }
    if (migrated) await persistConfig(candidate);
    await reconcileCredentialRetirements(configCredentialReferences(candidate));
  } catch (error) {
    return failCredentialMutation(error, createdReferences, null);
  }
  config = candidate;
  currentProfileName = candidate.defaultProfile;
  return candidate;
}

export function loadConfig(): Config {
  if (!config) throw new Error("配置尚未通过受管存储初始化");
  return config;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}

export function getCurrentProfileName(): string {
  const cfg = loadConfig();
  return currentProfileName && Object.hasOwn(cfg.profiles, currentProfileName)
    ? currentProfileName
    : cfg.defaultProfile;
}

export function getCurrentProfile(): ProviderProfile {
  const cfg = loadConfig();
  return cfg.profiles[getCurrentProfileName()];
}

function cloneConfig(source: Config): Config {
  return {
    schemaVersion: 2,
    revision: source.revision,
    defaultProfile: source.defaultProfile,
    profiles: Object.fromEntries(Object.entries(source.profiles).map(([name, profile]) => [name, { ...profile }])),
    settings: { ...source.settings },
    domains: cloneSettingsDomains(source.domains),
  };
}

async function persistConfig(value: Config): Promise<void> {
  const persisted = {
    schemaVersion: 2,
    revision: value.revision,
    defaultProfile: value.defaultProfile,
    profiles: Object.fromEntries(Object.entries(value.profiles).map(([name, profile]) => [name, {
      model: profile.model,
      credentialRef: profile.credentialRef,
      baseURL: profile.baseURL,
      providerType: profile.providerType,
      codexTransport: profile.codexTransport,
      proxy: profile.proxy,
      stripImages: profile.stripImages,
      knowledgeMaxCount: profile.knowledgeMaxCount,
      personaProfileBindings: profile.personaProfileBindings,
    }])),
    settings: value.settings,
    domains: value.domains,
  };
  await (await getManagedPathStore()).writeConfig(Buffer.from(JSON.stringify(persisted, null, 2), "utf8"));
}

export function getConfigSnapshot(): Config {
  return cloneConfig(loadConfig());
}

export function getConfigRevisionDigest(): string {
  return loadConfig().revision;
}

export function getAppSettings(): AppSettings {
  return { ...loadConfig().settings };
}

/** 切换当前运行 profile，不改变下次启动使用的 defaultProfile。 */
export function switchProfile(name: string): boolean {
  const cfg = loadConfig();
  if (!Object.hasOwn(cfg.profiles, name)) return false;
  currentProfileName = name;
  return true;
}

/** 返回可安全发给前端的 profile 元数据，永不返回 API Key 或 secret-derived hint。 */
export function listProfiles(): PublicProviderProfile[] {
  const cfg = loadConfig();
  const current = getCurrentProfileName();
  return Object.entries(cfg.profiles).map(([name, profile]) => ({
    name,
    model: profile.model,
    baseURL: profile.baseURL,
    providerType: profile.providerType || "openai-compatible",
    codexTransport: profile.codexTransport,
    proxy: profile.proxy,
    stripImages: profile.stripImages,
    knowledgeMaxCount: profile.knowledgeMaxCount,
    personaProfileBindings: { ...profile.personaProfileBindings },
    hasApiKey: Boolean(profile.apiKey),
    isCurrent: name === current,
    isDefault: name === cfg.defaultProfile,
  }));
}

export function getPublicConfig(): {
  schemaVersion: 2;
  revision: string;
  defaultProfile: string;
  currentProfile: string;
  profiles: PublicProviderProfile[];
  settings: AppSettings;
  domains: Record<string, unknown>;
  domainManifest: ReturnType<typeof settingsDomainManifest>;
  configPath: string;
} {
  const cfg = loadConfig();
  return {
    schemaVersion: 2,
    revision: getConfigRevisionDigest(),
    defaultProfile: cfg.defaultProfile,
    currentProfile: getCurrentProfileName(),
    profiles: listProfiles(),
    settings: { ...cfg.settings },
    domains: publicSettingsDomains(cfg.domains),
    domainManifest: settingsDomainManifest(),
    configPath: CONFIG_PATH,
  };
}

function validateProfileName(name: string): void {
  if (Object.hasOwn(Object.prototype, name) || name === "__proto__" || name === "prototype"
    || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new Error("Profile 名称只能包含字母、数字、下划线和连字符，最长 64 个字符");
  }
}

function validateBaseURL(baseURL: string): void {
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    throw new Error("baseURL 必须是有效的 URL");
  }
  if (url.username || url.password || url.hash) throw new Error("baseURL 不允许凭据或 fragment");
  if (url.protocol === "https:") return;
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol === "http:" && loopback && process.env.RAINYDAYS_ALLOW_LOOPBACK_HTTP_PROVIDER === "1") return;
  throw new Error("baseURL 默认只允许 HTTPS；loopback HTTP 需要显式开发模式");
}

function validateProviderType(value: unknown): asserts value is "openai-compatible" | "openai-compatible-vision" | "anthropic" | "gemini" | "codex" {
  if (typeof value !== "string" || !["openai-compatible", "openai-compatible-vision", "anthropic", "gemini", "codex"].includes(value)) throw new TypeError("Provider 类型无效");
}

function assertProviderAdapterAvailable(value: string): void {
  if (value !== "openai-compatible" && value !== "openai-compatible-vision") throw new TypeError(`Provider adapter 尚未启用: ${value}`);
}

function validateProxy(value: string): void {
  if (!value) return;
  let url: URL;
  try { url = new URL(value); } catch { throw new TypeError("proxy URL 无效"); }
  if (!["https:", "http:", "socks5:"].includes(url.protocol) || url.username || url.password || url.hash) throw new TypeError("proxy URL 无效");
}

function validatePersonaProfileBindings(value: unknown): asserts value is Record<string, string> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 64) throw new TypeError("personaProfileBindings 无效");
  for (const [persona, profile] of Object.entries(value as Record<string, unknown>)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(persona) || typeof profile !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/u.test(profile)) throw new TypeError("personaProfileBindings 无效");
  }
}

export async function upsertProfile(
  name: string,
  input: { model?: string; baseURL?: string; apiKey?: string; providerType?: string; codexTransport?: string; proxy?: string; stripImages?: boolean; knowledgeMaxCount?: number; personaProfileBindings?: Record<string, string> },
  deferCredentialCleanup = false
): Promise<void> {
  validateProfileName(name);
  const cfg = getConfigSnapshot();
  const existing = Object.hasOwn(cfg.profiles, name) ? cfg.profiles[name] : undefined;
  const model = input.model?.trim() || existing?.model;
  const baseURL = input.baseURL?.trim() || existing?.baseURL;

  if (!model) throw new Error("缺少 model");
  if (!baseURL) throw new Error("缺少 baseURL");
  validateBaseURL(baseURL);
  const providerType = input.providerType?.trim() || existing?.providerType || "openai-compatible";
  validateProviderType(providerType);
  assertProviderAdapterAvailable(providerType);
  const codexTransport = input.codexTransport ?? existing?.codexTransport ?? "auto";
  if (codexTransport !== "auto" && codexTransport !== "websocket" && codexTransport !== "http") throw new TypeError("codexTransport 无效");
  const proxy = input.proxy?.trim() ?? existing?.proxy ?? "";
  validateProxy(proxy);
  const knowledgeMaxCount = input.knowledgeMaxCount ?? existing?.knowledgeMaxCount ?? 20;
  if (!Number.isSafeInteger(knowledgeMaxCount) || knowledgeMaxCount < 0 || knowledgeMaxCount > 1000) throw new TypeError("knowledgeMaxCount 无效");
  const personaProfileBindings = input.personaProfileBindings ?? existing?.personaProfileBindings ?? {};
  validatePersonaProfileBindings(personaProfileBindings);

  cfg.profiles[name] = {
    model,
    baseURL: baseURL.replace(/\/$/, ""),
    apiKey: typeof input.apiKey === "string" && input.apiKey.length > 0
      ? input.apiKey.trim()
      : existing?.apiKey || "",
    credentialRef: existing?.credentialRef,
    providerType,
    codexTransport,
    proxy,
    stripImages: input.stripImages ?? existing?.stripImages ?? false,
    knowledgeMaxCount,
    personaProfileBindings: { ...personaProfileBindings },
  };

  assertDomainProfileReferences(cfg.domains, cfg.profiles);
  await saveConfig(cfg);
  if (!deferCredentialCleanup) await finalizeCredentialChanges();
}

export async function deleteProfile(name: string, deferCredentialCleanup = false): Promise<void> {
  const cfg = getConfigSnapshot();
  if (!Object.hasOwn(cfg.profiles, name)) throw new Error(`Profile 不存在: ${name}`);
  if (Object.keys(cfg.profiles).length <= 1) throw new Error("至少保留一个 Profile");
  if (name === cfg.defaultProfile) throw new Error("不能删除默认 Profile，请先更改默认 Profile");
  if (name === getCurrentProfileName()) throw new Error("不能删除当前使用中的 Profile，请先切换");

  delete cfg.profiles[name];
  await saveConfig(cfg);
  if (!deferCredentialCleanup) await finalizeCredentialChanges();
}

export function prepareAppSettingsUpdate(
  input: Partial<AppSettings> & { defaultProfile?: string },
  base: Config = getConfigSnapshot()
): Config {
  const candidate = cloneConfig(normalizeConfig(base));

  if (input.defaultProfile !== undefined) {
    if (!Object.hasOwn(candidate.profiles, input.defaultProfile)) {
      throw new Error(`默认 Profile 不存在: ${input.defaultProfile}`);
    }
    candidate.defaultProfile = input.defaultProfile;
  }

  for (const key of ["defaultPersona", "workspaceRoot", "departmentDataRoot", "outputDir"] as const) {
    if (input[key] !== undefined) {
      const value = input[key]?.trim();
      if (!value) throw new Error(`${key} 不能为空`);
      candidate.settings[key] = value;
    }
  }

  return normalizeConfig(candidate);
}

export async function validateAppSettingsPaths(settings: AppSettings, auditIdentity?: PathAuditIdentity): Promise<void> {
  await pathPolicy.validateConfigurationRoots([
    { rootId: "workspace", configuredPath: settings.workspaceRoot },
    { rootId: "department", configuredPath: settings.departmentDataRoot },
    { rootId: "output", configuredPath: settings.outputDir },
  ], auditIdentity);
}

export async function updateAppSettings(input: Partial<AppSettings> & { defaultProfile?: string }): Promise<void> {
  const candidate = prepareAppSettingsUpdate(input);
  await validateAppSettingsPaths(candidate.settings);
  await saveConfig(candidate);
  await finalizeCredentialChanges();
}

function assertDomainId(value: string): asserts value is Exclude<SettingsDomainId, "profiles"> {
  if (!["common", "mcp", "wire", "animas", "nous", "tts", "asr", "shell", "relay", "update"].includes(value)) {
    throw new TypeError(`Settings domain 不存在: ${value}`);
  }
}

function assertDomainProfileReferences(domains: SettingsDomains, profiles: Record<string, ProviderProfile>): void {
  const references = [
    domains.common.supervisorProfile, domains.common.curatorProfile, domains.common.consolidationProfile,
    domains.common.oracleProfile, domains.common.imageProfile, domains.common.videoProfile,
    domains.common.renameProfile, domains.nous.profile,
  ].filter(Boolean);
  for (const reference of references) if (!Object.hasOwn(profiles, reference)) throw new TypeError(`Settings 引用了不存在的 Profile: ${reference}`);
  for (const profile of Object.values(profiles)) {
    for (const reference of Object.values(profile.personaProfileBindings)) if (!Object.hasOwn(profiles, reference)) throw new TypeError(`personaProfileBindings 引用了不存在的 Profile: ${reference}`);
  }
}

export function prepareSettingsDomainUpdate(domainId: string, input: unknown, base: Config = getConfigSnapshot()): Config {
  assertDomainId(domainId);
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError("Settings domain 请求无效");
  const candidate = normalizeConfig(base);
  const domains = cloneSettingsDomains(candidate.domains);
  const value = { ...(input as Record<string, unknown>) };
  if (domainId === "asr") {
    delete value.apiKey;
    delete value.clearCredential;
    if (candidate.domains.asr.credentialRef) value.credentialRef = candidate.domains.asr.credentialRef;
  } else if (domainId === "relay") {
    delete value.accessToken;
    delete value.clearCredential;
    if (candidate.domains.relay.credentialRef) value.credentialRef = candidate.domains.relay.credentialRef;
  }
  (domains as unknown as Record<string, unknown>)[domainId] = value;
  candidate.domains = parseSettingsDomains(domains);
  assertDomainProfileReferences(candidate.domains, candidate.profiles);
  return candidate;
}

export async function updateSettingsDomain(domainId: string, input: unknown): Promise<void> {
  assertDomainId(domainId);
  const request = input && typeof input === "object" && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const candidate = prepareSettingsDomainUpdate(domainId, request);
  const current = loadConfig();
  const secretField = domainId === "asr" ? "apiKey" : domainId === "relay" ? "accessToken" : null;
  const oldReference = domainId === "asr" ? current.domains.asr.credentialRef : domainId === "relay" ? current.domains.relay.credentialRef : undefined;
  const clearCredential = request.clearCredential === true;
  if (secretField && request[secretField] !== undefined && typeof request[secretField] !== "string") throw new TypeError(`${secretField} 无效`);
  const suppliedSecret = secretField && typeof request[secretField] === "string" ? (request[secretField] as string).trim() : "";
  let createdReference: string | undefined;
  if (secretField && request.clearCredential !== undefined && typeof request.clearCredential !== "boolean") throw new TypeError("clearCredential 无效");
  if (suppliedSecret && clearCredential) throw new TypeError("不能同时设置和清除 credential");
  try {
    if (suppliedSecret) createdReference = await storeCredential(suppliedSecret);
    const nextReference = clearCredential ? undefined : createdReference ?? oldReference;
    if (domainId === "asr") candidate.domains.asr.credentialRef = nextReference;
    if (domainId === "relay") candidate.domains.relay.credentialRef = nextReference;
    if (oldReference && oldReference !== createdReference && (clearCredential || createdReference)) {
      await stageCredentialRetirements([oldReference]);
    }
    await saveConfig(candidate);
  } catch (error) {
    return failCredentialMutation(error, createdReference ? [createdReference] : [], current);
  }
  await finalizeCredentialChanges();
}

export interface SettingsExportBundle {
  schemaVersion: 1;
  kind: "rainydays-settings";
  defaultProfile: string;
  profiles: Record<string, Pick<ProviderProfile, "model" | "baseURL" | "providerType" | "codexTransport" | "proxy" | "stripImages" | "knowledgeMaxCount" | "personaProfileBindings">>;
  settings: AppSettings;
  domains: SettingsDomains;
}

export function exportSettings(): SettingsExportBundle {
  const snapshot = getConfigSnapshot();
  const domains = cloneSettingsDomains(snapshot.domains);
  delete domains.asr.credentialRef;
  delete domains.relay.credentialRef;
  return {
    schemaVersion: 1,
    kind: "rainydays-settings",
    defaultProfile: snapshot.defaultProfile,
    profiles: Object.fromEntries(Object.entries(snapshot.profiles).map(([name, profile]) => [name, {
      model: profile.model, baseURL: profile.baseURL, providerType: profile.providerType || "openai-compatible", codexTransport: profile.codexTransport,
      proxy: profile.proxy, stripImages: profile.stripImages, knowledgeMaxCount: profile.knowledgeMaxCount, personaProfileBindings: { ...profile.personaProfileBindings },
    }])),
    settings: { ...snapshot.settings },
    domains,
  };
}

export function prepareSettingsImport(value: unknown, base: Config = getConfigSnapshot()): Config {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("Settings import 无效");
  const bundle = value as Record<string, unknown>;
  if (Object.keys(bundle).sort().join("\0") !== ["schemaVersion", "kind", "defaultProfile", "profiles", "settings", "domains"].sort().join("\0")
    || bundle.schemaVersion !== 1 || bundle.kind !== "rainydays-settings"
    || typeof bundle.defaultProfile !== "string" || !bundle.profiles || typeof bundle.profiles !== "object" || Array.isArray(bundle.profiles)
    || !bundle.settings || typeof bundle.settings !== "object" || Array.isArray(bundle.settings)) {
    throw new TypeError("Settings import Schema 无效");
  }
  const current = normalizeConfig(base);
  const profiles: Record<string, ProviderProfile> = {};
  for (const [name, raw] of Object.entries(bundle.profiles as Record<string, unknown>)) {
    validateProfileName(name);
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("Imported Provider 无效");
    const profile = raw as Record<string, unknown>;
    if (Object.keys(profile).sort().join("\0") !== ["model", "baseURL", "providerType", "codexTransport", "proxy", "stripImages", "knowledgeMaxCount", "personaProfileBindings"].sort().join("\0")
      || typeof profile.model !== "string" || !profile.model || typeof profile.baseURL !== "string" || typeof profile.providerType !== "string"
      || !["auto", "websocket", "http"].includes(String(profile.codexTransport)) || typeof profile.proxy !== "string" || typeof profile.stripImages !== "boolean"
      || !Number.isSafeInteger(profile.knowledgeMaxCount) || !profile.personaProfileBindings || typeof profile.personaProfileBindings !== "object" || Array.isArray(profile.personaProfileBindings)) {
      throw new TypeError("Imported Provider 无效");
    }
    validateBaseURL(profile.baseURL);
    validateProviderType(profile.providerType);
    assertProviderAdapterAvailable(profile.providerType);
    validateProxy(profile.proxy);
    validatePersonaProfileBindings(profile.personaProfileBindings);
    profiles[name] = {
      model: profile.model, baseURL: profile.baseURL.replace(/\/$/u, ""), providerType: profile.providerType,
      codexTransport: profile.codexTransport as "auto" | "websocket" | "http", proxy: profile.proxy, stripImages: profile.stripImages,
      knowledgeMaxCount: Number(profile.knowledgeMaxCount), personaProfileBindings: { ...(profile.personaProfileBindings as Record<string, string>) },
      apiKey: Object.hasOwn(current.profiles, name) ? current.profiles[name].apiKey : "", credentialRef: Object.hasOwn(current.profiles, name) ? current.profiles[name].credentialRef : undefined,
    };
  }
  validateProfileName(bundle.defaultProfile);
  if (!Object.hasOwn(profiles, bundle.defaultProfile)) throw new TypeError("Imported default Profile 不存在");
  const settings = bundle.settings as Record<string, unknown>;
  const expectedSettings = ["defaultPersona", "workspaceRoot", "departmentDataRoot", "outputDir"];
  if (Object.keys(settings).sort().join("\0") !== expectedSettings.sort().join("\0")
    || expectedSettings.some(key => typeof settings[key] !== "string" || !(settings[key] as string))) throw new TypeError("Imported app settings 无效");
  const rawDomains = JSON.parse(JSON.stringify(bundle.domains)) as SettingsDomains;
  rawDomains.asr.credentialRef = current.domains.asr.credentialRef;
  rawDomains.relay.credentialRef = current.domains.relay.credentialRef;
  const candidate: Config = {
    schemaVersion: 2,
    revision: current.revision,
    defaultProfile: bundle.defaultProfile,
    profiles,
    settings: settings as unknown as AppSettings,
    domains: parseSettingsDomains(rawDomains),
  };
  assertDomainProfileReferences(candidate.domains, candidate.profiles);
  return candidate;
}

function configCredentialReferences(value: Config): string[] {
  const references = [
    ...Object.values(value.profiles).map(profile => profile.credentialRef),
    value.domains.asr.credentialRef,
    value.domains.relay.credentialRef,
  ].filter((reference): reference is string => typeof reference === "string");
  return [...new Set(references.map(validateCredentialReference))].sort();
}

export async function finalizeCredentialChanges(): Promise<void> {
  await reconcileCredentialRetirements(configCredentialReferences(loadConfig()));
}

export async function commitConfigSnapshot(candidate: Config, deferCredentialCleanup = false): Promise<void> {
  await saveConfig(candidate);
  if (!deferCredentialCleanup) await finalizeCredentialChanges();
}

/** 通过PathPolicy同目录临时文件和原子rename持久化，成功后才发布内存状态。 */
export async function saveConfig(cfg: Config): Promise<void> {
  const normalized = normalizeConfig(cfg);
  normalized.revision = randomBytes(16).toString("hex");
  assertDomainProfileReferences(normalized.domains, normalized.profiles);
  const previous = config;
  const createdReferences: string[] = [];
  const retiredReferences: string[] = [];
  try {
    for (const [name, profile] of Object.entries(normalized.profiles)) {
      const oldProfile = previous && Object.hasOwn(previous.profiles, name) ? previous.profiles[name] : undefined;
      if (profile.apiKey && (!profile.credentialRef
        || (profile.credentialRef === oldProfile?.credentialRef && profile.apiKey !== oldProfile?.apiKey))) {
        const oldReference = profile.credentialRef;
        profile.credentialRef = await storeCredential(profile.apiKey);
        createdReferences.push(profile.credentialRef);
        if (oldReference) retiredReferences.push(oldReference);
      }
    }
    if (previous) {
      for (const [name, profile] of Object.entries(previous.profiles)) {
        if (!Object.hasOwn(normalized.profiles, name) && profile.credentialRef) retiredReferences.push(profile.credentialRef);
      }
    }
    await stageCredentialRetirements(retiredReferences);
    await persistConfig(normalized);
  } catch (error) {
    return failCredentialMutation(error, createdReferences, previous);
  }
  config = normalized;

  if (!currentProfileName || !Object.hasOwn(normalized.profiles, currentProfileName)) {
    currentProfileName = normalized.defaultProfile;
  }
}
