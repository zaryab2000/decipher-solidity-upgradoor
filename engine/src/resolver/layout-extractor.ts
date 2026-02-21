import type { CanonicalStorageEntry } from "../types.js";
import type { ForgeStorageLayout } from "../utils/forge.js";
import { forgeInspectStorageLayout } from "../utils/forge.js";
import path from "path";

// Expands type aliases to canonical form using forge's human-readable label
function canonicalizeType(typeId: string, types: ForgeStorageLayout["types"]): string {
  const entry = types[typeId];
  if (!entry) return typeId;
  return entry.label;
}

export async function extractStorageLayout(
  projectRoot: string,
  solFile: string, // absolute path or relative to cwd
  contractName: string,
): Promise<CanonicalStorageEntry[]> {
  const relFile = path.relative(projectRoot, path.resolve(solFile));

  const raw = await forgeInspectStorageLayout(projectRoot, relFile, contractName);

  return raw.storage.map((entry, index) => ({
    slot: parseInt(entry.slot, 16),
    offset: entry.offset,
    length: parseInt(raw.types[entry.type]?.numberOfBytes ?? "32", 10),
    canonicalType: canonicalizeType(entry.type, raw.types),
    label: entry.label,
    contractOrigin: entry.contract,
    inheritanceIndex: index,
  }));
}
