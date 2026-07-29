import assert from "node:assert/strict";
import { AsyncLocalStorage, createHook } from "node:async_hooks";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { capabilityBroker } from "../../dist/tools/index.js";
import { fileViewerService } from "../../dist/file-viewer.js";
import { PathDeniedError } from "../../dist/path-policy.js";
import { pathPolicy } from "../../dist/path-runtime.js";
import { issueResourceOwner, registerOwnedResource, retireResourceOwner } from "../../dist/resource-owner.js";
import { createSec02Recorder } from "../sec02-receipts.mjs";

const permissions = Object.freeze([
  "read-file", "read-directory", "search-tree", "create-file", "replace-file",
  "create-directory", "watch-directory", "initial-cwd", "reveal",
]);
const audit = Object.freeze({ sessionId: "sec02-file-viewer", runId: "direct-integration", principal: "local-user-api" });
const viewerRecorder = await createSec02Recorder(import.meta.url, "SEC-02 File Viewer uses one authority snapshot for list, preview, resolve and range handles");
const auditKeys = ["authorityEpoch", "code", "event", "inputFingerprint", "operation", "operationId", "principal", "rootId", "runId", "sessionId", "timestamp"].sort();
const processContext = new AsyncLocalStorage();

test.after(async () => viewerRecorder.close());

async function captureDeniedOperation(action, rawInput, sentinelPath) {
  const events = [];
  const before = await fs.readFile(sentinelPath);
  const originalWarn = console.warn;
  let processStarts = 0;
  let result;
  let error;
  const hook = createHook({
    init(_asyncId, type) {
      if (processContext.getStore() === true && type === "PROCESSWRAP") processStarts += 1;
    },
  });
  console.warn = (...args) => {
    try {
      const parsed = JSON.parse(String(args[0]));
      if (parsed?.component === "path-policy") {
        const { component: _component, ...event } = parsed;
        events.push(event);
        return;
      }
    } catch { /* Preserve unrelated console output. */ }
    originalWarn(...args);
  };
  hook.enable();
  try {
    result = await processContext.run(true, action);
  } catch (caught) {
    error = caught;
  } finally {
    hook.disable();
    console.warn = originalWarn;
  }
  const after = await fs.readFile(sentinelPath);
  return {
    error,
    events,
    processStarts,
    rootEscapeDenied: error instanceof PathDeniedError && before.equals(after),
    stringPathReopen: result !== undefined,
    sideEffects: before.equals(after) ? 0 : 1,
    denied: error !== undefined,
    auditAttempts: events.length,
    auditAllowedFieldsExact: events.every(event => JSON.stringify(Object.keys(event).sort()) === JSON.stringify(auditKeys)),
    rawPathsAbsent: events.every(event => !Object.values(event).some(value => typeof value === "string" && value.includes(rawInput))),
  };
}

function viewerDenialActual(attempt, includeProcessStarts = false) {
  const actual = {
    rootEscapeDenied: attempt.rootEscapeDenied,
    stringPathReopen: attempt.stringPathReopen,
    sideEffects: attempt.sideEffects,
    denied: attempt.denied,
    auditAttempts: attempt.auditAttempts,
    auditAllowedFieldsExact: attempt.auditAllowedFieldsExact,
    rawPathsAbsent: attempt.rawPathsAbsent,
  };
  if (includeProcessStarts) actual.processStarts = attempt.processStarts;
  return actual;
}

async function observeViewerDenial(id, attempt, includeProcessStarts = false) {
  const actual = viewerDenialActual(attempt, includeProcessStarts);
  assert.deepEqual(actual, includeProcessStarts ? {
    rootEscapeDenied: true,
    stringPathReopen: false,
    sideEffects: 0,
    denied: true,
    processStarts: 0,
    auditAttempts: 1,
    auditAllowedFieldsExact: true,
    rawPathsAbsent: true,
  } : {
    rootEscapeDenied: true,
    stringPathReopen: false,
    sideEffects: 0,
    denied: true,
    auditAttempts: 1,
    auditAllowedFieldsExact: true,
    rawPathsAbsent: true,
  });
  if (viewerRecorder.enabled) await viewerRecorder.observe(id, actual);
}

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec02-viewer-"));
  const workspace = path.join(base, "workspace");
  const department = path.join(base, "department");
  const output = path.join(base, "output");
  await Promise.all([workspace, department, output].map(directory => fs.mkdir(directory)));
  t.after(async () => fs.rm(base, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  return { base, workspace, department, output };
}

async function bindViewer(roots) {
  const pathAuthority = await pathPolicy.createAuthority([
    { rootId: "workspace", role: "workspace", configuredPath: roots.workspace, permissions },
    { rootId: "department", role: "department", configuredPath: roots.department, permissions },
    { rootId: "output", role: "output", configuredPath: roots.output, permissions },
  ]);
  const env = {
    WORKSPACE_ROOT: roots.workspace,
    DEPARTMENT_DATA_ROOT: roots.department,
    OUTPUT_DIR: roots.output,
    DATA_ROOT: roots.workspace,
  };
  const authority = capabilityBroker.createRuntimeAuthority({
    name: "sec02-viewer",
    tools: [],
    env,
    systemPrompt: "SEC-02 File Viewer integration",
    allowedRoots: [roots.workspace, roots.department, roots.output],
    rootEnv: {
      WORKSPACE_ROOT: "workspace",
      DEPARTMENT_DATA_ROOT: "department",
      OUTPUT_DIR: "output",
      DATA_ROOT: "workspace",
    },
    pathAuthority,
    networkPolicy: { mode: "deny" },
  });
  let rootSourceReads = 0;
  const viewerRoots = [
    ["workspace", "Workspace", roots.workspace],
    ["department", "Department", roots.department],
    ["output", "Output", roots.output],
  ].map(([id, name, configuredPath]) => {
    const source = { id, name, available: true };
    Object.defineProperty(source, "configuredPath", {
      enumerable: true,
      get() {
        rootSourceReads += 1;
        return configuredPath;
      },
    });
    return source;
  });
  fileViewerService.bindAuthority(authority, pathAuthority, viewerRoots);
  rootSourceReads = 0;
  const owner = issueResourceOwner({
    authorityId: authority.authorityId,
    authorityEpoch: 1,
    sessionId: "sec02-file-viewer",
    principal: "local-user-api",
    rootIds: ["workspace", "department", "output"],
  });
  return { authority, pathAuthority, owner, viewerRoots, rootSourceReads: () => rootSourceReads };
}

test("SEC-02 File Viewer uses one authority snapshot for list, preview, resolve and range handles", async t => {
  const roots = await fixture(t);
  const textPath = path.join(roots.workspace, "notes.txt");
  const imagePath = path.join(roots.workspace, "pixel.png");
  const originalPath = path.join(roots.workspace, "pixel-original.png");
  const outsidePath = path.join(roots.base, "outside.txt");
  const outsideBytes = Buffer.from("EXTERNAL-SENTINEL");
  await fs.writeFile(textPath, "line one\nline two\nline three");
  await fs.writeFile(imagePath, Buffer.from("ORIGINAL-IMAGE-BYTES"));
  await fs.writeFile(outsidePath, outsideBytes);
  const { authority, owner, viewerRoots, rootSourceReads } = await bindViewer(roots);
  t.after(async () => {
    await retireResourceOwner(owner).catch(() => undefined);
    await capabilityBroker.retireAuthority(authority).catch(() => undefined);
  });

  const rootList = fileViewerService.roots(authority);
  assert.deepEqual(rootList.map(root => root.id), ["workspace", "department", "output"]);
  const boundRootSnapshot = JSON.stringify(rootList);
  rootList[0].name = "CALLER-MUTATION";
  rootList[0].path = outsidePath;
  viewerRoots[0].name = "SOURCE-MUTATION";
  viewerRoots[0].available = false;
  const stableRootList = fileViewerService.roots(authority);
  let forgedRoots;
  let forgedRootError;
  try {
    forgedRoots = fileViewerService.roots({ ...authority });
  } catch (error) {
    forgedRootError = error;
  }
  const rootsActual = {
    rootEscapeDenied: forgedRootError instanceof Error
      && /authority is unavailable/u.test(forgedRootError.message)
      && stableRootList[0].path !== outsidePath,
    stringPathReopen: forgedRoots !== undefined,
    sideEffects: (await fs.readFile(outsidePath)).equals(outsideBytes) ? 0 : 1,
    immutableSnapshot: JSON.stringify(stableRootList) === boundRootSnapshot,
    settingsRereads: rootSourceReads(),
  };
  assert.deepEqual(rootsActual, {
    rootEscapeDenied: true,
    stringPathReopen: false,
    sideEffects: 0,
    immutableSnapshot: true,
    settingsRereads: 0,
  });
  if (viewerRecorder.enabled) await viewerRecorder.observe("SEC02-P30-roots-snapshot", rootsActual);

  const listed = await fileViewerService.list(authority, audit, "workspace", "", 0, 20);
  assert.deepEqual(listed.entries.map(entry => entry.name), ["notes.txt", "pixel.png"]);
  assert(listed.entries.every(entry => entry.absolutePath.startsWith(roots.workspace)));

  const preview = await fileViewerService.preview(authority, audit, owner, "workspace", "notes.txt", 2, 1);
  assert.equal(preview.kind, "text");
  assert.equal(preview.text, "line two");
  assert.equal(preview.lineOffset, 2);
  const resolved = await fileViewerService.resolveAbsolute(authority, audit, textPath);
  assert.deepEqual({ rootId: resolved.rootId, path: resolved.path, type: resolved.type }, { rootId: "workspace", path: "notes.txt", type: "file" });

  const relativeEscape = `..${path.sep}outside.txt`;
  const listAttempt = await captureDeniedOperation(
    () => fileViewerService.list(authority, audit, "workspace", relativeEscape),
    relativeEscape,
    outsidePath
  );
  await observeViewerDenial("SEC02-P30-list", listAttempt);
  const previewAttempt = await captureDeniedOperation(
    () => fileViewerService.preview(authority, audit, owner, "workspace", relativeEscape),
    relativeEscape,
    outsidePath
  );
  await observeViewerDenial("SEC02-P30-preview", previewAttempt);
  const resolveAttempt = await captureDeniedOperation(
    () => fileViewerService.resolveAbsolute(authority, audit, outsidePath),
    outsidePath,
    outsidePath
  );
  await observeViewerDenial("SEC02-P30-resolve", resolveAttempt);
  const contentAttempt = await captureDeniedOperation(
    () => fileViewerService.content(authority, audit, owner, "workspace", relativeEscape),
    relativeEscape,
    outsidePath
  );
  await observeViewerDenial("SEC02-P30-content", contentAttempt);

  const lease = await fileViewerService.content(authority, audit, owner, "workspace", "pixel.png");
  assert.equal(lease.mime, "image/png");
  await fs.rename(imagePath, originalPath);
  await fs.writeFile(imagePath, "ATTACKER-REPLACEMENT");
  const rangeObservation = "SEC02-P30-range-handle";
  const openDescriptor = Object.getOwnPropertyDescriptor(fs, "open");
  assert.equal(typeof openDescriptor?.value, "function", "fs.promises.open is unavailable");
  let rangePathReopens = 0;
  let rangeBytes;
  Object.defineProperty(fs, "open", {
    ...openDescriptor,
    value: function (input, ...args) {
      if (processContext.getStore() === rangeObservation
        && path.resolve(String(input)).toLowerCase() === imagePath.toLowerCase()) rangePathReopens += 1;
      return openDescriptor.value.call(this, input, ...args);
    },
  });
  try {
    rangeBytes = await processContext.run(rangeObservation, () => lease.readRange(0, 7));
  } finally {
    Object.defineProperty(fs, "open", openDescriptor);
  }
  const replacementBytes = await fs.readFile(imagePath, "utf8");
  const rangeFromOriginal = rangeBytes?.toString("utf8") === "ORIGINAL";
  const outsideUnchanged = (await fs.readFile(outsidePath)).equals(outsideBytes);
  const p21Actual = {
    passed: rangeFromOriginal && replacementBytes === "ATTACKER-REPLACEMENT" && rangePathReopens === 0,
    bytesFromOriginalHandle: rangeFromOriginal,
    reopenedPath: rangePathReopens > 0,
  };
  assert.deepEqual(p21Actual, { passed: true, bytesFromOriginalHandle: true, reopenedPath: false });
  if (viewerRecorder.enabled) await viewerRecorder.observe("SEC02-P21-range-after-path-replacement", p21Actual);
  const rangeActual = {
    rootEscapeDenied: rangeFromOriginal && replacementBytes === "ATTACKER-REPLACEMENT",
    stringPathReopen: rangePathReopens > 0,
    sideEffects: outsideUnchanged ? 0 : 1,
    bytesFromOriginalHandle: rangeFromOriginal,
    reopenedPath: rangePathReopens > 0,
  };
  assert.deepEqual(rangeActual, {
    rootEscapeDenied: true,
    stringPathReopen: false,
    sideEffects: 0,
    bytesFromOriginalHandle: true,
    reopenedPath: false,
  });
  if (viewerRecorder.enabled) await viewerRecorder.observe("SEC02-P30-range-handle", rangeActual);
  if (viewerRecorder.enabled) await viewerRecorder.positive("SEC02-POS-viewer-range-lease");
  await lease.close();
  await assert.rejects(
    () => lease.readRange(0, 0),
    error => error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_STALE"
  );

  const revealEscapeAttempt = await captureDeniedOperation(
    () => fileViewerService.reveal(authority, audit, "workspace", relativeEscape),
    relativeEscape,
    outsidePath
  );
  await observeViewerDenial("SEC02-P30-reveal-escape", revealEscapeAttempt, true);

  const revealOutside = path.join(roots.base, "reveal-outside");
  const revealTarget = path.join(roots.workspace, "reveal-target");
  const revealPreserved = path.join(roots.workspace, "reveal-preserved");
  const revealSentinel = path.join(revealOutside, "secret.txt");
  await fs.mkdir(revealOutside);
  await fs.mkdir(revealTarget);
  await fs.writeFile(revealSentinel, outsideBytes);
  const statDescriptor = Object.getOwnPropertyDescriptor(fs, "stat");
  assert.equal(typeof statDescriptor?.value, "function", "fs.promises.stat is unavailable");
  let revealSwapped = false;
  Object.defineProperty(fs, "stat", {
    ...statDescriptor,
    value: async function (input, ...args) {
      const result = await statDescriptor.value.call(this, input, ...args);
      if (!revealSwapped && path.resolve(String(input)).toLowerCase() === revealTarget.toLowerCase()) {
        revealSwapped = true;
        await fs.rename(revealTarget, revealPreserved);
        await fs.symlink(revealOutside, revealTarget, "junction");
      }
      return result;
    },
  });
  let revealSwapAttempt;
  try {
    revealSwapAttempt = await captureDeniedOperation(
      () => fileViewerService.reveal(authority, audit, "workspace", "reveal-target"),
      "reveal-target",
      revealSentinel
    );
  } finally {
    Object.defineProperty(fs, "stat", statDescriptor);
  }
  assert.equal(revealSwapped, true);
  await observeViewerDenial("SEC02-P30-reveal-swap", revealSwapAttempt, true);

  const drainPath = path.join(roots.workspace, "drain.png");
  const drainPreserved = path.join(roots.workspace, "drain-original.png");
  const drainOriginal = Buffer.from("ORIGINAL-DRAIN-BYTES");
  await fs.writeFile(drainPath, drainOriginal);
  const retirementLease = await fileViewerService.content(authority, audit, owner, "workspace", "drain.png");
  const probePath = path.join(roots.output, "probe.tmp");
  await fs.writeFile(probePath, "probe");
  const probeHandle = await fs.open(probePath, "r");
  const handlePrototype = Object.getPrototypeOf(probeHandle);
  await probeHandle.close();
  const readDescriptor = Object.getOwnPropertyDescriptor(handlePrototype, "read");
  const drainOpenDescriptor = Object.getOwnPropertyDescriptor(fs, "open");
  assert.equal(typeof readDescriptor?.value, "function", "FileHandle.read is unavailable");
  assert.equal(typeof drainOpenDescriptor?.value, "function", "fs.promises.open is unavailable");
  const drainObservation = "SEC02-P30-opened-range-retire-drain-only";
  let pathnameReopens = 0;
  let releaseRead;
  let enterRead;
  let blocked = false;
  const entered = new Promise(resolve => { enterRead = resolve; });
  const released = new Promise(resolve => { releaseRead = resolve; });
  Object.defineProperty(handlePrototype, "read", {
    ...readDescriptor,
    value: async function (...args) {
      if (processContext.getStore() === drainObservation && !blocked) {
        blocked = true;
        enterRead();
        await released;
      }
      return readDescriptor.value.apply(this, args);
    },
  });
  Object.defineProperty(fs, "open", {
    ...drainOpenDescriptor,
    value: function (input, ...args) {
      if (processContext.getStore() === drainObservation
        && path.resolve(String(input)).toLowerCase() === drainPath.toLowerCase()) pathnameReopens += 1;
      return drainOpenDescriptor.value.call(this, input, ...args);
    },
  });
  let drainedBytes;
  let leaseClosed = false;
  try {
    const draining = processContext.run(
      drainObservation,
      () => retirementLease.readRange(0, drainOriginal.length - 1)
    );
    await entered;
    await capabilityBroker.retireAuthority(authority);
    await fs.rename(drainPath, drainPreserved);
    await fs.writeFile(drainPath, "REPLACEMENT-DRAIN-BYTES");
    releaseRead();
    drainedBytes = await draining;
    await retirementLease.close();
    try {
      await retirementLease.readRange(0, 0);
    } catch (error) {
      leaseClosed = error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_STALE";
    }
  } finally {
    releaseRead?.();
    Object.defineProperty(handlePrototype, "read", readDescriptor);
    Object.defineProperty(fs, "open", drainOpenDescriptor);
    await retirementLease.close();
  }
  const drainedFromOriginal = drainedBytes?.equals(drainOriginal) === true;
  const drainActual = {
    passed: drainedFromOriginal && (await fs.readFile(drainPath, "utf8")) === "REPLACEMENT-DRAIN-BYTES",
    bytesFromOriginalHandle: drainedFromOriginal,
    pathnameReopens,
    leaseClosed,
  };
  assert.deepEqual(drainActual, {
    passed: true,
    bytesFromOriginalHandle: true,
    pathnameReopens: 0,
    leaseClosed: true,
  });
  if (viewerRecorder.enabled) await viewerRecorder.observe(drainObservation, drainActual);
});

test("SEC-02 File Viewer previews governed text, Office, media and unsupported types", async t => {
  const roots = await fixture(t);
  const { Document, Packer, Paragraph } = await import("docx");
  const docx = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("governed office text")] }] }));
  await fs.mkdir(path.join(roots.workspace, "nested", "deep"), { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(roots.workspace, "readme.md"), "# title\nbody"),
    fs.writeFile(path.join(roots.workspace, "data.json"), '{"value":1}'),
    fs.writeFile(path.join(roots.workspace, "broken.json"), '{not-json'),
    fs.writeFile(path.join(roots.workspace, ".env"), "VISIBLE=only-through-authority"),
    fs.writeFile(path.join(roots.workspace, "Makefile"), "all:\n\techo ok"),
    fs.writeFile(path.join(roots.workspace, "gbk.txt"), Buffer.from([0xc4, 0xe3, 0xba, 0xc3])),
    fs.writeFile(path.join(roots.workspace, "sample.docx"), docx),
    fs.writeFile(path.join(roots.workspace, "photo.jpg"), "image-bytes"),
    fs.writeFile(path.join(roots.workspace, "paper.pdf"), "%PDF-fake-preview-bytes"),
    fs.writeFile(path.join(roots.workspace, "blob.bin"), "unsupported"),
    fs.writeFile(path.join(roots.workspace, "noextension"), "unsupported"),
    fs.writeFile(path.join(roots.workspace, "empty.png"), Buffer.alloc(0)),
    fs.writeFile(path.join(roots.workspace, "nested", "deep", "inside.txt"), "inside"),
  ]);
  await fs.writeFile(path.join(roots.workspace, "big.png"), "x");
  await fs.writeFile(path.join(roots.workspace, "big.pdf"), "x");
  await fs.truncate(path.join(roots.workspace, "big.png"), 101 * 1024 * 1024);
  await fs.truncate(path.join(roots.workspace, "big.pdf"), 101 * 1024 * 1024);
  const { authority, pathAuthority, owner } = await bindViewer(roots);
  const wrongRootsOwner = issueResourceOwner({
    authorityId: authority.authorityId,
    authorityEpoch: 1,
    sessionId: "sec02-file-viewer-wrong-root",
    principal: "local-user-api",
    rootIds: ["output"],
  });
  t.after(async () => {
    await retireResourceOwner(owner).catch(() => undefined);
    await retireResourceOwner(wrongRootsOwner).catch(() => undefined);
    await capabilityBroker.retireAuthority(authority).catch(() => undefined);
  });

  assert.throws(() => fileViewerService.bindAuthority(authority, pathAuthority, []), /already bound/);
  const markdown = await fileViewerService.preview(authority, audit, owner, "workspace", "readme.md");
  assert.equal(markdown.kind, "markdown");
  assert.equal(markdown.language, "markdown");
  const normalizedMarkdown = await fileViewerService.preview(authority, audit, owner, "workspace", "readme.md", 0, 0);
  assert.equal(normalizedMarkdown.lineOffset, 1);
  assert.equal(normalizedMarkdown.lineEnd, 2);
  assert.equal(normalizedMarkdown.totalLines, 2);
  const json = await fileViewerService.preview(authority, audit, owner, "workspace", "data.json");
  assert.match(json.text, /\n {2}"value": 1\n/u);
  const hidden = await fileViewerService.preview(authority, audit, owner, "workspace", ".env");
  assert.equal(hidden.kind, "text");
  const brokenJson = await fileViewerService.preview(authority, audit, owner, "workspace", "broken.json");
  assert.equal(brokenJson.text, "{not-json");
  const makefile = await fileViewerService.preview(authority, audit, owner, "workspace", "Makefile", 0, 0);
  assert.equal(makefile.kind, "unsupported");
  const gbk = await fileViewerService.preview(authority, audit, owner, "workspace", "gbk.txt");
  assert.equal(gbk.text, "你好");
  const office = await fileViewerService.preview(authority, audit, owner, "workspace", "sample.docx");
  assert.equal(office.kind, "office");
  assert.match(office.text, /governed office text/u);
  const image = await fileViewerService.preview(authority, audit, owner, "workspace", "photo.jpg");
  assert.deepEqual({ kind: image.kind, mime: image.mime }, { kind: "image", mime: "image/jpeg" });
  const pdf = await fileViewerService.preview(authority, audit, owner, "workspace", "paper.pdf");
  assert.deepEqual({ kind: pdf.kind, mime: pdf.mime }, { kind: "pdf", mime: "application/pdf" });
  await assert.rejects(() => fileViewerService.preview(authority, audit, owner, "workspace", "big.png"), /图片超过 100MB/u);
  await assert.rejects(() => fileViewerService.preview(authority, audit, owner, "workspace", "big.pdf"), /PDF 超过 100MB/u);
  const unsupported = await fileViewerService.preview(authority, audit, owner, "workspace", "blob.bin");
  assert.equal(unsupported.kind, "unsupported");
  const extensionless = await fileViewerService.preview(authority, audit, owner, "workspace", "noextension");
  assert.match(extensionless.message, /无扩展名/u);

  const pdfContent = await fileViewerService.content(authority, audit, owner, "workspace", "paper.pdf");
  assert.equal(pdfContent.mime, "application/pdf");
  assert.match((await pdfContent.readRange(0, 3)).toString(), /%PDF/u);
  await pdfContent.close();
  await pdfContent.close();
  await assert.rejects(() => fileViewerService.content(authority, audit, owner, "workspace", "blob.bin"), /不允许/);
  await assert.rejects(() => fileViewerService.content(authority, audit, owner, "workspace", "empty.png"), /空文件/);
  await assert.rejects(
    () => fileViewerService.preview(authority, audit, wrongRootsOwner, "workspace", "readme.md"),
    error => error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_FORGED"
  );
  await assert.rejects(() => fileViewerService.resolveAbsolute(authority, audit, "readme.md"), /需要绝对路径/);
  await assert.rejects(() => fileViewerService.prepareRootEnrollment(authority, audit, "relative"), error => error instanceof PathDeniedError && error.code === "PATH_INPUT_INVALID");
  await assert.rejects(() => fileViewerService.list(authority, audit, "workspace", null), TypeError);
  await assert.rejects(() => fileViewerService.list(authority, audit, "absent", ""), /文件根目录不可用/u);
  assert.throws(() => fileViewerService.roots({ ...authority }), /authority is unavailable/);

  const page = await fileViewerService.list(authority, audit, "workspace", "", 1, 2);
  assert.equal(page.entries.length, 2);
  assert.equal(page.hasMore, true);
  const normalizedPage = await fileViewerService.list(authority, audit, "workspace", "nested", -10, 0);
  assert.equal(normalizedPage.parent, "");
  assert.equal(normalizedPage.offset, 0);
  assert.equal(normalizedPage.limit, 200);
  const deepPage = await fileViewerService.list(authority, audit, "workspace", path.join("nested", "deep"), 0, 9999);
  assert.equal(deepPage.parent, "nested");
  assert.equal(deepPage.limit, 500);
  assert.equal(deepPage.entries[0].path, path.join("nested", "deep", "inside.txt"));
  const enrollment = await fileViewerService.prepareRootEnrollment(authority, audit, path.join(roots.output, "new", "nested"));
  assert.equal(enrollment.createdDirectories, 2);
  await enrollment.rollback();
  await assert.rejects(() => fs.access(path.join(roots.output, "new")));
});

test("SEC-02 File Viewer denies redirect entries and stale runtime bindings", async t => {
  const roots = await fixture(t);
  const outside = path.join(roots.base, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "secret.txt"), "EXTERNAL-SECRET");
  await fs.symlink(outside, path.join(roots.workspace, "linked"), "junction");
  const { authority, owner } = await bindViewer(roots);

  await assert.rejects(
    () => fileViewerService.list(authority, audit, "workspace", "", 0, 20),
    error => error instanceof PathDeniedError && error.code === "PATH_REDIRECT_DENIED"
  );
  await capabilityBroker.retireAuthority(authority);
  assert.throws(() => fileViewerService.roots(authority), /authority is unavailable/);
  await assert.rejects(
    () => fileViewerService.preview(authority, audit, owner, "workspace", "linked\\secret.txt"),
    /authority is unavailable/
  );
  await retireResourceOwner(owner);
});

test("SEC-02 integration coverage closes ResourceOwner public rejection branches", async () => {
  const base = { authorityId: "resource-edge", authorityEpoch: 1, sessionId: "resource-session", principal: "local-user-api", rootIds: ["workspace"] };
  for (const invalid of [
    { ...base, authorityId: "" },
    { ...base, authorityEpoch: 0 },
    { ...base, sessionId: "" },
    { ...base, principal: "" },
    { ...base, rootIds: null },
    { ...base, rootIds: ["INVALID"] },
    { ...base, rootIds: ["workspace", "workspace"] },
  ]) assert.throws(() => issueResourceOwner(invalid), TypeError);

  const forged = Object.freeze({ ownerId: "forged" });
  assert.throws(() => registerOwnedResource(forged, () => undefined), error => error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_FORGED");
  await assert.rejects(() => retireResourceOwner(forged), error => error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_FORGED");

  const owner = issueResourceOwner(base);
  assert.throws(() => registerOwnedResource(owner, null), TypeError);
  const unregister = registerOwnedResource(owner, () => undefined);
  unregister();
  unregister();
  for (const timeout of [0, 60_001, Number.NaN]) assert.throws(() => retireResourceOwner(owner, timeout), TypeError);
  await retireResourceOwner(owner);
  assert.throws(() => registerOwnedResource(owner, () => undefined), error => error instanceof PathDeniedError && error.code === "PATH_AUTHORITY_STALE");
});
