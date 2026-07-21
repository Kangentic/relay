# Architecture

## What this process does

One Node.js process, one HTTP server (`src/server.ts`). It serves five fixed HTTP routes
(`/healthz`, `/readyz`, `/metrics`, `/metricz`, and a static splash page at `/`) and upgrades
WebSocket requests at `config.wsPath` (default `/`), provided the request carries a `slot` query
parameter that passes `isValidSlotId`. The splash page has no config surface and never touches the
upgrade path: WebSocket upgrades arrive on Node's separate `'upgrade'` event, so a plain `GET /`
and a `GET /` with an `Upgrade: websocket` header are handled by entirely different code. There is
no other surface. No database, no session store, no request body is ever parsed.

Two connections that present the same slot id are paired and every binary message one sends is
written to the other's socket, unmodified. That is the entire product.

## The connection lifecycle

```
'upgrade' event (src/server.ts: handleUpgrade)
  -> slot format check (guards/slotFormat.ts)
  -> resolve client IP (net/clientIp.ts)
  -> per-IP rate limit, per-slot rate limit (guards/rateLimit.ts)
  -> reserve global + per-IP connection cap (guards/caps.ts)
  -> draining check
  -> admission policy (admission.ts) -- the only async step
  -> draining check again (a slow admission call must not admit into a draining process)
  -> wss.handleUpgrade -> 'connection'
       -> createConn (connection.ts)
       -> attachConnectionHandlers (message/pong/close/error)
       -> slotTable.handleConnection (rendezvous.ts)
```

Connection caps are reserved **before** the admission call, not after, specifically so a slow or
hanging admission webhook cannot be raced by many connections at once to blow past the caps. The
reservation is released in the `onClosed` callback regardless of how the connection ends.

Message handlers are attached (`attachConnectionHandlers`) **before** the connection is handed to
`SlotTable.handleConnection`, so a frame the peer sends immediately on open is never lost whether
the connection ends up parked or paired immediately.

## The rendezvous state machine

`SlotTable` (`src/rendezvous.ts`) owns a single `Map<string, SlotState>` — the entire routing
table. A slot is either:

- **`waiting`**: one connection (`peer`) parked, buffering any frames it sends into
  `conn.pending` until a partner arrives (bounded by `MAX_PARKED_BUFFER_BYTES`; see
  `connection.ts`'s `onMessage`).
- **`paired`**: two connections (`a`, `b`) with `sessionBytes` tracked on the shared
  `PairedSlotState` object, which both connections also hold a reference to directly
  (`conn.pairState`) so the per-frame forwarding path never does a map lookup.

`handleConnection` is the single entry point, called synchronously from the `'connection'`
event with **no `await` between reading and mutating `slots.get(slot)`**. Node's single-threaded
event loop makes this race-free without a lock: two connections arriving for the same slot can
never both believe they are the first (or second) arrival, because nothing yields between the
read and the write.

Pairing flushes the waiting peer's buffered pre-pair frames to the newcomer, in order, before
either side sees live traffic — the newcomer cannot have buffered anything itself, since pairing
happens synchronously inside its own connection handler, before its own `'message'` listener can
ever fire.

### Identity checks on every teardown path

A WebSocket `'close'` event can fire well after the logical teardown that caused it (up to `ws`'s
own close timeout). By the time it fires, the slot table entry it thinks it owns may already
belong to a brand-new pair on the same slot id. Every teardown path (`handleClose`,
`enforceGuardTeardown`) checks that the table's current entry is still the *same object identity*
as the one this connection was part of before deleting it or counting a metric — never "does this
slot currently hold something," always "does it still hold *my* pair." This is what stops a stale
close from black-holing a fresh pair or double-counting a teardown.

## Guards (`src/guards/`)

| Guard | File | What it bounds |
|---|---|---|
| Slot format | `slotFormat.ts` | Length capped at 256 chars *before* the regex runs (a cheap ReDoS/length guard), then matched against `SLOT_ID_PATTERN`. Never case-folds — the slot is an exact-match routing key. |
| Rate limits | `rateLimit.ts` | Lazy-refill token bucket, keyed by IP bucket or slot id. Refills continuously by elapsed time, not a timer tick. Swept every 5 minutes so idle keys don't leak memory. |
| Connection caps | `caps.ts` | `ConnectionCaps` (global + per-IP, reserved/released around the connection's lifetime) and `SlotConnectionCaps` (per-slot, since a slot is exactly two peers by definition). |

## The forwarding hot path (`src/connection.ts`)

A received message either forwards immediately (paired) or buffers (waiting) — no other state is
possible. Forwarding does no parsing, no string conversion, no copy, and no per-frame allocation
beyond what `ws` itself does (`wireData.ts` preallocates the two possible `send()` options objects
so the hot path never allocates a fresh literal per message). Session-byte accounting reads
`conn.pairState` (cached at pair time) instead of a slot-table lookup on every frame.

Two independent guards can tear a pair down mid-session, both enforced per-frame:

- **Backpressure**: if the partner socket's `bufferedAmount` exceeds `MAX_BUFFERED_BYTES`, the
  pair is torn down (`enforceGuardTeardown`, close code `4431`). A byte-forwarder cannot drop a
  frame without corrupting whatever end-to-end stream it's carrying, so a slow consumer gets the
  tunnel closed instead of unbounded buffering.
- **Session byte cap**: `pairState.sessionBytes` accumulates across the pair's lifetime; exceeding
  `MAX_SESSION_BYTES` tears the pair down (`4432`).

Both sides simply reconnect and re-handshake on their own encryption layer — this relay has no
opinion about what happens above it.

## Liveness (`src/keepalive.ts`)

A WS-level ping/pong loop, invisible to the client (there is no application-level heartbeat). Every
`PING_INTERVAL_MS`, any connection that missed the *previous* round's pong is terminated
(`onPongTimeout`); everyone else gets pinged and their `isAlive` flag reset to `false` until the
next pong arrives. This is what reaps a half-open socket — a dead TCP peer with no FIN still reads
`OPEN` — so parked/paired state and connection caps stay accurate. Traffic-idle is never treated as
death: a quiet-but-alive paired tunnel is normal and must never be killed by this check.

## Real client IP (`src/net/clientIp.ts`)

`resolveClientIp` always trusts the raw socket address when `TRUST_PROXY` is `false` (the
default) — a self-hoster with no reverse proxy in front cannot have caps bypassed via a forged
header. When `TRUST_PROXY` is `true`, it only consults `CF-Connecting-IP` / `X-Forwarded-For` if
the immediate socket peer's address falls inside `TRUSTED_PROXY_CIDRS`. **An empty
`TRUSTED_PROXY_CIDRS` list means every peer is trusted** — this is a real footgun the deploy docs
address explicitly (see [deployment.md](deployment.md)); the fix belongs in this file, not the
docs, and is tracked as a follow-up (make an empty list fail closed at config-load time).

IPv6 addresses are bucketed to their leading `IPV6_PREFIX_BITS` (`bucketIp`) before being used as
a rate-limit/cap key, so a single client cannot evade per-IP limits by rotating through its own
`/64`.

## The open-core seam (`src/admission.ts`)

`AdmissionPolicy` is the *only* extension point. Its input, `AdmissionContext`, is deliberately
narrow — resolved IP, slot id, headers, raw URL, connect time — with no socket, frame, or payload
access, so an entitlement gate can decide *whether* a device may use this relay without ever being
able to read what flows through it once admitted.

- `allowAllPolicy` (the default): every connection is admitted. This is what self-hosting always
  gets, since `ADMISSION_WEBHOOK_URL` is unset by default.
- `createWebhookAdmissionPolicy`: POSTs `{ip, slotId, rawUrl, connectedAt}` to
  `ADMISSION_WEBHOOK_URL` and honors the JSON `{allow, reason?}` response. On a webhook error or
  timeout, `ADMISSION_FAIL_OPEN` decides whether to admit anyway (default `true`) or deny
  (`admission_unavailable`).

Because this relay is AGPL-3.0-only, a private control plane implementing that webhook must stay
out-of-process — linking this package in-process would pull the private service under AGPL. See
the README's "Open-core and licensing" section.

## Observability (`src/http/metrics.ts`, `src/logging.ts`)

`/metrics` (Prometheus text) and `/metricz` (its JSON twin, plus `rssBytes`/`heapUsedBytes`/
`uptimeSeconds`) are gated by the same `authorizeMetricsRequest`: `METRICS_ENABLED=false` yields a
plain 404 (hidden entirely); `METRICS_TOKEN` set requires an exact `Authorization: Bearer <token>`
match. Neither surface ever carries a slot id, an IP, or frame content — only aggregate counters.

`closedByCause` in `/metricz` mixes two units, which the release's own runbook flags as the one
thing to remember when reading it: `peerClosed`, `backpressure`, `sessionByteCap`,
`sessionTimeCap` count **pair teardowns** (two sockets each); `parkedOverflow`, `heartbeat`,
`parkTimeout` count **single sockets**.

Structured JSON logs (`logging.ts`) hash slot ids by default (`LOG_SLOT_HASHING=true`,
`slotRef()`) — even though payloads are opaque to this relay, the *pairing graph* (which two
connections rendezvoused) is metadata worth protecting, and a raw slot id doubles as a bearer
secret for that rendezvous.

## Configuration and shutdown

`src/config.ts` parses every environment variable into a single frozen `Config` object, failing
fast (throwing `ConfigError`) on any malformed value rather than falling back to a silent default.
`src/index.ts` wires `SIGTERM`/`SIGINT` to `relay.close()`, which flips `health.draining` (so
`/readyz` starts returning 503 and new upgrades are refused with close code `4503`), closes every
live connection with code `1001`, and force-terminates anything still open after
`SHUTDOWN_GRACE_MS`.

## What is deliberately not here

- **No frame parsing, ever.** `src/**` has zero runtime dependency on `@kangentic/protocol` (the
  end-to-end crypto layer whose frames this relay carries). That package appears only as a
  `devDependency`, imported by exactly one file:
  `test/integration.protocol-handshake.test.ts`, which proves a real Noise handshake completes
  through this relay without the relay itself ever touching it.
  `test/blindness.test.ts` mechanically enforces the import restriction.
- **No horizontal scaling inside this codebase.** The slot table is in-process memory; two peers
  of one slot must land on the same instance. See the README's "A known limit: single instance"
  section for the slot-affinity routing path if that's ever needed.
- **No authentication, no accounts.** `v1` ships free and accountless; see
  [deployment.md](deployment.md) and the README's "Open-core and licensing" section for how a
  hosted instance can gate access without touching this guarantee.
