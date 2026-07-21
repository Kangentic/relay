# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

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

- `docker-compose.yml` now pulls `ghcr.io/kangentic/relay` instead of building from source (the
  `build: .` key previously present made `docker compose up -d` silently ignore the published
  image). Port 8080 is now bound to `127.0.0.1` only, `ulimits.nofile` is raised to 65535 matching
  the README's fd-headroom guidance, and `stop_grace_period` is set to 20s, leaving margin beyond
  `SHUTDOWN_GRACE_MS`'s 10s default so the process drains on its own rather than being SIGKILLed
  mid-drain.
- README: corrected the hosted-instance description from a Hetzner CX23 (EU-only 20 TB pricing) to
  a CPX11 in Ashburn, VA (1 TB included, US pricing), and fixed the self-hosting deploy steps to
  require `TRUSTED_PROXY_CIDRS` alongside `TRUST_PROXY=true` - setting `TRUST_PROXY=true` alone
  trusts `CF-Connecting-IP` / `X-Forwarded-For` from any peer, which lets a client forge either
  header and bypass every per-IP cap and rate limit.
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
