#!/usr/bin/env bash
# Idempotent provisioning for a Kangentic relay box on Hetzner Cloud, via
# the hcloud CLI (not the web wizard - a hand-clicked box is not
# reproducible). Safe to re-run: every step describes-then-creates, and the
# firewall is unconditionally reconciled so a Cloudflare IP range change
# (see infra/scripts/render-cloudflare-config.sh) converges on the next
# run instead of drifting.
#
# Every input is an env var with a default, so a second box (e.g. a future
# EU region) reuses this script by overriding only what differs.
#
# Requires: hcloud CLI authenticated (HCLOUD_TOKEN or `hcloud context
# create`), an admin SSH public key, and the ci-deploy SSH public key
# generated ahead of time (ssh-keygen -t ed25519 -f relay-ci-deploy -N '').
set -euo pipefail

: "${RELAY_SERVER_NAME:=relay-ashburn-us-east}"
: "${RELAY_LOCATION:=ash}"
: "${RELAY_SERVER_TYPE:=cpx11}"
: "${RELAY_IMAGE:=ubuntu-26.04}"
: "${RELAY_FIREWALL_NAME:=relay-edge}"
: "${RELAY_ADMIN_KEY_NAME:=relay-admin}"
: "${RELAY_CI_KEY_NAME:=relay-ci-deploy}"
: "${RELAY_ADMIN_PUBKEY_FILE:=$HOME/.ssh/id_ed25519.pub}"
: "${RELAY_CI_PUBKEY_FILE:=./relay-ci-deploy.pub}"
: "${RELAY_LABELS:=project=relay,env=production}"
: "${RELAY_REPO_URL:=https://github.com/Kangentic/relay.git}"
: "${RELAY_DEPLOY_USER:=deploy}"
: "${RELAY_DOMAIN:=kangentic.com}"

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

require_file() {
  if [ ! -f "$1" ]; then
    echo "missing required file: $1" >&2
    exit 1
  fi
}

ensure_ssh_key() {
  local name="$1" pubkey_file="$2"
  require_file "$pubkey_file"
  if hcloud ssh-key describe "$name" >/dev/null 2>&1; then
    echo "ssh-key $name already exists"
  else
    hcloud ssh-key create --name "$name" --public-key-from-file "$pubkey_file"
  fi
}

ensure_firewall() {
  if ! hcloud firewall describe "$RELAY_FIREWALL_NAME" >/dev/null 2>&1; then
    hcloud firewall create --name "$RELAY_FIREWALL_NAME"
  fi
  # Unconditional: always reconcile to the generated rules file, so a
  # Cloudflare range refresh converges here without extra logic.
  hcloud firewall replace-rules "$RELAY_FIREWALL_NAME" \
    --rules-file "$script_dir/firewall-rules.json"
}

ensure_server() {
  if hcloud server describe "$RELAY_SERVER_NAME" >/dev/null 2>&1; then
    echo "server $RELAY_SERVER_NAME already exists"
    return
  fi
  # Built from $RELAY_LABELS rather than hardcoded, so overriding it
  # actually takes effect. The default expands to exactly the previous
  # literal pair. These labels are what deploy.yml's HCLOUD_SERVER_SELECTOR
  # matches on, so a mismatch here makes every deploy resolve zero servers.
  local label_args=() label
  local saved_ifs="$IFS"
  IFS=','
  for label in $RELAY_LABELS; do
    [ -n "$label" ] && label_args+=(--label "$label")
  done
  IFS="$saved_ifs"

  hcloud server create \
    --name "$RELAY_SERVER_NAME" \
    --type "$RELAY_SERVER_TYPE" \
    --image "$RELAY_IMAGE" \
    --location "$RELAY_LOCATION" \
    --ssh-key "$RELAY_ADMIN_KEY_NAME" \
    --ssh-key "$RELAY_CI_KEY_NAME" \
    --firewall "$RELAY_FIREWALL_NAME" \
    "${label_args[@]}" \
    --user-data-from-file "$script_dir/cloud-init.yaml"
}

server_ip() {
  hcloud server ip "$RELAY_SERVER_NAME"
}

wait_for_bootstrap() {
  local ip; ip="$(server_ip)"
  echo "waiting for cloud-init to finish on $ip..."
  local admin_key="${RELAY_ADMIN_PUBKEY_FILE%.pub}"
  local ssh_opts=(-o StrictHostKeyChecking=accept-new -o ConnectTimeout=5 -i "$admin_key")
  local attempt=0
  until ssh "${ssh_opts[@]}" "root@$ip" 'cloud-init status --wait' >/dev/null 2>&1; do
    attempt=$((attempt + 1))
    if [ "$attempt" -gt 60 ]; then
      echo "cloud-init did not finish in time" >&2
      exit 1
    fi
    sleep 5
  done
  if ! ssh "${ssh_opts[@]}" "root@$ip" 'test -f /opt/relay/.bootstrap-ok'; then
    echo "cloud-init finished but /opt/relay/.bootstrap-ok is missing - Docker install likely failed." >&2
    echo "Check: ssh root@$ip 'cloud-init status --long' and 'cat /var/log/cloud-init-output.log'." >&2
    echo "If Docker's apt repo has no suite for this Ubuntu release yet, retry with DOCKER_APT_SUITE" >&2
    echo "in the user-data pinned to the previous LTS codename." >&2
    exit 1
  fi
  echo "cloud-init OK, box bootstrapped"
}

clone_repo() {
  local ip; ip="$(server_ip)"
  local admin_key="${RELAY_ADMIN_PUBKEY_FILE%.pub}"
  # Self-healing: if /opt/relay/src exists but has no .git (a clone that
  # was interrupted partway, or a concurrent retry that collided with a
  # still-running clone from an earlier attempt), wipe it and reclone
  # rather than letting `git clone` fail on a non-empty target directory.
  ssh -o StrictHostKeyChecking=accept-new -i "$admin_key" "$RELAY_DEPLOY_USER@$ip" \
    "test -d /opt/relay/src/.git || { rm -rf /opt/relay/src && git clone '$RELAY_REPO_URL' /opt/relay/src; }"
}

restrict_ci_deploy_key() {
  local ip; ip="$(server_ip)"
  local admin_key="${RELAY_ADMIN_PUBKEY_FILE%.pub}"
  local ci_pubkey; ci_pubkey="$(cat "$RELAY_CI_PUBKEY_FILE")"
  # Idempotent: rewrite authorized_keys so the admin key is unrestricted
  # and the ci-deploy key is command=-restricted to the deploy wrapper. A
  # leaked CI key then cannot get a shell, port-forward, or a pty.
  local admin_pubkey; admin_pubkey="$(cat "$RELAY_ADMIN_PUBKEY_FILE")"
  # Intentionally unquoted heredoc: $admin_pubkey/$ci_pubkey/$RELAY_DEPLOY_USER
  # must expand HERE (locally, before sending), not on the remote box,
  # which has none of these variables set.
  # shellcheck disable=SC2087
  ssh -o StrictHostKeyChecking=accept-new -i "$admin_key" "$RELAY_DEPLOY_USER@$ip" bash -s <<EOF
set -euo pipefail
cat > /home/$RELAY_DEPLOY_USER/.ssh/authorized_keys <<KEYS
$admin_pubkey
command="/opt/relay/bin/ci-deploy-wrapper.sh",no-port-forwarding,no-agent-forwarding,no-pty $ci_pubkey
KEYS
chmod 600 /home/$RELAY_DEPLOY_USER/.ssh/authorized_keys
EOF
}

main() {
  ensure_ssh_key "$RELAY_ADMIN_KEY_NAME" "$RELAY_ADMIN_PUBKEY_FILE"
  ensure_ssh_key "$RELAY_CI_KEY_NAME" "$RELAY_CI_PUBKEY_FILE"
  ensure_firewall
  ensure_server
  wait_for_bootstrap
  clone_repo
  restrict_ci_deploy_key

  local ip; ip="$(server_ip)"
  echo ""
  echo "Provisioned. Server IP: $ip"
  echo "Next steps (see infra/README.md):"
  echo "  1. Create DNS A record $RELAY_SERVER_NAME.$RELAY_DOMAIN -> $ip in Cloudflare, proxied."
  echo "  2. Mint an Origin CA certificate for $RELAY_DOMAIN plus *.$RELAY_DOMAIN."
  echo "  3. Capture this host's SSH key line for DEPLOY_SSH_KNOWN_HOSTS:"
  echo "     ssh-keyscan -t ed25519 $ip | sed 's/^[^ ]*/relay-production/'"
  echo "  4. Add the ci-deploy private key, DEPLOY_SSH_KNOWN_HOSTS, HCLOUD_TOKEN, and the Origin CA"
  echo "     cert/key to the GitHub 'production' environment secrets."
}

main "$@"
