import { forgeInspectAbi } from "../utils/forge.js";
import path from "path";
import { keccak256, toHex } from "viem";

export interface NormalizedFunction {
  selector: string; // 4-byte hex, e.g. "0xabcdef12"
  signature: string; // human-readable, e.g. "transfer(address,uint256)"
  name: string;
  inputs: string[]; // parameter types only
  outputs: string[];
  stateMutability: string;
}

export interface NormalizedEventInput {
  type: string;
  indexed: boolean;
}

export interface NormalizedEvent {
  topic0: string; // keccak256 of event signature
  signature: string;
  name: string;
  inputs: string[]; // type strings (for backward compat)
  indexedInputs: NormalizedEventInput[]; // full input info including indexed flag
}

export interface ExtractedAbi {
  functions: NormalizedFunction[];
  events: NormalizedEvent[];
}

function buildSignature(name: string, inputs: Array<{ type: string }>): string {
  return `${name}(${inputs.map((i) => i.type).join(",")})`;
}

function computeSelector(signature: string): string {
  const hash = keccak256(toHex(new TextEncoder().encode(signature)));
  return hash.slice(0, 10); // first 4 bytes = 8 hex chars + "0x"
}

export async function extractAbi(
  projectRoot: string,
  solFile: string,
  contractName: string,
): Promise<ExtractedAbi> {
  const relFile = path.relative(projectRoot, path.resolve(solFile));
  const items = await forgeInspectAbi(projectRoot, relFile, contractName);

  const functions: NormalizedFunction[] = [];
  const events: NormalizedEvent[] = [];

  for (const item of items) {
    if (item.type === "function" && item.name) {
      const inputs = item.inputs ?? [];
      const sig = buildSignature(item.name, inputs);
      functions.push({
        selector: computeSelector(sig),
        signature: sig,
        name: item.name,
        inputs: inputs.map((i) => i.type),
        outputs: (item.outputs ?? []).map((o) => o.type),
        stateMutability: item.stateMutability ?? "nonpayable",
      });
    } else if (item.type === "event" && item.name) {
      const inputs = item.inputs ?? [];
      const sig = buildSignature(item.name, inputs);
      events.push({
        topic0: keccak256(toHex(new TextEncoder().encode(sig))),
        signature: sig,
        name: item.name,
        inputs: inputs.map((i) => i.type),
        indexedInputs: inputs.map((i) => ({
          type: i.type as string,
          indexed: (i as Record<string, unknown>)["indexed"] === true,
        })),
      });
    }
  }

  return { functions, events };
}
