# Office and spatial presentation

Audit baseline: **v0.4.288**, 2026-11-12. This module projects host sessions and
Extalia Protocol events; a moving avatar is not a separate runtime or proof of
work completion. Web and Desktop share the same renderer.

## Read by purpose

| Purpose | Documentation |
| --- | --- |
| Scene, appearance and development | [Office development](../design/office-development.md) |
| Selection, locate and follow | [Camera attention](../design/office-camera-attention.md), [character picking](../design/office-character-picking.md) |
| Walking and recovery | [Movement recovery](../design/office-movement-recovery.md), [natural walking review](../product/natural-walking-review.md), [door review](../product/door-movement-review.md), [static seating](../product/static-seating-review.md) |
| Furniture and environment | [Interior integration](../product/interior-blender-integration.md), [workstations](../product/workstation-blender-integration.md), [night coverage](../product/night-lighting-review.md) |
| Conversation presentation | [Shared messages](../design/chat-message-presentation.md), [observed messaging](../getting-started/observed-agent-messaging.md) |
| Asset provenance and distribution | [Public inventory](../../apps/web/public-assets/README.md), [packaging](../release/packaging.md#shared-public-scene-assets) |

Dated visual reviews and benchmark records preserve the scope they actually
checked; they are not fresh acceptance results for every later scene change.

## Implementation status

| Area | Status at this baseline | Remaining boundary |
| --- | --- | --- |
| Shared campus/F1–F3/All floors, appearance and portraits | Implemented | Public registered Blender-derived assets have their own licenses; procedural fallbacks remain. No claim that every visible primitive is a Blender asset. |
| Camera locate, live follow and request attention | Implemented | Explicit selection and manual zoom policies remain separate from automatic attention; phase-only external requests are coarse indicators. |
| Natural route curves, speed variation, door/chair/seat/lift coordination and crowd recovery | Implemented with bounded controllers and regression coverage | Authored navigation, portal/contact constraints and physical checks remain; this is not arbitrary free-space navigation or a universal physics solver. |
| Day/night fixtures, floor-bound lighting and adaptive drawing | Implemented | The controller targets 60 FPS and retains lower resolution only after a measured improvement. Full campus, crowd and physical-device throughput acceptance remains open. |
| Canvas resize continuity and scene recovery | Implemented | Graphics-context failures and development reloads are distinct from the repaired resize clear; recovery must preserve application drafts. |
| Facility, hospitality, fitness and leisure presentation | Implemented in authored interactions | Scene animations do not create new agent execution or prove an external action happened. |

## Source and regression map

- Presence/session projection: [presence.ts](../../apps/web/src/office/presence.ts)
  and [useOfficeEvents.ts](../../apps/web/src/office/useOfficeEvents.ts).
- Camera: [cameraDirector.ts](../../apps/web/src/office/cameraDirector.ts);
  [cameraAttention.test.ts](../../apps/web/test/cameraAttention.test.ts) and
  [followTransit.test.ts](../../apps/web/test/followTransit.test.ts).
- Walking: [naturalWalking.ts](../../apps/web/src/office/scene/movement/naturalWalking.ts),
  [crowdWatch.ts](../../apps/web/src/office/scene/movement/crowdWatch.ts),
  [doorChoreography.ts](../../apps/web/src/office/scene/movement/doorChoreography.ts)
  and [staticSeating.ts](../../apps/web/src/office/scene/movement/staticSeating.ts);
  [officeMovement.test.ts](../../apps/web/test/officeMovement.test.ts),
  [doorCrowdStress.test.ts](../../apps/web/test/doorCrowdStress.test.ts) and
  [chairHandlingGait.test.ts](../../apps/web/test/chairHandlingGait.test.ts).
- Assets: [sourceAssets.ts](../../apps/web/src/office/scene/avatars/sourceAssets.ts)
  prefers registered public body/hair URLs; [models.json](../../apps/web/public-assets/models.json)
  records 133 GLBs / 152,104,948 bytes before compression.
- Render limits and continuity: [renderBudget.ts](../../apps/web/src/office/scene/environment/renderBudget.ts),
  [CanvasContinuity.tsx](../../apps/web/src/office/scene/environment/CanvasContinuity.tsx),
  [canvasContinuity.test.ts](../../apps/web/test/canvasContinuity.test.ts) and
  [officeSceneRecovery.test.ts](../../apps/web/test/officeSceneRecovery.test.ts).

This audit inspected source and existing evidence; it did not rerun browser,
physical interaction, hardware FPS or long-duration scene acceptance.
