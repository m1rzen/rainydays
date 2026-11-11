import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const vendorDir = path.join(projectRoot, "public", "vendor");

const assets = [
  ["node_modules/marked/lib/marked.umd.js", "marked.umd.js"],
  ["node_modules/@highlightjs/cdn-assets/highlight.min.js", "highlight.min.js"],
  ["node_modules/@highlightjs/cdn-assets/styles/github-dark.min.css", "github-dark.min.css"],
  ["node_modules/@xterm/xterm/lib/xterm.js", "xterm.js"],
  ["node_modules/@xterm/xterm/css/xterm.css", "xterm.css"],
  ["node_modules/@xterm/addon-fit/lib/addon-fit.js", "xterm-addon-fit.js"],
];

await fs.mkdir(vendorDir, { recursive: true });
for (const [source, name] of assets) {
  await fs.copyFile(path.join(projectRoot, source), path.join(vendorDir, name));
}
// Fonts ship with the app: the page's CSP blocks remote fonts and the UI must not depend on the network.
const fontsDir = path.join(vendorDir, "fonts");
await fs.mkdir(fontsDir, { recursive: true });
for (const file of ["michroma/files/michroma-latin-400-normal.woff2", "ibm-plex-mono/files/ibm-plex-mono-latin-400-normal.woff2", "ibm-plex-mono/files/ibm-plex-mono-latin-600-normal.woff2"]) {
  await fs.copyFile(path.join(projectRoot, "node_modules/@fontsource", file), path.join(fontsDir, path.basename(file)));
}
const notoSource = path.join(projectRoot, "node_modules/@fontsource-variable/noto-sans-sc");
await fs.mkdir(path.join(fontsDir, "noto-sans-sc"), { recursive: true });
await fs.copyFile(path.join(notoSource, "wght.css"), path.join(fontsDir, "noto-sans-sc/wght.css"));
await fs.copyFile(path.join(notoSource, "LICENSE"), path.join(fontsDir, "noto-sans-sc/LICENSE"));
await fs.cp(path.join(notoSource, "files"), path.join(fontsDir, "noto-sans-sc/files"), { recursive: true });
console.log(`Vendor assets copied to ${vendorDir}`);
