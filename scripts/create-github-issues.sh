#!/usr/bin/env bash
set -euo pipefail

REPO="Extalia-VO/extalia-virtual-agent"
echo "Creating roadmap issues for $REPO..."

# Milestone 1: v0.1.0-alpha: Public Foundation & Vertical Slice
M1="v0.1.0-alpha: Public Foundation & Vertical Slice"
gh issue create --repo "$REPO" \
  --milestone "$M1" \
  --title "feat(core): Scaffold monorepo architecture and cross-platform CI matrix" \
  --label "phase:0-foundation,area:desktop,area:web,type:feature,priority:critical" \
  --body "### Summary
Establish the clean public monorepo structure with strict boundary checks between apps and domain packages.

### Scope
- Initialize packages: \`core\`, \`protocol\`, \`runtime\`, \`renderer\`, \`platform\`, and \`ui\`.
- Configure pnpm workspaces and TypeScript project references.
- Implement GitHub Actions CI matrix running lint, typecheck, and unit tests across macOS, Windows, and Linux runners.
- Ensure strict zero-leakage of personal paths or private credentials.

### Acceptance Criteria
- [ ] \`pnpm install\` and \`pnpm build\` succeed from a clean clone without private environment dependencies.
- [ ] CI pipeline validates pull requests on all target platforms."

gh issue create --repo "$REPO" \
  --milestone "$M1" \
  --title "feat(platform): Implement platform capability abstractions and workspace sandboxing" \
  --label "phase:0-foundation,area:security,area:desktop,type:feature,priority:high" \
  --body "### Summary
Define capability contracts (\`PlatformCapabilities\`) to decouple application domain logic from Electron or browser specifics.

### Scope
- Implement unified interfaces for \`filesystem\`, \`terminal\`, \`git\`, \`secureStorage\`, and \`updater\`.
- Implement workspace sandboxing: deny filesystem reads/writes outside the selected project boundary.
- Integrate secure OS credential storage (via Keytar / platform API).

### Acceptance Criteria
- [ ] Domain code contains zero \`if (isElectron)\` conditional checks.
- [ ] Path traversal outside designated project roots is blocked."

gh issue create --repo "$REPO" \
  --milestone "$M1" \
  --title "feat(renderer): Build generic 3D virtual office core and avatar kinematic system" \
  --label "phase:1-office-core,area:renderer,type:feature,priority:critical" \
  --body "### Summary
Migrate the Three.js / React Three Fiber rendering engine with generic office floorplans, spatial camera navigation, and state-driven avatars.

### Scope
- Spatial navigation and smooth camera pan/zoom controls.
- Generic office floorplan with ambient lighting and configurable quality presets.
- Kinematic avatar movement and workstation allocation queue.
- Support state-driven animations: idle, walking, seated, working, and delegating.

### Acceptance Criteria
- [ ] Virtual office runs smoothly with mock protocol events driving avatar state transitions without external runtimes.
- [ ] Frustum culling and scene disposal prevent memory leaks."

gh issue create --repo "$REPO" \
  --milestone "$M1" \
  --title "feat(protocol): Define Extalia Protocol v0 schema and typed event bus" \
  --label "phase:2-protocol-runtime,area:protocol,type:feature,priority:critical" \
  --body "### Summary
Establish the normalized Extalia event protocol that decouples all visual and UI components from underlying AI runtimes.

### Scope
- Define typed event schemas: \`AgentStateChanged\`, \`PromptSubmitted\`, \`ModelStreaming\`, \`ToolStarted\`, \`ToolCompleted\`, \`SubagentSpawned\`, \`TaskProgress\`.
- Implement high-throughput typed in-memory and IPC event bus.
- Version-tagged JSON schemas for serialization and replayability.

### Acceptance Criteria
- [ ] Unit tests validate event serialization, deserialization, and schema validation.
- [ ] Protocol package has zero dependencies on specific model providers."

gh issue create --repo "$REPO" \
  --milestone "$M1" \
  --title "feat(runtime): Implement Hermes runtime adapter and first vertical slice" \
  --label "phase:2-protocol-runtime,area:runtime,type:feature,priority:critical" \
  --body "### Summary
Implement the reference runtime adapter for Hermes Agent and validate the first end-to-end vertical execution slice.

### Scope
- Discover Hermes capabilities and active sessions.
- Ingest Hermes tool execution events, streaming tokens, and subagent lifecycles into the normalized Extalia Protocol.
- Support prompt submission and cancellation via adapter interface.
- Connect runtime adapter to 3D office and basic Chat UI.

### Acceptance Criteria
- [ ] Submitting a prompt in the Chat view triggers agent execution in Hermes.
- [ ] Agent avatar walks to desk and shows active work animation in the 3D office."

# Milestone 2: v0.2.0-alpha: Workspaces & Session Hub
M2="v0.2.0-alpha: Workspaces & Session Hub"
gh issue create --repo "$REPO" \
  --milestone "$M2" \
  --title "feat(workspace): Implement profile manager and workspace repository linking" \
  --label "phase:3-workspace-session,area:ui,type:feature,priority:high" \
  --body "### Summary
Enable users to manage top-level user profiles and associate workspaces directly with project repository directories.

### Scope
- Profile model supporting isolated environments (e.g. Work, Personal, Freelance).
- Workspace model tying project directories to runtime configurations and model rosters.
- Workspace creation and directory selector dialogs.

### Acceptance Criteria
- [ ] User can switch profiles and link workspaces to local git repositories.
- [ ] Settings and rosters persist locally under user data directory."

gh issue create --repo "$REPO" \
  --milestone "$M2" \
  --title "feat(sessions): Build persistent multi-session local store and unified sidebar" \
  --label "phase:3-workspace-session,area:ui,type:feature,priority:high" \
  --body "### Summary
Create persistent session storage independent of runtime engines, with a unified workspace sidebar.

### Scope
- SQLite-backed local session database supporting multiple sessions per workspace.
- Unified sidebar grouping sessions by workspace/project.
- Search, filter by source, archive, restore, and soft-delete capabilities.

### Acceptance Criteria
- [ ] Sessions persist across app restarts.
- [ ] Archiving or trashing a session updates the index without deleting external project files."

# Milestone 3: v0.3.0-beta: Import Center & Agent Console
M3="v0.3.0-beta: Import Center & Agent Console"
gh issue create --repo "$REPO" \
  --milestone "$M3" \
  --title "feat(importer): Implement session import center for Codex, Claude Code, and Hermes" \
  --label "phase:4-import-center,area:importer,type:feature,priority:high" \
  --body "### Summary
Build discovery, parsing, and normalization pipeline for historical sessions from Codex, Claude Code, and Hermes Agent.

### Scope
- Local discovery for standard runtime directories (\`~/.codex\`, \`~/.claude\`, \`~/.hermes\`).
- Parsers converting source rollout formats to Extalia Portable Session schema.
- Fingerprinting and deduplication to avoid redundant imports.
- Dual ingestion modes: Imported Mode (independent copy) vs Linked Mode (read-only index).

### Acceptance Criteria
- [ ] Historical sessions import cleanly with message history, tool calls, and timestamps.
- [ ] Source directories remain strictly unmodified."

gh issue create --repo "$REPO" \
  --milestone "$M3" \
  --title "feat(security): Implement high-entropy secret redaction scanner for imports and exports" \
  --label "phase:4-import-center,area:security,type:feature,priority:critical" \
  --body "### Summary
Ensure no secrets, API keys, private tokens, or authorization credentials are saved into Extalia session stores or exported archives.

### Scope
- High-entropy regex and pattern scanner for API keys (OpenAI, Anthropic, GitHub PAT, AWS, GCP, Slack).
- Automatic redaction of private keys and bearer tokens during session ingestion.
- Pre-export sanitization validation.

### Acceptance Criteria
- [ ] Scanner masks credentials with \`[REDACTED]\` in timeline entries.
- [ ] Test fixtures with sample credentials pass zero-leakage assertions."

gh issue create --repo "$REPO" \
  --milestone "$M3" \
  --title "feat(console): Build non-3D Agent Console and multi-view observability suite" \
  --label "phase:5-console,area:ui,type:feature,priority:high" \
  --body "### Summary
Provide a comprehensive conventional developer interface allowing complete agent inspection and steering without opening the 3D office.

### Scope
- Tabbed multi-view workspace: Chat, Timeline, Tool Inspector, Terminal, Files, Git, and Logs.
- Interactive controls: pause, steer, cancel, prompt injection.
- Real-time tool call inspector displaying arguments, outputs, execution duration, and status indicators.

### Acceptance Criteria
- [ ] All session operations and agent steering can be performed with the 3D office completely disabled."

# Milestone 4: v0.4.0-beta: Subagents & Project Orchestration
M4="v0.4.0-beta: Subagents & Project Orchestration"
gh issue create --repo "$REPO" \
  --milestone "$M4" \
  --title "feat(orchestration): Implement subagent lifecycle manager and spatial allocation" \
  --label "phase:6-skills-subagents,area:renderer,area:runtime,type:feature,priority:high" \
  --body "### Summary
Enable primary agents to spawn, delegate to, steer, and monitor specialized subagents with dynamic office seating.

### Scope
- Subagent lifecycle operations: spawn, delegate, steer, pause, review, complete.
- Hierarchical task assignment and progress reporting.
- 3D office workstation assignment: subagents dynamically navigate to available desks and update smart screen monitors.

### Acceptance Criteria
- [ ] Subagents appear both in the Console hierarchy and as active seated workers in the 3D office."

gh issue create --repo "$REPO" \
  --milestone "$M4" \
  --title "feat(skills): Build declarative skill registry and capability permission gates" \
  --label "phase:6-skills-subagents,area:security,type:feature,priority:high" \
  --body "### Summary
Establish a structured skill registry where skills declare explicit capabilities and required permissions.

### Scope
- Skill package metadata schema (\`permissions\`, \`requires\`, \`events\`).
- Permission mediation dialogs requiring user confirmation before granting sensitive capabilities.
- Built-in bootstrap skills: \`profile-manager\`, \`workspace-manager\`, \`subagent-orchestrator\`, \`filesystem\`, \`git\`.

### Acceptance Criteria
- [ ] Skills requesting unauthorized capabilities are blocked by permission gates."

gh issue create --repo "$REPO" \
  --milestone "$M4" \
  --title "feat(orchestration): Implement project planning DAG and autonomous meeting rooms" \
  --label "phase:7-orchestration-knowledge,area:renderer,type:feature,priority:medium" \
  --body "### Summary
Provide higher-level project orchestration including task dependency graphs and virtual meeting rooms for multi-agent synthesis.

### Scope
- Project goal breakdown into tasks with dependency tracking (DAG).
- Virtual meeting room semantics: avatars gather, discuss, and synthesize decisions.
- Structured decision ledger output and meeting action item tracking.

### Acceptance Criteria
- [ ] Meeting events trigger avatar movement to meeting rooms and record synthesized decisions."

gh issue create --repo "$REPO" \
  --milestone "$M4" \
  --title "feat(knowledge): Implement bidirectional Obsidian vault integration" \
  --label "phase:7-orchestration-knowledge,area:docs,type:feature,priority:medium" \
  --body "### Summary
Provide optional project knowledge persistence integrated with Obsidian vaults.

### Scope
- Structured note generation: session recaps, architectural decisions (ADRs), meeting notes.
- Configurable write policies with user preview and conflict resolution.
- Strict isolation: imported external content is never executed as trusted prompt policy.

### Acceptance Criteria
- [ ] Session recaps export seamlessly into Obsidian Markdown format."

# Milestone 5: v1.0.0-ga: Extension SDK & Production Release
M5="v1.0.0-ga: Extension SDK & Production Release"
gh issue create --repo "$REPO" \
  --milestone "$M5" \
  --title "feat(sdk): Publish public Extension SDK and developer documentation" \
  --label "phase:8-extension-sdk,area:docs,type:feature,priority:medium" \
  --body "### Summary
Publish official Extalia SDK (\`@extalia/sdk\`) allowing community developers to build custom runtime adapters, importers, plugins, and custom 3D rooms.

### Scope
- SDK package contracts, extension manifest schemas, and plugin life-cycle hooks.
- Sample extensions: custom runtime adapter and custom 3D room.
- Developer documentation and architecture guides.

### Acceptance Criteria
- [ ] External plugins can be built and loaded without modifying Extalia core codebase."

gh issue create --repo "$REPO" \
  --milestone "$M5" \
  --title "ci(release): Configure automated desktop release packaging and code signing" \
  --label "phase:8-extension-sdk,area:desktop,type:chore,priority:high" \
  --body "### Summary
Establish automated CI/CD release workflows producing signed desktop installers for all Tier 1 target platforms.

### Scope
- Multi-platform packaging: macOS (DMG for arm64/x64), Windows (x64 installer), Linux (AppImage and DEB).
- Automated GitHub Release generation with checksums and release notes.
- Background update check foundation for Desktop and Web.

### Acceptance Criteria
- [ ] Tagged releases automatically generate and publish tested binary assets to GitHub Releases."

echo "All roadmap issues created successfully."
