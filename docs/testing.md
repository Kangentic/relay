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
