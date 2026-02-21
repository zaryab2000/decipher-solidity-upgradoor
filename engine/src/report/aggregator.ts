import type { Finding, Verdict, Severity, AnalyzerResult } from "../types.js";

export interface AggregatedResult {
  verdict: Verdict;
  highestSeverity: Severity | null;
  findings: Finding[];
  analyzerStatus: Record<string, "completed" | "skipped" | "errored">;
}

// Severity ordering for comparison
const SEVERITY_ORDER: Record<Severity, number> = {
  CRITICAL: 4,
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
};

// Analyzers that can produce CRITICAL findings — if any of these error, verdict = INCOMPLETE
const CRITICAL_CAPABLE_ANALYZERS = [
  "proxy-detection",
  "storage-layout",
  "abi-diff",
  "uups-safety",
  "transparent-safety",
  "initializer-integrity",
  "access-control-regression",
];

export function aggregateResults(
  analyzerResults: Record<string, AnalyzerResult>,
): AggregatedResult {
  const findings: Finding[] = [];
  const analyzerStatus: Record<string, "completed" | "skipped" | "errored"> = {};

  for (const [name, result] of Object.entries(analyzerResults)) {
    analyzerStatus[name] = result.status;
    if (result.status === "completed") {
      findings.push(...result.findings);
    }
  }

  // Check if any CRITICAL-capable analyzer errored
  const criticalCapableErrored = CRITICAL_CAPABLE_ANALYZERS.some(
    (name) => analyzerStatus[name] === "errored",
  );

  if (criticalCapableErrored) {
    return { verdict: "INCOMPLETE", highestSeverity: null, findings, analyzerStatus };
  }

  // Compute highest severity
  let highestSeverity: Severity | null = null;
  for (const finding of findings) {
    if (
      !highestSeverity ||
      SEVERITY_ORDER[finding.severity] > SEVERITY_ORDER[highestSeverity]
    ) {
      highestSeverity = finding.severity;
    }
  }

  // Compute verdict
  let verdict: Verdict;
  if (findings.some((f) => f.severity === "CRITICAL")) {
    verdict = "UNSAFE";
  } else if (findings.some((f) => f.severity === "HIGH")) {
    verdict = "UNSAFE";
  } else if (findings.some((f) => f.severity === "MEDIUM")) {
    verdict = "REVIEW_REQUIRED";
  } else {
    verdict = "SAFE";
  }

  return { verdict, highestSeverity, findings, analyzerStatus };
}
