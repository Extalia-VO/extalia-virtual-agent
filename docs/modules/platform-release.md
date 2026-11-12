# Platform, setup and release

Audit baseline: **v0.4.288**, 2026-11-12. Desktop, the Web client and CLI Bridge
share application state and renderer contracts. A static Web bundle alone
cannot reach project files or run agents.

## Read by purpose

| Purpose | Documentation |
| --- | --- |
| Install and first setup | [Getting started](../getting-started/README.md), [workspace boundaries](../getting-started/workspace-boundaries.md) |
| Storage and clean start | [Persistence inventory](../architecture/storage.md) |
| Platform and session ownership | [Platform contracts](../architecture/platform.md), [sessions](../architecture/sessions.md), [security](../architecture/security.md) |
| Build, sign and validate installers | [Packaging](../release/packaging.md), [versioning](../release/versioning.md) |
| Published baseline and limitations | [v0.4.288 release](../release/v0.4.288.md) |
| Native scope | [Native agent](native-agent.md), [skills](skills.md), [Knowledge/memory](knowledge-memory.md) |

## Implementation status

| Area | Status at this baseline | Remaining boundary |
| --- | --- | --- |
| Shared Web/Desktop setup and host profile | Implemented | Only one Bridge/Desktop process owns a profile at once; use a separate temporary profile for independent development. |
| Workspace folder selection and deferred setup | Implemented | Desktop uses the native picker; Web uses a host-backed directory browser. Skipping setup defers workspace selection, not host filesystem authority. |
| Test connection before catalog/model selection | Implemented | Discovery does not certify every model's tools, images, budget or inference behavior. |
| Desktop installers | Published for macOS ARM64/Intel, Windows x64 and Linux x64 | macOS previews are ad-hoc signed, not Apple-notarized; manual opening approval/replacement can be required. Linux ARM64 is a CLI daemon target, not a Desktop installer. |
| npm application and matching daemon packages | Published | Node.js is required for the CLI. Install `extalia-vo`; internal daemon packages alone are not the application. |
| Packaged Rust daemon and specific bundled Python scanner | Implemented with target limits | Verified SkillSpector execution is macOS 14+ ARM64 only. Other scanner targets fail closed; this is not a general Python executor. |
| Learning/artifact staging | Implemented on macOS/Linux | Windows automatic curation and note/skill staging remain unavailable; see [learning](../getting-started/automatic-learning.md). |
| Update/reconnect/recovery UI | Implemented | Development and ad-hoc macOS preview installations cannot use the ordinary automatic-install path. A fresh build does not update an already running host. |
| Broad release acceptance | Incomplete beyond recorded gates | Passing CI/clean-machine fixtures does not replace real-provider, device-performance or long-duration acceptance. v0.5 remains separately gated. |

## Source and regression map

- Setup: [SetupWizard.tsx](../../apps/web/src/setup/SetupWizard.tsx),
  [WorkspaceForm.tsx](../../apps/web/src/setup/WorkspaceForm.tsx),
  [DirectoryBrowser.tsx](../../apps/web/src/setup/DirectoryBrowser.tsx) and
  [connectionTestFlow.ts](../../apps/web/src/setup/connectionTestFlow.ts);
  [setupFlow.test.ts](../../apps/web/test/setupFlow.test.ts) and
  [connectionTestFlow.test.ts](../../apps/web/test/connectionTestFlow.test.ts).
- Desktop ownership/security/update: [agentsIpc.ts](../../apps/desktop/src/agentsIpc.ts),
  [security.ts](../../apps/desktop/src/security.ts), [updater.ts](../../apps/desktop/src/updater.ts);
  [agentsLifecycle.test.ts](../../apps/desktop/test/agentsLifecycle.test.ts),
  [security.test.ts](../../apps/desktop/test/security.test.ts) and
  [updatePolicy.test.ts](../../apps/desktop/test/updatePolicy.test.ts).
- Distribution checks: [release workflow](../../.github/workflows/release.yml),
  [clean-machine-smoke.mjs](../../tooling/clean-machine-smoke.mjs),
  [daemon.mjs](../../tooling/daemon.mjs) and
  [public-models.mjs](../../tooling/public-models.mjs).

The v0.4.288 release record documents twelve passing Release jobs and scoped
npm installation verification. This documentation audit did not rerun installers,
notarization, vendor certification or hardware acceptance.
