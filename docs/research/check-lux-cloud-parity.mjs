import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "../..");

const baselinePath = path.join(rootDir, "parity/baselines/lux-cloud-2026.json");
const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));

const LEGACY_ALIASES = {
  compact_context: "curate",
  consolidate_memory: "consolidate",
  worker_file_upload: "worker_upload",
  worker_file_download: "worker_download",
  worker_pairing_claim: "worker_connect",
  agent_spawn: "subagent",
  agent_list: "subagent_list",
  agent_peek: "subagent_peek",
  agent_post: "subagent_post",
  agent_wait: "subagent_wait",
  agent_close: "subagent_stop",
};

function extractBraceBlock(text, startIdx) {
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  for (let i = startIdx; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = true;
      quote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
  }
  return "";
}

function extractTopLevelKeysFromProperties(propsBlock) {
  // propsBlock is `{ key1: { ... }, key2: identifier, ... }`
  const inner = propsBlock.slice(1, -1);
  const keys = [];
  let depth = 0;
  let inString = false;
  let quote = "";
  let escaped = false;
  let token = "";
  let expectingKey = true;

  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === quote) inString = false;
      if (depth === 0 && expectingKey) token += ch;
      continue;
    }
    if (ch === "/" && inner[i + 1] === "/") {
      while (i < inner.length && inner[i] !== "\n") i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      inString = true;
      quote = ch;
      if (depth === 0 && expectingKey) token += ch;
      continue;
    }
    if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      expectingKey = false;
      continue;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      depth--;
      continue;
    }
    if (depth === 0) {
      if (ch === ",") {
        expectingKey = true;
        token = "";
      } else if (ch === ":" && expectingKey) {
        const cleaned = token.trim().replace(/^["']|["']$/g, "");
        if (cleaned) keys.push(cleaned);
        expectingKey = false;
        token = "";
      } else if (expectingKey) {
        token += ch;
      }
    }
  }
  return keys;
}

function collectMiniLuxTools() {
  const toolsDir = path.join(rootDir, "src/tools");
  const files = fs.readdirSync(toolsDir).filter(f => f.endsWith(".ts")).map(f => path.join(toolsDir, f));
  const extraFiles = ["src/task-tools.ts", "src/mcp/runtime.ts"].map(f => path.join(rootDir, f)).filter(f => fs.existsSync(f));
  const allFiles = [...files, ...extraFiles];

  const tools = new Map();
  for (const file of allFiles) {
    const content = fs.readFileSync(file, "utf8");
    const fnRegex = /function:\s*\{/g;
    let m;
    while ((m = fnRegex.exec(content)) !== null) {
      const braceStart = content.indexOf("{", m.index);
      const fnBlock = extractBraceBlock(content, braceStart);
      if (!fnBlock) continue;
      const nameMatch = fnBlock.match(/name:\s*"([a-z0-9_]+)"/);
      if (!nameMatch) continue;
      const name = nameMatch[1];
      let properties = [];
      const propsIdx = fnBlock.indexOf("properties:");
      if (propsIdx !== -1) {
        const propsBraceStart = fnBlock.indexOf("{", propsIdx);
        if (propsBraceStart !== -1) {
          const propsBlock = extractBraceBlock(fnBlock, propsBraceStart);
          properties = extractTopLevelKeysFromProperties(propsBlock);
        }
      }
      if (!tools.has(name)) {
        tools.set(name, {
          name,
          file: path.relative(rootDir, file).replaceAll("\\", "/"),
          properties,
        });
      }
    }
  }
  return tools;
}

const miniLuxTools = collectMiniLuxTools();
const results = [];

for (const cloudTool of baseline.contracts.tools) {
  const cloudProps = Object.keys(cloudTool.parameters?.properties ?? {});
  const direct = miniLuxTools.get(cloudTool.name);
  const aliasName = LEGACY_ALIASES[cloudTool.name];
  const alias = aliasName ? miniLuxTools.get(aliasName) : null;

  if (direct) {
    const missingProps = cloudProps.filter(p => !direct.properties.includes(p));
    results.push({
      name: cloudTool.name,
      subsystem: cloudTool.subsystem,
      status: missingProps.length === 0 ? "aligned" : "partial-schema",
      mappedTo: `${direct.name} (${direct.file})`,
      file: direct.file,
      cloudProps,
      presentProps: direct.properties,
      missingProps,
    });
  } else if (alias) {
    const missingProps = cloudProps.filter(p => !alias.properties.includes(p));
    results.push({
      name: cloudTool.name,
      subsystem: cloudTool.subsystem,
      status: "legacy-alias",
      mappedTo: `${alias.name} (${alias.file})`,
      file: alias.file,
      cloudProps,
      presentProps: alias.properties,
      missingProps,
    });
  } else {
    results.push({
      name: cloudTool.name,
      subsystem: cloudTool.subsystem,
      status: "missing",
      mappedTo: "-",
      file: "-",
      cloudProps,
      presentProps: [],
      missingProps: cloudProps,
    });
  }
}

const counts = {
  miniLuxTotalDiscovered: miniLuxTools.size,
  cloudCoreTotal: results.length,
  aligned: results.filter(r => r.status === "aligned").length,
  partial: results.filter(r => r.status === "partial-schema").length,
  legacy: results.filter(r => r.status === "legacy-alias").length,
  missing: results.filter(r => r.status === "missing").length,
};

const mdLines = [
  "# RainyDays vs Lux-Cloud 自動化契約對齊報告（LC-00）",
  "",
  `> 生成腳本：\`docs/research/check-lux-cloud-parity.mjs\``,
  `> 基準文件：\`parity/baselines/lux-cloud-2026.json\`（共 ${counts.cloudCoreTotal} 個核心原生工具契約；RainyDays 現有已註冊工具 ${counts.miniLuxTotalDiscovered} 個）`,
  "",
  "## 1. 總體統計",
  "",
  `- **完全對齊 (aligned)**：${counts.aligned} / ${counts.cloudCoreTotal}`,
  `- **同名但缺 Lux-Cloud 新增參數 (partial-schema)**：${counts.partial} / ${counts.cloudCoreTotal}`,
  `- **舊版別名/原型實現 (legacy-alias)**：${counts.legacy} / ${counts.cloudCoreTotal}`,
  `- **完全缺失 (missing)**：${counts.missing} / ${counts.cloudCoreTotal}`,
  `- **已覆蓋（含同名與舊版別名）**：${counts.aligned + counts.partial + counts.legacy} / ${counts.cloudCoreTotal} (${Math.round(((counts.aligned + counts.partial + counts.legacy) / counts.cloudCoreTotal) * 100)}%)`,
  "",
  "## 2. 逐工具對齊明細表",
  "",
  "| 子系統 | Lux-Cloud 工具 | 狀態 | RainyDays 現有映射 | RainyDays 現有參數 | 缺失的 Lux-Cloud 關鍵參數 |",
  "| :--- | :--- | :--- | :--- | :--- | :--- |",
  ...results.map(r => `| \`${r.subsystem}\` | \`${r.name}\` | **${r.status}** | ${r.mappedTo === "-" ? "-" : `\`${r.mappedTo}\``} | ${r.presentProps.length ? r.presentProps.map(p => `\`${p}\``).join(", ") : "-"} | ${r.missingProps.length ? r.missingProps.map(p => `\`${p}\``).join(", ") : "無"} |`),
  "",
];

const reportPath = path.join(rootDir, "docs/research/lux-cloud-gap-report.md");
fs.writeFileSync(reportPath, mdLines.join("\n"), "utf8");
console.log(JSON.stringify({ counts, reportPath }, null, 2));
