# Agent-app connections: safety and verification

Audit: 2026-10-29. Follow-up: [#64](https://github.com/Extalia-VO/extalia-virtual-agent/issues/64).
The shared connector serves Web, Desktop and CLI for Codex, Claude Code,
Gemini CLI, Antigravity and Hermes. Tested formats and installed-version warnings
remain in `connect/service.ts`; synthetic tests do not certify a newer vendor.

## Preview, apply and undo

The host returns a preview fingerprint covering configuration paths/targets,
exact before hashes, masked planned content, profiles, selected port, token
identity and forwarder state. Web/Desktop and CLI return that fingerprint on
Apply. Changed previews refuse before configuration, token or forwarder writes.
Older programmatic callers without a fingerprint retain their existing API;
they do not gain the displayed-preview guarantee.

Configuration-root changes require disconnecting the original configuration
first. New manifest entries bind backups to the resolved file target. Retargeted
file symlinks are refused; missing targets resolve through their nearest existing
parent, and broken file symlinks are refused. Legacy records without a target
binding refuse file symlinks rather than asserting ownership of their target.

All apply destinations are checked before writing; aliased destinations are
refused. Unchanged enrolled files are preserved. Backups precede changes. The
configuration, token, forwarder, explicit port overrides and manifest participate
in guarded writes. A caught failure restores earlier bytes only when they still
match this operation's output; concurrent edits remain untouched and incomplete
rollback is reported. A preexisting owned-hook configuration with no reliable
original is removed surgically instead of restoring hooks from its own backup.

This is **not crash atomicity or cross-process locking**. Process death and
simultaneous connector processes still need a recovery journal/locking design.
Disconnect likewise remains a sequence of individually backed-up removals, not
an atomic multi-profile operation. Keep these limits explicit when certifying
release evidence.

Hermes includes default and named profiles in preview/apply/status/undo. Every
enrolled profile can make the connection partial or stale. Edited profile removal
gets a fresh backup and contributes to the reported removal count. The
conservative YAML planner refuses inline `hooks.outbound` values, including `[]`,
rather than appending duplicate YAML keys. It does not rewrite arbitrary YAML.

## Delivery and truthful status

- Authentication reads the current token file for each check. Completed rotation,
  deletion, invalid content or read failure denies old credentials; a request
  whose authentication already began is not retroactively cancelled.
- Synthetic endpoint tests remain separate from actual normalized hook activity.
  They cannot establish that an app restarted, loaded hooks or approved Codex
  trust. An HTTP success proves endpoint acceptance only.
- Connection revision timestamps prevent old event history from proving that a
  new configuration loaded, including cached live-ingest history in the UI.
  Standalone CLI diagnostics can read persisted last-event history.
- Explicit per-app ports live in Extalia-owned `hooks/targets.json`. Forwarders
  and endpoint tests use the selected port; they do not replace the endpoint file
  owned by a running host. Disconnect removes the app override.
- Missing forwarders report stale connections. UTF-8 payload clipping uses byte
  lengths, and forwarding remains bounded by its deadline and decision-free
  output contract, including Antigravity's special pre-tool behavior.

A transcript can become unreadable before the first hook arrives in a host run.
Previously, receiving live hook activity left the old `unavailable` status and
error in place even though the channel became `hook`; subsequent transcript
polls preserved that stale error. A real normalized report now restores the live
observation state and emits the updated summary. Paused observations stay paused;
endpoint probes and events with no normalized steps establish no recovery.
Cached transcript history is preserved without inventing missing content, and
an unavailable source with no new hook remains unavailable.

The v0.4.127 lifecycle increment separates webhook-only Hermes from GUI Node
discovery. Command apps expose an optional `nodeStatus` prerequisite; invalid,
missing or Electron runtime paths cannot generate new command hooks. Existing
validated command paths, read-only diagnostics and undo remain usable. Failed
lookup is retried on a later operation, shared across concurrent status scans;
one unreadable application config does not hide other apps' diagnostics. Runtime
path/executable checks are not binary-version or vendor certification.

While visible, the connection card reads lightweight ingest status every two
seconds. Full connection/trust checks run initially, on manual refresh and after
debounced focus/visibility events, with one trailing scan when focus returns
during an older read. Reads are serialized and results from before a mutation
are discarded. A shown preview, trust choice and unsaved dashboard edits survive
refresh. Unmount stops timers/listeners and ignores late replies. Host changes
cannot leave action controls locked after an old request finishes.

Disconnect removes hooks and leaves the independently stored transcript-watch
setting unchanged, including watching that a connector previously enabled. The
English/Indonesian UI tells users to disable it on Observe if desired. No observer
preferences are silently removed. Complete lifecycle acceptance still requires
the crash/cross-process recovery work above and real installed vendor versions,
with explicit consent for any external configuration change.

## Verification

Local checkout v0.4.125: `pnpm check` passed, including 293 Vitest suites
(3,573 passed, one skipped), 257 Rust tests, lint, typecheck, strict Rust checks
and Web/Desktop/CLI builds. Connector regression tests use temporary homes only:

- `packages/host/test/connectSafety.test.ts`: all five config-root identities;
  Hermes YAML/profile/status/backup/undo cases.
- `packages/host/test/connectTransaction.test.ts`: changed previews and targets,
  caught write failures, preserved concurrent edits, explicit forwarding ports
  and large UTF-8 payloads.
- `packages/host/test/hooks.test.ts`: immediate Bearer/HMAC rotation refusal,
  invalid/deleted credentials and synthetic-versus-real liveness for all apps.
- CLI and renderer tests: approved fingerprint propagation, separate Codex trust
  consent, legacy compatibility and old-configuration event rejection.

These results establish scoped local behavior. No real application configuration,
provider session, npm package or GitHub release was changed by this verification.
Mock connection previews were visually checked in English/Indonesian, light/dark
themes and at 390 px width, with no document horizontal overflow. These previews
do not exercise a real vendor application's hooks.

The 2026-10-30 lifecycle increment v0.4.127 passed `pnpm check`: 294 Vitest suites
(3,616 passed, one skipped), 257 Rust tests and Web/Desktop/CLI builds. Details
are recorded in the current PRD status tracker and issue #64. Additional
temporary-home tests cover Linux/macOS/Windows
mode simulation, no-Node Hermes operation, discovery retry, malformed configs and
safe existing-hook removal. UI/CLI regressions cover missing prerequisites,
focused/hidden/overlapping reads, action and read completion after unmount,
capability replacement, preview/draft preservation and hook-only Disconnect.
Transcript-loss regressions reproduce the stale availability error and prove
actual hook recovery, retained cached history, no transcript recreation, and
preserved user pauses. Synthetic probes and unknown events cannot establish live
activity. Mock browser checks cover EN/ID light/dark at 390/1280 px with missing
command prerequisites and an enabled webhook-only Hermes control.
