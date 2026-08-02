import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { runProcess, spawnManaged, waitFor } from "../helpers.mjs";

export function classifyInstallerResult(result, timedOut = false) {
  if (timedOut) return "timed-out";
  if (result?.signal) return "signal-crash";
  if (result?.code === 0) return "passed";
  if (Number.isInteger(result?.code) && (result.code >>> 0) >= 0xC0000000) return "windows-crash";
  return "non-zero";
}

export function requireObservedProcessResult(result, allowedCodes, label) {
  assert(result && typeof result === "object", `${label} produced no result`);
  assert.equal(result.signal, null, `${label} crashed`);
  assert(allowedCodes.includes(result.code), `${label} failed with ${result.code}`);
  return result;
}

export function windowsRegistrySnapshotCommand(root, outputPath) {
  assert.equal(typeof root, "string");
  assert.equal(typeof outputPath, "string");
  const prefix = "HKCU:\\";
  assert(root.startsWith(prefix) && root.length <= 512 && !root.includes("\0"));
  assert(path.isAbsolute(outputPath) && outputPath.length <= 32_767 && !outputPath.includes("\0"));
  const encodedSubkey = Buffer.from(root.slice(prefix.length), "utf16le").toString("base64");
  const encodedOutput = Buffer.from(outputPath, "utf16le").toString("base64");
  return `$subkey=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedSubkey}'));$output=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedOutput}'));$base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Default);try{$opened=$base.OpenSubKey($subkey,$false);if($null-eq$opened){$observation=[ordered]@{rootPresent=$false;items=@()}}else{try{$items=@($opened.GetSubKeyNames()|ForEach-Object{$name=$_;$child=$opened.OpenSubKey($name,$false);if($null-eq$child){throw 'Registry snapshot changed during observation'};try{[pscustomobject][ordered]@{PSChildName=$name;DisplayName=$child.GetValue('DisplayName',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);DisplayVersion=$child.GetValue('DisplayVersion',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);InstallLocation=$child.GetValue('InstallLocation',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);UninstallString=$child.GetValue('UninstallString',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames);QuietUninstallString=$child.GetValue('QuietUninstallString',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)}}finally{$child.Dispose()}}|Where-Object{$_.DisplayName-like'*RainyDays*'}|Sort-Object PSChildName);$observation=[ordered]@{rootPresent=$true;items=$items}}finally{$opened.Dispose()}};$json=($observation|ConvertTo-Json -Compress -Depth 3);[IO.File]::WriteAllText($output,$json,[Text.UTF8Encoding]::new($false))}finally{$base.Dispose()}`;
}

export async function observeWindowsRegistrySnapshot(root, outputPath, env = process.env) {
  await rm(outputPath, { force: true });
  const command = windowsRegistrySnapshotCommand(root, outputPath);
  const result = await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", command], {
    env,
    timeoutMs: 30_000,
    stdio: "ignore",
  });
  requireObservedProcessResult(result, [0], "registry observation");
  return (await readFile(outputPath, "utf8")).trim();
}

export async function observeWindowsPowerShellOutput(command, outputPath, env = process.env) {
  assert.equal(typeof command, "string");
  assert(command.length > 0 && command.length <= 32_767 && !command.includes("\0"));
  assert.equal(typeof outputPath, "string");
  assert(path.isAbsolute(outputPath) && outputPath.length <= 32_767 && !outputPath.includes("\0"));
  await rm(outputPath, { force: true });
  const encodedOutput = Buffer.from(outputPath, "utf16le").toString("base64");
  const wrapped = `$ErrorActionPreference='Stop';$output=[Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodedOutput}'));$value=@(&{${command}});$text=($value|Out-String).Trim();[IO.File]::WriteAllText($output,$text,[Text.UTF8Encoding]::new($false))`;
  const result = await runProcess("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", wrapped], {
    env,
    timeoutMs: 30_000,
    stdio: "ignore",
  });
  requireObservedProcessResult(result, [0], "PowerShell observation");
  return (await readFile(outputPath, "utf8")).trim();
}

export function launchTracked(command, args, { env, timeoutMs, label, readyProbe }) {
  const child = spawnManaged(command, args, { env });
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => { stdout += chunk; });
  child.stderr?.on("data", (chunk) => { stderr += chunk; });
  const instance = { child, logs: () => ({ stdout, stderr }), ready: null };
  instance.ready = waitFor(async () => {
    if (child.exitCode !== null) throw new Error(`${label} exited ${child.exitCode}: ${stdout}\n${stderr}`);
    return await readyProbe();
  }, { timeoutMs, label });
  return instance;
}
