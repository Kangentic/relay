# Origin CA certificate: minting and rotation

TLS between Cloudflare and the box is a Cloudflare Origin CA certificate,
not Let's Encrypt. This avoids a custom Caddy image (Let's Encrypt via
DNS-01 needs a Cloudflare DNS plugin) and, more importantly, avoids parking
a DNS-edit-scoped Cloudflare API token on the box, which is a far more
dangerous secret than a single-hostname certificate.

No secret material is committed anywhere in this repo. This file documents
the steps only.

## Minting

1. In the Cloudflare dashboard for the `kangentic.com` zone, go to **SSL/TLS
   > Origin Server** and select **Create Certificate**.
2. Let Cloudflare generate the private key and CSR.
3. **Hostnames covered must include both `kangentic.com` and
   `*.kangentic.com`** (Cloudflare includes these by default). This is not
   optional: under Full (strict), Cloudflare validates the origin
   certificate against the requested `Host` header. A client hitting
   `relay.kangentic.com` (the CNAME) sends that Host, so a certificate
   issued only for `relay-ashburn-us-east.kangentic.com` would 526.
4. Choose the longest validity period offered (currently 15 years).
5. Copy the **Origin Certificate** and **Private Key** into two files. The
   private key is shown exactly once.
6. Set the zone's SSL/TLS encryption mode to **Full (strict)**.

## Delivering the cert to the box

The cert and key are never committed. They are stored as the GitHub
`production` environment secrets `CF_ORIGIN_CERT_PEM` and
`CF_ORIGIN_KEY_PEM`, and `deploy.yml`'s `write-secret` verb writes them to
`/opt/relay/secrets/origin.crt` (mode 644) and
`/opt/relay/secrets/origin.key` (mode 600) on every deploy. `deploy.sh`
then reloads Caddy on its success path so the new cert takes effect -
but only on a deploy that does not exit at the skip gate. See Rotation
below.

## Rotation

Nominal life is 15 years, which is exactly the risk: nobody will remember
on their own. `.github/workflows/monitor.yml` deliberately does NOT check
this from outside, because an external check against the public hostname
only ever sees Cloudflare's own edge certificate (the firewall blocks
anything but Cloudflare from reaching the origin directly, so an external
probe cannot observe the origin cert at all). The real check runs inside
`scripts/deploy/deploy.sh` on every deploy, reading the local file.

If the repo goes quiet for a stretch with no deploys, run this manually as
a fallback:

```
ssh deploy@relay-ashburn-us-east.kangentic.com \
  "openssl x509 -in /opt/relay/secrets/origin.crt -noout -enddate"
```

To rotate: repeat the minting steps above for a new certificate, update
the two GitHub environment secrets, then trigger a manual deploy
(`workflow_dispatch` on `deploy.yml`) to push the new cert to the box.

That deploy loads the new certificate on its own. `deploy.sh` fingerprints
the cert, the key, the Caddyfile and the Cloudflare range list, and when the
fingerprint changed it runs `caddy reload --force`, including on a deploy
that otherwise skips the relay restart. Both halves were missing before:

- **A plain `caddy reload` does not pick up a new certificate.** Caddy skips
  a reload whose config is unchanged, and the `tls` directive names the same
  two file paths either way. `--force` exists for exactly this: "reloading
  manually-loaded TLS certificates"
  ([Caddy CLI docs](https://caddyserver.com/docs/command-line)). Reproduced on
  Caddy 2.8.4 with two self-signed certs: a plain reload kept serving the old
  serial, a forced one switched.
- **The rotation deploy never reached the reload.** The cert and key go to
  `/opt/relay/secrets`, not `/opt/relay/.env`, so they moved no fingerprint
  the skip gate read, and a `workflow_dispatch` with nothing else changed
  exited before the success path.

To check what the running Caddy actually serves, rather than what is on disk,
compare serials on the box (the public hostnames are proxied and present
Cloudflare's edge certificate, not this one):

```
echo | openssl s_client -connect 127.0.0.1:443 -servername relay.kangentic.com 2>/dev/null | openssl x509 -noout -serial
openssl x509 -in /opt/relay/secrets/origin.crt -noout -serial
```

On 2026-10-07 both read `60EE8516...`, so no rotation had yet been lost to
the bug. A manual forced reload, if ever needed, is in
[`infra/README.md`](../README.md#how-secrets-reach-the-box).

## What is deliberately not used

**Authenticated Origin Pulls** (a client certificate Cloudflare presents to
the origin) is not enabled. It proves only "this connection came from
Cloudflare's network," which the Hetzner firewall already proves by
restricting 80/443 to Cloudflare's ranges. Its own CA certificate has a
hard expiry that would silently 5xx the whole site if missed, which is
exactly the class of landmine this document exists to avoid introducing
twice. It remains available as future defense-in-depth if the threat model
changes.
