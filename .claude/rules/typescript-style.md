# Rule: TypeScript style (no `any`, full descriptive names)

This codebase is TypeScript strict mode throughout. Two style rules are load-bearing for
maintainability: no `any`, and no shorthand variable names. The first is checked by ESLint; the
second is a review convention.

## The rule

- **TypeScript strict mode.** New code compiles under `tsc` strict mode (`tsconfig.json`
  `strict: true`, plus `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`); do not loosen
  it.
- **No `any` types.** Never use `any` in new code. Use proper types from `src/types.ts`,
  `unknown` with type guards, or generic constraints. Replace existing `any` casts when you
  touch the file.
- **No shorthand variable names.** Use full, descriptive names everywhere (variables, refs,
  parameters, callback arguments): `connectionCaps` not `connCaps`, `previousValue` not `prev`,
  `session` not `sess`.

## Enforcement (self-maintaining)

- **Lint (`any`):** ESLint `@typescript-eslint/no-explicit-any` is set to `error` in
  `eslint.config.js` for `src/**` and `test/**`. Run with `npm run lint`.
- **Type system:** `tsc --noEmit` (`npm run typecheck`) enforces strict mode and runs in CI.
- **Review:** `/code-review` flags `any` and shorthand names. Shorthand names are review-only
  (not reliably mechanizable).

`npm run lint` runs in CI (`.github/workflows/ci.yml`), so `no-explicit-any` is enforced on
every push, in addition to editors and review.

## Scope

Authored TypeScript under `src/` and `test/`.
