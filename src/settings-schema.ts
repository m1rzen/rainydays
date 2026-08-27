export type SettingsApplyMode = "immediate" | "restart-required" | "unavailable";
export type SettingsDomainId = "common" | "profiles" | "mcp" | "wire" | "animas" | "nous" | "tts" | "asr" | "shell" | "relay" | "update";

export interface McpServerSetting {
  name: string;
  enabled: boolean;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  url: string;
}

export interface WireSourceSetting {
  name: string;
  enabled: boolean;
  url: string;
  eventPattern: string;
}

export interface SettingsDomains {
  common: {
    maxIterations: number;
    maxCanvasTokens: number;
    defaultSupervisorRules: string;
    worker: { enabled: boolean; target: "local" | "remote" };
    orgMode: boolean;
    yoloMode: boolean;
    supervisorEnabled: boolean;
    supervisorProfile: string;
    curatorProfile: string;
    consolidationProfile: string;
    oracleProfile: string;
    imageProfile: string;
    videoProfile: string;
    autoRename: boolean;
    renameProfile: string;
    pinRenderMode: "system" | "user-tail";
    pinRenderInterval: number;
  };
  mcp: { servers: McpServerSetting[] };
  wire: { sources: WireSourceSetting[] };
  animas: { defaultAnima: string };
  nous: { enabled: boolean; autoTriggerThreshold: number; cooldownMinutes: number; profile: string };
  tts: { enabled: boolean; voice: string; language: string; rate: number };
  asr: { provider: "browser" | "volcengine"; language: string; endpoint: string; credentialRef?: string };
  shell: { defaultShell: "auto" | "powershell" | "cmd"; initializationScript: string };
  relay: { enabled: boolean; url: string; credentialRef?: string };
  update: { channel: "stable" | "beta"; autoCheck: boolean; autoDownload: boolean };
}

export interface SettingsDomainManifest {
  id: SettingsDomainId;
  label: string;
  description: string;
  applyMode: SettingsApplyMode;
  available: boolean;
  fields: readonly Readonly<{ key: string; sensitive: boolean; applyMode: SettingsApplyMode }>[];
}

const DOMAIN_MANIFEST: readonly SettingsDomainManifest[] = Object.freeze([
  domain("common", "Common", "基础配置、运行限制和默认行为", "restart-required", false, ["maxIterations", "maxCanvasTokens", "defaultSupervisorRules", "worker", "orgMode", "yoloMode", "supervisorEnabled", "supervisorProfile", "curatorProfile", "consolidationProfile", "oracleProfile", "imageProfile", "videoProfile", "autoRename", "renameProfile", "pinRenderMode", "pinRenderInterval"], [], { yoloMode: "unavailable" }),
  domain("profiles", "Profiles", "Provider 配置集和运行时切换", "immediate", true, ["model", "apiKey", "baseURL", "providerType", "codexTransport", "proxy", "stripImages", "knowledgeMaxCount", "personaProfileBindings"], ["apiKey"]),
  domain("mcp", "MCP", "MCP Server 启用和连接配置", "restart-required", false, ["servers"]),
  domain("wire", "Wire", "Wire 外部事件源配置", "restart-required", false, ["sources"]),
  domain("animas", "Animas", "Anima 默认身份配置", "restart-required", false, ["defaultAnima"]),
  domain("nous", "Nous", "Muse/Nous 自动触发、冷却和独立 Profile", "restart-required", false, ["enabled", "autoTriggerThreshold", "cooldownMinutes", "profile"]),
  domain("tts", "TTS", "浏览器文字转语音设置", "immediate", true, ["enabled", "voice", "language", "rate"]),
  domain("asr", "ASR", "浏览器语音识别；远程 Provider 尚未接入", "immediate", true, ["provider", "language", "endpoint", "apiKey"], ["apiKey"], { provider: "unavailable", endpoint: "unavailable", apiKey: "unavailable" }),
  domain("shell", "Shell", "默认 Shell 和初始化脚本", "restart-required", false, ["defaultShell", "initializationScript"]),
  domain("relay", "Relay", "WebSocket 中继远程访问", "restart-required", false, ["enabled", "url", "accessToken"], ["accessToken"]),
  domain("update", "Update", "更新通道和自动检查策略", "restart-required", false, ["channel", "autoCheck", "autoDownload"]),
]);

function domain(id: SettingsDomainId, label: string, description: string, applyMode: SettingsApplyMode, available: boolean, keys: string[], sensitive: string[] = [], fieldModes: Readonly<Record<string, SettingsApplyMode>> = {}): SettingsDomainManifest {
  return Object.freeze({
    id, label, description, applyMode, available,
    fields: Object.freeze(keys.map(key => Object.freeze({ key, sensitive: sensitive.includes(key), applyMode: fieldModes[key] ?? applyMode }))),
  });
}

export function settingsDomainManifest(): readonly SettingsDomainManifest[] {
  return DOMAIN_MANIFEST;
}

export function defaultSettingsDomains(): SettingsDomains {
  return {
    common: {
      maxIterations: 200, maxCanvasTokens: 100_000, defaultSupervisorRules: "", worker: { enabled: false, target: "local" }, orgMode: false, yoloMode: false,
      supervisorEnabled: false, supervisorProfile: "", curatorProfile: "", consolidationProfile: "",
      oracleProfile: "", imageProfile: "", videoProfile: "", autoRename: true, renameProfile: "",
      pinRenderMode: "system", pinRenderInterval: 0,
    },
    mcp: { servers: [] },
    wire: { sources: [] },
    animas: { defaultAnima: "" },
    nous: { enabled: false, autoTriggerThreshold: 80, cooldownMinutes: 30, profile: "" },
    tts: { enabled: false, voice: "", language: "zh-CN", rate: 1 },
    asr: { provider: "browser", language: "zh-CN", endpoint: "" },
    shell: { defaultShell: "auto", initializationScript: "" },
    relay: { enabled: false, url: "" },
    update: { channel: "stable", autoCheck: true, autoDownload: false },
  };
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${label} Schema 无效`);
  return value as Record<string, unknown>;
}
function exact(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) throw new TypeError(`${label} 字段无效`);
}
function text(value: unknown, label: string, maximum: number, allowEmpty = true): string {
  if (typeof value !== "string" || value.length > maximum || (!allowEmpty && value.length === 0) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw new TypeError(`${label} 无效`);
  return value;
}
function integer(value: unknown, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum || Number(value) > maximum) throw new TypeError(`${label} 无效`);
  return Number(value);
}
function numberValue(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < minimum || value > maximum) throw new TypeError(`${label} 无效`);
  return value;
}
function bool(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new TypeError(`${label} 无效`);
  return value;
}
function choice<T extends string>(value: unknown, label: string, choices: readonly T[]): T {
  if (typeof value !== "string" || !choices.includes(value as T)) throw new TypeError(`${label} 无效`);
  return value as T;
}
function secureUrl(value: unknown, label: string, protocols: readonly string[], allowEmpty = true): string {
  const raw = text(value, label, 2048, !allowEmpty ? false : true);
  if (!raw && allowEmpty) return "";
  let url: URL;
  try { url = new URL(raw); } catch { throw new TypeError(`${label} URL 无效`); }
  if (!protocols.includes(url.protocol) || url.username || url.password || url.hash) throw new TypeError(`${label} URL 无效`);
  return url.toString().replace(/\/$/u, "");
}
function profile(value: unknown, label: string): string { return text(value, label, 64); }
function optionalReference(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return text(value, label, 160, false);
}

function parseMcpServers(value: unknown): McpServerSetting[] {
  if (!Array.isArray(value) || value.length > 32) throw new TypeError("MCP servers 无效");
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const item = record(entry, `MCP server ${index}`);
    exact(item, ["name", "enabled", "transport", "command", "args", "url"], `MCP server ${index}`);
    const name = text(item.name, "MCP name", 64, false);
    if (seen.has(name)) throw new TypeError("MCP name 重复");
    seen.add(name);
    const transport = choice(item.transport, "MCP transport", ["stdio", "http"] as const);
    if (!Array.isArray(item.args) || item.args.length > 64) throw new TypeError("MCP args 无效");
    const args = item.args.map((arg, argumentIndex) => text(arg, `MCP arg ${argumentIndex}`, 1024));
    const command = text(item.command, "MCP command", 2048);
    const url = item.url === "" ? "" : secureUrl(item.url, "MCP URL", ["https:"]);
    if (transport === "stdio" && !command) throw new TypeError("stdio MCP 缺少 command");
    if (transport === "http" && !url) throw new TypeError("http MCP 缺少 URL");
    return { name, enabled: bool(item.enabled, "MCP enabled"), transport, command, args, url };
  });
}

function parseWireSources(value: unknown): WireSourceSetting[] {
  if (!Array.isArray(value) || value.length > 32) throw new TypeError("Wire sources 无效");
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const item = record(entry, `Wire source ${index}`);
    exact(item, ["name", "enabled", "url", "eventPattern"], `Wire source ${index}`);
    const name = text(item.name, "Wire name", 64, false);
    if (seen.has(name)) throw new TypeError("Wire name 重复");
    seen.add(name);
    return {
      name, enabled: bool(item.enabled, "Wire enabled"),
      url: secureUrl(item.url, "Wire URL", ["wss:", "https:"], false),
      eventPattern: text(item.eventPattern, "Wire event pattern", 128, false),
    };
  });
}

export function parseSettingsDomains(value: unknown): SettingsDomains {
  const root = record(value, "Settings domains");
  const keys = ["common", "mcp", "wire", "animas", "nous", "tts", "asr", "shell", "relay", "update"] as const;
  exact(root, keys, "Settings domains");
  const common = record(root.common, "Common settings");
  exact(common, ["maxIterations", "maxCanvasTokens", "defaultSupervisorRules", "worker", "orgMode", "yoloMode", "supervisorEnabled", "supervisorProfile", "curatorProfile", "consolidationProfile", "oracleProfile", "imageProfile", "videoProfile", "autoRename", "renameProfile", "pinRenderMode", "pinRenderInterval"], "Common settings");
  const worker = record(common.worker, "Worker settings"); exact(worker, ["enabled", "target"], "Worker settings");
  if (common.yoloMode !== false) throw new TypeError("yoloMode 在 Mini-Lux 中不可用，不能绕过 SEC-02 PathGuard");
  const mcp = record(root.mcp, "MCP settings"); exact(mcp, ["servers"], "MCP settings");
  const wire = record(root.wire, "Wire settings"); exact(wire, ["sources"], "Wire settings");
  const animas = record(root.animas, "Anima settings"); exact(animas, ["defaultAnima"], "Anima settings");
  const nous = record(root.nous, "Nous settings"); exact(nous, ["enabled", "autoTriggerThreshold", "cooldownMinutes", "profile"], "Nous settings");
  const tts = record(root.tts, "TTS settings"); exact(tts, ["enabled", "voice", "language", "rate"], "TTS settings");
  const asr = record(root.asr, "ASR settings"); exact(asr, ["provider", "language", "endpoint", ...(Object.hasOwn(asr, "credentialRef") ? ["credentialRef"] : [])], "ASR settings");
  const shell = record(root.shell, "Shell settings"); exact(shell, ["defaultShell", "initializationScript"], "Shell settings");
  const relay = record(root.relay, "Relay settings"); exact(relay, ["enabled", "url", ...(Object.hasOwn(relay, "credentialRef") ? ["credentialRef"] : [])], "Relay settings");
  const update = record(root.update, "Update settings"); exact(update, ["channel", "autoCheck", "autoDownload"], "Update settings");
  const asrReference = optionalReference(asr.credentialRef, "ASR credential");
  const relayReference = optionalReference(relay.credentialRef, "Relay credential");
  return {
    common: {
      maxIterations: integer(common.maxIterations, "maxIterations", 1, 1000), maxCanvasTokens: integer(common.maxCanvasTokens, "maxCanvasTokens", 4096, 1_000_000),
      defaultSupervisorRules: text(common.defaultSupervisorRules, "defaultSupervisorRules", 8192), worker: { enabled: bool(worker.enabled, "Worker enabled"), target: choice(worker.target, "Worker target", ["local", "remote"] as const) },
      orgMode: bool(common.orgMode, "orgMode"), yoloMode: bool(common.yoloMode, "yoloMode"),
      supervisorEnabled: bool(common.supervisorEnabled, "supervisorEnabled"), supervisorProfile: profile(common.supervisorProfile, "supervisorProfile"),
      curatorProfile: profile(common.curatorProfile, "curatorProfile"), consolidationProfile: profile(common.consolidationProfile, "consolidationProfile"),
      oracleProfile: profile(common.oracleProfile, "oracleProfile"), imageProfile: profile(common.imageProfile, "imageProfile"), videoProfile: profile(common.videoProfile, "videoProfile"),
      autoRename: bool(common.autoRename, "autoRename"), renameProfile: profile(common.renameProfile, "renameProfile"),
      pinRenderMode: choice(common.pinRenderMode, "pinRenderMode", ["system", "user-tail"] as const), pinRenderInterval: integer(common.pinRenderInterval, "pinRenderInterval", 0, 1000),
    },
    mcp: { servers: parseMcpServers(mcp.servers) }, wire: { sources: parseWireSources(wire.sources) },
    animas: { defaultAnima: profile(animas.defaultAnima, "defaultAnima") },
    nous: { enabled: bool(nous.enabled, "Nous enabled"), autoTriggerThreshold: integer(nous.autoTriggerThreshold, "Nous threshold", 1, 100), cooldownMinutes: integer(nous.cooldownMinutes, "Nous cooldown", 1, 1440), profile: profile(nous.profile, "Nous profile") },
    tts: { enabled: bool(tts.enabled, "TTS enabled"), voice: text(tts.voice, "TTS voice", 128), language: text(tts.language, "TTS language", 35, false), rate: numberValue(tts.rate, "TTS rate", 0.5, 2) },
    asr: { provider: choice(asr.provider, "ASR provider", ["browser", "volcengine"] as const), language: text(asr.language, "ASR language", 35, false), endpoint: asr.endpoint === "" ? "" : secureUrl(asr.endpoint, "ASR endpoint", ["https:"]), ...(asrReference ? { credentialRef: asrReference } : {}) },
    shell: { defaultShell: choice(shell.defaultShell, "defaultShell", ["auto", "powershell", "cmd"] as const), initializationScript: text(shell.initializationScript, "Shell initialization", 8192) },
    relay: { enabled: bool(relay.enabled, "Relay enabled"), url: relay.url === "" ? "" : secureUrl(relay.url, "Relay URL", ["wss:"]), ...(relayReference ? { credentialRef: relayReference } : {}) },
    update: { channel: choice(update.channel, "Update channel", ["stable", "beta"] as const), autoCheck: bool(update.autoCheck, "Update autoCheck"), autoDownload: bool(update.autoDownload, "Update autoDownload") },
  };
}

export function cloneSettingsDomains(value: SettingsDomains): SettingsDomains {
  return parseSettingsDomains(JSON.parse(JSON.stringify(value)));
}

export function publicSettingsDomains(value: SettingsDomains): Record<string, unknown> {
  const clone = cloneSettingsDomains(value) as unknown as Record<string, Record<string, unknown>>;
  const asrConfigured = typeof clone.asr.credentialRef === "string";
  const relayConfigured = typeof clone.relay.credentialRef === "string";
  delete clone.asr.credentialRef;
  delete clone.relay.credentialRef;
  return { ...clone, credentials: { asrConfigured, relayConfigured } };
}
