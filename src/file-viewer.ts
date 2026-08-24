// ===========================================
// File Viewer — direct-local runtime authority snapshot
// ===========================================

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import iconv from "iconv-lite";
import { getBootstrapPathStore } from "./bootstrap-path-store.js";
import type { RuntimeAuthority } from "./capability-broker.js";
import { PathDeniedError, type PathAuditIdentity, type PathAuthority, type PathDirectoryEnrollmentLease, type PathQualifiedResult, type PathReadLease } from "./path-policy.js";
import { pathPolicy } from "./path-runtime.js";
import { assertResourceOwner, registerOwnedResource, type ResourceOwner } from "./resource-owner.js";
import { parseDocumentIsolated } from "./document-parser.js";

export type FileRootId = "workspace" | "department" | "output";
export type PreviewKind = "text" | "markdown" | "html" | "office" | "image" | "pdf" | "audio" | "video" | "unsupported";

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

export interface FileWatchLease {
  readonly revision: string;
  readonly close: () => Promise<void>;
}

export class FileEditConflictError extends Error {
  readonly currentRevision: string | null;
  constructor(currentRevision: string | null) {
    super("File changed outside the editor");
    this.name = "FileEditConflictError";
    this.currentRevision = currentRevision;
  }
}

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".csv", ".log", ".json", ".jsonl", ".xml", ".yaml", ".yml",
  ".toml", ".ini", ".conf", ".config", ".env", ".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx",
  ".css", ".scss", ".less", ".html", ".htm", ".vue", ".svelte", ".py", ".java", ".c", ".h",
  ".cpp", ".hpp", ".cs", ".go", ".rs", ".php", ".rb", ".sh", ".bash", ".ps1", ".bat", ".cmd",
  ".sql", ".graphql", ".gql", ".dockerfile", ".gitignore", ".npmrc",
]);
const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const HTML_EXTENSIONS = new Set([".html", ".htm"]);
const OFFICE_EXTENSIONS = new Set([".docx", ".xlsx", ".xls"]);
const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
  ".webp": "image/webp", ".bmp": "image/bmp",
};
const AUDIO_MIME: Record<string, string> = {
  ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav", ".ogg": "audio/ogg", ".oga": "audio/ogg",
};
const VIDEO_MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".webm": "video/webm", ".ogv": "video/ogg", ".mov": "video/quicktime",
};
const MAX_TEXT_BYTES = 5 * 1024 * 1024;
const MAX_EDIT_BYTES = 1024 * 1024;
const MAX_HTML_PREVIEW_BYTES = 1024 * 1024;
const MAX_PREVIEW_CHARACTERS = 128 * 1024;
const MAX_VIRTUAL_LINE_CHARACTERS = 16 * 1024;
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

function detectText(buffer: Buffer): Readonly<{ text: string; encoding: "utf-8" | "gbk" }> {
  try { return Object.freeze({ text: new TextDecoder("utf-8", { fatal: true }).decode(buffer), encoding: "utf-8" }); }
  catch { return Object.freeze({ text: iconv.decode(buffer, "gbk"), encoding: "gbk" }); }
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

function fileWatchRevision(qualified: PathQualifiedResult): string {
  return createHash("sha256").update([
    qualified.identity.deviceId,
    qualified.identity.objectId,
    qualified.snapshot.size,
    qualified.snapshot.mtimeNs,
    qualified.snapshot.ctimeNs,
    qualified.snapshot.linkCount,
  ].join("\0")).digest("hex");
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
      const decoded = detectText(read.bytes);
      let displayText = decoded.text;
      if (extension === ".json") {
        try { displayText = JSON.stringify(JSON.parse(decoded.text), null, 2); }
        catch { /* Preserve invalid JSON as source text. */ }
      }
      const revision = createHash("sha256").update(read.bytes).digest("hex");
      const editable = read.bytes.length <= MAX_EDIT_BYTES;
      const kind: PreviewKind = HTML_EXTENSIONS.has(extension)
        ? "html"
        : MARKDOWN_EXTENSIONS.has(extension)
          ? "markdown"
          : "text";
      return {
        ...this.#fileBase(root, input, read),
        ...this.#paginateText(displayText, lineOffset, lineLimit),
        kind,
        language: languageFor(extension),
        encoding: decoded.encoding,
        revision,
        editable,
        fullText: editable ? decoded.text : null,
        html: kind === "html" && read.bytes.length <= MAX_HTML_PREVIEW_BYTES ? decoded.text : null,
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
    if (AUDIO_MIME[extension]) {
      if (size > MAX_MEDIA_BYTES) throw new Error("音频超过 100MB，无法预览");
      return { ...base, kind: "audio" satisfies PreviewKind, mime: AUDIO_MIME[extension], contentUrl: this.#contentUrl(root.id, input) };
    }
    if (VIDEO_MIME[extension]) {
      if (size > MAX_MEDIA_BYTES) throw new Error("视频超过 100MB，无法预览");
      return { ...base, kind: "video" satisfies PreviewKind, mime: VIDEO_MIME[extension], contentUrl: this.#contentUrl(root.id, input) };
    }
    return { ...base, kind: "unsupported" satisfies PreviewKind, message: `暂不支持预览 ${extension || "无扩展名"} 文件` };
  }

  async saveText(
    authority: RuntimeAuthority,
    audit: PathAuditIdentity,
    owner: ResourceOwner,
    rootId: string,
    relativePath: string,
    expectedRevision: string,
    text: string,
    encoding: "utf-8" | "gbk"
  ): Promise<{ revision: string; size: number }> {
    const binding = this.#binding(authority);
    const root = this.#root(binding, rootId);
    this.#assertOwner(binding, owner, root.id);
    const input = normalizeRelative(relativePath);
    if (!TEXT_EXTENSIONS.has(extensionOf(input)) && !path.basename(input).startsWith(".")) throw new TypeError("该文件类型不可编辑");
    if (!/^[a-f0-9]{64}$/u.test(expectedRevision)) throw new TypeError("文件 revision 无效");
    if (typeof text !== "string") throw new TypeError("文件内容必须是字符串");
    if (encoding !== "utf-8" && encoding !== "gbk") throw new TypeError("文件编码无效");
    const output = encoding === "gbk" ? iconv.encode(text, "gbk") : Buffer.from(text, "utf8");
    if (output.length > MAX_EDIT_BYTES) throw new TypeError("编辑内容超过 1MB");
    const revision = createHash("sha256").update(output).digest("hex");
    const result = await pathPolicy.replaceFile<{ conflictRevision: string | null }>(binding.pathAuthority, {
      input, operation: "replace-file", defaultRootId: root.id, auditIdentity: audit,
    }, current => {
      const currentRevision = createHash("sha256").update(current).digest("hex");
      if (currentRevision !== expectedRevision) {
        return Object.freeze({ bytes: null, value: Object.freeze({ conflictRevision: currentRevision }) });
      }
      return Object.freeze({ bytes: output, value: Object.freeze({ conflictRevision: null }) });
    }, MAX_EDIT_BYTES);
    if (result.value.conflictRevision) throw new FileEditConflictError(result.value.conflictRevision);
    return Object.freeze({ revision, size: output.length });
  }

  async watch(
    authority: RuntimeAuthority,
    audit: PathAuditIdentity,
    owner: ResourceOwner,
    rootId: string,
    relativePath: string,
    publish: (event: Readonly<{ type: "file_added" | "file_changed" | "file_removed"; timestamp: number }>) => void | Promise<void>
  ): Promise<FileWatchLease> {
    const binding = this.#binding(authority);
    const root = this.#root(binding, rootId);
    this.#assertOwner(binding, owner, root.id);
    if (typeof publish !== "function") throw new TypeError("文件 watcher publish 无效");
    const input = normalizeRelative(relativePath);
    const target = await pathPolicy.qualifyExisting(binding.pathAuthority, {
      input, operation: "read-file", defaultRootId: root.id, auditIdentity: audit,
    }, "file");
    const parent = path.dirname(input) === "." ? "" : path.dirname(input);
    const targetIdentity = process.platform === "win32" ? target.canonicalPath.toLowerCase() : target.canonicalPath;
    let unregister: () => void = () => undefined;
    let closePromise: Promise<void> | null = null;
    const lease = await pathPolicy.watchDirectory(binding.pathAuthority, {
      input: parent, operation: "watch-directory", defaultRootId: root.id, auditIdentity: audit,
    }, async event => {
      const eventIdentity = process.platform === "win32" ? event.path.toLowerCase() : event.path;
      if (eventIdentity !== targetIdentity) return;
      assertResourceOwner(owner);
      await publish(Object.freeze({ type: event.type, timestamp: event.timestamp }));
    });
    let current: PathQualifiedResult;
    try {
      current = await pathPolicy.qualifyExisting(binding.pathAuthority, {
        input, operation: "read-file", defaultRootId: root.id, auditIdentity: audit,
      }, "file");
      const currentIdentity = process.platform === "win32" ? current.canonicalPath.toLowerCase() : current.canonicalPath;
      if (currentIdentity !== targetIdentity) throw new PathDeniedError("PATH_IDENTITY_CHANGED", "Watched file identity changed");
    } catch (error) {
      await lease.close();
      throw error;
    }
    const revision = fileWatchRevision(current);
    const close = (): Promise<void> => {
      if (closePromise) return closePromise;
      unregister();
      closePromise = lease.close();
      return closePromise;
    };
    try {
      unregister = registerOwnedResource(owner, close);
      return Object.freeze({ revision, close });
    } catch (error) {
      await close();
      throw error;
    }
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
      const mime = IMAGE_MIME[extension] || AUDIO_MIME[extension] || VIDEO_MIME[extension] || (extension === ".pdf" ? "application/pdf" : "");
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
    const canonicalRoot = await pathPolicy.qualifyExisting(binding.pathAuthority, {
      input: "", operation: "read-file", defaultRootId: root.id, auditIdentity: audit,
    }, "directory");
    const relative = path.relative(canonicalRoot.canonicalPath, qualified.canonicalPath);
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
      watchRevision: fileWatchRevision(qualified),
    };
  }

  #paginateText(text: string, lineOffset: number, lineLimit: number): Record<string, unknown> {
    const lines = text.replace(/\r\n/gu, "\n").split("\n").flatMap(line => {
      if (line.length <= MAX_VIRTUAL_LINE_CHARACTERS) return [line];
      const chunks: string[] = [];
      for (let offset = 0; offset < line.length; offset += MAX_VIRTUAL_LINE_CHARACTERS) {
        chunks.push(line.slice(offset, offset + MAX_VIRTUAL_LINE_CHARACTERS));
      }
      return chunks;
    });
    const offset = Math.max(1, Math.trunc(lineOffset) || 1);
    const limit = Math.min(Math.max(Math.trunc(lineLimit) || 500, 1), 2000);
    const start = Math.min(lines.length, offset - 1);
    const selected: string[] = [];
    let characters = 0;
    for (let index = start; index < lines.length && selected.length < limit; index += 1) {
      const next = lines[index];
      if (selected.length > 0 && characters + 1 + next.length > MAX_PREVIEW_CHARACTERS) break;
      selected.push(next);
      characters += next.length + (selected.length > 1 ? 1 : 0);
    }
    return {
      text: selected.join("\n"),
      lineOffset: offset,
      lineEnd: start + selected.length,
      totalLines: lines.length,
      hasMore: start + selected.length < lines.length,
      virtualized: lines.some(line => line.length === MAX_VIRTUAL_LINE_CHARACTERS),
    };
  }

  #contentUrl(rootId: string, relativePath: string): string {
    return `/api/files/content?root=${encodeURIComponent(rootId)}&path=${encodeURIComponent(relativePath)}`;
  }
}

export const fileViewerService = new FileViewerService();
