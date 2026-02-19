# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Status

Pre-implementation. The full specification lives in `docs/decipher-solidity-upgradoor-v2-prd.md` (V3). The README is a placeholder. No source code exists yet — this CLAUDE.md describes what to build.

## What This Is

**decipher-solidity-upgradoor** is a Claude Code plugin that provides deterministic upgrade safety verification for Solidity smart contracts using Transparent Proxy (EIP-1967) and UUPS Proxy (EIP-1822 + EIP-1967) patterns. V1 scope: Transparent and UUPS only — no Beacon, Diamond, or custom proxy patterns.

The engine is deterministic (no LLM in the analysis path). Claude acts as the presentation layer: explaining findings, suggesting fixes, orchestrating workflow.

## Tech Stack

- **Language:** TypeScript strict mode, Node.js ≥ 18, ESM
- **Build:** tsup (bundles all deps into `dist/`)
- **Test:** vitest
- **Blockchain RPC:** viem
- **Plugin protocol:** `@modelcontextprotocol/sdk`
- **CLI:** commander
- **Validation:** zod
- **Solidity tools:** Foundry (`forge`) for storage layout extraction and compilation

## Repository Layout (to be created)

```
.claude-plugin/          # Claude Code plugin manifest
  plugin.json            # Plugin manifest (name, version, author)
  .mcp.json              # MCP server auto-registration
  commands/              # Slash commands (check.md, detect.md)
  skills/                # Auto-invoked skills (upgrade-safety/SKILL.md)
  agents/                # Subagents (upgrade-reviewer.md)
  hooks/                 # Lifecycle hooks (hooks.json, scripts/)
engine/                  # Core deterministic engine (TypeScript)
  src/
    index.ts             # Public API exports
    types.ts             # All shared TypeScript interfaces
    engine.ts            # UpgradoorEngine orchestrator class
    mcp-server.ts        # Thin MCP server wrapper
    cli.ts               # Thin CLI wrapper
    resolver/            # Input validation and source resolution
    analyzers/           # Independent analysis modules
    report/              # Report generators (markdown, JSON, fix-plan)
    baseline/            # Storage layout snapshot persistence
    utils/               # viem helpers, forge/solc wrappers, API clients
  package.json
  tsconfig.json
  tsup.config.ts
upgradoor.config.json    # Project-level config (RPC, API keys, options)
.upgradoor/              # Local baseline cache (gitignored)
docs/                    # PRD and design docs
```

## Commands (once engine/ exists)

```bash
cd engine
npm install
npm run build       # tsup → dist/mcp-server.js, dist/cli.js
npm test            # vitest (all tests run twice to verify determinism)
npm run typecheck   # tsc --noEmit
```

Plugin validation (once .claude-plugin/ exists):
```bash
claude plugin validate .
```

## Architecture

### Two distribution surfaces, one engine

1. **Claude Code Plugin** — installed via `/plugin install decipher-upgradoor@decipher-marketplace`. Provides slash commands, skills, subagents, hooks, and an auto-registered MCP server.
2. **Standalone CLI/npm package** — same engine, different surface. Exit codes for CI automation.

### Engine pipeline

```
Inputs (proxy address, new impl, RPC)
  → InputResolver         (validate + resolve sources via cascade below)
  → Analyzer Pipeline     (modules run in parallel after dependencies)
  → ReportAggregator      (combine findings, compute verdict)
  → Output                (Markdown report + JSON)
```

### Source resolution cascade (InputResolver)

1. User-provided local path
2. Git reference (`git:commit:path`)
3. Baseline cache (`.upgradoor/{chainId}/{proxyAddress}`)
4. Etherscan verified source
5. Sourcify verified source
6. Bytecode-only degraded mode

### Analyzer modules (all independent, all deterministic)

| Module | Finding prefix | What it checks |
|---|---|---|
| `proxy-detection` | — | EIP-1967 slot reading → Transparent vs UUPS |
| `storage-layout` | `STOR-*` | Collisions, deletions, type changes, inheritance reordering |
| `abi-diff` | `ABI-*` | Selector removals, collisions, signature changes |
| `uups-safety` | `UUPS-*` | `_authorizeUpgrade` presence/gating, `proxiableUUID` |
| `transparent-safety` | `TRAN-*` | Admin validation, function selector conflicts |
| `initializer-integrity` | `INIT-*` | Constructor storage writes, `initializer` modifiers, version regressions |
| `access-control-regression` | `ACL-*` | Removed modifiers, visibility widening |
| `inheritance-check` | `INH-*` | C3 linearization order |

Each analyzer returns `{ status: "completed|skipped|errored", findings?: [...], reason?: "..." }`. One failure never blocks others.

### Verdict computation

- Any CRITICAL-capable analyzer errors → `INCOMPLETE` (never `SAFE`)
- Any `CRITICAL` finding → `UNSAFE`
- Any `HIGH` finding → `UNSAFE`
- Any `MEDIUM` finding → `REVIEW_REQUIRED`
- Otherwise → `SAFE`

### Storage layout validation rules

- Primary key: `slot + offset + canonicalType` (labels are informational only)
- Type aliases normalized (`uint` → `uint256`)
- Storage gaps validated: `N_new + V_new == N_old`

### CLI exit codes

| Code | Meaning |
|---|---|
| 0 | SAFE |
| 1 | CRITICAL finding |
| 2 | HIGH finding |
| 3 | MEDIUM finding |
| 4 | INCOMPLETE (analyzer error) |
| 10–12 | Input/config/network errors |

### Configuration precedence

CLI flags > environment variables (`UPGRADOOR_*`) > `upgradoor.config.json` > `.upgradoor/config.json` > defaults

## MCP Tools (exposed by mcp-server.ts)

- `analyze_upgrade` — full pipeline run
- `check_proxy_type` — EIP-1967 slot detection only
- `get_baseline` — retrieve cached storage layout snapshot

## Plugin Components

- **`/decipher-upgradoor:check`** — Full upgrade safety analysis (slash command)
- **`/decipher-upgradoor:detect`** — Quick proxy type detection (slash command)
- **`upgrade-safety` skill** — Auto-invoked when Claude detects upgrade work in context
- **`upgrade-reviewer` subagent** — Isolated context deep-dive review
- **Pre-deploy hook** — Warns before `forge script` commands that deploy upgrades

## Key Conventions

- Every test runs **twice** — second run verifies byte-for-byte identical output (determinism requirement)
- `dist/` is committed — no build step for plugin users
- Finding codes are standardized strings like `STOR-001`, `UUPS-002`, `ACL-001`; each has severity, confidence, title, description, location, remediation
- No LLM calls inside the engine; findings are computed, not inferred
