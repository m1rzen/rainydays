import assert from "node:assert/strict";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { validateReportPath } from "../tests/helpers.mjs";
import { runGov04 } from "./gov04/orchestrator.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function parseArgs(argv) {
  const result = { profile: "merge", retryOf: null, report: null, evidenceDir: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--profile") result.profile = argv[++index] ?? "";
    else if (argument === "--retry-of") result.retryOf = argv[++index] ?? "";
    else if (argument === "--report") result.report = path.resolve(argv[++index] ?? "");
    else if (argument === "--evidence-dir") result.evidenceDir = path.resolve(argv[++index] ?? "");
    else throw new Error(`Unknown argument: ${argument}`);
  }
  assert(["merge", "trusted-release"].includes(result.profile), "--profile must be merge or trusted-release");
  if (result.retryOf !== null) assert(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result.retryOf), "--retry-of must be a UUID v4");
  return result;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const exportReportPath = args.report === null ? null : await validateReportPath(args.report);
  const exportEvidenceDirectory = args.evidenceDir === null ? null : path.dirname(await validateReportPath(path.join(args.evidenceDir, "gov04-report.json")));
  const result = await runGov04({ projectRoot, profile: args.profile, retryOf: args.retryOf, exportReportPath, exportEvidenceDirectory });
  console.log(`[GOV-04] ${args.profile}: ${result.report.state} (${result.report.durationMs} ms)`);
  console.log(`[GOV-04] runId=${result.report.runId}`);
  console.log(`[GOV-04] report=${result.reportPath}`);
  if (result.report.state !== "passed") process.exitCode = 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 1;
});
