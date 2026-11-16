import csv
import importlib.util
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location("prepare_deps", Path(__file__).with_name("prepare_deps.py"))
prepare_deps = importlib.util.module_from_spec(spec)
spec.loader.exec_module(prepare_deps)


class InstallationRecordsTests(unittest.TestCase):
    def fixture(self, root):
        (root / "example.dist-info").mkdir()
        (root / "bin").mkdir()
        (root / "bin/example").write_text("#!/temporary/build/path/python\n")
        (root / "example.py").write_text("# library\n")
        (root / "example.dist-info/LICENSE").write_text("Example license\n")
        (root / "example.dist-info/RECORD").write_text("bin/example,sha256=old,20\nexample.py,sha256=old,2\nexample.dist-info/LICENSE,sha256=old,1\nexample.dist-info/RECORD,,\n")

    def test_removes_only_unused_wrappers_and_keeps_licenses(self):
        with tempfile.TemporaryDirectory(prefix="extalia-record-test-") as directory:
            root = Path(directory); self.fixture(root)
            self.assertEqual(prepare_deps.prepare(root), {"removed_unused_entrypoints": 1, "normalized_distribution_records": 1})
            self.assertFalse((root / "bin").exists())
            self.assertEqual((root / "example.dist-info/LICENSE").read_text(), "Example license\n")
            rows = list(csv.reader((root / "example.dist-info/RECORD").read_text().splitlines()))
            self.assertEqual(len(rows), 3)
            self.assertTrue(rows[0][1].startswith("sha256=")); self.assertEqual(rows[-1][1:], ["", ""])
            original = (root / "example.dist-info/RECORD").read_bytes()
            prepare_deps.prepare(root)
            self.assertEqual((root / "example.dist-info/RECORD").read_bytes(), original)

    def test_refuses_record_escape(self):
        with tempfile.TemporaryDirectory(prefix="extalia-record-test-") as directory:
            root = Path(directory); self.fixture(root)
            (root / "example.dist-info/RECORD").write_text("../outside,,\n")
            with self.assertRaises(ValueError): prepare_deps.prepare(root)

    def test_refuses_missing_files_and_malformed_rows(self):
        for row in ("missing.py,,\n", "example.py,missing-field\n"):
            with self.subTest(row=row), tempfile.TemporaryDirectory(prefix="extalia-record-test-") as directory:
                root = Path(directory); self.fixture(root)
                (root / "example.dist-info/RECORD").write_text(row)
                with self.assertRaises(ValueError): prepare_deps.prepare(root)


if __name__ == "__main__":
    unittest.main()
