---
description: Merge an already-green PR (rebase merge, delete branch) and fast-forward the local main checkout. This is the Merge column skill. It assumes the Testing column (/pull-request) already drove the PR to green. Not for creating a PR (use /pull-request) or a direct quick-push (use /merge-back).
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(npm:*), Bash(gh:*), Agent, mcp__kangentic__kangentic_get_current_task, mcp__kangentic__kangentic_link_pr
---

# Merge Pull Request

Merge a green pull request and pull the result back into the local `main` checkout. This is the
**Merge column** skill. It assumes the **Testing column** (`/pull-request`) already created the
PR and drove its CI checks to all-green.

**Branch protection note:** this repo currently has no branch protection configured on `main`
(unlike the sibling `kangentic` repo, which requires an approving review and uses `--admin` to
waive it for a maintainer's own PR). This skill therefore merges without `--admin`. If branch
protection is added to `@kangentic/relay` later, revisit this skill with the user before adding
any review-bypass flag - that is a deliberate decision, not something to silently mirror from
another repo.

**Usage:** `/merge-pull-request`

## Pre-flight Checks

All git commands run from the **current working directory** - never `cd <path> && git ...`.
Use `git -C <path>` to target another directory.

1. **Detect mode:** worktree mode requires CWD to contain `.kangentic/worktrees/`. If this is
   the main repo (no worktree), stop and tell the user this skill runs from a task worktree
   (the Merge column); a direct push from the main checkout is `/merge-back`.
2. Get the current branch: `git rev-parse --abbrev-ref HEAD`. If `HEAD` (detached), warn and
   stop.
3. Derive the project root: two directories above `.kangentic/worktrees/<slug>/` (strip
   `.kangentic/worktrees/<slug>` from the worktree path).
4. Determine the source branch: `git config kangentic.baseBranch` (fallback: `main`).
5. Verify the GitHub CLI is authenticated: `gh auth status`. If it fails, report it and stop.

## Step 0 - Resolve the PR (by stored number first, head branch as fallback)

The PR's head branch may NOT equal the worktree's local branch (`/pull-request` pushes to a
clean public remote name). Resolve the PR by the stored `pr_number` first, falling back to the
head branch only when there is no stored number.

1. `<branch>` is the current LOCAL branch from pre-flight. Used later ONLY for local git
   operations, NEVER for `gh pr` lookups.
2. Resolve the PR number `<pr>`:
   - Call `kangentic_get_current_task` and take its `pr_number`. If present, that is `<pr>`.
     Also record the returned task's ID as `<taskId>` (reused in Step 3). If no task is found,
     `<taskId>` stays unset and that refresh is skipped.
   - If absent, fall back: `gh pr list --head <branch> --state open --json number`; `<pr>` is
     the first match's number.
3. Run `gh pr view <pr> --json
   number,url,state,mergeable,mergeStateStatus,statusCheckRollup,headRefName`. Record
   `<prHead>` = `headRefName` (the PR's REMOTE head branch - the push and merge target).
4. If no PR resolves either way, stop and report that the Testing column should have created
   one (run `/pull-request` from the Testing column first).

Every later `gh pr` command (view, checks, merge) targets `<pr>` or `<prHead>`; the local
`<branch>` is for local git only.

## Step 1 - Doc review at merge time

Re-check the anchor files across the whole branch diff so a gap cannot slip through:

1. Compare the current diff against `origin/<sourceBranch>`; narrow to `src/config.ts`,
   `src/closeCodes.ts`, `src/admission.ts` (`.claude/rules/docs-stay-in-sync.md`). If none
   changed, skip to Step 2.
2. Verify `.env.example` and the README config table reflect every env var / close code /
   admission field the diff touched. Fix any gap inline with `Edit`.
3. If docs changed, commit them (`docs:` message via `.kangentic/COMMIT_MSG.tmp`) and push to
   the PR's remote head: `git push origin HEAD:<prHead> --force-with-lease`.

## Step 2 - Re-verify (rebase if main moved, confirm green and mergeable)

1. `git fetch origin <sourceBranch>`.
2. If `<sourceBranch>` moved since the PR went green, rebase onto it: `git rebase
   origin/<sourceBranch>` (resolve conflicts the same way `/pull-request` does, or abort and
   report). If the rebase changed history, push: `git push origin HEAD:<prHead>
   --force-with-lease`.
3. Re-read the PR state: `gh pr view <pr> --json mergeable,mergeStateStatus,statusCheckRollup`.
   **Require every status check in `statusCheckRollup` to be green (SUCCESS)** before
   proceeding. If a check is failing or still pending, stop (or wait).
4. If the rebase re-triggered checks and they are pending, wait: `gh pr checks <pr> --watch
   --fail-fast --interval 30` (Bash `timeout` about `600000` ms). If they go red, stop and
   report - the user can move the task back to Testing to re-run `/pull-request`.

## Step 3 - Merge the PR

Only after Step 2 confirmed every check is green:

Run: `gh pr merge <pr> --rebase --delete-branch`

- `--rebase`: lands the individual commits on the source branch (no merge commit).
- `--delete-branch`: deletes the remote PR head branch (`<prHead>`). The local `<branch>` has a
  different name (the slug-hex), so gh's local-branch delete is a no-op.

**Merge-method fallback - if `--rebase` fails with "can't be rebased":** fall back to a
SQUASH, which still keeps `<sourceBranch>` LINEAR: `gh pr merge <pr> --squash
--delete-branch`. Do NOT use `--merge` (would break the linear-`main` convention). Record
`<mergeMethod>` (rebase or squash) - it selects the realign below.

**If the merge fails** for any reason (branch behind, a required check red, or GitHub reports
a missing review once branch protection is later added), do NOT force past it with an
undiscussed bypass flag - report the unmet requirement and stop.

### Refresh the board's PR status

- If Step 0 resolved a `<taskId>`, call `kangentic_link_pr` with that task ID so the board card
  flips to "merged" right away instead of waiting on its background poll.
- If no `<taskId>` was resolved, skip - there is no board card tracking the PR.

Run this right after the merge succeeds, before the realign below.

### Realign the worktree branch (so move-to-Done reads clean)

1. Confirm the worktree is clean: `git status --porcelain` (empty right after the merge). If
   NOT empty, skip the realign and report - never discard uncommitted work.
2. `git fetch origin <sourceBranch>` to refresh the merged base.
3. Realign by merge method:
   - **rebase merge:** `git rebase origin/<sourceBranch>`.
   - **squash merge:** reset instead, since a rebase would not cleanly drop the local commits:
     `git reset --hard origin/<sourceBranch>`. Safe PRECISELY because step 1 confirmed the
     worktree is clean.
4. On a rebase conflict, abort cleanly: `git rebase --abort`, then report.

## Step 4 - Pull back into the local main checkout

1. Fast-forward it: `git -C <projectRoot> pull --ff-only`. If this succeeds, you are done.
2. **If it fails, do NOT just log a soft warning.** Diagnose and surface it:
   a. `git -C <projectRoot> status -sb` to read the ahead/behind counts.
   b. If **behind only** (ahead 0) and the ff still failed, the working tree likely has
      uncommitted changes. Report and stop - do not stash or discard the user's work.
   c. If **ahead** (has unpushed local commits), list them with `git -C <projectRoot> log
      --oneline origin/<sourceBranch>..<sourceBranch>` and name them.
3. **Offer to reconcile the ahead case** (do not do it silently): rebase
   (`git -C <projectRoot> rebase origin/<sourceBranch>`) or push
   (`git -C <projectRoot> push origin <sourceBranch>`) if the user wants those commits
   upstream. On conflict, abort cleanly (`git -C <projectRoot> rebase --abort`) and report.

**Prevention:** the local `main` checkout should only ever fast-forward. Do not commit directly
to it - use a worktree or feature branch.

## Step 5 - Report

Summarize: PR URL and merged branch, source branch and commit count landed, branch cleanup
status, local `main` checkout status, and a reminder to move the task to Done on the board to
trigger `cleanup_worktree`.

## Rules

**CRITICAL: No chained commands.** Every Bash call must contain exactly ONE command. Never use
`&&`, `||`, `|`, or `;`. For git commands in another directory, use `git -C <path>` - never `cd
<path> && git ...`. Conventional commit messages. No em-dashes or `--` as punctuation.
