import type { CanonicalStorageEntry, AnalyzerResult, Finding } from "../types.js";

const GAP_LABEL_RE = /gap$/i;

function isGapEntry(entry: CanonicalStorageEntry): boolean {
  return GAP_LABEL_RE.test(entry.label) && entry.canonicalType.startsWith("uint256[");
}

export function analyzeStorageLayout(
  oldLayout: CanonicalStorageEntry[],
  newLayout: CanonicalStorageEntry[],
): AnalyzerResult {
  const findings: Finding[] = [];

  // Build maps keyed by slot+offset for fast lookup
  const oldBySlotOffset = new Map(oldLayout.map((e) => [`${e.slot}:${e.offset}`, e]));
  const newBySlotOffset = new Map(newLayout.map((e) => [`${e.slot}:${e.offset}`, e]));

  // STOR-001: Variable deleted (exists in old, not in new at same slot+offset)
  // STOR-003: Type width changed at same slot+offset
  // STOR-004: Type semantics changed at same slot+offset
  // STOR-010: Variable renamed at same slot+offset
  for (const [key, oldEntry] of oldBySlotOffset) {
    // Skip gap entries — size changes are handled exclusively by validateGaps()
    if (isGapEntry(oldEntry)) continue;

    if (!newBySlotOffset.has(key)) {
      // Before emitting STOR-001, check if the label moved to a higher slot (insertion shifted it).
      // If so, STOR-002 will handle the shifted variable — suppress the deletion finding.
      const appearsAtHigherSlot = newLayout.some(
        (e) => e.label === oldEntry.label && e.slot > oldEntry.slot,
      );
      if (appearsAtHigherSlot) continue;

      findings.push({
        code: "STOR-001",
        severity: "CRITICAL",
        confidence: "HIGH_CONFIDENCE",
        title: "Storage variable deleted",
        description:
          `Variable "${oldEntry.label}" at slot ${oldEntry.slot} offset ${oldEntry.offset} ` +
          `was deleted in the new implementation.`,
        details: {
          slot: oldEntry.slot,
          offset: oldEntry.offset,
          label: oldEntry.label,
          type: oldEntry.canonicalType,
        },
        location: {
          slot: oldEntry.slot,
          offset: oldEntry.offset,
          contract: oldEntry.contractOrigin,
        },
        remediation:
          "Do not delete storage variables in upgrades. Mark as unused or replace with a " +
          "padding variable of the same size.",
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
        description:
          `Variable at slot ${oldEntry.slot} changed size: ${oldEntry.canonicalType} ` +
          `(${oldEntry.length} bytes) → ${newEntry.canonicalType} (${newEntry.length} bytes).`,
        details: {
          slot: oldEntry.slot,
          oldType: oldEntry.canonicalType,
          newType: newEntry.canonicalType,
          oldLength: oldEntry.length,
          newLength: newEntry.length,
        },
        location: { slot: oldEntry.slot, offset: oldEntry.offset },
        remediation:
          "Changing the size of a storage variable corrupts all subsequent slots. Use a new " +
          "variable appended at the end instead.",
      });
    }
    // STOR-004: Type semantics changed (same width, different type)
    else if (oldEntry.canonicalType !== newEntry.canonicalType) {
      findings.push({
        code: "STOR-004",
        severity: "CRITICAL",
        confidence: "HIGH_CONFIDENCE",
        title: "Storage variable type semantics changed",
        description:
          `Variable "${oldEntry.label}" at slot ${oldEntry.slot} changed type from ` +
          `${oldEntry.canonicalType} to ${newEntry.canonicalType}.`,
        details: {
          slot: oldEntry.slot,
          oldType: oldEntry.canonicalType,
          newType: newEntry.canonicalType,
        },
        location: { slot: oldEntry.slot, offset: oldEntry.offset },
        remediation:
          "Type changes reinterpret existing on-chain data. Even if sizes match, semantics differ. " +
          "Add a new variable instead.",
      });
    }
    // STOR-010: Renamed (same slot+offset+type, different label) — LOW
    else if (oldEntry.label !== newEntry.label) {
      findings.push({
        code: "STOR-010",
        severity: "LOW",
        confidence: "HIGH_CONFIDENCE",
        title: "Storage variable renamed",
        description:
          `Variable renamed from "${oldEntry.label}" to "${newEntry.label}" at slot ${oldEntry.slot}.`,
        details: { slot: oldEntry.slot, oldLabel: oldEntry.label, newLabel: newEntry.label },
        location: { slot: oldEntry.slot },
        remediation: "Renaming is safe — same slot, offset, and type. No action required.",
      });
    }
  }

  // STOR-002: Variable inserted in middle
  // A new non-gap entry appears at a slot within the old layout range, at a slot:offset
  // that didn't exist in old. This is an insertion that shifts subsequent variables.
  const maxOldSlot = Math.max(...oldLayout.filter((e) => !isGapEntry(e)).map((e) => e.slot), 0);
  for (const newEntry of newLayout) {
    if (isGapEntry(newEntry)) continue;
    if (!oldBySlotOffset.has(`${newEntry.slot}:${newEntry.offset}`) && newEntry.slot <= maxOldSlot) {
      findings.push({
        code: "STOR-002",
        severity: "CRITICAL",
        confidence: "HIGH_CONFIDENCE",
        title: "Storage variable inserted in middle",
        description:
          `New variable "${newEntry.label}" inserted at slot ${newEntry.slot} (within existing layout). ` +
          `This shifts all subsequent variables.`,
        details: { slot: newEntry.slot, label: newEntry.label, type: newEntry.canonicalType },
        location: { slot: newEntry.slot },
        remediation:
          "Never insert variables in the middle of the storage layout. " +
          "Append new variables after the last existing slot.",
      });
    }
  }

  // STOR-009: New variable appended (safe if gap was decremented correctly)
  const newVars = newLayout.filter(
    (e) => !isGapEntry(e) && !oldBySlotOffset.has(`${e.slot}:${e.offset}`) && e.slot > maxOldSlot,
  );
  if (newVars.length > 0) {
    findings.push({
      code: "STOR-009",
      severity: "MEDIUM",
      confidence: "HIGH_CONFIDENCE",
      title: "New storage variable(s) appended",
      description: `${newVars.length} new variable(s) appended after the existing layout.`,
      details: {
        newVariables: newVars.map((v) => ({ slot: v.slot, label: v.label, type: v.canonicalType })),
      },
      remediation:
        "Ensure the storage gap (if any) was decremented by the correct number of slots.",
    });
  }

  // Gap validation (STOR-007, STOR-008)
  // Pass the total count of appended new variables so the gap-insufficiency check can use it.
  // newVars are variables that appear in newLayout but not in oldLayout at any slot.
  const totalNewVarsAdded = newVars.length;
  validateGaps(oldLayout, newLayout, findings, totalNewVarsAdded);

  return { status: "completed", findings };
}

function validateGaps(
  oldLayout: CanonicalStorageEntry[],
  newLayout: CanonicalStorageEntry[],
  findings: Finding[],
  totalNewVarsAdded: number,
): void {
  const oldGaps = oldLayout.filter(isGapEntry);
  const newGaps = newLayout.filter(isGapEntry);

  for (const oldGap of oldGaps) {
    const oldN = extractArraySize(oldGap.canonicalType);

    // Match new gap by slot position — contractOrigin differs across contract versions
    const matchingNewGap = newGaps.find((g) => g.slot === oldGap.slot);

    if (!matchingNewGap) {
      findings.push({
        code: "STOR-008",
        severity: "HIGH",
        confidence: "HIGH_CONFIDENCE",
        title: "Storage gap removed",
        description:
          `Storage gap "${oldGap.label}" at slot ${oldGap.slot} was removed entirely ` +
          `in the new implementation.`,
        details: { oldGapSize: oldN, slot: oldGap.slot },
        location: { slot: oldGap.slot, contract: oldGap.contractOrigin },
        remediation:
          "Do not remove storage gaps. If adding new variables, decrement the gap size by " +
          "the number of new slots consumed.",
      });
      continue;
    }

    const newN = extractArraySize(matchingNewGap.canonicalType);

    // The invariant is: newGapSize + totalNewVarsAdded == oldGapSize.
    // Variables can be appended before or after the gap — what matters is the total count,
    // not their position relative to the gap slot.
    if (newN + totalNewVarsAdded < oldN) {
      findings.push({
        code: "STOR-007",
        severity: "HIGH",
        confidence: "HIGH_CONFIDENCE",
        title: "Storage gap insufficient",
        description:
          `Gap shrank by ${oldN - newN} slots but only ${totalNewVarsAdded} new variable(s) added. ` +
          `Expected ${newN} + ${totalNewVarsAdded} = ${newN + totalNewVarsAdded} >= ${oldN}.`,
        details: { oldGapSize: oldN, newGapSize: newN, newVarsAdded: totalNewVarsAdded },
        location: { slot: matchingNewGap.slot, contract: oldGap.contractOrigin },
        remediation:
          "The gap must decrease by exactly the number of new storage slots used. " +
          "Check that N_new + V_new == N_old.",
      });
    }
  }
}

function extractArraySize(canonicalType: string): number {
  const match = canonicalType.match(/\[(\d+)\]/);
  return match?.[1] !== undefined ? parseInt(match[1], 10) : 0;
}
