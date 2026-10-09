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
- API keys live in the OS credential store (macOS Keychain, Secret Service on
  Linux) or, where none is available, in a user-only file in the data
  directory; they can also come from an environment variable. They never leave
  the host process and are never returned to the UI.
- One host owns a data directory at a time (lock file), so Desktop and the
  Bridge cannot corrupt each other's sessions.

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
