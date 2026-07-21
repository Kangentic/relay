#!/usr/bin/env bash
# Regenerates every file derived from Cloudflare's published IP ranges from
# one source (infra/cloudflare/ips.json), so the Hetzner firewall and
# Caddy's trusted_proxies never drift apart. Run by
# .github/workflows/cloudflare-ranges.yml on a weekly schedule, which opens
# a PR if anything changed - this script never applies anything itself.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
infra_dir="$(cd "$script_dir/.." && pwd)"

curl -sf https://api.cloudflare.com/client/v4/ips \
  | jq '.result | {ipv4_cidrs, ipv6_cidrs}' \
  > "$infra_dir/cloudflare/ips.json"

v4="$(jq -r '.ipv4_cidrs[]' "$infra_dir/cloudflare/ips.json")"
v6="$(jq -r '.ipv6_cidrs[]' "$infra_dir/cloudflare/ips.json")"

all_cidrs="$(printf '%s\n%s\n' "$v4" "$v6")"

# Caddy's trusted_proxies directive: one line, space-separated CIDRs.
{
  printf 'trusted_proxies static'
  while IFS= read -r cidr; do
    [ -n "$cidr" ] && printf ' %s' "$cidr"
  done <<< "$all_cidrs"
  printf '\n'
} > "$infra_dir/cloudflare/trusted-proxies.caddy"

# Hetzner firewall rules: SSH open (GitHub-hosted runner egress ranges are
# too numerous to enumerate; mitigated by key-only auth and fail2ban - see
# infra/README.md), 80/443 restricted to Cloudflare only. Both IPv4 and
# IPv6 ranges go in both port rules even though the box publishes no AAAA
# today, so a self-hoster who does publish one is not silently exposed.
jq -n \
  --argjson v4 "$(jq -c '.ipv4_cidrs' "$infra_dir/cloudflare/ips.json")" \
  --argjson v6 "$(jq -c '.ipv6_cidrs' "$infra_dir/cloudflare/ips.json")" \
  '[
    {
      direction: "in", protocol: "tcp", port: "22",
      source_ips: ["0.0.0.0/0", "::/0"],
      description: "SSH, key-only auth. GitHub-hosted runner egress ranges are too numerous to allowlist."
    },
    {
      direction: "in", protocol: "tcp", port: "80",
      source_ips: ($v4 + $v6),
      description: "GENERATED from infra/cloudflare/ips.json by render-cloudflare-config.sh. Do not hand-edit."
    },
    {
      direction: "in", protocol: "tcp", port: "443",
      source_ips: ($v4 + $v6),
      description: "GENERATED from infra/cloudflare/ips.json by render-cloudflare-config.sh. Do not hand-edit."
    }
  ]' > "$infra_dir/hetzner/firewall-rules.json"

echo "regenerated infra/cloudflare/ips.json, infra/cloudflare/trusted-proxies.caddy, infra/hetzner/firewall-rules.json"
