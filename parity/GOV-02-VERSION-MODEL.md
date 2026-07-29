# GOV-02 Version and Traceability Model

## Status

- Target: Mini-Lux after GOV-01
- Owner chain: architect → developer → reviewer → user confirmation
- Canonical execution spec: `../LUX-DESKTOP-100-PARITY-EXECUTION-SPEC.md`
- This document freezes the GOV-02 version model before implementation.

## Problem statement

The current application mixes unrelated identifiers:

- `package.json` declares app version `0.1.0`;
- the desktop UI displays a hard-coded `v1.0`;
- Session Export writes a hard-coded `version: "1.0"`;
- SQLite has no `user_version` or migration ledger;
- `/api/status`, startup logs and Electron metadata do not expose one build identity;
- Link has behavior but no protocol version; MCP and remote Worker are not implemented;
- there is no downloadable diagnostic artifact carrying version evidence.

Changing all labels to one number would be incorrect. Each compatibility boundary needs its own authority.

## Authorities

| Boundary | Authority | Type | Current value |
|---|---|---:|---:|
| Application release | root `package.json.version` | SemVer string | `0.1.0` |
| Build identity | generated root `build-info.json` | opaque string | generated |
| SQLite schema | `PRAGMA user_version` | integer | `1` |
| Session Export | `format` + `formatVersion` | string + integer | `mini-lux-session` / `1` |
| Link envelope | version contract | integer or null | `1` |
| Worker envelope | version contract | integer or null | `null` until implemented |
| MCP integration envelope | version contract | integer or null | `null` until implemented |
| Lux parity baseline schema | locked manifest | integer | `1` |
| Lux parity target | locked manifest | SemVer string | `0.1.898` |

Rules:

1. No component may hard-code the app version independently.
2. Database, export and protocol versions must never reuse the app version.
3. A `null` protocol version means unsupported/unimplemented; it is not version zero.
4. The runtime must fail closed when a persisted format is newer than supported.
5. Build metadata must not contain credentials, absolute user paths or mutable runtime state.

## Generated build metadata

A pre-build script generates `build-info.json` before TypeScript compilation and asset copying.

Canonical shape:

```json
{
  "schemaVersion": 1,
  "product": "Mini-Lux",
  "appVersion": "0.1.0",
  "buildId": "0.1.0+local.<first12(sourceDigest)>",
  "buildIdSource": "derived",
  "sourceDigest": "<sha256>",
  "distIntegritySha256": "<sha256 of dist-integrity.json>",
  "builtAt": "<ISO timestamp>",
  "versions": {
    "databaseSchema": 1,
    "sessionExport": 1,
    "protocols": {
      "link": { "version": 1, "enabled": true, "transport": "in-process" },
      "worker": { "version": null, "enabled": false, "transport": null },
      "mcp": { "version": null, "enabled": false, "transport": null }
    },
    "luxBaseline": {
      "schemaVersion": 1,
      "targetVersion": "0.1.898",
      "manifestSha256": "1126d7449fca392e64721d5e7e86169158bc8c72ea72f9d414fa0fe93ab445df"
    }
  }
}
```

Generation rules:

- `appVersion` comes only from root `package.json`.
- Default local `buildId` is deterministic for the relevant source tree:
  `<appVersion>+local.<first 12 chars of sourceDigest>`.
- `buildIdSource` is `derived` for local source-derived IDs and `ci` only when trusted CI/release supplies `MINI_LUX_BUILD_ID`.
- For `derived` builds, runtime and staging must verify `buildId === <appVersion>+local.<first 12 chars of sourceDigest>`.
- CI/release may provide `MINI_LUX_BUILD_ID`; it must match a conservative safe-character pattern and is recorded verbatim.
- `sourceDigest` hashes length-framed relative paths plus bytes from explicit application inputs: all files under `src`, `electron`, `public`, `personas`, `skills`, and `scripts`, plus `package.json`, `package-lock.json`, `tsconfig.json`, and the locked GOV-01 baseline manifest.
- Generated output, user data, models, `.probe`, `dist`, `.electron-app`, reports, and `release` are excluded.
- `builtAt` is informational and may differ between rebuilds; compatibility never depends on it.
- The generator validates the locked GOV-01 baseline hash before publishing metadata.
- Metadata generation initially sets `distIntegritySha256` to `null`; after a successful compile, `dist-integrity.json` records the exact `dist` file set, byte lengths, and SHA-256 values, and the build finalizer stores that manifest hash in `build-info.json`.
- Electron staging requires a non-null manifest hash, recompiles TypeScript to an isolated directory, requires byte-identical output, and verifies the complete `dist` file set against the manifest before copying.
- The finalized `build-info.json` and `dist-integrity.json` are included unchanged in Electron staging and packaged resources.

## Runtime version module

A single runtime module reads and validates `build-info.json` and exports immutable version information.

Required behavior:

- development and packaged runtime use the same file shape;
- missing, malformed, semantically unsupported, or package-version-mismatched metadata aborts startup;
- metadata is recursively immutable after validation;
- development may generate metadata through the build command, not silently invent values at runtime;
- `/api/version` returns the complete public version object;
- `/api/status` embeds the same object without reconstruction;
- startup logs print one machine-readable version line;
- the UI reads `/api/status` and displays `v<appVersion>` plus a shortened Build ID; full Build ID is available in title/accessible text;
- Electron preload exposes the same `appVersion` and `buildId` for cross-checking, sourced from packaged metadata rather than a hard-coded constant;
- the installer artifact filename contains app version and a collision-free filesystem encoding of Build ID (`+` becomes `~2B` under the allowed alphabet).

## SQLite schema version and migration

Current unversioned databases are treated as schema version `0`.

Startup algorithm:

1. Before creating any writable SQLite connection, probe an existing database without modifying it: read `user_version` from the main-file header when no sidecars exist; when WAL/SHM/journal sidecars exist, copy the main file plus all present sidecars to a temporary directory and query the copy.
2. If the probed value is greater than supported version `1`, delete only the temporary probe and abort with an explicit incompatibility error; the original main file and sidecars remain byte-identical.
3. Only after the compatibility probe succeeds, open the real database and enable foreign keys.
4. Re-read `PRAGMA user_version`; if it changed to a future version between probe and open, abort.
5. Run each missing migration in order inside one transaction.
6. Validate the complete Schema 1 signature, then set `PRAGMA user_version = 1` only inside the successful transaction.
7. Re-read and assert the final version and Schema signature.
8. Enable persistent WAL only after migration and validation succeed.
9. Only then expose CRUD operations or start the HTTP server.

Migration `0 → 1`:

- create all currently supported tables and indexes using `IF NOT EXISTS`, including the `memos` table used by memo tools;
- persistent feature modules must not create or mutate schema at import time; all application tables belong to the versioned migration and complete Schema signature;
- add `memories.embedding` only when the table exists and the column is absent;
- preserve all existing rows;
- validate the complete Schema 1 signature before setting or accepting version 1: column order/type/NOT NULL/default/PK, AUTOINCREMENT, named indexes, unique constraints, foreign keys/actions, and `foreign_key_check`;
- do not infer schema success solely from column names or one column probe.

Failure rules:

- migration failure rolls back schema and version changes;
- a future database version is rejected without mutation;
- error text includes found and supported versions, but no sensitive data.

## Session Export format

New export envelope:

```json
{
  "format": "mini-lux-session",
  "formatVersion": 1,
  "producer": {
    "appVersion": "0.1.0",
    "buildId": "..."
  },
  "exportedAt": "...",
  "session": {},
  "messages": []
}
```

Compatibility matrix:

| Input | Result |
|---|---|
| new `format=mini-lux-session`, `formatVersion=1` | validate and import |
| legacy `version="1.0"` with valid shape | normalize to format version 1 and import |
| missing version/format marker | reject before database write |
| unknown format | reject before database write |
| `formatVersion < 1` | reject unless an explicit migration exists |
| `formatVersion > 1` | reject as newer/incompatible |
| malformed session or message | reject before database write |

Import rules:

- normalize and validate the entire envelope before creating a session;
- reject conflicting legacy/current markers and imported `system` messages;
- validate the complete session/message envelope and structured `ToolCall[]`, including JSON object arguments;
- cap message count and relevant string sizes at the API boundary;
- import session plus messages in one database transaction;
- use a new local session ID regardless of exported ID;
- do not trust exported timestamps, roles or serialized tool fields without validation;
- return a structured error containing format and supported versions.

## Protocol version registry

The application publishes protocol capabilities rather than pretending every planned surface exists:

```json
{
  "link": { "version": 1, "enabled": true, "transport": "in-process" },
  "worker": { "version": null, "enabled": false, "transport": null },
  "mcp": { "version": null, "enabled": false, "transport": null }
}
```

- Link messages gain an internal envelope version and reject unsupported versions, malformed envelopes, unregistered sources, and unknown targets before delivery.
- Persisted and newly created sessions are registered through the authoritative Session lifecycle; transaction failure compensates any in-memory registration.
- Worker and MCP stay explicitly disabled until their implementation tasks define real envelopes.
- Future implementations must update the registry and add compatibility tests; they may not silently reuse Link version.

## Diagnostic artifact

Add an authenticated download endpoint that returns a sanitized JSON diagnostic artifact.

It contains:

- full public build/version object;
- runtime Node/Electron versions when applicable;
- platform and architecture;
- configured/not-configured flags, never secrets;
- database schema version;
- current protocol capability registry;
- active profile/persona names;
- timestamp.

It excludes:

- API keys and auth tokens;
- prompts, messages, memories and user file content;
- absolute config, database or workspace paths.

Filename: `mini-lux-diagnostics-<safeBuildId>.json`.

## Installer traceability

- Electron staging copies the generated `build-info.json` unchanged.
- Staged `package.json.version` must equal `build-info.appVersion`.
- The installer artifact name includes both values.
- Packaged startup verifies Electron `app.getVersion()` equals metadata `appVersion`; mismatch aborts startup.
- Packaged API, UI, log and diagnostic artifact must all expose the same Build ID byte-for-byte.

## Required tests

### Positive

1. Two local metadata generations over unchanged inputs produce the same `buildId` and `sourceDigest`.
2. Development API/UI/log use the generated values.
3. Fresh database migrates `0 → 1`.
4. Existing unversioned database with rows migrates without data loss.
5. New Session Export round-trips.
6. Legacy `version: "1.0"` export migrates and imports.
7. Packaged metadata matches installer, API, UI, log and diagnostic artifact.

### Negative and recovery

1. Tampered GOV-01 baseline hash blocks metadata generation.
2. Invalid externally supplied Build ID is rejected.
3. Missing/malformed, semantically unsupported, package-mismatched, or forged-derived `build-info.json` blocks startup.
4. Changing `tsconfig.json` changes `sourceDigest` and derived Build ID.
5. Database `user_version=2` is rejected with byte-identical database SHA-256.
6. Forced migration failure rolls back and leaves the prior `user_version`; a constraint-impostor Schema is rejected.
7. Unknown/newer or conflicting Session Export version is rejected with zero rows written.
8. Malformed messages, imported system summaries, and invalid ToolCall structures write zero rows.
9. Forced message insert failure rolls back both database rows and Link registration.
10. Unsupported/malformed/spoofed Link envelopes are not delivered.
11. Worker/MCP report disabled and cannot be mistaken for version zero.
12. Diagnostic artifact contains no token, API key or absolute user path and reports the Electron shell in development and packaged modes.
13. Windows executable metadata, installer name, API, UI, preload, log and diagnostics agree on application version/build identity.

## Persona and completion gate

- Architect freezes this document and compatibility matrix.
- Developer implements only this contract.
- Debugging/verification must exercise failure, rollback, restart and packaged paths.
- Reviewer independently compares all surfaces and inspects the packaged artifact.
- GOV-02 remains `verified-awaiting-user-confirmation` until the user accepts it.
