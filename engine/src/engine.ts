import { createPublicClient, http } from "viem";
import type { EngineInput, EngineResult, AnalyzerResult, ProxyInfo } from "./types.js";
import { UpgradoorError } from "./errors.js";
import { detectProxy } from "./analyzers/proxy-detection.js";
import { resolveImplementations } from "./resolver/input-resolver.js";
import { analyzeStorageLayout } from "./analyzers/storage-layout.js";
import { analyzeAbiDiff } from "./analyzers/abi-diff.js";
import { analyzeUupsSafety } from "./analyzers/uups-safety.js";
import { analyzeTransparentSafety } from "./analyzers/transparent-safety.js";
import { analyzeInitializerIntegrity } from "./analyzers/initializer-integrity.js";
import { analyzeAccessControlRegression } from "./analyzers/access-control-regression.js";
import { aggregateResults } from "./report/aggregator.js";
import { generateMarkdownReport } from "./report/markdown-report.js";
import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

export class UpgradoorEngine {
  async analyze(input: EngineInput): Promise<EngineResult> {
    await this.validateFoundry();

    const client = createPublicClient({ transport: http(input.rpcUrl) });
    const analyzerResults: Record<string, AnalyzerResult> = {};

    // Step 1: Proxy detection
    const { proxyInfo, result: proxyResult } = await detectProxy(
      client,
      input.proxyAddress as `0x${string}`,
    );
    analyzerResults["proxy-detection"] = proxyResult;

    // Halt if proxy detection found a blocking issue
    const blockingProxyCodes = ["PROXY-001", "PROXY-002", "PROXY-003", "PROXY-005"];
    const proxyFindings =
      proxyResult.status === "completed" ? proxyResult.findings : [];
    if (proxyFindings.some((f) => blockingProxyCodes.includes(f.code))) {
      for (const name of [
        "storage-layout",
        "abi-diff",
        "uups-safety",
        "transparent-safety",
        "initializer-integrity",
        "access-control-regression",
      ]) {
        analyzerResults[name] = { status: "skipped", reason: "proxy-detection-failed" };
      }
      const aggregated = aggregateResults(analyzerResults);
      return {
        verdict: "INCOMPLETE",
        highestSeverity: null,
        findings: aggregated.findings,
        reports: {
          markdown: generateMarkdownReport(
            aggregated,
            proxyInfo,
            this.buildMetadata(input),
          ),
        },
        analyzerStatus: aggregated.analyzerStatus,
      };
    }

    // Step 2: Resolve implementations (runs forge build + forge inspect)
    let resolved;
    try {
      resolved = await resolveImplementations(input);
    } catch (err) {
      if (err instanceof UpgradoorError) throw err;
      throw new UpgradoorError(
        "RUNTIME_ERROR",
        `Failed to resolve implementations: ${String(err)}`,
      );
    }

    // Step 3: Run all analyzers in parallel
    const proxyType = proxyInfo?.type;

    const [storageResult, abiResult, proxyPatternResult, initResult, aclResult] =
      await Promise.allSettled([
        Promise.resolve(analyzeStorageLayout(resolved.old.layout, resolved.new.layout)),
        Promise.resolve(analyzeAbiDiff(resolved.old.abi, resolved.new.abi)),
        proxyType === "uups"
          ? analyzeUupsSafety(
              resolved.projectRoot,
              resolved.new.filePath,
              resolved.new.contractName,
            )
          : proxyType === "transparent"
            ? analyzeTransparentSafety(proxyInfo as ProxyInfo, resolved.new.abi)
            : Promise.resolve<AnalyzerResult>({
                status: "skipped",
                reason: "proxy-type-unknown",
              }),
        analyzeInitializerIntegrity(
          resolved.projectRoot,
          resolved.new.filePath,
          resolved.new.contractName,
        ),
        analyzeAccessControlRegression(
          resolved.projectRoot,
          resolved.old.filePath,
          resolved.old.contractName,
          resolved.new.filePath,
          resolved.new.contractName,
        ),
      ]);

    analyzerResults["storage-layout"] = settledToResult(storageResult);
    analyzerResults["abi-diff"] = settledToResult(abiResult);

    // Key the proxy-pattern analyzer by the actual proxy type
    const proxyPatternKey =
      proxyType === "uups" ? "uups-safety" : "transparent-safety";
    analyzerResults[proxyPatternKey] = settledToResult(proxyPatternResult);

    // Ensure both proxy-pattern keys exist in status
    const otherProxyKey =
      proxyType === "uups" ? "transparent-safety" : "uups-safety";
    analyzerResults[otherProxyKey] = {
      status: "skipped",
      reason: `proxy-type-is-${proxyType ?? "unknown"}`,
    };

    analyzerResults["initializer-integrity"] = settledToResult(initResult);
    analyzerResults["access-control-regression"] = settledToResult(aclResult);

    // Step 4: Aggregate and generate report
    const aggregated = aggregateResults(analyzerResults);
    const markdown = generateMarkdownReport(
      aggregated,
      proxyInfo,
      this.buildMetadata(input),
    );

    return {
      verdict: aggregated.verdict,
      highestSeverity: aggregated.highestSeverity,
      findings: aggregated.findings,
      reports: { markdown },
      analyzerStatus: aggregated.analyzerStatus,
    };
  }

  private buildMetadata(input: EngineInput) {
    return {
      proxyAddress: input.proxyAddress,
      newImplementationPath: input.newImplementationPath,
      oldImplementationPath: input.oldImplementationPath,
      timestamp: new Date().toISOString(),
    };
  }

  private async validateFoundry(): Promise<void> {
    try {
      await execAsync("forge --version");
    } catch {
      throw new UpgradoorError(
        "FOUNDRY_NOT_FOUND",
        "Foundry is required but not found in PATH. " +
          "Install: curl -L https://foundry.paradigm.xyz | bash && foundryup",
      );
    }
  }
}

function settledToResult(
  settled: PromiseSettledResult<AnalyzerResult>,
): AnalyzerResult {
  if (settled.status === "fulfilled") return settled.value;
  return { status: "errored", error: String(settled.reason) };
}
