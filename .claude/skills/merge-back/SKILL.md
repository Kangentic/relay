---
description: Direct quick-push escape hatch - commit, rebase, and push straight to the source branch, bypassing the PR gate. Use only when the user explicitly asks to push, land, or merge back a quick change. The normal flow is the board (Testing -> /pull-request, Merge -> /merge-pull-request). NOT for a plain local commit (use /commit for that).
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(npm:*), Agent
argument-hint: [commit message]
---

# Merge Back

Safely commit, rebase, and push changes straight to the source branch. Works from both
worktrees and the main repo.

This is the **direct quick-push escape hatch**: it bypasses the pull-request gate. It relies on
push access to `main` (no branch protection is currently configured on this repo - see
`.claude/skills/merge-pull-request/SKILL.md`'s branch-protection note). The normal flow goes
through a PR: the **Testing** column runs `/pull-request` and the **Merge** column runs
`/merge-pull-request`. Reach for `/merge-back` only for a small, urgent change (e.g. CI is
down, or a one-line hotfix).

**Usage:** `/merge-back [commit message]`

**User-provided commit message (if any):** $ARGUMENTS

## Pre-flight Checks

All git commands below run from the **current working directory** - never use `cd <path> &&
git ...` (triggers an unbypassable security prompt). The only exception is Step 5 which uses
`git -C <projectRoot>` to target the main repo.

1. **Detect mode:**
   - If CWD contains `.kangentic/worktrees/` -> **worktree mode**
   - Otherwise -> **main repo mode**
2. Get the current branch name: `git rev-parse --abbrev-ref HEAD`
   - If `HEAD` (detached) -> warn the user and stop.
3. **Worktree mode only:** Derive the project root by walking up from the worktree path.
4. Determine the source branch:
   - **Worktree mode:** `git config kangentic.baseBranch` (fallback: `main`)
   - **Main repo mode:** same as the current branch
5. Run `git status --porcelain` to check for uncommitted changes.

Report the mode, branch name, source branch, and working tree status before proceeding.

## Step 0 - Install Dependencies, Type Check, and Lint

1. Run `npm ci`. Ensures `node_modules` matches the lockfile exactly.
2. Run `npm run typecheck`. If it fails, report and stop - do not proceed with the merge.
3. Run `npm run lint`. If it reports any errors, report them and stop.
4. Run `npm test`. The unit tier is fast (sub-second) and is the last local gate before a
   direct push bypasses CI's own copy of it.

## Step 1 - Commit Changes

If there are uncommitted changes (non-empty `git status --porcelain` output):

1. Show the user `git status` and `git diff --stat`.
2. **Determine the commit message:** same rules as `/commit` Step 2.
3. **Update documentation before staging** - targeted anchor check: verify `.env.example` and
   the README config table reflect any change to `src/config.ts`, `src/closeCodes.ts`, or
   `src/admission.ts` (`.claude/rules/docs-stay-in-sync.md`). Fix any gap inline.
4. Stage changes: `git add -A`
5. Write the commit message using the **Write tool** to `.kangentic/COMMIT_MSG.tmp` (resolved
   from CWD). Then commit: `git commit -F .kangentic/COMMIT_MSG.tmp`
   **Never write to `.git/`** - in worktrees `.git` is a file, not a directory.
   **Never use `$(...)` or backtick command substitution.**

If the working tree is clean, skip to Step 2.

## Step 2 - Fetch Latest Source Branch

Run: `git fetch origin <sourceBranch>`

## Step 3 - Rebase onto Source Branch

Run: `git rebase origin/<sourceBranch>`

**If conflicts occur:** show conflicting files, ask the user to resolve, merge instead, or
abort, and follow their choice.

## Step 4 - Push to Source Branch

**Worktree mode:** Push to the **source branch** (e.g., `main`), NOT the worktree branch name.

Run: `git push origin HEAD:<sourceBranch>`

**If the push fails** (someone else pushed in the meantime): report the error, suggest
re-running `/merge-back`, and stop - do not force-push.

## Step 5 - Report

Summarize: mode, branch merged, source branch, commit count landed. **Worktree mode only:**
remind the user they can clean up the worktree by moving the task to Done on the board.

## Step 6 - Update Local Source Branch (worktree mode only, always runs after Step 5)

**Skip this step entirely in main repo mode.**

1. Fast-forward it: `git -C <projectRoot> pull --ff-only`. If this succeeds, you are done.
2. **If it fails, do NOT just log a soft warning.** Diagnose and surface it:
   a. `git -C <projectRoot> status -sb`.
   b. If **behind only** and the ff still failed, the working tree likely has uncommitted
      changes. Report and stop - do not stash or discard the user's work.
   c. If **ahead**, list the local-only commits with `git -C <projectRoot> log --oneline
      origin/<sourceBranch>..<sourceBranch>` and name them.
3. **Offer to reconcile the ahead case** (do not do it silently): rebase or push if the user
   wants those commits on the source branch. On conflict, abort cleanly and report.

**Prevention:** the local source-branch checkout should only ever fast-forward. Do not commit
directly to it - use a worktree or feature branch.

## Rules

**CRITICAL: No chained commands.** Every Bash call must contain exactly ONE command. Never use
`&&`, `||`, `|`, or `;`. For git commands in another directory, use `git -C <path>` - never `cd
<path> && git ...`.
