# Documentation

@kangentic/relay is a tiny, stateless, blind WebSocket rendezvous relay for the Kangentic mobile
companion. It forwards only opaque ciphertext frames between two peers that both dial out to it,
and authenticates and reads nothing. See the root [README.md](../README.md) for the blind-relay
guarantee, self-hosting quickstart, and full config reference.

## Start Here

| Audience | Start with |
|---|---|
| Self-hosting the relay | [Root README](../README.md#quickstart-self-hosting) |
| Understanding how the relay works | [Architecture](architecture.md) |
| Understanding how a commit becomes a running instance | [Deployment architecture](deployment.md) |
| Operating the hosted instance | [`infra/README.md`](../infra/README.md) |

## Reference

### Architecture
- [Architecture](architecture.md) — Connection lifecycle, the slot rendezvous state machine,
  guards, the forwarding hot path, liveness, real-client-IP resolution, the admission seam,
  observability.

### Deployment
- [Deployment architecture](deployment.md) — The publish pipeline (GHCR, image tags), the deploy
  mechanism (health gate, rollback, the skip-when-unchanged optimization), production topology,
  provisioning, and monitoring.
- [`infra/README.md`](../infra/README.md) — The operator runbook: first-provision steps, the
  secrets and variables tables, troubleshooting, reading `/metricz`, traffic-budget checks.
- [`infra/cloudflare/origin-ca.md`](../infra/cloudflare/origin-ca.md) — Minting and rotating the
  Origin CA certificate.

### Project conventions
- [`CONTRIBUTING.md`](../CONTRIBUTING.md) — Opening a pull request.
- [`SECURITY.md`](../SECURITY.md) — Reporting a vulnerability.
- [`CHANGELOG.md`](../CHANGELOG.md) — Notable changes, in Keep a Changelog format.
