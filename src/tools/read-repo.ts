// ===========================================
// read_repo — capability-scoped Git project reader
// ===========================================

import { execFile } from "node:child_process";
import path from "node:path";
import { getBootstrapPathStore } from "../bootstrap-path-store.js";
import type { ScopedPathGateway, ToolDefinition, ToolExecutor } from "../types.js";

const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_TRACKED_FILES = 10_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export const readRepoDef: ToolDefinition = {
  type: "function",
  function: {
    name: "read_repo",
    description:
      "将整个 Git 项目加载为结构化 Markdown。支持不同详细度：summary(概览) / tree(文件列表) / headers(前30行) / full(完整)。用于快速了解项目结构。",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "项目根目录路径" },
        level: { type: "string", enum: ["summary", "tree", "headers", "full"], description: "加载详细度（默认 summary）" },
        include: { type: "string", description: "glob 过滤，如 '*.ts'（可选）" },
        exclude: { type: "string", description: "排除模式，如 '*.test.ts'（可选）" },
        max_files: { type: "number", description: "最大文件数（默认 500）" },
      },
    },
  },
};

async function runGitLsFiles(cwd: string): Promise<Buffer> {
  const executable = await getBootstrapPathStore().openGitExecutable();
  try {
    await executable.assertCurrent("beforeProcessSpawn");
    return await new Promise((resolve, reject) => {
      execFile(
        executable.canonicalPath,
      ["ls-files", "-z", "--"],
      {
        cwd,
        shell: false,
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        encoding: "buffer",
      },
      (error, stdout) => {
        if (error) {
          reject(new Error("read_repo requires a readable Git worktree"));
          return;
        }
        resolve(Buffer.from(stdout));
        }
      );
    });
  } finally {
    await executable.close();
  }
}

function parseGitEntries(bytes: Buffer): string[] {
  if (bytes.length === 0) return [];
  if (bytes.at(-1) !== 0) throw new Error("git ls-files returned a non-NUL-terminated result");
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("git ls-files returned a non-UTF-8 path");
  }
  const entries = decoded.slice(0, -1).split("\0");
  if (entries.length > MAX_TRACKED_FILES) throw new Error(`Git repository exceeds ${MAX_TRACKED_FILES} tracked files`);
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || entry.includes("\\") || path.posix.isAbsolute(entry)) throw new Error("git ls-files returned an invalid relative path");
    const components = entry.split("/");
    if (components.some(component => !component || component === "." || component === "..")) {
      throw new Error("git ls-files returned an invalid relative path");
    }
    if (seen.has(entry)) throw new Error("git ls-files returned duplicate paths");
    seen.add(entry);
  }
  return entries;
}

function globToRegex(glob: string): RegExp {
  if (typeof glob !== "string" || glob.length === 0 || glob.length > 256) throw new TypeError("glob filter is invalid");
  let expression = "^";
  for (const character of glob) {
    if (character === "*") expression += ".*";
    else if (character === "?") expression += ".";
    else expression += character.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
  }
  return new RegExp(`${expression}$`, "iu");
}

async function authorizeTrackedEntries(gateway: ScopedPathGateway, canonicalRoot: string, files: readonly string[], rootId: string): Promise<void> {
  const byParent = new Map<string, Set<string>>();
  for (const file of files) {
    const parent = path.posix.dirname(file) === "." ? "" : path.posix.dirname(file);
    const leaf = path.posix.basename(file);
    const leaves = byParent.get(parent) ?? new Set<string>();
    leaves.add(leaf);
    byParent.set(parent, leaves);
  }

  for (const [parent, requiredLeaves] of byParent) {
    const absoluteParent = parent ? path.join(canonicalRoot, ...parent.split("/")) : canonicalRoot;
    const entries = await gateway.searchDirectory(absoluteParent, { defaultRootId: rootId, maxEntries: 10_000 });
    const regularFiles = new Set(entries.filter(entry => entry.type === "file").map(entry => entry.name));
    for (const leaf of requiredLeaves) {
      if (!regularFiles.has(leaf)) throw new Error("Git tracked entry failed PathPolicy qualification");
    }
  }
}

function decodeText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  return bytes.toString("utf8");
}

export const readRepoExec: ToolExecutor = async (args, _env, invocation) => {
  if (!invocation) throw new Error("Path gateway is required");
  const gateway = invocation.path;
  const rootId = gateway.rootIdForEnv("DATA_ROOT") ?? gateway.rootIdForEnv("WORKSPACE_ROOT");
  if (!rootId) throw new Error("read_repo root is unavailable");
  const inputPath = typeof args.path === "string" && args.path.length > 0 ? args.path : "";
  const level = typeof args.level === "string" ? args.level : "summary";
  if (!["summary", "tree", "headers", "full"].includes(level)) throw new TypeError("read_repo level is invalid");
  const maxFiles = args.max_files === undefined ? 500 : Number(args.max_files);
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 500) throw new TypeError("max_files must be an integer from 1 to 500");

  return gateway.withInitialCwd(inputPath, { defaultRootId: rootId }, async canonicalRoot => {
    const files = parseGitEntries(await runGitLsFiles(canonicalRoot));
    await authorizeTrackedEntries(gateway, canonicalRoot, files, rootId);

    let selected = [...files];
    if (args.include !== undefined) {
      const include = globToRegex(String(args.include));
      selected = selected.filter(file => include.test(path.posix.basename(file)));
    }
    if (args.exclude !== undefined) {
      const exclude = globToRegex(String(args.exclude));
      selected = selected.filter(file => !exclude.test(path.posix.basename(file)));
    }
    selected = selected.slice(0, maxFiles);
    const displayRoot = inputPath || ".";

    if (level === "summary") {
      const directories = new Set(selected.map(file => path.posix.dirname(file)));
      const extensions: Record<string, number> = {};
      for (const file of selected) {
        const extension = path.posix.extname(file) || "(no ext)";
        extensions[extension] = (extensions[extension] || 0) + 1;
      }
      const keyNames = new Set(["package.json", "tsconfig.json", "README.md", "index.ts", "main.ts"]);
      const keyFiles = selected.filter(file => keyNames.has(path.posix.basename(file)));
      return `项目概览: ${displayRoot}\n文件数: ${selected.length}\n目录数: ${directories.size}\n\n文件类型:\n${Object.entries(extensions).sort((a, b) => b[1] - a[1]).map(([extension, count]) => `  ${extension}: ${count}`).join("\n")}\n\n关键文件:\n${keyFiles.map(file => `  📄 ${file}`).join("\n") || "  (无)"}`;
    }

    if (level === "tree") {
      return `项目文件树: ${displayRoot}\n共 ${selected.length} 个文件:\n\n${selected.map(file => `  📄 ${file}`).join("\n")}`;
    }

    const limit = level === "headers" ? 30 : 50;
    const results: string[] = [];
    for (const file of selected.slice(0, limit)) {
      const absoluteFile = path.join(canonicalRoot, ...file.split("/"));
      const result = await gateway.searchFile(absoluteFile, { defaultRootId: rootId, maxBytes: MAX_FILE_BYTES });
      const content = decodeText(result.bytes);
      if (content === null) continue;
      if (level === "headers") {
        results.push(`--- ${file} ---\n${content.split("\n").slice(0, 30).join("\n")}`);
      } else {
        results.push(`--- ${file} ---\n${content.length > 2000 ? `${content.slice(0, 2000)}\n...(截断)` : content}`);
      }
    }
    const label = level === "headers" ? "项目文件头" : "项目完整内容";
    return `${label}: ${displayRoot}\n共 ${selected.length} 个文件，显示前 ${limit} 个:\n\n${results.join("\n\n")}`;
  });
};
