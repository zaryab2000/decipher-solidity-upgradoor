import type { AnalyzerResult, Finding } from "../types.js";
import type { ExtractedAbi } from "../resolver/abi-extractor.js";

export function analyzeAbiDiff(oldAbi: ExtractedAbi, newAbi: ExtractedAbi): AnalyzerResult {
  const findings: Finding[] = [];

  const oldFunctions = new Map(oldAbi.functions.map((f) => [f.selector, f]));
  const newFunctions = new Map(newAbi.functions.map((f) => [f.selector, f]));

  // ABI-001: Function selector removed / ABI-003: Function signature changed
  for (const [selector, fn] of oldFunctions) {
    if (!newFunctions.has(selector)) {
      const sameNameInNew = newAbi.functions.find((f) => f.name === fn.name);
      if (sameNameInNew) {
        findings.push({
          code: "ABI-003",
          severity: "HIGH",
          confidence: "HIGH_CONFIDENCE",
          title: "Function signature changed",
          description:
            `Function "${fn.name}" changed signature: (${fn.inputs.join(",")}) → ` +
            `(${sameNameInNew.inputs.join(",")}).`,
          details: { oldSignature: fn.signature, newSignature: sameNameInNew.signature },
          location: { function: fn.name },
          remediation:
            "Changing function parameters breaks all callers. Add a new function name instead " +
            "of changing the signature.",
        });
      } else {
        findings.push({
          code: "ABI-001",
          severity: "HIGH",
          confidence: "HIGH_CONFIDENCE",
          title: "Function selector removed",
          description:
            `Function "${fn.name}" (selector ${selector}) was removed from the new implementation.`,
          details: { selector, signature: fn.signature },
          location: { function: fn.name },
          remediation:
            "Removing a function breaks all callers. Keep the function or ensure no external " +
            "contracts depend on it.",
        });
      }
    }
  }

  // ABI-002: Selector collision in new impl
  const newSelectors = new Map<string, string>();
  for (const fn of newAbi.functions) {
    if (newSelectors.has(fn.selector)) {
      findings.push({
        code: "ABI-002",
        severity: "CRITICAL",
        confidence: "HIGH_CONFIDENCE",
        title: "Function selector collision",
        description:
          `Two functions in the new implementation share selector ${fn.selector}: ` +
          `"${newSelectors.get(fn.selector)}" and "${fn.signature}".`,
        details: {
          selector: fn.selector,
          function1: newSelectors.get(fn.selector),
          function2: fn.signature,
        },
        remediation: "Rename one of the functions to eliminate the 4-byte selector collision.",
      });
    } else {
      newSelectors.set(fn.selector, fn.signature);
    }
  }

  // ABI-004: Return type changed
  for (const [selector, oldFn] of oldFunctions) {
    const newFn = newFunctions.get(selector);
    if (newFn && JSON.stringify(oldFn.outputs) !== JSON.stringify(newFn.outputs)) {
      findings.push({
        code: "ABI-004",
        severity: "MEDIUM",
        confidence: "HIGH_CONFIDENCE",
        title: "Return type changed",
        description:
          `Function "${oldFn.name}" return type changed from (${oldFn.outputs.join(",")}) ` +
          `to (${newFn.outputs.join(",")}).`,
        details: { selector, oldOutputs: oldFn.outputs, newOutputs: newFn.outputs },
        location: { function: oldFn.name },
        remediation:
          "Callers that decode return values will break. Review all callers of this function.",
      });
    }
  }

  // ABI-005: New function added (LOW — informational)
  for (const [selector, fn] of newFunctions) {
    if (!oldFunctions.has(selector)) {
      findings.push({
        code: "ABI-005",
        severity: "LOW",
        confidence: "HIGH_CONFIDENCE",
        title: "New function added",
        description:
          `Function "${fn.name}" (selector ${selector}) was added in the new implementation.`,
        details: { selector, signature: fn.signature },
        location: { function: fn.name },
        remediation:
          "New functions are generally safe. Ensure they have appropriate access control if " +
          "they modify state.",
      });
    }
  }

  // ABI-006: Event signature changed / ABI-007: Event removed
  const oldEvents = new Map(oldAbi.events.map((e) => [e.topic0, e]));
  const newEvents = new Map(newAbi.events.map((e) => [e.topic0, e]));
  for (const [topic, oldEvent] of oldEvents) {
    if (!newEvents.has(topic)) {
      const sameNameInNew = newAbi.events.find((e) => e.name === oldEvent.name);
      if (sameNameInNew) {
        findings.push({
          code: "ABI-006",
          severity: "HIGH",
          confidence: "HIGH_CONFIDENCE",
          title: "Event signature changed",
          description:
            `Event "${oldEvent.name}" signature changed. Off-chain listeners using the old ` +
            `topic will miss events.`,
          details: {
            oldSignature: oldEvent.signature,
            newSignature: sameNameInNew.signature,
          },
          remediation: "Update all off-chain indexers to use the new event signature.",
        });
      } else {
        findings.push({
          code: "ABI-007",
          severity: "MEDIUM",
          confidence: "HIGH_CONFIDENCE",
          title: "Event removed",
          description:
            `Event "${oldEvent.name}" (topic ${topic}) was removed. Off-chain listeners will ` +
            `miss these events.`,
          details: { topic, signature: oldEvent.signature },
          remediation:
            "If off-chain systems index this event, removing it breaks their data pipelines.",
        });
      }
    }
  }

  return { status: "completed", findings };
}
