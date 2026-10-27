# Virtual Office adaptation status

Extalia Virtual Agent is the canonical renderer for Web and Desktop. Compare
remaining changes from the earlier Virtual Office manually and adapt them here.
There is no automatic overwrite or synchronization between the projects.

| Feature | Current adaptation |
| --- | --- |
| Campus, exterior, roof and green branding | Source geometry bundled in the shared renderer |
| F1, F2, F3 rooms, furniture and decorations | Source geometry, floor/cutaway selection and authored chair anchors |
| Characters | Procedural characters in the public build. Local-only source models (git-ignored, not redistributable) add wardrobe/hair slots, morphs and the skeletal seat/typing pose on machines that have them |
| Character conversations | Own session history, managed prompt/stop/approval controls; read-only worker/native-observer activity |
| Appearance | Saved preferences and preview editor shared with character appearance contracts |
| Glass elevators and exterior stairs | Original models and elevator controller restored |
| Agent panel | More opaque blurred surface, animated collapse/expand |
| Prompt with no active agent | Office prompt dock creates a managed session in the chosen workspace |
| Activity notifications | Protocol-derived bottom toasts and timed character bubbles |
| First load | Engine/scene/first-frame loading stages; model and texture load completion |
| Sidebar | Narrow Office rail; hover/focus overlay expansion without canvas resize |
| Walking, navigation and facility routines | Remaining adaptation: automatic walking, floor travel, elevator riders, and post-task facility behavior |

Restored elevator geometry does not imply that automatic character travel has
been implemented. Spatial behavior must consume actual session/presence events,
retain navigation clearance and capacity checks, and use the same configured
appearance/gait in both application variants. Do not fabricate model activity to
demonstrate movement.
