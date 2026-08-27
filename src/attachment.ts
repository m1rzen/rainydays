import { createHash } from "node:crypto";
import path from "node:path";
import { inflateSync } from "node:zlib";
import type { Message, MessageAttachment } from "./types.js";

export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
export const MAX_DRAFT_ATTACHMENT_BYTES = 24 * 1024 * 1024;
export const MAX_TEXT_ATTACHMENT_BYTES = 1024 * 1024;
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;
export const MAX_IMAGE_PIXELS = 16_777_216;
export const MAX_IMAGE_DIMENSION = 8_192;

export type AttachmentState = "uploading" | "ready" | "failed" | "cancelled";
export type AttachmentKind = "image" | "text";

export interface AttachmentUploadMetadata {
  readonly name: string;
  readonly mime: string;
  readonly size: number;
  readonly kind: AttachmentKind;
}

export interface ValidatedAttachmentContent extends AttachmentUploadMetadata {
  readonly bytes: Buffer;
  readonly sha256: string;
}

const MIME_BY_EXTENSION = Object.freeze<Record<string, string>>({
  ".png": "image/png",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".markdown": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
});
const IMAGE_MIMES = new Set(["image/png"]);
const TEXT_MIMES = new Set(["text/plain", "text/markdown", "text/csv", "application/json"]);

function exactObject(value: unknown, keys: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)) {
    throw new TypeError(`${field} must be a plain object`);
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join("\0") !== [...keys].sort().join("\0")) {
    throw new TypeError(`${field} fields are invalid`);
  }
  return record;
}

export function validateAttachmentId(value: unknown): string {
  if (typeof value !== "string" || !/^att_[a-f0-9]{32}$/u.test(value)) throw new TypeError("Attachment ID is invalid");
  return value;
}

export function validateAttachmentIds(value: unknown): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS_PER_MESSAGE) throw new TypeError("Attachment ID list is invalid");
  const ids = value.map(validateAttachmentId);
  if (new Set(ids).size !== ids.length) throw new TypeError("Attachment IDs must be unique");
  return Object.freeze(ids);
}

function attachmentName(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Attachment name is invalid");
  const name = value.normalize("NFC").trim();
  if (!name || name === "." || name === ".." || Buffer.byteLength(name, "utf8") > 255
    || /[\u0000-\u001f\u007f/\\]/u.test(name)) throw new TypeError("Attachment name is invalid");
  return name;
}

function canonicalMime(name: string, value: unknown): string {
  if (typeof value !== "string") throw new TypeError("Attachment MIME is invalid");
  const supplied = value.trim().toLowerCase().split(";", 1)[0];
  const inferred = MIME_BY_EXTENSION[path.extname(name).toLowerCase()] ?? "";
  const mime = supplied || inferred;
  if (supplied && inferred && supplied !== inferred) throw new TypeError("Attachment extension and MIME differ");
  if (!IMAGE_MIMES.has(mime) && !TEXT_MIMES.has(mime)) throw new TypeError("Attachment type is unsupported");
  return mime;
}

export function validateAttachmentUploadMetadata(value: unknown): AttachmentUploadMetadata {
  const record = exactObject(value, ["name", "mime", "size"], "Attachment metadata");
  const name = attachmentName(record.name);
  const mime = canonicalMime(name, record.mime);
  const kind = IMAGE_MIMES.has(mime) ? "image" : "text";
  const maximum = kind === "image" ? MAX_ATTACHMENT_BYTES : MAX_TEXT_ATTACHMENT_BYTES;
  if (!Number.isSafeInteger(record.size) || (record.size as number) < 1 || (record.size as number) > maximum) {
    throw new TypeError("Attachment size is invalid");
  }
  return Object.freeze({ name, mime, size: record.size as number, kind });
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function validatePngContainer(bytes: Buffer): readonly [number, number] {
  let offset = 8;
  let chunkIndex = 0;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  let sawPalette = false;
  let sawImageData = false;
  let leftImageData = false;
  let sawEnd = false;
  const imageData: Buffer[] = [];
  while (offset + 12 <= bytes.length) {
    const length = bytes.readUInt32BE(offset);
    const end = offset + 12 + length;
    if (end > bytes.length) throw new TypeError("PNG chunk length is invalid");
    const typeBytes = bytes.subarray(offset + 4, offset + 8);
    const type = typeBytes.toString("ascii");
    if (!/^[A-Za-z]{4}$/u.test(type)) throw new TypeError("PNG chunk type is invalid");
    if (chunkIndex === 0 && (type !== "IHDR" || length !== 13)) throw new TypeError("PNG IHDR is invalid");
    if (type === "acTL" || type === "fcTL" || type === "fdAT") throw new TypeError("Animated PNG is unsupported");
    if (type === "IHDR") {
      if (chunkIndex !== 0 || length !== 13) throw new TypeError("PNG IHDR is invalid");
      width = bytes.readUInt32BE(offset + 8);
      height = bytes.readUInt32BE(offset + 12);
      bitDepth = bytes[offset + 16];
      colorType = bytes[offset + 17];
      const validDepths: Readonly<Record<number, readonly number[]>> = Object.freeze({
        0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16],
      });
      if (!validDepths[colorType]?.includes(bitDepth) || bytes[offset + 18] !== 0 || bytes[offset + 19] !== 0 || bytes[offset + 20] !== 0) {
        throw new TypeError("PNG IHDR parameters are unsupported");
      }
    } else if (type === "PLTE") {
      if (sawPalette || sawImageData || length < 3 || length > 768 || length % 3 !== 0 || colorType === 0 || colorType === 4) {
        throw new TypeError("PNG palette is invalid");
      }
      sawPalette = true;
    } else if (type === "IDAT") {
      if (leftImageData) throw new TypeError("PNG IDAT chunks are not consecutive");
      sawImageData = true;
      imageData.push(Buffer.from(bytes.subarray(offset + 8, offset + 8 + length)));
    } else {
      if (sawImageData && type !== "IEND") leftImageData = true;
      if ((typeBytes[0] & 0x20) === 0 && type !== "IEND") throw new TypeError("PNG critical chunk is unsupported");
    }
    const expected = bytes.readUInt32BE(offset + 8 + length);
    if (crc32(bytes.subarray(offset + 4, offset + 8 + length)) !== expected) throw new TypeError("PNG chunk CRC is invalid");
    offset = end;
    chunkIndex += 1;
    if (type === "IEND") {
      if (length !== 0 || offset !== bytes.length) throw new TypeError("PNG IEND is invalid");
      sawEnd = true;
      break;
    }
  }
  if (!sawImageData || !sawEnd || (colorType === 3 && !sawPalette)) throw new TypeError("PNG image data is incomplete");
  if (!width || !height || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
    throw new TypeError("Attachment image dimensions are unsafe");
  }
  const channels = colorType === 0 || colorType === 3 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  const rowBytes = Math.ceil(width * channels * bitDepth / 8);
  const decodedBytes = (rowBytes + 1) * height;
  if (!Number.isSafeInteger(decodedBytes) || decodedBytes < 1 || decodedBytes > 80 * 1024 * 1024) throw new TypeError("PNG decoded size is unsafe");
  const compressed = Buffer.concat(imageData);
  let decoded: Buffer;
  try {
    const result = inflateSync(compressed, { maxOutputLength: decodedBytes, info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten: number };
    };
    if (result.engine.bytesWritten !== compressed.length) throw new Error("trailing compressed input");
    decoded = result.buffer;
  } catch { throw new TypeError("PNG image data cannot be decoded"); }
  if (decoded.length !== decodedBytes) throw new TypeError("PNG scanline length is invalid");
  for (let row = 0; row < height; row += 1) {
    if (decoded[row * (rowBytes + 1)] > 4) throw new TypeError("PNG scanline filter is invalid");
  }
  return [width, height];
}

function imageDimensions(bytes: Buffer, mime: string): readonly [number, number] {
  if (mime !== "image/png") throw new TypeError("Attachment image type is unsupported");
  if (bytes.length < 24 || bytes.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") throw new TypeError("PNG signature is invalid");
  return validatePngContainer(bytes);
}

function validateImage(bytes: Buffer, mime: string): void {
  const [width, height] = imageDimensions(bytes, mime);
  if (!width || !height || width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION || width * height > MAX_IMAGE_PIXELS) {
    throw new TypeError("Attachment image dimensions are unsafe");
  }
}

function validateText(bytes: Buffer, mime: string): void {
  let text: string;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { throw new TypeError("Attachment text is not valid UTF-8"); }
  if (text.includes("\0")) throw new TypeError("Attachment text contains NUL");
  if (mime === "application/json") {
    try { JSON.parse(text); }
    catch { throw new TypeError("Attachment JSON is invalid"); }
  }
}

export function validateAttachmentContent(metadata: AttachmentUploadMetadata, input: Uint8Array): ValidatedAttachmentContent {
  if ((metadata.kind === "image" && !IMAGE_MIMES.has(metadata.mime))
    || (metadata.kind === "text" && !TEXT_MIMES.has(metadata.mime))) throw new TypeError("Attachment type is unsupported");
  if (!(input instanceof Uint8Array)) throw new TypeError("Attachment bytes are invalid");
  const bytes = Buffer.from(input);
  if (bytes.length !== metadata.size || bytes.length < 1 || bytes.length > MAX_ATTACHMENT_BYTES) throw new TypeError("Attachment byte length differs");
  if (metadata.kind === "image") validateImage(bytes, metadata.mime);
  else validateText(bytes, metadata.mime);
  return Object.freeze({ ...metadata, bytes, sha256: createHash("sha256").update(bytes).digest("hex") });
}

export function attachmentLabel(attachment: MessageAttachment): string {
  return `${attachment.name} (${attachment.mime}, ${attachment.size} bytes)`;
}

export function messageAttachmentTokenText(message: Message): string {
  return (message.attachments ?? []).map(attachmentLabel).join("\n");
}
