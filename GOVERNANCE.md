# Governance

Open contribution does not mean unrestricted release authority (PRD §30).

## Roles

| Role | Responsibilities |
| --- | --- |
| Project Lead | Product vision, governance, architecture direction, maintainer appointments |
| Core Maintainers | Core review, merges, releases |
| Area Maintainers | Review and direction for one area: renderer, protocol, runtime adapters, importers, desktop, web, UI, docs |
| Triagers | Issue labels, duplicates, reproduction |
| Contributors | Issues, pull requests, extensions, documentation |

Contributors progress through trusted contributor, triager and area maintainer
to core maintainer based on sustained, high-quality work, by invitation of the
Project Lead after consulting the core maintainers.

## Decisions

- Day-to-day changes are decided in pull request review.
- Architecture changes and hard-to-reverse choices are proposed as ADRs in
  `docs/adr` and accepted by the core maintainers.
- When consensus is not reached, the Project Lead decides and records why.

## Releases

Releases are produced by CI from `main`. Only core maintainers can trigger a
release. Publishing credentials are not held by individuals where trusted
publishing is available.

## Branch protection

`main` requires pull requests, passing CI and code-owner review; force pushes
and branch deletion are disabled.

## Maintainers

The maintainer list and the private contact for conduct reports are published
here before the first public release.
