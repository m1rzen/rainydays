import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../..", import.meta.url));

const A01_VARIABLES = Object.freeze({
  "A01-01": "DEEPSEEK_API_KEY",
  "A01-02": "MINI_LUX_API_TOKEN",
  "A01-03": "AWS_SECRET_ACCESS_KEY",
  "A01-04": "SSH_AUTH_SOCK",
  "A01-05": "SEC03_PARENT_SENTINEL",
  "A01-06": "HTTP_PROXY",
  "A01-07": "NODE_OPTIONS",
  "A01-08": "PATH",
});

export const A01_PATH_SENTINEL = "SEC03_PARENT_PATH_SENTINEL";
export const A01_OUTPUT_MARKER = "SEC03_A01_ENV_ABSENT";

export function a01ParentMutation(variantId, previousValue = "") {
  const name = A01_VARIABLES[variantId];
  if (!name) throw new Error(`Unsupported SEC-03 A01 variant: ${variantId}`);
  return Object.freeze({
    name,
    value: name === "PATH" ? `${previousValue};${A01_PATH_SENTINEL}` : `sec03-parent-only-${variantId.toLowerCase()}`,
  });
}

export function a01Probe(variantId, profileId) {
  const name = A01_VARIABLES[variantId];
  if (!name || !["E1", "E2", "E3", "E4"].includes(profileId)) throw new Error(`Unsupported SEC-03 A01 record: ${variantId}/${profileId}`);
  const pathProbe = name === "PATH";
  if (profileId === "E3") {
    const condition = pathProbe
      ? `(process.env.PATH ?? "").includes(${JSON.stringify(A01_PATH_SENTINEL)})`
      : `process.env[${JSON.stringify(name)}] !== undefined`;
    return `if (${condition}) process.exit(91); console.log(${JSON.stringify(A01_OUTPUT_MARKER)});`;
  }
  const condition = pathProbe
    ? `not "%PATH:${A01_PATH_SENTINEL}=%"=="%PATH%"`
    : `defined ${name}`;
  if (profileId === "E1") return `if ${condition} (exit /b 91) else (exit /b 0)`;
  return `if ${condition} (exit 91) else (echo ${A01_OUTPUT_MARKER})`;
}

export const A17_OUTPUT_MARKER = "SEC03_A17_SCRIPT_DENIED";
const denied = expression => `try { ${expression}; throw new Error("SEC03_CAPABILITY_SUCCEEDED"); } catch (error) { if (error?.message === "SEC03_CAPABILITY_SUCCEEDED") throw error; console.log(${JSON.stringify(A17_OUTPUT_MARKER)}); }`;

export function a17Probe(variantId) {
  const probes = {
    "A17-01": `import { createRequire } from "node:module"; ${denied(`createRequire(import.meta.url)(process.env.MINI_LUX_ROOT_0 + "\\\\sandbox-launcher.node")`)}`,
    "A17-02": `import { Worker } from "node:worker_threads"; ${denied(`new Worker("", { eval: true })`)}`,
    "A17-03": `import { spawn } from "node:child_process"; ${denied(`spawn(process.execPath, ["--version"], { stdio: "ignore" })`)}`,
    "A17-04": `import inspector from "node:inspector"; ${denied(`inspector.open(0, "127.0.0.1", false)`)}`,
    "A17-05": `import { WASI } from "node:wasi"; ${denied(`new WASI({ version: "preview1" })`)}`,
    "A17-06": `import { readFile } from "node:fs/promises"; ${denied(`await readFile(process.env.MINI_LUX_ROOT_0 + "\\\\..\\\\outside.txt", "utf8")`)}`,
    "A17-07": `import { connect } from "node:net"; await new Promise((resolve, reject) => { const socket = connect(47831, "127.0.0.1"); socket.once("connect", () => reject(new Error("SEC03_CAPABILITY_SUCCEEDED"))); socket.once("error", () => { console.log(${JSON.stringify(A17_OUTPUT_MARKER)}); resolve(); }); });`,
  };
  const probe = probes[variantId];
  if (!probe) throw new Error(`Unsupported SEC-03 A17 variant: ${variantId}`);
  return probe;
}

export const A02_OUTPUT_MARKER = "SEC03_A02_FS_DENIED";
export const A02_ANOTHER_DRIVE_PATH = path.join(projectRoot, ".sec03-native-test", "mini-lux-sec03-a02-another-drive-canary.txt");
export const A04_OUTPUT_MARKER = "SEC03_A04_NETWORK_DENIED";
export const A04_LISTEN_READY_MARKER = "SEC03_A04_LISTEN_READY";
export const A04_PORTS = Object.freeze({ dns: 47841, externalTcp: 47842, udp: 47843, loopback: 47844, listen: 47845 });

function shellPowerShellProbe(source, marker) {
  const encoded = Buffer.from(source, "utf16le").toString("base64");
  const executable = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  return `"${executable}" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded} && echo ${marker}`;
}

function profileProbe(esmSource, shellSource, marker, profileId) {
  if (!["E1", "E2", "E3", "E4"].includes(profileId)) throw new Error(`Unsupported SEC-03 probe profile: ${profileId}`);
  const probe = profileId === "E3" ? esmSource : shellPowerShellProbe(shellSource, marker);
  const persistent = profileId === "E2" || profileId === "E4";
  return Object.freeze({ payload: persistent ? "cmd" : probe, input: persistent ? probe : null });
}

function a02Source(variantId) {
  const targets = {
    "A02-01": 'root + "\\\\..\\\\outside-canary.txt"',
    "A02-02": 'path.resolve(root, "..", "sec03-a02-sibling", "canary.txt")',
    "A02-03": JSON.stringify(A02_ANOTHER_DRIVE_PATH),
    "A02-04": 'slash + slash + "localhost" + slash + path.parse(outside).root[0] + "$" + slash + outside.slice(path.parse(outside).root.length)',
    "A02-05": 'slash + slash + "?" + slash + outside',
    "A02-06": 'slash + slash + "." + slash + outside',
    "A02-07": 'path.join(root, "ads-base.txt") + ":sec03"',
    "A02-09": 'path.join(root, "outside-symlink.txt")',
    "A02-10": 'path.join(root, "outside-junction", "canary.txt")',
    "A02-11": 'path.join(root, "outside-hardlink.txt")',
  };
  if (variantId === "A02-08") return `import fs from "node:fs/promises"; import path from "node:path"; const root = process.env.MINI_LUX_ROOT_0; const moved = root + "-a02-moved"; const outsideDirectory = path.dirname(root); let renamed = false; let linked = false; let denied = false; try { await fs.rename(root, moved); renamed = true; await fs.symlink(outsideDirectory, root, "junction"); linked = true; } catch { denied = true; } finally { if (linked) await fs.rm(root, { force: true }); if (renamed) await fs.rename(moved, root); } if (!denied) process.exitCode = 91; else console.log(${JSON.stringify(A02_OUTPUT_MARKER)});`;
  const target = targets[variantId];
  if (!target) throw new Error(`Unsupported SEC-03 A02 variant: ${variantId}`);
  return `import fs from "node:fs/promises"; import path from "node:path"; const root = process.env.MINI_LUX_ROOT_0; const outside = path.join(path.dirname(root), "outside-canary.txt"); const slash = String.fromCharCode(92); const target = ${target}; try { await fs.readFile(target); process.exitCode = 91; } catch { console.log(${JSON.stringify(A02_OUTPUT_MARKER)}); }`;
}

function powerShellQuote(value) { return `'${value.replaceAll("'", "''")}'`; }
function a02PowerShell(variantId) {
  const prefix = "$root=$env:MINI_LUX_ROOT_0;$outside=Join-Path (Split-Path $root -Parent) 'outside-canary.txt';$s=[char]92;";
  const targets = {
    "A02-01": "$root+$s+'..'+$s+'outside-canary.txt'",
    "A02-02": "[IO.Path]::GetFullPath((Join-Path $root '..\\sec03-a02-sibling\\canary.txt'))",
    "A02-03": powerShellQuote(A02_ANOTHER_DRIVE_PATH),
    "A02-04": "$s+$s+'localhost'+$s+[IO.Path]::GetPathRoot($outside).Substring(0,1)+[char]36+$s+$outside.Substring([IO.Path]::GetPathRoot($outside).Length)",
    "A02-05": "$s+$s+'?'+$s+$outside",
    "A02-06": "$s+$s+'.'+$s+$outside",
    "A02-07": "(Join-Path $root 'ads-base.txt')+':sec03'",
    "A02-09": "Join-Path $root 'outside-symlink.txt'",
    "A02-10": "Join-Path $root 'outside-junction\\canary.txt'",
    "A02-11": "Join-Path $root 'outside-hardlink.txt'",
  };
  if (variantId === "A02-08") return `${prefix}$moved=$root+'-a02-moved';$renamed=$false;$linked=$false;$denied=$false;try{Move-Item -LiteralPath $root -Destination $moved -ErrorAction Stop;$renamed=$true;New-Item -ItemType Junction -Path $root -Target (Split-Path $root -Parent) -ErrorAction Stop|Out-Null;$linked=$true}catch{$denied=$true}finally{if($linked){Remove-Item -LiteralPath $root -Force};if($renamed){Move-Item -LiteralPath $moved -Destination $root -ErrorAction Stop}};if($denied){Write-Output '${A02_OUTPUT_MARKER}';exit 0}else{exit 91}`;
  const target = targets[variantId];
  if (!target) throw new Error(`Unsupported SEC-03 A02 variant: ${variantId}`);
  return `${prefix}$target=${target};try{[IO.File]::ReadAllBytes($target)|Out-Null;exit 91}catch{Write-Output '${A02_OUTPUT_MARKER}';exit 0}`;
}

export function a02Case(variantId, profileId) {
  return Object.freeze({ ...profileProbe(a02Source(variantId), a02PowerShell(variantId), A02_OUTPUT_MARKER, profileId), marker: A02_OUTPUT_MARKER });
}

function a04ExternalAddress(explicit) {
  const address = explicit ?? Object.values(os.networkInterfaces()).flat().find(value => value?.family === "IPv4" && !value.internal)?.address;
  if (typeof address !== "string" || !/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/u.test(address)) throw new Error("SEC-03 A04 requires a host-validated external IPv4 address");
  return address;
}

function a04Source(variantId, externalAddress) {
  const external = JSON.stringify(a04ExternalAddress(externalAddress));
  if (variantId === "A04-05") return `import net from "node:net"; const external = ${external}; await new Promise(resolve => { let accepted = false; let finished = false; const server = net.createServer(socket => { accepted = true; socket.destroy(); }); const finish = () => { if (finished) return; finished = true; const done = () => { if (accepted) process.exitCode = 91; else console.log(${JSON.stringify(A04_OUTPUT_MARKER)}); resolve(); }; if (server.listening) server.close(done); else done(); }; server.once("error", finish); server.listen(${A04_PORTS.listen}, external, () => { console.log(${JSON.stringify(A04_LISTEN_READY_MARKER)}); setTimeout(finish, 1500); }); });`;
  const operations = {
    "A04-01": `const resolver = new dns.promises.Resolver(); resolver.setServers(["127.0.0.1:${A04_PORTS.dns}"]); const reached = await Promise.race([resolver.resolve4("sec03-authentic.invalid").then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 500))]); if (!reached) { resolver.cancel(); throw new Error("SEC03_DNS_TIMEOUT"); }`,
    "A04-02": `await new Promise((resolve, reject) => { const socket = net.createConnection({ host: external, port: ${A04_PORTS.externalTcp} }); const timer = setTimeout(() => { socket.destroy(); reject(new Error("SEC03_TCP_TIMEOUT")); }, 500); socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(); }); socket.once("error", error => { clearTimeout(timer); reject(error); }); })`,
    "A04-03": `await new Promise((resolve, reject) => { const socket = dgram.createSocket("udp4"); const timer = setTimeout(() => { socket.close(); reject(new Error("SEC03_UDP_TIMEOUT")); }, 500); socket.once("message", () => { clearTimeout(timer); socket.close(); resolve(); }); socket.once("error", error => { clearTimeout(timer); socket.close(); reject(error); }); socket.send(Buffer.from("SEC03_A04_UDP"), ${A04_PORTS.udp}, external, error => { if (error) { clearTimeout(timer); socket.close(); reject(error); } }); })`,
    "A04-04": `await new Promise((resolve, reject) => { const socket = net.createConnection({ host: "127.0.0.1", port: ${A04_PORTS.loopback} }); const timer = setTimeout(() => { socket.destroy(); reject(new Error("SEC03_LOOPBACK_TIMEOUT")); }, 500); socket.once("connect", () => { clearTimeout(timer); socket.destroy(); resolve(); }); socket.once("error", error => { clearTimeout(timer); reject(error); }); })`,
    "A04-05": `await new Promise((resolve, reject) => { const server = net.createServer(); const timer = setTimeout(() => server.close(() => reject(new Error("SEC03_LISTEN_TIMEOUT"))), 500); server.once("error", error => { clearTimeout(timer); reject(error); }); server.listen(${A04_PORTS.listen}, external, () => { clearTimeout(timer); server.close(resolve); }); })`,
  };
  const operation = operations[variantId];
  if (!operation) throw new Error(`Unsupported SEC-03 A04 variant: ${variantId}`);
  return `import dns from "node:dns"; import net from "node:net"; import dgram from "node:dgram"; const external = ${external}; try { ${operation}; process.exitCode = 91; } catch { console.log(${JSON.stringify(A04_OUTPUT_MARKER)}); }`;
}

function a04PowerShell(variantId, externalAddress) {
  const external = `$external=[Net.IPAddress]::Parse('${a04ExternalAddress(externalAddress)}');`;
  const operations = {
    "A04-01": `$client=[Net.Sockets.UdpClient]::new();$client.Client.ReceiveTimeout=500;$query=[byte[]](0x53,0x03,0x01,0x00,0x00,0x01,0x00,0x00,0x00,0x00,0x00,0x00,0x05,0x73,0x65,0x63,0x30,0x33,0x09,0x61,0x75,0x74,0x68,0x65,0x6e,0x74,0x69,0x63,0x07,0x69,0x6e,0x76,0x61,0x6c,0x69,0x64,0x00,0x00,0x01,0x00,0x01);$sent=$client.Send($query,$query.Length,'127.0.0.1',${A04_PORTS.dns});if($sent -ne $query.Length){throw 'dns-send'};$remote=[Net.IPEndPoint]::new([Net.IPAddress]::Any,0);$response=$client.Receive([ref]$remote);$client.Close()`,
    "A04-02": `$client=[Net.Sockets.TcpClient]::new();$client.Connect($external,${A04_PORTS.externalTcp});$client.Close()`,
    "A04-03": `$client=[Net.Sockets.UdpClient]::new();$client.Client.ReceiveTimeout=500;$bytes=[Text.Encoding]::ASCII.GetBytes('SEC03_A04_UDP');$sent=$client.Send($bytes,$bytes.Length,$external.ToString(),${A04_PORTS.udp});if($sent -ne $bytes.Length){throw 'udp-send'};$remote=[Net.IPEndPoint]::new([Net.IPAddress]::Any,0);$response=$client.Receive([ref]$remote);$client.Close()`,
    "A04-04": `$client=[Net.Sockets.TcpClient]::new();$client.Connect([Net.IPAddress]::Loopback,${A04_PORTS.loopback});$client.Close()`,
    "A04-05": `$listener=[Net.Sockets.TcpListener]::new($external,${A04_PORTS.listen});$listener.Start();$listener.Stop()`,
  };
  const operation = operations[variantId];
  if (!operation) throw new Error(`Unsupported SEC-03 A04 variant: ${variantId}`);
  return `${external}try{${operation};exit 91}catch{Write-Output '${A04_OUTPUT_MARKER}';exit 0}`;
}

export function a04Case(variantId, profileId, externalAddress) {
  return Object.freeze({ ...profileProbe(a04Source(variantId, externalAddress), a04PowerShell(variantId, externalAddress), A04_OUTPUT_MARKER, profileId), marker: A04_OUTPUT_MARKER });
}

const A08_BASE_LIMITS = Object.freeze({
  E1: Object.freeze({ activeProcesses: 16, processMemoryBytes: 512 * 2 ** 20, jobMemoryBytes: 2 ** 30, cpuRatePercent: 50, jobUserTimeMs: 30_000, wallTimeMs: 30_000, idleTimeMs: null, aggregateOutputBytes: 2 ** 20, retainedOutputBytes: 2 ** 20, inputBytes: 128 * 2 ** 10 }),
  E2: Object.freeze({ activeProcesses: 32, processMemoryBytes: 512 * 2 ** 20, jobMemoryBytes: 2 ** 30, cpuRatePercent: 25, jobUserTimeMs: 600_000, wallTimeMs: 1_800_000, idleTimeMs: 300_000, aggregateOutputBytes: 10 * 2 ** 20, retainedOutputBytes: 2 ** 20, inputBytes: 64 * 2 ** 10 }),
  E3: Object.freeze({ activeProcesses: 1, processMemoryBytes: 256 * 2 ** 20, jobMemoryBytes: 256 * 2 ** 20, cpuRatePercent: 20, jobUserTimeMs: 10_000, wallTimeMs: 10_000, idleTimeMs: null, aggregateOutputBytes: 2 ** 20, retainedOutputBytes: 2 ** 20, inputBytes: 128 * 2 ** 10 }),
  E4: Object.freeze({ activeProcesses: 64, processMemoryBytes: 2 ** 30, jobMemoryBytes: 2 * 2 ** 30, cpuRatePercent: 50, jobUserTimeMs: 3_600_000, wallTimeMs: 28_800_000, idleTimeMs: 1_800_000, aggregateOutputBytes: 64 * 2 ** 20, retainedOutputBytes: 2 ** 20, inputBytes: 64 * 2 ** 10 }),
});

export const A08_SUPPORT_FILES = Object.freeze({
  "cpu.cmd": "@echo off\r\nset x=0\r\n:loop\r\nset /a x+=1 >nul\r\ngoto loop\r\n",
  "process-memory.ps1": "$x = New-Object byte[] (256MB)\r\nfor ($i=0; $i -lt $x.Length; $i += 4096) { $x[$i] = 1 }\r\nStart-Sleep -Seconds 30\r\n",
  "job-child.ps1": "$x = New-Object byte[] (32MB)\r\nfor ($i=0; $i -lt $x.Length; $i += 4096) { $x[$i] = 1 }\r\nStart-Sleep -Seconds 30\r\n",
  "job-parent.ps1": "$exe = $env:SystemRoot + '\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'\r\n$child = $env:MINI_LUX_ROOT_0 + '\\job-child.ps1'\r\n$arguments = '-NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File \"' + $child + '\"'\r\n$children = @()\r\n1..4 | ForEach-Object {\r\n    $psi = New-Object System.Diagnostics.ProcessStartInfo\r\n    $psi.FileName = $exe\r\n    $psi.Arguments = $arguments\r\n    $psi.UseShellExecute = $false\r\n    $psi.CreateNoWindow = $true\r\n    $children += [System.Diagnostics.Process]::Start($psi)\r\n}\r\n$children | ForEach-Object { $_.WaitForExit() }\r\n",
});

function a08PowerShell(source, marker) {
  return shellPowerShellProbe(source, marker);
}

function a08JobMemoryCommand() {
  const childSource = "$x=New-Object byte[] (96MB);for($i=0;$i -lt $x.Length;$i+=4096){$x[$i]=1};Start-Sleep -Seconds 30";
  const child = Buffer.from(childSource, "utf16le").toString("base64");
  const launch = `start "" /b "%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -EncodedCommand ${child}`;
  return `${Array.from({ length: 4 }, () => launch).join(" & ")} & for /L %i in (1,1,2147483647) do @rem`;
}

function a08Plan(profileId, command, script, limits, nativeReason, expectedCode) {
  const persistent = profileId === "E2" || profileId === "E4";
  const payload = profileId === "E3" ? script : persistent ? "cmd" : command;
  return Object.freeze({ payload, input: persistent ? command : null, limits: Object.freeze(limits), nativeReason, expectedCode });
}

export function a06Case(variantId, profileId) {
  if (!["E1", "E2", "E4"].includes(profileId)) throw new Error(`SEC-03 A06 is not honestly reachable for profile: ${profileId}`);
  const foreground = `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 2"`;
  const background = `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 30"`;
  const cases = {
    "A06-01": [foreground, 1],
    "A06-02": [`"%ComSpec%" /d /s /c "${foreground}"`, 2],
    "A06-03": [`start "" /wait /b ${foreground}`, 1],
    "A06-04": [`start "" /b ${background}`, 1],
  };
  const planned = cases[variantId];
  if (!planned) throw new Error(`Unsupported SEC-03 A06 variant: ${variantId}`);
  return Object.freeze({
    payload: profileId === "E1" ? planned[0] : "cmd",
    input: profileId === "E1" ? null : `${planned[0]} & exit`,
    minimumDescendants: planned[1],
    expectedCode: "OBS_JOB_EMPTY",
  });
}

export function a07Case(variantId, profileId) {
  if (!["A07-04", "A07-05", "A07-06"].includes(variantId) || !["E1", "E2", "E3", "E4"].includes(profileId)) throw new Error(`Unsupported SEC-03 A07 record: ${variantId}/${profileId}`);
  const persistent = profileId === "E2" || profileId === "E4";
  return Object.freeze({
    payload: profileId === "E3" ? "process.exit(0);" : persistent ? "cmd" : "exit /b 0",
    input: persistent ? "exit" : null,
    expectedCode: "OBS_HANDLE_DENIED",
  });
}

export function a08Case(variantId, profileId) {
  const base = A08_BASE_LIMITS[profileId];
  if (!base) throw new Error(`Unsupported SEC-03 A08 profile: ${profileId}`);
  const persistent = profileId === "E2" || profileId === "E4";
  if (variantId === "A08-01") {
    const limits = { ...base, activeProcesses: profileId === "E4" ? 16 : base.activeProcesses, processMemoryBytes: profileId === "E4" ? 512 * 2 ** 20 : base.processMemoryBytes, jobMemoryBytes: profileId === "E4" ? 2 ** 30 : base.jobMemoryBytes, cpuRatePercent: profileId === "E4" ? 25 : base.cpuRatePercent, jobUserTimeMs: 100, wallTimeMs: profileId === "E3" ? 10_000 : 20_000, idleTimeMs: persistent ? 15_000 : null, aggregateOutputBytes: 2 ** 20, retainedOutputBytes: 2 ** 20 };
    return a08Plan(profileId, "for /L %i in (1,1,2147483647) do @set /a sec03_cpu+=1 >nul", `for (;;) { Math.sqrt(123456789); }`, limits, "limit-cpu", "EXEC_LIMIT_CPU");
  }
  if (variantId === "A08-02" && profileId !== "E3") {
    const limits = { ...base, activeProcesses: 1, processMemoryBytes: 512 * 2 ** 20, jobMemoryBytes: 2 ** 30, cpuRatePercent: profileId === "E4" ? 25 : base.cpuRatePercent, jobUserTimeMs: 10_000, wallTimeMs: 5_000, idleTimeMs: persistent ? 4_000 : null, aggregateOutputBytes: 2 ** 20, retainedOutputBytes: 2 ** 20 };
    const command = `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "exit 0"`;
    return a08Plan(profileId, command, "", limits, "limit-active-process", "EXEC_LIMIT_ACTIVE_PROCESS");
  }
  if (variantId === "A08-03") {
    const limits = { ...base, activeProcesses: profileId === "E4" ? 16 : base.activeProcesses, processMemoryBytes: 96 * 2 ** 20, jobMemoryBytes: profileId === "E3" ? 256 * 2 ** 20 : 512 * 2 ** 20, cpuRatePercent: profileId === "E4" ? 25 : base.cpuRatePercent, jobUserTimeMs: 10_000, wallTimeMs: 8_000, idleTimeMs: persistent ? 7_000 : null, aggregateOutputBytes: 2 ** 20, retainedOutputBytes: 2 ** 20 };
    return a08Plan(profileId, a08PowerShell(A08_SUPPORT_FILES["process-memory.ps1"], "SEC03_A08_MEMORY_UNEXPECTED"), `const blocks=[]; for (;;) { const b=Buffer.allocUnsafe(8*1024*1024); b.fill(1); blocks.push(b); }`, limits, "limit-process-memory", "EXEC_LIMIT_PROCESS_MEMORY");
  }
  if (variantId === "A08-04" && profileId !== "E3") {
    const limits = { ...base, activeProcesses: 8, processMemoryBytes: 192 * 2 ** 20, jobMemoryBytes: 256 * 2 ** 20, cpuRatePercent: profileId === "E4" ? 25 : base.cpuRatePercent, jobUserTimeMs: 10_000, wallTimeMs: 8_000, idleTimeMs: persistent ? 7_000 : null, aggregateOutputBytes: 2 ** 20, retainedOutputBytes: 2 ** 20 };
    return a08Plan(profileId, a08JobMemoryCommand(), "", limits, "limit-job-memory", "EXEC_LIMIT_JOB_MEMORY");
  }
  if (variantId === "A08-05") {
    const payload = profileId === "E3" ? `console.log("x".repeat(8192));` : `for /L %i in (1,1,5000) do @echo 0123456789abcdef0123456789abcdef`;
    return Object.freeze({ payload, input: persistent ? payload : null, limits: Object.freeze({ ...base, aggregateOutputBytes: 1024, retainedOutputBytes: 1024 }), nativeReason: "limit-output", expectedCode: "EXEC_LIMIT_OUTPUT" });
  }
  if (variantId === "A08-06") {
    const payload = profileId === "E3" ? `await new Promise(resolve => setTimeout(resolve, 60_000));` : profileId === "E1" ? `for /L %i in (1,1,2000000000) do @rem` : "cmd";
    return Object.freeze({ payload, input: null, limits: Object.freeze({ ...base, wallTimeMs: 250, idleTimeMs: persistent ? 5_000 : null }), nativeReason: "limit-wall", expectedCode: "EXEC_LIMIT_WALL" });
  }
  if (variantId === "A08-07" && persistent) return Object.freeze({ payload: "cmd", input: null, limits: Object.freeze({ ...base, wallTimeMs: 5_000, idleTimeMs: 250 }), nativeReason: "limit-idle", expectedCode: "EXEC_LIMIT_IDLE" });
  throw new Error(`SEC-03 A08 record is not honestly reachable under the frozen profile: ${variantId}/${profileId}`);
}

export function a08JobPolicyMaterial(limits) {
  return [limits.activeProcesses, limits.processMemoryBytes, limits.jobMemoryBytes, limits.cpuRatePercent, limits.jobUserTimeMs, limits.wallTimeMs, limits.idleTimeMs ?? "null", limits.aggregateOutputBytes, limits.retainedOutputBytes, limits.inputBytes].join(":");
}

export function a03Case(variantId, profileId) {
  if (!["A03-01", "A03-02", "A03-03"].includes(variantId) || !["E1", "E2", "E3", "E4"].includes(profileId)) throw new Error(`Unsupported SEC-03 A03 record: ${variantId}/${profileId}`);
  const persistent = profileId === "E2" || profileId === "E4";
  return Object.freeze({ payload: profileId === "E3" ? "process.exit(0);" : persistent ? "cmd" : "exit /b 0", input: persistent ? "exit" : null });
}

export function a11Case(variantId, profileId) {
  if (!["E1", "E2", "E3"].includes(profileId)) throw new Error(`Unsupported SEC-03 A11 profile: ${profileId}`);
  const variants = {
    "A11-01": ["missing", "EXEC_GRANT_REQUIRED"],
    "A11-02": ["forged", "EXEC_GRANT_FORGED"],
    "A11-03": ["argument-mismatch", "EXEC_GRANT_ARGUMENT_MISMATCH"],
    "A11-04": ["expired", "EXEC_GRANT_EXPIRED"],
    "A11-05": ["replayed", "EXEC_GRANT_REPLAYED"],
    "A11-06": ["cross-run", "EXEC_GRANT_CROSS_RUN"],
    "A11-07": ["cross-session", "EXEC_GRANT_CROSS_SESSION"],
    "A11-08": ["concurrent-reuse", "EXEC_GRANT_CONCURRENT_REUSE"],
  };
  const variant = variants[variantId];
  if (!variant) throw new Error(`Unsupported SEC-03 A11 variant: ${variantId}`);
  const approvedPayload = profileId === "E1" ? "exit /b 0" : profileId === "E3" ? "process.exit(0);" : "echo SEC03_A11_EXACT";
  const attemptedPayload = variantId === "A11-03"
    ? profileId === "E3" ? "process.exit(91);" : profileId === "E1" ? "exit /b 91" : "echo SEC03_A11_ALTERED"
    : approvedPayload;
  return Object.freeze({
    operation: profileId === "E2" ? "input" : "launch",
    decisionState: variant[0],
    expectedCode: variant[1],
    approvedPayload,
    attemptedPayload,
  });
}

export function a12Case(variantId, profileId) {
  if (profileId !== "E4") throw new Error(`Unsupported SEC-03 A12 profile: ${profileId}`);
  const variants = {
    "A12-01": ["consent-denied", "EXEC_CONSENT_DENIED"],
    "A12-02": ["consent-dismissed", "EXEC_CONSENT_DISMISSED"],
    "A12-03": ["consent-expired", "EXEC_CONSENT_EXPIRED"],
    "A12-04": ["consent-argument-mismatch", "EXEC_CONSENT_ARGUMENT_MISMATCH"],
    "A12-05": ["consent-replayed", "EXEC_CONSENT_REPLAYED"],
    "A12-06": ["consent-synthetic", "EXEC_CONSENT_SYNTHETIC"],
    "A12-07": ["consent-cross-window", "EXEC_CONSENT_CROSS_WINDOW"],
    "A12-08": ["consent-cross-session", "EXEC_CONSENT_CROSS_SESSION"],
    "A12-09": ["consent-concurrent-reuse", "EXEC_CONSENT_CONCURRENT_REUSE"],
  };
  const variant = variants[variantId];
  if (!variant) throw new Error(`Unsupported SEC-03 A12 variant: ${variantId}`);
  return Object.freeze({
    operation: "consent",
    decisionState: variant[0],
    expectedCode: variant[1],
    request: Object.freeze({ appendNewline: true, id: "sec03-a12-terminal", input: "echo SEC03_A12_EXACT" }),
  });
}

export function a19Case(variantId, profileId) {
  if (variantId !== "A19-01" || profileId !== "E4") throw new Error(`Unsupported SEC-03 A19 record: ${variantId}/${profileId}`);
  return Object.freeze({
    operation: "launch",
    decisionState: "network-profile-unsupported",
    expectedCode: "EXEC_NETWORK_PROFILE_UNSUPPORTED",
    payload: "cmd",
  });
}

export function a09Case(variantId, profileId) {
  if (!["E1", "E2", "E3", "E4"].includes(profileId)) throw new Error(`Unsupported SEC-03 A09 profile: ${profileId}`);
  const persistent = profileId === "E2" || profileId === "E4";
  if (variantId === "A09-01") {
    const payload = profileId === "E3" ? "process.exit(0);" : persistent ? "cmd" : "exit /b 0";
    return Object.freeze({ payload, input: persistent ? "exit" : null, nativeReason: "completed", completionReason: "completed", expectedCode: "EXEC_COMPLETED_JOB_EMPTY" });
  }
  const terminationCases = {
    "A09-02": ["requested", "cancelled", "EXEC_CANCELLED"],
    "A09-03": ["owner-retired", "owner-retired", "EXEC_OWNER_RETIRED"],
    "A09-04": ["session-retired", "session-retired", "EXEC_SESSION_RETIRED"],
    "A09-05": ["service-shutdown", "service-shutdown", "EXEC_SERVICE_SHUTDOWN"],
  };
  const termination = terminationCases[variantId];
  if (termination) {
    const payload = profileId === "E3" ? "await new Promise(resolve => setTimeout(resolve, 60_000));" : persistent ? "cmd" : `"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -Command "Start-Sleep -Seconds 60"`;
    return Object.freeze({ payload, input: null, terminateReason: termination[0], nativeReason: termination[1], completionReason: termination[2], expectedCode: termination[2] });
  }
  throw new Error(`Unsupported SEC-03 A09 record: ${variantId}/${profileId}`);
}
