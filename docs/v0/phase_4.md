# Phase 4 — Core Analyzers

## Goal

Implement all six analyzers that run on resolved implementation data: storage layout, ABI diff, UUPS safety, transparent proxy safety, initializer integrity, and access control regression. At the end of this phase, the engine runs a complete analysis pipeline and returns a full `findings` array.

---

## Deliverables

Each analyzer is a pure function: takes resolved data, returns `AnalyzerResult`. No side-effects. No network calls. No subprocess calls. All heavy lifting was done in phase 3 (forge calls) and phase 2 (RPC calls).

---

### 1. `engine/src/analyzers/storage-layout.ts`

Compares `old.layout` vs `new.layout` slot-by-slot.

```typescript
import type { CanonicalStorageEntry, AnalyzerResult, Finding } from "../types.js";

export function analyzeStorageLayout(
  oldLayout: CanonicalStorageEntry[],
  newLayout: CanonicalStorageEntry[],
): AnalyzerResult {
  const findings: Finding[] = [];

  // Build maps keyed by slot+offset for fast lookup
  const oldBySlotOffset = new Map(
    oldLayout.map(e => [`${e.slot}:${e.offset}`, e]),
  );
  const newBySlotOffset = new Map(
    newLayout.map(e => [`${e.slot}:${e.offset}`, e]),
  );

  // STOR-001: Variable deleted (exists in old, not in new at same slot+offset)
  for (const [key, oldEntry] of oldBySlotOffset) {
    if (!newBySlotOffset.has(key)) {
      findings.push({
        code: "STOR-001",
        severity: "CRITICAL",
        confidence: "HIGH_CONFIDENCE",
        title: "Storage variable deleted",
        description: `Variable "${oldEntry.label}" at slot ${oldEntry.slot} offset ${oldEntry.offset} was deleted in the new implementation.`,
        details: { slot: oldEntry.slot, offset: oldEntry.offset, label: oldEntry.label, type: oldEntry.canonicalType },
        location: { slot: oldEntry.slot, offset: oldEntry.offset, contract: oldEntry.contractOrigin },
        remediation: "Do not delete storage variables in upgrades. Mark as unused or replace with a padding variable of the same size.",
      });
      continue;
    }
    const newEntry = newBySlotOffset.get(key)!;

    // STOR-003: Type width changed at same slot+offset
    if (oldEntry.length !== newEntry.length) {
      findings.push({
        code: "STOR-003",
        severity: "CRITICAL",
        confidence: "HIGH_CONFIDENCE",
        title: "Storage variable type width changed",
        description: `Variable at slot ${oldEntry.slot} changed size: ${oldEntry.canonicalType} (${oldEntry.length} bytes) → ${newEntry.canonicalType} (${newEntry.length} bytes).`,
        details: { slot: oldEntry.slot, oldType: oldEntry.canonicalType, newType: newEntry.canonicalType, oldLength: oldEntry.length, newLength: newEntry.length },
        location: { slot: oldEntry.slot, offset: oldEntry.offset },
        remediation: "Changing the size of a storage variable corrupts all subsequent slots. Use a new variable appended at the end instead.",
      });
    }

    // STOR-004: Type semantics changed (same width, different type)
    else if (oldEntry.canonicalType !== newEntry.canonicalType) {
      findings.push({
        code: "STOR-004",
        severity: "CRITICAL",
        confidence: "HIGH_CONFIDENCE",
        title: "Storage variable type semantics changed",
        description: `Variable "${oldEntry.label}" at slot ${oldEntry.slot} changed type from ${oldEntry.canonicalType} to ${newEntry.canonicalType}.`,
        details: { slot: oldEntry.slot, oldType: oldEntry.canonicalType, newType: newEntry.canonicalType },
        location: { slot: oldEntry.slot, offset: oldEntry.offset },
        remediation: "Type changes reinterpret existing on-chain data. Even if sizes match, semantics differ. Add a new variable instead.",
      });
    }

    // STOR-010: Renamed (same slot+offset+type, different label) — LOW
    else if (oldEntry.label !== newEntry.label) {
      findings.push({
        code: "STOR-010",
        severity: "LOW",
        confidence: "HIGH_CONFIDENCE",
        title: "Storage variable renamed",
        description: `Variable renamed from "${oldEntry.label}" to "${newEntry.label}" at slot ${oldEntry.slot}.`,
        details: { slot: oldEntry.slot, oldLabel: oldEntry.label, newLabel: newEntry.label },
        location: { slot: oldEntry.slot },
        remediation: "Renaming is safe — same slot, offset, and type. No action required.",
      });
    }
  }

  // STOR-002: Variable inserted in middle (new entry at a slot that shifts others)
  // Detect by checking if any new slot+offset combination didn't exist and is < the max old slot
  const maxOldSlot = Math.max(...oldLayout.map(e => e.slot), 0);
  for (const newEntry of newLayout) {
    if (!oldBySlotOffset.has(`${newEntry.slot}:${newEntry.offset}`) && newEntry.slot <= maxOldSlot) {
      findings.push({
        code: "STOR-002",
        severity: "CRITICAL",
        confidence: "HIGH_CONFIDENCE",
        title: "Storage variable inserted in middle",
        description: `New variable "${newEntry.label}" inserted at slot ${newEntry.slot} (within existing layout). This shifts all subsequent variables.`,
        details: { slot: newEntry.slot, label: newEntry.label, type: newEntry.canonicalType },
        location: { slot: newEntry.slot },
        remediation: "Never insert variables in the middle of the storage layout. Append new variables after the last existing slot.",
      });
    }
  }

  // STOR-009: New variable appended (safe if gap was decremented correctly)
  const newVars = newLayout.filter(e => !oldBySlotOffset.has(`${e.slot}:${e.offset}`) && e.slot > maxOldSlot);
  if (newVars.length > 0) {
    findings.push({
      code: "STOR-009",
      severity: "MEDIUM",
      confidence: "HIGH_CONFIDENCE",
      title: "New storage variable(s) appended",
      description: `${newVars.length} new variable(s) appended after the existing layout.`,
      details: { newVariables: newVars.map(v => ({ slot: v.slot, label: v.label, type: v.canonicalType })) },
      remediation: "Ensure the storage gap (if any) was decremented by the correct number of slots.",
    });
  }

  // STOR-005: Struct field reordering — compare struct types that appear in both layouts
  // (Simplified: detect if the same slot has a different ordering of struct fields)
  // Full implementation requires parsing struct type definitions from forge output.
  // For v0, this is a best-effort check based on type label changes within the same slot.

  // Gap validation (STOR-007, STOR-008)
  validateGaps(oldLayout, newLayout, findings);

  return { status: "completed", findings };
}

function validateGaps(
  oldLayout: CanonicalStorageEntry[],
  newLayout: CanonicalStorageEntry[],
  findings: Finding[],
): void {
  // Find gap arrays: label ends with "gap" (case-insensitive), type is uint256[]
  const gapRegex = /gap$/i;
  const oldGaps = oldLayout.filter(e => gapRegex.test(e.label) && e.canonicalType.startsWith("uint256["));
  const newGaps = newLayout.filter(e => gapRegex.test(e.label) && e.canonicalType.startsWith("uint256["));

  for (const oldGap of oldGaps) {
    const oldN = extractArraySize(oldGap.canonicalType);
    const matchingNewGap = newGaps.find(g => g.contractOrigin === oldGap.contractOrigin);

    if (!matchingNewGap) {
      // STOR-008: Gap removed entirely
      findings.push({
        code: "STOR-008",
        severity: "HIGH",
        confidence: "HIGH_CONFIDENCE",
        title: "Storage gap removed",
        description: `Storage gap "${oldGap.label}" in ${oldGap.contractOrigin} was removed entirely in the new implementation.`,
        details: { oldGapSize: oldN, contract: oldGap.contractOrigin },
        location: { slot: oldGap.slot, contract: oldGap.contractOrigin },
        remediation: "Do not remove storage gaps. If adding new variables, decrement the gap size by the number of new slots consumed.",
      });
      continue;
    }

    const newN = extractArraySize(matchingNewGap.canonicalType);
    // Count new variables added after the gap in the same contract
    const newVarsAfterGap = newLayout.filter(e =>
      e.contractOrigin === oldGap.contractOrigin &&
      e.slot > oldGap.slot &&
      !gapRegex.test(e.label),
    ).length;

    if (newN + newVarsAfterGap < oldN) {
      // STOR-007: Gap shrank more than variables added
      findings.push({
        code: "STOR-007",
        severity: "HIGH",
        confidence: "HIGH_CONFIDENCE",
        title: "Storage gap insufficient",
        description: `Gap shrank by ${oldN - newN} slots but only ${newVarsAfterGap} new variable(s) added. Expected ${newN} + ${newVarsAfterGap} = ${newN + newVarsAfterGap} >= ${oldN}.`,
        details: { oldGapSize: oldN, newGapSize: newN, newVarsAdded: newVarsAfterGap },
        location: { slot: matchingNewGap.slot, contract: oldGap.contractOrigin },
        remediation: "The gap must decrease by exactly the number of new storage slots used. Check that N_new + V_new == N_old.",
      });
    }
  }
}

function extractArraySize(canonicalType: string): number {
  // "uint256[50]" → 50
  const match = canonicalType.match(/\[(\d+)\]/);
  return match ? parseInt(match[1]!, 10) : 0;
}
```

---

### 2. `engine/src/analyzers/abi-diff.ts`

Compares old vs new ABI. Detects removed selectors, collisions, signature changes.

```typescript
import type { AnalyzerResult, Finding } from "../types.js";
import type { ExtractedAbi } from "../resolver/abi-extractor.js";

export function analyzeAbiDiff(
  oldAbi: ExtractedAbi,
  newAbi: ExtractedAbi,
): AnalyzerResult {
  const findings: Finding[] = [];

  const oldFunctions = new Map(oldAbi.functions.map(f => [f.selector, f]));
  const newFunctions = new Map(newAbi.functions.map(f => [f.selector, f]));

  // ABI-001: Function selector removed
  for (const [selector, fn] of oldFunctions) {
    if (!newFunctions.has(selector)) {
      // Check if name still exists with different params (ABI-003) vs removed entirely (ABI-001)
      const sameNameInNew = newAbi.functions.find(f => f.name === fn.name);
      if (sameNameInNew) {
        findings.push({
          code: "ABI-003",
          severity: "HIGH",
          confidence: "HIGH_CONFIDENCE",
          title: "Function signature changed",
          description: `Function "${fn.name}" changed signature: (${fn.inputs.join(",")}) → (${sameNameInNew.inputs.join(",")}).`,
          details: { oldSignature: fn.signature, newSignature: sameNameInNew.signature },
          location: { function: fn.name },
          remediation: "Changing function parameters breaks all callers. Add a new function name instead of changing the signature.",
        });
      } else {
        findings.push({
          code: "ABI-001",
          severity: "HIGH",
          confidence: "HIGH_CONFIDENCE",
          title: "Function selector removed",
          description: `Function "${fn.name}" (selector ${selector}) was removed from the new implementation.`,
          details: { selector, signature: fn.signature },
          location: { function: fn.name },
          remediation: "Removing a function breaks all callers. Keep the function or ensure no external contracts depend on it.",
        });
      }
    }
  }

  // ABI-002: Selector collision (two different functions in new impl with same selector)
  const newSelectors = new Map<string, string>();
  for (const fn of newAbi.functions) {
    if (newSelectors.has(fn.selector)) {
      findings.push({
        code: "ABI-002",
        severity: "CRITICAL",
        confidence: "HIGH_CONFIDENCE",
        title: "Function selector collision",
        description: `Two functions in the new implementation share selector ${fn.selector}: "${newSelectors.get(fn.selector)}" and "${fn.signature}".`,
        details: { selector: fn.selector, function1: newSelectors.get(fn.selector), function2: fn.signature },
        remediation: "Rename one of the functions to eliminate the 4-byte selector collision.",
      });
    } else {
      newSelectors.set(fn.selector, fn.signature);
    }
  }

  // ABI-004: Return type changed (same selector in both, but output types differ)
  for (const [selector, oldFn] of oldFunctions) {
    const newFn = newFunctions.get(selector);
    if (newFn && JSON.stringify(oldFn.outputs) !== JSON.stringify(newFn.outputs)) {
      findings.push({
        code: "ABI-004",
        severity: "MEDIUM",
        confidence: "HIGH_CONFIDENCE",
        title: "Return type changed",
        description: `Function "${oldFn.name}" return type changed from (${oldFn.outputs.join(",")}) to (${newFn.outputs.join(",")}).`,
        details: { selector, oldOutputs: oldFn.outputs, newOutputs: newFn.outputs },
        location: { function: oldFn.name },
        remediation: "Callers that decode return values will break. Review all callers of this function.",
      });
    }
  }

  // ABI-005: New function added (LOW — informational)
  for (const [selector, fn] of newFunctions) {
    if (!oldFunctions.has(selector)) {
      findings.push({
        code: "ABI-005",
        severity: "LOW",
        confidence: "HIGH_CONFIDENCE",
        title: "New function added",
        description: `Function "${fn.name}" (selector ${selector}) was added in the new implementation.`,
        details: { selector, signature: fn.signature },
        location: { function: fn.name },
        remediation: "New functions are generally safe. Ensure they have appropriate access control if they modify state.",
      });
    }
  }

  // ABI-006: Event signature changed
  const oldEvents = new Map(oldAbi.events.map(e => [e.topic0, e]));
  const newEvents = new Map(newAbi.events.map(e => [e.topic0, e]));
  for (const [topic, oldEvent] of oldEvents) {
    if (!newEvents.has(topic)) {
      const sameNameInNew = newAbi.events.find(e => e.name === oldEvent.name);
      if (sameNameInNew) {
        findings.push({
          code: "ABI-006",
          severity: "HIGH",
          confidence: "HIGH_CONFIDENCE",
          title: "Event signature changed",
          description: `Event "${oldEvent.name}" signature changed. Off-chain listeners using the old topic will miss events.`,
          details: { oldSignature: oldEvent.signature, newSignature: sameNameInNew.signature },
          remediation: "Update all off-chain indexers to use the new event signature.",
        });
      } else {
        findings.push({
          code: "ABI-007",
          severity: "MEDIUM",
          confidence: "HIGH_CONFIDENCE",
          title: "Event removed",
          description: `Event "${oldEvent.name}" (topic ${topic}) was removed. Off-chain listeners will miss these events.`,
          details: { topic, signature: oldEvent.signature },
          remediation: "If off-chain systems index this event, removing it breaks their data pipelines.",
        });
      }
    }
  }

  return { status: "completed", findings };
}
```

---

### 3. `engine/src/analyzers/uups-safety.ts`

Checks `_authorizeUpgrade` presence and access control. AST loaded from forge build artifacts.

```typescript
import type { AnalyzerResult, Finding } from "../types.js";
import { readFileSync, existsSync } from "fs";
import path from "path";

// Load AST from forge build artifacts (out/<ContractFile>/<ContractName>.json)
function loadBuildArtifact(projectRoot: string, contractFile: string, contractName: string): object | null {
  const artifactPath = path.join(
    projectRoot,
    "out",
    path.basename(contractFile),
    `${contractName}.json`,
  );
  if (!existsSync(artifactPath)) return null;
  return JSON.parse(readFileSync(artifactPath, "utf-8"));
}

// Extract function definitions from AST nodes
function findFunctionInAst(ast: object, functionName: string): object | null {
  // Walk the AST tree looking for FunctionDefinition nodes
  const walk = (node: unknown): object | null => {
    if (!node || typeof node !== "object") return null;
    const n = node as Record<string, unknown>;
    if (n["nodeType"] === "FunctionDefinition" && n["name"] === functionName) {
      return n as object;
    }
    for (const value of Object.values(n)) {
      const found = walk(value);
      if (found) return found;
    }
    return null;
  };
  return walk(ast);
}

// Check if a function definition has access control (modifier or require on msg.sender)
function hasAccessControl(fnNode: object): boolean {
  const fn = fnNode as Record<string, unknown>;
  // Check for modifiers
  const modifiers = fn["modifiers"] as Array<{ modifierName?: { name?: string } }> | undefined;
  if (modifiers && modifiers.length > 0) {
    const accessModifiers = ["onlyOwner", "onlyRole", "onlyAdmin", "auth", "authorized", "guard"];
    if (modifiers.some(m => accessModifiers.some(am => m.modifierName?.name?.toLowerCase().includes(am.toLowerCase())))) {
      return true;
    }
  }
  // Check for require/revert with msg.sender in body (simplified: look for "msg.sender" text reference)
  const bodyText = JSON.stringify(fn["body"] ?? {});
  return bodyText.includes("msg.sender") || bodyText.includes("_msgSender");
}

export async function analyzeUupsSafety(
  projectRoot: string,
  newContractFile: string,
  newContractName: string,
): Promise<AnalyzerResult> {
  const findings: Finding[] = [];

  const artifact = loadBuildArtifact(projectRoot, newContractFile, newContractName);
  if (!artifact) {
    return { status: "errored", error: `Build artifact not found for ${newContractName}. Run forge build first.` };
  }

  const fnNode = findFunctionInAst(artifact, "_authorizeUpgrade");

  if (!fnNode) {
    findings.push({
      code: "UUPS-001",
      severity: "CRITICAL",
      confidence: "HIGH_CONFIDENCE",
      title: "_authorizeUpgrade not found",
      description: "The new implementation does not define or inherit _authorizeUpgrade. UUPS proxies require this function to authorize upgrades.",
      details: { contractName: newContractName },
      remediation: "Add `function _authorizeUpgrade(address) internal override onlyOwner {}` to the contract.",
    });
    return { status: "completed", findings };
  }

  const fn = fnNode as Record<string, unknown>;
  const body = fn["body"] as Record<string, unknown> | null;

  if (!body || !body["statements"] || (body["statements"] as unknown[]).length === 0) {
    findings.push({
      code: "UUPS-002",
      severity: "CRITICAL",
      confidence: "HIGH_CONFIDENCE",
      title: "_authorizeUpgrade has empty body",
      description: "The _authorizeUpgrade function exists but has an empty body. Anyone can call upgradeTo() to upgrade the proxy.",
      details: { contractName: newContractName },
      remediation: "Add access control: `function _authorizeUpgrade(address) internal override onlyOwner {}`",
    });
    return { status: "completed", findings };
  }

  if (!hasAccessControl(fnNode)) {
    findings.push({
      code: "UUPS-003",
      severity: "CRITICAL",
      confidence: "HIGH_CONFIDENCE",
      title: "_authorizeUpgrade has no access control",
      description: "The _authorizeUpgrade function has a body but no detectable access control modifier or msg.sender check.",
      details: { contractName: newContractName },
      remediation: "Add `onlyOwner` or equivalent access control modifier to _authorizeUpgrade.",
    });
  }

  return { status: "completed", findings };
}
```

---

### 4. `engine/src/analyzers/transparent-safety.ts`

```typescript
import type { AnalyzerResult, Finding, ProxyInfo } from "../types.js";
import type { ExtractedAbi } from "../resolver/abi-extractor.js";

// Known proxy admin selectors (OZ TransparentUpgradeableProxy v4/v5)
const ADMIN_SELECTORS = new Map([
  ["0x3659cfe6", "upgradeTo(address)"],
  ["0x4f1ef286", "upgradeToAndCall(address,bytes)"],
  ["0x8f283970", "changeAdmin(address)"],
  ["0xf851a440", "admin()"],
  ["0x5c60da1b", "implementation()"],
]);

export async function analyzeTransparentSafety(
  proxyInfo: ProxyInfo,
  newAbi: ExtractedAbi,
): Promise<AnalyzerResult> {
  const findings: Finding[] = [];
  const adminAddress = proxyInfo.adminAddress;

  // TPROXY-001: Admin slot is zero address
  if (!adminAddress || adminAddress === "0x0000000000000000000000000000000000000000") {
    findings.push({
      code: "TPROXY-001",
      severity: "CRITICAL",
      confidence: "HIGH_CONFIDENCE",
      title: "Admin slot is zero address",
      description: "The proxy admin slot contains the zero address. No one can upgrade this proxy.",
      details: { adminAddress },
      remediation: "Verify the proxy was deployed correctly with a valid admin address.",
    });
  }

  // TPROXY-002: New impl contains upgradeTo/upgradeToAndCall (pattern conflict)
  const hasUpgradeFunctions = newAbi.functions.some(
    f => f.name === "upgradeTo" || f.name === "upgradeToAndCall",
  );
  if (hasUpgradeFunctions) {
    findings.push({
      code: "TPROXY-002",
      severity: "HIGH",
      confidence: "HIGH_CONFIDENCE",
      title: "Implementation contains upgrade functions (pattern conflict)",
      description: "The new implementation defines upgradeTo or upgradeToAndCall. In a Transparent proxy, these should only exist in the proxy itself, not the implementation.",
      details: {},
      remediation: "Remove upgradeTo/upgradeToAndCall from the implementation contract. These are proxy-level functions.",
    });
  }

  // TPROXY-003: Admin is EOA (not a ProxyAdmin contract)
  // In v0: cannot reliably detect without calling admin.bytecode check via RPC.
  // This check is done if proxyInfo contains adminAddress and admin has no code.
  // Skipped in v0 since it requires an additional RPC call not currently wired.

  // TPROXY-004: Implementation selector collides with admin selectors
  for (const fn of newAbi.functions) {
    if (ADMIN_SELECTORS.has(fn.selector)) {
      findings.push({
        code: "TPROXY-004",
        severity: "HIGH",
        confidence: "HIGH_CONFIDENCE",
        title: "Selector collision with proxy admin function",
        description: `Implementation function "${fn.name}" (selector ${fn.selector}) collides with proxy admin function "${ADMIN_SELECTORS.get(fn.selector)}". Admin calls will be intercepted by the proxy.`,
        details: { selector: fn.selector, implFunction: fn.name, adminFunction: ADMIN_SELECTORS.get(fn.selector) },
        location: { function: fn.name },
        remediation: "Rename the implementation function to avoid the 4-byte selector collision.",
      });
    }
  }

  return { status: "completed", findings };
}
```

---

### 5. `engine/src/analyzers/initializer-integrity.ts`

```typescript
import type { AnalyzerResult, Finding } from "../types.js";
import { readFileSync, existsSync } from "fs";
import path from "path";

// Same AST loading helper as uups-safety (consider extracting to shared util in v1)
function loadAst(projectRoot: string, contractFile: string, contractName: string): object | null {
  const p = path.join(projectRoot, "out", path.basename(contractFile), `${contractName}.json`);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8"));
}

function findNodesOfType(ast: unknown, nodeType: string): object[] {
  const results: object[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (n["nodeType"] === nodeType) results.push(n as object);
    for (const v of Object.values(n)) walk(v);
  };
  walk(ast);
  return results;
}

export async function analyzeInitializerIntegrity(
  projectRoot: string,
  newContractFile: string,
  newContractName: string,
): Promise<AnalyzerResult> {
  const findings: Finding[] = [];

  const artifact = loadAst(projectRoot, newContractFile, newContractName);
  if (!artifact) {
    return { status: "errored", error: `Build artifact not found for ${newContractName}` };
  }

  const functions = findNodesOfType(artifact, "FunctionDefinition") as Array<Record<string, unknown>>;

  // INIT-001: Constructor writes to storage
  const constructors = functions.filter(f => f["kind"] === "constructor");
  for (const ctor of constructors) {
    const bodyStr = JSON.stringify(ctor["body"] ?? {});
    // Look for ExpressionStatement with Assignment as body (simplified detection)
    const hasStorageWrite = findNodesOfType(ctor, "Assignment").length > 0;
    if (hasStorageWrite) {
      findings.push({
        code: "INIT-001",
        severity: "CRITICAL",
        confidence: "HIGH_CONFIDENCE",
        title: "Constructor writes to storage",
        description: "The constructor contains storage writes. In upgradeable contracts, constructors run only once on the implementation — storage in the proxy is unaffected.",
        details: { contractName: newContractName },
        remediation: "Move initialization logic from the constructor to an `initialize()` function with the `initializer` modifier.",
      });
    }
  }

  // INIT-005: _disableInitializers() not called in constructor
  const hasDisableInitializers = constructors.some(ctor =>
    JSON.stringify(ctor["body"] ?? {}).includes("_disableInitializers"),
  );
  if (!hasDisableInitializers && constructors.length > 0) {
    findings.push({
      code: "INIT-005",
      severity: "MEDIUM",
      confidence: "HIGH_CONFIDENCE",
      title: "_disableInitializers() not called in constructor",
      description: "The implementation constructor does not call _disableInitializers(). Without this, someone could call initialize() on the bare implementation contract.",
      details: { contractName: newContractName },
      remediation: "Add `constructor() { _disableInitializers(); }` to the implementation contract.",
    });
  }

  // INIT-002: No initializer/reinitializer modifier found
  const initializerFunctions = functions.filter(f => {
    const modifiers = f["modifiers"] as Array<{ modifierName?: { name?: string } }> | undefined;
    return modifiers?.some(m => ["initializer", "reinitializer"].includes(m.modifierName?.name ?? ""));
  });

  if (initializerFunctions.length === 0) {
    findings.push({
      code: "INIT-002",
      severity: "HIGH",
      confidence: "HIGH_CONFIDENCE",
      title: "No initializer or reinitializer modifier found",
      description: "The new implementation has no function with the `initializer` or `reinitializer` modifier.",
      details: { contractName: newContractName },
      remediation: "Add an `initialize()` function with the `initializer` modifier (for new deployments) or a `reinitialize()` function with the `reinitializer` modifier (for upgrades).",
    });
  }

  // INIT-006: Multiple functions have initializer modifier
  const multipleInitializers = initializerFunctions.filter(f => {
    const mods = f["modifiers"] as Array<{ modifierName?: { name?: string } }> | undefined;
    return mods?.some(m => m.modifierName?.name === "initializer");
  });
  if (multipleInitializers.length > 1) {
    findings.push({
      code: "INIT-006",
      severity: "HIGH",
      confidence: "HIGH_CONFIDENCE",
      title: "Multiple functions with initializer modifier",
      description: `${multipleInitializers.length} functions have the \`initializer\` modifier. Only one initializer function is allowed.`,
      details: { functions: multipleInitializers.map(f => f["name"]) },
      remediation: "Remove duplicate initializer modifiers. Use `reinitializer` for subsequent initialization functions.",
    });
  }

  // INIT-003: Reinitializer version regression
  // Check that reinitializer(N) in new impl has N > existing version (simplified: compare constants)
  // Full implementation requires reading the proxy's initialized storage slot. Deferred to v1.

  return { status: "completed", findings };
}
```

---

### 6. `engine/src/analyzers/access-control-regression.ts`

```typescript
import type { AnalyzerResult, Finding } from "../types.js";
import { readFileSync, existsSync } from "fs";
import path from "path";

const ACCESS_CONTROL_MODIFIER_KEYWORDS = ["only", "auth", "authorized", "owner", "admin", "role", "guard"];

function isAccessControlModifier(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCESS_CONTROL_MODIFIER_KEYWORDS.some(kw => lower.includes(kw));
}

function loadFunctions(projectRoot: string, contractFile: string, contractName: string): Array<Record<string, unknown>> {
  const p = path.join(projectRoot, "out", path.basename(contractFile), `${contractName}.json`);
  if (!existsSync(p)) return [];
  const artifact = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
  const fns: Array<Record<string, unknown>> = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (n["nodeType"] === "FunctionDefinition") fns.push(n);
    for (const v of Object.values(n)) walk(v);
  };
  walk(artifact);
  return fns;
}

type FunctionMap = Map<string, {
  visibility: string;
  modifiers: string[];
  hasMsgSenderCheck: boolean;
}>;

function buildFunctionMap(functions: Array<Record<string, unknown>>): FunctionMap {
  const map: FunctionMap = new Map();
  for (const fn of functions) {
    const name = fn["name"] as string | undefined;
    if (!name) continue;
    const modifiers = (fn["modifiers"] as Array<{ modifierName?: { name?: string } }> ?? [])
      .map(m => m.modifierName?.name ?? "")
      .filter(Boolean);
    const bodyStr = JSON.stringify(fn["body"] ?? {});
    map.set(name, {
      visibility: fn["visibility"] as string ?? "internal",
      modifiers,
      hasMsgSenderCheck: bodyStr.includes("msg.sender") || bodyStr.includes("_msgSender"),
    });
  }
  return map;
}

export async function analyzeAccessControlRegression(
  projectRoot: string,
  oldContractFile: string,
  oldContractName: string,
  newContractFile: string,
  newContractName: string,
): Promise<AnalyzerResult> {
  const findings: Finding[] = [];

  const oldFunctions = loadFunctions(projectRoot, oldContractFile, oldContractName);
  const newFunctions = loadFunctions(projectRoot, newContractFile, newContractName);

  const oldMap = buildFunctionMap(oldFunctions);
  const newMap = buildFunctionMap(newFunctions);

  for (const [fnName, oldFn] of oldMap) {
    const newFn = newMap.get(fnName);
    if (!newFn) continue; // function removed — ABI diff handles this

    // ACL-001: onlyOwner removed
    const hadOnlyOwner = oldFn.modifiers.includes("onlyOwner");
    const hasOnlyOwner = newFn.modifiers.includes("onlyOwner");
    if (hadOnlyOwner && !hasOnlyOwner) {
      findings.push({
        code: "ACL-001",
        severity: "CRITICAL",
        confidence: "HIGH_CONFIDENCE",
        title: "onlyOwner modifier removed",
        description: `Function "${fnName}" had \`onlyOwner\` in the old implementation but not in the new one.`,
        details: { function: fnName },
        location: { function: fnName },
        remediation: "Restore the onlyOwner modifier or replace it with equivalent access control.",
      });
    }

    // ACL-002: onlyRole removed
    const hadOnlyRole = oldFn.modifiers.some(m => m.startsWith("onlyRole"));
    const hasOnlyRole = newFn.modifiers.some(m => m.startsWith("onlyRole"));
    if (hadOnlyRole && !hasOnlyRole) {
      findings.push({
        code: "ACL-002",
        severity: "CRITICAL",
        confidence: "HIGH_CONFIDENCE",
        title: "onlyRole modifier removed",
        description: `Function "${fnName}" had a role-based access modifier in the old implementation but not in the new one.`,
        details: { function: fnName, oldModifiers: oldFn.modifiers, newModifiers: newFn.modifiers },
        location: { function: fnName },
        remediation: "Restore the role-based access control modifier.",
      });
    }

    // ACL-003: Custom access control modifier removed
    const hadCustom = oldFn.modifiers.some(isAccessControlModifier);
    const hasCustom = newFn.modifiers.some(isAccessControlModifier);
    if (hadCustom && !hasCustom && !hadOnlyOwner && !hadOnlyRole) {
      findings.push({
        code: "ACL-003",
        severity: "HIGH",
        confidence: "HIGH_CONFIDENCE",
        title: "Custom access control modifier removed",
        description: `Function "${fnName}" had a custom access control modifier (${oldFn.modifiers.join(", ")}) in the old implementation.`,
        details: { function: fnName, oldModifiers: oldFn.modifiers },
        location: { function: fnName },
        remediation: "Verify that the removal of this modifier is intentional and that the function is still appropriately protected.",
      });
    }

    // ACL-004: Visibility widened (internal → public/external)
    const wasInternal = oldFn.visibility === "internal" || oldFn.visibility === "private";
    const isNowPublic = newFn.visibility === "public" || newFn.visibility === "external";
    if (wasInternal && isNowPublic) {
      findings.push({
        code: "ACL-004",
        severity: "HIGH",
        confidence: "HIGH_CONFIDENCE",
        title: "Function visibility widened",
        description: `Function "${fnName}" was ${oldFn.visibility} in the old implementation and is now ${newFn.visibility}. Anyone can call it.`,
        details: { function: fnName, oldVisibility: oldFn.visibility, newVisibility: newFn.visibility },
        location: { function: fnName },
        remediation: "Verify this visibility change is intentional. Add access control if the function modifies privileged state.",
      });
    }

    // ACL-007: _authorizeUpgrade access control weakened (fires alongside UUPS-004)
    if (fnName === "_authorizeUpgrade") {
      const hadAccessControl = oldFn.modifiers.some(isAccessControlModifier) || oldFn.hasMsgSenderCheck;
      const hasAccessControl = newFn.modifiers.some(isAccessControlModifier) || newFn.hasMsgSenderCheck;
      if (hadAccessControl && !hasAccessControl) {
        findings.push({
          code: "ACL-007",
          severity: "CRITICAL",
          confidence: "HIGH_CONFIDENCE",
          title: "_authorizeUpgrade access control weakened",
          description: "The old implementation had access control on _authorizeUpgrade, but the new implementation does not.",
          details: { function: fnName },
          location: { function: fnName },
          remediation: "Restore access control to _authorizeUpgrade.",
        });
      }
    }
  }

  return { status: "completed", findings };
}
```

---

### 7. Wire All Analyzers into `engine.ts`

Update `engine.ts` to call all six analyzers after resolution:

```typescript
// After resolveImplementations():
const [
  storageResult,
  abiResult,
  uupsOrTransparentResult,
  initResult,
  aclResult,
] = await Promise.allSettled([
  analyzeStorageLayout(resolved.old.layout, resolved.new.layout),
  analyzeAbiDiff(resolved.old.abi, resolved.new.abi),
  proxyInfo?.type === "uups"
    ? analyzeUupsSafety(resolved.projectRoot, resolved.new.filePath, resolved.new.contractName)
    : analyzeTransparentSafety(proxyInfo!, resolved.new.abi),
  analyzeInitializerIntegrity(resolved.projectRoot, resolved.new.filePath, resolved.new.contractName),
  analyzeAccessControlRegression(
    resolved.projectRoot,
    resolved.old.filePath, resolved.old.contractName,
    resolved.new.filePath, resolved.new.contractName,
  ),
]);

// Collect results, handle errors
```

---

## Verification Steps

```bash
cd engine
npm run build
npm run typecheck
npm test   # all unit tests for all 6 analyzers

# End-to-end against test fixtures:
node dist/check.js \
  --proxy 0x... \
  --old ./test-fixtures/MyContractV1.sol \
  --new ./test-fixtures/MyContractV2.sol \
  --rpc https://...
# Expect: full findings array, analyzer status all "completed", no "skipped"
```

Test fixtures to create in `engine/tests/fixtures/`:
- `SafeUpgrade.sol` / `SafeUpgradeV2.sol` — expect SAFE (no findings except LOW)
- `StorageCollision.sol` / `StorageCollisionV2.sol` — expect STOR-001 (variable deleted)
- `MissingAuthorize.sol` — expect UUPS-001
- `RemovedOnlyOwner.sol` / `RemovedOnlyOwnerV2.sol` — expect ACL-001

---

## Expected Outcome

All of the following must be TRUE before moving to Phase 5:

1. `npm run build` exits 0 — no compile errors in any of the six analyzer files.
2. `npm run typecheck` exits 0 — zero TypeScript errors across all new source files.
3. `npm test` exits 0 — all unit tests for all six analyzers pass.
4. Running the engine against `SafeUpgrade.sol → SafeUpgradeV2.sol` (append-only): verdict is `"SAFE"`, zero CRITICAL/HIGH findings, and all seven `analyzerStatus` entries are `"completed"`.
5. Running against `StorageCollision.sol` fixture: `findings` contains exactly one entry with `code: "STOR-001"` (variable deleted at existing slot).
6. Running against `MissingAuthorize.sol` UUPS fixture: `findings` contains an entry with `code: "UUPS-001"` and `severity: "CRITICAL"`.
7. Running against `RemovedOnlyOwner.sol` ACL fixture: `findings` contains an entry with `code: "ACL-001"` and `severity: "CRITICAL"`.
8. No `analyzerStatus` entry is `"errored"` for any of the test fixtures — all six analyzers complete cleanly.
9. The functions `analyzeStorageLayout`, `analyzeAbiDiff`, `analyzeUupsSafety`, `analyzeTransparentSafety`, `analyzeInitializerIntegrity`, and `analyzeAccessControlRegression` are all exported from their respective files and callable as pure functions with no side-effects.
10. Engine returns `verdict: "UNSAFE"` whenever any CRITICAL finding is present in the findings array.
