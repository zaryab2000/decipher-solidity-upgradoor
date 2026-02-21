# Phase 3 — Storage Layout & ABI Extraction via Forge

## Goal

Implement the two resolvers that extract data from Foundry artifacts: `layout-extractor.ts` and `abi-extractor.ts`. These call `forge inspect` and `forge build` to get storage layouts and ABIs for both old and new implementations. At the end of this phase, the engine can extract and compare raw data structures from two `.sol` files.

---

## Deliverables

### 1. `engine/src/utils/forge.ts` — Forge CLI Wrappers

All `forge` subprocess calls go through this file. Never call `child_process.exec` with `forge` commands outside of this module.

```typescript
import { exec } from "child_process";
import { promisify } from "util";
import { UpgradoorError } from "../errors.js";

const execAsync = promisify(exec);

export interface ForgeStorageEntry {
  label: string;
  offset: number;
  slot: string;       // hex string e.g. "0x0"
  type: string;       // type identifier e.g. "t_uint256"
  contract: string;   // fully qualified name e.g. "src/V1.sol:MyContract"
}

export interface ForgeStorageLayout {
  storage: ForgeStorageEntry[];
  types: Record<string, { encoding: string; label: string; numberOfBytes: string }>;
}

export interface ForgeAbiItem {
  type: string;
  name?: string;
  inputs?: Array<{ name: string; type: string; internalType?: string }>;
  outputs?: Array<{ name: string; type: string; internalType?: string }>;
  stateMutability?: string;
  anonymous?: boolean;
}

// Run forge build in the project root
export async function forgeBuild(projectRoot: string): Promise<void> {
  try {
    await execAsync("forge build", { cwd: projectRoot });
  } catch (err) {
    throw new UpgradoorError(
      "FOUNDRY_ERROR",
      `forge build failed: ${String(err)}. Fix compilation errors before running the analyzer.`,
    );
  }
}

// Extract storage layout for a contract
// contractFile: path relative to project root, e.g. "src/V2.sol"
// contractName: e.g. "MyContractV2"
export async function forgeInspectStorageLayout(
  projectRoot: string,
  contractFile: string,
  contractName: string,
): Promise<ForgeStorageLayout> {
  const target = `${contractFile}:${contractName}`;
  try {
    const { stdout } = await execAsync(
      `forge inspect ${target} storage-layout --json`,
      { cwd: projectRoot },
    );
    return JSON.parse(stdout) as ForgeStorageLayout;
  } catch (err) {
    throw new UpgradoorError(
      "FOUNDRY_ERROR",
      `forge inspect storage-layout failed for ${target}: ${String(err)}`,
    );
  }
}

// Extract ABI for a contract
export async function forgeInspectAbi(
  projectRoot: string,
  contractFile: string,
  contractName: string,
): Promise<ForgeAbiItem[]> {
  const target = `${contractFile}:${contractName}`;
  try {
    const { stdout } = await execAsync(
      `forge inspect ${target} abi --json`,
      { cwd: projectRoot },
    );
    return JSON.parse(stdout) as ForgeAbiItem[];
  } catch (err) {
    throw new UpgradoorError(
      "FOUNDRY_ERROR",
      `forge inspect abi failed for ${target}: ${String(err)}`,
    );
  }
}
```

### 2. `engine/src/resolver/layout-extractor.ts` — Storage Layout Extraction

Takes a `.sol` file path + contract name and returns a `CanonicalStorageEntry[]`.

```typescript
import type { CanonicalStorageEntry } from "../types.js";
import type { ForgeStorageLayout } from "../utils/forge.js";
import { forgeInspectStorageLayout } from "../utils/forge.js";
import path from "path";

// Expands type aliases to canonical form
// e.g. "t_uint256" → "uint256", "t_address" → "address"
function canonicalizeType(typeId: string, types: ForgeStorageLayout["types"]): string {
  const entry = types[typeId];
  if (!entry) return typeId;
  return entry.label; // forge already provides the human-readable label
}

export async function extractStorageLayout(
  projectRoot: string,
  solFile: string,      // absolute path or relative to cwd
  contractName: string,
): Promise<CanonicalStorageEntry[]> {
  // Make solFile relative to projectRoot for forge inspect
  const relFile = path.relative(projectRoot, path.resolve(solFile));

  const raw = await forgeInspectStorageLayout(projectRoot, relFile, contractName);

  return raw.storage.map((entry, index) => ({
    slot: parseInt(entry.slot, 16),
    offset: entry.offset,
    length: parseInt(raw.types[entry.type]?.numberOfBytes ?? "32", 10),
    canonicalType: canonicalizeType(entry.type, raw.types),
    label: entry.label,
    contractOrigin: entry.contract,
    inheritanceIndex: index,   // forge returns entries in inheritance order
  }));
}
```

### 3. `engine/src/resolver/abi-extractor.ts` — ABI Extraction

```typescript
import { forgeInspectAbi, type ForgeAbiItem } from "../utils/forge.js";
import path from "path";
import { keccak256, toHex, stringToBytes } from "viem";

export interface NormalizedFunction {
  selector: string;    // 4-byte hex, e.g. "0xabcdef12"
  signature: string;   // human-readable, e.g. "transfer(address,uint256)"
  name: string;
  inputs: string[];    // parameter types only
  outputs: string[];
  stateMutability: string;
}

export interface NormalizedEvent {
  topic0: string;      // keccak256 of event signature
  signature: string;
  name: string;
  inputs: string[];
}

export interface ExtractedAbi {
  functions: NormalizedFunction[];
  events: NormalizedEvent[];
}

function buildSignature(name: string, inputs: Array<{ type: string }>): string {
  return `${name}(${inputs.map(i => i.type).join(",")})`;
}

function computeSelector(signature: string): string {
  const hash = keccak256(toHex(new TextEncoder().encode(signature)));
  return hash.slice(0, 10); // first 4 bytes = 8 hex chars + "0x"
}

export async function extractAbi(
  projectRoot: string,
  solFile: string,
  contractName: string,
): Promise<ExtractedAbi> {
  const relFile = path.relative(projectRoot, path.resolve(solFile));
  const items = await forgeInspectAbi(projectRoot, relFile, contractName);

  const functions: NormalizedFunction[] = [];
  const events: NormalizedEvent[] = [];

  for (const item of items) {
    if (item.type === "function" && item.name) {
      const inputs = item.inputs ?? [];
      const sig = buildSignature(item.name, inputs);
      functions.push({
        selector: computeSelector(sig),
        signature: sig,
        name: item.name,
        inputs: inputs.map(i => i.type),
        outputs: (item.outputs ?? []).map(o => o.type),
        stateMutability: item.stateMutability ?? "nonpayable",
      });
    } else if (item.type === "event" && item.name) {
      const inputs = item.inputs ?? [];
      const sig = buildSignature(item.name, inputs);
      events.push({
        topic0: keccak256(toHex(new TextEncoder().encode(sig))),
        signature: sig,
        name: item.name,
        inputs: inputs.map(i => i.type),
      });
    }
  }

  return { functions, events };
}
```

### 4. `engine/src/resolver/input-resolver.ts` — Orchestrates Both

Takes the `EngineInput` and returns the resolved layouts and ABIs for both implementations.

```typescript
import type { EngineInput, CanonicalStorageEntry } from "../types.js";
import type { ExtractedAbi } from "./abi-extractor.js";
import { extractStorageLayout } from "./layout-extractor.js";
import { extractAbi } from "./abi-extractor.js";
import { forgeBuild } from "../utils/forge.js";
import { UpgradoorError } from "../errors.js";
import path from "path";
import fs from "fs";

export interface ResolvedImplementations {
  projectRoot: string;
  old: {
    layout: CanonicalStorageEntry[];
    abi: ExtractedAbi;
    contractName: string;
    filePath: string;
  };
  new: {
    layout: CanonicalStorageEntry[];
    abi: ExtractedAbi;
    contractName: string;
    filePath: string;
  };
}

// Detect primary contract name from a .sol file (matches filename stem)
function detectContractName(solFile: string): string {
  const stem = path.basename(solFile, ".sol");
  return stem;
}

// Validate that a file exists and is a .sol file
function validateSolFile(filePath: string, role: string): string {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new UpgradoorError("INPUT_ERROR", `${role} file not found: ${filePath}`);
  }
  if (!filePath.endsWith(".sol") && !filePath.endsWith(".json")) {
    throw new UpgradoorError("INPUT_ERROR", `${role} must be a .sol file or Foundry artifact JSON: ${filePath}`);
  }
  return resolved;
}

// Find project root by locating foundry.toml or package.json
function findProjectRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "foundry.toml")) || fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export async function resolveImplementations(
  input: EngineInput,
): Promise<ResolvedImplementations> {
  const oldPath = validateSolFile(input.oldImplementationPath, "Old implementation");
  const newPath = validateSolFile(input.newImplementationPath, "New implementation");

  const projectRoot = findProjectRoot(path.dirname(newPath));

  // Build the project (compiles new implementation, artifacts go to out/)
  await forgeBuild(projectRoot);

  const oldContractName = input.options?.contractName ?? detectContractName(oldPath);
  const newContractName = input.options?.contractName ?? detectContractName(newPath);

  const [oldLayout, oldAbi, newLayout, newAbi] = await Promise.all([
    extractStorageLayout(projectRoot, oldPath, oldContractName),
    extractAbi(projectRoot, oldPath, oldContractName),
    extractStorageLayout(projectRoot, newPath, newContractName),
    extractAbi(projectRoot, newPath, newContractName),
  ]);

  return {
    projectRoot,
    old: { layout: oldLayout, abi: oldAbi, contractName: oldContractName, filePath: oldPath },
    new: { layout: newLayout, abi: newAbi, contractName: newContractName, filePath: newPath },
  };
}
```

### 5. Wire into `engine.ts`

Update the engine to call `resolveImplementations` before running analyzers:

```typescript
// In engine.ts analyze() method, after validateFoundry():
const resolved = await resolveImplementations(input);
// Pass resolved.old and resolved.new to each analyzer in phase 4
```

---

## Verification Steps

```bash
cd engine
npm run build
npm run typecheck

# Run against a real Foundry project with two sol files
node dist/check.js \
  --proxy 0x... \
  --old ./test-fixtures/MyContractV1.sol \
  --new ./test-fixtures/MyContractV2.sol \
  --rpc https://...

# Expect: JSON output with analyzerStatus showing "completed" for proxy-detection
# storage-layout and abi-diff still "skipped" (phase 4)
```

Unit tests for `layout-extractor.ts`:
- Correct slot/offset/type parsing for simple contracts
- Type canonicalization (uint alias expansion)
- Multiple inherited contracts appear in order

Unit tests for `abi-extractor.ts`:
- Function selector computation matches known values (transfer = 0xa9059cbb)
- Event topic0 computation matches known values
- Constructor and fallback are excluded from functions list

---

## Expected Outcome

All of the following must be TRUE before moving to Phase 4:

1. `npm run build` exits 0 — no compile errors in `forge.ts`, `layout-extractor.ts`, `abi-extractor.ts`, or `input-resolver.ts`.
2. `npm run typecheck` exits 0 — zero TypeScript errors across all new source files.
3. Running `node dist/check.js` against a real Foundry project with two `.sol` files completes without throwing — the `forge` subprocess ran successfully (even if findings are empty).
4. `analyzerStatus["proxy-detection"]` is `"completed"` in the JSON output — proxy detection still works end-to-end after the resolver is wired in.
5. The JSON output contains `resolved.old.layout` and `resolved.new.layout` arrays with at least one entry each when the fixture contracts declare storage variables — confirming `forgeInspectStorageLayout` returned parseable data.
6. Unit test: `extractAbi` for a contract with `transfer(address,uint256)` returns a function entry with `selector: "0xa9059cbb"`.
7. Unit test: `extractStorageLayout` for a single-variable contract returns an entry with `slot: 0` and `offset: 0`.
8. Unit test: `findProjectRoot` returns the directory containing `foundry.toml` when called from a subdirectory of that project.
9. `analyzerStatus["storage-layout"]` and `analyzerStatus["abi-diff"]` are both `"skipped"` — Phase 4 analyzers not yet wired.

---

## Notes

- `forge inspect` requires the project to have been built first. Always call `forgeBuild()` before `forgeInspectStorageLayout()` or `forgeInspectAbi()`.
- The `out/` directory must exist. If the user's project has never been built, `forge build` will create it.
- For `.json` artifact files as old implementation path: `forge inspect` can target artifact files directly using the `<file>:<contract>` format. The layout-extractor handles this transparently — no special case needed.
- Do not use `child_process.exec` outside `forge.ts`. All subprocess calls are centralized.
