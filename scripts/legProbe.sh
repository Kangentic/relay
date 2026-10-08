#!/usr/bin/env bash
# Leg probe: times the hosted relay's request path one leg at a time, at 1 Hz,
# on timestamps that line up across machines, so a slow patch a client sees
# can be pinned to the leg it lives on. See docs/latency.md for how the
# 2026-10-07 investigation used it, and docs/testing.md for usage.
#
#   client mode (run anywhere with curl 8.3+, Git Bash included):
#     edge     GET https://<host>/cdn-cgi/trace   answered by the Cloudflare
#              edge itself, so it never reaches the origin
#     origin   GET https://<host>/healthz         client -> edge -> origin -> back
#   box mode (run ON the relay host, with sudo for the TCP counters):
#     caddy    GET https://<host>/healthz via --resolve to 127.0.0.1, so Caddy
#              plus the relay with no network in between
#     relay    GET http://127.0.0.1:8080/healthz, the relay alone
#     tcp      every 10 s, deltas of the TCP retransmit and timeout counters
#              inside Caddy's network namespace, which is where the
#              Cloudflare-facing sockets live
#
# Every request reuses one keep-alive connection per leg (curl --rate over a
# URL range), so a sample measures the path rather than a fresh handshake;
# n= in the output says when a new connection was opened. Run client and box
# modes over the same minutes and compare by timestamp: a spike on origin with
# edge, caddy and relay flat is the Cloudflare-to-origin leg.
#
# Usage:
#   scripts/legProbe.sh client relay.kangentic.com [seconds]
#   scripts/legProbe.sh box relay.kangentic.com [seconds]
# Output is one line per sample, then a summary per leg. Timestamps are UTC.
set -euo pipefail

mode="${1:?usage: legProbe.sh client|box <host> [seconds]}"
host="${2:?usage: legProbe.sh client|box <host> [seconds]}"
seconds="${3:-300}"

# A sample slower than this is listed again in the summary.
slow_threshold_seconds="0.25"

# One file per leg, merged at the end. The legs run concurrently, and two
# writers appending to one file is not safe everywhere: Git Bash emulates
# O_APPEND as seek-then-write, and lost one leg's lines entirely.
samples_dir="$(mktemp -d)"
trap 'rm -rf "$samples_dir"' EXIT

# One leg: N transfers paced at 1/s over a single reused connection.
# %time{} needs curl 8.3 or later; it is the transfer's end, in UTC.
probe_leg() {
  local leg="$1" url="$2"
  shift 2
  curl -s -o /dev/null --rate 1/s "$@" \
    -w "%time{%Y-%m-%dT%H:%M:%S.%fZ} ${leg} %{time_total} code=%{http_code} n=%{num_connects}\n" \
    "${url}?leg=${leg}&n=[1-${seconds}]" > "$samples_dir/$leg"
}

# Deltas of the counters that show loss and RTO backoff, every 10 s, from the
# network namespace of the running Caddy container.
probe_tcp_counters() {
  local caddy_pid counters previous="" current
  caddy_pid="$(docker inspect -f '{{.State.Pid}}' "$(docker ps -qf name=caddy | head -1)")"
  counters="TcpOutSegs TcpRetransSegs TcpExtTCPTimeouts TcpExtTCPSynRetrans TcpExtListenOverflows TcpPassiveOpens"
  for _ in $(seq 1 $((seconds / 10))); do
    # -a absolute, -s do not touch nstat's history file, -z include zeros.
    # shellcheck disable=SC2086
    current="$(sudo nsenter -t "$caddy_pid" -n nstat -asz $counters | awk 'NR > 1 { printf "%s=%s ", $1, $2 }')"
    if [ -n "$previous" ]; then
      awk -v now="$(date -u +%Y-%m-%dT%H:%M:%SZ)" -v previous="$previous" -v current="$current" 'BEGIN {
        split(previous, before, " "); split(current, after, " ");
        line = now " tcp";
        for (index_ = 1; index_ in after; index_++) {
          split(before[index_], pair_before, "="); split(after[index_], pair_after, "=");
          line = line " " pair_after[1] "=+" (pair_after[2] - pair_before[2]);
        }
        print line;
      }' >> "$samples_dir/tcp"
    fi
    previous="$current"
    sleep 10
  done
}

case "$mode" in
  client)
    probe_leg edge "https://${host}/cdn-cgi/trace" &
    probe_leg origin "https://${host}/healthz" &
    ;;
  box)
    # -k: the Origin CA certificate is not in a public trust store.
    probe_leg caddy "https://${host}/healthz" -k --resolve "${host}:443:127.0.0.1" &
    probe_leg relay "http://127.0.0.1:8080/healthz" &
    probe_tcp_counters &
    ;;
  *)
    echo "unknown mode: $mode (expected client or box)" >&2
    exit 1
    ;;
esac
wait

sort "$samples_dir"/*
echo
echo "summary (seconds):"
for leg in edge origin caddy relay; do
  [ -s "$samples_dir/$leg" ] || continue
  awk '{ print $3 }' "$samples_dir/$leg" | sort -n | awk -v leg="$leg" -v threshold="$slow_threshold_seconds" '
    function rank(fraction,   position) {
      position = int(NR * fraction)
      return position < 1 ? 1 : position
    }
    { value[NR] = $1; if ($1 > threshold) slow++ }
    END {
      printf "  %-6s n=%d p50=%s p90=%s p99=%s max=%s over_%ss=%d\n", leg, NR,
        value[rank(0.50)], value[rank(0.90)], value[rank(0.99)], value[NR], threshold, slow + 0
    }'
done
