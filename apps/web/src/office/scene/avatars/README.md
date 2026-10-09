# Office characters

`OfficeCharacter` restores the original procedural office humanoid geometry:
layered sculpted hair, face and ears, textured eyes, articulated hands and
fingers, wardrobe cuts and trims, cuff details, and shaped shoes. Appearance,
rig, wardrobe, face and texture helpers are renderer-local extractions of the
original implementation. No source-derived GLB or externally licensed model is
bundled. Textures are generated locally and shared between instances.

`CharacterAppearance` is a customization contract independent of runtime state.
Generic defaults are seeded only from presence `id`, never names or providers.
It supports presentation, stature, height, skin and hair colors, hair cuts,
clothing presets and colors, glasses, headphones, badge, and watches. Props and
bags remain future extensions; corresponding retained type fields do not imply
renderer support.

The status ring retains reported presence colors, and selection has a separate
ring. Standing, a 45 cm seated pose, idle movement and subtle typing hand
movement are supported. Typing requires a managed, running, working presence.
Reduced motion disables cosmetic movement including facial blinks. Walking,
navigation, gait styles and saved per-agent appearance settings remain future
work. Animation never creates task state or progress.
