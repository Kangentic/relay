# Rule: no em-dashes or double-dashes as punctuation

Em-dashes (U+2014) render as garbled characters on Windows console code pages, and this
project's maintainer develops on Windows. Double-dashes (`--`) used as separators look awkward
in UI text and terminal output. Authored punctuation must use a single dash or be restructured.

## The rule

Never use an em-dash (U+2014, the long dash), `&mdash;`, or `--` as a sentence or list
separator in anything you author: source code, comments, tests, docs, scripts, commit
messages, and user-facing chat.

- Use a single dash for inline separators, e.g. `**Bold** - description`.
- Or restructure the sentence with a period.

This forbids em-dashes you write. It does not forbid em-dashes that appear inside recorded
data (captured terminal output, replay fixtures, assertions that mirror real external output),
where the character is content, not punctuation you chose.

## Enforcement (self-maintaining)

- **Lint:** `eslint.config.js`'s `no-restricted-syntax` rule flags a literal em-dash in
  `src/**` and `test/**`. Runs in CI via `npm run lint`.
- **Review:** `/code-review` flags em-dashes anywhere, including `docs/` and markdown, which
  the lint rule does not scan.

## Scope

Punctuation you author, in any file type. Recorded or captured content is exempt.
