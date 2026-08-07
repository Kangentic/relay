# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- **`/healthz` now reports the running build's `version`**, read from `package.json` at import so
  it cannot drift from the deployed image. The body gains a key but keeps `"status":"ok"` intact
  as a contiguous substring, so the deploy health gate and any *contains*-matching uptime monitor
  keep working; a monitor comparing the whole body for equality has to be switched to a contains
  check. The field is omitted entirely, never faked, if the manifest cannot be read. The desktop
  app's "Test connection" pill picks this up with no desktop release needed.
- **First-time pairing now has relay-level proof.** The integration test covered only the KK
  reconnect handshake; it now also drives a real IKpsk0 pairing handshake through a live relay,
  including the pre-pair buffer-and-flush path that carries pairing message one.

## [0.2.1] - 2026-08-05

### Fixed

- **A tagged release could not deploy.** `release.yml` passed the git tag verbatim (`v0.2.0`) as
  the image tag to pull, but `docker/metadata-action`'s `{{version}}` publishes it without the
  leading `v` (`0.2.0`), so the box tried to pull a tag that was never pushed and the deploy died
  on `failed to resolve reference`. The bug was latent from the start of the pipeline: 0.1.0
  changed nothing build-relevant, so `deploy.sh` short-circuited on "no build-relevant changes"
  and never reached the pull. 0.2.0 bumped `package.json`, which is build-relevant, and surfaced
  it. Production was never touched - the pull fails before any container is recreated - so 0.2.0
  is a published release that never shipped, and this is the first version to deploy through the
  tag path.
- The image job now asserts the tag it hands to the deploy is one it actually published, so a
  future drift between the deploy tag and `metadata-action`'s naming fails in the build, before
  the production box is contacted.

## [0.2.0] - 2026-08-05

The relay itself is unchanged from 0.1.0 - this release carries no `src/`, `Dockerfile`, or
dependency change, so the image content is identical. It exists because how the relay reaches
production changed, which matters to anyone running this pipeline or reading the deployment docs.

### Changed

- **Merging to `main` no longer deploys.** A merge publishes an image (`latest`,
  `sha-<full sha>`) and stops; only a `vX.Y.Z` tag reaches the hosted instance. Landing a change
  and shipping it are now separate decisions, `main` can carry merged-but-unreleased work, and
  production always runs a version with a changelog entry. The board models this with a Release
  column (`/release`) after Merge. `release.yml`'s deploy job is gated on tags and now needs
  `gh-release`, which makes the changelog a hard pre-deploy gate: a version with no `CHANGELOG.md`
  section fails the release and therefore never ships. Deploys that are not releases (rollback,
  redeploy, the rollback drill) continue to run `deploy.yml` via `workflow_dispatch` with an
  explicit `image_tag`.

## [0.1.0] - 2026-08-05

First tagged release. The relay has been running from `main` builds; this promotes that work to a
versioned, immutable image (`ghcr.io/kangentic/relay:0.1.0`) with a published changelog.

### Added

- `docs/security-model.md`: what pairing and routing integrity the relay guarantees and how each
  claim is tested, why slot ids cannot be guessed (entropy, not rate limiting), what an attacker
  holding a slot id can and cannot do, the IP-trust rules, logging and metrics exposure, and the
  risks the design accepts. Written after a pre-production audit of the rendezvous path, which
  found no way for a third party without the slot id to reach, join, or observe a pairing.
- `MAX_UNPAIRED_CONNECTIONS` (default: half of `MAX_CONNECTIONS`, minimum 2): a ceiling on
  connections that have not yet found a partner, so a flood of parked sockets cannot consume the
  global cap and starve pairings that would otherwise succeed. A connection releases its place the
  moment it pairs, not when it closes. Rejections answer the same HTTP 503 as the global cap but
  count under a distinct `unpaired_cap` reject reason.
- `METRICS_ALLOW_UNAUTHENTICATED` (default `false`): opt-in to serving `/metrics` and `/metricz`
  without a token on a genuinely private deployment. See the Changed entry below for why the
  default flipped.
- GHCR publish and deploy pipeline: `.github/workflows/release.yml` builds and pushes
  `ghcr.io/kangentic/relay` on every merge to `main` (tagged `latest` and `sha-<full sha>`) and on
  `vX.Y.Z` tags (semver tags plus a GitHub release with changelog), then deploys automatically
  through a protected `production` environment. `.github/workflows/deploy.yml` resolves the target
  box by Hetzner label, runs `scripts/deploy/deploy.sh` on the box over a restricted SSH key, gates
  on a three-condition health check (container identity, image digest, health status), and rolls
  back to the previous image digest automatically on failure. `.github/workflows/monitor.yml` and
  `cloudflare-ranges.yml` add scheduled `/metricz` and synthetic-pairing checks and a weekly
  Cloudflare IP range refresh.
- `infra/`: committed, parameterized Hetzner provisioning (`hetzner/cloud-init.yaml`,
  `hetzner/provision.sh`), the production Caddy + Cloudflare Origin CA TLS setup
  (`compose/docker-compose.prod.yml`, `compose/Caddyfile.prod`), and the deploy runbook
  (`infra/README.md`), so self-hosters follow the identical path to Kangentic's own hosted instance.
- `docker-compose.dev.yml`: opt-in overlay to build the relay from source instead of pulling the
  published image.
- `scripts/deploy/synthetic-pair.mjs`: a two-peer WebSocket round-trip probe used by the monitoring
  workflow, the only check that proves pairing actually works end to end.
- `scripts/loadTest.mjs`: `--metrics-token` flag (also read from `RELAY_METRICS_TOKEN`) so the load
  test can read `/metricz` from an instance with `METRICS_TOKEN` set.
- `/metricz`: a JSON metrics endpoint mirroring `/metrics` (same enable/token gating) with
  process RSS, uptime, and connections-closed-by-cause counters. Causes count in different
  units: peer-closed, backpressure, and the session caps count pair teardowns (two sockets
  each); parked-overflow, heartbeat, and park-timeout count single sockets. Still
  aggregate-only: no slot ids, IPs, or content.
- `relay_peer_closed_total` Prometheus counter for paired tunnels torn down by one half closing.
- README "Performance and vertical scaling" section with measured numbers and the
  slot-affinity horizontal-scaling path.
- Initial relay implementation: slot-based WebSocket rendezvous, runaway-bill guards (slot-id
  format validation, per-IP and per-slot rate limits, connection caps, per-session and per-message
  byte caps, backpressure teardown), WS-level ping/pong keepalive with pong-timeout reaping, a
  pluggable admission seam (in-process policy and an out-of-process webhook), `/healthz`, `/readyz`,
  and `/metrics` operational endpoints, structured logging with slot-id hashing, graceful SIGTERM
  shutdown, Docker and docker-compose deploy tooling, and CI (lint, typecheck, unit tests,
  `@kangentic/protocol` integration test, Docker build smoke check).

### Changed

- **`/metrics` and `/metricz` now require a token.** With `METRICS_TOKEN` unset they answer 404
  (not 401, which would advertise that a gated surface exists) unless
  `METRICS_ALLOW_UNAUTHENTICATED=true`. Neither surface has ever carried slot ids or IPs, but the
  live waiting/paired gauges reveal when pairings form and the per-reason reject counters tell a
  prober exactly which guard they tripped, which is a feedback channel worth denying a stranger.
  The gate is an explicit flag rather than something inferred from `BIND_ADDRESS`, because a
  containerised relay binds `0.0.0.0` whether the host publishes the port to loopback or to the
  world. The bearer token is now compared in constant time. **Breaking for self-hosters who read
  metrics:** set `METRICS_TOKEN`, or `METRICS_ALLOW_UNAUTHENTICATED=true`.
- An admission webhook returning 4xx is now an explicit deny, honored even under
  `ADMISSION_FAIL_OPEN`. It previously shared a catch with network errors, so a control plane that
  denied the natural REST way (403 with `{"allow": false}`) admitted the connection instead. A
  5xx, timeout, or network error still counts as the control plane being unavailable and follows
  `ADMISSION_FAIL_OPEN`. A deny `reason` is forwarded as the WebSocket close reason and so is
  capped at 123 UTF-8 bytes (the close frame's limit), degrading to the generic `denied` beyond
  that rather than throwing mid-teardown.
- `docker-compose.yml` now pulls `ghcr.io/kangentic/relay` instead of building from source (the
  `build: .` key previously present made `docker compose up -d` silently ignore the published
  image). Port 8080 is now bound to `127.0.0.1` only, `ulimits.nofile` is raised to 65535 matching
  the README's fd-headroom guidance, and `stop_grace_period` is set to 20s, leaving margin beyond
  `SHUTDOWN_GRACE_MS`'s 10s default so the process drains on its own rather than being SIGKILLed
  mid-drain.
- README: updated the self-hosting deploy guidance from a Hetzner CX23 baseline to a CPX11, and
  fixed the deploy steps to require `TRUSTED_PROXY_CIDRS` alongside `TRUST_PROXY=true` - setting
  `TRUST_PROXY=true` alone previously trusted `CF-Connecting-IP` / `X-Forwarded-For` from any peer,
  which let a client forge either header and bypass every per-IP cap and rate limit (now enforced in
  code, see the next entry).
- `TRUST_PROXY=true` with an empty `TRUSTED_PROXY_CIDRS` now fails closed at startup: `loadConfig`
  throws a `ConfigError` instead of booting, and every configured CIDR is validated at load time so
  a malformed entry (including a trailing-slash typo like `10.0.0.0/`, which would otherwise behave
  as a match-everything `/0`) cannot reach the trusted-proxy matcher at request time. The relay's
  own `X-Forwarded-For` parsing also now walks from the rightmost untrusted hop rather than the
  leftmost, so a proxy that appends to the header instead of replacing it does not open a spoofing
  path. **Breaking for self-hosters:** a `TRUST_PROXY=true` deployment with an empty
  `TRUSTED_PROXY_CIDRS` that previously booted (and trusted every peer) will now refuse to start;
  set `TRUSTED_PROXY_CIDRS` to the fronting proxy's address or subnet.
- Default `SLOT_ID_PATTERN` now accepts the 32-hex ongoing-session slot
  (`^([0-9a-f]{32}|[0-9a-f]{64})$`) in addition to the 64-hex pairing slot. The old default
  (`^[0-9a-f]{64}$`) let pairing succeed but rejected every session rendezvous at upgrade time,
  because `@kangentic/protocol`'s `deriveSessionSlotId` produces a 16-byte (32-hex) slot.
  Deployments that pinned `SLOT_ID_PATTERN` explicitly should widen it the same way.
- permessage-deflate is now explicitly disabled on the WebSocket server rather than left to the
  `ws` default: ciphertext is incompressible, and the extension would cost CPU and per-connection
  zlib memory for nothing.
- The per-frame forwarding hot path no longer does a slot-table lookup for session-byte
  accounting (pair state is cached on the connection) and no longer allocates a send-options
  object per frame.

### Fixed

Found by a pre-production audit of the rendezvous path. None of these let a third party pair into
another peer's slot; they are rate-limit evasion, availability, and accounting defects.

- `CF-Connecting-IP` was trusted without being parsed, unlike the `X-Forwarded-For` path. Behind a
  proxy that forwards the header rather than overwriting it, a client could send an arbitrary
  string and get a fresh full-burst rate-limit bucket on every request, bypassing
  `RATE_LIMIT_IP_PER_MIN` and `MAX_CONNECTIONS_PER_IP` entirely and growing the limiter's key map
  without bound. Kangentic's own deployment was unaffected (Caddy overwrites both headers); a
  self-hoster behind a generic nginx or Caddy was not.
- An upgrade that `ws` refused outright (missing or malformed `Sec-WebSocket-Key`, bad version,
  non-GET, or a socket that died while the admission decision was awaited) never invoked the
  completion callback, so the global and per-IP cap reservations taken beforehand were never
  returned. Malformed upgrades could walk the relay to refusing every pairing.
- The pre-pair flush forwarded a parked peer's buffered frames without charging them against
  `MAX_SESSION_BYTES` or checking `MAX_BUFFERED_BYTES`, letting up to `MAX_PARKED_BUFFER_BYTES`
  per session pass outside both caps.
- A connection rejected for a busy slot released a per-slot cap reservation it never held, walking
  `MAX_CONNECTIONS_PER_SLOT` toward zero while both real peers were still connected.
- `IPV6_PREFIX_BITS` truncated whole 16-bit groups without masking the final partial one, so any
  value not a multiple of 16 silently aggregated less than asked (a `/56` behaved as a `/64`).
- README, `docs/architecture.md`, and `infra/README.md` described slot-id log hashing as the
  pairing-graph mitigation. No log line contains a slot id at all, hashed or raw, which is stronger
  than documented but was unenforced; a test now fails the build if a logger call site is ever
  given one. `LOG_SLOT_HASHING` and `SLOT_LOG_SALT` are documented as the inert-but-sanctioned path
  for any future slot logging.
- `ADMISSION_WEBHOOK_URL` was documented as functional, but the shipped binary never constructs the
  webhook policy: it is a library seam for an embedder calling
  `createRelay(config, { admissionPolicy })`. Documented as such so no operator sets the variable
  and believes access is gated.
- Close codes 4400, 4410, and 4503 were documented but never sent (a bad slot is rejected
  pre-upgrade with HTTP 400, draining uses the standard 1001, and an unanswered ping is reaped with
  `terminate()`, yielding 1006). They are now marked reserved so a client is not written to wait
  for one.
- "Honest metadata disclosure" now records that the slot id travels in the request URL and that
  Cloudflare terminates TLS on the hosted instance, and that the reconnect slot id is stable for
  the life of a pairing.
