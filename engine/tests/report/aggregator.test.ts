import { describe, it, expect } from "vitest";
import { aggregateResults } from "../../src/report/aggregator.js";
import type { AnalyzerResult, Finding } from "../../src/types.js";

function makeFinding(code: string, severity: Finding["severity"]): Finding {
  return {
    code,
    severity,
    confidence: "HIGH_CONFIDENCE",
    title: `${code} title`,
    description: `${code} description`,
    details: {},
    remediation: `Fix ${code}`,
  };
}

describe("aggregateResults", () => {
  it("all completed with no findings → SAFE", () => {
    const results: Record<string, AnalyzerResult> = {
      "proxy-detection": { status: "completed", findings: [] },
      "storage-layout": { status: "completed", findings: [] },
      "abi-diff": { status: "completed", findings: [] },
      "uups-safety": { status: "completed", findings: [] },
      "transparent-safety": { status: "skipped", reason: "proxy-type-is-uups" },
      "initializer-integrity": { status: "completed", findings: [] },
      "access-control-regression": { status: "completed", findings: [] },
    };
    const agg = aggregateResults(results);
    expect(agg.verdict).toBe("SAFE");
    expect(agg.highestSeverity).toBeNull();
    expect(agg.findings).toHaveLength(0);
  });

  it("CRITICAL finding → UNSAFE", () => {
    const results: Record<string, AnalyzerResult> = {
      "proxy-detection": { status: "completed", findings: [] },
      "storage-layout": {
        status: "completed",
        findings: [makeFinding("STOR-001", "CRITICAL")],
      },
      "abi-diff": { status: "completed", findings: [] },
      "uups-safety": { status: "completed", findings: [] },
      "transparent-safety": { status: "skipped", reason: "proxy-type-is-uups" },
      "initializer-integrity": { status: "completed", findings: [] },
      "access-control-regression": { status: "completed", findings: [] },
    };
    const agg = aggregateResults(results);
    expect(agg.verdict).toBe("UNSAFE");
    expect(agg.highestSeverity).toBe("CRITICAL");
  });

  it("HIGH finding only → UNSAFE", () => {
    const results: Record<string, AnalyzerResult> = {
      "proxy-detection": { status: "completed", findings: [] },
      "storage-layout": { status: "completed", findings: [makeFinding("ABI-001", "HIGH")] },
      "abi-diff": { status: "completed", findings: [] },
      "uups-safety": { status: "skipped", reason: "transparent" },
      "transparent-safety": { status: "completed", findings: [] },
      "initializer-integrity": { status: "completed", findings: [] },
      "access-control-regression": { status: "completed", findings: [] },
    };
    const agg = aggregateResults(results);
    expect(agg.verdict).toBe("UNSAFE");
    expect(agg.highestSeverity).toBe("HIGH");
  });

  it("MEDIUM finding only → REVIEW_REQUIRED", () => {
    const results: Record<string, AnalyzerResult> = {
      "proxy-detection": { status: "completed", findings: [] },
      "storage-layout": {
        status: "completed",
        findings: [makeFinding("STOR-009", "MEDIUM")],
      },
      "abi-diff": { status: "completed", findings: [] },
      "uups-safety": { status: "completed", findings: [] },
      "transparent-safety": { status: "skipped", reason: "uups" },
      "initializer-integrity": { status: "completed", findings: [] },
      "access-control-regression": { status: "completed", findings: [] },
    };
    const agg = aggregateResults(results);
    expect(agg.verdict).toBe("REVIEW_REQUIRED");
    expect(agg.highestSeverity).toBe("MEDIUM");
  });

  it("critical-capable analyzer errored → INCOMPLETE", () => {
    const results: Record<string, AnalyzerResult> = {
      "proxy-detection": { status: "completed", findings: [] },
      "storage-layout": { status: "errored", error: "Something broke" },
      "abi-diff": { status: "completed", findings: [] },
      "uups-safety": { status: "completed", findings: [] },
      "transparent-safety": { status: "skipped", reason: "uups" },
      "initializer-integrity": { status: "completed", findings: [] },
      "access-control-regression": { status: "completed", findings: [] },
    };
    const agg = aggregateResults(results);
    expect(agg.verdict).toBe("INCOMPLETE");
  });

  it("all seven analyzer keys are present in analyzerStatus", () => {
    const results: Record<string, AnalyzerResult> = {
      "proxy-detection": { status: "completed", findings: [] },
      "storage-layout": { status: "completed", findings: [] },
      "abi-diff": { status: "completed", findings: [] },
      "uups-safety": { status: "completed", findings: [] },
      "transparent-safety": { status: "skipped", reason: "uups" },
      "initializer-integrity": { status: "completed", findings: [] },
      "access-control-regression": { status: "completed", findings: [] },
    };
    const agg = aggregateResults(results);
    const keys = Object.keys(agg.analyzerStatus);
    expect(keys).toContain("proxy-detection");
    expect(keys).toContain("storage-layout");
    expect(keys).toContain("abi-diff");
    expect(keys).toContain("uups-safety");
    expect(keys).toContain("transparent-safety");
    expect(keys).toContain("initializer-integrity");
    expect(keys).toContain("access-control-regression");
  });
});
