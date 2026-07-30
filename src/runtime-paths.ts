// ===========================================
// Runtime paths
// 开发态默认使用项目目录；正式 Electron 使用 userData 保存可变数据
// ===========================================

import path from "path";
import { fileURLToPath } from "url";
import { pathPolicy } from "./path-runtime.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function bootstrapCandidate(
  environmentName: string,
  fallback: string,
  role: string,
  parent?: string
): Promise<string> {
  const candidate = process.env[environmentName] ?? fallback;
  return pathPolicy.validateBootstrapCandidate(candidate, { role, parent });
}

export const APP_ROOT = await bootstrapCandidate(
  "RAINYDAYS_APP_ROOT",
  path.resolve(__dirname, ".."),
  "app"
);
export const USER_DATA_DIR = await bootstrapCandidate(
  "RAINYDAYS_USER_DATA_DIR",
  APP_ROOT,
  "user-data"
);
export const DATA_DIR = await bootstrapCandidate(
  "RAINYDAYS_DATA_DIR",
  path.join(USER_DATA_DIR, "data"),
  "data",
  USER_DATA_DIR
);
export const DEFAULT_WORKSPACE_DIR = await pathPolicy.validateBootstrapCandidate(
  path.join(USER_DATA_DIR, "workspace"),
  { role: "default-workspace", parent: USER_DATA_DIR }
);
export const CONFIG_PATH = await bootstrapCandidate(
  "RAINYDAYS_CONFIG_PATH",
  path.join(USER_DATA_DIR, "config.json"),
  "config",
  USER_DATA_DIR
);
export const PUBLIC_DIR = await bootstrapCandidate(
  "RAINYDAYS_PUBLIC_DIR",
  path.join(APP_ROOT, "public"),
  "public",
  APP_ROOT
);
export const MODELS_DIR = await bootstrapCandidate(
  "RAINYDAYS_MODELS_DIR",
  path.join(APP_ROOT, "models"),
  "models",
  APP_ROOT
);
export const BUILTIN_PERSONAS_DIR = await bootstrapCandidate(
  "RAINYDAYS_BUILTIN_PERSONAS_DIR",
  path.join(APP_ROOT, "personas"),
  "builtin-personas",
  APP_ROOT
);
export const USER_PERSONAS_DIR = await bootstrapCandidate(
  "RAINYDAYS_USER_PERSONAS_DIR",
  path.join(DATA_DIR, "personas"),
  "user-personas",
  USER_DATA_DIR
);
export const BUILTIN_SKILLS_DIR = await bootstrapCandidate(
  "RAINYDAYS_BUILTIN_SKILLS_DIR",
  path.join(APP_ROOT, "skills"),
  "builtin-skills",
  APP_ROOT
);
export const USER_SKILLS_DIR = await bootstrapCandidate(
  "RAINYDAYS_USER_SKILLS_DIR",
  path.join(DATA_DIR, "skills"),
  "user-skills",
  USER_DATA_DIR
);
export const PLAYBOOKS_DIR = await bootstrapCandidate(
  "RAINYDAYS_PLAYBOOKS_DIR",
  path.join(USER_DATA_DIR, "playbooks"),
  "playbooks",
  USER_DATA_DIR
);
// Oracle是可选lazy store：先做纯语法/absolute校验，父子关系和identity在首次使用时验证。
export const ORACLE_PATH = await bootstrapCandidate(
  "RAINYDAYS_ORACLE_PATH",
  path.join(USER_DATA_DIR, "LUX.oracle"),
  "oracle"
);

export function validateOptionalBootstrapDescendant(candidate: string, parent: string, role: string): Promise<string> {
  return pathPolicy.validateBootstrapCandidate(candidate, { role, parent });
}
