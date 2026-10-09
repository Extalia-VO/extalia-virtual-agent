# Versioning and releases

- All workspace packages share one version (lockstep). `node tooling/check-versions.mjs`
  fails when they drift or when the changelog lacks the current version.
- Notable changes go under `## [Unreleased]` in `CHANGELOG.md` with the change.
- `pnpm version:patch` bumps every package and turns the Unreleased notes into
  a dated section for the new version. Run `pnpm check` afterwards.
- Pre-1.0 milestones follow the roadmap: `0.1.0-alpha` (Phases 0–2),
  `0.2.0-alpha` (Phase 3), `0.3.0-beta` (Phases 4–5), `0.4.0-beta` (Phases 6–7),
  `1.0.0` (Phase 8).
- Desktop releases: push a tag `v<version>` matching `apps/desktop/package.json`.
  The release workflow creates a draft GitHub release (tags with `-` become
  pre-releases), builds macOS (DMG + ZIP, arm64 and x64), Windows (NSIS) and
  Linux (AppImage + DEB) with electron-builder, and uploads them with update
  metadata. A maintainer reviews and publishes the draft. Optional signing
  secrets: `MAC_CSC_LINK`, `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`, `WIN_CSC_LINK`,
  `WIN_CSC_KEY_PASSWORD`. macOS auto-update needs signed builds.
- The stable update channel follows GitHub's latest (non-pre-release) release,
  so publish at least one regular release for stable users to receive updates.
- The CLI is published to npm as `extalia-vo` once maintainers enable it; users
  update with `extalia update`.
- Local packaging check: `CSC_IDENTITY_AUTO_DISCOVERY=false pnpm --filter @extalia/desktop dist:dir`.
