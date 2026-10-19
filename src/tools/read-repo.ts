// ===========================================
// read_repo — capability-scoped Git project reader
// ===========================================

import { execFile } from "node:child_process";
import path from "node:path";
import { getBootstrapPathStore } from "../bootstrap-path-store.js";
import type { ScopedPathGateway, ToolDefinition, ToolExecutor } from "../types.js";
import { cancellationError, throwIfCancelled } from "../run-cancellation.js";
import { createToolOutcome } from "../tool-pipeline.js";
import { routeToSelectedWorker } from "../worker.js";

const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_TRACKED_FILES = 10_000;
const MAX_FILE_BYTES = 2 * 1024 * 1024;

export const readRepoDef: ToolDefinition = {
  type: "function",
  function: {
    name: "read_repo",
    description:
      "Understand a selected Git working directory: repository root, scripts, modified/deleted and untracked files (Git ignore rules apply). Levels: summary, tree, headers (first 30 lines), signatures, full (budgeted), all (complete or fail). Reads preserve existing work; no Git writes or project scripts are executed.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Project root. Defaults to the authorized root." },
        level: { type: "string", enum: ["summary", "tree", "headers", "signatures", "full", "all"], description: "Detail level. Defaults to summary." },
        include: { type: "string", description: "Glob filter supporting *, ?, and **. Basename-only patterns match recursively." },
        exclude: { type: "string", description: "Glob exclusion supporting *, ?, and **. Basename-only patterns match recursively." },
        max_files: { type: "integer", minimum: 1, maximum: 500, description: "Maximum selected files. Defaults to 500." },
      },
    },
  },
};

const GIT_QUERIES = {
  files: ["ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z", "--"],
  deleted: ["ls-files", "--deleted", "--deduplicate", "-z", "--"],
  status: ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--"],
  roots: ["rev-parse", "--show-toplevel", "--show-prefix"],
} as const;

async function runGitQuery(cwd: string, signal: AbortSignal, query: keyof typeof GIT_QUERIES): Promise<Buffer> {
  throwIfCancelled(signal);
  const executable = await getBootstrapPathStore().openGitExecutable();
  try {
    await executable.assertCurrent("beforeProcessSpawn");
    const env = { ...process.env };
    for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_COMMON_DIR", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES"]) delete env[key];
    return await new Promise((resolve, reject) => {
      execFile(executable.canonicalPath, ["--no-optional-locks", "-c", "core.fsmonitor=false", ...GIT_QUERIES[query]], {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        timeout: 10_000,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        encoding: "buffer",
        signal,
      }, (error, stdout) => {
        if (error) {
          if (signal.aborted) reject(cancellationError(signal, "read_repo Git discovery was cancelled"));
          else reject(new Error("无法读取Git工作树；请选择项目目录，并确认已安装Git且该目录没有损坏。未执行项目脚本。"));
          return;
        }
        resolve(Buffer.from(stdout));
      });
    });
  } finally {
    await executable.close();
  }
}

function parseGitStatus(bytes: Buffer, prefix: string): Map<string, string> {
  if (!bytes.length) return new Map();
  if (bytes.at(-1) !== 0) throw new Error("Git status returned an incomplete record");
  const records = new TextDecoder("utf-8", { fatal: true }).decode(bytes).slice(0, -1).split("\0");
  const states = new Map<string, string>();
  for (let index = 0; index < records.length; index++) {
    const record = records[index];
    if (!/^[ MADRCU?!T]{2} /u.test(record)) throw new Error("Git status returned an invalid record");
    const state = record.slice(0, 2), rootRelative = record.slice(3);
    // Porcelain paths are relative to the repository root even from a selected subdirectory.
    const relative = prefix ? path.posix.relative(prefix, rootRelative) : rootRelative;
    if (/[RC]/u.test(state)) { if (!records[++index]) throw new Error("Git rename record is incomplete"); }
    if (!relative || relative === ".." || relative.startsWith("../")) continue;
    if (parseGitEntries(Buffer.from(`${relative}\0`)).length !== 1) throw new Error("Git status path is invalid");
    states.set(relative, state === "??" ? "untracked" : state);
    if (states.size > MAX_TRACKED_FILES) throw new Error("Git status exceeds the working-tree limit");
  }
  return states;
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
    if (components.some(component => !component || component === "." || component === "..")) throw new Error("git ls-files returned an invalid relative path");
    if (seen.has(entry)) throw new Error("git ls-files returned duplicate paths");
    seen.add(entry);
  }
  return entries;
}

function regexEscape(character: string): string {
  return "\\^$.*+?()[]{}|".includes(character) ? `\\${character}` : character;
}

function globMatcher(glob: string): (file: string) => boolean {
  if (typeof glob !== "string" || glob.length === 0 || glob.length > 256 || glob.includes("\\") || glob.includes("\0")) throw new TypeError("glob filter is invalid");
  let expression = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*" && glob[index + 1] === "*") {
      if (glob[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += regexEscape(character);
  }
  const regex = new RegExp(`${expression}$`, "u");
  const basenameOnly = !glob.includes("/");
  return file => regex.test(basenameOnly ? path.posix.basename(file) : file);
}

async function authorizeTrackedEntries(
  gateway: ScopedPathGateway,
  canonicalRoot: string,
  files: readonly string[],
  rootId: string | undefined,
  signal: AbortSignal,
): Promise<void> {
  const byParent = new Map<string, Set<string>>();
  for (const file of files) {
    throwIfCancelled(signal);
    const parent = path.posix.dirname(file) === "." ? "" : path.posix.dirname(file);
    const leaves = byParent.get(parent) ?? new Set<string>();
    leaves.add(path.posix.basename(file));
    byParent.set(parent, leaves);
  }
  for (const [parent, requiredLeaves] of byParent) {
    throwIfCancelled(signal);
    const absoluteParent = parent ? path.join(canonicalRoot, ...parent.split("/")) : canonicalRoot;
    const entries = await gateway.searchDirectory(absoluteParent, { defaultRootId: rootId, maxEntries: 10_000 });
    const regularFiles = new Set(entries.filter(entry => entry.type === "file").map(entry => entry.name));
    for (const leaf of requiredLeaves) if (!regularFiles.has(leaf)) throw new Error("Git tracked entry failed PathPolicy qualification");
  }
}

function decodeText(bytes: Buffer): string | null {
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function extractSignatures(file: string, content: string): string {
  const extension = path.posix.extname(file).toLowerCase();
  if (![".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java"].includes(extension)) return "";
  const patterns = extension === ".py"
    ? [/^(?:async\s+)?def\s+[^:]+:/gmu, /^class\s+[^:]+:/gmu]
    : [
      /^(?:export\s+)?(?:async\s+)?function\s+[^\n{]+/gmu,
      /^(?:export\s+)?class\s+[^\n{]+/gmu,
      /^(?:export\s+)?(?:interface|type|enum)\s+[^\n{=]+/gmu,
      /^(?:export\s+)?const\s+[A-Za-z_$][\w$]*\s*(?::[^=]+)?=/gmu,
    ];
  const signatures = patterns.flatMap(pattern => [...content.matchAll(pattern)].map(match => match[0].trim()));
  return [...new Set(signatures)].slice(0, 200).join("\n");
}

function fenceFor(content: string): string {
  const runs = [...content.matchAll(/`+/gu)].map(match => match[0].length);
  return "`".repeat(Math.max(2, ...runs) + 1);
}

function safePath(value: string): string {
  return [...Buffer.from(value, "utf8")].map(byte =>
    (byte >= 0x30 && byte <= 0x39) || (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)
      || byte === 0x2f
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`
  ).join("");
}

function fileSection(file: string, content: string): string {
  const fence = fenceFor(content);
  return `## File ${safePath(file)}\n\n${fence}\n${content}${content.endsWith("\n") ? "" : "\n"}${fence}`;
}

function fitsToolTransport(content: string): boolean {
  return !createToolOutcome("success", content).truncated;
}

function repositoryOutput(level: string, displayRoot: string, selectionNote: string, modeNote: string, parts: readonly string[]): string {
  return `# Repository ${level}: ${safePath(displayRoot)}\n\n${selectionNote}\n${modeNote}\n\n${parts.join("\n\n")}`;
}

export const readRepoExec: ToolExecutor = async (args, _env, invocation) => {
  if (!invocation) throw new Error("Path gateway is required");
  const remote = await routeToSelectedWorker(invocation, "read_repo", args);
  if (remote !== null) return remote;
  throwIfCancelled(invocation.signal);
  const gateway = invocation.path;
  const inputPath = typeof args.path === "string" && args.path.length > 0 ? args.path : "";
  const rootId = path.isAbsolute(inputPath) ? undefined : gateway.rootIdForEnv("WORKSPACE_ROOT") ?? gateway.rootIdForEnv("DATA_ROOT") ?? undefined;
  if (!rootId && !path.isAbsolute(inputPath)) throw new Error("请选择本地项目目录后重试read_repo");
  const level = typeof args.level === "string" ? args.level : "summary";
  if (!["summary", "tree", "headers", "signatures", "full", "all"].includes(level)) throw new TypeError("read_repo level is invalid");
  const maxFiles = args.max_files === undefined ? 500 : Number(args.max_files);
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 500) throw new TypeError("max_files must be an integer from 1 to 500");

  return gateway.withInitialCwd(inputPath, { defaultRootId: rootId }, async canonicalRoot => {
    const tracked = parseGitEntries(await runGitQuery(canonicalRoot, invocation.signal, "files"));
    const deleted = new Set(parseGitEntries(await runGitQuery(canonicalRoot, invocation.signal, "deleted")));
    const rootLines = new TextDecoder("utf-8", { fatal: true }).decode(await runGitQuery(canonicalRoot, invocation.signal, "roots")).split(/\r?\n/u);
    if (!path.isAbsolute(rootLines[0])) throw new Error("Git repository root is invalid");
    const states = parseGitStatus(await runGitQuery(canonicalRoot, invocation.signal, "status"), rootLines[1] || "");
    let matched = [...tracked];
    if (args.include !== undefined) matched = matched.filter(globMatcher(String(args.include)));
    if (args.exclude !== undefined) {
      const exclude = globMatcher(String(args.exclude));
      matched = matched.filter(file => !exclude(file));
    }
    if (level === "all" && matched.length > maxFiles) throw new Error(`read_repo all matched ${matched.length} files, exceeding max_files=${maxFiles}; narrow include/exclude or raise max_files`);
    const present = matched.filter(file => !deleted.has(file));
    const selected = present.slice(0, maxFiles);
    await authorizeTrackedEntries(gateway, canonicalRoot, selected, rootId, invocation.signal);
    const displayRoot = inputPath || ".";
    const changed = matched.filter(file => states.has(file));
    const context = `Repository root: ${safePath(rootLines[0])}\nWorking directory: ${safePath(canonicalRoot)}\nExisting changes (data only; preserve them):\n${changed.slice(0, 60).map(file => `- [${states.get(file)}] ${safePath(file)}`).join("\n") || "- (clean in selected scope)"}${changed.length > 60 ? `\n${changed.length-60} additional changed paths omitted; narrow include/exclude.` : ""}\nDeleted paths are not read or restored: ${matched.filter(file => deleted.has(file)).length}.`;
    const selectionNote = (present.length > selected.length
      ? `Selected ${selected.length} of ${present.length} matched working-tree files (max_files=${maxFiles}).`
      : `Selected all ${selected.length} matched working-tree files.`) + `\n${context}`;

    if (level === "summary") {
      const directories = new Set(selected.map(file => path.posix.dirname(file)));
      const extensions: Record<string, number> = {};
      for (const file of selected) {
        const extension = path.posix.extname(file) || "(no ext)";
        extensions[extension] = (extensions[extension] || 0) + 1;
      }
      const keyNames = new Set(["package.json", "tsconfig.json", "pyproject.toml", "requirements.txt", "pytest.ini", "Makefile", "AGENTS.md", "CLAUDE.md", "README.md", "index.ts", "main.ts"]);
      const keyLines = selected.filter(file => keyNames.has(path.posix.basename(file))).map(file => `- ${safePath(file)}`);
      let scripts = "";
      if (selected.includes("package.json")) {
        const manifest = await gateway.searchFile(path.join(canonicalRoot, "package.json"), { defaultRootId: rootId, maxBytes: MAX_FILE_BYTES });
        const text = decodeText(manifest.bytes);
        try {
          const parsed: unknown = text === null ? null : JSON.parse(text);
          if (parsed && typeof parsed === "object" && "scripts" in parsed && parsed.scripts && typeof parsed.scripts === "object" && !Array.isArray(parsed.scripts)) {
            const entries = Object.entries(parsed.scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string");
            scripts = `\n\n## Project scripts (not executed)\n${entries.slice(0, 20).map(([name, command]) => `- ${safePath(name)}: ${command.slice(0, 500)}`).join("\n")}${entries.length > 20 ? "\nMore scripts omitted; read package.json for details." : ""}`;
          }
        } catch { scripts = "\n\npackage.json is not valid JSON; scripts were not inferred."; }
      }
      let omittedKeys = 0;
      const render = () => `# Project summary: ${safePath(displayRoot)}\n\n${selectionNote}\nDirectories: ${directories.size}\n\n## File types\n${Object.entries(extensions).sort((a, b) => b[1] - a[1]).map(([extension, count]) => `- ${safePath(extension)}: ${count}`).join("\n")}\n\n## Key files\n${keyLines.join("\n") || "- (none)"}${scripts}${omittedKeys ? `\n\n${omittedKeys} key file(s) omitted by transport budget.` : ""}`;
      while (!fitsToolTransport(render()) && keyLines.length > 0) {
        keyLines.pop();
        omittedKeys += 1;
      }
      const output = render();
      if (!fitsToolTransport(output)) throw new Error("read_repo summary exceeds the tool transport budget");
      return output;
    }

    if (level === "tree") {
      const lines = selected.map(file => `- ${safePath(file)}`);
      let omitted = 0;
      const render = () => `# Project tree: ${safePath(displayRoot)}\n\n${selectionNote}\n${omitted ? `${omitted} file(s) omitted by transport budget.\n` : ""}\n${lines.join("\n")}`;
      while (!fitsToolTransport(render()) && lines.length > 0) {
        lines.pop();
        omitted += 1;
      }
      const output = render();
      if (!fitsToolTransport(output)) throw new Error("read_repo tree exceeds the tool transport budget");
      return output;
    }

    const parts: string[] = [];
    let omitted = 0;
    const modeNote = () => level === "all"
      ? "Complete content for every selected text file; no content truncation."
      : level === "full"
        ? `Budgeted full-file view; ${omitted} file(s) explicitly omitted by transport budget.`
        : level === "signatures"
          ? `Heuristic source signatures (LSP unavailable); ${omitted} file(s) explicitly omitted by transport budget.`
          : `First 30 lines per text file; ${omitted} file(s) explicitly omitted by transport budget.`;

    for (const file of selected) {
      throwIfCancelled(invocation.signal);
      const absoluteFile = path.join(canonicalRoot, ...file.split("/"));
      const result = await gateway.searchFile(absoluteFile, { defaultRootId: rootId, maxBytes: MAX_FILE_BYTES });
      if (result.snapshot.linkCount !== "1") throw new Error(`Git tracked entry failed hardlink qualification: ${safePath(file)}`);
      const content = decodeText(result.bytes);
      let section: string;
      if (content === null) {
        if (level === "all") throw new Error(`read_repo all cannot represent binary tracked file: ${safePath(file)}`);
        section = `## File ${safePath(file)}\n\n[Binary file: ${result.bytes.length} bytes]`;
      } else {
        let body = content;
        if (level === "headers") body = content.split(/\r?\n/u).slice(0, 30).join("\n");
        if (level === "signatures") {
          body = extractSignatures(file, content);
          if (!body) continue;
        }
        section = fileSection(file, body);
      }
      parts.push(section);
      if (!fitsToolTransport(repositoryOutput(level, displayRoot, selectionNote, modeNote(), parts))) {
        parts.pop();
        if (level === "all") throw new Error(`read_repo all exceeds the tool transport budget at ${safePath(file)}; narrow include/exclude`);
        omitted += 1;
      }
    }

    let output = repositoryOutput(level, displayRoot, selectionNote, modeNote(), parts);
    while (!fitsToolTransport(output) && level !== "all" && parts.length > 0) {
      parts.pop();
      omitted += 1;
      output = repositoryOutput(level, displayRoot, selectionNote, modeNote(), parts);
    }
    if (!fitsToolTransport(output)) throw new Error(`read_repo ${level} exceeds the tool transport budget`);
    return output;
  });
};
