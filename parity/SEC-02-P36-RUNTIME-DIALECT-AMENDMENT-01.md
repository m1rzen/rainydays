# SEC-02/P36 Restricted Runtime Dialect Amendment 01

Status: **FROZEN FOR ONE-CYCLE RECOVERY**  
Parent: `parity/SEC-02-PATH-POLICY-ARCHITECTURE.md` Revision 3  
Canonical task: `LUX-DESKTOP-100-PARITY-EXECUTION-SPEC.md#SEC-02`  
User decision: Option A approved on 2026-07-24

## 1. Purpose

P36 remains the seven-leaf contract frozen in the parent architecture. This amendment changes only how the static completeness leaves are established. It forbids further attempts to prove completeness over unrestricted JavaScript and replaces that unbounded claim with a finite authored-runtime language, an explicit sink ledger, runtime canaries, and exact package projection.

No PathPolicy behavior, attack leaf, evidence tier, or SEC-02 residual boundary is weakened.

## 2. Finite input domain

The source dialect contains every regular executable file currently collected under:

- `src/**/*.{ts,tsx}`;
- `electron/**/*.{js,mjs,cjs}`.

The package dialect contains the corresponding authored executable projection under:

- `dist/**/*.{js,mjs,cjs}`;
- `electron/**/*.{js,mjs,cjs}` inside the staged app and final ASAR.

Tests, build scripts, parity scripts, vendored renderer code, dependencies, generated reports, and configuration are build/governance identity inputs but are not members of the P36 runtime-language completeness claim.

The exact source file list and hashes are recorded in the sink inventory. The exact compiled/packaged executable lists and hashes are checked against the fresh authored package projection. A new, removed, renamed, linked, case-aliased, or byte-changed runtime file changes candidate identity and must pass the same checks.

## 3. Restricted language

The machine-readable dialect policy fixes:

1. the governed module set;
2. the exact adapter file/module pairs allowed to import or require a governed module;
3. static source and package roots/extensions;
4. the sole reviewed non-literal runtime loader site;
5. the unsupported syntax classes.

Within the runtime dialect:

- governed modules may be imported or required only by their listed adapters;
- static `import`, dynamic `import()`, and `require()` specifiers must be string literals, except the one identity-bound Electron server-entry loader;
- a governed import may not be re-exported;
- computed access, reassignment, conditional selection, collection storage, callback passing, or return propagation of a governed callable is outside the dialect;
- permitted low-level calls must have an exact sink-ledger record binding source identity, API family, path operands, operation classification, adapter anchor, and runtime evidence owner;
- unsupported syntax is rejected as `UNSUPPORTED_RUNTIME_DIALECT`; it never triggers analyzer expansion.

The existing TypeScript AST scanner is retained only as a deterministic ledger extractor for this restricted domain. It is not evidence that arbitrary JavaScript data flow has been solved. The independent P36 checker proves the source remains inside the restricted language and that the ledger has no missing, extra, unresolved, or stale site.

## 4. Explicit adapter boundary

The adapter allowlist is closed. It covers the current PathPolicy/bootstrap/process/viewer/Office/parser/Electron entry modules and no wildcard module owner. Adding an adapter or governed dependency changes the reviewed policy and candidate identity.

In-memory parser/generator methods are not pathname sinks. Any switch to a path-taking third-party method creates a new ledger site and fails until it is removed or explicitly reviewed with a PathPolicy-owned byte/reservation boundary.

Shell, Script, and Terminal post-start filesystem isolation remains SEC-03. P36 covers their executable and initial-CWD adapter sites only.

## 5. Package binding

A valid package result requires all of the following:

- source digest equals build metadata;
- authored stage and ASAR files exactly match the fresh expected projection;
- no extra authored executable exists;
- the fresh expected and actual packaged sink sets are identical;
- the fresh expected and actual packaged restricted-dialect results are identical and passing;
- sink ledger, dialect checker, dialect policy, schemas, tests, resolved manifest, and report validators are bound into candidate identity.

Dependency internals are excluded from the P36 language claim and remain controlled by lockfile identity, SCA, package allowlisting, and later dependency governance.

## 6. Machine completion predicate

P36 static/package closure is true only when one current candidate satisfies:

```text
sourceDomainExact
&& unsupportedDialectSites == 0
&& unapprovedGovernedImports == 0
&& sinkLedger.missing == 0
&& sinkLedger.extra == 0
&& sinkLedger.unresolved == 0
&& sinkLedger.stale == 0
&& runtimeCanaries.complete
&& packageProjection.exact
&& packageDialect.complete
&& identity.source == identity.build == identity.stage == identity.asar == identity.report
&& P36.receipts == exactSevenLeaves
```

No generated policy may silently self-approve a new site. Ledger/policy updates require an independent Reviewer decision.

## 7. Recovery budget and stop rule

This amendment authorizes exactly:

- one Developer implementation cycle;
- one independent Reviewer cycle.

A new equivalent bypass, an inability to keep the dialect finite, a second implementation request, or any failed independent completion predicate returns SEC-02/P36 immediately to red-stop `BLOCKED`. The response is not to add another alias/data-flow rule.
