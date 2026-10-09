# Development Roadmap & Implementation Phases

The Extalia development roadmap completes the managed/observed workflows, session library,
import, configuration and desktop/web foundations before bringing in the 3D office. The
existing Virtual Office scene is the final integration milestone; its unfinished modules are
not prerequisites for the agent application.

---

## Phase Breakdown

### Phase 0 — Public Foundation (Milestone v0.1.0-alpha)
- Establish monorepo structure with strict boundary checks.
- Set up automated CI/CD for linting, type-checking, and test suites across macOS, Windows, and Linux.
- Scaffold generic application shell for Desktop and Web.
- Zero-leakage verification: sanitize all paths, tokens, and personal credentials.

### Phase 1 — Protocol & Runtime Adapter (Milestone v0.1.0-alpha)
- Define Extalia Protocol v0 specification and JSON Schema validators.
- Build runtime adapter interface and Extalia Native managed runtime.
- Stream model tokens, tool execution progress, and agent state transitions to event bus.
- Complete the first end-to-end vertical slice: prompt -> runtime -> normalized event -> session.

### Phase 2 — Workspaces & Session Hub (Milestone v0.2.0-alpha)
- Profile Manager (Personal, Freelance, Enterprise profiles).
- Workspace Manager (link workspace to local repository directories).
- Persistent multi-session SQLite / local store.
- Unified sidebar grouping sessions by workspace/project with search, filter, and archive.

### Phase 3 — Import Center (Milestone v0.3.0-beta)
- Historical session importers for Codex, Claude Code, and Hermes Agent.
- Read-only discovery and content parser with secret redaction scanner.
- Session fingerprinting and deduplication logic.
- Linked mode vs. Imported mode data isolation.

### Phase 4 — Agent Console & Observability (Milestone v0.3.0-beta)
- Conventional non-3D views: Chat, Timeline, Tool Inspector, Terminal, Files, Git, and Logs.
- Interactive steering: prompt injection, pause, resume, and cancellation.
- Real-time tool execution output with collapsible cards and duration tracking.

### Phase 5 — Skills & Subagent Orchestration (Milestone v0.4.0-beta)
- Skill registry with explicit capability declarations and permission checks.
- Dynamic subagent spawning, task delegation, and hierarchical reporting.
- Visual subagent seating in virtual office with activity screens.

### Phase 6 — Project Orchestration & Knowledge (Milestone v0.4.0-beta)
- Project goals, milestone tracking, and task dependency graphs.
- Autonomous meeting rooms: agent discussion logs, decision synthesis, action items.
- Optional Obsidian integration for syncing architecture decisions and project notes.

### Phase 7 — Desktop/Web Readiness (before the spatial milestone)
- Publish the Web CLI only after maintainers enable the npm package.
- Configure signed, notarized desktop releases and verify update/restart behavior on each platform.
- Finish documentation, recovery behavior and public-release review.

### Phase 8 — Virtual Office Integration (final product milestone)
- Integrate the completed Three.js / React Three Fiber scene, office layout, lighting, avatars and navigation from the existing Virtual Office.
- Feed the scene stable Extalia Protocol session, task and presence events.
- Verify that the office can be opened as a full workspace while all non-3D agent workflows remain usable independently.

### Phase 9 — Extension SDK & Public Release (Milestone v1.0.0-ga)
- Public SDK for custom runtime adapters, importers, plugins, and custom 3D rooms.
- Signed desktop installers (DMG for macOS arm64/x64, EXE/MSI for Windows, AppImage/DEB for Linux).
- Community documentation, release notes automation, and plugin registry.
