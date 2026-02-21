import { describe, it, expect, vi } from "vitest";
import { detectProxy } from "../../src/analyzers/proxy-detection.js";
import type { PublicClient } from "viem";

// EIP-1967 slot values
const ZERO_SLOT = "0x0000000000000000000000000000000000000000000000000000000000000000";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// A realistic address with a non-zero value
const BEACON_ADDR = "0x000000000000000000000000bEac0000bEac0000bEac0000bEac0000bEac0000";
const IMPL_ADDR = "0x000000000000000000000000aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADMIN_ADDR = "0x000000000000000000000000bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

// proxiableUUID selector (UUPS indicator)
const PROXIABLE_UUID_SELECTOR = "52d1902d";

function mockClient(overrides: {
  implSlot?: string;
  adminSlot?: string;
  beaconSlot?: string;
  bytecode?: string;
}): PublicClient {
  const {
    implSlot = ZERO_SLOT,
    adminSlot = ZERO_SLOT,
    beaconSlot = ZERO_SLOT,
    bytecode = "0x",
  } = overrides;

  const IMPL_SLOT_KEY =
    "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const ADMIN_SLOT_KEY =
    "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
  const BEACON_SLOT_KEY =
    "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

  return {
    getStorageAt: vi.fn(({ slot }: { address: string; slot: string }) => {
      if (slot === IMPL_SLOT_KEY) return Promise.resolve(implSlot as `0x${string}`);
      if (slot === ADMIN_SLOT_KEY) return Promise.resolve(adminSlot as `0x${string}`);
      if (slot === BEACON_SLOT_KEY) return Promise.resolve(beaconSlot as `0x${string}`);
      return Promise.resolve(ZERO_SLOT as `0x${string}`);
    }),
    getBytecode: vi.fn(() => Promise.resolve(bytecode as `0x${string}`)),
  } as unknown as PublicClient;
}

describe("detectProxy", () => {
  it("PROXY-001: beacon slot set → beacon finding, no proxyInfo", async () => {
    const client = mockClient({ beaconSlot: BEACON_ADDR });
    const result = await detectProxy(client, "0x1234567890123456789012345678901234567890");
    expect(result.proxyInfo).toBeUndefined();
    expect(result.result.status).toBe("completed");
    if (result.result.status === "completed") {
      expect(result.result.findings).toHaveLength(1);
      expect(result.result.findings[0]!.code).toBe("PROXY-001");
    }
  });

  it("PROXY-002: implementation slot = zero address → zero address finding", async () => {
    const client = mockClient({ implSlot: ZERO_SLOT });
    const result = await detectProxy(client, "0x1234567890123456789012345678901234567890");
    expect(result.proxyInfo).toBeUndefined();
    expect(result.result.status).toBe("completed");
    if (result.result.status === "completed") {
      expect(result.result.findings).toHaveLength(1);
      expect(result.result.findings[0]!.code).toBe("PROXY-002");
    }
  });

  it("PROXY-003: implementation has no bytecode → no code finding", async () => {
    const client = mockClient({ implSlot: IMPL_ADDR, bytecode: "0x" });
    const result = await detectProxy(client, "0x1234567890123456789012345678901234567890");
    expect(result.proxyInfo).toBeUndefined();
    expect(result.result.status).toBe("completed");
    if (result.result.status === "completed") {
      expect(result.result.findings).toHaveLength(1);
      expect(result.result.findings[0]!.code).toBe("PROXY-003");
    }
  });

  it("PROXY-005: no admin slot, no proxiableUUID → unrecognized proxy", async () => {
    const client = mockClient({
      implSlot: IMPL_ADDR,
      adminSlot: ZERO_SLOT,
      bytecode: "0xdeadbeef",
    });
    const result = await detectProxy(client, "0x1234567890123456789012345678901234567890");
    expect(result.proxyInfo).toBeUndefined();
    expect(result.result.status).toBe("completed");
    if (result.result.status === "completed") {
      expect(result.result.findings).toHaveLength(1);
      expect(result.result.findings[0]!.code).toBe("PROXY-005");
    }
  });

  it("UUPS: proxiableUUID in bytecode → type=uups, no findings", async () => {
    const client = mockClient({
      implSlot: IMPL_ADDR,
      adminSlot: ZERO_SLOT,
      bytecode: `0xdeadbeef${PROXIABLE_UUID_SELECTOR}cafebabe`,
    });
    const result = await detectProxy(client, "0x1234567890123456789012345678901234567890");
    expect(result.proxyInfo).toBeDefined();
    expect(result.proxyInfo?.type).toBe("uups");
    expect(result.result.status).toBe("completed");
    if (result.result.status === "completed") {
      expect(result.result.findings).toHaveLength(0);
    }
  });

  it("Transparent: admin slot set, no proxiableUUID → type=transparent, adminAddress set", async () => {
    const client = mockClient({
      implSlot: IMPL_ADDR,
      adminSlot: ADMIN_ADDR,
      bytecode: "0xdeadbeef",
    });
    const result = await detectProxy(client, "0x1234567890123456789012345678901234567890");
    expect(result.proxyInfo).toBeDefined();
    expect(result.proxyInfo?.type).toBe("transparent");
    expect(result.proxyInfo?.adminAddress).not.toBe(ZERO_ADDRESS);
    expect(result.result.status).toBe("completed");
    if (result.result.status === "completed") {
      expect(result.result.findings).toHaveLength(0);
    }
  });
});
