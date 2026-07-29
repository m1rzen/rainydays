import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import {
  SCHEMA_VERSION,
  canonicalize,
  deriveContracts,
  parseMarkdown,
  readJson,
  sha256File,
  toPosix,
  validateManifest,
} from "./baseline-lib.mjs";

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const PARITY_DIR = path.resolve(SCRIPT_DIR, "..");
const DEFAULT_OUTPUT_DIR = path.join(PARITY_DIR, "baselines");
const PROBE_SOURCE = path.join(PARITY_DIR, "probes", "tool-catalog-mod.mjs");
const PROBE_DIR = path.join(PARITY_DIR, ".probe");

function parseArgs(argv) {
  const result = { luxRoot: "", output: "", keepProbe: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--lux-root") result.luxRoot = argv[++index] ?? "";
    else if (value === "--output") result.output = argv[++index] ?? "";
    else if (value === "--keep-probe") result.keepProbe = true;
    else if (value === "--help" || value === "-h") {
      console.log("Usage: node capture-lux-baseline.mjs --lux-root <path> [--output <path>] [--keep-probe]");
      process.exit(0);
    } else throw new Error(`Unknown argument: ${value}`);
  }
  if (!result.luxRoot) throw new Error("--lux-root is required");
  result.luxRoot = path.resolve(result.luxRoot);
  return result;
}

async function listFiles(directory, predicate) {
  const output = [];
  const entries = await readdir(directory, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await listFiles(absolute, predicate));
    else if (entry.isFile() && predicate(absolute)) output.push(absolute);
  }
  return output.sort((left, right) => left.localeCompare(right));
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function sourceRecord(luxRoot, relativePath, kind, required = true) {
  const absolute = path.join(luxRoot, ...relativePath.split("/"));
  const present = await exists(absolute);
  if (required && !present) throw new Error(`Required Lux source missing: ${relativePath}`);
  if (!present) return { path: relativePath, kind, required, present: false, size: null, sha256: null };
  const fileStat = await stat(absolute);
  if (!fileStat.isFile()) throw new Error(`Lux source is not a file: ${relativePath}`);
  return {
    path: relativePath,
    kind,
    required,
    present: true,
    size: fileStat.size,
    sha256: await sha256File(absolute),
  };
}

function parseFrontmatter(content) {
  if (!content.startsWith("---")) return {};
  const end = content.indexOf("\n---", 3);
  if (end < 0) return {};
  const result = {};
  for (const line of content.slice(3, end).split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line.trim());
    if (match) result[match[1]] = match[2].replace(/^['"]|['"]$/g, "");
  }
  return result;
}

async function waitForFile(filePath, child, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await exists(filePath)) return;
    if (child.exitCode !== null) throw new Error(`Lux Server exited before probe completed (exit ${child.exitCode})`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Runtime tool probe timed out after ${timeoutMs} ms`);
}

async function waitForServerPort(logs, child, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const match = /\[lux-server:ready\]\s+port=(\d+)/.exec(logs.stdout);
    if (match) return Number(match[1]);
    if (child.exitCode !== null) throw new Error(`Lux Server exited before becoming ready (exit ${child.exitCode})`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Lux Server did not report a ready port after ${timeoutMs} ms`);
}

async function createLocalProviderSink() {
  const apiKey = `gov01-local-${randomBytes(24).toString("hex")}`;
  let resolveRequest;
  let rejectRequest;
  const request = new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
  const server = createServer((incoming, response) => {
    if (incoming.method !== "POST" || incoming.url !== "/v1/chat/completions") {
      response.writeHead(404, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify({ error: "not found" }));
      return;
    }
    if (incoming.headers.authorization !== `Bearer ${apiKey}`) {
      response.writeHead(401, { "content-type": "application/json", connection: "close" });
      response.end(JSON.stringify({ error: "unauthorized" }));
      return;
    }
    let body = "";
    incoming.setEncoding("utf8");
    incoming.on("data", (chunk) => {
      body += chunk;
      if (body.length > 16 * 1024 * 1024) incoming.destroy(new Error("Provider probe request exceeded 16 MiB"));
    });
    incoming.on("error", rejectRequest);
    incoming.on("end", () => {
      try {
        const parsed = JSON.parse(body);
        if (Array.isArray(parsed.tools) && parsed.tools.length > 0) resolveRequest(parsed);
        const chunk = {
          id: "gov01-local-sink",
          object: "chat.completion.chunk",
          created: 0,
          model: "gov01-local-sink",
          choices: [{ index: 0, delta: { content: "OK" }, finish_reason: "stop" }],
        };
        response.writeHead(200, { "content-type": "text/event-stream", connection: "close" });
        response.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
      } catch (error) {
        rejectRequest(error);
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid local contract probe request" }));
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Local provider sink did not expose a TCP port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    apiKey,
    request,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function captureDefaultSessionContract(port, providerRequest) {
  if (typeof WebSocket !== "function") throw new Error("This Node.js runtime does not provide a WebSocket client");
  const sessionId = "gov01-default-session-contract-probe";
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  let opened = false;
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("WebSocket connection timed out")), 5000);
      socket.addEventListener("open", () => { opened = true; clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("WebSocket connection failed")); }, { once: true });
    });
    socket.send(JSON.stringify({ cmd: "daemon_stop", name: "overseer" }));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const membership = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Default Session initialization timed out")), 15000);
      let catalog;
      let ready = false;
      const finish = () => {
        if (!catalog || !ready) return;
        clearTimeout(timer);
        resolve(catalog);
      };
      socket.addEventListener("message", (event) => {
        let message;
        try { message = JSON.parse(String(event.data)); } catch { return; }
        if (message.sessionId !== sessionId) return;
        if (message.type === "tool_definitions_updated") {
          catalog = {
            personaName: String(message.personaName ?? ""),
            toolCount: Number(message.toolCount),
            toolNames: Array.isArray(message.toolNames) ? [...message.toolNames].map(String).sort() : [],
          };
        } else if (message.type === "ready") ready = true;
        finish();
      });
      socket.send(JSON.stringify({ cmd: "session_create", sessionId, name: "GOV-01 Default Session Contract Probe", config: {} }));
    });
    if (!membership.personaName) throw new Error("Default Session probe returned no Persona name");
    if (membership.toolNames.length === 0 || membership.toolCount !== membership.toolNames.length) {
      throw new Error("Default Session probe returned an invalid base tool catalog");
    }
    socket.send(JSON.stringify({ sessionId, cmd: "run", id: "gov01-model-contract-run", input: "Return OK." }));
    const request = await Promise.race([
      providerRequest,
      new Promise((_, reject) => setTimeout(() => reject(new Error("Model-facing tool contract request timed out")), 15000)),
    ]);
    return { membership, providerTools: request.tools };
  } finally {
    if (opened && socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ cmd: "session_destroy", sessionId }));
    }
    socket.close();
  }
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 2500)),
  ]);
  if (exited) return;
  if (process.platform === "win32") {
    await new Promise((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      killer.once("exit", resolve);
      killer.once("error", resolve);
    });
  } else child.kill("SIGKILL");
}

async function runRuntimeProbe(luxRoot, keepProbe) {
  await mkdir(PROBE_DIR, { recursive: true });
  const runDir = await mkdtemp(path.join(PROBE_DIR, "run-"));
  const luxHome = path.join(runDir, "lux-home");
  const modDir = path.join(luxHome, "mods", "parity-tool-catalog");
  const outputPath = path.join(runDir, "tool-catalog.json");
  await mkdir(modDir, { recursive: true });
  await copyFile(PROBE_SOURCE, path.join(modDir, "mod.mjs"));
  await writeFile(path.join(modDir, "package.json"), JSON.stringify({ name: "parity-tool-catalog", version: "1.0.0", lux: { priority: 9999 } }, null, 2));
  const providerSink = await createLocalProviderSink();

  const nodeExecutable = process.platform === "win32" && await exists(path.join(luxRoot, "node.exe"))
    ? path.join(luxRoot, "node.exe")
    : process.execPath;
  const serverPath = path.join(luxRoot, "lux-server.mjs");
  const logs = { stdout: "", stderr: "" };
  const child = spawn(nodeExecutable, [
    serverPath,
    "--port", "0",
    "--host", "127.0.0.1",
    "--no-open",
    "--base-url", providerSink.baseUrl,
    "--api-key", providerSink.apiKey,
    "--model", "gov01-local-sink",
  ], {
    cwd: luxRoot,
    env: {
      PATH: process.env.PATH ?? "",
      SystemRoot: process.env.SystemRoot ?? "",
      TEMP: process.env.TEMP ?? "",
      TMP: process.env.TMP ?? "",
      LUX_HOME: luxHome,
      LUX_PARITY_PROBE_OUTPUT: outputPath,
    },
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { logs.stdout = (logs.stdout + chunk).slice(-12000); });
  child.stderr.on("data", (chunk) => { logs.stderr = (logs.stderr + chunk).slice(-12000); });

  try {
    const [port] = await Promise.all([
      waitForServerPort(logs, child, 25000),
      waitForFile(outputPath, child, 25000),
    ]);
    const [output, sessionContract] = await Promise.all([
      readJson(outputPath),
      captureDefaultSessionContract(port, providerSink.request),
    ]);
    if (output.error) throw new Error(`Runtime tool probe failed: ${output.error}`);
    if (!output.stable) throw new Error("Runtime tool registry did not become stable");
    if (!Array.isArray(output.tools) || output.tools.length === 0) throw new Error("Runtime tool probe returned zero tools");
    const baseDefinitions = output.tools.map((tool) => canonicalize(tool));
    const baseNames = baseDefinitions.map((tool) => tool.name).sort();
    if (JSON.stringify(baseNames) !== JSON.stringify(sessionContract.membership.toolNames)) {
      throw new Error("Mod API definitions do not match the default Session base membership event");
    }
    const modelDefinitions = sessionContract.providerTools.map((tool, index) => {
      if (tool?.type !== "function" || !tool.function) throw new Error(`Invalid model-facing tool entry at index ${index}`);
      return canonicalize(tool.function);
    });
    const modelByName = new Map();
    for (const definition of modelDefinitions) {
      if (!definition.name || modelByName.has(definition.name)) throw new Error(`Invalid or duplicate model-facing tool: ${definition.name ?? "<unnamed>"}`);
      modelByName.set(definition.name, definition);
    }
    for (const baseDefinition of baseDefinitions) {
      const modelDefinition = modelByName.get(baseDefinition.name);
      if (!modelDefinition || JSON.stringify(modelDefinition) !== JSON.stringify(baseDefinition)) {
        throw new Error(`Base Registry definition does not match model-facing Schema: ${baseDefinition.name}`);
      }
    }
    return {
      ...output,
      sessionMembership: sessionContract.membership,
      modelTools: [...modelDefinitions].sort((left, right) => left.name.localeCompare(right.name)),
    };
  } catch (error) {
    throw new Error(`${error instanceof Error ? error.message : String(error)}\nLux stdout:\n${logs.stdout}\nLux stderr:\n${logs.stderr}`);
  } finally {
    try {
      await stopProcess(child);
    } finally {
      try {
        await providerSink.close();
      } finally {
        if (!keepProbe) await rm(runDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      }
    }
  }
}

async function loadInstalledSkills(luxRoot, sourceRecords) {
  const directory = path.join(luxRoot, "skills");
  const files = await listFiles(directory, (file) => file.endsWith(".md"));
  if (files.length === 0) throw new Error("No installed Lux skills found");
  const skills = [];
  for (const absolute of files) {
    const relative = toPosix(path.relative(luxRoot, absolute));
    const content = await readFile(absolute, "utf8");
    const source = await sourceRecord(luxRoot, relative, "skill");
    sourceRecords.push(source);
    const frontmatter = parseFrontmatter(content);
    skills.push(canonicalize({
      name: frontmatter.name || path.basename(absolute, ".md"),
      description: frontmatter.description || "",
      path: relative,
      sha256: source.sha256,
    }));
  }
  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

async function loadInstalledPersonas(luxRoot, sourceRecords) {
  const directory = path.join(luxRoot, "personas");
  if (!await exists(directory)) return [];
  const files = await listFiles(directory, (file) => file.endsWith(".json"));
  const personas = [];
  for (const absolute of files) {
    const relative = toPosix(path.relative(luxRoot, absolute));
    const source = await sourceRecord(luxRoot, relative, "persona");
    sourceRecords.push(source);
    personas.push(canonicalize({ ...await readJson(absolute), path: relative, sha256: source.sha256 }));
  }
  return personas.sort((left, right) => String(left.name).localeCompare(String(right.name)));
}

async function capture() {
  const args = parseArgs(process.argv.slice(2));
  const baselinePath = path.join(args.luxRoot, "baseline.json");
  const metadata = await readJson(baselinePath);
  if (!/^\d+\.\d+\.\d+$/.test(metadata.version ?? "")) throw new Error("Lux baseline.json has an invalid version");
  const outputPath = path.resolve(args.output || path.join(DEFAULT_OUTPUT_DIR, `lux-desktop-${metadata.version}.json`));
  const sourceRecords = [await sourceRecord(args.luxRoot, "baseline.json", "metadata")];

  const helpManifestRelative = "help/manifest.json";
  const helpManifest = await readJson(path.join(args.luxRoot, "help", "manifest.json"));
  sourceRecords.push(await sourceRecord(args.luxRoot, helpManifestRelative, "help-manifest"));
  if (!Array.isArray(helpManifest.sections) || helpManifest.sections.length === 0) throw new Error("Lux Help manifest contains no sections");

  const helpDocuments = [];
  for (const section of helpManifest.sections) {
    if (!section.file || path.basename(section.file) !== section.file) throw new Error(`Unsafe Help file path: ${section.file}`);
    const relative = `help/${section.file}`;
    const absolute = path.join(args.luxRoot, "help", section.file);
    sourceRecords.push(await sourceRecord(args.luxRoot, relative, "help"));
    helpDocuments.push(parseMarkdown(relative, await readFile(absolute, "utf8")));
  }

  const skills = await loadInstalledSkills(args.luxRoot, sourceRecords);
  const personas = await loadInstalledPersonas(args.luxRoot, sourceRecords);

  const promptDirectory = path.join(args.luxRoot, "prompts", "org-mode");
  const promptFiles = await listFiles(promptDirectory, (file) => file.endsWith(".md"));
  if (promptFiles.length === 0) throw new Error("No Lux org-mode prompt files found");
  for (const absolute of promptFiles) {
    sourceRecords.push(await sourceRecord(args.luxRoot, toPosix(path.relative(args.luxRoot, absolute)), "prompt"));
  }

  const runtimeModules = [
    "lux-core.mjs",
    "lux-server.mjs",
    "lux-bash.mjs",
    "lux-playbook-runner.mjs",
    "lux-worker.mjs",
    "lux-wire.mjs",
    "lux-win-platform.mjs",
  ];
  for (const relative of runtimeModules) sourceRecords.push(await sourceRecord(args.luxRoot, relative, "runtime-module"));

  for (const relative of [
    "chrome-extension/manifest.json",
    "chrome-extension/background.js",
    "chrome-extension/bridge.js",
    "chrome-extension/injector.js",
  ]) {
    sourceRecords.push(await sourceRecord(args.luxRoot, relative, "browser-extension"));
  }

  const probe = await runRuntimeProbe(args.luxRoot, args.keepProbe);
  if (probe.version !== metadata.version) throw new Error(`Runtime probe version ${probe.version} does not match baseline ${metadata.version}`);
  const tools = probe.modelTools.map((definition) => {
    const normalized = canonicalize(definition);
    const { name, description = "", parameters, ...metadataFields } = normalized;
    if (!name || !parameters) throw new Error(`Invalid model-facing tool definition: ${name ?? "<unnamed>"}`);
    const tool = { name, description, parameters, sourceKind: "runtime-model-request" };
    if (Object.keys(metadataFields).length > 0) tool.metadata = metadataFields;
    return canonicalize(tool);
  }).sort((left, right) => left.name.localeCompare(right.name));

  const derived = deriveContracts(helpDocuments, skills, personas);
  const runtimeNames = tools.map((tool) => tool.name);
  const documentedCandidates = derived.toolDocumentation.candidateNames;
  derived.toolDocumentation.runtimeNames = runtimeNames;
  derived.toolDocumentation.documentedOnlyCandidates = documentedCandidates.filter((name) => !runtimeNames.includes(name));
  derived.toolDocumentation.runtimeOnlyNames = runtimeNames.filter((name) => !documentedCandidates.includes(name));
  const toolCatalog = {
    scope: "isolated-default-session-model-request",
    definitionSource: "local-openai-compatible-provider-request",
    baseRegistryDefinitionSource: "runtime-mod-api",
    baseMembershipSource: "server-websocket-tool_definitions_updated",
    personaName: probe.sessionMembership.personaName,
    toolCount: tools.length,
    baseRegistryToolCount: probe.tools.length,
    baseRegistryNames: probe.tools.map((tool) => tool.name).sort(),
    dynamicExtensionsExcluded: [
      "configured MCP and Prism tools",
      "platform and desktop bridge tools",
      "Android device tools",
      "worker-attach transfer tools",
      "host-injected tools",
    ],
  };
  const uniqueSources = [...new Map(sourceRecords.map((source) => [source.path, source])).values()]
    .sort((left, right) => left.path.localeCompare(right.path));
  const manifest = canonicalize({
    $schema: "../schema/lux-desktop-baseline.schema.json",
    schemaVersion: SCHEMA_VERSION,
    target: { product: "Lux Desktop", version: metadata.version },
    runtime: {
      nodeVersion: String(metadata.nodeVersion),
      electronVersion: String(metadata.electronVersion),
      prebuildsHash: String(metadata.prebuildsHash),
      shellHash: String(metadata.shellHash),
      probeVersion: probe.version,
    },
    sources: uniqueSources,
    contracts: { tools, toolCatalog, ...derived },
    capture: {
      capturedAt: new Date().toISOString(),
      hostPlatform: process.platform,
      hostArch: process.arch,
    },
  });

  const errors = validateManifest(manifest);
  if (errors.length > 0) throw new Error(`Captured manifest is invalid:\n- ${errors.join("\n- ")}`);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
  console.log(JSON.stringify({
    ok: true,
    output: outputPath,
    version: metadata.version,
    toolCount: tools.length,
    personaName: probe.sessionMembership.personaName,
    documentedToolCandidateCount: derived.toolDocumentation.candidateNames.length,
    helpSectionCount: helpDocuments.length,
    skillCount: skills.length,
    installedPersonaCount: personas.length,
    sourceCount: uniqueSources.length,
  }, null, 2));
}

capture().catch(async (error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 2;
});
