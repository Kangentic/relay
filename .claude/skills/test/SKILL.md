---
description: Run tests or audit coverage for the relay
allowed-tools: Read, Glob, Grep, Edit, Write, Bash(npm:*), Bash(npx:*), Bash(git:*)
argument-hint: [unit|integration|audit]
---

# Test - Local Test Gate

A fast, predictable local gate for the relay's two test tiers: unit (vitest, `test/*.test.ts`)
and integration (a single real `@kangentic/protocol` handshake through a live relay instance,
`test/integration.protocol-handshake.test.ts`). There is no UI or E2E tier in this repo - the
relay is a headless Node server.

**Usage:** `/test [mode]`

| Argument | Mode | Description |
|----------|------|-------------|
| *(none)* | **Full gate** | typecheck -> unit -> integration |
| `unit` | **Unit only** | typecheck -> unit |
| `integration` | **Integration only** | typecheck -> integration |
| `audit` | **Coverage audit** | Report gaps without running or writing tests |

**Selected mode:** $ARGUMENTS

---

## Mode: Full gate (`/test`)

1. **Typecheck (gate).** Run `npm run typecheck`. If it fails, report and **stop**.
2. Run `npm test` (unit tier).
3. Run `npm run test:integration`.
4. Present results in the Reporting Format below.

## Mode: Unit only (`/test unit`)

1. `npm run typecheck`. Stop on failure.
2. `npm test`.

## Mode: Integration only (`/test integration`)

1. `npm run typecheck`. Stop on failure.
2. `npm run test:integration`.

## Mode: Coverage audit (`/test audit`)

There is no dedicated coverage agent in this repo (small test surface, ~90 tests total); the
audit runs inline:

1. Gather context (each in its own Bash call): `git diff --staged`, `git diff`, `git status`.
2. For each behaviorally-significant change in the diff, ask: is there a test that would fail
   if this change were reverted? If not, report a coverage gap: the location, the specific
   behavior left unverified, and which existing test file it most naturally belongs in
   (`test/rendezvous.test.ts` for slot logic, `test/guards/*` equivalents like
   `test/rateLimit.test.ts`/`test/caps.test.ts`/`test/slotFormat.test.ts` for a guard,
   `test/admission.test.ts` for the seam, `test/keepalive.test.ts` for liveness,
   `test/health.test.ts`/`test/metrics.test.ts` for the operational surface, or
   `test/integration.protocol-handshake.test.ts` only for a change that needs the real
   `@kangentic/protocol` handshake).
3. Report gaps found, or "No coverage gaps - all changes are tested or trivial."
4. Do not write tests in this mode.

---

## Writing new tests (any mode)

This repo has no `test-builder` delegate; write tests directly, following the patterns already
in `test/`:
- Reuse `test/helpers/relayHarness.ts` (starts a real relay on an ephemeral port) and
  `test/helpers/wsClient.ts` (a queueing WS client wrapper - see its doc comment for why
  eager message queuing matters: a message the relay flushes during pairing can beat a lazily
  attached listener).
- Prefer fake timers (`vi.useFakeTimers()`) over real delays for anything involving
  `PING_INTERVAL_MS`, `PARK_TIMEOUT_MS`, or the rate limiter's clock injection - see
  `test/keepalive.test.ts` and `test/rateLimit.test.ts` for the pattern.
- Red-green verify: confirm the test fails without your fix, then passes with it.
- Run only the file you touched (`npx vitest run test/<file>.test.ts`), not the full suite,
  while iterating.

## Reporting Format (run modes only)

```
## Test Results

| Tier        | Status | Passed | Failed | Duration |
|-------------|--------|--------|--------|----------|
| Unit        | PASS   | 82     | 0      | 1.2s     |
| Integration | PASS   | 1      | 0      | 1.0s     |

All green. No regressions.
```

- Only include tiers that ran. Use `PASS`, `FAIL`, or `skipped` - never emojis.
- Passed counts come from vitest's own summary line.

On failures, add after the table:

```
### Failures

1. test/rendezvous.test.ts:42 - "pairs two connections on the same slot"
   Error: expected 'sent while parked' but got undefined

### Recommendations
- Investigate <file> - <what the error indicates>
```

## Rules

- **No chained commands.** No `&&`, `||`, `|`, `;`, or stderr redirection. Each command runs in
  its own Bash tool call.
- **No `cd && git`.** Git commands run from the current working directory; use `git -C <path>`
  to target another.
- **Typecheck is a gate.** Always typecheck first; stop immediately on failure.
- **Use dedicated tools.** Use `Read`, `Glob`, `Grep` for file operations. Reserve `Bash` for
  `npm`, `npx`, and `git` only.
