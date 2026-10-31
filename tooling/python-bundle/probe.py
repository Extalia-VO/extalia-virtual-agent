"""Developer-only fixed CPython compatibility check before the stdlib health fixture."""
import pathlib
import runpy
import sys

if sys.version_info[:3] != (3, 13, 18):
    raise SystemExit(2)
runpy.run_path(str(pathlib.Path(__file__).with_name("reference_worker.py")), run_name="__main__")
