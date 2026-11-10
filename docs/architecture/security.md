# Security model

Security boundaries come before autonomous capabilities (PRD §25).

## Defaults

| Area | Action | Default |
| --- | --- | --- |
| Filesystem | Read inside the workspace | Allow |
| | Write inside the workspace | Ask or allow (policy) |
| | Other registered workspace folders | Read only unless either side is isolated |
| | Other registered workspace edits | Both sides must allow read/write; approvals still apply |
| | Unregistered folders | Deny |
| Terminal | Native command without verified isolated executor | Unavailable |
| Git | Commit | Allow |
| | Push | Ask |
| Network | External requests | Ask |
| Secrets | Read credentials | Deny |

Security policy overrides user, project and agent instructions.

## Extalia Native agent

- Native file tools use the selected primary/additional folders and two-sided
  [workspace boundaries](../getting-started/workspace-boundaries.md), including
  canonical symlink targets and nested registered roots. They refuse credential files (`.env`, keys, `.ssh/`, `.npmrc`, …) and writes into
  `.git/`.
- Production Native commands and integration gates fail before launch without
  a verified workspace-isolated executor. Lower-level command utilities retain
  explicit caller control, process groups, environment filtering and redacted
  output; these mechanisms alone do not establish filesystem isolation.
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

`extalia connect <app>` edits another application's configuration,
so it always shows a dry run first, needs the user's approval, backs up the
files it changes, preserves existing settings and can be undone with
`extalia disconnect <app>`. Notification hooks forward events only; they never block,
steer or inject text into the agent. See
[runtime-adapters.md](runtime-adapters.md).

The opt-in [observed Codex control](../adr/0060-observed-codex-same-server-control.md)
uses a separate existing-server connection, not hook responses. The host binds
socket/thread/turn/request identity and does not expose arbitrary RPC to the UI.
Pause/delete/disconnect revoke the connection before persistence waits. Secret
answers remain memory-only in Extalia, and uncertain delivery is not retried. A transcript
waiting state, private Desktop IPC socket or saved thread on another server
never establishes answer authority. Generic approvals stay in their source app.

[ADR 0062](../adr/0062-codex-queue-and-native-permissions.md) permits exact newly
received native command/file/permission decisions on that connection, with full
preview and explicit offered choices. Persistent policy/session grants are
excluded; broader file-root grants can only be declined/cancelled here. Separate
saved queue setup executes only the official queue command against a registered
source profile and exact UUID. Durable intent/receipt metadata contains no text,
and does not confer steering or permission authority.

[ADR 0063](../adr/0063-codex-synchronous-permission-hooks.md) adds a separate,
explicitly reviewed synchronous permission hook. It uses its own private token,
exact native-session filter before forwarding, registered transcript/profile
binding, original HTTP callback, full payload digest and one-use explicit choices.
Notification and cooperative-reply tokens cannot authorize it. Timeout,
disconnect, source change and pause defer to Codex. Setup does not write hook
trust or change source permission modes. Only the verified native Bash payload
admits allow; missing permission details remain visible as a review limitation.
Built-in permission-grant tools still need the source app or original-server RPC.

[Observed reply channels](../adr/0061-observed-reply-channels.md) use a separate
ephemeral loopback rendezvous with one-use bearer tokens, strict Host/no-Origin
checks and bounded messages. They return only through the tool that explicitly
waits for a reply. Possession of its token is not proof of native app or chat
identity; the user manually pairs the intended source conversation. Tokens and
answers are not persisted by Extalia. Source apps can retain their own tool
history. Pause/removal seals admission synchronously before observation writes.
The conditional Hermes adapter separately verifies the public attach ticket's
owner/profile, live session and execution generation; it cannot start or recover
a gateway or persist permanent source-app authorization.

## Observed message dispatch

Observed messaging also uses [capability-bound dispatch and cooperative inboxes](../adr/0072-observed-control-hub-and-cooperative-inboxes.md).
An operation is tied to an exact source/watch epoch and connection/turn; an
uncertain result is never automatically replayed or moved to another transport.
Inbox polling is a separate memory-only loopback capability with explicit
acknowledgement, bounds, expiry and revocation. Pairing proves token possession,
not native app/session identity. Inbox messages cannot answer native approvals,
change permissions, start a CLI or control a Desktop window.

## Repository safety

`pnpm lint` runs `tooling/check-public-safety.mjs`, which fails on personal
home paths, personal e-mail addresses, credential formats, committed `.env`
files and maintainer-defined private terms (kept in the untracked file
`.extalia-private-terms`). Report vulnerabilities as described in
[SECURITY.md](../../SECURITY.md).
