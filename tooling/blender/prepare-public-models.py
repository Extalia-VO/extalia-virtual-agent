"""Prepare the reviewed project-authored scene exports for public distribution.

Run after generating/reviewing the local Blender exports:
    python3 tooling/blender/prepare-public-models.py

Only the explicitly approved non-avatar files below are accepted. The building
exports are authored project assets approved for redistribution; their Blender
authoring scene is maintained separately. Other exports come from checked-in
geometry generators. No third-party avatar or hair pack is processed.
"""
import hashlib
import json
from pathlib import Path
import re
import struct

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "apps/web/local-assets"
DESTINATION = ROOT / "apps/web/public-assets"
GENERATORS = {
    "architecture/interior-architecture.glb": "create-architecture-library.py",
    "architecture/stair-library.glb": "create-stair-library.py",
    "floors/floor-panel.glb": "create-floor-panel.py",
    "furniture/office-chair-task.glb": "create-office-chairs.py",
    "furniture/office-chair-executive.glb": "create-office-chairs.py",
    "furniture/team-pod-desktop.glb": "create-team-pod-desktop.py",
    "furniture/workstation-set.glb": "create-workstation-set.py",
    "furniture/interior-library.glb": "create-interior-library.py",
    "landscape/campus-mobility.glb": "create-campus-mobility.py",
    "landscape/district-buildings.glb": "create-district-buildings.py",
    "landscape/exterior-landscape.glb": "create-exterior-assets.py",
}
BUILDING = ["extalia-shell", "roof-utilities", "roof-stair", "elevators", "terrace"]


def public_glb(source):
    data = source.read_bytes()
    magic, version, total = struct.unpack_from("<III", data)
    if magic != 0x46546C67 or version != 2 or total != len(data):
        raise ValueError("Invalid GLB header")
    length, kind = struct.unpack_from("<II", data, 12)
    if kind != 0x4E4F534A:
        raise ValueError("Expected GLB JSON chunk")
    document = json.loads(data[20:20 + length])
    # Blender also exported empty review scenes. Keep only the rendered scene;
    # never publish those review labels or authoring notes.
    scene_index = document.get("scene", 0)
    scenes = document.get("scenes", [])
    if not scenes or any(scene.get("nodes") for i, scene in enumerate(scenes) if i != scene_index):
        raise ValueError("Review assets with more than one populated scene manually")
    document["scenes"] = [scenes[scene_index]]
    document["scene"] = 0
    document["scenes"][0]["name"] = "Extalia scene assets"
    document["scenes"][0].pop("extras", None)
    document.setdefault("asset", {})["copyright"] = "Copyright (c) Extalia contributors. MIT license."
    for buffer in document.get("buffers", []):
        if "uri" in buffer:
            raise ValueError("Public scene buffers must be embedded")
    for image in document.get("images", []):
        if "uri" in image:
            raise ValueError("Public scene textures must be embedded")
    encoded = json.dumps(document, ensure_ascii=True, separators=(",", ":")).encode()
    if re.search(rb"(?:/Users/|/home/|[A-Za-z]:\\\\Users\\\\)", encoded):
        raise ValueError("Private path in model metadata")
    encoded += b" " * (-len(encoded) % 4)
    tail = data[20 + length:]
    total = 20 + len(encoded) + len(tail)
    return struct.pack("<IIIII", magic, version, total, len(encoded), kind) + encoded + tail


def main():
    entries = []
    approved = {**{f"building/{name}.glb": None for name in BUILDING}, **GENERATORS}
    # Validate and prepare every file before updating the public inventory.
    prepared = [(relative, generator, public_glb(SOURCE / relative))
                for relative, generator in sorted(approved.items())]
    for relative, generator, data in prepared:
        target = DESTINATION / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        provenance = ({"kind": "project-generated", "generator": "tooling/blender/" + generator}
                      if generator else {
                          "kind": "project-authored-export",
                          "exporter": "tooling/blender/export-building-shell.py",
                          "note": "Project-authored building; maintainer approved redistribution with Extalia. Authoring scene maintained separately.",
                      })
        entries.append({"path": relative, "sha256": hashlib.sha256(data).hexdigest(),
                        "bytes": len(data), "license": "MIT", "provenance": provenance})
    (DESTINATION / "LICENSE.md").write_bytes((ROOT / "LICENSE").read_bytes())
    (DESTINATION / "models.json").write_text(json.dumps({"schemaVersion": 1, "license": "MIT", "models": entries}, indent=2) + "\n")
    print(f"Prepared {len(entries)} reviewed public scene models ({sum(entry['bytes'] for entry in entries)} bytes)")


if __name__ == "__main__":
    main()
