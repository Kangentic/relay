# Rule: no personal or machine-specific info in committed code

This is a public repository. Hardcoded usernames, emails, or machine-specific absolute paths
leak personal data and break on other machines.

## The rule

Never hardcode personal or machine-specific values in committed code, tests, scripts, or docs:

- No personal usernames, emails, or home-directory paths (e.g. `C:\Users\tyler`,
  `/Users/tyler`). Use generic placeholders like `C:\Users\dev` or `/home/dev` in tests and
  examples.
- No machine-specific absolute paths. Derive paths at runtime (env vars, `path.join`, config)
  instead of hardcoding them.
- Keep all committed code environment-agnostic. The relay's own config is entirely
  environment-variable driven (`src/config.ts`) for exactly this reason.

## Enforcement (self-maintaining)

- **Review:** `/code-review` flags hardcoded personal paths and other personal data.
- No dedicated mechanical test yet. A scan for home-directory path patterns (a
  `C:\Users\<name>` other than `dev`, `/Users/<name>`, `/home/<name>` other than `dev`) and
  email literals is a strong candidate future test.

## Scope

All committed files. Does not apply to local-only, gitignored files (`.env`,
`CLAUDE.local.md`, `.kangentic/`, `kangentic.local.json`) or to a developer's own machine
config outside the repo.
