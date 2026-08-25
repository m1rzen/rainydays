import assert from "node:assert/strict";
import test from "node:test";
import {
  createToolProtocolDescriptor,
  extractBodyToolCalls,
  getToolTimeoutMs,
  parseBodyToolArguments,
  parseToolInvocationArguments,
  renderBodyToolInstructions,
} from "../../dist/tool-protocol.js";
import { STATIC_TOOL_POLICIES } from "../../dist/tool-policies.js";
import { editFileDef, writeFileDef } from "../../dist/tools/filesystem.js";
import { editDef, replaceDef, writeDef } from "../../dist/tools/filesystem-lux.js";
import { executeCommandDef } from "../../dist/tools/shell.js";
import { scriptDef } from "../../dist/tools/script.js";

const descriptors = Object.freeze([
  createToolProtocolDescriptor(writeFileDef, STATIC_TOOL_POLICIES.write_file),
  createToolProtocolDescriptor(editFileDef, STATIC_TOOL_POLICIES.edit_file),
  createToolProtocolDescriptor(executeCommandDef, STATIC_TOOL_POLICIES.execute_command),
  createToolProtocolDescriptor(scriptDef, STATIC_TOOL_POLICIES.script),
]);
const canonicalDescriptors = Object.freeze([
  createToolProtocolDescriptor(writeDef, STATIC_TOOL_POLICIES.write),
  createToolProtocolDescriptor(editDef, STATIC_TOOL_POLICIES.edit),
  createToolProtocolDescriptor(replaceDef, STATIC_TOOL_POLICIES.replace),
]);
const byName = new Map([...descriptors, ...canonicalDescriptors].map(descriptor => [descriptor.name, descriptor]));

function invalid(action) {
  assert.throws(action, error => error?.code === "TOOL_ARGUMENTS_INVALID");
}

test("TOOL-01 unified descriptors bind schema, body, policy, effects, routing, concurrency and timeout", () => {
  const write = byName.get("write_file");
  assert.equal(write.schemaVersion, 1);
  assert.equal(write.schema, writeFileDef);
  assert.deepEqual(write.invocation.body, {
    kind: "raw", blockName: "WRITE", bodyParameter: "content",
    headers: [{ name: "path", parameter: "path", required: true }],
  });
  assert.equal(write.permissions, STATIC_TOOL_POLICIES.write_file);
  assert.equal(write.sideEffects, write.permissions.effects);
  assert.equal(write.hostBound, true);
  assert.equal(write.concurrency, "serial");
  assert.equal(write.timeoutMs, 30_000);
  assert.equal(getToolTimeoutMs("glob"), 10_000);
  assert.equal(getToolTimeoutMs("grep"), 10_000);
  assert.equal(byName.get("execute_command").timeoutMs, 60_000);
  assert.equal(byName.get("script").timeoutMs, 60_000);
  assert.equal(getToolTimeoutMs("unknown_fixture"), 30_000);
  assert(Object.isFrozen(write));
  assert(Object.isFrozen(write.invocation));
  assert(Object.isFrozen(write.invocation.body));
});

test("TOOL-01 raw body modes preserve quotes, slashes, dollars and multiline text without JSON escaping", () => {
  const writeBody = String.raw`#+BEGIN_WRITE :path "folder/report a.md"
first "quoted" line
C:\temp\file
${"${HOME} && $(echo untouched)"}

last line
#+END_WRITE`;
  const write = parseToolInvocationArguments(writeBody, byName.get("write_file"), { allowBody: true });
  assert.equal(write.mode, "body");
  assert.equal(write.args.path, "folder/report a.md");
  assert.equal(write.args.content, String.raw`first "quoted" line
C:\temp\file
${"${HOME} && $(echo untouched)"}

last line`);

  const bashBody = String.raw`#+BEGIN_BASH :cwd 'folder with spaces'
printf '%s\n' '"quoted"' "$HOME"
#+END_BASH`;
  assert.deepEqual({ ...parseBodyToolArguments(bashBody, byName.get("execute_command")) }, {
    cwd: "folder with spaces",
    command: String.raw`printf '%s\n' '"quoted"' "$HOME"`,
  });

  const scriptCode = `const value = { quote: "'\\\\slash" };\nconsole.log(JSON.stringify(value));`;
  const scriptBody = `#+BEGIN_SCRIPT\n${scriptCode}\n#+END_SCRIPT`;
  assert.equal(parseBodyToolArguments(scriptBody, byName.get("script")).code, scriptCode);
});

test("TOOL-01 protected org lines preserve raw terminators and existing comma prefixes", () => {
  const write = `#+BEGIN_WRITE :path "markers.txt"
before
,#+END_WRITE
,,#+END_WRITE
after
#+END_WRITE`;
  assert.equal(parseBodyToolArguments(write, byName.get("write_file")).content, `before
#+END_WRITE
,#+END_WRITE
after`);

  const script = `#+BEGIN_SCRIPT
console.log("before");
,#+BEGIN_SCRIPT :literal true
,#+END_SCRIPT
console.log("after");
#+END_SCRIPT`;
  assert.equal(parseBodyToolArguments(script, byName.get("script")).code, `console.log("before");
#+BEGIN_SCRIPT :literal true
#+END_SCRIPT
console.log("after");`);
});

test("TOOL-01 sectioned EDIT carries two independent raw multiline values", () => {
  const body = `#+BEGIN_EDIT :path "src/example.ts" :replace_all false
#+BEGIN_OLD_STRING
const oldValue = "a\\b";
line two
#+END_OLD_STRING
#+BEGIN_NEW_STRING
const newValue = 'x"y';
line two changed
#+END_NEW_STRING
#+END_EDIT`;
  assert.deepEqual({ ...parseBodyToolArguments(body, byName.get("edit_file")) }, {
    path: "src/example.ts",
    replace_all: false,
    old_string: `const oldValue = "a\\b";\nline two`,
    new_string: `const newValue = 'x"y';\nline two changed`,
  });
});

test("TOOL-02 canonical write/edit/replace body modes use file_path and preserve raw values", () => {
  const write = parseBodyToolArguments(`#+BEGIN_WRITE :file_path "folder/a b.txt"\nraw \\\\ "quoted" $value\n#+END_WRITE`, byName.get("write"));
  assert.deepEqual({ ...write }, { file_path: "folder/a b.txt", content: String.raw`raw \\ "quoted" $value` });
  const edit = parseBodyToolArguments(`#+BEGIN_EDIT :file_path "a.txt" :replace_all true\n#+BEGIN_OLD_STRING\nsame\n#+END_OLD_STRING\n#+BEGIN_NEW_STRING\nnew\n#+END_NEW_STRING\n#+END_EDIT`, byName.get("edit"));
  assert.deepEqual({ ...edit }, { file_path: "a.txt", replace_all: true, old_string: "same", new_string: "new" });
  const replace = parseBodyToolArguments(`#+BEGIN_REPLACE :file_path "a.txt"\n#+BEGIN_OLD_STRING\nold\n#+END_OLD_STRING\n#+BEGIN_NEW_STRING\nnew\n#+END_NEW_STRING\n#+END_REPLACE`, byName.get("replace"));
  assert.deepEqual({ ...replace }, { file_path: "a.txt", old_string: "old", new_string: "new" });
});

test("TOOL-01 extraction supports multiple calls and leaves surrounding prose out of raw arguments", () => {
  const write = `#+BEGIN_WRITE :path "a.txt"\nalpha\n#+END_WRITE`;
  const script = `#+BEGIN_SCRIPT\nconsole.log("beta")\n#+END_SCRIPT`;
  const extracted = extractBodyToolCalls(`Before\n${write}\nBetween\n${script}\nAfter`, descriptors);
  assert.equal(extracted.content, "Before\n\nBetween\n\nAfter");
  assert.deepEqual(extracted.calls.map(call => call.toolName), ["write_file", "script"]);
  assert.equal(extracted.calls[0].rawArguments, write);
  assert.equal(extracted.calls[1].rawArguments, script);
  assert.equal(parseBodyToolArguments(extracted.calls[0].rawArguments, byName.get("write_file")).content, "alpha");

  const unknown = extractBodyToolCalls("#+BEGIN_UNKNOWN\ntext\n#+END_UNKNOWN", descriptors);
  assert.equal(unknown.content, "#+BEGIN_UNKNOWN\ntext\n#+END_UNKNOWN");
  assert.deepEqual(unknown.calls, []);

  const malformedThenValid = extractBodyToolCalls(`#+BEGIN_SCRIPT
broken body starts here
ordinary answer remains visible
${write}`, descriptors);
  assert.equal(malformedThenValid.content, `#+BEGIN_SCRIPT
broken body starts here
ordinary answer remains visible`);
  assert.deepEqual(malformedThenValid.calls.map(call => call.toolName), ["script", "write_file"]);
  invalid(() => parseBodyToolArguments(malformedThenValid.calls[0].rawArguments, byName.get("script")));
  assert.equal(parseBodyToolArguments(malformedThenValid.calls[1].rawArguments, byName.get("write_file")).content, "alpha");

  const validScript = `#+BEGIN_SCRIPT\nconsole.log("valid")\n#+END_SCRIPT`;
  const malformedSameThenValid = extractBodyToolCalls(`#+BEGIN_SCRIPT\nbroken same-kind block\nordinary same-kind answer\n${validScript}`, descriptors);
  assert.equal(malformedSameThenValid.content, `#+BEGIN_SCRIPT\nbroken same-kind block\nordinary same-kind answer`);
  assert.deepEqual(malformedSameThenValid.calls.map(call => call.toolName), ["script", "script"]);
  invalid(() => parseBodyToolArguments(malformedSameThenValid.calls[0].rawArguments, byName.get("script")));
  assert.equal(parseBodyToolArguments(malformedSameThenValid.calls[1].rawArguments, byName.get("script")).code, `console.log("valid")`);
});

test("TOOL-01 JSON and body failures share fail-closed TOOL_ARGUMENTS_INVALID semantics", () => {
  invalid(() => parseToolInvocationArguments("{bad-json", byName.get("write_file")));
  invalid(() => parseToolInvocationArguments("#+BEGIN_WRITE :path \"x.txt\"\nmissing end", byName.get("write_file"), { allowBody: true }));
  invalid(() => parseBodyToolArguments("#+BEGIN_WRITE\ncontent\n#+END_WRITE", byName.get("write_file")));
  invalid(() => parseBodyToolArguments("#+BEGIN_WRITE :unknown value :path x\ncontent\n#+END_WRITE", byName.get("write_file")));
  invalid(() => parseBodyToolArguments("#+BEGIN_WRITE :path x :path y\ncontent\n#+END_WRITE", byName.get("write_file")));
  invalid(() => parseBodyToolArguments("#+BEGIN_WRITE :__proto__ x :path y\ncontent\n#+END_WRITE", byName.get("write_file")));
  invalid(() => parseBodyToolArguments("#+BEGIN_BASH\ncommand\n#+END_BASH\ntrailing", byName.get("execute_command")));
  invalid(() => parseBodyToolArguments("#+BEGIN_EDIT :path x\n#+BEGIN_NEW_STRING\nnew\n#+END_NEW_STRING\n#+END_EDIT", byName.get("edit_file")));
  invalid(() => parseToolInvocationArguments("#+BEGIN_WRITE :path x\nbody\n#+END_WRITE", null, { allowBody: true }));
  invalid(() => parseToolInvocationArguments("#+BEGIN_SCRIPT\nconsole.log('disabled')\n#+END_SCRIPT", byName.get("script"), { allowBody: false }));
  invalid(() => parseBodyToolArguments(`#+BEGIN_SCRIPT\n${"x".repeat(512 * 1024)}\n#+END_SCRIPT`, byName.get("script")));
  const tooManyCalls = Array.from({ length: 17 }, (_, index) => `#+BEGIN_SCRIPT\nconsole.log(${index})\n#+END_SCRIPT`).join("\n");
  invalid(() => extractBodyToolCalls(tooManyCalls, descriptors));
});

test("TOOL-01 generated prompt advertises exact context-supported body forms", () => {
  const instructions = renderBodyToolInstructions(descriptors);
  for (const marker of ["#+BEGIN_WRITE", "#+END_WRITE", "#+BEGIN_EDIT", "#+BEGIN_OLD_STRING", "#+BEGIN_NEW_STRING", "#+BEGIN_BASH", "#+BEGIN_SCRIPT"]) {
    assert.match(instructions, new RegExp(marker.replace("+", "\\+"), "u"));
  }
  assert.match(instructions, /without JSON escaping/u);
  assert.equal(renderBodyToolInstructions([]), "");
});
