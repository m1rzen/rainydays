# GOV-03 Test Framework and Contract Architecture

## Status and authority

- Task: GOV-03
- Baseline: Lux Desktop v0.1.898, manifest schema 1
- Persona chain: planner → architect → developer → debugger → reviewer
- Canonical source: `../LUX-DESKTOP-100-PARITY-EXECUTION-SPEC.md`
- Planning evidence: `reports/gov-03-discovery.json`, `reports/gov-03-plan.json`
- State: frozen by Architect on 2026-07-16; implementation changes require explicit Architect re-review.
- This document is the implementation contract; Developer must not weaken its failure semantics.

## Goals

GOV-03 establishes a real five-layer test system:

1. Unit
2. Contract
3. Integration
4. Electron E2E
5. Packaged E2E

It also provides isolated fixtures, coverage enforcement, fault-gate self-tests, and one machine-readable report. It does not implement the GOV-04 CI workflow, linting, SCA, secret scanning, signing, or artifact upload.

## Current-state findings

| Layer | Existing evidence | Gap |
|---|---|---|
| Unit | None | No `node:test` suite or standard discovery |
| Contract | GOV-01 synthetic and locked fault-injection scripts | Custom entrypoints, no shared layer/report contract |
| Integration | GOV-02 version script exercises DB/API/Session/Link | Mixed layers and rewrites root build metadata |
| Electron E2E | Metadata-rejection subprocesses | No automated successful main/preload/UI workflow |
| Packaged E2E | Manual installer evidence | No repeatable installed-EXE smoke command |
| Coverage | None | No honest all-file accounting or thresholds |
| Unified gate | None | No `npm test`, layer summary, or fault propagation test |

Generated `.electron-app` files and historical installers are not test sources.

## Technology choice

Use Node's built-in `node:test` runner and `node:assert/strict`.

Add only `c8` as a direct, lockfile-pinned development dependency. Node's native coverage does not count explicitly included but never imported files, so it cannot prove an honest denominator. One `c8 --all` invocation receives one exact `--include` per governed executable file and merges inherited Node child-process coverage into a fresh unique Temp directory. Packaged Electron and renderer execution are not claimed as c8 coverage.

First-party code parses integer counters from `coverage-summary.json`; c8 console percentages and `--check-coverage` are not the gate authority because GOV-03 uses different overall-line and security-branch populations. Missing files, zero denominators, malformed reports, stale raw data, path remap ambiguity, or a child test failure are all failures.

Do not add Jest, Vitest, Playwright, Puppeteer, Spectron, or a browser-driver service. Electron automation uses the existing CDP endpoint and Node's global WebSocket implementation.

## Directory and entrypoint contract

```text
tests/
  coverage-scope.json
  manifests/gov-03.json
  helpers.mjs
  unit/framework.test.mjs
  contract/lux-baseline.test.mjs
  integration/version-model.test.mjs
  electron/desktop-smoke.test.mjs
  packaged/installed-smoke.test.mjs
  fixtures/failing/assertion.test.mjs
scripts/
  run-test-layer.mjs
  run-tests.mjs
  run-coverage.mjs
  test-gate-selftest.mjs
```

Existing GOV-01/GOV-02 scripts remain authoritative regression engines and are called by layer tests rather than duplicated.

Required npm commands:

| Command | Contract |
|---|---|
| `npm run test:unit` | Unit only |
| `npm run test:contract` | Lux baseline contract only |
| `npm run test:integration` | Real DB/API/filesystem/process integration only |
| `npm run test:electron` | Real Electron main/preload/renderer workflow |
| `npm run test:packaged` | Smoke an already-built exact-current installer |
| `npm run test:package` | Build formal package, then run packaged smoke |
| `npm run test:coverage` | Run governed coverage scope and enforce thresholds |
| `npm run test:self` | Prove assertion, contract, coverage and packaged preflight faults return non-zero |
| `npm run test:quick` | Unit + contract + integration + Electron E2E + coverage |
| `npm test` | Full five layers, coverage, fault-gate self-test, and unified report |

`npm test` may be slow. It is the acceptance command. Fast development uses explicit layer commands or `test:quick`.

## Layer contracts

### Unit

Test pure boundary and framework behavior without opening the real application database or network listeners:

- test-manifest validation and exact layer names;
- safe artifact Build-ID filename encoding;
- timeout/error classification;
- report aggregation and failure precedence;
- coverage-registry validation;
- cleanup helper idempotency.

A Unit test must not spawn Electron or install an application.

### Contract

Wrap the GOV-01 machine-readable baseline:

- run the 13 synthetic contract scenarios;
- run the 10 locked-baseline fault-injection scenarios with the report directed to Temp;
- assert target `0.1.898`, baseline hash, schema version, tool counts, and exit codes 0/1/2;
- never recapture or rewrite the locked baseline.

Future tasks attach contract cases through their task manifest. Contract comparison remains field-level, not name-count-only.

### Integration

Run real first-party boundaries in isolated Temp roots:

- SQLite migration and rollback;
- Session Export current/legacy/rejection paths;
- Link capability and spoof rejection;
- authenticated API/status/diagnostics;
- process startup/shutdown and cleanup.

The GOV-02 regression engine must be made side-effect-free for the project root. All generator, tamper, migration-input, and dist-integrity scenarios that can write application artifacts run against a Temp sandbox. Canonical `dist` modules may execute from the project root only with Temp user data and inputs so coverage paths remain canonical. Root metadata generators may run only in `--check` mode. `build-info.json`, `dist-integrity.json`, `dist`, `.electron-app`, and `release` are snapshotted before the layer and must remain byte-identical.

### Electron E2E

Launch the real Electron `main.cjs`, preload, renderer, and compiled `dist` with isolated userData and a pair of simultaneously reserved, distinct loopback ports.

A narrowly scoped development-only switch is frozen with an explicit dual-ABI boundary:

- absent: non-packaged Electron keeps the normal `tsx src/index.ts` development path;
- exactly `MINI_LUX_E2E_USE_DIST=1`: non-packaged Electron launches canonical `dist/index.js` with the absolute host Node executable supplied as `MINI_LUX_E2E_NODE_EXECUTABLE`; it never invokes `npx`, `tsx` or a shell;
- the host executable must be an existing absolute regular file and the companion variable is forbidden when `USE_DIST` is absent; malformed or partial configuration fails before server spawn;
- this child-process boundary is required because root development dependencies are built for the host Node ABI while packaged native dependencies are rebuilt for Electron's embedded Node ABI;
- packaged behavior remains controlled only by `app.isPackaged`, ignores both development-only variables, and continues to use the in-process compiled server;
- build metadata validation, runtime environment construction, API authentication, CSP and preload isolation remain unchanged;
- source Electron E2E and packaged E2E are complementary evidence; neither may substitute for the other.

Minimum GOV-03 smoke, repeated on both the first launch and the full-process restart:

- wait for CDP and the expected local HTTP origin, and prove the CDP page belongs to that origin;
- verify renderer load and the actual `document.title`/native page title, not an element tooltip;
- derive every expected value from `build-info.json`; no hard-coded app version, local-only Build-ID pattern, or hex-only assumption is allowed;
- compare exact UI short identity, full Build ID, preload identity, complete `/api/status.version`, and complete `/api/version`;
- reject an unauthenticated API request with `401`;
- create one session, reload, and verify persistence;
- restart with the same userData and verify the session remains current;
- wait for the Electron process tree, including the compiled-server child, to exit; both HTTP and CDP listeners must close and the fixture must be removable.

Future task manifests add desktop workflows without changing the runner.

### Packaged E2E

Windows GOV-03 packaged smoke uses the exact installer derived from current `build-info.json` and a package-run artifact manifest:

1. run source metadata `--check`;
2. resolve the collision-free installer filename from Build ID;
3. require an atomic artifact manifest produced immediately after packaging with Build ID, source digest, filename, byte length and SHA-256;
4. fail before installation with a structured code when the installer is missing, its basename differs, its bytes/hash differ, or the manifest does not bind the current Build ID;
5. silently install to a unique Temp target;
6. launch the installed EXE with isolated userData and distinct dynamic HTTP/CDP ports;
7. on both launches, repeat complete identity, UI title, API, diagnostics, unauthenticated and session-current checks;
8. silently uninstall and poll for cleanup instead of sleeping a fixed duration;
9. require child exit, zero files and no HTTP/CDP listeners; an empty custom `/D=` directory may be removed by the harness and must be reported;
10. in `finally`, attempt the official uninstaller whenever it exists, including partial-install failures.

`MINI_LUX_INSTALLER_OVERRIDE` may relocate only an installer with the exact expected basename and artifact-manifest identity; it never bypasses identity checks. `test:packaged` never selects “latest” by timestamp and never accepts a historical installer. `test:package` is the only wrapper that builds and writes the artifact manifest before smoke.

Non-Windows platforms must report `unsupported`, not `passed` or a normal skipped test. The full acceptance profile treats a required unsupported packaged layer as non-zero; `test:quick` remains the cross-platform source-level profile. Other platform installers belong to platform release tasks.

## Isolation and side-effect rules

- Every test receives a unique `mkdtemp` root.
- HTTP and CDP ports are reserved together and proven distinct before launch; fixed ports are forbidden.
- API tokens are random per fixture and never written to reports.
- Environment inheritance is allowlisted for spawned application processes while preserving required coverage variables only in the coverage profile.
- Process trees are terminated in `finally` blocks; Windows uses targeted PID-tree termination only and checks the termination result.
- Junctions are unlinked before recursive fixture deletion.
- Tests wait for direct-child exit, listener closure and fixture removal; requesting cleanup is not evidence of cleanup.
- Unit, contract, integration, Electron, coverage, and self-test profiles snapshot formal artifact hashes before and after; any mutation fails the layer.
- Only the package-building profile may update generated build metadata, `dist`, `.electron-app`, `release` and the package artifact manifest.
- Every non-package runner uses a fresh result directory and atomic temp-file-plus-rename report publication.
- `test-results/`, coverage output, `.electron-app/`, package artifact manifests and runtime fixtures are ignored generated data.

## Task manifest extension point

Each governed task adds `tests/manifests/<task-id>.json` with exact keys:

```json
{
  "schemaVersion": 1,
  "taskId": "GOV-03",
  "baseline": { "product": "Lux Desktop", "version": "0.1.898", "manifestSha256": "..." },
  "personaChain": ["planner", "architect", "developer", "debugger", "reviewer"],
  "changedRuntimeFiles": ["electron/main.cjs"],
  "coverageExemptions": {
    "electron/main.cjs": {
      "reason": "Electron main-process V8 is outside the Node c8 population",
      "evidenceLayer": "electron"
    }
  },
  "layers": {
    "unit": ["tests/unit/framework.test.mjs"],
    "contract": ["tests/contract/lux-baseline.test.mjs"],
    "integration": ["tests/integration/version-model.test.mjs"],
    "electron": ["tests/electron/desktop-smoke.test.mjs"],
    "packaged": ["tests/packaged/installed-smoke.test.mjs"]
  }
}
```

The runner rejects unknown keys, missing layers, missing files, duplicate/case-alias paths, glob metacharacters, path traversal, symlink escape, or a baseline mismatch. Every `changedRuntimeFiles` entry must either be in the governed coverage registry or have one exact exemption naming a non-empty reason and a required evidence layer that contains a real test. Exemptions are disclosed in the report and Reviewer-blocking if their evidence layer is skipped. GOV-04 will compare `changedRuntimeFiles` with the VCS diff; GOV-03 provides the schema and fail-closed runner but does not claim that CI wiring exists.

## Coverage model

### Honest denominator

`tests/coverage-scope.json` is an explicit, versioned, monotonically expanding registry of governed executable files. Initial scope covers the canonical runtime and contract boundaries verified by GOV-01/GOV-02:

- `dist/version.js`
- `dist/db.js`
- `dist/session.js`
- `dist/link.js`
- `parity/scripts/baseline-lib.mjs`

Security-critical scope initially contains the four runtime compatibility/capability modules. Electron main/preload/renderer and installed-package execution are evidenced by E2E and are not misrepresented as Node c8 coverage.

The registry validator requires exact keys; integer thresholds in `0..100`; normalized POSIX relative regular-file paths; realpath containment; no symlinks, traversal, backslashes, glob metacharacters, duplicates or Windows case aliases; security entries and per-file floors must be subsets of `overall`.

One `c8 --all` invocation receives one exact include for every registered file. It wraps the canonical contract and integration coverage profile, and Node child processes must inherit `NODE_V8_COVERAGE`. A registered but unexecuted file must appear with zero covered counters. Coverage executed from Temp project copies is not silently mapped to canonical files; the coverage profile executes canonical modules with Temp data instead.

The report separately records:

- governed executable files and zero-hit files;
- security-critical files;
- explicit changed-runtime coverage exemptions and their E2E evidence;
- authored production inventory (`src/**/*.ts`, `electron/**/*.{cjs,mjs,js}`, `public/**/*.js`, and `parity/scripts/*.mjs`, excluding tests, generated output and dependencies);
- registered authored equivalents where known and reproducible unregistered legacy debt.

The threshold must never be described as whole-product coverage until the governed registry reaches the whole product.

### Exact threshold algorithm

First-party code reads integer `covered` and `total` counters from `coverage-summary.json` and rejects any missing, unexpected or ambiguous path after canonicalization.

```text
overallLinesCovered = sum(overall[file].lines.covered)
overallLinesTotal = sum(overall[file].lines.total)
securityBranchesCovered = sum(securityCritical[file].branches.covered)
securityBranchesTotal = sum(securityCritical[file].branches.total)

line pass iff overallLinesTotal > 0
  and overallLinesCovered * 100 >= overallLinesTotal * 80
branch pass iff securityBranchesTotal > 0
  and securityBranchesCovered * 100 >= securityBranchesTotal * 90
```

In addition:

- every security-critical file must have a non-zero branch denominator and its exact counters must be disclosed; the 90% security threshold is enforced over their frozen aggregate, matching the canonical GOV-03 requirement;
- every `perFileLineMinimum` entry is enforced from integer counters; no branch can be removed from the aggregate denominator because it is dominated by an earlier fail-closed check;
- initial acceptance records non-decreasing per-file line floors for all governed files after the final measured run;
- deleting a governed file, lowering a stored floor, or adding a changed runtime file without coverage/exemption is Reviewer-blocking unless the production file itself was deleted;
- rounded `pct`, console output and `c8 --check-coverage` are informational only.

The authoritative coverage report records registry hash, Node/c8 versions, child test exit, exact aggregate and per-file counters, zero-hit/missing/unexpected files, legacy debt, exemptions, formal artifact snapshots and the final pass decision. It converts absolute c8 paths to canonical POSIX project-relative paths and never republishes absolute user paths.

### Coverage self-proof

GOV-03 must prove the coverage mechanism, not only run it:

- a registered file never imported still appears as zero and can fail the line threshold;
- a child-only module contributes coverage when the child inherits `NODE_V8_COVERAGE`, and contributes zero when inheritance is deliberately removed;
- security-only branch arithmetic cannot be raised by non-security files; 89.x fails and exact 90% passes;
- zero branch denominator, missing/truncated JSON and path remap ambiguity fail;
- a pre-seeded stale raw coverage file cannot affect a fresh run;
- a passing coverage ratio cannot mask a failing child test or formal-artifact mutation.

## Unified report

`run-tests.mjs` writes one atomic JSON report under `test-results/`:

```text
reportVersion / taskId / Lux baseline / Persona chain
Build ID / source digest / profile / timestamps
Changed files / migrations / configuration
Layers: command, expected, actual, exit code, tests, pass/fail, duration
Normal and negative scenarios
Concurrency/restart/package outcomes
Coverage: exact totals, percentages, registered scope, legacy debt
Metrics: tool calls, LLM calls, tokens, duration, runner max RSS
Formal artifact hashes before/after
Known limitations
Reviewer verdict / user status
```

Secrets, tokens, prompts, messages, absolute user paths, and environment dumps are forbidden. Console output is human-readable; JSON is the evidence authority. Layer state is one of `passed`, `failed`, `timed-out`, `crashed`, or `unsupported`; required `unsupported` is not success. Failure precedence is `timeout/crash → artifact mutation → test assertion → coverage threshold → cleanup → report validation`. Any failed required layer, failed cleanup, threshold miss, malformed report, artifact mutation, or missing/unsupported packaged result makes the acceptance runner exit non-zero. The report is published atomically only after schema validation; a partial temp report is never accepted as evidence.

## Fault-gate self-test

`test-gate-selftest.mjs` must prove independent fail-closed behavior:

1. run the intentionally failing assertion fixture and require non-zero with the expected assertion classification;
2. corrupt a Temp copy of the Lux baseline and require the contract layer to return non-zero without rewriting the locked baseline;
3. force an unexecuted governed coverage file/security threshold miss and require the coverage gate to return non-zero from integer counters;
4. pre-seed stale coverage data and prove it cannot turn the forced miss into a pass;
5. invoke packaged preflight with a missing installer and require `INSTALLER_MISSING` before installation;
6. invoke packaged preflight with an existing wrong-basename file and require `INSTALLER_NAME_MISMATCH` before execution;
7. when an artifact manifest is present, substitute wrong bytes under the exact basename and require `INSTALLER_HASH_MISMATCH` before execution.

The self-test records each expected and actual exit/classification. It passes only when every injected fault is blocked for the intended reason; generic non-zero after accidentally executing a bad installer is not proof. A child unexpectedly returning zero, returning the wrong failure class, modifying formal artifacts, or leaving residue fails the self-test. GOV-04 later wires this same process contract into CI.

## Build and traceability impact

Add `tests` to source-digest inputs so test/fixture changes alter derived Build ID. Generated `test-results` and coverage data stay excluded. A formal GOV-03 package must therefore have a new Build ID; the accepted GOV-02 installer remains historical evidence and must not be overwritten or relabeled.

## Acceptance sequence

1. Unit, contract, integration, and Electron E2E each pass independently without mutating formal artifacts.
2. The coverage mechanism self-proofs zero-hit accounting, child merging, stale-output isolation and exact security arithmetic.
3. Coverage meets at least 80% governed aggregate lines, 90% aggregate security branches, non-zero disclosed branch denominators for every security-critical file, and all stored per-file line floors.
4. Fault-gate self-test proves all assertion, corrupt-contract, coverage and packaged-preflight injections fail non-zero for the intended reason.
5. Three consecutive normal quick runs pass without process, listener, Temp or artifact residue.
6. Add `tests` to source-digest inputs, build a new formal installer and atomically record its artifact manifest; the accepted GOV-02 Build remains historical.
7. Run the exact installed packaged E2E, including full restart and official uninstall cleanup.
8. Run the complete `npm test` acceptance profile and generate unified evidence with actual tests, durations, errors, cleanup, artifact hashes, coverage counters, resource metrics and disclosed non-claims.
9. Debugger independently repeats negative, coverage, restart, port-race, package-preflight and cleanup paths.
10. Reviewer checks architecture conformance, scope honesty, exemptions, artifact identity and report schema, then stops at `verified-awaiting-user-confirmation`.

## Explicit non-claims

- No GitHub/other CI workflow is complete until GOV-04.
- No unsigned installer is a trusted release; signing remains REL-01.
- Coverage applies to the disclosed governed registry, not all legacy Mini-Lux modules.
- GOV-03 proves the framework and its initial governance boundaries; it does not retroactively certify every legacy feature.
