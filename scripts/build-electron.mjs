import path from "path";
import { spawn } from "child_process";
import { fileURLToPath } from "url";
import { validateElectronAsar } from "./electron-asar-integrity.mjs";
import { validateElectronStage } from "./electron-stage-integrity.mjs";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const stageDir = path.join(projectRoot, ".electron-app");
const cli = path.join(projectRoot, "node_modules", "electron-builder", "out", "cli", "cli.js");
const args = [cli, "--projectDir", ".", ...process.argv.slice(2)];
const env = {
  ...process.env,
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR || "https://npmmirror.com/mirrors/electron-builder-binaries/",
};

await validateElectronStage(projectRoot, stageDir);
const code = await new Promise((resolve, reject) => {
  const child = spawn(process.execPath, args, {
    cwd: stageDir,
    env,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
  child.once("error", reject);
  child.once("exit", resolve);
});
if (code !== 0) throw new Error(`electron-builder exited with ${code}`);
await validateElectronStage(projectRoot, stageDir);
const packageIdentity = await validateElectronAsar(projectRoot, path.join(projectRoot, "release", "win-unpacked", "resources"));
console.log(`Electron ASAR authored payload verified: ${packageIdentity.asarSha256}`);
