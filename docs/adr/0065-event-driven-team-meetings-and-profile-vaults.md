# 0065: Event-driven team meetings and profile vault exports

Status: proposed, implemented locally (2026-11-09).

## Context

Native teams could delegate work but could not emit a meeting lifecycle. The
Office's logical meeting projector was disconnected from its rendered seating,
which offered only workstations. Moving characters based on a word in a prompt
would invent a meeting without participant or discussion evidence.

Users also need one Obsidian-compatible vault per workspace profile, with several
workspaces sharing that destination. They chose grouping inside one Extalia
installation, rather than separate application data/credential contexts. Existing
`Workspace.profileId` is available for that grouping. Changing the host's profile
display metadata is not a storage or authority migration.

## Decision

1. Offer a bounded, nonparallel `conduct_team_meeting` to enabled Native teams.
   Persist selected configured roster identities and `meeting.started` before
   provider entry. Run two genuine read-only member rounds on approved models;
   the second receives actual first-round findings. Record attributed
   `meeting.contribution` events. Await entered workers before recording the
   completed/cancelled/failed terminal outcome. The lead synthesizes the returned
   evidence; the tool does not fabricate accepted decisions or implementation.
2. Optional rooms are explicit preferences. Without a room, the Office allocates
   an available fitting room to the whole participant group, preserving existing
   meetings first. Each group uses distinct chairs; overflow or occupied explicit
   rooms never share occupied chairs. Ordinary work remains at workstations.
   Retain active lifecycle anchors and causal identities beyond the normal event
   window, and release meeting state on terminal/session failure events.
3. Outside applications report their own meetings through the exact cooperative
   `report_meeting` MCP/hook contract. Authenticate with existing hook mechanisms,
   validate known source/session participants, correlate contributions and permit
   only the original reporter to complete the meeting. Source reports do not
   establish external process settlement or proof that an artifact was written.
   Labels-only observation removes meeting text and artifact content.
4. Persist vault profile metadata and `Workspace.profileId` assignments atomically
   in the existing host config. A workspace belongs to one registered profile;
   several workspaces can share it. Each profile has one canonical vault root,
   with overlapping roots refused. Preserve the original indexed vault and
   existing notes. New managed roots are `vaults/<opaque-profile-id>` beneath the
   current host data directory; the indexed owned root remains `vaults/default`
   for compatibility with the actual daemon profile. A different configured
   internal path must not inherit owned-root privileges.
5. Saved Native meetings may export host-owned Markdown minutes. Pin the profile,
   workspace, root, binding revision and directory identity before provider work,
   recheck them before publishing, and create an immutable new note under
   `Meetings/<workspace-id>/<meeting-id>.md`. Exact retries are idempotent;
   different existing content is never overwritten. Note content records actual
   discussion evidence and outcome; final lead synthesis remains in the chat.
   An export failure is separate from discussion success. History-off meetings
   never export durable minutes.
6. Export consent is explicit for external destinations. A previously selected
   external Knowledge indexing root is not an automatic write grant. Its opt-in
   binds to that exact root; changing the root revokes that implicit match.
   Profile bindings cannot grant generic model file reads or writes. External
   vaults overlapping registered projects remain subject to workspace write
   boundaries. Extalia does not install or edit `.obsidian` configuration.

## Boundaries and consequences

These workspace/vault profiles are not independent runtime authority profiles or
complete credential/session isolation. Canonical daemon/control scopes retain
the host's existing identity; do not substitute a workspace grouping ID into a
runtime grant. True separate data contexts still require separate host data
directories and an explicitly designed lifecycle/migration flow.

The running Knowledge index remains on its original selected vault. Additional
profile vaults are explicit export destinations, not silently added live indexes
or model context. Switching the mission daemon per meeting would change process
ownership and is not permitted. Multiple indexed vault contexts need separate
protocol and lifecycle work.

Room capacity is ten or fourteen including the lead. Native can invite up to
thirteen configured members; its existing worker admission ceiling remains
eight active members. Meeting completion is not authoritative acceptance of
decisions, dependency release, full descendant settlement or closure of the v0.5
and v0.6 roadmap gates. Existing cooperative filesystem safeguards do not claim
an operating-system sandbox against a hostile local administrator.

See [the meeting guide](../getting-started/team-meetings.md) for the supported
user flow and [the status tracker](../product/prd-app-flow-and-live-agents.md)
for validation evidence.
