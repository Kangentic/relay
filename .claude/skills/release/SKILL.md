---
description: Cut a versioned release and ship it - promote the changelog, tag vX.Y.Z, and drive the Release workflow to green so production runs the new version. This is the Release column skill, run after /merge-pull-request has landed the work on main. Not for landing a change (use /pull-request then /merge-pull-request) and not for a rollback (see the runbook note below).
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(git:*), Bash(npm:*), Bash(npx:*), Bash(node:*), Bash(gh:*), Bash(curl:*), AskUserQuestion, mcp__kangentic__kangentic_get_current_task
---

# Release

Cut a versioned release of `@kangentic/relay` and ship it to the hosted instance. This is the
**Release column** skill. It assumes the **Merge column** (`/merge-pull-request`) already landed
the work on `main`.

**Merging does not deploy.** A merge to `main` publishes an image (`latest`, `sha-<full sha>`)
and stops. Only a `vX.Y.Z` tag deploys, so this skill is the one place a change reaches real
users. Treat it accordingly.

**Usage:** `/release [version]`

- `/release` - proposes the next version from the changelog and confirms it
- `/release 0.2.0` - uses that version (still validated against the changelog and `package.json`)

**User-provided version (if any):** $ARGUMENTS

## Pre-flight Checks

All git commands run from the **current working directory** - never `cd <path> && git ...`. Use
`git -C <path>` to target another directory.

1. **Work from the main checkout, not a worktree.** A release tags `main`; a task worktree is on
   a feature branch. If CWD contains `.kangentic/worktrees/`, derive the project root (two
   directories above `.kangentic/worktrees/<slug>/`) and run every git command below with
   `git -C <projectRoot>`. Report which path you are operating on.
2. Confirm the checkout is on the source branch: `git -C <root> rev-parse --abbrev-ref HEAD`
   (expect `main`, or `git config kangentic.baseBranch`). If it is not, stop and report - do not
   check out branches on the user's main clone.
3. `git -C <root> status --porcelain` must be empty apart from files this skill is about to
   change. Uncommitted work in the main checkout is a signal something is wrong; report and stop
   rather than sweeping it into a release commit.
4. `gh auth status`. If it fails, stop - this skill drives workflow runs over `gh`.
5. `git -C <root> fetch origin <sourceBranch>` then confirm the checkout is not behind:
   `git -C <root> rev-list --count HEAD..origin/<sourceBranch>` must be `0`. If it is behind,
   `git -C <root> pull --ff-only` first, so the tag includes everything that has landed.

## Step 1 - Confirm there is something to release

1. Compare against the last release: `git -C <root> describe --tags --abbrev=0` for the previous
   tag (absent on a first release), then
   `git -C <root> log --oneline <previousTag>..HEAD` to list what would ship.
2. If that range is empty, stop: `main` is already released, nothing to cut.
3. Read `CHANGELOG.md`. The `## [Unreleased]` section is what becomes the release notes. If it is
   missing or empty while commits exist, the changelog is behind - write the missing entries from
   the commit range before continuing, in the existing Keep a Changelog style (`### Added`,
   `### Changed`, `### Fixed`), describing user-visible impact rather than restating commit
   subjects.

## Step 2 - Choose the version

1. Read the current version: `node -p "require('./package.json').version"`.
2. Propose the next one from what is actually in `[Unreleased]`, pre-1.0 (this repo tags no bare
   major while `0.x` - see `release.yml`'s metadata step):
   - a breaking change for operators (a removed or default-flipped env var, a changed wire
     behavior) → minor bump
   - additions and fixes only → patch bump
   - a first release → the version already in `package.json`
3. **Confirm with the user via `AskUserQuestion`** unless `$ARGUMENTS` named a version. Include
   the proposed number, the bump reasoning, and the breaking changes it carries. The number is
   the user's call; do not pick it silently.

## Step 3 - Promote the changelog and sync the version

1. Rename `## [Unreleased]` to `## [<version>] - <YYYY-MM-DD>` (today's date).
2. **Insert a fresh empty `## [Unreleased]` heading above it**, so the next change has somewhere
   to land. Forgetting this is the most common miss in this flow.
3. If `package.json`'s version does not match, update it. `release.yml`'s gh-release job asserts
   `v<tag> == package.json version` and fails the release if they differ - and it fails *after*
   the tag is already pushed, which is the awkward place to discover it.
4. **Verify the notes extract before tagging:**
   `node scripts/release/extract-changelog.mjs v<version>`. It must print a non-empty body. This
   is the same script the workflow runs, so a pass here means the release job will not fail on it.
5. Commit with the Write tool to `.kangentic/COMMIT_MSG.tmp` (gitignored, so `git add -A` will not
   stage it), then `git -C <root> commit -F .kangentic/COMMIT_MSG.tmp`. Message:
   `chore(release): promote the changelog to <version>`, with a body naming what operators must
   act on. **Never use `$(...)` or backtick substitution** - it triggers a safety prompt.
6. Push: `git -C <root> push origin <sourceBranch>`.

This push fires a Release run that builds an image but does **not** deploy. Let it be; the tag
below is what ships.

## Step 4 - Tag and ship

1. `git -C <root> tag -a v<version> -m "v<version>"`.
2. `git -C <root> push origin v<version>`.
3. Find the run: `gh run list --workflow release.yml --limit 1`, then watch it:
   `gh run watch <runId> --exit-status --compact` with the Bash `timeout` at `600000` ms.
4. The tag run does checks, builds the semver image, creates the GitHub release, and only then
   deploys. On success, go to Step 5.

**If the run fails, do not retag over it.** Diagnose with `gh run view <runId> --log-failed`:

- **A check failed:** the tag points at broken code. Land the fix through the normal board flow
  (`/pull-request`, `/merge-pull-request`), then cut the *next* patch version. Delete the bad tag
  locally and on the remote (`git -C <root> tag -d`, `git -C <root> push origin :v<version>`) and
  say so plainly - a tag that never shipped is better deleted than left pointing at a failed
  release.
- **gh-release failed:** almost always the version assertion or the changelog section. Both are
  checked in Step 3, so this means something drifted; fix it on `main` and cut the next patch.
- **The deploy failed:** the box rolls itself back to the previous digest automatically. Confirm
  the rollback in the job log, report which digest production is on, and stop. Do not retry
  blindly.

## Step 5 - Verify it is actually live

A green deploy job is necessary, not sufficient. Confirm the product works:

1. Read the deploy job log and quote the digest it reports. Note that the deploy **skips the
   restart** when a release carries no build-relevant change (a docs-or-changelog-only release);
   that is correct, but it means production keeps running the previous digest. Say which case
   happened rather than implying a fresh rollout.
2. `curl -sS https://<relay hostname>/healthz` - expect
   `{"status":"ok","version":"<the tag without its leading v>"}`. This is the cheapest
   confirmation that production is actually serving the build you just cut. Two failure readings:
   a `version` still showing the *previous* release means the deploy skipped the restart or rolled
   back, so reconcile it against the digest from step 1; a *missing* `version` field means the
   container could not read its own `package.json`, which is worth investigating but is not a
   liveness failure.
3. **Run the synthetic pairing probe**, which is the only check that proves the product works end
   to end through Cloudflare and Caddy: `gh workflow run monitor.yml`, find the run
   (`gh run list --workflow monitor.yml --limit 1`), and watch it. It also exercises the
   token-gated `/metricz`, so it catches a metrics or config regression at the same time.

## Step 6 - Report

- Release URL, tag, and the image tag now published.
- What shipped: the commit range since the previous tag, and any operator-facing breaking change
  from the changelog, called out explicitly.
- Which digest production is running, and whether the deploy rolled or correctly skipped.
- The synthetic pairing result.
- Reminder to move the task to Done on the board, which triggers `cleanup_worktree`.

## Not this skill

- **Rolling back:** run `deploy.yml` via `workflow_dispatch` with `image_tag` set to the previous
  good `vX.Y.Z`. Do not cut a new release to undo one.
- **Redeploying the same version:** same `workflow_dispatch`, same tag. Do not retag.
- **Shipping something not on `main`:** land it first. This skill tags `main` and nothing else.

## Rules

**CRITICAL: No chained commands.** Every Bash call must contain exactly ONE command. Never use
`&&`, `||`, `|`, or `;`. For git commands in another directory, use `git -C <path>` - never
`cd <path> && git ...`. Conventional commit messages. No em-dashes or `--` as punctuation.

**Never fork this skill or spawn a side-check while it is running** (see
`.claude/rules/skill-authoring.md`): it is a gated, mutating workflow that pushes tags and ships
to production, and it needs main-loop visibility and user confirmation.
