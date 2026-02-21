import { describe, it, expect, vi, beforeEach } from "vitest";
import { extractStorageLayout } from "../../src/resolver/layout-extractor.js";
import * as forgeModule from "../../src/utils/forge.js";

vi.mock("../../src/utils/forge.js", () => ({
  forgeInspectStorageLayout: vi.fn(),
}));

const mockInspect = vi.mocked(forgeModule.forgeInspectStorageLayout);

describe("extractStorageLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("single-variable contract: slot=0, offset=0", async () => {
    mockInspect.mockResolvedValue({
      storage: [
        {
          label: "value",
          offset: 0,
          slot: "0x0",
          type: "t_uint256",
          contract: "src/Contract.sol:Contract",
        },
      ],
      types: {
        t_uint256: { encoding: "inplace", label: "uint256", numberOfBytes: "32" },
      },
    });

    const layout = await extractStorageLayout(
      "/project",
      "/project/src/Contract.sol",
      "Contract",
    );
    expect(layout).toHaveLength(1);
    expect(layout[0]!.slot).toBe(0);
    expect(layout[0]!.offset).toBe(0);
    expect(layout[0]!.canonicalType).toBe("uint256");
    expect(layout[0]!.length).toBe(32);
    expect(layout[0]!.label).toBe("value");
  });

  it("correctly parses slot hex values", async () => {
    mockInspect.mockResolvedValue({
      storage: [
        {
          label: "a",
          offset: 0,
          slot: "0x0",
          type: "t_uint256",
          contract: "src/C.sol:C",
        },
        {
          label: "b",
          offset: 0,
          slot: "0x1",
          type: "t_address",
          contract: "src/C.sol:C",
        },
        {
          label: "c",
          offset: 0,
          slot: "0xff",
          type: "t_uint256",
          contract: "src/C.sol:C",
        },
      ],
      types: {
        t_uint256: { encoding: "inplace", label: "uint256", numberOfBytes: "32" },
        t_address: { encoding: "inplace", label: "address", numberOfBytes: "20" },
      },
    });

    const layout = await extractStorageLayout("/project", "/project/src/C.sol", "C");
    expect(layout[0]!.slot).toBe(0);
    expect(layout[1]!.slot).toBe(1);
    expect(layout[2]!.slot).toBe(255);
    expect(layout[1]!.canonicalType).toBe("address");
    expect(layout[1]!.length).toBe(20);
  });

  it("type canonicalization: uint alias expanded to uint256", async () => {
    mockInspect.mockResolvedValue({
      storage: [
        {
          label: "amount",
          offset: 0,
          slot: "0x0",
          type: "t_uint256",
          contract: "src/C.sol:C",
        },
      ],
      types: {
        // forge reports it as "uint256" in the label even when source uses "uint"
        t_uint256: { encoding: "inplace", label: "uint256", numberOfBytes: "32" },
      },
    });

    const layout = await extractStorageLayout("/project", "/project/src/C.sol", "C");
    expect(layout[0]!.canonicalType).toBe("uint256");
  });

  it("multiple inherited contracts preserve order (inheritanceIndex)", async () => {
    mockInspect.mockResolvedValue({
      storage: [
        {
          label: "base",
          offset: 0,
          slot: "0x0",
          type: "t_uint256",
          contract: "src/Base.sol:Base",
        },
        {
          label: "child",
          offset: 0,
          slot: "0x1",
          type: "t_uint256",
          contract: "src/Child.sol:Child",
        },
      ],
      types: {
        t_uint256: { encoding: "inplace", label: "uint256", numberOfBytes: "32" },
      },
    });

    const layout = await extractStorageLayout("/project", "/project/src/Child.sol", "Child");
    expect(layout).toHaveLength(2);
    expect(layout[0]!.contractOrigin).toBe("src/Base.sol:Base");
    expect(layout[0]!.inheritanceIndex).toBe(0);
    expect(layout[1]!.contractOrigin).toBe("src/Child.sol:Child");
    expect(layout[1]!.inheritanceIndex).toBe(1);
  });
});
