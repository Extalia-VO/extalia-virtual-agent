# ADR 0072: Capability-bound observed control and cooperative inboxes

- Status: Accepted for local implementation; release and provider certification tracked separately
- Date: 2026-11-10
- Product requirement: [Observed agent control PRD](../product/prd-observed-agent-control.md)
- Tracking: [Epic #76](https://github.com/Extalia-VO/extalia-virtual-agent/issues/76)

## Context

Observe and Office character conversations share one application, but observation
is not authority to control an external process. Orca's owned process connections
provide useful ownership/receipt patterns; they do not establish an attachment to
an arbitrary already-open Desktop agent. Existing Codex, Hermes, official queue
and cooperative replies already have distinct authority and delivery semantics.

## Decision

Add a host-owned observed-control facade with opaque per-action capabilities.
Status inspection never connects, enables, launches or configures a source.
A capability binds a source reference/watch epoch, original connection or channel,
and exact turn/execution generation. Dispatch rechecks those values and the
selected action. Hermes rechecks explicit start/steer intent after its asynchronous
live-owner lookup. Questions and permissions retain their dedicated adapters.

Each user operation has an ID and immutable payload digest. Concurrent duplicates
share one result; changed payloads are refused. An uncertain outcome seals the
original route generation and never causes automatic replay or transport fallback.
Existing queue admission and tool submission are not model-consumption receipts.
The host keeps at most 512 operation records and 128 source bindings per lifetime.

Add a provider-neutral cooperative inbox as a new channel, not a managed runtime.
An explicit pairing creates a memory-only token and loopback URL. A tool-enabled
agent can use `extalia inbox` or MCP `poll_inbox` at a safe work boundary. The
consumer runs on the same host as Extalia; no remote tunnel is created. The token
proves possession only. It does not prove application/native session identity,
wake an idle agent, or grant permission/approval authority.

Inbox bounds are 32 channels, 16 queued messages per channel, 128 lifetime message
admissions/deduplication records, 32 visible receipts, 16,000 characters and 16 KiB
per message, and an absolute 30-minute token lifetime. Polls wait at most 25 seconds;
request bodies and concurrent requests are bounded. Exact Host, no Origin, one
bearer token and canonical loopback URL validation apply before any message read.
The client refuses redirects and performs no retry.

A message is queued before a consumer polls. Before writing a response it becomes
uncertain; HTTP finish records only delivery to the tool connection. A subsequent
explicit acknowledgement confirms that the paired caller reports receipt, not
that an identified agent acted on it. Ack-only does not consume another message.
Disconnected/uncertain responses are not replayed. Pause, source change, deletion,
re-pair, expiry and host close revoke authority; unread text is cancelled/cleared.
Tokens and inbox message bodies are never persisted by Extalia. Source applications
may retain their own tool history.

## UI and compatibility

Observe and selected Office characters share one composer, explicit action
selection and conservative receipt labels. Native connection/question/permission
panels remain available. Compact character controls bound their expanded details
and omit empty provider-specific tool rails. Older hosts retain their existing
controls. English is default, Indonesian secondary.

A separate manual pairing list supports existing tool-enabled CLI conversations
without an importer. It creates neither a native observation nor an Office avatar.
The ephemeral list survives page navigation while the host lives, not host restart.
Workspaces, provider accounts, source configuration and permission modes are unchanged.

## Placement and verification

TypeScript remains the bounded privileged host/transport boundary under ADR 0071;
React handles presentation state only. There is no new process, dependency or
language migration. The ownership inventory records the actual backend code.

Temporary-profile integration covers two independent message targets, real CLI/MCP
polls/acknowledgements, stale capability/ABA/revocation, duplicate operations,
authentication, bounded queues and uncertain delivery. Browser checks use a
production bundle and a temporary Bridge. These are not live-provider or packaged
cross-platform certifications. PRD issues #80 and #81 retain those separate gates.
