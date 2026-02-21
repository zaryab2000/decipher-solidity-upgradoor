# decipher-solidity-upgradoor

Deterministic upgrade safety analyzer for Solidity proxy contracts. Catches storage collisions, ABI breaks, access control regressions, and initializer bugs before you deploy.

Supports **Transparent Proxy (EIP-1967)** and **UUPS Proxy (EIP-1822 + EIP-1967)**. No Beacon or Diamond support in v0.

---

## How It Works

The engine is fully deterministic — no LLM is involved in the analysis. Given a deployed proxy address, the old implementation source, and the new implementation source, it runs a pipeline of independent analyzers and returns a structured verdict.

Claude Code acts as the presentation layer: collecting inputs, invoking the engine via Bash, explaining findings in plain English, and writing the report to disk.

```
Proxy address + old impl + new impl + RPC
  → InputResolver       (validate inputs, forge build, extract layouts + ABIs)
  → Analyzer Pipeline   (8 modules run in parallel)
  → ReportAggregator    (combine findings, compute verdict)
  → Markdown report + JSON output
```

---

## Verdicts

| Verdict | Meaning |
|---|---|
| `SAFE` | No findings above LOW severity |
| `UNSAFE` | CRITICAL or HIGH finding present — do not deploy |
| `REVIEW_REQUIRED` | MEDIUM findings require manual judgment |
| `INCOMPLETE` | A critical-capable analyzer errored — result is not trustworthy |

---

## Analyzer Modules

Each module runs independently. One failure never blocks the others.

| Module | Finding Prefix | What It Checks |
|---|---|---|
| `proxy-detection` | — | EIP-1967 slot reading → classifies Transparent vs UUPS |
| `storage-layout` | `STOR-*` | Slot collisions, deletions, type changes, inheritance reordering, gap integrity |
| `abi-diff` | `ABI-*` | Selector removals, selector collisions, signature changes, event changes |
| `uups-safety` | `UUPS-*` | `_authorizeUpgrade` presence, non-empty body, access control gating |
| `transparent-safety` | `TRAN-*` | Admin slot validity, selector conflicts with proxy admin functions |
| `initializer-integrity` | `INIT-*` | Constructor storage writes, `initializer` modifiers, `_disableInitializers` |
| `access-control-regression` | `ACL-*` | Removed modifiers, visibility widening, lost `_authorizeUpgrade` protection |
| `inheritance-check` | `INH-*` | C3 linearization order changes |

---

## Usage

### As a Claude Code Plugin (slash command)

```
/decipher-upgradoor:check 0xProxyAddress ./src/V1.sol ./src/V2.sol https://eth-mainnet.rpc/...
```

Claude validates inputs, runs the engine, explains every finding in plain English, and writes `upgrade_safety_report.md` to your project root.

Quick proxy type detection only:

```
/decipher-upgradoor:detect 0xProxyAddress https://eth-mainnet.rpc/...
```

### As a CLI

```bash
cd engine
npm install
npm run build

node dist/check.js \
  --proxy 0xYourProxyAddress \
  --old ./src/MyContractV1.sol \
  --new ./src/MyContractV2.sol \
  --rpc https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
```

Output is a JSON object on stdout. The process exits with a code that reflects the verdict — useful for CI pipelines.

### CLI Exit Codes

| Code | Meaning |
|---|---|
| `0` | SAFE |
| `1` | CRITICAL finding present |
| `2` | HIGH finding (no CRITICAL) |
| `3` | MEDIUM finding (no CRITICAL/HIGH) |
| `4` | INCOMPLETE (analyzer error) |
| `10` | Input or config error |
| `12` | Runtime error |

### CI Example

```yaml
- name: Upgrade safety check
  run: |
    node engine/dist/check.js \
      --proxy ${{ vars.PROXY_ADDRESS }} \
      --old ./src/V1.sol \
      --new ./src/V2.sol \
      --rpc ${{ secrets.RPC_URL }}
  # Exits non-zero on UNSAFE, REVIEW_REQUIRED, or INCOMPLETE
```

---

## Prerequisites

- **Node.js** ≥ 18
- **Foundry** (`forge`) — [install](https://getfoundry.sh)
- A Solidity project using Foundry (needs `foundry.toml` to be discoverable)
- A JSON-RPC endpoint for the chain where the proxy is deployed

```bash
# Install Foundry if not already installed
curl -L https://foundry.paradigm.xyz | bash && foundryup
```

---

## Configuration

Copy `.env.example` and fill in your RPC URL:

```bash
cp .env.example .env
```

```env
ETHEREUM_MAINNET_RPC=https://eth-mainnet.g.alchemy.com/v2/YOUR_KEY
UUPS_PROXY_ADDRESS=0x...
TRANSPARENT_PROXY_ADDRESS=0x...
```

The slash command reads `ETHEREUM_MAINNET_RPC` automatically if you don't pass an RPC URL explicitly.

Configuration precedence (highest to lowest):

```
CLI flags > UPGRADOOR_* env vars > upgradoor.config.json > .upgradoor/config.json > defaults
```

---

## Source Resolution

The engine locates contract sources in this order:

1. User-provided local path
2. Git reference (`git:commit:path`)
3. Baseline cache (`.upgradoor/{chainId}/{proxyAddress}`)
4. Etherscan verified source
5. Sourcify verified source
6. Bytecode-only degraded mode

---

## Finding Severity Reference

### Storage Layout (`STOR-*`)

| Code | Severity | Description |
|---|---|---|
| `STOR-001` | CRITICAL | Variable deleted from storage layout |
| `STOR-002` | CRITICAL | Variable inserted in the middle of existing layout |
| `STOR-003` | CRITICAL | Type width changed at same slot |
| `STOR-004` | CRITICAL | Type semantics changed at same slot |
| `STOR-007` | HIGH | Storage gap shrank more than new variables added |
| `STOR-008` | HIGH | Storage gap removed entirely |
| `STOR-009` | MEDIUM | New variable appended after existing layout |
| `STOR-010` | LOW | Variable renamed (same slot/offset/type) |

### ABI Diff (`ABI-*`)

| Code | Severity | Description |
|---|---|---|
| `ABI-001` | HIGH | Function selector removed |
| `ABI-002` | CRITICAL | Two functions share the same 4-byte selector |
| `ABI-003` | HIGH | Function name unchanged but parameter types changed |
| `ABI-004` | MEDIUM | Same selector, return type changed |
| `ABI-005` | LOW | New function added |
| `ABI-006` | HIGH | Event signature changed |
| `ABI-007` | MEDIUM | Event removed |

### UUPS Safety (`UUPS-*`)

| Code | Severity | Description |
|---|---|---|
| `UUPS-001` | CRITICAL | `_authorizeUpgrade` missing |
| `UUPS-002` | CRITICAL | `_authorizeUpgrade` has empty body (anyone can upgrade) |
| `UUPS-003` | CRITICAL | `_authorizeUpgrade` body has no access control |

### Transparent Proxy Safety (`TPROXY-*`)

| Code | Severity | Description |
|---|---|---|
| `TPROXY-001` | CRITICAL | Admin slot is zero address |
| `TPROXY-002` | HIGH | Implementation defines `upgradeTo`/`upgradeToAndCall` |
| `TPROXY-004` | HIGH | Implementation selector collides with proxy admin functions |

### Initializer Integrity (`INIT-*`)

| Code | Severity | Description |
|---|---|---|
| `INIT-001` | CRITICAL | Constructor has storage writes |
| `INIT-002` | HIGH | No `initializer` or `reinitializer` modifier found |
| `INIT-005` | MEDIUM | Constructor does not call `_disableInitializers()` |
| `INIT-006` | HIGH | Multiple functions carry the `initializer` modifier |

### Access Control Regression (`ACL-*`)

| Code | Severity | Description |
|---|---|---|
| `ACL-001` | CRITICAL | `onlyOwner` removed from a function |
| `ACL-002` | CRITICAL | Role-based modifier removed |
| `ACL-003` | HIGH | Custom access control modifier removed |
| `ACL-004` | HIGH | Function visibility widened (e.g. `internal` → `public`) |
| `ACL-007` | CRITICAL | `_authorizeUpgrade` lost its access control guard |

---

## Development

```bash
cd engine
npm install
npm run build       # tsup → dist/check.js
npm test            # vitest (each test runs twice to verify determinism)
npm run typecheck   # tsc --noEmit
```

The `dist/` directory is committed so plugin users don't need a build step.

Every test suite runs each test **twice**. The second run verifies byte-for-byte identical output — a hard requirement for a deterministic engine.

### Repository Layout

```
.claude-plugin/          # Claude Code plugin manifest
  plugin.json            # Plugin name, version, author
  commands/              # Slash command definitions (check.md, detect.md)
engine/                  # Core deterministic engine (TypeScript)
  src/
    check.ts             # CLI entry point
    engine.ts            # UpgradoorEngine orchestrator
    types.ts             # All shared TypeScript interfaces
    analyzers/           # Independent analysis modules
    resolver/            # Input validation and source resolution
    report/              # Verdict aggregation and markdown report generation
    utils/               # viem helpers, forge subprocess wrappers
  dist/                  # Built output (committed)
  tests/                 # Vitest unit tests
docs/                    # Design docs and engine internals reference
commands/                # Claude Code slash command markdown files
```

---

## Plugin Components

| Component | Description |
|---|---|
| `/decipher-upgradoor:check` | Full upgrade safety analysis |
| `/decipher-upgradoor:detect` | Quick proxy type detection only |
| `upgrade-safety` skill | Auto-invoked when Claude detects upgrade work in context |
| `upgrade-reviewer` subagent | Isolated deep-dive review in a fresh context window |
| Pre-deploy hook | Warns before `forge script` commands that deploy upgrades |

---

## MCP Tools

When the MCP server is enabled, three tools are exposed to Claude:

| Tool | Description |
|---|---|
| `analyze_upgrade` | Full pipeline run |
| `check_proxy_type` | EIP-1967 slot detection only |
| `get_baseline` | Retrieve cached storage layout snapshot |

---

## License

MIT — see `plugin.json` for author and repository details.
