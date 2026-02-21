import type { EngineInput, CanonicalStorageEntry } from "../types.js";
import type { ExtractedAbi } from "./abi-extractor.js";
import { extractStorageLayout } from "./layout-extractor.js";
import { extractAbi } from "./abi-extractor.js";
import { forgeBuild } from "../utils/forge.js";
import { UpgradoorError } from "../errors.js";
import path from "path";
import fs from "fs";

export interface ResolvedImplementations {
  projectRoot: string;
  old: {
    layout: CanonicalStorageEntry[];
    abi: ExtractedAbi;
    contractName: string;
    filePath: string;
  };
  new: {
    layout: CanonicalStorageEntry[];
    abi: ExtractedAbi;
    contractName: string;
    filePath: string;
  };
}

// Detect primary contract name from a .sol file (matches filename stem)
function detectContractName(solFile: string): string {
  return path.basename(solFile, ".sol");
}

// Validate that a file exists and is a .sol or .json file
function validateSolFile(filePath: string, role: string): string {
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved)) {
    throw new UpgradoorError("INPUT_ERROR", `${role} file not found: ${filePath}`);
  }
  if (!filePath.endsWith(".sol") && !filePath.endsWith(".json")) {
    throw new UpgradoorError(
      "INPUT_ERROR",
      `${role} must be a .sol file or Foundry artifact JSON: ${filePath}`,
    );
  }
  return resolved;
}

// Find project root by locating foundry.toml or package.json
export function findProjectRoot(startDir: string): string {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    if (
      fs.existsSync(path.join(dir, "foundry.toml")) ||
      fs.existsSync(path.join(dir, "package.json"))
    ) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  return process.cwd();
}

export async function resolveImplementations(
  input: EngineInput,
): Promise<ResolvedImplementations> {
  const oldPath = validateSolFile(input.oldImplementationPath, "Old implementation");
  const newPath = validateSolFile(input.newImplementationPath, "New implementation");

  const projectRoot = findProjectRoot(path.dirname(newPath));

  // Build the project (compiles new implementation, artifacts go to out/)
  await forgeBuild(projectRoot);

  const oldContractName =
    input.options?.contractName ?? detectContractName(oldPath);
  const newContractName =
    input.options?.contractName ?? detectContractName(newPath);

  const [oldLayout, oldAbi, newLayout, newAbi] = await Promise.all([
    extractStorageLayout(projectRoot, oldPath, oldContractName),
    extractAbi(projectRoot, oldPath, oldContractName),
    extractStorageLayout(projectRoot, newPath, newContractName),
    extractAbi(projectRoot, newPath, newContractName),
  ]);

  return {
    projectRoot,
    old: { layout: oldLayout, abi: oldAbi, contractName: oldContractName, filePath: oldPath },
    new: { layout: newLayout, abi: newAbi, contractName: newContractName, filePath: newPath },
  };
}
