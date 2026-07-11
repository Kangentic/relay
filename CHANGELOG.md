# Changelog

All notable changes to this project are documented in this file. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

## [Unreleased]

### Added

- Initial relay implementation: slot-based WebSocket rendezvous, runaway-bill guards (slot-id
  format validation, per-IP and per-slot rate limits, connection caps, per-session and per-message
  byte caps, backpressure teardown), WS-level ping/pong keepalive with pong-timeout reaping, a
  pluggable admission seam (in-process policy and an out-of-process webhook), `/healthz`, `/readyz`,
  and `/metrics` operational endpoints, structured logging with slot-id hashing, graceful SIGTERM
  shutdown, Docker and docker-compose deploy tooling, and CI (lint, typecheck, unit tests,
  `@kangentic/protocol` integration test, Docker build smoke check).
