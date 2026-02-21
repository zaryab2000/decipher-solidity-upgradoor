import { describe, it, expect } from "vitest";
import { analyzeAbiDiff } from "../../src/analyzers/abi-diff.js";
import type { ExtractedAbi } from "../../src/resolver/abi-extractor.js";

function makeAbi(
  functions: Array<{
    selector: string;
    signature: string;
    name: string;
    inputs?: string[];
    outputs?: string[];
  }>,
  events: Array<{ topic0: string; signature: string; name: string; inputs?: string[] }> = [],
): ExtractedAbi {
  return {
    functions: functions.map((f) => ({
      selector: f.selector,
      signature: f.signature,
      name: f.name,
      inputs: f.inputs ?? [],
      outputs: f.outputs ?? [],
      stateMutability: "nonpayable",
    })),
    events: events.map((e) => ({
      topic0: e.topic0,
      signature: e.signature,
      name: e.name,
      inputs: e.inputs ?? [],
    })),
  };
}

describe("analyzeAbiDiff", () => {
  it("identical ABIs → no findings", () => {
    const abi = makeAbi([
      { selector: "0xa9059cbb", signature: "transfer(address,uint256)", name: "transfer" },
    ]);
    const result = analyzeAbiDiff(abi, abi);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.findings).toHaveLength(0);
    }
  });

  it("ABI-001: function removed → HIGH finding", () => {
    const old = makeAbi([
      { selector: "0xa9059cbb", signature: "transfer(address,uint256)", name: "transfer" },
      { selector: "0x70a08231", signature: "balanceOf(address)", name: "balanceOf" },
    ]);
    const newAbi = makeAbi([
      { selector: "0x70a08231", signature: "balanceOf(address)", name: "balanceOf" },
    ]);
    const result = analyzeAbiDiff(old, newAbi);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      const abi001 = result.findings.filter((f) => f.code === "ABI-001");
      expect(abi001).toHaveLength(1);
      expect(abi001[0]!.severity).toBe("HIGH");
    }
  });

  it("ABI-002: selector collision in new impl → CRITICAL finding", () => {
    const old = makeAbi([]);
    // Two functions happen to collide (we simulate by using same selector)
    const newAbi: ExtractedAbi = {
      functions: [
        {
          selector: "0xdeadbeef",
          signature: "foo()",
          name: "foo",
          inputs: [],
          outputs: [],
          stateMutability: "nonpayable",
        },
        {
          selector: "0xdeadbeef",
          signature: "bar(uint256)",
          name: "bar",
          inputs: ["uint256"],
          outputs: [],
          stateMutability: "nonpayable",
        },
      ],
      events: [],
    };
    const result = analyzeAbiDiff(old, newAbi);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      const abi002 = result.findings.filter((f) => f.code === "ABI-002");
      expect(abi002).toHaveLength(1);
      expect(abi002[0]!.severity).toBe("CRITICAL");
    }
  });

  it("ABI-003: function signature changed (same name, different params) → HIGH finding", () => {
    const old = makeAbi([
      {
        selector: "0xa9059cbb",
        signature: "transfer(address,uint256)",
        name: "transfer",
        inputs: ["address", "uint256"],
      },
    ]);
    const newAbi = makeAbi([
      {
        selector: "0xdifferent",
        signature: "transfer(address,uint128)",
        name: "transfer",
        inputs: ["address", "uint128"],
      },
    ]);
    const result = analyzeAbiDiff(old, newAbi);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      const abi003 = result.findings.filter((f) => f.code === "ABI-003");
      expect(abi003).toHaveLength(1);
      expect(abi003[0]!.severity).toBe("HIGH");
    }
  });

  it("ABI-005: new function added → LOW finding", () => {
    const old = makeAbi([
      { selector: "0x70a08231", signature: "balanceOf(address)", name: "balanceOf" },
    ]);
    const newAbi = makeAbi([
      { selector: "0x70a08231", signature: "balanceOf(address)", name: "balanceOf" },
      { selector: "0xdeadbeef", signature: "newFunc()", name: "newFunc" },
    ]);
    const result = analyzeAbiDiff(old, newAbi);
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      const abi005 = result.findings.filter((f) => f.code === "ABI-005");
      expect(abi005).toHaveLength(1);
      expect(abi005[0]!.severity).toBe("LOW");
    }
  });
});
