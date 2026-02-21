# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**decipher-solidity-upgradoor** is a Claude Code plugin providing deterministic upgrade safety verification for Solidity smart contracts using Transparent Proxy (EIP-1967) and UUPS Proxy (EIP-1822 + EIP-1967) patterns.

The engine is deterministic — no LLM in the analysis path. Claude acts as the presentation layer, orchestrating the engine and explaining findings.

## Commands

All commands run from the repo root unless noted.

```bash
# Build (compiles engine/src → engine/dist/)
npm run build

# Test (runs vitest inside engine/)
npm test

# Type-check (no emit)
cd engine && npm run typecheck

# Validate Claude Code plugin manifest
npm run validate   # runs: claude plugin validate .

# Watch mode (rebuild on save)
cd engine && npm run dev
```

Run a single test file:
```bash
cd engine && npx vitest run tests/analyzers/storage-layout.test.ts
```

Invoke the engine directly (requires `forge` in PATH and a running RPC):
```bash
node engine/dist/check.js \
  --proxy <0x...> \
  --old <path/to/V1.sol> \
  --new <path/to/V2.sol> \
  --rpc <rpc-url>
```

## Architecture

### Two surfaces, one engine

1. **Claude Code Plugin** — `.claude-plugin/` manifest + `commands/check.md` slash command. Claude invokes `engine/dist/check.js` via Bash and formats the JSON output.
2. **Engine** — `engine/` contains all analysis logic. Compiles to `engine/dist/check.js` (bundled by tsup, deps inlined). `dist/` is committed so plugin users need no build step.

### Engine pipeline (`engine/src/`)

```
check.ts (CLI entry)
  → UpgradoorEngine.analyze()        engine.ts
      → validateFoundry()             forge --version check
      → detectProxy()                 analyzers/proxy-detection.ts
      → resolveImplementations()      resolver/input-resolver.ts
          → forgeBuild()              utils/forge.ts (forge build)
          → extractStorageLayout()    resolver/layout-extractor.ts (forge inspect)
          → extractAbi()              resolver/abi-extractor.ts (forge inspect)
      → [parallel] all analyzers     analyzers/*.ts
      → aggregateResults()            report/aggregator.ts
      → generateMarkdownReport()      report/markdown-report.ts
```

`resolveImplementations` uses `findProjectRoot` (walks up looking for `foundry.toml` or `package.json`) so the project root is auto-detected from the provided `.sol` file paths.

### Analyzer isolation

Each analyzer is a pure function returning `AnalyzerResult`:
```ts
{ status: "completed"; findings: Finding[] }
| { status: "skipped"; reason: string }
| { status: "errored"; error: string }
```
All analyzers run via `Promise.allSettled` — one failure never blocks others. `proxy-detection` is the only gating step: specific finding codes (`PROXY-001`, `PROXY-002`, `PROXY-003`, `PROXY-005`) cause all downstream analyzers to be skipped.

Only one of `uups-safety` or `transparent-safety` runs per analysis (keyed by detected proxy type); the other is marked `skipped`.

### Finding codes and severity

Each finding has a namespaced code: `STOR-*`, `ABI-*`, `UUPS-*`, `TRAN-*`, `INIT-*`, `ACL-*`, `INH-*`. Severity levels: `CRITICAL | HIGH | MEDIUM | LOW`.

Verdict rules (in `report/aggregator.ts`):
- Any CRITICAL-capable analyzer errors → `INCOMPLETE`
- Any `CRITICAL` or `HIGH` finding → `UNSAFE`
- Any `MEDIUM` finding → `REVIEW_REQUIRED`
- Otherwise → `SAFE`

### CLI exit codes (`check.ts`)

| Code | Meaning |
|---|---|
| 0 | SAFE |
| 1 | UNSAFE (CRITICAL) |
| 2 | UNSAFE (HIGH) |
| 3 | REVIEW_REQUIRED |
| 4 | INCOMPLETE |
| 10 | Input/config error |
| 12 | Runtime error |

### Forge integration

All Foundry calls go through `utils/forge.ts`:
- `forgeBuild(projectRoot)` — compiles the project
- `forgeInspectStorageLayout(projectRoot, file, contractName)` — storage layout JSON
- `forgeInspectAbi(projectRoot, file, contractName)` — ABI JSON

Contract target format for `forge inspect`: `<relative-path-from-root>:<ContractName>`.

### Contract name detection

`input-resolver.ts` derives the contract name from the filename stem (`path.basename(file, ".sol")`). Override with `options.contractName` in `EngineInput`.

## Plugin Structure

```
.claude-plugin/plugin.json   # Plugin manifest
commands/check.md            # /decipher-upgradoor:check slash command
engine/src/                  # TypeScript source
engine/dist/                 # Compiled output (committed)
engine/tests/                # vitest tests, mirroring src/
```

The `commands/check.md` slash command drives the full workflow: input validation → `forge build` → `node engine/dist/check.js` → JSON parse → present findings → write `upgrade_safety_report.md`.

## Key Conventions

- `dist/` is committed — plugin users never run a build step.
- Storage layout primary key: `slot + offset + canonicalType` (labels are informational).
- Type aliases are normalized: `uint` → `uint256`, etc.
- Storage gaps validated: `N_new + V_new == N_old`.
- No LLM calls inside the engine — all findings are computed, never inferred.
- `UpgradoorError` is the only typed error class; all engine throws use it with an `ErrorCode`. The CLI catches it and exits with code 10.
- `ETHEREUM_MAINNET_RPC` env var is the fallback RPC URL when `--rpc` is not provided.
