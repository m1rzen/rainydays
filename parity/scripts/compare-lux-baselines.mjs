import process from "node:process";
import { compareManifests, readJson, validateManifest } from "./baseline-lib.mjs";

async function main() {
  const [expectedPath, actualPath] = process.argv.slice(2);
  if (!expectedPath || !actualPath) {
    console.error("Usage: node compare-lux-baselines.mjs <expected.json> <actual.json>");
    process.exitCode = 2;
    return;
  }

  const expected = await readJson(expectedPath);
  const actual = await readJson(actualPath);
  const expectedErrors = validateManifest(expected);
  const actualErrors = validateManifest(actual);
  if (expectedErrors.length > 0 || actualErrors.length > 0) {
    console.error(JSON.stringify({
      equal: false,
      validationErrors: { expected: expectedErrors, actual: actualErrors },
    }, null, 2));
    process.exitCode = 2;
    return;
  }

  const result = compareManifests(expected, actual);
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.equal ? 0 : 1;
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exitCode = 2;
});
