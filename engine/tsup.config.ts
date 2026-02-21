import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    check: "src/check.ts",   // CLI entry point for v0 (called by Claude via Bash)
  },
  format: ["esm"],
  target: "node18",
  bundle: true,
  noExternal: [/.*/],
  platform: "node",
  outDir: "dist",
});
