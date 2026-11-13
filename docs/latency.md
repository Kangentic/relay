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
| A 250 ms freeze among ~125 ordinary samples (test) | p99 stays near the timer floor, nothing else recorded | `eventLoopLagMaxMs` >= 150 ms in that row, p99 still below it |
| Production row for a stall minute | p99 21.3 ms whatever happened | at every slow dial a client reported since the release, loop max 22-23 ms, GC under 3 ms, PSI at its baseline: the relay was idle. Worst minute in 36 days: 320 ms, no GC, with an IO stall that minute (see "Results, 2026-11-12") |

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
  Before: `memory.swap.current` 3.9 MB. After: 0 on 2026-10-30 and on 2026-11-12, every
  `memory.events` counter 0, **but the limit itself did not hold.** `memory.swap.max` read 0 on 10-30
  and `max` on 11-12, on the same container. runc writes the 0 into the cgroup without telling
  systemd: systemd's record of the container's `docker-<id>.scope` carries `MemoryMax` but keeps
  `MemorySwapMax=infinity`. systemd re-applies its record on every daemon-reload or re-exec, and
  `apt-daily-upgrade` ran one of each (11-05 and 11-07). Reproduced on the box with a throwaway
  container: 0 at start, `max` after a single `systemctl daemon-reload`. `memory.max`, the OOM
  control, held throughout. The fix is a systemd drop-in that makes systemd itself hold
  `MemorySwapMax=0`: `/etc/systemd/system/docker-.scope.d/90-kangentic-relay.conf`, which applies
  to every `docker-*.scope` because systemd also searches a unit name's dash-truncated prefixes for
  drop-ins ([systemd.unit](https://www.freedesktop.org/software/systemd/man/latest/systemd.unit.html)).
  On the box, the throwaway scope with a drop-in kept 0 across two reloads, and a transient scope
  created after a prefix drop-in started at 0 and stayed there. `deploy.sh`
  (`pin_no_swap_for_containers`) writes it before its skip gate, so the next release applies it
  even if it does not recreate the relay, and `cloud-init.yaml` writes it on new boxes. It covers
  Caddy as well, deliberately: nothing on this box should page.
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
  Cloudflare always closes first. After: churn did not change, and the measurement shows there was
  none for this setting to win. Caddy's namespace logged 533,088 passive opens in the 35.9 days to
  2026-11-12 against 528,324 relay connections, 1.01 per connection. The pre-release 3.8 a minute
  was over months that averaged about 4 connections a minute, also about 1 per connection. A
  WebSocket consumes the connection it upgrades, so nearly every dial is a fresh origin connection:
  Caddy's access log shows 0 TLS resumptions in 299,308 requests (10-26 to 11-12). The raw rate
  rose only because traffic did (2.4 connections a minute in August, 10.2 since the release). The
  setting still closes the reuse race for the few plain requests. The churn itself is the
  park-timeout re-dial, below in "Follow-ups this data suggests".
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
(minutes with pong timeouts and a backlog), which read 0 before and is expected to stay 0. After, over
the 36 days to 2026-11-12: 0 spared (history `pg`, and `/metricz` since the 10-27 restart), 4,439
pong timeouts, none in a history row with a backlogged connection, and the sampled outbound queue
never left 0. The spare has had nothing to do in production yet. That is expected while no phone
drains a deep backlog.

The contention probe applies the same test, which closes the lever `docs/security-model.md`
described: contention could reap a live incumbent that was merely backlogged.

### 7. Measure, then decide

- **`tcp_slow_start_after_idle=0` on the Caddy service.** "time out the congestion window after an
  idle period. Default: 1" ([kernel](https://docs.kernel.org/networking/ip-sysctl.html)); confirmed
  1 in Caddy's namespace. Applied as a namespaced `sysctls` entry. `scripts/burstProbe.mjs` through
  `wss://relay.kangentic.com`, 20 runs, before: 16-byte frame p50 36.5 ms; 512 KiB after 10 s idle
  p50 103.7 ms, p90 171.4 ms, max 603.7 ms. After, the same command in two sessions of 20 runs:

  | Session (UTC) | 16-byte frame p50 | 512 KiB burst p50 / p90 / max |
  |---|---|---|
  | Before, 2026-10-07 | 36.5 ms | 103.7 / 171.4 / 603.7 ms |
  | 2026-10-30 02:50 | 36.8 ms | 67.5 / 68.9 / 178.9 ms |
  | 2026-11-12 21:55 | 40.2 ms | 71.5 / 73.7 / 175.0 ms |

  Kept. The burst now costs about 31 ms over the small frame instead of 67, with the tail gone; the
  single slow run in each session is the first, on a fresh connection. This and BBR below shipped
  together, so the after figures are their combined effect.
- **BBR congestion control on the Caddy service: applied.** The edge-to-origin leg lost 0.8% of
  segments during a slow patch, and cubic reads every loss as congestion and shrinks its window.
  Lab: this exact Caddyfile on Caddy 2.8.4, `netem` adding 15 ms delay and 0.8% loss on Caddy's
  egress, 2 MiB bursts after 2 s idle through Caddy's internal site, 15 runs per arm,
  `tcp_slow_start_after_idle=0` in both:

  | Arm | Round 1 p50 / p90 / max | Round 2 (order reversed) p50 / p90 / max |
  |---|---|---|
  | cubic | 284 / 1,224 / 1,889 ms | 1,485 / 1,664 / 1,872 ms |
  | BBR | 155 / 198 / 208 ms | 170 / 231 / 423 ms |
  | cubic, no loss | 5.4 / 7.4 ms (10 runs) | |
  | BBR, no loss | 4.5 / 5.8 ms (10 runs) | |

  Cubic's bursts climbed past a second as losses accumulated, which is the shape of the client
  patches; BBR held, and cost nothing on a clean path. Two host conditions stood in the way on
  production, and a container can create neither: the kernel ships `tcp_bbr` as a module that was
  not loaded (available: `reno cubic`), and a namespace other than the host's may only default to an
  algorithm on `tcp_allowed_congestion_control` ("Only init netns can set default to a restricted
  algorithm", `net/ipv4/tcp_cong.c`), which was `reno cubic`. The lab passed only because Docker
  Desktop's VM already allows `bbr`; with an algorithm the kernel refuses, Docker fails the container
  with "operation not permitted", which on a Caddy recreate would have been an outage. So
  `deploy.sh` loads the module, adds `bbr` to the allowed list, persists both (`modules-load.d`,
  then `sysctl.d`), and starts a throwaway container with Caddy's exact image and sysctl before
  compose touches Caddy, stopping the deploy if that fails. A dry run of that function against fake
  `/proc` and `/etc` trees covered the production start state, an idempotent second deploy, and a
  host where the allowed-list write did not take (the preflight stopped it). `cloud-init.yaml`
  writes the same two files on new boxes. Production after-measure: the burst probe above, p90
  171.4 to 73.7 ms at worst and max 603.7 to 178.9 ms, with `bbr` live in Caddy's namespace
  throughout. Kept. Over Caddy's 35.9 days, retransmission timeouts per relay connection held
  (9,096 over 528,324, 0.017, against roughly 0.018 before), and the segment retransmit rate rose
  from 0.16% to 0.19% (44,923 of 23,546,357). That is not a clean BBR-versus-cubic comparison:
  traffic more than doubled, clients now arrive through 38 Cloudflare colos from Sydney to Dhaka,
  and BBR probes for bandwidth by design. No user-visible figure regressed.
- **`tcp_notsent_lowat`: rejected.** The hope was that keeping unsent bytes out of the kernel would
  leave a backlog visible to the keepalive's drain check. With `16384` set on the slow-consumer
  repro (Linux container), the relay's own queue did grow (23.2 MiB against 21.4 MiB), but 4 of 5
  runs still logged the reap after the last byte: the bytes the check cannot see are in flight to
  the receiver, not unsent. Caddy has nothing for it to improve either, since it proxies each
  WebSocket as one ordered stream with nothing to reprioritize.
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
  Bot Fight Mode "may challenge API or mobile app traffic". The dashboard setting was not read
  (it needs an interactive Cloudflare login), but the traffic it would catch first is not being
  challenged: a bare `curl` from the Hetzner datacenter address got `HTTP/2 200` with no
  `cf-mitigated` header, the GitHub Actions monitor (also a datacenter, also a non-browser client)
  passes on every run, and no request in any probe here was challenged. The dashboard read on
  2026-10-30: Bot Fight Mode off for the zone (AI Labyrinth off too). Nothing to change.
- **Cloudflare Tunnel A/B.** The gate the task set is met: the measured problem is the origin leg.
  The tunnel is set up as an opt-in compose profile on a second hostname, with `/admin` refused in
  Caddy because that hostname has no Access application. See `infra/README.md`, "Cloudflare Tunnel
  A/B". No Cloudflare doc claims a tunnel lowers WebSocket latency, so it is measured before anything
  depends on it. After five weeks it is recommended but not yet run: see "Results, 2026-11-12".

## Taking the after measurements

Once the release carrying these changes has deployed, on the box (`deploy@<box>`, the server's own
address; both public hostnames are proxied and refuse SSH). Each comment's number is the item above
it measures:

```
# 1. The stall fields are being written: the newest rows carry elx, gcx, sts/stt, pcs/pms/pis.
sudo tail -3 /var/lib/docker/volumes/compose_relay_history/_data/history.ndjson

# 3. No swap for the relay container: expect 0.
cat /sys/fs/cgroup/system.slice/docker-$(docker inspect -f '{{.Id}}' compose-relay-1).scope/memory.swap.current
# 3. The limit itself, once the systemd drop-in has deployed: expect 0 and MemorySwapMax=0.
cat /sys/fs/cgroup/system.slice/docker-$(docker inspect -f '{{.Id}}' compose-relay-1).scope/memory.swap.max
systemctl show docker-$(docker inspect -f '{{.Id}}' compose-relay-1).scope -p MemorySwapMax

# 4. Cloudflare reuses origin connections longer: compare against the pre-release rate.
sudo nsenter -t $(docker inspect -f '{{.State.Pid}}' compose-caddy-1) -n nstat -asz TcpPassiveOpens

# 5. The served cert matches the file (and does again after the next rotation).
echo | openssl s_client -connect 127.0.0.1:443 -servername relay.kangentic.com 2>/dev/null | openssl x509 -noout -serial
openssl x509 -in /opt/relay/secrets/origin.crt -noout -serial

# 2. No slot id and no slot-length hex string in either Caddy log: expect no output.
docker logs compose-caddy-1 2>&1 | grep -E 'slot=[0-9a-f]|[0-9a-f]{32,64}'
docker exec compose-caddy-1 grep -E 'slot=[0-9a-f]|[0-9a-f]{32,64}' /data/logs/access.log

# 4. 502s since the release, now that Caddy logs every request: expect none outside deploys.
docker exec compose-caddy-1 grep -c '"status":502' /data/logs/access.log

# 6. Slow consumers spared, from the /admin Table view's Spared slow column, or:
curl -s -H "Authorization: Bearer $METRICS_TOKEN" http://127.0.0.1:8080/metricz
```

From a workstation, over the same minutes as `scripts/legProbe.sh box relay.kangentic.com 600` on
the box: `scripts/legProbe.sh client relay.kangentic.com 600`, and for item 7
`node scripts/burstProbe.mjs --url wss://relay.kangentic.com`, compared against the burst p50 of
103.7 ms (p90 171.4, max 603.7) above. Confirm BBR is live in Caddy's namespace with
`sudo nsenter -t $(docker inspect -f '{{.State.Pid}}' compose-caddy-1) -n cat /proc/sys/net/ipv4/tcp_congestion_control`
(expect `bbr`).

The origin leg over every real dial the trace still holds, from a workstation. The trace lives only
in the container log, so export it before a release recreates the relay, and at least weekly while
watching for episodes (rotation keeps about a week):

```
ssh deploy@<box> "docker logs compose-relay-1 2>&1 | grep -F 'connection trace'" > traces.ndjson
node scripts/originLegStalls.mjs traces.ndjson
```

## Results, 2026-11-12

Taken 2026-11-12 from 20:00 UTC, plus a two-hour dial rig to 00:02 on 11-13. Production had run
this release's changes for 36 days (v0.4.1 on 10-27 only rebuilt the image on a patched Node). The
windows differ by source, because a relay recreate wipes its log and zeroes its counters:

| Source | Window |
|---|---|
| Caddy namespace counters and logs | 10-08 01:25 to 11-12, 35.9 days (Caddy's uptime) |
| History rows | 36 days; one-minute rows for the last 7 |
| Caddy access log | 10-26 to 11-12 (it rolls at 25 MiB) |
| Relay trace lines | 11-05 15:04 to 11-12, all that log rotation still held |
| Monitor runs | 176 runs, 10-08 to 11-12 |

The Caddy timestamps for the monitor's 10-15 and 10-24 runs below come from an earlier export of
the access log, made before those files rolled out.

The per-item after figures are in the items above (1, 3, 4, 6 and 7). What the five weeks add:

### The origin leg stalls in episodes

**How it is measured.** A CF-Ray's first 10 hex digits rise by about 1600 a second (a least-squares
fit of ray against the relay's `upgradeReceivedAt`), so a ray dates the moment Cloudflare's edge took
the request. Cloudflare does not document this, so it is used only as far as it was checked. The
offset between the two clocks drifts by seconds over days, so it is re-anchored every hour, and each
colo's ordinary transit (its median) is subtracted. What remains is each dial's excess time between
the edge and the relay. `scripts/originLegStalls.mjs` computes it from an exported trace. Against a
calm window, the 3,570 dials (the rig's and real users') traced during the rig's two hours below, it
read p99 0.08 s and max 0.43 s, so it does not invent stalls. The monitor's slow run on 11-09, located by a different method (two rays from one run
reaching the edge together), read 1.77 s on this leg.

**What it found.** 136,000 real dials, 11-05 15:04 to 11-12 22:02, through 48 colos:

| | Over 1 s | Over 2 s |
|---|---|---|
| All dials | 2,545 (1.87%) | 1,126 (0.83%) |
| Dials that went on to pair, the ones a person waits on | 56 of 1,260 (4.4%) | 43 (3.4%) |
| 11-05, 11-06 and 11-12, the calm days | 0.05 to 0.16% | 0.01 to 0.06% |
| 11-09, the worst day | 1,663 of 21,635 (7.7%) | 813 (3.8%) |

The worst single dial waited 48.7 s. These are episodes, not background noise. 49 bursts of 10 or
more stalls hold 1,891 of the 2,545. Each burst lasted 1 to 40 minutes and stalled 10 to 92% of the
dials inside it, hitting 6 to 17 colos at the same moments, from Boston to Brisbane. Sizes fall off
smoothly from 1 s, with no peaks at the 1, 3 and 7 s of a SYN retransmit schedule. Cloudflare's
dashboard shows the zone's 5xx rate as 0.00% over the same 7 days, so the edge held these dials
until the origin answered: they were slow, not failed.

**Where it is, and is not.** The excess spans Cloudflare's connection to the origin, Caddy's TLS, and
Caddy to the relay. Ruled out across every episode:

- **The relay.** Loop max 22 to 25 ms in nearly every episode minute and at most 109 ms, with GC
  under 14 ms, CPU under 2%, and PSI in its usual range (memory 0, IO at most 9 ms in a minute,
  where all minutes' p99 is 10). Caddy to relay (`socketAgeAtUpgradeMs`) read 0.12 to 0.40 ms on
  the largest stalls themselves.
- **The host.** No receive drops or errors on the NIC, conntrack at 43 of 65,536 entries, no
  listen-queue overflow or drop in Caddy's namespace, no network message in the kernel log, and
  Caddy never CPU-throttled.
- **A freeze of Caddy as a whole.** Established sockets kept answering: pong timeouts went from a
  baseline of 0.03 a minute to about 0.3 in the two worst bursts, against hundreds of stalled dials.
- **Certificate or storage work in Caddy.** Its runtime log over 11-06 to 11-11 holds only the daily
  storage cleanup at 01:25, nowhere near an episode. That log would not show a handshake that
  merely stalled, so this rules out Caddy's own housekeeping, not its TLS path.

That leaves the network path between Cloudflare and the box, or Caddy's TLS accept path alone, which
this data cannot tell apart. The timing favors the network. Hetzner posted
["Urgent maintenance on all core routers"](https://status.hetzner.com/incident/cd31dd45-f431-4639-8f9a-d4bfb5353f30)
from 10-15 10:00 to 11-11 11:37: "network redundancy is reduced globally. We do not expect any
service interruptions, but you may experience increased latency." The stall rate was 2.28% of
dials before that end and 0.10% (26 of 25,720) after, with no change to Caddy in between.
Cloudflare posted
["Network Performance Issues in Eastern North America"](https://www.cloudflarestatus.com/incidents/88hc76jnq2gn)
for 11-09 16:34 to 20:12, inside the worst stretch. Neither names the box's location, and 11-05 and
11-06 fell inside the Hetzner window yet were calm, so this is a correlation, not a cause.

### Desktop task #774's rig, rerun

The same rig on Electron 44.5.1 (Chromium 152, Node 24), two stacks at one dial every 30 s each,
plus its path probe, 11-12 22:02 to 00:02:

| Stack | Dials | Over 1 s | p50 / p90 / p99 |
|---|---|---|---|
| Chromium | 960 | 2 (0.21%) | 168 / 199 / 308 ms |
| Node | 958 | 0, and 1 failed (abnormal close after 10.7 s) | 157 / 187 / 258 ms |

This is **not comparable** with #774's 1.73% (Chromium) and 1.36% (Node). The origin leg was calm all
evening (0 stalls over 1 s among the 3,570 traced dials in the window). #774's hour held two rough
patches and pooled five rig configurations. Both slow Chromium dials took 19.2 s, and both were on the
client-to-edge leg instead. Chromium's netlog shows TCP to the edge in 24 to 28 ms and the
ClientHello sent. No reply came for 19.0 s, then a connection reset, and a retry on a fresh socket
finished TLS in about 30 ms. The relay saw the retry's upgrade at once. The second one, at 23:16:23,
landed in the same seconds as the Node failure, so it hit both stacks on one workstation. Its cause
is not known, and it is not a leg this repo controls. The path probe's edge connect stayed flat (p99
28.5 ms), with `/healthz` p99 84.9 ms and max 301 ms.

### Monitor

176 runs and 352 dials since the release: p50 237 ms, p90 418 ms, p99 1,372 ms, max 4,643 ms; 7 over
1 s and 3 over 2 s. The four slow runs, located by CF-Ray in Caddy's access log and the trace:

| Run (UTC) | Dials A / B | Before the edge | Edge to origin |
|---|---|---|---|
| 10-15 19:17 | 1.35 / 1.37 s | about 1.1 s | none: the two arrived 26 ms apart |
| 10-24 23:30 | 4.64 / 0.29 s | about 0.2 s | 4.35 s on one dial |
| 10-26 21:06 | 3.25 / 1.21 s | about 1.1 s | 2.02 s on one dial |
| 11-09 13:10 | 3.14 / 1.37 s | about 1.3 s | 1.77 s on one dial |

The second-plus before the edge is the GitHub runner's own path, which nothing here can reach.

### The relay's own stalls

Over the last 7 days of one-minute rows, loop max read 21.7 ms at the median and 91 ms at p99. It
read 21.9 ms in the minutes of both 19 s rig dials. The one outlier in 36 days, 320 ms at 11-08
01:08, had GC 0.5 ms and 233 ms of IO pressure against a usual 5 ms: the host's disk held the
process once. No client reported a slow dial then, and the trace's nearest stalled dial came at
01:07:31 (1.2 s on the origin leg), outside any episode.

### Decisions

- **BBR and `tcp_slow_start_after_idle=0`: kept** (item 7).
- **Cloudflare Tunnel A/B: recommended, still a separate opt-in.** The origin leg is the largest
  delay this data can attribute, and in a bad week it held 4.4% of the dials people waited on past
  a second. A tunnel removes exactly the per-dial work in that leg: requests ride `cloudflared`'s
  standing connections, with no fresh origin TCP and TLS handshake per dial and no public TLS at
  Caddy. Run it across an episode, not a calm week: since 11-11 11:37 the leg stalled on 0.10% of
  dials, so a quiet run would show nothing either way (`infra/README.md`, "Cloudflare Tunnel A/B").
- **Escalation: evidence assembled, not sent.** The episodes line up with incidents both providers
  posted, and both have ended. The evidence (episode times, rays, the rig's netlogs) is kept on the
  task board, not in this public repo. See the follow-up below for when to send it.
- **`CONNECTION_TRACE`: kept on.** It is the instrument for both of the above. Its lines live only in
  the container log: a relay recreate wipes them, and the 20 MB x 5 rotation drops them after about a
  week at November 2026 traffic. Export before either (see "Taking the after measurements").
- **Bot Fight Mode: off, nothing to change** (item 7).

## Already right, unchanged

The forward is zero-copy (`connection.ts` sends the received buffer as-is), `setNoDelay` is on (ws
sets it), writes are corked (ws), `permessage-deflate` is off, and production runs Node 22.23.2.

## Also changed

- **Caddy is pinned to `caddy:2.8.4`**, the version production ran under the floating `caddy:2.8`
  tag and the one every config here was validated against, so a Caddy recreate is never also an
  unannounced upgrade.
- **The monitor's synthetic pair now times the path.** Every run prints both dial times and the
  round trip into the job summary, and a dial over 2 s raises a warning annotation. It does not
  fail the run: dials over a second happen on about 1.4% of attempts on a normal day, so a failure
  per slow dial would file issues on noise; the 10 s hard timeout is still the failure. First run
  against production: dials 319 and 315 ms, round trip 85 ms.

## Follow-ups this data suggests

- **Parked desktops re-dial every minute: filed in both client repos.** In the 36 days to
  2026-11-12, 96.8% of 528,324 connections ended in `park_timeout` (60 s), and 98.8% in the last 7
  days (12.9 a minute, with 8 to 14 desktops waiting). Every one is a fresh origin connection across
  the leg measured above. Checked against the client code, two earlier premises were stale:
  - The phone does not depend on 4408 to report a failed pairing. `pairingMachine.ts` arms its own
    20 s timeout and clears it only at the SAS step, and its session transport maps 4408 to a 5 s
    retry. Verify-only, filed in kangentic-mobile: "Verify pairing and the session transport with a
    10-minute relay park timeout".
  - The desktop re-dials a parked socket about every 125 s anyway. Its 120 s rekey tick probes the
    socket, and a `parked-stale` redial follows when nothing answers, which with no phone present is
    always. A longer park alone would halve idle dials, not cut them tenfold. The fix judges a parked
    socket by the relay's own 30 s pings instead, filed in kangentic: "Mobile bridge: keep a parked
    relay socket for the relay's whole park timeout".
  - The relay step waits until that desktop change has shipped and been adopted:
    `PARK_TIMEOUT_MS=600000` in `deploy.yml`'s env heredoc, plus a row in `infra/README.md`'s
    "Production `.env`" table. The documented default stays 60000.
- **Escalate if the episodes come back.** The 11-07 to 11-11 episodes coincide with incidents Hetzner
  and Cloudflare posted, and both are over. If `scripts/originLegStalls.mjs` shows bursts again with
  nothing posted, take the evidence to Hetzner. Add `mtr` from the box to Cloudflare's addresses run
  during a burst, which a trace export alone cannot provide.
