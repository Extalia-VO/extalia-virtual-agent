# Office camera tours and request attention

The Office camera offers an automatic tour and a manual mode. The idle tour
starts after a variable 60–120 seconds without interaction, redrawn after each
user interaction. It visits all characters currently admitted to the Office,
including idle agents and facility staff. Working characters receive variable
dwell times of 30–120 seconds; stationary idle characters receive 20–30 seconds. A camera
gesture or explicit selection gives control back to the user. The camera toggle
sits beside the light controls in the Office top bar; its choice is shared with
the scene and lasts for the current app session, including page navigation.

Newly admitted working agents, including delegated workers, receive immediate attention once the 2-second manual-interaction
cooldown has elapsed. Initial event/presence hydration establishes a baseline;
it does not announce every existing worker as newly active. Announcements expire
after 30 seconds and disappear when the agent is no longer working. Outstanding
input or approval requests take priority over those announcements and the idle
tour. After a character's final request resolves, a 1.5-second grace period
precedes moving to the next character.

Automatic focus changes on the same visible floor go directly to the next
character, preserving the focus zoom and easing the pan in and out over two
seconds. Only different or unknown floors use overview → travel → focus.
Manual Locate keeps its existing timing. Live follow continues as a character
walks or changes floors; it does not repeatedly restart the focus animation.

Each visit samples its duration once from real renderer metadata:

- Subagent working: 30–60 seconds.
- Main agent working: 60–90 seconds.
- Explicit meeting membership: 90–120 seconds; a meeting starting during an
  existing shot extends its total visit to at least 90 seconds.
- Working while moving: 60–120 seconds. A journey that continues beyond the
  sampled dwell is followed until arrival plus five seconds, capped at 120
  seconds of total focus time. The same bounded journey grace applies to idle
  walkers and staff.
- Stationary idle: 20–30 seconds.

Ordinary work restarts of existing characters do not interrupt another shot.
An idle character already in focus can start working and receive one full
working dwell; later work restarts do not reset that visit's clock. Genuine
new spawns and pending input/approval retain priority over minimum dwell and
journey grace. Manual activity, suspension and reduced-motion rules still apply.

The comfort policy was implemented in v0.4.232. Validation includes 74 focused camera
and attention tests, an independent read-only review, and actual CameraView /
director browser runs at 1440×900 light and 390×844 dark. Each run sampled 133
frames through a 16 m same-floor pan at stable focus zoom, then verified a
cross-floor overview/focus sequence and continued live follow. Temporary preview
files and their browser/server were removed. The final full project check passed
7,415 TypeScript tests (26 optional skipped), 474 Rust tests, all builds and
version/asset checks. Initial shared-checkout failures during concurrent chat
queue work passed after those sources and fixtures settled; this camera update
does not change queue behavior or external application configuration.

Live camera focus follows the selected character while walking and crossing
floors. Contextual focus uses zoom 48 (about 80 pixels for a standing character),
keeping the workstation and surrounding area visible. Floor and All floors
manual zoom out stops at 85% of the viewport-fitted overview zoom, capped at
character focus zoom for very large viewports. Reduced motion disables the idle tour and work announcements; explicit
input/approval attention remains available through a direct focus snap. These
are camera policies; focus does not grant permission or deliver an answer.

## Attention contract

[`cameraAttentionIds`](../../apps/web/src/office/cameraAttention.ts) accepts
renderer-ready `OfficeAgent[]`, protocol `ExtaliaEvent[]`, and a structural
pending-approval list (`id`, `sessionId`, `requestedAt`, optional `agentId`). It
returns session-scoped character IDs, oldest outstanding first, once per avatar.
It has no host, provider, or runtime imports.

- Explicit `approval.requested` records belong to
  `${sessionId}:${event.agentId ?? 'primary'}`. Multiple requests can keep the
  same character in the queue. A matching `approval.resolved` removes only that
  session's request; ordinary work or turn completion does not relocate or
  resolve it. `session.ended` closes that session's outstanding requests.
- Replay orders each session by `seq` when both events have one, then timestamp
  and event ID. Duplicate event deliveries and approval requests do not move a
  request's original owner or age. Independent sessions are ordered by request
  timestamp with deterministic character/key ties.
- Current managed host approvals and `pendingApprovalId` provide fallback when
  event history has not loaded. A known resolution prevents stale summary data
  from reopening the request. Fallback never fabricates an observed approval.
- `agent.state` or `subagent.state` must explicitly say `state: 'waiting'` and
  `phase: 'input' | 'approval'` for phase-only attention. Later state/activity,
  an answer/tool completion, or terminal turn/session activity clears that
  coarse wait. A question tool's paired `tool.started` at the same time and
  activity does not clear the wait it just announced.
- Idle input prompts, bare waiting/blocked states, model reply text, completed
  answers, and imported history do not create attention. Offline, Earlier,
  unavailable, paused, and non-admitted characters are excluded.

Identified approvals support concurrent requests. Phase-only sources expose one
current state per character: two simultaneous questions cannot be tracked
independently, and a tool completion does not identify which question was
answered. The camera therefore offers a coarse wait indicator for those sources,
not a guarantee of a complete external request inbox.

## Existing event path

The following describes repository support, not certification of every current
upstream runtime release. Configuration installation remains the separate,
consent-based `extalia connect` workflow; this camera feature edits no external
application configuration.

1. Command forwarders and Claude HTTP hooks post to `/api/hooks/<app>`. Hermes
   outbound webhooks use the same ingest with HMAC authentication. The shared
   Bridge/Desktop handler in [`hooks/http.ts`](../../packages/host/src/hooks/http.ts)
   authenticates, bounds and rate-limits payloads. Accepted ingest returns an
   empty HTTP 204; its response cannot approve, answer or steer the caller.
2. [`hooks/ingest.ts`](../../packages/host/src/hooks/ingest.ts) calls
   [`normalizeHook`](../../packages/host/src/hooks/normalize.ts). App normalizers
   produce source-neutral bodies and agent IDs; `hookProtocolEvents` validates
   them with the app runtime and `hook` channel. The observation registry in
   [`observations.ts`](../../packages/host/src/observations.ts) associates native
   sessions/subagents, creates observed sessions, and retains their events.
3. Transcript parsers in [`parsers.ts`](../../packages/importers/src/parsers.ts)
   and [`transcriptEvents.ts`](../../packages/host/src/transcriptEvents.ts)
   provide read-only catch-up. The latter recognizes question tools including
   `AskUserQuestion`, `ask_user`, `ask_user_question`, `ask_question`,
   `request_user_input`, `clarify`, and `ask_followup_question` as input waits.
4. [`useOfficeEvents`](../../apps/web/src/office/useOfficeEvents.ts) loads session
   events and [`presence.ts`](../../apps/web/src/office/presence.ts) projects
   per-character presence. Retention keeps the most recent 400 relevant events
   plus outstanding identified requests and each character's latest unresolved
   waiting phase, so a busy sibling cannot push another agent's pending request
   out of the activity window. Matching resolution or superseding activity
   retires the corresponding retained wait. Camera attention consumes those
   public inputs.

The optional [`extalia mcp`](../../packages/host/src/hooks/mcp.ts) server exposes
`report_intent` and `report_handoff`. `forwardMcpReport` sends their arguments
through the authenticated ingest; `normalizeMcpReport` is also recognized inside
native pre-tool hooks (including prefixed MCP names). `report_intent` emits
thinking/working/delegating; `report_handoff` emits subagent lifecycle/state.
Neither tool exposes a request ID, approval choice, answer, or explicit input
phase. A reported generic `waiting` state cannot enter this attention queue.
The forwarding path currently produces the ingest's `hook` channel, even though
the protocol also defines an `mcp` channel.

## Per-runtime sources and gaps

| Integration | Hook names and signals currently handled | Attention and reply limitations |
| --- | --- | --- |
| Codex | Connector installs `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `SubagentStart`, `SubagentStop`, `Stop`, `SessionEnd`. Shared Claude-style normalizer maps `PermissionRequest` to waiting/approval and question-tool starts to waiting/input. Transcript status recognizes `exec_approval_request`, `apply_patch_approval_request`, `request_permissions`, `request_user_input`, `elicitation_request`. | Hook/transcript normalization exposes phases, not paired durable approval IDs or answer delivery. Hook trust/availability remains an upstream configuration requirement. |
| Claude Code | `SessionStart` command hook; HTTP hooks for `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `PermissionRequest`, `Stop`, `SubagentStart`, `SubagentStop`, `SessionEnd`. `agent_id` retains child ownership. `PermissionRequest` and recognized question tools report waiting phases. | `permission_prompt` notifications become approval waits; `idle_prompt` becomes idle/input and gets no attention. Unknown notification kinds currently fall through to waiting/input, so their precision depends on the normalizer. No hook request/resolution IDs or external reply transport are supplied here. |
| Gemini CLI | Connector installs `SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeTool`, `AfterTool`, `Notification`. Shared normalizer handles tool questions and notification waiting phases. | `toolpermission` notifications become approval waits. There is no installed `PermissionRequest` hook or durable request/resolution mapping; generic notifications have the shared fallback above. Read-only observation cannot answer Gemini. |
| Antigravity | Connector installs `PreInvocation`, `PostInvocation`, `PreToolUse`, `PostToolUse`, `Stop`. Normalizer pairs tool steps by `stepIdx`, reports thinking/tool activity, and maps known question tools through shared tool classification. | No dedicated approval or notification hook is installed. Its pre-tool hook contract requires a decision, so the observer forwarder prints nothing for that event instead of returning `{}` (which that contract treats as denial). The observer supplies no decision. |
| Hermes | Connector installs `on_session_start`, `on_session_end`, `pre_llm_call`, `post_llm_call`, `pre_tool_call`, `post_tool_call`, `subagent_start`, `subagent_stop`, `pre_approval_request`. Normalizer maps `pre_approval_request` to waiting/approval and known question tools to waiting/input. | Webhook `extra` fields are only partially known; child IDs depend on recognized keys. There is no normalized approval-resolution hook or external decision delivery. `on_session_end` ends a run/turn, rather than proving every external request was answered. Managed Hermes capability is separately defined by its adapter. |

Connector source: [`connect/`](../../packages/host/src/connect/), especially
`codex.ts`, `claude.ts`, `gemini.ts`, `antigravity.ts`, and `hermes.ts`. The table
distinguishes installed hooks from additional event names the shared normalizer
can parse. Extalia Native managed approvals already use protocol
`approval.requested`/`approval.resolved` with host-supported choices; these do not
give observed runtimes the same control capability.

## Future durable requests and replies

A complete cross-runtime inbox needs a source-advertised request lifecycle:
native session and agent identity, stable request ID, request kind
(approval/question), creation time, structured choices or answer schema, and
explicit resolved/cancelled/expired events linked to that same request ID.
Reconnect/replay must preserve pending requests and reconcile terminal state
without guessing from silence, generic activity or assistant text. Parallel
questions on one agent must remain separate until each named request ends.

Reply UI must be gated by an actual versioned adapter capability for that
session and request kind. Displaying a request is insufficient. A supported
transport must correlate the native request, validate choices and current state,
deliver once with an acknowledgement, reject stale/replayed decisions, and
record resolution only when the runtime confirms it. Approval grants remain
separate from display history. Sources without that capability keep a read-only
“respond in the source app” route. The existing empty-204 observer endpoint and
MCP reporting tools provide no such transport.
