# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/):

- **Major (1.0.0)**: Production General Availability (Milestone: `v1.0.0-ga: Extension SDK & Production Release`) with stable public API contracts and extension SDK.
- **Minor (0.X.0)**: Milestone releases representing significant architectural stages:
  - `0.1.0`: Milestone 1 — Public Foundation & Vertical Slice
  - `0.2.0`: Milestone 2 — Workspaces & Session Hub
  - `0.3.0`: Milestone 3 — Import Center & Agent Console
  - `0.4.0`: Milestone 4 — Subagents & Project Orchestration (Current Active Milestone)
  - `0.5.0`: Milestone 5 — Durable Control & Knowledge Vault (Upcoming)
  - `0.6.0`: Milestone 6 — Evolve & Autonomous Learning (Upcoming)
- **Patch (0.X.Y)**: Incremental iterations, bug fixes, visual improvements, and subsystem refinements within the active milestone.

## [Unreleased]

## [0.4.323] - 2026-11-14

- Hydrate truncated Antigravity `USER_INPUT` and `PLANNER_RESPONSE` transcript bodies from the sibling `transcript_full.jsonl` when `transcript.jsonl` records `truncated_fields` or `<truncated N bytes>` markers, raise `STEP_TEXT_LIMIT` to `50,000` characters to match `MESSAGE_LIMIT`, and close unclosed Markdown code fences before compact-log truncation markers when `transcript_full.jsonl` is unavailable so long multi-section responses render in full across Observe, Chat and History (`C13`).

## [0.4.322] - 2026-11-14

- Enhance automatic/self-learning development for Knowledge/Obsidian vaults and Skills (`N-AUTOMATIC-LEARNING`, `N-KNOWLEDGE-VAULT`, `N-SKILL-LEARNING`): wire verified read-only skill catalog tools (`skill_read`, `skill_list`, `skill_search`) into post-task and observed curators when skill learning is enabled so curators can avoid duplicates and align with existing skills; enrich the Rust curator prompt and `skill_propose` schema with class-level skill authoring standards (`When to Use`, `Procedure`, `Pitfalls`, `Verification`, trigger-first descriptions, and anti-incident-log rules) and Obsidian `[[wikilinks]]` cross-referencing; emit Knowledge-indexed `kind` and `tags` frontmatter in generated learning (`kind: learning`, `tags: [learning, automatic-learning, ...]`) and team meeting (`kind: meeting`, `tags: [meeting, team-knowledge]`) notes; add the built-in `knowledge-vault` skill and category keywords; and support `/learn` shorthand and broader English/Indonesian skill-extraction requests (`jadikan/simpan ... sebagai skill`, `turn/convert/extract ... into a skill`).

## [0.4.321] - 2026-11-14

- Complement the 60 FPS Office renderer pipeline (`O-RENDER-60FPS`) with hardware-filtered PCF shadows (`shadows`), distance and per-desk frustum culling for small desk props (`DeskAccessorySet`, `DeskOrganizerSet`, `CoffeeCup`, `MouseProp`) and secondary monitors (`slot > 1`) below close-up zoom (`< 28 px/m`), Stack-view sub-pixel detail and interior-furniture shadow culling, hidden/idle `useFrame` skips across campus skyline, grass, roof fans, server racks, gym mechanisms and distant avatar faces, and `detectInitialRenderBudgetLevel` GPU tier classification.
- Added General Schedules (`Jadwal` / `Schedules`) across `@extalia/platform`, `@extalia/host`, and the web/desktop workspace UI (`N-GENERAL-SCHEDULES`): supports one-off, interval, and 5-field cron recurring prompts, session target modes (`create-and-reuse`, `existing`, `derive-from-session`, and `new-each-run`), lead/worker/subagent assignment (`workspace`, `solo`, or `custom`), missed-run policies (`skip` or `run-once`), live cron next-run preview, and pause/resume/run-now/edit/delete controls.

## [0.4.320] - 2026-11-14

- Target 60 FPS in the shared Office renderer without limiting the frame loop.
  Keep lower resolutions only when measured frame time improves, and remove the
  480-pixel fallback.
- Reduce repeated transform work for fixed furnishings and hidden floors. Share
  compatible avatar skeletons, batch matching fitted-outfit surfaces, and cull
  surrounding buildings individually without reducing their mesh detail.
- Skip inactive light pools and add reproducible day, night, crowd and resolution
  benchmarks for the Office.

## [0.4.319] - 2026-11-14

- Integrate the latest Native, workspace, Knowledge, Skills, Observe and Chat updates with optimized Office geometry and instance submissions. Preserve profile-scoped storage, reviewed workspace changes and existing Desktop folder dialogs across the combined code paths.
- Use the supplied home directory for handover/CLI discovery, retain GUI executable fallbacks, and isolate discovery fixtures from tools installed on the test machine.

## [0.4.318] - 2026-11-13

- Keep the Office character board compact by showing active, ready and on-shift
  standby members first. Offline and off-shift members remain inspectable in a
  collapsed bottom group with localized show/hide controls and team grouping.

## [0.4.317] - 2026-11-13

- Make Native delegation cards in Chat expandable into read-only live worker
  previews, including recorded model responses, tool/command output and errors.
  Keep previews separate per task and preserve expansion during live updates
  and model fallback, with compact layouts in English and Indonesian.

## [0.4.316] - 2026-11-13

- Render image thumbnails and strip leading `[Attached file: ...]` tags on
  observed prompt bubbles by retaining SHA-256 previews across queued
  observation dispatch, hooks and session-staged transcript materialization.

## [0.4.315] - 2026-11-13

- Hold observed Antigravity queued prompts as editable pending items in Extalia
  while `GetCascadeTrajectory` reports an active cascade run, so edit, reorder,
  delete, pause/resume and steer stay usable until the cascade returns idle.
- Default running and finished multi-tool transcript groups and tool command
  rows to collapsed unless previewed, and preserve each group's, tool row's and
  queue drawer's expanded or collapsed state across live transcript and polling
  updates.

## [0.4.314] - 2026-11-13

- Let Office render quality recover gradually above 30 FPS, including stable
  31–39 FPS displays. Lower one level after three sustained sub-30 windows,
  hold exactly 30 FPS and retain bounded retry of sharper levels.
- Count recurring raw-frame stalls when choosing quality, so filtered FPS cannot
  conceal sustained slow rendering. Reset measurement streaks after visibility
  or WebGL-context changes, retaining the selected resolution and retry budget.

## [0.4.313] - 2026-11-13

- Scope isolated Native learning and Knowledge meetings to conflicting workspace
  and vault activity, including Observe queues and observed-memory work. Preserve
  shared/default vault, unknown ownership, privacy and actual-settlement guards.
- Show the selected quiet interval while learning is waiting, including ten-minute
  snoozes, and the live remaining countdown once armed. Describe resource conflicts
  without requiring the entire Office to be idle.

- Remove the Native prompt's Learn as skill checkbox. Existing profile-owned
  automatic learning continues, while direct English/Indonesian learning requests
  can save generated user skill candidates without a special command. Built-in
  skills, write approvals, inspection and activation boundaries remain separate.
- Read user-supplied learning links through a bounded, supervised Rust process:
  public-address and pinned-DNS admission, validated redirects, text/body limits,
  cancellation settlement and at most two source children per host. Linked
  proposals require successful attributed reads; failures cannot produce a
  candidate supposedly learned from unseen source content.

## [0.4.312] - 2026-11-13

- Show a small automatic-camera warning beside the Office FPS counter during
  the final ten seconds before a working target, or five seconds before an idle
  target. Use the director's actual movement/meeting/newcomer deadlines, and hide
  on switches, manual activity, suspension and input attention.

## [0.4.311] - 2026-11-13

- Confirm session, imported-history and workspace deletion in a focused modal
  showing the exact item and its impact. Cancel receives initial focus; pending
  removal locks duplicate submissions and shows progress with retryable errors.
  Removing an additional project folder also requires confirmation before its
  workspace draft changes, while original project and source-app files are kept.

## [0.4.310] - 2026-11-13

- Group Native Chat sessions by workspace and registered project folder, with
  stable tree expansion, activity indicators and within-workspace drag-and-drop.
  Session settings offer the same folder choice for keyboard/touch users;
  cross-workspace transfers require a destination review and explicit confirmation.
- Persist a saved Native session's selected working root for tools, instructions,
  delegation and missions while retaining its identity and conversation. Preserve
  historical file-root references and previews, enforce current registered grants,
  and reject active, uncertain or stale moves. Workspace memory/vault ownership
  stays unchanged by a folder selection.

## [0.4.309] - 2026-11-13

- Split observed Antigravity models into base models with per-model effort
  selectors in the Extalia composer (`updateObservedAntigravitySettings`) and
  pass the resolved native `planModel` on `SendUserCascadeMessage`.
- Expose Antigravity native cascade and cooperative inbox queues through
  `observedNativeQueueStatus`, render `ObservedCodexNativeQueue` for
  Antigravity sessions, and stabilize cooperative prompt queue identities
  across asynchronous `projectPath` updates so editing the queue does not raise
  stale target mismatch errors.
- Allow bidirectional handover between Codex and Antigravity observed sessions
  anytime—even across unregistered projects or while active—while preserving
  isolated workspace boundaries and deduplicating handover loading/error alerts.

## [0.4.308] - 2026-11-13

- Show immediate, sticky sending feedback for Codex answers, including a spinner
  and indeterminate progress bar. Lock inputs while delivery is pending, keep the
  indicator if polling retires the question first, and replace it with the actual
  receipt or uncertain outcome. Respect reduced motion without claiming reading
  or inventing a completion percentage.

## [0.4.307] - 2026-11-12

- Keep live session trees from blinking open and closed when input markers or
  recent activity change. Preserve per-source folder choices through refresh,
  filtering and parent collapse; apply initial expansion defaults only once.
  Refresh already-loaded pages atomically, retaining rows on failed or obsolete
  reads, and keep known-empty sections hidden while refreshing. Folder and
  session overtaking animations remain enabled.

## [0.4.306] - 2026-11-12

- Animate recent-activity reordering in Observe, History and Import trees:
  whole project folders glide past sibling folders, while sessions pass only
  their siblings inside the same folder. Keep selection, keyboard focus and
  expansion state; smoothly retarget rapid updates and respect reduced motion.

## [0.4.305] - 2026-11-12

- In the foreground 3D Office, frame the character requesting supported input
  before opening its question or confirmation. Wait for camera completion,
  preserve existing dialogs, and deduplicate exact requests across polls and
  navigation. Background pages retain their notification flow; answers and
  permission decisions always require the user.
- Keep explicit character focus from being canceled by delayed automatic-camera
  cleanup. Retain usable confirmation controls when Office history or graphics
  cannot identify or frame the character.

## [0.4.304] - 2026-11-12

- Prefer verified direct native answers or original-turn steering for Codex
  feedback before ordinary queue delivery. Expose the selected route and distinguish
  submitted/queued receipts from confirmed reading; uncertain delivery never
  silently falls back or resends. Retain typed drafts across safe route changes.
- Render feedback as clean question–answer pairs, with expandable question text
  and metadata-free copying in both live and imported conversations.

## [0.4.303] - 2026-11-12

- Keep model and option menus anchored to their input in the main prompt,
  Setup and Settings. Menu entrance effects no longer override or animate the
  positioning transform, including when scrolling or opening near screen edges.

## [0.4.302] - 2026-11-12

- End session-tree connector lines at the final visible sibling, including
  single-child groups and expanded parents, across Observe, History and Import.
  Keep ancestor spines only where another sibling follows.

## [0.4.301] - 2026-11-12

- Simplify Observe session trees with a spinner for each working session and a
  dot for new unread assistant output. Keep selection neutral and parent nodes
  free of active-link highlights; retain keyboard-accessible hover/focus actions.
- Persist exact-revision output read markers. Opening old history, status updates
  and tools do not create unread output; background or older-scroll views do not
  acknowledge output that has not reached the visible conversation.
- Group a repository's main checkout, linked worktrees and subfolders into one
  project while preserving each session's actual working path. Without Git, use
  registered workspace roots, then the original folder path. Apply verified
  grouping metadata to Observe, History and import discovery/preview.

## [0.4.300] - 2026-11-12

- Audit inputs across all seven Settings tabs and nested editors. Reuse shared
  library selectors and host-backed folder pickers for project and ignored
  folders, with copyable locations and unchanged workspace validation.
- Lock pending settings edits, prevent duplicate submissions and discard stale
  replies after changing host or profile. Serialize notification permission
  requests and keep failed saves recoverable.
- Improve field labels, linked validation messages, credential input behavior
  and English/Indonesian preference descriptions. Validate optional dashboard
  URLs before submission and offer retries when vault settings cannot load.
- Keep Storage settings within narrow screens, including long data and vault
  paths, while retaining copy actions.

## [0.4.299] - 2026-11-12

- Retain expandable agent-app groups above project/worktree folders in Observe,
  History and Import. Add connected tree branches, bounded harness pages and
  separate groups for sessions without a project inside each app.
- Mark the currently viewed session/project separately from recently reported
  Observe work, including aggregate activity on collapsed parent nodes.
- Compact the Observe toolbar and session header, prevent control/title overlap,
  and reclaim vertical space for the transcript on laptop screens.

## [0.4.298] - 2026-11-12

- Use the shared Radix workspace selector in Knowledge vault connections.
  Choose vault folders through the native Desktop picker or the host-backed Web
  folder browser, with no manual path entry. Show confirmed locations with copy
  actions; shared vault profile choices remain drafts until explicitly saved.
- Preserve vault locations when folder selection is cancelled, reject stale
  picker results and retain existing host validation and workspace boundaries.

## [0.4.297] - 2026-11-12

- Group Observe and imported History sessions by their original project folder
  by default, retaining session titles and separating sessions without a project.
  Add compact expand/collapse controls, newest-first ordering and explicit
  twelve-row pages for more projects and older sessions.
- Keep normal UI state polling free of the full imported-library list. Fetch
  browser metadata through bounded, profile/query-bound cursor pages; preserve
  selected conversation content and explicit import preview/commit. Source
  folders remain metadata, without new workspace or filesystem access grants.

## [0.4.296] - 2026-11-12

- Add reusable Native agent profiles with shared purpose/personality, lead
  connection/model preferences and individually configured subagents. Select a
  team profile per project, keep explicit overrides and reset to its defaults.
- Snapshot profile settings for each new session so later preset edits leave
  existing agents unchanged. Edit an idle lead's personality or individual
  team members from the Chat/Office team settings, with per-worker skill
  relevance and project Knowledge, memory and file boundaries retained.
- Preserve reviewed handover routing and active Native admission while changing
  future defaults. Use revision-aware saves and stable creation request IDs to
  avoid duplicate profiles after a lost response; refresh catalogs explicitly
  across retained Settings tabs without replacing project drafts.
- Add English/Indonesian profile controls and bounded local persistence, with
  clear Native-only runtime support and a read-only refresh recovery action.
- Keep learning status in bounded normal-flow panels in Chat and Settings so
  background updates do not cover the composer or profile fields. Apply the
  existing light/dark input styles consistently to the new profile editors.

### Additional merged changes

- Further reduce seven garments, three static libraries and selected avatar accessories while retaining rig metadata, reviewed fixture detail and bounded texture-coordinate precision. Synthetic pose and loader checks are recorded; native full-body fit and FPS remain unverified.

## [0.4.295] - 2026-11-12

- Store the default shared skill library directly in `~/.extalia-vo/skills`
  on macOS/Linux. Verify and copy legacy immutable objects without changing
  revision, scanner, review or activation authority; retain recovery copies and
  unrelated legacy skill folders, and resume safely after interrupted publication.
- Keep manual imports, generated candidates and marketplace staging on the same
  layout, initialized only by the core store owner. Preserve nondefault CLI
  namespaces and Windows legacy paths until native migration is supported.
- Document operating profiles as a separate proposed preset for purpose,
  personality, lead models and agent teams. Shared procedures keep per-worker
  relevance checks; Knowledge, memory and project access retain their boundaries.

### Additional merged changes

- Reduce geometry in four public garments with deterministic, skinning-aware simplification while retaining textures and documenting pose comparisons.
- Compact visible model instances and maintain culling bounds; expose actual graphics-backend details in Office benchmark reports.

- Restore the README's centered Extalia logo, badges, title and introduction
  before the campus preview. Add a smooth front-right → front-left → front-right
  camera tour, keeping downloads below the building and feature previews separate.
  Show the npm installation script before Desktop installers, with visible macOS
  quarantine-removal and launch commands beside the downloads.
- Put macOS, Windows and Linux downloads directly below the animated campus in
  the README, followed by the separate animated feature previews. Keep npm as a
  compact installation option and move detailed setup below the feature tour.
- Lead the README with animated campus traffic and the existing team-delegation
  WebP. Give Observe, the Skills Grimoire and a 1,600-note Knowledge graph their
  own animated previews, captured from real views with isolated demonstration
  data, including book browsing and node-detail interactions.
- Rebuild the README around npm installation, Desktop downloads and clear Native,
  Hermes and Observe capabilities. Remove Web/CLI archive links and place macOS
  unidentified-developer opening instructions beside the Mac downloads.
- Reconcile module/PRD navigation and GitHub milestone/issue checkpoints while
  preserving unfinished acceptance gates and distinguishing source from releases.

## [0.4.294] - 2026-11-12

- Support Observe-only setup and workspace folders without a model connection.
  Capture and recall remain local with profile consent; background curation uses
  an optional explicit connection. Upgrade the same workspace to full Extalia
  while retaining observed sessions, history and stored episodes.
- Keep Observe navigation and Office controls focused on outside-agent activity.
  Hide managed Chat, missions, Knowledge, Grimoire and Native composer shortcuts;
  keep managed characters/dialogs out of the Observe Office while preserving their
  history. Retain relevant profile/connection settings and an explicit full-setup path.

### Additional merged changes

- Offer folder-access review after Native sends are rejected while Chat or the
  character dialog still has an older session summary. Refresh status without
  retrying the message, preserve drafts and ignore responses from an old session.
- Add the same explicit recovery to the Office prompt dock, including compact
  mode. Hold Send/Enter and delivery preparation until review is accepted; retain
  draft text and uploaded attachment references without automatic replay.

## [0.4.293] - 2026-11-12

- Add opt-in profile learning from observed sessions with Rust-owned attributed
  episode capture, local search, revision-aware reads and restart-safe deduplication.
  Keep default-off startup free of background inference and historical backfill.
- Offer progressive observed-work recall to Native agents and explicit search/read
  in Observe tools. Preserve workspace/profile boundaries and partial coverage.
- Curate observed work into scoped Knowledge notes and inactive skill candidates
  through the existing Rust learning owner, with configured-model consent,
  source attribution and cancellation/drain when foreground work resumes.
- Include bounded memory, Knowledge, approved-skill and observed references in
  reviewed handover archives. Reserve references in long histories and recheck
  contributor authority without broadening existing external archive grants.

### Additional merged changes

- Align Connect, observed history and managed Hermes with its official Windows
  installation folder, explicit homes and named profiles. Keep installations
  separate, reject invalid roots and preserve undo when the selected folder changes.
- Discover agent CLIs and standalone Node in common GUI package-manager locations
  across operating systems. Launch supported Windows npm commands through Node
  without a shell; report unsupported wrappers instead of silently failing.
- Use the same custom configuration roots for all agent integrations, including
  Gemini's base-home override, and honor the host's supplied home consistently.

## [0.4.292] - 2026-11-12

- Share globally approved active skill revisions with ordinary and isolated
  workspaces. Bind applicability to the actual activation approval, retaining
  explicit workspace scopes, scanner checks and revocation behavior.
- Load optional skill procedures for each worker's current task and gate manual
  skill-body reads by that invocation. Reject weak topic/category matches,
  irrelevant quoted references and competing ambiguous procedures; keep basic
  memory/team policy guidance separate from optional skill selection.
- Keep Knowledge, memory recall and project files isolated while skill additions
  and updates append to the shared library. Generated skill guidance generalizes
  private project details into reusable procedures and retains mandatory review.

- Distinguish Extalia built-in, marketplace, custom, project and generic imported
  skills with readable source badges and origin filters in Grimoire. Preserve
  exact revision identity and show review/activation state separately.
- Derive marketplace source markers from valid recorded provenance for the exact
  profile and revision. Older hosts keep generic imported labels; no storage
  migration, per-book inspection requests or scanner/activation changes.

### Additional merged changes

- Use validated, parented OS-native Desktop folder dialogs with localized titles
  and current-folder hints across projects, Knowledge vaults and skill imports.
  Add folder selection to per-profile vault settings and Bridge vault/skill
  imports; avoid a redundant browser picker whose handle cannot reveal a host path.
- Use native Zenity/KDialog destination choosers in Linux setup, allow terminal
  destination changes and safely restore an adopted empty folder after failure.
  Correct the Mac installer profile/project explanation and refresh its artwork.

## [0.4.291] - 2026-11-12

- Simplify handover into detected harness cards and conversation choices, with
  technical setup in Advanced. Add workspace-attested Antigravity destination
  creation and native delivery, original-operation recovery and explicit
  inspection without replaying uncertain prompts.
- Rebuild Observe around harness/project groups, search and status filters,
  fixed conversation headers and tabs, independent transcript scrolling and a
  bottom composer. Keep tools separate and preserve drafts across live updates.
- Use native Antigravity workspace/model evidence and the latest visible dated
  Codex working-folder metadata. Reject stale or ambiguous continuation scopes
  and remove duplicate queue-error text without discarding drafts.
- Verify a real UI Codex-to-Antigravity-and-back workflow with retained decisions,
  unchanged implementation, fourteen tests and host-restart continuity; record
  adapter and compaction limits separately from transport admission.
- Allow more time for the asynchronous Linux installer fixture under the full
  test suite while retaining its consent and verified-content assertions. Keep
  symlink fixture assertions platform-specific without skipping bounded native
  configuration validation on Windows.

### Additional merged changes

- Let automatic Knowledge curation and team reviews for unique non-default
  isolated vault profiles run alongside known Native workers, planning, memory
  and queued work in other profiles. Preserve same-profile preemption and physical
  drain, default/shared idle rules, unknown-ownership guards and scanner-gated
  inactive skill proposals in the shared user library.

## [0.4.290] - 2026-11-12

- Consolidate Knowledge/Obsidian setup into one workspace-to-vault connection
  card with the actual folder, shared-workspace impact and progressive folder
  controls. Keep global profile management in Settings and preserve responsive
  English/Indonesian graph, search and note workflows.
- Give Native leads, delegated readers and saved-team meetings bounded,
  workspace-bound Knowledge search/read tools. Read only indexed visible notes,
  retain source labels and reject changed or unavailable bindings. Managed
  learning/minutes writers keep their existing consent and provenance checks.
- Bind scoped Knowledge requests to their expected profile and folder so a stale
  editor cannot write another vault with the same path and hash. Retain copyable
  drafts across external changes, freeze pending saves and restrict legacy-memory
  imports and previews to workspaces assigned to the destination profile.
- Recognize a configured semantic default-profile alias without moving vaults
  or rewriting notes. Trusted daemon startup supplies the one allowed alias;
  derived index schema 2 rebuilds cached visibility on alias introduction, change
  or removal while preserving other profiles' isolation.
- Keep development vault data separate by profile/folder and extend the native
  Desktop smoke test through actual Knowledge IPC reads and stale-binding refusal.

### Additional merged changes

- Show a direct folder-access review beside Native Chat and Office messages
  after project folders are replaced, added or removed. Keep drafts, attachments
  and conversation history while holding sends and queued dispatch until review.
- Reject stale review confirmations and late UI responses; retain Native sessions
  when their workspace default changes runtime. Nested review dialogs preserve
  the Office conversation when closed with Escape.

## [0.4.289] - 2026-11-12

- Add reviewed, direct UI handover into existing Codex, Gemini CLI and Claude Code conversations through installed CLI connections, with scoped archive readers, same-session checks, durable uncertainty and retained process ownership.
- Document the remaining Claude-Mem-inspired memory requirements separately from implemented continuity and Knowledge features.

### Additional merged changes

- Treat a removed profile as a fresh installation instead of restoring retired
  data or stale browser preferences. Keep setup, workspace registrations, chat
  and observation/import records under the active Extalia root while project
  files remain in user-selected folders.
- Store Desktop browser data, logs, crash dumps and update staging under that
  same root. Save last-workspace, Office lights, notification and panel choices
  in the host profile; rehydrate them when a Web client reconnects to a new host.

- Organize guides, architecture, design, release notes and PRD evidence through six
  module hubs. Reconcile v0.4.288 implemented, partial and outstanding requirements;
  preserve historical test scope and keep v0.5 acceptance separate from publication.
- Correct stale folder-setup, observed-control, scanner/Python, public-asset and
  Office navigation guidance without changing runtime behavior or package versions.

## [0.4.288] - 2026-11-12

### Fixed

- Verify Native session destination folders structurally across Windows and Unix path encodings. Synchronize cooperative inbox revocation tests with actual request admission so delayed connections cannot invalidate the intended stale-pairing checks. Keep marketplace file validation compatible with strict Windows Clippy checks while preserving linked-file rejection.

### Additional merged changes

- Refresh Desktop/Web/npm release guidance, exact download names, scanner platform limits and the verified 133-model asset footprint. Keep v0.5 acceptance and real-provider certification separate from source integration and packaging checks.

## [0.4.287] - 2026-11-12

- Show package version, risk, requested permissions and runtime declarations in
  Grimoire previews. Resolve metadata from the pinned bytes in Rust and reject
  invalid manifests before preparing an import.

## [0.4.286] - 2026-11-12

- Associate observed conversations with an existing workspace from Chat or
  the lead character. Keep equal-depth matches unresolved until selected,
  recheck physical folder identity, and preserve the scope of existing handovers.

## [0.4.285] - 2026-11-11

- Check complete furnished walking routes and choose bounded authored alternatives
  before entering a blocked later aisle. Correct the Entertainment seating aisle,
  preserve exact destinations and retain normal door, chair and lift ownership.
- Reserve door-leaf and operator maneuvers when finding waiting places, allow
  checked outward recovery from a crowded apron and extend distant queues only
  through nearby aligned tickets. Refresh genuine travel direction during yields
  without discarding the original passing responsibility.
- Let newly admitted idle colleagues receive automatic camera attention, keep
  passive hover from cancelling the tour and show an explicit manual Following
  control with a Stop action. Preserve the slower contextual focus intervals.
- Skip invisible character pose work and recursive model raycasts while keeping
  movement simulation active. Reveal the current pose immediately and preserve
  visible picking order. Release cloned skeleton textures and private final
  wardrobe geometry without disposing shared model assets.
- Recover interrupted Office graphics and failed engine downloads through fresh
  attempts. Preserve prompt drafts and attachment chips across explicit scene
  restarts, wait for healthy restored frames and reset interrupted FPS samples.
- Keep the existing front paving, entrance route, lamps and benches visible in
  the F1 cutaway so arriving colleagues have outdoor context. Share one mounted
  front area with Building view while keeping it hidden on F2 and F3.

## [0.4.284] - 2026-11-11

- Load eleven secondary pages on demand while keeping Office, Chat, navigation,
  approvals and observed-input alerts available. Add localized page loading and
  explicit recovery after a failed download. The same-feature production build
  reduces the initial static JavaScript gzip transfer by 11.35%; device memory
  and FPS remain separate measurements.
- Keep long tool commands and output within narrow Chat layouts, including the
  hidden sender label, without clipping content or masking page overflow.
- Extend controlled handover acceptance through repeated observed/Native hops,
  original archive paging, destination-bound grants and Native endpoint reuse.

## [0.4.283] - 2026-11-11

- Add a live Grimoire marketplace that refreshes independently of application
  releases: explicit public search, cached/offline results, immutable GitHub
  previews and exact-package imports through the existing security review flow.
  Rust owns HTTP, bounded file downloads, hashes and staging; no upstream
  installer runs and imports never approve or activate a skill.
- Preserve reviewed package pins across host admission and immutable registry
  staging, serialize marketplace operations and retain uncertain receipts without
  automatic retries. Add responsive English/Indonesian review controls and pinned
  source links.
- Record append-only import sources for each exact skill revision, including
  unchanged bytes seen at later commits. Reject cross-source package-name
  collisions and disclose legacy unknowns and omitted retained records. CoreStore
  schema 14 uses the existing automatic pre-migration backup; older binaries
  refuse the upgraded store.

## [0.4.282] - 2026-11-11

- Add reviewed cross-agent work handover with one canonical continuity record,
  attributed source/model/context coverage, editable working notes, immutable
  evidence pages and a persistent transfer trail. Native connection changes keep
  their session/history; returning from Observe reuses the prepared Native
  endpoint. Existing external conversations use verified control routes or an
  explicit manual packet, with honest queued/submitted/unknown receipts.
- Let a reviewed external destination page pinned original archives through the
  Extalia MCP server, using expiring destination-bound grants stored as hashes.
  Preserve labels-only/workspace/history-off privacy, revoke grants on pause or
  removal, and require deliberate inspection after uncertain delivery without
  resending or clearing worker ownership. Bound repeated context by replacing
  prior host-generated capsules and filtering exact delivered packet echoes.
- Associate observed projects with every selected workspace folder, including
  secondary roots, and document the remaining PRD work and handover limits.

## [0.4.281] - 2026-11-11

### Fixed

- Detect repeated encounters between Office characters even when both keep moving back and forth. Keep a consistent passing turn until the other character has cleared the aisle, and find a checked multi-turn bypass around desks and shelves while preserving the original destination and door, chair and lift ownership.
- Register persistent equipment contact anchors for the cable-row and weight-bench seats so their users can finish the controlled dismount and clear the incoming character's path.
- Route fitness traffic around the cable tower and approach treadmill decks from the rear. Keep treadmill rails and consoles solid without treating the usable deck as a filled collision box.

## [0.4.280] - 2026-11-11

### Added

- Add a fullscreen control to the Web toolbar and open ordinary Desktop windows in native fullscreen from launch.

### Fixed

- Show a persistent connection-lost dialog when the foreground Web service stops. Automatically reconnect after a manual service restart, refresh rotated Bridge credentials without reloading the page, and dismiss the dialog only after a fresh host snapshot succeeds. Preserve the current view and drafts without replaying user actions.
- Coalesce repeated CLI stop signals, close hosts that finish starting during shutdown, and cancel update relaunch when Ctrl+C requests a stop.

## [0.4.279] - 2026-11-11

### Improved

- Bring both idle colleagues toward a shared conversation place chosen from their actual routes. Prefer nearby sofa seating, animate seated talk/listen gestures, and stop delayed gatherings or blocked optional sit approaches instead of leaving a character waiting indefinitely. Real work still takes priority.

### Fixed

- Keep fitness-seat contact ownership when replacement models load, finish the full checked dismount before ordinary walking, and move the Library lamp away from the door operator's sweep.
- Let lift waiters step aside for the passenger with the boarding or exit turn without changing reservations. Prevent neighboring door queues from yielding to each other indefinitely while preserving each queue's FIFO order.

## [0.4.278] - 2026-11-11

### Added

- Integrate deferred Native knowledge meetings with the saved team, per-member skill context and acknowledged Obsidian minutes. Surface meeting countdowns and durable skill-candidate receipts above the Office prompt through one shared notification controller.

### Fixed

- Restart the full chosen learning delay after foreground work, including quick human memory operations, and drain active maintenance before user work proceeds. Retain acknowledged partial results without replaying uncertain jobs.
- Bound and redact meeting source context from only the completed task before queueing and provider requests.
- Select a character's source session/workspace while keeping the Office board global and automatic camera attention visual. Restore the default prompt workspace when its toolbar choice is cleared.

## [0.4.277] - 2026-11-11

### Improved

- Start the shared Web/Desktop Office near 1080p and recover toward sharper native-display tiers when frame throughput permits. Retry previously slow tiers with bounded cooldowns instead of permanently locking quality after two failures; retain prompt slowdown protection and the native-DPR/4K pixel limits.
- Show a small, passive live FPS readout at the Office's top-left. Measure real foreground throughput including hitches, clear stale values on visibility changes, and update the badge independently of scene rendering.

## [0.4.276] - 2026-11-11

### Fixed

- Complete physical door cleanup through changing/cancelled queues without reordering crossing tickets. Retain closure responsibility, allow a checked closing service turn, transfer to a real nearby operator, and resume the exact original seat/exit/transit position after closing. Retained closers use authored room aisles around furniture and a rejoin checked with the leaf fully closed.
- Recover blocked pending Office destinations through checked local bends and authored aisle joins. Periodic retries preserve the pending goal and recovery budget while bodies, furniture or door portals block an escape.

## [0.4.275] - 2026-11-11

### Improved

- Keep the Chat title and Messages/Files tabs visible while scrolling long conversations. Use a responsive right sidebar on laptop and desktop for session status, model/effort, working folder, recent file changes, memory/context and team controls; keep one mounted set of controls inline on narrow screens.

### Fixed

- Keep every visible Office body in collision and door-swing checks, including targetless door work, lift waits and departure fades. Guard chair/door root motion against current bodies before advancing poses, and separate lift queues from passenger exit lanes.
- Detect stationary crowds of two or more and let one safe, fairly selected character give way while retaining its destination and FIFO ticket. Clear blocked doorway heads through checked same-face retreat bays, preserve partial-retreat rejoins, and cancel obsolete retreats when goals change.
- Retain physical seat ownership through in-flight chair interactions. Validate complete chair maneuvers, select a clear side, keep controlled contact with each workstation's own tabletop/input surfaces, and clear foreign-table/wall conflicts through synchronized desk rows, approaches and library decoration placement.

## [0.4.274] - 2026-11-11

### Fixed

- Keep Chat and Observe Messages/Files tabs at their compact content height instead of letting them expand vertically into empty space. Center conversation panels in the same reading column as the composer, retain mounted messages/drafts across tab switches, and keep phone layouts within the viewport. Update the dialog hook harness for observed input context and lazy cooperative tools.

## [0.4.273] - 2026-11-11

### Fixed

- Keep macOS DMG background, volume-icon and layout support icons outside the installer artwork in Finder's initial icon view, including when hidden files are shown. Preserve the required assets, the three installation items and all Finder preferences.

## [0.4.272] - 2026-11-11

### Changed

- Desktop checks for releases shortly after launch and shows an English/Indonesian version confirmation dialog before downloading. Approval binds the offered release; Later/Escape keeps the current app, and normal quit never silently installs an update. Approved downloads retain safe agent-idle restarts, postponement, progress and retry controls.

## [0.4.271] - 2026-11-11

### Fixed

- Keep Native conversations usable after team, member, model, personality and goal changes. Scope history access fingerprints to effective workspace grants, preserve real folder-change guards, and safely upgrade compatible saved prompt queues.
- Preserve historical file roots when a conversation moves, so old relative references cannot silently open same-named destination files.

### Added

- Move an existing Native session into another workspace using an expiring, settings-bound access review. Retain its ID, history, team, model, identity and history-off policy while future turns use the destination folders, instructions, memory and vault. Support explicit review of the current workspace after grants change; refuse active work and unresolved queued prompts.

## [0.4.270] - 2026-11-11

### Fixed

- Start persistent camera Follow when selecting a character in Agents & sessions. Clear room framing and change to the character's floor without cancelling tracking; earlier or unadmitted entries remain selectable without following an absent avatar.

## [0.4.269] - 2026-11-11

### Fixed

- Drain crowded Office doorways through earlier route-aware admission, safe aisle reconnection and same-ticket side stepping for characters already passing. Preserve in-flight crossings, cancel stale yields to later tickets or finished arrivals, continue into clear turning aisles and retain closing duties for the last actual passer.
- Use the full controlled rear lane when leaving or entering meeting/guest chairs, with own-chair-only clearance and neighbouring-body checks. Protect a recoverable library entry turn around its plant, and walk validated level-floor recovery joins instead of relocating avatars with a fade.
- Retain real batched furniture collisions when scene metadata refreshes, while respecting intended hiding and cleanup. Add 10–20-character crowd, queue-yield, narrow-entry, handoff and seating regressions.

## [0.4.268] - 2026-11-11

### Added

- Show structured Codex async and native questions above the normal input in Chat, Observe and Office, with explicit options/free text, native option descriptions, source-bound answers, and preserved drafts. Async answers enter the original conversation queue; native questions keep their exact callbacks.
- Add a global input alert and source-bound notification targets that open the requesting character's Messages dialog and frame admitted characters. Background Desktop/browser notifications respect the existing preference and permission, omit question/answer text, and suppress startup backlog notifications.

### Fixed

- Keep queued receipts distinct from source consumption, preserve uncertain deliveries across restart, and block stale/source-swapped, private or paused question answers. Bound retained history and preserve native answering when optional async receipt metadata is unavailable.

## [0.4.267] - 2026-11-11

### Fixed

- Show captured Codex tool-result images in Observe and shared Chat/Office transcripts, including media that hydrates an existing hook row. Preserve call/agent matching, labels-only privacy, captured originals when filenames are reused, private per-session copies, bounded storage and deferred-history progress; never turn arbitrary tool text or remote URLs into image reads.
- Display small, lazy image renditions with keyboard-accessible original-size viewing, independent URL leases and visible unavailable fallbacks. Refresh enriched or redacted existing events authoritatively without duplicate tool rows, while retaining manual folding and bounding preview memory.

## [0.4.266] - 2026-11-11

### Changed

- Simplify generic observed messaging to a normal prompt input with an icon send button, Enter/Shift+Enter handling and shared drafts. Move connection, capability and pairing settings into Conversation tools, with separate tabs by tool type and Office tools initially closed for this sender.
- Resolve an unambiguous supported queue/start or paired action only on explicit Send, never automatically steer or retarget a draft after a source identity change. Keep uncertain delivery blocked and preserve pending tool forms across tool tabs.

## [0.4.265] - 2026-11-11

### Fixed

- Prevent hidden-floor avatars and hidden model parts from intercepting Office clicks or hover. Filter pointer intersections by the entire object visibility chain before event dispatch, while retaining visible avatars' transparent pick volumes and normal hit ordering. A visible seated character now opens its own card instead of an off-floor character marked Not in view.

## [0.4.264] - 2026-11-11

### Fixed

- Route characters through another authored door when an entry queue stops progressing and a supported, collision-checked alternative exists. Preserve the latest destination, release only the departing ticket, join the alternate door behind its existing queue, and bound rechecks/detours to avoid oscillation. Healthy moving queues keep their order.
- Add compact lateral waiting pockets when furniture or shallow corridors prevent the normal deep queue positions. Keep waits outside the passage and full future leaf sweep; replan door paths around static obstacles and use a shorter clear handoff exit when the far apron is blocked.

## [0.4.263] - 2026-11-11

### Changed

- Mirror the observed conversation's reported model and reasoning effort in its prompt composer, refresh visible source choices without clearing drafts, and keep unsupported controls read-only.
- Allow model/effort updates only through a positively verified Codex settings API on the original attached server connection, with revision guards and exact readback; preserve uncertain outcomes and never emulate settings with prompt tags.

## [0.4.262] - 2026-11-11

### Added

- Schedule bounded Native post-task learning after a 60-second quiet countdown, with global English/Indonesian Snooze and Run now controls. Foreground prompts finish independently; one background curator retains provider, registry and note ownership through cancellation/shutdown. Managed vault learning defaults on while explicit disabled/custom consent policies remain respected; generated skills still require inspection and user activation.
- Bind isolated workspaces to dedicated stable vault profiles and show each workspace's actual Knowledge index and folder settings. Reuse the Rust daemon's index worker with strict scoped requests, bounded profile caches, shared deadline-aware admission and profile refresh after note publication. Changing folders rebuilds the selected index; pending learning is cancelled rather than redirected, and existing notes/Obsidian settings are preserved.

## [0.4.261] - 2026-11-11

### Fixed

- Queue two-way Office doorway traffic through the entire crossing, park waiting characters outside the passage and leaf swing, release stale tickets, and let the final passer close the door. Preserve onward route markers and safe route reconnection for hinged and sliding doors.
- Measure actual avatar speed and inactive intent for both agent characters and facility staff. Refresh blocked cached fixed-seat approaches after ten simulated seconds and periodically recheck exhausted ordinary walking routes for a supported, collision-checked continuation to the same destination; protect settled work, staff stations, queues and transit. Add on-demand movement diagnostics for development inspection.

## [0.4.260] - 2026-11-11

### Added

- Automatically prepare bounded, relevant skill procedures before Native Chat, delegated worker and team-meeting model requests. Load memory-recall guidance by default and orchestrator for a configured active lead team; retain feature ownership, fresh registry verification, current exclusions and complete-request budgets. Refresh at safe request boundaries after steering, without an extra classifier call or copying bodies into history.
- Show quiet Skill context receipts in the shared Chat/Office conversation: loaded names, reasons, worker ownership, unavailable/budget-skipped entries and omission counts in English/Indonesian. Receipts report prepared instructions, not tool execution, model compliance or canonical mission evidence; mission workers remain a separate integration.

## [0.4.259] - 2026-11-11

### Fixed

- Render queued prompts with visible clickable web links, including URL-shaped Markdown labels; keep attachment names and bounded inline PNG thumbnails passive.
- Hide empty Extalia and persisted Codex queue panels while retaining background updates and unresolved delivery controls.
- Bound nested Markdown rendering so deeply quoted queued prompts remain readable without exhausting the UI stack.

## [0.4.258] - 2026-11-11

### Added

- Bundle fourteen compact Superpowers development workflows and two portable OpenDesign brief/reference procedures in Grimoire and Native discovery. Pin reviewed upstream revisions with MIT/Apache-2.0 notices, complete bounded instruction reads, metadata pagination and task-based permissions. Existing teams, Git actions and skill activation remain authoritative; no upstream plugins, runtimes, services, hooks or template catalogs are installed.

### Fixed

- Give the exhaustive 658-route Office door simulation its own 60-second test budget under parallel suite load; retain every route, join and final-state assertion instead of treating the global 15-second unit-test budget as a behavior failure.

## [0.4.257] - 2026-11-11

### Added

- Bundle six compact anti-slop skill adaptations in Grimoire and Native on-demand discovery: the forty-rule core, UI, copywriting, accessibility, responsive layout and code-comment guidance. Pin upstream 3.2.28 sources with MIT attribution and keep existing user scope, permissions, scanner boundaries and prompt/read limits; no upstream installer, scripts, global mode settings or automatic updates are installed.

## [0.4.256] - 2026-11-11

### Changed

- Refresh the reviewed Dependabot minor/patch dependency group and align checkout v7, setup-node v7, pnpm setup v6, artifact upload v7 and artifact download v8 across all current workflows.

### Fixed

- Limit the POSIX-shell Antigravity CLI fixture to Unix runners, preserving the existing portable inbox and capability coverage in Windows checks.
- Exercise artifact upload/download and tar permission preservation in Linux CI before relying on the updated artifact actions in release packaging.
- Use the supported PCF shadow mode for the Office and skill shelf with the updated Three.js renderer.
- Stage observed session attachments under unique per-attachment directories (`attachments/<sessionId>/files/<attachmentId>/<name>`), resolve pending tags per filename in upload order across cooperative inboxes, Antigravity `agentapi`, reply channels, and Codex queue dispatches without duplicating `[Attached file: ...]` tags or leaking prior files into later prompts, enforce UTF-8/16,000-char bounds (`fitObservedDispatchText`), and clean up staged directories on `removeAttachment` and `deleteSession`.
- Report empty reasoning effort options (`efforts: []`) for watched Antigravity sessions whose model IDs already embed effort tiers, hide the empty effort picker (`composer-effort`) in `<ObservedCodexPromptComposer>`, surface safe attachment upload errors, and replace remaining `'Codex'` fallback wording in `<ObservedCodexPromptContent>` with the actual watched source label.
- Skip POSIX-script `agentapi` fixture execution on Windows (`packages/host/test/observedControlHost.test.ts`) while also probing `agentapi.exe` on `win32`, fixing Windows CI while adding observed attachment lifecycle and transcript-reply fallback regression tests.

## [0.4.255] - 2026-11-11

### Added

- Extend the observed prompt composer (`<ObservedCodexPromptComposer>`), cooperative inbox control, and `host.modelChoices` discovery to watched Claude Code sessions alongside Codex, Hermes, Gemini CLI, and Antigravity.

### Fixed

- Publish `model.completed` replies during live transcript fallback polling even when newer tool hook watermarks exist, and merge late transcript replies into existing timelines in source timestamp order (`mergeEvents`).
- Display the actual observed agent name in `<PromptDeliveryStatus>` instead of hardcoding `Codex`.

## [0.4.254] - 2026-11-10

### Added

- Discover available models for watched Google Antigravity (`GetCascadeModelConfigData` over the local Antigravity daemon, filtering out disabled and exhausted-quota entries) and Gemini CLI (`~/.gemini/settings.json` and active session models) via `host.modelChoices`, and expose a Model selector (`composer-model`) in `<ObservedCodexPromptComposer>` across Chat, Observe and 3D Office character dialogs.

## [0.4.253] - 2026-11-10

### Added

- Add file attachment picker, drag-and-drop and clipboard file paste (`composer-chips`), and an Effort selector (`Default` / `Low` / `Medium` / `High` / `Max`) to the observed prompt composer (`<ObservedCodexPromptComposer>`) across Chat, Observe and 3D Office character dialogs, saving attached files for observed sessions so external agents can inspect them directly.

### Fixed

- Discover active Google Antigravity language-server daemon ports and CSRF tokens from `~/.gemini/antigravity/daemon/*.json` when invoking `agentapi send-message`, so Extalia Desktop and Bridge can deliver prompts directly into running Antigravity sessions without requiring inherited Antigravity shell environment variables.

## [0.4.252] - 2026-11-10

### Fixed

- Render the normal observed prompt composer (`<ObservedCodexPromptComposer>`) directly in 3D Office character dialogs and Observe for watched Codex, Gemini CLI and Google Antigravity sessions even when the host control hub API is active, instead of requiring manual route selection.
- Deliver prompts sent from Extalia to watched Google Antigravity sessions directly via Antigravity's native `agentapi send-message` CLI when installed, recording the submitted prompt immediately in the session transcript without requiring manual pairing.

## [0.4.251] - 2026-11-10

### Added

- Capture changed and created files (`file.written` events) from Google Antigravity (`Path`, `TargetFile` and multi-tool `stepIdx` queues) and Gemini CLI (`BeforeTool`/`AfterTool` input and working directory recall) hooks and transcripts, retaining changed-file evidence across long sessions for the Files tab in Chat, Observe and 3D Office.

## [0.4.250] - 2026-11-10

### Added

- Enable observed prompt queuing and sending for watched Gemini CLI and Google Antigravity sessions across Chat, Observe and 3D Office character dialogs, matching the Codex observed prompt composer and queue controls.
- Automatically prepare session-bound cooperative inboxes for watched Gemini CLI and Antigravity sessions and support hook-authenticated `poll_inbox({ session_id })` in `extalia mcp` so connected sessions can poll and acknowledge queued messages without manual URL/token pairing.

## [0.4.249] - 2026-11-10

### Fixed

- Keep scanner permission checks and private job setup scoped to supported Unix targets so strict Windows Clippy builds pass while unsupported Windows scanner execution remains unavailable.
- Validate pinned scanner artifacts portably on Windows without treating its file modes as POSIX execute bits; preserve exact manifests, inventories, content hashes and executable metadata checks.
- Declare real-daemon prerequisites for host integration tests and require the built daemon in Rust CI, preserving dependency-free test coverage in ordinary Check jobs and real backend coverage in the Rust matrix.
- Exercise model-discovery transport failures through a local malformed HTTP response, preserving strict sanitization and deadlines without depending on platform-specific closed-port refusal timing.
- Keep Windows skill tests aligned with unavailable artifact staging while still checking failed tool receipts, no persistence, prompt privacy, read-only routing and per-turn learning authority.

## [0.4.248] - 2026-11-10

### Added

- Keep a rotating standby crew from the current configured Extalia Native team: three members for a team of ten, four for twenty and five for thirty-two, plus the existing lead. Cap synthetic standby attendance at five across visible workspaces, count real attendance first and rotate eligible identities after their existing idle linger duration using spaced entrance admissions.
- Label standby and off-shift availability in English and Indonesian without starting inference, creating sessions or fabricating work events. Preserve real work, errors, approvals and missions; wait for current host/profile roster revisions and session history before projecting attendance, and retain in-memory rotation fairness across navigation.

## [0.4.247] - 2026-11-10

### Added

- Unify observed conversation messaging in Observe and Office character dialogs with explicit transport capabilities, source-bound actions and correlated delivery receipts. Preserve the existing native Codex, conditional Hermes and waiting-tool routes without inferring control from hooks or transcripts.
- Add bounded, memory-only cooperative inboxes for existing tool-enabled CLI conversations, with CLI/MCP polling, explicit acknowledgement, expiry and revocation. Manual pairing supports separate conversations without inventing native identity or starting external agents; uncertain sends are not automatically retried or rerouted.
- Document the Observe control PRD, architecture decision, setup guide and GitHub delivery backlog, separating the local foundation from live provider certification and future managed CLI transports.

## [0.4.246] - 2026-11-10

### Changed

- Admit Office characters in visual waves of at most two every 1.2 seconds, including initial hydration and reduced motion. Wait for real entrance clearance, skip blocked portals and prevent catch-up bursts after delayed frames; agent execution and team capacity remain independent.
- Keep queued characters' board portraits as lightweight illustrations until their scene body is admitted, and hide speech/callout anchors at empty reserved desks. Preserve complete agent metadata and access to conversations during visual admission.

### Fixed

- Accept a TCP reset as well as EOF in the cancelled-completion transport fixture, while retaining cancellation, worker-join and independent-request assertions.

## [0.4.245] - 2026-11-10

### Changed

- Start the 3D Office with a 480-pixel render budget and recover progressively through 720/1080/1440/2160-pixel ceilings when frame throughput stays smooth. Fit the drawing buffer to the actual Office area, native display density and a 4K pixel cap; preserve sharp DOM controls, resize continuity and existing GLB assets. Keep the demand-rendered vault graph on its own bounded native resolution.
- Add a reproducible CPU-throttled browser comparison driver and a five-file public GLB optimization backlog, separating render-buffer savings from model downloads, decoded resources and whole-application memory.

## [0.4.244] - 2026-11-10

### Added

- Add a development-only standard-library Python completion worker and comparison mode using the same request/result parity fixtures, latency, CPU, cancellation, idle lifecycle and combined Node/worker memory accounting as the TypeScript/Rust benchmark. Record the selected interpreter and implementation limits; production placement remains based on measured benefit.

## [0.4.243] - 2026-11-09

### Changed

- Retain TypeScript as the production completion default after comparing one-shot and shared Rust workers against a frozen baseline. Select backend placement from measured efficiency and output compatibility rather than a mandatory language migration; existing Rust storage/knowledge/learning services and the Python scanner retain their roles.
- Add reproducible completion evidence covering request/result parity, latency, CPU, event-loop delay and concurrent parent/worker memory. Keep the unselected native candidates behind the development-only `provider-experiments` Cargo feature, excluded from ordinary release builds and production host imports.
- Prevent filtered or output-limited OpenAI-compatible responses from executing accumulated tool calls, including valid-looking truncated arguments. Preserve explicit experimental transport isolation without silently replaying an uncertain native operation in JavaScript.

## [0.4.242] - 2026-11-09

### Changed

- Move OpenAI-compatible model catalog HTTP, bounded response parsing and model normalization into an isolated Rust executable mode used by connection tests, selectors and planning. Keep credentials off arguments/environment/logs, refuse redirects and environment proxies, and hold cancellation/shutdown admission until the actual child closes. Preserve inference fallback only for explicit HTTP 404/405/501; completion streaming and Anthropic discovery remain migration work.

## [0.4.241] - 2026-11-09

### Changed

- Set the product language target to UI-only TypeScript/React with Rust or supervised Python backend execution. Add an AST-based source ownership inventory, an explicitly reviewed legacy baseline enforced by lint, and a separate strict check that fails while backend/shared executable debt remains. Include JavaScript variants, embedded worker evidence, runtime imports and privileged application sources; this audit does not claim the existing backend has been migrated or certify generated bundles.

## [0.4.240] - 2026-11-09

### Added

- Inspect imported and explicitly learned skills with pinned NVIDIA SkillSpector 2.13.4 and a bundled, verified Python runtime on macOS 14+ ARM64. Keep incomplete, unavailable and malicious inspections unavailable to agents; require separate digest-bound user approval and activation for eligible instruction-only packages. Preserve genuine evaluation requirements for code and tool packages.
- Show actual scanner identity, coverage, severity and read-only instruction previews in the Grimoire Security Center, with explicit rescanning of quarantined revisions. Keep scanner work outside daemon control dispatch and bundle the matching scanner/daemon pair in supported Desktop and CLI artifacts without requiring user Python or first-use downloads. Windows/Linux scanner execution remains unavailable pending verified isolation.

## [0.4.239] - 2026-11-09

### Changed

- Move automatic-learning jobs, chunked current-task evidence and AI-result validation, durable deduplication, generated/manual skill staging and profile learning/meeting note publication into the existing Rust sidecar. Keep bounded local work off control dispatch, use connection-bound effects and two-phase immutable note exports, preserve legacy admission receipts and mandatory skill inspection, and refuse unavailable backends before model inference. The host retains consent, approved provider HTTP and physical effect draining; ordinary Chat tools remain separate. This new artifact port is Unix-only; Windows reports unavailable until equivalent directory-handle checks are implemented.

## [0.4.238] - 2026-11-09

### Added

- Offer up to three AI-generated next prompts after successful Native Chat work. A visible conversation requests one bounded tools-free completion from the already approved model; completion and queued tasks remain independent, and stale, cancelled or failed predictions are discarded. Suggestions stay in memory, fill only empty drafts after a user click, and never send themselves.
- Show observed harness suggestions through the transient `report_followups` MCP/hook report. Existing attached Codex connections can harvest or request native predictions for their exact verified completed turn. Keep source privacy and lifecycle guards; unsupported harnesses do not receive synthetic follow-up turns. Sources without a normal sender offer explicit Copy buttons.

## [0.4.237] - 2026-11-09

### Added

- Show a separate read-only Codex persisted-queue snapshot in observed Chat, Observe and Office message dialogs. Resolve the original native conversation and profile on the host, read through the public experimental queue API without resuming or starting turns, and share bounded in-memory reads across views. Honor labels-only privacy, source changes and pause/shutdown; distinguish unavailable snapshots from empty queues, and keep source prompts separate from Extalia's editable outbox. Desktop-only prompts not yet persisted by Codex are outside the snapshot.

## [0.4.236] - 2026-11-09

### Fixed

- Retain unsent prompt text per host and conversation while hooks update metadata, message dialogs close, or users switch sessions and Chat/Observe/Office views. Keep drafts in application memory only, protect closed drafts from accidental restart, and clear only the exact unchanged draft after a confirmed submission. Preserve first-message drafts when session creation succeeds but sending fails.
- Show immediate, accessible message-submission feedback and a longer-wait indicator, with visible queue/handoff receipts outside collapsed queue details. Distinguish Extalia acceptance from Codex handoff and uncertain delivery, preserve late receipts after closing a composer, and require explicit inspection before retrying an ambiguous submission.

## [0.4.235] - 2026-11-09

### Added

- Configure automatic post-task learning once per workspace vault profile. Saved Native Chat tasks can run a bounded real curator on their current tool evidence, submit generated candidates for mandatory registry inspection, and save immutable Markdown lessons to the profile vault. Keep candidate activation manual, honor plan/history/team and workspace boundaries, deduplicate uncertain imports, and retain invocation ownership until learning and storage settle.

### Fixed

- Route actual skill/knowledge activity to distinct Skills-room stations, retain learning work there, and let overflow wait at its desk. Ordinary summary mentions no longer send characters to the room.

## [0.4.234] - 2026-11-09

### Fixed

- Keep existing observed agents visible while other sessions load, retain quiet workers' latest activity and terminal evidence through busy sibling event windows, and preserve delivery order for hooks sharing a timestamp. Restore deduplicated transcript catch-up after missed hooks, with matching history reload behavior, explicit stop/end authority and independent concurrent session identities.

## [0.4.233] - 2026-11-09

### Changed

- Give worker message dialogs a compact width and animate Conversation tools opening and closing while preserving their state and keyboard focus. Keep dialogs horizontally centered within the 3D Office, use the full visible screen height, and follow mobile keyboard/viewport changes. Closed tools become inert immediately; reduced motion disables the transitions.

## [0.4.232] - 2026-11-09

### Changed

- Calm automatic Office camera travel with direct same-floor focus and a two-second eased pan; keep overview/zoom transitions for floor changes. Use variable 20–30s idle visits and 30–120s working visits based on main/subagent roles, explicit meetings and live movement. Give journeys bounded arrival grace, preserve input/approval and genuine-spawn priority, and prevent ordinary work restarts from interrupting or repeatedly resetting a shot.

## [0.4.231] - 2026-11-09

### Changed

- Unify Chat, character dialogs and observed Codex around one message input. Messages wait in Extalia's queue while an agent works, with drag-and-drop ordering, accessible move controls and pending-message editing/deletion. Promote a queued text message to a real current-run steer when supported: Native reads it at a safe model boundary, and connected Codex uses its exact active turn. Preserve active approvals, tools and workers during steering, along with uncertain receipts, source/revision checks and text-only queue limits.

## [0.4.230] - 2026-11-09

### Fixed

- Recover completed fixed-seat departures that lost their onward route instead of leaving avatars standing indefinitely. Preserve the newest destination, walk through validated same-floor paths and recheck restored routes at a bounded interval after the local recovery budget is exhausted.
- Retry unreachable NPC break/recreation plans and abandon stationary failed trips after fifteen simulated seconds. Pause leisure travel deadlines during genuine lift, door, seat, service and reciprocal-chat waits, preserving ordinary visit completion and meeting/work behavior.

## [0.4.229] - 2026-11-09

### Changed

- Give Grimoire books a cursor-following title/category preview with opacity fades and keyboard-accessible category labels. Fly books from outside the view into their shelf slots on page entry, filtering and catalog paging, with flowing curved arrivals and magical dust trails. Emit dense, moving category-colored magic smoke while a book is hovered, with faint front-edge wisps and clipping at the book foot and shelf surface. Keep the full three-row rack visible even for empty filters; preserve reading controls, touch behavior and reduced motion, and stop rendering when no active effect remains.

### Fixed

- Keep every parking simulation tick and collision sample covered while collecting first-failure diagnostics outside hot assertion loops. Check MCP tool membership independently of advertisement order.

## [0.4.228] - 2026-11-09

### Added

- Run explicit Native team meetings with two real read-only discussion rounds, approved member models, durable attributed contributions and distinct completed/cancelled/failed outcomes. Drive meeting-room seating, walking, presentation screens and discussion poses from meeting events instead of ordinary desk activity.
- Let cooperative observed agents and authenticated hooks report a bounded meeting lifecycle through `report_meeting`, with source/session membership checks, replay protection and labels-only privacy. Plain text, file writes and routine delegation do not create meetings.
- Group workspaces into named vault profiles with one Obsidian-compatible Markdown destination per profile. Saved Native meetings can export real discussion minutes to their pinned profile vault without granting agent file access or switching the live Knowledge index; explicit destination consent, revision checks and workspace write boundaries remain in force.

## [0.4.227] - 2026-11-08

- Initialize the configured pnpm version before Node setup in checksum and retained-Mac-archive workflows, so package-manager cache detection can run on fresh hosted runners.
- Make the ignored-abort quarantine fixture cancel only after confirmed provider entry, preserving its lifecycle assertions without a 50 ms persistence/startup race on Windows.

## [0.4.226] - 2026-11-08

- Keep release preflight independent of build dependencies by loading Linux installer verification only when Linux artifacts are actually checked.

## [0.4.225] - 2026-11-08

- Compact the observed Codex prompt box in Office, Observe and Chat: remove repeated target and keyboard/delivery hints, place the send icon beside the textarea, and show status text only when needed.
- Display and copy the readable answers from structured user-question replies, including envelopes surrounded by blank lines, while preserving malformed data and literal examples.
- Record owner confirmation of RenderHub Extended Use terms for 18 plant/tree models and eight detailed hairstyles; preserve source archives, historical provenance and geometry/textures, update notices, and retain strict model validation.
- Suppress Linux installer procfs race diagnostics while preserving running-app checks, and make Codex subprocess/path test fixtures portable across supported operating systems with explicit Windows socket-control refusal coverage.

## [0.4.224] - 2026-11-08

- Center the character message dialog within the 3D Office area, excluding the application sidebar and top bar, regardless of board expansion. Use a frosted translucent surface so the Virtual Office remains visible behind it. Preserve the tools sidebar and manual board state; reduced-transparency preferences retain an opaque surface.

## [0.4.223] - 2026-11-08

- Give character message dialogs a wider conversation column and independently scrolling tools sidebar for queues, connection settings and permission controls. Narrow screens use a drawer; closing it preserves drafts and restores focus. The compact footer leaves more room for messages, and opening a dialog no longer collapses the Agents & sessions board.

## [0.4.222] - 2026-11-08

- Add a private, per-session pending prompt queue for managed Native/Hermes sessions and observed Codex. Prepare, edit, reorder, delete, start and pause queued text; dispatch reuses original-session admission. Sending and handed-off items are read-only receipts, unknown outcomes pause without retry, restart stays paused, and history-off queues remain in memory.

- Use an icon-only Send button in the observed Codex prompt box, with localized accessible names, tooltips and a pending spinner.

## [0.4.221] - 2026-11-08

- Show a normal Codex prompt box directly in Observe, the observed Office lead dialog and selected observed Chat. Enter/Send forwards to the original native conversation; the first explicit send saves its message connection. Connection details stay under advanced settings, failed or uncertain sends retain drafts, and no source session or permission grant is created.

## [0.4.220] - 2026-11-08

- Add explicitly reviewed, conversation-scoped Codex permission hooks to Observe and Office. Pending shell decisions return to the original native caller through a separate authenticated broker; complete request previews, expiry, source revocation, backups and revision-bound undo are included. Hook trust, permission modes and real Desktop activation remain user-controlled; other native permission tools may still require Codex.

## [0.4.219] - 2026-11-08

### Changed

- Organize Settings into six responsive sections with lazy loading and retained drafts. Give agent-app connections, automatic observation and ignored folders a single home in Settings; Office and Observe link directly to it.
- Separate Observe's live-session selection and tool pairing from Import's historical preview and commit flow. Require source-read consent, retain native conversation controls, guard duplicate/stale operations and explain Linked imports in English and Indonesian.

## [0.4.218] - 2026-11-08

### Added

- Complete the supported Missions project-review workflow with project selection, explicit blank Native session creation, setup guidance and English/Indonesian steps. Explain read-only scope, Hermes routing, retained results and unavailable older hosts in the Missions guide.
- Add exact mission cancellation across host, Bridge, Desktop and mock transports. A stale mission view cannot stop another mission, planning operation or chat turn in the same session.

### Fixed

- Preserve goal choices and task edits when moving between mission composition and review. Prevent duplicate planning, launch and session-creation requests, and ignore late UI results after changing host, session or project.
- Keep mission history scoped to its project/session, refresh it on session lifecycle events and wait for initial history before choosing the default view. Clarify that write-proposal integration remains blocked when its test gate has not run.

## [0.4.217] - 2026-11-08

### Added

- Enable messages once for an observed Codex conversation and submit future messages through Codex's public native queue, without pasting instructions or starting another agent session. Save exact source/profile binding and receipt metadata, preserve uncertain submissions across restarts, and show that queued messages wait for the current turn.
- Answer newly received native Codex command, file-change and permission requests over a verified original-server connection. Show exact action details, escaped terminal input, file previews and permission scopes; require an explicit offered decision and exclude persistent grants.

### Fixed

- Keep broader file-root grants in Codex for authorization, while allowing explicit decline/cancel from Extalia. Do not treat queued messages as native permission responses.

## [0.4.216] - 2026-11-08

### Fixed

- Keep avatars moving after leaving team pods by testing the actual concave desktop footprint, preserving open chair bays and solid table structure instead of blocking the bays with a square bounding box.
- Connect every registered team pod to its screen and movable chair resource, including pods E and F, so all 24 workstations show their occupant and animate their chair correctly.

## [0.4.215] - 2026-11-08

### Added

- Add an English macOS guided installer with automatically crossfading Office photographs, pause/slide controls, native Applications installation and a safe isolated preview. Keep a branded Standard/Retina drag-to-Applications DMG and installation guide.
- Add an English Windows assisted setup and an offline per-user Linux graphical/terminal installer, with verified payloads, guarded replacement and updater-compatible integrity receipts.

### Changed

- Focus installer Office photographs on the center right, with opacity and fading edges blending into the title background. Generate and verify installation artwork from the shared English catalog and Extalia identity before packaging. Preserve signing, notarization, architecture and release gates.

### Fixed

- Disable the automatic Office camera through its normal control before checking manual floor selections in packaged smoke tests, preventing the active tour from overriding the probe.

## [0.4.214] - 2026-11-08

### Added

- Return messages and answers from Observe and Office to an explicitly paired tool in the existing source conversation, using one-use loopback reply channels through the CLI or MCP. Keep tokens and replies transient, expire waiting tools, and revoke channels on source changes or observation pause.
- Add conditional native control for an already-running Hermes gateway through its public discover-only attachment command, with exact session/owner/generation checks and explicit native question responses. Unsupported installed versions remain unavailable; no agent or gateway is started.

### Documentation

- Document separate native and cooperative capabilities for Codex Desktop, Claude Chat, Claude Code/Desktop Code, Hermes, Antigravity and Gemini CLI, including required setup and current verification limits.

## [0.4.213] - 2026-11-08

### Changed

- Expand application pages to their available width with balanced side padding in Standard, Liquid Glass and Liquid Glass Pro, including full-width empty-state cards. Keep transcript and form reading widths responsive.
- Replace the remaining 18 native dropdowns across Files/Git setup, Knowledge and Skill Books controls with the shared Radix Select. Move editable model suggestions to Downshift and Floating UI while preserving custom IDs, grouped options, keyboard navigation and dismissal.

### Fixed

- Preserve empty workspace/root and unrestricted filter choices, repeated picker actions, disabled options, and valid keyboard focus after a model catalog refresh. Keep folder-picker dropdowns inside native modal dialogs so their options remain visible and interactive.
- Embed canonical installer copy at build time instead of importing Web source into the Desktop runtime; refresh its catalog fingerprint after verifying the existing artwork is unchanged.

## [0.4.212] - 2026-11-08

### Added

- Expand the Large Team Workspace to six four-seat pods with 24 allocatable pod workstations, preserving existing seat identities and adding matching suspended lighting.

### Changed

- Arrange team pods in three columns and two rows, route circulation between columns, and relocate perimeter breakout seating, rugs, lamps and plants. Align the ceiling grid with the aisles and derive the English/Indonesian capacity label from the actual layout.

### Fixed

- Recognize the generated macOS Retina background filename in its installer manifest without exempting other email tokens from the public-repository safety scan.

## [0.4.211] - 2026-11-08

### Added

- Add explicit same-server control for observed Codex conversations through an existing local App Server Unix socket. The host verifies the loaded native thread and folder, subscribes without overrides, sends same-thread messages/steering and answers newly received native input requests. It never starts another engine, forks a conversation, installs hooks or changes source-app configuration.
- Add localized, optional original-conversation controls in Observe and observed-lead Office panels, with explicit answer choices, masked secret fields, stale-session guards and neutral submission/resolution states. Late pending questions and Desktop sessions without a supported public endpoint remain in Codex; no approval automation or automatic retry is introduced.

## [0.4.210] - 2026-11-08

### Fixed

- Align the F2 executive and F3 CEO rear cabinets to their feature walls and keep navigation footprints synchronized. Arrange paired wall sconces, a lounge reading lamp and modest corner planters; support the desk lamp on the actual desktop instead of sinking it into the surface.

## [0.4.209] - 2026-11-08

### Changed

- Expand the Skill Books page and its responsive shelf canvas to the available content width with balanced side padding, including Liquid Glass Pro. Share the wide-page layout with Files and Git.

## [0.4.208] - 2026-11-08

### Fixed

- Give the initial Building camera a gently elevated view of the office and entrance plaza. Bound outward zoom against both the city rim and the camera near plane so the lower viewport keeps rendered surroundings instead of an empty background strip.

## [0.4.207] - 2026-11-08

### Fixed

- Extend shared avatar/NPC recovery to authored stairs and verified lift stalls while preserving genuine queues, moving cabs and healthy door service. Use 3D stair progress, protected mid-landings and collision-checked retreat; sample rider-scoped controller progress before releasing only a stalled rider and replanning around a failed cab. Validate supported landings, preserve pending goals, and apply recovery fades to facility NPCs.

## [0.4.206] - 2026-11-08

### Changed

- Organize Observe into Sessions, Agent apps and Settings tabs, opening Sessions first so connection and observation settings no longer push conversations down the page. Keep session selection and form drafts when switching, with keyboard navigation and responsive English/Indonesian labels.

## [0.4.205] - 2026-11-08

### Fixed

- Recover Office avatars that stop making progress at doorways or along walking routes, using bounded collision-checked detours, replanning and safe local placement while preserving the character and session. Respect real waits and reject unsafe recovery positions. Allow body clearance across authored ground-floor entrance apertures without removing wall, furniture or upper-floor support checks.

## [0.4.204] - 2026-11-08

### Added

- Add graph Explore Mode with animated 3D travel along visible indexed links, neighbour controls, a bounded back trail, explicit note opening and temporary layout freezing. Preserve filters, keyboard editing and the previous 2D/3D preference; respect reduced motion.

### Changed

- Adopt the Advanced Graph View galaxy palette, compact star cores and layered halos under its MIT license while retaining Extalia's Three.js renderer. Tint paths from each endpoint with smooth gradients between different node colours, density-aware dimming and stronger local focus; ship the pinned upstream license notice.

## [0.4.203] - 2026-11-08

### Fixed

- Preserve directory-qualified changed-file evidence across Codex, Claude Code, Gemini CLI, Antigravity and observed Hermes hooks/transcripts. Confirm completed edits before reporting writes, retain patch add/delete/move paths, and support Hermes structured file outcomes. Managed Native and Hermes writes now carry their tool-call identity.
- Show only reported writes in conversation and Office Files tabs, deduplicate hook/transcript evidence by agent and call, and attach late file reports to the correct tool card. Clarify empty-list wording and document source-format limits; arbitrary shell or wrapper-tool edits are not guessed.

## [0.4.202] - 2026-11-08

### Added

- Add persistent Chat orchestrator controls for setup, active/inactive status and reviewed team toggles. New chats edit workspace defaults; existing sessions keep their own teams. Disabling preserves members, model chains and grants, with next-turn behavior and explicit Hermes/observed-runtime limits.
- Add a first-party orchestrator skill and bounded per-prompt relevance guidance. Native starts with relevant skill metadata and up to four matching memory summaries, retains on-demand discovery, and preserves complete prompt/history text. Paused, absent or empty teams run solo; active delegation requires a configured member. Atomic team updates preserve newer user settings against running model edits; Caveman remains explicit concise-style guidance.

## [0.4.201] - 2026-11-08

### Changed

- Let Files and Git use the available content width with equal left/right padding in every surface style, including Liquid Glass Pro. Expand Git empty/status cards to the same content edges while preserving readable description widths and mobile spacing.

## [0.4.200] - 2026-11-08

### Added

- Add Native workspace folder boundaries with one primary and up to fifteen additional selected folders. Choose isolated, cross-workspace read-only (default), or read-write access; both workspaces must permit a cross-workspace operation. Apply the boundary to file traversal, lead/worker tools and mission worktrees, with credential, nested-folder and protected-profile checks.
- Reserve workspace changes against Native admission, require fresh chat history after boundary changes, keep isolated memory separate and require workspace-specific external-skill grants. Refuse unconfined Native terminal commands and integration test gates until a verified isolated executor is available; show this limitation in English and Indonesian.

## [0.4.199] - 2026-11-08

### Changed

- Move the automatic camera toggle beside the Office light switch in the top bar, sharing its state with the scene and retaining the choice during page navigation. Remove the redundant Open chat button from the Office toolbar; use a compact camera icon on narrow screens.

## [0.4.198] - 2026-11-08

### Changed

- Make the Files page a metadata-only project browser: select files or folders for a right-hand details panel, double-click folders to navigate, and switch between grid and list layouts without reading file contents. Keep keyboard and touch folder navigation, credential markers and unavailable-link boundaries.

## [0.4.197] - 2026-11-08

### Changed

- Bring contextual character focus one-third closer while keeping the desk and surrounding room visible. Bound manual floor and All floors zoom out near their viewport-fitted overview instead of allowing distant miniature floors; retain cross-floor following and Building backdrop coverage.

## [0.4.196] - 2026-11-08

### Added

- Add an automatic Office camera with a varying 1–2 minute inactivity delay, animated floor overview/travel/focus, live cross-floor character following and a manual mode switch. Working characters receive 9–17 second stops; idle characters and facility staff receive 4–7 seconds. Newly working or delegated characters receive priority without treating initial history hydration as a spawn.
- Prioritize explicit input/approval waits with a per-character queue, retain multiple outstanding requests through busy sibling activity, and hold the current character until its requests finish. Manual interaction, editing, dialogs and hidden tabs pause automation; reduced motion keeps direct input attention only. Document existing Codex, Claude Code, Gemini, Antigravity, Hermes and MCP hook capabilities and the external reply limitations.

## [0.4.195] - 2026-11-08

### Changed

- Read Hermes team budgets from the selected profile instead of fixing every team at two roles. Show the shared configured worker model, distinguish total one-shot and parallel batch limits, and revalidate before saving, planning or dispatching without editing Hermes configuration.
- Keep saved-session planning on its own Hermes profile, reject unsupported custom backend teams and serialize workspace profile/team changes. Verify eight simultaneous Native workers can use eight distinct models and document queued, dormant and completed Office presence.

## [0.4.194] - 2026-11-08

### Changed

- Expand Native rosters and each approved connection model pool to 32, retaining up to eight models per member chain. Bound active workers to eight per lead turn with cancellable FIFO admission and existing writer/member serialization.
- Align Hermes controls with the standard shared-model, one-shot adapter: up to two configured roles, no per-member model/fallback selectors, and capacity validation before team persistence or inference. Respect profile limits without editing Hermes configuration; distinguish the adapter policy from upstream concurrency and custom routing capabilities.

## [0.4.193] - 2026-11-08

### Added

- Add one optional, editable Model Selection Guide per Extalia profile for team and automatic mission planning. Import Markdown/plain text, track title/revision/update time, and replan against fresh guide contents without rewriting existing teams.
- Explain whether a plan used the saved guide, the lead model's own knowledge or a deterministic fallback. Keep actual model/connection grants authoritative; include a guide template without fabricated benchmark rankings.

## [0.4.192] - 2026-11-08

### Added

- Import long pasted messages as UTF-8 `.txt` attachments in Chat, session dialogs and the Office prompt dock; shorter text stays inline. Preserve selection order, complete Unicode content, attachment limits and retry ownership.
- Import goals longer than the goal field into a bounded text document for team and automatic mission planning. Retain saved team goal documents for subsequent Native/Hermes turns; manual mission planning requires a shorter goal.

## [0.4.191] - 2026-11-08

### Changed

- Refine Knowledge Graph toward the Advanced Graph View visual reference: compact camera-facing star cores, softer procedural halos, a cool cluster palette and finer paths that fade with depth in dark mode. Preserve sparse-graph visibility and stronger light-theme path contrast without adding links or decorative nodes.
- Tint the graph backdrop from the active app theme/material and keep graph controls readable on glass surfaces. Keep per-core geometry at two triangles and respect the shared lower-resolution render budget. Preserve selected-node rings without glow, screen-space picking after orbit, front-node depth ordering and current-theme materials after graph refresh.

## [0.4.190] - 2026-11-08

### Added

- Native teams can explicitly approve up to eight additional saved provider connections and route each of up to 20 members through its own connection and ordered model fallbacks. Workers run bounded tool loops and return their findings to the lead; independent readers run concurrently.
- Team setup exposes connection-specific model catalogs, custom model ids and member selection in English and Indonesian. Office cards show configured worker models and actual runtime/fallback metadata, refreshing after same-size team edits.

### Fixed

- Keep credentials, feature ownership, request limits and fallback chains scoped to the selected connection. Freeze turn admission and connection mutation guards through actual cancellation settlement; prompt imports and model-driven roster edits cannot expand connection grants or mission authority.
- Queue overlapping invocations of the same named member and preserve shared-workspace writer serialization. Re-planning retains approved routing, disabled teams do not unlock unused connections, and missing active references fail closed.

## [0.4.189] - 2026-11-08

### Fixed

- Keep Chat and Office model/permission controls bound to the saved session runtime and connection after workspace defaults change. Refresh same-workspace model catalogs, preserve permission mode and effort during dock updates, and retain explicit Hermes models for newly created sessions.
- Explain when an open conversation still uses the previous workspace target and offer a new session using the current default. Clarify that skipping workspace setup leaves the saved runtime unchanged.

## [0.4.188] - 2026-11-08

### Fixed

- Checkpoint accepted Native prompt text before credentials or inference, discard cancelled late replies, and seal/drain admitted local writes before releasing the profile lock. Track skill staging/cleanup, worktree and connector mutations and credential writes without claiming external process settlement or replay safety.
- Keep memory conflict feedback visible while reading or editing within the disclosure, and prevent transcript text from showing through the expanded memory surface in glass themes.
- Keep expanded memory controls reachable beside a long draft in short viewports, with a bounded scrolling body and an independently scrollable composer.
- Give the chat composer an opaque backing beneath its themed surface so transcript text cannot obscure a draft in glass templates.
- Remove inherited Anthropic cache-control markers when replaying native response blocks, preserving signed thinking and nested tool data so opt-out and unsupported connections cannot accidentally inherit caching.
- Reject contradictory reported cache subsets and unsafe aggregate token counts. Preserve reported zeroes, keep overflowed fields unknown, and make Native token budgets fail closed on arithmetic overflow.

### Changed

- Rank the initial workspace memory preview by bounded literal relevance, with descriptive filename matches eligible beyond the first alphabetical page. Reuse a bounded stat-validated metadata-only cache; full bodies, search and revision guards remain fresh. Add a reproducible synthetic recall/latency benchmark with explicit misses and no provider-token savings claim.
- Keep Native skill prompts and discovery pages bounded as Grimoire grows beyond 1,000 skills. Add constant-size list/search/read schemas, separate agent inventory from the UI report cap, share fresh index scans for selected reads, and retain external metadata with private digests instead of all instruction bodies. Scanner and active-revision checks still apply before every external offering or read.

## [0.4.187] - 2026-11-08

### Added

- Native Memory & context controls show effective workspace/connection ownership and separate latest-request context from turn usage. Browse redacted metadata/pages, create and edit complete revisions, and explicitly delete read revisions; preserve bounded drafts across navigation with restart protection.
- Opt-in ephemeral prompt caching for supported official Anthropic connections and an explicit estimated Native input ceiling. Guard complete request growth before provider entry without truncating history or fabricating usage; local limits cannot trigger model fallback.

### Fixed

- Normalize new Anthropic input usage to include cache reads and cache creation exactly once for mission budgets. Show reported cache counts and genuine zeroes while keeping missing usage unknown and historical figures unchanged.
- Require revision guards on new model-facing memory writes, serialize competing writes/deletes, and reject stale note continuations. Drain human memory operations and reserved workspace deletion before releasing the host profile lock; unsupported or malformed peers cannot silently enable edits.

## [0.4.186] - 2026-11-08

### Fixed

- Keep Knowledge graph paths visible in dark and light themes with contrasting tinted edges, adaptive density and clearer default widths. Focused connections stand out while filtered links remain absent.

### Changed

- Refine graph nodes with lightweight shaded pearl cores, clearer sizing, softer halos and a selection ring that remains available when decorative glow is off, without adding draw calls or textures.

## [0.4.185] - 2026-11-08

### Added

- Shared Native status panel in the Office/Chat/Missions top bar, including phones. Show actual local operations and delegated invocations, recorded task evidence, workspace context, backend selection, shared daemon state and retained blocker reasons. Link approvals and exact mission recovery through existing controls; stale/unsupported/unavailable snapshots disable actions.

### Fixed

- Bind status-panel cancellation to the displayed invocation so an outdated row cannot stop a replacement run in the same session. Recheck only positively settled inactive planning/preparation receipts with activity/identity/close guards; uncertain execution remains quarantined without replay or force-clear.
- Project bounded Native status metadata lazily without copying mission answers or terminal history. Counts/truncation stay explicit; configured/queued team members do not count as running workers, and cancelled invocations remain visible until local settlement.

## [0.4.184] - 2026-11-08

### Changed

- Native `read_file` scans pages with a fixed input buffer and bounded retained lines instead of loading, decoding and splitting the whole file. Validate the opened handle and actual 5 MiB read ceiling, preserve Unicode/pagination/binary output, and await closure on cancellation and errors.
- Document resource-based Rust/TypeScript/Python process ownership and add a reproducible frozen-baseline file-read benchmark with output parity, p50/p95, OS peak RSS and observed event-loop delay. Local synthetic scenarios reduce reader-process peak RSS with documented latency tradeoffs; the Native LLM loop remains in TypeScript pending its Rust migration gates.

## [0.4.183] - 2026-11-08

### Fixed

- Saved Rust Native missions durably record their preparation scope before credentials or isolated worktrees are prepared. Session and connection guards survive uncertain acknowledgements, restart and backend changes; planning cannot overlap unresolved mission preparation. Successful starts retain the preallocated mission/supervisor identity through recorded handoff.
- Drain entered credential preparations after an early sibling failure, retain recovering ownership when cancellation or fresh-worktree cleanup is uncertain, and wait for entered worktree registry writes before releasing the profile lock during shutdown. Preparation observations remain local evidence and do not authorize execution recovery or writer fencing.

## [0.4.182] - 2026-11-07

### Fixed

- Git discovers repositories inside workspace subfolders, including when the workspace folder has no repository of its own. A repository selector scopes branches, changed files and diffs to the chosen folder; switching repositories clears the selected diff and rejects stale responses. Discovery is bounded and skips generated, credential and symbolic-link directories; credential-file protection and read-only Git hardening remain in place.

## [0.4.181] - 2026-11-07

### Added

- Grimoire contents, literal in-book search and page-number navigation turn the current book in place. Heading extraction excludes code fences and preserves source page positions and Unicode text.
- Incremental read-only skill-registry metadata pages continue beyond the initial 500-row report. Each user load reads at most five 99-row pages; loaded counts, generation checks, cursor-cycle guards and refresh controls prevent mixed or stale catalog batches. Existing scanner, consent and activation requirements remain unchanged.

### Changed

- Reorganize the sidebar into Workspace, Library, Activity and System modules with workflow-aware priorities and existing feature gates. Knowledge uses the available main-column width with responsive gutters, including glass templates.
- Book and List modes are exclusive. Book renders at most eighteen volumes with a keyboard picker; List renders twelve, twenty-four or forty-eight items per catalog page. Precomputed metadata search and direct catalog-page jumps support growing catalogs without rendering every entry. Closed skill management defers mounting its heavy forms and rows until first opened.
- Knowledge exposes immediate selected-note focus and close actions, plus an independent depth/clear trail that remains available when appearance controls or the note panel are closed. Filtered or missing anchors show generic recovery guidance without hidden note titles.

### Fixed

- Initial registry reports stop at exactly 500 raw rows and reject mixed generations instead of overshooting the bound. Loading more metadata keeps an open book and its visible shelf stable, including a partially filled final shelf; appended covers appear after the book closes.

## [0.4.180] - 2026-11-07

### Changed

- Rename the Skills collection to Grimoire, with matching English/Indonesian navigation, headings and Settings links. Skill categories, instructions and security management retain their familiar terms.
- Refine in-place skill books with illustrated cloth covers, foil, binding, layered paper edges, ribbon bookmarks and editorial page typography. Keep animated cover/page turns, literal content, a fixed reading viewpoint and same-area copyable text. Background and reader tools follow the app theme.

### Fixed

- Keep expanded Knowledge graph camera controls within the phone viewport below the app navigation, including glass surface styles.

## [0.4.179] - 2026-11-07

### Changed

- Knowledge opens a canvas-first graph explorer with compact overlay controls, structural communities, 2D/3D layouts, real line-width/opacity controls, zoom, fit and an expanded view. Colors, background, controls and labels follow the app theme and material template in both light and dark modes. Sparse vaults receive stronger individual-link contrast; light mode uses appropriate compositing instead of additive light on a pale background.
- Graph communities and their view-only layout derive from actual loaded links. Palette reuse keeps large graphs colorful while legends count exact community membership. Keyboard search, scoped filters, note inspection and list fallback remain available; idle pulse timers now stop completely and small dots retain usable pointer targets.

## [0.4.178] - 2026-11-06

### Changed

- Skill books now animate in the shelf itself: the selected volume moves forward, opens its cover, displays actual text on its page surfaces, turns a curved leaf and closes back into its original shelf position. Remove the separate scrolling inspector; keep copyable text, keyboard controls and unavailable-3D fallback in the same scene area. Compact layouts show a readable single page, and reduced motion settles directly at the requested view.

## [0.4.177] - 2026-11-06

### Added

- Skills opens an interactive 3D bookshelf of real bundled, project and exact registry-revision entries, with source/category search, bounded shelves, an accessible list and paged literal instruction reading. Procedural local covers use the existing Three.js version; selection never changes skill permissions or lifecycle state.

### Fixed

- Knowledge stays visible on Desktop and Bridge hosts with the default TypeScript mission backend. Knowledge and recorded Rust recovery share one lazy index sidecar; mission routing and scanner-gated skill policy remain unchanged. Direct vault/Obsidian folder setup is available on Knowledge as well as Settings, with honest unavailable/restart guidance and folder-save feedback.
- Vault switching drains earlier note writes before saving the new root, blocks new writes/admission during the switch, and refuses restarts while global planning, mission/recovery or registry work remains unresolved. Replaced hosts and vaults clear stale page reads and editor state.

## [0.4.176] - 2026-11-06

### Fixed

- Avatar clothing: restore anatomical skin binding damaged by layer conformance, refit eleven loose garments against the full body, lower head-adjacent hoods/collars and restore neck backing. Conservative opaque-trouser coverage and a separate lining under the alpha-cut trousers keep covered pelvis/thigh skin behind clothing. All 32 garments are reviewed in standing, walking and seated poses; see `docs/product/garment-fit-review.md`.
- Vehicle indicators use compact amber strips mounted on the actual lamp surfaces instead of floating spheres and halos. Their orientation stays fixed to the body through turns, blinking follows simulation time, and signals stay on while waiting and through the complete turn before cancelling.
- Decorative pots have coordinated corner/terrace placements and sizes bounded by actual foliage height and radial spread. Desktop arrangements keep at most one small botanical accent in the rear slots, clear of keyboard/mouse and device areas; procedural fallbacks follow the same scale limits.
- Rust bundle filesystem tests use distinct per-process fixture sequences so parallel tests cannot collide when the system clock returns the same timestamp.

### Changed

- Lossless garment buffer compaction reduces the 32 clothing GLBs from 94.74 to 90.02 MB; sixteen meet the 1 MB target. Sparse zero morphs and exact storage deduplication retain decoded geometry, influences, textures and source UVs without a new runtime decoder. The largest detailed garments remain above target.

## [0.4.175] - 2026-11-06

### Fixed

- Garments in motion: `tooling/blender/garment-layers.py` poses each published garment's own rig (seated, walking, reaching, typing, with the runtime's seated and walk drape morphs) and finds inner layers that leave the one over them: legs and skin through skirts and trousers, a skirt's waistband or a trouser seat through a top's hem. Covered inner vertices are conformed to the layer over them (its skin weights and drape deltas, just beneath its surface), so they bend with it; skirts conform above the hips only and the jumper skirt's seated drape is lifted over the thighs (`drape`). Over the 24 affected outfits and pieces, vertices poking through while seated, walking or reaching fall from 7,431 to 1,267 (the original dress, both bartender uniforms, the female tops and the ray underlayer to none or almost none). The denim dress, gothic skirt and ray trousers keep their own fit, which measured better. Manifests and source-garment receipts carry the new hashes.

## [0.4.174] - 2026-11-05

### Added

- Eight new detailed hairstyles from the owner's hair packs (`tooling/hair-packs.json`): bun with bangs, sleek ponytail, long straight, long bangs, straight short and dreads for women; dreadlocks and an afro for men. Each is fitted in Blender to the reference head's skull and bound to the `head` bone (`tooling/convert-detailed-hair.py`, now with `texture_dir`, `planar` card simplification, `skull_object` and `uniform` fitting), re-textured grey for the runtime hair colour, compact-encoded and quantized: 0.32-0.83 MB each, the two densest 1.17-1.20 MB. The afro's hair curves become a coiled volume shell first (`tooling/blender/prepare-afro-shell.py`). Generated looks draw from 11 women's and 7 men's detailed styles; saved curly/afro looks wear the afro and wavy/long looks the long straight hair. Licences are pending owner confirmation (`LicenseRef-Owner-Provided-Unverified`, "Owner-provided hair packs" notice section); `prepare-public-models.py --hair` publishes them.
- Work on the move: a busy character that walks (to its desk, to the library laptop for a skill task, through the lifts) carries a work tablet in both hands at the chest and glances down at it; the walk's arm swing gives way. The tablet is a Blender model (`tooling/blender/create-tablet-prop.py`, `furniture/tablet.glb`, 28 kB, MIT; `prepare-public-models.py --only <path>` publishes one generated export). A desk computer shows its owner's work only while the owner sits at it (`movement/deskPresence.ts`): one walking away leaves a locked screen. Seated busy characters already stay at the desk until the work is done.

### Fixed

- Garment fit: `tooling/blender/garment-fit.py` audits every published garment against its body's skin and scanned under-outfit (belly, chest, hip and neck clearance) and draws loose panels in by moving vertex positions only, so materials, compact texture records, skin weights and seated-drape morphs stay intact. The jumper skirt no longer reads as pregnant (belly clearance p95 15.7 to 5.2 cm); the oversized female top, gothic blouse, denim dress and printed hoodie sit closer at the chest and belly; the pink and flame hoodies, oversize shirt, reception uniform and cloth jacket hug the neck so it no longer looks short. Manifests and source-garment receipts carry the new hashes.

## [0.4.173] - 2026-11-05

### Added

- Turn signals: a car about to turn (20 m before the junction) and turning blinks amber lamps at the front and rear corners of the turn side, 1.5 Hz with its own phase. The lens reads by day; after dusk an additive halo grows and brightens. With reduced motion the signal stays lit instead of flashing.

## [0.4.172] - 2026-11-05

### Added

- Campus greenery: 18 plants and trees (3 potted plants, 4 garden plants, 11 trees) simplified in Blender from the owner's downloads (`tooling/blender/prepare-greenery.py`, `campus-greenery.json`), each under 1 MiB (9.6 MB in all, from 3.6 GB of sources). They replace the procedural indoor pots and desk plants, campus, civic-park and parking trees and shrubs, and the city-park trees near the campus once loaded, with deterministic per-placement variants, yaw, size and foliage tint. Indoor pots (including the lobby's monumental palms, the meeting and executive rooms' sculptural planters and desk plants) use one plant per room, square to the walls and at one size, so paired pots match. Licences are pending owner confirmation (`LicenseRef-Owner-Provided-Unverified`, left out by `EXTALIA_COMMERCIAL_ASSETS_ONLY=1`); `?greenery=procedural` keeps the fallbacks.

### Fixed

- The traffic queue test adopts a car from its own network's rotation instead of today's date-seeded catalog, so it no longer fails on days whose first car is not in that rotation.

## [0.4.171] - 2026-11-05

### Fixed

- macOS release verification calls `lipo <executable> -verify_arch <arch>` with the input file first, so the hosted runner's lipo no longer reads the executable path as an architecture and rejects the DMG with a usage error (`invalid-arguments`).

### Changed

- The Desktop and npm/Web beta moves to v0.4.171 (`docs/release/v0.4.171.md`) because the v0.4.170 draft could not pass the macOS archive check; v0.4.170 stays unpublished.

## [0.4.170] - 2026-11-05

### Changed

- Release notes for the Desktop and npm/Web beta v0.4.170 (`docs/release/v0.4.170.md`), which supersedes the unpublished v0.4.157; the README download table points at v0.4.170.

## [0.4.169] - 2026-11-05

### Fixed

- The night Splash loop no longer flickers: re-rendered on a hardware GPU, the skyline's lit windows stay steady instead of blinking on every frame (a software-renderer artifact). `tooling/check-splash-flicker.mjs` measures blinking in the loops.

## [0.4.168] - 2026-11-05

### Changed

- The Splash background loops (day and night) and their posters are re-rendered from the current campus: the redesigned building facade, roof plant and exterior stair, the outdoor campus with parking areas, parked cars and moving traffic. The capture camera is reframed so the whole building and the vehicles are in view.

## [0.4.167] - 2026-11-05

### Changed

- Generated character looks in the Office no longer repeat casual clothing: every outfit and wardrobe piece has a dress code, casual items are unique among the characters present at the same time, while uniforms, suits and other formal wear may be shared. When casual clothing runs out, the next character wears formal clothing. Saved looks are never changed and their casual items count as taken.
- Generated hair is chosen randomly from the detailed GLB styles of the character's group, kept distinct while possible, and changes on every page load; the appearance editor adds **Randomize hair** (Indonesian: **Acak rambut**). Generated looks and editor choices no longer use procedural clothing or hair, which remain only as the fallback when a model fails to load; saved looks with procedural hair render the nearest GLB style.

## [0.4.166] - 2026-11-05

### Added

- The Office loading screen follows real model loading instead of fixed stages: the bar grows smoothly and never jumps or moves backwards, the percentage counts through every number, a soft highlight sweeps left to right while loading continues, and the label names what is loading (for example "Loading clothing · Victorian bartender (12 of 48)" / "Memuat pakaian · … (12 dari 48)"). On slow devices the bar keeps creeping within the current stage instead of freezing. Reduced motion shows the value without easing or shimmer, and screen-reader updates are throttled.

## [0.4.165] - 2026-11-05

### Changed

- Campus traffic now drives on one connected road network instead of six isolated straight lanes: the front road, the roads behind and beside the building and the surrounding ring are joined at junctions, cars turn left or right along multi-junction routes, wait their turn at junctions and keep their distance, and still stop at the front zebra crossing. Cars enter and leave only at road ends outside the visible district, including cars driving to and from the building's parking lots, so no car appears or disappears in view.

## [0.4.163] - 2026-11-04

### Changed

- 44 avatar body, hair and garment GLBs store skin weights as normalized 16-bit and tangents as normalized 8-bit (`KHR_mesh_quantization`, decoded natively by three.js without WebAssembly), saving 29.3 MB. Positions, normals, UVs, joints, morph targets, skins, materials and textures are unchanged; measured maximum differences are 1.12e-5 for weights and 0.315° for tangent direction with exact handedness. `tooling/compress-public-models.py --quantize` repeats it and `--verify` checks every quantized accessor.

### Fixed

- The `extalia` Bridge now sends `ETag` and `Last-Modified` for static files such as GLB models and answers conditional requests with `304 Not Modified`, so reopening the Web client no longer downloads every model again. `If-Range` only resumes a range while the file is unchanged; the token-bearing `index.html` stays `no-store`.

## [0.4.162] - 2026-11-04

### Changed

- Public models: 38 garment, outfit and hair GLBs re-encode their PNG textures as lossless WebP (`EXT_texture_webp`) and store identical images once; normal, metallic-roughness and occlusion maps above 2048 px are downscaled to 2048 px. Colour pixels are identical and no motif changes; the registered GLB total drops from 691,568,420 to 417,978,116 bytes. `tooling/compress-public-models.py` repeats the conversion (`--dry-run`, `--write`, `--verify`), and the model validator accepts a conversion only when it is recorded against the original image hash.

## [0.4.161] - 2026-11-04

### Fixed

- Connector lock: replacing a stale `operation.lock` left by a crashed process now happens only under an exclusive breaker file. Before, several Extalia processes starting together could each replace it and run connect or recovery concurrently (reproduced in 26 of 40 six-process runs; 0 of 40 after the fix).
- A connector change still running in the same Bridge or Desktop process is no longer shown to other tabs as interrupted, and a journal whose lock predates the last restart is reported for review instead of looking clean while connect stays refused. Journal removal retries briefly on Windows file locks, and a lock directory removed by a refused concurrent operation is recreated instead of failing.

## [0.4.160] - 2026-11-04

### Added

- Connect agent apps in Web and Desktop shows an interrupted connector change with each file's state (not applied, applied, changed since) and offers Roll back or Keep current files, each behind an inline confirmation. Roll back is disabled when any file changed since; connect, disconnect and apply stay disabled until the record is resolved. English and Indonesian text; older hosts without the optional method keep the previous behavior.

## [0.4.159] - 2026-11-04

### Fixed

- Connect agent apps changes now run one at a time across Desktop, Bridge and the CLI, with a write-ahead journal of every configuration, token, forwarder and manifest write. An operation interrupted by process death is never replayed or rolled back automatically: later changes refuse, status shows a warning, and `extalia connections --recover` reviews it before an explicit, confirmed rollback or keep. Rollback refuses files changed since.

## [0.4.158] - 2026-10-31

### Fixed

- Coordinate late-execution mission tests after the provider or tool actually enters, keeping real timeout callbacks and fail-closed assertions. Exercise byte-based history pruning through two durable saves instead of repeated large setup writes on Windows.
- Report bounded Mac archive executable and architecture-tool failure diagnostics while preserving mandatory architecture and strict signature checks. Add a read-only hosted workflow to diagnose retained archives without publishing them or replacing release gates.

## [0.4.157] - 2026-10-31

### Added

- Release drafts now collect the Desktop installers, standalone Web client, six npm tarballs and a complete SHA-256 inventory from the same tag, after their required build and packaged-smoke gates. Publishing and npm authentication remain explicit maintainer operations.

### Changed

- Refresh installation and release documentation with npm first, current download links, Native skills/memory/Obsidian capabilities and their remaining scanner/Python/ACL limits. Document the current shared asset footprint and individual asset licenses instead of implying unrestricted commercial reuse.
- Run the full host suite against the real daemon on CI platforms, including durable planning, registry and prompt-learning regressions. Exclude Python bytecode and local visual-review entries from release source.

### Fixed

- Observed sessions on Windows now map to their workspace; project paths with backslashes never matched before.
- README download names match the release workflow's Web archive, with a direct link to the complete checksum inventory.
- Failed macOS release jobs retain unverified archive artifacts for diagnosis without uploading them to the public release or weakening signature checks.
- Texture failures in the isolated Desktop smoke report bounded app-blob source hashes and fetch/decode diagnostics; a successful diagnostic retry never clears the original model-error gate.

## [0.4.156] - 2026-10-31

### Added

- Native Chat can learn one generated skill candidate from an explicitly opted-in message or `/learn-skill` command. Candidates carry host-bound provenance, appear in the user's Skills library and request mandatory registry inspection; scanner-unavailable candidates remain quarantined without approval or activation.
- Shared Chat and character-dialog composers provide a per-message Learn as skill option in English and Indonesian. Learning authority never comes from ordinary reading, history, quoted instructions, delegated workers or prior write grants.

### Fixed

- A first-message session handoff preserves the prompt, learning choice and uploaded attachment IDs if sending fails. Unrelated navigation still discards stale completion effects; preview hosts refuse unsupported learning through both entry forms.

## [0.4.155] - 2026-10-31

### Changed

- External agent skills now require fresh scanner-gated registry reads for both catalog metadata and instructions. Legacy user/project consent remains review input and cannot bypass scanning; canonical shipped built-ins cannot be shadowed by external names or source flags.
- Legacy Skills controls now record/remove review instead of implying activation. Native lead and worker guidance treats skill documents and prompt links as unverified data that cannot replace the registered scanner workflow.
- External skill catalogs no longer reuse cached instructions or fall back to supplied bodies. Opaque host catalogs and exact identity checks reject forged offerings, changed revisions, stale scan context and URL/path skill requests without download/import fallback.

### Added

- Source GLB clothing intake preserves original panels, UV layers, embedded texture bytes and native material graphs. Every example has a recipe; variants and separate garments have independent, hash-bound appearance/pose reviews and per-file geometry budgets before entering the public or reviewed local catalogue.

### Fixed

- Fitted garment layers can own their neckline, gloves and footwear. Native clothes tuck behind actual jacket surfaces, while source-specific sleeve landmarks, leg sections and articulated skirt weights improve activity poses without replacing original fabric motifs.

## [0.4.154] - 2026-10-31

### Added

- The Skills page can preview category/intent routing over exact registered revisions and dependency pins. Read-only results preserve ranked matches, ambiguity, exclusions and omitted diagnostics; no skill is activated or dispatched.
- The Obsidian vault graph can filter loaded notes by exact folder, note kind and any tag, including root/uncategorized/untagged notes. Filters combine with time and neighbourhood focus across the canvas, search, counts and accessible list.

### Fixed

- Routing diagnostics reject conflicting metadata for the same exact revision across dependency plans. Host and input changes discard late routing replies; filtered graph notes no longer leave their content visible in the selected-note panel.

## [0.4.153] - 2026-10-31

### Added

- Saved Rust Native automatic planning records its invocation before credential, catalog or model calls. Unfinished session/connection scopes stay blocked across restarts and backend changes; only actual local pipeline completion records a weak observation. TypeScript and history-off planning keep their existing behavior.

### Fixed

- Connection testing, team planning and saved-connection edits respect unresolved planning scopes. Shutdown drains pending planning-marker writes before releasing the profile lock, preventing an older host from overwriting a new host's records.

## [0.4.152] - 2026-10-31

### Added

- Native missions retain an immutable original task plan in the Rust store, captured atomically with creation. Admission and recovery inspection refuse missing, extra or changed task definitions while allowing normal execution state changes. A bounded internal reader reports legacy history as unavailable; this does not certify executor or child-process settlement.

## [0.4.151] - 2026-10-31

### Added

- Characters can combine body-specific tops, bottoms and optional outer layers, save each combination, and receive a stable random outfit on first spawn. The appearance editor filters garments by body and keeps staff uniforms tied to their roles.
- Original textured clothing exports preserve the supplied jacket, dress, receptionist suit, bartender vest and denim garments, with source attribution and separate licensing for added avatar context.

### Fixed

- Garment conversion preserves source panel seams before reduction, binds cuffs to arms, and uses normalized export weights. Runtime layering retains safe native clothing for missing pieces, preserves original colours on Auto, and chooses the selected shoes' sole height. Added skin joins the native ankles, internal cloth covers separated armholes, and opaque suit layers no longer disappear behind the shirt.

## [0.4.150] - 2026-10-30

### Added

- A Files tab in the session dialog, Chat and Observe lists every file a session changed, newest first, with its change, edit count and time; a row opens the file preview. A lead shows its team's edits, a worker its own.
- Replies render nested lists, task boxes, strikethrough and rich quotes, code blocks get light syntax colouring (including diffs), messages offer copy on hover, and long prompts fold with Show more.

### Changed

- Conversations share one reading view across Chat, Observe, History and the session dialog: a centred column, calm user bubbles, and tool runs as one quiet line that opens into a thin rail.

### Fixed

- Claude task notifications with `<usage>` no longer show as raw XML; fields added later no longer break the card, and tokens, tool uses and duration are shown. Slash commands, shell commands, command output, Codex subagent reports and injected app context now appear as what they are, and the Activity tab and Office activity use plain text for them.

## [0.4.149] - 2026-10-31

### Fixed

- Claude task notifications containing a result now remain readable source cards, with a separate task-result section. Failed status is preserved and result text never becomes a new user request.

## [0.4.148] - 2026-10-30

### Added

- 36 wearable outfits (28 female, 8 male) refitted from the owner's RenderHub and Sketchfab clothing downloads: skinned to the avatar rig without arm-to-torso webbing, simplified to about 7k triangles, recoloured into tint zones and credited in `THIRD_PARTY_NOTICES.md`. A catalog-driven Blender pipeline (`prepare-avatar-outfits.py`, `avatar-outfits.json`, `publish-avatar-outfits.py`) turns each new garment into one catalog entry.
- Office characters start in a generated outfit picked from the scanned styles and the fitted outfit catalog of their gender, with coordinated office or casual colours; the look is stable per character and stored only when you save an edit. The appearance editor offers every outfit for the character's gender, jacket and accent colours, Randomize outfit and Default outfit.
- The receptionist and the bartender wear locked role uniforms (receptionist: blazer, name badge, brand-teal scarf or tie; bartender: waistcoat, bow tie, rolled sleeves, long bistro apron); their accent colour, hair, skin and accessories stay editable. Built reproducibly by `tooling/blender/create-staff-uniforms.py` from the avatars' licensed outfits.

### Fixed

- A departing car's give-way stop is interpolated between path samples, so its front bumper never ends past the painted line.

## [0.4.147] - 2026-10-30

### Added

- Clickable message attachments and local Markdown file links, with read-only workspace previews and an explicit local-only file chooser for unavailable/out-of-scope files. Preview dialogs handle focus, background isolation and stale requests without opening arbitrary paths or launching files.

### Changed

- Chat, Office, Observe and History share readable message presentation and consistent typography. Attachment envelopes tolerate real export spacing/CRLF; task notifications and context summaries become collapsed source cards. Observe can show hook events even before a portable snapshot is available.

## [0.4.146] - 2026-10-30

### Changed

- Chat and Office conversations render user links as safe Markdown, show attachment envelopes as file chips, and present exported question replies as readable question/answer cards while preserving source messages.
- Native approvals use numbered options, prevent duplicate submissions, allow retry after failed delivery, and retain the exact selected option in replayed history. Read-only conversations do not show actionable approval buttons; cancelled/failed requests do not invent a Deny selection.

## [0.4.145] - 2026-10-30

### Added

- Progressive workspace memory in Native Chat and Teams: a bounded initial catalog, ranked literal search, metadata pages and Unicode-aware note pages. Read-time masking covers externally edited notes; bounded scans reject unsafe files and report partial results. Workers receive recall tools without memory writes.
- Built-in `memory-recall` and opt-in `caveman` guidance, maintained by Extalia without installing upstream hooks or proxies. No automatic transcript capture or measured token-saving claim.

## [0.4.144] - 2026-10-30

### Added

- Opt-in developer CPython staging from exact source candidates, with bounded streaming USTAR preflight, internal file-link materialization, preserved notices, exclusive output ownership and relocation before a feature-gated Rust health probe. The macOS ARM64 candidate runs without system Python; ordinary checks never download it. No production Python/scanner or application route is enabled.

### Changed

- Worker bundle paths allow sixteen components, retaining the native candidate's license paths measured at depth eleven. Path length, component, inventory and byte limits remain bounded; older validators refuse deeper manifests.

## [0.4.143] - 2026-10-30

### Added

- Worker bundle manifest and bounded artifact observations: independent exact-byte manifest pins, portable sorted inventories, target/role/size checks and streaming SHA-256 over trusted Unix staging trees. Descriptor-relative checks reject ordinary link/inventory changes; Windows observation remains explicitly unsupported. Shared TS/schema/Rust fixtures cover the contract. No actual Python download/bundle, scanner, launcher integration or execution authority is enabled.

## [0.4.142] - 2026-10-30

### Added

- Campus east parking lot: 14 bays (3 EV bays with chargers), a footway link to the building, planting and 5 lamp posts, joined to the east avenue's southbound lane. Layout and geometry are authored in Blender (`tooling/blender/create-campus-parking.py` → `landscape/campus-parking.glb`, MIT, about 1,700 triangles in one draw); a shared `PARKING_LOTS` contract is generated from the Blender layout markers, with `parkingSurfaceY` for drivable heights.
- Cars leave and arrive in both lots on a daily deterministic schedule (more arrivals in the morning, departures in the evening; lots never empty or full). Departing cars start with lamps on, drive out on smooth paths, give way at the painted line and merge; arriving cars turn in, reverse into the bay with a white reverse lamp, flash their brake lamps and switch every lamp off a second after parking. Moving lot cars reuse the per-style batches and get headlight beams and glare; reduced motion pauses manoeuvres.
- `tooling/bench/office-fps.mjs`: production-mode Office benchmark (day/rush/night, overview and close-ups, `--lod off`, `--tier auto`, `--breakdown`).

### Changed

- Rebuilt the west parking access (the step, the gap and the trees in the aisle are gone). Both accesses have a level throat, an eased ramp with retaining walls, a dropped-kerb footway crossing with curved kerb returns, tactile paving, a zebra crossing, a give-way line and a centre line.
- Performance: the campus overview holds about 57–59 FPS at day, rush hour and night (previously 23–44) on the reference machine. In the campus view the Office skips sub-pixel non-emissive detail, leaves interior furniture out of the sun/moon shadow pass and drops the 14 interior live spot lights at overview zoom (baked light pools and every lamp, LED and screen glow stay); screen textures no longer stall the GPU on repaint. The adaptive render budget reacts within about a second when frames exceed 25 ms, ignores one-off hitches and steps back up only after 12 smooth seconds.

## [0.4.141] - 2026-10-30

### Added

- Rust health-probe process ownership with independent watchdogs, bounded stdout/stderr, cooperative cancellation and forced direct-child reaping. Abandoned callers retain a cleanup owner; unresolved cleanup blocks future probes. Feature-gated Rust subprocess fixtures cover timeout, cancellation, overflow and inherited-pipe cases without requiring system Python. This library is not connected to scanner, runtime or application routes, and direct-child exit never proves descendant settlement.

## [0.4.140] - 2026-10-30

### Added

- Probe-only Python worker protocol foundation: a strict versioned health contract, generated JSON Schema, matching bounded TypeScript/Rust NDJSON codecs and a pure Rust exchange with correlation, deadlines, cancellation retirement and lifetime request identities. Shared fixtures and an opt-in isolated stdlib Python reference verify interoperability. No production launcher, Python requirement, scanner, activation or process-settlement authority is enabled.

## [0.4.139] - 2026-10-30

### Added

- Rust core category/intent routing preview over exact active skill revisions, with dependency/permission eligibility before ranking, deterministic match reasons, preserved ambiguity and bounded sanitized exclusions. One shared read-only source snapshot checks approval applicability for candidate and dependency workspaces while retaining all ambient conflicts. Every result denies dispatch; runtime selection, scanner and activation gates remain unchanged. Official scanner source evidence is documented without installing or enabling a scanner.

## [0.4.138] - 2026-10-30

### Added

- Read-only dependency checks on the Skills page, with exact revision/pin selectors, localized blockers and diagnostic ordering. The optional daemon/host capability preserves older peers; bounded results always deny dispatch and never run inspection, write consent, approve or activate skills. Unknown compatibility facts and an empty diagnostic permission ceiling remain explicit. Pending reports are discarded when inputs, host, scanner/policy or registry context change.

### Fixed

- Daemon clients negotiate with the original v1 capability vocabulary, then discover optional operations from the server reply. Adding a new operation no longer makes strict older daemons reject the initial handshake; required-operation checks and optional feature gates remain unchanged.

## [0.4.137] - 2026-10-30

### Added

- Rust skill dependency and compatibility preflight with explicit immutable pins, bounded version/graph diagnostics, dependency ordering, cycles, bidirectional conflicts, active-consumer constraints and literal permission ceilings. A read-only profile snapshot reconstructs manifests from verified staged sources and checks active approval/inspection bindings. Results never authorize dispatch or activation; scanner and existing resolver gates remain closed. No daemon/UI/runtime integration or Python worker is enabled.

## [0.4.136] - 2026-10-30

### Added

- Built-in skills library with name/description/category search, six categorized groups, match counts and read-only instruction disclosures in English and Indonesian. Optional bounded category/body metadata keeps older host catalogs usable; unknown categories stay uncategorized and unavailable instructions are labelled honestly. Viewing or filtering a skill never changes runtime selection, consent, permissions or activation.

### Fixed

- Skill Security Center action buttons pass React keys directly, avoiding development console warnings without changing review or activation behavior.

## [0.4.135] - 2026-10-30

### Added

- Whole-vault 3D graph neighbourhood focus: explicitly focus a selected note and explore one, two or three steps through actual visible links. Focus stays on its stable note identity across selection and refresh; unavailable or time-filtered roots explain why the focused view is empty. Clear focus preserves the time filter and camera. Visible note/link counts and colour legend follow the focused subset without changing palette assignments or vault data.

### Fixed

- Graph filters and refresh cancel camera flights toward hidden or removed notes. Search keyboard selection uses stable note identity and stays within rendered options; an empty refreshed vault retains its missing-focus explanation and clear action. Hidden links no longer reappear faintly through fog, and hidden note halos are extinguished.

## [0.4.134] - 2026-10-29

### Added

- Whole-vault 3D graph notes return to their pre-drag positions by default, with reactive neighbours/links, a free-settling toggle and explicit layout restore that preserves the camera. Exact snapshots stay in the view worker and never modify notes or links; reduced-motion restores are immediate, background work pauses and filter/refresh clears old restore points. English and Indonesian controls and gesture/lifecycle regressions cover the interaction.

### Fixed

- Filtering, refreshing or hiding a vault graph during a drag releases pointer capture and orbit controls. Late terminal frames cannot replace a newly dragged node, and final position easing ends at the exact target.

## [0.4.133] - 2026-10-29

### Changed

- Campus traffic comes in waves on six straight lanes (front road and both avenues in both directions): deterministic per-lane schedules from the day's seed with 1–3 cars 2.2–4 s apart and 10–30 s gaps; busiest in the morning and evening rush, calmer by day, quiet but never empty at night. Cars keep 1.8 m clearance and queue behind a waiting car at the zebra crossing with brake lamps on. Only the day's styles drive; the long box truck and limousine appear rarely and only on lanes without a crossing. Moving cars are capped per render tier (16/14/10/6) and stay instanced; still at most two real headlight spots.
- The procedural single-cab truck is retired: `campus-mobility.glb` holds only the EV charger and cycle shelter, `mobility-truck` resolves to the day's derived mid-size pickup, and every day's rotation parks at least one derived pickup.
- Campus cars fix pass: remaining brand emblems and lettering removed from 18 cars (new `emblems` catalog key), the Audi estate grille smear and the Yangwang U8 lamp-housing patches fixed, the Hummer EV side windows closed (new `side_caps` key), and the BYD ETP3 listed as an EV. The Volvo XC90, Cadillac Escalade and GMC Sierra are under the Sketchfab Standard licence (ActsOfDoge) and the 1970 Dodge Charger under CC-BY-NC-SA-4.0 (OUTPISTON, non-commercial), with matching embedded notices. Third-party notices omit the unverified-licence sentence while no car uses that licence.

## [0.4.132] - 2026-10-29

### Added

- Rust schema 10 adds immutable native edit-intent history bound to actual execution admissions, exact live leases and write-capable running tasks. Scoped replay, digest-bound withdrawal, per-execution clocks and atomic recovery/expiry preserve pending/revoked/expired history without storing raw arguments.
- Native intent SQL guards reject replacement/clock rewind, legacy-grant attachment and promotion to granted/rejected. Parameter/policy fingerprints stay explicitly unverified; this storage format has no positive approval, consumption, RPC/runtime or tool-execution route.

## [0.4.131] - 2026-10-29

### Added

- Rust schema 9 adds a separate provisional delegation allocation ledger with explicit scoped seeds, hierarchical subtree escrow, CAS and immutable idempotency receipts. Child reservations carve shared slots and all four budget caps atomically; descendants do not double-charge ancestors.
- Ledger reconstruction checks balances, revision/receipt chronology and canonical payloads; whole-pool revocation never refunds capacity. Persisted clock observations prevent recorded expiry denials from being bypassed by clock rewind, while SQL/precommit failures roll back writes. Temporary-store race, replay/restart, corruption and migration regressions cover the boundary. No grant verification, metering, daemon/RPC/runtime wiring or dispatch authority is enabled.

## [0.4.130] - 2026-10-29

### Added

- Additive scoped delegation intents with explicit authority/definition references, acyclic task lineage, bounded descendant allowances, integer budget caps and expiry. TypeScript and Rust validators share generated-schema conformance fixtures; legacy aliases cannot supply authority implicitly.
- Pure TypeScript/Rust inspection rejects expanded child scope, lineage resets, reused parent identities, increased budgets/windows and conflicting idempotency intents. A consistent result never authorizes execution or replay; real grant resolution, atomic sibling reservations, receipts and broker activation remain pending.

## [0.4.129] - 2026-10-29

### Added

- Additive control task snapshots separate definition/state revisions, lifecycle, execution outcome, validation and acceptance/waiver claims. TypeScript, generated JSON Schema and Rust reject malformed records and inconsistent completed/accepted claims using shared fixtures, without changing legacy task enums or activating dispatch.
- Pure read-only legacy task projection preserves installation/source-workspace/task provenance and original verification labels. It keeps unknown revisions and acceptance explicit, without treating old completion, assignments or generic waits as new execution authority. Record resolution, dependency admission and storage remain future work.

## [0.4.128] - 2026-10-29

### Added

- Additive `extalia.control.v1` identity-map contract with strict TypeScript/Rust validation, generated JSON Schema and shared conformance fixtures. Explicit session/workspace bindings retain the complete source namespace and reject source/canonical collisions.
- Pure scoped forward/reverse identity lookup rejects foreign profiles/workspaces and unmapped IDs, returning detached bindings without inferring aliases. This increment does not migrate existing records, verify source ownership, grant execution authority or activate a new runtime.

## [0.4.127] - 2026-10-29

### Fixed

- Agent-app connections now treat Node availability as a per-app prerequisite. Hermes webhooks and existing-hook diagnostics/undo remain available without GUI Node discovery; command-hook setup refuses missing, invalid or Electron runtime paths and retries failed discovery on a later action.
- Connect agent apps refreshes real event status with lightweight reads while visible and checks installed connections on focus, without repeatedly probing Codex trust. Serialized refreshes preserve previews and unsaved dashboard edits, ignore stale replies around changes, and stop on unmount.
- English and Indonesian connection controls explain that disconnecting hooks leaves separately enabled transcript watching unchanged. Missing-Node setup no longer reports "Already connected" in the CLI, and changing hosts during a pending action no longer leaves the controls locked.
- A valid live hook now clears a stale "Source unavailable" state caused by an unreadable transcript, while preserving user pauses and cached history. Test probes and unrecognized events cannot establish recovery or invent a live session.

## [0.4.126] - 2026-10-29

### Added

- 34 more campus vehicles (45 in total) derived from reference models, including a micro EV, large and rugged electric SUVs, an electric pickup, estates, hot hatches, crossovers, sports and classic cars, mid- and full-size pickups, a stretch limousine and a traffic-only 11 m rigid truck. Parking and traffic rotate 12–14 styles a day (deterministic per local date, weighted so rare cars stay rare; only that day's models load).
- Vehicle licences include CC-BY-NC, CC-BY-NC-SA, Sketchfab Standard and owner-provided files still awaiting confirmation, each credited in `THIRD_PARTY_NOTICES.md`; non-commercial ones are marked "non-commercial use only". Building with `EXTALIA_COMMERCIAL_ASSETS_ONLY=1` keeps non-commercial and unverified cars out of the scene (the files still ship; a commercial distribution must remove them).
- Car pipeline options for texture atlases, ancestor rules, positional role boxes, roof caps, source boxes, rear-only spare detection, staged decimation of heavy sources and parallel exports.

## [0.4.125] - 2026-10-29

### Added

- Campus double-cab pickup (`pickup`) derived from "2019 Ford Ranger Raptor CIVIL (Cities Skylines)" by TSB3DMODELS (CC-BY-4.0, credited in `THIRD_PARTY_NOTICES.md`), about 3,100 triangles and 107 KB. It replaces the procedural double-cab; the old `mobility-double-cabin` name still resolves to it and the single-cab truck stays procedural. The car pipeline gains `colourFrom: "texture"` (material roles from texture samples and position) and accepts single `.glb` sources.

### Changed

- Campus traffic at night: each moving car casts two headlight beams from its own headlamp positions (read from each model's lamp geometry), lying flat on the asphalt and fading within about 13 m. Lit head and tail lamps show soft halos, two small red pools sit just behind the tail lamps and brighten while braking, and the two budgeted real headlight spots sit at headlamp height and aim 12 m ahead so the road and lane markings visibly brighten. Road lights follow Lights Auto/On/Off and skip their draws in daytime.

## [0.4.124] - 2026-10-29

### Added

- Additive control capability manifests distinguish engines, coding workers and providers, with explicit per-mode support claims, runtime/policy/evidence references and experimental opt-in requirements. Strict TypeScript and Rust validators share conformance fixtures and a generated JSON Schema; validation grants no execution authority or integration certification.
- PRD v2 compatibility decisions and a requirement-to-acceptance map preserve existing protocols, runtime IDs, Rust/Python direction and staged release gates.

### Fixed

- Agent-app hooks reject revoked tokens on the next authentication check, and endpoint test probes no longer count as real application activity. Connection indicators ignore events older than the current configuration revision.
- Connection approval is bound to the displayed preview in Web/Desktop and CLI. Config-root or symlink-target changes cannot reuse another file's backup; caught multi-file apply failures roll back safely without overwriting concurrent edits.
- Hermes connection status and undo cover default and named profiles, with backups for edited profile removal. Inline webhook YAML is refused safely instead of creating duplicate keys.
- Explicit hook ports reach both test probes and command forwarders without changing the running host's endpoint. Missing forwarders report stale connections, CLI can read last-event history, and oversized UTF-8 payloads are clipped by byte length.
- Campus headlight integration uses the measured lamp anchors and current shared light settings consistently in rendering and tests.

## [0.4.123] - 2026-10-29

### Added

- Ten campus cars derived from reference models (EV sedan, long EV sedan, EV SUV, EV MPV, sedan, hatchback, off-road jeep, MPV, van and a rare sports car), simplified in Blender to about 6,000 smooth triangles each, with no interior, badges or textures. Each ships as its own licensed GLB (RenderHub Extended Use; the sports car is CC-BY-4.0) with notices. A data-driven catalog (`tooling/blender/campus-vehicles.json`) and `prepare-campus-vehicles.py` make adding a car one catalog entry plus two script runs.
- Vehicle wheels roll with the distance travelled and stop at the crossing. At dusk and night, moving cars light head and tail lamps, brighten their brake lamps while waiting and paint soft light pools on the road; at most two budgeted spot lights follow the cars nearest the camera.
- Asset intake map (`docs/product/asset-intake.md`) for the owner's downloaded hair, clothing, character and furniture models, processed in stages after the cars.

### Changed

- EV charging bays hold electric cars and traffic mixes electric and conventional cars; only the vehicle files actually placed are loaded. The project-generated campus library now covers only the pickups, chargers and cycle shelter.

## [0.4.122] - 2026-10-29

### Added

- Native recovery can inspect canonical mission state and execution evidence together, with a profile-bound review fingerprint and explicit missing task admissions. English and Indonesian panels explain the remaining ownership and settlement limits.

### Fixed

- Recovery prefers one atomic daemon read and never falls back to mixed inspection after that operation fails. Refresh clears the old displayed review; no retry, terminal closure or quarantine release is authorized.

## [0.4.121] - 2026-10-29

### Added

- Native tasks track and seal local provider/tool operations and full tool pipelines. Trusted built-in adapter coverage can record separate durable local-drain evidence after actual settlement, including late settlement, without clearing recovery quarantine.

### Fixed

- Search now waits for worker termination or exit before returning an outcome. Pending sibling/preflight work keeps native capacity quarantined instead of treating an early aggregate failure as completion.

## [0.4.120] - 2026-10-29

### Added

- Native recovery inspection shows durable execution identities and observations of actual turn completion, including late completion after a timeout. Rust records admissions atomically before execution and preserves observations across reaping and restart, without treating them as physical-settlement proof or clearing quarantine.

## [0.4.119] - 2026-10-29

### Added

- The Rust daemon periodically quarantines missions with expired leases even while its input is idle. Bounded, profile-scoped transactions preserve queued and terminal work, fence uncertain siblings without replay, and fail closed if reaping cannot persist. The sweep thread stops with the daemon.

## [0.4.118] - 2026-10-29

### Added

- Rust-owned native missions renew exact task leases independently of model activity. Renewal failure revokes runtime authority, stops active workers and blocks queued work while preserving uncertain execution for recovery.

### Fixed

- Expired native leases cannot be revived by late task completions or activity. Tool permission checks renew and verify current lease authority before accepting policy decisions, including after host suspension.

## [0.4.117] - 2026-10-28

### Fixed

- Folder selection preserves workspace name, runtime and permission edits made while validation is pending. Older folder checks and canceled or closed pickers cannot restore stale editor state.

## [0.4.116] - 2026-10-28

### Added

- Authenticated host-folder browsing for Web workspaces, alongside native folder dialogs on macOS, Windows and Linux Desktop. Folder selection is shared by setup, Chat and Settings; manual paths remain an optional advanced control.

### Changed

- Initial setup can defer workspace creation while retaining a configured managed runtime. Chat offers workspace creation when first needed, and Settings remains available for later setup.
- Provider setup guides users through testing before model selection, rejects stale endpoint results, and offers an explicit manual-model path for providers without model discovery.

## [0.4.115] - 2026-10-28

### Fixed

- macOS Desktop discovers Node.js in common Homebrew, Herd, nvm and Volta installation locations when launched from the Dock. Failed discovery can be retried without restarting, and agent-app commands inherit the selected Node directory.
- Web and Desktop detect host disconnection while idle, display a recovery banner and keep the last Office view visible. Identical heartbeat snapshots do not redraw the Office; Web also offers page reload after a Bridge restart.
- Startup no longer changes Hermes hook configuration automatically. Connecting an agent app previews configuration changes before the user applies them, with Codex trust remaining an explicit choice.
- The setup background resolves its poster from the page instead of the bundled CSS directory. macOS smoke tests retain native WebGL and report renderer and missing-asset errors for release diagnostics.

## [0.4.114] - 2026-10-27

### Fixed

- macOS Desktop smoke tests avoid the Skia Graphite compositor after hosted runners reported GPU device loss, while retaining full scene readiness checks.

## [0.4.113] - 2026-10-27

### Fixed

- The Office adaptive render budget now counts severe foreground frame stalls, so it can lower rendering load when the scene becomes unresponsive. Hidden-tab time is excluded when the view resumes.
- The collapsed Earlier board no longer creates hidden portrait rows until opened; closing preserves its animation and releases those rows. Unchanged or offscreen portrait updates no longer repeatedly reconcile visible 3D portraits.
- Desktop smoke tests isolate external application homes and skip automatic integration setup, preventing test runs from changing real agent configuration.

## [0.4.112] - 2026-10-27

### Fixed

- Automated Desktop smoke tests use explicit software WebGL on Linux/Windows and allow the native macOS GPU, preserving strict scene readiness checks and normal production GPU behavior. Smoke diagnostics now report scene alerts and loading progress.
- CI installs pnpm before Rust jobs initialize Node package-manager caching and checks Desktop rendering on all three operating systems. Release tests handle Windows path separators and directory links.

## [0.4.111] - 2026-10-27

### Added

- Sixteen approved, project-authored Blender scene models with MIT license, provenance and content hashes, shared by Web, Desktop and the npm Bridge. The public bundle includes the building, roof/terrace/elevator parts, furniture, interior architecture, floor, landscaping, nearby buildings and vehicles.
- Existing Blender-retargeted avatars are retained: two unique body files serve the four appearance variants, with ten detailed hairstyles and the existing style fallback. These models retain their separate RenderHub Extended Use License and attribution; their bytes, rigs, outfits and textures are not replaced by a new human model.
- Free macOS preview packaging with valid ad-hoc signatures and an explicit distribution marker. Both architectures' DMG and ZIP app bundles must pass strict integrity checks; previews carry an unidentified-developer notice and use manual updates. Notarized releases remain available as an explicit credential-backed mode.

### Fixed

- Default builds load the same registered Blender avatars and scene models on Web and Desktop. Unregistered local files are excluded before asset discovery; explicit local development can add fallbacks without replacing public models.
- Public asset validation now permits only registered, hash-verified models, requires a complete inventory and license, and rejects unknown, modified, symlinked, external-resource or inlined models. CLI and Desktop packaging validate the copied UI again.
- Ad-hoc macOS previews cannot enter the automatic updater or replace a signed update feed.

## [0.4.110] - 2026-10-27

### Fixed

- Desktop's recovery panel retries agent-host startup after a conflicting Bridge releases the shared profile. Concurrent requests share one startup attempt; shutdown prevents new attempts and closes late hosts without replaying actions.
- macOS release builds now require Developer ID signing and notarization. Both architectures' DMGs and updater ZIP apps must pass identity, signature, Gatekeeper and stapled-ticket checks before their job uploads installers or update metadata. All platform uploads follow packaged smoke tests; unsigned local builds remain available.
- Installation guidance now distinguishes the `extalia-vo` application from internal daemon packages and explains npm resolver failures when local npm installs traverse a pnpm checkout. The v0.4.109 DMG's invalid ad-hoc signature is documented; a trusted replacement requires Apple Developer credentials.

## [0.4.109] - 2026-10-27

### Added

- Read-only Rust mission snapshots and a localized recovery inspection action in Missions. New runs retain explicit backend ownership and recovery provenance; canonical task states and unresolved leases can be inspected without replaying work.

### Fixed

- A host-restart checkpoint can adopt an already-terminal Rust mission only after exact identity checks, terminal task states, no leases and no local activity. Genuine execution uncertainty remains quarantined, missing results remain missing, and failed checkpoint writes leave recovery pending.
- Late mission status polls and responses after unmount cannot overwrite a recovery refresh. Interrupted missions retain manual retry, while active missions continue their normal polling.
- Board rows and character shortcuts locate the avatar again, including its current floor; direct avatar clicks and popup inspection preserve the user's camera.

## [0.4.108] - 2026-10-27

### Added

- Local Blender architecture libraries for glazed partitions, plaster walls, framed glass/wood/automatic sliding doors and detailed stair treads, stringers, landings and rail fittings. Moving leaves and walking contacts retain their app-owned geometry contracts.
- Warm cached light spill beneath every indoor stair tread, six parking luminaires and four short, shadow-free headlights for moving road vehicles.

### Changed

- F1–F3 and All floors use fitted overview framing. Building zoom-out is bounded by the circular ground coverage while preserving its desktop default framing.

### Fixed

- Selecting a character or opening its details preserves manual camera position and zoom; Locate and Follow remain explicit camera actions.
- Parked vehicles keep their lamps off. Light Off preserves natural daylight and daytime fill; night dimming follows the solar phase.
- Full-height glazed door openings no longer overlap a low transom. Right-hand frame fittings mirror with their leaves, sliding tracks support full travel, and nested static batches refresh safely after local models load.

## [0.4.107] - 2026-10-27

### Added

- Blender-authored outdoor planting with flower parterres, fern/agave clusters, blossom trees, cypresses, a reflection pond and a bench pergola. Close grass uses bent Blender blades, while distant tree crowns retain a cheaper shared silhouette.
- Organized conventional parking, three EV charging bays, covered bicycle parking and sparse road traffic. Distinct local Blender vehicles include sedan, SUV, Jeep-style off-road, MPV, hatchback, single-cab truck, double-cab pickup and EV, with complete procedural backups and restrained night lamps.
- Idle outdoor visits to 28 seats, an automated café pickup and a garden-art viewing point. Guests physically arrive before drink preparation, collect their order and walk to a free café seat; real work, removal and reduced motion cancel visits and release reservations.

### Changed

- The twelve nearby district buildings gain physical window mullions, transoms and glazed lobby recesses using four shared role batches. Distant skyline silhouettes and time-driven window lighting remain lightweight.
- Repeated loaded Blender parts now share render instances without changing their world transforms, collision sources or live materials. Unreadable distant screens pause live repainting until zoomed in; compact animated portraits use a lower display cadence while larger portraits keep their existing timing, reducing overview work without replacing their images or characters.

### Fixed

- Outdoor furniture and navigation share one canonical blueprint; clearer picnic/patio spacing, structural collision proxies and lamp positions keep the exterior pedestrian routes and seating approaches open.

## [0.4.106] - 2026-10-27

### Fixed

- Prevent transient white Office frames when adaptive resolution or the window size changes. The current 3D scene is redrawn immediately after the drawing buffer is resized, before the browser can present its cleared contents; character animation and adaptive quality keep their normal timing.

## [0.4.105] - 2026-10-27

### Fixed

- Wired normalized Blender instanced geometries (`bakeExteriorInstancedGeometries` and `useExteriorInstancedGeometries` in `ExteriorPart.tsx`) into the instanced boulevard, side-lawn, corner-grove, and civic park batches (`CampusLandscape.tsx`, `CivicForecourtPark.tsx`, and `CampusSkyline.tsx`) so all foreground boulevard trees, park trees, park benches, and pedestrian lamps upgrade to sculpted Blender meshes as soon as `exterior-landscape.glb` loads, and decoupled `CampusSkyline.tsx` geometry/material disposal effects while keying `<instancedMesh>` instances on geometry UUID and matrix count so async `district-buildings.glb` loading cleanly replaces procedural district building boxes without disposing shared skyline materials.

## [0.4.104] - 2026-10-27

### Changed

- Expanded the Blender exterior asset pipeline (`tooling/blender/create-exterior-assets.py`, `ExteriorPart.tsx`, `CampusExterior.tsx`, `exteriorPart.test.ts`, and `exteriorAssets.test.ts`) to 23 zero-anchored models (`39,204` triangles across `132` material-batched meshes), rebuilding the pedestrian pole luminaires (`exterior-walk-lamp`), louvered pathway bollards (`exterior-bollard-light`), ground-recessed tree uplights (`exterior-tree-uplight`), wayfinding directory monolith (`exterior-wayfinding-pylon`), Campus Cafe kiosk pod (`exterior-cafe-kiosk` with slatted honey-oak apron, honed stone counter, back-bar shelving, twin-group espresso machine, burr grinder, pastry display case, POS terminal, and cups), timber terrace deck (`exterior-cafe-deck`), festoon support masts (`exterior-festoon-mast`), Sheffield loop bicycle station (`exterior-bike-rack` and tintable `exterior-bicycle`), and sculpted stone lantern & terracotta garden vignettes (`exterior-garden-decor`), with solar-driven `Exterior lamp diffuser` emission and full preservation of avatar seating and `outdoor.cafe-counter` interaction clearances.

## [0.4.103] - 2026-10-27

### Changed

- Authored a lightweight Blender outer-shell architectural library for the 12 surrounding district buildings (`tooling/blender/create-district-buildings.py`, `districtBuildingModels.ts`, and `CampusSkyline.tsx`) with colonnaded stone podiums, entrance canopies, chamfered corner piers, twin-core skybridge towers, notched sky-garden terraces, brise-soleil fins, cantilevered residential balconies, and rooftop mechanical penthouses merged into 4 world-space role geometries (`20,420` triangles, 4 draw calls) that preserve the procedural day/night window-grid shader (`FACADE_COLOR` / `FACADE_EMISSIVE`) and > 40 fps render budget, while adding pedestrian crosswalk markings, outer avenue sidewalks, district forecourt aprons, and formal parterre garden beds in `CampusNeighborhood.tsx` and `CivicForecourtPark.tsx`.

## [0.4.102] - 2026-10-27

### Changed

- Authored a Blender exterior landscape and outdoor seating library (`tooling/blender/create-exterior-assets.py`, `ExteriorPart.tsx`, `CampusExterior.tsx`, and `CampusGrass.tsx`) with sculpted multi-branching shade trees, multi-stem ornamental blossom trees, multi-mound shrubs, tiered lavender clumps, honed limestone arrival planters with river pebbles and timber bench edges, cast-alloy park benches, chamfered stone plinth benches, A-frame picnic tables with ribbed square parasols, bistro patio sets, rear garden understory planting, and expanded close-zoom turf tufts while preserving all `OUTDOOR_FACILITIES_BLUEPRINT` seat contact heights, `officeSeat` clearance tags, and procedural fallbacks.

## [0.4.101] - 2026-10-27

### Changed

- Reorganised ceiling light grids across Floors 1, 2, and 3 (`RoomShell.tsx`, `Floor1.tsx`, and `CirculationLighting.tsx`): arranged room ceiling downlights into orthogonal `2×2`, `3×2`, and `4×2` grids so wide labs (`multi-engine`, `fitness`, `mission-control`, `meeting-a`, `meeting-b`, `architecture`, `research`, `entertainment`) have balanced two-row coverage clear of central pendants and linear meeting-table fixtures, excluded duplicate `RoomCeilingDownlights` housings inside executive suites that already mount `ExecutiveSuiteLighting`, pulled `TeamWorkspaceCeilingLights` perimeter wall washers inside the `32 × 19.6 m` Engineering Hall envelope (`x = ±15.25`) oriented parallel to the west/east walls, expanded `LobbyCeilingLights` to a symmetric two-row `8×2` downlight grid framing the central chandelier, centred the Stair Arrival Plaza chandelier between circulation rows, and removed the overlapping south-end stop in F1 `east-circulation`.

## [0.4.100] - 2026-10-27

### Changed

- Reorganised the Floor 1 Open Lounge & Pantry and adjacent East Wing breakout lighting (`LOUNGE_FURNITURE_BLUEPRINT`, `BarPendantCluster`, `DiningLinearPendant`, and `Floor1.tsx`): raised the bar pendant cluster (`drop = 0.45`) and high-top dining linear pendant (`drop = 0.85`) above avatar head height, centred the reading-lounge coffee table directly beneath its pendant light (`[0.05, 0, 0]`) with flanking sofa lamp/plant and full front-apron clearance, removed floating wall sconces from transparent glass partitions and the open reception hall, and anchored lounge corner stand lamps symmetrically (`[±6.35, 0, 8.8]`).

## [0.4.99] - 2026-10-27

### Changed

- Reorganised the Floor 1 QA / Test Lab and adjoining Source Control Lab (`8.2 × 7.6 m`) so storage cabinets and the equipment console sit flush against the west and east partition walls (`x = ±3.76` / `3.82`), wall displays, whiteboards, and artwork mount on the solid south wall instead of the north glass partition, and corner plants/lamps occupy the perimeter corners while preserving workstation seat and IK anchors.

## [0.4.98] - 2026-10-27

### Changed

- Reorganised the Floor 2 Archive room (`9.5 × 8.4 m`) so all display cabinets, bookshelves, and the console table sit flush against the west and east perimeter walls (`x = ±4.44` / `±4.48`), keeping the north glass entrance and central window aisle unobstructed while aligning `OFFICE_OBSTACLES`, archive interaction points, corner plants/lamps, and Knowledge Room west-wall bookcases.

## [0.4.97] - 2026-10-27

### Changed

- Anchored Floor 3 perimeter furnishings flush against their actual room envelopes in the 12.0 × 10.0 m Research Area (four side-wall bookcases, south-wall whiteboard and storage cabinets, and corner plants/floor lamps) as well as the adjoining Knowledge Sanctuary, Flex Work, and Sky Lounge rooms, while preserving workstation seat and aisle coordinates.

## [0.4.96] - 2026-10-27

### Changed

- Reorganised the Floor 1 Entertainment room around a shared spatial blueprint (`ENTERTAINMENT_LAYOUT`), splitting the 12.6 × 7.6 m room into a west TV lounge (wall-mounted screen on the solid north wall, sofa, armchair, coffee table with console controllers, and west minibar) and an east game corner (north-wall arcade cabinets and foosball table) with matching seat/station targets, navigation waypoints, and corner lighting.

## [0.4.95] - 2026-10-24

### Added

- Learning loop, first W6 slice in the Rust core (ADR 0029, proposed; core schema 6): finished native missions become bounded, credential-masked experiences (idempotent per mission). Evidence trust is fixed by kind: Extalia test gates and user confirmations are verified, native reports unverified, observed claims always untrusted. Knowledge and skill candidates stay `insufficient_evidence` without at least two verified successes; only the local user can accept or reject them, citing the proposal digest. Accepted knowledge is written only to Extalia-managed notes through the compare-and-swap path (user notes get conflict copies); accepted skills are only staged into the profile's skill import inbox for the normal quarantine, inspection and approval flow. All learning records are append-only and isolated per profile. Not on the daemon wire or in the UI yet.

### Changed

- The daemon runs knowledge requests on their own thread, in arrival order, so a long vault sync no longer delays mission, permission, health or skill requests on the same connection. Answers are matched by request id; a knowledge request whose deadline passes while it waits is answered `deadline_exceeded`; on stdin EOF, knowledge requests already received finish before the daemon exits.

### Fixed

- The intermittent `index_locked` test failure: spawning the daemon binary briefly copied the test process's lock descriptors into the child. Tests that spawn the binary now run separately from tests that hold store locks in the test process.

## [0.4.94] - 2026-10-24

### Added

- Knowledge editing: edit notes in place (Markdown editor with preview; Ctrl/Cmd+S saves, Esc asks before discarding unsaved changes). Saves are compare-and-swap: if the note changed meanwhile, your version goes to a conflict copy and a panel explains why, compares side by side and reloads the current version. New notes, per-note version history with confirmed rollback, a "Managed by Extalia" chip, and "Import memory notes" with a dry-run preview before confirming. Editing appears only when the native core serves it.
- Choose your own Knowledge vault folder (for example an existing Obsidian vault) in Settings → Knowledge vault. Extalia checks the folder, restarts the native core with it and rebuilds the index. It never deletes or rewrites your notes, edits automatically only notes marked `managed_by: extalia`, and leaves `.obsidian` untouched. A chosen folder that goes missing makes the vault unavailable instead of falling back to another folder.
- Notes edited outside Extalia are indexed automatically while the native core runs (native file watching on macOS and Windows, light polling elsewhere, debounced, with back-off on errors); the Knowledge page refreshes when an outside edit was indexed.
- Daemon operations `knowledge.read`, `knowledge.write` (user compare-and-swap; conflicts become copies), `knowledge.history`, `knowledge.rollback` and `knowledge.importMemory` (idempotent, credential-masked, with a dry run), and `--vault-root` for a validated user-chosen vault folder reported only as `custom:<folder name>`.
- Guide for the Knowledge page and the 3D graph.

### Changed

- Test timeouts are 15 s per test and hook, because host suites spawn the real daemon and Git during a full parallel run.

## [0.4.93] - 2026-10-23

### Added

- Knowledge "Whole vault" 3D graph next to the local graph: notes coloured by folder, kind or tag; the most connected notes are larger and glow, and hubs pulse gently. Hover highlights a note and its neighbours, a click flies to the note and opens it beside the graph (a bottom sheet on phones), and notes can be dragged. Search with `/` and arrow keys, filter by modification time (1D–All), toggle labels and glow, or use the accessible list view. The layout runs in a Web Worker (`d3-force-3d`) and the canvas draws only while something moves; 3 draw calls at any size, 60 fps at 2,000 notes on the development machine.
- The Knowledge page reads the real vault index through the Rust core daemon (`nativeCore: "rust"`): status, sync with the skipped files of the latest sync, notes, links, backlinks, search, local graph and the whole-vault overview. Opening the page refreshes an index older than 5 minutes (incremental, never creating the vault). With the TypeScript core the page stays hidden.
- Daemon `knowledge.overview`: a bounded whole-vault graph (at most 2,000 notes and 8,000 links, profile-scoped) with folder, up to 8 tags, in/out degree and modification time per note; distinct resolved links only. The most connected notes are kept when the vault is larger, within the frame limit.

## [0.4.92] - 2026-10-23

### Fixed

- Standby characters resume from their actual position after closing or handing off a door. Route joins replace stale curve origins/progress, consume dense crossed markers without losing destination contacts, and wait for verified clearance instead of walking through an obstruction.

## [0.4.91] - 2026-10-23

### Fixed

- Hand-operated door interactions now follow each character's current walking speed: clear-apron steps, turns, grip/release timing and opening/closing swing stay coordinated as trip pace changes. Contact steps use measured travel for gait, so stationary swings no longer animate walking feet; swept clearance, handoff and automatic sliding-door timing are preserved.
- The sample Knowledge host implements the graph-overview contract, keeping support detection and bounded graph results consistent with the native host.

## [0.4.90] - 2026-10-23

### Fixed

- Static sofas, armchairs and benches now use clear front approaches, turn before lowering and rise forward before leaving. Seated neighbors remain physical obstacles; shared sofas use independent front lanes with safe yielding, retries and cancellation. Target-cushion contact preserves other furniture collisions, and dining chairs leave space to stand and turn.

## [0.4.89] - 2026-10-23

### Changed

- Skills have their own page in the sidebar (Extalia group, next to Settings), with a badge counting skills waiting for review or approval. With the preview native core it holds the Skill Security Center; with the TypeScript core it lists project skills for every workspace with the same Allow and Revoke. Both modes list the built-in skills read-only (they ship and update with the app), through a new read-only `builtinSkills()` host method. Settings points to the Skills page, each workspace shows a "N project skills waiting — Review" link, and the Chat notice button now says "Review skills".

## [0.4.88] - 2026-10-23

### Added

- Knowledge page (W5) under Work: search the profile's vault, read notes with clickable wikilinks (resolved, ambiguous with a candidate picker, missing shown muted), see front matter as declared and never as verified, outgoing links with status, backlinks, a bounded local graph (depth 1–2, at most 60 notes, loaded on demand) and the sync status with skipped files and reasons. It appears only when the host serves the new optional knowledge methods (validated in `@extalia/platform`); the host implementation follows in the next slice. The mock host has a sample vault. English and Indonesian.
- Knowledge index on the daemon wire (W5): additive contract v1 operations `knowledge.status`, `knowledge.sync` (incremental or rebuild), `knowledge.node`, `knowledge.links`, `knowledge.backlinks`, `knowledge.search` and `knowledge.graph`, with JSON Schema and 52 shared fixtures. Each profile's `knowledge.sqlite` opens lazily with its own lock; an unusable index reports `unavailable` instead of stopping the daemon; the vault root is created on the first sync and never recreated empty. Only vault-relative paths cross the wire, note bodies are capped at 256 KiB and every frame stays under 1 MiB.
- Safe note writes in the Rust knowledge core: compare-and-swap with atomic rename and no-replace create, conflict copies instead of overwrites, symlinks and hard links refused, an append-only revision journal with rollback, and Extalia may only update notes marked `managed_by: extalia`. Workspace memory notes can be imported into `Projects/<workspace>/Memory/` with provenance front matter and the same credential masking as the host; originals stay untouched. Not on the wire yet.

## [0.4.87] - 2026-10-23

### Improved

- Board, character-card and message-dialog portraits now render the same 3D body, face, hair, wardrobe and saved appearance as the Office. Visible duplicates share one portrait scene and a single WebGL renderer, with offscreen/background pause, reduced-motion support and illustration/model fallbacks.
- Office characters and portraits share seeded blinks, gaze, gentle idle yawns and work/wait expressions through one cosmetic clock and live character activity. Canonical local faces gain cached runtime eyelid, mouth and brow shapes; procedural characters use the same expression controls.

## [0.4.86] - 2026-10-23

### Fixed

- Following a character now switches the displayed floor during travel across F1–F3, stairs and elevators while preserving camera framing and zoom. Through-trip elevator cabins and passengers remain visible at intermediate floors. Explicit floor/view selection or dragging returns control to the user and cancels pending camera movement.

## [0.4.85] - 2026-10-23

### Fixed

- Night lighting now covers the east room-side circulation strips on F1–F3, the floor beneath the returning stair flight and the rooftop terrace walking paths. Added physical downlights and shielded terrace posts provide overlapping local coverage; interior overrides, exterior dusk control and coverage on lower render budgets remain consistent.

## [0.4.84] - 2026-10-23

### Fixed

- Floor finishes on F1–F3 now meet the character and furniture ground plane, with their thickness below the walking surface. Flush borders, thinner grounded rugs, lobby inlays, server rack origins and Blender console-table legs correct buried or floating contacts; slab undersides, rounded edges and stair openings remain aligned. An editable Blender floor panel preserves the same datum with a procedural fallback, and the fitness aisle no longer overlaps another finish.
- Smooth walking preserves velocity and unused frame time across short curve samples, removing repeated slowdowns. Personal and per-trip pace variation now gives clearer relaxed, normal and hurried walks, with distance-driven footsteps and safe passing retained.

### Removed

- Ground status and selection rings beneath agents and facility characters. Character picking, hover names and information panels remain available.

## [0.4.83] - 2026-10-23

### Improved

- Office characters use varied, clearance-checked walking curves and safe open-space shortcuts instead of tracing every aisle waypoint. Nearby walkers adjust their lateral position and pace to pass or follow with space; doorway, chair, stair and elevator contacts remain exact. Rendered furniture and partitions supply body clearance, upper-floor support prevents shortcuts across stair voids, and walking animation follows actual travel.

## [0.4.82] - 2026-10-23

### Improved

- Shared interior furniture now uses a 46-part Blender library: cabinets and bookcases, print/copy stations, decorative tables, pantry equipment and swivel stools, server racks, entertainment furniture, fitness equipment, plants, artwork and lamps. Editable local models retain procedural backups; live screens and physical illumination remain active, and pendant cords extend without stretching the shades.
- Pantry guests wait for food/drink service at their stool-aligned counter positions before eating or sipping; the bartender walks between preparation and handoff points. Stool and seated character rotations stay synchronized. Two idle characters can share a local console rally on the TV, with held controllers and cancellation when work resumes.
- Server racks face the inspection aisle with restrained activity LEDs and improved service-room details. Fitness visits include running, cycling, weights, yoga, bench curls and cable rows; moving equipment and avatar contact targets share their motion phases.

## [0.4.81] - 2026-10-23

### Added

- Knowledge foundation, first W5 slice (Rust core, ADR 0024 amended): each profile has a rebuildable index `<data>/profiles/<profile>/knowledge.sqlite`, separate from the core store, built from Markdown in `<data>/vaults/<profile>`. A safe vault walker (no symlinks, hidden folders such as `.obsidian` ignored, size caps, UTF-8 only), strict front matter, an Obsidian-compatible wikilink parser (aliases, headings, block refs, embeds, relative paths, typed `Related:`/`Learned from:` lines, code excluded), deterministic case-insensitive resolution (path, path suffix, title, alias; ambiguous and missing links kept), incremental sync with rename detection, and profile-scoped queries (node, links, backlinks, full-text search, bounded local graph) where a link to another profile's note looks the same as a missing one. Markdown stays authoritative; the index never writes notes. Not yet exposed in the app.
- Per-workspace integration test gate (W4, ADR 0028) in Settings → Workspaces, with a suggestion from the project's files that is never applied automatically. Integration proposals use it when none is given and record where it came from; the Changes panel pre-fills it and links to the setting. Without a gate a proposal stays `gate_missing` and cannot be applied.
- Skill daemon `skill.scanner` reports the installed inspector (pinned, version, policy version, status); the Skill Security Center banner follows it instead of guessing. Skill operations accept the host's workspace ids, so project-skill consent is shown as "Allowed in project X on <date> (input only)". Core store schema 5 rebuilds the affected skill tables, keeping every row, index and append-only rule, with a backup first.
- Guides for the Skill Security Center and mission changes.

### Fixed

- The "Inspection was interrupted" reason now says to inspect again; interrupted inspections are never replayed.

## [0.4.80] - 2026-10-23

### Fixed

- Characters now take visible backward/forward steps while pulling or pushing work chairs. Chair handling no longer cancels its walk animation each frame, and its shortened gait follows actual body travel through the eased chair slide/swivel instead of a fixed timer. Seated scooting, stand-up contacts and chair-side selection are preserved.

## [0.4.79] - 2026-10-23

### Fixed

- Characters entering through inward-opening room doors now close with a short tug from the reachable handle face and move clear inside as the leaf shuts, instead of circling behind it. Already-open door closing duties use the same reachable-face selection. Existing exit and queued handoff behavior is retained, and foot-limited swings settle exactly at their open/closed endpoints.

## [0.4.78] - 2026-10-23

### Added

- Skill Security Center (W3): with the Rust native core enabled, Settings shows the skill registry. Import a skill folder or a project skill into quarantine; see lifecycle states, reasons, declared permissions and hashes; review; approve exactly the shown package hash and permission digest (expires after 10 minutes); activate, deactivate, roll back or revoke. Until a verified scanner is configured, imported skills stay quarantined. Agents receive user and project skills only from active, daemon-verified revisions; when the native core is unavailable only built-in skills are offered. With the TypeScript core, project-skill consent (W0) is unchanged.
- Native core store schema 4 adds append-only skill reviews, review inputs and built-in registrations. The daemon serves `skill.review` (accept → validated, reject → quarantined, bound to the shown tree hash); W0 consent is recorded as review input and never changes a state; built-in skills are re-verified on every daemon start.
- Missions → Changes panel (W4, ADR 0028): per write task, the worktree branch, ahead/dirty status and diff summary; propose an integration with a test gate, see conflict paths and gate logs, apply only after confirming the exact diff digest, remove a worktree only with its reviewed fingerprint, and review orphaned worktrees. Worker edits appear in the mission journal, Office and timeline as bounded activity (paths only, never file contents), admitted by one table shared by the TypeScript and Rust stores. English and Indonesian.
- `AgentHostApi` gains optional, validated skill-registry and worktree methods, forwarded by Desktop and the Bridge; worktree methods are never available to agents.
- Getting-started guides for project skills and the preview Rust native core.

### Fixed

- `skill.list` with the maximum page size of 100 no longer fails with `limit_invalid`.

## [0.4.77] - 2026-10-23

### Improved

- Ordinary and touchdown workstations now use Blender-authored oak tops, slim legs, refined displays, laptops and input devices, plus coordinated books, organizers, shelves, flowers and lamps. Live screen content and seated hand contacts remain aligned; local models have procedural backups and decorative lamps follow interior lighting.
- Dual and triple external monitors now form level panoramic banks with equal screen sizes, matching side angles and narrow, consistent bezel gaps across ordinary, team, executive and reception desks. Mixed laptop/monitor workstations retain their independent arrangement.

## [0.4.76] - 2026-10-23

### Improved

- Four-person team desks now use a Blender-authored structure with larger inward seating bays, slim steel legs and a recessed frame, low rounded glass dividers and compact clamps. Seats and input devices move together to preserve hand reach; monitors and laptop stands sit farther inward with verified input clearance. A matching procedural structure remains available without local models.

## [0.4.75] - 2026-10-23

### Improved

- Blender-authored task and executive office chairs with contoured upholstery, rounded arm pads, gas lifts and five twin-wheel casters. Local chair models replace both static and moving chairs while retaining shared sitting/contact anchors, instanced motion and a procedural backup when assets are unavailable.

## [0.4.74] - 2026-10-23

### Fixed

- Characters pulling a door open step to the latch side, opposite the hinge, after an initial handle tug. Solo passage uses only the opening needed to regrip and close while exiting; queued traffic keeps a full opening and hands it off directly. Swing motion respects foot speed, leaf/jamb clearance and fixed opening intent when another walker arrives late.

## [0.4.73] - 2026-10-23

### Fixed

- Free-roaming characters no longer miss closed doors when rendered portal coordinates differ slightly from authored route thresholds. Door crossings use a small plane tolerance; characters already stranded inside a shut leaf’s clearance area walk back on their approach side before retrying. Regression coverage uses all 28 rendered portals and actual leisure routes, plus mirrored recovery, goal-change and traffic cases.

## [0.4.72] - 2026-10-23

### Added

- Rust core daemon skill operations (W3 slice 2, ADR 0025): contract v1 gains `skill.import`, `skill.list`, `skill.inspect`, `skill.approve`, `skill.activate`, `skill.deactivate`, `skill.rollback`, `skill.revoke` and `skill.read` (additive, advertised only with an open core store), the error codes `denied` and `integrity_failure` and an optional error `reason`, with JSON Schema and shared fixtures checked by Vitest and `cargo test`. Imports read only the profile's `skill-imports` folder and stay quarantined while no scanner is pinned. Only the local user (`user:<id>`) can approve, against the digests shown; approvals expire after 10 minutes by default (at most 24 hours). Reads return verified files of the active revision only. A revision interrupted during inspection returns to quarantine on start. W0 workspace consent is shown as review input and never activates anything. Built-in skills are registered only inside the daemon, content-hashed and exempt from the scanner gate. `skill.review` is defined but not served until its storage migration lands. No UI yet.
- Write-capable native mission workers, first slice of W4 workspace isolation (ADR 0028, proposed): a task marked `access: "write"` edits only inside its own Git worktree under the data folder (pinned base commit, branch `extalia/worker/<id>`), never the project checkout; read-only tasks and default missions are unchanged. A serial integration queue merges a finished worker onto the current target in a throwaway worktree and runs the configured test gate (exit code and a bounded, redacted log as evidence). Conflicts are reported with their paths and never resolved automatically; applying needs the user's approval bound to the diff digest and never forces. Worktrees left by a crash are reported as orphans and never deleted automatically. Non-Git folders, repositories without commits, submodules, Git LFS and custom filter/merge drivers are refused. Host API only (`AgentHostRuntime.worktrees`), no UI yet.
- CI runs the host mission suites against a real daemon build in the Rust job, plus a non-blocking benchmark smoke on Linux.

### Changed

- Event commits no longer slow down as a mission's journal grows: both mission stores keep exact running per-mission totals in the same transaction (core.sqlite migration 0003, missions.sqlite schema 3, backfilled on upgrade). Caps, sequences and errors are unchanged. Commit p95 at 7,000–8,000 events falls from 2.77 ms to 0.15 ms (Rust daemon) and from 3.52 ms to 0.64 ms (TypeScript); see `docs/benchmarks/native-core-2026-10-22-totals.md`.

### Fixed

- Corrected workstation handedness using the avatar’s actual facing direction: the mouse and active hand are anatomically right, full-keyboard number pads face that side, and cups sit opposite. Mouse position within its pad varies independently per seat; deeper single/touchdown desktops leave palm space before the keyboard without extending the arm targets.
- Door closing turns beside the free-edge handle without the former far-apron round trip, preserving mirrored push/pull contact and leaf/jamb clearance.

## [0.4.71] - 2026-10-22

### Added

- Rust core secure skill registry, first W3 slice (ADR 0025): core store schema 2 adds the skill tables (packages, immutable content-addressed revisions, files, permissions, dependencies, conflicts, compatibility, categories, intents, append-only inspections, evaluations and history, approvals bound to hash and permission digest, one activation pointer per profile and package); a schema 1 store is backed up and upgraded in place. `extalia-core::skills` stages packages into a per-profile read-only object store with the canonical tree hash `extalia.skill-tree.v1` (symlinks, hard links, special files, hidden or non-portable names and oversize packages refused), validates `extalia-skill.json` against `SKILL.md`, enforces the lifecycle table, and keeps every package quarantined through a fail-closed `UnavailableInspector` until a verified scanner pin exists. Activation, deactivation, rollback and revocation are audited, with the hash re-verified at seven points. No daemon operations or UI yet.
- Benchmark `tooling/bench/native-core.mjs` (audit PR 10): measures the TypeScript mission journal against the Rust daemon through the real host code paths (commit latency at 1/3/8 missions, throughput, mission creation, cold start, restart recovery, memory, binary size) and records hardware, OS, toolchain, revision and daemon hash. First results and proposed default-on thresholds: `docs/benchmarks/native-core-2026-10-22.md`.

### Fixed

- Restarting the host no longer marks every task of an interrupted native mission as unknown. Only work that may have been in flight (assigned, running, waiting, awaiting approval, verifying) becomes `unknown`; completed, failed and cancelled tasks keep their results, and queued or blocked tasks stay as they were. The mission is still `recovering` and nothing is replayed (ADR 0013 amended, matching the Rust store). The Missions page shows a task left queued in a recovering mission as "Not started".

## [0.4.70] - 2026-10-22

### Added

- Rust core daemon client (audit PR 8, flag off by default): with `nativeCore: "rust"` (`config/extalia.json`, or `EXTALIA_NATIVE_CORE=rust`) new saved native missions route to the `extalia-daemon` sidecar, started lazily and stopped with the host. Missions are created with `mission.create`, runtime events are acknowledged through `task.transition`/`event.commit`, and worker tool calls are decided by `permission.check`. When the daemon is missing, crashes, times out or answers malformed frames, tool calls are denied (`policy_unavailable`, reads included), running missions become `recovering`, new missions are refused, and nothing falls back to the TypeScript policy (ADR 0026). A second process holding the daemon lock is reported clearly and never retried. History-off and existing missions stay on the TypeScript path; `getState()` reports the daemon status when the flag is on. `pnpm check` builds the debug daemon so the host mission suites also run against it.
- Self-contained installers: Extalia Desktop bundles the `extalia-daemon` binary for each OS and architecture (`<resources>/daemon/`, about 2.5 MB, signed with the app on macOS); release CI builds it for macOS arm64/x64, Windows x64 and Linux x64/arm64 (glibc 2.35+). A "clean machine" gate in CI and releases runs the packaged app and an `npm install -g` of the CLI with no Rust, Python, Node or npm on `PATH`. The CLI's per-platform daemon packages (`@extalia/daemon-<platform>-<arch>`) are generated and packed by the release workflow but not published until the npm scope is reserved.
- Shared task and mission transition tables in `@extalia/protocol` (`TASK_TRANSITIONS`, `MISSION_TRANSITIONS`), generated to `packages/protocol/schemas/transitions.json` and covered by the drift check. The Rust daemon loads its rules from that file at compile time; runtime mission tests fail if an emitted state change is missing from the tables.

## [0.4.69] - 2026-10-22

### Added

- Settings → Workspaces shows each workspace's project skills (`.extalia/skills/*/SKILL.md`). Skills waiting for review list their description, source, reason ("New in this project" / "Changed since you allowed it") and short SHA-256, with Allow and Allow all; allowed skills can be revoked one by one or all at once, and skipped files are listed. Allowing sends the exact hash shown, so a skill edited in the meantime is refused and the list refreshes. Chat shows a small notice with a link while the active workspace has skills waiting. English and Indonesian.
- Rust core slice A, one durable task (audit PR 6): `extalia-daemon` serves `mission.create`, `task.transition` and `event.commit` from `state/core.sqlite` for one profile (`--profile`, default `default`). Each operation commits in one transaction or writes nothing; per-mission sequences start at 1; an identical duplicate event id returns the original acknowledgement and conflicting reuse is refused; ADR 0014 caps apply (4 KiB per event, 8,192 events and 8 MiB per mission, 64 tasks); only native control metadata with checked task, assignee and workspace ownership is accepted. Running work holds a lease; on restart in-flight tasks become `unknown` and their missions `recovering`, never replayed (ADR 0013). An exclusive lock admits one daemon per data directory; a second exits with status 4 before reading any frame.
- Rust `permission.check` (audit PR 7, ADR 0026): a pure port of the runtime's `decide()`; a 2,560-case matrix generated from TypeScript (`node tooling/generate-permission-matrix.mjs`) must give identical decisions in Vitest, the Rust function and the daemon. A type-level test fails typecheck if the protocol's permission enums drift from the runtime's. The host does not call the daemon yet.

## [0.4.68] - 2026-10-22

### Fixed

- Workstation layouts leave more space between avatars, keyboards and displays across PC, laptop, pod, executive and reception desks. Mice stay on the sitter’s right with stable per-seat position and angle variation; hand targets follow the physical devices. Executive inputs rest on the leather blotter, laptop companions use a raised stand, and reception has supported keyboard/mouse hardware.

## [0.4.67] - 2026-10-22

### Fixed

- Workstation sit/stand choreography now follows the same signed chair swivel, pivot and slide as the rendered chair. Each maneuver varies its opening side, keeps hand contacts attached, walks around that side to the open front and releases the armrests before stepping away. Scripted chair movement stays synchronized with the avatar instead of adding a second damping lag.

## [0.4.66] - 2026-10-22

### Fixed

- Office hinged doors open a full quarter turn into rooms, with mirrored hinges where needed. Characters follow the handle while pushing or pulling, walk around the free edge, turn back to close, and wait outside the leaf sweep for other users. Open-door route handoffs and scene cleanup preserve clearance and release reservations.

## [0.4.65] - 2026-10-22

### Fixed

- Detailed formal shirts: isolated sleeves follow the upper arm and forearm instead of pulling cloth from the waist when typing, using the mouse or lifting a hand. Shoulder and cuff contacts blend smoothly; sleeveless vest panels follow the torso rather than the moving arm. Source geometry, hand poses and shoes are preserved.

## [0.4.64] - 2026-10-21

### Fixed

- Antigravity observed sessions: resolve transcript path mapping from hooks (`transcript_full.jsonl` → compact `transcript.jsonl`) so the session links properly to history rather than remaining an empty-path hook-only stub.
- Antigravity image attachments: read prompt user media (`USER_INPUT` `media: [{ mime_type, uri }]`) via bounded base64 reader in `nativeImport`, populating image attachments/thumbnails and user messages directly in Extalia's Messages tab.

## [0.4.63] - 2026-10-21

### Fixed

- Antigravity hooks: the forwarder (`forward.mjs`, now v2) no longer prints `{}` for `PreToolUse`. Antigravity requires a `decision` there and treated `{}` as a deny, blocking every tool call with an empty reason. `PreToolUse` now gets no output, so Antigravity's own permission flow applies; other Antigravity events still receive `{}`.

## [0.4.62] - 2026-10-21

### Changed

- Connect agent apps (`ConnectAgentAppsCard`): clicking **Connect** now applies the local hook configuration, installs/updates `forward.mjs`, enables transcript auto-watch and verifies the local hook endpoint in one click.
- `ConnectService`: automatically upgrades an outdated `EXTALIA_HOME/hooks/forward.mjs` when inspecting connections and detects `~/.gemini/tasks` / `~/.gemini` for Antigravity / Gemini Desktop hook integration.

## [0.4.61] - 2026-10-21

### Fixed

- Detailed avatar feet: fit the formal outfit's exposed ankle/instep and excessive trouser cuffs to the existing shoes, preserving shoe geometry. Measure the active wardrobe's sole for floor contact and keep shoes level during seated transitions without moving the seated hip or desk contacts.

## [0.4.60] - 2026-10-21

### Added

- Zero-config Hermes hook integration: auto-detect Hermes on Desktop and Web Bridge startup and connect outbound webhook (`post_llm_call`) automatically without manual configuration.
- Task-based spatial dispatch to Library / Skills workstation (Floor 1): agents executing `skill_manage` or skill curation tools automatically navigate to the Library desk (`library.laptop` or sofa), sit down with reading animation, and return to their home workstation once the task completes.
- Dual-mode in-scene prompt dock previews (Managed & Observed) and frameless Retina campus architecture screenshots in README.

### Fixed

- Observed session reply reconciliation (`packages/host/src/observations.ts`): dropped restrictive `event.at < hook.since` timestamp boundary so final assistant replies from SQLite history are seamlessly merged and streamed into the Messages tab without hanging on "Thinking...".
- Aligned project versions to Semantic Versioning and milestone hierarchy: Minor versions track project milestones (0.1.0, 0.2.0, 0.3.0, 0.4.0), and patches reflect incremental iterations.

## [0.4.59] - 2026-10-21

### Added

- First Rust code: a Cargo workspace with `extalia-core` and `extalia-daemon`, toolchain pinned to 1.99.1 (rustfmt, clippy, edition 2024). `pnpm check` and CI on macOS, Windows and Linux run `tooling/check-rust.mjs` (fmt, clippy with warnings as errors, tests against the committed `Cargo.lock`). Contributors need rustup; people who install Extalia do not.
- `extalia-daemon` sidecar handshake (ADR 0020): length-prefixed JSON frames on stdio per daemon wire contract v1 with `hello` and `health`; other operations get `handshake_required` before `hello` and `unknown_op` after it. Clean exit on stdin EOF, logs on stderr only. Rust tests read the shared protocol fixtures for parity with TypeScript. Release binary about 2.4 MiB; `hello` round trip about 3 ms (p50) on the development machine.
- `extalia-core` SQLite store (ADR 0019): a daemon-owned `state/core.sqlite`, used only with `--data-dir` and not read by TypeScript yet. Schema 1 holds missions, tasks, events, leases and approvals, each scoped to a profile; migrations tracked by `user_version` with an exact-schema check, fail closed on newer or tampered files, a private backup before each upgrade, one transaction per migration, WAL with full sync and foreign keys, private file permissions.

### Changed

- `pnpm version:patch` and the version check also cover the crate versions and their `Cargo.lock` entries.

## [0.4.58] - 2026-10-21

### Changed

- `@extalia/protocol` generates JSON Schema (draft 2020-12) for the Mission, Task, AgentEvent, Approval and Permission contracts from the same rules its validators use, into `packages/protocol/schemas/`, with golden valid and invalid fixtures. Tests require validator and schema to agree on every fixture; the few checks JSON Schema cannot express are listed in each file. `pnpm lint` fails when the committed schemas drift.
- Daemon wire contract v1 in `@extalia/protocol` (ADR 0020): strictly validated `hello`, `mission.create`, `task.transition`, `event.commit`, `permission.check` and `health` frames with request ids, stable error codes, fail-closed schema versions and length-prefixed framing with a 1 MiB limit. Nothing calls the daemon yet.
- Native missions accept an opt-in asynchronous event acknowledgement (`commitEventAsync`, `commitDeadlineMs`; ADR 0014 amendment). One commit is in flight per mission in emission order; provider calls, read tools and task transitions wait for every earlier acknowledgement, and a rejected, late, malformed or non-monotonic acknowledgement stops the mission like the synchronous path. The synchronous path is unchanged and remains the default.

### Documentation

- ADRs 0024–0027 (proposed): profiles, ACL and vault roots; skill manifest and immutable revisions; one permission enforcement point; evidence and provenance model. ADR 0022 revised: installers are self-contained, so the Python worker is bundled (built with `uv` in CI) and the CLI brings the Rust daemon through per-platform npm packages; users never install Rust, Python or Node themselves.

## [0.4.57] - 2026-10-21

### Security

- Skills that come with a project (`.extalia/skills`, for example in a cloned repository) are no longer given to the agent automatically. Each one waits until you allow it for that workspace, and the consent covers that exact file: when the skill is edited or a new one appears, it waits for you again. Built-in skills are unchanged.
- Your own skills and allowed project skills are shown to the agent as untrusted guidance that cannot grant permissions or override Extalia's safety instructions.

### Changed

- New host methods `workspaceSkills`, `allowWorkspaceSkills` and `revokeWorkspaceSkills` (Desktop and CLI Bridge) list a workspace's waiting project skills and allow or withdraw them. There is no screen for them yet.

### Documentation

- Phase 0 repository audit for PRD patch v1.1.1 (`docs/implementation/REPO_AUDIT.md`) with a staged plan up to the first Rust slice, and accepted ADRs 0019–0023: a separate Rust-owned core database (rusqlite), a stdio sidecar daemon, the strangler integration behind the host API, a `uv`-managed Python worker on consent, and a fail-closed skill scanner adapter whose pin is still unverified.

## [0.4.56] - 2026-10-21

### Documentation

- PRD patch v1.1.1 (technical implementation blueprint and coding-agent handoff) added under `docs/product/master-prd-v1.1/`. It makes Rust the control-plane authority behind contracts, keeps Python an on-demand worker and requires a read-only repository audit first. Gap map §5 adapts the blueprint to the existing protocol package, host-owned SQLite, Bridge transport and TypeScript kernel, and maps its phases onto the upgrade waves.

## [0.4.55] - 2026-10-21

### Fixed

- Seated desk avatars use wider typing contacts, stable mouse contacts and an elbow plane that keeps arms relaxed below the shoulders. Palm orientation follows the posed torso, wrist roll is shared with the forearm, and activity transitions orient hands for typing, thinking, phones and cups.
- Local detailed avatars retain their intended body proportions. Conservative clothing-weight corrections keep forearms and calves straight below the joints; relaxed-hand morphs soften the terminal source hands without changing local model files.

## [0.4.54] - 2026-10-21

### Documentation

- Master PRD v1.1 (secure skills, knowledge vaults and learning: FR-15–FR-24, AC-16–AC-30) added under `docs/product/master-prd-v1.1/`, with private workspace, persona and location names replaced by neutral examples. `docs/product/prd-v1.1-gap-map.md` rates every v1.0 and v1.1 requirement against the code and merges the open work into upgrade waves W0–W8, starting with containing unscanned repository skills.

## [0.4.53] - 2026-10-21

### Changed

- Message details show consecutive tool calls as one compact block, like a chat app's "Ran 6 commands": a summary line ("Ran 3 commands and read 2 files", with failures counted) folds a single card that has one row per call; a row opens its output and changed files. The block grows while the agent keeps calling tools and a new one starts after its next message; it stays open while a call in it runs. Consecutive subagents share one card too.

## [0.4.52] - 2026-10-21

### Changed

- Observe mode: a subagent's message details show its own conversation (the task it was given, its tools and replies) instead of repeating the lead agent's; the lead keeps its own conversation with its subagents as cards.

### Added

- Files attached to prompts in observed sessions are shown in the message details: images as small thumbnails that open full size, other files as a list with their size. The transcript readers recognise attachments in Codex, Claude Code, Gemini CLI and Hermes histories; embedded images (PNG, JPEG, WebP, GIF up to 5 MB) are kept as private copies in the data directory (`observed-files/<session>/`, removed with the observation), and events carry only each file's name, kind, size and a content reference. New host call `attachmentPreview(sessionId, ref)`.

## [0.4.51] - 2026-10-20

### Added

- Local detailed characters: a casual women's outfit (rolled-sleeve shirt, jeans, sneakers) worn by the casual, technical and creative styles; glasses, earrings, an ID badge, headphones and a wristwatch modelled for the new heads and bodies, shown when the look wears them (the watch only with bare forearms); and seven more realistic hair styles built from the hair-pack cards: short fade, side part and undercut for men, bob, medium, low bun and low ponytail for women.

### Fixed

- Scanned outfits on the local characters follow the arms properly: weights now come from the scans themselves, so the blouse and shirt no longer stretch from the armpit to the hip when typing. The blouse's jagged shoulders and back seam, the waistcoat's dark side patches and ragged armholes, and skin specks at collars and cuffs are cleaned up; the hair styles are pushed clear of the new heads so no skin shows above the ears.

## [0.4.50] - 2026-10-20

### Fixed

- Building view trims floor slabs, room finishes, borders and ceiling reveals to the rounded exterior glazing footprint, preventing square corners from piercing the facade. F3 indoor surfaces follow the setback while the terrace retains its full deck; stair openings and standalone floor views remain intact.

## [0.4.49] - 2026-10-20

### Fixed

- Campus view hides room perimeter walls, window frames, sills and skirting where they meet the exterior skin, including the F3 terrace setback. Interior partitions and app-owned doors remain; standalone floor and all-floor cutaway views restore their room walls. Perimeter surfaces have separate batches so switching views leaves no stale merged geometry.

## [0.4.48] - 2026-10-20

### Fixed

- The F3 terrace's old procedural guard no longer remains as merged floor geometry after the Blender balustrade loads. Its isolated fallback batch is removed with the guard, including glass, rails and accent strips.

## [0.4.47] - 2026-10-20

### Changed

- Local Blender building assets now include the reviewed continuous west ribbons, side-door surround, open front-left glazing, rooftop sign supports and entrance reveals. Facade, shaft and guard glass share the authored neutral tint with separate opacity; only facade windows receive the interior night glow. The original neon lettering remains app-owned and aligns to the model's rooftop plinth.

### Fixed

- Loading the Blender maintenance stair now replaces only its static structure. Two traffic-driven gates and five solar-controlled fixtures remain in the app, align to the model's landings and unregister on other floor views. Switching stair layouts also refreshes their baked illumination.
- Building export uses an isolated copy of the authoring scene, excludes preview lights/cameras/actions, resets the eight shared-mesh fan rotor nodes for runtime motion and stages all five parts before publishing them. Local GLBs remain optional and ignored by Git.

## [0.4.46] - 2026-10-20

### Changed

- Local detailed characters use new bodies made in Blender from Character Creator base bodies (male slimmed to an office build, both 1.85 m on the same 20-joint skeleton): realistic skin tinted by the chosen skin tone, detailed eyes and lashes, and for men optional scanned beard, moustache and stubble with fuller brows. They wear scanned outfits retargeted onto them, a shirt, waistcoat, tie, belt, trousers and shoes for men and a bow blouse, trousers and heels for women, whose parts take the wardrobe palette. Hair now uses only the realistic hair-card styles from the hair packs (textured crop and slicked back for men, high ponytail for women), refitted to the new heads with their scalp layer; other styles wear the group's local style and the appearance editor offers only the local ones. The previous bodies and hair stay in the git-ignored `apps/web/local-assets/avatars-previous/`.

## [0.4.45] - 2026-10-19

### Added

- The F3 terrace's glass balustrade, base shoes and top rails can come from Blender (`terrace.glb`, exported by `tooling/blender/export-building-shell.py`, local-only): the rounded guard runs round the deck and opens onto the maintenance stair's landing. Once it is on screen the three.js terrace rails step aside; without it they stay as the backup. Balustrade glass does not take the window glow at night.

### Fixed

- The two west planters on the F3 terrace no longer stand at the foot of the maintenance stair; they now sit between the Blender stair's landing and the backup stair's gate.

## [0.4.44] - 2026-10-19

### Changed

- The exterior skin model now carries the latest Blender front: one continuous mitred ribbon set of uniform 1.42 m width with 3.2/4.6 diagonals, whose zigzag over the atrium runs shelf, diagonal, shelf, diagonal from the two aligned vertical caps; the upper diagonal now sits over the same span as the lower one, mirroring it. The west-side fold, lower band and corner fixes from 0.0.63 are kept.

## [0.4.43] - 2026-10-19

### Changed

- The Blender exterior skin (`extalia-shell.glb`, local-only) follows the mockup more closely. Front: the diagonal ribbons are full band thickness, the warm accent lines run along the lower edge of each band (the window heads) instead of splitting bands in the middle, the ground floor is full-height glass (no ground-level band, no west ground diagonal), and the atrium fold is wider, turning on a new panel between its two diagonals. West: the corner column stops at the lower band, which now runs straight round the corner to the side door; a new diagonal comes down from the top band over the tall corner glass and folds into a glazed U above the old left diagonal, and the right diagonal sits 8 m further back. A misplaced corner glass object that left a hole in the upper front-west corner is back in place.

## [0.4.42] - 2026-10-19

### Added

- The rooftop plant (air handlers, water tanks, louvered screens, service walkways), the maintenance stair to the roof with its landings, and the glass lifts' static frames, rails, glazing and bridges can also come from Blender (`roof-utilities.glb`, `roof-stair.glb`, `elevators.glb`, exported by `tooling/blender/export-building-shell.py`, local-only). The model's eight AC fan rotors are spun by the app's independent motors; lift cabs, doors and lights stay in the app, and in single-floor views the app keeps its per-floor lift landings. Each part falls back to its three.js version when its file is absent or fails; `?building=threejs` forces every backup.

## [0.4.41] - 2026-10-19

### Added

- The campus building can use the exterior skin modelled in Blender: `tooling/blender/export-building-shell.py` exports the scene's "ExtaliaShell" collection (and the canopy sign backing) to the local-only `apps/web/local-assets/building/extalia-shell.glb`, already in world coordinates. When present, the app loads it with live glass and accent materials (night glow follows the sky and the interior lights) and hangs the entrance lettering on the model's canopy sign; when absent or failing to load — or with `?building=threejs` — the three.js shell renders as the backup.

## [0.4.40] - 2026-10-19

### Changed

- Rooftop AC fans run on their own thermostats: each of the eight motors runs 9–45 s at its own speed (±15% per run), stops, coasts down on its inertia, rests 6–24 s and starts again, from its own random stream — so motors stop and restart independently instead of turning in lockstep forever. Reduced motion keeps them still.

## [0.4.39] - 2026-10-19

### Fixed

- Office prompt dock: folding open and shut no longer glitches; the rows above and below the field fold as CSS grid rows (both ways) instead of being measured and hidden in one frame.

## [0.4.38] - 2026-10-19

### Changed

- Office prompt dock: the compact dock folds open and shut smoothly in both directions — the rows above and below the field (workspace, target, team, model, hint) grow from zero height as CSS grid rows while fading, so the dock grows upward from its pinned bottom with no jump; folded rows are inert. Reduced motion keeps the instant change.

## [0.4.37] - 2026-10-19

### Changed

- Campus building skin follows the reference's silver diagonal ribbon frames, long recessed window slots and broad glazed corner. Window openings are part of the panel geometry; the old floating diagonal strips are removed. Diamond cladding, slim mullions, aligned entrance canopy and warm accent edges complete the exterior while retaining the three existing floors and circulation openings.

### Fixed

- Mixed indexed sweep and extruded facade geometry is normalized before batching. Solar-driven cladding materials remain live after static batching, including day-to-night changes.

## [0.4.36] - 2026-10-19

### Changed

- Building exterior: the facade bands are continuous swept solids that wrap the corners on a 1.2 m radius (no seams or loose panels), with continuous glazing, caps and accent lines; openings (lift portals, emergency exit, terrace door) are cut out of the band. The stepped front ribbons are single mitred solids, the roof parapet wraps the roof, and the cladding is light anodised aluminium with a metre-scaled diamond pattern that runs on around corners.
- The large `/>` emblem over the entrance is removed; the entrance keeps the logo-and-name lockup on the canopy.

## [0.4.35] - 2026-10-19

### Added

- Detailed hair-card hair for local avatars: textured crop and slicked back (male), high ponytail and bun (female; bun is a real style again). `tooling/convert-detailed-hair.py` (Blender) fits a licensed hair pack to the canonical head and skeleton with a tintable strand texture; `tooling/register-detailed-hair.mjs` records it and the hair check validates it. Outputs stay local-only.

### Changed

- Hair is kept per gender: the appearance editor offers only the character's own group (male or female styles), and generated looks wear the detailed styles of their group.
- Looks on the business-woman body (a face shell without a skull) wear detailed hair on the whole-head female body.

### Fixed

- Hair cards render as cut-outs instead of blended layers, which vanished from some angles (a bun looked bald) or looked hazy.

## [0.4.34] - 2026-10-18

### Changed

- Keyboards and mice have real sizes: compact (31 × 12.5 cm) and full boards with a number pad (44 × 13.5 cm) at 19 mm key pitch, a 6.4 × 11.6 cm mouse on a 22 × 19 cm pad. The mouse sits 2–5 cm beside the keyboard.
- Every desk is arranged differently and stably per seat (`deskLayout`): keyboard size, offset and angle, left- or right-handed mouse, and its own desktop furniture — mini drawer cabinet for documents, stacked letter trays, file holder with folders, books between bookends, plant, photo, notebook, headphone stand, pen cup, sticky notes. Avatars' hand targets read the same arrangement, so hands land on each desk's own keyboard and mouse.
- Laptops with an external keyboard stand on a laptop stand behind the keyboard and mouse (single desks and pods).
- The Office camera zooms toward the cursor and goes about four times closer (a character can fill the view).

### Fixed

- Typing hands reach the keyboard on every desk kind: single-desk keyboards sit 2.5 cm nearer the sitter and wrists rest at the keyboard's front edge.

## [0.4.33] - 2026-10-18

### Fixed

- The procedural fallback character now has the detailed models' proportions: a head about an eighth of the height (it was about a fifth), legs a little over half of it, thicker limbs, a shorter neck and the same ~1.67 m stature.
- Hair and clothing of seated detailed avatars no longer vanish in close-ups: skinned-mesh culling bounds now cover the seated pose, not only the standing bind pose.

### Changed

- Avatar level of detail uses the same model at every distance (no swap, no change of shape): figures small on screen pose every second or third frame, and tiny ones stop casting shadows.

## [0.4.32] - 2026-10-18

### Fixed

- Avatar spawn no longer briefly displays the procedural body before a local detailed model is ready. Selected body and hair requests start together and reuse their per-URL caches; unavailable or failed source models retain the procedural fallback.

## [0.4.31] - 2026-10-18

### Fixed

- Workstation monitors now use smaller 16:9 panels, shorter stands and feet anchored to actual tabletop heights. Single, pod, executive, touchdown and reception desks share the placement contract; multi-monitor spacing follows the reduced widths.
- Laptops now have a 36 × 25 cm chassis and a hinged, proportionate display. Their decks rest on the desk instead of floating; screen content, independent animation state and existing keyboard/mouse hand targets are retained.

## [0.4.30] - 2026-10-18

### Fixed

- Furniture/avatar fit: slimmer workstation chairs and lower arm pads, shared 46 cm office/meeting/guest cushions, 43 cm sofas and 45 cm armchairs. Chairs move under their sitters while workstation avatar roots and keyboard reach stay fixed; the custom executive sofa matches its semantic height.
- Seated avatars use the actual cushion height and front edge. Thigh support limits also apply to relaxed clip offsets; source leg poses use measured rest-bone lengths and keep shoes from sinking through the floor. The procedural fallback no longer assumes every seat is 45 cm high.
- Chair stand-up and scoot hand targets follow the resized arm pads and seat edge.

## [0.4.29] - 2026-10-18

### Fixed

- Desk animations: typing hands face the keys with palms down and the backs of the hands up. Source-model wrist pronation uses the rig's actual rest basis; source limb tilts and the posed chest frame now match the IK targets, with mouse wrists above the device. Seated roots use chair-local offsets consistently with keyboard targets.
- Observed sessions first reported by hooks keep the same character when their transcript is later selected manually, including after host restart and session resume.
- Native mission persistence: caller option mutation cannot remove an active commit boundary, and read-tool prechecks run only after the tool-start acknowledgement. Transient journal retention also clears its event-ID index and rejects cross-mission duplicate IDs.

## [0.4.28] - 2026-10-18

### Fixed

- Seated characters (model avatars) no longer fold their arms across the chest: each arm now reaches the hand target on its own side (the arms were paired by bone name, and the bundled rig names its +X arm "right").
- Hands reach the keyboard and mouse with bent elbows instead of stretching into the air: single-desk chairs sit 13 cm closer, pod sitters sit forward on the seat, the CEO chair moved from 1.4 m to under 1 m from the desk, and wrists trail the fingertips on the keys.

## [0.4.27] - 2026-10-18

### Added

- Native missions: budgets (duration, mission/task tokens, concurrency) enforced by the scheduler with honest usage (unreported usage is "unknown", never zero); atomic mission control events with an execution acknowledgement before every provider/tool call (ADR 0014, ADR 0015). The OpenAI-compatible adapter now requests token usage when streaming.
- Mission workers appear in the 3D Office as subagents under their lead with mission badge, task title, provider/model and truthful states (queued, working, ready, error, unknown) (ADR 0016).
- Workspace default team: saved on the host and inherited by every new session in the workspace (dock, Chat, Missions, continued sessions); every turn carries the team (Native system prompt, Hermes brief).
- Approval inbox: one place (shield button in the top bar, Alt+A) for every pending approval with who/what/risk and Allow once / Allow for this session / Deny; desktop notifications (web after opting in); inline answers on the board and avatar card.
- Context usage per agent (managed, Claude Code, Codex): "Context 62% · 124k / 200k" on the board, avatar card, session dialog and composer ring.
- Chat composer in the style of Claude Code desktop, shared by the Chat page and the session dialog: up to 10 attachments (pick, drop, paste; images to vision models, text inlined, Hermes gets file paths), model and effort pickers, permission mode (workspace default, ask, accept edits, plan/read-only) enforced by the host, and a context ring.
- ADR 0018 (proposed): observed approval bridge — Claude Code and Codex hooks can return allow/deny; Hermes needs an in-process plugin; Gemini/Antigravity unverified.

### Changed

- Agents & sessions: newest activity on top (leads and their subagents), with animated reordering; animated expand/collapse; tree lines behind portraits, colored by status and flowing for active subagents, with rounded joints.
- Observed agents always show their latest reported model; a continued Claude Code chat (new session file copying the earlier one) keeps the same character instead of adding a new one.
- Seated characters reach the keyboard and mouse with arm IK (single desks seat closer), sip from a mug or look at a phone while idle at the desk; chairs move only when a character pulls or pushes them; hinged doors are opened by hand and closed by the last person through (left open when someone follows).

### Fixed

- Several tests that were flaky under parallel load.

## [0.4.26] - 2026-10-17

### Added

- Saved native mission checkpoints now use host-owned SQLite WAL transactions, committing each checkpoint with its revision/change record. Validated legacy sidecars import once and remain preserved; removal tombstones prevent stale history from returning.

### Fixed

- Interrupted checkpoints are committed as recovering/unknown before startup exposes them, without replay. Missing session metadata cannot hide unresolved connection quarantine; corrupt/newer databases and failed transactions fail closed. History-off missions remain in memory.

### Changed

- Bridge/CLI now require Node.js 22.13+ (Node 23 requires 23.4+) for built-in SQLite. Session JSONL events remain separate; full transactional task/tool recovery and budgets are still pending.

## [0.4.25] - 2026-10-17

### Fixed

- Native mission planning now reserves its session and lead connection before provider preparation, preventing overlapping plans, prompts and missions. Cancellation and the lead-call deadline retain busy capacity until an abort-ignoring provider actually settles, and late replies cannot replace the fallback plan.
- Mission history retains validated task dependencies so reopened runs keep their graph. Older records without edges remain explicitly unavailable; resizing the graph from desktop to phone no longer leaves a wide connector overlay.

## [0.4.24] - 2026-10-17

### Changed

- Characters walk at a natural, brisker pace (about 1.4–1.7 m/s) with a personal pace per character and small per-trip variation; they stroll during leisure and hurry back when real work arrives; corners no longer slow them to a crawl, and stride/cadence scale with speed so feet don't slide.
- Subagents arrive like people: they appear at their floor's elevator/stair arrival point (or the F1 entrance) and walk to their desk, admitted at most about three per second. When their work ends they stay in the office as Ready for 7–20 minutes (idle routine), then walk to the nearest exit and fade out, never back into their lead.

## [0.4.23] - 2026-10-17

### Added

- Missions (PRD v1 Stage 2): a Missions page where a managed Extalia Native session's lead plans a read-only mission (`planNativeMission`: one lead call, strict parse, only workspace-allowed connection/model pairs, at least two providers when two are allowed, deterministic fallback plan) and the user reviews it as a task graph, edits tasks, models and dependencies, launches it, and monitors task states per worker/provider/model; answers are shown as unverified model answers and progress as "N of M tasks completed". Planning never starts anything; missions stay read-only (ADR 0010, ADR 0011).
- Observed agents that go silent in an active state show "No response · since HH:MM" (3 min thinking/planning/compacting, 10 min while a tool runs, 15 min for commands/tests; never while waiting for you); after 30 min they leave. Stop reasons from transcripts and hooks (out of tokens or quota, rate limit, overloaded, auth, context, interrupted) are shown, with "Out of tokens or quota" for exhausted sessions.

### Changed

- Agents & sessions lists only agents present now; earlier observed leads and offline subagents move to a collapsed "Earlier (N)" section (remembered per device, searchable), are not drawn in the 3D office and are not counted. "No response" counts under Errors.

## [0.4.22] - 2026-10-17

### Added

- Google Antigravity (`antigravity`) support in Connect agent apps (`extalia connect antigravity` / `disconnect`), live hook ingestion (`~/.gemini/config/hooks.json` via `/api/hooks/antigravity`) and native transcript discovery/import/observation (`~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/transcript.jsonl`).
- Adaptive light/dark brand logos (`AgentAppLogo` and `OriginMark`) for Codex, Claude Code, Gemini CLI, Antigravity and Hermes across Settings → Connect agent apps, Observe auto-watch locations, the Setup Wizard and the 3D Office board.

### Fixed

- Night spotlight irradiance across F1, F2 and F3: F3 stairwell ceiling downlights (`stair-void-ceiling-f3`) now reach the F2→F3 staircase below (`floorY: 6.4`), F1 under-stair bar soffit downlights stay inside the east building boundary so they are not masked as exterior lights, `BarPendantCluster` mounts beneath the stair mid-landing soffit, and stair flight/landing rails, circulation corridors, team pod halos, wall washers, plinths, sconces and lamps cast visible pools of light.

## [0.4.21] - 2026-10-17

### Added

- Native mission start/status/history through the authenticated host API, with explicit workspace connection authorization, separate provider credentials and read-only file tools.
- Canonical correlated session events and bounded versioned mission results, preserving history-off privacy and marking unfinished work recovering after restart without replay.

### Fixed

- Native mission admission, cancellation and unknown-execution quarantine now protect overlapping prompts, connection policy changes and deletion; storage errors no longer imply persisted mission success.
- Unknown model context capacity can remain unspecified rather than using an invented limit. The observer integration test's outer timeout now accommodates its existing bounded waits.

## [0.4.20] - 2026-10-17

### Added

- A programmatic, read-only native mission supervisor with explicit provider/model bindings, dependency results, bounded concurrency and task deadlines. Local adapter tests exercise three parallel tasks over OpenAI and Anthropic implementations; host/UI integration and durable control remain pending.

### Fixed

- Added regression coverage for specific observed failure reasons, stale activity timestamps and synthetic failed replies, preserving the updated observer behavior.
- Native mission cancellation and failure handling preserve unrelated tasks and report unknown execution when a provider does not acknowledge abort.

## [0.4.19] - 2026-10-17

### Added

- Versioned native orchestration wire contracts and strict validation for missions, task DAGs, agents, models, budgets, scoped approvals, observation provenance and learning candidates; existing v0 events remain compatible. These contracts do not yet run a durable scheduler or enforce runtime policy.
- Native orchestration baseline, requirement/acceptance status and a continuation handoff, including remaining implementation stages and ADR 0007.

## [0.4.18] - 2026-10-17

### Added

- Rich observed statuses for Claude Code, Codex, Gemini CLI and Hermes (hooks and transcripts): Thinking, Planning, Reading, Editing, Running a command or tests, Searching, Browsing, Using an MCP tool, Delegating, Waiting for approval, Waiting for you, Compacting context, Interrupted, Error, Ready, Ended (optional `phase` on `agent.state`/`subagent.state`).
- Characters answer with a short random greeting bubble when picked from the board or lead cards; seated work poses follow the real activity (typing, scrolling, reading, thinking, watching output); idle characters stay at their desk 1–5 min, then spend 6–15 min chatting, at the gym, TV, games, terrace, lounge, pantry or garden, and return as soon as real work arrives. Desk chairs slide out and back when sitting down or leaving.
- Markdown tables in chat and transcripts (GitHub-flavoured, alignment, horizontal scroll).
- Board rows show a compact "time ago" next to the name; tree joints are rounded.
- Settings: model fields (connection model after Test, Complex/Standard/Quick tiers) are combo boxes that list the endpoint's models and still accept typing; max delegations is a select; the agent runtime is chosen from cards.
- Teams: up to 20 members; Plan with AI gives each member the models that fit it (usually 1–3, in fallback order) from the allowed list, plus a generated soul and reasons; a filter box for allowed models; the lead delegates only when a request concerns a member's role or scope.

### Fixed

- Observed Claude Code subagents showed "Ready" while working (they inherited the lead's idle state after background tasks were launched); each agent now has its own state, and an idle lead with working subagents shows "Delegating".
- Observed subagents lost their place under the lead when their announcement fell out of the event window; announcements are kept and unknown hook agent ids are attached to the lead. Hook-announced subagents take labels and models from their transcript files.
- Agents & sessions counters count every agent on the board exactly once (Working, Waiting, Errors, Ready) plus Running and Observed, with explanations.
- Screen light no longer glares on characters, only lights the surroundings at night with room lights off, and no longer leaks behind TVs; elevator cab lights move with the cab; added night downlights around the stair/elevator core on F1–F3.

## [0.4.17] - 2026-10-16

### Added

- Observed subagent trees from transcripts: Claude Code subagent files (`<session>/subagents/agent-*.jsonl` + `.meta.json`) and Codex child threads (`thread_spawn.parent_thread_id`, any depth) are shown under their lead with their label/nickname, role and model; Codex children are no longer listed or watched as separate sessions.
- The board shows where each observed agent comes from (Codex, Claude Code, Gemini CLI, Hermes), how it arrives (live via hook, from transcript, Hermes dashboard) and the model in use; observed leads and subagents get names (source nickname or a generated full name) and matching looks.
- Ignored folders on the Observe page (default `~/.claude-mem`, whose background helper sessions were showing up as characters): never auto-watched, ingested from hooks or shown in the Office; matching scan results are dimmed.
- Large live transcripts (over 4 MB) are observed from their first 512 KB and last 3 MB instead of being skipped.

### Changed

- Board tree lines are thin dashed lines.

### Fixed

- Observed session titles skip injected context (Codex AGENTS.md / environment blocks, Claude agent messages and reminders) and use Claude custom titles and Codex thread names when present.

## [0.4.16] - 2026-10-16

### Changed

- The Building view (the Office's first view) is framed to the office building and its entrance plaza from a slightly higher angle (about 17°), filling the stage area the overlays leave free, instead of a low wide shot of the whole block.

## [0.4.15] - 2026-10-16

### Changed

- Floor views (F1–F3) frame the whole floor plate as large as possible in the stage area the board and bottom overlays leave free, from a slightly steeper angle (`floorOverviewPose`), so the first view no longer cuts the floor off.
- The active agent cards sit at the very bottom of the Office with the prompt dock right above them; without active agents the dock is the bottom-most overlay.
- The outside view tab is called "Building" ("Gedung"), matching Building → F1–F3 → All floors.

### Removed

- The "Drag to orbit · Scroll to zoom" label over the 3D Office.

## [0.4.14] - 2026-10-16

### Removed

- Activity toasts in the 3D Office: what characters do now shows only as the flash bubble over each character (the Activity drawer keeps the full list).

## [0.4.13] - 2026-10-16

### Added

- Observed sessions show their subagents as a tree under the lead also when watched through transcripts only: Claude Code sidechain agents are announced once, labelled by the delegation that started them (hooks already did this for Claude Code, Codex and Hermes).

## [0.4.12] - 2026-10-16

### Added

- Subagent teams work on Hermes workspaces: Plan with AI uses the profile's local router (key sent only to loopback, `${VAR}` keys resolved like Hermes does), teams are saved per session, and an enabled team is briefed to Hermes, which delegates with its own `delegate_task` (one model for all children — the dialog says so).
- Plan with AI no longer needs a goal or ticked models: without a goal it plans a general team for the workspace; without models it chooses from the workspace's models and ticks the ones it used, in priority order. Planning may take up to 45 s before falling back to the heuristic plan.

### Fixed

- The Office prompt dock starts as a single compact field and opens its workspace, target, team, model and effort controls only when used.
- Scrolling over the lead-agent cards (or the empty strip around them) zooms the 3D Office again instead of being swallowed by the strip.

## [0.4.11] - 2026-10-16

### Added

- Every agent has a full name from one office-wide generator (e.g. "Elena Mark"), unique across sessions; a lead's name and gender are assigned when its session starts and saved. Default looks are generated from the full name and explicit gender, so the 3D character, board portrait, card and team dialog match.
- Teams from the prompt: a prompt with subagent blocks (`Subagent A:` or the "Lead Orchestrator" template with `#### Subagent 1:`; English or Indonesian labels: Name/Nama, Gender, Role/Peran, Model, Soul/Persona, Tugas/Task, Batasan) creates or updates the lead's team before the turn; the dock previews it ("Team from prompt · 2") with Review. The lead can also add or change members itself (`manage_team`).
- Write-capable members: a member may edit inside its scope (forbidden paths win; `..` and absolute paths are refused), with command approvals through the normal flow; writers run one at a time. Team members carry gender, soul/persona, access, scope and forbidden paths.

### Changed

- Board tree lines are clearly drawn from a lead to its members, and team members stay listed under their lead (as offline) when they are not working.

### Fixed

- The Extalia logo gradient material failed to compile on geometry with RGBA vertex colours (WebGL "useProgram: program not valid").

## [0.4.10] - 2026-10-16

### Changed

- Updated `.node-version` to Node 26 and upgraded workspace dependencies (`@types/node` 26, Electron 44.7, Three.js 0.186, React Three Fiber 9.8, Drei 10.7.9, React 19.3.1, Vite 8.3.4, Vitest 5.0.4, `@anthropic-ai/sdk` 0.134, `@radix-ui/react-select` 2.4.1, `smol-toml` 1.9.1, and `typescript-eslint` 8.71.2).

## [0.4.9] - 2026-10-16

### Added

- Subagent teams for Extalia Native lead agents: turn on "Use subagents automatically" and the lead always delegates to its team without being asked. The setup dialog (Team chip in the prompt dock, Team button in the lead's session dialog) sets the count, names (generated, editable), roles and tasks, and the allowed models in priority order; "Plan with AI" splits the goal across members and assigns models, "Re-plan" rebalances while keeping your edits. Members keep the single-writer rule (read-only research, review and analysis; the lead edits).
- Model fallback: when a model runs out of quota, credit or rate limit, the member (or the lead) retries with the next model in its order and says so in the Office.
- Agents & sessions board shows each agent's portrait and nests subagents under their lead (collapsible branches with a count).

### Changed

- Nothing floats over characters except the flash bubble; hovering shows only the name (no status or task text), and selection no longer pins it.

## [0.4.8] - 2026-10-16

### Added

- Per-session model and effort: `createSession(workspaceId, options)`, `setSessionOptions` and `modelChoices` (Native: the connection's listed models, effort for Anthropic connections; Hermes: the profile's router models and `--reasoning` when the Hermes CLI supports it).
- Office prompt dock redesign: grows out of the bottom-left corner on first load, auto-growing field, model combo box, effort control, and a target chip ("New session" or continue a chosen agent's session). The avatar card has its own "Message <name>…" field.

### Changed

- Agents & sessions board rows show name, status and model; details expand on demand, and clicking a row focuses the avatar and points the dock at that session (subagents point at their lead) instead of opening the dialog.
- Nothing floats above a character by default: name tags appear on hover, selection, follow or keyboard focus; bubbles only while work is in progress.
- Lead agents sit in the CEO office (then the leadership desk); subagents take a stable desk in a room that fits their work.
- Monitors, laptops and wall screens on the same desk or neighbouring desks never show the same picture (lock, screensaver and clock variants per slot, varied wallpapers); screens ignore fog and the busiest desks get the screen light pool first, so dark rooms are lit by their screens.

## [0.4.7] - 2026-10-15

### Changed

- Character appearance presets and walking styles now use only `feminine` and `masculine` (`packages/core/src/characterAppearance.ts`, `apps/web/src/office/scene/avatars/{appearance,rig,gait}.ts`); the `neutral` gender/style preset is removed and generated character looks pair each character's presentation with matching male or female hair and gait.

### Fixed

- 2D character portraits (`apps/web/src/office/overlay/{AgentPortrait.tsx,portrait.ts}`): closed the gap between the forehead/temples and hair across all 11 hairstyles (including `undercut`), added a seamless cranium base cap, proportioned the ears and neck/shoulder silhouette, added tailored jacket lapels, and refined eye/brow/glasses proportions.

## [0.4.6] - 2026-10-15

### Changed

- The Hermes model field is now a glass combo box matching the other pickers: "Profile default" first, the router's models grouped by provider, filtering as you type, and "Use “…”" to keep any model id you write yourself (`ui/ComboBox.tsx`, ARIA combobox with keyboard support).

## [0.4.5] - 2026-10-15

### Added

- Hermes workspaces read the selected profile's default model from its `config.yaml` and, when the profile uses a router on this computer (9Router, OmniRoute, Ollama, …), list that router's models to pick from (`hermesModels` host method; remote providers are never queried and the profile's API key is never returned). The model field shows the default, offers the list as you type, can rescan, and explains when a profile has no default model.

## [0.4.4] - 2026-10-15

### Fixed

- Provider picker: the official Anthropic mark replaces the wrong image, 9Router and OmniRoute use monochrome tiles that suit light and dark themes, the "Local" badge sits on the card's top row instead of spilling past its edge, cards in a row have equal heights, and the Liquid Glass Pro selection is a thin iridescent rim instead of a rainbow fill.

## [0.4.3] - 2026-10-15

### Added

- The theme picker (welcome setup and Settings) explains what each choice changes, in the interface and in the 3D Office (day, night, or following the real sun), and notes that the office lamps are set separately. Solar Cycle has its own sunrise icon.

## [0.4.2] - 2026-10-15

### Fixed

- Deleting `~/.extalia-vo` now really starts fresh: an old data folder that was already copied once (it holds `MIGRATED_TO_EXTALIA_VO.txt`) is never copied again.

## [0.4.1] - 2026-10-15

### Added

- Welcome setup on first run (and once for older configs, with the existing connection and workspace preselected): Welcome and language, Profile and appearance, Connection, Workspace, Connect agent apps, Done, then the 3D Office.
- One profile folder for Web and Desktop: `~/.extalia-vo` (Windows `%USERPROFILE%\.extalia-vo`). Existing data is copied once from the previous location (never moved or deleted); interface preferences (language, theme, surface style, font, sidebar) are saved in the profile, and Settings shows the folder.
- The splash plays a pre-rendered loop of the 3D office (night in dark theme, day in light theme); reduced motion and Save-Data show a still image.

### Changed

- Liquid Glass Pro v2: glass slabs with iridescent rims, bevels and nested frosted panels over a slow plasma backdrop, in CSS only (the WebGL `plasma-ui` library was measured and not added because it cost Office frame rate).

### Fixed

- React key warnings in the Office labels and stage; the desktop smoke test follows the moved floor controls.

<!-- ======================================================================= -->
<!-- Milestone 4: Subagents & Project Orchestration (v0.4.x)                -->
<!-- ======================================================================= -->

## [0.4.0] - 2026-10-15

### Added

- Lightweight branded splash and boot coordinator: first run shows only Setup; once set up, every launch opens the 3D Office (legacy remembered mode migrated). Recovery panel with Retry on boot errors.
- 3D Office floor (Campus/F1/F2/F3/All) and light (Auto/On/Off) controls moved into the top bar, Office page only, from one shared store; the Virtual Agent/Virtual Office switch is removed (Chat stays in the sidebar).
- Avatar click opens a compact anchored character card (Message, Activity, Follow, Appearance); a board row opens a separate accessible session dialog with Messages and Activity tabs, restoring the board and focus on close.
- Facility staff: a receptionist (F1 reception) and a bartender (F1 bar) with duty states, legal routes only (F1, F3 terrace/fitness), never counted as agents; agents can no longer take their stations.
- Privacy-safe semantic bubbles: bubbles, toasts, name tags and in-world screens show fixed phrases ("Running a command…", "Editing code…") instead of raw commands, paths or replies; raw detail stays in the Activity panel.
- Explicit restart: Desktop "Restart now" (confirms when work or drafts are active, relaunches through the normal shutdown); Web "Reload page" that states it does not restart the Bridge or outside apps. Connect agent apps shows restart and Codex `/hooks` approval as separate prerequisites.
- "Liquid Glass Pro" surface style (CSS only, light and dark, reduced-transparency and reduced-motion fallbacks); Standard and Liquid glass unchanged.

### Fixed

- Auto-watch enabled by `extalia connect` while the Bridge or Desktop is running now reaches the running host (discovery settings are re-read when the file changes, so neither side overwrites the other).
- The Office fills the window without page scrolling at desktop sizes; compact sidebar and top bar have a visible gutter in glass styles.

## [0.3.4] - 2026-10-15

### Added

- `extalia mcp [--app <codex|claude|gemini|hermes>] [--session <id>] [--port <number>]` stdio JSON-RPC 2.0 MCP server (`packages/host/src/hooks/mcp.ts`, `apps/cli/src/connect.ts`), exposing `report_intent` and `report_handoff` tools with `EXTALIA_MCP_INSTRUCTION` and forwarding calls directly to the local hook ingest endpoint (`127.0.0.1:<port>/api/hooks/<app>`).
- Connecting an agent app (`extalia connect <app>` or `applyAgentAppConnect`) now automatically enables "Watch new sessions automatically" (`autoWatch`) for that app's primary transcript location (`packages/host/src/observations.ts`, `packages/host/src/connect/service.ts`) so outside sessions fall back gracefully to transcript polling before hooks are approved or loaded.

## [0.3.3] - 2026-10-15

### Added

- End-to-end privacy and Hermes dashboard controls in "Connect agent apps" (`ConnectAgentAppsCard.tsx`, `setHookPrivacy` on `@extalia/platform` and `@extalia/host`):
  - Persisted **Labels only** (`labelsOnly`) toggle that strips prompt text, assistant reply bodies and tool outputs across both live hooks and transcript polling while keeping structured activity labels in the Virtual Office.
  - Optional loopback **Hermes dashboard URL** (`hermesDashboardUrl`, e.g. `http://127.0.0.1:9119`) wired into `Observations.discover` and `Observations.refresh` so active Hermes dashboard sessions are discovered and incrementally polled via `/api/sessions` and `/api/sessions/{id}/timeline?after_row_id=<cursor>` without reading `state.db`.
- Mock host (`apps/web/src/host/mockHost.ts`) now enables Gemini CLI and Hermes in "Connect agent apps" alongside Codex and Claude Code, and supports `setHookPrivacy`.

### Fixed

- Observed transcript turns whose last assistant reply lacks an explicit `final` marker (older Codex rollouts or Claude Code entries without `stop_reason`) now settle to `turn.completed` and `agent.state: idle` after 30 seconds of inactivity (`packages/host/src/transcriptEvents.ts`).
- Subagents spawned inside observed sessions via hooks (`SubagentStart` / `SubagentStop` or MCP `report_handoff`) now track their own `working` and `offline` state in the Virtual Office instead of mirroring the lead agent's status (`apps/web/src/office/presence.ts`).

## [0.3.2] - 2026-10-15

### Added

- Hermes dashboard read source (`packages/host/src/hermesDashboard.ts`): optional loopback-only HTTP reader for `/api/sessions` and `/api/sessions/{id}/timeline` with incremental `after_row_id` cursor polling as an alternative to reading `state.db` directly.
- Optional Extalia MCP reporting (`packages/host/src/hooks/mcp.ts`): `report_intent` and `report_handoff` tool schemas, instructions and hook normalization so outside agents can report high-level intent and subagent handoffs directly to the Virtual Office.
- Privacy `labelsOnly` option on hook normalization and ingest (`packages/host/src/hooks/{normalize,ingest}.ts`) to drop prompt text, assistant replies and tool output while keeping structured activity labels.

## [0.3.1] - 2026-10-15

### Added

- Live agent-app hooks and `extalia connect`: connect Codex, Claude Code, Gemini CLI and Hermes once so their sessions and tool steps appear live in the Virtual Office within a second.
  - Loopback hook ingest endpoint (`POST http://127.0.0.1:<port>/api/hooks/<codex|claude|gemini|hermes>`) on both the Bridge and Desktop (`@extalia/host`), authenticated with a separate `0600` ingest token (`Bearer`) or `X-Hermes-Signature-256` HMAC, bounded to 64 KB JSON bodies, rate limited, and always answering `204` so hooks never block or steer an outside agent.
  - Pure hook normalizers (`packages/host/src/hooks/normalize.ts`) for Codex, Claude Code, Gemini CLI and Hermes outbound webhooks, mapping native events to Extalia Protocol events (`session.started`, `prompt.submitted`, `agent.state`, `tool.started`, `tool.completed`, `file.written`, `subagent.spawned`, `subagent.state`, `turn.completed`, `session.ended`), linking `transcript_path` when inside a known root, deduplicating against transcript polling, and skipping Hermes sessions managed by Extalia itself.
  - Dependency-free hook forwarder (`EXTALIA_HOME/hooks/forward.mjs`) and CLI commands `extalia connect <codex|claude|gemini|hermes>` (`--dry-run`, `--yes`, `--port`, `--rotate`, `--trust`), `extalia disconnect <app>` and `extalia connections`, with unified diffs, non-colliding timestamped backups and byte-exact or surgical undo:
    - **Codex**: comment-preserving `[[hooks.<Event>]]` block in `$CODEX_HOME/config.toml` and optional `--trust` approval through the Codex app-server.
    - **Claude Code**: HTTP hooks (`timeout: 2`) plus a `SessionStart` command forwarder in `~/.claude/settings.json`, with managed-policy warnings (`disableAllHooks`, `allowManagedHooksOnly`, `allowedHttpHookUrls`).
    - **Gemini CLI**: command forwarder hooks (`timeout: 2000` ms) in `~/.gemini/settings.json` for `SessionStart`, `SessionEnd`, `BeforeAgent`, `AfterAgent`, `BeforeTool`, `AfterTool` and `Notification`.
    - **Hermes**: comment-preserving YAML `hooks.outbound` webhook entry across default and named profile `config.yaml` files with HMAC-SHA256 signing.
  - "Connect agent apps" / "Hubungkan aplikasi agent" card (`ConnectAgentAppsCard.tsx`) in Settings, Observe and the Virtual Office toolbar, with one-click **Copy command**, **Copy prompt**, diff preview, **Test** and **Disconnect** in English and Indonesian.

<!-- ======================================================================= -->
<!-- Milestone 3: Import Center & Agent Console (v0.3.x)                   -->
<!-- ======================================================================= -->

## [0.3.0] - 2026-10-11

### Added

- Watch new sessions automatically (opt-in per source on the Observe page): Codex, Claude Code, Gemini CLI and Hermes sessions that change after you opt in are observed without picking them, up to 24 at a time; the least recently active ones move to History. Sessions you pick by hand stay until you remove them.
- Observed sessions now report real activity from their transcripts: prompts, tool steps (classified, with the file or command), results and finished turns, about one second after the agent writes them. In the Office their characters think, work and idle like managed ones (live when the last event is under two minutes old, idle after ten), and their screens, bubbles, toasts and read-only console show the steps.

### Fixed

- Observed sessions are matched to the workspace whose folder contains their project, so they appear under the Office's project filter.
- The Office's "Start an agent" box no longer says no agent is working while an observed agent is busy.
- Codex environment context and project instructions no longer show up as user messages in imported or observed sessions.

## [0.2.4] - 2026-10-11

### Changed

- After setup and on every later launch the app opens the Virtual Agent (Chat and sessions) or, if that was the last one used, the Virtual Office. A "Virtual Agent | Virtual Office" switch in the top bar changes mode; the choice and the last workspace are remembered per device.
- Setup's Connection step always offers Extalia Native and Hermes Agent; when Hermes is not installed its card explains how to install it or point `EXTALIA_HERMES_BIN` at it, with a Check again button. The wizard's wording covers both runtimes and ends with "Open Virtual Agent".
- Hermes workspaces show their permissions as "Managed by Hermes", with one explicit switch to bypass Hermes approvals.
- The 9Router preset no longer requires an API key (a local 9Router answers without one).

### Fixed

- The Hermes logo was missing (404) in the light theme of the setup wizard.
- The 9Router and OmniRoute logos were invisible (white on white) in the light theme.
- Testing a custom endpoint no longer requires a model name first and shows readable errors instead of validation messages.
- Switching the workflow in Settings no longer sends a set-up app back to the setup wizard.

### Documentation

- `docs/product/prd-app-flow-and-live-agents.md`: product requirements, verified status and working protocol for the app flow, modes and live agent apps (phases A–E).

## [0.2.3] - 2026-10-10

### Added

- Day and night: the Office follows the sun for the device's time zone (no location prompt, no network), with dusk, blue hour and dark nights lit by real pools of light (entrance, plaza, paths, facade, tree uplights, street lights) and warm office windows. An Auto / On / Off lights control in the Office toolbar switches the interior lights; with them off at night only exit signs and screens light the rooms. An adaptive render budget keeps the scene smooth.
- Screens behave per device: monitor 1, 2 and 3 of a desk show an editor, a terminal or test runner, and docs; laptops, all-in-ones, the reception desk, wall boards and the entertainment TV each have their own look. Content follows the seated agent's reported activity (editing, running commands, tests, research, waiting for approval) without inventing details, idle desks show a lock screen, and empty desks go dark at night with the lights off. Screens glow and light desks, keyboards and faces at night, most strongly with the lights off.
- Building branding: the Extalia emblem above the main entrance, the wordmark over the door and a front board on the forecourt, backlit at night.
- Office overlay: search (`/`) for agents, rooms and activity; a room picker grouped by floor; a Recent activity drawer; lead-agent cards with portraits drawn from each character's look; six KPIs (running, waiting, working, errors, observed, idle); opt-in camera follow (F) next to Find in office; and an "Office full" notice listing agents without a desk.
- Name tags show what a character is doing under its name, and a dashed line shows where a selected walking character is heading.

### Fixed

- Campus signs drawn on canvas textures (the old monument, the wayfinding pylon and the cafe sign) were blank because their textures were uploaded before they were sized.
- The render budget's resolution changes were undone whenever the canvas re-rendered.

## [0.2.2] - 2026-10-09

### Added

- Characters walk: a new agent walks in from the lobby door to its desk and sits down; one that leaves stands up and walks out; workers step out at their lead's desk and walk back when done. Routes follow an authored corridor graph (A*) on each floor, and floor changes use the indoor stairs or ride either glass elevator through its real controller (doors and cab move with the rider). The walk cycle uses the character's walking style (stride, cadence, arm swing, hip sway); name tags, bubbles and the camera follow walkers. Agents already present when the Office opens start seated, arrivals are spaced at the entrance, and reduced motion places characters directly at their desks.
- Characters keep their desks when other agents arrive or leave.
- Character console in the Office: Messages and Activity tabs (a timeline of prompts, steps with status and duration, delegations, approvals with their decision, and results with tokens and duration), the lead agent's team of workers (select one to open it), Find in office, a larger dialog for long conversations (focus stays inside, Esc returns), and keyboard shortcuts M (message), A (activity), L (find) and E (appearance) that never fire while typing.

### Changed

- Source-derived avatar models and their extracted hair are local-only: they load from the git-ignored `apps/web/local-assets/avatars/` folder when present, and the public build uses the self-made procedural characters (every hair style and option still works). The public-safety check rejects any `.glb`, `.gltf` or `.fbx` file in the repository, and publishing `extalia-vo` refuses a build that contains 3D model files.

### Fixed

- The Office no longer logs "Cannot update a component while rendering a different component" while character models load.
- Character bubbles sit above the name tag instead of overlapping it, and activity toasts appear centered left of the agents panel (above the prompt dock when it is shown) instead of covering the conversation's input.

## [0.2.1] - 2026-10-09

### Added

- Separate source hair into 5 male, 4 female and 3 shared independently loadable skinned GLBs; base model packs no longer include hair meshes. Tinting and head/seat poses use the same canonical skeleton.
- Group the appearance editor's real hair assets by presentation with explicit male/female/shared labels. Preserve legacy choices with clear fallback notices; generated presets select actual assets, including high ponytail.
- Provide a reproducible, Blender-free extractor and a required asset-integrity check for skeletons, buffer references, embedded images and source fingerprints.

<!-- ======================================================================= -->
<!-- Milestone 2: Workspaces & Session Hub (v0.2.x)                        -->
<!-- ======================================================================= -->

## [0.2.0] - 2026-10-09

### Added

- Start a managed agent from a prompt dock in Office when no agent is busy, with per-workspace session creation and the existing permission controls.
- Show real character activity as bottom toasts and timed speech/thought bubbles. The agent/session panel is more opaque, blurred, and collapses with a transition; the Office sidebar expands over the canvas on hover or keyboard focus without resizing it.
- Show staged loading progress until the scene and source character assets have drawn. Restore the original bundled GLB character packs, both glass elevator shafts/cabs and the exterior roof-access stairs.

### Fixed

- Permit local object-URL image textures and their fetches in Web/Desktop while keeping script evaluation restricted. Uncompressed source avatars skip unnecessary Draco/network and WebAssembly decoders.

### Validation

- All 349 tests pass. Verify Office prompt/session creation, character-specific chat and approval controls against a temporary mock provider; sidebar overlay expansion keeps canvas width unchanged. Desktop smoke exercises the source character assets, scene readiness and all three floor views.

## [0.1.8] - 2026-10-09

### Added

- Restore furnished F1, F2 and F3 rooms, their original furniture and decorations, floor/cutaway navigation and authored humanoid characters in the shared Office renderer.
- Select a character to view its session history and prompt its managed agent inside Office; worker and observed activity remains read-only according to runtime capabilities.
- Document Extalia Virtual Agent as the single development home for Office improvements, with explicit follow-up requirements for hair, clothing, accessories, gender/style presets and configurable walking animations.
- Name tags above characters (status color and session title) make agents findable and clickable at whole-floor zoom; selecting a character moves the camera to it, beside the conversation panel (instant with reduced motion).
- Character appearance: each character has an editable look with Feminine, Masculine and Neutral style presets (hair, clothing cuts including skirts and dresses, accessories, body frame and walking style) plus individual options, previewed live in the Office. Looks are saved in the agent host, so Web and Desktop share them across restarts. Presets are the user's choice; nothing is inferred from names, models or providers, and characters without a saved look get a neutral generated one.

### Fixed

- Office room, floor and corridor labels stay on one line instead of breaking after every word, and Office panels sit above the scene's labels and stay readable over the 3D view with liquid glass.
- Blazers, coats and cardigans no longer show the shirt through their back, and coats end at the seat instead of passing through the chair.
- Tests that start git or Hermes processes allow 30 s, so they no longer time out on a busy machine.

## [0.1.7] - 2026-10-09

### Fixed

- Interface fonts (Quicksand, Geist, Plus Jakarta Sans, Inter) ship with the app instead of loading from Google Fonts, which the app's Content Security Policy blocked; Extalia makes no third-party requests and the font choice works offline.
- Theme, material and font changes only animate when the value really changes, apply instantly with reduced motion or in a background tab, and no longer log unhandled "Transition was aborted" errors (the solar theme re-applied itself every minute).
- Pages no longer grow wider than the window when they contain a long project path (Files and Git cut off their right column).
- The Bridge reads and discards a slightly oversized request body before answering 413, so clients get the error instead of a reset connection (this also made a Bridge test fail intermittently).

## [0.1.6] - 2026-10-09

### Added

- Setup, Settings, Chat and Virtual Office share one Web/Desktop application. Setup enters Office, and the scene is packaged in the same build with no separate preview server.
- Reuse the existing campus geometry with gradient branding and an initial work view. Project-filtered agents are derived from real host sessions and protocol activity, including approvals, observed sessions and delegated workers; selecting an actor opens its conversation.
- Load the 3D renderer on demand with reduced-motion support and a fallback to Chat when WebGL is unavailable. Detailed interiors and advanced avatar navigation remain later milestones.

## [0.1.5] - 2026-10-09

### Added

- Hermes Agent as a managed runtime: a workspace can run the local `hermes` command instead of Extalia Native. Prompts stream into Chat with tool cards and usage, later prompts resume the same Hermes session, Stop and closing Extalia end the process, and Continue in Extalia works into Hermes workspaces. Setup offers Hermes when it is installed, without a model connection. Hermes' own approvals stay in force unless the workspace allows both file edits and commands.
- Files and Git pages (read-only): browse a workspace and view text files with line numbers; see the branch, ahead/behind, changed files and diffs. Credential files are never shown, and Git runs without a shell and with repository-defined programs (fsmonitor, hooks, filters, external diff, textconv, pagers) switched off.
- Brand assets in `docs/brand/`: light and dark logos (symbol and wordmark), the symbol in SVG and PNG, and a 1280 × 640 social preview; the README header shows the logo that matches GitHub's theme.

### Fixed

- Diagnostics recognizes commands, Git inspection and credential storage provided through the agent host, distinguishes a folder picker from registered project access, and shows unsupported development update checks accurately.
- Show registered project/session counts and a direct workspace-management action in Diagnostics; avoid opening duplicate folder dialogs while a picker is active.
- Desktop finds Hermes in the per-user install folder (`~/.local/bin`) when it was started without a shell PATH.
- README and runtime docs now describe Continue in Extalia and per-connection history.

### Validation

- Verify project-folder checks, two independent workspace session lists, explicit session selection and persistence across host restarts using temporary projects. Document browser/Bridge/Desktop requirements and the optional Python runtime boundary.

## [0.1.4] - 2026-10-09

### Changed

- Native observer polling checks file metadata and Hermes database/WAL metadata before parsing, caches source-location resolution, and coalesces overlapping polls. Unchanged sources do not rewrite snapshots or emit redundant updates.
- Defer the sample Office navigation until real scene integration; preserve the spatial contracts and source for the final milestone.

### Fixed

- Observer-only startup resolves to the Observe page after asynchronous host loading, and icon-only navigation keeps accessible labels on phones.
- Give the observer list and transcript a responsive two-column layout, preserve the local title after a rejected empty rename, and release the host lock if observer startup fails.

### Validation

- Synthetic native-source tests cover idle parse/write suppression, transcript appends and rewinds, equal-size rewrites, pause/restart/resume, source-boundary recovery, Hermes WAL updates, and rejection of managed actions on observed sessions.

## [0.1.3] - 2026-10-09

### Added

- Continue in Extalia: start a managed session from an imported or observed conversation (for example a Codex or Claude Code session that ran out of quota). The recent conversation and the original request are carried over as context, Chat marks where the earlier agent stopped, and the source is never changed.
- Connections can turn session history off. New sessions on such a connection stay in memory only, are marked "Not saved" and disappear when Extalia closes.

## [0.1.2] - 2026-10-09

### Changed

- Defer the Virtual Office 3D scene to the final integration milestone, after managed and observed agent workflows, imports, session management and desktop/web foundations.

## [0.1.1] - 2026-10-09

### Added

- Extalia Native runtime (`@extalia/runtime`): a provider-neutral agent loop with tool calling, approvals and cancellation; model providers for OpenAI-compatible endpoints (OpenAI, OpenRouter, 9Router, OmniRoute, Ollama, custom) and the Anthropic Messages API through the official SDK, with reasoning blocks replayed unchanged and server-side refusal fallbacks when talking to Anthropic directly.
- Node agent host (`@extalia/host`): workspace-bounded file and command tools, OS credential storage, persistent sessions, per-workspace memory, skills (built-in, user and project), and a single-host lock. Desktop runs it in the main process; the `extalia` command runs it behind the local Bridge.
- Connections with presets and a per-connection choice of who provides memory and skills (Extalia, the provider where it has its own, or off); OmniRoute is asked not to add its memory when Extalia's is used.
- First-run setup and progressive navigation: only pages that work in the current mode are shown.
- Chat with streaming answers, tool cards, live command output and approvals (once, for the session, or deny).
- Desktop auto-update from GitHub Releases (download in the background, restart after a short countdown when no agent is working) and packaging with electron-builder.
- npm distribution of the Web client as `extalia-vo` (`extalia` command) with update checks and `extalia update`.
- `tooling/mock-provider.mjs`, a scripted OpenAI-compatible endpoint for trying the agent without an API key.
- Orchestration, on by default: the agent can hand read-only research and review to worker agents (`delegate_task`), several at once, on per-connection Complex / Standard / Quick models (suggested: Claude Opus / Sonnet / Haiku for Anthropic, Sol / Sol / Luna for OpenAI), with a per-turn delegation limit; workers appear as `subagent.*` events.
- Nine built-in skills (plan-feature, debug-issue, code-review, write-tests, refactor-safely, security-review, commit-changes, update-docs, explain-codebase); user and project skills override them.
- Native history import (`@extalia/importers`): Codex, Claude Code, Hermes Agent (per profile, read-only SQLite) and Gemini CLI, with scan, preview and import into a local library that keeps renames, archive and trash across re-imports; Antigravity conversations are detected but not readable yet.

### Changed

- The logo mark uses the office's green gradient (#10b9ac → #83cb35 → #f8e719).
- Placeholder session views (Office, Console, Tasks, Terminal, Files, Git) are no longer shown until they are implemented.

<!-- ======================================================================= -->
<!-- Milestone 1: Public Foundation & Vertical Slice (v0.1.x)               -->
<!-- ======================================================================= -->

## [0.1.0] - 2026-10-08

### Added

- Monorepo foundation: `apps/web`, `apps/desktop`, `apps/cli`, `packages/protocol`, `packages/core`, `packages/platform`.
- Extalia Protocol v0: versioned event envelope with session, agent, task, parent and correlation ids; managed/observed session control; event families for conversation, agents and subagents, tools, commands, files, tasks, approvals, Git and meetings; strict validation and JSON Lines parsing.
- Domain core: profiles, workspaces, portable sessions (`extalia.session.v1`), session library with import preview, deduplication by source key, local organization that survives re-imports, linked-session tombstones, credential masking and export.
- Platform capability contracts, Desktop and Web hosts, and platform user-data directories.
- Web shell with English and Indonesian, light and Royal Charcoal dark themes, an optional liquid-glass surface style for both, compact sidebar, Get started, Event log, Diagnostics and Settings pages, and placeholders for upcoming session views.
- Electron Desktop shell with sandboxed renderer, `extalia://app` protocol with Content Security Policy, folder picker and a smoke test.
- `extalia` CLI with `doctor` and `validate`.
- Repository checks for dependency boundaries, public safety and lockstep versions; CI on macOS, Windows and Linux.
- Architecture documentation, ADRs 0001–0004, migration ledger, contribution, governance and security policies.
