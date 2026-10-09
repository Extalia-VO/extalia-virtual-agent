# ADR 0001: Clean public repository with selective migration

Status: Accepted

## Context

Extalia grew out of private prototypes: a 3D office and an agent foundation
with a local bridge. They contain personal paths, profile names, agent
personas, integration settings and history that must not be published, and
several modules are coupled to one machine's setup.

## Decision

Build the public project in a new repository with clean history. The
prototypes are behavior, visual and performance references. Each module is
classified KEEP, ADAPT, REWRITE or DROP in the
[migration ledger](../migration/ledger.md) and brought over deliberately,
never copied wholesale. Personal requirements become generic configuration.

`tooling/check-public-safety.mjs` runs in CI and locally to catch personal
paths, e-mail addresses, credentials and maintainer-defined private terms.

## Consequences

- Early phases re-implement some working prototype behavior.
- Every migrated module gets tests and documentation at the time it lands.
- Prototype history stays private.
