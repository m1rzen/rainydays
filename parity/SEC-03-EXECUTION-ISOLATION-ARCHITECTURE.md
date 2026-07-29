# SEC-03 Shell / Script / Terminal Execution Isolation Architecture

> Status: **FROZEN — REVISION 2; independent Sentinel PASS on candidate SHA-256 `1128f805796d55635e4429f9cbad730d5c37886400caba30e59a712ef5df0c80`**  
> Canonical task: `LUX-DESKTOP-100-PARITY-EXECUTION-SPEC.md` § SEC-03  
> Baseline: Lux Desktop `0.1.898`  
> Platform closed by this revision: Windows 10 22H2 / Windows 11 x64 packaged desktop, local NTFS execution roots only  
> Revision: 2

## 1. Security claim

SEC-03 closes exactly four executable entry points:

1. one-shot Agent `execute_command`;
2. persistent Agent `shell_start` + `shell_input`;
3. restricted Node ESM `script`;
4. user-operated persistent Terminal.

For these entry points, untrusted command or script bytes SHALL never execute directly under the Mini-Lux server's normal user token. Every child starts through the governed Windows sandbox host and is constrained before its first user-code instruction. This is a completion claim, not a description of the Revision 1 source state.

Revision 2 deliberately closes a finite platform profile: regular AppContainer on supported Windows x64 and local fixed NTFS roots. An authorized UNC/device/network root, non-NTFS root, WSL path, removable volume, unknown reparse surface, unsupported shell/runtime or unavailable native primitive fails before ACL mutation or process creation. Network-root execution, LPAC and non-Windows runners are compatibility work, not hidden fallbacks and not SEC-03 completion evidence.

The claim covers:

- a minimal explicit environment;
- mutable user-data access limited to selected roots/private state, while explicitly acknowledging the OS/runtime files already readable to AppContainers;
- network denied by default and brokered when explicitly allowed;
- CPU, memory, active-process, output and wall-time limits;
- process-tree ownership and deterministic whole-tree termination;
- one-use approval for Agent execution and one-use short-lived native consent for manual Terminal start/input;
- source, toolchain, staged/unpacked app and installer identity of the launcher and sandbox host.

The claim does not cover kernel compromise, administrator/SYSTEM attackers, Windows sandbox escape vulnerabilities, or executables explicitly granted access that exploit a Windows kernel vulnerability.

## 2. Rejected non-solutions

The following must never be used as SEC-03 completion evidence:

- parsing or blocking selected shell command strings;
- sanitizing command text and then using normal `spawn`;
- `cwd` validation alone;
- clearing a few environment variables while inheriting the user token;
- Node.js Permission Model as the security boundary;
- timeout followed only by killing the direct PID;
- `taskkill` without pre-execution job ownership;
- a proxy environment variable while direct sockets remain possible;
- renderer-provided `userGesture: true` or a long-lived HTTP bearer token;
- mocks that assert Windows isolation without a real AppContainer token and Job Object.

Node 24.14.1 explicitly states its Permission Model is a seat belt for trusted code and can be bypassed by malicious code. It may be added to the Script profile only as defense in depth.

## 3. Fixed component model

```text
Agent approval                         Electron-main native consent
      |                                           |
CapabilityBroker + PathPolicy       private main↔server consent channel
      |                                           |
      +------------- opaque one-use ExecutionGrant+
                              |
                              v
             ExecutionIsolationService (trusted TypeScript)
                              |
                 private anonymous pipes; bounded frames
                              v
       mini-lux-sandbox-host.exe (one host per execution/session)
                              |
             +-- unique regular AppContainer SID/token
             +-- non-inheritable Job Object, assigned before resume
             +-- explicit inherited-handle list only
             +-- ConPTY only for persistent profiles
             +-- accounting + service-liveness watchdog
                              v
              fixed cmd / PowerShell / Node profile + descendants
```

ConPTY transports terminal bytes; it is not a security boundary. Job Object owns lineage/resources; it is not a filesystem/network boundary. AppContainer token plus DACLs owns filesystem/network isolation; it does not replace Broker intent. The claim depends on all components and the order below.

There is no direct `spawn`/`exec`/`fork`/`node-pty` path for the four governed entry points after migration.

### 3.1 Frozen entry and sink inventory

The four governed command/script-bearing entry surfaces and their current Revision 1 sinks are:

| ID | Public surface | Current trusted call path | Sink that migration must remove |
|---|---|---|---|
| `E1` | Agent `execute_command` | dispatcher → `src/tools/shell.ts::runShellCommand` | `execFile` |
| `E2` | Agent `shell_start` / `shell_input` | dispatcher → `terminalFacade` → `TerminalManager` | `spawn` and stdin write |
| `E3` | Agent `script` | dispatcher → `src/tools/script.ts::runNodeModule` | `spawn` |
| `E4` | manual Terminal start/input | HTTP/UI → `runDirectOperation` → `terminalFacade` | the same `TerminalManager.spawn` and stdin write |

Revision 2 splits `E2` and `E4` into separate trusted adapters over one `ExecutionIsolationService`; they may not share an authorization shortcut. Every launch and mutating input reaches only `launch(grant)` or `write(sessionLease, inputGrant)`. Session list/output/subscription are read-only. Kill/close are attenuation-only lifecycle calls.

The following production process/worker sinks are explicitly outside this four-surface claim and SHALL remain in an exact reviewed allowlist: Electron server bootstrap/termination (`electron/main.cjs`); daemon server bootstrap plus `src/process-tree.ts` fixed `taskkill /PID <owned-daemon-pid> /T /F` termination; fixed `git ls-files -z --` in `read_repo`; File Viewer reveal launcher; and the fixed document parser worker. Build/test scripts are a separate non-runtime class. The exported `terminateProcessTree` helper is allowlisted only while its sole production importer/caller is `src/daemon.ts` and its PID comes from that module's own leased server child; any E1–E4, generic-tool or new caller fails governance. These sinks accept no arbitrary command/script bytes under an E1–E4 call graph. Adding a sink, changing an executable/argv class, or making an allowlisted sink reachable from E1–E4 requires an architecture amendment.

A repository scanner and independent call-graph crosscheck SHALL classify every authored `child_process`, worker, native process, PTY and dynamic-loader sink as exactly one of: governed E1–E4 seam, reviewed fixed-purpose production allowlist, or build/test-only. Unknown, callable-exported, aliased, re-exported or indirect sinks fail closed. `src/process-tree.ts` taskkill is not valid termination evidence for E1–E4 and must become unreachable from them while retaining only the exact daemon contract above.

## 4. Native sandbox host

### 4.1 Build and identity

The repository owns one native source tree:

```text
native/sandbox-host/
  sandbox-launcher.cpp   # Node-API bootstrap/lease launcher
  sandbox-host.cpp       # per-execution/session native host
  protocol.h
```

A deterministic build script invokes the pinned x64 MSVC toolchain and Windows SDK in CI/build environments. It emits one Node-API launcher addon and one host executable. Both are staged outside ASAR at fixed resource paths and included in the installer. The launcher is loaded and identity-checked during trusted server bootstrap before any E1–E4 request is accepted; it exposes only the fixed host-launch ABI, not arbitrary process creation.

Required identity binding:

- source files, protocol definitions and native build script are build-info inputs;
- compiler executable SHA-256, compiler version, Windows SDK version, target architecture and canonical effective compile/link arguments are recorded;
- launcher addon and host PE SHA-256, byte length, machine type and imported-DLL allowlist digests are recorded in the package artifact manifest;
- each artifact is staged outside ASAR at one fixed resource-relative path and must appear exactly once in stage, unpacked app and installer inventory;
- the already-loaded launcher opens the exact host with `CreateFileW` sharing read only (no share-write/delete), verifies PE x64 and manifest hash through that handle, retains the exclusive lease across `CreateProcessW`, and releases it only after host image/path identity and authenticated handshake succeed; verify-by-path then reopen is forbidden;
- unpackaged development may use only a host built in the current build invocation whose native source/toolchain digest equals current build-info;
- no PATH lookup, registry discovery, download-on-first-run or caller-selected helper path is permitted;
- local unsigned candidates report `signatureStatus=unsigned-local` and are never called trusted releases; a release claiming signature trust must additionally pass the existing GOV-04 signature policy without changing the SEC-03 byte identity.

The observed workstation compiler is not a frozen trust input. The implementation must select one explicit CI/local toolchain record and make absence or drift a build failure.

### 4.2 Process creation order

The host must fail closed unless all steps succeed in this order:

1. receive exactly one bounded, versioned launch frame from the inherited control handle and authenticate its random one-use secret; argv and environment contain no secret, command or script bytes;
2. verify policy/grant/profile digests, expiry, host PID/service-liveness handle and exact executable lease identity;
3. create a fresh random AppContainer profile; collision or pre-existence is failure;
4. open every local NTFS root by handle, reject reparse/device/remote/removable/unsupported volume state, bind volume serial + file ID, create and flush the ACL journal, then apply the unique SID ACE transaction;
5. create an unnamed non-inheritable Job Object; set and read back all extended, CPU and notification limits; associate its completion port before any process exists; do not set either breakaway flag;
6. create anonymous control/I/O handles or ConPTY. Clear inheritance on every host handle, then mark only the finite child handle list inheritable;
7. build a fresh environment block and `STARTUPINFOEXW` containing only `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`, `PROC_THREAD_ATTRIBUTE_HANDLE_LIST`, and, for persistent profiles, `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE`;
8. call `CreateProcessW` with exact `lpApplicationName`, writable quoted command line, `EXTENDED_STARTUPINFO_PRESENT | CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT`, `bInheritHandles=TRUE`, and no shell/path lookup;
9. immediately clear inheritance on transferred host copies, assign the suspended process to the Job, prove membership and read back effective token/job limits, then re-query every still-held root handle and pathname mapping and require the original volume serial/file ID immediately before resume; nested-job incompatibility or root drift is failure, not fallback;
10. start host/service-liveness, wall-time, output and job-completion monitors; ensure the Job handle is held only by the host and cannot be inherited/duplicated by the child;
11. only then call `ResumeThread` once and emit `started`.

Any failure before step 11 terminates the suspended process if created, closes the Job Object, reconciles the ACL journal, deletes the unused profile, emits one bounded failure frame and executes zero untrusted instructions. The service never receives the Job handle; loss/crash of the host closes the last Job handle and activates kill-on-close.

### 4.3 AppContainer policy

Revision 2 uses only an unpackaged **regular AppContainer**. LPAC is out of scope and cannot be advertised, selected or used as a fallback. Each sandbox session gets a new random profile name and unique AppContainer SID; a SID is never reused across executions, sessions, retries or recovery.

Properties:

- `SECURITY_CAPABILITIES.CapabilityCount = 0`: no network, broad filesystem, registry, device, COM or credential capability SID is present;
- the low-integrity AppContainer token is queried after process creation and before resume; wrong package SID, unexpected capability SID, non-AppContainer token or wrong integrity fails;
- selected filesystem roots are accessible only through ACEs for this execution's unique AppContainer SID; the normal user SID must independently pass Windows access checks, so the transaction cannot grant the user rights they did not already have;
- descendants inherit the AppContainer and non-breakaway Job boundary; tests query every observed descendant rather than inferring from the root;
- private TEMP/TMP/USERPROFILE/HOME/APPDATA/LOCALAPPDATA directories are created under execution-private state and ACLed only for the user, SYSTEM and this unique SID;
- no ACL is added to Windows, Program Files or another runtime support tree. A fixed executable that cannot start using the OS's existing AppContainer-readable surface is unsupported and fails closed.

Windows and installed software may already grant read/execute to `ALL APPLICATION PACKAGES`, `ALL RESTRICTED APPLICATION PACKAGES` or the unique SID. SEC-03 does not revoke those OS/vendor grants and therefore does not claim an empty root-external read surface. It claims that Mini-Lux adds access only to the selected data roots/private state and that ordinary current-user-readable canaries without an AppContainer ACE remain inaccessible. Tests inventory unexpected access to protected user-data sentinels; broadly pre-authorized public/system files are a documented OS surface, not a root escape.

The security claim is the measured regular-AppContainer profile above, not the word “sandbox” and not an assumption that AppContainer alone blocks every resource.

### 4.4 Root ACL transaction

Granting an AppContainer access to an arbitrary selected workspace changes a Windows security descriptor and therefore is a governed transaction.

For each execution and root:

1. PathPolicy creates an internal execution-root lease containing root ID, access mask, authority epoch and stable local-NTFS identity; it exposes neither a caller path nor mutable descriptor.
2. The host reopens the root with `FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT`, `FILE_SHARE_READ | FILE_SHARE_WRITE` but **without `FILE_SHARE_DELETE`** (never `MAXIMUM_ALLOWED`), and verifies fixed local drive, NTFS, no root reparse tag, volume serial and file ID. It retains this root handle through final ACL cleanup so new rename/delete/replacement opens are denied.
3. Before mutation it writes a create-new journal generation containing candidate/build ID, grant/profile/session IDs, unique SID, root identity, requested mask, original descriptor digest, exact ACE bytes and state `prepared`; it calls `FlushFileBuffers` and publishes the generation with `MoveFileExW(MOVEFILE_WRITE_THROUGH)`. Later states use new monotonically numbered generations; recovery trusts no partial/temp file.
4. It reads DACL generation D0 by handle, builds D1 by preserving every D0 ACE byte/order and inserting one canonical explicit allow ACE for the unique SID, then pauses at the deterministic test barrier and re-reads D0'. If D0' differs from D0 it aborts before write. Otherwise it applies D1 by handle with `SetSecurityInfo`, reads D2, and proves exactly one matching ACE plus the D0 unrelated sequence. Cleanup uses the same read → deterministic barrier → re-read → remove-exact-ACE → verify sequence against the then-current DACL.
5. It marks `applied` and flushes before resume. Failure to propagate because of sharing/protected descendants is an availability failure for that requested positive fixture; it never broadens the ACE or disables protection.
6. Cleanup occurs only after Job active-process zero and I/O drain. Using the still-held root handle, it verifies identity, removes only the exact unique-SID ACE from the current observed DACL with the D0/D0' conflict check above, verifies absence, marks `removed`, deletes the profile, then deletes the journal.
7. If root identity changed or exact safe removal cannot be proven, the journal remains durable, the profile is deleted/disabled, execution is blocked, and startup recovery must resolve it before any new execution. Because every SID is unique and the Job is dead first, an orphan ACE cannot authorize a later execution.

Startup recovery runs before the service accepts E1–E4. It validates strict journal schema, generation continuity, recorded digests and candidate identity, ignores only unpublished temp files, ensures no live owned host/job, deletes the recorded profile first, then removes only the exact SID ACE from the same root identity. Corrupt, ambiguous, conflicting or unverifiable records are hard recovery failures; no full-descriptor rollback may overwrite unrelated ACL changes.

Windows exposes no DACL compare-and-swap primitive. Revision 2 therefore guarantees preservation of the DACL observed at the final D0' check and deterministic detection at the frozen barriers; it does not claim to preserve a change made by an independent principal holding `WRITE_DAC` in the final unobservable interval before `SetSecurityInfo`. Such an ACL writer is outside the untrusted AppContainer threat model. The sandbox SID never receives `WRITE_DAC`/`WRITE_OWNER`, so E1–E4 code cannot create that race. Tests must report this non-claim rather than simulate a CAS guarantee.

Read grants map to traverse/list/read/execute as required; write grants add create/write/delete-child/rename rights. They never add `WRITE_DAC`, `WRITE_OWNER`, SACL, ownership or broad full-control. No tool, renderer or script can supply a SID, profile name, DACL, access mask or raw root path.

## 5. ExecutionGrant

`ExecutionGrant` is an opaque, one-use internal object held in a WeakMap by `ExecutionIsolationService`. Public fields are redacted identifiers only.

It binds:

- `contextId`, `sessionId`, `runId`, principal and authority epoch;
- entry-point kind and exact command/script/input digest;
- selected PathPolicy root IDs and canonical root object identities;
- per-root access mask;
- network mode and broker allowlist digest;
- executable profile;
- environment profile;
- CPU, memory, active-process, output and wall-time limits;
- expiry and one-use state;
- ResourceOwner/job lifetime.

`ExecutionGrant` has no public constructor and is authentic only by object identity in an `ExecutionIsolationService` private `WeakMap`. Its creation is a second-stage transaction after SEC-01 authorization:

1. the Broker consumes the exact tool approval (E1–E3) or main-process consent challenge (E4) atomically;
2. it snapshots the already-validated argument bytes/digest, authentic CapabilityContext, ResourceOwner, network policy and root IDs;
3. PathPolicy issues handle/identity-bound execution-root leases internally;
4. the service intersects the request with one frozen profile and stores the resulting grant privately;
5. `launch`/`write` atomically changes `fresh → consumed` before any host/pipe/ACL side effect.

Failure after consume never restores or reuses a grant. Retry requires new approval/consent and a new random AppContainer SID. `describeAuthority()` remains redacted and no caller can convert a root ID to a pathname, serialize a lease, select a SID/profile/limit, or retain authority across an epoch change.

Persistent input has a distinct opaque `InputGrant` bound to session-lease identity, exact bytes + newline mode, operation, context/session/run/principal, authority epoch and expiry. It cannot launch, target another sandbox or widen the launch grant. Session leases and grants become stale synchronously before ResourceOwner retirement begins.

Attenuation is intersection-only. Child Agent/Playbook execution cannot add roots, write access, network operations, environment names, executable profiles or larger resource limits. E2/E4 launch authorization must display and freeze every root/mask, support-root and network operation usable over the persistent lifetime; later input approval/consent authorizes bytes, not authority expansion. An omitted launch-time authority is unavailable until the session is closed and a new launch is approved.

## 6. Four fixed profiles

### 6.1 Restricted Script

- executable: the exact packaged/pinned Node executable only;
- mode: Node ESM source supplied as bytes through a private sandbox file or pipe;
- Node flags: `--permission` defense in depth, no addons, no workers, no child process, no inspector, no WASI;
- process limit: 1;
- network: denied; approved HTTP operations use a finite host bridge, never direct sockets;
- environment: fixed runtime keys plus capability root aliases, no provider/API secrets;
- wall/output/CPU/memory limits: mandatory and bounded by policy;
- stdin: closed unless the finite bridge protocol requires it.

### 6.2 Agent one-shot shell

- executable: fixed `cmd.exe` profile; PowerShell requires a separately tested fixed executable profile;
- exact command bytes are approval-bound but are not parsed as a security control;
- AppContainer and Job Object provide enforcement;
- background descendants remain in the same non-breakaway Job;
- completion means the Job has no active process, not merely that the direct shell exited;
- network is denied or available only through an explicit broker command supplied by Mini-Lux.

### 6.3 Persistent Agent shell

- sandbox/job is created by an approved `shell_start`;
- every mutating `shell_input` consumes a separate approval bound to shell ID and input digest;
- output/list may remain read-only operations;
- context/authority retirement closes the job;
- a shell cannot outlive its ResourceOwner, change profile, widen roots or acquire network later.

### 6.4 User manual Terminal

- uses the same AppContainer and Job Object boundary;
- ConPTY exists only inside the native host and is attached before resume;
- start and input require one-use native-consent grants; signal/kill/close are owner-bound attenuation operations;
- list, output and subscribe are read-only and session-scoped; clear changes only the trusted output buffer;
- each consent binds operation, terminal ID where applicable, exact argument digest, BrowserWindow/webContents identity, session, authority epoch and expiry;
- E4 is deny-only network in Revision 2; it receives neither direct capability nor broker client/bridge;
- renderer/browser HTTP cannot start or write; denial has zero process/ACL/stdin side effects.

## 7. Trusted manual-Terminal consent

Renderer `isTrusted`, transient user activation, focus, a normal API bearer token and a renderer-held nonce do not prove consent to exact command bytes. Revision 2 therefore uses a main-process-owned native confirmation flow; no approval secret or grant is returned to renderer JavaScript.

1. A narrow preload method accepts only `terminalStart(request)` or `terminalInput(request)` from the top frame. It canonicalizes transport shape but asserts no authority.
2. Electron main verifies the sending `webContents`, top frame, current visible/focused BrowserWindow and current session binding, then sends a bounded `prepare-consent` record over the main-owned consent channel. Packaged same-process mode uses an object-identity callback registered during bootstrap; child-server modes use one inherited anonymous pipe. Browser/HTTP clients can access neither transport.
3. The server validates schema, Broker envelope and PathPolicy input, stores the exact immutable request, and returns a random one-use challenge ID plus bounded display fields and argument digest. It performs zero process/ACL/stdin side effects.
4. Main displays an OS-owned modal `dialog.showMessageBox` parented to that BrowserWindow. The dialog names operation, shell/terminal, CWD alias and exact bounded command/input preview + SHA-256. Default/cancel/close is deny. A renderer cannot synthesize the native button decision.
5. Main returns the decision and challenge ID on that private channel. The server rechecks active window/session/authority epoch, maximum 15-second age and exact pending digest, consumes the challenge atomically, mints an internal `ExecutionGrant`/`InputGrant`, and invokes the stored request exactly once.
6. The result returns over the same main-owned chain. Neither challenge secret, grant, local API token, callback authority nor pipe handle enters DOM, URL, query, local/session storage, renderer logs or command environment.

A compromised renderer can request or spam confirmation dialogs, but cannot silently approve, change approved bytes, replay approval or use approval in another window/session/operation. Deny, dismissal, expiry, navigation, renderer replacement, window blur/close, session switch, authority retirement, malformed response and concurrent reuse produce zero process/ACL/stdin side effects.

Only start and mutating input require native consent. Kill and close are session/owner-bound attenuation operations and remain available as emergency stop without a gesture; they cannot start code, write stdin or widen ACL. List/output/subscribe/clear are read-only or buffer-local. Direct HTTP start/input are permanently denied; a direct HTTP kill/close may only attenuate the caller's current session resource. Browser-only/manual Terminal mutation is unavailable until an equivalent native consent channel exists.

## 8. Environment policy

The sandbox child receives a sorted, newly constructed Unicode environment block. It never spreads or filters `process.env`; parent enumeration is used only by negative tests.

The maximum permitted key universe is:

`SystemRoot`, `WINDIR`, `ComSpec`, `PATHEXT`, `OS`, `PROCESSOR_ARCHITECTURE`, `NUMBER_OF_PROCESSORS`, `TEMP`, `TMP`, `USERPROFILE`, `HOME`, `APPDATA`, `LOCALAPPDATA`, `PATH`, `NODE_DISABLE_COLORS`, `ELECTRON_RUN_AS_NODE`, `MINI_LUX_SANDBOX_ID`, `MINI_LUX_SESSION_ID`, and contiguous `MINI_LUX_ROOT_0..N` aliases. E1/E2/E4 use the common keys except the two Node-only keys; E3 omits `ComSpec` and adds `NODE_DISABLE_COLORS`, plus `ELECTRON_RUN_AS_NODE` only when its frozen executable profile requires it. No other per-profile keys exist.

Rules:

- Windows values come from trusted bootstrap APIs or fixed literals, not caller environment. `ComSpec` is the exact leased initial shell; Script omits it.
- profile/private-directory keys point only inside the execution-private AppContainer state;
- root aliases are generated from active execution-root leases, reveal only granted roots, and are absent after grant attenuation;
- `PATH` is a semicolon-joined exact list of `System32`, the initial executable directory, packaged runtime-support directories, and explicitly leased read/execute support roots. Empty components, current directory, relative entries, duplicates and parent PATH are forbidden;
- Script additionally receives only `NODE_DISABLE_COLORS=1`; if the packaged runtime requires `ELECTRON_RUN_AS_NODE=1`, that fact is a frozen executable-profile field and test receipt, not inherited input;
- PowerShell receives no inherited `PSModulePath`; required modules must be in a frozen read/execute support root;
- locale/encoding compatibility may add only frozen literal `LANG`/`LC_ALL` values through an architecture amendment, not host inheritance;
- broker/control authority is conveyed only by the explicit inherited-handle list and protocol state, never by environment token.

Every other name is absent, including API/provider keys, cookies, local API token, proxy variables, cloud/SSH/Git credentials, `NODE_OPTIONS`, `NODE_PATH`, loader/preload/inspector variables, arbitrary Persona values and parent PATH. Environment names are normalized case-insensitively; duplicate/collision, `=` in a name, NUL, oversize value or unrecognized profile key fails before process creation. Tests compare the full exact set, not only selected redactions.

## 9. Network policy

### 9.1 Deny

No AppContainer network capability and no loopback exemption. Direct TCP/UDP/DNS/listen operations fail at the OS boundary.

### 9.2 Brokered allowlist

The child still receives no network capability. A finite Mini-Lux network broker performs approved operations outside the sandbox after independently validating:

- scheme, hostname, effective port and resolved redirect chain;
- the CapabilityContext allowlist;
- DNS rebinding/private-address policy;
- request/response byte and time limits;
- absence of ambient credentials and forbidden headers.

The bridge uses authenticated private handles/pipes. It is not a general socket forwarder and cannot request an arbitrary destination. E1/E2 receive a fixed `mini-lux-net` broker client only when the launch grant freezes exact finite operations; E3 receives the equivalent finite bridge API. E4 has no brokered mode in Revision 2, and any E4 launch requesting it fails `EXEC_NETWORK_PROFILE_UNSUPPORTED` before profile/ACL/process side effects.

Transparent arbitrary network compatibility is not claimed. Implementing unrestricted sockets or origin-transparent proxying would require a separately governed WFP/service design and is outside this revision.

## 10. Resource and termination policy

The frozen maximum profile values are:

| Profile | Active processes | Per-process / Job memory | CPU hard cap / total Job user time | Wall / idle | Aggregate output / retained | Input frame |
|---|---:|---:|---:|---:|---:|---:|
| E1 one-shot shell | 16 | 512 MiB / 1 GiB | 50% / 30 s | 30 s / n/a | 1 MiB / 1 MiB | 128 KiB command |
| E2 Agent persistent | 32 | 512 MiB / 1 GiB | 25% / 10 min | 30 min / 5 min | 10 MiB / 1 MiB | 64 KiB |
| E3 Script | 1 | 256 MiB / 256 MiB | 20% / 10 s | 10 s / n/a | 1 MiB / 1 MiB | 128 KiB source |
| E4 manual Terminal | 64 | 1 GiB / 2 GiB | 50% / 60 min | 8 h / 30 min | 64 MiB / 1 MiB | 64 KiB |

`MiB` is 1,048,576 bytes. Wall starts before `CreateProcessW`; idle resets only on consented/approved input or child output, not status polling. Aggregate output counts raw stdout+stderr+PTY bytes before decoding. CPU rate uses Job hard-cap control; total Job user time is independently fatal. Job flags include process/job memory, active-process, Job time, `KILL_ON_JOB_CLOSE`, and no breakaway/silent-breakaway. Users, Personas and model input may only lower numeric values; increases or new executable/support-root profiles require a numbered architecture amendment.

The host sets every applicable structure, reads it back and reports one canonical effective-policy digest before resume. Unsupported controls, rounding outside exact documented units, a host/service digest mismatch or inability to distinguish limit-triggered termination is failure.

Termination begins by atomically changing the service session `running → terminating`, invalidating input grants and closing the child input/bridge ends. The host calls `TerminateJobObject` with a stable reason code, closes ConPTY/output handles, queries `JobObjectBasicAccountingInformation` until active processes are zero, and closes the sole Job handle. Completion-port messages are evidence hints, not the sole proof. If the host is unresponsive, the service terminates the leased host process; Windows then closes the host-only Job handle and kill-on-close applies. If the service dies, its liveness pipe closes and the host performs the same sequence.

Termination is complete only when:

1. no new launch/input can be authorized;
2. Job active-process count is observed zero and the Job handle is closed;
3. all inherited/PTY/output handles reach EOF and close within the drain bound;
4. host exit is observed and no owned host PID remains;
5. ACL/profile cleanup is verified or a durable blocking recovery journal remains.

Normal one-shot completion also waits for Job active-process zero; direct-shell exit is insufficient. Timeout, idle, CPU/memory/process/output limit, cancellation, kill/close, owner retirement, session switch, server shutdown, service/host crash and protocol loss all converge on this sequence. No E1–E4 path calls PID-only kill or `taskkill` as proof.

## 11. Protocol

The host protocol is versioned, length-prefixed binary framing with canonical UTF-8 JSON payloads for control records and raw bounded byte frames for I/O.

Rules:

- maximum frame sizes are fixed;
- unknown keys, duplicate keys, invalid Unicode, non-canonical numeric forms and unknown enum values are rejected;
- secrets and executable/script bytes never appear in argv;
- launch is exactly once;
- state machine is `created → constrained → running → draining → closed` with terminal `failed`;
- input is accepted only in `running` and only after the TypeScript service consumes the matching Broker grant;
- host events include stable error codes, effective policy digest, PID/job counters and bounded redacted diagnostics.

## 12. Failure semantics

Fail closed with zero untrusted execution for:

- unavailable/mismatched native host;
- unsupported Windows or architecture;
- AppContainer/profile/ACL/Job/ConPTY setup failure;
- stale PathAuthority or root identity;
- missing Agent approval or manual native-consent decision;
- unavailable network broker for a policy requiring brokered access;
- inability to prove process assignment before resume;
- incomplete orphan ACL recovery.

There is no fallback to normal `spawn`, inherited environment, unrestricted network, direct PID-only kill or unsandboxed Terminal.

## 13. Required implementation slices

The implementation is finite and ordered:

1. governed protocol/schema and policy constants;
2. native host build, identity and package staging;
3. AppContainer + Job Object one-shot pipe runner;
4. execution-root lease and ACL journal/recovery;
5. `ExecutionIsolationService` and Broker integration;
6. restricted Script migration;
7. one-shot and persistent Agent shell migration;
8. ConPTY manual Terminal plus Electron-main native consent;
9. brokered network client;
10. source/Electron/packaged attack matrix and evidence aggregation.

A slice may not introduce a direct-spawn compatibility fallback.

## 14. Machine completion predicates

SEC-03 may become `verified` only when all are true for one source/build/package identity:

1. scanner plus independent crosscheck classify every authored sink and prove E1–E4 reach only the isolation seam; the fixed-purpose allowlist has no E1–E4 call path;
2. every real root and observed descendant proves `TokenIsAppContainer = 1`, exact unique Package SID, zero capability SIDs and expected integrity before test payload continuation;
3. every process proves membership in the expected non-breakaway Job and the host/service report identical read-back limits;
4. full environment exact-set tests show the frozen profile set and no parent sentinel secret, API key, proxy/debug/loader variable or parent PATH;
5. three distinct local fixed-NTFS roots allow the intended per-mask access and deny traversal, another drive, namespace/ADS, junction/symlink and changed identity;
6. every authorized UNC/network/non-NTFS/removable/reparse-root request fails before journal/ACL/profile/process side effects;
7. deny mode blocks DNS, TCP, UDP, localhost and listen; broker mode permits only exact approved finite operations and validated redirect chains;
8. CPU time, process count, process/job memory, output and wall/idle limits independently converge on whole-Job termination;
9. child/grandchild/detached/background/breakaway attempts cannot survive normal completion, timeout, cancel, owner/session retirement, service shutdown/crash or host crash;
10. direct HTTP manual start/input, renderer synthetic activity, native-dialog deny/dismiss, replay, altered bytes and cross-window/session grants produce zero process/ACL/stdin side effects; emergency kill/close only attenuate;
11. ACL crash-recovery removes only the exact unique-SID ACE, preserves the unrelated ACE sequence observed at the final conflict check, detects deterministic D0/D0' mutation, and blocks on ambiguity without claiming unavailable DACL CAS semantics;
12. Script cannot load addon/worker/child/inspector/WASI or bypass direct filesystem/network restrictions;
13. unit, contract, real-host integration, real Electron and installed-package layers pass with no skip/todo/unsupported on the frozen Windows x64 profile;
14. launcher and sandbox-host source/toolchain/flags/PE bytes/stage/unpacked/installer/report identities match one candidate; local unsigned status is disclosed and never reported as trusted signature;
15. the exact receipt set in §15 is complete, unique and identity-bound, and independent Debugger plus Sentinel/Reviewer verdicts contain no blocking finding.

## 15. Frozen attack matrix and receipt count

Profiles are `E1` one-shot Agent shell, `E2` persistent Agent shell, `E3` Script and `E4` manual Terminal. Every variant below has a fixed ID, stimulus and stable expected result. “All” means four observations. No slash-separated item permits implementation-time choice.

| Family | Variants | Profiles | Receipts |
|---|---:|---|---:|
| A01 environment exact-set | 8 | All | 32 |
| A02 root escape | 11 | All | 44 |
| A03 root identity/lease race | 3 | All | 12 |
| A04 direct network deny | 5 | All | 20 |
| A05 finite broker allowlist | 10 | E1–E3 | 30 |
| A06 process lineage | 4 | All | 16 |
| A07 breakaway/handle inheritance | 6 | All | 24 |
| A08 resource limit | 7, with idle only E2/E4 | mixed | 26 |
| A09 termination trigger | 8 | All | 32 |
| A10 host protocol | 9 | Host-level | 9 |
| A11 Agent grant/input binding | 8 | E1–E3 | 24 |
| A12 native consent | 9 | E4 | 9 |
| A13 direct manual HTTP | 4 | E4 | 4 |
| A14 ACL transaction/recovery | 7 | All | 28 |
| A15 native artifact identity | 9 | All | 36 |
| A16 local positive | 3 | All | 12 |
| A17 Script restriction | 7 | E3 | 7 |
| A18 unsupported root | 5 | All | 20 |
| A19 unsupported E4 broker mode | 1 | E4 | 1 |
| **Real-host integration total** |  |  | **386** |

### 15.1 Exact real-host variants

- `A01-01..08`, expected `OBS_ENV_ABSENT`: `DEEPSEEK_API_KEY`, `MINI_LUX_API_TOKEN`, `AWS_SECRET_ACCESS_KEY`, `SSH_AUTH_SOCK`, `SEC03_PARENT_SENTINEL`, `HTTP_PROXY`, `NODE_OPTIONS`, and an injected parent-only PATH entry respectively.
- `A02-01..11`, expected `OBS_FS_DENIED`: `..\outside`, sibling-prefix absolute path, another fixed local drive, `\\server\share`, `\\?\C:\...`, `\\.\...`, NTFS ADS, root junction replacement, descendant symbolic-link escape, descendant junction escape, and a hardlink alias to an outside file respectively.
- `A03-01`, expected `EXEC_ROOT_IDENTITY_CHANGED`: barrier replacement before the retained root handle. `A03-02` and `A03-03`, expected `OBS_ROOT_REPLACEMENT_BLOCKED`: replacement attempt after ACL apply and after suspended process creation respectively, followed by matching final identity and safe continuation.
- `A04-01..05`, expected `OBS_NETWORK_DENIED`: DNS query, external TCP connect, UDP send, loopback connect and listen/bind respectively.
- `A05-01`, expected `OBS_BROKER_ALLOWED`: exact frozen HTTPS operation. `A05-02..10` expect, in order, `EXEC_BROKER_SCHEME_DENIED`, `EXEC_BROKER_HOST_DENIED`, `EXEC_BROKER_PORT_DENIED`, `EXEC_BROKER_PRIVATE_ADDRESS_DENIED`, `EXEC_BROKER_DNS_REBIND_DENIED`, `EXEC_BROKER_REDIRECT_DENIED`, `EXEC_BROKER_REQUEST_LIMIT`, `EXEC_BROKER_RESPONSE_LIMIT`, `EXEC_BROKER_TIMEOUT`.
- `A06-01..04`, expected `OBS_JOB_EMPTY`: direct child, grandchild, detached child, and background descendant after direct parent exits.
- `A07-01..06`: explicit breakaway and silent-breakaway requests expect `EXEC_BREAKAWAY_DENIED`; nested-job incompatibility expects `EXEC_JOB_INCOMPATIBLE`; attempted Job-handle duplication, control-handle duplication and inheritance of one unlisted sentinel handle each expect `OBS_HANDLE_DENIED`.
- `A08-01..06`, all profiles, expect `EXEC_LIMIT_CPU`, `EXEC_LIMIT_ACTIVE_PROCESS`, `EXEC_LIMIT_PROCESS_MEMORY`, `EXEC_LIMIT_JOB_MEMORY`, `EXEC_LIMIT_OUTPUT`, `EXEC_LIMIT_WALL` respectively. `A08-07` runs only E2/E4 and expects `EXEC_LIMIT_IDLE`. Tests attenuate durations/sizes but preserve the same limit type and policy digest fields.
- `A09-01..08` expect `EXEC_COMPLETED_JOB_EMPTY`, `EXEC_CANCELLED`, `EXEC_OWNER_RETIRED`, `EXEC_SESSION_RETIRED`, `EXEC_SERVICE_SHUTDOWN`, `EXEC_SERVICE_LOST`, `EXEC_HOST_LOST`, `EXEC_CHANNEL_LOST` for normal drain, explicit cancel, ResourceOwner retirement, session switch, graceful service shutdown, forced service crash, forced host crash and independent control-channel loss respectively.
- `A10-01..09` expect `EXEC_PROTOCOL_INVALID` with fixed subcodes `length`, `oversize`, `unknown-key`, `duplicate-key`, `utf8`, `replay`, `second-launch`, `secret`, `state` respectively.
- `A11-01..08` expect `EXEC_GRANT_REQUIRED`, `EXEC_GRANT_FORGED`, `EXEC_GRANT_ARGUMENT_MISMATCH`, `EXEC_GRANT_EXPIRED`, `EXEC_GRANT_REPLAYED`, `EXEC_GRANT_CROSS_RUN`, `EXEC_GRANT_CROSS_SESSION`, `EXEC_GRANT_CONCURRENT_REUSE`. E2 applies the same IDs to `InputGrant` after its launch grant.
- `A12-01..09` expect `EXEC_CONSENT_DENIED`, `EXEC_CONSENT_DISMISSED`, `EXEC_CONSENT_EXPIRED`, `EXEC_CONSENT_ARGUMENT_MISMATCH`, `EXEC_CONSENT_REPLAYED`, `EXEC_CONSENT_SYNTHETIC`, `EXEC_CONSENT_CROSS_WINDOW`, `EXEC_CONSENT_CROSS_SESSION`, `EXEC_CONSENT_CONCURRENT_REUSE`.
- `A13-01..04` expect `EXEC_DIRECT_MUTATION_DENIED` for HTTP start/input and `EXEC_OWNER_MISMATCH` for cross-owner kill/close respectively.
- `A14-01..07` expect `OBS_ACL_PRISTINE` after pre-mutation crash, `OBS_ACL_RECOVERED` after post-apply crash, `EXEC_ACL_SHARING_FAILED`, `EXEC_ACL_PROPAGATION_FAILED`, `EXEC_ACL_CONFLICT` for deterministic unrelated-ACE mutation at D0/D0', `EXEC_ROOT_IDENTITY_CHANGED`, and `EXEC_RECOVERY_JOURNAL_INVALID` respectively. A14-05 proves no overwrite at the frozen barrier, not unavailable DACL CAS semantics.
- `A15-01..09` expect `EXEC_NATIVE_IDENTITY_INVALID` for missing launcher, missing host, extra native artifact, changed launcher bytes, changed host bytes, wrong PE machine, forbidden import digest, attempted host replacement while exclusive lease is held, and source/toolchain digest mismatch respectively.
- `A16-01..03`, expected `OBS_POSITIVE_COMPLETE`: ASCII workspace, non-ASCII/space workspace, and a test-created separate local fixed-NTFS VHD volume respectively.
- `A17-01..07`, expected `OBS_SCRIPT_DENIED`: native addon, Worker, child process, inspector, WASI, direct filesystem bypass and direct network bypass respectively.
- `A18-01..05`, expected `EXEC_ROOT_UNSUPPORTED` before journal/profile/process side effects: authorized UNC, mapped remote drive, local non-NTFS volume, removable NTFS volume and reparse root respectively.
- `A19-01`, E4 only, expected `EXEC_NETWORK_PROFILE_UNSUPPORTED` before journal/profile/process side effects when brokered mode is requested.

### 15.2 Exact Electron and installed-package projections

Each layer executes `P01..P12` for each E1–E4 profile: `P01` seam + exact launcher/host digest (`OBS_HOST_BOUND`); `P02` token (`OBS_TOKEN_MATCH`); `P03` Job/read-back limits (`OBS_JOB_MATCH`); `P04` exact environment (`OBS_ENV_EXACT`); `P05=A16-01`; `P06=A02-01`; `P07=A04-02`; `P08=A06-02`; `P09=A08-05`; `P10=A09-03`; `P11=A11-05` for E1–E3 and `A12-05` for E4; `P12=A09-07` plus verified ACL/profile cleanup. Thus each projection has exactly **48** receipts and the frozen runtime total is **482** (`386 real-host + 48 Electron + 48 packaged`). Unit/contract/scanner/governance assertions are additional and cannot substitute for runtime receipts.

Every receipt key is `(candidateId, layer, familyId, variantId, profileId)`. It records architecture/matrix/schema hashes, source digest, launcher/host PE digests, stage/package digest where applicable, exact expected and actual stable code/subcode, process/ACL/stdin side-effect counters, token Package SID/capability count/integrity, Job policy digest/active-process-zero proof, environment-name digest, root identity digest, start/end state and cleanup result. Raw secrets, command content and absolute paths are forbidden. Missing, duplicate, stale-identity, unsupported, skipped, todo, wrong-profile or internally inconsistent receipts fail aggregation.

## 16. Frozen decisions, trade-offs and evidence boundary

1. **Regular AppContainer, not LPAC.** Regular AppContainer is the only Revision 2 execution token. LPAC is stricter but its compatibility/support surface is not proved; adding it later is a new numbered profile amendment, never silent fallback.
2. **Local fixed NTFS only.** Arbitrary UNC, mapped remote, removable, non-NTFS and uncertain reparse roots fail closed. This reduces workspace execution compatibility but avoids claiming unproved SMB credentials/network-capability/remote ACL semantics. File tools may still use separately authorized SEC-02 roots; E1–E4 may not execute there.
3. **Unique SID + handle-based ACL transaction.** This adds ACL/journal complexity but prevents cross-execution reuse and avoids restoring stale whole descriptors. The retained no-share-delete root handle plus final identity recheck closes governed replacement; D0/D0' barriers detect deterministic DACL conflict. Windows provides no DACL CAS, so a separate `WRITE_DAC` principal in the final syscall interval is an explicit non-claim. OS automatic inheritance is used only on eligible NTFS descendants; protected/unavailable descendants may deny a positive launch but never trigger broader grants.
4. **Finite network broker for E1–E3; E4 deny-only.** No direct socket compatibility is claimed. E1/E2 receive the fixed client and E3 the finite API; E4 has no broker bridge. A future transparent or manual-Terminal network runner requires separate WFP/service architecture and review.
5. **Fixed limits, attenuation only.** §10 values are maxima. Compatibility requests that exceed them are denied rather than silently relaxed.
6. **Native consent for start/input; emergency attenuation for kill/close.** This trades interaction cost for exact-command consent while preserving an unblocked safety stop.
7. **Hash identity without false signing claim.** Source/toolchain/PE/package identity is mandatory. Unsigned local candidates remain explicitly unsigned; trusted-release signing remains GOV-04 policy.

Official Windows evidence supports only the primitives used in the contract:

- Microsoft “Launch an AppContainer” documents Package SID/capability setup through `PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES` and the AppContainer DACL model: <https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer>.
- `UpdateProcThreadAttribute` documents explicit `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` inheritance: <https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute>.
- Job Objects document descendant association by default, breakaway exceptions, nested jobs and kill-on-last-handle-close: <https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects>.
- `SetSecurityInfo` and automatic ACE propagation document handle-based DACL update and propagation to eligible existing NTFS children: <https://learn.microsoft.com/en-us/windows/win32/api/aclapi/nf-aclapi-setsecurityinfo> and <https://learn.microsoft.com/en-us/windows/win32/secauthz/automatic-propagation-of-inheritable-aces>.

These sources do **not** prove that ConPTY is isolation, that Job Objects control files/network, that every legacy executable is AppContainer-compatible, that UNC/SMB execution is safe without further design, or that implementation is correct. Those remain measured completion predicates. Revision 2 makes no claim against administrator/SYSTEM/kernel attackers or Windows sandbox vulnerabilities.
