---
description: Run a full upgrade safety analysis for a proxy contract
allowed-tools:
  - Bash
  - Write
---

# Upgrade Safety Check

Run a deterministic upgrade safety analysis. The engine checks storage layout
compatibility, ABI changes, proxy pattern safety, initializer integrity, and
access control regressions.

## Inputs

The user provides (in any order):
1. Proxy address (0x...) — the deployed proxy contract
2. Old implementation path — local `.sol` file or Foundry artifact JSON (e.g. `./src/V1.sol`)
3. New implementation path — local `.sol` file (e.g. `./src/V2.sol`)
4. RPC URL — JSON-RPC endpoint for the chain

If the user omits the RPC URL, check the environment variable `ETHEREUM_MAINNET_RPC`.
If still missing, ask the user for it.

## Workflow

### Step 1 — Validate Inputs

- Proxy address: must be 42 characters starting with 0x (or 40 hex chars without 0x)
- Old implementation path: must exist on disk
- New implementation path: must exist on disk and end in `.sol`
- RPC URL: must be provided or available via `ETHEREUM_MAINNET_RPC` env var

If any required input is missing or invalid, explain what's wrong and ask for the correct value.

### Step 2 — Build the Project

Run: `forge build`

If compilation fails:
- Show the compilation errors
- Do NOT proceed with analysis
- Suggest fixing the compilation errors first

### Step 3 — Run the Engine

Run the engine via Bash:
```bash
node engine/dist/check.js \
  --proxy <proxyAddress> \
  --old <oldImplementationPath> \
  --new <newImplementationPath> \
  --rpc <rpcUrl>
```

The output is a JSON object on stdout. If the process exits with a non-zero code, the stderr
contains an error JSON with `error` and `message` fields — present those clearly.

### Step 4 — Parse and Present Results

Parse the JSON result. Present to the user in this order:

1. **Verdict** (large and prominent):
   - SAFE → "✅ The upgrade appears safe."
   - UNSAFE → "🚨 The upgrade is UNSAFE. Do not deploy."
   - REVIEW_REQUIRED → "⚠️ The upgrade needs manual review."
   - INCOMPLETE → "❓ The analysis is incomplete. Some analyzers could not run."

2. **Severity Summary** — count of findings by severity (CRITICAL / HIGH / MEDIUM / LOW)

3. **CRITICAL and HIGH Findings** — for each, explain in plain English:
   - What the issue is
   - Why it's dangerous
   - Where exactly it occurs (contract, function, storage slot)
   - What to do to fix it

4. **MEDIUM and LOW Findings** — brief list only (code + title)

5. **Analyzer Status** — note any skipped or errored analyzers and why

### Step 5 — Write Report

Write the markdown report from `result.reports.markdown` to:
`./upgrade_safety_report.md`

Confirm to the user: "Report written to upgrade_safety_report.md"

### Step 6 — Offer to Help

Based on verdict:
- **SAFE**: "The upgrade appears safe. Review the report before deploying."
- **UNSAFE**: "I found critical issues. Would you like me to walk through how to fix them?"
- **REVIEW_REQUIRED**: "Some findings need your judgment. Want me to explain each one?"
- **INCOMPLETE**: "Some analyzers couldn't run. Here's what was skipped and how to provide the missing information."
