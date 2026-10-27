"""Bundle only the reviewed existing avatar exports; never generate replacement humans.

Run: python3 tooling/prepare-licensed-avatars.py
Source downloads stay local. The output retains its RenderHub license, separate
from the project's MIT scene geometry. See the public third-party notices.
"""
import hashlib
import json
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parents[1]
PUBLIC = ROOT / "apps/web/public-assets"
LOCAL = ROOT / "apps/web/local-assets"
LICENSE = "LicenseRef-RenderHub-Extended-Use"


def main():
    source = json.loads((ROOT / "tooling/licensed-avatar-sources.json").read_text())
    if source.get("schemaVersion") != 1 or source.get("license") != LICENSE:
        raise ValueError("Unexpected licensed avatar source inventory")
    prepared = []
    for item in source["models"]:
        relative = Path(item["path"])
        if relative.is_absolute() or ".." in relative.parts or relative.parts[0] != "avatars" or relative.suffix != ".glb":
            raise ValueError("Unexpected avatar path")
        original = LOCAL / relative
        data = original.read_bytes()
        if len(data) != item["bytes"] or hashlib.sha256(data).hexdigest() != item["sha256"]:
            raise ValueError(f"Review changed avatar export before bundling: {relative}")
        prepared.append((relative, original, item))
    manifest_path = PUBLIC / "models.json"
    manifest = json.loads(manifest_path.read_text())
    manifest["models"] = [entry for entry in manifest["models"] if not entry["path"].startswith("avatars/")]
    for relative, original, item in prepared:
        target = PUBLIC / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(original, target)
        manifest["models"].append({**item, "license": LICENSE, "provenance": {
            "kind": "licensed-avatar-export",
            "exporter": "tooling/prepare-licensed-avatars.py",
            "note": "Existing Blender-retargeted RenderHub avatar. Source and separate asset terms are recorded in THIRD_PARTY_NOTICES.md.",
        }})
    manifest["models"].sort(key=lambda entry: entry["path"])
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Prepared {len(prepared)} existing licensed avatar models; original bytes retained")


if __name__ == "__main__":
    main()
