import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { analyzeUupsSafety } from "../../src/analyzers/uups-safety.js";
import { buildArtifact } from "../fixtures/artifact-builder.js";
import fs from "fs";
import path from "path";
import os from "os";

let tmpDir: string;
let projectRoot: string;

function writeArtifact(contractFile: string, contractName: string, artifact: object): void {
  const artifactDir = path.join(projectRoot, "out", path.basename(contractFile));
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(
    path.join(artifactDir, `${contractName}.json`),
    JSON.stringify(artifact),
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "uups-test-"));
  projectRoot = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("analyzeUupsSafety", () => {
  it("UUPS-001: _authorizeUpgrade missing → CRITICAL finding", async () => {
    const artifact = buildArtifact("MyContract", [
      { name: "initialize", kind: "function", visibility: "public", modifiers: ["initializer"] },
    ]);
    writeArtifact("src/MyContract.sol", "MyContract", artifact);

    const result = await analyzeUupsSafety(projectRoot, "src/MyContract.sol", "MyContract");
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      const finding = result.findings.find((f) => f.code === "UUPS-001");
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe("CRITICAL");
    }
  });

  it("UUPS-002: _authorizeUpgrade with empty body → CRITICAL finding", async () => {
    const artifact = buildArtifact("MyContract", [
      {
        name: "_authorizeUpgrade",
        kind: "function",
        visibility: "internal",
        modifiers: [],
        hasBody: true,
        bodyStatements: [],
      },
    ]);
    writeArtifact("src/MyContract.sol", "MyContract", artifact);

    const result = await analyzeUupsSafety(projectRoot, "src/MyContract.sol", "MyContract");
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      const finding = result.findings.find((f) => f.code === "UUPS-002");
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe("CRITICAL");
    }
  });

  it("UUPS-003: _authorizeUpgrade with body but no access control → CRITICAL finding", async () => {
    const artifact = buildArtifact("MyContract", [
      {
        name: "_authorizeUpgrade",
        kind: "function",
        visibility: "internal",
        modifiers: [],
        hasBody: true,
        bodyStatements: [{ nodeType: "ExpressionStatement", expression: { nodeType: "Literal" } }],
      },
    ]);
    writeArtifact("src/MyContract.sol", "MyContract", artifact);

    const result = await analyzeUupsSafety(projectRoot, "src/MyContract.sol", "MyContract");
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      const finding = result.findings.find((f) => f.code === "UUPS-003");
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe("CRITICAL");
    }
  });

  it("safe UUPS: _authorizeUpgrade with onlyOwner → no findings", async () => {
    const artifact = buildArtifact("MyContract", [
      {
        name: "_authorizeUpgrade",
        kind: "function",
        visibility: "internal",
        modifiers: ["onlyOwner"],
        hasBody: true,
        bodyStatements: [{ nodeType: "EmptyStatement" }],
      },
    ]);
    writeArtifact("src/MyContract.sol", "MyContract", artifact);

    const result = await analyzeUupsSafety(projectRoot, "src/MyContract.sol", "MyContract");
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.findings).toHaveLength(0);
    }
  });

  it("errored when artifact not found", async () => {
    const result = await analyzeUupsSafety(projectRoot, "src/Missing.sol", "Missing");
    expect(result.status).toBe("errored");
  });
});
