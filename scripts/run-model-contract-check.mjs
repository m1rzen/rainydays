// D02: checks one real OpenAI-compatible model configuration through the product's own LLM client.
// Credentials come only from RAINYDAYS_EVAL_API_KEY / RAINYDAYS_EVAL_BASE_URL and are never printed.
// Every request is counted and its usage recorded; missing usage is reported as unknown, never 0.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/u, "$1")), "..");
const option = (name, fallback) => { const index = process.argv.indexOf(`--${name}`); return index >= 0 ? process.argv[index + 1] : fallback; };
const apiKey = process.env.RAINYDAYS_EVAL_API_KEY, baseURL = process.env.RAINYDAYS_EVAL_BASE_URL;
if (!apiKey || !baseURL) throw new Error("RAINYDAYS_EVAL_API_KEY and RAINYDAYS_EVAL_BASE_URL are required");
const model = option("model", ""), out = option("out", "");
if (!model || !out) throw new Error("--model and --out are required");

await import(pathToFileURL(path.join(root, "scripts/eval-credential-preload.mjs")).href);
const { LLMClient } = await import(pathToFileURL(path.join(root, "dist/llm.js")).href);
const { probeProviderConnection } = await import(pathToFileURL(path.join(root, "dist/model-connection.js")).href);

const budget = { contextWindowTokens: 128000, outputReserveTokens: 4096 };
const client = (overrides = {}) => new LLMClient({ apiKey, baseURL, model, providerType: "openai-compatible", ...budget, ...overrides });
const requests = [];
const record = (step, usage) => requests.push({ step, usage: usage ?? "unknown" });
const results = {};
const check = (name, pass, detail = {}) => { results[name] = { pass: Boolean(pass), ...detail }; process.stdout.write(`${pass ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail).slice(0, 300)}\n`); };
const scrub = text => String(text ?? "").split(apiKey).join("[key]");

const weatherTool = { type: "function", function: { name: "get_weather", description: "查询城市当前天气", parameters: { type: "object", properties: { city: { type: "string", description: "城市中文名" } }, required: ["city"] } } };
const fixtureWeather = { 北京: "晴 21°C", 上海: "小雨 18°C" };

async function streamOnce(llm, messages, tools, step) {
  let deltas = 0, final = null, usage, retries = 0;
  for await (const event of llm.chatStream(messages, tools, AbortSignal.timeout(120_000))) {
    if (event.type === "delta") deltas += 1;
    else if (event.type === "retry") retries += 1;
    else if (event.type === "result") { final = event.message; usage = event.usage; }
  }
  record(step, usage);
  return { final, usage, deltas, retries };
}

// 1. Connection check: one short request, no files or history.
const probe = await probeProviderConnection(client(), AbortSignal.timeout(30_000));
record("probe", undefined);
check("probe", probe.ok && probe.code === "CONNECTED", { code: probe.code });

// 2. Non-streamed text with usage.
try {
  const reply = await client().chat([{ role: "user", content: "只回答一个字：好" }], undefined, AbortSignal.timeout(60_000));
  record("chat-text", reply.usage);
  check("chatText", typeof reply.content === "string" && reply.content.includes("好"), { content: String(reply.content).slice(0, 40), usage: reply.usage ?? "unknown" });
} catch (error) { check("chatText", false, { error: scrub(error.message).slice(0, 200) }); }

// 3. Streamed text.
try {
  const { final, usage, deltas } = await streamOnce(client(), [{ role: "user", content: "用一句话介绍杭州。" }], undefined, "stream-text");
  check("streamText", final && String(final.content).length > 4 && deltas > 0, { deltas, usage: usage ?? "unknown" });
} catch (error) { check("streamText", false, { error: scrub(error.message).slice(0, 200) }); }

// 4. Text -> tool calls -> tool results -> answer, streamed, as the Agent does it.
try {
  const llm = client(), messages = [{ role: "system", content: "需要天气数据时必须调用 get_weather，不要猜。" }, { role: "user", content: "北京和上海现在天气分别怎样？" }];
  let parallel = false, callsTotal = 0, argsValid = true, answer = "", rounds = 0, retries = 0;
  for (; rounds < 4; rounds += 1) {
    const turn = await streamOnce(llm, messages, [weatherTool], `tool-loop-${rounds + 1}`);
    retries += turn.retries;
    const calls = turn.final?.tool_calls ?? [];
    if (!calls.length) { answer = String(turn.final?.content ?? ""); break; }
    parallel ||= calls.length > 1; callsTotal += calls.length;
    messages.push(turn.final);
    for (const call of calls) {
      let args = {};
      try { args = JSON.parse(call.function.arguments || "{}"); } catch { argsValid = false; }
      messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify({ city: args.city, weather: fixtureWeather[args.city] ?? "未知城市" }) });
    }
  }
  check("toolLoop", callsTotal >= 2 && argsValid && /21/u.test(answer) && /18/u.test(answer), { requests: rounds + 1, toolCalls: callsTotal, parallelInOneTurn: parallel, argsValid, streamRetries: retries, answer: answer.slice(0, 120) });
} catch (error) { check("toolLoop", false, { error: scrub(error.message).slice(0, 200) }); }

// 5. Non-streamed tool call.
try {
  const reply = await client().chat([{ role: "user", content: "查一下北京天气。" }], [weatherTool], AbortSignal.timeout(60_000));
  record("chat-tool", reply.usage);
  const call = reply.tool_calls?.[0];
  let args = null; try { args = JSON.parse(call?.function?.arguments ?? "null"); } catch { /* invalid */ }
  check("chatToolCall", call?.function?.name === "get_weather" && args?.city === "北京", { usage: reply.usage ?? "unknown" });
} catch (error) { check("chatToolCall", false, { error: scrub(error.message).slice(0, 200) }); }

// 6. Error mapping, without retrying past the real answer.
const mapped = async (name, llm, expected) => {
  const result = await probeProviderConnection(llm, AbortSignal.timeout(30_000));
  record(`error-${name}`, undefined);
  check(`error:${name}`, !result.ok && expected.includes(result.code), { code: result.code });
};
await mapped("badKey", client({ apiKey: "obviously-invalid-key-for-d02" }), ["AUTHENTICATION", "PERMISSION"]);
await mapped("badModel", client({ model: "rainydays-no-such-model-d02" }), ["MODEL", "PERMISSION"]);
await mapped("unreachable", client({ baseURL: "http://127.0.0.1:9/v1" }), ["NETWORK", "TIMEOUT"]);

const summary = { model, baseURLHost: new URL(baseURL).host, at: new Date().toISOString(), results, requests, requestCount: requests.length, usageKnown: requests.filter(item => item.usage !== "unknown").length };
await fs.mkdir(path.dirname(path.resolve(out)), { recursive: true });
await fs.writeFile(path.resolve(out), JSON.stringify(summary, null, 1));
process.stdout.write(`requests=${summary.requestCount} usageKnown=${summary.usageKnown} pass=${Object.values(results).filter(item => item.pass).length}/${Object.keys(results).length}\n`);
