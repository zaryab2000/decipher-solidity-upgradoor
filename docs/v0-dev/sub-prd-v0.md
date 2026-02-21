# sub-prd-v0.md — decipher-solidity-upgradoor MVP (v0)

## What v0 Is

The absolute minimum to ship a working upgrade safety check inside Claude Code.

A developer working in a Foundry project:
1. Installs the plugin
2. Runs `/decipher-solidity-upgradoor:check` with a proxy address, old impl path, new impl path, and RPC URL
3. Gets a verdict (SAFE / UNSAFE / REVIEW_REQUIRED / INCOMPLETE) and a markdown report

No MCP server. No marketplace. No skill auto-detection. No subagent. No hook. No CLI. No baseline caching. No Etherscan. No git ref resolution.

**Just the engine + one slash command.**

---

## v0 Scope

### In Scope

- Plugin manifest (`.claude-plugin/plugin.json`) — enough to load the plugin locally
- One slash command: `/decipher-solidity-upgradoor:check`
- Core engine (TypeScript, Node.js) — pure library, no side-effects
- Proxy detection — Transparent and UUPS only (via EIP-1967 slots over RPC)
- Old implementation source resolution — local path only (user provides it)
- New implementation source resolution — local `.sol` path (user provides it)
- Storage layout extraction — via `forge inspect`
- Storage layout comparison — slot-by-slot, catches CRITICAL collision scenarios
- ABI diff — selector removed, collision, signature changed
- UUPS safety — `_authorizeUpgrade` existence and access control guard
- Transparent proxy safety — admin slot, pattern conflicts, selector collision
- Initializer integrity — constructor writes, missing initializer, version regression
- Access control regression — removed modifiers, widened visibility
- Report generation — single markdown report written to the project directory
- Finding format — standardized codes, severities, locations, remediations
- Verdict computation — SAFE / UNSAFE / REVIEW_REQUIRED / INCOMPLETE

### Out of Scope for v0 (moved to v1)

- MCP server (`.mcp.json`, `analyze_upgrade`/`check_proxy_type`/`get_baseline` tools)
- `/decipher-solidity-upgradoor:detect` command (standalone proxy type check)
- Marketplace distribution (`/plugin marketplace add`, `/plugin install`)
- Team auto-install via `.claude/settings.json`
- Skill auto-detection (`skills/upgrade-safety/SKILL.md`)
- `upgrade-reviewer` subagent
- Pre-deploy hook (`hooks/hooks.json`, `pre-deploy-check.sh`)
- Standalone CLI (`npx decipher-solidity-upgradoor check`)
- Baseline caching (`.upgradoor/` directory, `get_baseline`, save/load)
- Git ref resolution (`git:commit:path`)
- Etherscan/Sourcify resolution (not in V1 either)
- JSON report output
- Fix plan file generation
- CI exit codes
- Inheritance C3 linearization check (STOR-006) — complex, deferred to v1
- Access control regression — `require(msg.sender)` pattern matching (ACL-005) — complex, deferred to v1
- Configuration file (`upgradoor.config.json`)
- Environment variable configuration (`UPGRADOOR_*`)

---

## v0 Plugin Structure

```
decipher-solidity-upgradoor/
├── .claude-plugin/
│   └── plugin.json              ← Minimal manifest
│
├── commands/
│   └── check.md                 ← The only command
│
└── engine/
    ├── src/
    │   ├── index.ts
    │   ├── types.ts
    │   ├── engine.ts
    │   ├── resolver/
    │   │   ├── input-resolver.ts
    │   │   ├── layout-extractor.ts
    │   │   └── abi-extractor.ts
    │   ├── analyzers/
    │   │   ├── proxy-detection.ts
    │   │   ├── storage-layout.ts
    │   │   ├── abi-diff.ts
    │   │   ├── uups-safety.ts
    │   │   ├── transparent-safety.ts
    │   │   ├── initializer-integrity.ts
    │   │   └── access-control-regression.ts
    │   ├── report/
    │   │   ├── aggregator.ts
    │   │   └── markdown-report.ts
    │   └── utils/
    │       ├── eip1967.ts
    │       ├── forge.ts
    │       └── errors.ts
    ├── tests/
    ├── package.json
    └── tsconfig.json
```

No `mcp-server.ts`, no `cli.ts`, no `baseline/`, no `sourcify.ts`, no `etherscan.ts`, no `ast-extractor.ts` (deferred with ACL-005 and STOR-006), no `fix-plan.ts`, no `json-report.ts`.

---

## v0 Command: `/decipher-solidity-upgradoor:check`

The command is a markdown file with YAML frontmatter. Claude reads it and follows the instructions.

**Inputs the user provides:**
- `proxyAddress` — deployed proxy address (0x...)
- `oldImplementationPath` — local path to old implementation `.sol` file or artifact JSON
- `newImplementationPath` — local path to new implementation `.sol` file
- `rpcUrl` — JSON-RPC endpoint for the chain where the proxy is deployed

**Claude's workflow (defined in `commands/check.md`):**
1. Validate inputs
2. Run `forge build` to compile
3. Call the engine (via a small Node.js script that Claude runs via Bash)
4. Parse JSON result from stdout
5. Present verdict and findings in plain English
6. Write `upgrade_safety_report.md` to the project directory

**How Claude calls the engine in v0 (no MCP):**
Claude runs the engine as a Node.js script via Bash:
```bash
node engine/dist/check.js \
  --proxy <proxyAddress> \
  --old <oldImplementationPath> \
  --new <newImplementationPath> \
  --rpc <rpcUrl>
```
The script outputs a JSON result to stdout. Claude reads it and presents it.

This avoids MCP entirely while keeping the engine as a pure library.

---

## v0 Engine API

```typescript
import { UpgradoorEngine } from "./engine.js";

const engine = new UpgradoorEngine();

const result = await engine.analyze({
  proxyAddress: "0x...",
  oldImplementationPath: "./src/V1.sol",   // local path only in v0
  newImplementationPath: "./src/V2.sol",
  rpcUrl: "https://...",
  options: {
    contractName: undefined,               // auto-detected
    chainId: undefined,                    // auto-detected via eth_chainId
    failOnSeverity: "CRITICAL",
  },
});
```

**Result shape:**
```typescript
{
  verdict: "SAFE" | "UNSAFE" | "REVIEW_REQUIRED" | "INCOMPLETE";
  highestSeverity: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW" | null;
  findings: Finding[];
  reports: {
    markdown: string;
  };
  analyzerStatus: Record<string, "completed" | "skipped" | "errored">;
}
```

No `fixPlan`, no `json` report, no `baselineSaveRecommended` in v0.

---

## v0 Analyzer Pipeline

All analyzers that run in v0:

| Analyzer                 | Module                         | Finding Prefix | Requires AST? |
|--------------------------|-------------------------------|----------------|---------------|
| Proxy Detection          | `proxy-detection.ts`          | PROXY-         | No            |
| Storage Layout           | `storage-layout.ts`           | STOR-          | No            |
| ABI Diff                 | `abi-diff.ts`                 | ABI-           | No            |
| UUPS Safety              | `uups-safety.ts`              | UUPS-          | Yes (basic)   |
| Transparent Safety       | `transparent-safety.ts`       | TPROXY-        | No            |
| Initializer Integrity    | `initializer-integrity.ts`    | INIT-          | Yes (basic)   |
| Access Control Regression| `access-control-regression.ts`| ACL-           | Yes (basic)   |

**"Basic AST" in v0:** For UUPS, Initializer, and ACL analyzers, AST extraction in v0 is limited to running `forge inspect <ContractName> abi` and `forge build --extra-output ast` to get the AST JSON from the build artifacts. This avoids the need for a standalone solc invocation. The `ast-extractor.ts` file is not a separate module in v0 — AST is loaded directly from `out/<Contract>.sol/<Contract>.json` build artifacts.

**Deferred from v0:**
- STOR-006 (inheritance C3 linearization) — requires full inheritance-chain AST walking
- ACL-005 (`require(msg.sender)` pattern matching) — MEDIUM_CONFIDENCE, complex AST patterns
- ACL-006 (new unguarded public function) — requires cross-referencing all public functions with writes

---

## v0 Finding Codes In Scope

| Module      | Codes in v0                              | Deferred to v1    |
|-------------|------------------------------------------|-------------------|
| PROXY-      | PROXY-001 through PROXY-005              | —                 |
| RESOLVE-    | RESOLVE-001, RESOLVE-002, RESOLVE-003    | RESOLVE-004       |
| STOR-       | STOR-001 through STOR-005, STOR-007 through STOR-010 | STOR-006 |
| ABI-        | ABI-001 through ABI-007                  | —                 |
| UUPS-       | UUPS-001 through UUPS-005                | UUPS-006          |
| TPROXY-     | TPROXY-001 through TPROXY-004            | —                 |
| INIT-       | INIT-001, INIT-002, INIT-003, INIT-005, INIT-006 | INIT-004 |
| ACL-        | ACL-001, ACL-002, ACL-003, ACL-004, ACL-007 | ACL-005, ACL-006 |

INIT-004 deferred because it requires a cross-module dependency (STOR new vars → INIT). Can add in v1 once both modules are stable.
UUPS-006 deferred because delegatecall detection requires careful scoping.

---

## v0 Report Output

Single file: `upgrade_safety_report.md` written to the project root.

Contents:
1. Verdict (large header)
2. Severity summary table (count per severity)
3. Proxy details (type, address, current impl address)
4. Analyzer status table (completed/skipped/errored per module)
5. Findings — Critical and High only with full detail (code, title, location, remediation)
6. Findings — Medium and Low as a brief summary table

No JSON report in v0. No fix plan file in v0.

---

## v0 Error Handling

Engine errors return structured error objects, never throw unhandled:

| Code                  | When it fires                                                         |
|-----------------------|-----------------------------------------------------------------------|
| `FOUNDRY_NOT_FOUND`   | `forge` not in PATH                                                   |
| `INPUT_ERROR`         | Invalid address, missing file, unreachable RPC                        |
| `CONTRACT_AMBIGUOUS`  | `.sol` file has multiple contracts, cannot auto-detect primary        |
| `FOUNDRY_ERROR`       | `forge build` or `forge inspect` failed (compile error, remappings)   |
| `RUNTIME_ERROR`       | Unexpected engine error                                               |

Claude presents these with the exact error message and suggested fix.

---

## v0 Development Workflow (Local Plugin Testing)

```bash
# Build the engine
cd engine
npm install
npm run build    # tsup → dist/check.js

# Test the plugin locally without install
claude --plugin-dir ./decipher-solidity-upgradoor

# Validate plugin structure
claude plugin validate .
```

No marketplace, no `/plugin install`, no MCP registration in v0.

---

## v0 Completion Criteria

- [ ] Plugin manifest passes `claude plugin validate .`
- [ ] `/decipher-solidity-upgradoor:check <proxy> <old-impl> <new-impl> <rpc>` runs end-to-end
- [ ] Proxy detection correctly identifies Transparent and UUPS proxies
- [ ] Storage layout comparison catches all CRITICAL scenarios (STOR-001 through STOR-005)
- [ ] ABI diff catches removed selectors and collisions
- [ ] UUPS module detects missing/ungated `_authorizeUpgrade`
- [ ] Transparent module validates admin and pattern conflicts
- [ ] Initializer integrity catches constructor writes and missing initializers
- [ ] Access control regression detects removed `onlyOwner`/`onlyRole` modifiers
- [ ] All findings include code, severity, location, and remediation text
- [ ] `upgrade_safety_report.md` is written to project directory after each run
- [ ] Engine runs via `node engine/dist/check.js` CLI wrapper
- [ ] Error messages are clear and actionable
- [ ] Engine unit tests pass for all in-scope finding codes
