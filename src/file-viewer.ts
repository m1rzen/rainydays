// ===========================================
// File Viewer — direct-local runtime authority snapshot
// ===========================================

import { spawn } from "node:child_process";
import path from "node:path";
import { Worker } from "node:worker_threads";
import iconv from "iconv-lite";
import { getBootstrapPathStore } from "./bootstrap-path-store.js";
import type { RuntimeAuthority } from "./capability-broker.js";
import { PathDeniedError, type PathAuditIdentity, type PathAuthority, type PathDirectoryEnrollmentLease, type PathQualifiedResult, type PathReadLease } from "./path-policy.js";
import { pathPolicy } from "./path-runtime.js";
import { assertResourceOwner, registerOwnedResource, type ResourceOwner } from "./resource-owner.js";
import type { ParseResult } from "./tools/parsers.js";

export type FileRootId = "workspace" | "department" | "output";
export type PreviewKind = "text" | "markdown" | "office" | "image" | "pdf" | "unsupported";

export interface FileRootInfo {
  id: FileRootId;
  name: string;
  path: string;
  available: boolean;
}

export interface FileRootSnapshotInput {
  readonly id: FileRootId;
  readonly name: string;
  readonly configuredPath: string;
  readonly available: boolean;
}

export interface FileEntry {
  name: string;
  path: string;
  absolutePath: string;
  type: "directory" | "file";
  size: number | null;
  modifiedAt: string | null;
  extension: string;
}

interface ViewerBinding {
  readonly authority: RuntimeAuthority;
  readonly pathAuthority: PathAuthority;
  readonly roots: readonly FileRootSnapshotInput[];
}

export interface FileContentLease {
  readonly absolutePath: string;
  readonly name: string;
  readonly size: number;
  readonly mime: string;
  readonly modifiedAt: Date;
  readonly readRange: (start: number, end: number) => Promise<Buffer>;
  readonly close: () => Promise<void>;
}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".log", ".json", ".jsonl", ".xml", ".yaml", ".yml",
  ".toml", ".ini", ".conf", ".config", ".env", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
  ".css", ".scss", ".less", ".html", ".htm", ".vue", ".svelte", ".py", ".java", ".c", ".h",
  ".cpp", ".hpp", ".cs", ".go", ".rs", ".php", ".rb", ".sh", ".bash", ".ps1", ".bat", ".cmd",
  ".sql", ".graphql", ".gql", ".dockerfile", ".gitignore", ".npmrc",
]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const OFFICE_EXTENSIONS = new Set([".docx", ".xlsx", ".xls"]);
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp",
};
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_OFFICE_BYTES = 50 * 1024 * 1024;
const MAX_MEDIA_BYTES = 100 * 1024 * 1024;
const OPERATION_TIMEOUT_MS = 20_000;

async function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = OPERATION_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时（${Math.ceil(timeoutMs / 1000)}秒）`)), timeoutMs);
        timer.unref?.();
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function parseDocumentIsolated(fileName: string, bytes: Buffer, owner: ResourceOwner): Promise<ParseResult> {
  assertResourceOwner(owner);
  const codeLease = await getBootstrapPathStore().openDocumentParserWorker();
  try {
    await codeLease.assertCurrent("beforeProcessSpawn");
  } catch (error) {
    await codeLease.close();
    throw error;
  }
  return new Promise<ParseResult>((resolve, reject) => {
    let worker: Worker;
    try {
      worker = new Worker(codeLease.canonicalPath, { workerData: { fileName, bytes } });
    } catch (error) {
      void codeLease.close();
      reject(error);
      return;
    }
    let terminated = false;
    let codeLeaseClosed = false;
    const closeCodeLease = async (): Promise<void> => {
      if (codeLeaseClosed) return;
      codeLeaseClosed = true;
      await codeLease.close();
    };
    const terminate = async (): Promise<void> => {
      if (terminated) return;
      terminated = true;
      try { await worker.terminate(); }
      finally { await closeCodeLease(); }
    };
    let unregister: () => void = () => undefined;
    try {
      unregister = registerOwnedResource(owner, terminate);
    } catch (error) {
      void terminate();
      reject(error);
      return;
    }
    const timer = setTimeout(() => {
      settle(() => reject(new Error(`解析 Office 文件超时（${OPERATION_TIMEOUT_MS / 1000}秒）`)));
    }, OPERATION_TIMEOUT_MS);
    timer.unref?.();
    let settled = false;
    const settle = (action: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unregister();
      void terminate();
      action();
    };
    worker.once("online", () => {
      void closeCodeLease().catch(error => settle(() => reject(error)));
    });
    worker.once("message", (message: { ok: boolean; result?: ParseResult; error?: string }) => {
      settle(() => message.ok && message.result ? resolve(message.result) : reject(new Error(message.error || "Office 文件解析失败")));
    });
    worker.once("error", error => settle(() => reject(error)));
    worker.once("exit", code => {
      if (code !== 0) settle(() => reject(new Error(`Office 解析 Worker 异常退出（${code}）`)));
    });
  });
}

function detectText(buffer: Buffer): string {
  const utf8 = buffer.toString("utf8");
  return utf8.includes("\uFFFD") ? iconv.decode(buffer, "gbk") : utf8;
}

function extensionOf(filePath: string): string {
  const base = path.basename(filePath).toLowerCase();
  if (base === "dockerfile" || base === "makefile") return `.${base}`;
  return path.extname(base);
}

function languageFor(extension: string): string {
  return ({
    ".js": "javascript", ".mjs": "javascript", ".cjs": "javascript", ".jsx": "javascript",
    ".ts": "typescript", ".tsx": "typescript", ".py": "python", ".rs": "rust", ".go": "go",
    ".java": "java", ".c": "c", ".h": "c", ".cpp": "cpp", ".hpp": "cpp", ".cs": "csharp",
    ".html": "html", ".htm": "html", ".css": "css", ".scss": "scss", ".json": "json",
    ".xml": "xml", ".yaml": "yaml", ".yml": "yaml", ".sql": "sql", ".sh": "bash",
    ".bash": "bash", ".ps1": "powershell", ".bat": "dos", ".cmd": "dos", ".md": "markdown",
  } as Record<string, string>)[extension] || "plaintext";
}

function snapshotDate(nanoseconds: string): Date {
  const milliseconds = Number(BigInt(nanoseconds) / 1_000_000n);
  return new Date(milliseconds);
}

function snapshotSize(value: string, type: "file" | "directory"): number | null {
  if (type !== "file") return null;
  const size = Number(value);
  return Number.isSafeInteger(size) && size >= 0 ? size : null;
}

function normalizeRelative(relativePath: string): string {
  if (typeof relativePath !== "string") throw new TypeError("文件路径必须是字符串");
  return relativePath;
}

export class FileViewerService {
  readonly #bindings = new WeakMap<RuntimeAuthority, ViewerBinding>();

  bindAuthority(authority: RuntimeAuthority, parentPathAuthority: PathAuthority, roots: readonly FileRootSnapshotInput[]): void {
    if (this.#bindings.has(authority)) throw new Error("File Viewer authority is already bound");
    const availableRootIds = roots.filter(root => root.available).map(root => root.id);
    const pathAuthority = pathPolicy.deriveAuthority(parentPathAuthority, availableRootIds);
    this.#bindings.set(authority, Object.freeze({
      authority,
      pathAuthority,
      roots: Object.freeze(roots.map(root => Object.freeze({ ...root }))),
    }));
  }

  roots(authority: RuntimeAuthority): FileRootInfo[] {
    const binding = this.#binding(authority);
    return binding.roots.map(root => ({ id: root.id, name: root.name, path: root.configuredPath, available: root.available }));
  }

  async prepareRootEnrollment(authority: RuntimeAuthority, audit: PathAuditIdentity, absolutePath: string): Promise<PathDirectoryEnrollmentLease> {
    if (!path.isAbsolute(absolutePath)) throw new PathDeniedError("PATH_INPUT_INVALID", "Enrollment root must be absolute");
    const binding = this.#binding(authority);
    return pathPolicy.createDirectoryEnrollment(binding.pathAuthority, {
      input: absolutePath,
      operation: "create-directory",
      auditIdentity: audit,
    });
  }

  async list(authority: RuntimeAuthority, audit: PathAuditIdentity, rootId: string, relativePath = "", offset = 0, limit = 200): Promise<{
    root: FileRootInfo;
    path: string;
    parent: string | null;
    entries: FileEntry[];
    total: number;
    offset: number;
    limit: number;
    hasMore: boolean;
  }> {
    const binding = this.#binding(authority);
    const root = this.#root(binding, rootId);
    const input = normalizeRelative(relativePath);
    const directory = await withTimeout(pathPolicy.listDirectoryDirect(binding.pathAuthority, {
      input, operation: "read-directory", defaultRootId: root.id, auditIdentity: audit,
    }, 10_000), "读取目录");
    const allEntries = [...directory.entries].sort((left, right) => {
      if (left.type !== right.type) return left.type === "directory" ? -1 : 1;
      return left.name.localeCompare(right.name, "zh-CN", { numeric: true, sensitivity: "base" });
    });
    const safeOffset = Math.max(0, Math.trunc(offset) || 0);
    const safeLimit = Math.min(Math.max(Math.trunc(limit) || 200, 1), 500);
    const page = allEntries.slice(safeOffset, safeOffset + safeLimit);
    const entries: FileEntry[] = page.map(entry => {
      const relative = input ? path.join(input, entry.name) : entry.name;
      return {
        name: entry.name,
        path: relative,
        absolutePath: entry.canonicalPath,
        type: entry.type,
        size: snapshotSize(entry.snapshot.size, entry.type),
        modifiedAt: snapshotDate(entry.snapshot.mtimeNs).toISOString(),
        extension: entry.type === "file" ? extensionOf(entry.name) : "",
      };
    });
    return {
      root: this.#rootInfo(root),
      path: input,
      parent: input ? (path.dirname(input) === "." ? "" : path.dirname(input)) : null,
      entries,
      total: allEntries.length,
      offset: safeOffset,
      limit: safeLimit,
      hasMore: safeOffset + entries.length < allEntries.length,
    };
  }

  async preview(authority: RuntimeAuthority, audit: PathAuditIdentity, owner: ResourceOwner, rootId: string, relativePath: string, lineOffset = 1, lineLimit = 500): Promise<Record<string, unknown>> {
    const binding = this.#binding(authority);
    const root = this.#root(binding, rootId);
    this.#assertOwner(binding, owner, root.id);
    const input = normalizeRelative(relativePath);
    const requestedExtension = extensionOf(input);

    if (OFFICE_EXTENSIONS.has(requestedExtension)) {
      const read = await pathPolicy.readFileDirect(binding.pathAuthority, {
        input, operation: "read-file", defaultRootId: root.id, auditIdentity: audit,
      }, MAX_OFFICE_BYTES);
      const parsed = await parseDocumentIsolated(path.basename(read.canonicalPath), read.bytes, owner);
      if (!parsed.success) throw new Error(parsed.error || "Office 文件解析失败");
      return { ...this.#fileBase(root, input, read), ...this.#paginateText(parsed.text, lineOffset, lineLimit), kind: "office" satisfies PreviewKind, language: "plaintext" };
    }

    if (TEXT_EXTENSIONS.has(requestedExtension) || path.basename(input).startsWith(".")) {
      const read = await pathPolicy.readFileDirect(binding.pathAuthority, {
        input, operation: "read-file", defaultRootId: root.id, auditIdentity: audit,
      }, MAX_TEXT_BYTES);
      const extension = extensionOf(read.canonicalPath);
      let text = detectText(read.bytes);
      if (extension === ".json") {
        try { text = JSON.stringify(JSON.parse(text), null, 2); }
        catch { /* Preserve original text. */ }
      }
      return {
        ...this.#fileBase(root, input, read),
        ...this.#paginateText(text, lineOffset, lineLimit),
        kind: MARKDOWN_EXTENSIONS.has(extension) ? "markdown" satisfies PreviewKind : "text" satisfies PreviewKind,
        language: languageFor(extension),
      };
    }

    const qualified = await pathPolicy.qualifyExisting(binding.pathAuthority, {
      input, operation: "read-file", defaultRootId: root.id, auditIdentity: audit,
    }, "file");
    const extension = extensionOf(qualified.canonicalPath);
    const size = snapshotSize(qualified.snapshot.size, "file") ?? 0;
    const base = this.#fileBase(root, input, qualified);
    if (IMAGE_MIME[extension]) {
      if (size > MAX_MEDIA_BYTES) throw new Error("图片超过 100MB，无法预览");
      return { ...base, kind: "image" satisfies PreviewKind, mime: IMAGE_MIME[extension], contentUrl: this.#contentUrl(root.id, input) };
    }
    if (extension === ".pdf") {
      if (size > MAX_MEDIA_BYTES) throw new Error("PDF 超过 100MB，无法内嵌预览");
      return { ...base, kind: "pdf" satisfies PreviewKind, mime: "application/pdf", contentUrl: this.#contentUrl(root.id, input) };
    }
    return { ...base, kind: "unsupported" satisfies PreviewKind, message: `暂不支持预览 ${extension || "无扩展名"} 文件` };
  }

  async content(authority: RuntimeAuthority, audit: PathAuditIdentity, owner: ResourceOwner, rootId: string, relativePath: string): Promise<FileContentLease> {
    const binding = this.#binding(authority);
    const root = this.#root(binding, rootId);
    this.#assertOwner(binding, owner, root.id);
    const input = normalizeRelative(relativePath);
    const lease = await pathPolicy.openReadLease(binding.pathAuthority, {
      input, operation: "read-file", defaultRootId: root.id, auditIdentity: audit,
    }, MAX_MEDIA_BYTES);
    let unregister: () => void = () => undefined;
    let closePromise: Promise<void> | null = null;
    const close = (): Promise<void> => {
      if (closePromise) return closePromise;
      unregister();
      closePromise = lease.close();
      return closePromise;
    };
    try {
      unregister = registerOwnedResource(owner, close);
      const extension = extensionOf(lease.canonicalPath);
      const mime = IMAGE_MIME[extension] || (extension === ".pdf" ? "application/pdf" : "");
      if (!mime) throw new Error("该文件类型不允许通过预览内容接口读取");
      if (lease.size === 0) throw new Error("空文件无法作为媒体预览");
      return Object.freeze({
        absolutePath: lease.canonicalPath,
        name: path.basename(lease.canonicalPath),
        size: lease.size,
        mime,
        modifiedAt: snapshotDate(lease.snapshot.mtimeNs),
        readRange: (start: number, end: number) => {
          assertResourceOwner(owner);
          return lease.readRange(start, end);
        },
        close,
      });
    } catch (error) {
      await close();
      throw error;
    }
  }

  async resolveAbsolute(authority: RuntimeAuthority, audit: PathAuditIdentity, absolutePath: string): Promise<{ rootId: FileRootId; path: string; root: FileRootInfo; type: "directory" | "file" }> {
    if (!path.isAbsolute(absolutePath)) throw new Error("需要绝对路径");
    const binding = this.#binding(authority);
    const qualified = await pathPolicy.qualifyExisting(binding.pathAuthority, {
      input: absolutePath, operation: "read-file", auditIdentity: audit,
    });
    const root = this.#root(binding, qualified.rootId);
    const relative = path.relative(path.resolve(root.configuredPath), qualified.canonicalPath);
    return { rootId: root.id, path: relative, root: this.#rootInfo(root), type: qualified.identity.type };
  }

  async reveal(authority: RuntimeAuthority, audit: PathAuditIdentity, rootId: string, relativePath: string): Promise<{ absolutePath: string }> {
    const binding = this.#binding(authority);
    const root = this.#root(binding, rootId);
    const input = normalizeRelative(relativePath);
    return pathPolicy.withReveal(binding.pathAuthority, {
      input, operation: "reveal", defaultRootId: root.id, auditIdentity: audit,
    }, async (canonicalPath, type) => {
      const executable = await getBootstrapPathStore().openRevealLauncher();
      try {
        await executable.assertCurrent("beforeProcessSpawn");
        const args = process.platform === "win32"
          ? (type === "directory" ? [canonicalPath] : [`/select,${canonicalPath}`])
          : process.platform === "darwin"
            ? (type === "directory" ? [canonicalPath] : ["-R", canonicalPath])
            : [type === "directory" ? canonicalPath : path.dirname(canonicalPath)];
        await new Promise<void>((resolve, reject) => {
          const child = spawn(executable.canonicalPath, args, { detached: true, shell: false, stdio: "ignore", windowsHide: false });
          child.once("spawn", () => { child.unref(); resolve(); });
          child.once("error", reject);
        });
      } finally {
        await executable.close();
      }
      return { absolutePath: canonicalPath };
    });
  }

  #assertOwner(binding: ViewerBinding, owner: ResourceOwner, rootId: string): void {
    const metadata = assertResourceOwner(owner);
    if (metadata.authorityId !== binding.authority.authorityId || !metadata.rootIds.includes(rootId)) {
      throw new PathDeniedError("PATH_AUTHORITY_FORGED", "File Viewer resource owner denied");
    }
  }

  #binding(authority: RuntimeAuthority): ViewerBinding {
    const binding = authority && this.#bindings.get(authority);
    if (!binding || binding.authority !== authority || !pathPolicy.isActive(binding.pathAuthority)) throw new Error("File Viewer authority is unavailable");
    return binding;
  }

  #root(binding: ViewerBinding, rootId: string): FileRootSnapshotInput {
    const root = binding.roots.find(candidate => candidate.id === rootId);
    if (!root || !root.available || !binding.pathAuthority.rootIds.includes(root.id)) throw new Error(`文件根目录不可用: ${rootId}`);
    return root;
  }

  #rootInfo(root: FileRootSnapshotInput): FileRootInfo {
    return { id: root.id, name: root.name, path: root.configuredPath, available: root.available };
  }

  #fileBase(root: FileRootSnapshotInput, relativePath: string, qualified: PathQualifiedResult): Record<string, unknown> {
    const extension = extensionOf(qualified.canonicalPath);
    return {
      root: this.#rootInfo(root),
      path: relativePath,
      absolutePath: qualified.canonicalPath,
      name: path.basename(qualified.canonicalPath),
      extension,
      size: snapshotSize(qualified.snapshot.size, "file") ?? 0,
      modifiedAt: snapshotDate(qualified.snapshot.mtimeNs).toISOString(),
    };
  }

  #paginateText(text: string, lineOffset: number, lineLimit: number): Record<string, unknown> {
    const lines = text.replace(/\r\n/gu, "\n").split("\n");
    const offset = Math.max(1, Math.trunc(lineOffset) || 1);
    const limit = Math.min(Math.max(Math.trunc(lineLimit) || 500, 1), 2000);
    const start = Math.min(lines.length, offset - 1);
    const selected = lines.slice(start, start + limit);
    return { text: selected.join("\n"), lineOffset: offset, lineEnd: start + selected.length, totalLines: lines.length, hasMore: start + selected.length < lines.length };
  }

  #contentUrl(rootId: string, relativePath: string): string {
    return `/api/files/content?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(relativePath)}`;
  }
}

export const fileViewerService = new FileViewerService();
