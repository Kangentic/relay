# @kangentic/relay

A tiny, stateless, blind WebSocket rendezvous relay. It forwards only opaque ciphertext frames
between two peers that both dial out to it. It authenticates nothing and reads nothing.

This is the relay for the [Kangentic](https://github.com/Kangentic/kangentic) desktop app's mobile
companion: the desktop lives behind NAT, and the phone is a foreground, reconnect-often client, so
both dial OUT to this relay rather than either one listening for inbound connections. Every session
that crosses the relay runs its own end-to-end Noise handshake (via
[`@kangentic/protocol`](https://github.com/Kangentic/kangentic/tree/main/packages/protocol)) inside
the tunnel this relay forwards, so the relay itself never needs, wants, or gets the ability to
decrypt anything.

## The blind-relay guarantee

- The relay routes purely by a `slot` query parameter on the WebSocket URL: it pairs exactly two
  connections that present the same slot id, and forwards every binary message between them
  byte-for-byte. It does not parse, wrap, or inspect a single byte of frame content.
- `src/**` has zero runtime dependency on `@kangentic/protocol` (the end-to-end crypto layer). That
  package appears only as a `devDependency`, imported by exactly one integration test that proves a
  real handshake completes correctly through this relay, never by the shipped server.
- There is no authentication, no accounts, and no signup in the open-source relay. v1 ships free and
  accountless. A future, separate, private control plane can gate access to a *hosted* instance
  (see "Open-core and licensing" below), but it attaches from outside this process and never touches
  pairing, device identity, or the capability roster.

## Honest metadata disclosure

Being blind to content is not being invisible. Anyone operating a relay instance, including
Kangentic's own hosted one, can still observe:

- Source and destination IP addresses of both peers.
- Connection timing: when each peer connects, disconnects, and reconnects.
- Frame sizes and frequency (traffic shape, not content).
- The pairing graph: which slot ids co-occur, i.e. which two connections were rendezvoused together.

This is inherent to operating any relay and is not specific to this implementation. Self-hosting
removes Kangentic (or anyone else) from that observation entirely. This relay's structured logs hash
slot ids by default (`LOG_SLOT_HASHING=true`) specifically because the pairing graph is sensitive,
even though the payloads that cross it never are.

## Quickstart: self-hosting

```
git clone https://github.com/Kangentic/relay.git
cd relay
cp .env.example .env
docker compose up -d
curl http://127.0.0.1:8080/healthz
```

Then point the Kangentic desktop app's `mobileBridge.relayUrl` setting at your instance
(`wss://your-host` once you have TLS in front, `ws://127.0.0.1:8080` for local development against a
relay running directly on the host).

### Deploying for real: Hetzner + Cloudflare

Kangentic's own hosted instance runs on a Hetzner CX23 (about EUR 5.49/mo, 20 TB of transfer
included) behind Cloudflare's free proxy, because the relay's entire job is byte-forwarding and
bandwidth pricing is what actually determines its cost under abuse.

1. Provision a Hetzner CX23 (or equivalent), Ubuntu 22.04+.
2. Install Docker and the Docker Compose plugin.
3. Clone this repo, copy `.env.example` to `.env`, and set `TRUST_PROXY=true`.
4. `docker compose up -d`.
5. Point a DNS `A` record (e.g. `relay.example.com`) at the server's IP.
6. In Cloudflare, enable the proxy (the orange cloud) for that record. WebSockets are proxied by
   default on Cloudflare's free plan; no extra configuration is needed. Cloudflare also absorbs
   volumetric DDoS for free at this layer.
7. Verify: `curl https://relay.example.com/healthz`, then run a real pairing from the desktop app
   and phone.

If you are not putting Cloudflare in front, see `Caddyfile.example` and the commented `caddy` service
in `docker-compose.yml` for a local-TLS alternative (automatic Let's Encrypt certificates).

### A known limit: single instance

The slot rendezvous table lives in this process's memory. The two peers of a slot must land on the
same instance, so do not run multiple replicas of this relay behind a naive load balancer without
also solving slot-affinity routing. A single box is the intended v1 topology.

## Configuration

All configuration is environment variables, documented fully in `.env.example`. Highlights:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `8080` | Port for both the HTTP health/metrics routes and the WebSocket upgrade. |
| `SLOT_ID_PATTERN` | `^[0-9a-f]{64}$` | Format the relay requires of a slot id before it will even try to rendezvous it. |
| `MAX_CONNECTIONS` / `MAX_CONNECTIONS_PER_IP` / `MAX_CONNECTIONS_PER_SLOT` | `10000` / `20` / `2` | Connection caps: global, per resolved IP, and per slot. |
| `RATE_LIMIT_IP_PER_MIN` / `RATE_LIMIT_SLOT_PER_MIN` | `120` / `60` | New-connection rate limits, per IP and per pairing. |
| `MAX_MESSAGE_BYTES` | `1114112` | Per-WebSocket-message size ceiling, enforced at the `ws` layer (must exceed the inner protocol's 1 MiB plaintext cap plus Noise/AEAD overhead). |
| `MAX_SESSION_BYTES` | `1073741824` | Total bytes forwarded across a paired tunnel before it is torn down. |
| `MAX_BUFFERED_BYTES` | `4194304` | Per-connection outbound buffer cap: when a slow consumer's socket backlog exceeds this, the tunnel is torn down with close code `4431` and both clients reconnect. Bounds worst-case per-connection memory. |
| `PING_INTERVAL_MS` | `30000` | WS-level ping/pong cadence used to reap half-open sockets. Invisible to the client; there is no application-level heartbeat. |
| `TRUST_PROXY` | `false` | Trust `CF-Connecting-IP` / `X-Forwarded-For` for the real client IP. Only enable this behind a proxy you control. |
| `METRICS_ENABLED` / `METRICS_TOKEN` | `true` / unset | Prometheus-format `/metrics` and its JSON twin `/metricz`, optionally behind a bearer token. |
| `ADMISSION_WEBHOOK_URL` | unset | The open-core seam. See below. |

See `.env.example` for the complete list.

## Performance and vertical scaling

The relay is a single Node process moving opaque buffers between sockets, and it is deliberately
kept that way:

- **permessage-deflate is explicitly disabled.** Every frame is ciphertext, which does not
  compress; the extension would cost CPU per frame, add latency, and hold a zlib context's worth
  of memory per connection for zero savings.
- **The frame path does no parsing.** A received message is counted and written to the partner
  socket as the same buffer; there is no JSON, no string conversion, no copy, and no per-frame
  allocation beyond what `ws` itself does. Session-byte accounting reads pair state cached on the
  connection rather than a per-frame table lookup.
- **TCP_NODELAY is on** (the `ws` default; it calls `setNoDelay()` on every socket), and nothing
  batches or delays forwarding, so small interactive frames leave the box immediately.
- **Slow consumers cannot balloon memory.** A paired tunnel is torn down (close code `4431`) when
  one side's outbound socket backlog exceeds `MAX_BUFFERED_BYTES` (4 MiB default), and a parked
  peer may buffer at most `MAX_PARKED_BUFFER_BYTES` (1 MiB default), so worst-case memory per
  connection is bounded at roughly the two caps plus one max-size message.
- **Dead phones are reaped.** The WS ping/pong keepalive terminates a socket that misses a pong
  for a full `PING_INTERVAL_MS` round (30 s default), so devices that vanish without a FIN (doze,
  network switch) release their file descriptor and slot within about a minute.

Measured on a development machine (relay and test clients sharing one Windows box over loopback,
Node 22, `scripts/loadTest.mjs`; client-side scheduling is included in the numbers, so treat them
as conservative):

| Scenario | Pairs | Frame size | Offered rate | p50 / p95 / p99 latency | Aggregate throughput | Relay RSS |
|---|---|---|---|---|---|---|
| Paced, interactive | 50 | 512 B | 20 frames/s per pair | 0.79 / 1.60 / 1.98 ms | 1,000 frames/s | ~80 MB |
| Paced, interactive | 500 | 512 B | 10 frames/s per pair | 1.33 / 2.83 / 28.8 ms | 5,000 frames/s | ~93 MB |
| Flood, small frames | 500 | 512 B | max (64-frame window) | queueing-bound | 25 MB/s, ~51,600 frames/s | ~140 MB |
| Flood, large frames | 1 | 64 KiB | max (32-frame window) | 3.2 / 13.1 / 18.7 ms | 283 MB/s single tunnel | ~134 MB |
| Flood, large frames | 50 | 64 KiB | max (8-frame window) | 33.8 / 60.7 / 70.1 ms | 393 MB/s (~3.1 Gbit/s) | ~122 MB |
| Connection count | 2,500 | 512 B | 1 frame/s per pair | 1.7 ms p50 | 5,000 concurrent sockets | ~8 KB per socket |

Two practical readings of that table for a small VPS (the Hetzner CX23 class):

- Interactive traffic is nowhere near any limit: thousands of concurrent phone/desktop pairs
  exchanging chat-sized frames cost single-digit milliseconds of relay-added latency and tens of
  megabytes of RSS. The box's real ceilings are bandwidth and file descriptors, not this process.
- Make sure the file-descriptor limit comfortably exceeds `MAX_CONNECTIONS`
  (`LimitNOFILE`/`ulimit -n` on bare hosts; `ulimits` in docker-compose if your Docker daemon's
  default is low). The relay's own `MAX_CONNECTIONS` cap rejects upgrades cleanly at 503 before
  the process ever hits fd exhaustion, which is the failure mode you want.

**The horizontal path, when one box is no longer enough:** the slot table is in-process memory,
so peers of one slot must land on the same process. Run multiple relay processes (or hosts)
behind a TCP load balancer with slot-affinity routing (hash the `slot` query parameter, e.g.
HAProxy `balance uri` on the query string or any consistent-hash LB), or partition slots across
instances at the DNS/config layer. `SO_REUSEPORT`-style kernel spreading does NOT work here
because it is connection-random, not slot-aware. Nothing else in the process is shared state, so
horizontal scaling needs no code changes, only slot-sticky routing in front.

## Observability

- `/healthz` is liveness, `/readyz` flips to 503 while draining for shutdown.
- `/metrics` is Prometheus text; `/metricz` is the same counters as JSON plus process RSS and
  uptime, including connections closed by cause (peer-closed, backpressure, heartbeat,
  park-timeout, session caps). Neither surface ever contains a slot id, an IP, or frame content.
- `scripts/loadTest.mjs` drives N concurrent pairs of M frames of S bytes against an instance and
  reports latency percentiles, throughput, and the relay RSS delta (see the header comment; run
  it only against a dedicated instance, never a live one).

## Open-core and licensing

This relay software is open source and self-hostable forever under the GNU Affero General Public
License v3.0 (AGPL-3.0-only). Kangentic also operates a hosted instance as part of a paid product;
that hosted service is what is monetized, not the software itself.

A future, separate, **private** control-plane repository (accounts, billing, quotas) can decide
*whether* a device may use Kangentic's *hosted* relay and at what plan limits, without ever
rearchitecting this relay. It attaches through `ADMISSION_WEBHOOK_URL`: if set, this relay POSTs
connection-level metadata only (resolved IP, the slot id, request headers, connection time; never a
frame or payload) to that URL and honors its allow/deny response. Because this relay is AGPL, a
private service must not link it in-process (that would pull the private service under AGPL); the
webhook seam keeps the relay artifact unmodified and fully open while the control plane stays
separate and private.

Self-hosting bypasses all of this entirely: with no `ADMISSION_WEBHOOK_URL` set (the default), every
connection is admitted, exactly as in v1. "Even our paid relay cannot read your data" stays true
because the entitlement gate only ever decides admission, never content, since content is opaque
ciphertext this relay was never able to read in the first place.

`@kangentic/protocol` (the end-to-end pairing and crypto layer this relay's frames carry, opaque to
it) is itself open source, also AGPL-3.0-only, in the main
[Kangentic/kangentic](https://github.com/Kangentic/kangentic) repository. An auditable crypto core is
a feature for a security product.

## Development

```
npm install
npm run typecheck
npm run lint
npm test              # unit tests
npm run test:integration   # real @kangentic/protocol handshake through the relay
npm run dev            # runs the relay locally with tsx, PORT=8080 by default
```

See `CONTRIBUTING.md` before opening a pull request.

## Security

See `SECURITY.md` for how to report a vulnerability.
