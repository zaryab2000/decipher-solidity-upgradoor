import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { analyzeAccessControlRegression } from "../../src/analyzers/access-control-regression.js";
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
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "acl-test-"));
  projectRoot = tmpDir;
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe("analyzeAccessControlRegression", () => {
  it("ACL-001: onlyOwner removed → CRITICAL finding", async () => {
    const oldArtifact = buildArtifact("V1", [
      {
        name: "adminAction",
        kind: "function",
        visibility: "public",
        modifiers: ["onlyOwner"],
        hasBody: true,
        bodyStatements: [{ nodeType: "EmptyStatement" }],
      },
    ]);
    const newArtifact = buildArtifact("V2", [
      {
        name: "adminAction",
        kind: "function",
        visibility: "public",
        modifiers: [], // onlyOwner removed
        hasBody: true,
        bodyStatements: [{ nodeType: "EmptyStatement" }],
      },
    ]);
    writeArtifact("src/V1.sol", "V1", oldArtifact);
    writeArtifact("src/V2.sol", "V2", newArtifact);

    const result = await analyzeAccessControlRegression(
      projectRoot,
      "src/V1.sol",
      "V1",
      "src/V2.sol",
      "V2",
    );
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      const finding = result.findings.find((f) => f.code === "ACL-001");
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe("CRITICAL");
    }
  });

  it("ACL-004: visibility widened from internal to public → HIGH finding", async () => {
    const oldArtifact = buildArtifact("V1", [
      {
        name: "_internalHelper",
        kind: "function",
        visibility: "internal",
        modifiers: [],
        hasBody: true,
        bodyStatements: [{ nodeType: "EmptyStatement" }],
      },
    ]);
    const newArtifact = buildArtifact("V2", [
      {
        name: "_internalHelper",
        kind: "function",
        visibility: "public",
        modifiers: [],
        hasBody: true,
        bodyStatements: [{ nodeType: "EmptyStatement" }],
      },
    ]);
    writeArtifact("src/V1.sol", "V1", oldArtifact);
    writeArtifact("src/V2.sol", "V2", newArtifact);

    const result = await analyzeAccessControlRegression(
      projectRoot,
      "src/V1.sol",
      "V1",
      "src/V2.sol",
      "V2",
    );
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      const finding = result.findings.find((f) => f.code === "ACL-004");
      expect(finding).toBeDefined();
      expect(finding!.severity).toBe("HIGH");
    }
  });

  it("safe upgrade: same access control in both versions → no ACL findings", async () => {
    const oldArtifact = buildArtifact("V1", [
      {
        name: "adminAction",
        kind: "function",
        visibility: "public",
        modifiers: ["onlyOwner"],
        hasBody: true,
        bodyStatements: [{ nodeType: "EmptyStatement" }],
      },
    ]);
    const newArtifact = buildArtifact("V2", [
      {
        name: "adminAction",
        kind: "function",
        visibility: "public",
        modifiers: ["onlyOwner"],
        hasBody: true,
        bodyStatements: [{ nodeType: "EmptyStatement" }],
      },
    ]);
    writeArtifact("src/V1.sol", "V1", oldArtifact);
    writeArtifact("src/V2.sol", "V2", newArtifact);

    const result = await analyzeAccessControlRegression(
      projectRoot,
      "src/V1.sol",
      "V1",
      "src/V2.sol",
      "V2",
    );
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.findings).toHaveLength(0);
    }
  });

  it("no findings when artifacts are missing (returns completed with empty findings)", async () => {
    // loadFunctions returns [] when artifact not found, so no findings
    const result = await analyzeAccessControlRegression(
      projectRoot,
      "src/Missing.sol",
      "Missing",
      "src/AlsoMissing.sol",
      "AlsoMissing",
    );
    expect(result.status).toBe("completed");
    if (result.status === "completed") {
      expect(result.findings).toHaveLength(0);
    }
  });
});
