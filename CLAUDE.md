# @kangentic/relay

A tiny, stateless, blind WebSocket rendezvous relay for the Kangentic mobile companion. It
forwards only opaque ciphertext frames between two peers that both dial out to it. It
authenticates nothing and reads nothing. Full context: [README.md](README.md).

This is a **sibling repo** to [`kangentic`](https://github.com/Kangentic/kangentic) (the
desktop app, which is the relay's client) and to `@kangentic/protocol` (the end-to-end crypto
layer this relay forwards but never imports at runtime). It is registered as its own Kangentic
project with its own board, worktrees, and skills - not a subdirectory of the desktop repo.

## Tech Stack

- **Language:** TypeScript, strict mode, ESM (`"type": "module"`)
- **Runtime dependency:** `ws` only (production)
- **Dev dependency:** `@kangentic/protocol` (used ONLY by the integration test, never at
  runtime by `src/**` - see "The blindness guarantee" below). It is pinned to a published
  `^x.y.z`; because the relay is blind, it almost never needs to track protocol changes (only
  when the handshake or framing the integration test exercises changes). On the rare occasion it
  does, follow the shared strategy the consumers use: `main` of the kangentic monorepo is the
  protocol's source of truth, iterate by building and linking the sibling `packages/protocol`
  into `node_modules` for local dev, and publish to npm only at a release milestone (the full
  workflow lives in kangentic-mobile's `docs/developer-guide.md` and the desktop's
  `docs/mobile-bridge.md`).
- **Build:** `tsc` (no bundler)
- **Tests:** Vitest, two workspace projects (`unit`, `integration`)
- **Deploy:** Docker (multi-stage, non-root runtime), docker-compose, GitHub Actions CI
- **Node:** pinned 22 (`.node-version`, `.nvmrc`); `engines.node >=20 <23`, made a hard install
  failure by `.npmrc`'s `engine-strict=true` (see "Node 22 is required" under Testing)

## Project Structure

```
src/
  index.ts            # entry: load config, build relay, install SIGTERM/SIGINT, listen
  config.ts           # env-var parsing into a frozen Config; fails fast on bad values
  types.ts            # Conn, SlotState, Config, decision types
  closeCodes.ts        # app-level WS close codes (4000-4999) + RejectReason union
  server.ts           # createRelay(): http.Server + WebSocketServer(noServer); upgrade+connection wiring
  rendezvous.ts       # SlotTable: park/pair/reject/teardown - the core routing logic
  connection.ts       # Conn factory, per-message forwarding hot path
  connectionTrace.ts  # opt-in CONNECTION_TRACE: per-connection dial + first-frame timings, keyed by CF-Ray
  keepalive.ts        # WS ping/pong liveness + reaping; spares a socket still draining (readOutboundQueue)
  admission.ts        # AdmissionPolicy interface, allowAllPolicy, webhook policy
  guards/             # slot-id format, rate limiting, connection caps
  net/clientIp.ts     # real client IP behind a trusted proxy, IPv6 bucketing
  http/               # /healthz (+ build version), /readyz, /metrics (Prometheus), /metricz (JSON + RSS),
                      #   /admin dashboard + /admin/data (adminPage.ts holds the inline page)
  history/            # metrics history recorder: rows.ts (schema + delta/aggregation math),
                      #   recorder.ts (timer, ring, NDJSON store, compaction), processSampler.ts
  version.ts          # own package.json version, resolved once at import; undefined if unreadable
  logging.ts          # structured JSON logs; slot ids hashed by default
test/
  helpers/            # relayHarness.ts (real relay on an ephemeral port), wsClient.ts
  integration.protocol-handshake.test.ts   # real @kangentic/protocol handshake through the relay
  blindness.test.ts   # asserts src/** never imports @kangentic/protocol at runtime
  *.test.ts           # one file per module, matching src/ 1:1
scripts/
  loadTest.mjs        # load-test harness: N slot pairs x M frames x S bytes against a dedicated instance
  flakeHunt.mjs       # runs the unit suite N times; reports the worker-crash rate and the file that crashed
  roamRepro.mjs       # A/B measurement of re-pair time after a roam, contention probe off vs on
  slowConsumerRepro.mjs  # A/B: does the keepalive reap a live reader draining a deep backlog (run on Linux)
  legProbe.sh         # 1 Hz per-leg latency probe (client: edge vs origin; box: Caddy, relay, TCP counters)
  burstProbe.mjs      # time a burst after an idle period through a relay URL (slow-start before/after)
  review-verdict.mjs  # /code-review's Ready-or-Blocked verdict + commit ledger, computed from findings.json
  lib/is-entrypoint.mjs  # realpath-based "was this module the entry script", so a test can import one
```

## Commands

- `npm install` - install dependencies (worktrees do not share `node_modules` with the main
  checkout; always run this first in a fresh worktree)
- `npm run dev` - run locally with `tsx watch`
- `npm run build` - compile to `dist/`
- `npm run typecheck` - `tsc --noEmit`
- `npm run lint` - ESLint (`--max-warnings` not set but CI treats any error as a failure)
- `npm test` - unit tier only
- `npm run test:integration` - the real-handshake integration test
- `npm run test:flake` - run the unit suite repeatedly to measure an intermittent worker crash
  (`-- --runs 30`); see [docs/testing.md](docs/testing.md)
- `npm run test:roam` - measure re-pair time after a roam with the contention probe off vs on
  (needs `npm run build` first); see [docs/testing.md](docs/testing.md)
- `docker compose up -d` - self-host locally

## Architecture

### The wire contract (fixed, defined by the desktop client, not this repo)

A client dials `${relayUrl}?slot=<32-or-64-char-hex>` with no subprotocol, no headers, no hello
frame. The relay pairs exactly two connections presenting the same slot and forwards binary
messages between them byte-for-byte. See `README.md`'s "The blind-relay guarantee" section.

One optional parameter rides alongside: `&role=desktop|mobile`, parsed by `src/guards/peerRole.ts`.
It is a self-declared hint that attributes the waiting-slots gauge and nothing else. It is
unauthenticated, it never reaches a pairing, routing, cap, or rate-limit decision, and it **cannot
reject**: absent, misspelled, or hostile all collapse to `unknown`, so every client that predates it
keeps working unchanged. Validate at the edge and never let the raw string reach a metric label,
or a stranger can mint unbounded Prometheus series. Because the contract is defined by the desktop
client rather than here, the relay ships this ahead of the clients and reads `unknown` for everyone
until they send it.

### The blindness guarantee (load-bearing, self-maintaining)

`src/**` must never import `@kangentic/protocol` at runtime, and no code path may parse,
decode, or branch on frame content. `@kangentic/protocol` appears only as a devDependency,
imported by exactly one file: `test/integration.protocol-handshake.test.ts`, which proves a
real Noise handshake and secretstream-sealed message round-trips through a live relay
instance while the relay itself never touches any of it. (That file covers both patterns the
product performs: KK, the *reconnect* handshake, over the paired forwarding path, and IKpsk0,
the *first-pairing* handshake, sent while the initiator is still parked alone so it travels
the pre-pair buffer-and-flush path instead. The relay is blind to both, so the distinction
matters for docs and tests, not for `src/**`.) `test/blindness.test.ts` mechanically
enforces the import restriction, and `/code-review` re-runs it as a pre-flight Critical-severity
gate on every review. Treat any change that would need to import the protocol package into
`src/**` as a design smell to escalate, not a quick fix.

### The /admin dashboard and metrics history

`ADMIN_ENABLED` serves a private dashboard; `METRICS_HISTORY_PATH` points at an append-only
NDJSON store the relay samples on a timer. Both default off, and off is **structural**, not a
runtime flag check: `createHistoryRecorder` is simply never called, so no timer, no file handle,
no route, and no event-loop-delay monitor exist. Four invariants are load-bearing:

- **The forwarding hot path stays untouched.** `Metrics.onForward()` is two integer increments.
  Nothing in this feature runs per frame. A change that needs per-frame work here is a redesign,
  not a tweak.
- **Counters are stored as per-interval deltas, never raw totals**, since they zero on restart
  and raw values would draw every deploy as a giant negative spike. The delta baseline is taken
  at recorder *construction*, not on the first tick, because `createRelay` accepts an injected
  `Metrics` that may already be warm.
- **Compaction buckets on epoch-aligned boundaries**, which is what makes it idempotent, and
  resolution may only ever increase. Bucketing relative to `now` would drift and double count.
- **The relay does not authenticate `/admin`.** That is deliberate (it stays a relay that
  authenticates nothing); the gate is Cloudflare Access scoped to `/admin*`. Do not add an
  in-process login. See `docs/security-model.md`.

`/metricz` is not superseded by this: it is the machine surface `monitor.yml` and
`scripts/loadTest.mjs` consume, and it keeps its token gate. The two surfaces share a data
definition rather than an auth mechanism: `buildClosedByCause` in `src/http/metrics.ts` is the
single place the teardown-cause grouping is defined, fed lifetime totals by `/metricz` and
per-interval deltas by the history rows.

New history row keys are **additive under the same schema version**, never a bump: a bump turns
every older row into an unknown version that is kept but never served, hiding the very baseline the
new fields are compared to. A nullable field that is measured is written even at zero, since
absence is how a reader tells "not measured" from "measured nothing" (see `cp` and the stall keys in
`rows.ts`).

### Connection trace and keepalive liveness

`CONNECTION_TRACE` (`src/connectionTrace.ts`) is the one opt-in exception to "nothing runs per
frame", and it is bounded on both sides: off is structural (no accept listener, no trace object, the
plain `message` listener), and on, a separate listener records only the first `TRACE_FRAME_LIMIT`
frames and then swaps itself for the plain one. Keep it that way; a trace that grows a branch in
`onMessage` or records every frame is a redesign. Its log line is built from an allowlist and never
carries a slot id or an IP.

The keepalive spares a missed pong when the socket made delivery progress
(`isDraining(readOutboundQueue(...))`). `readOutboundQueue` reads libuv's `writeQueueSize` off the
socket's internal handle, which is not public API; `test/keepalive.test.ts` reads it off a real
socket so a Node or ws upgrade that moves it fails the build. Do not drop that test or "simplify"
the check to `bufferedAmount` alone: measured on Linux, `bufferedAmount` stays flat under Node's
batched `writev` and the check then spares nothing (`docs/latency.md`).

### Open-core admission seam

`src/admission.ts`'s `AdmissionPolicy` is the only extension point a future, separate, private
control-plane repo needs to gate access to Kangentic's *hosted* instance. Because this relay is
AGPL-3.0-only, that control plane must attach **out of process** (the `ADMISSION_WEBHOOK_URL`
seam), never by importing this package in-process - see README's "Open-core and licensing"
section for why.

### Runaway-bill guards

Every guard (slot-id format, per-IP/per-slot rate limits, connection caps, byte caps,
backpressure teardown) is environment-configurable with a sane default. See `src/guards/*`,
the README config table, and `.env.example`. Keep all three in sync - see
`.claude/rules/docs-stay-in-sync.md`.

### Testing

Two tiers, no UI/E2E (this is a headless server, not an app):
- **Unit** (`test/*.test.ts`, Vitest): fast, spins up a real relay on `port: 0` where useful.
- **Integration** (`test/integration.protocol-handshake.test.ts`): the one place
  `@kangentic/protocol` is imported, proving end-to-end blind forwarding with real crypto.

`/test` runs both; `/pull-request` offloads both to CI and only runs `typecheck` + `lint`
locally.

**Node 22 is required, and it is load-bearing for the local gate.** On Node 24 the Vitest worker
dies on roughly 1 run in 10 (native fail-fast, exit `0xC0000409`, no stderr), taking one test
file's results with it, so `npm test` goes red with nothing having failed. Measured: 5 crashes in
48 Node 24 runs, 0 in 40 Node 22 runs on the identical checkout. `--pool=threads` is worse, not a
workaround. If a run dies this way, the file that never reported **is** the file that crashed:
the forks pool gives each test file its own child process. `scripts/flakeHunt.mjs`
(`npm run test:flake`) measures the rate and names that file. Full write-up, including two ruled
out suspects, in [docs/testing.md](docs/testing.md). Do not "fix" a flaky suite here with retries
or `--no-file-parallelism`.

## Conventions

**Always-on rules** (loaded every session, `.claude/rules/`):
- `bash-single-command.md` - one command per Bash tool call; no `&&` `||` `|` `;` or redirects.
- `text-formatting.md` - no em-dashes (U+2014) or `--` as punctuation in authored text.
- `typescript-style.md` - TypeScript strict mode; no `any` types; full descriptive names.
- `no-personal-info.md` - no usernames, emails, or machine paths in committed code (repo is
  public).

**Path-scoped rules:**
- `docs-stay-in-sync.md` - env vars / close codes / admission shape stay reflected in
  `.env.example` and README (`src/config.ts`, `src/closeCodes.ts`, `src/admission.ts`).
- `skill-authoring.md` - when to fork a skill (currently: never - every skill here is either a
  gated mutating workflow or a main-loop driver), and why a fan-out gets a dedicated read-only
  agent with its model and effort pinned rather than `general-purpose`
  (`.claude/skills/**`, `.claude/agents/**`).

### Workflow

- **Landing changes goes through a PR by default.** The board drives it: the **Testing**
  column runs `/pull-request` (commit, branch, push, create the PR, drive CI to green), the
  **Merge** column runs `/merge-pull-request` (merge, pull back to local `main`), and the
  **Release** column runs `/release` (promote the changelog, tag `vX.Y.Z`, ship). For a
  deliberate direct quick-push, use `/merge-back`.
- **Merging does not ship.** A merge to `main` publishes an image and stops; only a `vX.Y.Z` tag
  deploys to the hosted instance. So landing work and putting it in front of users are separate
  acts, `main` may hold merged-but-unreleased changes, and production always runs a version with
  a changelog entry. `/release` is the only skill here that reaches real users - the deploy has a
  health gate and automatic rollback, but treat it with that in mind. A deploy that is not a
  release (rollback, redeploy, rollback drill) runs `deploy.yml` via `workflow_dispatch`, not a
  new tag.
- A plain **local commit** goes through `/commit`: stages and commits on the current branch
  only, no push, no rebase. A bare "commit" / "commit changes" means `/commit`.
- `/commit`, `/pull-request`, `/merge-pull-request`, `/merge-back`, and `/release` all write
  conventional-commit messages.
- **`/code-review` converges in one pass and commits that pass.** It fixes every finding it
  verifies (Lows included), applies its recommended option on a decision and records the
  alternative, and ends with the **Ready** or **Blocked** verdict `scripts/review-verdict.mjs`
  computes from its `findings.json`. There is no "skipped" status: only work this session
  genuinely cannot do is `blocked`, and only Blocked sends a card back to Executing. It commits
  its own pass locally under the `review` scope, never pushes, and never `git add -A` (it
  commits only what became dirty during the pass, so the task agent's unfinished work in the
  same worktree is left alone). Each review commit body carries a `Refuted:`/`Decisions:`
  ledger that the next pass reads back, so two passes cannot flip the same call without new
  evidence.
- `/test` runs the local gate; `/sync-docs` keeps the README/`.env.example`/CONTRIBUTING in
  sync with source.
- **No branch protection is configured on `main` yet** (unlike the sibling `kangentic` repo).
  `/merge-pull-request` therefore merges without `--admin`. If branch protection is added
  later, that skill needs a deliberate update, not a silent copy of the desktop repo's bypass.

**Not ported from the `kangentic` desktop repo:** everything Electron/HMR/IPC/PTY/UI-specific
(hmr-parity, ipc-auditor, session-debugger, migration-safety, platform-guard,
marketing-captures, and their corresponding rules) has no equivalent here - this repo has no
renderer, no IPC layer, no database, and no PTY sessions. If this project ever grows a surface
that needs analogous tooling, author it fresh for what this repo actually is, rather than
reimporting the desktop app's version wholesale.

That applies to `/code-review` too. Its convergence behavior, ledger, set-math commit, and
verdict script are ported; its **review-pack machinery is deliberately not**. The desktop repo
builds a sharded pack with `scripts/build-review-pack.mjs` because its diffs are large enough
that each finder re-reading them dominated the cost. Here the driver writes the diff straight to
`.kangentic/REVIEW_DIFF_*.tmp` with `git diff --output=` and the finders read that, which buys
the same gather-once property in a few lines. Also skipped, for want of the surface they audit:
the pack shards and since-review pack, the `test-builder` agent and the E2E tier, the
domain auditors, `scripts/review-eval/`, and the commitlint footer-cap fix (this repo runs no
commitlint). Reach for the pack script only if a relay diff ever gets big enough to need it.
