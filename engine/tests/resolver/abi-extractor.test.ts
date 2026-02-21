import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractAbi } from "../../src/resolver/abi-extractor.js";
import * as forgeModule from "../../src/utils/forge.js";

vi.mock("../../src/utils/forge.js", () => ({
  forgeInspectAbi: vi.fn(),
}));

const mockForgeInspectAbi = vi.mocked(forgeModule.forgeInspectAbi);

describe("extractAbi", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("computes correct selector for transfer(address,uint256)", async () => {
    mockForgeInspectAbi.mockResolvedValue([
      {
        type: "function",
        name: "transfer",
        inputs: [
          { name: "to", type: "address", internalType: "address" },
          { name: "amount", type: "uint256", internalType: "uint256" },
        ],
        outputs: [{ name: "", type: "bool", internalType: "bool" }],
        stateMutability: "nonpayable",
      },
    ]);

    const result = await extractAbi("/project", "/project/src/Token.sol", "Token");
    expect(result.functions).toHaveLength(1);
    expect(result.functions[0]!.selector).toBe("0xa9059cbb");
    expect(result.functions[0]!.signature).toBe("transfer(address,uint256)");
  });

  it("computes correct selector for balanceOf(address)", async () => {
    mockForgeInspectAbi.mockResolvedValue([
      {
        type: "function",
        name: "balanceOf",
        inputs: [{ name: "account", type: "address", internalType: "address" }],
        outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
        stateMutability: "view",
      },
    ]);

    const result = await extractAbi("/project", "/project/src/Token.sol", "Token");
    expect(result.functions[0]!.selector).toBe("0x70a08231");
  });

  it("excludes constructor and fallback from functions list", async () => {
    mockForgeInspectAbi.mockResolvedValue([
      { type: "constructor", inputs: [] },
      { type: "fallback" },
      { type: "receive" },
      {
        type: "function",
        name: "getValue",
        inputs: [],
        outputs: [{ name: "", type: "uint256", internalType: "uint256" }],
        stateMutability: "view",
      },
    ]);

    const result = await extractAbi("/project", "/project/src/Contract.sol", "Contract");
    expect(result.functions).toHaveLength(1);
    expect(result.functions[0]!.name).toBe("getValue");
  });

  it("extracts events with correct topic0", async () => {
    mockForgeInspectAbi.mockResolvedValue([
      {
        type: "event",
        name: "Transfer",
        inputs: [
          { name: "from", type: "address", internalType: "address" },
          { name: "to", type: "address", internalType: "address" },
          { name: "value", type: "uint256", internalType: "uint256" },
        ],
      },
    ]);

    const result = await extractAbi("/project", "/project/src/Token.sol", "Token");
    expect(result.events).toHaveLength(1);
    expect(result.events[0]!.name).toBe("Transfer");
    // keccak256("Transfer(address,address,uint256)") =
    // 0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef
    expect(result.events[0]!.topic0).toBe(
      "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
    );
  });

  it("handles empty ABI", async () => {
    mockForgeInspectAbi.mockResolvedValue([]);
    const result = await extractAbi("/project", "/project/src/Empty.sol", "Empty");
    expect(result.functions).toHaveLength(0);
    expect(result.events).toHaveLength(0);
  });
});
