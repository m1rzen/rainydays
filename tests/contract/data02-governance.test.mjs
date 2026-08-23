import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  buildData02ResolvedManifest,
  loadData02ResolvedManifest,
  projectRoot,
  validateData02ResolvedManifest,
} from "../../scripts/data02-governance.mjs";

const integrationTitle = "DATA-02 v2 round-trip preserves messages, Pins, Task DAG, and explicit attachment state";

test("DATA-02 resolved governance binds exact transfer runtime and evidence identities", async () => {
  const { manifest } = await loadData02ResolvedManifest();
  assert.equal(manifest.taskId, "DATA-02");
  assert.equal(manifest.runtimeEntries.length, 25);
  assert.equal(manifest.testEntries.length, 5);
  assert(manifest.runtimeEntries.some(entry => entry.exactCasePath === "src/session.ts"));
  assert(manifest.runtimeEntries.some(entry => entry.exactCasePath === "src/task.ts"));
  assert(manifest.runtimeEntries.some(entry => entry.exactCasePath === "src/attachment.ts"));
  assert(manifest.runtimeEntries.some(entry => entry.exactCasePath === "src/attachment-store.ts"));
  assert(manifest.testEntries.some(entry => entry.exactCasePath === "tests/integration/data02-session-transfer.test.mjs"));
  assert(manifest.testEntries.some(entry => entry.exactCasePath === "tests/integration/ds05-attachments.test.mjs"));
  assert.deepEqual(manifest, await buildData02ResolvedManifest());

  const sessionSource = await readFile(path.join(projectRoot, "src", "session.ts"), "utf8");
  assert.match(sessionSource, /const MAX_IMPORT_BYTES = 96 \* 1024 \* 1024/);
  assert.match(sessionSource, /normalizeTaskTransfer\(value\.tasks\)/);
  assert.match(sessionSource, /normalizeAttachments\(value\.attachments, messages\)/);
  assert.match(sessionSource, /validateAttachmentContent\(metadata, content\)/);
  assert.match(sessionSource, /validated\.sha256 !== sha256/);
  assert.match(sessionSource, /导入 assistant 工具调用缺少连续 tool 结果/);
  assert.match(sessionSource, /normalizeSessionImport\(exported\)/);

  const indexSource = await readFile(path.join(projectRoot, "src", "index.ts"), "utf8");
  assert.match(indexSource, /const sessionImportJsonBodyParser = express\.json\(\{ limit: "96mb" \}\)/);
  assert(indexSource.indexOf('app.use("/api", (req, res, next) => {') < indexSource.indexOf("const sessionImportJsonBodyParser"));
  assert.match(indexSource, /app\.post\("\/api\/sessions\/import", sessionImportJsonBodyParser/);

  const versionSource = await readFile(path.join(projectRoot, "src", "version.ts"), "utf8");
  assert.match(versionSource, /SUPPORTED_SESSION_EXPORT_VERSION = 2/);
  const integration = await readFile(path.join(projectRoot, "tests", "integration", "data02-session-transfer.test.mjs"), "utf8");
  assert.match(integration, new RegExp(integrationTitle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("DATA-02 resolved governance rejects payload and file identity substitution", async () => {
  const { manifest } = await loadData02ResolvedManifest();
  const payloadMutation = structuredClone(manifest);
  payloadMutation.runtimeEntries[0].owner = "OTHER";
  await assert.rejects(() => validateData02ResolvedManifest(payloadMutation));

  const digestMutation = structuredClone(manifest);
  digestMutation.runtimeEntries[0].sha256 = "0".repeat(64);
  await assert.rejects(() => validateData02ResolvedManifest(digestMutation));

  const extra = structuredClone(manifest);
  extra.untrusted = true;
  await assert.rejects(() => validateData02ResolvedManifest(extra));
});
