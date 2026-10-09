# ADR 0002: Electron for the Desktop shell

Status: Accepted; the packaging toolchain was decided in [ADR 0006](0006-updates-and-packaging.md)

## Context

Desktop targets macOS (arm64, x64), Windows x64 and Linux x64 and must share UI
and domain code with Web (PRD §5). The office renderer depends on WebGL 2 and
consistent behavior across platforms. The team works in TypeScript.

## Decision

The Desktop shell uses Electron. The renderer loads the same build as Web from
a privileged `extalia://app` protocol. Native features reach the renderer only
through a preload bridge implementing platform capabilities, with
`contextIsolation`, `sandbox` and no Node integration.

The packaging and update toolchain (Electron Forge or an alternative) is still
open (PRD §44) and will be decided with release work (signing, notarization,
DMG/installer/AppImage/DEB).

Alternatives considered: Tauri (smaller binaries, but system WebViews differ
per OS, which matters for the 3D renderer, and it adds a Rust toolchain for
contributors).

## Consequences

- One Chromium version across desktop platforms; larger downloads.
- Electron security settings are verified by `pnpm test:desktop` and unit tests
  for navigation and file-serving rules.
- Electron updates are tracked by Dependabot; new releases are adopted after
  pnpm's minimum release age.
