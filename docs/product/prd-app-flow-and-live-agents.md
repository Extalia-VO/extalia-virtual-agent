# PRD: App flow, modes and live agent apps in the Virtual Office

| | |
| --- | --- |
| Status | Implemented (phases A–E complete, v0.0.19) |
| Baseline | v0.0.13 (verified 2026-10-11); current v0.0.19 |
| Owners | Product owner; implementation by any coding agent (Claude Code, Codex, Hermes, Gemini) |
| Related | [runtime-adapters](../architecture/runtime-adapters.md), [ADR 0004](../adr/0004-managed-and-observed-sessions.md), [security](../architecture/security.md), [office-development](../design/office-development.md), [AGENTS.md](../../AGENTS.md) |

This document is the single source of truth for this work. Any agent that
continues it must read it first, keep the [status tracker](#11-status-tracker)
current, and follow the [working protocol](#10-working-protocol-for-coding-agents).

---

## 1. Problem and goal

Extalia is one application (Web through the `extalia` Bridge, and Desktop)
with two ways of working:

- **Virtual Agent**: Extalia runs agents itself (Extalia Native with an API
  key or router, or Hermes Agent) and the user chats with them in sessions.
- **Virtual Office**: a 3D office where agents appear as characters, walk,
  sit at desks, and show what they are doing on their screens, in bubbles and
  in toasts.

The Office must also show agents that run **in their own apps**: Codex
(Desktop and CLI), Claude Code, Gemini CLI and Hermes. The user connects an
app **once** (by running one command or pasting one prompt that Extalia
gives them). From then on, every time they prompt in that app, the activity
appears in the Office within about a second, without picking sessions by
hand.

## 2. Target scenario

```
First install
  launch → Splash → setup only (no sidebar, Office or Chat)
         → connection: (1) Extalia Native  or  (2) Hermes Agent
         → 3D Office

Already set up
  launch → Splash → 3D Office, every time (the last page is not remembered;
  the last-used workspace is, while it still exists)

Host unreachable or slow
  launch → Splash → recovery panel (Retry, copyable diagnostics)

Chat and 3D Office (separate sidebar pages, one click apart)
  Office-only controls (floors, lights) sit in the top bar while the Office is open

Virtual Office with outside agents
  Settings/Office → "Connect agent apps" → copy one command (or prompt)
  → run it once in a terminal (or paste the prompt into Codex/Claude/…)
  → prompts in that app now show up live in the Office
```

## 3. Current state (verified on v0.0.13)

Verified by code audit, a real end-to-end run with temporary data (mock
model, fake Hermes, Desktop smoke) and experiments with real Codex 0.161 and
Claude Code 2.1.295 against mock model servers in temporary homes.

| Scenario step | Status | Evidence |
| --- | --- | --- |
| One app for Web and Desktop | Met | Desktop loads `apps/web/dist`; the Bridge serves the same build. Only difference: native folder picker on Desktop. |
| First install: setup → connection → Native or Hermes | Partly | Wizard steps Welcome → Model → Workspace → Done. The Native/Hermes choice only appears when a Hermes binary is detected. Both paths run prompts. |
| After setup → Virtual Agent | Not met | "Enter your office" opens the 3D Office (`App.tsx` `defaultPage = 'office'`). |
| Later launches → Virtual Agent (sessions) | Not met | Every launch opens the 3D Office; the last page is not remembered. Sessions and history persist correctly. |
| Clear Virtual Agent / Virtual Office modes | Partly | Both exist as sidebar pages ("Chat", "3D Office"); no explicit mode switch. The Settings workflow switch (managed/observe) barely changes the UI. |
| New sessions of outside apps appear automatically | Not met | Observation only covers sessions the user picks from a scan (max 10). A new Codex session never appears. |
| Outside activity shows as Office activity | Not met | Only `session.updated` is emitted live; transcripts replay as messages and raw tool text. The Office loads event history only for managed sessions. Characters show "Observing history". |
| `extalia connect`, hook ingest | Not met | `extalia connect` is an unknown command; the Bridge has no ingest route; the Bridge token changes on every launch; Desktop has no loopback listener. |
| Transcript latency | Measured | 0.3–2.8 s (mean ≈ 1.3 s, worst ≈ 4 s) from append to `session.updated`. |

Known bugs and friction to fix along the way:

1. `/brand/hermes-logo-black.svg` returns 404 in the setup wizard (light theme).
2. Custom endpoint: "Test connection" with an empty model shows the raw error
   "model: expected a string with content"; Next stays disabled until a model
   is typed.
3. Wizard copy (Welcome, step label "Model", Done) is written for the Native
   route only.
4. Hermes workspaces default to "File edits: Ask · Commands: Ask" although
   Hermes cannot ask for approval through Extalia.
5. Switching the workflow to "managed" in Settings without a connection or
   workspace sets `setupComplete=false` and reopens the wizard.
6. Observed sessions have `workspaceId: ''` and disappear under a project filter.
7. Codex rollouts: `<environment_context>` is parsed as a user message.
8. The 9Router preset requires an API key, but a local 9Router answers without one.

## 4. Goals and non-goals

Goals

- G1. The scenario in section 2 works on Web and Desktop.
- G2. Connecting an outside app is a one-time, reversible step with a dry run
  and the user's approval.
- G3. Outside activity reaches the Office in under 1 s (hooks) and degrades
  gracefully to transcript polling.
- G4. Outside sessions appear automatically, as characters with real states
  (thinking, working with activity and target, waiting, idle, ended).
- G5. Nothing leaves the machine; no secrets are stored or shown.

Non-goals (for now)

- Controlling outside agents from Extalia (prompting, approving, cancelling
  Codex/Claude/Gemini). Observed sessions stay read-only.
- Driving the Hermes dashboard's private WebSocket protocol.
- Cloud sync, remote machines, multi-user offices.

## 5. Requirements

Each requirement has an id, the acceptance criteria (AC) that define done,
and the phase it belongs to.

### Phase A: app flow and modes (≈ 1 day)

- **A1. Landing page.** *(Revised in v0.0.20, see U6.)* After finishing
  setup and on every later launch the app opens the **3D Office**; the
  last-used workspace is kept while it exists. Without an agent host (plain
  browser) it opens Get started.
  - AC: fresh install → Splash → wizard → final button opens the 3D Office;
    restart → Splash → 3D Office, whatever page was open before.
- **A2. Mode switch.** *(Removed in v0.0.20.)* The top-bar "Virtual Agent |
  Virtual Office" switch is gone; Chat and 3D Office stay one click apart in
  the sidebar, and the top bar shows the Office floor and light controls only
  while the Office is open (U2).
- **A3. Runtime choice is always visible.** Setup's connection step always
  shows "Extalia Native" and "Hermes Agent". When Hermes is not installed,
  the Hermes option explains how to install it or set `EXTALIA_HERMES_BIN`,
  and cannot be selected.
- **A4. Final button wording** follows the destination ("Open Virtual Agent").
  The Welcome and Done copy covers both runtimes.
- **A5. Fix bugs 1–5** from section 3. Hermes workspaces show permissions as
  "Managed by Hermes" (approval bypass only when the user explicitly allows
  everything).
- **A6. 9Router preset**: API key optional (bug 8); keep the default URL
  `http://localhost:20128/v1`.

### Phase B: observer upgrades without hooks (≈ 1–2 days)

- **B1. Automatic discovery.** An opt-in "Watch new sessions automatically"
  per detected app: the host rescans recently modified sessions every few
  seconds and adds them as observations (LRU of about 24 active; older ones go
  to history). Manual picking stays available.
- **B2. Structured transcript events.** Parsers emit `tool.started` /
  `tool.completed` (classified activity kind and target), `agent.state`, and
  `turn.completed` for observed sessions instead of raw tool text. Drop
  `<environment_context>` and developer messages (bug 7).
- **B3. Office integration.** `useOfficeEvents` loads observed sessions too,
  so presence, screens, bubbles and toasts react. Observed sessions are
  mapped to a workspace by matching `cwd` with a workspace folder (bug 6).
- AC: in a temporary `CODEX_HOME`, writing a new rollout makes a character
  walk in within 8 s; appending a tool call changes its screen and shows a
  toast.

### Phase C: hook ingest and `extalia connect` for Codex and Claude Code (≈ 1–2 weeks)

- **C1. Ingest endpoint.** `POST http://127.0.0.1:<port>/api/hooks/<app>` on
  the Bridge **and** a loopback listener in Desktop (same code in
  `packages/host`). Rules: loopback only; existing Host allow-list; reject
  requests that carry an `Origin` header; JSON only, 64 KB limit; rate
  limited; always reply `204` with an empty body (a hook can never block or
  steer the agent).
- **C2. Ingest token.** A per-install token (32 random bytes) at
  `EXTALIA_HOME/hooks/token`, mode 0600, valid only for `/api/hooks/*`, never
  for `/api/call`. `extalia connect --rotate` replaces it. The port is stored
  in `EXTALIA_HOME/hooks/endpoint.json`.
- **C3. Normalizers.** Pure functions per app (new package or
  `packages/importers`) with fixture tests built from real captured payloads.
  Mapping:

  | Native hook | Extalia Protocol events (channel `hook`) |
  | --- | --- |
  | SessionStart, or first event of an unknown `session_id` | `session.started { control: 'observed' }`, register `(app, session_id)` |
  | UserPromptSubmit / BeforeAgent | `prompt.submitted { via: 'native' }`, `agent.state thinking` |
  | PreToolUse / BeforeTool | `tool.started`, `agent.state working { activity, target }` |
  | PostToolUse / AfterTool | `tool.completed { ok, output ≤ 4000 chars, redacted }`, `file.written` when known |
  | PermissionRequest / Notification | `agent.state waiting` |
  | SubagentStart / SubagentStop | `subagent.spawned` / `subagent.state` |
  | Stop / AfterAgent | `turn.completed`, `agent.state idle` |
  | SessionEnd | `session.ended` |

  Activity classification: Bash → `command` (or `test` when it runs a test
  command), Edit/Write/apply_patch → `edit`, Read → `read`, Grep/Glob →
  `search`, Web* → `web`, Task/subagent → `delegate`. Target: file base name or
  the head of the command.
- **C4. Session registry and liveness.** Observed sessions fed by hooks use
  their real `agent.state`; a session with no event for 10 minutes decays to
  idle; transcript-only sessions stay "Observing". `transcript_path` (only
  when inside the app's known root) links the transcript for history and
  catch-up after a restart. Remove duplicates between hook and transcript events.
- **C5. Forwarder.** `EXTALIA_HOME/hooks/forward.mjs <app>`: dependency-free,
  reads stdin, POSTs with a 1 s timeout, prints nothing, always exits 0.
  Installed at a stable path (never an `npx` cache path).
- **C6. `extalia connect <codex|claude|gemini|hermes>`** with `--dry-run`,
  `--yes`, `--port`, `--rotate`, plus `extalia disconnect <app>` and
  `extalia connections` (status, last event). Steps: detect app and version
  (warn outside the verified-version list) → read config → plan → print diff →
  ask y/N → back up to `EXTALIA_HOME/connect/backups/<app>/<timestamp>/` →
  atomic write with marked entries → send a test event → report backup path
  and undo command. Never touch the user's own hooks, `notify`, project-level
  or committed config.
- **C7. Claude Code** (`$CLAUDE_CONFIG_DIR` or `~/.claude/settings.json`,
  user level only): HTTP hooks for UserPromptSubmit, PreToolUse,
  PostToolUse(Failure), Notification/PermissionRequest, Stop,
  SubagentStart/Stop and SessionEnd with `Authorization: Bearer <token>` and
  `timeout: 2`; a **command** hook (the forwarder) for SessionStart, because
  SessionStart does not fire HTTP hooks. Note: `--bare`, `disableAllHooks` and
  managed `allowedHttpHookUrls` policies can block hooks; `connections` must
  report that.
- **C8. Codex** (`$CODEX_HOME/config.toml`): `[[hooks.<Event>]]` entries with
  `matcher = "*"` and `hooks = [{ type = "command", command = "<node>
  <EXTALIA_HOME>/hooks/forward.mjs codex", async = true, timeout = 5 }]` for
  SessionStart, UserPromptSubmit, PreToolUse, PermissionRequest, PostToolUse,
  SubagentStart/Stop, Stop, SessionEnd. Edit through the Codex app-server
  `config/batchWrite` (with `expectedVersion`) or a comment-preserving TOML
  edit. **Trust:** new hooks are untrusted until reviewed. Default: tell the
  user to approve them in Codex `/hooks`. With separate explicit consent,
  write `hooks.state."<file>:<event>:<i>:<j>".trusted_hash` through the
  app-server (`hooks/list` → `currentHash` → `config/value/write`) and verify
  the status is trusted. Trust keys depend on hook position; `connections`
  re-checks it.
- **C9. Connect UI.** A "Connect agent apps" card (Settings and Office): one
  row per detected app with version, status and last event; buttons **Copy
  command**, **Copy prompt**, **Test**, **Disconnect**; hint "restart the app
  after connecting". Primary path is the terminal one-liner, because agent
  sandboxes (Codex) block writes outside the workspace.
- AC (Codex and Claude, temporary homes, mock models): after `connect --yes`,
  a prompt in the app makes a character appear within 1 s, its screen and
  bubble show the tool step, approvals show as waiting, and `disconnect`
  restores the config byte-for-byte except unrelated user edits.

### Phase D: Hermes, Gemini CLI and the Hermes dashboard (≈ 2–3 days)

- **D1. Hermes webhooks.** `connect hermes` adds one `hooks.outbound` entry
  per profile `config.yaml` (url `/api/hooks/hermes`, HMAC secret, `timeout:
  2`, events pre/post_tool_call, on_session_start/end, subagent_*,
  pre_approval_request). Verify HMAC (`X-Hermes-Signature-256`). Skip events
  from Hermes sessions that Extalia itself started (managed Hermes runs) to
  avoid duplicates. Edit YAML without losing comments. Verify a plain-HTTP
  loopback URL is accepted.
- **D2. Gemini CLI.** Command hooks (the forwarder) in
  `~/.gemini/settings.json` for SessionStart/End, BeforeAgent/AfterAgent,
  BeforeTool/AfterTool, Notification; timeout in milliseconds (2000). Install
  Gemini CLI first to verify payloads.
- **D3. Hermes dashboard (optional read source).** When the user enters a
  dashboard URL (for example `http://127.0.0.1:9119`), read sessions and
  timelines (`/api/sessions`, `/api/sessions/{id}/timeline`, cursor
  `after_row_id`) as an alternative to reading `state.db`. Not a live
  channel and not a control channel.

### Phase E (optional): MCP reporting

- Extalia MCP tools (`report_intent`, `report_handoff`) plus a short
  instruction, best effort, adding meaning hooks cannot see.

## 6. Technical design notes

```
Codex / Claude / Gemini hook ──► forward.mjs ─┐
Claude HTTP hook ──────────────────────────────┼─► POST 127.0.0.1:<port>/api/hooks/<app>
Hermes outbound webhook (HMAC) ────────────────┘          │ token / HMAC check
                                                           ▼
                                            normalizer(app, payload) → protocol events
                                                           ▼
                              observed-session registry (app, session_id) + transcript link
                                                           ▼
                                   host publish → SSE / IPC → Office presence, screens,
                                                              bubbles, toasts, console
```

- Captured payloads (Codex 0.161 and Claude Code 2.1.295) share Claude-style
  fields on stdin: `session_id`, `turn_id`, `transcript_path`, `cwd`,
  `hook_event_name`, `model`, `permission_mode`, `tool_name`, `tool_input`,
  `tool_use_id`, `tool_response`, `prompt`, `last_assistant_message`. Store
  fixtures under the normalizer tests; never commit real user content.
- Measured hook latency: Claude PreToolUse arrived 14 ms after the model
  response; Codex hooks run in-process at the event. Target end-to-end
  (hook → Office) < 200 ms.
- The Codex `notify` setting only fires `agent-turn-complete`; it is not a
  substitute for hooks.
- The earlier private prototype polled the Codex `state_5.sqlite` `threads`
  and `thread_spawn_edges` tables; useful later for subagent edges, not as the
  live channel.

## 7. Security and privacy

- Loopback only; nothing leaves the machine. No telemetry.
- Separate ingest token (ingest scope only) or HMAC; never the UI token.
- Redact prompts and tool text with the existing secret masks; clip labels;
  tool output at most 4000 characters; a setting can drop prompt text
  ("labels only").
- Never persist raw native payloads.
- Every config write: detection, dry-run diff, explicit approval, backup,
  marked entries, undo. Never project-level or committed config. Tests use
  temporary homes only (`HOME`, `CODEX_HOME`, `CLAUDE_CONFIG_DIR`,
  `HERMES_HOME`, `EXTALIA_HOME`); never read or write the developer's real
  `~/.codex`, `~/.claude`, `~/.gemini` or `~/.hermes`.
- Hooks fail open and stay silent: an Extalia outage never blocks the agent.

## 8. UX copy (draft)

- Card title: "Connect agent apps" / "Hubungkan aplikasi agent".
- Row: "Codex 0.161 · Not connected" with **Copy command**:
  `npx -y extalia-vo@latest connect codex`
- **Copy prompt** (paste into the agent app):

  > Run `npx -y extalia-vo@latest connect codex --dry-run` and show me its
  > output verbatim. Do not change anything yet. If I reply "apply", run it
  > again with `--yes` and tell me the backup path and the undo command.

- After connecting: "Restart Codex so it loads the new hooks. In Codex, open
  /hooks and approve the Extalia hooks."
- Status: "Connected · last event 3 s ago" / "Waiting for the first event".

## 9. Testing and verification

- Unit: normalizers (fixtures per app and version), config planners (dry-run
  diff, idempotent, disconnect restores), token and endpoint rules.
- Integration (opt-in): real Codex and Claude CLIs against mock model
  servers in temporary homes; assert events arrive and the Office reacts.
- Office E2E: headless Playwright against the Bridge with temporary
  `EXTALIA_HOME`, `EXTALIA_SECRET_STORE=memory`, a temporary `HOME`; post a
  synthetic hook and check a character appears and its screen/toast change.
- Manual: Codex Desktop, Gemini CLI, Hermes webhooks on a real install, only
  with the owner's approval.
- Every update: `CHANGELOG.md` `[Unreleased]` notes → `pnpm version:patch` →
  `pnpm check` (lint, boundaries, public-safety, typecheck, tests, build).

## 10. Working protocol for coding agents

Several agents (Claude Code, Codex, Hermes) may continue this work in turns,
for example when one runs out of quota.

1. Read [AGENTS.md](../../AGENTS.md) and this PRD first; check
   `git status`, `git log -5` and the status tracker below before editing.
2. Pick the next unchecked item; mark it "in progress (agent, date)" in the
   tracker before starting, and update it when stopping, even mid-way, with a
   one-line handoff note (what is done, what is next, files touched).
3. Never commit or push without the owner's explicit approval. Never edit a
   real home configuration. Never add `.glb`/`.gltf`/`.fbx` files (avatar
   models are local-only, see `apps/web/src/office/scene/avatars/README.md`).
   Exception: project-authored scene models explicitly registered with hashes,
   MIT license and provenance in `apps/web/public-assets/models.json` may be
   distributed. Licensed avatar exports may also ship under the separately
   reviewed RenderHub license profile and notices; unknown source packs remain excluded.
4. Keep shared files (`OfficePage.tsx`, `OfficeCanvas.tsx`, `i18n.ts`,
   `styles.css`, `service.ts`, `agentHost.ts`) edits small and targeted; other
   agents may be editing them.
5. All UI text in English and Indonesian.
6. Finish each update with CHANGELOG notes, `pnpm version:patch` and a green
   `pnpm check`.

## 11. Status tracker

| Id | Item | Status | Notes |
| --- | --- | --- | --- |
| R-PUBLIC-MODELS | Shared public scene assets and free macOS preview | Implemented locally v0.4.111 (Codex orchestration, 2026-10-27) | Sixteen approved original scene GLBs with MIT license/provenance/hash inventory plus twelve retained avatar/body/hair GLBs under the separate RenderHub Extended Use license profile. Original rigs, outfits and textures remain unchanged; unregistered local files stay excluded. Source copy without local-assets builds all 28 models; Web/CLI and mounted macOS DMG resources match. Preview is valid ad-hoc, manual-update only; notarized mode retains strict Apple checks. Mounted arm64 DMG passes host/Office/F1–F3 smoke with no model errors; ZIP signature passes. Full check: 278 suites / 3,156 passed, one skipped; Rust and all builds pass. Exact body-to-product mapping and the bob/medium geometry-edit history remain incomplete; candidate sources and attribution limits are disclosed. Owner authorized GitHub/npm publication; release v0.4.111 in progress (2026-10-27), awaiting cross-platform CI and registry verification. |
| R-INSTALL-TRUST | Reliable installation, Desktop startup recovery and trusted macOS artifacts | Implemented locally v0.4.110; notarized DMG blocked; free preview available v0.4.111 (Codex orchestration, 2026-10-27) | Public npm install, CLI/daemon/Web startup pass on Node 26.12.0/npm 12.2.1 with temporary profile; local npm installs into pnpm links caused the reported resolver crash. Desktop retries after Bridge releases the shared profile, with concurrent/quit safety. Release jobs smoke before upload; notarized releases of both macOS architectures' DMG/ZIP apps require Developer ID, strict signatures, Gatekeeper and stapled tickets. Existing v0.4.109 DMG rejected by the new verifier. Full check: 276 suites / 3,101 passed, one skipped; Rust and all builds pass. Desktop smoke with temporary home passes. Signed replacement still needs Apple Developer credentials. |
| N-RECOVERY-INSPECTION | Native authoritative recovery inspection (gate 3.3A) | Delivered v0.4.109 (Codex orchestration, 2026-10-27) | ADR 0030: canonical snapshots and persisted authority/provenance; terminal restart shadows refresh without replay, while genuine uncertainty stays quarantined. Real daemon/restart/write-failure and UI race tests pass. Full check: 274 suites, 3,064 tests passed, one skipped; Rust and all builds pass. Full gate 3.3 remains incomplete. |
| O-CAMERA-INSPECTION | Preserve manual camera while inspecting characters | Delivered v0.4.108; board shortcut clarified v0.4.109 (Codex orchestration, 2026-10-27) | Direct avatar clicks/details preserve manual pan/zoom; board rows and explicit Find/Follow locate avatars. Browser direct pick and modal retain zoom 70 (pose drift below 1e-12); board focuses at zoom 36. F1–F3/All floors fitted, Building outward limit follows ground coverage. Shared v0.4.109 full check passes. |
| O-VEHICLE-NIGHT | Parked/moving vehicle lamps and parking illumination | Delivered v0.4.108 (Codex orchestration, 2026-10-27) | Parked emissive masks stay zero; four pooled moving-car headlights reach 9 m without shadows. Six instanced parking poles use cached pools. Daylight Off preserves sun/sky/fill, with night-only dimming. Shared full check and browser day/night inspection pass. |
| O-ARCHITECTURE-BLENDER | Blender interior walls, doors and stairs | Delivered v0.4.108 (Codex orchestration, 2026-10-27) | Fourteen Blender modules integrated, full-height transom overlap removed, right jambs mirrored and slide tracks span travel. All 72 tread strips light at night with 216 cached spill samples; night Off extinguishes them. Portal/stair contacts preserved; nested async batches refresh without stale fallback geometry. Shared full check passes; see building integration notes. |
| O-OUTDOOR-CAMPUS | Blender landscape, nearby district, parking, traffic and outdoor visits | Implemented; performance follow-up (Codex orchestration, 2026-10-27) | Blender planting/district/mobility libraries, eight vehicle forms, conventional/EV/bicycle parking, sparse traffic and 30 outdoor visits are integrated; geometry, fallback and route checks pass. v0.4.107: `pnpm check` passes (2,913 tests, one skipped). See `building-blender-integration.md`. Remaining: sustained night overview above 40 FPS; the final 30-second compiled night sample averaged 34.1 FPS under shared machine load. |
| O-WHITE-FLASH | Prevent transient white Office frames | Delivered v0.4.106 (Codex orchestration, 2026-10-27) | Synchronous redraw after R3F buffer resets prevents transparent frames during adaptive DPR and container changes. Seven regressions, 32 live resize events and 44 production-build dimension writes pass; full check: 254 suites / 2,870 passed tests, one skipped, Rust and Web/Desktop/CLI builds. [Evidence](../design/office-development.md#drawing-buffer-continuity). |
| O-DOOR-RESUME | Resume standby travel after closing a door | Delivered v0.4.92 (Codex orchestration, 2026-10-24) | Reconnect actual feet to the remaining route after close/handoff, retain destination and transition contacts, and wait for verified clearance. Full check: 241 suites, 2,675 passed tests (one skipped); 496 browser journeys across F1–F3. See [door movement review](door-movement-review.md). |
| O-DOOR-PACE | Door interaction follows dynamic character pace | Delivered (0.4.91, Codex orchestration, 2026-10-24) | Actual walking speed drives approach, grip, turn, swing and release; measured foot travel preserves gait through stops and short paths. Mixed-speed queues and mid-act changes pass; 12 source-avatar maneuvers retain 0.42 m clearance. Full check: 240 suites / 2,655 passed, one skipped; Rust and Web/Desktop builds pass. [Review](door-movement-review.md#dynamic-interaction-pace). |
| O-STATIC-SEATING | Natural static-seat entry and occupied sofa access | Delivered (0.4.90, Codex orchestration, 2026-10-24) | Front lanes, turn/lower and forward rise avoid fixed furniture and seated neighbors; blocked access retries and recalls safely. All 22 rendered routes and 28 occupied-neighbor cycles pass, plus live source-avatar review. Full check: 238 suites / 2,595 passed, one skipped; Rust and Web/Desktop builds pass. [Review](static-seating-review.md). |
| O-PORTRAIT-IDENTITY | Shared 3D character identity and animated portraits | Delivered (0.4.87, Codex orchestration, 2026-10-24) | Shared body/face/hair/wardrobe and activity-linked expressions across Office and portraits. Live appearance parity, source/procedural fallback, responsive dialogs and renderer lifecycle verified. Full check: 234 suites / 2,560 passed, one skipped; Rust and Web/Desktop builds pass. [Review](avatar-portrait-review.md). |
| O-FOLLOW-FLOORS | Follow characters across floors, stairs and elevators | Delivered (0.4.86, Codex orchestration, 2026-10-23) | Live floor switching preserves camera framing/zoom through stairs and express elevators; intermediate cabins/riders remain visible. Four actual scene trips and manual view/drag takeover pass. Full check: 229 suites / 2,414 passed, one skipped; Rust and Web/Desktop builds pass. [Review](character-follow-review.md). |
| O-NIGHT-COVERAGE | Night spotlight coverage across F1–F3 | Delivered (0.4.85, Codex orchestration, 2026-10-23) | Physical east-apron, stair-underside and terrace path fixtures close dark gaps. Actual night views, zero-live-beam coverage and day/night/manual controls verified. Full check: 228 suites / 2,410 passed, one skipped; Rust and Web/Desktop builds pass. [Review](night-lighting-review.md). |
| O-WALK-PACE | Continuous curve speed and distinct personal walking paces | Delivered (0.4.84, 2026-10-23) | Preserved speed/time across samples; distinct personal/trip/mood paces. 30/60/120 FPS regressions, nine actual scene pace cases, mixed/equal-fast six-walker groups and fourteen fast seated approaches pass. [Review](natural-walking-review.md#pace-correction-in-0484). |
| O-FLOOR-CONTACT | Finished-floor, furniture and sole alignment on F1–F3 | Delivered (0.4.84, 2026-10-23) | Grounded finishes, rugs, inlays and racks; Blender panel with tested fallback; slab undersides, rounded edges and stair openings preserved. Ground character rings removed. Full check: 227 suites / 2,405 passed, one skipped; Rust and Web/Desktop builds pass. [Review](floor-contact-review.md). |
| O-NATURAL-WALK | Varied smooth walking and shared-space passing | Delivered (0.4.83, 2026-10-23) | Per-trip clearance-checked curves, open-space shortcuts, adaptive passing and measured gait; exact door/chair/stair/lift contacts preserved. Browser: ten representative trips, fourteen seated destinations and six opposed walkers completed; full check: 225 suites, 2,393 passed, one skipped. See [review](natural-walking-review.md). |
| O-INTERIOR-BLENDER | Blender furniture, hospitality and interactive recreation refresh | Delivered (v0.4.82, Codex orchestration, 2026-10-23) | 46-part Blender library integrated across storage/print/decor, pantry/stools, server room, entertainment and fitness. Stool-aligned food/drink service, synchronized swivels, local two-character console play, and physically occupied fitness with shared contact phases. Imported geometry, failed-load restoration, live Office mounting and day/night/manual lighting verified. Full check: 223 suites / 2,371 tests passed, one skipped; Rust and Web/Desktop builds passed. [Integration](interior-blender-integration.md). |
| O-CHAIR-STEPS | Visible steps while pulling and pushing work chairs | Delivered (v0.4.80, Codex + Luna audit + Sol review, 2026-10-23) | Competing gait ramps fixed; short backward/forward steps follow root distance through chair slide/swivel. 55 focused tests and four male/female mirrored source-avatar cycles pass, seated scoot/rise preserved. Full check passes on combined v0.4.81: 218 suites / 2,344 tests, one skipped; Rust gate and Web/Desktop builds. [Review](chair-movement-review.md). |
| O-DOOR-ENTRY-CLOSE | Close inward room entry beside the opening | Delivered (v0.4.79, Codex + Luna audit + Sol review, 2026-10-23) | Accessible-face tug and moving-tip entry arc; free-walker closing duties included, working exit and queue handoff retained. 185 focused tests and six source-avatar browser maneuvers pass. Full check: 215 suites / 2,291 tests passed, one skipped; Rust gate and Web/Desktop builds passed. [Review](door-movement-review.md). |
| O-SINGLE-BLENDER | Blender ordinary desks, decor and panoramic monitor banks | Delivered (v0.4.77, Codex + Sol review, 2026-10-23) | 22-part Blender library integrated with ordinary/touchdown desks and shared hardware/decor. Equal-size dual/triple monitor banks have aligned heights/angles and 8 mm seams; mixed laptop setups preserved. Browser input contacts, imported geometry, failed-load restoration and day/night/manual lamp response verified. Full check: 214 suites / 2,280 tests passed, one skipped; Rust checks and Web/Desktop builds passed. [Integration](workstation-blender-integration.md). |
| O-POD-BLENDER | Concave seating bays and redesigned four-person desks | Delivered (v0.4.76, Codex + Luna audit, 2026-10-23) | Blender 85 cm bays, slim legs/frame, low rounded glass with eight clamps, inward device placement and coordinated seat/input inset; original aisle waiting points retained. Four actual office pods load and restore their models; failed-load procedural structures verified. 173 focused tests; full check 212 suites / 2,274 passed, one skipped; Rust and Web/Desktop builds. [Integration](team-pod-blender-integration.md). |
| O-CHAIR-BLENDER | Blender-authored ergonomic work chairs | Delivered (v0.4.75, Codex + Luna audit, 2026-10-23) | Local editable task/executive models; 51 moving and 25 static chairs replaced across three floors, retained seat/contact anchors and instanced motion. Both entry sides and executive seating reviewed; failed-load backup and restored-load checks passed. Full check: 211 suites / 2,270 passed, one skipped; Rust and Web/Desktop builds. [Integration](chair-blender-integration.md). |
| O-DOOR-LATERAL | Sidestep opposite the hinge when pulling a door open | Delivered (v0.4.74, Codex + Luna, 2026-10-23) | Initial tug and latch-side sidestep, solo partial opening, real handle regrip while exiting; full openings for initial queues and fixed intent for late arrivals. 181 focused tests, mirrored solid/glass source-avatar browser review, full check passed (210 suites / 2,267 passed, one skipped; Rust gate and builds). [Review](door-movement-review.md). |
| O-DOOR-NEAR-CLOSE | Close nearby and recover stuck threshold traffic | Delivered (v0.4.73, Codex + Sol + Luna, 2026-10-23) | Shorter handle-side closing, tolerant threshold detection and physical retreat for stranded actors. Reproduced 94 stalled leisure routes using 28 rendered portals; 109 liveness cases and 219 focused tests pass. Mirrored source-avatar and recovery browser review; full check passed (210 suites / 2,265 passed, one skipped, Rust gate and builds). [Review](door-movement-review.md). |
| O-DESK-HANDEDNESS | Correct sitter-relative right mouse, independent pad variation and inset keyboards | Delivered (v0.4.73, Codex + Luna, 2026-10-23) | Anatomical right derived from facing vector, matching negative-X hand goals, number-pad side and opposite cup. Independent mouse/pad variation and supported palm space; 62 focused tests, ten browser configurations and full check passed. [Review](workstation-device-review.md). |
| O-DESK-REACH | Workstation screen distance and right-hand input placement | Delivered (v0.4.68, Codex + Sol + Luna, 2026-10-22) | Extended keyboard reach, right-hand mice with stable variation, PC/laptop/pod/executive screen spacing, supported executive and reception inputs. Nine browser configurations plus female executive review; 46 focused tests and full check passed (194 suites / 1,923 tests, Rust gate, builds). [Review and scope](workstation-device-review.md). |
| O-CHAIR-PASSAGE | Match chair swivel, hand contacts and sit/stand path | Delivered (v0.4.67, Codex + Sol + Luna, 2026-10-22) | Per-maneuver side variation, canonical pivot/slide/swivel and front entry/exit around the chosen side. Contact release, executive anchors, frame ordering and scripted renderer motion synchronized. Male left/right and female source-body browser review; 96 focused tests and full check passed (193 suites / 1,918 tests, Rust gate, builds). [Review and scope](chair-movement-review.md). |
| O-DOOR-SWING | Hinged door handedness and collision-aware passage | Delivered (v0.4.66, Codex + Sol + Luna, 2026-10-22) | Uniform inward quarter-turn room entries, mirrored hinges, handle-led push/pull footsteps and free-tip detours. Reservations, open-door route handoff and director cleanup retain clearance. Four actual-avatar browser cases; 25 hinged and three sliding mounted portals reviewed. 67 focused tests and full check passed (191 suites / 1,906 tests, Rust gate, builds). [Review and scope](door-movement-review.md). |
| O-SHIRT-SKIN | Seated shirt sleeve and torso continuity | Delivered (v0.4.65, Codex; Astra diagnosis, 2026-10-22) | Topology-scoped sleeve binding removes misplaced hip/spine influence and wrong elbow paint; sleeveless torso panels shed arm leakage. Both formal variants reviewed across seven activity samples and both sides; joined female garment skipped as intended. 25 focused tests and full check passed (190 suites / 1,890 tests, Rust gate, builds). [Review and scope](avatar-shirt-review.md). |
| O-FOOT-SEAM | Source ankle, trouser cuff and shoe continuity | Delivered (v0.4.61, Codex + Sol + Astra, 2026-10-21) | Cached formal instep/cuff fitting preserves shoes and other wardrobe geometry. Active sole clearance, authored standing hip and transition floor constraints. Female/male side/front and sit/stand/walk samples reviewed; 16 focused tests and full check passed (189 suites / 1,881 tests, Rust gate, builds). Xcode tools selected explicitly for validation; Desktop startup smoke not run because its current auto-connect path reaches the real Hermes profile. [Review](avatar-foot-review.md). |
| V1-S0/S1 | Native orchestration baseline and contracts | Gate passed (Codex, 2026-10-17) | Resumed `pnpm check` exit 0: 111 files / 1,109 tests at v0.0.39 before additional regression assertions. Previous observer failures were already repaired in the shared checkout; [continuation ledger](native-orchestration-v1-handoff.md). |
| V1-S2 | Native mission supervisor | Kernel delivered; full Stage 2 incomplete (Codex, 2026-10-17) | v0.0.40: final `pnpm check` exit 0, 112 files / 1,125 tests. Read-only DAG kernel with bounded concurrency, dependency data and unknown-execution handling; host/UI/persistence/live-provider acceptance remains incomplete. See [handoff](native-orchestration-v1-handoff.md). |
| V1-S2H | Native mission host integration | Delivered; full Stage 2 incomplete (Codex, 2026-10-17) | v0.0.41: `pnpm check` exit 0, 116 files / 1,144 tests. Authenticated host API, workspace provider opt-in, read-only tools, canonical v0 events, retained results and recovery quarantine; launch/review UI and live-provider acceptance remain incomplete. See [API guide](../architecture/native-missions.md). |
| V1-S2P/UI | Lead planning and Missions UI | Delivered (v0.0.43); acceptance incomplete | Editable lead proposal, validated DAG launch, task-state monitoring, cancellation and unverified answers. Local scripted-provider and mock UI proof; live-provider/artifact evidence still required. See [handoff](native-orchestration-v1-handoff.md). |
| V1-S2R | Planner admission and retained dependency graph | Delivered (Codex Sol + Luna, 2026-10-18); durability incomplete | v0.0.45: `pnpm check` exit 0, 123 files / 1,241 tests. Planner session/lead admission covers catalog/inference; cancel/deadline retains capacity until actual settlement. Validated retained DAG, legacy unknown graph and desktop-to-phone SVG resize fix verified. Volatile reservations/catalog cancellation limits and Stage 3 work in [handoff](native-orchestration-v1-handoff.md). |
| V1-S3C | Transactional mission checkpoints | Foundation delivered (Codex Sol + Luna, 2026-10-18); full Stage 3 incomplete | v0.0.46: `pnpm check` exit 0, 125 files / 1,261 tests; Desktop smoke, Node 22.13 checkpoint probe and post-commit SIGKILL recovery passed. SQLite WAL checkpoint/change transactions, one-time legacy import, tombstones, orphan quarantine and RAM-only transient results. Canonical task/tool transactions, leases, reconciliation and budgets remain pending; [handoff](native-orchestration-v1-handoff.md), ADR 0013. |
| V1-S3J | Atomic native mission events and execution gate | Delivered; full Stage 3 incomplete (Codex Sol + Luna, 2026-10-18) | Schema-2 event/checkpoint transactions and synchronous acknowledgements before read-only provider/tool effects; failed commits stop admission and abort siblings. Migration, rollback, transient isolation and host-level fault tests passed; ADR 0014 and the handoff record contain evidence. Leases/reconciliation and scoped approvals remain pending. |
| O-ID | Observe hook/transcript character continuity | Delivered (v0.0.49, Codex, 2026-10-18) | Manual transcript selection now matches app source + native session ID, attaching hook-only records rather than creating a second avatar. Restart/end/resume identity regression added; continued Claude conversation handling retained. LRU retirement identity restoration remains a separate gap. |
| O-FACADE | Reference-led building skin | Delivered (Codex + GPT-6.1 Sol + GPT-6 Luna, 2026-10-19, v0.0.57) | Perforated silver diagonal frames, long window slots, broad glazed corner, aligned entrance and solar accent edges. Three real levels and campus-only visibility retained; 81 portal clearance rays plus four controls pass. Full check: 166 suites / 1,578 tests; Desktop smoke passes all three floors. Preview transition warning is recorded in the handoff. |
| O-BLENDER14 | Latest reviewed building and runtime details | Delivered (Codex + Sol + Luna, 2026-10-20, v0.0.67) | Five local Blender parts refreshed: continuous west ribbons, side portal, open corner, logo mounts and neutral role-specific glass. Runtime cabs/doors/fans/neon retained; maintenance gates and fixtures survive model loading. Actual imported mesh access/sweep checks, day/night browser review, full check171 suites/1,599 tests and Desktop smoke passed. [Integration evidence](building-blender-integration.md). |
| O-TERRACE-GUARD | Remove stale procedural terrace glass | Fixed (Codex, 2026-10-20, v0.0.68) | Isolated fallback guard batch unmounts with its glass, rails and accent strips; floor-wide geometry retains no stale copy. Controlled cold-load browser raycasts switch from procedural alpha0.23 to Blender alpha0.18 at four terrace positions. Full check:172 suites/1,600 tests. |
| O-ROOM-ENVELOPE | Hide room surfaces overlapping the campus skin | Delivered (Codex + Sol + Luna, 2026-10-20, v0.0.69) | 29 perimeter wall/window/trim groups hide in Building, including the F3 setback; interior partitions and runtime doors remain. F1/F2/F3 restore10/10/9 groups, All floors restores29; return to Building hides29 without stale batches. Browser geometry probes, full check174 suites/1,609 tests and Desktop smoke passed. [Integration evidence](building-blender-integration.md). |
| O-FLOOR-FOOTPRINT | Fit floor slabs and finishes behind rounded facade | Delivered (Codex + Sol, Luna audit, 2026-10-20, v0.0.70) | Campus slabs, finishes, borders and ceilings follow conservative rounded glazing profiles; F3 setback and full terrace deck remain distinct. Browser checks: 254 patches / 8,196 vertices contained, all view transitions restore geometry, stair voids stay clear. Full check176 suites/1,620 tests and Desktop smoke passed. [Integration evidence](building-blender-integration.md). |
| O-DESK-RIG | Natural seated arm and hand contacts | Delivered (v0.0.75, Codex + Sol + Astra, 2026-10-21) | Wider typing contacts, lowered mouse elbow plane, actual-parent palm orientation and bounded forearm roll. Corrected source body proportions and lower-limb cloth weights; relaxed source hand morphs. Detailed female/male activity transitions and procedural typing/mouse reviewed; focused 9 suites / 61 tests, full check 184 / 1,666 and Desktop smoke passed. Source fingers remain terminal; [review and limits](desk-rigging-review.md). |
| O-ELBOW | Relaxed desk-work elbow posture | Integrated; reviewed on v0.0.56 (Codex + earlier Luna work, 2026-10-19) | Executive chair/root follows the shared closer seat anchor; single/pod keyboard anchors and per-seat desk layouts also drive actual hand targets. General IK and movement reaches retained. Current focused 4 suites / 28 tests, full check (164 / 1,571) and Desktop smoke passed; current source/procedural renders reviewed. See integration handoff. |
| O-PROP | Procedural fallback proportions | Delivered in shared v0.0.53; reviewed on v0.0.56 (2026-10-19) | Smaller head, shorter neck and revised body/limb proportions approach the detailed model. Current source and procedural desk renders reviewed; no claim of an identical mesh or matching source-model LOD. |
| O-DESK | Input-device scale and desktop furnishings | Delivered in shared v0.0.54; reviewed on v0.0.56 (2026-10-19) | 31/44 cm keyboards, 6.4 × 11.6 cm mouse, smaller pad and stable per-seat arrangements. Document drawers, trays, file holders, books and other accessories; props and hand goals share deskLayout. Current tests and renders reviewed. |
| O-SPAWN | Stable avatar appearance during source loading | Delivered (v0.0.52, Codex + Luna, 2026-10-18) | Selected-source bodies wait for both assets instead of flashing the procedural style; body/hair preload together using per-URL caches. Cold/delayed, warm-cache, failed-load and missing-source paths verified. `pnpm check` passed (160 files / 1,551 tests); Desktop smoke passed. No matching lightweight LOD added; decision/evidence in handoff. |
| O-DEVICE | Monitor/laptop proportions and tabletop contact | Delivered (v0.0.51, Codex + Luna, 2026-10-18) | 50–58 cm 16:9 panels, shorter stands, 36 × 25 cm laptops and surface-based device origins across all five caller families. Reception shelf clears the solid counter. Keyboard/mouse targets and screen slots retained. `pnpm check` passed (159 files / 1,550 tests); Desktop smoke passed. Dimensions and continuation evidence in the handoff. |
| O-SEAT | Furniture/body scale and cushion contact | Delivered (v0.0.50, Codex + Luna, 2026-10-18) | Shared 46 cm office/meeting/guest cushions, 43/45 cm sofa/armchair tops, slimmer chairs and 71 cm arm pads. Seat-front metadata reaches both avatar renderers; thigh support and calf floor constraints cover leisure poses. Desk avatar roots/hand targets stay fixed; chair animation contacts follow geometry. `pnpm check` passed (158 files / 1,544 tests); Desktop smoke passed. See handoff for dimensions and limits. |
| O-HAND | Keyboard/mouse hand pose | Delivered (v0.0.49, Codex + Luna, 2026-10-18) | Chair-local seat roots, forward finger direction, source rest-limb calibration, actual chest-pose frame and palm-down wrist pronation. Source male/female, procedural typing, mouse contact and narrow reduced-motion renders checked. Active chair/door reaches retain control; `pnpm check` passed (156 files / 1,533 tests), Desktop smoke passed. |
| V1.1-MAP | Master PRD v1.1 intake and gap map | Planned (Claude Opus, 2026-10-21, v0.4.54) | PRD v1.1 added under `docs/product/master-prd-v1.1/` with private names neutralised; [gap map](prd-v1.1-gap-map.md) rates FR-01–FR-24 against the code and orders waves W0–W8. Noted security gap: user and repository `SKILL.md` files reach the model unscanned (W0). No code changed. |
| V1.1.1-MAP | PRD patch v1.1.1 intake | Planned (Claude Opus, 2026-10-21, v0.4.56) | Technical blueprint and handoff added (translated to English, requirements unchanged); [gap map §5](prd-v1.1-gap-map.md#5-patch-v111-technical-implementation) adapts it to the repository (`@extalia/protocol`, `node:sqlite` host ownership, Bridge transport, existing TS kernel) and maps phases 0–8 onto waves. Next: W0, then the read-only phase 0 audit. No code changed. |
| A1 | Landing page | Revised (Claude Opus, 2026-10-15) | v0.0.20 policy: every launch and the end of setup land in the 3D Office (`resolveLandingPage`; Get started without an agent host). The page is no longer remembered; the legacy `extalia.mode.v1` record is migrated once to `extalia.landing.v2` (workspace only) and only that key is removed. `apps/web/test/appMode.test.ts`. |
| A2 | Virtual Agent / Virtual Office switch | Removed (Claude Opus, 2026-10-15) | `ui/ModeSwitch.tsx` and its CSS deleted; Chat and 3D Office remain sidebar pages. |
| A3 | Always show Native and Hermes in setup | Done (Claude Sonnet, 2026-10-11) | Connection step always shows Extalia Native and Hermes Agent cards; Hermes is disabled with install / `EXTALIA_HERMES_BIN` guidance and a "Check again" button when not detected. `SetupWizard.tsx`, `useRuntimes.ts`. |
| A4 | Final button and wizard copy | Done (Claude Sonnet, 2026-10-11) | Button "Open Virtual Agent" / "Buka Virtual Agent"; step label "Connection" / "Koneksi"; Welcome, workspace and Done copy cover both runtimes (en + id in `i18n.ts`). |
| A5 | Fix bugs 1–5 | Done (Claude Sonnet, 2026-10-11) | Added `brand/hermes-logo-black.svg`; connection test no longer needs a model and shows friendly en/id errors (`connectionErrors.ts`); Hermes workspaces show "Managed by Hermes" with only an explicit allow-everything switch (`permissions.ts`); `setWorkflow` keeps `setupComplete` (host test added). |
| A6 | 9Router key optional | Done (Claude Haiku, 2026-10-11) | 9Router preset `apiKey` is now `optional`; keyless saves succeed and no Authorization header is sent; default URL kept. |
| B1 | Automatic discovery (opt-in) | Done (Claude Opus, 2026-10-11; Gemini, 2026-10-15) | Per-location opt-in `setAutoWatch` (persisted in `state/observer-discovery.json`, shown as `ImportLocation.autoWatch`, toggle on the Observe page), plus automatic activation of the connected app's primary transcript location on `extalia connect <app>` / `applyAgentAppConnect` (`enableAutoWatchForApp`, graceful fallback per G3); LRU of 24 automatic observations, retired ones go to History as linked entries; Extalia-run Hermes sessions skipped. |
| B2 | Structured transcript events | Done (Claude Opus, 2026-10-11; Gemini, 2026-10-15) | Parsers return `steps` (`packages/importers/src/steps.ts`) for Codex, Claude Code, Gemini CLI and Hermes; `packages/host/src/transcriptEvents.ts` maps them to `prompt.submitted`, `agent.state` (thinking/working/idle), `tool.started`/`tool.completed` (classified kind, short target, output ≤ 4000), `model.completed`, `turn.completed` with ids hashed from source position; live polls publish only new events. Codex injected context dropped (bug 7). `classifyTool` maps Web* → web and Task → delegate. Trailing assistant replies without an explicit `final` flag settle after 30 s (`IDLE_REPLY_SETTLE_MS`), and `labelsOnly` omits prompt/reply/output bodies on transcript polling too (`packages/host/test/autoObservation.test.ts`). |
| B3 | Office loads observed events; cwd → workspace | Done (Claude Sonnet, 2026-10-11) | Office loads watched observed sessions (`historyIds.ts`, 24 most recent); `presence.ts` derives observed status from non-import events (live < 2 min, idle after 10 min, event timestamps, read-only); host maps observed sessions to workspaces by project path (`observedWorkspace.ts`); mock `?mock=ready&observed` demo. Verified end to end on v0.0.15: an auto-watched new Codex rollout appeared in the Office as Working with a "Running cat …" toast about 1 s after the tool call was written. |
| C1–C2 | Ingest endpoint and token (Bridge + Desktop) | Done (Gemini, 2026-10-15) | `packages/host/src/hooks/{files,http,ingest}.ts`, Bridge `/api/hooks/<app>` route (`apps/cli/src/bridge/server.ts`, `apps/cli/src/start.ts`), Desktop loopback listener (`apps/desktop/src/agentsIpc.ts`), 0600 ingest token & `endpoint.json`, Origin/Host/size/rate checks, 204 fail-open responses. Verified in `packages/host/test/hooks.test.ts` and `apps/cli/test/connect.test.ts`. |
| C3–C4 | Normalizers, registry, liveness | Done (Gemini, 2026-10-15) | `packages/host/src/hooks/normalize.ts` (Codex, Claude Code, Gemini CLI, Hermes), `Observations.receiveHook` (`packages/host/src/observations.ts`), `NativeImportService.hookReference` transcript linking and hook/transcript deduplication, plus Office hook projection verified in `apps/web/test/officeObservedHistory.test.ts`. |
| C5–C6 | Forwarder, `extalia connect/disconnect/connections` | Done (Gemini, 2026-10-15) | `packages/host/src/connect/{forwarder,endpoint,diff,service,util}.ts` and `apps/cli/src/connect.ts` with `--dry-run`, `--yes`, `--port`, `--rotate`, `--trust`, non-colliding timestamped backups, byte-exact or surgical `disconnect`, `connections` status, and automatic `autoWatch` activation on connect. Verified in `packages/host/test/connect.test.ts` and `apps/cli/test/connect.test.ts`. 2026-10-15 fix: auto-watch written by `extalia connect` is now picked up by a running host (`Observations` re-reads `observer-discovery.json` when its mtime changes, `packages/host/src/observations.ts`); verified E2E with temp homes: hook → SSE ≈ 55–60 ms. |
| C7 | Claude Code hooks | Done (Gemini, 2026-10-15) | `packages/host/src/connect/claude.ts`: HTTP hooks (`timeout: 2`, Bearer token) + `SessionStart` command forwarder in `~/.claude/settings.json`; policy warnings (`disableAllHooks`, `allowManagedHooksOnly`, `allowedHttpHookUrls`). Verified in `packages/host/test/connect.test.ts`. |
| C8 | Codex hooks and trust | Done (Gemini, 2026-10-15) | `packages/host/src/connect/{codex,codexAppServer}.ts`: comment-preserving TOML block in `$CODEX_HOME/config.toml` and optional `--trust` approval via Codex app-server RPC (`hooks/list`, `config/batchWrite`). Verified in `packages/host/test/connect.test.ts`. |
| C9 | Connect agent apps UI | Done (Gemini, 2026-10-15) | `apps/web/src/pages/ConnectAgentAppsCard.tsx` in Settings, Observe and Office drawer (EN/ID copy in `i18n.ts`), with Copy command, Copy prompt, preview diff, Test, Disconnect, "Labels only" privacy toggle and optional Hermes dashboard URL input (`setHookPrivacy`); `mockHost.ts` supports all 4 apps (`codex`, `claude`, `gemini`, `hermes`) and `apps/web/test/connectAgentApps.test.ts`. |
| D1 | Hermes outbound webhooks | Done (Gemini, 2026-10-15) | `packages/host/src/connect/hermes.ts`: comment-preserving YAML `hooks.outbound` entry across default and named profile `config.yaml` files (`/api/hooks/hermes`, HMAC secret, `timeout: 2`), `X-Hermes-Signature-256` verification in `hooks/http.ts`, and skipping Extalia-managed Hermes sessions in `service.ts`. Verified in `packages/host/test/{connect,hooks}.test.ts`. |
| D2 | Gemini CLI hooks | Done (Gemini, 2026-10-15) | `packages/host/src/connect/gemini.ts`: command forwarder hooks (`timeout: 2000` ms) in `~/.gemini/settings.json` for `SessionStart/End`, `BeforeAgent/AfterAgent`, `BeforeTool/AfterTool`, `Notification`. Verified in `packages/host/test/connect.test.ts` and `apps/cli/test/connect.test.ts`. |
| D3 | Hermes dashboard read source | Done (Gemini, 2026-10-15) | `packages/host/src/hermesDashboard.ts` wired into `Observations.discover` and `Observations.refresh` (`packages/host/src/observations.ts`) and configurable via `host.setHookPrivacy({ hermesDashboardUrl })`: loopback-only HTTP reader for `/api/sessions` and `/api/sessions/{id}/timeline` with incremental `after_row_id` cursor caching and `parseHermes` conversion. Verified end-to-end in `packages/host/test/hermesDashboard.test.ts`. |
| E | MCP reporting | Done (Gemini, 2026-10-15) | `packages/host/src/hooks/mcp.ts` (`EXTALIA_MCP_TOOLS`, `EXTALIA_MCP_INSTRUCTION`, `normalizeMcpReport`, `handleMcpJsonRpc`, `runMcpStdioServer`) and `extalia mcp [--app <app>] [--session <id>] [--port <number>]` CLI server (`apps/cli/src/connect.ts`) + persisted `labelsOnly` prompt/output redaction mode across both hook ingest and transcript polling (`setHookPrivacy`). Verified end-to-end in `apps/cli/test/connect.test.ts` and `packages/host/test/{hermesDashboard,autoObservation}.test.ts`. |
| U1 | Shell geometry / viewport-fit Office | Done (Claude Opus, 2026-10-15) | Tokens `--shell-inset`, `--shell-gap`, `--rail-width`, `--header-height`, `--glass-radius` (`styles.css`, "v0.0.20 shell" block). Liquid Glass rail and top bar float with a gutter on all sides (the rail column includes its inset). Office height comes from a flex/grid chain (shell 100dvh → banner → top bar → content → page → stage), not `100dvh - 146px`. Measured headless (Chromium, mock host): no document scroll at 1280×720, 1440×900, 1920×1080 with and without the update banner; ≤ 700 px wide or < 540 px tall keeps the scrolling fallback. |
| U2 | Top-bar Office controls | Done (Claude Opus, 2026-10-15) | Floor tabs (Campus/F1/F2/F3/All floors) and lights (Auto/On/Off) moved from `OfficePage` to `office/OfficeTopbarControls.tsx`, shown only on the 3D Office (`showsOfficeControls`). One zustand store (`office/officeControls.ts`) holds `view` and `lightOverride` (still persisted via `saveLightOverride`); `aria-pressed`, arrow/Home/End focus, one row at every width. `apps/web/test/officeControls.test.ts`. |
| U6 | Splash and boot coordinator | Done (Claude Opus, 2026-10-15) | `boot/bootState.ts` (`loading`/`setup-required`/`ready`/`recoverable-error`; 700 ms minimum only for fast boots; 15 s timeout → Retry + copyable diagnostics), `boot/useBoot.ts`, pre-rendered `boot/Splash.tsx` (no WebGL; reduced motion/transparency). First run mounts only the SetupWizard. Theme, material and font apply before first paint (`public/boot-appearance.js`, `boot/appearance.ts`). `apps/web/test/bootState.test.ts`. The recovery panel is covered by unit tests only (no headless host-failure run). Background: pre-rendered loop of the real office (`apps/web/public/splash/office-loop{,-day}.{webm,mp4}` + posters, `tooling/capture-splash.mjs`, `docs/design/splash.md`); poster only for reduced motion / Save-Data; no R3F canvas. |
| U3 | Avatar popover and session dialog | Done (Claude, 2026-10-15) | Picking a character opens a small card (`overlay/CharacterPopover.tsx`) anchored to the figure by `scene/PopoverAnchor.tsx`, which keeps the card element out of React state so it follows a walking character without re-rendering. Its four states come from `overlay/popoverModel.ts`; scene selection and popover focus are in `overlay/officeSelection.ts`. The full session opens in `office/AgentSessionDialog.tsx`, which makes the rest of the page inert while open. Facility characters get no session actions. |
| U4 | Semantic bubbles | Done (Claude, 2026-10-15) | `office/semanticBubble.ts` maps an activity to one of a fixed set of catalog phrases (`officeUx.semantic`). Bubbles, name tags, toasts and in-world screens (`office/scene/interior/screenData.ts`) show only those phrases, never a command, path, query, token or reply text. `apps/web/test/semanticBubble.test.ts`. |
| U5 | Facility staff | Done (Claude, 2026-10-15) | The receptionist and bartender are walked by `scene/movement/facilityDirector.ts` over the agents' walking graph, defined in `facilityNpcs.ts`. `FacilityStaff.tsx` mounts one director per Office; `facilityStatus.ts` lets the Office page read only role and duty state. Their stations are reserved in `office/scene/interior/seating.ts`, so agents are never offered those seats. `apps/web/test/facilityNpcs.test.ts`. |
| U7 | Restart capability | Done (Claude, 2026-10-15) | Desktop relaunch on the user's request: `apps/desktop/src/restart.ts` (validation and policy) and `restartIpc.ts` (the reply is sent first, then the app quits). `apps/web/src/ui/RestartPrompt.tsx` serves Desktop (restart) and Web (reload). `apps/web/src/restart/restartPlan.ts` holds a restart while Extalia-run agent work or an approval is pending; `unsavedDrafts.ts` collects drafts from their owners. `apps/web/test/restartPrompt.test.ts`. |
| U8 | Liquid Glass Pro | Done (Claude Opus, 2026-10-15; v2) | v2 in the `v0.0.21 theme: Liquid Glass Pro v2` block of `apps/web/src/styles.css`: Plasma-UI-like glass slabs with iridescent rims, bevels and nested frosted panels over a slow plasma backdrop (transform-only, paused on the Office page and when hidden; `ui/documentVisibility.ts`). CSS only: `@cruxgarden/plasma-ui` was measured and not added (−6% FPS with vsync, −22% uncapped on the Office), see `docs/design/themes.md`. |
| U9 | Welcome setup | Done (Claude Opus, 2026-10-15) | `apps/web/src/setup/{SetupWizard.tsx,steps.ts}`: Welcome (language) → Profile & appearance (name, theme, surface style, font; saved with `saveProfile`, shows the data folder) → Connection → Workspace → Connect agent apps (info) → Done → 3D Office. Older configs (`setupVersion` < 2, incl. migrated ones) re-run it once with the existing connection and workspace preselected; completion only through `completeSetup` after a valid connection and workspace, or observe mode. |
| U10 | Profile in `~/.extalia-vo` | Done (Claude Opus, 2026-10-15) | `resolveDataDirectory` defaults to `~/.extalia-vo` (Windows `%USERPROFILE%\.extalia-vo`) for Bridge and Desktop; `EXTALIA_HOME` still overrides. `packages/host/src/migration.ts` copies the legacy folder once (lock-protected, modes kept, `cache/` skipped, legacy `hooks/forward.mjs` becomes a shim, stale hooks flagged for `extalia connect`). `packages/host/src/profile.ts` + `getProfile`/`saveProfile` store UI preferences in `config/profile.json`; `apps/web/src/profileSync.ts` syncs them. Verified on a copy of real legacy data in a temp home. |
| T1 | Workspace default team and every-turn orchestration | Done (Claude Haiku, 2026-10-18) | v0.0.47: the host persists a workspace default team (`saveWorkspaceTeam`, `workspace.team`); every new managed session copies it host-side (an explicit team wins, `team: null` starts without one; later edits never change existing copies). The team dialog saves the default at once (dock team chip, Settings → Workspaces) or edits the targeted session with "Save as workspace default". Every turn carries an enabled team (Native lead prompt, Hermes `<extalia-team>` brief on each `hermes chat`); disabled teams are never applied. Tests: `packages/host/test/teams.test.ts`, `packages/host/test/hermes.test.ts`, `apps/web/test/workspaceTeam.test.ts`; headless `?mock=ready` and `?mock=ready&hermes` flows: save, reload, chip, send, new session copy. |

### Phase 0 discrepancy ledger

Differences found between the Phase 0 spec, the screenshots and the source. Each is a deliberate record, not a bug to fix.

- Version: a screenshot reported Desktop v0.0.18 while the source was v0.0.19. No installed Desktop app was found in `/Applications` to verify against, so only dev builds were checked.
- Landing: the PRD's "last mode" landing policy changed to "always 3D Office" (see A1).
- Layout: the spec's `.office-stage calc(100dvh - 146px)` is confirmed in source and was replaced by a flex chain (see U1).
- Known gap: the Campus view shows an empty ground band at the bottom of taller stages. This is camera framing, not layout.

## 12. Open questions

1. Should Extalia ever write Codex hook trust itself (with consent), or always
   leave approval to Codex `/hooks`?
2. Default for "Watch new sessions automatically": on after connecting an
   app, or always opt-in?
3. Keep prompt text from outside apps by default, or labels only?
4. Which app versions to certify first (Codex Desktop build, Gemini CLI
   version, Hermes version)?
