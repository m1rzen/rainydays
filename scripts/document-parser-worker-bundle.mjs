import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { isBuiltin } from "node:module";
import path from "node:path";
import { build } from "esbuild";

export const documentParserWorkerBundlePath = "dist/document-parser-worker.js";

export async function buildDocumentParserWorkerBundle(projectRoot) {
  const result = await build({
    absWorkingDir: projectRoot,
    entryPoints: ["src/document-parser-worker.ts"],
    outfile: documentParserWorkerBundlePath,
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node24",
    legalComments: "inline",
    metafile: true,
    write: false,
    banner: {
      js: [
        'import { getBuiltinModule } from "node:process";',
        "function require(id) {",
        "  const module = getBuiltinModule(id);",
        '  if (module === undefined) throw new Error("Parser worker cannot load a module from disk: " + id);',
        "  return module;",
        "}",
      ].join("\n"),
    },
  });
  const outputs = Object.values(result.metafile.outputs);
  assert.equal(outputs.length, 1, "Document parser worker must bundle to a single file");
  assert.equal(result.outputFiles.length, 1, "Document parser worker emitted additional files");
  for (const dependency of outputs[0].imports) {
    assert(dependency.external && isBuiltin(dependency.path), `Document parser worker has an external file dependency: ${dependency.path}`);
  }
  return Buffer.from(result.outputFiles[0].contents);
}

export async function writeDocumentParserWorkerBundle(projectRoot, distDirectory) {
  const bytes = await buildDocumentParserWorkerBundle(projectRoot);
  await writeFile(path.join(distDirectory, path.basename(documentParserWorkerBundlePath)), bytes);
}
