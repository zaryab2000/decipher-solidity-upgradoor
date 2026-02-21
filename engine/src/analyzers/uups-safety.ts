import type { AnalyzerResult, Finding } from "../types.js";
import { readFileSync, existsSync } from "fs";
import path from "path";

// Load AST from forge build artifacts (out/<ContractFile>/<ContractName>.json)
function loadBuildArtifact(
  projectRoot: string,
  contractFile: string,
  contractName: string,
): object | null {
  const artifactPath = path.join(
    projectRoot,
    "out",
    path.basename(contractFile),
    `${contractName}.json`,
  );
  if (!existsSync(artifactPath)) return null;
  return JSON.parse(readFileSync(artifactPath, "utf-8")) as object;
}

// Extract function definitions from AST nodes
function findFunctionInAst(ast: object, functionName: string): object | null {
  const walk = (node: unknown): object | null => {
    if (!node || typeof node !== "object") return null;
    const n = node as Record<string, unknown>;
    if (n["nodeType"] === "FunctionDefinition" && n["name"] === functionName) {
      return n as object;
    }
    for (const value of Object.values(n)) {
      const found = walk(value);
      if (found) return found;
    }
    return null;
  };
  return walk(ast);
}

// Check if a function definition has access control (modifier or require on msg.sender)
function hasAccessControl(fnNode: object): boolean {
  const fn = fnNode as Record<string, unknown>;
  const modifiers = fn["modifiers"] as
    | Array<{ modifierName?: { name?: string } }>
    | undefined;
  if (modifiers && modifiers.length > 0) {
    const accessModifiers = ["onlyOwner", "onlyRole", "onlyAdmin", "auth", "authorized", "guard"];
    if (
      modifiers.some((m) =>
        accessModifiers.some((am) =>
          m.modifierName?.name?.toLowerCase().includes(am.toLowerCase()),
        ),
      )
    ) {
      return true;
    }
  }
  const bodyText = JSON.stringify(fn["body"] ?? {});
  return bodyText.includes("msg.sender") || bodyText.includes("_msgSender");
}

export async function analyzeUupsSafety(
  projectRoot: string,
  newContractFile: string,
  newContractName: string,
): Promise<AnalyzerResult> {
  const findings: Finding[] = [];

  const artifact = loadBuildArtifact(projectRoot, newContractFile, newContractName);
  if (!artifact) {
    return {
      status: "errored",
      error: `Build artifact not found for ${newContractName}. Run forge build first.`,
    };
  }

  const fnNode = findFunctionInAst(artifact, "_authorizeUpgrade");

  if (!fnNode) {
    findings.push({
      code: "UUPS-001",
      severity: "CRITICAL",
      confidence: "HIGH_CONFIDENCE",
      title: "_authorizeUpgrade not found",
      description:
        "The new implementation does not define or inherit _authorizeUpgrade. UUPS proxies " +
        "require this function to authorize upgrades.",
      details: { contractName: newContractName },
      remediation:
        "Add `function _authorizeUpgrade(address) internal override onlyOwner {}` to the contract.",
    });
    return { status: "completed", findings };
  }

  const fn = fnNode as Record<string, unknown>;
  const body = fn["body"] as Record<string, unknown> | null;

  if (!body || !body["statements"] || (body["statements"] as unknown[]).length === 0) {
    findings.push({
      code: "UUPS-002",
      severity: "CRITICAL",
      confidence: "HIGH_CONFIDENCE",
      title: "_authorizeUpgrade has empty body",
      description:
        "The _authorizeUpgrade function exists but has an empty body. Anyone can call upgradeTo() " +
        "to upgrade the proxy.",
      details: { contractName: newContractName },
      remediation:
        "Add access control: `function _authorizeUpgrade(address) internal override onlyOwner {}`",
    });
    return { status: "completed", findings };
  }

  if (!hasAccessControl(fnNode)) {
    findings.push({
      code: "UUPS-003",
      severity: "CRITICAL",
      confidence: "HIGH_CONFIDENCE",
      title: "_authorizeUpgrade has no access control",
      description:
        "The _authorizeUpgrade function has a body but no detectable access control modifier or " +
        "msg.sender check.",
      details: { contractName: newContractName },
      remediation:
        "Add `onlyOwner` or equivalent access control modifier to _authorizeUpgrade.",
    });
  }

  return { status: "completed", findings };
}
