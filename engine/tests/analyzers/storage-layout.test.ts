import { describe, it, expect } from "vitest";
import { analyzeStorageLayout } from "../../src/analyzers/storage-layout.js";
import type { CanonicalStorageEntry } from "../../src/types.js";

function entry(
  slot: number,
  offset: number,
  label: string,
  canonicalType: string,
  length = 32,
  contractOrigin = "src/Contract.sol:Contract",
): CanonicalStorageEntry {
  return { slot, offset, label, canonicalType, length, contractOrigin, inheritanceIndex: slot };
}

describe("analyzeStorageLayout", () => {
  it("identical layouts → no findings", () => {
    const layout = [entry(0, 0, "value", "uint256")];
    const result = analyzeStorageLayout(layout, layout);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.findings).toHaveLength(0);
    }
  });

  it("STOR-001: variable deleted → CRITICAL finding", () => {
    const old = [entry(0, 0, "value", "uint256"), entry(1, 0, "owner", "address", 20)];
    const newLayout = [entry(0, 0, "value", "uint256")];
    const result = analyzeStorageLayout(old, newLayout);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      const stor001 = result.findings.filter((f) => f.code === "STOR-001");
      expect(stor001).toHaveLength(1);
      expect(stor001[0]!.severity).toBe("CRITICAL");
    }
  });

  it("STOR-002: variable inserted in middle → CRITICAL finding", () => {
    const old = [entry(0, 0, "a", "uint256"), entry(2, 0, "b", "uint256")];
    const newLayout = [
      entry(0, 0, "a", "uint256"),
      entry(1, 0, "inserted", "uint256"),
      entry(2, 0, "b", "uint256"),
    ];
    const result = analyzeStorageLayout(old, newLayout);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      const stor002 = result.findings.filter((f) => f.code === "STOR-002");
      expect(stor002).toHaveLength(1);
      expect(stor002[0]!.severity).toBe("CRITICAL");
    }
  });

  it("STOR-003: type width changed → CRITICAL finding", () => {
    const old = [entry(0, 0, "value", "uint256", 32)];
    const newLayout = [entry(0, 0, "value", "uint128", 16)];
    const result = analyzeStorageLayout(old, newLayout);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      const stor003 = result.findings.filter((f) => f.code === "STOR-003");
      expect(stor003).toHaveLength(1);
      expect(stor003[0]!.severity).toBe("CRITICAL");
    }
  });

  it("STOR-004: same width, different type → CRITICAL finding", () => {
    const old = [entry(0, 0, "value", "uint256", 32)];
    const newLayout = [entry(0, 0, "value", "bytes32", 32)];
    const result = analyzeStorageLayout(old, newLayout);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      const stor004 = result.findings.filter((f) => f.code === "STOR-004");
      expect(stor004).toHaveLength(1);
      expect(stor004[0]!.severity).toBe("CRITICAL");
    }
  });

  it("STOR-009: new variable appended → MEDIUM finding", () => {
    const old = [entry(0, 0, "value", "uint256")];
    const newLayout = [entry(0, 0, "value", "uint256"), entry(1, 0, "newVar", "address", 20)];
    const result = analyzeStorageLayout(old, newLayout);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      const stor009 = result.findings.filter((f) => f.code === "STOR-009");
      expect(stor009).toHaveLength(1);
      expect(stor009[0]!.severity).toBe("MEDIUM");
    }
  });

  it("STOR-010: variable renamed, same type → LOW finding", () => {
    const old = [entry(0, 0, "oldName", "uint256")];
    const newLayout = [entry(0, 0, "newName", "uint256")];
    const result = analyzeStorageLayout(old, newLayout);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      const stor010 = result.findings.filter((f) => f.code === "STOR-010");
      expect(stor010).toHaveLength(1);
      expect(stor010[0]!.severity).toBe("LOW");
    }
  });

  it("safe upgrade: only new variables appended → only STOR-009, no CRITICAL", () => {
    const old = [entry(0, 0, "value", "uint256")];
    const newLayout = [
      entry(0, 0, "value", "uint256"),
      entry(1, 0, "extra", "uint256"),
    ];
    const result = analyzeStorageLayout(old, newLayout);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      const criticals = result.findings.filter((f) => f.severity === "CRITICAL");
      expect(criticals).toHaveLength(0);
    }
  });
});
