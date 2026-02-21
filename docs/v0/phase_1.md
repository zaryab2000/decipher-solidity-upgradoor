# Phase 1 — Plugin Scaffolding & Local Dev Workflow

## Goal

Create the plugin shell that Claude Code can load locally. At the end of this phase, running `claude --plugin-dir ./decipher-solidity-upgradoor` should start a Claude session that recognizes the plugin and shows `/decipher-solidity-upgradoor:check` in `/help`.

No engine logic yet. Just the skeleton.

---

## Deliverables

### 1. Repository Structure

Create the top-level directory layout:

```
decipher-solidity-upgradoor/
├── .claude-plugin/
│   └── plugin.json
├── commands/
│   └── check.md          ← stub for now
├── engine/
│   ├── src/
│   │   └── (empty — phase 2)
│   ├── package.json
│   └── tsconfig.json
├── README.md
└── package.json          ← root package (build scripts)
```

### 2. Plugin Manifest — `.claude-plugin/plugin.json`

```json
{
  "name": "decipher-solidity-upgradoor",
  "description": "Deterministic upgrade safety analyzer for Transparent & UUPS proxy contracts.",
  "version": "0.1.0",
  "author": {
    "name": "Zaryab",
    "url": "https://github.com/zaryab2000"
  },
  "repository": "https://github.com/zaryab-decipher/decipher-solidity-upgradoor",
  "license": "MIT",
  "keywords": [
    "solidity",
    "proxy",
    "upgrade",
    "safety",
    "foundry",
    "eip-1967",
    "uups",
    "transparent-proxy"
  ]
}
```

The `name` field determines the command namespace. `/decipher-solidity-upgradoor:check` must match exactly.

### 3. Stub Command — `commands/check.md`

```markdown
---
description: Run a full upgrade safety analysis for a proxy contract
allowed-tools:
  - Bash
  - Write
---

# Upgrade Safety Check (v0 stub)

This command is under construction. Phase 2 will implement the engine.

Usage: /decipher-solidity-upgradoor:check <proxy-address> <old-impl-path> <new-impl-path> <rpc-url>
```

This stub lets us validate the plugin loads correctly before writing any engine code.

### 4. Engine Package Setup — `engine/package.json`

```json
{
  "name": "decipher-solidity-upgradoor-engine",
  "version": "0.1.0",
  "type": "module",
  "private": true,
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "viem": "2.21.54",
    "zod": "3.24.1"
  },
  "devDependencies": {
    "typescript": "5.7.3",
    "tsup": "8.3.5",
    "vitest": "2.1.9",
    "@types/node": "22.10.2"
  }
}
```

Always look up current stable versions before installing — never assume from memory.

### 5. TypeScript Config — `engine/tsconfig.json`

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "noPropertyAccessFromIndexSignature": true,
    "verbatimModuleSyntax": true,
    "isolatedModules": true,
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

### 6. tsup Config — `engine/tsup.config.ts`

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    check: "src/check.ts",   // CLI entry point for v0 (called by Claude via Bash)
  },
  format: ["cjs"],
  target: "node18",
  bundle: true,
  noExternal: [/.*/],
  platform: "node",
  outDir: "dist",
});
```

In v0, the entry point is `check.ts` (a thin CLI wrapper that Claude calls via Bash). No MCP server entry yet.

### 7. Root Package — `package.json`

```json
{
  "name": "decipher-solidity-upgradoor",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "build": "cd engine && npm run build",
    "test": "cd engine && npm test",
    "validate": "claude plugin validate ."
  }
}
```

---

## Verification Steps

After completing this phase:

```bash
# Install engine dependencies
cd engine && npm install

# Verify TypeScript compiles (no errors, no warnings)
npm run typecheck

# Validate plugin structure
claude plugin validate .

# Load plugin locally — should show /decipher-solidity-upgradoor:check in /help
claude --plugin-dir ./decipher-solidity-upgradoor
```

The plugin must load without errors. The command must appear in `/help`. The stub command must respond when invoked (even if it just says "under construction").

---

## Expected Outcome

All of the following must be TRUE before moving to Phase 2:

1. `engine/node_modules/` exists — `npm install` in `engine/` completed without errors.
2. `npm run typecheck` in `engine/` exits 0 — zero TypeScript errors even with empty `src/` stubs.
3. `claude plugin validate .` exits 0 — plugin manifest is structurally valid.
4. `claude --plugin-dir .` starts a session where `/help` lists `/decipher-solidity-upgradoor:check`.
5. Invoking `/decipher-solidity-upgradoor:check` produces a response (even if only the stub text "under construction").
6. No files exist under `engine/dist/` — the build is intentionally deferred because `src/check.ts` does not exist yet.

---

## Notes

- No engine code is written in this phase. Source files in `engine/src/` are empty stubs.
- The `tsup` build may fail because entry files don't exist yet — that's fine. The typecheck and plugin validate steps are what matter in phase 1.
- Do not add oxlint/oxfmt config in phase 1 — add them in phase 2 when there's real code to lint.
