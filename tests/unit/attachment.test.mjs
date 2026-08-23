import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import test from "node:test";
import {
  MAX_ATTACHMENT_BYTES,
  validateAttachmentContent,
  validateAttachmentIds,
  validateAttachmentUploadMetadata,
} from "../../dist/attachment.js";
import { projectMessagesForProvider } from "../../dist/llm.js";

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const output = Buffer.alloc(12 + data.length);
  output.writeUInt32BE(data.length, 0);
  name.copy(output, 4);
  data.copy(output, 8);
  output.writeUInt32BE(crc32(Buffer.concat([name, data])), 8 + data.length);
  return output;
}

function png(width = 1, height = 1, extra = []) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    ...extra,
    pngChunk("IDAT", deflateSync(Buffer.from([0, 0, 0, 0, 255]))),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngWithInvalidImageData() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", Buffer.from([0x78])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngWithTrailingCompressedInput() {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from("89504e470d0a1a0a", "hex"),
    pngChunk("IHDR", header),
    pngChunk("IDAT", Buffer.concat([deflateSync(Buffer.from([0, 0, 0, 0, 255])), Buffer.from("deadbeef", "hex")])),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function jpegWithoutScan() {
  return Buffer.from("ffd8ffc00011080001000103011100021100031100ffd9", "hex");
}

function webpWithoutImagePayload() {
  const bytes = Buffer.alloc(30);
  bytes.write("RIFF", 0, "ascii");
  bytes.writeUInt32LE(22, 4);
  bytes.write("WEBP", 8, "ascii");
  bytes.write("VP8X", 12, "ascii");
  bytes.writeUInt32LE(10, 16);
  return bytes;
}

test("DS-05 attachment metadata is exact, bounded and path-free", () => {
  assert.deepEqual(validateAttachmentUploadMetadata({ name: "photo.png", mime: "image/png", size: 10 }), {
    name: "photo.png", mime: "image/png", size: 10, kind: "image",
  });
  assert.deepEqual(validateAttachmentUploadMetadata({ name: "notes.md", mime: "", size: 10 }), {
    name: "notes.md", mime: "text/markdown", size: 10, kind: "text",
  });
  for (const input of [
    { name: "../photo.png", mime: "image/png", size: 10 },
    { name: "photo.png", mime: "image/jpeg", size: 10 },
    { name: "photo.jpg", mime: "image/jpeg", size: 10 },
    { name: "photo.webp", mime: "image/webp", size: 10 },
    { name: "movie.gif", mime: "image/gif", size: 10 },
    { name: "large.png", mime: "image/png", size: MAX_ATTACHMENT_BYTES + 1 },
    { name: "photo.png", mime: "image/png", size: 10, path: "C:\\secret.png" },
  ]) assert.throws(() => validateAttachmentUploadMetadata(input));
  assert.deepEqual(validateAttachmentIds(["att_" + "a".repeat(32)]), ["att_" + "a".repeat(32)]);
  assert.throws(() => validateAttachmentIds(["att_" + "a".repeat(32), "att_" + "a".repeat(32)]));
});

test("DS-05 validates canonical static image containers and UTF-8 text", () => {
  const image = png();
  const validated = validateAttachmentContent(
    validateAttachmentUploadMetadata({ name: "pixel.png", mime: "image/png", size: image.length }), image,
  );
  assert.equal(validated.sha256, createHash("sha256").update(image).digest("hex"));
  for (const [name, mime, bytes] of [["header.jpg", "image/jpeg", jpegWithoutScan()], ["header.webp", "image/webp", webpWithoutImagePayload()]]) {
    assert.throws(() => validateAttachmentContent({ name, mime, size: bytes.length, kind: "image" }, bytes), /unsupported/iu);
  }

  const corrupt = Buffer.from(image);
  corrupt[corrupt.length - 5] ^= 1;
  assert.throws(() => validateAttachmentContent(
    validateAttachmentUploadMetadata({ name: "pixel.png", mime: "image/png", size: corrupt.length }), corrupt,
  ), /CRC|IEND|critical chunk/iu);

  const animated = png(1, 1, [pngChunk("acTL", Buffer.alloc(8))]);
  assert.throws(() => validateAttachmentContent(
    validateAttachmentUploadMetadata({ name: "animated.png", mime: "image/png", size: animated.length }), animated,
  ), /Animated PNG/iu);

  const oversized = png(8193, 1);
  assert.throws(() => validateAttachmentContent(
    validateAttachmentUploadMetadata({ name: "wide.png", mime: "image/png", size: oversized.length }), oversized,
  ), /dimensions/iu);

  const invalidPng = pngWithInvalidImageData();
  assert.throws(() => validateAttachmentContent(
    validateAttachmentUploadMetadata({ name: "broken.png", mime: "image/png", size: invalidPng.length }), invalidPng,
  ), /cannot be decoded/iu);
  const trailingPng = pngWithTrailingCompressedInput();
  assert.throws(() => validateAttachmentContent(
    validateAttachmentUploadMetadata({ name: "trailing.png", mime: "image/png", size: trailingPng.length }), trailingPng,
  ), /cannot be decoded/iu);

  const text = Buffer.from("hello 世界", "utf8");
  assert.equal(validateAttachmentContent(
    validateAttachmentUploadMetadata({ name: "hello.txt", mime: "text/plain", size: text.length }), text,
  ).kind, "text");
  assert.throws(() => validateAttachmentContent(
    validateAttachmentUploadMetadata({ name: "bad.json", mime: "application/json", size: 1 }), Buffer.from("{")
  ), /JSON/iu);
});

test("DS-05 Provider projection emits image data parts and never path text", () => {
  const bytes = png();
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const attachment = Object.freeze({ id: `att_${"b".repeat(32)}`, name: "screen.png", mime: "image/png", size: bytes.length, sha256, kind: "image" });
  const resolver = (sessionId, id) => {
    assert.equal(sessionId, "session-a");
    assert.equal(id, attachment.id);
    return { attachment, bytes };
  };
  const projected = projectMessagesForProvider("session-a", [{ role: "user", content: "inspect", attachments: [attachment] }], resolver, "data-uri");
  assert.equal(projected[0].role, "user");
  assert.equal(projected[0].content[0].type, "text");
  assert.equal(projected[0].content[1].type, "image_url");
  assert(projected[0].content[1].image_url.url.startsWith("data:image/png;base64,"));
  assert.equal(Buffer.from(projected[0].content[1].image_url.url.split(",")[1], "base64").equals(bytes), true);
  assert.equal(JSON.stringify(projected).includes("C:\\"), false);
  assert.throws(() => projectMessagesForProvider("session-a", [{ role: "user", content: "inspect", attachments: [attachment] }], resolver, "none"), /PROVIDER_IMAGE_INPUT_UNSUPPORTED/u);
});
