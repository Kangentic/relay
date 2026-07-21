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
#               immutable tag so a re-deploy of the same code is
#               guaranteed to recreate the container, which the health
#               gate's "container identity changed" check depends on.
#   drill-mode  none (default) | healthcheck | port - see
#               infra/compose/docker-compose.drill-*.yml and
#               infra/README.md.
set -euo pipefail

image_tag="${1:?usage: deploy.sh <image-tag> [drill-mode]}"
drill="${2:-none}"

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
compose_file="$repo_root/infra/compose/docker-compose.prod.yml"
env_file="/opt/relay/.env"
state_dir="/opt/relay/state"
last_good_file="$state_dir/last_good"

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

# Reality is the source of truth for rollback, not a hand-maintained file:
# the previous image digest comes from the currently running container,
# and the previous git ref comes from git's own reflog (HEAD@{1} is
# exactly "HEAD before the checkout the wrapper just did"). last_good is
# written only as a cold-start fallback and audit trail below.
prev_container_id="$(compose ps -q relay || true)"
prev_digest=""
if [ -n "$prev_container_id" ]; then
  prev_digest="$(container_digest "$prev_container_id")"
fi
prev_git_ref="$(git -C "$repo_root" rev-parse "HEAD@{1}" 2>/dev/null || echo "")"

echo "deploying image_tag=$image_tag drill=$drill (previous digest: ${prev_digest:-none})"

# Skip entirely when nothing that affects the built image changed between
# the previous deploy and this one. This is NOT decided by comparing image
# digests (that was the original design and it does not work):
# docker/metadata-action's default labels include
# org.opencontainers.image.created, a build timestamp baked into every
# image's config, so two builds from byte-identical source still produce
# different digests. Comparing the actual source inputs the Dockerfile
# reads is the real signal - a docs-only merge (markdown is excluded by
# .dockerignore, but git diff does not consult that) touches none of these
# paths, and recreating the container for no reason would drop every live
# session pointlessly.
if [ "$drill" = "none" ] && [ -n "$prev_container_id" ] && [ -n "$prev_git_ref" ]; then
  if git -C "$repo_root" diff --quiet "$prev_git_ref" HEAD -- \
    Dockerfile .dockerignore package.json package-lock.json tsconfig.json tsconfig.build.json src
  then
    echo "no build-relevant changes since $prev_git_ref, skipping restart"
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
compose up -d caddy

# The relay recreate is scoped to `relay` only (via --force-recreate on
# just this service), so an already-running Caddy is never dropped or
# reconnected on every deploy.
compose up -d --force-recreate --remove-orphans relay

if ! wait_for_gate "$prev_container_id" "$new_digest"; then
  rollback
fi

# Success. Reload Caddy in case the Origin CA cert changed since the last
# deploy (write-secret pushes it independently of image deploys).
compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile 2>/dev/null || true

{
  echo "$new_digest"
  git -C "$repo_root" rev-parse HEAD
} > "$last_good_file.tmp"
chmod 0644 "$last_good_file.tmp"
mv "$last_good_file.tmp" "$last_good_file"

# Prune only after success, and only images older than a week - never
# prune the digest we might need to roll back to next time.
docker image prune -af --filter until=168h >/dev/null 2>&1 || true

echo "deployed $new_digest"
