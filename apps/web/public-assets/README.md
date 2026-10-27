# Public Office models

The 16 project-authored scene models use the MIT license in [LICENSE.md](LICENSE.md).
Twelve existing Blender avatar exports retain their separate
[RenderHub asset license](AVATAR_SOURCE_LICENSE.md), with
[third-party attribution](THIRD_PARTY_NOTICES.md). Exact hashes, sizes and provenance
for all 28 models are recorded in [models.json](models.json). Web, Desktop and the
npm Bridge share this same inventory.

The furniture, floor, interior architecture, landscape, district and vehicle
libraries come from the checked-in Blender generators named in the inventory.
The building, terrace, elevator and roof exports are project-authored work
approved by the maintainer for redistribution with Extalia. Their original
Blender authoring scene is maintained separately; the reviewed GLBs are the
checked-in distribution sources, exported with `export-building-shell.py`.

After regenerating and reviewing approved local exports, run
`python3 tooling/blender/prepare-public-models.py`. This copies only the explicit
non-avatar inventory, removes empty review scenes and records new hashes. It
does not grant distribution rights to any other local file. Review geometry and
provenance before accepting a changed inventory.

Then run `python3 tooling/prepare-licensed-avatars.py` to retain the reviewed
existing avatar exports. Its pinned source inventory rejects changed input bytes;
it does not generate replacement humans or change the existing rig/wardrobe.
Two identical pairs of body variants share two physical GLBs; ten detailed hair
exports retain the original style fallback. Original full source packs remain local.

Source validation rejects missing, modified, symlinked or unregistered models,
external resources and private filesystem metadata. Production validation also
requires every registered model, this inventory and the license; no model is
inlined. CLI and Desktop packaging repeat the same check on the copied UI.

Unregistered avatar packs remain in the ignored `local-assets/avatars` directory.
Only the explicit development-server mode `local-assets` may add them as
fallbacks. Default Web and Desktop builds use the same registered Blender avatars,
regardless of extra local files on the build machine. Their third-party assets
are not offered as a standalone model collection or relicensed under MIT.
