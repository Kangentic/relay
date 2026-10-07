---
description: Review git changes for quality and conventions via parallel reviewer subagents synthesized in the main agent (fixes everything it verifies, records the decisions it made, fills red-green test-coverage holes, commits that pass locally, and ends Ready or Blocked from a script)
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(npm:*), Bash(npx:*), Bash(node:*), Agent, mcp__kangentic__kangentic_create_task
argument-hint: [base-ref] [review-only]
---

# Code Review

Review the changes that make up this branch's work - commits on the branch **plus** staged,
unstaged, and new untracked files in the working tree - for quality, correctness, and project
conventions, then fix every verified finding and end Ready or Blocked.

## Modes

- **Default** (`/code-review`) - review, then fix every verified finding (Lows included), apply
  the recommended option on every decision and record it, re-run the checks, commit this pass's
  own work locally (never pushed), and end with the verdict block `scripts/review-verdict.mjs`
  prints: **Ready** (for Testing) or **Blocked**. There is no third verdict and no "skipped"
  status. Only Blocked sends the card back to Executing.
- **Review-only** (`/code-review review-only`) - findings table + Verdict footer only. Writes
  nothing at all: no edits, no findings file, no commit, and no verdict script.

The skill reads `$ARGUMENTS`, which may carry up to two independent tokens in any order:
`review-only`, and a **base ref** (e.g. `origin/main`) overriding the auto-detected base branch.
A base ref is diff-*scoping* metadata, not author intent: it never tells the reviewer what the
change was supposed to do.

**User-provided arguments (if any):** $ARGUMENTS

**One uniform path.** This skill runs as a thin **driver** in the main loop: mechanical
pre-flight, gather the diff once to files, **fan out independent reviewer subagents in parallel**
(via the `Agent` tool), then **synthesize and verify their findings in the main agent**, and (in
default mode) fix every verified finding and commit the pass.

### Reviewer independence

`/code-review` runs in a fresh, isolated session with no prior conversation history (the board
spawns the Code Review column `isolated` + `always_spawn_new`), so the reviewing agent did not
write the code under review and has no memory of intending anything by it. Judge the diff
strictly on its own merits; that a change exists is not evidence it is right. The main agent
**verifies each finding against the actual code**: reads the cited lines, confirms the issue is
real, treats "the author clearly meant X" as inadmissible, and when uncertain refutes (drops) the
finding rather than waving it through on assumed intent.

### Not the same as `/code-review ultra`

`ultra` is a Claude Code **built-in** that launches a multi-agent review in the **cloud** -
user-initiated, billed, and not self-launchable by this skill. This project skill is an
**in-session, local** reviewer: it fans out parallel read-only subagents via the `Agent` tool
and synthesizes their findings in the main loop.

## Instructions (driver)

All commands below run from the **current working directory** - never `cd <path> && git ...`;
use `git -C <path>` if you must target another directory.

**Where this pass keeps its files.** Everything goes in `.kangentic/`, which is gitignored, so
no temp file ever stages itself or needs cleanup: `REVIEW_DIFF_COMMITTED.tmp`,
`REVIEW_DIFF_WORKING.tmp`, `REVIEW_PREEXISTING_DIRTY.tmp`, `findings.json`, and
`COMMIT_MSG.tmp`. Unlike the sibling desktop repo, nothing here moves `.kangentic/` to a trash
folder, so it needs no scratchpad detour. Write the dirty list (Step 4) with the `Write` tool
**before** the first `git diff --output=`, because `Write` creates `.kangentic/` if a fresh
worktree has none and `git diff --output=` will not.

1. **Pre-flight typecheck.** Run `npm run typecheck`. Any type errors are highest-priority
   findings, including in files this diff did not touch.
2. **Pre-flight blindness check.** Run `npx vitest run test/blindness.test.ts` (fast). This
   enforces the load-bearing invariant that `src/**` never imports `@kangentic/protocol` at
   runtime. A failure here is a **Critical** finding: it would mean the relay is no longer
   provably blind to the payloads it forwards.
3. **Resolve the base branch.** In this order, each its own Bash call, first hit wins:
   1. An explicit ref in `$ARGUMENTS` (the token that is not `review-only`).
   2. `git symbolic-ref --short refs/remotes/origin/HEAD`.
   3. Fallback locals: `git rev-parse --verify --quiet refs/heads/main`.
   If none resolve, set base to empty and review the working tree only, and say so in the
   Summary.
4. **Gather the diff once, to files (each command its own Bash call).** The finders have no Bash
   and no git (see "## Finders"), so the driver gathers and they read. Gathering once is the
   point: a fan-out where every finder re-runs the same `git diff` pays for it N times.

   - **Record `preexistingDirty` first.** Run `git diff HEAD --name-only` and `git ls-files
     --others --exclude-standard`; their union is everything already dirty before this pass
     touched anything. **Persist it immediately** to `.kangentic/REVIEW_PREEXISTING_DIRTY.tmp`
     with the `Write` tool, one path per line. Do not merely remember it: Step 8 is a whole
     fan-out and Apply Phase later, and if this value does not survive a context compaction the
     set difference under-counts and Step 8 commits the task agent's unfinished work, which is
     the exact outcome the set math exists to prevent.
   - **Use `--name-only`, never `--stat` paths, for that set.** `--stat` abbreviates a long path
     to fit its column budget, and an abbreviated entry fails to string-match its own full path
     in Step 8, drops out of the subtraction, and gets committed.
   - **Committed-vs-base:** `git diff <base>...HEAD --output=.kangentic/REVIEW_DIFF_COMMITTED.tmp`
     (three-dot: changes since the branch diverged from base). Skip when base is empty. Then
     `git diff <base>...HEAD --stat` for the human-readable summary.

     **When you skip it, the file an earlier pass left behind is still sitting there.**
     `.kangentic/` is not cleaned between passes, so a stale `REVIEW_DIFF_COMMITTED.tmp` would be
     handed to the finders as though it were this pass's diff. Track which diff files **this
     pass actually wrote** and name only those in Step 5; never infer the set from which files
     exist on disk.
   - **Uncommitted (staged + unstaged):** `git diff HEAD
     --output=.kangentic/REVIEW_DIFF_WORKING.tmp`, then `git diff HEAD --stat`.
   - **Untracked new files:** the `git ls-files --others --exclude-standard` list from above. No
     diff shows these; the finders `Read` them directly.

   `--output=` is how the diff reaches a file without a shell redirect
   (`.claude/rules/bash-single-command.md` forbids `>`) and without the `Write` tool, which would
   re-bill the whole diff as driver output tokens.

   If the committed diff, the uncommitted diff, **and** the untracked list are all empty, emit
   "No changes to review." and stop. Otherwise `changedFiles` = the deduped union of
   `git diff <base>...HEAD --name-only`, `git diff HEAD --name-only`, and the untracked list.
   Compute the compact **signature delta** from the diffs for the integration finder (see
   "## Finders").

   **Read the review ledger.** Earlier passes on this branch recorded what they refuted and what
   they decided in the bodies of their `*(review)` commits. When the base is non-empty, run
   `git log --grep="(review)" --format=%B <base>..HEAD` (one Bash call; keep the quotes, since
   unquoted parentheses are a shell syntax error) and keep every line starting `Refuted:` or
   `Decisions:`. Each is keyed `<file> <symbol>: <mechanism>`, never by line number, because line
   numbers drift between passes. Empty output means this is the first pass. Step 6 uses these
   lines; without them a pass re-raises what earlier passes already settled.
5. **Fan out reviewer subagents (the `Agent` tool, ALL in ONE message).** Every finder is a
   **read-only** `review-finder` subagent in its own fresh context; only the driver mutates the
   working tree, in the Apply Phase. Give each finder its dimension's criteria, the
   `changedFiles` list, the absolute paths of the diff files **this pass wrote** (never a stale
   one left in `.kangentic/` by an earlier pass), the
   untracked-file paths, and a 3 to 6 line **neutral** summary of what the change does (mechanism
   only, phrased as context rather than a licence to assume the author was right). See
   "## Finders" for the set, the gates, and the required return shape.
6. **Synthesize + verify (main agent).** For each finding, read the cited `file:line` and confirm
   the issue is real; refute anything the code does not substantiate or that cannot be stated
   falsifiably. Dedup findings the same issue surfaced from several dimensions, keeping the
   highest severity and clearest recommendation. Then check each survivor against the Step 4
   ledger: a finding with the same file, symbol and mechanism as a `Refuted:` or `Decisions:` line
   is refuted with the reason `ledger: <the earlier reason>`, **unless** it cites evidence the
   earlier reason did not cover (an input it never considered, code that changed since, a test
   that now fails). A finding that does cite such evidence is verified like any other and recorded
   with `reRaise: { of: <the ledger line>, newEvidence }`. Never overturn an earlier decision
   without that evidence: two passes flipping the same call is the loop this rule exists to stop.
   Fold in the pre-flight signals as Critical rows (Step 1 type errors; a Step 2 blindness failure
   with its assertion verbatim). Sort by severity. If a finder errored or came back empty, note
   the dropped dimension in the Summary. Tally the finders' `Reads beyond the diff:` lines for the
   Pass record.
7. **Apply Phase + checks** (skip both in `review-only` mode). Resolve every verified finding as
   "## Apply Phase" describes, then re-run `npm run typecheck`, `npx vitest run
   test/blindness.test.ts`, the scoped run of every test this pass added, and the scoped run of
   each existing test file that covers a module a fix touched. This repo maps `test/*.test.ts` to
   `src/` 1:1, so `Grep` `test/` for the touched module's path to find them. A fix can break a
   test it never mentions. When an existing file fails, revert that fix's edit and run the file
   again: a file that still fails was broken before this pass, so add it to `followUps` and it
   does not fail `scopedTests`; a file that passes without the fix means the fix is wrong, so try
   once more and then mark the finding `blocked`. Finally write `.kangentic/findings.json` with
   the `Write` tool, in the shape the header of `scripts/review-verdict.mjs` documents: every
   finding with its final `status` (`fixed`, `refuted` or `blocked`), the three check results, and
   any `followUps`. There is no `skipped` status and the script refuses one.
8. **Commit the pass** (skip in `review-only` mode). See "## Committing the pass".
9. **Report.** In `review-only` mode, emit the Review-only-mode footer and run no script. In
   default mode, run `node scripts/review-verdict.mjs .kangentic/findings.json` and emit the
   **Output Format** below, ending with that command's output pasted verbatim. Its closing block
   (`Verdict: Ready`, or `Verdict: Blocked` followed by the numbered steps) is the LAST thing in
   your final message: no closing prose after it, no `Next:` line, and no offer of another pass.
   A person reading the board and an agent reading the transcript both act on those lines, so
   never relabel the verdict or soften it in your own words.

## Finders

Spawned as **read-only** `review-finder` `Agent` subagents (`subagent_type: "review-finder"`),
all in one message. Each MUST return a structured list, one block per finding with `severity`,
`category`, `location` (`file:line`), `finding`, and `recommendation`, plus the falsifiable
triple (`triggeringInput`, `codePath`, `testGap`) for every Correctness/Critical finding.

| Finder | Run | Prompt seed |
|---|---|---|
| Correctness / Security | ALWAYS | Review Criteria > Correctness, plus race conditions around the synchronous slot rendezvous (`SlotTable.handleConnection` must have no `await` between reading and mutating slot state) |
| Performance | ALWAYS | Review Criteria > Performance |
| Maintainability / Conventions | ALWAYS | Review Criteria > Maintainability + Best Practices + Project Conventions |
| Cross-file integration (signatures only) | when `changedFiles > 1` | See below |
| Test coverage (red-green) | when the diff changes behavioral source under `src/` | See below |

**Cross-file integration pass - signatures only.** This is the one finder that gets no diff
files: hand it the compact "diff interface delta" computed in Step 4 instead (added/changed/
removed exported signatures, `Config`/`AdmissionContext`/`AdmissionDecision` shape changes, new
env vars in `config.ts` not reflected in `.env.example` or the README table, new
`RejectReason`/close-code values not handled in `server.ts`/`rendezvous.ts`).

**Test coverage - the red-green pass.** Ask, per behaviorally-significant change: is there a test
that would fail if this change were reverted? If not, report a coverage hole (location, behavior
left unverified, suggested test file per `/test`'s file-to-concern mapping).

**Removed/renamed surface.** When the diff deletes or renames an exported symbol, an env var
name, or a close-code constant, the maintainability finder `Grep`s the whole repo (including
`test/`, `docs`, `README.md`, `.env.example`) for surviving references outside the diff.

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
- Anything that adds per-frame work for the metrics-history feature, whose whole design rests on
  `Metrics.onForward()` staying two integer increments.

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
- An unauthenticated self-declared parameter (`role`) must never reach a pairing, routing, cap,
  or rate-limit decision, and a raw value from the wire must never reach a metric label.

### Project Conventions (source of truth: `.claude/rules/`)

The finders are custom agents, so `CLAUDE.md` may not be in their context. The conventions finder
`Read`s the rule files rather than working from memory.

- Single-command bash calls only - see `.claude/rules/bash-single-command.md`.
- No em-dashes or `--` as punctuation - see `.claude/rules/text-formatting.md`.
- No personal info / machine paths in committed code - see `.claude/rules/no-personal-info.md`.
- Every env var, close code, or admission-seam change stays reflected in `.env.example` and the
  README config table - see `.claude/rules/docs-stay-in-sync.md`.
- **The relay stays blind:** `src/**` never imports `@kangentic/protocol` at runtime (it may
  appear only under `test/`), and no code path parses, decodes, or branches on frame content.

## Model selection

- **Finders:** **Sonnet at medium effort, pinned in `.claude/agents/review-finder.md`
  frontmatter**, never passed per spawn. The restricted tool roster (`Read, Glob, Grep`) drops the
  tool/MCP manifest from every finder's fixed floor, and because the driver gathers the diff the
  finders need no Bash or git at all. Pinning the effort matters because the Code Review column
  runs at `xhigh`: an unpinned fan-out would inherit it across every finder at once. Sonnet at
  medium is enough because the review's depth and safety come from the **structure** - several
  independent finders plus main-agent verification and dedup - not from each finder being a
  frontier reasoner.
- **Synthesis + verification + Apply Phase:** the session model at its configured effort, the
  most capable agent in the system. The strong model is spent on the one bounded synthesis
  context rather than across the fan-out.

The sibling desktop repo measured Haiku as sufficient for its purely mechanical auditors (an IPC
parity check, a docs anchor enumeration) at about a tenth of the cost, while its judgment finders
stayed on Sonnet because Haiku missed known findings and raised 1.4 to 1.7 times as many. The
closest analogue here is the signatures-only integration finder. That has **not** been measured
in this repo, so every finder stays on Sonnet until it is.

## Apply Phase

Default mode fixes findings immediately after the findings table, then commits them (Step 8). The
commit is **local only, never pushed** - landing the branch stays `/pull-request`'s job, or
`/merge-back`'s for a direct quick-push.

**This edits and commits in the worktree it is reviewing, and the task agent's own unfinished
work is usually already sitting there.** The board spawns this skill `isolated` +
`always_spawn_new`, but that isolates the **conversation, not the filesystem**: the session's
working directory is the task's own worktree. The two do not run concurrently, but what the
suspended task agent leaves behind is its uncommitted working tree, and by Step 8 those files are
indistinguishable from the pass's own edits. That is why Step 8 commits by set math and never
`git add -A`.

### How each finding resolves

Every verified finding is fixed in this pass, Lows included. Severity sets the order you work in
and how careful a fix must be; it never decides whether a finding gets fixed. There is no
"skipped" status: a skip that waits for a person costs a full Executing round, and the answer is
reliably "fix the findings". Each finding ends in exactly one of these:

- **`fixed`.** The default. Typical fixes, for orientation rather than as a limit: `any` to a real
  type; shorthand names expanded; em-dashes and `--` separators replaced; chained Bash split into
  single commands; `cd <path> && git` to `git -C <path>`; a missing `.env.example` or README table
  entry for an env var the diff added; a narrowed return type; a hardcoded home-directory path
  replaced with a generic placeholder. A rename across many call sites is still a fix, because
  typecheck verifies it.
- **`fixed` with a `decision`.** When a finding has more than one valid answer (two designs, log
  or metric policy, deleting code the author just added, two findings that conflict), apply the
  option you recommend and record `decision: { chosen, alternative }`. The pass never stops to
  ask. The report's "Decisions made" list and the commit's `Decisions:` lines carry the
  alternative, so the call is visible and easy to reverse.
- **Out of the diff.** If the issue relates to this change and you understand both the problem and
  its fix in this pass, fix it here, including a type error in a file the diff did not touch. If
  it is a larger item needing its own design, leave it out of `findings` and add it to `followUps`
  (`title`, `location`, `why`). File ONE grouped To Do task per pass for all of them with
  `kangentic_create_task`, titled "Follow-ups from code review: <task title>", one item per line
  in the description, and record its board id in `followUpTask`. Missing tests for old code the
  diff did not touch go here too. Follow-ups never affect the verdict.
- **`refuted`.** The code does not bear it out, it cannot be stated falsifiably, or it matches the
  ledger with no new evidence. Give the reason; it becomes a `Refuted:` ledger line.
- **`blocked`.** Only for work this session cannot do, and only **after** you tried what you can
  run yourself. Try first: a scoped vitest run, a `npm run build`, a fixture you can generate. What
  is left (a fix that broke typecheck twice, a measurement needing a deploy) is `blocked`. Give a
  `reason` and a `step` naming exactly what a person or the task agent must do. Any non-quick
  blocked finding makes the verdict Blocked, the one outcome that sends the card back to
  Executing.

A finding is **`quick: true`** when its fix is mechanical, at one site, in a file the change
touched, and needs no new test: a stale comment or doc line, a renamed local, a wrong path in a
message. It resolves like any other finding, is counted on the Summary's "Quick fixes" line with
the fix itself as a row in Changes Applied, and never decides the verdict, even if it ends
`blocked`. It never carries a `decision`, because a choice between valid answers is not
mechanical; the script refuses the pair.

**An architectural refactor spanning several modules is not automatically out of scope.** Judge
it on whether this pass can do it and verify it. If yes, fix it. If it needs its own design, it is
a follow-up. Only a fix this session cannot complete or verify is `blocked`.

### Auto-adding missing tests (coverage holes)

A coverage hole is a finding like any other (category `Coverage`): `fixed` once its test is
written and green, `blocked` only under the rule above. This repo has no dedicated test-writing
agent, so the driver writes the test inline, following `/test`'s "Writing new tests" guidance:
reuse `test/helpers/relayHarness.ts` and `test/helpers/wsClient.ts`, prefer fake timers for
anything timer-based, and run only the new file scoped (`npx vitest run test/<file>.test.ts`) to
confirm green. Never run the full suite; that is `/pull-request`'s job on CI.

The test must assert the post-fix behavior such that reverting the change fails it. Where the
change is localized, briefly toggle the fix to confirm the test goes red, then restore it. If a
hole cannot be pinned without a large new fixture, it is a `followUp`, not a skip. Never leave a
red or `.skip` test behind.

Tests are committed with the rest of the pass (Step 8); they are new untracked files, so they
always fall on the committable side of the set rule.

## Committing the pass

Step 8, default mode only. The goal is that a finished pass leaves the worktree **clean**, with
its work in one commit whose message says who wrote it, and whose body carries the ledger so the
next pass knows what this one refuted and decided.

### What may be committed

This skill deliberately reviews uncommitted work, so the tree is often already dirty with the task
agent's own unfinished work when the pass starts. A blind `git add -A` would commit that work under
a `refactor(review):` message, which is worse than leaving the tree dirty. So:

> Commit **only** what became dirty during this pass. Never `git add -A`.

Do not try to track "the files the Apply Phase edited"; there is no such value. Use set math over
git state instead, which is provable. Each command is its own Bash call:

1. `git diff HEAD --name-only` - tracked files dirty now.
2. `git ls-files --others --exclude-standard` - untracked files now.
3. `currentDirty` = the union of those two. **Committable = `currentDirty` minus
   `preexistingDirty`**, reading `preexistingDirty` back from
   `.kangentic/REVIEW_PREEXISTING_DIRTY.tmp` rather than from memory. If that file is missing or
   unreadable, do NOT guess and do NOT fall back to `git add -A`: skip the commit and report that
   the pass could not establish what it may safely commit, so the user can stage it themselves.

Anything dirty now that was not dirty at Step 4 is provably this pass's work. The edge cases need
no special handling: a new test file is untracked now and was not before, so it commits; a fix on a
path the task agent had already left dirty is in both sets, so it is excluded; a fix auto-reverted
by the re-check step returns that file to clean and is never committed.

If Committable is empty, there are no files to commit, but the ledger still has to land: see "The
ledger-only commit". If the ledger is empty too, skip the commit and go to the Output Format.

### How to commit

1. Stage each committable path explicitly: `git add <path>`, **one path per Bash tool call**
   (`.claude/rules/bash-single-command.md` forbids chaining).
2. Run `node scripts/review-verdict.mjs .kangentic/findings.json --ledger`. It prints the
   `Refuted:` and `Decisions:` lines for the body; if it exits 2, fix the findings file it names
   and run it again. Then write the message to `.kangentic/COMMIT_MSG.tmp` with the **Write**
   tool. Never write to `.git/`; in a worktree `.git` is a file, not a directory.
3. `git commit <path1> <path2> ... -F .kangentic/COMMIT_MSG.tmp` - **pass every committable path
   as a pathspec.** One command with several positional args, so it still satisfies
   `.claude/rules/bash-single-command.md`. Never use `$(...)` or backtick substitution.

   **A bare `git commit -F` here is a real bug, not a shortcut.** With no pathspec, `git commit`
   commits the ENTIRE INDEX. A task agent routinely pauses with work already staged; Step 4
   correctly puts that file in `preexistingDirty` and the set math correctly excludes it, and then
   a bare commit sweeps it in anyway because it was sitting in the index the whole time. As a cheap
   assertion, `git diff --cached --name-only` should equal Committable immediately before you
   commit; if it does not, stop rather than commit.

The message is conventional and the scope is literally `review`: `fix(review):`,
`refactor(review):`, or `test(review):`, picked by primary change type. The body lists what was
fixed, one line per finding, then a blank line, then the `--ledger` output verbatim. The ledger is
how a later pass knows what this one settled (Step 4 reads it back), so it is never trimmed or
wrapped. Name a follow-up task in prose ("filed as a follow-up task on the board"), never as `#N`:
GitHub turns `#N` into a link to an unrelated issue.

**Use `review` as the scope even though scope usually names a code area.** A review pass is
routinely spread across every area it reviewed, so no single area scope is honest, and the useful
grouping is which pass produced the commit. It also makes the commit greppable, which both Step 4's
ledger read and `/pull-request` rely on.

### The ledger-only commit

When every fix landed on an already-dirty path and no test was added, Committable is empty, yet the
ledger still has to reach the branch or the next pass re-raises everything this one refuted. Make
an empty commit carrying only the ledger:

`git commit --allow-empty --only -F .kangentic/COMMIT_MSG.tmp`

with the subject `chore(review): record refuted findings and decisions` and the `--ledger` output
as the body. `--only` with no paths commits nothing from the index, so a file the task agent left
staged stays staged. A bare `git commit --allow-empty -F` would sweep the whole index in.

### After the report

If the session continues after the report (the user types "fix this too"), commit everything that
follow-up writes as another `*(review)` commit, using the same set math against the same Step 4
dirty list, and update `findings.json` and the ledger. Fixes a review session wrote and left under
another scope feed the next pass code nobody has reviewed.

**Never push. Never amend an existing commit.** Amending would rewrite the task agent's commit and
claim this pass as part of it, which is the misattribution this design exists to prevent.

### The mixed-authorship case

When a fix lands on a path that was already dirty, that fix stays uncommitted, mixed into the task
agent's work in the same file. The hunks cannot be separated safely, so do not try. Instead the
report must **list those paths by name**: "some fixes left uncommitted" is not enough, because the
next agent inherits a dirty tree and needs to know exactly which files hold two authors' work
before it stages anything.

**The same split can strand a test.** A coverage-hole test is a new untracked file, so it always
falls on the committable side; if the behavior it pins lives in a file that stays uncommitted, the
commit lands a test with no corresponding fix in its own history. The working tree is fine, but
that commit read in isolation is not. When it happens, commit it and say so explicitly: "test
committed without its target fix (see the mixed-authorship list)."

## Output Format

### Findings Table

Every verified finding in one table, sorted by severity, with the status it ended in:

| # | Severity | Category | Location | Finding | Fix | Status |
|---|----------|----------|----------|---------|-----|--------|
| 1 | High | Correctness | `src/rendezvous.ts:42` | Brief description | What changed and why | fixed |
| 2 | Medium | Performance | `src/connection.ts:88` | Brief description | The option chosen | fixed (decision) |
| 3 | Low | Maintainability | `src/types.ts:10` | Brief description | - | refuted |

#### Severity levels

| Severity | Meaning |
|----------|---------|
| **Critical** | Type errors, runtime crashes, blindness-guarantee violations, security holes |
| **High** | Logic bugs, missing error handling, `any` types, race conditions |
| **Medium** | Performance issues, convention violations, unclear code |
| **Low** | Style nits, minor duplication, small improvements |

Severity sets how much risk a finding carries and the order you fix things in. It does not decide
whether a finding is fixed: every verified finding is.

### Default-mode report

```
### Changes Applied (N)

| # | File:Line | What changed |
|---|-----------|--------------|

### Tests Added (K)

| # | Test file | Behavior pinned (red-green) |
|---|-----------|------------------------------|

### Refuted (R)

- src/guards/caps.ts release: double release on teardown - the second call is a no-op, pinned by caps.test.ts

### Blocked (B)   <- only when B > 0

| # | Location | What this pass tried | Step for a person or the task agent |
|---|----------|----------------------|--------------------------------------|

### Follow-up task

<board id>, N items: <titles>. Or: None.

### Committed

`refactor(review): <subject>` as `<sha>` - P files.

Then the tree status, which is COMPUTED, not boilerplate: print `No uncommitted files.` only when
nothing was left behind. If anything was, print `N file(s) left uncommitted (mixed authorship).`
instead - never print "No uncommitted files" directly above a non-empty list.

Left uncommitted (already dirty before this pass, so they hold two authors' work):
- src/server.ts

### Pass record
- Files reviewed: N
- Finders: F (<dimensions>); reads beyond the diff: R (<path: finder, criterion>, or none)

<the output of `node scripts/review-verdict.mjs .kangentic/findings.json`, verbatim: its Summary,
its Decisions made list, and its closing block. Nothing follows the closing block.>
```

The closing block reads, for example:

```
Verdict: Blocked
1. src/history/recorder.ts:88: re-run the compaction over a real 7-day store and confirm the bucket count
```

Edge cases the report must handle cleanly:
- No diff at all -> short-circuit at Step 4 with "No changes to review."
- Diff exists, zero quality findings -> skip the fix step, but STILL run the coverage pass. With
  no findings at all, `findings.json` has an empty `findings` array and the script prints
  `Verdict: Ready`.
- A fix breaks typecheck -> revert it and try once more with a different fix. If the second
  attempt also fails, the finding is `blocked` and the report shows the error. The `typecheck`
  check records the final tree, so it is `fail` only when the tree as left does not typecheck.
- Step 2 blindness test FAILS -> include the failing assertion verbatim as a Critical finding, fix
  it in the Apply Phase (remove the offending runtime import), and re-run the vitest in Step 7. If
  it still fails, `blindness` is `fail` and the verdict is Blocked.
- Committable empty at Step 8 -> make the ledger-only commit when the ledger is non-empty, and
  STILL list the mixed-authorship paths and say the worktree was left dirty.
- Committable non-empty while some fixes also landed on already-dirty paths -> emit `### Committed`
  for what did land, and print `N file(s) left uncommitted (mixed authorship)` with the list.
- A worker dies with no failing assertion (the documented Node 24 Vitest crash, see
  `docs/testing.md`) -> that is not a finding and not a failed check. Re-run the affected file
  scoped to confirm.

### Review-only-mode footer

When `review-only` is in `$ARGUMENTS`, skip the Apply Phase, the Step 8 commit, and the verdict
script, write no `findings.json`, and emit the legacy footer:

- **Files reviewed:** N
- **Findings:** N critical, N high, N medium, N low
- **Verdict:** **Ship it** / **Minor issues** / **Needs revision**

That mode writes no findings file on purpose: a file an earlier pass left in `.kangentic/` would
otherwise give a verdict for findings this review never raised.

## Allowed Tools

`Bash` (git/npm/npx/node only) for pre-flight, diff gathering, the scoped test runs, the commit,
and the verdict script; the `Agent` tool to fan out the read-only `review-finder` subagents;
`kangentic_create_task` for the one grouped follow-up task a pass may file; and `Read`, `Edit`,
`Write`, `Glob`, `Grep` for verification and the Apply Phase. No chained commands. Never
`cd <path> && git ...` - use `git -C <path>`.

**No headless `claude`, no `Workflow`.** All orchestration is in-session via the `Agent` tool.

**Commit this pass, and nothing else.** Step 8 commits only what became dirty during this pass.
Never `git add -A`, never touch work that was already uncommitted when the pass started, never
amend, and **never push**.
