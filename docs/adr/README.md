# Architecture decision records

Important, hard-to-reverse choices are recorded here (PRD §42). Copy the format
of an existing record, number it sequentially and link it from the table.

| ADR | Decision | Status |
| --- | --- | --- |
| [0001](0001-clean-public-repository.md) | Clean public repository with selective migration | Accepted |
| [0002](0002-desktop-shell-electron.md) | Electron for the Desktop shell | Accepted (packaging decided in 0006) |
| [0003](0003-source-first-workspace-packages.md) | Workspace packages export TypeScript source | Accepted |
| [0004](0004-managed-and-observed-sessions.md) | Managed and observed sessions share one protocol | Accepted |
| [0005](0005-extalia-native-runtime.md) | Extalia Native runtime for API-only connections; memory and skills have one owner | Accepted |
| [0006](0006-updates-and-packaging.md) | Desktop auto-update with electron-builder; npm updates for the Web client | Accepted |

Open questions from PRD §44 (local database, Web ↔ Bridge transport and
authentication, plugin sandboxing, skill format, registry trust, event sourcing,
Obsidian write policy, license/trademark, DCO vs CLA) each get an ADR before
implementation.
