import { ExecutionDeniedError, type ExecutionLimits } from "./execution-isolation.js";

export type ScriptLanguage = "node" | "node-cjs";

export const SCRIPT_DEFAULT_TIMEOUT_MS = 10_000;
export const SCRIPT_MIN_TIMEOUT_MS = 100;
export const SCRIPT_MAX_TIMEOUT_MS = 10_000;

function exactLanguage(value: unknown): ScriptLanguage {
  const lang = value === undefined ? "node" : value;
  if (lang !== "node" && lang !== "node-cjs") {
    throw new ExecutionDeniedError("EXEC_REQUEST_INVALID", "Script language is unsupported by the isolated runner");
  }
  return lang;
}

export function parseScriptTimeout(value: unknown): number {
  if (value === undefined) return SCRIPT_DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(value) || Number(value) < SCRIPT_MIN_TIMEOUT_MS || Number(value) > SCRIPT_MAX_TIMEOUT_MS) {
    throw new ExecutionDeniedError("EXEC_REQUEST_INVALID", `Script timeout must be ${SCRIPT_MIN_TIMEOUT_MS}-${SCRIPT_MAX_TIMEOUT_MS} ms`);
  }
  return Number(value);
}

function bridgePrelude(): string {
  return `
await (async () => {
  const [{ lstat, open, stat }, { dirname, isAbsolute, relative, resolve, sep }] = await Promise.all([
    import("node:fs/promises"), import("node:path"),
  ]);
  const cwd = resolve(process.cwd());
  const contains = (target) => {
    const child = relative(cwd, target);
    return !isAbsolute(child) && child.split(sep)[0] !== "..";
  };
  const lexicalPath = (input) => {
    if (typeof input !== "string" || input.length < 1 || input.includes("\\0") || isAbsolute(input)) throw new TypeError("lux bridge path must be relative to cwd");
    const target = resolve(cwd, input);
    if (!contains(target)) throw new TypeError("lux bridge path escapes cwd");
    return target;
  };
  const assertNoLinks = async (target) => {
    const child = relative(cwd, target);
    let current = cwd;
    for (const segment of child.split(sep).filter(Boolean)) {
      current = resolve(current, segment);
      const metadata = await lstat(current, { bigint: true });
      if (metadata.isSymbolicLink()) throw new TypeError("lux bridge path escapes cwd through a link");
    }
  };
  const stableHandle = async (target, flags) => {
    await assertNoLinks(target);
    const handle = await open(target, flags);
    try {
      await assertNoLinks(target);
      const [handleMetadata, pathMetadata] = await Promise.all([
        handle.stat({ bigint: true }), stat(target, { bigint: true }),
      ]);
      if (handleMetadata.dev !== pathMetadata.dev || handleMetadata.ino !== pathMetadata.ino || handleMetadata.nlink !== 1n || !handleMetadata.isFile()) {
        throw new TypeError("lux bridge path identity changed or is hardlinked");
      }
      return handle;
    } catch (error) {
      await handle.close();
      throw error;
    }
  };
  const readText = async (input) => {
    const handle = await stableHandle(lexicalPath(input), "r");
    try { return await handle.readFile("utf8"); } finally { await handle.close(); }
  };
  const writeText = async (input, value) => {
    if (typeof value !== "string") throw new TypeError("lux.writeText value must be a string");
    const target = lexicalPath(input);
    let handle;
    try {
      handle = await stableHandle(target, "r+");
    } catch (error) {
      if (!error || error.code !== "ENOENT") throw error;
      if (dirname(target) !== cwd) throw new TypeError("lux bridge new files must be direct cwd children");
      handle = await open(target, "wx");
      try {
        await assertNoLinks(target);
        const [handleMetadata, pathMetadata] = await Promise.all([
          handle.stat({ bigint: true }), stat(target, { bigint: true }),
        ]);
        if (handleMetadata.dev !== pathMetadata.dev || handleMetadata.ino !== pathMetadata.ino || handleMetadata.nlink !== 1n) throw new TypeError("lux bridge path identity changed or is hardlinked");
      } catch (verificationError) {
        await handle.close();
        throw verificationError;
      }
    }
    try { await handle.truncate(0); await handle.writeFile(value, "utf8"); } finally { await handle.close(); }
  };
  const format = (value) => typeof value === "string" ? value : JSON.stringify(value);
  const bridge = Object.freeze({
    cwd,
    readText,
    writeText,
    readJson: async (input) => JSON.parse(await readText(input)),
    writeJson: async (input, value) => await writeText(input, JSON.stringify(value, null, 2) + "\\n"),
    done: (value) => console.log(format(value)),
  });
  Object.defineProperty(globalThis, "lux", { value: bridge, enumerable: true, configurable: false, writable: false });
})();
`;
}

export function createScriptPayload(input: Readonly<{ code: string; lang?: unknown }>): Readonly<{ lang: ScriptLanguage; payload: string }> {
  if (typeof input.code !== "string" || input.code.length < 1 || input.code.length > 128 * 1024 || input.code.includes("\0")) {
    throw new ExecutionDeniedError("EXEC_REQUEST_INVALID", "Script code is invalid");
  }
  const lang = exactLanguage(input.lang);
  const prelude = bridgePrelude();
  if (lang === "node") return Object.freeze({ lang, payload: `${prelude}\n${input.code}\n` });
  const encoded = JSON.stringify(input.code);
  return Object.freeze({
    lang,
    payload: `${prelude}
await (async () => {
  const [{ createRequire }, { resolve }, { pathToFileURL }] = await Promise.all([
    import("node:module"), import("node:path"), import("node:url"),
  ]);
  const cwd = process.cwd();
  const filename = resolve(cwd, "__lux_script__.cjs");
  const require = createRequire(pathToFileURL(filename));
  const module = { exports: {} };
  const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
  const run = new AsyncFunction("require", "module", "exports", "__filename", "__dirname", ${encoded});
  await run(require, module, module.exports, filename, cwd);
})();
`,
  });
}

export function scriptLimits(maximum: ExecutionLimits, timeoutMs: number): ExecutionLimits {
  const timeout = parseScriptTimeout(timeoutMs);
  return Object.freeze({ ...maximum, jobUserTimeMs: Math.min(maximum.jobUserTimeMs, timeout), wallTimeMs: timeout });
}
