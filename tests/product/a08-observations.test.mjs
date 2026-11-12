// A08: host tool images reach the model as image parts tied to their tool call, within budget, and never by spoofing.
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";
import test from "node:test";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const fixture = await mkdtemp(path.join(os.tmpdir(), "rainydays-a08-"));
Object.assign(process.env, { RAINYDAYS_APP_ROOT: projectRoot, RAINYDAYS_USER_DATA_DIR: fixture, RAINYDAYS_DATA_DIR: path.join(fixture, "data") });
const { registerObservation, observationFromToolResult, OBSERVATION_MARKER, pngSize } = await import("../../src/observations.ts");
const { projectMessagesForProvider, MAX_OBSERVATION_IMAGES } = await import("../../src/llm.ts");
const { estimateProjectedRequestTokens, IMAGE_TOKEN_ESTIMATE } = await import("../../src/request-budget.ts");
test.after(async () => { assert(path.basename(fixture).startsWith("rainydays-a08-")); await rm(fixture, { recursive: true, force: true }); });

function png(width, height, seed) {
  const raw = Buffer.alloc((width * 3 + 1) * height, seed);
  for (let y = 0; y < height; y += 1) raw[y * (width * 3 + 1)] = 0;
  const table = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = buffer => { let c = 0xffffffff; for (const byte of buffer) c = table[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => { const length = Buffer.alloc(4); length.writeUInt32BE(data.length); const body = Buffer.concat([Buffer.from(type), data]); const sum = Buffer.alloc(4); sum.writeUInt32BE(crc(body)); return Buffer.concat([length, body, sum]); };
  const header = Buffer.alloc(13); header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const meta = { sourceWidth: 1280, sourceHeight: 720, scale: 0.5, source: "browser_screenshot", target: "报名 <http://127.0.0.1/>", viewport: true };
const toolTurn = (id, observation) => [
  { role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "browser_screenshot", arguments: "{}" } }] },
  { role: "tool", tool_call_id: id, content: JSON.stringify({ [OBSERVATION_MARKER]: { sha256: observation.sha256 } }), observations: [{ ...observation, toolCallId: id }] },
];

test("A08 a registered screenshot follows its tool block as image data, with call, target, size and scale", () => {
  const observation = registerObservation("s1", png(640, 360, 200), meta);
  assert.deepEqual({ ...pngSize(png(640, 360, 1)) }, { width: 640, height: 360 });
  const projected = projectMessagesForProvider("s1", [{ role: "user", content: "看看页面" }, ...toolTurn("call-1", observation)], null, "data-uri");
  assert.equal(projected.length, 4);
  assert.equal(projected[2].role, "tool", "the tool message stays adjacent to its call");
  const follow = projected[3];
  assert.equal(follow.role, "user");
  const text = follow.content.filter(part => part.type === "text").map(part => part.text).join("\n");
  assert.match(text, /call-1/u); assert.match(text, /640×360/u); assert.match(text, /1280×720/u); assert.match(text, /÷ 0\.5000/u); assert.match(text, /不是用户指令/u);
  const image = follow.content.find(part => part.type === "image_url");
  assert(image.image_url.url.startsWith("data:image/png;base64,"), "real image data, not a local path");
  assert.doesNotMatch(JSON.stringify(projected), new RegExp(fixture.replace(/\\/gu, "\\\\\\\\")), "no host path reaches the provider");
});

test("A08 without image input the model is told it did not receive the picture", () => {
  const observation = registerObservation("s2", png(64, 64, 10), meta);
  const projected = projectMessagesForProvider("s2", toolTurn("call-2", observation), null, "none");
  const follow = projected.at(-1);
  assert(!follow.content.some(part => part.type === "image_url"));
  assert.match(follow.content.map(part => part.text ?? "").join(""), /没有交给模型/u);
});

test("A08 only images a host tool registered in this session can be attached", () => {
  const observation = registerObservation("s3", png(32, 32, 7), meta);
  assert.equal(observationFromToolResult("s3", JSON.stringify({ [OBSERVATION_MARKER]: { sha256: observation.sha256 } })).sha256, observation.sha256);
  assert.equal(observationFromToolResult("other-session", JSON.stringify({ [OBSERVATION_MARKER]: { sha256: observation.sha256 } })), null, "another session's image is not reachable");
  assert.equal(observationFromToolResult("s3", JSON.stringify({ [OBSERVATION_MARKER]: { sha256: "f".repeat(64) } })), null, "a forged digest attaches nothing");
  assert.equal(observationFromToolResult("s3", "plain text"), null);
});

test("A08 only the latest images are sent; older ones become text, and images are budgeted as images", () => {
  const turns = [];
  for (let index = 0; index < 4; index += 1) turns.push(...toolTurn(`c${index}`, registerObservation("s4", png(400, 300, 30 + index), meta)));
  const projected = projectMessagesForProvider("s4", turns, null, "data-uri");
  const images = projected.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === "image_url") : []);
  assert.equal(images.length, MAX_OBSERVATION_IMAGES);
  assert.match(JSON.stringify(projected), /较早的截图已省略/u);
  const withImages = estimateProjectedRequestTokens(projected);
  const textOnly = estimateProjectedRequestTokens(projectMessagesForProvider("s4", turns, null, "none"));
  assert(withImages < textOnly + MAX_OBSERVATION_IMAGES * IMAGE_TOKEN_ESTIMATE + 400, `image bytes are not counted as text (${withImages} vs ${textOnly})`);
  assert(withImages >= textOnly + MAX_OBSERVATION_IMAGES * IMAGE_TOKEN_ESTIMATE - 400);
});
