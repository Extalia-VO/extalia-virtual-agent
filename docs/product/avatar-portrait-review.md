# Shared character portraits and expressions

Board, lead-card, character-popover, team and message-dialog portraits use `CharacterBody`, the same renderer as the furnished Office. Presence id, name identity, saved appearance and appearance-editor draft flow through the same resolution path. Face geometry, source/procedural model selection, hair, wardrobe, skin and material colors are shared. Studio lighting keeps the small portrait legible independently of the Office's day/night lighting.

All visible portraits use one detached WebGL renderer. Duplicate targets for the same character/look share one model scene and receive copies of the same frame. Offscreen models unmount; offscreen targets, background documents and reduced-motion portraits stop scheduling animation. Initial loading or graphics failure retains the existing lightweight illustration. Absent or failed local models use the same procedural character fallback as the Office.

Expressions are cosmetic: no runtime status or task progress is inferred or changed. Actual scene activity is read through a per-character motion binding. A shared monotonic clock and seeded pure facial pose keep blink/gaze phases aligned across separately rendered views. Working characters use restrained focused brows; waiting/idle characters have softer gaze, heavier lids and occasional gentle yawns. Reduced motion disables cosmetic motion. Local canonical models have no authored eye/jaw bones, so narrowly gated cached runtime shapes move their lids, mouth and brows; unknown replacement geometries are left unchanged.

## Verification

- Actual source-model portraits render on board, lead card, character card and message-dialog header. Six characters with up to eleven target canvases use one portrait WebGL context. Male/female open-eye, closed-eye and gentle-yawn frames were visually inspected.
- Editing hair to blonde and the top to burgundy through the live appearance editor produces identical visible mesh/material/color signatures in the actual Office and portrait. Cancel restores the original look. Duplicate views remain deduplicated.
- Dialog portraits were inspected in light/dark themes and at 390-pixel width. Reduced-motion, all-targets-offscreen and background-document checks show no advancing portrait frames. Simulated context loss restores eleven illustration fallbacks and stops the renderer.
- Procedural-only mode and deliberately failed local body requests both render character portraits through the shared procedural fallback.
- Focused tests cover appearance keys, deduplication, scheduling/lifetime, source shape isolation/immutability, shared state/phase, idle gestures and reduced motion.
- Version 0.4.87 verified on 2026-10-24: full `pnpm check` passes, including lint, boundaries, public safety, schemas, workspace types, 234 test suites / 2,560 passed tests (one skipped), Rust checks, Web/Desktop/CLI builds, version consistency and canonical hair assets. The five focused avatar/appearance suites pass all 29 tests.

Local screenshot/probe artifacts are not committed. Third-party model assets remain local-only.
