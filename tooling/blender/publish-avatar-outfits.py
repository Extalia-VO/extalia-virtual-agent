"""Publish the reviewed avatar outfit exports with their licences and credits.

Run after `prepare-avatar-outfits.py` (Blender) wrote `apps/web/local-assets/avatars/outfits`:
    python3 tooling/blender/publish-avatar-outfits.py

Every processed catalog entry (`avatar-outfits.json`; entries marked `"status": "skip"` are left
out) is copied to `apps/web/public-assets/avatars/outfits/<group>/<id>.glb` with a copyright line
in its glTF metadata, registered in `models.json` (licence and provenance) and credited in the
"Avatar outfits" section of `THIRD_PARTY_NOTICES.md` (title, author, source URL, licence and
modifications). A reviewed public file without a local export is kept as it is. Files of other
exporters (the staff uniforms) are never touched.
"""
import hashlib
import importlib.util
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[2]
CATALOG = ROOT / "tooling/blender/avatar-outfits.json"
SOURCE = ROOT / "apps/web/local-assets/avatars/outfits"
DESTINATION = ROOT / "apps/web/public-assets"
NOTICES = DESTINATION / "THIRD_PARTY_NOTICES.md"
EXPORTER = "tooling/blender/prepare-avatar-outfits.py"
NOTICE_START, NOTICE_END = "<!-- avatar-outfits:start -->", "<!-- avatar-outfits:end -->"
LICENSES = {"CC-BY-4.0", "LicenseRef-RenderHub-Extended-Use", "LicenseRef-Sketchfab-Standard", "LicenseRef-Owner-Provided-Unverified"}
UNVERIFIED = "LicenseRef-Owner-Provided-Unverified"

_spec = importlib.util.spec_from_file_location("prepare_public_models", ROOT / "tooling/blender/prepare-public-models.py")
_public = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_public)


def ascii_text(text):
    return text.encode("ascii", "ignore").decode()


def copyright_line(entry):
    title = ascii_text(entry["title"])
    if entry["license"] == "CC-BY-4.0":
        return (f"Based on \"{title}\", licensed under CC-BY-4.0; refitted, re-rigged, simplified and recoloured "
                "for Extalia. See THIRD_PARTY_NOTICES.md.")
    if entry["license"] == "LicenseRef-Sketchfab-Standard":
        return f"Refitted, simplified derivative of \"{title}\" (Sketchfab Standard licence). Not MIT-licensed. See THIRD_PARTY_NOTICES.md."
    if entry["license"] == UNVERIFIED:
        return (f"Refitted, simplified derivative of the {title} reference garment; author and licence pending owner "
                "confirmation. Not MIT-licensed. See THIRD_PARTY_NOTICES.md.")
    return (f"Refitted, simplified derivative of the {title} garment (RenderHub free download, Extended Use License). "
            "Not MIT-licensed. See THIRD_PARTY_NOTICES.md.")


def load_catalog():
    catalog = json.loads(CATALOG.read_text(encoding="utf-8"))
    for entry in catalog["outfits"]:
        if not re.fullmatch(r"outfit-[a-z0-9-]+", entry["id"]) or entry["group"] not in ("male", "female") \
                or entry["license"] not in LICENSES or entry["notice"] not in catalog["notices"]:
            raise ValueError(f"Invalid avatar outfit entry: {entry.get('id')}")
    return catalog


def notices_section(catalog, published):
    if not published:
        return (NOTICE_START + "\n## Avatar outfits\n\n"
                "Downloaded garment conversions remain local review assets: their sleeve/body correspondence\n"
                "and seated fit have not passed publication review. The active body-fitted separates are\n"
                "listed under Original avatar garments; facility uniforms retain their own notices.\n\n" + NOTICE_END + "\n")
    lines = [NOTICE_START, "## Avatar outfits", "",
             "The wearable outfits in `avatars/outfits/<male|female>/outfit-*.glb` are derivatives of",
             "third-party garment models, made with `tooling/blender/prepare-avatar-outfits.py` from the",
             "catalog `tooling/blender/avatar-outfits.json`: each garment was refitted to the Extalia",
             "avatar body, re-rigged to its 20-joint skeleton, reduced to a few thousand triangles, split",
             "into tint zones, and its textures, logos and lettering were removed. Shoes, trousers or a",
             "base top missing from a download come from the body's own licensed scan outfit. They are",
             "not covered by the project's MIT license; each file keeps the license recorded for it in",
             "models.json.", ""]
    if any(entry["license"] == UNVERIFIED for entry in published):
        lines += ["Files marked LicenseRef-Owner-Provided-Unverified have no recorded author or licence yet",
                  "(pending owner confirmation).", ""]
    for key, notice in catalog["notices"].items():
        entries = [entry for entry in published if entry["notice"] == key]
        if not entries:
            continue
        lines += [f"### {entries[0]['license']} ({key})", "", notice["text"], ""]
        for entry in entries:
            lines.append(f"- `avatars/outfits/{entry['group']}/{entry['id']}.glb` ({entry['license']}): {entry['title']}; "
                         f"source file: {entry['archive']}. {notice['item']}")
        lines.append("")
    return "\n".join(lines + [NOTICE_END]) + "\n"


def write_notices(section):
    text = NOTICES.read_text(encoding="utf-8")
    if NOTICE_START in text:
        head, rest = text.split(NOTICE_START, 1)
        text = head + section + rest.split(NOTICE_END, 1)[1].lstrip("\n")
    else:
        text = text.rstrip("\n") + "\n\n" + section
    NOTICES.write_text(text, encoding="utf-8")


def main():
    catalog = load_catalog()
    manifest_path = DESTINATION / "models.json"
    manifest = json.loads(manifest_path.read_text())
    previous = {entry["path"]: entry for entry in manifest["models"]}
    ours = re.compile(r"^avatars/outfits/(?:male|female)/outfit-[a-z0-9-]+\.glb$")
    entries, published = [], []
    for entry in catalog["outfits"]:
        if entry.get("status") == "skip" or entry.get("publish") is False:
            continue
        relative = f"avatars/outfits/{entry['group']}/{entry['id']}.glb"
        local = SOURCE / entry["group"] / f"{entry['id']}.glb"
        if local.exists():
            data = _public.public_glb(local, copyright_line(entry))
        elif (DESTINATION / relative).exists() and relative in previous:
            print(f"Keeping the reviewed public {relative}: no local export")
            data = (DESTINATION / relative).read_bytes()
        else:
            print(f"Skipping {relative}: not exported yet")
            continue
        target = DESTINATION / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        entries.append({"path": relative, "sha256": hashlib.sha256(data).hexdigest(), "bytes": len(data), "license": entry["license"],
                        "provenance": {"kind": "third-party-derived", "exporter": EXPORTER,
                                       "note": f"Wearable {entry['group']} outfit ({entry['category']}) refitted from "
                                               f"{ascii_text(entry['title'])}. Source and credit are recorded in THIRD_PARTY_NOTICES.md."}})
        published.append(entry)
    keep = {entry["path"] for entry in entries}
    owned = {f"avatars/outfits/{entry['group']}/{entry['id']}.glb" for entry in catalog["outfits"]}
    for stale in (DESTINATION / "avatars/outfits").glob("*/outfit-*.glb"):
        # A retired or skipped catalog entry leaves no stray public model.
        if stale.relative_to(DESTINATION).as_posix() in owned and stale.relative_to(DESTINATION).as_posix() not in keep:
            stale.unlink()
    models = [entry for entry in manifest["models"] if entry["path"] not in owned and entry.get("provenance", {}).get("exporter") != EXPORTER] + entries
    models.sort(key=lambda entry: entry["path"])
    manifest["models"] = models
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    write_notices(notices_section(catalog, published))
    print(f"Published {len(entries)} avatar outfits ({sum(entry['bytes'] for entry in entries)} bytes)")


if __name__ == "__main__":
    main()
