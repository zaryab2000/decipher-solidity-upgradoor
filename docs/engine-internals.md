# Engine Internals — decipher-solidity-upgradoor v0

Internal reference document. Describes what the engine does, what every file is responsible for,
and the exact flow from the moment a user invokes the `/decipher-solidity-upgradoor:check`
command to the moment they receive a verdict and a written report.

---

## 1. What the Engine Is

The engine is a TypeScript library (`engine/`) that performs **deterministic upgrade safety
analysis** for Solidity smart contracts. Given a deployed proxy address, a path to the old
implementation, and a path to the new implementation, it runs a pipeline of independent
analyzers and returns a structured verdict.

**Deterministic** means: no LLM is involved in the analysis. Every finding is computed from
on-chain data, forge build artifacts, and static source analysis. The same inputs always
produce the same output.

Claude Code is the presentation layer. It receives the engine's JSON output, translates
findings into plain English, and writes the report file.

The engine has two distribution surfaces that share the same core:

| Surface | How it runs | How Claude uses it |
|---|---|---|
| `dist/check.js` | Node.js CLI via `node engine/dist/check.js ...` | Claude calls it with Bash |
| `index.ts` (public API) | Import as a library | Not used in v0 |

In v0 there is no MCP server. Claude calls the engine entirely through Bash.

---

## 2. Engine Directory Layout

```
engine/
├── src/
│   ├── index.ts                         ← Public API exports
│   ├── types.ts                         ← All shared TypeScript interfaces
│   ├── errors.ts                        ← UpgradoorError class + error codes
│   ├── engine.ts                        ← UpgradoorEngine orchestrator class
│   ├── check.ts                         ← Thin CLI wrapper (entry point for Bash)
│   │
│   ├── utils/
│   │   ├── eip1967.ts                   ← EIP-1967 constants + slot reader helpers
│   │   └── forge.ts                     ← All forge subprocess calls (centralized)
│   │
│   ├── resolver/
│   │   ├── input-resolver.ts            ← Orchestrates forge build + both extractions
│   │   ├── layout-extractor.ts          ← Calls forge inspect → CanonicalStorageEntry[]
│   │   └── abi-extractor.ts             ← Calls forge inspect → ExtractedAbi
│   │
│   ├── analyzers/
│   │   ├── proxy-detection.ts           ← Reads EIP-1967 slots over RPC, classifies proxy
│   │   ├── storage-layout.ts            ← Slot-by-slot layout comparison
│   │   ├── abi-diff.ts                  ← Selector/signature/event diff
│   │   ├── uups-safety.ts               ← _authorizeUpgrade presence + access control
│   │   ├── transparent-safety.ts        ← Admin slot + selector conflict checks
│   │   ├── initializer-integrity.ts     ← Constructor writes, initializer modifiers
│   │   └── access-control-regression.ts ← Removed modifiers, widened visibility
│   │
│   └── report/
│       ├── aggregator.ts                ← Combines all AnalyzerResults → verdict
│       └── markdown-report.ts           ← Renders AggregatedResult → markdown string
│
├── tests/                               ← Vitest unit tests (mirrors src/ structure)
├── package.json
├── tsconfig.json
└── tsup.config.ts                       ← Bundles src/check.ts → dist/check.js
```

---

## 3. File-by-File Reference

### `types.ts`

The single source of truth for every TypeScript type in the engine. No other engine file is
imported here — only external packages. Everything else imports from `types.ts`.

Key types:

**`Finding`** — one issue found by an analyzer. Contains:
- `code` — standardized string like `STOR-001`, `UUPS-002`, `ACL-001`
- `severity` — `CRITICAL | HIGH | MEDIUM | LOW`
- `confidence` — `HIGH_CONFIDENCE | MEDIUM_CONFIDENCE`
- `title`, `description`, `details`, `location`, `remediation`

**`AnalyzerResult`** — what every analyzer returns. A discriminated union:
- `{ status: "completed", findings: Finding[] }` — ran cleanly, zero or more findings
- `{ status: "skipped", reason: string }` — intentionally not run (e.g. wrong proxy type)
- `{ status: "errored", error: string }` — ran but threw an exception

The distinction between `skipped` and `errored` is load-bearing. If a critical-capable
analyzer returns `errored`, the overall verdict is forced to `INCOMPLETE` regardless of
other results.

**`EngineInput`** — what the CLI passes to the engine:
- `proxyAddress` — deployed proxy (0x...)
- `oldImplementationPath` — local .sol file path
- `newImplementationPath` — local .sol file path
- `rpcUrl` — JSON-RPC endpoint

**`EngineResult`** — what the engine returns to `check.ts` (and ultimately to Claude):
- `verdict` — `SAFE | UNSAFE | REVIEW_REQUIRED | INCOMPLETE`
- `highestSeverity` — the worst severity found
- `findings[]` — all findings from all analyzers
- `reports.markdown` — the full markdown report as a string
- `analyzerStatus` — map of analyzer name → completed/skipped/errored

**`ProxyInfo`** — internal result of proxy detection, passed between pipeline stages:
- `type` — `transparent | uups | unknown`
- `implementationAddress` — current implementation read from EIP-1967 slot
- `adminAddress?` — set only for transparent proxies

---

### `errors.ts`

Defines `UpgradoorError` (extends `Error`) and the `ErrorCode` union:

| Code | When |
|---|---|
| `FOUNDRY_NOT_FOUND` | `forge` binary not in PATH |
| `INPUT_ERROR` | Bad address, missing file, wrong format |
| `CONTRACT_AMBIGUOUS` | .sol file has multiple contracts, can't auto-detect |
| `FOUNDRY_ERROR` | `forge build` or `forge inspect` failed |
| `RUNTIME_ERROR` | Unexpected engine error |

`check.ts` catches these and maps them to exit codes. Claude reads the exit code to know
whether the run succeeded or failed.

---

### `utils/eip1967.ts`

Two things only: the EIP-1967 slot constants and the RPC read helpers.

**Constants:**
- `IMPLEMENTATION_SLOT` — the slot where the current implementation address is stored
  (`keccak256("eip1967.proxy.implementation") - 1`)
- `ADMIN_SLOT` — the slot where the proxy admin address is stored (Transparent proxies)
- `BEACON_SLOT` — the slot for beacon proxies (we detect this to reject them)
- `PROXIABLE_UUID_SELECTOR` — the 4-byte selector for `proxiableUUID()`, used to distinguish
  UUPS from Transparent proxies by checking implementation bytecode

**Functions:**
- `readStorageSlot(client, address, slot)` — calls `eth_getStorageAt` via viem
- `slotToAddress(slotValue)` — takes a 32-byte hex storage value and extracts the last 20
  bytes as an address (storage slots store addresses left-padded with zeros)

This file has zero business logic. It is a thin wrapper over viem's `getStorageAt`.

---

### `utils/forge.ts`

The only file in the engine that calls `child_process.exec` with forge commands. Every forge
interaction in the entire engine goes through this file — analyzers and resolvers never spawn
subprocesses directly.

**Functions:**

`forgeBuild(projectRoot)` — runs `forge build` in the project root. Throws `FOUNDRY_ERROR`
if compilation fails. Must be called before any `forgeInspect*` call because `forge inspect`
reads from the `out/` directory that `forge build` creates.

`forgeInspectStorageLayout(projectRoot, contractFile, contractName)` — runs:
```
forge inspect <contractFile>:<contractName> storage-layout --json
```
Returns the raw `ForgeStorageLayout` object. The layout lists every state variable with its
slot, offset, type identifier, and which contract in the inheritance chain declared it.

`forgeInspectAbi(projectRoot, contractFile, contractName)` — runs:
```
forge inspect <contractFile>:<contractName> abi --json
```
Returns the raw ABI as an array of `ForgeAbiItem` objects (functions, events, errors, etc.).

**Why centralized?** Having one place for all subprocess calls means: one place to handle
errors, one place to set the working directory, one place to add timeout logic in the future,
and one place to mock in tests.

---

### `resolver/layout-extractor.ts`

Takes a `.sol` file path and contract name. Calls `forgeInspectStorageLayout`. Converts the
raw forge output into the canonical form the analyzers expect.

The main transformation is **type canonicalization**: forge returns internal type identifiers
like `t_uint256`, `t_mapping(t_address,t_uint256)`. This file extracts the human-readable
`label` from the forge types dictionary (e.g. `uint256`, `mapping(address => uint256)`).

Output: `CanonicalStorageEntry[]` — one entry per state variable, with:
- `slot` (integer) — which storage slot it occupies
- `offset` (integer) — byte offset within the slot (for packed variables)
- `length` (integer) — byte size
- `canonicalType` (string) — human-readable type
- `label` (string) — variable name
- `contractOrigin` (string) — which contract in the inheritance chain declared it

---

### `resolver/abi-extractor.ts`

Takes a `.sol` file path and contract name. Calls `forgeInspectAbi`. Normalizes raw ABI
items into typed structures the analyzers can compare.

For **functions**: computes the 4-byte selector by keccak256-hashing the canonical function
signature (`name(type,type,...)`) and taking the first 4 bytes.

For **events**: computes `topic0` the same way (full keccak256 of the event signature).

Output: `ExtractedAbi` with:
- `functions: NormalizedFunction[]` — each with selector, signature, name, input types,
  output types, stateMutability
- `events: NormalizedEvent[]` — each with topic0, signature, name, input types

Constructors, fallback, receive, and error items are excluded from both lists.

---

### `resolver/input-resolver.ts`

Orchestrates the full resolution step before any analyzer runs.

Steps:
1. **Validate input files** — check that old and new `.sol` files exist on disk
2. **Find project root** — walks up the directory tree from the new file's directory,
   looking for `foundry.toml` or `package.json`. This is where forge will be invoked.
3. **Run `forge build`** — compiles the project, populating `out/` with artifacts
4. **Auto-detect contract names** — inferred from the `.sol` filename stem (e.g.
   `MyContractV2.sol` → contract name `MyContractV2`) unless overridden by `options.contractName`
5. **Extract in parallel** — calls `extractStorageLayout` and `extractAbi` for both old
   and new implementations concurrently via `Promise.all`

Output: `ResolvedImplementations` — contains `old` and `new` objects, each with:
- `layout: CanonicalStorageEntry[]`
- `abi: ExtractedAbi`
- `contractName: string`
- `filePath: string`
- Plus `projectRoot: string` (used by AST-based analyzers to find `out/` artifacts)

---

### `analyzers/proxy-detection.ts`

The only analyzer that makes RPC calls. All other analyzers are pure functions that receive
data; this one goes to the blockchain.

**What it reads:**
1. EIP-1967 implementation slot (`eth_getStorageAt` × 3 for impl, admin, beacon slots)
2. Bytecode of the implementation address (`eth_getCode`)

**Classification logic:**
- If beacon slot is set → `PROXY-001` (beacon not supported)
- If impl slot is zero → `PROXY-002` (uninitialized proxy)
- If impl address has no bytecode → `PROXY-003` (wrong network or address)
- If impl bytecode contains the `proxiableUUID()` selector → type is `uups`
- Else if admin slot is non-zero → type is `transparent`
- Else → `PROXY-005` (unrecognized pattern)

For UUPS and Transparent proxies it returns a `ProxyInfo` object that flows into the
rest of the pipeline.

---

### `analyzers/storage-layout.ts`

A pure synchronous function. No network, no subprocess. Takes two `CanonicalStorageEntry[]`
arrays and compares them slot-by-slot.

**Primary key:** `slot + offset`. The label is informational. The type is what matters.

**What it detects:**

| Code | Severity | What happened |
|---|---|---|
| `STOR-001` | CRITICAL | Variable deleted — existed in old layout, gone in new |
| `STOR-002` | CRITICAL | Variable inserted in the middle — new slot within old range |
| `STOR-003` | CRITICAL | Type width changed at same slot (e.g. uint256 → uint128) |
| `STOR-004` | CRITICAL | Type semantics changed at same slot (same width, different type) |
| `STOR-007` | HIGH | Storage gap shrank more than new variables added |
| `STOR-008` | HIGH | Storage gap removed entirely |
| `STOR-009` | MEDIUM | New variable appended after existing layout (safe, but gap must be decremented) |
| `STOR-010` | LOW | Variable renamed — same slot/offset/type, different label |

Storage gaps are detected by looking for variables whose label ends with `gap` and whose
type is `uint256[N]`. The analyzer verifies `N_new + V_new == N_old` where V_new is the
count of new variables added after the gap.

---

### `analyzers/abi-diff.ts`

A pure function. Takes two `ExtractedAbi` objects. Compares function selectors and event
topics.

| Code | Severity | What happened |
|---|---|---|
| `ABI-001` | HIGH | Function selector removed entirely |
| `ABI-002` | CRITICAL | Two functions in new impl share the same 4-byte selector |
| `ABI-003` | HIGH | Function name exists in both but parameters changed (selector differs) |
| `ABI-004` | MEDIUM | Same selector in both but return type changed |
| `ABI-005` | LOW | New function added (informational) |
| `ABI-006` | HIGH | Event signature changed (off-chain listeners will miss events) |
| `ABI-007` | MEDIUM | Event removed entirely |

---

### `analyzers/uups-safety.ts`

Runs only when the proxy type is `uups`. Reads the build artifact JSON from
`out/<ContractFile>/<ContractName>.json` (produced by `forge build`) and walks the Solidity
AST embedded in it.

**What it checks:**

1. Does `_authorizeUpgrade` exist in the AST? If not → `UUPS-001` (CRITICAL).
2. Does `_authorizeUpgrade` have a non-empty function body? If empty → `UUPS-002` (CRITICAL).
   An empty body means anyone can upgrade the proxy.
3. Does the body have access control (modifier with a known access control keyword, or a
   `msg.sender` check)? If not → `UUPS-003` (CRITICAL).

Access control detection uses two methods:
- Modifier names are checked against keywords: `onlyOwner`, `onlyRole`, `onlyAdmin`, `auth`,
  `authorized`, `guard`
- The function body JSON is string-scanned for `msg.sender` or `_msgSender`

---

### `analyzers/transparent-safety.ts`

Runs only when the proxy type is `transparent`. Takes `ProxyInfo` (from proxy detection) and
the new implementation's `ExtractedAbi`.

| Code | Severity | What it checks |
|---|---|---|
| `TPROXY-001` | CRITICAL | Admin slot is zero address — nobody can upgrade |
| `TPROXY-002` | HIGH | New impl defines `upgradeTo`/`upgradeToAndCall` (wrong pattern) |
| `TPROXY-004` | HIGH | Implementation function selector collides with known proxy admin selectors |

The admin selectors it checks against (`0x3659cfe6`, `0x4f1ef286`, etc.) are the OZ
TransparentUpgradeableProxy v4/v5 function selectors. A collision here means admin calls
will be silently routed to the wrong function.

---

### `analyzers/initializer-integrity.ts`

Reads the AST from `out/` artifacts and checks initializer-related patterns in the new
implementation.

| Code | Severity | What it checks |
|---|---|---|
| `INIT-001` | CRITICAL | Constructor has storage writes — these only run on the impl, not the proxy |
| `INIT-002` | HIGH | No function has `initializer` or `reinitializer` modifier |
| `INIT-005` | MEDIUM | Constructor doesn't call `_disableInitializers()` |
| `INIT-006` | HIGH | More than one function has the `initializer` modifier |

The constructor write detection works by walking the constructor body AST for `Assignment`
nodes.

The `_disableInitializers` detection string-scans the constructor body JSON for the function
name.

---

### `analyzers/access-control-regression.ts`

Reads AST artifacts for **both** old and new implementations. Builds a map of function name
→ `{ visibility, modifiers[], hasMsgSenderCheck }` for each. Then compares old to new.

| Code | Severity | What it checks |
|---|---|---|
| `ACL-001` | CRITICAL | `onlyOwner` was present in old, missing in new |
| `ACL-002` | CRITICAL | `onlyRole` (any role-based modifier) was present, now missing |
| `ACL-003` | HIGH | Custom access control modifier removed (any modifier matching keyword list) |
| `ACL-004` | HIGH | Function visibility widened: `internal`/`private` → `public`/`external` |
| `ACL-007` | CRITICAL | `_authorizeUpgrade` had access control in old impl but not in new |

The keyword list used for "custom access control" detection:
`only`, `auth`, `authorized`, `owner`, `admin`, `role`, `guard`

Functions that were removed entirely are not flagged here (the ABI diff analyzer handles that).

---

### `report/aggregator.ts`

Takes the `Record<string, AnalyzerResult>` map from the engine and computes the final verdict.

**Logic:**

1. Collect all findings from every `completed` analyzer.
2. Check if any **critical-capable analyzer** returned `errored`. If yes → verdict is
   `INCOMPLETE` (we don't know if it's safe, so we can't say it's safe).
   Critical-capable analyzers: `proxy-detection`, `storage-layout`, `abi-diff`, `uups-safety`,
   `transparent-safety`, `initializer-integrity`, `access-control`.
3. Find the highest severity among all findings.
4. Apply verdict rules:
   - Any `CRITICAL` finding → `UNSAFE`
   - Any `HIGH` finding → `UNSAFE`
   - Any `MEDIUM` finding → `REVIEW_REQUIRED`
   - Otherwise → `SAFE`

Output: `AggregatedResult` with `verdict`, `highestSeverity`, `findings[]`, `analyzerStatus`.

---

### `report/markdown-report.ts`

A pure function. Takes an `AggregatedResult` and metadata, returns a markdown string.

The report structure:
1. Verdict header line (with emoji)
2. Metadata: timestamp, proxy address, proxy type, current implementation, old/new paths
3. Severity summary table (count per severity)
4. Analyzer status table (one row per analyzer with ✅/⏭/❌)
5. Critical & High findings — full detail (code, title, description, location, details JSON,
   remediation)
6. Medium & Low findings — summary table (code, severity, title only)
7. If no findings: a "No findings" paragraph

---

### `engine.ts` — `UpgradoorEngine` Orchestrator

The class that wires everything together. Has one public method: `analyze(input: EngineInput)`.

Internal steps (in order):

1. `validateFoundry()` — runs `forge --version` to confirm forge is installed. Throws
   `FOUNDRY_NOT_FOUND` if not. Fails fast before any network or file work.
2. Create a viem `PublicClient` with the provided RPC URL.
3. Run `detectProxy(client, proxyAddress)` — the only RPC step. Get `ProxyInfo` and the
   `proxy-detection` `AnalyzerResult`.
4. If proxy detection found a blocking finding (PROXY-001/002/003/005), skip all remaining
   analyzers with `reason: "proxy-detection-failed"` and return `INCOMPLETE`.
5. Run `resolveImplementations(input)` — forge build + layout + ABI extraction.
6. Run all five remaining analyzers **in parallel** via `Promise.allSettled`:
   - `analyzeStorageLayout(old.layout, new.layout)`
   - `analyzeAbiDiff(old.abi, new.abi)`
   - `analyzeUupsSafety(...)` or `analyzeTransparentSafety(...)` depending on proxy type
   - `analyzeInitializerIntegrity(...)`
   - `analyzeAccessControlRegression(...)`
7. Convert `Promise.allSettled` results: fulfilled → use the result, rejected → return
   `{ status: "errored", error: ... }`.
8. Assign analyzer results to the canonical key names in `analyzerResults`.
9. Call `aggregateResults(analyzerResults)` → verdict + findings.
10. Call `generateMarkdownReport(...)` → markdown string.
11. Return `EngineResult`.

---

### `check.ts` — CLI Entry Point

The thin wrapper that Claude calls via Bash. Has no business logic.

1. Read `--proxy`, `--old`, `--new`, `--rpc` from `process.argv`.
2. If any is missing → print error JSON to stderr, `process.exit(10)`.
3. Instantiate `UpgradoorEngine`, call `analyze()`.
4. On success: `console.log(JSON.stringify(result, null, 2))`, exit 0.
5. On `UpgradoorError`: print error JSON to stderr, `process.exit(10)`.
6. On any other error: print generic error JSON to stderr, `process.exit(12)`.

**Exit codes:**

| Code | Meaning |
|---|---|
| 0 | SAFE |
| 1 | CRITICAL finding present |
| 2 | HIGH finding (no CRITICAL) |
| 3 | MEDIUM finding (no CRITICAL/HIGH) |
| 4 | INCOMPLETE |
| 10 | Input/config error |
| 12 | Runtime error |

---

### `index.ts` — Public API

Exports the public surface for library consumers:
- `UpgradoorEngine` class
- Types: `EngineInput`, `EngineResult`, `Finding`, `Verdict`, `Severity`
- `UpgradoorError` class

Not used in v0 (Claude invokes `check.ts` directly via Bash). Exists for v1 when the MCP
server and standalone CLI will import the engine as a library.

---

## 4. Full Flow: From `/check` Command to Final Report

This is the exact sequence of events from the moment the user runs the command.

---

### Step 0 — User invokes the command

```
/decipher-solidity-upgradoor:check 0xAbCd... ./src/V1.sol ./src/V2.sol https://eth-mainnet.rpc/...
```

Claude Code loads `commands/check.md` and begins executing its instructions.

---

### Step 1 — Claude validates inputs

Claude checks (before touching the engine):
- Is the proxy address 42 characters starting with `0x`?
- Does the old implementation path exist on disk?
- Does the new implementation path end in `.sol` and exist on disk?
- Is an RPC URL provided, or available in `ETHEREUM_MAINNET_RPC` env var?

If anything is wrong, Claude stops here and asks the user to fix it. No subprocess is run.

---

### Step 2 — Claude runs `forge build`

Claude runs:
```bash
forge build
```

This compiles the user's Foundry project. If it fails, Claude shows the compilation errors
and stops. The engine is never invoked if the project doesn't compile.

This build step also happens *inside* the engine (via `forgeBuild()`) when `resolveImplementations`
runs. The `forge build` here is Claude's pre-check; the one inside the engine is the same
command run again as part of the extraction pipeline. Both must succeed.

---

### Step 3 — Claude runs `node engine/dist/check.js`

```bash
node engine/dist/check.js \
  --proxy 0xAbCd... \
  --old ./src/V1.sol \
  --new ./src/V2.sol \
  --rpc https://eth-mainnet.rpc/...
```

This process is what the engine actually is from the outside. Everything below happens
inside this Node.js process.

---

### Step 4 — `check.ts` parses args and calls engine

`check.ts` reads the four arguments from `process.argv` and calls:
```typescript
const engine = new UpgradoorEngine();
const result = await engine.analyze({ proxyAddress, oldImplementationPath, newImplementationPath, rpcUrl });
```

---

### Step 5 — Engine validates Foundry

`engine.ts` calls `validateFoundry()`:
```bash
forge --version   # run via child_process.exec
```
If this fails, `FOUNDRY_NOT_FOUND` error is thrown. `check.ts` catches it, writes error JSON
to stderr, exits with code 10. Claude reads the error and tells the user to install Foundry.

---

### Step 6 — Proxy detection (RPC calls)

The engine creates a viem `PublicClient` and calls `detectProxy(client, proxyAddress)`.

Three `eth_getStorageAt` calls are made in sequence:
- Read implementation slot → extract 20-byte address
- Read admin slot → extract 20-byte address
- Read beacon slot → extract 20-byte address

One `eth_getCode` call: get the bytecode at the implementation address.

**Classification outcome:**

If the proxy is a valid UUPS or Transparent proxy, `detectProxy` returns a `ProxyInfo` object:
```typescript
{
  type: "uups",                          // or "transparent"
  proxyAddress: "0xAbCd...",
  implementationAddress: "0x1234...",
  adminAddress: "0x5678..."             // only for transparent
}
```

If detection fails (beacon proxy, zero impl, no bytecode, unknown pattern), a blocking
finding is added and the engine short-circuits: all remaining analyzers are marked `skipped`,
verdict is set to `INCOMPLETE`, and the flow jumps to Step 11.

---

### Step 7 — Source resolution (forge calls)

`resolveImplementations(input)` is called. This does:

1. Validate both `.sol` files exist
2. Walk up the directory tree to find the Foundry project root (`foundry.toml`)
3. Run `forge build` in the project root (populates `out/`)
4. Auto-detect contract names from filenames
5. In parallel, run four `forge inspect` commands:
   - `forge inspect src/V1.sol:V1 storage-layout --json`
   - `forge inspect src/V1.sol:V1 abi --json`
   - `forge inspect src/V2.sol:V2 storage-layout --json`
   - `forge inspect src/V2.sol:V2 abi --json`
6. Parse and canonicalize all four outputs

At the end of this step, the engine has:
- `old.layout: CanonicalStorageEntry[]` — every storage variable in V1 with slot/offset/type
- `old.abi: ExtractedAbi` — every function and event in V1 with selectors/topics
- `new.layout: CanonicalStorageEntry[]` — same for V2
- `new.abi: ExtractedAbi` — same for V2
- `projectRoot: string` — needed by AST-based analyzers to find `out/` artifacts

---

### Step 8 — Analyzers run in parallel

Five analyzers run concurrently via `Promise.allSettled`:

```
analyzeStorageLayout(old.layout, new.layout)           ← pure, synchronous
analyzeAbiDiff(old.abi, new.abi)                       ← pure, synchronous
analyzeUupsSafety(projectRoot, V2.sol, V2)             ← reads out/ AST file
  OR
analyzeTransparentSafety(proxyInfo, new.abi)           ← pure, synchronous
analyzeInitializerIntegrity(projectRoot, V2.sol, V2)   ← reads out/ AST file
analyzeAccessControlRegression(projectRoot, V1, V2)    ← reads out/ AST files
```

`Promise.allSettled` ensures one analyzer's failure never blocks the others. Each analyzer
independently returns a `{ status: "completed"|"skipped"|"errored", ... }` result.

Inside each analyzer:

**`analyzeStorageLayout`** — iterates through old layout entries. For each slot+offset key,
checks if the new layout has it. If missing → STOR-001. If present, compares type width and
semantics. Also checks for insertions in the middle and gap integrity.

**`analyzeAbiDiff`** — builds selector maps for old and new. Checks for removed selectors,
selector collisions, signature changes, return type changes, new functions, event changes.

**`analyzeUupsSafety`** (UUPS only) — reads `out/V2.sol/V2.json`, walks the AST tree looking
for the `_authorizeUpgrade` function definition. Checks its existence, body emptiness, and
access control modifiers.

**`analyzeTransparentSafety`** (Transparent only) — checks admin address from `ProxyInfo`
and scans the new ABI for upgrade function names and selector collisions.

**`analyzeInitializerIntegrity`** — reads AST artifact, finds all constructors and initializer
functions, checks for storage writes and missing `_disableInitializers`.

**`analyzeAccessControlRegression`** — reads AST artifacts for both old and new, builds
function maps, compares modifiers and visibility for each function present in both.

---

### Step 9 — Results aggregated

`aggregateResults(analyzerResults)` is called.

All findings from all `completed` analyzers are collected into one array.

If any critical-capable analyzer errored → `INCOMPLETE`.

Otherwise the verdict follows severity rules:
- CRITICAL or HIGH present → `UNSAFE`
- MEDIUM present (no CRITICAL/HIGH) → `REVIEW_REQUIRED`
- Nothing or only LOW → `SAFE`

---

### Step 10 — Markdown report generated

`generateMarkdownReport(aggregated, proxyInfo, metadata)` renders the full report as a string.

The string is stored in `result.reports.markdown`. It is **not written to disk** by the engine.
Writing to disk is Claude's job (Step 12 below).

---

### Step 11 — Engine returns JSON to `check.ts`

`check.ts` receives the `EngineResult`, prints it as JSON to stdout:
```bash
console.log(JSON.stringify(result, null, 2))
```

Then maps the verdict to an exit code:
- `SAFE` → exit 0
- Any CRITICAL finding → exit 1
- Any HIGH finding (no CRITICAL) → exit 2
- Any MEDIUM finding (no CRITICAL/HIGH) → exit 3
- `INCOMPLETE` → exit 4

The Node.js process exits.

---

### Step 12 — Claude reads JSON and writes report

Claude receives the stdout JSON from `check.js`.

It parses the result and presents it to the user in this order:
1. **Verdict** — prominent, with emoji
2. **Severity summary** — count of CRITICAL/HIGH/MEDIUM/LOW
3. **Critical and High findings** — each explained in plain English with location and fix
4. **Medium and Low findings** — brief list
5. **Analyzer status** — note any skipped or errored analyzers

Then Claude uses the `Write` tool to write `result.reports.markdown` to:
```
./upgrade_safety_report.md
```

Then Claude tells the user: "Report written to upgrade_safety_report.md."

Based on the verdict, Claude offers next steps:
- **SAFE**: "Review the report before deploying."
- **UNSAFE**: "Would you like me to walk through how to fix the critical issues?"
- **REVIEW_REQUIRED**: "Want me to explain each finding?"
- **INCOMPLETE**: "Here's what was skipped and how to provide the missing information."

---

## 5. Data Flow Diagram

```
User
  │
  │  /decipher-solidity-upgradoor:check 0xProxy ./V1.sol ./V2.sol https://rpc
  ▼
commands/check.md  (Claude reads this, follows instructions)
  │
  │  Validates inputs
  │  Runs: forge build
  │  Runs: node engine/dist/check.js --proxy ... --old ... --new ... --rpc ...
  ▼
check.ts  (Node.js process starts)
  │
  │  Parses args
  │  Calls: UpgradoorEngine.analyze(input)
  ▼
engine.ts
  │
  ├─→ validateFoundry()                         [subprocess: forge --version]
  │
  ├─→ detectProxy(client, proxyAddress)         [3x eth_getStorageAt, 1x eth_getCode]
  │     └─→ eip1967.ts  (readStorageSlot, slotToAddress)
  │     └─→ Returns: ProxyInfo { type, implementationAddress, adminAddress }
  │         + AnalyzerResult { status: "completed", findings: [...] }
  │
  ├─→ resolveImplementations(input)
  │     ├─→ validateSolFile(old), validateSolFile(new)
  │     ├─→ findProjectRoot(dir)               [filesystem traversal]
  │     ├─→ forgeBuild(projectRoot)            [subprocess: forge build]
  │     └─→ Promise.all([
  │           extractStorageLayout(old)         [subprocess: forge inspect ... storage-layout]
  │           extractAbi(old)                   [subprocess: forge inspect ... abi]
  │           extractStorageLayout(new)         [subprocess: forge inspect ... storage-layout]
  │           extractAbi(new)                   [subprocess: forge inspect ... abi]
  │         ])
  │         └─→ Returns: ResolvedImplementations { old, new, projectRoot }
  │
  ├─→ Promise.allSettled([
  │     analyzeStorageLayout(old.layout, new.layout)          [pure function]
  │     analyzeAbiDiff(old.abi, new.abi)                      [pure function]
  │     analyzeUupsSafety(projectRoot, V2.sol, V2)            [reads out/ AST]
  │       OR analyzeTransparentSafety(proxyInfo, new.abi)     [pure function]
  │     analyzeInitializerIntegrity(projectRoot, V2.sol, V2)  [reads out/ AST]
  │     analyzeAccessControlRegression(projectRoot, V1, V2)   [reads out/ AST]
  │   ])
  │   └─→ Each returns: AnalyzerResult
  │
  ├─→ aggregateResults(analyzerResults)
  │     └─→ Returns: { verdict, highestSeverity, findings[], analyzerStatus }
  │
  └─→ generateMarkdownReport(aggregated, proxyInfo, metadata)
        └─→ Returns: markdown string

check.ts
  │
  │  console.log(JSON.stringify(result))
  │  process.exit(exitCode)
  ▼
Claude Code
  │
  ├─→ Presents verdict + findings to user (in chat)
  └─→ Write tool: ./upgrade_safety_report.md
```

---

## 6. Key Design Decisions

**One analyzer, one responsibility.** Each analyzer file exports exactly one function and
checks one category of issue. They share no mutable state. This means one failing analyzer
never crashes others (enforced by `Promise.allSettled`), and each can be tested in isolation.

**All subprocess calls in one file.** `utils/forge.ts` is the only place `child_process.exec`
is called with forge commands. Analyzers receive already-parsed data structures — they never
spawn processes.

**Only one file makes RPC calls.** `analyzers/proxy-detection.ts` is the only analyzer that
touches the network. All other analyzers receive data passed in as arguments.

**No LLM in the analysis path.** Every finding is computed deterministically. Claude's role is
input collection, result presentation, and file writing. The verdict logic cannot be influenced
by prompt variation.

**`skipped` vs `errored` is load-bearing.** An analyzer returns `skipped` when it was
intentionally not run (e.g., the wrong proxy type). It returns `errored` when it tried to run
but failed. Only `errored` on critical-capable analyzers forces `INCOMPLETE`. A `skipped`
analyzer never degrades the verdict.

**`Promise.allSettled` not `Promise.all`.** If one analyzer throws, the others still complete.
The thrown analyzer is recorded as `errored`. The rest of the findings are still valid and
still included in the report.
