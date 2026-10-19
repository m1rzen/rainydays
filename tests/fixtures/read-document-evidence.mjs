import { createHash } from "node:crypto";
const [{ readExec }, { issueResourceOwner, retireResourceOwner }, { closeDb }, { readMessageAttachmentForSession }, { ConversationMemory }] = await Promise.all([
  import("../../src/tools/filesystem-lux.ts"), import("../../src/resource-owner.ts"), import("../../src/db.ts"), import("../../src/attachment-store.ts"), import("../../src/memory.ts"),
]);
const [sessionId, requestsJson] = process.argv.slice(2);
const owner = issueResourceOwner({ authorityId: "d06-fresh-process", authorityEpoch: 1, sessionId, principal: "agent", rootIds: [] });
try {
  const memory = new ConversationMemory(); memory.loadFromDb(sessionId);
  const documents = [];
  for (const { id, offset } of JSON.parse(requestsJson)) {
    const content = await readExec({ file_path: `attachment:${id}`, offset }, {}, { resourceOwner: owner, capabilityContext: { sessionId }, signal: new AbortController().signal });
    const { bytes } = readMessageAttachmentForSession(sessionId, id);
    documents.push({ content, sha256: createHash("sha256").update(bytes).digest("hex") });
  }
  const attachmentIds = memory.getAll().flatMap(message => message.attachments?.map(item => item.id) ?? []);
  console.log(`D06_RESULT:${JSON.stringify({ documents, attachmentIds })}`);
} finally { await retireResourceOwner(owner); await closeDb(); }
