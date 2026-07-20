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
- **Node:** pinned 22 (`.node-version`, `.nvmrc`); `engines.node >= 20`

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
  keepalive.ts        # WS ping/pong liveness + reaping
  admission.ts        # AdmissionPolicy interface, allowAllPolicy, webhook policy
  guards/             # slot-id format, rate limiting, connection caps
  net/clientIp.ts     # real client IP behind a trusted proxy, IPv6 bucketing
  http/               # /healthz, /readyz, /metrics (Prometheus), /metricz (JSON + RSS)
  logging.ts          # structured JSON logs; slot ids hashed by default
test/
  helpers/            # relayHarness.ts (real relay on an ephemeral port), wsClient.ts
  integration.protocol-handshake.test.ts   # real @kangentic/protocol handshake through the relay
  blindness.test.ts   # asserts src/** never imports @kangentic/protocol at runtime
  *.test.ts           # one file per module, matching src/ 1:1
scripts/
  loadTest.mjs        # load-test harness: N slot pairs x M frames x S bytes against a dedicated instance
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
- `docker compose up -d` - self-host locally

## Architecture

### The wire contract (fixed, defined by the desktop client, not this repo)

A client dials `${relayUrl}?slot=<64-char-hex>` with no subprotocol, no headers, no hello
frame. The relay pairs exactly two connections presenting the same slot and forwards binary
messages between them byte-for-byte. See `README.md`'s "The blind-relay guarantee" section.

### The blindness guarantee (load-bearing, self-maintaining)

`src/**` must never import `@kangentic/protocol` at runtime, and no code path may parse,
decode, or branch on frame content. `@kangentic/protocol` appears only as a devDependency,
imported by exactly one file: `test/integration.protocol-handshake.test.ts`, which proves a
real Noise KK handshake and secretstream-sealed message round-trips through a live relay
instance while the relay itself never touches any of it. `test/blindness.test.ts` mechanically
enforces the import restriction, and `/code-review` re-runs it as a pre-flight Critical-severity
gate on every review. Treat any change that would need to import the protocol package into
`src/**` as a design smell to escalate, not a quick fix.

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
  gated mutating workflow or a main-loop driver) (`.claude/skills/**`).

### Workflow

- **Landing changes goes through a PR by default.** The board drives it: the **Testing**
  column runs `/pull-request` (commit, branch, push, create the PR, drive CI to green), and the
  **Merge** column runs `/merge-pull-request` (merge, pull back to local `main`). For a
  deliberate direct quick-push, use `/merge-back`.
- A plain **local commit** goes through `/commit`: stages and commits on the current branch
  only, no push, no rebase. A bare "commit" / "commit changes" means `/commit`.
- `/commit`, `/pull-request`, `/merge-pull-request`, and `/merge-back` all write
  conventional-commit messages.
- `/code-review` reviews the current diff and auto-fixes safe findings by default.
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
