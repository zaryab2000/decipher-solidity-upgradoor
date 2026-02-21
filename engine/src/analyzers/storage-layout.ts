import type { CanonicalStorageEntry, AnalyzerResult, Finding } from "../types.js";

export function analyzeStorageLayout(
  oldLayout: CanonicalStorageEntry[],
  newLayout: CanonicalStorageEntry[],
): AnalyzerResult {
  const findings: Finding[] = [];

  // Build maps keyed by slot+offset for fast lookup
  const oldBySlotOffset = new Map(oldLayout.map((e) => [`${e.slot}:${e.offset}`, e]));
  const newBySlotOffset = new Map(newLayout.map((e) => [`${e.slot}:${e.offset}`, e]));

  // STOR-001: Variable deleted (exists in old, not in new at same slot+offset)
  for (const [key, oldEntry] of oldBySlotOffset) {
    if (!newBySlotOffset.has(key)) {
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
  const maxOldSlot = Math.max(...oldLayout.map((e) => e.slot), 0);
  for (const newEntry of newLayout) {
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
    (e) => !oldBySlotOffset.has(`${e.slot}:${e.offset}`) && e.slot > maxOldSlot,
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
  validateGaps(oldLayout, newLayout, findings);

  return { status: "completed", findings };
}

function validateGaps(
  oldLayout: CanonicalStorageEntry[],
  newLayout: CanonicalStorageEntry[],
  findings: Finding[],
): void {
  const gapRegex = /gap$/i;
  const oldGaps = oldLayout.filter(
    (e) => gapRegex.test(e.label) && e.canonicalType.startsWith("uint256["),
  );
  const newGaps = newLayout.filter(
    (e) => gapRegex.test(e.label) && e.canonicalType.startsWith("uint256["),
  );

  for (const oldGap of oldGaps) {
    const oldN = extractArraySize(oldGap.canonicalType);
    const matchingNewGap = newGaps.find((g) => g.contractOrigin === oldGap.contractOrigin);

    if (!matchingNewGap) {
      findings.push({
        code: "STOR-008",
        severity: "HIGH",
        confidence: "HIGH_CONFIDENCE",
        title: "Storage gap removed",
        description:
          `Storage gap "${oldGap.label}" in ${oldGap.contractOrigin} was removed entirely ` +
          `in the new implementation.`,
        details: { oldGapSize: oldN, contract: oldGap.contractOrigin },
        location: { slot: oldGap.slot, contract: oldGap.contractOrigin },
        remediation:
          "Do not remove storage gaps. If adding new variables, decrement the gap size by " +
          "the number of new slots consumed.",
      });
      continue;
    }

    const newN = extractArraySize(matchingNewGap.canonicalType);
    const newVarsAfterGap = newLayout.filter(
      (e) =>
        e.contractOrigin === oldGap.contractOrigin &&
        e.slot > oldGap.slot &&
        !gapRegex.test(e.label),
    ).length;

    if (newN + newVarsAfterGap < oldN) {
      findings.push({
        code: "STOR-007",
        severity: "HIGH",
        confidence: "HIGH_CONFIDENCE",
        title: "Storage gap insufficient",
        description:
          `Gap shrank by ${oldN - newN} slots but only ${newVarsAfterGap} new variable(s) added. ` +
          `Expected ${newN} + ${newVarsAfterGap} = ${newN + newVarsAfterGap} >= ${oldN}.`,
        details: { oldGapSize: oldN, newGapSize: newN, newVarsAdded: newVarsAfterGap },
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
