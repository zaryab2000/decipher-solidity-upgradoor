import { exec } from "child_process";
import { promisify } from "util";
import { UpgradoorError } from "../errors.js";

const execAsync = promisify(exec);

export interface ForgeStorageEntry {
  label: string;
  offset: number;
  slot: string; // hex string e.g. "0x0"
  type: string; // type identifier e.g. "t_uint256"
  contract: string; // fully qualified name e.g. "src/V1.sol:MyContract"
}

export interface ForgeStorageLayout {
  storage: ForgeStorageEntry[];
  types: Record<string, { encoding: string; label: string; numberOfBytes: string }>;
}

export interface ForgeAbiItem {
  type: string;
  name?: string;
  inputs?: Array<{ name: string; type: string; internalType?: string }>;
  outputs?: Array<{ name: string; type: string; internalType?: string }>;
  stateMutability?: string;
  anonymous?: boolean;
}

// Run forge build in the project root
export async function forgeBuild(projectRoot: string): Promise<void> {
  try {
    await execAsync("forge build", { cwd: projectRoot });
  } catch (err) {
    throw new UpgradoorError(
      "FOUNDRY_ERROR",
      `forge build failed: ${String(err)}. Fix compilation errors before running the analyzer.`,
    );
  }
}

// Extract storage layout for a contract
// contractFile: path relative to project root, e.g. "src/V2.sol"
// contractName: e.g. "MyContractV2"
export async function forgeInspectStorageLayout(
  projectRoot: string,
  contractFile: string,
  contractName: string,
): Promise<ForgeStorageLayout> {
  const target = `${contractFile}:${contractName}`;
  try {
    const { stdout } = await execAsync(
      `forge inspect ${target} storage-layout --json`,
      { cwd: projectRoot },
    );
    return JSON.parse(stdout) as ForgeStorageLayout;
  } catch (err) {
    throw new UpgradoorError(
      "FOUNDRY_ERROR",
      `forge inspect storage-layout failed for ${target}: ${String(err)}`,
    );
  }
}

// Extract ABI for a contract
export async function forgeInspectAbi(
  projectRoot: string,
  contractFile: string,
  contractName: string,
): Promise<ForgeAbiItem[]> {
  const target = `${contractFile}:${contractName}`;
  try {
    const { stdout } = await execAsync(
      `forge inspect ${target} abi --json`,
      { cwd: projectRoot },
    );
    return JSON.parse(stdout) as ForgeAbiItem[];
  } catch (err) {
    throw new UpgradoorError(
      "FOUNDRY_ERROR",
      `forge inspect abi failed for ${target}: ${String(err)}`,
    );
  }
}
