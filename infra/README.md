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
| Caddy `trusted_proxies` plus `header_up` overwrite of `CF-Connecting-IP` and `X-Forwarded-For` | Header authenticity, and pinning the trusted hop to exactly Caddy. The relay now fails closed on an empty `TRUSTED_PROXY_CIDRS` on its own (see below), so this layer is defense in depth, not the only fix. |
| `TRUST_PROXY=true` with `TRUSTED_PROXY_CIDRS` pinned to the `edge` network subnet | The relay trusts exactly one hop: Caddy. Not Cloudflare's ranges - the relay's socket peer is always Caddy, never Cloudflare directly. |
| Hetzner firewall, 80/443 restricted to Cloudflare's published ranges | Reachability and origin-IP hiding. This is what makes the Caddy layer's header authenticity actually mean something - without it, anyone who learns the origin IP could dial in directly and forge headers themselves. |
| Caddy's strict `Host` match (its default behavior) | Free protection against another Cloudflare customer aiming their zone at this IP. |

**Why `TRUSTED_PROXY_CIDRS` is the Docker bridge subnet, not Cloudflare's ranges.** In
`src/net/clientIp.ts`, `resolveClientIp` only consults `CF-Connecting-IP` if the immediate socket
peer is in `TRUSTED_PROXY_CIDRS`. The relay's socket peer is always Caddy's container, never
Cloudflare's edge, so putting Cloudflare's ranges there would make every connection resolve to
Caddy's one address and collapse `MAX_CONNECTIONS_PER_IP` into a global cap.

**Why `TRUST_PROXY=true` with an empty `TRUSTED_PROXY_CIDRS` is refused at startup.** `loadConfig`
now fails closed on that combination: `isTrustedProxy` trusts no peer when the list is empty, so
`TRUST_PROXY=true` with nothing to trust is a misconfiguration the relay refuses to boot with rather
than silently trusting every peer. Earlier builds treated an empty list as "trust everything," which
let any client forge `CF-Connecting-IP`/`X-Forwarded-For` and bypass per-IP caps and rate limits
entirely. Pinning the production value here is now belt and suspenders (it also limits the trusted
hop to exactly Caddy), not the only thing closing that hole.

**Why Caddy replaces `X-Forwarded-For` instead of just setting `CF-Connecting-IP`.** Cloudflare
*appends* to XFF rather than replacing it, so a client-forged `X-Forwarded-For: 1.2.3.4` arrives as
`1.2.3.4, <real client>`. The relay's own fallback path now walks XFF from the rightmost untrusted
hop, not the leftmost, so the forged leftmost entry is skipped even without Caddy's rewrite. Caddy's
`header_up X-Forwarded-For {client_ip}` (no `+`/`-` prefix) replaces the header outright anyway, so
this is defense in depth rather than the only safeguard.

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
secret scoping, deliberately without a required human approval on every deploy. The deliberate act
is cutting the release tag, which a human decides in the board's Release column; once that tag
exists, a standing approval prompt on the deploy itself would only add a second confirmation of the
same decision. The deploy gate (container identity changed, digest matches, health check and host
probe both green) plus automatic rollback plus the rollback drill below are the designed safety
net.

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
| `RELAY_PUBLIC_HOSTNAME_ALIAS` | `relay.kangentic.com` | Written into `.env` as `RELAY_HOSTNAME_ALIAS`. **Required, not optional** - Caddy only routes a Host header matching one of a site block's own configured addresses, so the short CNAME needs to be listed explicitly in `infra/compose/Caddyfile.prod` or it gets a 200 with an empty body despite the CNAME resolving and the TLS handshake succeeding (the wildcard Origin CA cert covers it fine; only the HTTP-layer Host match was missing). This exact gap shipped once - see the Caddyfile's own comment. |

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

**This table is a description, not the source.** The file is generated from a heredoc in
`.github/workflows/deploy.yml` and overwrites `/opt/relay/.env` wholesale on every deploy, so a
value that is not in that heredoc is not in production no matter what this table says. Editing
the file over SSH appears to work and is silently reverted by the next deploy. Change the
workflow.

| Var | Value | Why |
|---|---|---|
| `MAX_CONNECTIONS` | `4000` | 2x the 2000 all-concurrent worst case at under 1k users. The default of 10000 cannot bound memory on a 2 GB box given the 16 MiB `MAX_BUFFERED_BYTES` tail per connection - refuse cleanly with a 503 rather than risk an OOM. |
| `MAX_CONNECTIONS_PER_IP` | `64` | Mobile carrier CGNAT puts thousands of phones behind one IPv4; the default of 20 would mean roughly 10 real users share a bucket. The real abuse bound is `MAX_CONNECTIONS_PER_SLOT=2`, unchanged. |
| `TRUST_PROXY` | `true` | Required - without it, every connection resolves to the raw socket peer, which is always Caddy's one bridge address. |
| `TRUSTED_PROXY_CIDRS` | `172.31.240.0/24` | The `edge` network subnet pinned in `infra/compose/docker-compose.prod.yml`. Pins the trusted hop to exactly Caddy; the relay also fails closed on an empty list at startup now - see "Topology" above. |
| `RELAY_HOSTNAME` | `relay-ashburn-us-east.kangentic.com` | Not a relay config var - read by compose for Caddy's `{$RELAY_HOSTNAME}` site block. Harmless if the relay process ignores it, which it does. |
| `METRICS_TOKEN` | 32 bytes hex, generated with `openssl rand -hex 32` | Mandatory. Both `/metrics` and `/metricz` sit on the public hostname. The relay now refuses to serve them without a token, so an unset value here means both surfaces 404 rather than leaking telemetry - which fails safe, but also silently breaks the monitor workflow. Set it, and do not set `METRICS_ALLOW_UNAUTHENTICATED` on this deployment. |
| `SLOT_LOG_SALT` | 32 bytes hex, pinned | **Currently inert** - no relay log line contains a slot id, so nothing hashes one and this salt is never consumed. It stays pinned and secret because it is the configured input to `slotRef()`, which is the only sanctioned path if slot logging is ever added; a pinned salt means such logs would correlate across restarts, and anyone holding the salt could confirm a candidate slot id by comparison. Safe to keep delivering; do not treat its presence as evidence that slot hashing is doing anything today. |
| `MAX_SESSION_MS` | `0` (default, unchanged) | Deliberately left disabled. A wall-clock cap tears down healthy long-lived pairings mid-use; the byte cap (`MAX_SESSION_BYTES`, unchanged) is the actual runaway-bill bound, and keepalive already reaps dead sockets. |
| `ADMIN_ENABLED` | `true` | Serves the private dashboard at `/admin`. **The relay does not authenticate it** - Cloudflare Access, scoped to the `/admin*` path on the public hostname, is the gate. See "The `/admin` dashboard and its volume" below before turning this on. |
| `METRICS_HISTORY_PATH` | `/var/lib/relay/history.ndjson` | The `relay_history` named volume's mount point. Must be absolute. Anywhere outside the volume is discarded by the next deploy. |
| `CONNECTION_TRACE` | `true` | One timing line per connection at close, keyed by CF-Ray, for the edge-to-origin latency investigation in [`docs/latency.md`](../docs/latency.md). No slot id, no IP. About 13k lines a day; the relay service's log rotation in the compose file is sized for it. Remove the line from `deploy.yml` to stop. |

**The single most important non-`.env` value is `mem_limit: 1200m`** in
`infra/compose/docker-compose.prod.yml`. `MAX_CONNECTIONS` cannot bound the buffered-bytes tail by
itself, so the container memory limit is the actual OOM control. Do not remove it under the
assumption the connection cap already covers memory. **`memswap_limit` is set equal to it**, which
is how Docker spells "no swap": unset, the container could page another 1200m into the box's 2 GB
swapfile, and a garbage collector touching a paged-out heap is a stall measured in disk reads. An
OOM kill and a restart is the honest failure here.

**Caddy runs BBR, which needs two host settings.** The `caddy` service sets
`net.ipv4.tcp_congestion_control=bbr` in its own network namespace (measured: under 0.8% loss, BBR
held 2 MiB bursts near 200 ms where cubic climbed past a second; see `docs/latency.md`). The kernel
accepts that only when `tcp_bbr` is loaded (Ubuntu ships it as a module) **and** `bbr` is on
`net.ipv4.tcp_allowed_congestion_control`: a namespace other than the host's may only default to an
allowed algorithm, and the stock list is `reno cubic`. A container can create neither, and without
them runc refuses to start Caddy ("failed to write sysctl ... operation not permitted"), which on a
recreate is an outage that `rollback()` would not reach. So `deploy.sh`, before compose touches
Caddy:

1. runs `modprobe tcp_bbr` and writes `/etc/modules-load.d/kangentic-relay.conf`;
2. adds `bbr` to the allowed list and writes `/etc/sysctl.d/90-kangentic-relay.conf` (systemd
   applies `sysctl.d` after `modules-load.d` at boot, so the order holds across a reboot);
3. starts a throwaway container with the exact Caddy image and sysctl, and stops the deploy, with
   the running Caddy untouched, if that fails.

`cloud-init.yaml` writes the same two files on new boxes. If Caddy ever fails to start with a
sysctl error after a reboot, check both `/proc/sys/net/ipv4/tcp_available_congestion_control` and
`/proc/sys/net/ipv4/tcp_allowed_congestion_control` for `bbr`.

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
and vars and pushes it, along with the Origin CA cert and key, before every deploy.

Rotating a value that lives in `.env` (a new `METRICS_TOKEN`) is just: update the GitHub secret,
then trigger a deploy (`workflow_dispatch` works if there is no code change to publish). The new
value changes the environment fingerprint, so that deploy recreates the relay rather than skipping.

**Rotating the Origin CA cert is just a deploy too.** Update the two GitHub secrets and run
`deploy.yml` via `workflow_dispatch`. `deploy.sh` fingerprints everything the running Caddy loaded
(the Caddyfile, the Cloudflare range list, and the Origin CA cert and key) and, when that
fingerprint changed, runs `caddy reload --force`, even on a deploy that otherwise skips the relay
restart. Two earlier bugs made this need a manual step, and both are fixed:

- **A plain `caddy reload` does not load a new cert.** Caddy skips a reload whose config is
  unchanged, and a rotated cert changes no config, since the `tls` directive names the same two
  file paths. `--force` is the documented way to reload "manually-loaded TLS certificates"
  ([Caddy CLI docs](https://caddyserver.com/docs/command-line)). Reproduced on Caddy 2.8.4: after
  swapping the cert files, a plain reload kept serving the old serial and a forced one served the
  new one.
- **The rotation deploy exited at the skip gate** before ever reaching the reload, because the
  cert lives in `/opt/relay/secrets`, not in `.env`, and moves no fingerprint the skip gate read.

Reloading only on a changed fingerprint is deliberate: a reload closes every proxied WebSocket
(`stream_close_delay` softens that, it does not avoid it), and it would land seconds after the relay
recreate had already dropped every session once. A failed reload now fails the run instead of being
swallowed. To reload by hand anyway, for example to rule Caddy out:

```
ssh deploy@<box> \
  "docker compose --env-file /opt/relay/.env -f /opt/relay/src/infra/compose/docker-compose.prod.yml exec -T caddy caddy reload --config /etc/caddy/compose/Caddyfile.prod --adapter caddyfile --force"
```

`<box>` is the server's own address, not either public hostname: both are proxied through
Cloudflare and do not accept SSH. To confirm which certificate Caddy is actually serving, compare
`echo | openssl s_client -connect 127.0.0.1:443 -servername relay.kangentic.com | openssl x509
-noout -serial` on the box with `openssl x509 -in /opt/relay/secrets/origin.crt -noout -serial`.

**Caddy reads its config through directory mounts, never single files.** A single-file bind mount
pins the inode it was created with, and `git checkout` replaces a file it updates with a new inode,
so the container went on reading the old copy, and every `caddy reload` re-read it too. On
2026-10-07 the box's Caddy was found serving the 2026-07-21 `Caddyfile.prod` (the drift happened
to be comment-only). The compose file now mounts `infra/compose` and `infra/cloudflare` as
directories, and Caddy runs `--config /etc/caddy/compose/Caddyfile.prod`.

## Deploy and rollback

A merge to `main` publishes an image (`latest`, `sha-<full sha>`) and stops there. **Only a
`vX.Y.Z` tag deploys**, so production always runs a released version with a changelog entry, and
`main` can carry merged-but-unreleased work. Cutting that tag is the board's Release column
(`/release`). All deploy logic lives in `scripts/deploy/deploy.sh`, run on the box over one SSH
call - a dropped runner connection cannot leave the server half-deployed, because the box
completes or reverts on its own.

For a deploy that is not a release - rolling back to a previous tag, redeploying the current one,
or the rollback drill - run `deploy.yml` directly via `workflow_dispatch` with an explicit
`image_tag`.

**Rollback target is a registry digest, never a tag.** Tags are mutable; a re-pushed tag would roll
back to the wrong bits. The digest is read from the currently running container
(`docker inspect --format '{{index .RepoDigests 0}}'`) before anything changes - that is reality,
not a hand-maintained file that could drift.

**The git ref to roll back to comes from `state/last_good`'s second line**, written after the last
successful deploy and therefore, by definition, the tree the running container was built from. A
container records no such thing, so there is no reality to read it off. `HEAD@{1}` ("HEAD before the
checkout the wrapper just did") is a fallback only, for a cold start with no `last_good` yet.

> `HEAD@{1}` used to be the primary source, and it is wrong whenever the wrapper's checkout is a
> no-op: **git writes no reflog entry when HEAD already points at the requested ref**, so redeploying
> the ref already on the box leaves `HEAD@{1}` pointing one deploy further back. The 2026-09-13
> rollback drill restored the 0.3.2 *image* onto the 0.3.1 *tree* for exactly this reason, and the
> same stale baseline made the skip check below always recreate on a same-ref redeploy instead of
> skipping. Both are fixed; `last_good` is no longer only an audit trail.

**The health gate is a conjunction of three conditions**, evaluated on the box over loopback: the
serving container id changed, its image digest matches what was just pulled, and both the Docker
healthcheck and a direct host probe on `127.0.0.1:8080` report healthy. The first condition alone
would pass against the old container still answering 200, which is why `/healthz` cannot be trusted
in isolation.

**A deploy that does change something recreates the relay container exactly once.** Caddy declares
`depends_on: [relay]`, so the `docker compose up -d caddy` that guarantees Caddy exists on a cold
start must pass `--no-deps`. Without it, that `up` pulls relay in as a dependency and recreates it
because `RELAY_IMAGE_REF` has just changed, and then the explicit `--force-recreate relay` recreates
it a second time - dropping every live session twice per deploy, silently. The 2026-09-13 rollback
drill made this visible: four relay containers, three recreates, one of which lived 70 ms. Do not
drop the `--no-deps`.

**A deploy that changes nothing skips the restart**, so a docs-only release does not drop every
live session for no reason. "Changes nothing" is a conjunction of three inputs, and the distinction
matters because a skipped deploy still reports success:

| Input | How it is detected |
|---|---|
| Image | `git diff` over `Dockerfile`, `.dockerignore`, `package.json`, `package-lock.json`, `tsconfig*.json`, `src` |
| Compose | `git diff` over `infra/compose` (mounts, `mem_limit`, ports are not build inputs but do change the running container) |
| Environment | `sha256` of `/opt/relay/.env` against `state/last_env_sha256` |

The environment needs its own fingerprint because the file is delivered out of band by the
workflow moments before `deploy.sh` runs and is deliberately not in git, so no `git diff` can see
it. Without that check, a deploy whose only change is a new variable skips the restart and reports
success while the container keeps running the previous configuration. The fingerprint is recorded
only after a successful deploy, so a rollback leaves the previous value in place and the next
attempt recreates rather than skipping.

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

**Test with a forged `X-Forwarded-For`, not `CF-Connecting-IP`.** Verified live against the real
Cloudflare edge: a client-supplied `CF-Connecting-IP` header gets rejected outright with a 403 by
Cloudflare itself, before the request ever reaches the origin - that header is not forgeable
through the public hostname at all, and attempting it only proves Cloudflare's own layer, not
Caddy's. `X-Forwarded-For` is not policed by Cloudflare (it appends to it rather than replacing
it), so a forged value does reach the origin, making it the one header that actually exercises the
forgery path Caddy is meant to close.

1. Temporarily set `MAX_CONNECTIONS_PER_IP=1` (push via `write-secret env`, or edit `.env` directly
   on the box and restart).
2. From one real client, through the public hostname, open one WebSocket connection normally and
   hold it open.
3. Attempt a second connection with a forged `X-Forwarded-For` header set to a different address.
4. If forgery works, both connections are admitted. If the design holds (Caddy's
   `header_up X-Forwarded-For {client_ip}` has overwritten the forged value before the relay ever
   sees it), the second is rejected (`503`) and `rejectsByReason.ip_cap` increments on `/metricz`.
5. Restore `MAX_CONNECTIONS_PER_IP` to `64`.

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

`logs caddy` is Caddy's runtime and error log. Its access log is a file on the `caddy_data`
volume, rolled at 25 MiB and kept about two weeks:
`docker compose -f infra/compose/docker-compose.prod.yml exec caddy cat /data/logs/access.log`.
Both are filtered: no slot id, no request headers, no client IP.

## Localizing a slow patch

When clients report multi-second stalls, find the leg first. The full method, and what it found on
2026-10-07, is in [`docs/latency.md`](../docs/latency.md). In short:

1. **Run [`scripts/legProbe.sh`](../scripts/legProbe.sh) on both ends over the same minutes.**
   `client <host>` from a workstation times the edge alone (`/cdn-cgi/trace`) against the full
   path (`/healthz`). `box <host>` on the server times Caddy-plus-relay and the relay alone, and
   records TCP retransmit and timeout deltas from Caddy's network namespace every 10 s. The box
   copy of the repo may predate the script; piping it in works:
   `ssh deploy@<box> "bash -s box relay.kangentic.com 600" < scripts/legProbe.sh`.
2. **Read the answer off the timestamps.** Origin slow with edge, caddy and relay flat is the
   Cloudflare-to-origin leg. Caddy slow with relay flat is Caddy. Relay slow is the relay or the VM.
3. **If it is the relay or the VM, the `/admin` Table view says which.** For the stall minute:
   loop max high with GC max high is the runtime; with PSI high it is the host starving the
   process; with low CPU, no GC and no PSI it is the hypervisor pausing the VM. Hetzner's shared
   vCPU does not report steal (it reads 0 by construction), so that last case has no direct counter.
4. **To follow one connection end to end**, `CONNECTION_TRACE` logs a line per connection keyed by
   CF-Ray (`docker compose ... logs relay | grep '"connection trace"'`), and Caddy's access log
   carries the same `cf_ray` with `upstream_latency_ms`.

## Cloudflare Tunnel A/B

An opt-in experiment for comparing the public-origin path with a Cloudflare Tunnel, should the
Cloudflare-to-origin leg stay the problem. It runs a second hostname through `cloudflared`'s
outbound connections into Caddy's internal `:8081` site, so both hostnames cross the same Caddy and
relay and only that one leg differs. Nothing starts it by default: it is the `tunnel-ab` compose
profile, and `deploy.sh` never names it. No Cloudflare doc claims a tunnel lowers WebSocket latency,
which is exactly why it is measured rather than adopted.

1. In the Cloudflare dashboard, create a remotely managed tunnel and a public hostname for it (for
   example `relay-tunnel-ab.kangentic.com`) whose service is `http://caddy:8081`. Do not create an
   Access application for it; see the next step instead.
2. **Never let it serve `/admin`.** Production runs `ADMIN_ENABLED=true` gated only by the Access
   application on the two main hostnames, and the A/B hostname has none. Caddy's `:8081` site
   answers `/admin*` with a 404 before proxying anything, so this holds without relying on the
   dashboard. Check it once live: `curl -s -o /dev/null -w '%{http_code}' https://<ab host>/admin`
   must print `404`.
3. Place the token on the box by hand, outside `.env` (that file is the relay's environment, and the
   relay has no business holding a tunnel credential), readable by cloudflared's non-root user:
   `install -m 0644 /dev/stdin /opt/relay/secrets/tunnel-token` with the token on stdin.
4. Start it: `docker compose --env-file /opt/relay/.env -f /opt/relay/src/infra/compose/docker-compose.prod.yml --profile tunnel-ab up -d cloudflared`.
   A deploy's `--remove-orphans` may remove it; start it again after each deploy for as long as the
   experiment runs.
5. Measure both hostnames over the same minutes, several times a day for a week:
   `scripts/legProbe.sh client relay.kangentic.com 600` and the same against the A/B hostname, plus
   `scripts/burstProbe.mjs` against each. Compare p50, p99, and samples over 0.25 s.
6. Tear down: `docker compose ... --profile tunnel-ab stop cloudflared`, delete the tunnel and its
   DNS record, and remove `/opt/relay/secrets/tunnel-token`.

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

## The `/admin` dashboard and its volume

`ADMIN_ENABLED=true` serves a private dashboard at `/admin` on the same listener and the same
hostname as the WebSocket endpoint. The relay does **not** authenticate it. A Cloudflare Access
self-hosted application is the gate, scoped to the admin paths and never to the whole host.

**Scoping this wrong is an immediate outage.** The relay serves the WebSocket upgrade on `/` on
that same hostname, so an Access application covering the bare host would put a login page in
front of every client. `monitor.yml` runs `scripts/deploy/synthetic-pair.mjs` every 30 minutes,
which opens two real sockets to one slot and asserts a byte-identical round trip through Caddy and
Cloudflare, so it catches exactly this failure. Watch that run after any Access change. To check
by hand:

```
RELAY_URL=wss://relay.kangentic.com node scripts/deploy/synthetic-pair.mjs
```

### Two traps when configuring the application

**A bare path does not cover its subpaths.** Cloudflare matches `example.com/alpha/*` against
`/alpha/one` but *not* against `/alpha` itself, and a path of `alpha` does not reach `/alpha/one`.
So `admin` alone protects the page while leaving `/admin/data` (a year of history) open, and
`admin/*` alone does the reverse. **Both entries are required.**

**Both public hostnames reach the relay.** `relay.kangentic.com` is a proxied CNAME to
`relay-ashburn-us-east.kangentic.com`, and `Caddyfile.prod`'s single site block serves both. An
application covering only the CNAME leaves the region name ungated. The full set is four
domain-and-path entries:

| Hostname | Path |
|---|---|
| `relay.kangentic.com` | `admin` |
| `relay.kangentic.com` | `admin/*` |
| `relay-ashburn-us-east.kangentic.com` | `admin` |
| `relay-ashburn-us-east.kangentic.com` | `admin/*` |

The Access session cookie is set per hostname, so signing in on one name does not authorize the
other. That is fine; it just means the login prompt appears once per hostname used.

The policy is a single **Allow** with two Include rules, which Cloudflare ORs together: *Emails
ending in* `@kangentic.com`, plus an *Emails* rule naming the maintainer's personal address as a
fallback. The fallback exists deliberately: the domain rule is worthless if no `@kangentic.com`
mailbox can receive the one-time PIN, and locking the only operator out of the dashboard is a
worse failure than a slightly wider allow list. Drop the fallback once domain mail is confirmed.

`Cf-Access-Authenticated-User-Email` is
treated as display-only and is never an authorization input: the header is trivially forgeable by
anyone who reaches the origin directly, so trusting it would be theater. The real boundary is the
Hetzner firewall restricting 80/443 to Cloudflare ranges, plus Caddy's strict Host matching and
origin certificate. If stronger is ever wanted, the correct mechanism is verifying the Access JWT
against Cloudflare's public keys, not checking for a header.

### What survives, and what does not

History lives on the **named** Docker volume `relay_history`, mounted at `/var/lib/relay`. Named,
not a host bind mount, because the container runs `USER node` and a bind mount arrives root-owned:
the relay could not write it, and the failure would appear in production only while every local
test passed. The Dockerfile creates and chowns the directory before dropping to `node`, so the
volume inherits the right ownership on first creation.

| Event | History |
|---|---|
| Deploy (`deploy.sh`, `up -d --force-recreate relay`) | **Survives.** Nothing in the deploy path runs `down -v`. |
| Rollback (same recreate with the previous digest) | **Survives.** |
| `docker image prune -af` after a successful deploy | **Survives.** Image prune does not touch volumes. |
| `docker compose down` without `-v` | **Survives.** |
| `docker compose down -v`, or `docker volume rm relay_history` | **Lost.** |
| A `provision.sh` server rebuild | **Lost.** Accepted: the relay is deliberately single-instance because the slot table is in-process memory, so there is no second box holding a copy. |

Verify the volume and its ownership on the box:

```
docker volume inspect relay_history
docker compose -f infra/compose/docker-compose.prod.yml exec relay ls -la /var/lib/relay
```

The second command must show the file owned by `node`. Root ownership means the chown step is
missing from the running image, and the relay is recording nothing.

Retention is tiered automatically (1-minute rows for 7 days, 5-minute for 30 days, hourly for a year),
which settles at roughly 25k rows and a few MB. Compaction runs at most hourly and rewrites through
a temp file, so a crash cannot destroy the original. It shares one serialized queue with the sample
appends, which means a slow compaction can delay the next sample write by tens of milliseconds; it
never touches a forwarded frame. If the file cannot be written at all the relay keeps running and
falls back to an in-memory ring, `/metricz` reports `historyRecorderHealthy: false`, and the
dashboard shows a banner.

If compaction itself keeps failing while appends keep succeeding, the file grows at fine resolution
because the row ceiling is only applied during a successful compaction. The usual cause is another
process holding a read handle on the file (a backup or antivirus agent). The relay cannot break
that lock, so after three consecutive failures it stops logging a warning and logs an error naming
the condition. Treat that error as "investigate what has the file open", not as a relay fault.

**Gauges are point samples.** `activeConnections` and friends are read once per interval, so a
spike that rises and falls between two ticks is invisible, and an aggregated bucket's maximum is
the largest sample taken rather than a true peak. Sampling faster is what the performance budget
rules out.

### Reading it during an incident

The dashboard is built around five questions. Roughly in the order worth checking:

1. **Are we near a ceiling?** Every capacity tile shows a percentage of its configured cap, badged
   at 60% and 80%. Connections against `MAX_CONNECTIONS`, resident memory against the container
   limit, and the slowest consumer's queue against `MAX_BUFFERED_BYTES`.
2. **Is the relay itself struggling, or is it the network?** Event loop delay p99 above roughly
   50 ms delays every forward, and that is the relay. Deep outbound queues with a healthy event
   loop is the opposite: the relay is fine and a consumer's downlink is not.
3. **Is anyone backing up before it becomes a teardown?** "Outbound queue depth" is the warning
   that "Abnormal teardowns / backpressure" is the postmortem of.
4. **Are clients failing to pair, and which side?** Read "Waiting peers by reported role" first.
   A desktop parked alone is the normal resting state of every online desktop, so a steady non-zero
   desktop count is healthy idle; *phones* waiting, or desktops in numbers beyond the desktops you
   know are online, is the signal worth chasing. "Sockets that paired" is the same question as a
   rate, and it sits near zero on an idle relay for exactly that reason, so read it against the
   connection rate rather than against 100%. Roles are self-declared by the client and never
   verified, and a client that sends none is counted as unknown.
5. **What changed?** Restart markers are dashed vertical rules. "Average frame size" separates a
   change in traffic shape from a change in traffic volume.

The `Live` range is a 15-minute window at the page's own 2-second poll resolution, seeded from
history so it is full immediately. It is derived in the browser and never persisted, so it costs
the relay nothing and does not survive a reload.

Counts are plotted as rates per minute rather than raw per-interval counts, because retention is
tiered: an hourly row holds twelve times the count of a 5-minute row for identical traffic, and a
raw count would step at every tier boundary. The table view keeps raw counts on purpose, since it
carries a resolution column that states the span.

## Traffic budget

`bytesForwardedTotal` resets to zero on every process restart, so a naive scrape undercounts. Sample
it alongside `uptimeSeconds` every 15-30 minutes, treat a decrease in `uptimeSeconds` as a restart
boundary, and sum deltas across boundaries for a month-to-date estimate. (The `/admin` recorder
already does exactly this in process, storing per-interval deltas and marking restart boundaries,
so its byte chart is correct across deploys. The guidance here still stands for any external
scraper, including `monitor.yml`.) The counter is payload
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
- **Narrowing SSH to GitHub's runner ranges** - GitHub publishes them, but the list runs to
  thousands of CIDRs and exceeds Hetzner's per-firewall rule limits. Mitigated by key-only auth and
  fail2ban instead.
