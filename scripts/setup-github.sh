#!/usr/bin/env bash
set -euo pipefail

REPO="Extalia-VO/extalia-virtual-agent"
echo "Target repository: $REPO"

# 1. Create Labels
echo "Creating taxonomy labels..."

create_label() {
  local name="$1"
  local color="$2"
  local desc="$3"
  echo "Setting label: $name"
  gh label create "$name" --repo "$REPO" --color "$color" --description "$desc" --force 2>/dev/null || \
  gh label edit "$name" --repo "$REPO" --color "$color" --description "$desc" 2>/dev/null || true
}

# Phases
create_label "phase:0-foundation" "0052cc" "Phase 0 - Public foundation, monorepo, and CI/CD"
create_label "phase:1-office-core" "0e8a16" "Phase 1 - Virtual office 3D renderer and avatars"
create_label "phase:2-protocol-runtime" "1d76db" "Phase 2 - Extalia protocol v0 and runtime adapters"
create_label "phase:3-workspace-session" "5319e7" "Phase 3 - Profiles, workspaces, and persistent sessions"
create_label "phase:4-import-center" "fbca04" "Phase 4 - Historical session importers and deduplication"
create_label "phase:5-console" "d93f0b" "Phase 5 - Agent console and multi-view observability"
create_label "phase:6-skills-subagents" "006b75" "Phase 6 - Skill registry and subagent orchestration"
create_label "phase:7-orchestration-knowledge" "b60205" "Phase 7 - Project orchestration and Obsidian knowledge"
create_label "phase:8-extension-sdk" "e99695" "Phase 8 - Extension SDK and cross-platform releases"

# Areas
create_label "area:renderer" "bfd4f2" "Three.js / R3F spatial rendering and office assets"
create_label "area:protocol" "bfdadc" "Extalia event protocol specifications and schemas"
create_label "area:runtime" "c2e0c6" "Agent runtime integration and adapter implementations"
create_label "area:desktop" "d4c5f9" "Electron/Desktop application shell and native bridges"
create_label "area:web" "fef2c0" "Browser web client and loopback bridge transport"
create_label "area:importer" "f9d0c4" "Session discovery, normalization, and secret redaction"
create_label "area:security" "e11d21" "Security boundaries, sandboxing, and permissions"
create_label "area:ui" "c5def5" "Shared UI design system, components, and layout"
create_label "area:docs" "0075ca" "Architecture documentation, specs, and user guides"

# Types
create_label "type:feature" "a2eeef" "New user-facing functionality or core system feature"
create_label "type:bug" "d73a4a" "Unexpected behavior, defect, or rendering glitch"
create_label "type:spec" "d4c5f9" "Design specification or architecture decision record"
create_label "type:chore" "fef2c0" "Tooling, dependencies, and infrastructure updates"
create_label "type:security" "b60205" "Security vulnerability, isolation fix, or secret redaction"

# Priorities
create_label "priority:critical" "b60205" "Highest priority - blocks foundational releases"
create_label "priority:high" "d93f0b" "High priority - scheduled for upcoming milestone"
create_label "priority:medium" "fbca04" "Medium priority - scheduled for current release cycle"
create_label "priority:low" "0e8a16" "Low priority - backlog enhancement or non-blocking polish"

# 2. Create Milestones
echo "Creating project milestones..."

create_milestone() {
  local title="$1"
  local desc="$2"
  local due="$3"
  echo "Setting milestone: $title"
  gh api -X POST "repos/$REPO/milestones" \
    -f title="$title" \
    -f description="$desc" \
    -f due_on="$due" 2>/dev/null || echo "Milestone $title already exists or cannot be created"
}

create_milestone "v0.1.0-alpha: Public Foundation & Vertical Slice" \
  "Public repository foundation, monorepo boundaries, Three.js generic office, Extalia Protocol v0, and Hermes runtime vertical slice." \
  "2026-11-15T00:00:00Z"

create_milestone "v0.2.0-alpha: Workspaces & Session Hub" \
  "Profile management, project workspace linking, persistent SQLite session store, and unified sidebar navigation." \
  "2026-12-15T00:00:00Z"

create_milestone "v0.3.0-beta: Import Center & Agent Console" \
  "Historical session importer for Codex, Claude Code, and Hermes. Secret redaction engine, agent console views, terminal and tool observability." \
  "2027-01-30T00:00:00Z"

create_milestone "v0.4.0-beta: Subagents & Project Orchestration" \
  "Subagent orchestration, dynamic office seating, declarative skill registry, project DAG planning, and Obsidian knowledge synchronization." \
  "2027-03-15T00:00:00Z"

create_milestone "v1.0.0-ga: Extension SDK & Production Release" \
  "Public Extension SDK, signed cross-platform installers for macOS, Windows, Linux, plugin manifest validator, and official documentation." \
  "2027-05-01T00:00:00Z"

echo "GitHub taxonomy and milestones initialized."
