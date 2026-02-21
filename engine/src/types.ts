// Verdict
export type Verdict = "SAFE" | "UNSAFE" | "REVIEW_REQUIRED" | "INCOMPLETE";

// Severity
export type Severity = "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
export type Confidence = "HIGH_CONFIDENCE" | "MEDIUM_CONFIDENCE";

// Finding
export interface Finding {
  code: string;
  severity: Severity;
  confidence: Confidence;
  title: string;
  description: string;
  details: Record<string, unknown>;
  location?: {
    contract?: string;
    function?: string;
    slot?: number;
    offset?: number;
    file?: string;
    line?: number;
  };
  remediation: string;
}

// Analyzer result (isolated error policy)
export type AnalyzerResult =
  | { status: "completed"; findings: Finding[] }
  | { status: "skipped"; reason: string }
  | { status: "errored"; error: string };

// Proxy type
export type ProxyType = "transparent" | "uups" | "unknown";

// Storage layout entry (canonical form)
export interface CanonicalStorageEntry {
  slot: number;
  offset: number;
  length: number;
  canonicalType: string;
  label: string;
  contractOrigin: string;
  inheritanceIndex: number;
}

// Engine input
export interface EngineInput {
  proxyAddress: string;
  oldImplementationPath: string; // v0: local path only
  newImplementationPath: string;
  rpcUrl: string;
  options?: {
    contractName?: string;
    chainId?: number;
    failOnSeverity?: "CRITICAL" | "HIGH" | "MEDIUM" | "LOW";
  };
}

// Engine result
export interface EngineResult {
  verdict: Verdict;
  highestSeverity: Severity | null;
  findings: Finding[];
  reports: {
    markdown: string;
  };
  analyzerStatus: Record<string, "completed" | "skipped" | "errored">;
}

// Proxy detection result (internal, passed between analyzers)
export interface ProxyInfo {
  type: ProxyType;
  proxyAddress: string;
  implementationAddress: string;
  adminAddress?: string;
}
