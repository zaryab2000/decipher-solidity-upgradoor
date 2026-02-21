import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { analyzeInitializerIntegrity } from "../../src/analyzers/initializer-integrity.js";
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "init-test-"));
  projectRoot = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("analyzeInitializerIntegrity", () => {
  it("INIT-001: constructor writes to storage → CRITICAL finding", async () => {
    const artifact = buildArtifact("MyContract", [
      {
        name: "",
        kind: "constructor",
        visibility: "public",
        modifiers: [],
        hasBody: true,
        hasStorageWrite: true,
      },
      {
        name: "initialize",
        kind: "function",
        visibility: "public",
        modifiers: ["initializer"],
        hasBody: true,
        bodyStatements: [{ nodeType: "EmptyStatement" }],
      },
    ]);
    writeArtifact("src/MyContract.sol", "MyContract", artifact);

    const result = await analyzeInitializerIntegrity(
      projectRoot,
      "src/MyContract.sol",
      "MyContract",
    );
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      const finding = result.findings.find((f) => f.code === "INIT-001");
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe("CRITICAL");
    }
  });

  it("INIT-002: no initializer modifier → HIGH finding", async () => {
    const artifact = buildArtifact("MyContract", [
      {
        name: "setup",
        kind: "function",
        visibility: "public",
        modifiers: [], // no initializer modifier
        hasBody: true,
        bodyStatements: [{ nodeType: "EmptyStatement" }],
      },
    ]);
    writeArtifact("src/MyContract.sol", "MyContract", artifact);

    const result = await analyzeInitializerIntegrity(
      projectRoot,
      "src/MyContract.sol",
      "MyContract",
    );
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      const finding = result.findings.find((f) => f.code === "INIT-002");
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe("HIGH");
    }
  });

  it("INIT-005: constructor without _disableInitializers → MEDIUM finding", async () => {
    const artifact = buildArtifact("MyContract", [
      {
        name: "",
        kind: "constructor",
        visibility: "public",
        modifiers: [],
        hasBody: true,
        bodyStatements: [], // no _disableInitializers, no storage write
      },
      {
        name: "initialize",
        kind: "function",
        visibility: "public",
        modifiers: ["initializer"],
        hasBody: true,
        bodyStatements: [{ nodeType: "EmptyStatement" }],
      },
    ]);
    writeArtifact("src/MyContract.sol", "MyContract", artifact);

    const result = await analyzeInitializerIntegrity(
      projectRoot,
      "src/MyContract.sol",
      "MyContract",
    );
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      const finding = result.findings.find((f) => f.code === "INIT-005");
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe("MEDIUM");
    }
  });

  it("safe contract: constructor calls _disableInitializers, initialize has modifier → no INIT findings", async () => {
    const artifact = buildArtifact("MyContract", [
      {
        name: "",
        kind: "constructor",
        visibility: "public",
        modifiers: [],
        hasBody: true,
        hasDisableInitializers: true,
      },
      {
        name: "initialize",
        kind: "function",
        visibility: "public",
        modifiers: ["initializer"],
        hasBody: true,
        bodyStatements: [{ nodeType: "EmptyStatement" }],
      },
    ]);
    writeArtifact("src/MyContract.sol", "MyContract", artifact);

    const result = await analyzeInitializerIntegrity(
      projectRoot,
      "src/MyContract.sol",
      "MyContract",
    );
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      const criticalOrHigh = result.findings.filter(
        (f) => f.severity === "CRITICAL" || f.severity === "HIGH",
      );
      expect(criticalOrHigh).toHaveLength(0);
    }
  });

  it("errored when artifact not found", async () => {
    const result = await analyzeInitializerIntegrity(
      projectRoot,
      "src/Missing.sol",
      "Missing",
    );
    expect(result.status).toBe("errored");
  });
});
