// ===========================================
// Oracle knowledge snapshot — governed project reader + managed store
// ===========================================

import type { LLMClient } from "./llm.js";
import { getManagedPathStore } from "./managed-path-store.js";
import type { ScopedPathGateway } from "./types.js";

export interface OracleSnapshot {
  readonly createdAt: string;
  readonly projectPath: string;
  readonly summary: string;
  readonly tree: string;
  readonly headers: Readonly<Record<string, readonly string[]>>;
}

const MAX_TREE_ENTRIES = 5_000;
const MAX_HEADER_BYTES = 2 * 1024 * 1024;
const KEY_FILE_NAMES = new Set([
  "package.json", "tsconfig.json", "README.md", "index.ts", "index.js", "main.ts", "main.js", "config.json",
]);

let currentOracle: OracleSnapshot | null = null;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateSnapshot(value: unknown): OracleSnapshot {
  if (!isPlainObject(value)) throw new Error("Oracle snapshot is invalid");
  const { createdAt, projectPath, summary, tree, headers } = value;
  if (typeof createdAt !== "string" || !Number.isFinite(Date.parse(createdAt))
    || typeof projectPath !== "string" || projectPath.length > 4096
    || typeof summary !== "string" || summary.length > 2_000_000
    || typeof tree !== "string" || tree.length > 2_000_000
    || !isPlainObject(headers)) {
    throw new Error("Oracle snapshot is invalid");
  }
  const safeHeaders: Record<string, readonly string[]> = {};
  for (const [name, lines] of Object.entries(headers)) {
    if (!name || name.length > 4096 || !Array.isArray(lines) || lines.length > 30
      || lines.some(line => typeof line !== "string" || line.length > 100_000)) {
      throw new Error("Oracle snapshot is invalid");
    }
    safeHeaders[name] = Object.freeze([...lines] as string[]);
  }
  return Object.freeze({
    createdAt,
    projectPath,
    summary,
    tree,
    headers: Object.freeze(safeHeaders),
  });
}

interface ProjectScan {
  readonly tree: string;
  readonly headers: Readonly<Record<string, readonly string[]>>;
  readonly fileCount: number;
}

async function scanProject(gateway: ScopedPathGateway, projectPath: string, rootId: string): Promise<ProjectScan> {
  const headers: Record<string, readonly string[]> = {};
  let totalEntries = 0;
  let fileCount = 0;

  async function walk(currentInput: string, relativeParent: string, prefix: string, depth: number): Promise<string> {
    if (depth > 3) return "";
    const entries = [...await gateway.searchDirectory(currentInput, { defaultRootId: rootId, maxEntries: 10_000 })]
      .sort((left, right) => left.name.localeCompare(right.name));
    totalEntries += entries.length;
    if (totalEntries > MAX_TREE_ENTRIES) throw new Error(`Oracle project exceeds ${MAX_TREE_ENTRIES} entries`);
    const visible = entries.filter(entry => !entry.name.startsWith(".") && entry.name !== "node_modules");
    let tree = "";
    for (let index = 0; index < visible.length; index += 1) {
      const entry = visible[index];
      const isLast = index === visible.length - 1;
      const connector = isLast ? "└── " : "├── ";
      tree += `${prefix}${connector}${entry.name}${entry.type === "directory" ? "/" : ""}\n`;
      const childInput = currentInput
        ? `${currentInput.replace(/[\\/]$/u, "")}\\${entry.name}`
        : entry.name;
      const relative = relativeParent ? `${relativeParent}/${entry.name}` : entry.name;
      if (entry.type === "directory") {
        tree += await walk(childInput, relative, `${prefix}${isLast ? "    " : "│   "}`, depth + 1);
      } else {
        fileCount += 1;
        if (Object.keys(headers).length < 20 && KEY_FILE_NAMES.has(entry.name)) {
          const result = await gateway.searchFile(childInput, { defaultRootId: rootId, maxBytes: MAX_HEADER_BYTES });
          if (!result.bytes.includes(0)) headers[relative] = Object.freeze(result.bytes.toString("utf8").split("\n").slice(0, 30));
        }
      }
    }
    return tree;
  }

  const tree = await walk(projectPath, "", "", 0);
  return Object.freeze({ tree, headers: Object.freeze(headers), fileCount });
}

/** Save a project snapshot. Project reads and managed snapshot writes use disjoint authorities. */
export async function saveOracle(projectPath: string, gateway: ScopedPathGateway): Promise<string> {
  if (typeof projectPath !== "string" || projectPath.length > 4096) throw new TypeError("Oracle project path is invalid");
  const rootId = gateway.rootIdForEnv("DATA_ROOT") ?? gateway.rootIdForEnv("WORKSPACE_ROOT");
  if (!rootId) throw new Error("Oracle project root is unavailable");
  const scan = await scanProject(gateway, projectPath, rootId);
  const label = projectPath || ".";
  const snapshot = validateSnapshot({
    createdAt: new Date().toISOString(),
    projectPath: label,
    summary: `项目路径: ${label}\n目录结构:\n${scan.tree}`,
    tree: scan.tree,
    headers: scan.headers,
  });
  const store = await getManagedPathStore();
  await store.writeOracle(Buffer.from(JSON.stringify(snapshot, null, 2), "utf8"));
  currentOracle = snapshot;
  return `✅ Oracle 快照已保存\n项目: ${label}\n文件: ${scan.fileCount} 个\n目录树深度: 3`;
}

/** Load and validate the managed Oracle snapshot. Missing is distinct from malformed. */
export async function loadOracle(): Promise<boolean> {
  const store = await getManagedPathStore();
  const bytes = await store.readOracle();
  if (bytes === null) return false;
  let parsed: unknown;
  try { parsed = JSON.parse(bytes.toString("utf8")); }
  catch { throw new Error("Oracle snapshot is invalid"); }
  currentOracle = validateSnapshot(parsed);
  return true;
}

export async function queryOracle(llm: LLMClient, question: string): Promise<string> {
  if (!currentOracle && !(await loadOracle())) {
    return "Oracle 知识库未初始化。请先用 /oracle save 创建快照。";
  }
  const context = `项目路径: ${currentOracle!.projectPath}\n\n目录结构:\n${currentOracle!.tree}\n\n关键文件内容:\n${
    Object.entries(currentOracle!.headers)
      .map(([file, lines]) => `--- ${file} ---\n${lines.join("\n")}`)
      .join("\n\n")
      .slice(0, 8000)
  }`;
  const response = await llm.chat([
    { role: "system", content: "你是项目知识库 Oracle。根据以下项目快照回答问题。只使用快照中的信息，不要猜测。" },
    { role: "user", content: `项目快照:\n${context}\n\n问题: ${question}` },
  ]);
  return response.content || "(Oracle 无回复)";
}

export async function getOracleStatus(): Promise<{ loaded: boolean; projectPath?: string; createdAt?: string }> {
  if (!currentOracle && !(await loadOracle())) return { loaded: false };
  return { loaded: true, projectPath: currentOracle!.projectPath, createdAt: currentOracle!.createdAt };
}
