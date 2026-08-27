import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { makeTempDir, projectRoot, removeFixture } from "../helpers.mjs";

const fixture = await makeTempDir("mini-lux-tool02-");
process.env.RAINYDAYS_APP_ROOT = projectRoot;
process.env.RAINYDAYS_USER_DATA_DIR = fixture;
process.env.RAINYDAYS_DATA_DIR = path.join(fixture, "data");
await fs.mkdir(process.env.RAINYDAYS_DATA_DIR, { recursive: true });

const [lux, grepModule, parsers, resourceOwners, cancellation] = await Promise.all([
  import("../../dist/tools/filesystem-lux.js"),
  import("../../dist/tools/filesystem-grep.js"),
  import("../../dist/tools/parsers.js"),
  import("../../dist/resource-owner.js"),
  import("../../dist/run-cancellation.js"),
]);
const owner = resourceOwners.issueResourceOwner({
  authorityId: "tool02-contract",
  authorityEpoch: 1,
  sessionId: "tool02-contract",
  principal: "test",
  rootIds: ["workspace", "output"],
});

function unexpected(name) {
  return () => { throw new Error(`unexpected gateway call: ${name}`); };
}

function gateway(overrides = {}) {
  return Object.freeze({
    rootIdForEnv: key => key === "OUTPUT_DIR" ? "output" : key === "DATA_ROOT" ? "workspace" : null,
    withInitialCwd: unexpected("withInitialCwd"), readFile: unexpected("readFile"),
    listDirectory: unexpected("listDirectory"), searchFile: unexpected("searchFile"),
    searchDirectory: unexpected("searchDirectory"), createFile: unexpected("createFile"),
    writeFile: unexpected("writeFile"), reserveFile: unexpected("reserveFile"),
    replaceFile: unexpected("replaceFile"), ...overrides,
  });
}

function invocation(pathGateway) {
  return Object.freeze({
    path: pathGateway,
    network: Object.freeze({ fetch: (...args) => globalThis.fetch(...args) }),
    signal: cancellation.NEVER_ABORT_SIGNAL,
    resourceOwner: owner,
  });
}

test.after(async () => {
  await resourceOwners.retireResourceOwner(owner);
  await removeFixture(fixture);
});

test("TOOL-02 built-in personas prefer canonical file tools while legacy names remain registry-only aliases", async () => {
  const names = ["architect", "debugger", "developer", "explorer", "general", "planner", "quick-fix", "rds-assistant", "reviewer", "sentinel", "writer"];
  const legacy = /^(?: {2}- )(?:list_directory|read_file|search_files|write_file|edit_file)$/mu;
  for (const name of names) {
    const source = await fs.readFile(path.join(projectRoot, "personas", `${name}.md`), "utf8");
    assert.doesNotMatch(source, legacy, `${name} still advertises a legacy file tool`);
    assert.match(source, /^ {2}- read$/mu, `${name} does not advertise canonical read`);
  }
});

test("TOOL-02 canonical definitions expose the complete frozen field contracts", () => {
  const fields = definition => Object.keys(definition.function.parameters.properties).sort();
  assert.deepEqual(fields(lux.readDef), ["file_path", "limit", "offset", "pages"]);
  assert.deepEqual(fields(lux.writeDef), ["content", "file_path"]);
  assert.deepEqual(fields(lux.editDef), ["file_path", "new_string", "old_string", "replace_all"]);
  assert.deepEqual(fields(lux.replaceDef), fields(lux.editDef));
  assert.deepEqual(fields(lux.globDef), ["path", "pattern"]);
  assert.deepEqual(fields(grepModule.grepDef), ["-A", "-B", "-C", "-i", "-n", "context", "glob", "head_limit", "multiline", "offset", "output_mode", "path", "pattern", "regex_dialect", "type"]);
  assert.deepEqual(lux.readDef.function.parameters.required, ["file_path"]);
  assert.deepEqual(lux.writeDef.function.parameters.required, ["file_path", "content"]);
  assert.deepEqual(lux.editDef.function.parameters.required, ["file_path", "old_string", "new_string"]);
});

test("TOOL-02 read paginates large UTF-8 text without its former 6000-character cut", async () => {
  const text = Array.from({ length: 120 }, (_, index) => `${index + 1}-${"x".repeat(90)}`).join("\n");
  const output = await lux.readExec({ file_path: "large.txt", offset: 51, limit: 40 }, {}, invocation(gateway({
    readFile: async (input, options) => {
      assert.equal(input, "large.txt");
      assert.deepEqual(options, { defaultRootId: "workspace", maxBytes: 32 * 1024 * 1024 });
      return { bytes: Buffer.from(text), rootId: "workspace", identity: {}, snapshot: {} };
    },
  })));
  assert.match(output, /51-xxxxxxxx/u);
  assert.match(output, /90-xxxxxxxx/u);
  assert(!output.includes("50-xxxxxxxx"));
  assert(!output.includes("91-xxxxxxxx"));
  assert.match(output, /下一页 offset=91/u);
  assert(output.length > 3_600);
});

test("TOOL-02 read validates image boundaries and reports authorized image metadata", async () => {
  const png = Buffer.alloc(24);
  Buffer.from("89504e470d0a1a0a", "hex").copy(png);
  const output = await lux.readExec({ file_path: "pixel.png" }, {}, invocation(gateway({
    readFile: async () => ({ bytes: png, rootId: "workspace", identity: {}, snapshot: {} }),
  })));
  assert.match(output, /\[Image: pixel\.png\]/u);
  assert.match(output, /MIME: image\/png/u);
  await assert.rejects(
    () => lux.readExec({ file_path: "fake.png" }, {}, invocation(gateway({
      readFile: async () => ({ bytes: Buffer.from("not png"), rootId: "workspace", identity: {}, snapshot: {} }),
    }))),
    error => error?.code === "TOOL_ARGUMENTS_INVALID",
  );
  await assert.rejects(
    () => lux.readExec({ file_path: "pixel.png", pages: "1" }, {}, invocation(gateway())),
    error => error?.code === "TOOL_ARGUMENTS_INVALID",
  );
});

test("TOOL-02 PDF parser selects exact pages and rejects invalid ranges", async () => {
  const pdf = await fs.readFile(new URL("../fixtures/tool02-two-pages.pdf", import.meta.url));
  const parsed = await parsers.parseFileBuffer("two-pages.pdf", pdf, { pdfPages: [2] });
  assert.equal(parsed.success, true);
  assert.equal(parsed.pageCount, 2);
  assert.deepEqual(parsed.renderedPages, [2]);
  assert.match(parsed.text, /SECOND_PAGE/u);
  assert(!parsed.text.includes("FIRST_PAGE"));
  assert.deepEqual(lux.parsePdfPageRange("1-3, 5"), [1, 2, 3, 5]);
  assert.throws(() => lux.parsePdfPageRange("3-1"), error => error?.code === "TOOL_ARGUMENTS_INVALID");
  const outside = await parsers.parseFileBuffer("two-pages.pdf", pdf, { pdfPages: [3] });
  assert.equal(outside.success, false);
  assert.match(outside.error, /共 2 页/u);
});

test("TOOL-02 edit and replace share atomic unique/all semantics and reject binary input", async () => {
  const execute = async (executor, args, source) => {
    let transformed;
    const output = await executor(args, {}, invocation(gateway({
      replaceFile: async (input, transform, options) => {
        transformed = await transform(source);
        return { rootId: "output", identity: {}, bytesWritten: transformed.bytes?.length ?? 0, value: transformed.value, input, options };
      },
    })));
    return { output, transformed };
  };
  const ambiguous = await execute(lux.editExec, { file_path: "a.txt", old_string: "same", new_string: "new" }, Buffer.from("same same"));
  assert.equal(ambiguous.transformed.bytes, null);
  assert.match(ambiguous.output, /出现了 2 次/u);
  const all = await execute(lux.replaceExec, { file_path: "a.txt", old_string: "same", new_string: "new", replace_all: true }, Buffer.from("same same"));
  assert.equal(all.transformed.bytes.toString(), "new new");
  assert.match(all.output, /替换 2 处/u);
  await assert.rejects(
    () => execute(lux.editExec, { file_path: "binary.bin", old_string: "x", new_string: "y" }, Buffer.from([0, 1, 2, 3])),
    error => error?.code === "TOOL_ARGUMENTS_INVALID",
  );
});

test("TOOL-02 glob supports basename recursion, double-star and brace choices", async () => {
  const tree = new Map([
    ["", [{ name: "src", type: "directory" }, { name: "root.ts", type: "file" }]],
    ["src", [{ name: "a.ts", type: "file" }, { name: "b.js", type: "file" }, { name: "nested", type: "directory" }]],
    ["src\\nested", [{ name: "c.tsx", type: "file" }, { name: "skip.md", type: "file" }]],
  ]);
  const pathGateway = gateway({ searchDirectory: async input => tree.get(input) ?? [] });
  const basename = await lux.globExec({ pattern: "*.ts" }, {}, invocation(pathGateway));
  assert.match(basename, /root\.ts/u);
  assert.match(basename, /src\\a\.ts/u);
  const braces = await lux.globExec({ pattern: "src/**/*.{ts,tsx}" }, {}, invocation(pathGateway));
  assert.match(braces, /src\\a\.ts/u);
  assert.match(braces, /src\\nested\\c\.tsx/u);
  assert(!braces.includes("b.js"));
});

test("TOOL-02 grep covers modes, context, type, offset, basic compatibility and multiline", async () => {
  const tree = new Map([["", [
    { name: "a.ts", type: "file" }, { name: "b.ts", type: "file" }, { name: "skip.bin", type: "file" },
  ]]]);
  const contents = new Map([
    ["a.ts", Buffer.from("before\nAlpha value\nafter\nstart\nacross\nend")],
    ["b.ts", Buffer.from("beta\nbeta")],
    ["skip.bin", Buffer.from([0, 1, 2])],
  ]);
  const pathGateway = gateway({
    searchDirectory: async input => tree.get(input) ?? [],
    searchFile: async input => ({ bytes: contents.get(input), rootId: "workspace", identity: {}, snapshot: {} }),
  });
  const content = await grepModule.grepExec({ pattern: "alpha", type: "ts", output_mode: "content", "-i": true, context: 1 }, {}, invocation(pathGateway));
  assert.match(content, /a\.ts-1-before/u);
  assert.match(content, /a\.ts:2:Alpha value/u);
  assert.match(content, /a\.ts-3-after/u);
  const count = await grepModule.grepExec({ pattern: "beta", type: "ts", output_mode: "count" }, {}, invocation(pathGateway));
  assert.match(count, /b\.ts:2/u);
  const files = await grepModule.grepExec({ pattern: "value|beta", type: "ts", output_mode: "files_with_matches", offset: 1, head_limit: 1 }, {}, invocation(pathGateway));
  assert.equal(files, "b.ts");
  const basic = await grepModule.grepExec({ pattern: "alpha\\|beta", type: "ts", output_mode: "files_with_matches", regex_dialect: "auto", "-i": true }, {}, invocation(pathGateway));
  assert.match(basic, /a\.ts/u);
  assert.match(basic, /b\.ts/u);
  const multiline = await grepModule.grepExec({ pattern: "start.*end", type: "ts", output_mode: "content", multiline: true }, {}, invocation(pathGateway));
  assert.match(multiline, /a\.ts:4:start/u);
  assert.match(multiline, /a\.ts:6:end/u);
});

test("TOOL-02 grep rejects catastrophic backtracking before path I/O", async () => {
  let pathCalls = 0;
  await assert.rejects(
    () => grepModule.grepExec({ pattern: "(a+)+$" }, {}, invocation(gateway({
      searchDirectory: async () => { pathCalls += 1; return []; },
    }))),
    error => error?.code === "TOOL_ARGUMENTS_INVALID" && /回溯|嵌套量词/u.test(error.message),
  );
  assert.equal(pathCalls, 0);
});

test("TOOL-02 grep shares one deadline across traversal and file scanning", async () => {
  const originalNow = Date.now;
  const ticks = [0, 0, 9_001];
  let fileReads = 0;
  Date.now = () => ticks.shift() ?? 9_001;
  try {
    const output = await grepModule.grepExec({ pattern: "needle" }, {}, invocation(gateway({
      searchDirectory: async () => [{ name: "late.txt", type: "file" }],
      searchFile: async () => { fileReads += 1; return { bytes: Buffer.from("needle"), rootId: "workspace", identity: {}, snapshot: {} }; },
    })));
    assert.match(output, /search timed out/u);
    assert.equal(fileReads, 0);
  } finally {
    Date.now = originalNow;
  }
});
