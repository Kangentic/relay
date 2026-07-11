---
description: Review git changes for quality and conventions via parallel reviewer subagents synthesized in the main agent (auto-fixes findings and fills red-green test-coverage holes by default)
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(npm:*), Bash(npx:*), Agent
argument-hint: [base-ref] [review-only]
---

# Code Review

Review the changes that make up this branch's work - commits on the branch **plus** staged,
unstaged, and new untracked files in the working tree - for quality, correctness, and project
conventions, then apply every safely-fixable finding.

## Modes

- **Default** (`/code-review`) - review, then immediately apply every safely-fixable finding,
  re-run typecheck, and report `Changes Applied` + `Skipped (with reason)`.
- **Review-only** (`/code-review review-only`) - findings table + Verdict footer only, no edits
  applied.

The skill reads `$ARGUMENTS`, which may carry up to two independent tokens in any order:
`review-only`, and a **base ref** (e.g. `origin/main`) overriding the auto-detected base branch.

**User-provided arguments (if any):** $ARGUMENTS

**One uniform path.** This skill runs as a thin **driver** in the main loop: mechanical
pre-flight, gather the diff, **fan out independent reviewer subagents in parallel** (via the
`Agent` tool), then **synthesize and verify their findings in the main agent**, and (default
mode) apply every safely-fixable finding.

### Reviewer independence

`/code-review` runs best in a fresh session with no prior conversation history, so the
reviewing agent did not write the code under review and has no memory of intending anything by
it. Judge the diff strictly on its own merits; that a change exists is not evidence it is
right. The main agent **verifies each finding against the actual code**: reads the cited
lines, confirms the issue is real, and when uncertain refutes (drops) the finding rather than
waving it through on assumed intent.

### Not the same as `/code-review ultra`

`ultra` is a Claude Code **built-in** that launches a multi-agent review in the **cloud** -
user-initiated, billed, and not self-launchable by this skill. This project skill is an
**in-session, local** reviewer: it fans out parallel read-only subagents via the `Agent` tool
and synthesizes their findings in the main loop.

## Instructions (driver)

All commands below run from the **current working directory** - never `cd <path> && git ...`;
use `git -C <path>` if you must target another directory.

1. **Pre-flight typecheck.** Run `npm run typecheck`. Any type errors are highest-priority
   findings.
2. **Pre-flight blindness check.** Run `npx vitest run test/blindness.test.ts` (fast). This
   enforces the load-bearing invariant that `src/**` never imports `@kangentic/protocol` at
   runtime. A failure here is a **Critical** finding: it would mean the relay is no longer
   provably blind to the payloads it forwards.
3. **Resolve the base branch.** In this order, each its own Bash call, first hit wins:
   1. An explicit ref in `$ARGUMENTS` (the token that is not `review-only`).
   2. `git symbolic-ref --short refs/remotes/origin/HEAD`.
   3. Fallback locals: `git rev-parse --verify --quiet refs/heads/main`.
   If none resolve, set base to empty and review the working tree only.
4. **Gather the diff (union; each command its own Bash call).**
   - **Committed-vs-base:** `git diff <base>...HEAD` and `git diff <base>...HEAD --stat`.
   - **Uncommitted:** `git diff HEAD` and `git diff HEAD --stat`.
   - **Untracked new files:** `git ls-files --others --exclude-standard`. `Read` each and
     append as a synthetic added-file block.
   If all three are empty, emit "No changes to review." and stop. Otherwise `diffText` = the
   union, and `changedFiles` = the deduped file-path union.
5. **Fan out reviewer subagents (the `Agent` tool, ALL in ONE message).** Every finder is a
   **read-only** `general-purpose` subagent in its own fresh context; only the driver mutates
   the working tree, in the Apply Phase. See "## Finders".
6. **Synthesize + verify (main agent).** Verify each finding against the actual code; dedup;
   fold in the pre-flight signals as Critical rows; sort by severity.
7. **Apply Phase + Re-typecheck** (skip both in `review-only` mode). See "## Apply Phase".
8. Emit the **Output Format** below.

## Finders

Spawned as **read-only** `general-purpose` `Agent` subagents, **model: "sonnet"**, all in one
message. Findings come back as text - each finder MUST return a structured list, one block per
finding with `severity`, `category`, `location` (`file:line`), `finding`, and
`recommendation`, plus the falsifiable triple (`triggeringInput`, `codePath`, `testGap`) for
every Correctness/Critical finding.

| Finder | Run | Prompt seed |
|---|---|---|
| Correctness / Security | ALWAYS | Review Criteria > Correctness, plus race conditions around the synchronous slot rendezvous (`SlotTable.handleConnection` must have no `await` between reading and mutating slot state) |
| Performance | ALWAYS | Review Criteria > Performance |
| Maintainability / Conventions | ALWAYS | Review Criteria > Maintainability + Best Practices + Project Conventions |
| Cross-file integration (signatures only) | when `changedFiles > 1` | See below |
| Test coverage (red-green) | when the diff changes behavioral source under `src/` | See below |

**Cross-file integration pass - signatures only.** Compute a compact "diff interface delta"
from the gathered diff alone (no file bodies): added/changed/removed exported signatures,
`Config`/`AdmissionContext`/`AdmissionDecision` shape changes, new env vars in `config.ts` not
reflected in `.env.example` or the README table, new `RejectReason`/close-code values not
handled in `server.ts`/`rendezvous.ts`.

**Test coverage - the red-green pass.** Ask, per behaviorally-significant change: is there a
test that would fail if this change were reverted? If not, report a coverage hole (location,
behavior left unverified, suggested test file per `/test`'s file-to-concern mapping).

**Removed/renamed surface.** When the diff deletes or renames an exported symbol, an env var
name, or a close-code constant, `Grep` the whole repo (including `test/`, `docs`, `README.md`,
`.env.example`) for surviving references outside the diff.

## Review Criteria

### Correctness
- Logic errors, off-by-one mistakes, null/undefined risks.
- Missing error handling or unhandled promise rejections.
- Race conditions - especially any `await` introduced between reading and mutating
  `SlotTable`'s internal map, which would reintroduce a TOCTOU race in rendezvous.
- Any teardown path that could double-release a cap reservation or leave a socket
  un-terminated.

### Performance
- Unnecessary allocations or repeated work in the per-message forwarding hot path
  (`connection.ts`'s `onMessage`/`forward`).
- Inefficient data structures for the slot table, rate limiters, or connection caps.

### Maintainability
- Readability: unclear naming, overly complex expressions.
- Duplication that should be extracted.
- Premature abstractions or over-engineering for a project this size.

### Best Practices
- TypeScript strict mode compliance - **no `any` in new code**. Flag any new `any` or
  `as any` cast.
- **No shorthand variable names** in new or changed code.
- Security: injection risks, unsanitized input, anything that would let the relay read or
  branch on frame *content* (violates the blindness guarantee even if the blindness test
  itself does not catch it, e.g. a new log line that includes payload bytes).
- Proper error handling at system boundaries (the HTTP upgrade handler, the admission webhook
  call).

### Project Conventions (source of truth: `.claude/rules/`)

- Single-command bash calls only - see `.claude/rules/bash-single-command.md`.
- No em-dashes or `--` as punctuation - see `.claude/rules/text-formatting.md`.
- No personal info / machine paths in committed code - see `.claude/rules/no-personal-info.md`.
- Every env var, close code, or admission-seam change stays reflected in `.env.example` and the
  README config table - see `.claude/rules/docs-stay-in-sync.md`.
- **The relay stays blind:** `src/**` never imports `@kangentic/protocol` at runtime (it may
  appear only under `test/`), and no code path parses, decodes, or branches on frame content.

## Model selection

- **Finders:** `model: "sonnet"`.
- **Synthesis + verification + Apply Phase:** the session model at its configured effort.

## Apply Phase

Default mode applies fixes immediately after the findings table. Fixes land in the working
tree only - **never commit**; the user runs `/commit` (then `/pull-request` or `/merge-back`).

### What gets auto-fixed

- TypeScript `any` / `as any` casts -> proper type, `unknown` + type guard, or generic
  constraint.
- Shorthand variable names -> expanded.
- Em-dashes and `--` used as punctuation -> single dash or restructured sentence.
- Single-command bash chain violations in skill docs (`&&`, `||`, `|`, `;`) -> split.
- `cd <path> && git ...` -> `git -C <path> ...`.
- A missing `.env.example` / README table entry for an env var the diff added.
- One-file type fixes (narrow a return type, add a missing annotation).

### What gets skipped (with reason)

- **Architectural refactors** spanning multiple modules.
- **Missing test coverage on pre-existing code the diff did not touch** -> reason: "Outside
  diff scope; run `/test` to audit separately."
- **Deletion of code the human just added** -> ask first.
- **Type errors in untouched files** -> reason: "Outside current diff scope."
- **Any fix that introduces a new type error** (auto-reverted by the re-typecheck step).

### Auto-adding missing tests (coverage holes)

For a red-green hole on behavior **this diff** introduced, write the test inline (this repo
has no dedicated test-writing agent), following `/test`'s "Writing new tests" guidance:
reuse `test/helpers/relayHarness.ts` and `test/helpers/wsClient.ts`, prefer fake timers for
anything timer-based, and run only the new file scoped (`npx vitest run test/<file>.test.ts`)
to confirm green. If the behavior cannot be pinned without a large new fixture, move the hole
to Skipped with its reason. Tests land in the working tree only - never commit.

## Output Format

### Findings Table

| # | Severity | Category | Location | Finding | Recommendation |
|---|----------|----------|----------|---------|----------------|
| 1 | Critical | Correctness | `src/rendezvous.ts:42` | Brief description | **Must fix** |
| 2 | High | Best Practices | `src/connection.ts:15` | Brief description | **Should fix** |

#### Severity levels

| Severity | Meaning | Action |
|----------|---------|--------|
| **Critical** | Type errors, runtime crashes, blindness-guarantee violations, security holes | **Must fix** |
| **High** | Logic bugs, missing error handling, `any` types, race conditions | **Should fix** |
| **Medium** | Performance issues, convention violations, unclear code | **Consider** |
| **Low** | Style nits, minor duplication | **Optional** |

### Default-mode footer

```
### Changes Applied (N)

| # | File:Line | What changed |
|---|-----------|--------------|

Re-typecheck: PASS

### Tests Added (K)

| # | Test file | Behavior pinned (red-green) |
|---|-----------|------------------------------|

Scoped run: PASS

### Skipped (M)

| # | File:Line | Why | Next step |
|---|-----------|-----|-----------|

### Summary
- Files reviewed: N
- Findings: A critical, B high, C medium, D low
- Auto-fixed: N
- Tests added: K
- Skipped: M
- Verdict: **Clean** (or **Needs revision**)
```

Edge cases:
- No diff at all -> short-circuit with "No changes to review."
- Diff exists, zero quality findings -> skip the fix step, but STILL run the coverage pass.
- Re-typecheck FAILS -> show the error, list which fix was reverted, mark **Needs revision**.
- Step 2 blindness test FAILS -> include the failing assertion verbatim as a Critical finding,
  attempt the auto-fix (remove the offending import), re-run the vitest during Re-typecheck. If
  it still fails, mark **Needs revision**.

### Review-only-mode footer

- **Files reviewed:** N
- **Findings:** N critical, N high, N medium, N low
- **Verdict:** **Ship it** / **Minor issues** / **Needs revision**

## Allowed Tools

`Bash` (git/npm/npx only) for pre-flight + diff gathering, the `Agent` tool to fan out the
read-only finders, and `Read`, `Edit`, `Write`, `Glob`, `Grep` for verification and the Apply
Phase. No chained commands. Never `cd <path> && git ...` - use `git -C <path>`.

**No headless `claude`, no `Workflow`.** All orchestration is in-session via the `Agent` tool.

**Do not commit.** The skill applies fixes to the working tree only.
