# Security model

Security boundaries come before autonomous capabilities (PRD §25).

## Defaults

| Area | Action | Default |
| --- | --- | --- |
| Filesystem | Read inside the workspace | Allow |
| | Write inside the workspace | Ask or allow (policy) |
| | Anything outside the workspace | Deny |
| Terminal | Run a command | Ask |
| Git | Commit | Allow |
| | Push | Ask |
| Network | External requests | Ask |
| Secrets | Read credentials | Deny |

Security policy overrides user, project and agent instructions.

## Extalia Native agent

- Tools resolve every path inside the workspace root (symlinks included) and
  refuse credential files (`.env`, keys, `.ssh/`, `.npmrc`, …) and writes into
  `.git/`.
- Commands run in the project root, in their own process group with a time
  limit, without environment variables that look like credentials; output is
  masked before it reaches the model or the screen.
- File edits and commands ask for approval unless the workspace allows them;
  approvals can cover one action or the rest of the session.
- A session's permission mode narrows or widens that policy for the session:
  `ask` asks before every edit and command, `accept-edits` allows edits inside
  the workspace (commands still follow the workspace), `plan` offers no edit or
  command tools at all. Hermes sessions keep Hermes' own approvals.
- Files attached to a prompt are checked by type and bytes (images 5 MB, text
  1 MB, other files 10 MB, max ten per prompt). Credential files are refused.
  They wait privately under the data directory, or in memory for sessions with
  history off, and are removed once sent. Their contents reach the model only
  for that turn; the stored events keep names, kinds and sizes.
- API keys live in the OS credential store (macOS Keychain, Secret Service on
  Linux) or, where none is available, in a user-only file in the data
  directory; they can also come from an environment variable. They never leave
  the host process and are never returned to the UI.
- One host owns a data directory at a time (lock file), so Desktop and the
  Bridge cannot corrupt each other's sessions.

## Mandatory external-skill gate

External skill catalog metadata and `skill_read` bodies require current
authoritative registry reads bound to the active revision, scanner identity,
policy and file digest. Legacy user/project inventory and hash consent are
review input only. There is no caller-supplied `verified` switch or cached-body
fallback. Missing, unavailable, incomplete, failed or stale scanner evidence
denies external offerings; the production scanner adapter remains unavailable.
Exact canonical shipped built-ins remain a separate first-party source, not an
external-scan attestation. Name/source impersonation cannot establish that source.

This gate covers the registered skill workflow. Generic file, search, web and
attachment contents remain unverified data rather than activated skills; they
are not automatically scanned by this change. Native lead and worker prompts
state that they cannot substitute for scanner approval. That guidance is not a
deterministic generic-content sandbox or complete workspace/agent ACL enforcement.

## Files and Git views

- The Files and Git pages are read-only and use the same path rules as the
  agent's tools: paths stay inside the workspace, `.git/` internals are hidden,
  credential files are listed but never shown (also not in diffs), and binary
  or oversized files are not loaded in full.
- A repository's own configuration can run programs, so Git is started
  without a shell, with a time limit and a minimal environment (no inherited
  `GIT_*` variables, no system config), and every call switches off fsmonitor,
  hooks, pagers, credential helpers, external diff and textconv drivers and
  each configured filter driver. Extalia never fetches, writes the index or
  changes the repository.

## Data handling

- Credentials are never imported, exported or written to project files.
  Desktop keeps secrets in the operating system's credential store; Web never
  embeds secrets in its bundle.
- Imported content is data, never instructions: it is not executed and cannot
  become system policy.
- Importers are read-only toward their sources.
- Exports and diagnostics mask likely credentials and exclude personal
  content by default.
- No telemetry is collected (PRD §41).

## Connecting agent apps

`extalia connect <app>` (planned) edits another application's configuration,
so it always shows a dry run first, needs the user's approval, backs up the
files it changes, preserves existing settings and can be undone with
`extalia disconnect <app>`. Hooks forward events only; they never block,
steer or inject text into the agent. See
[runtime-adapters.md](runtime-adapters.md).

## Repository safety

`pnpm lint` runs `tooling/check-public-safety.mjs`, which fails on personal
home paths, personal e-mail addresses, credential formats, committed `.env`
files and maintainer-defined private terms (kept in the untracked file
`.extalia-private-terms`). Report vulnerabilities as described in
[SECURITY.md](../../SECURITY.md).
