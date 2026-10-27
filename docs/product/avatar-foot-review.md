# Avatar foot continuity review

The formal local outfits contained an oversized bare instep and forward-flared
trouser cuffs in their rest geometry. The shoes themselves were correctly
shaped. The visible skin and shoe vertices already shared the foot joint, so a
general weight change would not remove the extra silhouette.

`sourceFootGeometry.ts` creates cached geometry copies for the canonical formal
`ScanOutfit` only. The cuff envelope comes from the clean calf ring above the
ankle. Exposed distal skin is compressed smoothly toward the ankle in X/Z while
retaining its height and a positive deformation slope. The upper ankle is
untouched. Shoes, weights, UVs, indices, morph data and casual outfits retain
their source geometry. No local model file is rewritten.

SourceHumanoid measures the active outfit's sole rather than treating the body
origin as the floor. Seated legs use ankle-to-sole clearance and the actual
blended hip height. Feet stay level through stationary sit/stand transitions;
standing uses the authored hip height. These changes keep seated hip and hand
contacts fixed. Walking retains its existing gait and foot rotation.

Synthetic tests cover both sides, transformed meshes, untouched shoe data,
wardrobe isolation, caching, monotone skin compression and sole clearance.
Browser review uses the actual detailed female/male models, side/front views,
seven sit/stand blend positions and four walk phases. The transition check
allows 12 mm for the existing cosmetic sway and authored orientation; walk
phases check finite geometry, not full locomotion foot planting.

The focused run passed 16 tests across geometry fitting, cloth weights and seat
contact. Web and Desktop builds passed. Xcode's command lookup failed on this
machine; Rust formatting, clippy and tests passed with the installed compiler,
archiver and SDK selected explicitly for the check process. No persistent
toolchain settings were changed. Desktop startup smoke was not run because its
current automatic connection path can inspect or edit the real Hermes profile;
the browser review used isolated mock data instead.

Final `pnpm check` passed with those process-local Xcode overrides: 189 test
suites / 1,881 tests, Rust gate, lint, boundaries, type checks, web/Desktop builds,
version consistency and local asset validation. Both model reviews kept seated
soles within 0.01 mm of the floor and sampled transitions within 7 mm.
