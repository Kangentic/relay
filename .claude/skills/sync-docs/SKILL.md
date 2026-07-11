---
description: Review and update documentation to match current source code
allowed-tools: Read, Edit, Write, Glob, Grep, Bash(git:*)
---

# Sync Docs

Review and update the repo's documentation to match the current source code. This is a much
smaller surface than a typical app: there is no `docs/` directory, just `README.md`,
`.env.example`, `CONTRIBUTING.md`, `SECURITY.md`, and `CHANGELOG.md`.

## Source-to-Doc Mapping

| Doc | Primary Source Files |
|-----|---------------------|
| `README.md` (config table + quickstart) | `src/config.ts`, `.env.example`, `Dockerfile`, `docker-compose.yml` |
| `README.md` (open-core / admission section) | `src/admission.ts` |
| `README.md` (blind-relay guarantee) | `src/**` (the absence of any `@kangentic/protocol` runtime import), `test/blindness.test.ts` |
| `.env.example` | `src/config.ts` (every `readInt`/`readBoolean`/`readString`/`readRegExp` key and default) |
| `CONTRIBUTING.md` | `CLA.md`, `.github/workflows/cla.yml`, `eslint.config.js`, `package.json` scripts |
| `SECURITY.md` | (policy, not source-anchored - review manually for staleness) |
| `CHANGELOG.md` | `git log`, `package.json` version |

## Anchor Points

The one enumerable anchor worth a mechanical check: **every env var `src/config.ts` parses
must appear in both `.env.example` and the README's config table, with matching defaults.**

- `src/config.ts`
  WHY: `loadConfig()` is the single source of truth for every env var name and default. A new
  `readInt(env, 'FOO', 123)` call that never makes it into `.env.example` or the README table
  is silent config drift - a self-hoster has no way to discover the knob exists.

- `src/closeCodes.ts`
  WHY: the `CLOSE_CODE` map and `RejectReason` union should stay consistent with anything the
  README documents about relay behavior (currently the README does not enumerate individual
  close codes, but if it starts to, this is the anchor).

- `src/admission.ts`
  WHY: `AdmissionContext`, `AdmissionDecision`, and the webhook contract are described in
  README's "Open-core and licensing" section; a shape change there needs a doc update.

## Workflow

### Step 1 - Scope Detection

1. Check for unpushed commits: `git log origin/HEAD..HEAD --name-only --pretty=format:""`.
2. If none, diff against the latest tag: `git describe --tags --abbrev=0` then
   `git diff --name-only <tag>..HEAD`.
3. Filter to source files only (exclude `.claude/`, `test/`).
4. If no source files changed, report "No source changes detected - skipping doc review" and
   stop.

### Step 2 - Env var anchor check

If `src/config.ts` changed:

1. Read `src/config.ts`, extract every env var name (the first argument to each
   `read*(env, 'NAME', ...)` call) and its default.
2. Read `.env.example` and the README config table.
3. Report any var present in `config.ts` but missing from either doc, or where the documented
   default disagrees with the code.
4. Fix gaps directly with `Edit`.

### Step 3 - Prose Audit

For `README.md`, `CONTRIBUTING.md`, and `SECURITY.md`:

1. Read the doc and the source files it references.
2. Check for prose staleness: changed behavior descriptions, stale defaults, renamed
   functions/env vars, a stale license/repo-URL reference.

### Step 4 - Update Pass

1. Fix anchor gaps from Step 2.
2. Fix prose staleness from Step 3.
3. Update cross-references if any doc's structure changed.

**Constraints:** only edit `README.md`, `.env.example`, `CONTRIBUTING.md`, `SECURITY.md`,
`CHANGELOG.md`. Never modify source code, tests, or config files. Respect the single-command
Bash rule.

### Step 5 - Report

Summarize: anchor gaps found and fixed, prose updates made, and "No changes needed" if
everything is current.
