# PRD: Observe and control existing agent conversations

| | |
| --- | --- |
| Status | Foundation implemented and released in v0.4.288; real-provider/version/platform acceptance remains open |
| Product | Extalia Virtual Office, one app across Web and Desktop |
| Scope date | 2026-11-10; status reconciled 2026-11-12 against v0.4.288 |
| GitHub | [Epic #76](https://github.com/Extalia-VO/extalia-virtual-agent/issues/76), [Observe v1 milestone](https://github.com/Extalia-VO/extalia-virtual-agent/milestone/9) |
| Related | [App flow and live agents](prd-app-flow-and-live-agents.md), [observed replies](../getting-started/observed-replies.md), [ADR 0061](../adr/0061-observed-reply-channels.md) |

## 1. Goal

Make Observe the single place to inspect activity from agents running in their
own applications and, where an existing verified transport allows it, send a
message to that same conversation. The same capabilities should be available
from the selected observed character in the Office. Keep the user's provider
application and conversation as the owner of native work.

## 2. Terms and boundaries

- **Installed CLI** means a command is present on the machine. It says nothing
  about starting it, observing it, or attaching to a running conversation.
- **Managed launch** means Extalia starts and owns a new process/session. It is
  separate from Observe and requires an explicit managed-runtime feature.
- **Observation** means transcript, hook, or explicit MCP reports provide
  activity. It grants no authority to control the source.
- **Native control** means a verified public provider transport attaches to the
  exact existing native conversation and supports a named action.
- **Cooperative control** means the user pairs a token/channel and the agent
  explicitly calls an Extalia CLI or MCP tool. It controls only that tool call
  or paired consumer, not native UI, approvals, or arbitrary processes.

An installed CLI is not proof of native attachment. Do not claim universal
Desktop attachment, launch agents from Observe, type into terminals, inject
into application processes, or turn imported/hook data into control authority.
Manual pairing proves possession of its bearer token only, not source app,
conversation, or agent identity.

## 3. Product experience

Observe lists and inspects existing observed sessions. A selected session can
show route-specific capabilities, evidence, delivery limits, questions and
approvals. The Office character dialog presents the same session-bound actions
without implying the character is a separate runtime. Unavailable capabilities
remain visibly unavailable; hooks/transcripts alone never enable native send.

For a watched session, a user may create a persistent cooperative inbox and
paste its CLI or MCP polling instruction into the intended tool-enabled CLI
conversation. Extalia can then enqueue a message for that paired consumer. An
existing one-shot `extalia reply` / MCP `await_reply` channel remains a distinct
route that returns one answer to a currently waiting tool call; it does not
wake an idle agent. Native provider routes remain explicit and provider-owned.

No provider configuration, credentials, permissions, or software are installed
or changed by Observe pairing. The listener binds loopback, and secrets and
message content remain memory-only in Extalia.

## 4. Current foundation and provider scope

The released foundation defines a common route/capability/receipt contract,
capability IDs fenced to a source binding, explicit dispatch, and existing
transport drivers. It also adds a bounded loopback cooperative inbox and a
single-poll CLI client. The original combined project gate passed at 0.4.248;
the foundation subsequently merged and shipped with v0.4.288. Publication does
not establish real-provider/version/platform certification. The dated evidence
in §7 remains historical, with current release evidence linked separately.

| Route | Evidence and allowed effect | Limit |
| --- | --- | --- |
| Codex native | Existing same-server attachment; idle start or exact active-turn steer | Existing native owner and verified turn |
| Codex queue | Existing official queue interface | Queue receipt, not proof of consumption |
| Hermes native | Conditional public same-owner attachment | Exact session and execution generation; unavailable if public attach is absent |
| Cooperative tool | Existing paired one-shot reply channel | A currently waiting tool call only |
| Cooperative inbox | Explicit token-paired CLI/MCP consumer | Queue admission only; consumer may not be the claimed native source |

Transcript/hook/MCP observation for Claude Code, Gemini CLI, Antigravity, and
other clients does not imply native control. Later source-specific prompt adapters
and model/attachment controls are recorded in the [app-flow tracker](prd-app-flow-and-live-agents.md#11-status-tracker)
(C10–C12); they do not create universal native attachment or approval authority.
Real-provider and cross-platform certification remain separate acceptance work.
Any owned PTY or ACP-style managed CLI launch is future feasibility work, outside Observe and not
implemented here.

## 5. Requirements and acceptance criteria

**OV-AC01 — One-app surfaces.** Observe and the Office character dialog expose
the same session-scoped route status and actions, with localized English and
Indonesian labels and unavailable states. Neither surface starts a CLI.

**OV-AC02 — Capability authority.** Host status derives actions from an
adapter's currently verified route. Each capability is bound to exact source,
attachment, and generation; status inspection never connects, launches, or
configures a provider. Transcript-only or notification-only sources get no
native capability.

**OV-AC03 — Fresh dispatch.** Dispatch requires the current capability and
rechecks target, attachment, generation, and action immediately before effect.
Idle `start` cannot become `steer`, and `steer` cannot target another turn.
Pause, removal, replacement, re-pair, source change (including ABA), or host
closure revokes pending authority.

**OV-AC04 — Honest receipts.** Every dispatch has an operation ID and a
non-retryable receipt. Repeating the same operation and payload returns its
receipt; reusing its ID for different content is rejected. Unknown outcomes
remain uncertain, are never automatically resent, and never fall through to a
different route. The host retains at most 512 operation receipts and 128
session bindings. A queue/delivery receipt never claims agent consumption.

**OV-AC05 — Inbox bounds.** Inbox messages are 1–16,000 characters and at most
16 KiB UTF-8. At most 16 messages queue per channel and 128 operation receipts
are retained per channel; status exposes at most the last 32 receipts. Channels
expire after an absolute 30 minutes, with at most 32 active channels. Poll wait
is at most 25 seconds, body at most 1 KiB, and listener admits at most 64
concurrent requests. Limits are enforced by the host, not just the UI.

**OV-AC06 — Inbox authentication.** Listener accepts only exact loopback Host,
one bearer token, no Origin, and the paired channel route; rejects redirects,
remote URLs, malformed/oversized bodies, and unknown fields. Tokens are random
256-bit values issued by explicit pairing, memory-only, and revoked
on close, expiry, pause, source change, or re-pair.

**OV-AC07 — Poll and acknowledgement semantics.** One consumer poll may wait
per channel. A poll can return one queued message. The consumer acknowledges a
message only after receiving it; acknowledgment alone never consumes the next
message. Interrupted delivery is marked unknown and is never replayed. “Delivered”
means the HTTP response was written, not that the agent read or acted on it.

**OV-AC08 — Privacy and pairing.** Do not persist inbox token, message text,
tool result, or provider credentials. Manual pairing creates no observed/native
session and displays that it proves token possession only. Existing provider
configuration and permission state are unchanged.

**OV-AC09 — Compatibility evidence.** Provider claims are version- and
transport-specific. Maintain a compatibility matrix with separately recorded
CLI presence, observation channel, native attachment, cooperative tool support,
platform, and real-provider certification. Never infer one capability from
another.

## 6. Phases and issue plan

The foundation and compatibility work use [Observe v1: Capability-bound agent messaging](https://github.com/Extalia-VO/extalia-virtual-agent/milestone/9). Owned CLI feasibility stays in the existing integration-verification milestone; it does not block the current cooperative/native Observe foundation.

| Issue | Work | Acceptance / dependency |
| --- | --- | --- |
| [OV-00 Epic](https://github.com/Extalia-VO/extalia-virtual-agent/issues/76) | Track Observe expansion and acceptance criteria | Links the scoped issues below; no separate duplicate feature promise |
| [OV-01 Capability facade](https://github.com/Extalia-VO/extalia-virtual-agent/issues/77) | Platform/host capability discovery, dispatch and conservative transport receipts | OV-AC01–04; foundation shipped in v0.4.288, independent acceptance still tracked |
| [OV-02 Cooperative inbox](https://github.com/Extalia-VO/extalia-virtual-agent/issues/78) | Finish setup/poll/ack/close UX and operational copy | OV-AC05–08; exact bounded receipt semantics |
| [OV-03 Surface integration](https://github.com/Extalia-VO/extalia-virtual-agent/issues/79) | Ensure selected observed character and Observe use one source of capability truth | OV-AC01–03; no arbitrary CLI-launch language |
| [OV-04 Compatibility certification](https://github.com/Extalia-VO/extalia-virtual-agent/issues/80) | Verify named provider transports and supported versions on each claimed platform | OV-AC09; separate evidence for installed CLI, observation, native attach, and cooperative tool |
| [OV-05 Owned CLI feasibility](https://github.com/Extalia-VO/extalia-virtual-agent/issues/81) | Evaluate a separately owned PTY/ACP managed-runtime contract | Future decision only; not a prerequisite or part of Observe control |

Coordinate with existing roadmap issues **#38**, **#50** (Hermes), and **#52**
(managed Codex/Claude). Reuse or link their relevant work; do not create duplicate
promises for existing Hermes attachment, managed runtimes, or previously
implemented one-shot replies. The new persistent cooperative inbox and unified
capability-fenced Observe contract are the distinct scope here.

## 7. Release and verification

Implementation updates follow the repository protocol: update the relevant
tracker/changelog, run `pnpm version:patch` once, then `pnpm check`. Do not
describe local work as merged, published, or provider-certified until those
gates and the relevant real-provider evidence are complete.

### Local acceptance evidence — 2026-11-10

The Observe implementation update is **0.4.247**, verified by the combined
workspace gate at **0.4.248** with the separately coordinated Native standby
update. Environment: macOS 26.6.1 ARM64, Node 26.13.0, pnpm 12.7.0; local
working tree based on `c98ec51`, not a published release.

| Check | Observed result |
| --- | --- |
| Focused regression tests | 158 passed across control discovery/dispatch, drivers, inbox, real host integration, conditional Hermes intent, UI model/character layout, CLI connection and inbox parsing |
| Static checks | Host, Web and CLI typechecks and scoped lint passed; ownership migration baseline passed with actual privileged TypeScript recorded |
| Complete workspace gate | `VITEST_MAX_WORKERS=2 pnpm check` exited 0: 561 TypeScript suites passed, 3 skipped; 8,015 tests passed, 26 skipped; 536 Rust tests passed; format, Clippy, architecture/public/schema checks, Web/Desktop/CLI builds, version and hair-asset checks passed at 0.4.248 |
| Temporary production Bridge | Two independent manually paired conversations received messages via the bundled CLI and MCP `poll_inbox`; explicit acknowledgement was reflected in host receipts; pairing created no native sessions |
| Browser surfaces | Production Web bundle: EN/light desktop and ID/dark 390-pixel viewport inspected; one character composer, no empty native tools rail, no false stale warning after successful queue admission, no horizontal overflow on the mobile pairing page |
| Provider certification | Not performed: CLI/MCP consumers and the hook-only Office source were synthetic temporary-profile fixtures, not live Claude/Gemini or packaged cross-platform acceptance |

The hook-only fixture has no native transcript; its existing optional history
request is unavailable. The activity and message controls were checked without
claiming a complete source transcript or a clean browser console for that fixture.
No real provider configuration or user profile was modified by that historical
verification. At the v0.4.288 reconciliation, source integration and publication
are complete; issues #77–79 retain their independent acceptance tracking, and
#80 retains real-provider/platform certification. Publication alone does not
close these acceptance issues.

### Release reconciliation — 2026-11-12

The [v0.4.288 release](../release/v0.4.288.md) records the merged source, all twelve
Release jobs passing, packaged checks and isolated npm installation verification.
[Release issue #91](https://github.com/Extalia-VO/extalia-virtual-agent/issues/91)
records completed publication. These verify the distributed baseline; they do
not replace the named live-provider/platform evidence required by OV-AC09.

## 8. Reference and adaptation

[Orca](https://github.com/stablyai/orca) describes running agents in separate
worktrees and combining chat, terminal and orchestration in one application.
The Extalia design decision is to use explicit connection ownership and
per-action capabilities in its existing Observe/Office surfaces. An external
agent's observation, paired tool inbox and native attachment remain distinct.
Orca's supported-agent list is not evidence that Extalia can attach to those
providers or to an already running Desktop session. Managed process ownership
is evaluated separately in #81; this foundation introduces no terminal runtime.
