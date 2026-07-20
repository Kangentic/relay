# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Changed

- Default `SLOT_ID_PATTERN` now accepts the 32-hex ongoing-session slot
  (`^([0-9a-f]{32}|[0-9a-f]{64})$`) in addition to the 64-hex pairing slot. The old default
  (`^[0-9a-f]{64}$`) let pairing succeed but rejected every session rendezvous at upgrade time,
  because `@kangentic/protocol`'s `deriveSessionSlotId` produces a 16-byte (32-hex) slot.
  Deployments that pinned `SLOT_ID_PATTERN` explicitly should widen it the same way.

### Added

- `/metricz`: a JSON metrics endpoint mirroring `/metrics` (same enable/token gating) with
  process RSS, uptime, and connections-closed-by-cause counters (peer-closed, backpressure,
  heartbeat, park-timeout, session caps). Still aggregate-only: no slot ids, IPs, or content.
- `relay_peer_closed_total` Prometheus counter for paired tunnels torn down by one half closing.
- `scripts/loadTest.mjs`: a dependency-free load-test harness (N slot pairs x M frames x S bytes,
  paced or flooding with end-to-end windowing) reporting relay-added latency percentiles,
  aggregate throughput, and relay RSS before/after via `/metricz`.
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

- permessage-deflate is now explicitly disabled on the WebSocket server rather than left to the
  `ws` default: ciphertext is incompressible, and the extension would cost CPU and per-connection
  zlib memory for nothing.
- The per-frame forwarding hot path no longer does a slot-table lookup for session-byte
  accounting (pair state is cached on the connection) and no longer allocates a send-options
  object per frame.
