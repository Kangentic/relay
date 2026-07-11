---
description: Create a PR and drive its CI checks to all-green (auto-fixing code and de-flaking/rewriting tests), then stop. Never merges. This is the Testing column skill. Use /merge-pull-request to merge a green PR.
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(npm:*), Bash(gh:*), Agent
argument-hint: [commit message]
---

# Pull Request

Commit, rebase, create a pull request, and drive its CI checks to all-green. This is the
**Testing column** skill: it offloads the test suite (unit + integration + Docker build) to
GitHub Actions PR checks instead of running it on the local machine, then auto-fixes any
failures until the PR is green.

It **never merges**. When the PR is green, the user manually moves the task Testing -> Merge,
where `/merge-pull-request` merges it and pulls the result back into the local `main` checkout.

**Usage:** `/pull-request [commit message]`

- `/pull-request` - auto-generates a commit message from the diff
- `/pull-request tighten the park-timeout reaper` - uses the provided text as the commit message

**User-provided commit message (if any):** $ARGUMENTS

## Pre-flight Checks

All git commands below run from the **current working directory** - never use `cd <path> &&
git ...` (triggers an unbypassable security prompt). Use `git -C <path>` to target another
directory.

1. **Detect mode:**
   - If CWD contains `.kangentic/worktrees/` - **worktree mode** (the PR workflow below).
   - Otherwise - **main repo mode** (fall back to `/merge-back` behavior, see the note at the
     end).
2. Get the current branch name: `git rev-parse --abbrev-ref HEAD`
   - If `HEAD` (detached) - warn the user and stop.
3. **Worktree mode only:** Derive the project root by walking up from the worktree path - the
   project root is two directories above `.kangentic/worktrees/<slug>/` (strip
   `.kangentic/worktrees/<slug>` from the worktree path).
4. Determine the source branch:
   - **Worktree mode:** `git config kangentic.baseBranch` (fallback: `main`).
   - **Main repo mode:** the current branch.
5. Run `git status --porcelain` to check for uncommitted changes.
6. Verify the GitHub CLI is authenticated: `gh auth status`. If it fails, report it and stop -
   this skill drives PR checks over `gh` and a long monitor loop must not start unauthenticated.

Report the mode, branch name, source branch, and working tree status before proceeding.

**Main repo mode:** If detected, fall back to `/merge-back` behavior (Steps 0-4 of
merge-back.md) and stop. The PR workflow below applies to worktree mode only.

## Step 0 - Local gate (typecheck + lint only)

The point of this skill is to OFFLOAD the test tiers to CI. Run only the fast, reliable local
gates so a trivially broken push does not waste a full CI round:

1. Ensure dependencies are present: if `node_modules` is missing (a fresh worktree - worktrees
   do not share `node_modules` with the main repo), run `npm install` first. If it fails with
   EBUSY, a file is locked by a running process; report it and stop.
2. Run `npm run typecheck`. If it fails, report the errors and stop.
3. Run `npm run lint`. If it reports errors, report them and stop.

Do NOT run `npm test` or `npm run test:integration` locally - CI owns them. (`/test` is still
available for a manual local run when you want it.)

## Step 1 - Commit Changes

If there are uncommitted changes (non-empty `git status --porcelain` output):

1. Show the user `git status` and `git diff --stat` for a summary of changes.
2. **Determine the commit message:** same rules as `/commit` Step 2.
3. **Update documentation before staging** - targeted anchor check:
   a. Identify changed source files (`src/config.ts`, `src/closeCodes.ts`, `src/admission.ts`
      per `.claude/rules/docs-stay-in-sync.md`).
   b. If none changed, skip to step 4.
   c. Read `.env.example` and the README config table; verify every env var / close code /
      admission field the diff added, removed, or changed a default for is reflected in both.
      Fix any gap inline with `Edit`. This is a small, fast check done directly (no dedicated
      doc-auditor agent in this repo).
4. Stage changes: `git add -A`
5. Write the commit message using the **Write tool** to the relative path
   `.kangentic/COMMIT_MSG.tmp` (resolved from CWD - do NOT resolve an absolute path, do NOT use
   the system temp directory). `.kangentic/` is gitignored, so `git add -A` won't stage it and
   no cleanup is needed. Then commit: `git commit -F .kangentic/COMMIT_MSG.tmp`
   **Never write to `.git/`** - in worktrees `.git` is a file, not a directory.
   **Never use `$(...)` or backtick command substitution** - triggers a safety prompt.

If the working tree is clean, skip to Step 1.5.

## Step 1.5 - Compute the clean PUBLIC branch name (never rename the local branch)

The local branch and the worktree folder together encode Kangentic's session identity, so we
NEVER rename the local branch. Push the unchanged local branch to a clean remote name and open
the PR from that.

1. `<type>` = the conventional prefix of the Step 1 commit message (`feat`, `fix`, `chore`, ...).
2. `<desc>` = a clean kebab slug of the work. Resolve the task with
   `kangentic_get_current_task` (pass the worktree cwd + the local branch) and slugify its
   TITLE: lowercase, words joined by single hyphens, drop filler, cap to ~4-5 meaningful words.
   If `$ARGUMENTS` supplied a name, prefer it (strip a leading `<type>/`).
3. `<branch>` = `<type>/<desc>` (e.g. `fix/parked-frame-buffer`).
4. RESUMING: if the task already has a PR (`task.pr_number` set, or you previously pushed a
   remote branch for it), reuse that existing remote name as `<branch>`.

## Step 2 - Fetch Latest Source Branch

Run: `git fetch origin <sourceBranch>`

## Step 3 - Rebase onto Source Branch

Run: `git rebase origin/<sourceBranch>`

**If conflicts occur:** show conflicting files (`git diff --name-only --diff-filter=U`), ask
the user to resolve or abort, and follow their choice.

## Step 4 - Push the Branch

Run: `git push origin HEAD:<branch> --force-with-lease`

`--force-with-lease` is safe here (a personal worktree branch) and required after a rebase. If
it fails because someone else pushed to the branch, report it and stop - never bare `--force`.

## Step 5 - Create the Pull Request

1. **Determine PR title:** the first line of the most recent commit.
2. **Determine PR body:** save a rich, reviewer-facing body to `.kangentic/PR_BODY.tmp` with
   the Write tool (avoids shell escaping):
   - `## What` - what changed.
   - `## Why` - the motivation. Link any related issue with a closing keyword.
   - `## How` - the approach and trade-offs.
   - `## Breaking changes` - any behavioral/config change requiring user action; otherwise
     `None`.
   - `## Tests` - how it is verified.
   - Footer: `Generated with [Claude Code](https://claude.com/claude-code)`
3. Run: `gh pr create --base <sourceBranch> --head <branch> --title "<title>" --body-file
   .kangentic/PR_BODY.tmp`

**If PR creation fails because one already exists:** run `gh pr view <branch>` and proceed to
Step 5b with the existing PR.

## Step 5b - Link the PR to the task

1. Extract the PR URL, parse the PR number.
2. Find the task with `kangentic_get_current_task` (pass the worktree cwd + the local branch).
3. Call `kangentic_update_task` with the task ID, `prUrl`, and `prNumber`. Required, not
   best-effort - retry if it fails.

**If the kangentic MCP is unavailable:** keep going (the PR is created and pushed); retry the
link once the MCP is back, or report the PR number prominently so the user can link it in-app.

## Step 6 - Monitor checks until green

1. `gh pr checks <branch>` resolves the PR head. Run `gh pr checks <branch> --watch
   --fail-fast --interval 30` with the Bash tool `timeout` set to `600000` ms (its max).
2. Expect a non-zero exit while checks are unfinished (`gh pr checks` returns exit code `8`).
   Read the printed rows to decide, don't treat this as a tooling failure.
3. Interpret the result:
   - **All checks passed:** go to Step 7 (report success).
   - **A check failed:** go to Step 7b (auto-fix).
   - **The 10-minute timeout fired with checks still only pending:** re-run the same `--watch`
     command. Only when there is no forward progress across two consecutive full watches, go to
     Step 8b (escalate).

## Step 7 - Report (success)

The PR is green. Report:
- PR URL (with link) and branch name.
- Number of commits.
- Next step: the user moves the task Testing -> Merge, where `/merge-pull-request` merges it.

**Do NOT merge.** Merging is `/merge-pull-request`'s job.

## Step 7b - Auto-fix loop (max 3 rounds, fully automatic)

Do NOT pause to ask. Each round, diagnose every failing check and fix it, then push and
re-monitor. Hard cap: 3 rounds. After the 3rd unsuccessful round, go to Step 8b.

For each round:

1. Pull the failure detail: `gh run view <run-id> --log-failed`.
2. Classify each problem and act automatically:
   - **Real regression** (the code is wrong): fix the code with `Edit`.
   - **Broken or wrong test** (the code is right, the assertion is stale): fix the test
     directly. `test/helpers/relayHarness.ts` and `test/helpers/wsClient.ts` are the canonical
     test doubles; reuse them rather than writing new ad-hoc setup.
   - **Flaky test** (fails intermittently): timing-sensitive relay tests (keepalive, park
     timeout) should use vitest fake timers, not real delays. Rewrite with fake timers rather
     than accepting the flake. If genuinely unsalvageable, remove it with an explicit
     justification in the commit body.
3. If the coverage of a genuinely new behavior is missing (not just a broken existing test),
   write the missing test inline yourself, scoped to the affected file(s), and run it locally
   (`npx vitest run test/<file>.test.ts`) before pushing.
4. Commit the fixes (conventional message via `.kangentic/COMMIT_MSG.tmp`), then push:
   `git push origin HEAD:<branch> --force-with-lease`.
5. Return to Step 6 to re-monitor.

## Step 8b - Escalate (after 3 rounds, or stuck checks)

Stop. Do not start a 4th round and do not `--admin` bypass. Leave the PR open, pushed, and with
no half-finished rebase. Report concrete, learned recommendations so a human can finish
quickly: for each still-failing check, the classification, what each round tried, and the root
cause as far as determined.

## Rules

**CRITICAL: No chained commands.** Every Bash call must contain exactly ONE command. Never use
`&&`, `||`, `|`, or `;`. For git commands in another directory, use `git -C <path>` - never `cd
<path> && git ...`. Conventional commit messages. No em-dashes or `--` as punctuation.

**Never fork a side-check while this skill is active.** A `subagent_type: "fork"` agent
inherits the full conversation context, including these very instructions. To check on a
background agent, wait for its natural completion notification instead of spawning another
agent.
