# Contributing to Extalia

Thank you for helping. This guide covers the workflow; the architecture is in
[docs/architecture/overview.md](docs/architecture/overview.md).

## Workflow

1. **Start from an issue.** Every pull request links an issue. For larger
   changes, discuss the approach in the issue first; hard-to-reverse choices
   get an [ADR](docs/adr/README.md).
2. **Branch from `main`** and keep pull requests focused on one change.
3. **Use Conventional Commits:** `feat(core): …`, `fix(desktop): …`,
   `docs(protocol): …`, `refactor(web): …`, `test(cli): …`, `chore: …`.
4. **Update `CHANGELOG.md`** under `## [Unreleased]` for user-visible changes.
5. **Run `pnpm check`** before opening the pull request. CI runs the same
   checks on macOS, Windows and Linux.

## Rules that reviews enforce

- **Runtime independence.** Views and the office consume Extalia Protocol
  events and core state only. Never import a runtime, provider or adapter from
  UI or renderer code.
- **Package boundaries.** Dependencies point one way
  (`protocol ← core ← platform ← apps`). A new package adds its rule to
  `tooling/check-boundaries.mjs`.
- **No personal data.** No absolute home paths, personal names, e-mail
  addresses, credentials, private project names or private endpoints in code,
  tests, fixtures or docs. Use placeholders such as `/Users/<name>` and
  example domains. Importer fixtures are sanitized and synthetic.
- **Configuration over special cases.** A feature that exists for one person's
  setup must work for any user through configuration (PRD §47).
- **Honest capabilities.** Unsupported runtime features are shown as
  unsupported, never emulated. Parsers for third-party formats ship only after
  they were verified against a real installed version, and say which.
- **Security first.** Respect the defaults in
  [docs/architecture/security.md](docs/architecture/security.md). Anything that
  edits another application's configuration needs a dry run, consent, backups
  and an undo path.
- **Tests.** New behavior comes with unit tests; UI changes are checked in
  light and dark themes and at phone width.

## Local private terms

Maintainers can list private words that must never be committed (for example
their own user name) in the untracked file `.extalia-private-terms`, one per
line. `pnpm lint` fails if any of them appears in the repository.

## Review and merge

Pull requests need passing CI and an approving review from a code owner of the
touched area. See [GOVERNANCE.md](GOVERNANCE.md) for roles.
