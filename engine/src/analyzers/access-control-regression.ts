import type { AnalyzerResult, Finding } from "../types.js";
import { readFileSync, existsSync } from "fs";
import path from "path";

const ACCESS_CONTROL_MODIFIER_KEYWORDS = [
  "only",
  "auth",
  "authorized",
  "owner",
  "admin",
  "role",
  "guard",
];

function isAccessControlModifier(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCESS_CONTROL_MODIFIER_KEYWORDS.some((kw) => lower.includes(kw));
}

function loadFunctions(
  projectRoot: string,
  contractFile: string,
  contractName: string,
): Array<Record<string, unknown>> {
  const p = path.join(
    projectRoot,
    "out",
    path.basename(contractFile),
    `${contractName}.json`,
  );
  if (!existsSync(p)) return [];
  const artifact = JSON.parse(readFileSync(p, "utf-8")) as Record<string, unknown>;
  const fns: Array<Record<string, unknown>> = [];
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    if (n["nodeType"] === "FunctionDefinition") fns.push(n);
    for (const v of Object.values(n)) walk(v);
  };
  walk(artifact);
  return fns;
}

interface FunctionInfo {
  visibility: string;
  modifiers: string[];
  hasMsgSenderCheck: boolean;
}

type FunctionMap = Map<string, FunctionInfo>;

function buildFunctionMap(functions: Array<Record<string, unknown>>): FunctionMap {
  const map: FunctionMap = new Map();
  for (const fn of functions) {
    const name = fn["name"] as string | undefined;
    if (!name) continue;
    const modifiers = (
      fn["modifiers"] as Array<{ modifierName?: { name?: string } }> | undefined ?? []
    )
      .map((m) => m.modifierName?.name ?? "")
      .filter(Boolean);
    const bodyStr = JSON.stringify(fn["body"] ?? {});
    map.set(name, {
      visibility: (fn["visibility"] as string | undefined) ?? "internal",
      modifiers,
      hasMsgSenderCheck:
        bodyStr.includes("msg.sender") || bodyStr.includes("_msgSender"),
    });
  }
  return map;
}

export async function analyzeAccessControlRegression(
  projectRoot: string,
  oldContractFile: string,
  oldContractName: string,
  newContractFile: string,
  newContractName: string,
): Promise<AnalyzerResult> {
  const findings: Finding[] = [];

  const oldFunctions = loadFunctions(projectRoot, oldContractFile, oldContractName);
  const newFunctions = loadFunctions(projectRoot, newContractFile, newContractName);

  const oldMap = buildFunctionMap(oldFunctions);
  const newMap = buildFunctionMap(newFunctions);

  for (const [fnName, oldFn] of oldMap) {
    const newFn = newMap.get(fnName);
    if (!newFn) continue; // function removed — ABI diff handles this

    // ACL-001: onlyOwner removed
    const hadOnlyOwner = oldFn.modifiers.includes("onlyOwner");
    const hasOnlyOwner = newFn.modifiers.includes("onlyOwner");
    if (hadOnlyOwner && !hasOnlyOwner) {
      findings.push({
        code: "ACL-001",
        severity: "CRITICAL",
        confidence: "HIGH_CONFIDENCE",
        title: "onlyOwner modifier removed",
        description:
          `Function "${fnName}" had \`onlyOwner\` in the old implementation but not in the new one.`,
        details: { function: fnName },
        location: { function: fnName },
        remediation:
          "Restore the onlyOwner modifier or replace it with equivalent access control.",
      });
    }

    // ACL-002: onlyRole removed
    const hadOnlyRole = oldFn.modifiers.some((m) => m.startsWith("onlyRole"));
    const hasOnlyRole = newFn.modifiers.some((m) => m.startsWith("onlyRole"));
    if (hadOnlyRole && !hasOnlyRole) {
      findings.push({
        code: "ACL-002",
        severity: "CRITICAL",
        confidence: "HIGH_CONFIDENCE",
        title: "onlyRole modifier removed",
        description:
          `Function "${fnName}" had a role-based access modifier in the old implementation ` +
          `but not in the new one.`,
        details: {
          function: fnName,
          oldModifiers: oldFn.modifiers,
          newModifiers: newFn.modifiers,
        },
        location: { function: fnName },
        remediation: "Restore the role-based access control modifier.",
      });
    }

    // ACL-003: Custom access control modifier removed
    const hadCustom = oldFn.modifiers.some(isAccessControlModifier);
    const hasCustom = newFn.modifiers.some(isAccessControlModifier);
    if (hadCustom && !hasCustom && !hadOnlyOwner && !hadOnlyRole) {
      findings.push({
        code: "ACL-003",
        severity: "HIGH",
        confidence: "HIGH_CONFIDENCE",
        title: "Custom access control modifier removed",
        description:
          `Function "${fnName}" had a custom access control modifier (${oldFn.modifiers.join(", ")}) ` +
          `in the old implementation.`,
        details: { function: fnName, oldModifiers: oldFn.modifiers },
        location: { function: fnName },
        remediation:
          "Verify that the removal of this modifier is intentional and that the function is " +
          "still appropriately protected.",
      });
    }

    // ACL-004: Visibility widened (internal → public/external)
    const wasInternal =
      oldFn.visibility === "internal" || oldFn.visibility === "private";
    const isNowPublic =
      newFn.visibility === "public" || newFn.visibility === "external";
    if (wasInternal && isNowPublic) {
      findings.push({
        code: "ACL-004",
        severity: "HIGH",
        confidence: "HIGH_CONFIDENCE",
        title: "Function visibility widened",
        description:
          `Function "${fnName}" was ${oldFn.visibility} in the old implementation and is now ` +
          `${newFn.visibility}. Anyone can call it.`,
        details: {
          function: fnName,
          oldVisibility: oldFn.visibility,
          newVisibility: newFn.visibility,
        },
        location: { function: fnName },
        remediation:
          "Verify this visibility change is intentional. Add access control if the function " +
          "modifies privileged state.",
      });
    }

    // ACL-007: _authorizeUpgrade access control weakened
    if (fnName === "_authorizeUpgrade") {
      const hadAc =
        oldFn.modifiers.some(isAccessControlModifier) || oldFn.hasMsgSenderCheck;
      const hasAc =
        newFn.modifiers.some(isAccessControlModifier) || newFn.hasMsgSenderCheck;
      if (hadAc && !hasAc) {
        findings.push({
          code: "ACL-007",
          severity: "CRITICAL",
          confidence: "HIGH_CONFIDENCE",
          title: "_authorizeUpgrade access control weakened",
          description:
            "The old implementation had access control on _authorizeUpgrade, but the new " +
            "implementation does not.",
          details: { function: fnName },
          location: { function: fnName },
          remediation: "Restore access control to _authorizeUpgrade.",
        });
      }
    }
  }

  return { status: "completed", findings };
}
