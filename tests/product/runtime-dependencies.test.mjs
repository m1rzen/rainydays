import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { builtinModules } from "node:module";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The installer ships only "dependencies"; a runtime import of a devDependency works from source but breaks the installed app.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const builtins = new Set(builtinModules);
const provided = new Set(["electron", "original-fs"]);

async function sourceFiles(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await sourceFiles(full));
    else if (/\.(?:ts|mts|cts|mjs|cjs|js)$/u.test(entry.name) && !entry.name.endsWith(".d.ts")) files.push(full);
  }
  return files;
}

function packageName(specifier) {
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

test("every package the shipped runtime imports is a production dependency", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  const dependencies = new Set(Object.keys(manifest.dependencies ?? {}));
  const missing = new Map();
  const files = [...await sourceFiles(path.join(root, "src")), ...await sourceFiles(path.join(root, "electron"))];
  for (const file of files) {
    const text = (await readFile(file, "utf8")).replace(/^\s*import\s+type\b[^;]*;/gmu, "").replace(/^\s*export\s+type\b[^;]*;/gmu, "");
    const specifiers = [
      ...text.matchAll(/\bfrom\s*["']([^"'\s]+)["']/gu),
      ...text.matchAll(/\bimport\s*\(\s*["']([^"'\s]+)["']\s*\)/gu),
      ...text.matchAll(/\brequire\s*\(\s*["']([^"'\s]+)["']\s*\)/gu),
      ...text.matchAll(/^\s*import\s*["']([^"'\s]+)["']/gmu),
    ].map(match => match[1]);
    for (const specifier of specifiers) {
      if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) continue;
      const name = packageName(specifier);
      if (builtins.has(name) || provided.has(name) || dependencies.has(name)) continue;
      missing.set(name, [...(missing.get(name) ?? []), path.relative(root, file)]);
    }
  }
  assert.deepEqual(Object.fromEntries(missing), {}, "Move these packages from devDependencies to dependencies (pinned), or stop importing them at runtime.");
});
