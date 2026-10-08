#!/usr/bin/env bash
# Runs ON THE BOX, invoked by /opt/relay/bin/ci-deploy-wrapper.sh after it
# has already `git checkout`ed the target ref. Everything from here on is
# atomic from the runner's point of view: a dropped SSH connection after
# this point cannot leave the box half-deployed and unverified, because
# this script owns the health gate and the rollback both.
#
# Usage: deploy.sh <image-tag> [drill-mode]
#   image-tag   a tag published by release.yml, e.g. sha-<full sha> or
#               vX.Y.Z. Never `latest` - deploys are always by an
#               immutable tag, so once the skip gate below has decided
#               something actually changed, the recreate is guaranteed to
#               produce a new container, which the health gate's
#               "container identity changed" check depends on. A redeploy
#               that changes nothing exits at the skip gate instead and
#               never reaches the health gate at all.
#   drill-mode  none (default) | healthcheck | port - see
#               infra/compose/docker-compose.drill-*.yml and
#               infra/README.md.
set -euo pipefail

image_tag="${1:?usage: deploy.sh <image-tag> [drill-mode]}"
drill="${2:-none}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="$repo_root/infra/compose/docker-compose.prod.yml"
env_file="/opt/relay/.env"
secrets_dir="/opt/relay/secrets"
state_dir="/opt/relay/state"
last_good_file="$state_dir/last_good"
last_env_file="$state_dir/last_env_sha256"
last_caddy_file="$state_dir/last_caddy_sha256"
caddy_config_path="/etc/caddy/compose/Caddyfile.prod"

drill_args=()
case "$drill" in
  none) ;;
  healthcheck) drill_args=(-f "$repo_root/infra/compose/docker-compose.drill-healthcheck.yml") ;;
  port) drill_args=(-f "$repo_root/infra/compose/docker-compose.drill-port.yml") ;;
  *) echo "unknown drill mode: $drill" >&2; exit 1 ;;
esac

compose() {
  docker compose --env-file "$env_file" -f "$compose_file" "${drill_args[@]}" "$@"
}

# Exported before ANY compose() call, including the "previous container"
# lookup below. docker-compose.prod.yml's services.relay.image requires
# RELAY_IMAGE_REF via ${RELAY_IMAGE_REF:?...}, and `docker compose`
# interpolates every service's fields to parse the file at all - even a
# `compose ps` scoped to one service fails outright (empty output, not
# just a warning) if a DIFFERENT service's required variable is unset.
# Exporting late here previously meant prev_container_id and prev_digest
# were silently always empty, which meant the skip-when-unchanged
# optimization never triggered and rollback never had a real target.
export RELAY_IMAGE_REF="ghcr.io/kangentic/relay:$image_tag"

# `docker inspect <container>` has no .RepoDigests field at all - that is
# an IMAGE-level field, not a container one (docker inspect on a container
# ID returns "map has no entry for key RepoDigests" if asked for it
# directly). Resolving a container to its repo digest is two steps:
# container -> image ID (.Image), then image ID -> .RepoDigests.
container_digest() {
  local container_id="$1" image_id
  image_id="$(docker inspect "$container_id" --format '{{.Image}}' 2>/dev/null || echo "")"
  [ -z "$image_id" ] && return 0
  docker image inspect "$image_id" --format '{{index .RepoDigests 0}}' 2>/dev/null || true
}

install -d -m 0755 "$state_dir"

# Everything the running Caddy has loaded that can change without Caddy
# being recreated: its config, the Cloudflare ranges it imports, and the
# Origin CA cert and key (write-secret replaces those independently of any
# image deploy). Fingerprinted like the env file, because a reload is only
# worth its cost when one of these actually changed.
caddy_inputs_sha256() {
  cat "$repo_root/infra/compose/Caddyfile.prod" "$repo_root/infra/cloudflare/trusted-proxies.caddy" \
    "$secrets_dir/origin.crt" "$secrets_dir/origin.key" | sha256sum | cut -d ' ' -f 1
}

record_caddy_fingerprint() {
  printf '%s\n' "$1" > "$last_caddy_file.tmp"
  chmod 0644 "$last_caddy_file.tmp"
  mv "$last_caddy_file.tmp" "$last_caddy_file"
}

# Reloads Caddy when, and only when, its inputs changed since it last loaded
# them. Two things make both halves of that necessary:
#
#  - --force. Caddy compares the new config to the running one and skips a
#    reload whose config is identical, and a rotated cert changes no config:
#    the tls directive names the same two file paths. Without --force a
#    rotation reported green and Caddy kept serving the old cert. Caddy's own
#    docs name this case: "--force will cause a reload to happen even if the
#    specified config is the same", "for example: reloading manually-loaded
#    TLS certificates" (https://caddyserver.com/docs/command-line).
#
#  - only on change. A reload closes every proxied WebSocket (softened by
#    stream_close_delay, not avoided), and this runs moments after the relay
#    recreate has already dropped every session once and clients have just
#    reconnected. Forcing a reload on every deploy would drop them all a
#    second time - the double drop the --no-deps note below exists to stop.
#
# Fails loudly rather than reporting green over a Caddy still serving old
# inputs, and records the fingerprint only once a reload succeeded.
reload_caddy_if_inputs_changed() {
  local current recorded
  current="$(caddy_inputs_sha256)"
  recorded="$(cat "$last_caddy_file" 2>/dev/null || echo "")"
  if [ "$current" = "$recorded" ]; then
    echo "caddy inputs unchanged since the last load, no reload"
    return 0
  fi
  if [ -z "$(compose ps -q caddy || true)" ]; then
    echo "caddy inputs changed but caddy is not running - nothing loaded them" >&2
    return 1
  fi
  echo "caddy inputs changed (config, Cloudflare ranges, or Origin CA cert/key), forcing a reload"
  if ! compose exec -T caddy caddy reload --config "$caddy_config_path" --adapter caddyfile --force; then
    echo "caddy reload FAILED - the running Caddy keeps its previous config and certificate" >&2
    return 1
  fi
  record_caddy_fingerprint "$current"
}

# The Caddy service sets net.ipv4.tcp_congestion_control=bbr in its own network
# namespace (docker-compose.prod.yml). The kernel accepts that only when two
# host conditions hold, and a container can create neither:
#
#  - the tcp_bbr module is loaded. Ubuntu builds it as a module, and a
#    container cannot load one.
#  - bbr is on net.ipv4.tcp_allowed_congestion_control. A namespace other than
#    the host's may only default to an algorithm on that list ("Only init
#    netns can set default to a restricted algorithm", net/ipv4/tcp_cong.c),
#    and the stock list is just the host default plus reno: "reno cubic".
#
# Miss either and runc refuses to start Caddy ("failed to write sysctl ...
# operation not permitted"), and a recreate that cannot start is an outage
# that rollback() would not even reach, since only the relay's health gate
# triggers it. So both are set here and persisted (modules-load.d, then
# sysctl.d, which systemd applies after modules at boot), and then a
# throwaway container proves the exact image and sysctl start before compose
# touches the real Caddy. Any failure stops the deploy (set -e) with the
# running Caddy untouched. `sudo -n` fails at once rather than waiting on a
# prompt.
ensure_caddy_can_run_bbr() {
  local modules_load_file="/etc/modules-load.d/kangentic-relay.conf"
  local sysctl_file="/etc/sysctl.d/90-kangentic-relay.conf"
  local allowed image caddy_image=""
  if ! grep -qw bbr /proc/sys/net/ipv4/tcp_available_congestion_control; then
    sudo -n modprobe tcp_bbr
  fi
  if ! grep -qx tcp_bbr "$modules_load_file" 2>/dev/null; then
    echo tcp_bbr | sudo -n tee "$modules_load_file" >/dev/null
  fi

  allowed="$(cat /proc/sys/net/ipv4/tcp_allowed_congestion_control)"
  case " $allowed " in
    *" bbr "*) ;;
    *)
      allowed="$allowed bbr"
      sudo -n sysctl -q -w "net.ipv4.tcp_allowed_congestion_control=$allowed"
      ;;
  esac
  if ! grep -qxF "net.ipv4.tcp_allowed_congestion_control = $allowed" "$sysctl_file" 2>/dev/null; then
    echo "net.ipv4.tcp_allowed_congestion_control = $allowed" | sudo -n tee "$sysctl_file" >/dev/null
  fi

  for image in $(compose config --images); do
    case "$image" in caddy:*) caddy_image="$image" ;; esac
  done
  if [ -z "$caddy_image" ]; then
    echo "preflight: no caddy image in the compose file" >&2
    return 1
  fi
  if ! docker run --rm --network none --entrypoint true \
    --sysctl net.ipv4.tcp_congestion_control=bbr "$caddy_image"; then
    echo "preflight: $caddy_image cannot start with BBR on this host - the running Caddy is untouched" >&2
    return 1
  fi
}

# The previous image digest comes from reality - the container actually
# running right now - and not from a file that could drift.
prev_container_id="$(compose ps -q relay || true)"
prev_digest=""
if [ -n "$prev_container_id" ]; then
  prev_digest="$(container_digest "$prev_container_id")"
fi

# The previous git ref has no equivalent in reality: a container does not
# record the tree it was deployed from. So it comes from state/last_good's
# second line, written only after a SUCCESSFUL deploy and therefore by
# definition the ref the running container was built from.
#
# HEAD@{1} ("HEAD before the checkout the wrapper just did") is the fallback
# only, because it is WRONG whenever that checkout was a no-op: git writes no
# reflog entry when HEAD already points at the requested ref, so redeploying
# the ref already on the box leaves HEAD@{1} pointing one deploy further back.
# The 2026-09-13 rollback drill hit exactly this and restored the 0.3.2 image
# onto the 0.3.1 tree. It also made the skip-when-unchanged check below
# compare against the wrong baseline, so a redeploy of unchanged code always
# recreated instead of skipping.
prev_git_ref=""
if [ -r "$last_good_file" ]; then
  recorded_git_ref="$(sed -n '2p' "$last_good_file" 2>/dev/null || echo "")"
  if [ -n "$recorded_git_ref" ] \
    && git -C "$repo_root" rev-parse --verify --quiet "${recorded_git_ref}^{commit}" >/dev/null; then
    prev_git_ref="$recorded_git_ref"
  fi
fi
if [ -z "$prev_git_ref" ]; then
  prev_git_ref="$(git -C "$repo_root" rev-parse "HEAD@{1}" 2>/dev/null || echo "")"
fi

echo "deploying image_tag=$image_tag drill=$drill (previous digest: ${prev_digest:-none})"

# The environment file is delivered out of band by the workflow moments
# before this script runs and is deliberately not in git, so the git diff
# below is blind to it. Fingerprint its content instead. Without this, a
# deploy whose only change is a new variable in /opt/relay/.env skips the
# restart, reports success, and leaves the container running the previous
# configuration - a green deploy that changed nothing, which is the most
# expensive kind of silent failure this script can produce.
env_sha256="$(sha256sum "$env_file" | cut -d ' ' -f 1)"
prev_env_sha256="$(cat "$last_env_file" 2>/dev/null || echo "")"

# Skip entirely when nothing that affects the RUNNING CONTAINER changed
# between the previous deploy and this one. This is NOT decided by
# comparing image digests (that was the original design and it does not
# work): docker/metadata-action's default labels include
# org.opencontainers.image.created, a build timestamp baked into every
# image's config, so two builds from byte-identical source still produce
# different digests. Comparing the actual inputs is the real signal - a
# docs-only merge (markdown is excluded by .dockerignore, but git diff does
# not consult that) touches none of these paths, and recreating the
# container for no reason would drop every live session pointlessly.
#
# Three classes of input, and all three have to be here. The image is built
# from the first list. The compose file is not a build input at all, but it
# decides mounts, limits and ports, so a volume or mem_limit change must
# recreate. The env file is neither, and is handled above.
if [ "$drill" = "none" ] && [ -n "$prev_container_id" ] && [ -n "$prev_git_ref" ] \
  && [ "$env_sha256" = "$prev_env_sha256" ]; then
  if git -C "$repo_root" diff --quiet "$prev_git_ref" HEAD -- \
    Dockerfile .dockerignore package.json package-lock.json tsconfig.json tsconfig.build.json src \
    infra/compose
  then
    echo "no build-relevant, compose or env changes since $prev_git_ref, skipping restart"
    # The relay is untouched, but the deploy that only delivers a rotated
    # Origin CA cert, or a refreshed Cloudflare range list, lands right
    # here. Before this check a rotation exited at the skip gate and the
    # running Caddy kept the old cert until someone reloaded it by hand.
    reload_caddy_if_inputs_changed
    exit 0
  fi
fi

compose pull

new_digest="$(docker image inspect "$RELAY_IMAGE_REF" --format '{{index .RepoDigests 0}}')"

rollback() {
  echo "health gate failed, rolling back" >&2
  docker logs --tail 200 "$(compose ps -q relay || true)" 2>&1 | tail -200 || true

  if [ -z "$prev_digest" ]; then
    echo "no previous deployment to roll back to (this was the first deploy) - leaving the failed state for investigation" >&2
    exit 1
  fi

  if [ -n "$prev_git_ref" ]; then
    git -C "$repo_root" checkout --quiet "$prev_git_ref"
  fi

  export RELAY_IMAGE_REF="$prev_digest"
  # Never re-run a drill overlay during rollback - the point is to restore
  # the last known-good state, not to re-trigger the failure.
  drill_args=()
  compose up -d --force-recreate --remove-orphans relay

  # Put Caddy back on the restored tree's definition too. If this deploy
  # recreated Caddy (a changed mount, command or sysctl), the checkout above
  # has just swapped the files under the NEW container: it keeps serving from
  # memory, but its next restart (a reboot, a crash) would read a config
  # written for a different container and could fail to start at all. `up`
  # is a no-op when the definition did not change, so this costs nothing on
  # an ordinary rollback.
  compose up -d --no-deps caddy

  if ! wait_for_gate "$prev_container_id" "$prev_digest"; then
    echo "rollback itself failed the gate - manual intervention required" >&2
    exit 1
  fi

  echo "rolled back to $prev_digest ($prev_git_ref)"
  exit 1
}

wait_for_gate() {
  local baseline_container_id="$1" want_digest="$2"
  local waited=0
  while [ "$waited" -lt 60 ]; do
    local current_id; current_id="$(compose ps -q relay || true)"
    if [ -n "$current_id" ] && [ "$current_id" != "$baseline_container_id" ]; then
      local current_digest; current_digest="$(container_digest "$current_id")"
      local health; health="$(docker inspect "$current_id" --format '{{.State.Health.Status}}' 2>/dev/null || echo "")"
      if [ "$current_digest" = "$want_digest" ] && [ "$health" = "healthy" ]; then
        if curl -sf http://127.0.0.1:8080/healthz | grep -q '"status":"ok"'; then
          return 0
        fi
      fi
    fi
    sleep 2
    waited=$((waited + 2))
  done
  return 1
}

# Ensures Caddy exists on a cold-start deploy without ever bouncing it on
# a routine deploy: `up -d` only creates or starts a service, it does not
# recreate one that is already running unchanged.
#
# --no-deps is load-bearing, and its absence was a live bug. Caddy declares
# `depends_on: [relay]`, so a bare `up -d caddy` pulls relay into the same
# `up` and recreates it whenever its desired config differs from what is
# running - which is EVERY deploy, because RELAY_IMAGE_REF has just changed.
# Every live session was therefore dropped twice per deploy: once here, and
# again on the explicit --force-recreate below. Measured on the 2026-09-13
# rollback drill, which produced three recreates where the drill path intends
# two (one forward deploy, one rollback). One of the extra containers lived
# 70 ms.
#
# `up -d` DOES recreate Caddy when its own service definition changed (an
# image, mount, command or sysctl edit in docker-compose.prod.yml). A fresh
# container loads every input as it starts, so that case needs no reload
# afterwards, only its fingerprint recorded.
ensure_caddy_can_run_bbr
caddy_container_before="$(compose ps -q caddy || true)"
compose up -d --no-deps caddy
caddy_container_after="$(compose ps -q caddy || true)"

# The relay recreate is scoped to `relay` only (via --force-recreate on
# just this service), so an already-running Caddy is never dropped or
# reconnected on every deploy.
compose up -d --force-recreate --remove-orphans relay

if ! wait_for_gate "$prev_container_id" "$new_digest"; then
  rollback
fi

{
  echo "$new_digest"
  git -C "$repo_root" rev-parse HEAD
} > "$last_good_file.tmp"
chmod 0644 "$last_good_file.tmp"
mv "$last_good_file.tmp" "$last_good_file"

# Recorded only on success, so a rollback leaves the previous fingerprint
# in place and the next deploy sees a mismatch and recreates rather than
# skipping. The container is running the rolled-back IMAGE with the new env
# file at that point, which is precisely a state no skip should preserve.
printf '%s\n' "$env_sha256" > "$last_env_file.tmp"
chmod 0644 "$last_env_file.tmp"
mv "$last_env_file.tmp" "$last_env_file"

# Prune only after success, and only images older than a week - never
# prune the digest we might need to roll back to next time.
docker image prune -af --filter until=168h >/dev/null 2>&1 || true

# Caddy last, once the relay is healthy and its state recorded, so a Caddy
# problem can fail this run without mis-recording the relay's. A Caddy
# recreated above already loaded everything as it started; otherwise reload
# it only if its inputs changed since it last loaded them.
if [ -n "$caddy_container_after" ] && [ "$caddy_container_after" != "$caddy_container_before" ]; then
  record_caddy_fingerprint "$(caddy_inputs_sha256)"
  echo "caddy was (re)created this deploy and loaded current inputs"
else
  reload_caddy_if_inputs_changed
fi

echo "deployed $new_digest"
