# Phase 2 — Types, Engine Shell, and Proxy Detection

## Goal

Define all shared TypeScript types and build the engine orchestrator shell. Implement the first real analyzer: proxy detection. At the end of this phase, the engine can connect to an RPC, read EIP-1967 storage slots, and classify a proxy as Transparent, UUPS, or unrecognized.

---

## Deliverables

### 1. `engine/src/types.ts` — All Shared Types

Define every interface the engine uses. This file has no imports from other engine files — it only imports from external packages.

```typescript
// Verdict
export type Verdict = "SAFE" | "UNSAFE" | "REVIEW_REQUIRED" | "INCOMPLETE";

// Severity
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type Confidence = "HIGH_CONFIDENCE" | "MEDIUM_CONFIDENCE";

// Finding
export interface Finding {
  code: string;
  severity: Severity;
  confidence: Confidence;
  title: string;
  description: string;
  details: Record<string, unknown>;
  location?: {
    contract?: string;
    function?: string;
    slot?: number;
    offset?: number;
    file?: string;
    line?: number;
  };
  remediation: string;
}

// Analyzer result (isolated error policy)
export type AnalyzerResult =
  | { status: "completed"; findings: Finding[] }
  | { status: "skipped"; reason: string }
  | { status: "errored"; error: string };

// Proxy type
export type ProxyType = "transparent" | "uups" | "unknown";

// Storage layout entry (canonical form)
export interface CanonicalStorageEntry {
  slot: number;
  offset: number;
  length: number;
  canonicalType: string;
  label: string;
  contractOrigin: string;
  inheritanceIndex: number;
}

// Engine input
export interface EngineInput {
  proxyAddress: string;
  oldImplementationPath: string;   // v0: local path only
  newImplementationPath: string;
  rpcUrl: string;
  options?: {
    contractName?: string;
    chainId?: number;
    failOnSeverity?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  };
}

// Engine result
export interface EngineResult {
  verdict: Verdict;
  highestSeverity: Severity | null;
  findings: Finding[];
  reports: {
    markdown: string;
  };
  analyzerStatus: Record<string, "completed" | "skipped" | "errored">;
}

// Proxy detection result (internal, passed between analyzers)
export interface ProxyInfo {
  type: ProxyType;
  proxyAddress: string;
  implementationAddress: string;
  adminAddress?: string;
}
```

### 2. `engine/src/errors.ts` — Custom Error Types

```typescript
export type ErrorCode =
  | "FOUNDRY_NOT_FOUND"
  | "INPUT_ERROR"
  | "CONTRACT_AMBIGUOUS"
  | "FOUNDRY_ERROR"
  | "RUNTIME_ERROR";

export class UpgradoorError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "UpgradoorError";
  }
}
```

### 3. `engine/src/utils/eip1967.ts` — EIP-1967 Constants and Slot Readers

```typescript
import { createPublicClient, http, type PublicClient } from "viem";

// EIP-1967 storage slots (keccak256 of magic strings, minus 1)
export const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
export const BEACON_SLOT =
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

// proxiableUUID() selector for UUPS detection
export const PROXIABLE_UUID_SELECTOR = "0x52d1902d";

export async function readStorageSlot(
  client: PublicClient,
  address: `0x${string}`,
  slot: `0x${string}`,
): Promise<`0x${string}`> {
  return client.getStorageAt({ address, slot }) as Promise<`0x${string}`>;
}

export function slotToAddress(slotValue: `0x${string}`): `0x${string}` {
  // Storage slot value is 32 bytes — address is the last 20 bytes
  return `0x${slotValue.slice(-40)}` as `0x${string}`;
}
```

### 4. `engine/src/analyzers/proxy-detection.ts`

Reads EIP-1967 slots. Classifies proxy type. Returns `ProxyInfo` or fires `PROXY-` findings.

```typescript
import type { PublicClient } from "viem";
import type { AnalyzerResult, Finding, ProxyInfo } from "../types.js";
import {
  IMPLEMENTATION_SLOT,
  ADMIN_SLOT,
  BEACON_SLOT,
  PROXIABLE_UUID_SELECTOR,
  readStorageSlot,
  slotToAddress,
} from "../utils/eip1967.js";

// Returns the proxy type and addresses, plus any findings
export async function detectProxy(
  client: PublicClient,
  proxyAddress: `0x${string}`,
): Promise<{ proxyInfo?: ProxyInfo; result: AnalyzerResult }> {
  const findings: Finding[] = [];

  // Read EIP-1967 slots
  const implSlot = await readStorageSlot(client, proxyAddress, IMPLEMENTATION_SLOT);
  const adminSlot = await readStorageSlot(client, proxyAddress, ADMIN_SLOT);
  const beaconSlot = await readStorageSlot(client, proxyAddress, BEACON_SLOT);

  const implAddress = slotToAddress(implSlot);
  const adminAddress = slotToAddress(adminSlot);

  // Beacon proxy — not supported in v0/v1
  const beaconAddress = slotToAddress(beaconSlot);
  if (beaconAddress !== "0x0000000000000000000000000000000000000000") {
    findings.push({
      code: "PROXY-001",
      severity: "CRITICAL",
      confidence: "HIGH_CONFIDENCE",
      title: "Beacon proxy detected — not supported",
      description: "This proxy uses the beacon pattern (EIP-1967 beacon slot is set). Only Transparent and UUPS proxies are supported.",
      details: { beaconAddress },
      remediation: "Use a supported proxy pattern (Transparent or UUPS) or wait for beacon proxy support in a future version.",
    });
    return { result: { status: "completed", findings } };
  }

  // No implementation address set
  if (implAddress === "0x0000000000000000000000000000000000000000") {
    findings.push({
      code: "PROXY-002",
      severity: "CRITICAL",
      confidence: "HIGH_CONFIDENCE",
      title: "No implementation set (zero address)",
      description: "The EIP-1967 implementation slot contains the zero address.",
      details: { implSlot, implAddress },
      remediation: "Verify the proxy address is correct and has been initialized.",
    });
    return { result: { status: "completed", findings } };
  }

  // Implementation has no code
  const implCode = await client.getBytecode({ address: implAddress as `0x${string}` });
  if (!implCode || implCode === "0x") {
    findings.push({
      code: "PROXY-003",
      severity: "CRITICAL",
      confidence: "HIGH_CONFIDENCE",
      title: "Implementation address has no deployed code",
      description: `The current implementation address (${implAddress}) has no bytecode.`,
      details: { implAddress },
      remediation: "Verify the proxy was deployed on the correct network and the RPC URL is for the right chain.",
    });
    return { result: { status: "completed", findings } };
  }

  // Determine proxy type: check for proxiableUUID selector in bytecode (UUPS indicator)
  const isUUPS = implCode.includes(PROXIABLE_UUID_SELECTOR.slice(2));
  const hasAdmin = adminAddress !== "0x0000000000000000000000000000000000000000";

  let proxyType: "transparent" | "uups" | "unknown";
  if (isUUPS) {
    proxyType = "uups";
  } else if (hasAdmin) {
    proxyType = "transparent";
  } else {
    proxyType = "unknown";
  }

  if (proxyType === "unknown") {
    findings.push({
      code: "PROXY-005",
      severity: "CRITICAL",
      confidence: "HIGH_CONFIDENCE",
      title: "Unrecognized proxy pattern",
      description: "No EIP-1967 slots match a known proxy pattern.",
      details: { implAddress, adminAddress },
      remediation: "Verify the address is a Transparent or UUPS proxy contract.",
    });
    return { result: { status: "completed", findings } };
  }

  const proxyInfo: ProxyInfo = {
    type: proxyType,
    proxyAddress,
    implementationAddress: implAddress,
    ...(hasAdmin ? { adminAddress } : {}),
  };

  return {
    proxyInfo,
    result: { status: "completed", findings },
  };
}
```

### 5. `engine/src/engine.ts` — Orchestrator Shell

The engine class wires together all analyzers. In this phase, only proxy detection is wired. Other analyzers return `{ status: "skipped", reason: "not-yet-implemented" }` as stubs.

```typescript
import { createPublicClient, http } from "viem";
import type { EngineInput, EngineResult, AnalyzerResult } from "./types.js";
import { UpgradoorError } from "./errors.js";
import { detectProxy } from "./analyzers/proxy-detection.js";

export class UpgradoorEngine {
  async analyze(input: EngineInput): Promise<EngineResult> {
    const { proxyAddress, rpcUrl } = input;

    // Validate Foundry is installed (required for later phases)
    await this.validateFoundry();

    const client = createPublicClient({ transport: http(rpcUrl) });

    const analyzerStatus: Record<string, "completed" | "skipped" | "errored"> = {};
    const allFindings = [];

    // Phase 2: Proxy detection
    const proxyResult = await detectProxy(client, proxyAddress as `0x${string}`);
    analyzerStatus["proxy-detection"] = proxyResult.result.status;
    if (proxyResult.result.status === "completed") {
      allFindings.push(...proxyResult.result.findings);
    }

    // Stubs for phase 3+ analyzers
    for (const name of ["storage-layout", "abi-diff", "uups-safety", "transparent-safety", "initializer-integrity", "access-control"]) {
      analyzerStatus[name] = "skipped";
    }

    // Compute verdict (simplified — full logic in phase 5)
    const verdict = allFindings.some(f => f.severity === "CRITICAL") ? "UNSAFE"
      : allFindings.some(f => f.severity === "HIGH") ? "UNSAFE"
      : "INCOMPLETE"; // INCOMPLETE until all analyzers are wired

    return {
      verdict,
      highestSeverity: null,
      findings: allFindings,
      reports: { markdown: "# Report\n\nPhase 2 stub — full report in phase 5." },
      analyzerStatus,
    };
  }

  private async validateFoundry(): Promise<void> {
    const { exec } = await import("child_process");
    const { promisify } = await import("util");
    const execAsync = promisify(exec);
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
```

### 6. `engine/src/check.ts` — CLI Entry Point (Thin Wrapper)

This is what Claude calls via Bash. It reads CLI args, calls the engine, prints JSON to stdout.

```typescript
import { UpgradoorEngine } from "./engine.js";
import { UpgradoorError } from "./errors.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const get = (flag: string): string | undefined => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const proxyAddress = get("--proxy");
  const oldImpl = get("--old");
  const newImpl = get("--new");
  const rpcUrl = get("--rpc");

  if (!proxyAddress || !oldImpl || !newImpl || !rpcUrl) {
    console.error(JSON.stringify({
      error: "INPUT_ERROR",
      message: "Usage: check.js --proxy <addr> --old <path> --new <path> --rpc <url>",
    }));
    process.exit(10);
  }

  try {
    const engine = new UpgradoorEngine();
    const result = await engine.analyze({
      proxyAddress,
      oldImplementationPath: oldImpl,
      newImplementationPath: newImpl,
      rpcUrl,
    });
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    if (err instanceof UpgradoorError) {
      console.error(JSON.stringify({ error: err.code, message: err.message }));
      process.exit(10);
    }
    console.error(JSON.stringify({ error: "RUNTIME_ERROR", message: String(err) }));
    process.exit(12);
  }
}

main();
```

### 7. `engine/src/index.ts` — Public API Exports

```typescript
export { UpgradoorEngine } from "./engine.js";
export type { EngineInput, EngineResult, Finding, Verdict, Severity } from "./types.js";
export { UpgradoorError } from "./errors.js";
```

---

## Verification Steps

```bash
cd engine
npm run build     # must produce dist/check.js
npm run typecheck # zero errors

# Test proxy detection manually (requires an RPC and a real proxy address)
node dist/check.js \
  --proxy 0x... \
  --old ./test-fixtures/V1.sol \
  --new ./test-fixtures/V2.sol \
  --rpc https://eth-mainnet.alchemyapi.io/v2/KEY

# Output should be JSON with verdict, findings, analyzerStatus
```

Unit tests for proxy detection (`engine/tests/proxy-detection.test.ts`):
- Address with beacon slot set → PROXY-001
- Implementation slot = zero address → PROXY-002
- Implementation address with no bytecode → PROXY-003
- Valid UUPS proxy (proxiableUUID in bytecode) → type = "uups"
- Valid Transparent proxy (admin slot set, no proxiableUUID) → type = "transparent"
- No EIP-1967 slots → PROXY-005

---

## Expected Outcome

All of the following must be TRUE before moving to Phase 3:

1. `npm run build` in `engine/` produces `dist/check.js` — the bundle exists on disk.
2. `npm run typecheck` exits 0 — zero TypeScript errors across all new source files.
3. `node dist/check.js` without arguments outputs JSON with `"error": "INPUT_ERROR"` and exits with code 10.
4. `node dist/check.js --proxy 0x<valid-uups-proxy> --old X --new Y --rpc Z` returns JSON where `analyzerStatus["proxy-detection"]` is `"completed"` and the top-level `proxyType` (or equivalent field in findings/proxyInfo) is `"uups"`.
5. Running the same command against a Transparent proxy returns `proxyType` as `"transparent"` with `adminAddress` set to a non-zero address.
6. Running against a proxy whose implementation slot is the zero address returns a finding with `code: "PROXY-002"`.
7. All remaining analyzer statuses are `"skipped"` — stub entries for storage-layout, abi-diff, uups-safety, transparent-safety, initializer-integrity, and access-control.
8. Verdict is `"INCOMPLETE"` — expected because not all analyzers are wired yet.
9. `npm test` exits 0 — all proxy-detection unit test cases pass (beacon → PROXY-001, zero impl → PROXY-002, no bytecode → PROXY-003, UUPS → type=uups, Transparent → type=transparent, no EIP-1967 slots → PROXY-005).

---

## Notes

- `viem` is the only runtime dependency needed in phase 2. Install it with an exact version pin.
- Do not use `@` imports or path aliases — TypeScript bundler moduleResolution handles `.js` extensions.
- The engine orchestrator returns `INCOMPLETE` verdict in phase 2 because not all analyzers run yet. This is expected.
