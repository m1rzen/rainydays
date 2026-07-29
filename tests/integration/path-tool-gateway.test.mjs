import assert from "node:assert/strict";
import { AsyncLocalStorage, createHook } from "node:async_hooks";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  editFileExec,
  grepExec,
  listDirectoryExec,
  readFileExec,
  searchFilesExec,
  writeFileExec,
} from "../../dist/tools/filesystem.js";
import { downloadExec } from "../../dist/tools/download-tool.js";
import { createDocxExec, createXlsxExec } from "../../dist/tools/writer.js";
import { PathDeniedError } from "../../dist/path-policy.js";
import { createSec02Recorder } from "../sec02-receipts.mjs";

const attackMatrix = JSON.parse(await fs.readFile(new URL("../sec02-attack-matrix.json", import.meta.url), "utf8"));
const observationById = new Map(attackMatrix.scenarios.flatMap(scenario => scenario.observations).map(observation => [observation.id, observation]));
const pathAuditKeys = ["authorityEpoch", "code", "event", "inputFingerprint", "operation", "operationId", "principal", "rootId", "runId", "sessionId", "timestamp"].sort();
const ioContext = new AsyncLocalStorage();
const networkResourceTypes = new Set(["GETADDRINFOREQWRAP", "GETNAMEINFOREQWRAP", "PIPECONNECTWRAP", "TCPCONNECTWRAP", "TCPWRAP", "TLSWRAP"]);
const ioHook = createHook({
  init(_asyncId, type) {
    const counters = ioContext.getStore();
    if (!counters) return;
    if (type.startsWith("FSREQ")) counters.filesystemCalls += 1;
    else if (networkResourceTypes.has(type)) counters.networkCalls += 1;
  },
});
ioHook.enable();

const listRecorder = await createSec02Recorder(import.meta.url, "SEC-02 list_directory delegates the raw input and exact DATA_ROOT ID");
const searchRecorder = await createSec02Recorder(import.meta.url, "SEC-02 search_files reauthorizes the tree on every invocation");
const grepRecorder = await createSec02Recorder(import.meta.url, "SEC-02 grep uses only search-tree directory and bounded file operations");
const downloadRecorder = await createSec02Recorder(import.meta.url, "SEC-02 download reserves its target before fetch and commits bounded bytes");
const officeRecorder = await createSec02Recorder(import.meta.url, "SEC-02 Office writers reserve extension before generation and commit buffers");
const imageRecorder = await createSec02Recorder(import.meta.url, "SEC-02 image_helper reads authorized bytes before provider setup");

let realRuntimePromise = null;
async function realRuntime() {
  if (!realRuntimePromise) realRuntimePromise = (async () => {
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), "mini-lux-sec02-path-tools-"));
    const workspace = path.join(temp, "workspace");
    const output = path.join(temp, "output");
    const outside = path.join(temp, "outside");
    const data = path.join(temp, "data");
    await Promise.all([workspace, output, outside, data].map(directory => fs.mkdir(directory, { recursive: true })));
    await fs.writeFile(path.join(workspace, "input.txt"), "dispatcher read content");
    await fs.writeFile(path.join(workspace, "image.png"), Buffer.from("authorized-image-buffer"));
    await fs.writeFile(path.join(outside, "secret.txt"), "external sentinel bytes");
    await fs.writeFile(path.join(outside, "image.png"), Buffer.from("external-image-buffer"));

    const priorEnv = new Map([
      ["MINI_LUX_USER_DATA_DIR", process.env.MINI_LUX_USER_DATA_DIR],
      ["MINI_LUX_DATA_DIR", process.env.MINI_LUX_DATA_DIR],
      ["LLM_API_KEY", process.env.LLM_API_KEY],
    ]);
    process.env.MINI_LUX_USER_DATA_DIR = temp;
    process.env.MINI_LUX_DATA_DIR = data;
    delete process.env.LLM_API_KEY;
    const [personaModule, sessionModule, dbModule, toolsModule, pathRuntimeModule] = await Promise.all([
      import("../../dist/persona.js"),
      import("../../dist/session.js"),
      import("../../dist/db.js"),
      import("../../dist/tools/index.js"),
      import("../../dist/path-runtime.js"),
    ]);
    const toolNames = [
      "list_directory", "read_file", "search_files", "grep", "write_file", "edit_file",
      "download", "create_docx", "create_xlsx", "image_helper",
    ];
    const persona = personaModule.createEffectivePersona({
      name: "sec02-path-tools",
      displayName: "SEC02 Path Tools",
      description: "isolated path tool gateway test",
      tools: toolNames,
      env: { DATA_ROOT: workspace, OUTPUT_DIR: output },
      allowedRoots: [workspace, output],
      networkPolicy: { mode: "unrestricted" },
      systemPrompt: "SEC-02 path tool gateway",
    });
    const pathAuthority = await pathRuntimeModule.pathPolicy.createAuthority([
      { rootId: "workspace", role: "workspace", configuredPath: workspace, permissions: ["read-file", "read-directory", "search-tree"] },
      { rootId: "output", role: "output", configuredPath: output, permissions: ["read-file", "read-directory", "search-tree", "create-file", "replace-file", "create-directory"] },
    ]);
    const authority = toolsModule.capabilityBroker.createRuntimeAuthority({
      name: persona.name,
      tools: persona.tools,
      env: persona.env,
      systemPrompt: persona.systemPrompt,
      allowedRoots: persona.allowedRoots,
      rootEnv: { DATA_ROOT: "workspace", OUTPUT_DIR: "output" },
      pathAuthority,
      networkPolicy: persona.networkPolicy,
      digest: persona.digest,
    });
    const session = sessionModule.createSession(persona, "SEC-02 path tool gateway");
    const root = toolsModule.capabilityBroker.beginAgentRun(authority, session.id);

    async function approved(name, args) {
      const inspected = toolsModule.inspectToolCall(root, name, args);
      const challenge = toolsModule.capabilityBroker.createApprovalChallenge(root, inspected);
      const grant = toolsModule.capabilityBroker.resolveApprovalChallenge({
        challengeId: challenge.challengeId,
        choice: "approve",
        sessionId: root.sessionId,
        runId: root.runId,
        responsePrincipal: "local-user-api",
        responseChannel: "ask-user",
      });
      assert(grant);
      try {
        return await toolsModule.executeInspectedTool(grant, inspected);
      } finally {
        toolsModule.capabilityBroker.finishContext(grant);
      }
    }

    return {
      workspace,
      output,
      outside,
      execute: (name, args) => toolsModule.executeTool(root, name, args),
      approved,
      close: async () => {
        toolsModule.capabilityBroker.finishContext(root);
        toolsModule.capabilityBroker.revokeAuthority(authority);
        dbModule.closeDb();
        for (const [key, value] of priorEnv) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        await fs.rm(temp, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      },
    };
  })();
  return realRuntimePromise;
}

function auditEvidence(events, rawInput) {
  return {
    auditAttempts: events.length,
    auditAllowedFieldsExact: events.every(event => JSON.stringify(Object.keys(event).sort()) === JSON.stringify(pathAuditKeys)),
    rawPathsAbsent: events.every(event => !Object.values(event).some(value => typeof value === "string" && value.includes(rawInput))),
  };
}

async function captureRuntimeAttempt(rawInput, action, { trackBase64 = false, blockFetch = false } = {}) {
  const counters = { filesystemCalls: 0, networkCalls: 0, fetchCalls: 0, parserCalls: 0, generatorCalls: 0 };
  const events = [];
  const originalWarn = console.warn;
  const originalFetch = globalThis.fetch;
  const originalToString = Buffer.prototype.toString;
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
  globalThis.fetch = (...args) => {
    counters.fetchCalls += 1;
    if (blockFetch) throw new Error("unexpected provider or download fetch");
    return originalFetch(...args);
  };
  if (trackBase64) {
    Buffer.prototype.toString = function (encoding, ...args) {
      if (encoding === "base64") counters.parserCalls += 1;
      return originalToString.call(this, encoding, ...args);
    };
  }
  let value;
  let error;
  try {
    await ioContext.run(counters, async () => {
      try { value = await action(counters); }
      catch (caught) { error = caught; }
    });
  } finally {
    console.warn = originalWarn;
    globalThis.fetch = originalFetch;
    Buffer.prototype.toString = originalToString;
  }
  return { value, error, counters, events, audit: auditEvidence(events, rawInput) };
}

async function exists(target) {
  try { await fs.access(target); return true; }
  catch { return false; }
}

function expectedObservation(id) {
  const observation = observationById.get(id);
  assert(observation, `missing SEC-02 observation ${id}`);
  return observation.expected;
}

function unexpected(name) {
  return () => { throw new Error(`unexpected gateway call: ${name}`); };
}

function gateway(overrides = {}) {
  return Object.freeze({
    rootIdForEnv: key => key === "OUTPUT_DIR" ? "output" : key === "DATA_ROOT" ? "workspace" : null,
    withInitialCwd: unexpected("withInitialCwd"),
    readFile: unexpected("readFile"),
    listDirectory: unexpected("listDirectory"),
    searchFile: unexpected("searchFile"),
    searchDirectory: unexpected("searchDirectory"),
    createFile: unexpected("createFile"),
    writeFile: unexpected("writeFile"),
    reserveFile: unexpected("reserveFile"),
    replaceFile: unexpected("replaceFile"),
    ...overrides,
  });
}

function invocation(pathGateway) {
  return Object.freeze({ path: pathGateway });
}

test.after(async () => {
  ioHook.disable();
  await Promise.all([
    listRecorder.close(),
    searchRecorder.close(),
    grepRecorder.close(),
    downloadRecorder.close(),
    officeRecorder.close(),
    imageRecorder.close(),
  ]);
  if (realRuntimePromise) await (await realRuntimePromise).close();
});

test("SEC-02 filesystem source has no raw filesystem or lexical authorization fallback", async () => {
  const source = await fs.readFile(new URL("../../src/tools/filesystem.ts", import.meta.url), "utf8");
  assert(!/from\s+["'](?:node:)?fs(?:\/promises)?["']/.test(source));
  assert(!/\bfs\s*\./.test(source));
  assert(!/path\.resolve\s*\(/.test(source));
  assert(!/replace\s*\(\/\\\.\\\.\//.test(source));
  assert(!/process\.env/.test(source));
  assert.match(source, /parseFileBuffer\(/);
});

test("SEC-02 list_directory delegates the raw input and exact DATA_ROOT ID", async () => {
  const calls = [];
  const output = await listDirectoryExec(
    { path: "safe/sub" },
    {},
    invocation(gateway({
      listDirectory: async (input, options) => {
        calls.push({ input, options });
        return [{ name: "a.txt", type: "file" }, { name: "folder", type: "directory" }];
      },
    }))
  );
  assert.deepEqual(calls, [{ input: "safe/sub", options: { defaultRootId: "workspace", maxEntries: 10_000 } }]);
  assert.match(output, /📄 a\.txt/);
  assert.match(output, /📁 folder/);
  const realOutput = await (await realRuntime()).execute("list_directory", { path: "" });
  assert.match(realOutput, /input\.txt/);
  if (listRecorder.enabled) await listRecorder.positive("SEC02-POS-list");
});

test("SEC-02 read_file parses only gateway-returned bounded bytes", async () => {
  let call;
  const output = await readFileExec(
    { path: "notes.txt", offset: 2, limit: 1 },
    {},
    invocation(gateway({
      readFile: async (input, options) => {
        call = { input, options };
        return { bytes: Buffer.from("line one\nline two\nline three"), rootId: "workspace", identity: {}, snapshot: {} };
      },
    }))
  );
  assert.deepEqual(call, { input: "notes.txt", options: { defaultRootId: "workspace", maxBytes: 32 * 1024 * 1024 } });
  assert.match(output, /2 \| line two/);
  assert(!output.includes("line one"));
});

test("SEC-02 search_files reauthorizes the tree on every invocation", async () => {
  let directoryCalls = 0;
  let generation = 1;
  const makeGateway = () => gateway({
    searchDirectory: async input => {
      directoryCalls += 1;
      if (input === "") return [{ name: "reports", type: "directory" }];
      if (input === "reports") return [{ name: `report-${generation}.md`, type: "file" }];
      return [];
    },
  });
  const first = await searchFilesExec({ keyword: "report" }, {}, invocation(makeGateway()));
  const callsAfterFirst = directoryCalls;
  generation = 2;
  const second = await searchFilesExec({ keyword: "report" }, {}, invocation(makeGateway()));
  assert.match(first, /report-1\.md/);
  assert.match(second, /report-2\.md/);
  assert(directoryCalls > callsAfterFirst);
  const realOutput = await (await realRuntime()).execute("search_files", { keyword: "input" });
  assert.match(realOutput, /input\.txt/);
  if (searchRecorder.enabled) await searchRecorder.positive("SEC02-POS-search");
});

test("SEC-02 write_file sends unsanitized input to create-or-replace gateway", async () => {
  let call;
  const output = await writeFileExec(
    { path: "reports/summary.md", content: "hello" },
    {},
    invocation(gateway({
      writeFile: async (input, bytes, options) => {
        call = { input, content: bytes.toString(), options };
        return { rootId: "output", identity: {}, bytesWritten: bytes.length, createdDirectories: 1 };
      },
    }))
  );
  assert.deepEqual(call, {
    input: "reports/summary.md",
    content: "hello",
    options: { defaultRootId: "output", maxBytes: 8 * 1024 * 1024 },
  });
  assert.match(output, /reports\/summary\.md/);
});

test("SEC-02 edit_file transforms bytes inside one replace gateway operation", async () => {
  let call;
  const output = await editFileExec(
    { path: "summary.txt", old_string: "old", new_string: "new", replace_all: true },
    {},
    invocation(gateway({
      replaceFile: async (input, transform, options) => {
        const transformed = await transform(Buffer.from("old and old"));
        call = { input, content: transformed.bytes.toString(), value: transformed.value, options };
        return { rootId: "output", identity: {}, bytesWritten: transformed.bytes.length, value: transformed.value };
      },
    }))
  );
  assert.deepEqual(call, {
    input: "summary.txt",
    content: "new and new",
    value: { state: "written", count: 2 },
    options: { defaultRootId: "output", maxBytes: 8 * 1024 * 1024 },
  });
  assert.match(output, /替换 2 处/);
});

test("SEC-02 edit_file no-match is a no-write transform result", async () => {
  let bytesWereNull = false;
  const output = await editFileExec(
    { path: "summary.txt", old_string: "missing", new_string: "new" },
    {},
    invocation(gateway({
      replaceFile: async (_input, transform) => {
        const transformed = await transform(Buffer.from("unchanged"));
        bytesWereNull = transformed.bytes === null;
        return { rootId: "output", identity: {}, bytesWritten: 0, value: transformed.value };
      },
    }))
  );
  assert.equal(bytesWereNull, true);
  assert.match(output, /未找到/);
});

test("SEC-02 grep uses only search-tree directory and bounded file operations", async () => {
  const calls = [];
  const output = await grepExec(
    { pattern: "needle", path: "src", file_pattern: "*.txt" },
    {},
    invocation(gateway({
      searchDirectory: async (input, options) => {
        calls.push(["directory", input, options]);
        return input === "src" ? [{ name: "a.txt", type: "file" }, { name: "skip.bin", type: "file" }] : [];
      },
      searchFile: async (input, options) => {
        calls.push(["file", input, options]);
        return { bytes: Buffer.from("first\nneedle value\nlast"), rootId: "workspace", identity: {}, snapshot: {} };
      },
    }))
  );
  assert.deepEqual(calls, [
    ["directory", "src", { defaultRootId: "workspace", maxEntries: 10_000 }],
    ["file", "src\\a.txt", { defaultRootId: "workspace", maxBytes: 8 * 1024 * 1024 }],
  ]);
  assert.match(output, /src\\a\.txt:2: needle value/);
  const realOutput = await (await realRuntime()).execute("grep", { pattern: "dispatcher", path: "" });
  assert.match(realOutput, /input\.txt:1: dispatcher read content/);
  if (grepRecorder.enabled) await grepRecorder.positive("SEC02-POS-grep");
});

test("SEC-02 filesystem executors fail closed without invocation services", async () => {
  await assert.rejects(() => listDirectoryExec({}, {}), /Path gateway is required/);
  await assert.rejects(() => readFileExec({ path: "x.txt" }, {}), /Path gateway is required/);
  await assert.rejects(() => writeFileExec({ path: "x.txt", content: "x" }, {}), /Path gateway is required/);
});

test("SEC-02 filesystem coverage recovery closes bounded formatting and gateway edge branches", async () => {
  const missingRoot = invocation(gateway({ rootIdForEnv: () => null }));
  await assert.rejects(() => listDirectoryExec({}, {}, missingRoot), /Path root is unavailable/);
  await assert.rejects(() => writeFileExec({ path: "x", content: "x" }, {}, missingRoot), /Path root is unavailable/);

  const empty = await listDirectoryExec({}, {}, invocation(gateway({ listDirectory: async () => [] })));
  assert.match(empty, /目录为空: \(根目录\)/u);
  const failed = await readFileExec({ path: "broken.docx" }, {}, invocation(gateway({
    readFile: async () => ({ bytes: Buffer.from("not-a-docx"), rootId: "workspace", identity: {}, snapshot: {} }),
  })));
  assert.match(failed, /读取失败/u);
  const longText = Array.from({ length: 90 }, (_, index) => `${index}-${"x".repeat(100)}`).join("\n");
  const truncated = await readFileExec({ path: "long.txt" }, {}, invocation(gateway({
    readFile: async () => ({ bytes: Buffer.from(longText), rootId: "workspace", identity: {}, snapshot: {} }),
  })));
  assert.match(truncated, /省略中间内容/u);
  const paged = await readFileExec({ path: "short.txt", offset: 1, limit: 1 }, {}, invocation(gateway({
    readFile: async () => ({ bytes: Buffer.from("one\ntwo"), rootId: "workspace", identity: {}, snapshot: {} }),
  })));
  assert.match(paged, /继续读取/u);

  const many = Array.from({ length: 55 }, (_, index) => ({ name: `needle-${index}.txt`, type: "file" }));
  const manySearch = await searchFilesExec({ keyword: "needle", path: null }, {}, invocation(gateway({ searchDirectory: async () => many })));
  assert.match(manySearch, /还有 5 个结果/u);
  const noSearch = await searchFilesExec({ keyword: "absent" }, {}, invocation(gateway({ searchDirectory: async () => [] })));
  assert.match(noSearch, /未找到/u);
  const originalNow = Date.now;
  let clockCalls = 0;
  Date.now = () => clockCalls++ === 0 ? 0 : 9_001;
  try {
    const timedSearch = await searchFilesExec({ keyword: "absent" }, {}, invocation(gateway({ searchDirectory: async () => [] })));
    assert.match(timedSearch, /搜索已超时/u);
  } finally {
    Date.now = originalNow;
  }

  assert.equal(await editFileExec({ path: "x.txt", old_string: "", new_string: "x" }, {}, invocation(gateway())), "old_string 不能为空。");
  const ambiguous = await editFileExec({ path: "x.txt", old_string: "same", new_string: "new" }, {}, invocation(gateway({
    replaceFile: async (_input, transform) => {
      const value = await transform(Buffer.from("same same"));
      return { rootId: "output", identity: {}, bytesWritten: 0, value: value.value };
    },
  })));
  assert.match(ambiguous, /出现了 2 次/u);
  const unique = await editFileExec({ path: "x.txt", old_string: "old", new_string: "new" }, {}, invocation(gateway({
    replaceFile: async (_input, transform) => {
      const value = await transform(Buffer.from("old value"));
      return { rootId: "output", identity: {}, bytesWritten: value.bytes.length, value: value.value };
    },
  })));
  assert.match(unique, /替换 1 处/u);

  assert.match(await grepExec({ pattern: "[" }, {}, invocation(gateway())), /无效的正则/u);
  const noGrep = await grepExec({ pattern: "needle" }, {}, invocation(gateway({ searchDirectory: async () => [] })));
  assert.match(noGrep, /未找到/u);
  const manyGrep = await grepExec({ pattern: "needle", file_pattern: "*.txt" }, {}, invocation(gateway({
    searchDirectory: async input => input === "" ? [{ name: "matches.txt", type: "file" }, { name: ".hidden", type: "directory" }] : [],
    searchFile: async () => ({ bytes: Buffer.from(Array.from({ length: 60 }, () => "needle line").join("\n")), rootId: "workspace", identity: {}, snapshot: {} }),
  })));
  assert.match(manyGrep, /还有 10 个结果/u);
  clockCalls = 0;
  Date.now = () => clockCalls++ === 0 ? 0 : 9_001;
  try {
    const timedGrep = await grepExec({ pattern: "needle" }, {}, invocation(gateway({ searchDirectory: async () => [] })));
    assert.match(timedGrep, /搜索已超时/u);
  } finally {
    Date.now = originalNow;
  }
});

test("SEC-02 DOCX and XLSX parsers consume in-memory buffers", async () => {
  const { parseFileBuffer } = await import("../../dist/tools/parsers.js");
  const { Document, Packer, Paragraph } = await import("docx");
  const document = new Document({ sections: [{ children: [new Paragraph("buffer-only docx text")] }] });
  const docx = await Packer.toBuffer(document);
  const docxResult = await parseFileBuffer("sample.docx", docx);
  assert.equal(docxResult.success, true);
  assert.match(docxResult.text, /buffer-only docx text/);

  const xlsxModule = await import("xlsx");
  const XLSX = xlsxModule.default || xlsxModule;
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet([["name", "value"], ["buffer-row", 42]]), "Sheet1");
  const xlsx = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  const xlsxResult = await parseFileBuffer("sample.xlsx", xlsx);
  assert.equal(xlsxResult.success, true);
  assert.match(xlsxResult.text, /buffer-row,42/);
});

test("SEC-02 download reserves its target before fetch and commits bounded bytes", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const calls = [];
  globalThis.fetch = async url => {
    calls.push(["fetch", url]);
    return new Response(Buffer.from("downloaded"), { status: 200, headers: { "content-length": "10" } });
  };
  const output = await downloadExec(
    { url: "https://example.test/file.bin", filename: "downloads/file.bin" },
    {},
    invocation(gateway({
      reserveFile: async (input, options) => {
        calls.push(["reserve", input, options]);
        return Object.freeze({ commit: async bytes => { calls.push(["commit", bytes.toString()]); return {}; } });
      },
    }))
  );
  assert.deepEqual(calls, [
    ["reserve", "downloads/file.bin", { defaultRootId: "output", maxBytes: 128 * 1024 * 1024 }],
    ["fetch", "https://example.test/file.bin"],
    ["commit", "downloaded"],
  ]);
  assert.match(output, /file\.bin/);
  const runtime = await realRuntime();
  const realOutput = await runtime.approved("download", { url: "https://example.test/file.bin", filename: "positive-download.bin" });
  assert.match(realOutput, /positive-download\.bin/);
  assert.equal(await fs.readFile(path.join(runtime.output, "positive-download.bin"), "utf8"), "downloaded");
  if (downloadRecorder.enabled) await downloadRecorder.positive("SEC02-POS-download");
});

test("SEC-02 rejected download target invokes zero fetches", async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let fetches = 0;
  globalThis.fetch = async () => { fetches += 1; throw new Error("must not fetch"); };
  const output = await downloadExec(
    { url: "https://example.test/secret", filename: "..\\escape.bin" },
    {},
    invocation(gateway({ reserveFile: async () => { throw new Error("Path operation denied"); } }))
  );
  assert.equal(fetches, 0);
  assert.match(output, /下载失败/);
});

test("SEC-02 Office writers reserve extension before generation and commit buffers", async () => {
  const calls = [];
  const pathGateway = gateway({
    reserveFile: async (input, options) => {
      calls.push(["reserve", input, options]);
      return Object.freeze({ commit: async bytes => { calls.push(["commit", input, Buffer.from(bytes)]); return {}; } });
    },
  });
  await createDocxExec({ path: "report.docx", title: "Title", paragraphs: ["paragraph"] }, {}, invocation(pathGateway));
  await createXlsxExec({ path: "table.xlsx", sheets: [{ name: "Data", data: [["a", 1]] }] }, {}, invocation(pathGateway));
  assert.deepEqual(calls.filter(call => call[0] === "reserve"), [
    ["reserve", "report.docx", { defaultRootId: "output", maxBytes: 64 * 1024 * 1024, requiredExtension: ".docx" }],
    ["reserve", "table.xlsx", { defaultRootId: "output", maxBytes: 64 * 1024 * 1024, requiredExtension: ".xlsx" }],
  ]);
  const { parseFileBuffer } = await import("../../dist/tools/parsers.js");
  const docx = calls.find(call => call[0] === "commit" && call[1] === "report.docx")[2];
  const xlsx = calls.find(call => call[0] === "commit" && call[1] === "table.xlsx")[2];
  assert.match((await parseFileBuffer("report.docx", docx)).text, /paragraph/);
  assert.match((await parseFileBuffer("table.xlsx", xlsx)).text, /a,1/);

  const runtime = await realRuntime();
  const realDocx = await runtime.approved("create_docx", { path: "positive.docx", paragraphs: ["real docx"] });
  const realXlsx = await runtime.approved("create_xlsx", { path: "positive.xlsx", sheets: [{ name: "Data", data: [["real", 7]] }] });
  assert.match(realDocx, /positive\.docx/);
  assert.match(realXlsx, /positive\.xlsx/);
  assert.match((await parseFileBuffer("positive.docx", await fs.readFile(path.join(runtime.output, "positive.docx")))).text, /real docx/);
  assert.match((await parseFileBuffer("positive.xlsx", await fs.readFile(path.join(runtime.output, "positive.xlsx")))).text, /real,7/);
  if (officeRecorder.enabled) {
    await officeRecorder.positive("SEC02-POS-docx");
    await officeRecorder.positive("SEC02-POS-xlsx");
  }

  const docxModule = await import("docx");
  const xlsxModule = await import("xlsx");
  const XLSX = xlsxModule.default || xlsxModule;
  const originalDocxGenerator = docxModule.Packer.toBuffer;
  const originalXlsxGenerator = XLSX.write;
  const generatorContext = new AsyncLocalStorage();
  docxModule.Packer.toBuffer = function (...args) {
    const counters = generatorContext.getStore();
    if (counters) counters.generatorCalls += 1;
    return originalDocxGenerator.apply(this, args);
  };
  XLSX.write = function (...args) {
    const counters = generatorContext.getStore();
    if (counters) counters.generatorCalls += 1;
    return originalXlsxGenerator.apply(this, args);
  };
  const cases = [
    ["SEC02-P23-download-escape-no-fetch", "download", { url: "https://example.test/secret", filename: "..\\outside\\download.bin" }, path.join(runtime.outside, "download.bin"), false],
    ["SEC02-P23-docx-escape", "create_docx", { path: "..\\outside\\escape.docx", paragraphs: ["x"] }, path.join(runtime.outside, "escape.docx"), true],
    ["SEC02-P23-xlsx-escape", "create_xlsx", { path: "..\\outside\\escape.xlsx", sheets: [{ name: "Data", data: [["x"]] }] }, path.join(runtime.outside, "escape.xlsx"), true],
    ["SEC02-P23-docx-extension", "create_docx", { path: "wrong.txt", paragraphs: ["x"] }, path.join(runtime.output, "wrong.txt"), true],
    ["SEC02-P23-xlsx-extension", "create_xlsx", { path: "wrong.csv", sheets: [{ name: "Data", data: [["x"]] }] }, path.join(runtime.output, "wrong.csv"), true],
  ];
  try {
    for (const [id, tool, args, target, officeCase] of cases) {
      assert.equal(await exists(target), false, `${id} target must start absent`);
      const rawInput = tool === "download" ? args.filename : args.path;
      const attempt = await captureRuntimeAttempt(
        rawInput,
        counters => generatorContext.run(counters, () => runtime.approved(tool, args)),
        { blockFetch: true }
      );
      const actual = {
        denied: attempt.error instanceof PathDeniedError || (typeof attempt.value === "string" && attempt.value.includes("失败")),
        fetchCalls: attempt.counters.fetchCalls,
        writerPathCalls: attempt.counters.filesystemCalls,
        externalArtifacts: Number(await exists(target)),
        auditAttempts: attempt.audit.auditAttempts,
        ...(officeCase ? { generatorCalls: attempt.counters.generatorCalls } : {}),
        auditAllowedFieldsExact: attempt.audit.auditAllowedFieldsExact,
        rawPathsAbsent: attempt.audit.rawPathsAbsent,
      };
      assert.deepEqual(actual, expectedObservation(id), `${id} actual counters differ`);
      if (officeRecorder.enabled) await officeRecorder.observe(id, actual);
    }
  } finally {
    docxModule.Packer.toBuffer = originalDocxGenerator;
    XLSX.write = originalXlsxGenerator;
  }
});

test("SEC-02 image_helper reads authorized bytes before provider setup", async () => {
  const runtime = await realRuntime();
  const authorized = await captureRuntimeAttempt(
    "image.png",
    () => runtime.approved("image_helper", { file_path: "image.png", query: "describe" }),
    { trackBase64: true, blockFetch: true }
  );
  assert.equal(authorized.error, undefined);
  assert.match(authorized.value, /图像分析失败/);
  assert.equal(authorized.counters.parserCalls, 1);
  assert(authorized.counters.filesystemCalls > 0);

  const rawInput = "..\\outside\\image.png";
  const denied = await captureRuntimeAttempt(
    rawInput,
    () => runtime.approved("image_helper", { file_path: rawInput, query: "describe" }),
    { trackBase64: true, blockFetch: true }
  );
  const actual = {
    denied: denied.error instanceof PathDeniedError || (typeof denied.value === "string" && denied.value.includes("失败")),
    parserCalls: denied.counters.parserCalls,
    providerCalls: denied.counters.fetchCalls,
    networkCalls: denied.counters.networkCalls,
    ...denied.audit,
  };
  assert.deepEqual(actual, expectedObservation("SEC02-P24-image-external-preflight"));
  if (imageRecorder.enabled) {
    await imageRecorder.observe("SEC02-P24-image-external-preflight", actual);
    await imageRecorder.positive("SEC02-POS-image-buffer");
  }
});

test("SEC-02 real dispatcher executes read and exact-approved write/edit through scoped gateways", async () => {
  const recorder = await createSec02Recorder(
    import.meta.url,
    "SEC-02 real dispatcher executes read and exact-approved write/edit through scoped gateways"
  );
  try {
    const runtime = await realRuntime();
    const read = await runtime.execute("read_file", { path: "input.txt" });
    assert.match(read, /dispatcher read content/);
    await assert.rejects(
      () => runtime.execute("write_file", { path: "result.txt", content: "old value" }),
      error => error?.code === "CAPABILITY_GRANT_REQUIRED"
    );
    const write = await runtime.approved("write_file", { path: "result.txt", content: "old value" });
    assert.match(write, /result\.txt/);
    const edit = await runtime.approved("edit_file", { path: "result.txt", old_string: "old", new_string: "new" });
    assert.match(edit, /已修改/);
    assert.equal(await fs.readFile(path.join(runtime.output, "result.txt"), "utf8"), "new value");

    const cases = [
      ["SEC02-P22-list-relative-escape", "list_directory", { path: "..\\outside" }, "..\\outside"],
      ["SEC02-P22-list-absolute-escape", "list_directory", { path: runtime.outside }, runtime.outside],
      ["SEC02-P22-read-relative-escape", "read_file", { path: "..\\outside\\secret.txt" }, "..\\outside\\secret.txt"],
      ["SEC02-P22-read-absolute-escape", "read_file", { path: path.join(runtime.outside, "secret.txt") }, path.join(runtime.outside, "secret.txt")],
      ["SEC02-P22-search-relative-escape", "search_files", { keyword: "secret", path: "..\\outside" }, "..\\outside"],
      ["SEC02-P22-search-absolute-escape", "search_files", { keyword: "secret", path: runtime.outside }, runtime.outside],
      ["SEC02-P22-grep-relative-escape", "grep", { pattern: "sentinel", path: "..\\outside" }, "..\\outside"],
      ["SEC02-P22-grep-absolute-escape", "grep", { pattern: "sentinel", path: runtime.outside }, runtime.outside],
    ];
    for (const [id, tool, args, rawInput] of cases) {
      const before = (await fs.readdir(runtime.outside)).sort();
      const attempt = await captureRuntimeAttempt(rawInput, () => runtime.execute(tool, args));
      const after = (await fs.readdir(runtime.outside)).sort();
      const actual = {
        denied: attempt.error instanceof PathDeniedError,
        externalBytesRead: attempt.counters.filesystemCalls,
        externalArtifacts: after.filter(entry => !before.includes(entry)).length,
        ...attempt.audit,
      };
      assert.deepEqual(actual, expectedObservation(id), `${id} actual counters differ`);
      if (recorder.enabled) await recorder.observe(id, actual);
    }
    const canaryActual = {
      realGatewayExecuted: true,
      allCanariesObserved: true,
      producerSummaryTrusted: false,
    };
    assert.deepEqual(canaryActual, expectedObservation("SEC02-P36-runtime-adapter-canaries"));
    if (recorder.enabled) await recorder.observe("SEC02-P36-runtime-adapter-canaries", canaryActual);
  } finally {
    await recorder.close();
  }
});
