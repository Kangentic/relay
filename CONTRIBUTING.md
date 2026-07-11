# Contributing to kangentic-relay

Thanks for your interest in contributing. This project is small and deliberately narrow in scope
(a blind byte-forwarder), so the bar for new code is high: prefer fixing a real bug, hardening a
guard, or improving deploy tooling over adding features that widen what the relay knows or does.

## Before your first pull request: CLA and DCO

Because this relay is part of an open-core product (see the README's "Open-core and licensing"
section), Kangentic needs the ability to relicense or dual-license contributed code later, alongside
keeping the project genuinely open under AGPL-3.0-only today. To preserve that, every external
contributor must:

1. **Sign the Contributor License Agreement (CLA)** before a pull request can be merged. A CLA
   Assistant bot will comment on your first pull request with instructions; it only needs to be
   signed once.
2. **Sign off every commit** with the Developer Certificate of Origin, certifying you wrote the code
   or otherwise have the right to submit it:
   ```
   git commit -s -m "fix: description of the change"
   ```

Pull requests missing either will be blocked from merging until resolved.

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

## Reporting a security issue

Do not open a public issue. See `SECURITY.md`.
