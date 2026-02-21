# Plugin Capabilities: decipher-solidity-upgradoor v0

Verified against three full end-to-end test runs (V1/V2/V3 test logs). Each entry is marked
with its verified status so you know exactly what to trust.

**Status key:**
- ✅ Verified — fires correctly and reliably
- ⚠️ Partial — fires but wrong code or co-fires with unrelated findings
- ❌ Broken — does not fire when expected, or fires the wrong finding instead

---

## How Analysis Works

Before any findings are emitted, the engine runs a **gating step** (proxy detection). If that
step fails, all downstream analyzers are skipped and the verdict is `INCOMPLETE`. If it passes,
up to six analyzers run in parallel — one of the two proxy-specific analyzers is always skipped
depending on the detected pattern.

**Verdict rules:**
- Any `CRITICAL` or `HIGH` finding → `UNSAFE`
- Any `MEDIUM` finding (and no CRITICAL/HIGH) → `REVIEW_REQUIRED`
- Only `LOW` findings or none → `SAFE`
- Any critical-capable analyzer errors out → `INCOMPLETE`

**Exit codes:**

| Code | Verdict |
|------|---------|
| 0 | SAFE |
| 1 | UNSAFE (CRITICAL finding present) |
| 2 | UNSAFE (HIGH finding, no CRITICAL) |
| 3 | REVIEW_REQUIRED |
| 4 | INCOMPLETE |
| 10 | Input/config error |
| 12 | Runtime error |

---

## Proxy Detection — Gating Step

These findings block all downstream analysis when triggered.

| Code | Severity | Status | What Triggers It |
|------|----------|--------|-----------------|
| `PROXY-001` | CRITICAL | ✅ | Address is a **beacon proxy** (EIP-1967 beacon slot set). Not supported in v0 — reported rather than giving wrong results. |
| `PROXY-002` | CRITICAL | ✅ | **Implementation slot holds a zero address** — no implementation is set. |
| `PROXY-003` | CRITICAL | ✅ | **Implementation address has no deployed bytecode** — contract self-destructed or wrong address. |
| `PROXY-005` | CRITICAL | ✅ | **Proxy pattern could not be classified** — neither UUPS nor Transparent detected from on-chain state. |

**Known limitation:** When the admin slot on a Transparent proxy is zero, the engine cannot
classify the proxy as Transparent and falls through to PROXY-005 instead of reaching
TPROXY-001 downstream. This means a zero-admin proxy returns INCOMPLETE (exit 4) rather than
UNSAFE (exit 1). See TPROXY-001 below.

---

## Storage Layout Safety

Compares old and new implementation storage layouts using `forge inspect storageLayout`.
Primary key is `slot + offset`.

| Code | Severity | Status | What Triggers It |
|------|----------|--------|-----------------|
| `STOR-001` | CRITICAL | ❌ | **Variable deleted** — should fire when a slot+offset present in old is absent in new. Currently STOR-003 fires instead when a gap array expands into the deleted variable's slot. Verdict (UNSAFE) is correct; finding code is wrong. |
| `STOR-002` | CRITICAL | ❌ | **Variable inserted in middle** — should fire when a new slot+offset appears within the old layout range. Currently STOR-003 fires instead. Verdict (UNSAFE) is correct; finding code is wrong. |
| `STOR-003` | CRITICAL | ✅ | **Type width changed at same slot** — same slot+offset but different byte width. Also fires as a stand-in for STOR-001 and STOR-002 cases (see above). |
| `STOR-004` | CRITICAL | ✅ | **Type semantics changed at same slot** — same slot+offset+width but different `canonicalType`. E.g., `int256 → uint256`. |
| `STOR-007` | HIGH | ⚠️ | **Storage gap insufficient** — fires correctly when new variables are appended *after* the gap. Does not fire when new variables are added *before* the gap (shifting its slot position); STOR-008 fires instead in that case. |
| `STOR-008` | HIGH | ✅ | **Storage gap removed entirely** — fires cleanly when the gap variable is completely absent from the new layout. Also fires (as a false stand-in) when variables are inserted before the gap, shifting its slot. |
| `STOR-009` | MEDIUM | ✅ | **New variable appended beyond existing layout** — fires reliably. Correct on happy-path upgrades. |
| `STOR-010` | LOW | ✅ | **Variable renamed** — same slot+offset+type, different label. Informational only. |

**Gap validation invariant:** `newGapSize + newVarsAdded == oldGapSize`. Variables are counted
as "added" only when they are appended beyond `maxOldSlot`. This is the standard OZ pattern
and works correctly for it.

---

## UUPS Proxy Safety

Runs only when the proxy is detected as UUPS. Requires `ast = true` in `foundry.toml`.

| Code | Severity | Status | What Triggers It |
|------|----------|--------|-----------------|
| `UUPS-001` | CRITICAL | ✅ | **`_authorizeUpgrade` missing** — not present in the new implementation's AST (including inherited contracts). |
| `UUPS-002` | CRITICAL | ✅ | **`_authorizeUpgrade` has an empty body with no access control** — the function exists but has no statements and no access control modifier. The standard OZ `onlyOwner {}` pattern does NOT trigger this (correctly). |
| `UUPS-003` | CRITICAL | ✅ | **`_authorizeUpgrade` has body but no access control** — has statements but no recognized access control modifier or `msg.sender` check. |

**Note on co-firing:** UUPS-002 and UUPS-003 scenarios also commonly trigger ACL-001 and
ACL-007 as co-findings. These are valid — removing access control from `_authorizeUpgrade`
simultaneously removes ownership protection. The co-findings are accurate, not false positives.

---

## Transparent Proxy Safety

Runs only when the proxy is detected as Transparent. Requires `ast = true` in `foundry.toml`.

| Code | Severity | Status | What Triggers It |
|------|----------|--------|-----------------|
| `TPROXY-001` | CRITICAL | ❌ | **Admin slot is zero address** — should fire when no one can manage the proxy. Currently unreachable: a zero admin slot causes proxy classification to fail (PROXY-005 fires instead), blocking all downstream analysis including this check. The verdict is INCOMPLETE rather than UNSAFE. |
| `TPROXY-002` | HIGH | ✅ | **Implementation exposes upgrade functions** — new implementation ABI contains `upgradeTo` or `upgradeToAndCall`. |
| `TPROXY-004` | HIGH | ✅ | **Selector collision with proxy admin functions** — implementation function's 4-byte selector matches one of the five hardcoded proxy admin selectors. |

---

## Initialization Logic

Analyzes the new implementation's AST. Requires `ast = true` in `foundry.toml`.

| Code | Severity | Status | What Triggers It |
|------|----------|--------|-----------------|
| `INIT-001` | CRITICAL | ✅ | **Constructor writes to storage** — constructor contains `Assignment` nodes. Storage writes in constructors are never visible through a proxy. |
| `INIT-002` | HIGH | ✅ | **No initializer function found** — no function carries an `initializer` or `reinitializer` modifier. |
| `INIT-005` | MEDIUM | ✅ | **`_disableInitializers()` not called in constructor** — constructor exists but does not call `_disableInitializers()`. Implementation can be initialized directly. |
| `INIT-006` | HIGH | ✅ | **Multiple functions with `initializer` modifier** — more than one function carries the `initializer` modifier (not `reinitializer`). |

**Foundry config requirement:** `foundry.toml` must include `ast = true` and
`extra_output = ["storageLayout"]`. Without `ast = true`, INIT-002 fires on every run
regardless of whether an initializer exists.

---

## Access Control Regression

Compares old and new contract ASTs for functions that lost access control between versions.
Requires `ast = true` in `foundry.toml`. Skipped for functions already caught by ABI diff.

| Code | Severity | Status | What Triggers It |
|------|----------|--------|-----------------|
| `ACL-001` | CRITICAL | ✅ | **`onlyOwner` removed** — function had `onlyOwner` in old implementation but not in new. |
| `ACL-002` | CRITICAL | ✅ | **`onlyRole` removed** — function had a modifier matching `onlyRole*` in old but not in new. |
| `ACL-003` | HIGH | ✅ | **Custom access control modifier removed** — modifier matching access-control keywords (`only`, `auth`, `authorized`, `owner`, `admin`, `role`, `guard`) present in old but absent in new. |
| `ACL-004` | HIGH | ✅ | **Function visibility widened** — function was `internal`/`private` in old, now `public`/`external`. |
| `ACL-007` | CRITICAL | ✅ | **`_authorizeUpgrade` lost access control** — old had modifier or `msg.sender` check; new does not. |

---

## ABI Compatibility

Compares function and event ABIs between old and new implementations using selector/topic0
as the primary key.

| Code | Severity | Status | What Triggers It |
|------|----------|--------|-----------------|
| `ABI-001` | HIGH | ✅ | **Function selector removed** — 4-byte selector present in old ABI, absent in new. |
| `ABI-002` | CRITICAL | — | **Selector collision in new ABI.** Untestable — Solidity 0.8.x (Error 1860) rejects selector collisions at compile time. Removed from test suite. |
| `ABI-003` | HIGH | ✅ | **Function signature changed** — same name, different selector (different parameter types). |
| `ABI-004` | MEDIUM | ✅ | **Return type changed** — same selector, different `outputs`. |
| `ABI-005` | LOW | ✅ | **New function added** — selector present in new ABI, absent in old. |
| `ABI-006` | HIGH | ✅ | **Event signature changed** — same name, different topic0 OR same topic0 but `indexed` attributes changed. Both cases detected. |
| `ABI-007` | MEDIUM | ✅ | **Event removed** — topic0 present in old ABI, absent in new. |

---

## Known Broken / Unreachable Findings

Summary of findings that do not behave as documented:

| Code | Behavior | Impact |
|------|----------|--------|
| `STOR-001` | STOR-003 fires instead when gap absorbs deleted variable's slot | Verdict (UNSAFE) is still correct; wrong finding code |
| `STOR-002` | STOR-003 fires instead when insertion shifts slots | Verdict (UNSAFE) is still correct; wrong finding code |
| `STOR-007` | Only fires for appended-after-gap pattern; STOR-008 fires instead when vars shift the gap's slot | Verdict (UNSAFE) is still correct; wrong finding code + misleading message |
| `TPROXY-001` | Completely unreachable — zero admin causes PROXY-005 to fire | **Verdict is wrong** — INCOMPLETE (exit 4) instead of UNSAFE (exit 1) |

---

## Pre-Analysis Errors

Detected before analysis begins; surface as CLI exit codes, not finding codes.

| Condition | Exit Code |
|-----------|-----------|
| Missing required arguments (`--proxy`, `--old`, `--new`) | 10 |
| Source file path cannot be resolved | 10 |
| `forge build` fails on the provided contracts | 12 |
| Uncaught engine exception | 12 |

---

## Complete Finding Code Index

| Code | Category | Severity | Status |
|------|----------|----------|--------|
| `PROXY-001` | Proxy Detection | CRITICAL | ✅ |
| `PROXY-002` | Proxy Detection | CRITICAL | ✅ |
| `PROXY-003` | Proxy Detection | CRITICAL | ✅ |
| `PROXY-005` | Proxy Detection | CRITICAL | ✅ |
| `STOR-001` | Storage Layout | CRITICAL | ❌ |
| `STOR-002` | Storage Layout | CRITICAL | ❌ |
| `STOR-003` | Storage Layout | CRITICAL | ✅ |
| `STOR-004` | Storage Layout | CRITICAL | ✅ |
| `STOR-007` | Storage Layout | HIGH | ⚠️ |
| `STOR-008` | Storage Layout | HIGH | ✅ |
| `STOR-009` | Storage Layout | MEDIUM | ✅ |
| `STOR-010` | Storage Layout | LOW | ✅ |
| `ABI-001` | ABI Compatibility | HIGH | ✅ |
| `ABI-002` | ABI Compatibility | CRITICAL | — (untestable) |
| `ABI-003` | ABI Compatibility | HIGH | ✅ |
| `ABI-004` | ABI Compatibility | MEDIUM | ✅ |
| `ABI-005` | ABI Compatibility | LOW | ✅ |
| `ABI-006` | ABI Compatibility | HIGH | ✅ |
| `ABI-007` | ABI Compatibility | MEDIUM | ✅ |
| `UUPS-001` | UUPS Safety | CRITICAL | ✅ |
| `UUPS-002` | UUPS Safety | CRITICAL | ✅ |
| `UUPS-003` | UUPS Safety | CRITICAL | ✅ |
| `TPROXY-001` | Transparent Safety | CRITICAL | ❌ |
| `TPROXY-002` | Transparent Safety | HIGH | ✅ |
| `TPROXY-004` | Transparent Safety | HIGH | ✅ |
| `INIT-001` | Initialization | CRITICAL | ✅ |
| `INIT-002` | Initialization | HIGH | ✅ |
| `INIT-005` | Initialization | MEDIUM | ✅ |
| `INIT-006` | Initialization | HIGH | ✅ |
| `ACL-001` | Access Control | CRITICAL | ✅ |
| `ACL-002` | Access Control | CRITICAL | ✅ |
| `ACL-003` | Access Control | HIGH | ✅ |
| `ACL-004` | Access Control | HIGH | ✅ |
| `ACL-007` | Access Control | CRITICAL | ✅ |

**Totals:** 28 verified ✅, 3 broken ❌ (STOR-001, STOR-002, TPROXY-001), 1 partial ⚠️ (STOR-007), 1 untestable — (ABI-002)
