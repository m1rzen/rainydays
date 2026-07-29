import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.join(projectRoot, "public", "vendor");

const assets = [
  ["node_modules/marked/lib/marked.umd.js", "marked.umd.js"],
  ["node_modules/@highlightjs/cdn-assets/highlight.min.js", "highlight.min.js"],
  ["node_modules/@highlightjs/cdn-assets/styles/github-dark.min.css", "github-dark.min.css"],
];

await fs.mkdir(vendorDir, { recursive: true });
for (const [source, name] of assets) {
  await fs.copyFile(path.join(projectRoot, source), path.join(vendorDir, name));
}
console.log(`Vendor assets copied to ${vendorDir}`);
