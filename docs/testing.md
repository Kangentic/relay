# Testing

Two tiers, no UI or E2E tests. This is a headless server, not an app.

- **Unit** (`npm test`, `test/*.test.ts`): fast, and spins up a real relay on an ephemeral port
  where useful. One file per `src/` module.
- **Integration** (`npm run test:integration`, `test/integration.protocol-handshake.test.ts`): the
  one place `@kangentic/protocol` is imported, proving end-to-end blind forwarding with real
  crypto.

`npm run test:all` runs both. CI runs the unit tier on Node 20 and 22, and the integration tier on
Node 22.

## Node 22 is required, and the reason is load-bearing

`.node-version` and `.nvmrc` pin Node 22 and `engines` enforces `>=20 <23`. On **Node 24 the
Vitest worker dies on roughly 1 run in 10.** No test fails: a worker process is killed, the test
file it was running never reports, and the summary reads something like
`Test Files 22 passed (23)` with a red run. Re-running usually goes green, which is exactly the
habit that hides a real failure later.

`.npmrc` sets `engine-strict=true`, so `npm install` **fails** rather than warns on an
out-of-range Node. That makes the bound real, but it only fires at install time. Use a version
manager that reads `.node-version` (for example [fnm](https://github.com/Schniz/fnm)) so the
right runtime is selected automatically rather than caught after the fact.

### What was measured

| Configuration | Runs | Worker deaths | Rate |
|---|---|---|---|
| Node 24.15.0, default forks pool | 30 | 2 | 6.7% |
| Node 24.15.0, forks, instrumented | 18 | 3 | 17% |
| **Node 24.15.0 combined** | **48** | **5** | **~10%** |
| **Node 22.23.2, identical repo and `node_modules`** | **40** | **0** | **0%** |
| Node 24.15.0, `--pool=threads` | 6 | 2 | 33% |

Only the `node` binary differed between the Node 24 and Node 22 rows: same checkout, same
installed `node_modules`, same run count. At the observed rate of 5 crashes in 48 runs, zero
crashes in 40 runs has probability `(1 - 5/48)^40`, about 1.2%.

### The crash signature

- Worker exit code **`3221226505` (`0xC0000409`)**, identical on every crash, no signal.
- **No child stderr at all** - no assertion message, no stack, no `RangeError`.
- Victims observed: `admin.test.ts`, `upgradeGuards.test.ts`, `landing.test.ts`, which are the
  three files that create the most relays and WebSocket connections.

Two things this rules out, so they do not get re-investigated:

- **It is not the history recorder or the `monitorEventLoopDelay` handle.** Two of the three
  victim files never construct a recorder.
- **It is not an unhandled socket `'error'`.** That is a JS exception: it prints a stack and exits
  1. This is a native fail-fast with no output.

`0xC0000409` is `STATUS_STACK_BUFFER_OVERRUN`, which Windows raises for the whole `__fastfail`
family - CRT `abort()`, a `/GS` cookie failure, and V8's stack-overflow guard all land there - so
the code alone does **not** identify the mechanism, and no claim is made about which it is. The
only native binaries in the tree are `@rollup/rollup-win32-x64-*.node`, which Vite calls into for
import analysis inside each worker; that is a plausible but unconfirmed candidate.

### Switching pools is not a workaround

`--pool=threads` is worse, not better: it crashed 2 runs in 6, and because threads share one
process the same fail-fast takes the entire Vitest process down rather than a single worker.
`--no-file-parallelism` does avoid it, but serialised runs are much slower and disabling
parallelism hides the problem rather than fixing it.

## Reproducing it: `scripts/flakeHunt.mjs`

```
npm run test:flake -- --runs 30
```

Runs the unit suite N times and reports only the crash rate and which file failed to report.
Useful flags:

| Flag | Purpose |
|---|---|
| `--runs N` | how many times to run the suite (default 30) |
| `--node <path>` | run Vitest under a different Node binary, holding the repo fixed. This is the flag that isolated the Node major |
| `--keep-going` | measure a full rate instead of stopping at the first crash |
| `--patch-tinypool` | temporarily rewrite tinypool's `onUnexpectedExit` so the worker exit code reaches the error message, then revert. Tinypool declares that handler with no parameters, so by default the one number saying *how* the worker died is discarded. The revert runs when the hunt ends normally; a hard kill can leave `node_modules` patched, and `npm install --no-engine-strict` restores it. The override is required because you would be hunting on Node 24, where `engine-strict` makes a plain `npm install` fail |
| `-- <args>` | everything after a bare `--` is forwarded to Vitest, e.g. `-- --pool=threads` |

Naming the guilty file works because the default forks pool with isolation runs **each test file
in its own child process** (measured: 23 files, 23 distinct pids). The file that never reported is
the file that crashed, not a bystander. The script recovers it by diffing the files that printed a
result against every file it has seen report during the session, because a crashed run's
`--reporter=json` output can be missing or truncated exactly when you need it.

## Measuring the roam stall: `scripts/roamRepro.mjs`

```
npm run build
npm run test:roam
```

Neither test tier can answer "how long is a roaming phone actually stuck", because that number is
the sum of a relay timeout and two client backoffs. This harness measures it end to end. It spawns
two real relay instances that differ only in `CONTENTION_PROBE_TIMEOUT_MS`, establishes a pair,
roams the phone, then drives both peers on the retry cadences their real clients use (the desktop's
500ms, the phone's 5000ms after a 4409).

The roam is `ws`'s `pause()`: the client stops reading its socket, so it never answers a ping,
while the TCP connection stays ESTABLISHED and no FIN is sent. That is exactly what the relay can
observe of a real roam, since a half-open socket still reads `OPEN`, so it drives the production
code path rather than a mock. It does not blackhole packets in the kernel; for that, run the relay
under `docker compose` and `docker network disconnect` the client's container.

Measured on Node 24.15.0 at stock defaults (`PING_INTERVAL_MS=30000`), three runs per arm, with
identical results across all three. Node 24 here, not the repo's pinned 22: `roamRepro.mjs` is a
plain Node script driving spawned relay processes rather than a Vitest worker, so the crash mode
that motivates the pin does not apply.



| Arm | Re-pair time | Phone dials | `slot_busy` | `probe_evicted` | `heartbeat` |
|---|---|---|---|---|---|
| Probe off (the old behaviour) | 60.5s | 13 | 12 | 0 | 1 |
| Probe on (2000ms) | 5.0s | 2 | 1 | 1 | 1 |

Three things that table is worth reading for. The clustered `slot_busy` count in the off arm is
this bug's fingerprint, and it is what to look for on a live instance. `heartbeat` is 1 in both
arms, which is the check that the probe moves *when* that teardown cause increments without
inflating it. And the residual 5.0s is almost entirely the phone's own backoff: re-running the on
arm with `--phone-backoff 500` gives 2.5s, which is the relay's actual floor of a 2s probe window
plus a reconnect.

| Flag | Purpose |
|---|---|
| `--ping-interval N` | `PING_INTERVAL_MS` for both arms (default 30000). Lower it to run a fast scaled-down version that shows the same ratio |
| `--probe N` | `CONTENTION_PROBE_TIMEOUT_MS` for the "on" arm (default 2000) |
| `--phone-backoff N` | the phone's delay after a 4409 (default 5000, the real client's value). Lower it to separate the relay's contribution from the client constant |
| `--repeats N` | measurements per arm (default 1) |
| `--timeout-ms N` | give up on a single measurement (default 150000) |

### Cross-checking the simulation against a real blackhole

The `pause()` trick is a simulation, so it was checked once against a genuine one. Build the image
(`docker build -t relay:roamtest .`), put the relay and a client container on a user-defined
network, pair them, then `docker network disconnect -f <network> <client>`. That removes the
client's interface outright: its socket stays ESTABLISHED, no FIN is generated, and nothing it
sends can arrive, which is what a phone walking off wifi does to a TCP connection.

| Arm | `pause()` harness | docker blackhole |
|---|---|---|
| Probe off | 60.5s, 12 `slot_busy` | 60.3s, 12 `slot_busy` |
| Probe on | 5.0s, 1 `probe_evicted` | 5.1s, 1 `probe_evicted` |

The two agree, and in both the surviving peer is closed with `4000` and reconnects once. So the
cheap harness above can be trusted for day-to-day work, and the docker setup is only worth
rebuilding if the transport layer itself changes.

## Measuring the keepalive with a slow consumer: `scripts/slowConsumerRepro.mjs`

```
npm run build
docker run --rm -v "$PWD:/app" -w /app node:22 node scripts/slowConsumerRepro.mjs
```

Does the keepalive reap a peer that is alive but reading slowly behind a deep backlog? A reader
takes a fixed byte budget off its socket every 100 ms (`pause()` and `resume()`), so TCP flow
control pushes the backlog back into the relay's queue the way a slow radio would, while the sender
pushes 24 MiB. `--relay-entry` runs an older build for an A/B, and `--diagnose` turns on the relay's
own history recorder at 1 s and prints the queue depth the drain check reads, each second.

**Run it on Linux.** Windows auto-tunes loopback socket buffers to tens of MiB, so the backlog leaves
the relay's queue for the kernel almost at once and the result says nothing about production. And
keep `--ping-interval` at 3 s or more: Linux frees send buffer space in bursts about a second
apart, so a 1 s interval can fall between two bursts and see no progress at all.

Measured on Node 22.23.3 in a `node:22` container, 24 MiB at 1 MiB/s, `PING_INTERVAL_MS=3000`,
five runs per arm:

| Build | Reader | Delivered | `pongOverdueDraining` |
|---|---|---|---|
| Before (c699189) | killed with 1006 in 5 of 5, 11.2 to 13.4 s in | 14.1 to 16.8 of 24 MiB | n/a |
| After | completed in 5 of 5, 19.2 to 19.3 s | 24 of 24 MiB | 3 to 5 per run |

Two things worth knowing before trusting either number. A first fix that read `bufferedAmount`
alone spared nothing at all (0 in 5 of 5): `--diagnose` showed the queue reading a flat 21.4 MiB
while the reader drained, because Node hands a backlog to libuv as one batched write and
`bufferedAmount` only falls when all of it completes. And 4 of the 5 "after" runs still log one reap
after the last byte arrived: by then the relay's own queue is empty and the tail sits in kernel
buffers, where nothing in Node can see it drain. That is the documented blind spot of the check.

## Leg and burst probes: `scripts/legProbe.sh`, `scripts/burstProbe.mjs`

Both measure the deployed path rather than the code, and both are described with their results in
[latency.md](latency.md).

- `legProbe.sh client <host> [seconds]` times, at 1 Hz, the Cloudflare edge alone
  (`/cdn-cgi/trace`) against the full path (`/healthz`), each over one reused connection.
  `legProbe.sh box <host> [seconds]`, run on the relay host, times Caddy-plus-relay and the relay
  alone, and every 10 s prints the TCP retransmit and timeout deltas from Caddy's network
  namespace. Run both over the same minutes and line them up by timestamp.
- `burstProbe.mjs --url <ws url>` pairs two clients on this machine and times a 512 KiB burst after
  10 s idle, against a 16-byte frame after the same idle. It is the before/after for
  `tcp_slow_start_after_idle=0` on the Caddy service. Against the hosted relay it is one short
  pairing on a random slot, the same footprint as the monitor's synthetic pair.

## Known test hygiene issues

Found during the crash investigation and **not** its cause. Worth fixing on their own merits:

1. **`test/helpers/wsClient.ts` leaves sockets without an `'error'` listener.** `connectTestClient`
   attaches `socket.once('error', reject)` for the open handshake only, and `once` leaves the
   emitter bare after it fires. An unhandled `'error'` on a Node `EventEmitter` throws. The same
   pattern appears at `test/upgradeGuards.test.ts:59` and `:81` and `test/rendezvous.test.ts:96-101`,
   which are the sites that deliberately provoke abnormal teardown. Note `scripts/loadTest.mjs`
   already guards exactly this ("a listener must exist or Node treats the `'error'` event as
   fatal"); the test helper never got the same treatment. Related: `TestClient.close()` is
   fire-and-forget and no call site awaits it, and `nextClose()` attaches its listener lazily where
   `nextMessage()` deliberately queues, so a close that fires first never settles that promise.
2. **`test/history.recorder.test.ts` can hang with no escape hatch.** Its `afterEach` awaits
   `recorder.stop()` *before* `vi.useRealTimers()`. `stopRecorder` races the file-operation queue
   against a 1s `setTimeout`, but under fake timers that arm can never fire, so the race has one
   live arm. Swapping the two lines removes the hazard.
3. **`test/admin.test.ts` busy-polls `fetch` with no delay**, and two of those loops use a 6000ms
   deadline against the `unit` project's default 5000ms `testTimeout`.
