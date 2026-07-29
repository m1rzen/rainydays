# Lux Desktop Parity Baselines

This directory contains the machine-readable Lux Desktop contract baseline used by Mini-Lux.

## Capture

```bash
node parity/scripts/capture-lux-baseline.mjs \
  --lux-root "C:/Users/<user>/AppData/Local/Programs/Lux/resources/app/lux-dist" \
  --output parity/baselines/lux-desktop-0.1.898.json
```

The capture runs Lux Server with an isolated `LUX_HOME`. It never reads the real user Lux config, auth, sessions, memories, or databases. A read-only Mod API probe exports base Registry definitions without invoking tools. The generator creates one isolated default Session, cross-checks base membership through `tool_definitions_updated`, then starts one controlled flow against a loopback-only OpenAI-compatible sink with an ephemeral random dummy key. The sink captures the real model-facing `tools` payload, never forwards traffic, and returns a fixed local response. After genuine first-run bootstrap, the isolated Overseer daemon is immediately stopped through Lux's official `daemon_stop` WebSocket command. Conditional MCP, Prism, platform, Android, Worker-attach, and host-injected tools remain documentation-scoped rather than being misrepresented as default built-ins.

## Compare

```bash
node parity/scripts/compare-lux-baselines.mjs \
  parity/baselines/lux-desktop-0.1.898.json \
  parity/baselines/lux-desktop-0.1.898.json
```

Both inputs are first validated against the Draft 2020-12 Schema and cross-field semantic rules. Exit codes: `0` equal, `1` valid contract drift, `2` invalid input/Schema failure or execution error.

## Negative tests

```bash
node parity/scripts/test-baseline-diff.mjs
```

The synthetic test suite mutates copies in a temporary directory. It does not modify the locked baseline.

## Verify the locked baseline

```bash
npm run parity:verify
```

This injects drift into temporary copies of the real locked manifest (tool removal, required-field change, documented default change, Help hash change, duplicate tool) and writes `reports/gov-01-verification.json`.
