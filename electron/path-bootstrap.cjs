"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");

class ElectronPathError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ElectronPathError";
    this.code = code;
  }
}

function deny(code, role) {
  throw new ElectronPathError(code, `Electron bootstrap path denied for ${role}`);
}

function validateAbsoluteSyntax(candidate, role) {
  if (typeof candidate !== "string" || !candidate || candidate.includes("\0") || !path.isAbsolute(candidate)) {
    deny("PATH_INPUT_INVALID", role);
  }
  if (process.platform === "win32") {
    const normalized = candidate.replaceAll("/", "\\");
    if (/^\\\\[?.]\\/u.test(normalized) || /^\\[?]\\/u.test(normalized)) deny("PATH_NAMESPACE_DENIED", role);
    const parsed = path.win32.parse(normalized);
    for (const segment of normalized.slice(parsed.root.length).split("\\").filter(Boolean)) {
      if (segment.includes(":")) deny("PATH_INPUT_INVALID", role);
      if (/[. ]$/u.test(segment)) deny("PATH_INPUT_INVALID", role);
    }
  }
  return path.resolve(candidate);
}

function validateRelativeSyntax(relative, role) {
  if (typeof relative !== "string" || !relative || relative.includes("\0") || path.isAbsolute(relative)) {
    deny("PATH_INPUT_INVALID", role);
  }
  const segments = relative.split(/[\\/]/u);
  if (segments.some(segment => !segment || segment === "." || segment === ".." || segment.includes(":"))) {
    deny("PATH_INPUT_INVALID", role);
  }
  if (process.platform === "win32" && segments.some(segment => /[. ]$/u.test(segment))) {
    deny("PATH_INPUT_INVALID", role);
  }
  return segments.join(path.sep);
}

function pathContained(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function exactIdentity(info) {
  return Object.freeze({
    dev: String(info.dev),
    ino: String(info.ino),
    mode: String(info.mode),
    type: info.isFile() ? "file" : info.isDirectory() ? "directory" : "other",
    birthtimeNs: String(info.birthtimeNs ?? BigInt(Math.trunc(info.birthtimeMs * 1_000_000))),
  });
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.type === right.type
    && left.birthtimeNs === right.birthtimeNs;
}

function mutableSnapshot(info) {
  return Object.freeze({
    size: String(info.size),
    mtimeNs: String(info.mtimeNs ?? BigInt(Math.trunc(info.mtimeMs * 1_000_000))),
  });
}

function descriptorDigest(io, descriptor, size) {
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let offset = 0;
  while (offset < size) {
    const count = io.readSync(descriptor, buffer, 0, Math.min(buffer.length, size - offset), offset);
    if (count === 0) deny("PATH_IDENTITY_CHANGED", "content-digest");
    hash.update(buffer.subarray(0, count));
    offset += count;
  }
  return hash.digest("hex");
}

function fileSnapshot(io, descriptor, info) {
  const mutable = mutableSnapshot(info);
  const size = Number(info.size);
  if (!Number.isSafeInteger(size) || size < 0) deny("PATH_SIZE_DENIED", "content-digest");
  return Object.freeze({ ...mutable, sha256: descriptorDigest(io, descriptor, size) });
}

function sameMutableSnapshot(left, right) {
  return left.size === right.size && left.mtimeNs === right.mtimeNs;
}

function sameSnapshot(left, right) {
  return sameMutableSnapshot(left, right) && left.sha256 === right.sha256;
}

function assertNoRedirectComponents(absolute, role, io = fs) {
  const parsed = path.parse(absolute);
  let cursor = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    const info = io.lstatSync(cursor, { bigint: true });
    if (info.isSymbolicLink()) deny("PATH_REDIRECT_DENIED", role);
  }
}

function canonicalDirectory(candidate, role, io = fs) {
  const absolute = validateAbsoluteSyntax(candidate, role);
  assertNoRedirectComponents(absolute, role, io);
  const canonical = io.realpathSync(absolute);
  const info = io.statSync(canonical, { bigint: true });
  if (!info.isDirectory()) deny("PATH_TYPE_DENIED", role);
  return Object.freeze({ canonical, identity: exactIdentity(info), io });
}

function verifyDirectory(record, role) {
  const io = record.io;
  assertNoRedirectComponents(record.canonical, role, io);
  const canonical = io.realpathSync(record.canonical);
  const info = io.statSync(canonical, { bigint: true });
  if (canonical !== record.canonical || !sameIdentity(record.identity, exactIdentity(info))) {
    deny("PATH_IDENTITY_CHANGED", role);
  }
}

function openFileAt(rootRecord, relative, role, barrier) {
  const io = rootRecord.io;
  verifyDirectory(rootRecord, role);
  const safeRelative = validateRelativeSyntax(relative, role);
  const lexical = path.join(rootRecord.canonical, safeRelative);
  if (!pathContained(rootRecord.canonical, lexical)) deny("PATH_ROOT_DENIED", role);
  assertNoRedirectComponents(lexical, role, io);
  const canonical = io.realpathSync(lexical);
  if (!pathContained(rootRecord.canonical, canonical)) deny("PATH_ROOT_DENIED", role);
  const descriptor = io.openSync(canonical, "r");
  try {
    const handleInfo = io.fstatSync(descriptor, { bigint: true });
    const pathInfo = io.statSync(canonical, { bigint: true });
    const identity = exactIdentity(handleInfo);
    const snapshot = fileSnapshot(io, descriptor, handleInfo);
    if (!handleInfo.isFile()
      || !sameIdentity(identity, exactIdentity(pathInfo))
      || !sameMutableSnapshot(snapshot, mutableSnapshot(pathInfo))) deny("PATH_IDENTITY_CHANGED", role);
    return new ElectronFileLease({ descriptor, canonical, identity, snapshot, rootRecord, relative: safeRelative, role, barrier, io });
  } catch (error) {
    io.closeSync(descriptor);
    throw error;
  }
}

class ElectronFileLease {
  #descriptor;
  #canonical;
  #identity;
  #snapshot;
  #rootRecord;
  #relative;
  #role;
  #barrier;
  #io;
  #closed = false;

  constructor({ descriptor, canonical, identity, snapshot, rootRecord, relative, role, barrier, io }) {
    this.#descriptor = descriptor;
    this.#canonical = canonical;
    this.#identity = identity;
    this.#snapshot = snapshot;
    this.#rootRecord = rootRecord;
    this.#relative = relative;
    this.#role = role;
    this.#barrier = barrier;
    this.#io = io;
  }

  get canonicalPath() {
    this.#assertOpen();
    return this.#canonical;
  }

  readBytes(maxBytes) {
    this.#assertOpen();
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError("maxBytes is invalid");
    const before = this.#io.fstatSync(this.#descriptor, { bigint: true });
    if (!sameSnapshot(this.#snapshot, fileSnapshot(this.#io, this.#descriptor, before))) deny("PATH_IDENTITY_CHANGED", this.#role);
    if (before.size > BigInt(maxBytes)) deny("PATH_SIZE_DENIED", this.#role);
    const bytes = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = this.#io.readSync(this.#descriptor, bytes, offset, bytes.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = this.#io.fstatSync(this.#descriptor, { bigint: true });
    if (offset !== bytes.length || !sameSnapshot(this.#snapshot, fileSnapshot(this.#io, this.#descriptor, after))) {
      deny("PATH_IDENTITY_CHANGED", this.#role);
    }
    return bytes;
  }

  verify(point = "verify") {
    this.#assertOpen();
    if (typeof point !== "string" || !/^[a-z0-9][a-z0-9-]{0,63}$/u.test(point)) throw new TypeError("verification point is invalid");
    this.#barrier(point, this.#role);
    verifyDirectory(this.#rootRecord, this.#role);
    const lexical = path.join(this.#rootRecord.canonical, this.#relative);
    assertNoRedirectComponents(lexical, this.#role, this.#io);
    const canonical = this.#io.realpathSync(lexical);
    const pathInfo = this.#io.statSync(canonical, { bigint: true });
    const handleInfo = this.#io.fstatSync(this.#descriptor, { bigint: true });
    if (canonical !== this.#canonical
      || !sameIdentity(this.#identity, exactIdentity(pathInfo))
      || !sameIdentity(this.#identity, exactIdentity(handleInfo))
      || !sameMutableSnapshot(this.#snapshot, mutableSnapshot(pathInfo))
      || !sameSnapshot(this.#snapshot, fileSnapshot(this.#io, this.#descriptor, handleInfo))) {
      deny("PATH_IDENTITY_CHANGED", this.#role);
    }
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#io.closeSync(this.#descriptor);
  }

  #assertOpen() {
    if (this.#closed) deny("PATH_LEASE_CLOSED", this.#role);
  }
}

class ElectronArchiveFileLease {
  #archiveLease;
  #archiveFs;
  #canonical;
  #role;
  #closed = false;

  constructor({ archiveLease, archiveFs, archivePath, relative, role }) {
    const safeRelative = validateRelativeSyntax(relative, role);
    this.#archiveLease = archiveLease;
    this.#archiveFs = archiveFs;
    this.#canonical = path.join(archivePath, safeRelative);
    this.#role = role;
  }

  get canonicalPath() {
    this.#assertOpen();
    return this.#canonical;
  }

  readBytes(maxBytes) {
    this.#assertOpen();
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new TypeError("maxBytes is invalid");
    this.#archiveLease.verify("before-archive-read");
    const info = this.#archiveFs.statSync(this.#canonical, { bigint: true });
    if (!info.isFile() || info.size > BigInt(maxBytes)) deny(info.isFile() ? "PATH_SIZE_DENIED" : "PATH_TYPE_DENIED", this.#role);
    const bytes = this.#archiveFs.readFileSync(this.#canonical);
    if (!Buffer.isBuffer(bytes) || bytes.length !== Number(info.size)) deny("PATH_IDENTITY_CHANGED", this.#role);
    this.#archiveLease.verify("after-archive-read");
    return bytes;
  }

  verify(point = "verify") {
    this.#assertOpen();
    this.#archiveLease.verify(point);
    const info = this.#archiveFs.statSync(this.#canonical, { bigint: true });
    if (!info.isFile()) deny("PATH_TYPE_DENIED", this.#role);
  }

  close() {
    this.#closed = true;
  }

  #assertOpen() {
    if (this.#closed) deny("PATH_LEASE_CLOSED", this.#role);
  }
}

function samePath(left, right) {
  return process.platform === "win32" ? left.toLowerCase() === right.toLowerCase() : left === right;
}

class ElectronBootstrapPathStore {
  #appRoot;
  #electronRoot;
  #userDataRoot;
  #barrier;
  #nativeFs;
  #archiveFs;
  #archiveLease = null;
  #archivePath = null;
  #runtimeAppRoot = null;
  #closed = false;

  constructor({ appRoot, electronRoot, userDataRoot, barrier = () => undefined, nativeFs = fs, archiveFs = fs }) {
    if (typeof barrier !== "function") throw new TypeError("Electron bootstrap barrier is invalid");
    this.#barrier = barrier;
    this.#nativeFs = nativeFs;
    this.#archiveFs = archiveFs;
    const appAbsolute = validateAbsoluteSyntax(appRoot, "app-root");
    assertNoRedirectComponents(appAbsolute, "app-root", nativeFs);
    const appInfo = nativeFs.lstatSync(appAbsolute, { bigint: true });
    if (appInfo.isDirectory()) {
      this.#appRoot = canonicalDirectory(appAbsolute, "app-root", nativeFs);
      this.#electronRoot = canonicalDirectory(electronRoot, "electron-root", nativeFs);
    } else if (appInfo.isFile() && path.extname(appAbsolute).toLowerCase() === ".asar") {
      const parent = canonicalDirectory(path.dirname(appAbsolute), "app-asar-parent", nativeFs);
      this.#archiveLease = openFileAt(parent, path.basename(appAbsolute), "app-asar", barrier);
      this.#archivePath = this.#archiveLease.canonicalPath;
      this.#runtimeAppRoot = canonicalDirectory(`${this.#archivePath}.unpacked`, "app-runtime-projection", nativeFs);
      const expectedElectronRoot = path.join(this.#archivePath, "electron");
      if (!samePath(path.resolve(electronRoot), expectedElectronRoot)) deny("PATH_ROOT_DENIED", "electron-root");
      this.#appRoot = null;
      this.#electronRoot = null;
    } else deny("PATH_TYPE_DENIED", "app-root");
    this.#userDataRoot = canonicalDirectory(userDataRoot, "user-data-root", nativeFs);
  }

  openAppFile(relative, role = "app-file") {
    this.#assertOpen();
    if (this.#archiveLease) return new ElectronArchiveFileLease({ archiveLease: this.#archiveLease, archiveFs: this.#archiveFs, archivePath: this.#archivePath, relative, role });
    return openFileAt(this.#appRoot, relative, role, this.#barrier);
  }

  openElectronFile(relative, role = "electron-file") {
    this.#assertOpen();
    if (this.#archiveLease) return new ElectronArchiveFileLease({ archiveLease: this.#archiveLease, archiveFs: this.#archiveFs, archivePath: this.#archivePath, relative: path.join("electron", relative), role });
    return openFileAt(this.#electronRoot, relative, role, this.#barrier);
  }

  openExternalBootstrapExecutable(candidate, role) {
    this.#assertOpen();
    const absolute = validateAbsoluteSyntax(candidate, role);
    const parent = canonicalDirectory(path.dirname(absolute), `${role}-parent`, this.#nativeFs);
    return openFileAt(parent, path.basename(absolute), role, this.#barrier);
  }

  openExternalTestExecutable(candidate) {
    return this.openExternalBootstrapExecutable(candidate, "e2e-node-executable");
  }

  async withAppDirectory(relative, role, use) {
    this.#assertOpen();
    if (this.#archiveLease) deny("PATH_TYPE_DENIED", role);
    const safeRelative = validateRelativeSyntax(relative, role);
    const lexical = path.join(this.#appRoot.canonical, safeRelative);
    if (!pathContained(this.#appRoot.canonical, lexical)) deny("PATH_ROOT_DENIED", role);
    const record = canonicalDirectory(lexical, role, this.#nativeFs);
    if (!pathContained(this.#appRoot.canonical, record.canonical)) deny("PATH_ROOT_DENIED", role);
    const value = await use(record.canonical);
    verifyDirectory(record, role);
    return value;
  }

  async withAppRootDirectory(role, use) {
    this.#assertOpen();
    if (this.#archiveLease) deny("PATH_TYPE_DENIED", role);
    verifyDirectory(this.#appRoot, role);
    const value = await use(this.#appRoot.canonical);
    verifyDirectory(this.#appRoot, role);
    return value;
  }

  runtimeRoots() {
    this.#assertOpen();
    if (this.#archiveLease) {
      this.#archiveLease.verify("runtime-roots");
      verifyDirectory(this.#runtimeAppRoot, "app-runtime-projection");
    } else verifyDirectory(this.#appRoot, "app-root");
    verifyDirectory(this.#userDataRoot, "user-data-root");
    return Object.freeze({ appRoot: this.#runtimeAppRoot?.canonical ?? this.#appRoot.canonical, userData: this.#userDataRoot.canonical });
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.#archiveLease?.close();
  }

  #assertOpen() {
    if (this.#closed) deny("PATH_LEASE_CLOSED", "bootstrap-store");
  }
}

module.exports = Object.freeze({ ElectronBootstrapPathStore, ElectronPathError });
