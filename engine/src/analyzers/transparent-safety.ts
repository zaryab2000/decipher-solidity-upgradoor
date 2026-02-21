import type { AnalyzerResult, Finding, ProxyInfo } from "../types.js";
import type { ExtractedAbi } from "../resolver/abi-extractor.js";

// Known proxy admin selectors (OZ TransparentUpgradeableProxy v4/v5)
const ADMIN_SELECTORS = new Map([
  ["0x3659cfe6", "upgradeTo(address)"],
  ["0x4f1ef286", "upgradeToAndCall(address,bytes)"],
  ["0x8f283970", "changeAdmin(address)"],
  ["0xf851a440", "admin()"],
  ["0x5c60da1b", "implementation()"],
]);

export async function analyzeTransparentSafety(
  proxyInfo: ProxyInfo,
  newAbi: ExtractedAbi,
): Promise<AnalyzerResult> {
  const findings: Finding[] = [];
  const adminAddress = proxyInfo.adminAddress;

  // TPROXY-001: Admin slot is zero address
  if (!adminAddress || adminAddress === "0x0000000000000000000000000000000000000000") {
    findings.push({
      code: "TPROXY-001",
      severity: "CRITICAL",
      confidence: "HIGH_CONFIDENCE",
      title: "Admin slot is zero address",
      description: "The proxy admin slot contains the zero address. No one can upgrade this proxy.",
      details: { adminAddress },
      remediation:
        "Verify the proxy was deployed correctly with a valid admin address.",
    });
  }

  // TPROXY-002: New impl contains upgradeTo/upgradeToAndCall (pattern conflict)
  const hasUpgradeFunctions = newAbi.functions.some(
    (f) => f.name === "upgradeTo" || f.name === "upgradeToAndCall",
  );
  if (hasUpgradeFunctions) {
    findings.push({
      code: "TPROXY-002",
      severity: "HIGH",
      confidence: "HIGH_CONFIDENCE",
      title: "Implementation contains upgrade functions (pattern conflict)",
      description:
        "The new implementation defines upgradeTo or upgradeToAndCall. In a Transparent proxy, " +
        "these should only exist in the proxy itself, not the implementation.",
      details: {},
      remediation:
        "Remove upgradeTo/upgradeToAndCall from the implementation contract. " +
        "These are proxy-level functions.",
    });
  }

  // TPROXY-004: Implementation selector collides with admin selectors
  for (const fn of newAbi.functions) {
    if (ADMIN_SELECTORS.has(fn.selector)) {
      findings.push({
        code: "TPROXY-004",
        severity: "HIGH",
        confidence: "HIGH_CONFIDENCE",
        title: "Selector collision with proxy admin function",
        description:
          `Implementation function "${fn.name}" (selector ${fn.selector}) collides with proxy ` +
          `admin function "${ADMIN_SELECTORS.get(fn.selector)}". Admin calls will be intercepted ` +
          `by the proxy.`,
        details: {
          selector: fn.selector,
          implFunction: fn.name,
          adminFunction: ADMIN_SELECTORS.get(fn.selector),
        },
        location: { function: fn.name },
        remediation:
          "Rename the implementation function to avoid the 4-byte selector collision.",
      });
    }
  }

  return { status: "completed", findings };
}
