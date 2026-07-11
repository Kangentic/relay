# Contributing to kangentic-relay

Thanks for your interest in contributing. This project is small and deliberately narrow in scope
(a blind byte-forwarder), so the bar for new code is high: prefer fixing a real bug, hardening a
guard, or improving deploy tooling over adding features that widen what the relay knows or does.

## Before your first pull request: sign the CLA

Because this relay is part of an open-core product (see the README's "Open-core and licensing"
section), Kangentic needs the ability to relicense or dual-license contributed code later, alongside
keeping the project genuinely open under AGPL-3.0-only today. To preserve that, **all contributors
must sign a CLA before their first pull request can be merged.**

When you open your first PR, the CLA Assistant bot will post a comment asking you to sign. You sign
by adding a comment to the PR with the exact text it asks for. It takes about 30 seconds and only
needs to be done once.

**What the CLA says (in plain language):**

- You grant VORPAHL LLC a perpetual, worldwide, non-exclusive, royalty-free license to use, modify,
  sublicense, and distribute your contribution under any license.
- You retain full copyright to your contribution. You can use it however you want.
- You confirm you have the right to make this grant (you wrote the code yourself or have permission).
- If your contribution includes third-party code, you must identify it and its license in the PR
  description.

The full text is in [CLA.md](CLA.md).

## Development setup

```
npm install
npm run typecheck
npm run lint
npm test
npm run test:integration
```

`npm run test:integration` installs and exercises `@kangentic/protocol` (a devDependency only,
never a runtime one) to prove a real end-to-end handshake completes through the relay without the
relay itself ever parsing a frame. If you touch anything under `src/rendezvous.ts`,
`src/connection.ts`, or `src/server.ts`, run both test suites before opening a pull request.

## Coding conventions

- TypeScript strict mode; no `any`.
- Full, descriptive names (`connectionCaps`, not `connCaps`).
- No em-dash (`—`) or `--` used as punctuation; use a single `-` or restructure the sentence.
- Keep the relay blind: never add a runtime import of `@kangentic/protocol`, or any code path that
  parses, decodes, or branches on frame content, under `src/**`.
- New guards, config, or behavior changes should come with a test and, where relevant, an update to
  `.env.example` and the README's config table.

## How maintainers land contributions

You do not need to run any of this; it is just so the flow is not a mystery. Maintainers drive
a PR to green and merge it through an internal Kanban board: a Testing column runs
`/pull-request` (pushes the branch and drives the CI checks to green, auto-fixing along the
way), and a Merge column runs `/merge-pull-request` (merges the green PR and pulls the result
back into the local `main` checkout). The board mechanics, git worktrees, and agent skills are
documented in [CLAUDE.md](CLAUDE.md) and are not something a contributor is expected to set up.

## Reporting a security issue

Do not open a public issue. See `SECURITY.md`.
