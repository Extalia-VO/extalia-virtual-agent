# System architecture

Current source baseline: **v0.4.288**. The architecture reference is
[overview](../architecture/overview.md); the [contract directory](../architecture/README.md)
and [ADRs](../adr/README.md) hold detailed boundaries and amendments.

## Event and dependency direction

```text
Managed runtime adapter / observed transcript, hook or MCP
    ↓
Extalia Protocol → session/task/agent state
    ↓
Shared Web/Desktop views and 3D Office
```

The dependency direction is `protocol ← core ← platform ← apps`. Renderer and UI
never import providers, runtimes or privileged host adapters. A hook event does
not grant control; observed actions require the exact capability of their route.

## Actual repository layout

| Location | Responsibility |
| --- | --- |
| `apps/web` | React UI and the shared Three.js/React Three Fiber Office |
| `apps/desktop` | Electron shell, preload and secure IPC |
| `apps/cli` | `extalia` command, authenticated local Bridge and MCP |
| `packages/protocol`, `core`, `platform` | Wire contracts, domain model and capability interfaces |
| `packages/runtime`, `host` | Managed loops/delegation and privileged host composition |
| `packages/importers`, `office` | Pure history parsers and spatial contracts |
| `crates/extalia-core`, `extalia-daemon` | Selected Rust stores, policy, indexes and supervised services |

The earlier proposed separate event-bus/workspace/sessions/renderer/avatar/UI/SDK
packages are not the current layout. An executable plugin host and public SDK
remain planned. Desktop uses Electron, not a parallel Tauri implementation.

## Process placement and capabilities

[ADR 0071](../adr/0071-rust-openai-completion-and-resource-evidence.md) keeps
production provider completion and ordinary orchestration in TypeScript after
measurement. Rust owns selected control/index/scanner/learning services; Python
is the pinned scanner worker on supported macOS ARM64 packages, not a generic
mission executor. UI remains presentation-only.

Desktop reaches native features through trusted preload/IPC; Web reaches them
through the local authenticated Bridge. A static Web bundle has no agent host.
Native command execution remains unavailable until a verified isolated executor
exists. Platform publication is not proof of every capability on every target.

Use [module documentation](../modules/README.md) for source/test navigation and
[PRD status](../product/README.md) for implemented and unfinished requirements.
