// ===========================================
// 配置管理 —— Provider profiles + 应用设置
// 兼容旧 config.json，并以 .env 作为首次启动回退
// ===========================================

import { createHash } from "node:crypto";
import path from "path";
import { getManagedPathStore } from "./managed-path-store.js";
import { pathPolicy } from "./path-runtime.js";
import type { PathAuditIdentity } from "./path-policy.js";
import { CONFIG_PATH, DEFAULT_WORKSPACE_DIR, USER_DATA_DIR } from "./runtime-paths.js";

export interface ProviderProfile {
  model: string;
  apiKey: string;
  baseURL: string;
  providerType?: string;
}

export interface AppSettings {
  defaultPersona: string;
  workspaceRoot: string;
  departmentDataRoot: string;
  outputDir: string;
}

export interface Config {
  defaultProfile: string;
  profiles: Record<string, ProviderProfile>;
  settings: AppSettings;
}

export interface PublicProviderProfile {
  name: string;
  model: string;
  baseURL: string;
  providerType: string;
  hasApiKey: boolean;
  apiKeyHint: string;
  isCurrent: boolean;
  isDefault: boolean;
}

let config: Config | null = null;
let currentProfileName: string | null = null;

function defaultSettings(): AppSettings {
  return {
    defaultPersona: process.env.DEFAULT_PERSONA || "general",
    workspaceRoot: process.env.WORKSPACE_ROOT || DEFAULT_WORKSPACE_DIR,
    departmentDataRoot: process.env.DEPARTMENT_DATA_ROOT || "Z:\\产品研发室",
    outputDir: process.env.OUTPUT_DIR || path.join(USER_DATA_DIR, "output"),
  };
}

function normalizeProfile(value: Partial<ProviderProfile> | undefined): ProviderProfile {
  return {
    model: typeof value?.model === "string" ? value.model : "deepseek-chat",
    apiKey: typeof value?.apiKey === "string" ? value.apiKey : "",
    baseURL: typeof value?.baseURL === "string" ? value.baseURL : "https://api.deepseek.com",
    providerType: typeof value?.providerType === "string" ? value.providerType : "openai-compatible",
  };
}

function normalizeConfig(value: Partial<Config>): Config {
  const rawProfiles = value.profiles && typeof value.profiles === "object" ? value.profiles : {};
  const profiles: Record<string, ProviderProfile> = {};
  for (const [name, profile] of Object.entries(rawProfiles)) {
    profiles[name] = normalizeProfile(profile);
  }

  if (Object.keys(profiles).length === 0) {
    const apiKey = process.env.DEEPSEEK_API_KEY || process.env.LLM_API_KEY || "";
    const baseURL = process.env.DEEPSEEK_BASE_URL || process.env.LLM_BASE_URL || "https://api.deepseek.com";
    const model = process.env.LLM_MODEL || "deepseek-chat";
    profiles.default = normalizeProfile({ model, apiKey, baseURL });
  }

  const requestedDefault = typeof value.defaultProfile === "string" ? value.defaultProfile : "";
  const defaultProfile = profiles[requestedDefault] ? requestedDefault : Object.keys(profiles)[0];
  const defaults = defaultSettings();
  const rawSettings = value.settings || ({} as AppSettings);

  return {
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
  };
}

/** 启动期通过私有 managed authority 加载配置；除文件不存在外一律 fail-closed。 */
export async function initializeConfig(): Promise<Config> {
  if (config) return config;
  const store = await getManagedPathStore();
  const bytes = await store.readConfig();
  if (bytes === null) config = normalizeConfig({});
  else {
    let parsed: Partial<Config>;
    try {
      parsed = JSON.parse(bytes.toString("utf8")) as Partial<Config>;
    } catch {
      throw new Error("config.json 不是合法 JSON");
    }
    config = normalizeConfig(parsed);
  }
  currentProfileName = config.defaultProfile;
  return config;
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
  return currentProfileName && cfg.profiles[currentProfileName]
    ? currentProfileName
    : cfg.defaultProfile;
}

export function getCurrentProfile(): ProviderProfile {
  const cfg = loadConfig();
  return cfg.profiles[getCurrentProfileName()];
}

function cloneConfig(source: Config): Config {
  return {
    defaultProfile: source.defaultProfile,
    profiles: Object.fromEntries(Object.entries(source.profiles).map(([name, profile]) => [name, { ...profile }])),
    settings: { ...source.settings },
  };
}

export function getConfigSnapshot(): Config {
  return cloneConfig(loadConfig());
}

export function getConfigRevisionDigest(): string {
  return createHash("sha256").update(JSON.stringify(getConfigSnapshot())).digest("hex");
}

export function getAppSettings(): AppSettings {
  return { ...loadConfig().settings };
}

/** 切换当前运行 profile，不改变下次启动使用的 defaultProfile。 */
export function switchProfile(name: string): boolean {
  const cfg = loadConfig();
  if (!cfg.profiles[name]) return false;
  currentProfileName = name;
  return true;
}

function maskApiKey(apiKey: string): string {
  if (!apiKey) return "";
  if (apiKey.length <= 8) return "••••••••";
  return `${apiKey.slice(0, 3)}••••${apiKey.slice(-4)}`;
}

/** 返回可安全发给前端的 profile 元数据，永不返回 API Key 明文。 */
export function listProfiles(): PublicProviderProfile[] {
  const cfg = loadConfig();
  const current = getCurrentProfileName();
  return Object.entries(cfg.profiles).map(([name, profile]) => ({
    name,
    model: profile.model,
    baseURL: profile.baseURL,
    providerType: profile.providerType || "openai-compatible",
    hasApiKey: Boolean(profile.apiKey),
    apiKeyHint: maskApiKey(profile.apiKey),
    isCurrent: name === current,
    isDefault: name === cfg.defaultProfile,
  }));
}

export function getPublicConfig(): {
  defaultProfile: string;
  currentProfile: string;
  profiles: PublicProviderProfile[];
  settings: AppSettings;
  configPath: string;
} {
  const cfg = loadConfig();
  return {
    defaultProfile: cfg.defaultProfile,
    currentProfile: getCurrentProfileName(),
    profiles: listProfiles(),
    settings: { ...cfg.settings },
    configPath: CONFIG_PATH,
  };
}

function validateProfileName(name: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) {
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
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("baseURL 只允许 http 或 https 协议");
  }
}

export async function upsertProfile(
  name: string,
  input: { model?: string; baseURL?: string; apiKey?: string; providerType?: string }
): Promise<void> {
  validateProfileName(name);
  const cfg = getConfigSnapshot();
  const existing = cfg.profiles[name];
  const model = input.model?.trim() || existing?.model;
  const baseURL = input.baseURL?.trim() || existing?.baseURL;

  if (!model) throw new Error("缺少 model");
  if (!baseURL) throw new Error("缺少 baseURL");
  validateBaseURL(baseURL);

  cfg.profiles[name] = {
    model,
    baseURL: baseURL.replace(/\/$/, ""),
    apiKey: typeof input.apiKey === "string" && input.apiKey.length > 0
      ? input.apiKey.trim()
      : existing?.apiKey || "",
    providerType: input.providerType?.trim() || existing?.providerType || "openai-compatible",
  };

  await saveConfig(cfg);
}

export async function deleteProfile(name: string): Promise<void> {
  const cfg = getConfigSnapshot();
  if (!cfg.profiles[name]) throw new Error(`Profile 不存在: ${name}`);
  if (Object.keys(cfg.profiles).length <= 1) throw new Error("至少保留一个 Profile");
  if (name === cfg.defaultProfile) throw new Error("不能删除默认 Profile，请先更改默认 Profile");
  if (name === getCurrentProfileName()) throw new Error("不能删除当前使用中的 Profile，请先切换");

  delete cfg.profiles[name];
  await saveConfig(cfg);
}

export function prepareAppSettingsUpdate(
  input: Partial<AppSettings> & { defaultProfile?: string },
  base: Config = getConfigSnapshot()
): Config {
  const candidate = cloneConfig(base);

  if (input.defaultProfile !== undefined) {
    if (!candidate.profiles[input.defaultProfile]) {
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
}

export async function commitConfigSnapshot(candidate: Config): Promise<void> {
  await saveConfig(candidate);
}

/** 通过PathPolicy同目录临时文件和原子rename持久化，成功后才发布内存状态。 */
export async function saveConfig(cfg: Config): Promise<void> {
  const normalized = normalizeConfig(cfg);
  const store = await getManagedPathStore();
  await store.writeConfig(Buffer.from(JSON.stringify(normalized, null, 2), "utf8"));
  config = normalized;

  if (!currentProfileName || !normalized.profiles[currentProfileName]) {
    currentProfileName = normalized.defaultProfile;
  }
}
