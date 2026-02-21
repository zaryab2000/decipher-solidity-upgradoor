# Plugin Capabilities: What decipher-solidity-upgradoor v0 Can Catch

This document provides a comprehensive, code-verified list of every check the plugin currently performs. Each item maps to an exact finding code emitted in the JSON output.

---

## How Analysis Works

Before any findings are emitted, the plugin runs a **gating step** (proxy detection). If that step fails, all downstream analyzers are skipped and the verdict is `INCOMPLETE`. If it passes, up to six analyzers run in parallel — one of the two proxy-specific analyzers is always skipped depending on the detected pattern.

**Verdict rules:**
- Any `CRITICAL` or `HIGH` finding → `UNSAFE`
- Any `MEDIUM` finding → `REVIEW_REQUIRED`
- Only `LOW` findings or none → `SAFE`
- Any critical-capable analyzer errors out → `INCOMPLETE`

---

## Proxy Detection — Gating Step

These four findings block all downstream analysis when triggered.

| Code | Severity | What Triggers It |
|---|---|---|
| `PROXY-001` | CRITICAL | The address is a **beacon proxy** (EIP-1967 beacon slot is set). Beacon proxies are not supported in v0 — the plugin reports this rather than giving wrong results. |
| `PROXY-002` | CRITICAL | The **implementation slot holds a zero address** — no implementation is set. |
| `PROXY-003` | CRITICAL | The **implementation address has no deployed bytecode** — contract self-destructed or wrong address provided. |
| `PROXY-005` | CRITICAL | **Proxy pattern could not be classified** — neither UUPS nor Transparent detected from on-chain state. Covers both "ambiguous" and "unrecognized" cases. |

> `PROXY-004` is not used. Both ambiguous and unrecognized patterns collapse to `PROXY-005`.

---

## Storage Layout Safety

Compares the on-chain (old) implementation storage layout against the new implementation layout using `forge inspect`. Primary key is `slot + offset`.

| Code | Severity | What Triggers It |
|---|---|---|
| `STOR-001` | CRITICAL | **Variable deleted** — a slot+offset present in the old layout is absent in the new layout. Corrupts all data at and after that slot. |
| `STOR-002` | CRITICAL | **Variable inserted in the middle** — a new slot+offset appears within the existing storage range (`slot ≤ maxOldSlot`). Shifts everything below it. |
| `STOR-003` | CRITICAL | **Type width changed at same slot** — same slot+offset but the `length` (byte width) differs. E.g., `uint128 → uint256` overwrites its neighbor. |
| `STOR-004` | CRITICAL | **Type semantics changed at same slot** — same slot+offset+width but different `canonicalType`. E.g., `int256 → uint256` or `address → bytes32`. |
| `STOR-007` | HIGH | **Storage gap insufficient** — gap shrank AND new variables were added, but `newGapSize + newVarsAdded < oldGapSize`. Inheritance chain could corrupt child contract storage. |
| `STOR-008` | HIGH | **Storage gap removed entirely** — a variable matching `/gap$/i` existed in the old layout with no counterpart in the new layout. |
| `STOR-009` | MEDIUM | **New variable appended** — new slot+offset appears beyond `maxOldSlot`. Safe in isolation, but flagged for awareness. |
| `STOR-010` | LOW | **Variable renamed** — same slot+offset+type but different label. Informational only; no storage risk. |

**Note on struct reordering:** There is no dedicated "struct fields reordered" check. If struct fields are reordered, `forge inspect` reports each field as an individual layout entry, so this surfaces as `STOR-001` (deletions) + `STOR-002` (insertions) rather than a named struct-reorder finding.

---

## UUPS Proxy Safety

Only runs when the proxy is detected as UUPS. Uses the Forge build artifact AST.

| Code | Severity | What Triggers It |
|---|---|---|
| `UUPS-001` | CRITICAL | **`_authorizeUpgrade` missing** — the function does not appear in the new implementation's AST (including inherited contracts). Without it the proxy is either permanently locked or unprotected. |
| `UUPS-002` | CRITICAL | **`_authorizeUpgrade` has an empty body** — the function exists but has no statements. Anyone can call it and trigger an upgrade. |
| `UUPS-003` | CRITICAL | **`_authorizeUpgrade` has no access control** — the function has a body but no recognized access control modifier (`onlyOwner`, `onlyRole`, `onlyAdmin`, `auth`, `authorized`, `guard`) and no `msg.sender`/`_msgSender` check. |

**Not yet implemented in v0:**
- Whether `upgradeTo`/`upgradeToAndCall` themselves have direct access control (only `_authorizeUpgrade` is analyzed)
- Whether access control was *weakened* rather than fully removed (e.g., `onlyOwner → customWeakerModifier`)
- Whether `proxiableUUID()` returns the correct EIP-1967 storage slot value

---

## Transparent Proxy Safety

Only runs when the proxy is detected as Transparent.

| Code | Severity | What Triggers It |
|---|---|---|
| `TPROXY-001` | CRITICAL | **Admin slot is zero address** — no one can manage the proxy. |
| `TPROXY-002` | HIGH | **Implementation exposes upgrade functions** — the new implementation's ABI contains `upgradeTo` or `upgradeToAndCall`. These conflict with the transparent proxy pattern where only the proxy admin should route those calls. |
| `TPROXY-004` | HIGH | **Selector collision with proxy admin functions** — an implementation function's 4-byte selector matches one of the five hardcoded proxy admin selectors: `upgradeTo`, `upgradeToAndCall`, `changeAdmin`, `admin()`, `implementation()`. |

**Not yet implemented in v0:**
- Whether the admin address belongs to an EOA vs. a `ProxyAdmin` contract (one lost key = permanently unmanageable proxy)

---

## Initialization Logic

Analyzes the new implementation's AST for OpenZeppelin-style proxy initialization patterns.

| Code | Severity | What Triggers It |
|---|---|---|
| `INIT-001` | CRITICAL | **Constructor writes to storage** — the constructor contains `Assignment` nodes. In a proxy context, the implementation's constructor storage writes are never visible through the proxy. |
| `INIT-002` | HIGH | **No initializer function found** — no function carries an `initializer` or `reinitializer` modifier. The contract cannot be properly initialized after upgrade. |
| `INIT-005` | MEDIUM | **`_disableInitializers()` not called in constructor** — constructors exist but none call `_disableInitializers()`. The bare implementation contract can be initialized directly by anyone. |
| `INIT-006` | HIGH | **Multiple functions with `initializer` modifier** — more than one function carries the `initializer` modifier (not `reinitializer`). Only one initializer should exist. |

**Not yet implemented in v0:**
- Comparing reinitializer version numbers between old and new implementations (version going backwards)

---

## Access Control Regression

Compares old and new contract ASTs for functions that lost access control between versions. Skipped for functions that were already removed (caught by ABI diff instead).

| Code | Severity | What Triggers It |
|---|---|---|
| `ACL-001` | CRITICAL | **`onlyOwner` removed** — a function had `onlyOwner` in the old implementation but not in the new one. |
| `ACL-002` | CRITICAL | **`onlyRole` removed** — a function had a modifier matching `onlyRole*` in the old implementation but not in the new one. |
| `ACL-003` | HIGH | **Custom access control modifier removed** — a function had a modifier matching access-control keywords (`only`, `auth`, `authorized`, `owner`, `admin`, `role`, `guard`) in the old implementation, but not in the new one. |
| `ACL-004` | HIGH | **Function visibility widened** — a function was `internal` or `private` in the old implementation and is now `public` or `external`. |
| `ACL-007` | CRITICAL | **`_authorizeUpgrade` lost access control** — the old implementation's `_authorizeUpgrade` had an access control modifier or `msg.sender` check; the new one does not. |

---

## ABI Compatibility

Compares function and event ABIs between old and new implementations using selector/topic0 as the primary key.

| Code | Severity | What Triggers It |
|---|---|---|
| `ABI-001` | HIGH | **Function selector removed** — a 4-byte selector present in the old ABI is absent from the new ABI. Any caller of that function will revert after upgrade. |
| `ABI-002` | CRITICAL | **Selector collision in new ABI** — two functions in the new implementation share the same 4-byte selector. The EVM will route calls unpredictably. |
| `ABI-003` | HIGH | **Function signature changed** — a function with the same name exists in both ABIs but has a different selector (different parameter types). All existing callers break. |
| `ABI-004` | MEDIUM | **Return type changed** — a function selector matches in both ABIs but the `outputs` differ. Callers expecting the old return type will misparse results. |
| `ABI-005` | LOW | **New function added** — a selector is present in the new ABI but absent from the old. Informational; review for unintended exposure. |
| `ABI-006` | HIGH | **Event signature changed** — an event with the same name exists in both ABIs but has a different topic0 (different parameter types). Monitoring systems and subgraphs break. |
| `ABI-007` | MEDIUM | **Event removed** — an event topic0 present in the old ABI is absent from the new one. Off-chain monitoring loses visibility. |

---

## Pre-Analysis Errors (not structured findings)

These are detected before analysis begins and surface as CLI exit codes rather than finding codes in the JSON output.

| Condition | Exit Code | Notes |
|---|---|---|
| Missing required arguments (`--proxy`, `--old`, `--new`) | 10 | Input validation error |
| Old or new source file path cannot be resolved | 10 | Checked before forge is invoked |
| `forge build` fails on the new implementation | 12 | Runtime error; no findings emitted |
| Uncaught engine exception | 12 | Runtime error |

**Not yet implemented in v0:**
- Detecting Solidity compiler version mismatch between old and new implementations (different `pragma` versions may produce different ABI/layout behavior)

---

## Complete Finding Code Index

| Code | Category | Severity |
|---|---|---|
| `PROXY-001` | Proxy Detection | CRITICAL |
| `PROXY-002` | Proxy Detection | CRITICAL |
| `PROXY-003` | Proxy Detection | CRITICAL |
| `PROXY-005` | Proxy Detection | CRITICAL |
| `STOR-001` | Storage Layout | CRITICAL |
| `STOR-002` | Storage Layout | CRITICAL |
| `STOR-003` | Storage Layout | CRITICAL |
| `STOR-004` | Storage Layout | CRITICAL |
| `STOR-007` | Storage Layout | HIGH |
| `STOR-008` | Storage Layout | HIGH |
| `STOR-009` | Storage Layout | MEDIUM |
| `STOR-010` | Storage Layout | LOW |
| `ABI-001` | ABI Compatibility | HIGH |
| `ABI-002` | ABI Compatibility | CRITICAL |
| `ABI-003` | ABI Compatibility | HIGH |
| `ABI-004` | ABI Compatibility | MEDIUM |
| `ABI-005` | ABI Compatibility | LOW |
| `ABI-006` | ABI Compatibility | HIGH |
| `ABI-007` | ABI Compatibility | MEDIUM |
| `UUPS-001` | UUPS Safety | CRITICAL |
| `UUPS-002` | UUPS Safety | CRITICAL |
| `UUPS-003` | UUPS Safety | CRITICAL |
| `TPROXY-001` | Transparent Safety | CRITICAL |
| `TPROXY-002` | Transparent Safety | HIGH |
| `TPROXY-004` | Transparent Safety | HIGH |
| `INIT-001` | Initialization | CRITICAL |
| `INIT-002` | Initialization | HIGH |
| `INIT-005` | Initialization | MEDIUM |
| `INIT-006` | Initialization | HIGH |
| `ACL-001` | Access Control | CRITICAL |
| `ACL-002` | Access Control | CRITICAL |
| `ACL-003` | Access Control | HIGH |
| `ACL-004` | Access Control | HIGH |
| `ACL-007` | Access Control | CRITICAL |

**Total: 34 finding codes** (4 proxy-gating + 30 downstream).
