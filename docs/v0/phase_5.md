# Phase 5 — Verdict, Report Generation & Command Wiring

## Goal

Implement the final pieces that turn raw findings into a usable result: verdict computation, markdown report generation, and the complete `/decipher-solidity-upgradoor:check` slash command. At the end of this phase, a developer can run the command inside Claude Code and get a full upgrade safety analysis with a written report file.

---

## Deliverables

### 1. `engine/src/report/aggregator.ts` — Verdict Computation

```typescript
import type { Finding, Verdict, Severity, AnalyzerResult } from "../types.js";

export interface AggregatedResult {
  verdict: Verdict;
  highestSeverity: Severity | null;
  findings: Finding[];
  analyzerStatus: Record<string, "completed" | "skipped" | "errored">;
}

// Severity ordering for comparison
const SEVERITY_ORDER: Record<Severity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

// Analyzers that can produce CRITICAL findings — if any of these error, verdict = INCOMPLETE
const CRITICAL_CAPABLE_ANALYZERS = [
  "proxy-detection",
  "storage-layout",
  "abi-diff",
  "uups-safety",
  "transparent-safety",
  "initializer-integrity",
  "access-control",
];

export function aggregateResults(
  analyzerResults: Record<string, AnalyzerResult>,
): AggregatedResult {
  const findings: Finding[] = [];
  const analyzerStatus: Record<string, "completed" | "skipped" | "errored"> = {};

  for (const [name, result] of Object.entries(analyzerResults)) {
    analyzerStatus[name] = result.status;
    if (result.status === "completed") {
      findings.push(...result.findings);
    }
  }

  // Check if any CRITICAL-capable analyzer errored
  const criticalCapableErrored = CRITICAL_CAPABLE_ANALYZERS.some(
    name => analyzerStatus[name] === "errored",
  );

  if (criticalCapableErrored) {
    return { verdict: "INCOMPLETE", highestSeverity: null, findings, analyzerStatus };
  }

  // Compute highest severity
  let highestSeverity: Severity | null = null;
  for (const finding of findings) {
    if (!highestSeverity || SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[highestSeverity]) {
      highestSeverity = finding.severity;
    }
  }

  // Compute verdict
  let verdict: Verdict;
  if (findings.some(f => f.severity === "CRITICAL")) {
    verdict = "UNSAFE";
  } else if (findings.some(f => f.severity === "HIGH")) {
    verdict = "UNSAFE";
  } else if (findings.some(f => f.severity === "MEDIUM")) {
    verdict = "REVIEW_REQUIRED";
  } else {
    verdict = "SAFE";
  }

  return { verdict, highestSeverity, findings, analyzerStatus };
}
```

### 2. `engine/src/report/markdown-report.ts` — Report Renderer

```typescript
import type { Finding, Severity } from "../types.js";
import type { AggregatedResult } from "./aggregator.js";
import type { ProxyInfo } from "../types.js";

const SEVERITY_EMOJI: Record<Severity, string> = {
  CRITICAL: "🔴 CRITICAL",
  HIGH: "🟠 HIGH",
  MEDIUM: "🟡 MEDIUM",
  LOW: "🟢 LOW",
};

const VERDICT_HEADER: Record<string, string> = {
  SAFE: "# ✅ SAFE — Upgrade Appears Safe",
  UNSAFE: "# 🚨 UNSAFE — Do Not Upgrade",
  REVIEW_REQUIRED: "# ⚠️ REVIEW REQUIRED — Manual Review Needed",
  INCOMPLETE: "# ❓ INCOMPLETE — Analysis Could Not Complete",
};

export function generateMarkdownReport(
  aggregated: AggregatedResult,
  proxyInfo: ProxyInfo | undefined,
  metadata: {
    proxyAddress: string;
    newImplementationPath: string;
    oldImplementationPath: string;
    timestamp: string;
  },
): string {
  const lines: string[] = [];

  // Header
  lines.push(VERDICT_HEADER[aggregated.verdict] ?? `# ${aggregated.verdict}`);
  lines.push("");
  lines.push(`**Analyzed:** ${metadata.timestamp}`);
  lines.push(`**Proxy:** \`${metadata.proxyAddress}\``);
  if (proxyInfo) {
    lines.push(`**Proxy Type:** ${proxyInfo.type === "uups" ? "UUPS" : "Transparent"}`);
    lines.push(`**Current Implementation:** \`${proxyInfo.implementationAddress}\``);
    if (proxyInfo.adminAddress) {
      lines.push(`**Admin:** \`${proxyInfo.adminAddress}\``);
    }
  }
  lines.push(`**Old Implementation:** \`${metadata.oldImplementationPath}\``);
  lines.push(`**New Implementation:** \`${metadata.newImplementationPath}\``);
  lines.push("");

  // Severity summary
  lines.push("## Severity Summary");
  lines.push("");
  const counts: Record<Severity, number> = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  for (const f of aggregated.findings) counts[f.severity]++;
  lines.push("| Severity | Count |");
  lines.push("| -------- | ----- |");
  for (const sev of ["CRITICAL", "HIGH", "MEDIUM", "LOW"] as Severity[]) {
    lines.push(`| ${SEVERITY_EMOJI[sev]} | ${counts[sev]} |`);
  }
  lines.push("");

  // Analyzer status
  lines.push("## Analyzer Status");
  lines.push("");
  lines.push("| Analyzer | Status |");
  lines.push("| -------- | ------ |");
  for (const [name, status] of Object.entries(aggregated.analyzerStatus)) {
    const icon = status === "completed" ? "✅" : status === "skipped" ? "⏭" : "❌";
    lines.push(`| ${name} | ${icon} ${status} |`);
  }
  lines.push("");

  // Critical and High findings — full detail
  const criticalAndHigh = aggregated.findings.filter(
    f => f.severity === "CRITICAL" || f.severity === "HIGH",
  );
  if (criticalAndHigh.length > 0) {
    lines.push("## Critical & High Findings");
    lines.push("");
    for (const finding of criticalAndHigh) {
      lines.push(`### ${SEVERITY_EMOJI[finding.severity]} [${finding.code}] ${finding.title}`);
      lines.push("");
      lines.push(finding.description);
      lines.push("");
      if (finding.location) {
        const loc = finding.location;
        const parts = [
          loc.contract ? `Contract: \`${loc.contract}\`` : null,
          loc.function ? `Function: \`${loc.function}\`` : null,
          loc.slot !== undefined ? `Slot: ${loc.slot}` : null,
          loc.offset !== undefined ? `Offset: ${loc.offset}` : null,
          loc.file ? `File: \`${loc.file}:${loc.line ?? ""}\`` : null,
        ].filter(Boolean);
        if (parts.length > 0) {
          lines.push(`**Location:** ${parts.join(" | ")}`);
          lines.push("");
        }
      }
      if (Object.keys(finding.details).length > 0) {
        lines.push("**Details:**");
        lines.push("```json");
        lines.push(JSON.stringify(finding.details, null, 2));
        lines.push("```");
        lines.push("");
      }
      lines.push(`**Remediation:** ${finding.remediation}`);
      lines.push("");
      lines.push("---");
      lines.push("");
    }
  }

  // Medium and Low findings — summary table
  const mediumAndLow = aggregated.findings.filter(
    f => f.severity === "MEDIUM" || f.severity === "LOW",
  );
  if (mediumAndLow.length > 0) {
    lines.push("## Medium & Low Findings");
    lines.push("");
    lines.push("| Code | Severity | Title |");
    lines.push("| ---- | -------- | ----- |");
    for (const f of mediumAndLow) {
      lines.push(`| ${f.code} | ${SEVERITY_EMOJI[f.severity]} | ${f.title} |`);
    }
    lines.push("");
  }

  if (aggregated.findings.length === 0) {
    lines.push("## No findings.");
    lines.push("");
    lines.push("The upgrade appears safe. All analyzers completed with no issues.");
    lines.push("");
  }

  lines.push("---");
  lines.push("*Generated by decipher-solidity-upgradoor v0*");

  return lines.join("\n");
}
```

### 3. Update `engine.ts` — Complete Orchestrator

Wire everything together with proper error handling:

```typescript
import { createPublicClient, http } from "viem";
import type { EngineInput, EngineResult, AnalyzerResult, ProxyInfo } from "./types.js";
import { UpgradoorError } from "./errors.js";
import { detectProxy } from "./analyzers/proxy-detection.js";
import { resolveImplementations } from "./resolver/input-resolver.js";
import { analyzeStorageLayout } from "./analyzers/storage-layout.js";
import { analyzeAbiDiff } from "./analyzers/abi-diff.js";
import { analyzeUupsSafety } from "./analyzers/uups-safety.js";
import { analyzeTransparentSafety } from "./analyzers/transparent-safety.js";
import { analyzeInitializerIntegrity } from "./analyzers/initializer-integrity.js";
import { analyzeAccessControlRegression } from "./analyzers/access-control-regression.js";
import { aggregateResults } from "./report/aggregator.js";
import { generateMarkdownReport } from "./report/markdown-report.js";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export class UpgradoorEngine {
  async analyze(input: EngineInput): Promise<EngineResult> {
    await this.validateFoundry();

    const client = createPublicClient({ transport: http(input.rpcUrl) });
    const analyzerResults: Record<string, AnalyzerResult> = {};

    // Step 1: Proxy detection
    const { proxyInfo, result: proxyResult } = await detectProxy(
      client,
      input.proxyAddress as `0x${string}`,
    );
    analyzerResults["proxy-detection"] = proxyResult;

    // Halt if proxy detection found a blocking issue
    const blockingProxyCodes = ["PROXY-001", "PROXY-002", "PROXY-003", "PROXY-005"];
    const proxyFindings = proxyResult.status === "completed" ? proxyResult.findings : [];
    if (proxyFindings.some(f => blockingProxyCodes.includes(f.code))) {
      for (const name of ["storage-layout", "abi-diff", "uups-safety", "transparent-safety", "initializer-integrity", "access-control"]) {
        analyzerResults[name] = { status: "skipped", reason: "proxy-detection-failed" };
      }
      const aggregated = aggregateResults(analyzerResults);
      return {
        verdict: "INCOMPLETE",
        highestSeverity: null,
        findings: aggregated.findings,
        reports: { markdown: generateMarkdownReport(aggregated, proxyInfo, this.buildMetadata(input)) },
        analyzerStatus: aggregated.analyzerStatus,
      };
    }

    // Step 2: Resolve implementations (runs forge build + forge inspect)
    let resolved;
    try {
      resolved = await resolveImplementations(input);
    } catch (err) {
      if (err instanceof UpgradoorError) throw err;
      throw new UpgradoorError("RUNTIME_ERROR", `Failed to resolve implementations: ${String(err)}`);
    }

    // Step 3: Run all analyzers in parallel (where independent)
    const proxyType = proxyInfo?.type;

    const [storageResult, abiResult, proxyPatternResult, initResult, aclResult] =
      await Promise.allSettled([
        Promise.resolve(analyzeStorageLayout(resolved.old.layout, resolved.new.layout)),
        Promise.resolve(analyzeAbiDiff(resolved.old.abi, resolved.new.abi)),
        proxyType === "uups"
          ? analyzeUupsSafety(resolved.projectRoot, resolved.new.filePath, resolved.new.contractName)
          : proxyType === "transparent"
            ? analyzeTransparentSafety(proxyInfo!, resolved.new.abi)
            : Promise.resolve({ status: "skipped" as const, reason: "proxy-type-unknown" }),
        analyzeInitializerIntegrity(resolved.projectRoot, resolved.new.filePath, resolved.new.contractName),
        analyzeAccessControlRegression(
          resolved.projectRoot,
          resolved.old.filePath, resolved.old.contractName,
          resolved.new.filePath, resolved.new.contractName,
        ),
      ]);

    analyzerResults["storage-layout"] = settledToResult(storageResult);
    analyzerResults["abi-diff"] = settledToResult(abiResult);
    analyzerResults[proxyType === "uups" ? "uups-safety" : "transparent-safety"] = settledToResult(proxyPatternResult);
    analyzerResults["initializer-integrity"] = settledToResult(initResult);
    analyzerResults["access-control"] = settledToResult(aclResult);

    // Step 4: Aggregate and generate report
    const aggregated = aggregateResults(analyzerResults);
    const markdown = generateMarkdownReport(aggregated, proxyInfo, this.buildMetadata(input));

    return {
      verdict: aggregated.verdict,
      highestSeverity: aggregated.highestSeverity,
      findings: aggregated.findings,
      reports: { markdown },
      analyzerStatus: aggregated.analyzerStatus,
    };
  }

  private buildMetadata(input: EngineInput) {
    return {
      proxyAddress: input.proxyAddress,
      newImplementationPath: input.newImplementationPath,
      oldImplementationPath: input.oldImplementationPath,
      timestamp: new Date().toISOString(),
    };
  }

  private async validateFoundry(): Promise<void> {
    try {
      await execAsync("forge --version");
    } catch {
      throw new UpgradoorError(
        "FOUNDRY_NOT_FOUND",
        "Foundry is required but not found in PATH. " +
        "Install: curl -L https://foundry.paradigm.xyz | bash && foundryup",
      );
    }
  }
}

function settledToResult(settled: PromiseSettledResult<AnalyzerResult>): AnalyzerResult {
  if (settled.status === "fulfilled") return settled.value;
  return { status: "errored", error: String(settled.reason) };
}
```

### 4. Complete `commands/check.md` — The Slash Command

Replace the phase 1 stub with the full command:

```markdown
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
```

---

## Verification Steps

```bash
# Build the complete engine
cd engine
npm run build
npm run typecheck
npm test

# Validate the full plugin
cd ..
claude plugin validate .

# Load plugin locally and test the command
claude --plugin-dir ./decipher-solidity-upgradoor

# Inside the Claude session:
# /decipher-solidity-upgradoor:check 0x... ./src/V1.sol ./src/V2.sol https://...
```

**End-to-end test scenarios:**
1. Safe upgrade (V2 only appends new variables) → SAFE verdict, `upgrade_safety_report.md` written
2. Storage collision (V2 deletes a variable) → UNSAFE, STOR-001 finding in report
3. Missing `_authorizeUpgrade` on UUPS proxy → UNSAFE, UUPS-001 finding
4. Invalid proxy address → INPUT_ERROR, clear error message presented
5. forge build failure → FOUNDRY_ERROR, compilation errors shown
6. Unreachable RPC URL → INPUT_ERROR or RUNTIME_ERROR, clear error

---

## Expected Outcome

All of the following must be TRUE before v0 is considered complete:

1. `npm run build` exits 0 and `npm run typecheck` exits 0 — no errors in aggregator, markdown-report, or updated engine.ts.
2. `npm test` exits 0 — all tests including aggregator unit tests pass.
3. Running the full engine against a safe upgrade produces `verdict: "SAFE"` and `reports.markdown` contains the word "SAFE" in the header line.
4. Running against a storage collision (`StorageCollision.sol` fixture) produces `verdict: "UNSAFE"` and the markdown report contains the `STOR-001` finding with its title, description, and remediation text.
5. The file `upgrade_safety_report.md` written by the command is a valid, human-readable markdown file containing: a verdict header, findings grouped by severity, and an analyzer status table.
6. Invoking `/decipher-solidity-upgradoor:check <proxy> <old> <new> <rpc>` inside a Claude Code session completes end-to-end: forge builds, the engine runs, Claude presents the results, and `upgrade_safety_report.md` is written.
7. The output JSON contains all seven `analyzerStatus` keys: `proxy-detection`, `storage-layout`, `abi-diff`, `uups-safety`, `transparent-safety`, `initializer-integrity`, `access-control-regression`.
8. Exit codes from `check.ts` are correct: exit 0 for SAFE, exit 1 for CRITICAL finding present, exit 2 for HIGH finding (no CRITICAL), exit 3 for MEDIUM finding (no CRITICAL/HIGH), exit 4 for INCOMPLETE — verified by running against each fixture type.
9. `claude plugin validate .` still exits 0 — the final plugin structure with the complete `commands/check.md` is valid.
10. All v0 completion criteria in `docs/v0/sub-prd-v0.md` are checked off.

---

## Notes

- The command writes to `./upgrade_safety_report.md` relative to the user's current working directory, not the plugin directory.
- The engine JSON output may be large. Claude should parse it and present it — not dump the raw JSON to the user.
- All error paths must be handled gracefully. If `node engine/dist/check.js` exits with code 10, 11, or 12, Claude presents the error from stderr and stops.
- This phase completes v0. All v0 completion criteria should now pass.
