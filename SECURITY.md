# Security Policy

@kangentic/relay is a security-sensitive component: it is the network-facing rendezvous point for
the Kangentic mobile companion's end-to-end encrypted channel. We take vulnerability reports
seriously and ask that you report them responsibly.

## Scope

In scope:
- The relay server itself (`src/**`): rendezvous logic, guards (rate limits, caps, byte limits),
  the admission seam, the HTTP health/metrics surface, and anything that could let it read, corrupt,
  misroute, or leak more than the documented honest-metadata surface (see README) of traffic it
  forwards.
- The Docker image and deploy tooling in this repository.

Out of scope:
- The end-to-end crypto layer (`@kangentic/protocol`), which lives in the
  [Kangentic/kangentic](https://github.com/Kangentic/kangentic) repository; report issues with it
  there.
- Kangentic's specific hosted deployment configuration (report those directly to Kangentic; see
  below).

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

Preferred: use GitHub's private vulnerability reporting for this repository (the "Report a
vulnerability" button under the Security tab), which opens a private advisory thread with
maintainers.

Alternative: email **hello@kangentic.com** with "SECURITY" in the subject line.

Please include:
- A description of the vulnerability and its potential impact.
- Steps to reproduce, or a proof of concept.
- The version or commit you tested against.

## Response expectations

We aim to acknowledge a new report within 5 business days and to provide an initial assessment
(severity, whether it is accepted, expected timeline) within 14 days. Coordinated disclosure is
welcome; we ask for reasonable time to release a fix before public disclosure.
