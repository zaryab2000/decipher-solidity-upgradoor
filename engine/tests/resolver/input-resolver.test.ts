import { describe, it, expect } from "vitest";
import { findProjectRoot } from "../../src/resolver/input-resolver.js";
import fs from "fs";
import os from "os";
import path from "path";

describe("findProjectRoot", () => {
  it("returns directory containing foundry.toml when called from a nested subdirectory", () => {
    // Create a temporary fixture structure
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "upgradoor-test-"));
    const projectDir = path.join(tmpBase, "my-foundry-project");
    const srcDir = path.join(projectDir, "src", "contracts");

    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, "foundry.toml"), "[profile.default]");

    try {
      const result = findProjectRoot(srcDir);
      expect(result).toBe(projectDir);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("returns directory containing package.json when no foundry.toml", () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "upgradoor-test-"));
    const projectDir = path.join(tmpBase, "my-project");
    const nestedDir = path.join(projectDir, "deep", "nested");

    fs.mkdirSync(nestedDir, { recursive: true });
    fs.writeFileSync(
      path.join(projectDir, "package.json"),
      JSON.stringify({ name: "test" }),
    );

    try {
      const result = findProjectRoot(nestedDir);
      expect(result).toBe(projectDir);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });

  it("foundry.toml takes precedence and is found before package.json", () => {
    const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "upgradoor-test-"));
    const outerProject = path.join(tmpBase, "outer");
    const innerProject = path.join(outerProject, "inner");
    const srcDir = path.join(innerProject, "src");

    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(outerProject, "package.json"), JSON.stringify({ name: "outer" }));
    fs.writeFileSync(path.join(innerProject, "foundry.toml"), "[profile.default]");

    try {
      const result = findProjectRoot(srcDir);
      expect(result).toBe(innerProject);
    } finally {
      fs.rmSync(tmpBase, { recursive: true, force: true });
    }
  });
});
