"""Prepare the reviewed scene and campus-vehicle exports for public distribution.

Run after generating/reviewing the local Blender exports:
    python3 tooling/blender/prepare-public-models.py

Only the explicitly approved non-avatar files below are accepted. The building
exports are authored project assets approved for redistribution; their Blender
authoring scene is maintained separately. Other MIT exports come from checked-in
geometry generators. Campus cars are simplified derivatives of third-party
reference models (`prepare-campus-vehicles.py`); each keeps its own license and
the credits in THIRD_PARTY_NOTICES.md. Existing avatar entries are retained
unchanged; no third-party avatar or hair pack is processed here.
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
    "landscape/campus-parking.glb": "create-campus-parking.py",
    "landscape/district-buildings.glb": "create-district-buildings.py",
    "landscape/exterior-landscape.glb": "create-exterior-assets.py",
}
BUILDING = ["extalia-shell", "roof-utilities", "roof-stair", "elevators", "terrace"]
CATALOG = ROOT / "tooling/blender/campus-vehicles.json"
VEHICLE_MANIFEST = SOURCE / "vehicles/vehicles.manifest.json"
RUNTIME_CATALOG = ROOT / "apps/web/src/office/scene/campusVehicles.json"
NOTICES = DESTINATION / "THIRD_PARTY_NOTICES.md"
PARKING_LAYOUT = SOURCE / "landscape/campus-parking.layout.json"
RUNTIME_PARKING = ROOT / "apps/web/src/office/scene/campusParkingLots.json"
NOTICE_START, NOTICE_END = "<!-- campus-vehicles:start -->", "<!-- campus-vehicles:end -->"
VEHICLE_EXPORTER = "tooling/blender/prepare-campus-vehicles.py"
VEHICLE_LICENSES = {"CC-BY-4.0", "CC-BY-NC-4.0", "CC-BY-NC-SA-4.0", "LicenseRef-RenderHub-Extended-Use",
                    "LicenseRef-Sketchfab-Standard", "LicenseRef-Owner-Provided-Unverified"}
# Non-commercial derivatives keep their licence (ShareAlike: the same CC-BY-NC-SA-4.0) and are
# flagged in the runtime catalog, like unverified ones, so one switch can leave them out.
NON_COMMERCIAL = {"CC-BY-NC-4.0", "CC-BY-NC-SA-4.0"}
UNVERIFIED = "LicenseRef-Owner-Provided-Unverified"
MIT_COPYRIGHT = "Copyright (c) Extalia contributors. MIT license."
SPEC_KEYS = ("length", "width", "height", "wheel", "wheelbase", "track")


def ascii_title(title):
    # GLB metadata stays plain ASCII; the notices keep the original spelling.
    return title.replace("\u00e1", "a")


def vehicle_copyright(license, title):
    if license.startswith("CC-BY"):
        restriction = " Non-commercial use only." if license in NON_COMMERCIAL else ""
        return (f"Based on \"{ascii_title(title)}\", licensed under {license}; simplified, debadged "
                f"and recoloured for Extalia.{restriction} See THIRD_PARTY_NOTICES.md.")
    if license == "LicenseRef-Sketchfab-Standard":
        return (f"Simplified, debadged derivative of \"{ascii_title(title)}\" (Sketchfab Standard licence). "
                "Not MIT-licensed. See THIRD_PARTY_NOTICES.md.")
    if license == UNVERIFIED:
        return (f"Simplified, debadged derivative of the {ascii_title(title)} reference model; author and licence "
                "pending owner confirmation. Not MIT-licensed. See THIRD_PARTY_NOTICES.md.")
    return (f"Simplified, debadged derivative of the {ascii_title(title)} reference model (RenderHub free download, "
            "Extended Use License). Not MIT-licensed. See THIRD_PARTY_NOTICES.md.")


def load_vehicle_catalog():
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    for entry in catalog["vehicles"]:
        if not re.fullmatch(r"[a-z][a-z0-9-]*", entry["style"]) or entry["license"] not in VEHICLE_LICENSES \
                or entry["notice"] not in catalog["notices"] or entry["category"] not in ("ev", "conventional"):
            raise ValueError(f"Invalid campus vehicle catalog entry: {entry.get('style')}")
    return catalog


def vehicle_notices(catalog):
    """The generated "Campus vehicles" section of THIRD_PARTY_NOTICES.md."""
    lines = [NOTICE_START, "## Campus vehicles", "",
             "The passenger cars in `vehicles/` are simplified derivatives of third-party reference",
             "models, made with `tooling/blender/prepare-campus-vehicles.py` from the catalog",
             "`tooling/blender/campus-vehicles.json`: the interior, badges, logos, lettering and",
             "number-plate text were removed, the geometry was reduced to about 6,000 triangles",
             "(about 10,700 for the traffic-only rigid truck),",
             "wheels were replaced by one generic wheel, and all textures and source colours were",
             "replaced by plain role colours. They are not covered by the project's MIT license;",
             "each file keeps the license recorded for it in models.json.", "",
             "Brand and model names below only identify the reference model. They are trademarks",
             "of their respective owners; no badge or brand mark is reproduced, and no affiliation",
             "or endorsement is implied.", "",
             "Files under CC-BY-NC-4.0 or CC-BY-NC-SA-4.0 are for non-commercial use only; the",
             "ShareAlike derivatives are shared under the same CC-BY-NC-SA-4.0 licence."]
    # The unverified-licence sentence only appears while some car still uses that licence.
    if any(entry["license"] == UNVERIFIED for entry in catalog["vehicles"]):
        lines += ["Files marked LicenseRef-Owner-Provided-Unverified have no recorded author or licence yet",
                  "(pending owner confirmation). Building with EXTALIA_COMMERCIAL_ASSETS_ONLY=1 keeps both",
                  "groups out of parking and traffic (see README.md).", ""]
    else:
        lines += ["Building with EXTALIA_COMMERCIAL_ASSETS_ONLY=1 keeps them out of parking and traffic",
                  "(see README.md).", ""]
    for key, notice in catalog["notices"].items():
        cars = [entry for entry in catalog["vehicles"] if entry["notice"] == key]
        if not cars:
            continue
        lines += [f"### {cars[0]['license']} ({key})", "", notice["text"], ""]
        for entry in cars:
            lines.append(f"- `vehicles/{entry['style']}.glb` ({entry['license']}): {entry['title']}; "
                         f"source archive: {entry['archive']}. {notice['item']}")
        lines.append("")
    return "\n".join(lines + [NOTICE_END]) + "\n"


def write_notices(catalog):
    text = NOTICES.read_text(encoding="utf-8")
    section = vehicle_notices(catalog)
    if NOTICE_START in text:
        head, rest = text.split(NOTICE_START, 1)
        text = head + section + rest.split(NOTICE_END, 1)[1].lstrip("\n")
    else:
        text = text.rstrip("\n") + "\n\n" + section
    NOTICES.write_text(text, encoding="utf-8")


def prepare_vehicles(catalog):
    """Publish every catalog car (local export, or the already reviewed public file)."""
    manifest = json.loads(VEHICLE_MANIFEST.read_text()) if VEHICLE_MANIFEST.exists() else {}
    published = json.loads((DESTINATION / "models.json").read_text())["models"]
    previous = {entry["path"]: entry for entry in published}
    prepared, runtime = [], []
    for entry in catalog["vehicles"]:
        relative = f"vehicles/{entry['style']}.glb"
        local = SOURCE / relative
        if local.exists():
            data = public_glb(local, vehicle_copyright(entry["license"], entry["title"]))
            stats = manifest[f"mobility-{entry['style']}"]
        elif (DESTINATION / relative).exists() and relative in previous and RUNTIME_CATALOG.exists():
            print(f"Keeping the reviewed public {relative}: no local export")
            data = (DESTINATION / relative).read_bytes()
            stats = {"spec": next(v["spec"] for v in json.loads(RUNTIME_CATALOG.read_text())["vehicles"] if v["style"] == entry["style"])}
        else:
            raise FileNotFoundError(f"{relative}: run prepare-campus-vehicles.py for this catalog entry first")
        prepared.append((relative, entry, data))
        flags = {"trafficOnly": True} if entry.get("placement") == "traffic-only" else {}
        if entry["license"] in NON_COMMERCIAL:
            flags["nonCommercial"] = True
        if entry["license"] == UNVERIFIED:
            flags["licenseUnverified"] = True
        runtime.append({"style": entry["style"], "model": f"mobility-{entry['style']}", "category": entry["category"],
                        "weight": entry["weight"], **flags, "spec": {key: stats["spec"][key] for key in SPEC_KEYS}})
    return prepared, runtime


def public_glb(source, copyright=MIT_COPYRIGHT, sanitize_original=False):
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
    document.setdefault("asset", {})["copyright"] = copyright
    if sanitize_original:
        # Source attribution URLs live in the notices. Runtime model metadata contains only
        # embedded resources and the narrowly declared wardrobe features.
        document['asset'].pop('extras', None)
        allowed = {'extaliaWardrobeCoverage', 'extaliaNativeFootwear', 'extaliaOwnNeckline', 'extaliaOwnHands', 'extaliaOwnEyewear'}
        for node in document.get('nodes', []):
            extras = {key: value for key, value in node.get('extras', {}).items() if key in allowed}
            if extras:
                node['extras'] = extras
            else:
                node.pop('extras', None)
        for material in document.get('materials', []):
            material.pop('extras', None)
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


def publish_parking_layout():
    """The runtime parking data comes from the same Blender markers as campus-parking.glb."""
    layout = json.loads(PARKING_LAYOUT.read_text(encoding="utf-8"))
    if [lot["id"] for lot in layout["lots"]] != ["west", "east"] or not all(lot["bays"] and len(lot["aisle"]) >= 2 for lot in layout["lots"]):
        raise ValueError("campus-parking.layout.json: expected the west and east lots with bays and an aisle")
    layout["$comment"] = ("Generated by tooling/blender/prepare-public-models.py from the layout markers of "
                          "tooling/blender/create-campus-parking.py; do not edit.")
    RUNTIME_PARKING.write_text(json.dumps(layout, indent=2) + "\n", encoding="utf-8")


STAFF_UNIFORM_MANIFEST = SOURCE / "avatars/outfits/staff-uniforms.manifest.json"
STAFF_UNIFORM_EXPORTER = "tooling/blender/create-staff-uniforms.py"
AVATAR_LICENSE = "LicenseRef-RenderHub-Extended-Use"


def staff_uniform_entries():
    """Staff uniforms (create-staff-uniforms.py): derivatives of the licensed avatar outfit, so they
    keep its RenderHub licence. Returns (relative path, bytes) pairs, checked like other exports."""
    if not STAFF_UNIFORM_MANIFEST.exists():
        return []
    manifest = json.loads(STAFF_UNIFORM_MANIFEST.read_text(encoding="utf-8"))
    prepared = []
    public_manifest = DESTINATION / 'models.json'
    existing = json.loads(public_manifest.read_text()).get('models', []) if public_manifest.exists() else []
    original_paths = {entry['path'] for entry in existing
                      if entry.get('provenance', {}).get('exporter', '').startswith('tooling/blender/fit-original-')}
    for item in manifest["uniforms"]:
        relative = item["path"]
        if relative in original_paths:
            continue  # A general scene rebuild must not replace a reviewed original uniform with its fallback.
        if not re.fullmatch(r"avatars/outfits/(male|female)/[a-z0-9-]+-uniform\.glb", relative) or item.get("license") != AVATAR_LICENSE:
            raise ValueError(f"Unexpected staff uniform entry: {relative}")
        data = (SOURCE / relative).read_bytes()
        if len(data) != item["bytes"]:
            raise ValueError(f"Staff uniform changed after export: {relative}")
        length = struct.unpack_from("<I", data, 12)[0]
        document = json.loads(data[20:20 + length])
        if any(document.get(key) for key in ("images", "textures", "animations")) or len(document.get("buffers", [])) != 1:
            raise ValueError(f"Unexpected content in staff uniform: {relative}")
        prepared.append((relative, data, item))
    return prepared


def publish_staff_uniforms(entries=None):
    """Copy the staff uniforms and record them; with no `entries`, update models.json in place."""
    prepared = staff_uniform_entries()
    records = []
    for relative, data, item in prepared:
        target = DESTINATION / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        records.append({"path": relative, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "license": AVATAR_LICENSE,
                        "provenance": {"kind": "licensed-avatar-export", "exporter": STAFF_UNIFORM_EXPORTER,
                                       "note": f"Staff uniform ({item['role']}, {item['group']}) cut from the licensed avatar's scanned outfit "
                                               "with project-generated accessories. Asset terms are recorded in THIRD_PARTY_NOTICES.md."}})
    if entries is not None:
        return records
    manifest_path = DESTINATION / "models.json"
    manifest = json.loads(manifest_path.read_text())
    paths = {record["path"] for record in records}
    manifest["models"] = [entry for entry in manifest["models"] if entry["path"] not in paths] + records
    manifest["models"].sort(key=lambda entry: entry["path"])
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Published {len(records)} staff uniforms ({sum(record['bytes'] for record in records)} bytes)")
    return records


def main():
    entries = []
    approved = {**{f"building/{name}.glb": None for name in BUILDING}, **GENERATORS}
    # Validate and prepare every file before updating the public inventory.
    prepared = [(relative, generator, public_glb(SOURCE / relative))
                for relative, generator in sorted(approved.items())]
    catalog = load_vehicle_catalog()
    vehicles, runtime = prepare_vehicles(catalog)
    (DESTINATION / "vehicles").mkdir(exist_ok=True)
    for stale in (DESTINATION / "vehicles").glob("*.glb"):
        # Only catalog cars are published; a renamed or retired style leaves no stray model.
        if f"vehicles/{stale.name}" not in {relative for relative, _entry, _data in vehicles}:
            stale.unlink()
    for relative, entry, data in vehicles:
        (DESTINATION / relative).write_bytes(data)
        entries.append({"path": relative, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "license": entry["license"],
                        "provenance": {"kind": "third-party-derived", "exporter": VEHICLE_EXPORTER,
                                       "note": f"Simplified, debadged and recoloured campus car ({entry['style']}, {entry['category']}) "
                                               f"derived from {ascii_title(entry['title'])}. Source and credit are recorded in THIRD_PARTY_NOTICES.md."}})
    write_notices(catalog)
    publish_parking_layout()
    RUNTIME_CATALOG.write_text(json.dumps({"$comment": "Generated by tooling/blender/prepare-public-models.py from campus-vehicles.json; do not edit.",
                                           "vehicles": runtime}, indent=2) + "\n")
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
    # Licensed avatars are maintained by prepare-licensed-avatars.py; keep them as they are.
    existing = json.loads((DESTINATION / "models.json").read_text())["models"]
    uniforms = publish_staff_uniforms(entries)
    entries += [entry for entry in existing if entry["path"].startswith("avatars/") and entry["path"] not in {u["path"] for u in uniforms}]
    entries += uniforms
    entries.sort(key=lambda entry: entry["path"])
    (DESTINATION / "models.json").write_text(json.dumps({"schemaVersion": 1, "license": "MIT", "models": entries}, indent=2) + "\n")
    print(f"Prepared {len(entries)} reviewed public models ({sum(entry['bytes'] for entry in entries)} bytes)")


if __name__ == "__main__":
    import sys
    if "--staff-uniforms" in sys.argv:
        publish_staff_uniforms()
        raise SystemExit(0)
    main()
