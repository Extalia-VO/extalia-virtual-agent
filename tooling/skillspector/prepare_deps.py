"""Build-only removal of unused, path-bearing entrypoints and RECORD normalization."""

import base64
import csv
import hashlib
import io
import json
from pathlib import Path, PurePosixPath
import shutil
import sys


def prepare(root: Path) -> dict[str, int]:
    if not root.is_absolute() or root.is_symlink() or not root.is_dir():
        raise ValueError("invalid dependency root")
    scripts = root / "bin"
    removed = 0
    if scripts.exists():
        if scripts.is_symlink() or not scripts.is_dir():
            raise ValueError("invalid entrypoint directory")
        for path in scripts.rglob("*"):
            if path.is_symlink() or not path.is_file():
                raise ValueError("invalid entrypoint")
            removed += 1
        shutil.rmtree(scripts)
    records = 0
    for record in sorted(root.glob("*.dist-info/RECORD")):
        if record.is_symlink() or not record.is_file():
            raise ValueError("invalid distribution record")
        rows = list(csv.reader(io.StringIO(record.read_text(encoding="utf-8"))))
        normalized = []
        for row in rows:
            if len(row) != 3:
                raise ValueError("invalid record row")
            relative = PurePosixPath(row[0])
            if relative.is_absolute() or ".." in relative.parts or not relative.parts or "\\" in row[0]:
                raise ValueError("unsafe record path")
            if relative.parts[0] == "bin":
                continue
            target = root.joinpath(*relative.parts)
            if target.is_symlink() or not target.is_file():
                raise ValueError("missing record artifact")
            if target == record:
                normalized.append([row[0], "", ""])
            else:
                digest = hashlib.sha256()
                with target.open("rb") as handle:
                    for chunk in iter(lambda: handle.read(1024**2), b""):
                        digest.update(chunk)
                checksum = base64.urlsafe_b64encode(digest.digest()).decode("ascii").rstrip("=")
                normalized.append([row[0], "sha256=" + checksum, str(target.stat().st_size)])
        output = io.StringIO(newline="")
        csv.writer(output, lineterminator="\n").writerows(normalized)
        record.write_text(output.getvalue(), encoding="utf-8", newline="")
        records += 1
    return {"removed_unused_entrypoints": removed, "normalized_distribution_records": records}


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit(2)
    print(json.dumps(prepare(Path(sys.argv[1])), separators=(",", ":")))
