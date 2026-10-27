# Instructions for coding agents

These rules apply to any AI coding agent working in this repository, in
addition to [CONTRIBUTING.md](CONTRIBUTING.md).

- Product: **Extalia**, an open-source spatial AI-agent workspace. Hermes,
  Codex, Claude Code, Gemini and other tools are integrations, not the product.
- Current product work is defined in
  [docs/product/prd-app-flow-and-live-agents.md](docs/product/prd-app-flow-and-live-agents.md):
  read it, follow its working protocol and update its status tracker.
- Read [docs/architecture/overview.md](docs/architecture/overview.md) before
  changing structure. Keep the dependency direction
  `protocol ← core ← platform ← apps`; renderer and UI code never import
  runtimes, providers or adapters.
- This is a public repository. Never write personal paths, user names, e-mail
  addresses, credentials, private project names, private endpoints or persona
  names into code, tests, fixtures, docs or commit messages. Use placeholders
  (`/Users/<name>`, `example.com`). `pnpm lint` checks this.
- Managed sessions (Extalia drives a runtime) and observed sessions (Extalia
  watches an agent app) both use Extalia Protocol events; see
  [docs/architecture/runtime-adapters.md](docs/architecture/runtime-adapters.md).
  Never emulate a capability a runtime does not have.
- Anything that edits another application's configuration needs a dry run, the
  user's approval, backups and an undo command. Test such code against
  temporary directories, never a real home directory.
- Extalia's own data lives in `~/.extalia-vo` (`%USERPROFILE%\.extalia-vo`),
  shared by the Bridge and Desktop. Tests pass a temporary `dataDirectory`,
  `EXTALIA_HOME` or `homeDirectory`; never read or write the real profile or
  the pre-0.0.21 folder (`~/Library/Application Support/Extalia`, …).
- UI text lives in `apps/web/src/i18n.ts`. English is the default, Indonesian
  the second language; user content is never translated.
- For each completed implementation update: add notes under
  `## [Unreleased]` in `CHANGELOG.md`, run `pnpm version:patch` once, then
  `pnpm check`.
