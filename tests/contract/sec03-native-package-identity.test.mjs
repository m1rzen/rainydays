import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  collectSourceFiles,
  sec03ArchitectureSha256,
  sec03NativeBinaryRelatives,
  sec03NativeManifestRelative,
  toPosix,
  validateSec03NativeProjection,
} from "../../scripts/build-inputs.mjs";
import { makeTempDir, projectRoot, removeFixture } from "../helpers.mjs";

async function fixture() {
  const root = await makeTempDir("mini-lux-sec03-native-identity-");
  await mkdir(path.join(root, "native"), { recursive: true });
  await mkdir(path.join(root, "scripts"), { recursive: true });
  await mkdir(path.join(root, "dist"), { recursive: true });
  await cp(path.join(projectRoot, "native", "sandbox-host"), path.join(root, "native", "sandbox-host"), { recursive: true });
  await cp(path.join(projectRoot, "scripts", "build-sec03-native.mjs"), path.join(root, "scripts", "build-sec03-native.mjs"));
  await cp(path.join(projectRoot, "dist", "native"), path.join(root, "dist", "native"), { recursive: true });
  return root;
}

async function rewriteMachine(root, relative, machine) {
  const binaryPath = path.join(root, ...relative.split("/"));
  const bytes = await readFile(binaryPath);
  const offset = bytes.readUInt32LE(0x3c);
  bytes.writeUInt16LE(machine, offset + 4);
  await writeFile(binaryPath, bytes);
  const manifestPath = path.join(root, ...sec03NativeManifestRelative.split("/"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const record = manifest.outputs.find((entry) => entry.path === relative);
  record.bytes = bytes.length;
  record.sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

test("SEC-03 source digest authored set includes native sources, build logic, runtime, governance and matrix inputs", async () => {
  const inputs = new Set((await collectSourceFiles(projectRoot)).map((absolute) => toPosix(path.relative(projectRoot, absolute))));
  for (const relative of [
    "native/sandbox-host/protocol.h",
    "native/sandbox-host/journal.h",
    "native/sandbox-host/sandbox-host.cpp",
    "native/sandbox-host/sandbox-launcher.cpp",
    "scripts/build-sec03-native.mjs",
    "src/execution-isolation.ts",
    "src/execution-native.ts",
    "src/execution-runtime.ts",
    "scripts/sec03-execution-inventory.mjs",
    "scripts/sec03-receipt-set.mjs",
    "tests/sec03-attack-matrix.json",
    "tests/sec03-attack-matrix.schema.json",
    "parity/SEC-03-EXECUTION-ISOLATION-ARCHITECTURE.md",
    "parity/reports/sec-03-architect-freeze.json",
  ]) assert(inputs.has(relative), `sourceDigest omits ${relative}`);
  assert.equal(sec03ArchitectureSha256, "849fc25a5e32eabdaa3b1285a14218f9877d46ecdc650a0e52a2120772e1cad1");
});

test("SEC-03 native projection binds the exact manifest, outputs, toolchain, freshness and AMD64 machine", async () => {
  const root = await fixture();
  try {
    const identity = await validateSec03NativeProjection(root);
    assert.deepEqual(identity.binaries.map((entry) => entry.path), sec03NativeBinaryRelatives);
    assert.equal(identity.manifest.path, sec03NativeManifestRelative);
    assert.equal(identity.architectureSha256, sec03ArchitectureSha256);

    await writeFile(path.join(root, "dist", "native", "future-helper.exe"), "extra");
    await assert.rejects(() => validateSec03NativeProjection(root), /output set mismatch/u);
    await rm(path.join(root, "dist", "native", "future-helper.exe"));

    const host = path.join(root, ...sec03NativeBinaryRelatives[0].split("/"));
    const missing = `${host}.missing`;
    await rename(host, missing);
    await assert.rejects(() => validateSec03NativeProjection(root), /output set mismatch/u);
    await rename(missing, host);

    const originalHost = await readFile(host);
    await writeFile(host, Buffer.concat([originalHost, Buffer.from([0])]));
    await assert.rejects(() => validateSec03NativeProjection(root), /byte identity differs/u);
    await writeFile(host, originalHost);

    await rewriteMachine(root, sec03NativeBinaryRelatives[0], 0x014c);
    await assert.rejects(() => validateSec03NativeProjection(root), /not AMD64 PE/u);
  } finally {
    await removeFixture(root);
  }
});

test("SEC-03 native projection rejects stale native source and manifest toolchain identity", async () => {
  const root = await fixture();
  try {
    const protocol = path.join(root, "native", "sandbox-host", "protocol.h");
    await writeFile(protocol, `${await readFile(protocol, "utf8")}\n`);
    await assert.rejects(() => validateSec03NativeProjection(root), /source .* byte identity differs/u);
  } finally {
    await removeFixture(root);
  }

  const second = await fixture();
  try {
    const manifestPath = path.join(second, ...sec03NativeManifestRelative.split("/"));
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.toolchainDigest = "0".repeat(64);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(() => validateSec03NativeProjection(second), /toolchain digest differs/u);
  } finally {
    await removeFixture(second);
  }
});

test("electron-builder includes only exact SEC-03 native paths and unpacks only the two binaries", async () => {
  const packageJson = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));
  assert(packageJson.build.files.includes("dist/native/sec03-native-manifest.json"));
  assert(packageJson.build.files.includes("electron-stage-integrity.json"));
  assert.deepEqual(
    packageJson.build.files.filter((entry) => entry.startsWith("dist/native/")),
    ["dist/native/sandbox-host.exe", "dist/native/sandbox-launcher.node", "dist/native/sec03-native-manifest.json"],
  );
  assert.deepEqual(
    packageJson.build.asarUnpack.filter((entry) => entry.startsWith("dist/native/")),
    ["dist/native/sandbox-host.exe", "dist/native/sandbox-launcher.node"],
  );
  assert(!packageJson.build.files.some((entry) => entry === "dist/**/*" || entry.startsWith("dist/native/*")));
  assert(!packageJson.build.asarUnpack.some((entry) => entry.startsWith("dist/native/*")));
});
