# Hosted deploy: operator runbook

This is the deploy path for Kangentic's own hosted relay instance. Self-hosters running behind
Cloudflare with Caddy can follow the same path; see the note at the end of each section for what
changes if you are not Kangentic.

## Topology

```
client --wss--> Cloudflare (proxy, TLS, DDoS absorption)
                    |  restricted to Cloudflare's own IP ranges by the Hetzner firewall
                    v
                Hetzner box (CPX11)
                    |
                  Caddy (80/443, Origin CA TLS, header normalization)
                    |  internal `edge` bridge network only, 172.31.240.0/24
                    v
                 relay (127.0.0.1:8080 on the host, for deploy.sh's own health probe)
```

What is load-bearing at each layer, and why:

| Layer | Protects |
|---|---|
| Caddy `trusted_proxies` plus `header_up` overwrite of `CF-Connecting-IP` and `X-Forwarded-For` | Header authenticity. This is the actual fix for the relay's fail-open `TRUSTED_PROXY_CIDRS` default - see below. |
| `TRUST_PROXY=true` with `TRUSTED_PROXY_CIDRS` pinned to the `edge` network subnet | The relay trusts exactly one hop: Caddy. Not Cloudflare's ranges - the relay's socket peer is always Caddy, never Cloudflare directly. |
| Hetzner firewall, 80/443 restricted to Cloudflare's published ranges | Reachability and origin-IP hiding. This is what makes the Caddy layer's header authenticity actually mean something - without it, anyone who learns the origin IP could dial in directly and forge headers themselves. |
| Caddy's strict `Host` match (its default behavior) | Free protection against another Cloudflare customer aiming their zone at this IP. |

**Why `TRUSTED_PROXY_CIDRS` is the Docker bridge subnet, not Cloudflare's ranges.** In
`src/net/clientIp.ts`, `resolveClientIp` only consults `CF-Connecting-IP` if the immediate socket
peer is in `TRUSTED_PROXY_CIDRS`. The relay's socket peer is always Caddy's container, never
Cloudflare's edge, so putting Cloudflare's ranges there would make every connection resolve to
Caddy's one address and collapse `MAX_CONNECTIONS_PER_IP` into a global cap.

**Why an empty `TRUSTED_PROXY_CIDRS` is dangerous.** `isTrustedProxy` treats an empty list as "trust
everything." The relay's own quickstart README used to say "set `TRUST_PROXY=true`" with no
mention of the CIDR list, which is exactly that trap - any client could forge
`CF-Connecting-IP`/`X-Forwarded-For` and bypass per-IP caps and rate limits entirely. This is fixed
in the shipped README and `.env.example`, but the production value here is what actually closes it.

**Why Caddy replaces `X-Forwarded-For` instead of just setting `CF-Connecting-IP`.** Cloudflare
*appends* to XFF rather than replacing it, so a client-forged `X-Forwarded-For: 1.2.3.4` arrives as
`1.2.3.4, <real client>`. The relay's fallback path picks the leftmost untrusted hop, which would be
the forged entry. Caddy's `header_up X-Forwarded-For {client_ip}` (no `+`/`-` prefix) replaces
outright, so neither header is forgeable.

## First provision

Human prerequisites (an agent cannot create these): a Hetzner account with billing and an hcloud
API token; a Cloudflare account with the `kangentic.com` zone's nameservers pointed at Cloudflare
(registration can stay wherever it is); a Cloudflare API token if you automate DNS record creation,
or create the records by hand in the dashboard.

1. Generate a dedicated ci-deploy SSH key: `ssh-keygen -t ed25519 -f relay-ci-deploy -N ''`. Keep
   `relay-ci-deploy` (private) out of the repo; `relay-ci-deploy.pub` is read directly by
   `provision.sh`.
2. `export HCLOUD_TOKEN=...` and run `infra/hetzner/provision.sh`. It creates both SSH keys on
   Hetzner, the firewall (from `infra/hetzner/firewall-rules.json`), the server (from
   `infra/hetzner/cloud-init.yaml`), waits for cloud-init to finish, clones this repo onto the box,
   and restricts the ci-deploy key's `authorized_keys` entry to the deploy wrapper. It is idempotent
   - re-run it any time (e.g. after the weekly Cloudflare-range refresh PR merges) to reconcile the
   firewall.
3. In Cloudflare: create an A record `relay-ashburn-us-east.kangentic.com` pointing at the server's IP,
   proxied (orange cloud). Create a CNAME `relay.kangentic.com` pointing at
   `relay-ashburn-us-east.kangentic.com`, also proxied. **Never point either name at more than one server** -
   the slot rendezvous table is in-process memory, so a desktop and phone resolving the same
   hostname to different boxes would land in different tables and never pair.
4. Set the zone's SSL/TLS mode to Full (strict). Mint an Origin CA certificate covering
   `kangentic.com` and `*.kangentic.com` - see `infra/cloudflare/origin-ca.md` for exactly why the
   wildcard matters (the CNAME needs it too, not just the region name).
5. In the GitHub repo's Settings > Environments, create `production` (deployment branches: `main`
   and tags matching `v*`, no required reviewer - see "Why no required reviewer" below) and
   `monitoring` (no restrictions). Populate the secrets and variables tables below.
6. Trigger a manual deploy (`workflow_dispatch` on `deploy.yml`) or merge a commit to main. The
   deploy pushes the `.env` and Origin CA cert/key to the box (see "Secrets" below) on every run, so
   the first deploy is also what delivers them.

Self-hosters: everything through step 4 is optional (you can front the relay with anything, or
nothing at all - see the base `Caddyfile.example` for a Cloudflare-free alternative). Steps 5-6 do
not apply; just run `docker compose up -d` per the main README.

### Why no required reviewer on the production environment

"Protected" here means a deployment-branch restriction (only `main` and `v*` tags may deploy) and
secret scoping, deliberately without a required human approval on every deploy. The relay's
Definition of Done asks that a merge to main roll the box; the deploy gate (container identity
changed, digest matches, health check and host probe both green) plus automatic rollback plus the
rollback drill below are the designed safety net. A standing approval prompt would make the
pipeline non-continuous for no safety the gate does not already provide.

## Secrets and variables

### `production` environment

| Secret | Purpose |
|---|---|
| `DEPLOY_SSH_KEY` | Private half of the ci-deploy key |
| `DEPLOY_SSH_KNOWN_HOSTS` | Pinned host key line, keyed to the `relay-production` `HostKeyAlias` - capture with `ssh-keyscan -t ed25519 <ip> \| sed 's/^[^ ]*/relay-production/'` right after provisioning, never at deploy time |
| `HCLOUD_TOKEN` | Read scope is enough; used only to resolve the server's IP by label |
| `RELAY_METRICS_TOKEN` | Bearer token for `/metricz`; also delivered into the box's `.env` |
| `RELAY_SLOT_LOG_SALT` | Pinned 32-byte hex; delivered into `.env` |
| `CF_ORIGIN_CERT_PEM` / `CF_ORIGIN_KEY_PEM` | Origin CA certificate and key; delivered to `/opt/relay/secrets/` on every deploy |

| Variable | Value | Purpose |
|---|---|---|
| `DEPLOY_SSH_USER` | `deploy` | |
| `DEPLOY_SSH_PORT` | `22` | |
| `HCLOUD_SERVER_SELECTOR` | `project=relay,env=production` | Resolves the box by label, not a numeric ID that changes on rebuild |
| `RELAY_PUBLIC_HOSTNAME` | `relay-ashburn-us-east.kangentic.com` | Written into `.env` as `RELAY_HOSTNAME` for Caddy's site block |

### `monitoring` environment (unprotected - see monitor.yml's own comment for why)

| Secret | Purpose |
|---|---|
| `RELAY_METRICS_TOKEN` | Same value as production's, for the periodic `/metricz` check |
| `HEALTHCHECKS_PING_URL` | Dead-man ping, so a GitHub-wide outage that silently stops this workflow is still detected from outside |

| Variable | Value |
|---|---|
| `RELAY_PUBLIC_HOSTNAME` | `relay.kangentic.com` (the CNAME, so this also validates the CNAME independently of the region record) |
| `RELAY_MAX_CONNECTIONS` | `4000` (must track the production `.env` value below) |

## Production `.env`

Delivered to `/opt/relay/.env` by every deploy (see "How secrets reach the box"). Only the values
that differ from `src/config.ts`'s defaults are listed; everything else stays default.

| Var | Value | Why |
|---|---|---|
| `MAX_CONNECTIONS` | `4000` | 2x the 2000 all-concurrent worst case at under 1k users. The default of 10000 cannot bound memory on a 2 GB box given the 16 MiB `MAX_BUFFERED_BYTES` tail per connection - refuse cleanly with a 503 rather than risk an OOM. |
| `MAX_CONNECTIONS_PER_IP` | `64` | Mobile carrier CGNAT puts thousands of phones behind one IPv4; the default of 20 would mean roughly 10 real users share a bucket. The real abuse bound is `MAX_CONNECTIONS_PER_SLOT=2`, unchanged. |
| `TRUST_PROXY` | `true` | Required - without it, every connection resolves to the raw socket peer, which is always Caddy's one bridge address. |
| `TRUSTED_PROXY_CIDRS` | `172.31.240.0/24` | The `edge` network subnet pinned in `infra/compose/docker-compose.prod.yml`. This is the actual fix for the empty-list trust-everything default - see "Topology" above. |
| `RELAY_HOSTNAME` | `relay-ashburn-us-east.kangentic.com` | Not a relay config var - read by compose for Caddy's `{$RELAY_HOSTNAME}` site block. Harmless if the relay process ignores it, which it does. |
| `METRICS_TOKEN` | 32 bytes hex, generated with `openssl rand -hex 32` | Mandatory. Both `/metrics` and `/metricz` sit on the public hostname; unset means world-readable operational telemetry. |
| `SLOT_LOG_SALT` | 32 bytes hex, pinned | Mandatory. The default regenerates every process restart, which destroys the cross-restart correlation the hashed slot ids exist for. Treat this value as a secret; it is what makes the hashes reversible-by-comparison to anyone who also holds it. |
| `MAX_SESSION_MS` | `0` (default, unchanged) | Deliberately left disabled. A wall-clock cap tears down healthy long-lived pairings mid-use; the byte cap (`MAX_SESSION_BYTES`, unchanged) is the actual runaway-bill bound, and keepalive already reaps dead sockets. |

**The single most important non-`.env` value is `mem_limit: 1200m`** in
`infra/compose/docker-compose.prod.yml`. `MAX_CONNECTIONS` cannot bound the buffered-bytes tail by
itself, so the container memory limit is the actual OOM control. Do not remove it under the
assumption the connection cap already covers memory.

`PING_INTERVAL_MS` stays at the default `30000`, comfortably inside Cloudflare's roughly
100-second WebSocket idle timeout. **Verify this with a real 10-minute idle pairing** after the
first deploy - if Cloudflare does not count WS ping/pong control frames as activity, the relay
would need application-visible traffic instead, which is a design question, not a config one.

## How secrets reach the box

Nothing in `infra/hetzner/cloud-init.yaml` contains a secret - Hetzner instance metadata is
readable from inside the box, so user-data is treated as public. Secrets arrive over SSH instead,
through a second forced-command verb on the ci-deploy key:
`write-secret <env|origin-cert|origin-key>`, which reads stdin and writes it atomically to a fixed,
allowlisted path. `deploy.yml` composes the `.env` file from the `production` environment's secrets
and vars and pushes it, along with the Origin CA cert and key, before every deploy - so rotating any
of them (a new `METRICS_TOKEN`, a renewed Origin CA cert) is just: update the GitHub secret, then
trigger a deploy (`workflow_dispatch` works if there is no code change to publish).

## Deploy and rollback

A merge to `main` or a `vX.Y.Z` tag publishes the image, then automatically deploys. All deploy
logic lives in `scripts/deploy/deploy.sh`, run on the box over one SSH call - a dropped runner
connection cannot leave the server half-deployed, because the box completes or reverts on its own.

**Rollback target is a registry digest, never a tag.** Tags are mutable; a re-pushed tag would roll
back to the wrong bits. The digest is read from the currently running container
(`docker inspect --format '{{index .RepoDigests 0}}'`) before anything changes, and the git ref to
roll back to comes from git's own reflog (`HEAD@{1}`, "HEAD before the checkout the wrapper just
did") - both are reality, not a hand-maintained file that could drift. `state/last_good` is written
only after a successful deploy, as an audit trail and a cold-start fallback.

**The health gate is a conjunction of three conditions**, evaluated on the box over loopback: the
serving container id changed, its image digest matches what was just pulled, and both the Docker
healthcheck and a direct host probe on `127.0.0.1:8080` report healthy. The first condition alone
would pass against the old container still answering 200, which is why `/healthz` cannot be trusted
in isolation.

**To roll back manually**, or to redeploy a specific version: trigger `deploy.yml` via
`workflow_dispatch` with `image_tag` set to the desired tag (or run `deploy.sh` directly on the box
with a full `repo@sha256:...` reference as the image tag argument).

### Proving rollback: the drill

```
gh workflow run deploy.yml -f image_tag=<current good tag> -f drill=healthcheck
```

This deploys the real, currently-good image with only its healthcheck forced to fail
(`infra/compose/docker-compose.drill-healthcheck.yml`). The gate fails, rollback restores the
previous digest, and the workflow run exits red - nothing broken ever reaches GHCR. Run
`drill=port` too: it sets `PORT=9099` inside the container so the container's own healthcheck
(which honors `$PORT`) still passes while the host probe on the fixed port `8080` fails, exercising
the other half of the gate's AND independently. One drill only proves one branch.

## Post-deploy security gate

Run this once after the first deploy, and again after any change to `TRUSTED_PROXY_CIDRS` or the
Caddy header configuration. It is the one test that behaviorally proves per-IP caps actually bind,
since the resolved client IP is never logged.

1. Temporarily set `MAX_CONNECTIONS_PER_IP=1` (push via `write-secret env`, or edit `.env` directly
   on the box and restart).
2. From one real client, open two WebSocket connections with different forged
   `CF-Connecting-IP` headers - Cloudflare's own edge will overwrite this for genuine external
   traffic, so test this from inside the `edge` network or directly against Caddy on the box to
   actually exercise the forgery path Caddy is meant to close.
3. If forgery works, both connections are admitted. If the design holds, the second is rejected and
   `rejectsByReason.ip_cap` increments on `/metricz`.
4. Restore `MAX_CONNECTIONS_PER_IP` to `64`.

## Health triage

`/healthz` red through the public hostname could mean Cloudflare, the firewall, Caddy, or the relay
itself. **This is impossible to fully disambiguate from outside by design**: the firewall drops any
non-Cloudflare source, so no external check can tell "Cloudflare is down" from "the origin is down."
SSH to the box and check locally:

```
curl -sf http://127.0.0.1:8080/healthz     # the relay itself, bypassing Caddy and Cloudflare
docker compose -f infra/compose/docker-compose.prod.yml ps
docker compose -f infra/compose/docker-compose.prod.yml logs --tail 200 caddy
docker compose -f infra/compose/docker-compose.prod.yml logs --tail 200 relay
```

## Reading `/metricz`

`closedByCause` mixes two units: `peerClosed`, `backpressure`, `sessionByteCap`, `sessionTimeCap`
count **pair teardowns** (two sockets each), while `parkedOverflow`, `heartbeat`, `parkTimeout`
count **single sockets**. `sessionTimeCap` should always read zero, since production leaves
`MAX_SESSION_MS` at its disabled default - a non-zero value means someone changed the deploy.

| Cause rising | Likely means | Action |
|---|---|---|
| `peerClosed` | Normal - one side hung up | None; this should dominate |
| `backpressure` | Slow consumers hitting the buffer cap, or a saturated uplink | Check bandwidth before raising `MAX_BUFFERED_BYTES` |
| `parkedOverflow` | One peer sending hard before its partner arrives | Client bug or abuse; correlate with `rate_limit_slot` |
| `heartbeat` | Phones vanishing without a FIN | Normal at low rates; a spike suggests a network path problem |
| `parkTimeout` | Pairings started and abandoned | Client-side pairing UX, or slot scanning |
| `sessionByteCap` | Legitimate heavy users hitting the byte cap | Revisit the cap if these are real users, not abuse |

## Traffic budget

`bytesForwardedTotal` resets to zero on every process restart, so a naive scrape undercounts. Sample
it alongside `uptimeSeconds` every 15-30 minutes, treat a decrease in `uptimeSeconds` as a restart
boundary, and sum deltas across boundaries for a month-to-date estimate. The counter is payload
only (no TLS, WebSocket, or TCP framing), so real egress runs roughly 1.1-1.3x higher. Hetzner bills
egress only; ingress is free. Cross-check monthly against the authoritative figure:
`hcloud server describe relay-ashburn-us-east -o json` includes outgoing traffic for the billing period.
Overage is billed per GB past the plan's included allowance, so an alert here is informational, not
urgent - check the Hetzner console for current plan limits and pricing.

## Cloudflare range rotation

`.github/workflows/cloudflare-ranges.yml` runs weekly, regenerates
`infra/hetzner/firewall-rules.json` and `infra/cloudflare/trusted-proxies.caddy` from Cloudflare's
published ranges, and opens a PR if anything changed. It never applies anything automatically - a
silent cron running `hcloud firewall replace-rules` would be an outage or an exposure waiting to
happen. To apply a merged PR: re-run `infra/hetzner/provision.sh` (it reconciles the firewall
unconditionally) and redeploy so Caddy's `trusted_proxies` picks up the new list.

## Origin CA certificate rotation

See `infra/cloudflare/origin-ca.md`. Nominal life is 15 years - nobody will remember on their own.
`scripts/deploy/deploy.sh` does not currently assert an expiry threshold itself; the check happens
inside the deploy but is not yet a hard gate. If the repo goes quiet with no deploys for a long
stretch, check manually: `ssh deploy@relay-ashburn-us-east.kangentic.com "openssl x509 -in
/opt/relay/secrets/origin.crt -noout -enddate"`.

## What was deliberately not built

- **Authenticated Origin Pulls** - redundant with the firewall for its headline claim, and its own
  CA certificate has a hard expiry that would silently 5xx the whole site. See
  `infra/cloudflare/origin-ca.md`.
- **Fail-closed on empty `TRUSTED_PROXY_CIDRS`** - a breaking change to `src/net/clientIp.ts`'s
  shipped default behavior, deserving its own tests and migration note rather than being buried in
  this infra change. The hosted box is unaffected either way (it ships an explicit list); the
  exposed party would be self-hosters following the old README, which is fixed separately.
- **Narrowing SSH to GitHub's runner ranges** - GitHub publishes them, but the list runs to
  thousands of CIDRs and exceeds Hetzner's per-firewall rule limits. Mitigated by key-only auth and
  fail2ban instead.
