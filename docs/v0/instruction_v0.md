# v0 Implementation Instructions for Claude Code

## Purpose

This file is a complete instruction set for a coding agent (Claude Code) to implement the
`decipher-solidity-upgradoor` v0 project end-to-end. You will work through five sequential
phase files located in `docs/v0/`. Each phase builds on the previous one. You must not skip
a phase or begin the next phase until the current phase's Expected Outcome section is fully
satisfied.

The loop is:
**Read phase file → Implement → Verify Expected Outcome → Move to next phase → Repeat until
Phase 5 is complete and verified.**

---

## Before You Start

1. Read `docs/v0/sub-prd-v0.md` in full. This is the v0 sub-PRD. It defines scope, constraints,
   and the overall completion criteria for v0. Keep it as your reference for architectural
   decisions throughout.

2. Read `CLAUDE.md` in the repository root. Follow every instruction in it without exception —
   it governs code style, tooling, linting, testing, error handling, and commit discipline for
   this project.

3. Confirm you are working in the repository root:
   `/Users/zar/Documents/ai/ai_projects/decipher-solidity-upgradoor`

4. Do not create any files outside the repository structure defined in `CLAUDE.md` and the
   phase files. Do not add dependencies not listed in the phase files without a documented
   reason.

---

## The Implementation Loop

### How to execute each phase

For every phase from 1 through 5, follow these steps in order without skipping any:

**Step A — Read the phase file completely.**
Read the entire phase file before writing a single line of code. Understand the goal, all
deliverables, the verification steps, and the Expected Outcome section. The Expected Outcome
section defines binary pass/fail criteria — each checkpoint must be TRUE when you are done.

**Step B — Implement every deliverable listed in the phase file.**
The phase file lists numbered deliverables. Implement them in order. Each deliverable
specifies file paths, code content, and behavioral contracts. Follow the code in the phase
file exactly — do not simplify, skip, or reinterpret unless there is an unresolvable
contradiction. If you encounter a contradiction between the phase file and `CLAUDE.md`, the
`CLAUDE.md` code quality rules take precedence (formatting, naming, error handling style),
but the phase file's architecture and API shapes take precedence.

When writing code:
- Use the exact file paths given in the phase file.
- Use the exact exported function and type names given in the phase file.
- Use the exact finding codes (`STOR-001`, `UUPS-001`, etc.) given in the phase file —
  these are part of the public contract.
- Do not add extra files, extra exports, or extra logic beyond what the phase describes.
  Speculative features are prohibited.

**Step C — Run the Verification Steps from the phase file.**
After implementing all deliverables, run every `bash` command listed in the
`## Verification Steps` section of the phase file. Fix any failures before proceeding.
Verification steps that require a live RPC URL or a deployed proxy can be skipped only if
the phase's Expected Outcome does not require them for a binary pass — note any such skip
explicitly.

**Step D — Check every checkpoint in `## Expected Outcome`.**
Read each numbered checkpoint in the Expected Outcome section. For each one:
- Run the command or inspect the file described in the checkpoint.
- Confirm the result matches what the checkpoint states.
- If a checkpoint fails, go back to Step B, fix the issue, and re-run from Step C.

Do not move to the next phase until every single Expected Outcome checkpoint is TRUE.
There are no partial passes. If checkpoint 7 of 9 fails, the phase is not done.

**Step E — Record what was done.**
Before moving to the next phase, write a one-paragraph summary of what was implemented and
any noteworthy decisions or deviations. Append this to a file called
`docs/v0/implementation_log.md` (create it if it does not exist). Format each entry as:

```
## Phase N — <phase title>
<summary paragraph>
```

---

## Phase Sequence

### Phase 1 — Plugin Scaffolding & Local Dev Workflow
File: `docs/v0/phase_1.md`

Focus: Repository structure, plugin manifest, stub slash command, engine package setup
(package.json, tsconfig.json, tsup.config.ts), and root package.json. No engine code.

Key constraint: The `engine/dist/` directory must NOT exist at the end of this phase.
The tsup build intentionally cannot run because `src/check.ts` does not exist yet.
The only commands that must pass are `npm run typecheck` and `claude plugin validate .`.

After verifying all 6 Expected Outcome checkpoints, proceed to Phase 2.

---

### Phase 2 — Types, Engine Shell, and Proxy Detection
File: `docs/v0/phase_2.md`

Focus: `types.ts`, `errors.ts`, `utils/eip1967.ts`, `analyzers/proxy-detection.ts`,
`engine.ts` (orchestrator shell with stubs), `check.ts` (CLI entry point), `index.ts`
(public exports). The engine must build and the proxy detection analyzer must work against
live proxies via RPC.

Key constraint: All non-proxy-detection analyzers return `{ status: "skipped" }` in this
phase. The verdict is always `"INCOMPLETE"` at the end of this phase — this is correct and
expected. Do not implement any other analyzer logic here.

Write unit tests for `proxy-detection.ts` using mocked viem clients. Tests must cover all
six cases listed in the Verification Steps section (PROXY-001 through PROXY-005, plus valid
UUPS and Transparent paths). Run `npm test` and confirm all tests pass.

After verifying all 9 Expected Outcome checkpoints, proceed to Phase 3.

---

### Phase 3 — Storage Layout & ABI Extraction via Forge
File: `docs/v0/phase_3.md`

Focus: `utils/forge.ts` (forge subprocess wrappers), `resolver/layout-extractor.ts`,
`resolver/abi-extractor.ts`, `resolver/input-resolver.ts`. Wire `resolveImplementations`
into `engine.ts`.

Key constraint: The storage-layout and abi-diff analyzers remain `"skipped"` at the end of
this phase — they are wired in Phase 4. The forge wrappers are the only new runtime behavior
added here.

Write unit tests for the extractor functions. The selector test (`transfer(address,uint256)`
→ `0xa9059cbb`) and the slot/offset test are hard requirements in Expected Outcome — write
them explicitly.

For the `findProjectRoot` test: create a small fixture directory structure with a nested
`foundry.toml` to test traversal. Do not rely on the live repository's `foundry.toml` for
this unit test.

After verifying all 9 Expected Outcome checkpoints, proceed to Phase 4.

---

### Phase 4 — Core Analyzers
File: `docs/v0/phase_4.md`

Focus: Six analyzer files:
- `analyzers/storage-layout.ts`
- `analyzers/abi-diff.ts`
- `analyzers/uups-safety.ts`
- `analyzers/transparent-safety.ts`
- `analyzers/initializer-integrity.ts`
- `analyzers/access-control-regression.ts`

Wire all six into `engine.ts` using `Promise.allSettled`.

Key constraint: Every analyzer is a pure function or async function with no network calls
and no subprocess calls. All subprocess work was done in Phase 3 (forge) and Phase 2 (RPC).
If you find yourself making an `execAsync` call inside an analyzer, stop — it belongs in
`utils/forge.ts` or `utils/eip1967.ts`.

Create the four test fixture contracts listed in the Verification Steps:
- `SafeUpgrade.sol` / `SafeUpgradeV2.sol`
- `StorageCollision.sol` / `StorageCollisionV2.sol`
- `MissingAuthorize.sol`
- `RemovedOnlyOwner.sol` / `RemovedOnlyOwnerV2.sol`

Write unit tests for each analyzer covering the fixture scenarios. The tests must use the
fixture contracts (or equivalent inline test data), not live network calls.

Expected Outcome checkpoints 4–7 (specific finding codes for specific fixtures) are hard
requirements. If the wrong finding code fires, or no finding fires when one should, the
phase is not complete.

After verifying all 10 Expected Outcome checkpoints, proceed to Phase 5.

---

### Phase 5 — Verdict, Report Generation & Command Wiring
File: `docs/v0/phase_5.md`

Focus: `report/aggregator.ts` (verdict computation), `report/markdown-report.ts` (markdown
renderer), complete rewrite of `engine.ts` orchestrator, and replacement of the Phase 1
stub `commands/check.md` with the full command.

Key constraint: The `check.ts` exit code mapping is a hard requirement for Expected Outcome
checkpoint 8. The CLI must exit with the correct code for each verdict type. Test this by
running against each fixture and checking `echo $?` after each run.

For checkpoint 5 (the written report file): the markdown report must contain at minimum a
verdict header line, a findings section grouped by severity, and an analyzer status table.
Open the written file and visually inspect it — do not just check that it was created.

For checkpoint 7: verify the exact seven analyzer key names in the output JSON. The keys
are: `proxy-detection`, `storage-layout`, `abi-diff`, `uups-safety`, `transparent-safety`,
`initializer-integrity`, `access-control-regression`. Note: the phase 2/3/4 stubs used
`"access-control"` as the key name — verify in Phase 5 that the engine uses the canonical
`"access-control-regression"` key throughout.

After verifying all 10 Expected Outcome checkpoints, v0 is complete. Append a final entry
to `docs/v0/implementation_log.md`:

```
## v0 Complete
All five phases implemented and verified. All Expected Outcome checkpoints pass.
```

---

## General Rules for All Phases

### On writing code

- Every function must have a clear, single responsibility. If a function is growing beyond
  100 lines, split it.
- TypeScript strict mode is enabled. Every type must be explicit — no `any` unless the
  phase file itself uses `any` for a specific reason (and even then, scope it as narrowly
  as possible).
- Use `.js` extensions on all local imports even though the source files are `.ts`. This is
  required by the `"moduleResolution": "bundler"` and ESM configuration.
- Do not add `console.log` debug statements to production code. The only `console` calls
  allowed are in `check.ts` (for JSON output) and in test files.
- All subprocess calls go through `utils/forge.ts` or the existing `validateFoundry` helper
  in `engine.ts`. No raw `child_process` calls in analyzers or resolvers.

### On testing

- Tests live in `engine/tests/`. Mirror the `src/` directory structure (e.g.,
  `tests/analyzers/storage-layout.test.ts`).
- Mock viem's `PublicClient` for proxy detection tests — do not make live RPC calls in unit
  tests.
- Mock the `forge` subprocess calls in layout and ABI extractor tests — do not require a
  live Foundry project for unit tests.
- Run `npm test` after each phase. Tests from previous phases must continue to pass.

### On errors

- Use `UpgradoorError` with the appropriate `ErrorCode` for all engine-level failures.
- Never swallow exceptions silently. If an analyzer catches an error, it must return
  `{ status: "errored", error: String(err) }` — not `{ status: "skipped" }`.
- The distinction between `"skipped"` and `"errored"` is load-bearing for the verdict
  computation in Phase 5. Get it right from Phase 2 onward.

### On the plugin structure

- Never modify `plugin.json` after Phase 1 unless a later phase explicitly instructs it.
- The `commands/check.md` stub from Phase 1 is intentionally minimal. Do not flesh it out
  until Phase 5 instructs you to replace it.
- `engine/dist/` is gitignored for development but the phase files specify that `dist/` is
  committed for plugin distribution. Do not add `dist/` to `.gitignore`.

### On stopping and asking

If you encounter a situation where:
- The phase file describes behavior that contradicts the types defined in `types.ts`
- A forge command produces unexpected output format
- A TypeScript error cannot be resolved without changing a phase-specified API shape

Stop, document the contradiction in `docs/v0/implementation_log.md` under the current phase
entry, and surface it for human review before proceeding. Do not silently work around
structural contradictions.

---

## Completion Criteria

v0 is complete when:
1. All five phase files have been implemented.
2. All five Expected Outcome sections are fully satisfied (every checkpoint TRUE).
3. `npm run build` exits 0 from `engine/`.
4. `npm run typecheck` exits 0 from `engine/`.
5. `npm test` exits 0 from `engine/`.
6. `claude plugin validate .` exits 0 from the repository root.
7. `docs/v0/implementation_log.md` contains an entry for each of the five phases plus the
   final "v0 Complete" entry.

Do not declare v0 complete unless all seven criteria above are satisfied simultaneously.
