# Deployment architecture

This describes how a commit becomes a running instance: the publish pipeline, the deploy
mechanics, and the infrastructure a hosted instance runs on. For the step-by-step operator
runbook (secrets, provisioning, troubleshooting), see `infra/README.md`. For the self-hosting
quickstart, see the root `README.md`.

## Pipeline shape

```
pull_request  -> ci.yml        -> checks.yml (reusable: lint, typecheck, unit x2, integration)
                                -> docker-build (build + /healthz smoke, never pushed)

push to main
or v* tag     -> release.yml   -> checks.yml (same reusable job set)
                                -> image        (build, push to GHCR, attest provenance)
                                -> gh-release   (tag pushes only: create the GitHub release)
                                -> deploy       (uses: deploy.yml, environment: production)
```

`checks.yml` exists so `release.yml` can gate publishing on CI with a plain `needs:` rather than
a `workflow_run` trigger. `workflow_run` reads the reusable workflow's body from the *default
branch* rather than the triggering commit, points `github.sha` at the wrong commit, and never
surfaces as a commit status — all real problems for a gate that decides whether to publish and
deploy.

`deploy.yml` is invoked as a called job (`uses:`) from `release.yml`, never via a
`release: published` trigger. GitHub suppresses workflow cascades raised by the default
`GITHUB_TOKEN`, so a release created by the `gh-release` job would silently never fire that
trigger — there is no error, the workflow just never runs.

## Image tags

| Tag | When |
|---|---|
| `latest` | Every merge to `main` |
| `sha-<full 40-hex sha>` | Every merge to `main` |
| `vX.Y.Z`, `X.Y` | Every `vX.Y.Z` tag push |

No bare `{{major}}` tag while pre-1.0 — a `0` tag spanning every 0.x release would be a footgun.
`latest` tracks the tip of `main`, not the newest release; self-hosters who want a stable pin
should use a `vX.Y.Z` tag, not `latest`.

Deploys always target an immutable tag (`sha-<full>` or `vX.Y.Z`), never `latest` — this
guarantees a re-deploy of the same code still causes Docker to recreate the container, which the
health gate's "container identity changed" check depends on.

## The deploy mechanism

The runner resolves the target box by Hetzner **label** (`project=relay,env=production`), not a
numeric server ID, then makes exactly one restricted SSH call. Everything past that point runs
**on the box**, inside `scripts/deploy/deploy.sh` — a dropped runner connection cannot leave the
server half-deployed, because the box completes or reverts on its own.

```
deploy.yml (runner)
  -> resolve server by Hetzner label
  -> push .env + Origin CA cert/key over SSH (write-secret verb)
  -> ssh ... deploy <image-tag> <git-ref> <drill-mode>
       (ci-deploy-wrapper.sh, forced command, no shell/pty/port-forward)
       -> git fetch --tags && git checkout <git-ref>
       -> exec scripts/deploy/deploy.sh <image-tag> <drill-mode>
            -> skip check (git diff against the previous deploy's ref)
            -> compose pull
            -> compose up -d caddy          (idempotent: only starts if missing)
            -> compose up -d --force-recreate relay   (scoped to relay only)
            -> health gate (up to 60s)
            -> on failure: rollback to the previous digest
            -> on success: write state/last_good, prune old images
```

### The health gate

`/healthz` alone cannot verify a deploy — it returns 200 unconditionally, including from a
container that was never replaced. The gate (`wait_for_gate` in `deploy.sh`) is a conjunction of
three conditions, polled every 2s for up to 60s:

1. The serving container's ID differs from the one running before this deploy.
2. Its image resolves to the exact digest that was just pulled (`container_digest()`: container
   ID -> image ID via `docker inspect`, then image ID -> repo digest via `docker image inspect` —
   `docker inspect` on a *container* has no `.RepoDigests` field at all, only images do).
3. Both the Docker healthcheck reports `healthy` *and* a host-side `curl` to
   `127.0.0.1:8080/healthz` (bypassing Caddy and Cloudflare entirely) returns
   `"status":"ok"`.

No application code change was needed to make this work — deliberately, to avoid dragging a
build-sha endpoint through `docs-stay-in-sync`'s anchor rule for no real benefit.

### Rollback

The rollback target is a **registry digest, never a tag** — tags are mutable, so a rollback keyed
on a tag could restore the wrong bits if that tag was ever re-pushed. The previous digest is read
from the container that's *actually running* right before the new deploy touches anything
(`container_digest()` again), and the previous git ref comes from git's own reflog
(`HEAD@{1}` — "HEAD before the checkout the wrapper just did"). Both are reality, not a
hand-maintained file that could drift out of sync.

`state/last_good` is written only *after* a gate passes, as an audit trail and a cold-start
fallback — never the primary source for an active rollback decision.

### Skip when unchanged

Before pulling anything, `deploy.sh` runs `git diff --quiet` between the previously deployed git
ref and the current `HEAD`, scoped to the exact paths the Dockerfile reads (`Dockerfile`,
`.dockerignore`, `package.json`, `package-lock.json`, `tsconfig*.json`, `src`). If none of them
changed and this isn't a drill, it exits immediately without pulling or touching the container. A
docs-only merge (markdown, `infra/`, `scripts/deploy/deploy.sh` itself, workflow YAML - none of
which affect the built image) then correctly skips, so a documentation change doesn't drop every
live session for no reason.

This is **not** decided by comparing image digests, and that distinction matters: the original
design did exactly that, and it does not work. `docker/metadata-action`'s default labels include
`org.opencontainers.image.created`, a build timestamp baked into every image's config, so two
builds from byte-identical source still produce two different digests. Confirmed live: two
docs-only deploys in a row both recreated the container with a fresh digest instead of skipping,
before this was caught and fixed. Diffing the actual source inputs is the signal that is actually
true to "would rebuilding produce different application behavior," independent of whether Docker's
own build is reproducible.

### Proving rollback: the drill

`deploy.yml` accepts a `drill` input (`workflow_dispatch`) that deploys the real, currently-good
image with a deliberately broken compose overlay layered on top:

- **`healthcheck`**: forces the Docker healthcheck to fail outright.
- **`port`**: sets `PORT=9099` inside the container. The container's *own* healthcheck (which
  honors `$PORT`) still reports healthy, but the host-side curl on the fixed published port fails
  — this exercises the gate's other conjunct independently, since one drill can only prove one
  branch of an AND.

Either way, the gate fails, rollback restores the previous digest, and the workflow exits red —
nothing broken ever reaches GHCR, and nothing broken stays running.

## Production topology

```
client --wss--> Cloudflare (proxy, TLS, DDoS absorption)
                    |  Hetzner firewall: 80/443 restricted to Cloudflare's published ranges
                    v
                Hetzner box
                    |
                  Caddy (80/443, Origin CA TLS, header normalization)
                    |  internal `edge` bridge network only, pinned subnet
                    v
                 relay (127.0.0.1:8080 on the host, for deploy.sh's own health probe)
```

### Why the relay never trusts Cloudflare's IP ranges directly

`TRUSTED_PROXY_CIDRS` in production is the Docker `edge` network's pinned subnet — **not**
Cloudflare's published ranges. The relay's socket peer is always Caddy's container address, never
Cloudflare's edge directly, so pointing `TRUSTED_PROXY_CIDRS` at Cloudflare's ranges would make
every real connection fail the trust check and collapse `MAX_CONNECTIONS_PER_IP` into a single
shared bucket.

Caddy, in turn, **overwrites** both `CF-Connecting-IP` and `X-Forwarded-For` on every proxied
request (`header_up ... {client_ip}`, no `+`/`-` prefix — a bare field name replaces rather than
appends). This matters because Cloudflare itself *appends* to `X-Forwarded-For` rather than
replacing it, so a client-forged `X-Forwarded-For: 1.2.3.4` would otherwise arrive as the
leftmost, attacker-controlled hop. The relay's own fallback parsing (`src/net/clientIp.ts`) now
walks `X-Forwarded-For` from the rightmost untrusted hop rather than the leftmost, so that
forgery would be skipped even without Caddy's overwrite - Caddy's rewrite here is defense in
depth, not the only thing standing between a forged header and a bypassed per-IP cap.

The Hetzner firewall is what makes any of this meaningful rather than cosmetic: without it,
anyone who learned the origin IP could bypass Cloudflare (and therefore Caddy's header rewriting)
entirely and forge headers directly against the relay.

**Verified against the real Cloudflare edge, not just the design intent**: attempting to set a
client-supplied `CF-Connecting-IP` header through Cloudflare gets rejected outright with a 403
before the request ever reaches the origin - Cloudflare enforces this itself, as a layer
independent of anything Caddy or this relay do. A forged `X-Forwarded-For`, which Cloudflare does
not police, does reach the origin - and Caddy's overwrite of it was the thing actually tested:
holding one connection open and attempting a second with a different forged `X-Forwarded-For`
correctly tripped `MAX_CONNECTIONS_PER_IP` (`rejectsByReason.ip_cap` incremented on `/metricz`),
proving the real client identity was resolved correctly despite the forged header, not the forged
value. See `infra/README.md`'s post-deploy security gate for the exact procedure.

### Every hostname a box serves needs its own Caddy site match

Caddy routes by Host header matching one of a site block's own configured addresses. Pointing DNS
at a box (a CNAME, in this case `relay.kangentic.com` aliasing the region-qualified
`relay-ashburn-us-east.kangentic.com`) does not by itself make Caddy accept that Host - DNS
resolution and HTTP-layer routing are unrelated. This shipped once as a real bug: the CNAME
TLS-handshook fine (the Origin CA cert is a `*.kangentic.com` wildcard, so certificate selection
never failed) but got a `200` with an empty body on every single request, since nothing at the
HTTP layer matched. `infra/compose/Caddyfile.prod`'s site block now lists both
`RELAY_HOSTNAME` and `RELAY_HOSTNAME_ALIAS` explicitly; adding a further alias (or a second
region's box reusing this same file) means adding it to that address line too.

A related trap when applying this kind of fix by hand: `RELAY_HOSTNAME_ALIAS` is a
compose-level `environment:` value on the `caddy` service, baked into the container at creation
time. `caddy reload` (which the deploy's success path runs automatically, to pick up Caddyfile
*content* changes) re-parses the Caddyfile but does not change the running process's environment -
picking up a new or changed env var needs the container actually recreated
(`docker compose up -d --force-recreate --no-deps caddy`), not just reloaded.

### Provisioning

`infra/hetzner/provision.sh` is an idempotent shell script (describe-then-create for every
resource) wrapping the `hcloud` CLI directly rather than a bespoke API client — the project's
whole identity is one runtime dependency (`ws`), and a self-hoster should be able to read the
provisioning path top to bottom. `infra/hetzner/cloud-init.yaml` is fully static and committed
with **no secrets in it** (Hetzner instance metadata is readable from inside the box, so
user-data is treated as public). It installs Docker, unattended-upgrades, SSH hardening, fd
limits, and a forced-command SSH wrapper for the ci-deploy key.

Secrets (the `.env` content, the Origin CA cert/key) reach the box over SSH via a second forced
command verb, `write-secret <name>`, restricted to a three-entry allowlist
(`env` / `origin-cert` / `origin-key`) so it cannot become a path-traversal write-anywhere
primitive. `deploy.yml` pushes all three on every deploy, which is also how a rotated
`METRICS_TOKEN` or a renewed Origin CA cert reaches the box — no separate delivery mechanism.

### Monitoring

Two layers, deliberately split by what a free-tier external uptime service can and can't do:

- An external SaaS polls `/healthz` on both the region-qualified hostname and the short CNAME
  (catching a CNAME or proxy misconfiguration independently), matching on response body content
  rather than status code alone, and is **not** given the metrics token.
- A scheduled `monitor.yml` workflow holds the credential the SaaS can't: it asserts `/metricz`
  fields and runs a synthetic pairing probe (two WebSocket connections round-tripping a byte
  through a real slot) — the only check that proves pairing actually works end to end, since
  `/healthz` says nothing about whether the WS upgrade routes correctly through Caddy and
  Cloudflare.

`monitor.yml` runs in a separate, **unprotected** `monitoring` GitHub environment, deliberately:
putting it on the protected `production` environment would queue every scheduled run for approval
forever.

## See also

- `infra/README.md` — the operator runbook: secrets/variables tables, first-provision steps,
  troubleshooting, reading `closedByCause`, traffic-budget checks, Cloudflare range rotation.
- `infra/cloudflare/origin-ca.md` — minting and rotating the Origin CA certificate.
- [architecture.md](architecture.md) — how the relay process itself works, independent of how it's
  deployed.
