---
paths:
  - "src/config.ts"
  - "src/closeCodes.ts"
  - "src/admission.ts"
---
# Rule: documentation tracks source (anchor parity)

The README's config table, `.env.example`, and `CONTRIBUTING.md` are anchored to source: every
env var `config.ts` parses, every close code `closeCodes.ts` defines, and the admission seam
`admission.ts` exposes must not drift from what is actually documented. This rule is the
in-context reminder that fires when you touch an anchor source file.

## The rule

When you add, remove, or change the default of an env var in `src/config.ts`, update BOTH
`.env.example` and the README's config table to match. When you add or remove a close code in
`src/closeCodes.ts`, or change the `AdmissionPolicy`/`AdmissionContext` shape in
`src/admission.ts`, update the README's "Open-core and licensing" section accordingly.

- The canonical anchor list and workflow live in `.claude/skills/sync-docs/SKILL.md`. Do not
  duplicate that list here; update it there.
- `/pull-request` and `/merge-pull-request` run a targeted check of these anchors automatically
  when the diff touches one of the paths above.

## Enforcement (self-maintaining)

- **Workflow:** `/sync-docs` (run standalone) performs the full update pass; its targeted
  anchor check also runs automatically inside `/pull-request` and `/merge-pull-request`.
- No mechanical test yet. A scan asserting every `readInt`/`readBoolean`/`readString` key in
  `config.ts` appears in both `.env.example` and README.md is a strong candidate future test.

## Scope

Source-to-doc anchor parity for `README.md`, `.env.example`, and `CONTRIBUTING.md` only. Prose
accuracy elsewhere is handled by `/sync-docs`'s prose-audit pass, not this rule.
