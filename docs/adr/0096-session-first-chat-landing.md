# ADR 0096: Session-first Chat landing page (amending app-flow Phase A1)

Status: Proposed — 2026-11-23 (amends [PRD app-flow Phase A1](../product/prd-app-flow-and-live-agents.md#phase-a-app-flow-and-modes--1-day); not yet implemented)

Resolves: `OQ-02` in [PRD-SF-1.0](../product/prd-session-first-coding-discord.md) (`DEC-01`, `DEC-08`, `INS-001..004`, `OFF-003`, `NFR-01`).

## Context

In the `v0.4.353` baseline, the application's post-setup and subsequent-launch landing rule follows the v0.0.20 (U6) revision of Phase A1 in [prd-app-flow-and-live-agents.md](../product/prd-app-flow-and-live-agents.md):

- **`apps/web/src/appMode.ts` (lines 60–71):** `resolveLandingPage({ agents })` ignores workflow mode and user preferences and unconditionally returns `input.agents ? 'office' : 'start'`.
- **`apps/web/src/App.tsx` (lines 30, 128–132, 182–186):**
  - `OfficePage` is eagerly imported (`import { OfficePage } from './pages/OfficePage'`), unlike secondary pages (`HistoryPage`, `KnowledgePage`, `SettingsPage`, `SkillsPage`, etc.) which use `React.lazy`.
  - `defaultPage` evaluates `resolveLandingPage({ agents: Boolean(agents) })`, so every launch and every `SetupWizard` completion (`if (next.setupComplete) setChosenPage(null)` at line 231) mounts the 3D Office immediately.
  - `navigationGroups` (lines 34–58 of `appMode.ts`) already exposes `'chat'` in `managed` mode regardless of workspace count (`chatAvailable` returns `input.agents && input.workflow === 'managed'`), while hiding `'chat'` in `'observe'` mode and without a host (`!agents`).
- **`apps/web/src/setup/SetupWizard.tsx` & `steps.ts`:**
  - `SetupWizard` already allows deferring workspace creation (`Skip workspace` → `workspaceDeferred = true`, line 374) and `canFinish` (`steps.ts:87`) already accepts a verified Native connection or available Hermes runtime with zero workspaces.
  - The final button (`SetupWizard.tsx:381`) still renders `<Icon name="monitor" />` with Office-oriented finish copy, which becomes misleading once managed mode lands in Chat.
- **`packages/host/src/profile.ts` & `apps/web/src/profileSync.ts`:**
  - `<dataDirectory>/config/profile.json` (`extalia.profile.v1`) stores shared interface preferences (`language`, `theme`, `material`, `font`, `sidebar`) synchronized across Desktop and Web Bridge, with safe field-by-field decoding (`decodeProfile`, `decodePreferences`) that drops unknown values cleanly.

Always mounting the 3D Office at startup introduces unnecessary WebGL/Three.js initialization overhead (startup time, idle GPU/RAM footprint) and adds an extra navigation step before users can type a prompt. At the same time, users in `observe`-only mode have no managed Chat workflow, hostless static Web builds have no host, and some managed users still prefer launching directly into the 3D Office.

## Decision

Amend Phase A1 of [prd-app-flow-and-live-agents.md](../product/prd-app-flow-and-live-agents.md) so that **managed hosts default to landing on `'chat'` (New Session composer)** after setup and on every subsequent launch, while keeping 3D Office one click away in primary navigation, offering an explicit `landingPage` preference in `config/profile.json`, and preserving honest landing behavior for `observe`-only and hostless static web modes.

### 1. Deterministic `resolveLandingPage` contract

Extend `LandingInput` and `resolveLandingPage` in `apps/web/src/appMode.ts`:

```ts
export type LandingPagePreference = 'chat' | 'office';

export interface LandingInput {
  /** Whether the host can run agents (false in the static web build). */
  agents: boolean;
  /** Active host workflow when known; defaults conservatively to 'managed'. */
  workflow?: Workflow;
  /** Optional shared profile preference (managed mode only). */
  preference?: LandingPagePreference;
}
```

Resolution rules (pure and deterministic):

| `agents` | `workflow` | `preference` | Returned `PageId` | Rationale |
| --- | --- | --- | --- | --- |
| `false` | any | any | `'start'` | Hostless static web build has no agent host; `Get started` stays honest (`INS-001`, `OFF-003`). |
| `true` | `'observe'` | any | `'office'` | Observe-only workflow has no managed Chat page (`navigationGroups` exposes `['office', 'observe']`); landing on `'office'` with `'observe'` one click away avoids a dead-end surface (`INS-003`, `AC-22`). |
| `true` | `'managed'` | omitted or `'chat'` | `'chat'` | Session-first default: opens the New Session composer immediately (`INS-001`, `INS-004`, `AC-01`, `AC-02`). |
| `true` | `'managed'` | `'office'` | `'office'` | Explicit user opt-in stored in `config/profile.json` (`INS-004`). |

Keep the rule that **arbitrary last-visited pages are never remembered** across restarts: launching the app always enters the deterministic landing page (no restoring stale `logs`, `diagnostics`, or `settings` tabs).

### 2. Initial Chat state on fresh launch (New Session composer)

- On initial shell mount in `managed` mode with `activePage === 'chat'`, initialize `selection` so the composer opens directly on a fresh **New Session** (`sessionId: null`) rather than silently reopening an old transcript:
  - When zero managed workspaces exist, `ChatPage` opens immediately in **Unassigned** mode (`workspaceId: null` per [ADR 0095](0095-unassigned-session-context.md)) with the composer focused and ready (`AC-01`).
  - When one or more managed workspaces exist, the New Session composer opens cleanly (`sessionId: null`) with an explicit context indicator showing whether the new session will start `Unassigned` or in a chosen workspace; `lastWorkspaceId` (`extalia.landing.v2` / `profile.clientState`) remains available for quick workspace switching without blocking immediate typing or forcing a workspace picker modal (a Slice B usability refinement can explore an optional composer default toggle for returning multi-workspace users).
- Existing saved sessions (both `Unassigned` and per-workspace trees) remain immediately selectable in the left session sidebar.

### 3. Primary navigation & on-demand 3D Office loading

- Update `navigationGroups` in `apps/web/src/appMode.ts` for `managed` mode so `work` leads with `['chat', 'office', ...]` (placing **Chat** first and **3D Office** right beside it, one click apart; `INS-004`). Observe-only mode keeps `['office', 'observe']`.
- Convert `OfficePage` in `apps/web/src/App.tsx` (currently eagerly imported at line 30) to a lazy-loaded chunk (`const OfficePage = lazy(() => import('./pages/OfficePage').then(...))`) wrapped by the existing `PageLoadBoundary`.
- Because `OfficePage` only mounts when `activePage === 'office'`, launching into `'chat'` avoids importing/initializing Three.js, WebGL contexts, and 3D scene assets until the user clicks **3D Office**, clicks a locate-in-office action, or opts into `landingPage: 'office'` (`INS-004`, `NFR-01`, `AC-01`).
- Switching between `'chat'` and `'office'` preserves active host sessions, streaming runs, and unsent composer drafts (`useComposerDraft`) and unmounts the 3D scene loop when leaving `'office'` (`OFF-003`, `OFF-006`).

### 4. Shared optional preference in `config/profile.json`

- Add `landingPage?: 'chat' | 'office'` to:
  - `ProfilePreferences` in `packages/platform/src/profile.ts` (or platform profile contract),
  - `PREFERENCE_KEYS` in `packages/host/src/profile.ts` (validated strictly against `['chat', 'office']` in `validPreference`),
  - `Preferences` and `decodePreferences` in `apps/web/src/preferences.ts` (default `'chat'`),
  - `PROFILE_FIELDS` in `apps/web/src/profileSync.ts` so Web Bridge and Desktop stay synchronized.
- Add a **Landing page** (`Chat` / `3D Office`) control under `Settings → General` (visible in `managed` mode, with EN/ID copy in `apps/web/src/i18n.ts`).
- Wait for authoritative `getProfile()` hydration before treating an absent local mirror as a saved override (already enforced by `useProfileSync` in `apps/web/src/profileSync.ts:124–133`). While `hostState` is loading, `Splash` covers the shell (`boot.phase === 'loading'`), so `workflow` and `preferences.landingPage` settle without a visible Office→Chat flicker.

### 5. `SetupWizard` and boot contract alignment

- Keep the existing `SetupWizard` workspace deferral (`Skip workspace` / `workspaceDeferred`) and `completeSetup('managed')` zero-workspace admission intact (`INS-001`, `INS-003`).
- Update the `done` step CTA copy and icon in `apps/web/src/setup/SetupWizard.tsx` (and `apps/web/src/i18n.ts`) based on the resolved destination (`INS-004`):
  - Managed mode → `Open Chat` / `Mulai Chat` (`<Icon name="chat" />`).
  - Observe-only mode → `Open 3D Office` / `Buka 3D Office` (`<Icon name="monitor" />`).
- Bump `BOOT_CONFIG_VERSION` in `apps/web/src/boot/bootState.ts` from `2` to `3` and update its doc comment to reflect session-first Chat landing.

### 6. Preserving deep-link and locate-in-office flows

- `locateOfficeRequest`, `locateInput`, and `locateAttention` in `apps/web/src/App.tsx` (lines 142–152) remain untouched in behavior: they explicitly call `setChosenPage('office')`, clear `missionFocus`, and dispatch scoped `inputFocus` so the 3D Office opens and focuses the requesting character (`INS-004`, `AC-23`).
- `OfficeAutoAttention` (`App.tsx:349`) retains `active={!splash && !host.error && hostState?.setupComplete === true && activePage === 'office'}`. When the user is working in `'chat'`, automatic camera attention does not hijack them into `'office'`; pending Native approvals and observed input prompts remain surfaced via the global topbar `ApprovalInboxButton` and `ObservedInputAlert`, where clicking **Locate in Office** explicitly invokes `locateInput`.
- Note on `App.tsx` `activePage` fallback (line 186): `const activePage = groups.some(group => group.pages.includes(page)) ? page : defaultPage;` naturally redirects an unavailable page (e.g. if the user switches workflow from `managed` to `observe` while on `'chat'`) to the honest `defaultPage` (`'office'`).

## Migration, backward compatibility, and rollback

- **Backward compatibility:** Existing `config/profile.json` files without `preferences.landingPage` decode cleanly and default to `'chat'` in `managed` mode. Older builds reading a `profile.json` containing `landingPage: 'chat'` or `'office'` ignore unknown preference keys cleanly in `decodeProfile()` (`packages/host/src/profile.ts:61`).
- **User-controlled opt-out (instant rollback):** Any user who prefers the pre-Slice-A landing experience can switch `Settings → General → Landing page` to `3D Office` with immediate effect across Desktop and Web Bridge.
- **Historical evidence preserved:** This ADR amends Phase A1 going forward without rewriting or deleting historical v0.0.20–v0.4.353 evidence in [prd-app-flow-and-live-agents.md](../product/prd-app-flow-and-live-agents.md).

## Verification requirements

Implementation of this ADR (WP-03, WP-12) requires the following automated verification before acceptance:

1. **Pure landing & navigation unit tests (`INS-001`, `INS-003`, `INS-004`, `AC-01`, `AC-02`, `AC-22`):** Extend `apps/web/test/` (`appMode` and `bootState` tests) to cover all combinations of `{ agents: false | true } × { workflow: 'managed' | 'observe' } × { preference: undefined | 'chat' | 'office' }`, plus `navigationGroups` ordering (`chat` before `office` in managed mode; no `chat` in observe/static mode).
2. **Profile persistence & sync tests (`INS-004`):** Extend `packages/host/test/` profile tests and `apps/web/test/` `profileSync` tests to verify `landingPage` validation (accept `'chat' | 'office'`, reject invalid values), atomic persistence in `config/profile.json`, and safe fallback on unknown values.
3. **Setup-to-Chat E2E (`INS-001`, `INS-003`, `INS-004`, `AC-01`, `REL-008`):** Temporary-host Playwright checks in EN/light (1280px) and ID/dark (390px) verifying `SetupWizard` with skipped workspace displays honest `Open Chat` / `Mulai Chat` CTA and lands directly on the focused New Session composer.
4. **No startup WebGL & 1-click Office toggle (`INS-004`, `OFF-003`, `NFR-01`):** Playwright startup check confirming that landing on `'chat'` mounts zero `<canvas>` / Three.js Office instances, clicking **3D Office** mounts the Office cleanly while retaining Chat drafts, and returning to **Chat** unmounts the Office render loop.
5. **Deep-link & locate-in-office regression (`INS-004`, `AC-23`, `AC-24`):** Verify that while landed on `'chat'`, clicking a locate action from `ObservedInputAlert` / approval notification switches `activePage` to `'office'` and delivers `inputFocus` to the target session/character without being blocked by the new default landing page, while passive background events do not hijack active Chat focus.
