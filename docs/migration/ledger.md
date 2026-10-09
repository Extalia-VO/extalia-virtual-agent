# Migration ledger

What this repository takes from the private prototypes (PRD §4.3). The
prototypes are references only; nothing is copied wholesale and their history
is not published.

- **Prototype A**: the 3D office (React Three Fiber scene, avatars, navigation,
  lighting, runtime gateway written in Python).
- **Prototype B**: the agent foundation (session import, local Bridge running
  agent CLIs, hooks, MCP server, workbench).

Classes: **KEEP** generic code that fits as is · **ADAPT** useful code that
needs abstraction · **REWRITE** valuable behavior with coupled implementation ·
**DROP** private, obsolete or unsafe.

## Done in Phase 0

| From | Module | Class | Now |
| --- | --- | --- | --- |
| B | Agent event protocol | ADAPT | `@extalia/protocol`: open runtime ids instead of a fixed engine list; agent, task, approval, git and meeting events; envelope agent/task/correlation ids; strict validation |
| B | Validation helpers, credential redaction | KEEP | `@extalia/core` `validation.ts`, `privacy.ts` |
| B | Portable session format, import preview, deduplication, linked-session exclusions | ADAPT | `@extalia/core` `portable.ts`, `library.ts`: open source ids, source-key identities, message redaction on import, move and permanent delete |
| B | Platform contracts | REWRITE | `@extalia/platform`: PRD capability model, data-directory resolution |
| A, B | Logo symbol, wordmark outlines, favicon, font license | KEEP | `apps/web/src/branding`, `apps/web/public` |
| B | Glass surfaces, motion, light/dark, English/Indonesian UI | ADAPT | `apps/web` shell, rewritten smaller |
| B | Release stamp with checksum | DROP | Lockstep versions and `CHANGELOG.md` |
| B | API agent loop, provider client, tools | REWRITE | `@extalia/runtime` and `@extalia/host` (Extalia Native) |
| B | Native history parsers and discovery | ADAPT | `@extalia/importers`, `packages/host/src/nativeImport.ts` |
| B | Orchestration settings with model tiers | ADAPT | `Connection.orchestration` and `delegate_task` for the native agent |

## Planned

| From | Module | Class | Target | Phase |
| --- | --- | --- | --- | --- |
| A | Office scene, floors, rooms, furniture, prefabs | ADAPT | `packages/renderer`, `packages/office` with generic templates | 1 |
| A | Avatar system, wardrobe, animation | ADAPT | `packages/avatars` | 1 |
| A | Navigation, spatial allocation, desk queue | ADAPT | `packages/navigation` | 1 |
| A | Lighting, day/night, render budget, quality presets | ADAPT | `packages/renderer` | 1 |
| A | Character picking and quick actions | ADAPT | `packages/office` driven by protocol state | 1 |
| A | Runtime state contracts | REWRITE | Covered by `@extalia/protocol` and core state | 1–2 |
| A | Hermes runner and model catalog | REWRITE | `packages/adapter-hermes` (TypeScript, capability discovery) | 2 |
| B | Engine adapters for Claude Code, Codex, Gemini CLI and Hermes managed runs, with their orchestration presets | ADAPT | Runtime adapters next to Extalia Native | 2, 5 |
| A, B | Codex and Claude Code observers (transcripts, hooks) | ADAPT | Observers per [runtime-adapters.md](../architecture/runtime-adapters.md) | 2–4 |
| B | `connect`/`disconnect` installers with backups | ADAPT | `extalia connect` | 2–4 |
| A | Python runtime gateway and ingest endpoint | REWRITE | Bridge in TypeScript with authenticated loopback transport (ADR pending) | 2 |
| B | Linked import refresh and continue-as-new from an imported session | ADAPT | Host and Chat | 4 |
| B | Workbench: processes, terminal blocks, preview, git diff | ADAPT | Console, Terminal, Files, Git views | 5 |
| B | MCP server tools and agent instructions | REWRITE | Skills with capability manifests | 6 |
| A | Meeting rooms, semantic rooms | ADAPT | Room extension API | 7–8 |
| A | Console phase specs and agent console | ADAPT | Console view | 5 |

## Dropped

| From | Item | Reason |
| --- | --- | --- |
| A | Named persona placeholders and hardcoded agent, profile or building names | Personal identity; replaced by configuration (PRD §4.4) |
| A, B | Machine-local orchestration scripts and paths | Not portable |
| A, B | Personal integration settings (chat servers, note vault locations, router endpoints) | User data |
| A | Patch notes, hand-off prompts, archives, temporary assets | Prototype process artifacts |
| B | Presence forwarding to the prototype's gateway | Replaced by protocol events consumed directly by the office |
