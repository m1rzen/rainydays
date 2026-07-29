# GOV-01 Lux Desktop Baseline Design

## Status

- Target: Lux Desktop `0.1.898`
- Owner chain: explorer → architect → developer → reviewer
- Canonical execution spec: `../LUX-DESKTOP-100-PARITY-EXECUTION-SPEC.md`
- This document freezes the GOV-01 extraction and comparison design.

## Goals

1. Capture a reproducible, machine-readable Lux Desktop baseline.
2. Separate exact runtime tool schemas from documentation-derived behavior.
3. Detect removed, added, and changed contract fields with JSON Pointer paths.
4. Preserve source provenance and SHA-256 hashes.
5. Never load or read the user's real Lux configuration or credentials.

## Non-goals

- Implement Mini-Lux parity features.
- Infer undocumented behavior from names.
- Treat Help prose as an exact JSON Schema.
- Capture dynamic enterprise MCP tools as Lux built-ins.
- Read `~/.lux/config.json`, `auth.json`, databases, sessions, or user content.

## Directory Layout

```text
parity/
  BASELINE-DESIGN.md
  README.md
  schema/
    lux-desktop-baseline.schema.json
  probes/
    tool-catalog-mod.mjs
  scripts/
    capture-lux-baseline.mjs
    compare-lux-baselines.mjs
    test-baseline-diff.mjs
  baselines/
    lux-desktop-0.1.898.json
  reports/
    gov-01-verification.json
  .probe/run-*/              # unique temporary run directories; each run deletes only its own directory
```

## Trust Model

### Exact sources

- `baseline.json`: product/runtime version metadata.
- Runtime Mod API `lux.version`.
- Runtime Mod API `lux.tools.list()` and `lux.tools.get(name).definition` for the base Registry.
- Server WebSocket `tool_definitions_updated` membership event for a newly created isolated default Session.
- The `tools` payload of one request sent to a loopback-only OpenAI-compatible sink, which captures the complete model-facing default Session Schema without external network access.
- Installed `skills/*.md` files and `personas/*.json` files.
- File bytes and SHA-256 for all declared sources.

### Documentation sources

- `help/manifest.json` and referenced Help Markdown.
- Documentation-derived catalogs are labeled `sourceKind: documentation`.
- They define documented behavior and discoverability, not exact runtime schemas.

### Derived sources

- Parsed Markdown tables, headings, backtick tool names, Settings tabs, shortcuts,
  slash commands, Persona rows, and Skill rows.
- Every derived item records its source file and line number where practical.

## Isolated Runtime Probe

The capture script must:

1. Create a unique `parity/.probe/run-*/lux-home` from scratch so concurrent/stale runs cannot collide.
2. Create only the probe Mod under that run's `lux-home/mods/parity-tool-catalog/`.
3. Set `LUX_HOME` to that isolated directory.
4. Set `LUX_PARITY_PROBE_OUTPUT` to an isolated output path.
5. Start the installed `lux-server.mjs` on `127.0.0.1`, port `0`, `--no-open`.
6. Let the Mod poll the registry until tool count and serialized definitions are stable.
7. Allow the genuine first-run bootstrap to complete, then immediately stop the isolated Overseer through the official WebSocket `daemon_stop` command so the probe cannot leave background sessions or locked databases.
8. Start a loopback-only OpenAI-compatible sink with an ephemeral random dummy key; accept only authenticated `POST /v1/chat/completions` and never forward traffic.
9. Create one default Session over the local WebSocket protocol and read `tool_definitions_updated`; require exact name/count equality with the Mod API base definitions.
10. Start exactly one controlled Agent flow (`Return OK.`), capture the real model request's `tools` payload, and return a local fixed `OK` stream.
11. Require every base Registry definition to be byte-equivalent after canonicalization to its model-facing definition.
12. Export only:
   - `lux.version`
   - complete sorted model-facing tool definitions
   - base Registry names/count
   - default Session Persona and tool membership metadata
13. Destroy the probe Session, close the sink, and stop the server process tree.
14. Delete only the current `run-*` directory after the output has been incorporated; never delete another active probe run.

The probe must not:

- copy the real user config;
- read API keys;
- invoke tools;
- start any Agent flow except the single loopback-only contract request described above;
- connect MCP servers or any external model/network endpoint;
- modify the registry;
- wrap or replace tools.

## Canonical Manifest

Top-level shape:

```json
{
  "$schema": "../schema/lux-desktop-baseline.schema.json",
  "schemaVersion": 1,
  "target": {
    "product": "Lux Desktop",
    "version": "0.1.898"
  },
  "runtime": {
    "nodeVersion": "25.0.0",
    "electronVersion": "35.7.5",
    "prebuildsHash": "...",
    "shellHash": "...",
    "probeVersion": "0.1.898"
  },
  "sources": [],
  "contracts": {
    "tools": [],
    "toolCatalog": {
      "scope": "isolated-default-session-model-request",
      "definitionSource": "local-openai-compatible-provider-request",
      "baseRegistryDefinitionSource": "runtime-mod-api",
      "baseMembershipSource": "server-websocket-tool_definitions_updated"
    },
    "toolDocumentation": {},
    "personas": {},
    "skills": [],
    "settings": {},
    "sessions": {},
    "shortcuts": [],
    "slashCommands": [],
    "platforms": {},
    "help": {}
  },
  "capture": {
    "capturedAt": "ISO timestamp",
    "hostPlatform": "win32",
    "hostArch": "x64"
  }
}
```

`capture` is informational and ignored by the comparator. Absolute source paths are not
stored in canonical source records; paths are relative to the Lux installation root.

## Tool Contract Normalization

For every runtime tool:

```json
{
  "name": "read",
  "description": "...",
  "parameters": {
    "type": "object",
    "properties": {},
    "required": []
  },
  "sourceKind": "runtime-model-request"
}
```

Rules:

- Sort tools by name.
- Recursively sort object keys.
- Preserve array order because required/enums may be semantically ordered by source.
- Preserve descriptions and defaults.
- Reject duplicate tool names.
- Reject functions, symbols, circular objects, and non-finite numbers in definitions.
- Fail capture when runtime tool count is zero.
- Do not merge documentation descriptions into runtime definitions.

The exact catalog scope is the isolated built-in `default` Session's real model request. In v0.1.898, the Mod API and Session membership event expose 72 base tools, while the model request contains 86 tools after Infrastructure tools are added. Lux Help's “100+ tools” additionally includes configured MCP/Prism tools, platform and desktop bridges, Android tools, worker-attach transfer tools, and host-injected tools. Those conditional extension surfaces remain documented and source-hashed, but are not falsely merged into the default 86-tool model contract.

## Help Normalization

For each Help file:

- SHA-256 of raw bytes.
- Ordered heading list with level and line.
- Markdown table rows with heading context and line.
- Backtick identifiers extracted from relevant tables.

Special catalogs:

- `tools.md`: documented tool expressions and groups. Slash shorthand such as `task_create/update/list` is expanded only from the table's Tool column; identifiers in descriptions are not classified as tools.
- `personas-skills.md`: built-in Persona and Skill rows, permission levels.
- `config.md`: Settings tabs, provider types, key configuration fields, paths.
- `sessions.md`: per-session state, persistence, fork/rollback/regenerate, tabs/files.
- `keyboard-shortcuts.md`: key → action rows.
- `slash-commands.md`: command → parameters → action rows.
- `platforms.md`: platform and automation capability rows.

Raw source hashes ensure prose changes are still detected when a parser does not yet
normalize a specific sentence.

## Source Inventory

Required source groups:

- `baseline.json`
- `help/manifest.json`
- every Help file referenced by the manifest
- `skills/*.md`
- `personas/*.json`
- `prompts/org-mode/*.md`
- selected executable modules:
  - `lux-core.mjs`
  - `lux-server.mjs`
  - `lux-bash.mjs`
  - `lux-playbook-runner.mjs`
  - `lux-worker.mjs`
  - `lux-wire.mjs`
  - `lux-win-platform.mjs`
- Chrome Extension manifest and bridge scripts

Missing required files fail capture. Optional platform-specific files are recorded when
present and listed as absent when not installed for the current platform.

## Comparison Semantics

The comparator removes only:

- `/capture/capturedAt`
- `/capture/hostPlatform`
- `/capture/hostArch`

Everything else is contract material.

Output:

```json
{
  "equal": false,
  "summary": { "added": 1, "removed": 1, "changed": 1 },
  "differences": [
    { "kind": "removed", "path": "/contracts/tools/by-name/read" },
    { "kind": "changed", "path": "/contracts/tools/by-name/write/parameters/required" }
  ]
}
```

Arrays with stable identities (`tools`, `skills`, personas) are compared by identity,
not only numeric index, so reports remain readable after insertions.

Exit codes:

- `0`: equal
- `1`: contract drift
- `2`: invalid input, schema failure, or capture error

## Required Negative Tests

1. Remove one runtime tool → `removed` at the tool identity path.
2. Add a required parameter → `changed` at `/parameters/required`.
3. Change a documented/default value → `changed` at exact field path.
4. Add a new tool → `added`.
5. Duplicate tool name → validator failure, exit `2`.
6. Change only `capture.capturedAt` → still equal.
7. Corrupt Help manifest or omit a referenced file → capture failure.
8. Runtime probe returns zero tools → capture failure.

## Completion Evidence

GOV-01 may reach `verified` only when the repository contains:

- schema;
- probe;
- capture script;
- comparator;
- generated v0.1.898 baseline;
- source hashes;
- positive recapture comparison;
- all negative test results;
- exact commands, timings, error counts, and Reviewer verdict.
