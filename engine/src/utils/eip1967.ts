import type { PublicClient } from "viem";

// EIP-1967 storage slots (keccak256 of magic strings, minus 1)
export const IMPLEMENTATION_SLOT =
  "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
export const ADMIN_SLOT =
  "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
export const BEACON_SLOT =
  "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";

// proxiableUUID() selector for UUPS detection
export const PROXIABLE_UUID_SELECTOR = "0x52d1902d";

export async function readStorageSlot(
  client: PublicClient,
  address: `0x${string}`,
  slot: `0x${string}`,
): Promise<`0x${string}`> {
  return client.getStorageAt({ address, slot }) as Promise<`0x${string}`>;
}

export function slotToAddress(slotValue: `0x${string}`): `0x${string}` {
  // Storage slot value is 32 bytes — address is the last 20 bytes
  return `0x${slotValue.slice(-40)}` as `0x${string}`;
}
