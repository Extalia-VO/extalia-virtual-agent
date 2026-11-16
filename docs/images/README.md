# README previews

The GitHub [README](../../README.md) and [npm README](../../apps/cli/README.md)
share these animated WebP files. GitHub uses relative paths; npm uses the matching
public raw GitHub image URLs. Every animation loops automatically.

## Current feature captures

Recorded on **2026-11-16** from the current **v0.4.352** UI, source revision
`549bf98`, with a 1440 × 900 capture viewport. The feature clips use the actual
`App`, team editor, Chat, resource diagram, Office and Observe/handover components.
The campus clip uses the actual `OfficeCanvas` and registered scene assets.
These are recordings of the application, with in-memory demonstration data.

| File | Dimensions | Duration | Size | Content |
| --- | --- | --- | --- | --- |
| `campus-traffic.webp` | 1120 × 700 | 28.6 s | 14.57 MiB | Current campus tour; live traffic, daylight → dusk → night → dawn → daylight |
| `team-planning.webp` | 1440 × 900 | 25.6 s | 0.71 MiB | Allowed models, simulated AI team plan, responsibilities, model order and saving |
| `learning-meeting.webp` | 1440 × 900 | 19.9 s | 6.20 MiB | Idle learning countdown, three-member meeting and saved Knowledge receipt |
| `chat-subagents-skills.webp` | 1440 × 900 | 24.2 s | 0.68 MiB | Lead conversation, worker preview, skill/Knowledge flow, evidence and filtering |
| `observe-session.webp` | 1440 × 900 | 15.4 s | 1.34 MiB | Four agent apps, three projects, active child, reviewed handover and queued receipt |

The campus camera and lighting return to their opening state. Traffic advances
normally throughout; frames are not reversed for the return leg. The accelerated
solar preview runs through dusk, night and dawn, using the scene's automatic
lighting. Continuing vehicle IDs were checked for movement. The campus is
encoded at 1120 × 700; the four UI clips retain 1440 × 900 for readable controls.

The other clips visibly disclose **Demo · simulated data**, including inside
native dialog top layers. Planning responses, model choices, project content,
agent events, skill accesses, learning/export receipts and handover results are
synthetic. The learning preview includes an editorial cut from the idle countdown
to the ongoing meeting. Its saved note exists only in the in-memory demo vault.
The Observe handover ends at **Queued · consumption unknown**, preserving the
actual distinction between delivery and confirmed reading.

No user profile, real transcript, credentials or external-app configuration was
used or modified. These previews demonstrate UI behavior; they do not certify live
provider support, learning quality, handover consumption or rendering performance.

All five files were decoded in a browser and checked for changing frames, canvas
size, infinite-loop metadata and absence of EXIF/XMP metadata. Text/UI clips use
mixed lossless/lossy WebP at quality 88; the campus uses lossy WebP at quality 80.
Identical frames may merge without changing animation duration. Capture and
encoding evidence remains in the local `output/playwright/readme-features/`
workspace artifacts. No runtime code or model asset was changed.

## Retained previews

| File | Dimensions | Duration | Size | Content |
| --- | --- | --- | --- | --- |
| `extalia-deligating-teams.webp` | 800 × 520 | 24.6 s | 4.59 MiB | Existing team-delegation preview |
| `knowledge-graph.webp` | 1120 × 744 | 13.6 s | 2.17 MiB | 1,600 demonstration notes / 4,427 links; selection, detail and dragging |
| `skills-grimoire.webp` | 1120 × 946 | 18.3 s | 2.09 MiB | 42 sample books; shelf pagination, hover, opening and page turns |

These three previews are retained unchanged. The demonstration Grimoire is not
an inventory of shipped built-in skills. Application code and scene assets retain
the terms described in the main README and asset inventory.
