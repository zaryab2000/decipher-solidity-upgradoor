import type { AnalyzerResult, Finding } from "../types.js";
import { readFileSync, existsSync } from "fs";
import path from "path";

function loadAst(
  projectRoot: string,
  contractFile: string,
  contractName: string,
): object | null {
  const p = path.join(
    projectRoot,
    "out",
    path.basename(contractFile),
    `${contractName}.json`,
  );
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf-8")) as object;
}

function findNodesOfType(ast: unknown, nodeType: string): object[] {
  const results: object[] = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (n["nodeType"] === nodeType) results.push(n as object);
    for (const v of Object.values(n)) walk(v);
  };
  walk(ast);
  return results;
}

export async function analyzeInitializerIntegrity(
  projectRoot: string,
  newContractFile: string,
  newContractName: string,
): Promise<AnalyzerResult> {
  const findings: Finding[] = [];

  const artifact = loadAst(projectRoot, newContractFile, newContractName);
  if (!artifact) {
    return {
      status: "errored",
      error: `Build artifact not found for ${newContractName}`,
    };
  }

  const functions = findNodesOfType(
    artifact,
    "FunctionDefinition",
  ) as Array<Record<string, unknown>>;

  // INIT-001: Constructor writes to storage
  const constructors = functions.filter((f) => f["kind"] === "constructor");
  for (const ctor of constructors) {
    const hasStorageWrite = findNodesOfType(ctor, "Assignment").length > 0;
    if (hasStorageWrite) {
      findings.push({
        code: "INIT-001",
        severity: "CRITICAL",
        confidence: "HIGH_CONFIDENCE",
        title: "Constructor writes to storage",
        description:
          "The constructor contains storage writes. In upgradeable contracts, constructors run " +
          "only once on the implementation — storage in the proxy is unaffected.",
        details: { contractName: newContractName },
        remediation:
          "Move initialization logic from the constructor to an `initialize()` function with " +
          "the `initializer` modifier.",
      });
    }
  }

  // INIT-005: _disableInitializers() not called in constructor
  const hasDisableInitializers = constructors.some((ctor) =>
    JSON.stringify(ctor["body"] ?? {}).includes("_disableInitializers"),
  );
  if (!hasDisableInitializers && constructors.length > 0) {
    findings.push({
      code: "INIT-005",
      severity: "MEDIUM",
      confidence: "HIGH_CONFIDENCE",
      title: "_disableInitializers() not called in constructor",
      description:
        "The implementation constructor does not call _disableInitializers(). Without this, " +
        "someone could call initialize() on the bare implementation contract.",
      details: { contractName: newContractName },
      remediation:
        "Add `constructor() { _disableInitializers(); }` to the implementation contract.",
    });
  }

  // INIT-002: No initializer/reinitializer modifier found
  const initializerFunctions = functions.filter((f) => {
    const modifiers = f["modifiers"] as
      | Array<{ modifierName?: { name?: string } }>
      | undefined;
    return modifiers?.some((m) =>
      ["initializer", "reinitializer"].includes(m.modifierName?.name ?? ""),
    );
  });

  if (initializerFunctions.length === 0) {
    findings.push({
      code: "INIT-002",
      severity: "HIGH",
      confidence: "HIGH_CONFIDENCE",
      title: "No initializer or reinitializer modifier found",
      description:
        "The new implementation has no function with the `initializer` or `reinitializer` modifier.",
      details: { contractName: newContractName },
      remediation:
        "Add an `initialize()` function with the `initializer` modifier (for new deployments) " +
        "or a `reinitialize()` function with the `reinitializer` modifier (for upgrades).",
    });
  }

  // INIT-006: Multiple functions have initializer modifier
  const multipleInitializers = initializerFunctions.filter((f) => {
    const mods = f["modifiers"] as
      | Array<{ modifierName?: { name?: string } }>
      | undefined;
    return mods?.some((m) => m.modifierName?.name === "initializer");
  });
  if (multipleInitializers.length > 1) {
    findings.push({
      code: "INIT-006",
      severity: "HIGH",
      confidence: "HIGH_CONFIDENCE",
      title: "Multiple functions with initializer modifier",
      description:
        `${multipleInitializers.length} functions have the \`initializer\` modifier. ` +
        `Only one initializer function is allowed.`,
      details: { functions: multipleInitializers.map((f) => f["name"]) },
      remediation:
        "Remove duplicate initializer modifiers. Use `reinitializer` for subsequent " +
        "initialization functions.",
    });
  }

  return { status: "completed", findings };
}
