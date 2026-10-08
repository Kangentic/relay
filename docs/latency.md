# Latency investigation, 2026-10-07

Desktop task #774 measured the hosted relay from a client on 2026-10-07: TCP connect to the
Cloudflare edge a flat ~25 ms, keep-alive `GET /healthz` p50 ~55-65 ms with rough patches of
0.9-3.2 s around 20:59 and 21:05 UTC, and WebSocket dials slower than 1 s in 1.36% (Node/undici)
and 1.73% (Chromium) of attempts, worst 6.3 s, through colo ATL. This document records what was
measured on the server side the same evening, what changed because of it, and the before/after for
each change. Every change cites the documentation it relies on.

All times are UTC. Server-side readings were taken read-only over SSH between 22:30 and 23:00 on
2026-10-07, before any change in this release was deployed.

## The answer

**The stalls were on the Cloudflare-edge-to-origin leg, not in the relay, Caddy, or the VM.**
Probing every leg at 1 Hz over the same minutes, during a rough patch:

| Leg | How | p50 | Worst |
|---|---|---|---|
| Relay alone | on the box, `http://127.0.0.1:8080/healthz` | 0.58 ms | 1.0 ms |
| Caddy + relay | on the box, `https://<host>/healthz` via `--resolve` to 127.0.0.1 | 1.3 ms | 7.4 ms |
| Client to edge | from the desktop, `/cdn-cgi/trace` (answered by the edge itself) | 25-27 ms | 98 ms |
| Client to origin | from the desktop, `/healthz`, concurrently with the line above | ~290 ms | 2.24 s |

The edge-only leg stayed flat while the full path spiked, and neither on-box leg exceeded 7.4 ms.
Over the same 172 s, Caddy's network namespace (which holds the Cloudflare-facing sockets) logged
178 retransmitted segments out of 22,222 sent (0.8%) and 25 retransmission timeouts; its lifetime
totals since 2026-07-21 were 36,644 retransmits and 8,126 timeouts. Where inside that leg the delay
sits is not resolved: `mtr` to the Cloudflare addresses that pull from the origin read 12-15 ms with
no loss at the destination during the same half hour, and TCP smoothed RTT on those sockets
(195-1,138 ms) is inflated by delayed acknowledgements on sparse WebSocket traffic, so it is not a
path measurement. The box's own traffic to the zone's anycast address landed at colo EWR with 24%
ping loss, but that is not the path Cloudflare pulls over either.

What this rules out, with the evidence:

- **The relay process.** The one-minute history rows for 20:45-21:15 read CPU 0.5-0.7%, RSS flat
  near 90 MB, no restart, and event loop p99 21.3 ms in every row. That 21.3 ms is the 20 ms
  sampling resolution, not load, and the 7-day maximum was 21.4 ms: **p99 could not have shown a
  three-second freeze**, which is item 1 below.
- **Memory and swap.** `docker inspect`: RestartCount 0, OOMKilled false. cgroup `memory.events`
  oom 0, and the relay cgroup's `memory.pressure` total was 0 since 2026-09-19: not one
  microsecond of memory stall. 3.9 MB was in swap, cold.
- **The VM, during this patch.** The on-box legs ran through the patch without a stall. The
  kernel log does show two hypervisor-level pauses earlier, a 1.14 s "Long readout interval" on
  2026-09-07 and a 472 ms TSC skew on 2026-09-28, so the VM does pause occasionally, just not here.
- **Caddy's keep-alive to the relay.** Caddy's error log since 2026-07-21 held 23 502s, every one
  in a deploy window ("connection refused", or Docker DNS "server misbehaving" while the relay
  container was being recreated), and no "connection reset by peer". None on 2026-10-07.

## Changes, with citations and before/after

Production "after" figures need a release. They are marked pending and are taken by re-running
the same commands after the tag deploys.

### 1. History can see a multi-second stall

Each one-minute row now records `eventLoopLagMaxMs` (the histogram's maximum: "The maximum recorded
event loop delay",
[Node perf_hooks](https://nodejs.org/docs/latest-v22.x/api/perf_hooks.html)), `gcPauseMaxMs` (the
longest `gc` entry from a `PerformanceObserver`), host steal and total CPU ticks from `/proc/stat`,
and the PSI "some" stall time for CPU, memory and IO from `/proc/pressure/*` ("the share of time in
which at least some tasks are stalled",
[kernel PSI docs](https://www.kernel.org/doc/html/latest/accounting/psi.html)). PSI was confirmed
readable from inside the relay container.

| | Before | After |
|---|---|---|
| A 250 ms freeze among ~125 ordinary samples (test) | p99 under 100 ms, nothing else recorded | `eventLoopLagMaxMs` >= 150 ms in that row, p99 still under 100 ms |
| Production row for a stall minute | p99 21.3 ms whatever happened | pending: max, GC, PSI per minute |

**Steal reads 0 on this host by construction.** `/proc/stat` steal was 0 across 78 days of uptime,
sar `%steal` 0.00, and dmesg has no `kvm-stealtime` line: Hetzner's hypervisor does not report it.
The field stays (it is meaningful elsewhere), but a VM pause here shows only as a high loop max with
low CPU, no GC pause and no PSI.

### 2. Localizing the next patch

- **Caddy access log** ("Enables and configures HTTP request logging",
  [Caddy log directive](https://caddyserver.com/docs/caddyfile/directives/log)), filtered to drop
  the `slot` query parameter, every request header and the client IP, with `cf_ray` and
  `upstream_latency_ms` (time to the relay's response, the 101 for a WebSocket) appended via
  `log_append`. On the `caddy_data` volume, rolled at 25 MiB, about two weeks.
- **Caddy's error log is filtered the same way.** It had recorded the raw slot id of every request
  that failed with a 502.
- **`CONNECTION_TRACE`** in the relay: one line per connection with CF-Ray, upgrade, admission, 101,
  pairing, and the first 8 frames' arrival, size and queue-ahead. On in production via `deploy.yml`.
- **`scripts/legProbe.sh`** runs the four legs above at 1 Hz with UTC timestamps that line up, plus
  TCP counter deltas from Caddy's namespace. Waits of 1 s and 1+2 s are what RTO backoff on a fresh
  origin connection looks like ([RFC 6298](https://www.rfc-editor.org/rfc/rfc6298)), and Cloudflare
  does not prewarm origin connections: "Connections are created on demand"
  ([Cloudflare](https://developers.cloudflare.com/speed/optimization/protocol/http2-to-origin/)).

Verified on a live Caddy 2.8.4 with this exact config: the access line for
`/?slot=<64 hex>&role=desktop` reads `"uri":"/?role=desktop"`, carries `cf_ray` and
`"upstream_latency_ms":2.25`, and has no request headers and no `client_ip`. The 502 line for a
dial with the relay stopped reads `"uri":"/?role=mobile"` with no headers, written once. The relay's
trace line for the same dial: `socketAgeAtUpgradeMs` 0.47, admitted after 0.44 ms, 101 after
1.18 ms, CF-Ray recorded, no slot or IP.

### 3. Swap and shared vCPU

- **Swap.** `docker-compose.prod.yml` set `mem_limit` without `memswap_limit`, and Docker then lets
  "the container can use as much swap as the `--memory` setting"
  ([Docker](https://docs.docker.com/engine/containers/resource_constraints/)); confirmed on the box,
  `HostConfig.MemorySwap` was 2x the memory limit. Swap was not the cause (zero memory stall), but
  a paged-out heap that a garbage collector touches is a stall measured in disk reads, so
  `memswap_limit` is now equal to `mem_limit`, which "prevents containers from using any swap".
  Before: `memory.swap.current` 3.9 MB. After: pending, expected 0.
- **Shared vCPU.** "the compute resources are distributed among all instances on the same physical
  server" ([Hetzner](https://docs.hetzner.com/cloud/servers/faq)). No change: steal is not reported
  here, and the measured patch was not on the VM. Revisit only if a loop-max spike with low CPU, no
  GC and no PSI lines up with a client stall.

### 4. Keep-alive mismatches

- **Caddy to relay.** Caddy kept idle upstream connections 2 minutes while Node closes them after
  5 s (`keepAliveTimeout` "Default: `5000`",
  [Node http](https://nodejs.org/docs/latest-v22.x/api/http.html)). Caddy's docs warn about exactly
  this: "connection reset by peer" errors, and "Caddy will respond with status code 502 in other
  cases" ([reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)). Now
  `keepalive 4s`. Before and after, honestly: production logged 0 such errors in 2.5 months, and a
  lab run of 60 POSTs (which Go does not retry) at idle gaps of 4.95-5.05 s returned 60 x 200 with
  either setting. Go's transport sees the relay's FIN on a local bridge within microseconds, so the
  race window is tiny. The change removes it by construction rather than fixing a measured fault.
- **Cloudflare to Caddy.** Cloudflare reuses an idle origin connection for up to 900 s ("Proxy Idle
  Timeout | 900 | 520",
  [Cloudflare connection limits](https://developers.cloudflare.com/fundamentals/reference/connection-limits/)),
  and Caddy's `idle` defaulted to 5m, so Caddy closed connections Cloudflare still meant to reuse,
  and the next request paid a fresh TCP and TLS handshake over the lossy leg. Now `idle 16m`, so
  Cloudflare always closes first. After: pending, `TcpPassiveOpens` per hour in Caddy's namespace.
- **Relay restarts.** `lb_try_duration 5s`: retries are off by default ("By default, retries are
  disabled"). Every one of the 23 logged 502s was a deploy window. Lab: a dial that arrived while the
  relay was restarting got its 101 after 3.2 s instead of an immediate 502.

### 5. The Origin cert reload, and a stale Caddyfile

`deploy.sh` and the rotation runbook ran `caddy reload` without `--force`. "`--force` will cause a
reload to happen even if the specified config is the same", "for example: reloading
manually-loaded TLS certificates" ([Caddy CLI](https://caddyserver.com/docs/command-line)). Lab, with
two self-signed certs: after swapping the files, a plain reload kept serving serial `2F95FE91...`
and a forced reload served `397BD563...`. Production before: served and on-disk serials both
`60EE8516...` (no rotation had happened yet, so nothing had been lost). The reload now runs only when
a fingerprint of the cert, key, Caddyfile and range list changed, because "WebSocket connections
are forcibly closed ... when the config is reloaded"
([reverse_proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy)), softened by
`stream_close_delay 5m`, and it now also runs on a deploy that skips the relay restart, which is
exactly where a rotation lands.

**Found while checking: Caddy had been reading a stale Caddyfile since 2026-07-22.** The config was
bind-mounted as a single file, which pins the inode it was created with, and `git checkout` gave
the file a new inode. Inside the container: the 07-21 inode and sha256; outside: the 07-22 ones.
The drift was comment-only, but no config or Cloudflare-range change since then could have loaded,
including this release's. The mounts are now directories, and a lab check (replace the file by
rename, reload) put the new config live.

### 6. The keepalive no longer kills a slow consumer

A ping is written behind everything already queued to the socket, up to 16 MiB, and ws defines
`bufferedAmount` as data "queued but not yet transmitted"
([ws](https://github.com/websockets/ws/blob/master/doc/ws.md)). A missed pong on a socket that made
delivery progress since the ping is now spared for another interval.

The task proposed "a falling bufferedAmount" as the signal. **Measured, that alone does not work.**
Node hands a backlog to libuv as one batched `writev`, and `bufferedAmount` only falls when all of
it completes: against a reader taking 1 MiB/s it read a flat 21.47 MiB for 5.4 s. libuv's live
write queue on the socket's handle fell from 17.5 to 11.1 MiB over the same seconds. The check reads
both; either strictly falling is proof of life, because libuv only leaves bytes queued when the
kernel send buffer is full.

`scripts/slowConsumerRepro.mjs`, Node 22.23.3 on Linux, 24 MiB at 1 MiB/s, ping every 3 s, five
runs per arm:

| Build | Outcome | Delivered |
|---|---|---|
| Before | reader reaped mid-stream in 5 of 5 | 14.1 to 16.8 of 24 MiB |
| `bufferedAmount`-only check | reaped in 5 of 5, 0 spares | 9.7 to 10.9 MiB (at a 1 s ping) |
| After | completed in 5 of 5, 3 to 5 spares each | 24 of 24 MiB |

**What it still cannot see.** Once the relay's own queue is empty, the tail sits in kernel buffers
(4 of the 5 "after" runs logged one reap after the last byte arrived). In production the queue
leading to a phone also includes Caddy's socket buffers and Cloudflare, so the relay sees progress
only while a backlog overflows all of those, and production's sampled outbound queue was 0 at every
minute for the week before (0 minutes with a backlogged connection, against 936 pong timeouts). The
production after-measure is the new `pongOverdueDrainingTotal` counter, alongside the task's query
(minutes with pong timeouts and a backlog), which read 0 before and is expected to stay 0.

The contention probe applies the same test, which closes the lever `docs/security-model.md`
described: contention could reap a live incumbent that was merely backlogged.

### 7. Measure, then decide

- **`tcp_slow_start_after_idle=0` on the Caddy service.** "time out the congestion window after an
  idle period. Default: 1" ([kernel](https://docs.kernel.org/networking/ip-sysctl.html)); confirmed
  1 in Caddy's namespace. Applied as a namespaced `sysctls` entry. `scripts/burstProbe.mjs` through
  `wss://relay.kangentic.com`, 20 runs, before: 16-byte frame p50 36.5 ms; 512 KiB after 10 s idle
  p50 103.7 ms, p90 171.4 ms, max 603.7 ms. After: pending. Keep it if the burst p50 drops.
- **bufferutil: rejected.** It "improves the performance of certain operations such as masking and
  unmasking" ([ws README](https://github.com/websockets/ws)), and the bar was a 20% gain, because
  adopting it would break the relay's one-runtime-dependency rule. Measured with
  `scripts/loadTest.mjs` (4 pairs, flood, window 8) against the relay alone, in a `node:22`
  container on Linux, bufferutil 4.0.9 reaching only the relay process (the load-test client
  unchanged), three rounds per arm:

  | Frame size | Without | With | Change |
  |---|---|---|---|
  | 64 KiB | 635, 661, 649 MB/s (mean 648) | 525, 521, 548 MB/s (mean 531) | 18% slower |
  | 1 MiB | 641, 634, 648 MB/s (mean 641) | 626, 665, 677 MB/s (mean 656) | 2% faster |

  Node 22's JavaScript unmasking is already fast enough that the native call does not pay for
  itself at these sizes.
- **Cloudflare.** ECH is on: the zone's HTTPS record carries an `ech=` parameter (public name
  `cloudflare-ech.com`) alongside `alpn=h3,h2`. Nothing to change. Do not buy Argo: "Argo is not
  compatible with WebSockets" ([Cloudflare](https://developers.cloudflare.com/network/websockets/)).
  Bot Fight Mode, which "may challenge API or mobile app traffic", needs the dashboard to confirm;
  no request in any probe was challenged.
- **Cloudflare Tunnel A/B.** The gate the task set is met: the measured problem is the origin leg.
  The tunnel is set up as an opt-in compose profile on a second hostname, with `/admin` refused in
  Caddy because that hostname has no Access application. See `infra/README.md`, "Cloudflare Tunnel
  A/B". No Cloudflare doc claims a tunnel lowers WebSocket latency, so it is measured before anything
  depends on it.

## Already right, unchanged

The forward is zero-copy (`connection.ts` sends the received buffer as-is), `setNoDelay` is on (ws
sets it), writes are corked (ws), `permessage-deflate` is off, and production runs Node 22.23.2.

## Follow-ups this data suggests

- **Parked desktops re-dial every minute.** In the week before, 87,763 of 93,517 connections ended
  in `park_timeout` (60 s): every idle desktop crosses the slow leg with a fresh dial each minute,
  which is exactly where the 1-6 s dial stalls were measured. Raising `PARK_TIMEOUT_MS` is a
  product decision tied to the desktop client, not made here.
- **Take the leg evidence to Cloudflare or Hetzner** once a week of CF-Ray-keyed traces exists.
