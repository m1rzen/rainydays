# GOV-04 Architect Amendment 01 — Split Source-Test and Package Workspaces

Status: **frozen**  
Frozen at: 2026-07-17T06:41:49.000Z  
Parent architecture: `parity/GOV-04-CI-ARCHITECTURE.md`

## Reason

The parent architecture requires GOV-03 quick before packaging, while GOV-03 quick consumes `build-info.json`, `dist/**` and `dist-integrity.json`. It also states that only the package step may create formal build output. A single workspace cannot satisfy both requirements without either hiding an extra build inside the quick step or deleting pre-existing output before package. Both weaken provenance.

This amendment is normative and supersedes the parent architecture wherever the two conflict.

## Workspace model

Every run exclusively creates:

```text
%TEMP%/mini-lux-gov04/<runId>/
  source-snapshot/
  source-test-workspace/
  package-workspace/
  reports/
  artifacts/sha256/<installer-sha256>/<exact-installer-name>
```

`source-snapshot` is the immutable candidate source. Both executable workspaces are copied independently from it and must match the same candidate identity before any command runs.

- `source-test-workspace` may create disposable test-only build output required by GOV-03. It has no artifact authority. Nothing generated there may be copied into the package workspace or published.
- `package-workspace` starts with no generated output and is the only authority for formal build metadata, dist, Electron staging, release output, artifact manifest and installer.
- Secret current-tree scanning targets `source-snapshot`; history scanning targets its full Git repository when provenance supports it.

## Fixed 16-step state machine

1. `prepare`
2. `source-clean-install`
3. `typecheck`
4. `lint`
5. `source-test-build`
6. `gov03-quick`
7. `gov03-self-test`
8. `sca-production`
9. `sca-full`
10. `secret-current`
11. `secret-history`
12. `package-clean-install`
13. `package`
14. `signature-policy`
15. `packaged-smoke`
16. `finalize`

Each step executes at most once. The first failure blocks later release steps. `finalize` always executes once.

## Install-count contract

A complete run performs exactly three `npm ci` operations:

1. one full install in `source-test-workspace`;
2. one full install in `package-workspace`;
3. one production-only install in `package-workspace/.electron-app` during the single package step.

A missing, additional or substituted install; `npm install`; copied/cached `node_modules`; or retry in the same run is a gate failure. The staging script records its governed install in a run-private exclusive ledger.

## Candidate-bound build identity

Prepare derives one canonical identity for both builds:

```text
buildId = <package-version> + "+ci." + <full-releaseCandidateId>
SOURCE_DATE_EPOCH = one run-fixed integer
```

`source-test-build` executes exactly:

```text
node scripts/generate-build-info.mjs
node node_modules/typescript/bin/tsc --project tsconfig.json
node scripts/generate-dist-integrity.mjs
```

The package command uses the same Build ID, epoch, source snapshot and toolchain. After packaging, the parent requires exact equality of:

- `build-info.json` bytes;
- `dist-integrity.json` bytes;
- dist tree digest;
- Build ID and source digest.

A difference means the tested bytes and packaged bytes are not the same candidate.

## Package-once contract

Before package execution, all of the following must be absent in `package-workspace`:

```text
build-info.json
dist-integrity.json
dist/
.electron-app/
release/
coverage/
test-results/package-artifact.json
```

Pre-existence is `PACKAGE_OUTPUT_PREEXISTS`. The runner must not delete and continue.

Before invoking package, the parent exclusively creates `reports/package-attempt.json`, binding run ID, challenge, candidate ID, canonical Build ID, source manifest hash and command identity. An existing marker is `PACKAGE_ALREADY_ATTEMPTED`.

The only authoritative package invocation is one direct pinned-npm CLI execution of `npm run dist`. Manifest generation is a single read-only post-package command. The installer is frozen using exclusive creation at:

```text
artifacts/sha256/<sha256>/<exact-filename>
```

Signature verification and packaged smoke explicitly consume that frozen path and its manifest. They may not select by timestamp, directory scan or “latest”.

## Post-package immutability

Immediately after package, record hashes of build info, dist integrity, dist tree, Electron staging tree, release tree, artifact manifest, source installer and frozen installer. Recheck at signature boundaries, packaged-smoke boundaries and finalize. Unsigned merge mode requires all bytes unchanged.

## Required negative proofs

The GOV-04 self-test must additionally prove:

- source-test output copied into package workspace is rejected;
- package output pre-existence is rejected without deletion;
- different Build ID/epoch or different dist tree is rejected;
- missing or additional install-ledger entry is rejected;
- copied `node_modules` is rejected;
- a second package attempt in one run is rejected;
- package/release/manifest mutation after freeze is rejected;
- packaged smoke cannot consume a non-frozen path or hash.
