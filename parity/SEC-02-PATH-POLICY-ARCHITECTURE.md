# SEC-02 Unified PathPolicy Architecture

Status: **FROZEN — REVISION 3**  
Target: Mini-Lux after accepted SEC-01 candidate `0.1.0+local.bc9570de9e02`  
Canonical task: `LUX-DESKTOP-100-PARITY-EXECUTION-SPEC.md#SEC-02`

## 1. Decision

Mini-Lux SHALL expose one process-local PathPolicy **security boundary** for every path-taking model tool, direct API, managed definition store, file-viewer operation, watcher, and process initial CWD. The boundary may contain platform grammar, filesystem adapter, lease, and audit modules, but all callers use one capability-scoped API and may not make their own containment decision.

`CapabilityContext.allowedRoots`, Settings strings, executor environment variables, a user-supplied absolute path, and a previously validated path string are not execution authority. Authority comes from a Broker-private `PathAuthority` and an operation-specific gateway method that binds grammar validation, deterministic root selection, lexical/canonical containment, object identity, use, audit, and cleanup.

No compatibility path may retain `startsWith`, `replace(/\.\./g, "")`, raw `path.resolve`, validate-then-reopen, or a parser/library path API as a security decision.

## 2. Architecture choice and non-claims

SEC-02 uses the governed Node 24/Electron 43 filesystem APIs. It does **not** introduce an unaudited native addon that would create a second packaging and trust boundary.

SEC-02 strongly guarantees:

- unsafe raw grammar is denied before filesystem, network, parser, watcher, or process calls;
- ordinary out-of-root targets are denied by lexical and canonical containment;
- Node-visible symbolic links and junctions below a root are denied;
- volume/device identity changes and canonical escapes are denied;
- an existing-file read returns bytes only from the identity-checked opened handle;
- deterministic production-adapter barriers detect root/ancestor/target replacement before the next governed action;
- pre-create controlled races deny before creation or verify no final residue;
- post-create identity change stops further writes, closes the handle, and yields either verified cleanup or hard `PATH_ROLLBACK_FAILED`;
- rejected direct malicious inputs leave no root-external artifact and emit a redacted audit attempt.

SEC-02 does **not** claim:

- that Shell, Script, or Terminal code cannot access another path after process start; SEC-03 owns the OS sandbox;
- protection from an administrator, kernel attacker, or a concurrent process with the same OS principal that can replace an authorized writable ancestor in the final unobservable interval after revalidation; SEC-03 removes that actor from the process boundary;
- that Node exposes every vendor-specific Windows reparse tag. A root/filesystem whose redirecting semantics or stable identity cannot be established is unsupported and is not published;
- zero transient external contact after a concurrent race has redirected a path. Existing reads guarantee no replacement bytes are returned; controlled new-target races guarantee detection and no final residue, not absence of a transient create notification;
- durable audit retention; SEC-06 owns it;
- UI gesture authorization for root enrollment; SEC-04 owns it;
- that an allowed-root read-only hardlink has no alias elsewhere. Existing writes deny `nlink > 1` at the governed check; the residual concurrent hardlink race is within the same-OS-principal non-claim.

These limits do not weaken canonical malicious-path tests. `..`, other drives, UNC, namespaces, aliases, ADS, sibling prefixes, symlink/junction escapes, and deterministic TOCTOU barriers remain required and fail-closed.

## 3. Threat model

Untrusted inputs include Provider/dynamic-tool arguments, HTTP path values after exactly one transport decode, Persona/Skill/Playbook identifiers and disk content, Oracle roots, download filenames, URL-derived names, file-viewer values, process CWDs, watcher paths and event names, Settings/root strings, directory entries, Git tracked paths, and any path observed after an asynchronous scheduling point.

Trusted but validated bootstrap inputs include Electron-pinned app/userData/public/models/config locations. Source/daemon environment overrides are operator inputs, never model authority, and pass the same grammar/root qualification before serving or writing data.

## 4. Mandatory invariants

1. **One boundary**: all security-relevant path decisions use the PathPolicy module boundary; wrappers select operations but do not implement containment.
2. **Private authority**: `PathAuthority` authenticity is object identity in a private `WeakMap`; it is never serialized, logged, persisted, sent to Providers, or given to arbitrary executors.
3. **Capability roots**: model/direct data operations use only exact roots frozen into their current Broker authority. Environment and Settings select bootstrap candidates, not execution authority.
4. **Root enrollment separation**: adding/changing a root is a local control-plane transaction, not a model path operation. It uses a private enrollment authority and cannot be called by Agent/SubAgent/Playbook principals.
5. **Stable identity**: root/ancestor/object identity uses filesystem/volume ID, object ID/inode, and type. Size/time/link count are mutable observations, never identity.
6. **Unsupported means absent**: unavailable roots or roots without stable Node-observable identity/redirect semantics grant no capability.
7. **Absolute by capability**: absolute targets are accepted only under the deterministically selected exact authorized root.
8. **Most-specific root wins**: after lexical resolution and again after canonical resolution, the most-specific root/exclusion record wins. Permissions never fall back to a broader ancestor or merge across roots.
9. **Pre-I/O grammar**: malformed, traversal, rooted-current-drive, device/namespace, ADS, trailing-alias, DOS-device, and unapproved UNC forms are rejected before external calls.
10. **Dual containment**: every target passes lexical containment before filesystem contact and canonical containment after resolution.
11. **No prefixes/sanitization**: prefix checks and mutation of unsafe input are forbidden.
12. **Redirect denial**: Node-visible symlink/junction components below a root, canonical component escape, and unexpected device/volume crossing are denied.
13. **Opened-file binding**: bounded reads/edits use the identity-checked opened file handle; parsers consume buffers rather than paths.
14. **Nearest existing parent**: new targets walk to the nearest existing parent, validate it, create one segment at a time, and revalidate after every test barrier and syscall.
15. **Create-or-replace is atomic in policy**: callers never use `exists()` to select permissions. The gateway attempts exclusive create; an existing target starts a fresh replace authorization.
16. **Root change aborts**: root/ancestor/target identity replacement is `PATH_IDENTITY_CHANGED`; there is no automatic following or broader-root retry.
17. **Conservative rollback**: the gateway records created identities, removes only a still-matching object it created, and verifies final absence in controlled-race tests. Unverifiable cleanup is `PATH_ROLLBACK_FAILED`.
18. **Long-lived ownership**: Terminal processes/control, watchers, HTTP leases, parser workers, and streams bind authority/epoch/session/principal/root identity.
19. **Operation leases**: retirement first blocks new leases and new opens, then closes/drains governed resources, then publishes replacement authority.
20. **Stable denial**: safe codes/messages contain no raw path, canonical root, token, or content.
21. **One audit attempt**: one top-level rejected operation makes exactly one non-recursive audit delivery attempt. Sink failure returns `PATH_AUDIT_FAILED`; it is not falsely reported as a committed event.
22. **Direct-input zero side effects**: a path rejected before authorized use invokes no parser/fetch/provider/process/watcher or root-external filesystem sink and leaves no temp artifact.
23. **Positive behavior**: ordinary root-internal relative and capability-authorized absolute paths remain functional.
24. **Revoke before publish**: root/settings/runtime changes retire affected authorities/resources before replacement publication.
25. **No fallback**: failure never falls back to home, drive root, process CWD, mutable Settings, or raw environment.
26. **Monotonic evidence**: resolved cumulative manifests bind test bytes, attack/positive receipts, changed runtime files, coverage, runners, schemas, and packaged assertions—not only path lists.

## 5. Core records

```ts
type PathRootRole =
  | "workspace" | "department" | "output"
  | "app" | "public" | "models" | "user-data"
  | "personas" | "skills" | "playbooks" | "oracle" | "scripts";

type PathOperation =
  | "read-file" | "read-directory" | "search-tree"
  | "create-file" | "replace-file" | "create-directory"
  | "watch-directory" | "initial-cwd" | "reveal";

interface ObjectIdentity {
  readonly deviceId: string;
  readonly objectId: string;
  readonly type: "file" | "directory";
}

interface MutableSnapshot {
  readonly size: string;
  readonly mtimeNs: string;
  readonly ctimeNs: string;
  readonly linkCount: string;
}

interface CanonicalRootRecord {
  readonly rootId: string;
  readonly role: PathRootRole;
  readonly configuredFingerprint: string;
  readonly lexicalPath: string;
  readonly canonicalPath: string;
  readonly identity: ObjectIdentity;
  readonly identityProvider: "node-bigint-stat";
  readonly filesystemClass: "local-supported" | "unc-supported";
  readonly permissions: ReadonlySet<PathOperation>;
  readonly authorityEpoch: number;
  readonly exclusionOnly: boolean;
}

interface PathRequest {
  readonly input: string;
  readonly operation: PathOperation;
  readonly kind: "existing-file" | "existing-directory" | "new-file" | "new-directory" | "create-or-replace-file";
  readonly defaultRootId?: string;
  readonly requiredExtension?: string;
}

interface PathAuditEvent {
  readonly event: "path-policy-denied" | "path-policy-rollback-failed";
  readonly operationId: string;
  readonly code: PathDenialCode;
  readonly operation: PathOperation;
  readonly inputFingerprint: string;
  readonly rootId: string | null;
  readonly sessionId: string | null;
  readonly runId: string | null;
  readonly principal: string;
  readonly authorityEpoch: number | null;
  readonly timestamp: string;
}
```

Node BigInt `dev/ino/type` is used only after a qualification probe shows stable nonzero identity across close/reopen and alias resolution. Windows UNC roots require the same probe; otherwise they may be represented in pure grammar tests but are not executable roots. `size/mtime/ctime/nlink` are snapshots for bounds, concurrent content change, and write policy.

## 6. Authorities and lifecycle

### 6.1 Bootstrap and root-enrollment transaction

Pinned app/userData descendants are prepared by a private bootstrap authority anchored in the already validated Electron/runtime path relationship. Persona/Skill/Playbook/Oracle managed authorities derive only from those pinned roots and never from model `allowedRoots`.

Settings/root enrollment is a serialized control-plane transaction guarded by one Broker-private mutex. Every candidate binds the observed `baseAuthorityEpoch` and previous settings digest:

```text
lock enrollment mutex
→ validate candidate transport/type/grammar
→ prepare roots and identity probes off-line
→ for a missing output, require its nearest existing parent under an already writable enrolled root
→ build candidate root table, exclusions, managed authorities, and runtime authority off-line
→ compare-and-swap base epoch + previous settings digest; stale candidate is denied
→ retire old authority permanently, stop new leases, and drain/close governed resources
→ atomically persist candidate settings
→ publish candidate authorities
→ unlock
```

An authority object or token is monotonic: once exiting/retired, it is never reactivated. If persistence fails after retirement, the system either creates a **new authority object with a new epoch** from the previous prepared descriptors/settings, or enters a stopped fail-closed state. If publication fails after persistence, it atomically restores the previous settings file and likewise publishes only a fresh old-configuration authority/new epoch, or remains stopped. Closed long-lived resources are not resurrected. Disk/runtime disagreement and stale concurrent candidate publication are forbidden.

Workspace/department roots may be unavailable and are omitted. Required output/managed roots must prepare successfully. A model cannot enroll a new root. SEC-04 later strengthens the local gesture controlling enrollment.

### 6.2 Root qualification and overlap

Qualification performs grammar parsing before I/O, resolves canonical path, walks current components, rejects Node-visible symlink/junction redirection below the configured root alias, probes stable identity, and records canonical device/object IDs.

The runtime keeps a global ordered table containing executable roots and protected exclusion roots. Both lexical and canonical selection choose the most-specific record. A caller must own that exact root and operation. A denied/protected child root cannot be accessed through a broader workspace root. Canonical selection must equal lexical selection after resolving aliases such as case and 8.3 names.

Two root IDs resolving to the same canonical identity are rejected. Crossed lexical/canonical nesting, ambiguous equal-specificity records, and inconsistent alias/permission definitions prevent publication.

### 6.3 Broker binding and scoped services

`CapabilityBroker.createRuntimeAuthority` receives prepared descriptors, not raw strings. Child attenuation selects exact parent root IDs and identities. Raw path strings cannot broaden roots.

`ToolInvocationServices` receives a frozen capability-scoped gateway that closes over authentic context. It exposes operation methods and safe leases, not raw authority/root records. Direct data APIs get the same gateway from `runDirectOperation`. Managed stores get separate least-privilege internal gateways.

Root enrollment is the only special direct operation and cannot be invoked through a model capability context.

### 6.4 Operation and resource leases

Every operation registers a private lease before its first filesystem call. A lease records authority ID/epoch, session, principal, root ID/identity, state, and any opened handle. An issued-but-not-opened lease rechecks the authority at the linearization point immediately before every open and is denied after retirement. Retirement atomically marks the authority exiting; an already identity-checked file handle may drain without pathname reopen, but no lease may open another path afterward.

Terminal processes/control, watchers, parser workers, streams, and HTTP range leases are long-lived resources. They bind the same identity tuple. Settings/root change and Session deletion close or isolate them before replacement publication. A new authority cannot write to, resize, subscribe to, or otherwise control an old Terminal ID. If a close/drain deadline fails, replacement publication fails closed and reports a lifecycle security error.

## 7. Windows pre-I/O grammar

The gateway accepts only strings already decoded exactly once by the transport. It rejects non-strings, invalid UTF-16/NUL/control characters, and double-decoding behavior.

Before any `path.resolve`, `realpath`, stat/open, network, parser, watcher, or process call, Windows grammar rejects case-insensitively:

- `.` and `..` components with either slash as separator;
- drive-relative `C:foo` and `F:..\x`;
- rooted-current-drive `\foo` and `/foo`;
- namespace/device/NT prefixes in slash or mixed-slash form: `\\?\`, `\\.\`, `\??\`, `GLOBALROOT`, `//?/`, and `//./`;
- every colon except the drive colon in a DOS absolute prefix;
- ADS forms including `name:stream`, `::$DATA`, extension-like streams, and extra colons;
- segments ending in U+002E or U+0020;
- DOS devices `CON`, `PRN`, `AUX`, `NUL`, `CLOCK$`, `CONIN$`, `CONOUT$`, `COM1..9`, `LPT1..9`, `COM¹/²/³`, and `LPT¹/²/³`, including extension/case/trailing-alias forms;
- malformed/incomplete UNC and server/share not matching a configured UNC candidate.

Unsafe input is rejected, never trimmed or normalized into acceptance. Ordinary relative paths, DOS absolute paths, and standard authorized UNC paths proceed to root selection. Canonical re-selection handles case and 8.3 aliases; aliases may not bypass a protected most-specific root.

On non-Windows systems the corresponding platform grammar rejects NUL, traversal components, ambiguous rooted forms, and absolute targets outside exact roots.

## 8. Containment, identity, and bounded reads

Containment is component-aware:

```ts
const relative = path.relative(root, target);
const inside = relative === "" || (
  relative !== ".." &&
  !relative.startsWith(`..${path.sep}`) &&
  !path.isAbsolute(relative)
);
```

Windows comparisons use the platform's case-insensitive semantics while identity remains `deviceId/objectId/type`. Different devices or UNC shares fail before target I/O. Sibling prefixes are outside.

A bounded read loops on the already validated `FileHandle` and aborts when accumulated bytes exceed the limit. It never trusts only a pre-read stat size. Parsers receive bounded buffers. Parser-specific decompression/output limits are retained or added for ZIP-based Office inputs.

## 9. Existing-target algorithm

```text
validate raw grammar
→ lexical most-specific root selection and permission check
→ lexical target and component containment
→ verify current root identity
→ walk components and reject Node-visible symlink/junction or device crossing
→ realpath target
→ canonical most-specific root re-selection and containment
→ stat expected type and capture stable identity + mutable snapshot
→ open file target
→ fstat handle and compare stable identity/type
→ bounded operation through the same handle
→ close handle/lease
```

If a replacement is opened after a race, the handle is closed without reading bytes or invoking a parser/provider. This guarantees no replacement bytes escape; it does not claim no root-external open/contact in the excluded final-resolution race.

Directory listing/search uses the production Node directory adapter under the qualified-root assumption. It revalidates directory identity immediately before opening and after the test barrier, does not follow links, grammar-checks every `Dirent.name`, and authorizes every child before metadata/content access. Because Node `Dir` has no supported identity `fstat`, this is not described as handle-identity proof against the excluded same-principal final race.

HTTP file content returns a private validated file-handle lease. Range reads use that handle; no route calls `createReadStream` with a returned path. File-viewer resolve returns redacted metadata/root-relative identity, not an authority-bearing absolute string.

Reveal and initial-CWD revalidate root/target after `beforeProcessSpawn` and immediately before the Node spawn/reveal call. They guarantee direct malicious input denial and controlled-barrier detection; the OS final string-resolution interval is within the explicit SEC-03 residual boundary.

## 10. New-target, replacement, and two-phase output

A new target never begins with recursive unchecked `mkdir` or path-based `writeFile`.

### 10.1 Reservation before external work

Download, image-derived output, and generated Office content use a private one-use output reservation:

```text
validate target grammar/root/permission
→ validate nearest existing parent and capture identities
→ issue private reservation bound to authority/root/operation/target digest/expiry
→ perform bounded generation or fetch
→ consume reservation
→ revalidate authority/root/parent
→ create or replace through the gateway
```

A root-external download filename is rejected before fetch. Revocation or target/parent change between reservation and commit denies the write. Reservations are private and non-serializable.

### 10.2 Creation

```text
validate grammar, extension, root, and lexical containment
→ find nearest existing parent without crossing the selected root
→ verify root/parent canonical identity and permissions
→ enumerate missing segments without I/O side effects
→ for each segment: barrier, revalidate, exclusive mkdir, lstat/realpath/identity check
→ before final create: barrier, revalidate full ancestor chain
→ open final file with exclusive-create semantics
→ realpath/fstat and canonical root re-selection
→ write bounded bytes through the opened handle
→ sync/close as required
```

Created identities are recorded. On controlled-barrier failure the gateway stops further writes, closes handles, and removes only a still-path-reachable, identity-matching empty object it created, in reverse order. It never recursively removes pre-existing content. If cleanup is verifiable, final absence is required. If a same-principal race moved the created identity to an unknown pathname or otherwise made verification impossible, the result is hard `PATH_ROLLBACK_FAILED`; the gateway does not claim it found or removed that object.

Pre-create deterministic races prove denial before creation or verified no-final-residue cleanup. A post-create identity race proves detection, zero further writes, handle closure, and either verified cleanup or hard `PATH_ROLLBACK_FAILED`. It does not promise removal of an object concurrently moved beyond Node's path-based reach and does not claim suppression of every transient notification.

### 10.3 Create-or-replace and edit

A `create-or-replace-file` operation first attempts the governed exclusive create. `EEXIST` does not authorize overwrite; it restarts as a complete existing-target replacement with `replace-file` permission.

Replacement/edit:

- denies Node-visible links/junctions and `linkCount > 1` at the governed check;
- opens the existing destination, compares stable identity, and reads/writes the same handle;
- rechecks mutable snapshot when the operation requires optimistic concurrency;
- truncates only after authorization and identity checks;
- never hands the destination path to a writer library.

DOCX/XLSX libraries generate buffers. PDF/Office readers receive bounded buffers. Downloads fetch bounded content only after reservation. No authored caller uses `XLSX.writeFile`, `mammoth({path})`, worker path reopen, or equivalent path-taking parser/writer APIs.

## 11. Deterministic TOCTOU and evidence tiers

Test barriers are compiled into/injected through the same production filesystem adapter; they only pause execution and cannot substitute idealized filesystem semantics. Production exposes no externally callable barrier.

Required barriers:

- `afterLexicalContainment`;
- `afterCanonicalValidation`;
- `afterHandleOpen`;
- `beforeCreateSegment`;
- `beforeFinalCreate`;
- `beforeProcessSpawn`;
- `beforeWatcherPublish`.

After every barrier, production code revalidates the identities needed by the next action. Evidence is typed:

1. **`windows-native`** — real NTFS files/directories, production adapter, actual symlink/junction/hardlink/root replacement, actual process/watcher/file handles;
2. **`production-barrier`** — same production adapter and real filesystem, with a barrier coordinating the real replacement;
3. **`pure-policy`** — grammar/root-selection cases that intentionally perform zero filesystem calls, including unavailable UNC identities;
4. **`runtime-contract`** — executes the real gateway with injected non-filesystem dependencies such as the audit sink and validates exact calls/results;
5. **`contract-validation`** — an independent parent reads raw receipts/reports/package contents and recomputes invariants without trusting producer summary booleans;
6. **`static-inventory`** — AST/import/sink inventory only; never substitutes for runtime or package evidence.

A fake in-memory adapter cannot satisfy `windows-native` or `production-barrier`. If the governed Windows runner cannot create a real file symlink or junction, the required environment gate fails; it is not skipped or replaced by a mock green.

A real authorized SMB root is environment-dependent. The always-required P05 evidence is a pure-policy UNC grammar/authority/identity-adapter contract with zero network calls. A real SMB positive may be reported separately as supplemental evidence and cannot change the required result.

For existing reads after replacement, the required proof is: no external bytes returned, no parser/provider receives content, and a mismatched opened handle is closed. It does not assert zero external open/contact. For pre-create races, the controlled barrier must produce denial before create or verified no-final-residue rollback. For a post-create identity race, allowed outcomes are verified cleanup or hard `PATH_ROLLBACK_FAILED`; both require zero further writes and handle closure. Reports preserve this distinction and the same-principal residual risk.

Every denied observation includes adapter counters, external sentinel tree before/after bytes/identity/entries, process baseline, watcher baseline, parser/provider/fetch counters, audit attempt, and cleanup result as applicable.

## 12. Governed surface inventory

The following is the minimum authored-source inventory. Each row binds caller, authority class, operation, and prohibited bypass:

| Surface | Authority / operation | Required behavior |
|---|---|---|
| `list_directory` | model root / read-directory | Qualify directory; authorize every entry; no link follow. |
| `read_file` | model root / read-file | Bounded opened-handle read; parser consumes buffer. |
| `search_files`, `grep` | model root / search-tree | Non-link traversal; cache key includes authority, epoch, root identity; revoke purges cache. |
| `write_file`, `edit_file` | model root / create-or-replace | Exclusive-create then independent replacement authorization. |
| `download` | model output / create-file | Reservation before fetch; bounded fetch; gateway commit. |
| `create_docx`, `create_xlsx` | model output / create-or-replace | Buffer generation; required extension; gateway write. |
| `image_helper` | model root / read-file | Bounded buffer before provider/network. |
| `read_repo` | model root / initial-cwd + read-file | Fixed Git command; `git ls-files -z`; NUL parsing; authorize every tracked entry/link. |
| Oracle project read | model root / search-tree | Authorized project only; every input child governed. |
| Oracle snapshot load/save | managed Oracle authority | Managed read/write; never inherits arbitrary model roots. |
| Persona list/load/switch/save | managed Persona authority | Safe identifier, content/name match, no linked definition, exclusive creation. |
| Skill list/load | managed Skill authority | Safe identifier, no linked definition, bounded read. |
| Playbook list/read/create/execute | managed Playbook authority | Safe identifier, schema, exclusive create, owner context, no linked JSON. |
| watcher create/event | scoped root / watch-directory | Revalidate before publish; event names re-enter grammar/child authorization; revoke closes. |
| `execute_command` | model root / initial-cwd | Revalidate before spawn; post-start confinement is SEC-03. |
| `script` | model root / initial-cwd | Authorized CWD; temporary script under managed scripts root. |
| tool `shell_start` | model root / initial-cwd | Scoped root and Terminal ownership before manager/spawn. |
| HTTP Terminal start/control | direct local authority | Same gateway; Terminal binds authority/root identity; old authority cannot control. |
| file roots/list/preview | direct local authority | One immutable root snapshot; no mutable Settings reread/materialization. |
| file resolve/content/range | direct local authority | Validated handle lease; no string reopen. |
| file reveal | direct local authority / reveal | Revalidate after barrier and before reveal spawn. |
| Settings API/disk load | enrollment/bootstrap authority | Transactional candidate preparation; no model authority. |
| runtime app/public/models/config/db paths | bootstrap authority | Validate pinned relationship and expected role before serve/read/write. |
| parser workers | operation lease | Receive bounded bytes/ports, never an untrusted path. |
| Electron main/preload routes | direct/bootstrap authority | No independent path decision or raw sink. |

Static boundaries cover `src`, `electron`, workers, scripts that execute runtime paths, and the packaged ASAR payload. `.electron-app` is generated output and is verified against source/dist integrity, never edited as source.

The boundary contract maintains an exhaustive authored-source sink inventory, not a regex blacklist. It resolves ESM/CJS imports, aliases, destructuring, dynamic imports, worker data, third-party path APIs, `spawn` CWD, `fs.watch`, and Electron reveal/stream sinks. Every sink is either inside the approved PathPolicy adapter/bootstrap implementation or has a runtime call-path assertion entering the scoped gateway.

## 13. Managed identifiers

Persona, Skill, and Playbook identifiers use:

```text
^[a-z0-9][a-z0-9-]{0,63}$
```

Existing built-ins satisfy the rule. Identifiers are decoded once by transport and are never interpreted as paths. Separators, dots, colons, whitespace, percent-encoded/double-encoded separators, and Windows device names are rejected.

Persona filename stem, frontmatter `name`, and requested name match exactly. Every referenced Skill identifier passes the rule. Definition files are regular non-link files inside the managed root. Built-in/user precedence applies only after both files are independently authorized.

Playbook JSON is bounded and schema-validated before use. Content cannot turn a file outside the managed root into a Playbook.

## 14. Audit contract

The top-level gateway allocates one `operationId` and performs **exactly one** audit delivery attempt for every returned denial. Nested helpers return typed internal failures and never audit independently.

Allowed fields are exactly:

```text
event, operationId, code, operation, inputFingerprint, rootId,
sessionId, runId, principal, authorityEpoch, timestamp
```

`inputFingerprint` is HMAC-SHA-256 with a random process/authority audit key that is never logged or persisted. It supports same-runtime correlation without enabling an offline dictionary over common paths. Raw input, absolute/canonical path, contents, environment, API keys, and path-bearing exception stacks are forbidden.

Normal sink success commits exactly one event. If the sink throws or rejects, the operation remains denied and the public result includes `PATH_AUDIT_FAILED`; the attempt is marked failed in in-memory test instrumentation. The gateway does not recursively audit the audit failure and does not claim a committed event. A minimal path-free emergency log may be attempted but is non-authoritative. A lifecycle or rollback hard failure is never downgraded: the structured result preserves the primary `PATH_ROLLBACK_FAILED`/`PATH_LIFECYCLE_FAILED` classification and separately records `auditDeliveryFailed=true`.

Stable codes:

- `PATH_AUTHORITY_REQUIRED`, `PATH_AUTHORITY_FORGED`, `PATH_AUTHORITY_STALE`;
- `PATH_INPUT_INVALID`, `PATH_NAMESPACE_DENIED`, `PATH_UNC_DENIED`;
- `PATH_ROOT_DENIED`, `PATH_ROOT_UNAVAILABLE`, `PATH_ROOT_UNSUPPORTED`;
- `PATH_NOT_FOUND`, `PATH_TYPE_MISMATCH`, `PATH_REDIRECT_DENIED`;
- `PATH_IDENTITY_CHANGED`, `PATH_OPERATION_DENIED`;
- `PATH_ROLLBACK_FAILED`, `PATH_AUDIT_FAILED`, `PATH_LIFECYCLE_FAILED`.

## 15. Proposed attack matrix and mandatory observations

The 36 scenario IDs/order are canonical for SEC-02. Freeze includes both this document and `tests/sec02-attack-matrix.json`. The JSON expands every mandatory observation below; contract tests require exact IDs, order, evidence tier, expected values, and no duplicate/missing/extra receipt.

1. `SEC02-P01` mixed-separator dot-dot traversal is denied pre-I/O.
2. `SEC02-P02` an absolute path on another drive is denied pre-I/O.
3. `SEC02-P03` drive-relative forms are denied pre-I/O.
4. `SEC02-P04` malformed or unapproved UNC is denied with zero filesystem/network calls.
5. `SEC02-P05` standard UNC selection accepts only the exact configured server/share/root identity.
6. `SEC02-P06` extended, device, NT, mixed-slash, and GLOBALROOT namespaces are denied pre-I/O.
7. `SEC02-P07` ADS and extra-colon forms are denied pre-I/O.
8. `SEC02-P08` trailing-dot/space aliases in final or intermediate segments are denied pre-I/O.
9. `SEC02-P09` all frozen DOS device bases and alias forms are denied pre-I/O.
10. `SEC02-P10` a mixed-case path inside a case-insensitive Windows root resolves to one object identity.
11. `SEC02-P11` drive and UNC sibling-prefix paths are denied.
12. `SEC02-P12` duplicate/ambiguous configured aliases are rejected before authority publication.
13. `SEC02-P13` a real root-internal file symlink to an external file is denied without secret bytes.
14. `SEC02-P14` a real root-internal junction to an external directory is denied without enumeration/content.
15. `SEC02-P15` replacement of the configured root identity retires the old authority.
16. `SEC02-P16` a nested new file under a valid nearest existing parent succeeds one segment at a time.
17. `SEC02-P17` a new target whose parent is a real junction is denied with no final external artifact.
18. `SEC02-P18` symlink, junction, and multi-hardlink existing-write destinations are independently denied.
19. `SEC02-P19` deterministic existing-read swaps never return replacement bytes or invoke parsers/providers.
20. `SEC02-P20` deterministic new-parent swaps deny before create or verify controlled no-final-residue rollback.
21. `SEC02-P21` HTTP range reads the validated handle after pathname replacement.
22. `SEC02-P22` list/read/search/grep independently deny relative and absolute root escape.
23. `SEC02-P23` download/DOCX/XLSX independently deny escape before fetch/create and enforce extensions.
24. `SEC02-P24` image analysis denies escape before parser/provider/network invocation.
25. `SEC02-P25` read-repo/Git entries and Oracle project/managed-store paths are independently governed.
26. `SEC02-P26` Persona/Skill identifier, linked-file, and identity mismatches are independently denied.
27. `SEC02-P27` Playbook traversal/link/overwrite/schema/execution variants are independently denied.
28. `SEC02-P28` Shell/Script/tool-Terminal/HTTP-Terminal CWD and controlled spawn swaps are independently denied.
29. `SEC02-P29` watcher target/publish/event/revocation variants are independently governed.
30. `SEC02-P30` every File Viewer route and reveal/range race uses one authority snapshot.
31. `SEC02-P31` Settings API, disk config, environment/bootstrap, and transactional failure paths are governed.
32. `SEC02-P32` a capability-authorized absolute target under the exact selected root succeeds.
33. `SEC02-P33` child attenuation and same-string/different-identity substitution use exact root identity.
34. `SEC02-P34` every denied leaf has one redacted audit attempt; audit-sink failure is fail-closed and non-recursive.
35. `SEC02-P35` every fixed positive receipt appears exactly once, passed, and non-skipped.
36. `SEC02-P36` authored-source inventory/runtime canaries/package inspection show no raw governed sink bypass.

### 15.1 Frozen vector families

The matrix expands these sets to one receipt per leaf; a loop that emits only one aggregate result is invalid. Each observation embeds or references an exact immutable `stimulus` object, `outcomeClass`, `evidenceTier`, and leaf-specific `expected` object. Runtime receipts bind `matrixDigest`, fresh `runId`, observation ID, canonical stimulus digest, actual counters/state, and test-case identity. A receipt label or producer summary without the bound stimulus and actual fields is invalid.

- P01 inputs: `../x`, `..\\x`, `a/..\\x`, `a\\../x`.
- P02: a DOS absolute path on a drive letter different from every authorized DOS root.
- P03: `C:secret`, `F:..\\x`.
- P04: unapproved `\\\\server\\share\\x`, incomplete server, incomplete share, and UNC sibling share.
- P05 pure-policy leaves: exact server/share child accepted; server change denied; share change denied; bound root identity change denied. Real SMB is supplemental only.
- P06 prefixes: `\\\\?\\`, `\\\\.\\`, `\\??\\`, `GLOBALROOT`, `//?/`, `//./`, plus mixed slash and mixed-case variants for each family.
- P07: `name:stream`, `name::$DATA`, `name.txt:stream.jpg`, and extra-colon drive/relative forms.
- P08: final-dot, final-space, intermediate-dot, intermediate-space.
- P09 is the Cartesian product of bases `{CON,PRN,AUX,NUL,CLOCK$,CONIN$,CONOUT$,COM1..COM9,LPT1..LPT9,COM¹,COM²,COM³,LPT¹,LPT²,LPT³}`, case `{upper,lower}`, and forms `{bare,.txt,trailing-dot,trailing-space}`.
- P10: mixed-case relative and capability-authorized absolute forms, both matching real object identity on a case-insensitive fixture.
- P11: DOS sibling prefix and UNC share sibling prefix.
- P12: case alias, slash alias, trailing-separator alias, canonical 8.3 alias when the volume exposes one, and same identity under two IDs. An unavailable 8.3 alias is recorded `not-exposed` and does not count as passed evidence; all other leaves remain required.
- P13/P14/P17/P18 use real Windows filesystem objects. P18 has distinct symlink, junction, and hardlink leaves.
- P15 leaves `{root-object-replacement,lease-issued-before-retire-open-denied,opened-handle-retire-drain-only,session-delete-closes-leases}`.
- P19 barriers: after canonical validation before open; after safe handle open followed by pathname replacement. Both require mismatched-handle closure or original-handle-only completion.
- P20 pre-create barriers `{before-directory-segment,before-final-create}` require zero final artifact. `post-create-identity-rollback` instead requires identity-change detection, zero further writes, handle closure, and outcome `{verified-cleanup | PATH_ROLLBACK_FAILED}`; it never self-reports pass when hard rollback failure occurs. Fault-gate self-test proves a runner cannot misclassify that hard outcome as ordinary success.
- P22 callers `{list_directory,read_file,search_files,grep}` × escapes `{relative,absolute}`.
- P23 leaves `{download-escape-no-fetch,docx-escape,xlsx-escape,docx-extension,xlsx-extension}`; Office denials independently require `generatorCalls=0`, not only no path-writer call.
- P24 independently records filesystem/parser/provider/network counters.
- P25 leaves `{repo-cwd-escape,git-newline-name,git-linked-entry,oracle-project-escape,oracle-managed-store-denial}` with leaf-specific process/external-read/write expectations.
- P26 leaves `{persona-traversal,persona-device,persona-link,persona-name-mismatch,skill-traversal,skill-device,skill-link}`; linked leaves require zero external bytes.
- P27 leaves `{traversal,linked-json,exclusive-overwrite,schema-invalid,llm-execution-zero}` with zero external bytes, LLM calls, executor calls, and writes where applicable.
- P28 surfaces `{shell,script,tool-terminal,http-terminal}` × `{external-cwd,reparse-cwd,before-spawn-swap}`, plus `new-authority-old-terminal-control-denied`.
- P29 leaves `{external-target,before-publish-swap,event-traversal,event-reparse,revoke-close,session-delete-close}` with leaf-specific watcher create/callback/external-access/audit expectations.
- P30 leaves `{roots-snapshot,list,preview,resolve,content,range-handle,reveal-escape,reveal-swap,opened-range-retire-drain-only}` with leaf-specific immutable-snapshot, settings-reread, handle-origin, and process expectations.
- P31 sources `{settings-api,disk-load,process-environment}` × unsafe families `{namespace,ads,trailing-alias,rooted-current-drive,relative,duplicate-root}`, plus `{config-parent-link,persist-failure,publication-failure-rollback,concurrent-stale-base}`. Transaction leaves require old tokens permanently stale, no stale candidate publication, and disk/runtime consistency through a fresh-old-config authority/new epoch or stopped state.
- P33 separates positive `child-subset` from denial leaves `{same-string-new-identity,root-replacement,broader-parent-fallback-denied}`.
- P34 independently joins every `outcomeClass=denial` raw receipt, plus one runtime `audit-sink-throw` leaf. Producer aggregate booleans are not evidence.
- P36 leaves `{sink-inventory-complete,legacy-helper-absent,runtime-adapter-canaries,third-party-path-api-absent,worker-path-absent,electron-route-bound,packaged-asar-bound}`.

Directory-entry grammar, Git NUL parsing, watcher event names, authority-scoped search cache revocation, process/reveal watcher barriers, bootstrap overrides, and all file-viewer routes are therefore mandatory, not implied by a broad title.

The matrix has one top-level `requiredObservationContract` requiring exact IDs and `duplicates=missing=extra=skipped=todo=failed=mockSubstitutions=tierDowngrades=0`. The default environment policy for `windows-native` and `production-barrier` is `required-capability`: inability to create the real fixture fails the environment gate and cannot skip, mock, or downgrade evidence. The sole conditional probe is P12 8.3 exposure: its receipt is mandatory and non-skipped; `not-exposed` contributes neutrally and is never recorded as `passed=true`.

## 16. Fixed positive receipts

The following IDs must each appear exactly once, `passed=true`, `skipped=false`, `todo=false`:

- `SEC02-POS-read-relative`, `SEC02-POS-read-absolute`;
- `SEC02-POS-list`, `SEC02-POS-search`, `SEC02-POS-grep`;
- `SEC02-POS-create-nearest-parent`, `SEC02-POS-edit-same-handle`;
- `SEC02-POS-docx`, `SEC02-POS-xlsx`, `SEC02-POS-download`;
- `SEC02-POS-image-buffer`;
- `SEC02-POS-persona`, `SEC02-POS-skill`, `SEC02-POS-playbook-read`, `SEC02-POS-playbook-create`;
- `SEC02-POS-oracle`;
- `SEC02-POS-shell-cwd`, `SEC02-POS-script-cwd`, `SEC02-POS-tool-terminal-cwd`, `SEC02-POS-http-terminal-cwd`;
- `SEC02-POS-watcher-create-close`;
- `SEC02-POS-viewer-range-lease`.

Electron smoke executes real API root-internal success, traversal/junction denial, File Viewer range-handle replacement, and Terminal CWD denial before process creation. Installed smoke executes the fixed packaged PathPolicy assertion set on **both** launches; the second launch may not test only identity/session persistence.

Packaged details contain a schema-fixed `pathPolicy` object with launch-indexed fixed assertion IDs, exact counts, pass booleans, and no paths. Same-byte repeat means repeated launch/install smoke within the governed packaged contract, never a hidden retry of a failed step.

## 17. Resolved cumulative governance

At architecture freeze, `parity/schema/sec-02-governance-contract.json` binds the exact current SEC-01 and GOV-03 predecessor manifest hashes, the future SEC-02 manifest path, pipeline inputs, GOV-04 state machine, and mandatory fault cases. `tests/manifests/sec-02.json` is allowed to be absent only during architecture freeze; it is mandatory before any Developer candidate or governed test claim.

`tests/manifests/sec-01.json`, `tests/manifests/sec-02.json`, and `tests/manifests/gov-03.json` are all independent authoritative inputs to a generated/validated resolved cumulative manifest. For every layer it contains ordered test-file records with exact-case relative path and SHA-256, and proves:

```text
SEC-01 test records ⊆ SEC-02 test records ⊆ GOV-03 test records
```

It additionally binds:

- all three source manifest SHA-256 values and cumulative manifest digest;
- inclusion over tuples `(exactCasePath, sha256)`, never path strings alone;
- architecture freeze report and attack-matrix SHA-256;
- every attack leaf ID/evidence tier/stimulus digest/test-case ID;
- every positive receipt ID;
- union of changed runtime files, exact coverage-scope files, and complete coverage-exemption records including reason/evidence layer;
- per-file floors, overall line threshold, security branch threshold, and no missing/unexpected/zero-hit files;
- runners, helpers, schemas, sink inventory, packaged `pathPolicy` schema, and self-test fault contract;
- exact-case component validation, no duplicate/case-alias test paths, and no linked test/evidence files.

A listed file without its expected receipts/coverage obligations is not cumulative closure. Any skipped/todo required test fails the layer.

`dist/path-policy.js` and its platform/lease/audit modules are security-critical coverage with permanent line floors of at least 90%. Overall line threshold remains 80%, security aggregate branch threshold remains 90%, and no existing floor may decrease. Contract/integration/native tests—not unit tests alone—must drive critical branches.

GOV-04 retains the frozen Amendment-01 16-step state machine. `gov03-quick`, self-test, packaged smoke, and report validator consume the resolved cumulative manifest. `pipelineDefinitionDigest` explicitly includes all tests/manifests/coverage scopes/runners/helpers/schemas/inventories and packaged assertion definitions; `parity/GOV-04-CI-ARCHITECTURE.md`; `parity/GOV-04-ARCHITECT-AMENDMENT-01.md`; merge/release workflows; GOV-04 orchestrator, policies, scanner/toolchain pins, report/final-marker/publication validators; `tests/manifests/gov-04.json`; and install/package/staging command definitions. The validator rechecks step-at-most-once, first-failure blocking, finalize-exactly-once, three clean installs, package-once, and both workspaces using one candidate identity—not only the 16-name array.

Self-test must independently reject at least: missing/duplicate/stale/false attack receipt; changed stimulus or matrix digest; skipped required vector; mock/tier downgrade; missing positive receipt; forged counter; raw sink inventory bypass; ordinary-success classification of rollback failure; false audit commit/recursive retry after sink failure; stale lease/cache/authority content; reactivated retired token; stale concurrent enrollment publication; missing/replaced/shrunk predecessor manifest or forged predecessor digest; missing changed-runtime file; weakened coverage floor; missing second-launch packaged assertion; and altered matrix/architecture/GOV-04 definition digest.

This architecture, its freeze report, and the attack matrix are Build inputs and are copied by every GOV-02 isolation fixture closure.

## 18. Acceptance and independent handoff

Developer completion requires:

- exact attack matrix and all leaf receipts;
- all fixed positive receipts;
- real Windows symlink, junction, hardlink, root-replacement, handle-replacement, watcher, and production-barrier tests;
- typecheck and zero-warning lint;
- SEC-02 quick/full and resolved cumulative GOV-03 quick/self-test;
- unchanged thresholds and no missing/unexpected/zero-hit governed file;
- same-byte installer repeated packaged smoke with both launches asserting PathPolicy;
- a byte-identical clean non-shallow Git fixture passing all 16 GOV-04 merge steps;
- explicit residual-risk disclosure and `releaseEligible=false` for unsigned merge artifacts.

Debugger recreates the real Windows attacks, verifies evidence tiers and external sentinels, scans authored sinks independently, and revalidates source/package identity. Reviewer checks canonical scope, frozen architecture/matrix, resolved cumulative manifest, reports, and a fresh clean-fixture GOV-04 run before requesting user confirmation.

## 19. Red-team resolution record

Revision 3 resolves the pre-freeze challenges by:

- separating stable identity from mutable metadata;
- choosing Node-only semantics and removing impossible all-reparse/zero-transient-contact claims;
- defining the same-principal final-resolution residual boundary owned by SEC-03;
- binding all long-lived resources and operation leases to authority epoch/root identity;
- separating root enrollment/bootstrap/managed authorities from model roots;
- making most-specific lexical and canonical root selection mandatory;
- making Settings update transactional;
- defining two-phase output reservation before fetch/generation commit;
- replacing “exactly one emitted audit event” with one non-recursive delivery attempt and HMAC fingerprint;
- expanding compound scenarios into mandatory leaf vectors and fixed positive receipts;
- separating pure-policy, real-Windows, production-barrier, and static evidence;
- replacing regex-only boundary checks with an exhaustive sink inventory plus runtime/package assertions;
- resolving cumulative governance beyond file-set inclusion;
- separating pre-create no-residue proof from post-create verified-cleanup-or-hard-failure semantics;
- serializing enrollment with base-epoch/settings-digest CAS and forbidding authority resurrection;
- adding runtime/contract-validation evidence tiers and exact no-skip/no-mock/no-downgrade rules;
- replacing heterogeneous shared expectations with leaf-specific results and stimulus-bound receipts;
- adding issued-lease retirement, handle-drain, Session deletion, old-Terminal control, and concurrent enrollment races;
- binding all predecessor manifests and the full GOV-04 Amendment-01 state machine into candidate identity.

Revision 3 is the frozen implementation contract. Any change to this document, the matrix, schema, validator, or governance contract invalidates the architect freeze report and requires a new Architect/Sentinel review before implementation continues.