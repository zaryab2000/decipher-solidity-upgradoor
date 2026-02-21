import type { PublicClient } from "viem";
import type { AnalyzerResult, Finding, ProxyInfo } from "../types.js";
import {
  IMPLEMENTATION_SLOT,
  ADMIN_SLOT,
  BEACON_SLOT,
  PROXIABLE_UUID_SELECTOR,
  readStorageSlot,
  slotToAddress,
} from "../utils/eip1967.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Returns the proxy type and addresses, plus any findings
export async function detectProxy(
  client: PublicClient,
  proxyAddress: `0x${string}`,
): Promise<{ proxyInfo?: ProxyInfo; result: AnalyzerResult }> {
  const findings: Finding[] = [];

  // Read EIP-1967 slots
  const implSlot = await readStorageSlot(client, proxyAddress, IMPLEMENTATION_SLOT);
  const adminSlot = await readStorageSlot(client, proxyAddress, ADMIN_SLOT);
  const beaconSlot = await readStorageSlot(client, proxyAddress, BEACON_SLOT);

  const implAddress = slotToAddress(implSlot);
  const adminAddress = slotToAddress(adminSlot);

  // Beacon proxy — not supported in v0/v1
  const beaconAddress = slotToAddress(beaconSlot);
  if (beaconAddress !== ZERO_ADDRESS) {
    findings.push({
      code: "PROXY-001",
      severity: "CRITICAL",
      confidence: "HIGH_CONFIDENCE",
      title: "Beacon proxy detected — not supported",
      description:
        "This proxy uses the beacon pattern (EIP-1967 beacon slot is set). " +
        "Only Transparent and UUPS proxies are supported.",
      details: { beaconAddress },
      remediation:
        "Use a supported proxy pattern (Transparent or UUPS) or wait for beacon proxy support " +
        "in a future version.",
    });
    return { result: { status: "completed", findings } };
  }

  // No implementation address set
  if (implAddress === ZERO_ADDRESS) {
    findings.push({
      code: "PROXY-002",
      severity: "CRITICAL",
      confidence: "HIGH_CONFIDENCE",
      title: "No implementation set (zero address)",
      description: "The EIP-1967 implementation slot contains the zero address.",
      details: { implSlot, implAddress },
      remediation: "Verify the proxy address is correct and has been initialized.",
    });
    return { result: { status: "completed", findings } };
  }

  // Implementation has no code
  const implCode = await client.getBytecode({ address: implAddress as `0x${string}` });
  if (!implCode || implCode === "0x") {
    findings.push({
      code: "PROXY-003",
      severity: "CRITICAL",
      confidence: "HIGH_CONFIDENCE",
      title: "Implementation address has no deployed code",
      description: `The current implementation address (${implAddress}) has no bytecode.`,
      details: { implAddress },
      remediation:
        "Verify the proxy was deployed on the correct network and the RPC URL is for the right chain.",
    });
    return { result: { status: "completed", findings } };
  }

  // Determine proxy type.
  // UUPS: implementation bytecode contains the proxiableUUID selector.
  // Transparent: implementation does not have proxiableUUID — classified as transparent
  //   regardless of whether the admin slot is zero. A zero admin is a valid (broken) state
  //   for a transparent proxy; TPROXY-001 surfaces this downstream.
  const isUUPS = implCode.includes(PROXIABLE_UUID_SELECTOR.slice(2));

  let proxyType: "transparent" | "uups" | "unknown";
  if (isUUPS) {
    proxyType = "uups";
  } else if (adminAddress !== ZERO_ADDRESS) {
    // Non-zero admin slot — definitely transparent
    proxyType = "transparent";
  } else {
    // Admin slot is zero but impl has code and no proxiableUUID.
    // Could be a transparent proxy with a zeroed admin (broken state) or a truly unknown proxy.
    // Read the proxy's own bytecode to distinguish: OZ TransparentUpgradeableProxy bytecode
    // always contains the admin slot hash. We fall back to transparent classification here
    // so that TPROXY-001 can fire downstream rather than blocking all analysis with PROXY-005.
    const proxyCode = await client.getBytecode({ address: proxyAddress });
    const adminSlotHash = "b53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
    if (proxyCode && proxyCode.includes(adminSlotHash)) {
      // Proxy bytecode references the admin slot — this is a transparent proxy
      proxyType = "transparent";
    } else {
      proxyType = "unknown";
    }
  }

  if (proxyType === "unknown") {
    findings.push({
      code: "PROXY-005",
      severity: "CRITICAL",
      confidence: "HIGH_CONFIDENCE",
      title: "Unrecognized proxy pattern",
      description: "No EIP-1967 slots match a known proxy pattern.",
      details: { implAddress, adminAddress },
      remediation: "Verify the address is a Transparent or UUPS proxy contract.",
    });
    return { result: { status: "completed", findings } };
  }

  const proxyInfo: ProxyInfo = {
    type: proxyType,
    proxyAddress,
    implementationAddress: implAddress,
    // Pass adminAddress always for transparent proxies so TPROXY-001 can detect zero admin.
    // For UUPS proxies, adminAddress is not meaningful.
    ...(proxyType === "transparent" ? { adminAddress } : {}),
  };

  return {
    proxyInfo,
    result: { status: "completed", findings },
  };
}
