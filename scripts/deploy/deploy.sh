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

install -d -m 0755 "$state_dir"

# Reality is the source of truth for rollback, not a hand-maintained file:
# the previous image digest comes from the currently running container,
# and the previous git ref comes from git's own reflog (HEAD@{1} is
# exactly "HEAD before the checkout the wrapper just did"). last_good is
# written only as a cold-start fallback and audit trail below.
prev_container_id="$(compose ps -q relay || true)"
prev_digest=""
if [ -n "$prev_container_id" ]; then
  prev_digest="$(docker inspect "$prev_container_id" --format '{{index .RepoDigests 0}}' 2>/dev/null || echo "")"
fi
prev_git_ref="$(git -C "$repo_root" rev-parse "HEAD@{1}" 2>/dev/null || echo "")"

echo "deploying image_tag=$image_tag drill=$drill (previous digest: ${prev_digest:-none})"

export RELAY_IMAGE_REF="ghcr.io/kangentic/relay:$image_tag"
compose pull

new_digest="$(docker image inspect "$RELAY_IMAGE_REF" --format '{{index .RepoDigests 0}}')"

# Skip entirely when the pulled image is byte-identical to what is already
# running and this is not a drill. A docs-only merge produces the same
# image (markdown is excluded by .dockerignore), and recreating the
# container for no reason would drop every live session pointlessly.
if [ "$drill" = "none" ] && [ -n "$prev_container_id" ] && [ "$new_digest" = "$prev_digest" ]; then
  echo "image unchanged ($new_digest), skipping restart"
  exit 0
fi

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
      local current_digest; current_digest="$(docker inspect "$current_id" --format '{{index .RepoDigests 0}}' 2>/dev/null || echo "")"
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
