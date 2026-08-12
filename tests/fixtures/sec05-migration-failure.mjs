import fs from "node:fs/promises";
import path from "node:path";

const fixture = process.env.SEC05_FAILURE_FIXTURE;
if (!fixture) throw new Error("SEC05_FAILURE_FIXTURE is required");
const secret = process.env.SEC05_FAILURE_SECRET;
if (!secret) throw new Error("SEC05_FAILURE_SECRET is required");
process.env.RAINYDAYS_USER_DATA_DIR = fixture;
process.env.RAINYDAYS_DATA_DIR = path.join(fixture, "data");
process.env.RAINYDAYS_CONFIG_PATH = path.join(fixture, "config.json");
delete process.env.DEEPSEEK_API_KEY;
delete process.env.LLM_API_KEY;

await fs.writeFile(process.env.RAINYDAYS_CONFIG_PATH, JSON.stringify({
  defaultProfile: "default",
  profiles: { default: { model: "m", apiKey: secret, baseURL: "https://provider.example" } },
  settings: {},
}, null, 2));

const credentials = await import("../../dist/credential-store.js");
credentials.configureCredentialProtector({
  protect: plaintext => Buffer.from(plaintext, "utf8"),
  unprotect: ciphertext => ciphertext.toString("utf8"),
});
const managed = await import("../../dist/managed-path-store.js");
const original = managed.ManagedPathStore.prototype.writeConfig;
managed.ManagedPathStore.prototype.writeConfig = async () => { throw new Error("injected-config-commit-failure"); };
const config = await import("../../dist/config.js");
let failed = false;
try { await config.initializeConfig(); }
catch (error) { failed = /injected-config-commit-failure/u.test(String(error)); }
finally { managed.ManagedPathStore.prototype.writeConfig = original; }
if (!failed) throw new Error("migration did not fail at config commit");
let unpublished = false;
try { config.loadConfig(); } catch { unpublished = true; }
if (!unpublished) throw new Error("failed migration published runtime config");

const disk = await fs.readFile(process.env.RAINYDAYS_CONFIG_PATH, "utf8");
if (!disk.includes(secret)) throw new Error("legacy plaintext was deleted after failed migration");
const vault = JSON.parse(await fs.readFile(path.join(fixture, "credentials.vault.json"), "utf8"));
if (Object.keys(vault.entries).length !== 0) throw new Error("orphan credential was not cleaned up");
console.log(JSON.stringify({ failedClosed: true, legacyPreserved: true, orphanCleaned: true }));
