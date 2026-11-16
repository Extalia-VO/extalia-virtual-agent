"""One-shot SkillSpector bridge. Rust owns sandboxing, hashes, deadlines and state."""

from __future__ import annotations

import contextlib
import io
import json
import os
from pathlib import Path
import re
import sys
import threading
import time

SCANNER_VERSION = "2.13.4"
SOURCE_COMMIT = "54824463814a0be01360792523ec7245a69190fc"
NORMALIZER_VERSION = "extalia-skillspector-v1"
MAX_FRAME = 16_384
MAX_CAPTURE = 1_048_576
SEVERITIES = ("none", "low", "medium", "high", "critical")
REQUEST_KEYS = {"schema_version", "operation", "input_path", "revision_id", "tree_sha256", "policy_version"}


class BoundedSink(io.TextIOBase):
    """Do not leak upstream paths/findings or permit unbounded captured logging."""

    def __init__(self) -> None:
        self.bytes = 0

    def write(self, value: str) -> int:
        self.bytes += len(value.encode("utf-8", "replace"))
        if self.bytes > MAX_CAPTURE:
            raise ValueError("scanner output limit")
        return len(value)


def no_duplicate_keys(pairs: list[tuple[str, object]]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate field")
        result[key] = value
    return result


def reject_constant(_value: str) -> None:
    raise ValueError("non-finite JSON number")


def read_request() -> dict[str, object]:
    raw = sys.stdin.buffer.read(MAX_FRAME + 1)
    if len(raw) > MAX_FRAME or not raw.endswith(b"\n") or raw.count(b"\n") != 1:
        raise ValueError("invalid frame")
    value = json.loads(raw, object_pairs_hook=no_duplicate_keys, parse_constant=reject_constant)
    if not isinstance(value, dict) or set(value) != REQUEST_KEYS:
        raise ValueError("invalid fields")
    if type(value["schema_version"]) is not int or value["schema_version"] != 1 or value["operation"] != "scan":
        raise ValueError("invalid operation")
    if not isinstance(value["revision_id"], str) or not re.fullmatch(r"skr_[0-9a-f]{64}", value["revision_id"]):
        raise ValueError("invalid revision")
    if not isinstance(value["tree_sha256"], str) or not re.fullmatch(r"[0-9a-f]{64}", value["tree_sha256"]):
        raise ValueError("invalid tree")
    if not isinstance(value["policy_version"], str) or not re.fullmatch(r"[a-zA-Z0-9._-]{1,80}", value["policy_version"]):
        raise ValueError("invalid policy")
    source = value["input_path"]
    if not isinstance(source, str) or len(source) > 4096 or not Path(source).is_absolute():
        raise ValueError("invalid source")
    path = Path(source)
    if path.is_symlink() or not path.is_dir() or not (path / "SKILL.md").is_file():
        raise ValueError("invalid source")
    return value


def severity(value: object) -> str:
    if not isinstance(value, str) or value.lower() not in SEVERITIES:
        raise ValueError("invalid severity")
    return value.lower()


def normalize(report: object) -> tuple[str, str, str, int]:
    """Normalize the actual v2.13.4 JSON contract; missing evidence never means clean."""
    if not isinstance(report, dict):
        raise ValueError("invalid report")
    metadata = report.get("metadata")
    assessment = report.get("risk_assessment")
    completeness = report.get("analysis_completeness")
    issues = report.get("issues")
    if not isinstance(metadata, dict) or metadata.get("skillspector_version") != SCANNER_VERSION:
        raise ValueError("wrong scanner")
    if metadata.get("llm_requested") is not False or metadata.get("meta_analysis_applied") is not False:
        raise ValueError("unexpected inference")
    if not isinstance(assessment, dict) or not isinstance(completeness, dict) or not isinstance(issues, list):
        raise ValueError("missing evidence")
    if len(issues) > 10_000 or report.get("suppressed_count") != 0 or report.get("suppressed") != []:
        raise ValueError("suppressed or excessive findings")
    maximum = severity(assessment.get("max_issue_severity"))
    weighted = severity(assessment.get("severity"))
    for issue in issues:
        if not isinstance(issue, dict):
            raise ValueError("invalid finding")
        item = severity(issue.get("severity"))
        if SEVERITIES.index(item) > SEVERITIES.index(maximum):
            maximum = item
    if not issues and maximum != "none":
        raise ValueError("inconsistent findings")
    if not issues and weighted not in ("none", "low"):
        raise ValueError("inconsistent weighted risk")
    # A weighted LOW band is normal for a no-finding result. Otherwise retain the
    # stricter of weighted risk and the actual maximum finding severity.
    if issues and SEVERITIES.index(weighted) > SEVERITIES.index(maximum):
        maximum = weighted
    counters = ("total_components", "scanned_components", "fully_inspected_files", "partially_inspected_files", "entirely_uninspected_files")
    if any(type(completeness.get(key)) is not int or completeness[key] < 0 for key in counters):
        raise ValueError("invalid coverage counters")
    arrays = ("ledger_exceptions", "scope_exclusions", "analyzer_statuses")
    if any(not isinstance(completeness.get(key), list) for key in arrays):
        raise ValueError("invalid coverage ledger")
    limitations = completeness.get("limitations", [])
    if not isinstance(limitations, list):
        raise ValueError("invalid limitations")
    analyzer_ids: set[str] = set()
    analyzers_complete = bool(completeness["analyzer_statuses"])
    for analyzer in completeness["analyzer_statuses"]:
        if not isinstance(analyzer, dict) or not isinstance(analyzer.get("analyzer_id"), str) or analyzer["analyzer_id"] in analyzer_ids:
            raise ValueError("invalid analyzer ledger")
        analyzer_ids.add(analyzer["analyzer_id"])
        counts = ("planned_work", "completed", "partial", "skipped", "failed", "unaccounted")
        if any(type(analyzer.get(key)) is not int or analyzer[key] < 0 for key in counts):
            raise ValueError("invalid analyzer counters")
        status = analyzer.get("status")
        if status == "completed":
            analyzers_complete = analyzers_complete and analyzer["planned_work"] == analyzer["completed"] and all(analyzer[key] == 0 for key in ("partial", "skipped", "failed", "unaccounted"))
        elif status == "not_applicable":
            analyzers_complete = analyzers_complete and all(analyzer[key] == 0 for key in counts)
        elif status == "disabled":
            optional_llm = {"meta_analyzer", "semantic_developer_intent", "semantic_quality_policy", "semantic_security_discovery"}
            analyzers_complete = analyzers_complete and analyzer["analyzer_id"] in optional_llm and analyzer.get("reason_code") == "disabled_by_configuration" and all(analyzer[key] == 0 for key in counts)
        else:
            analyzers_complete = False
    complete = (
        report.get("execution_successful") is True
        and completeness.get("execution_successful") is True
        and completeness.get("is_complete") is True
        and completeness.get("status") == "complete"
        and type(completeness.get("coverage_percent")) in (int, float)
        and completeness["coverage_percent"] == 100
        and completeness["total_components"] == completeness["scanned_components"]
        and completeness["total_components"] > 0
        and completeness["partially_inspected_files"] == 0
        and completeness["entirely_uninspected_files"] == 0
        and not completeness["ledger_exceptions"]
        and not completeness["scope_exclusions"]
        and not limitations
        and analyzers_complete
    )
    return ("completed" if complete else "incomplete", maximum, "complete" if complete else "partial", len(issues))


def deny_network_and_execution(event: str, _arguments: tuple[object, ...]) -> None:
    # Defense in depth only. This Python audit hook is not an OS sandbox; Rust
    # separately refuses launch where mandatory isolation cannot be enforced.
    if event.startswith("socket.") or event in {"subprocess.Popen", "os.system", "os.exec", "os.posix_spawn", "pty.spawn"}:
        raise PermissionError("scanner operation denied")


def scan(request: dict[str, object]) -> dict[str, object]:
    result = {
        "schema_version": 1,
        "scanner_version": SCANNER_VERSION,
        "source_commit": SOURCE_COMMIT,
        "normalizer_version": NORMALIZER_VERSION,
        "revision_id": request["revision_id"],
        "tree_sha256": request["tree_sha256"],
        "policy_version": request["policy_version"],
        "outcome": "error", "severity": "none", "coverage": "none", "issue_count": 0,
    }
    sink = BoundedSink()
    with contextlib.redirect_stdout(sink), contextlib.redirect_stderr(sink):
        try:
            # -I -S prevents environment/user site imports. This one path is part
            # of the Rust-verified immutable bundle, never a model-supplied path.
            sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "deps"))
            sys.addaudithook(deny_network_and_execution)
            from skillspector.graph import graph

            state = graph.invoke({"input_path": request["input_path"], "output_format": "json", "use_llm": False, "llm_requested": False, "source_local_only": True})
            raw = state.get("report_body")
            if not isinstance(raw, str) or len(raw.encode("utf-8")) > MAX_CAPTURE:
                raise ValueError("invalid report body")
            report = json.loads(raw, object_pairs_hook=no_duplicate_keys, parse_constant=reject_constant)
            outcome, maximum, coverage, count = normalize(report)
            result.update(outcome=outcome, severity=maximum, coverage=coverage, issue_count=count)
        except (ValueError, TypeError, KeyError, json.JSONDecodeError):
            result["outcome"] = "invalid-output"
        except Exception:
            # Native paths, supplied text and scanner exception strings stay off
            # the wire. Failure is data, never an approval or clean attestation.
            result["outcome"] = "error"
    return result


def main() -> int:
    try:
        parent = os.getppid()
        if parent <= 1:
            return 2

        def watch_parent() -> None:
            while True:
                time.sleep(0.1)
                if os.getppid() != parent:
                    os._exit(3)

        threading.Thread(target=watch_parent, daemon=True, name="scanner-owner").start()
        # Set before even decoding an untrusted frame. Unsupported isolation is
        # a refusal, never an excuse to inspect with weaker resource limits.
        import resource

        limits = [(resource.RLIMIT_CPU, 30), (resource.RLIMIT_FSIZE, 1024**2), (resource.RLIMIT_NOFILE, 128), (resource.RLIMIT_CORE, 0)]
        if sys.platform == "darwin":
            # Darwin aliases RLIMIT_AS to an unsupported RSS limit. Only the
            # fixed Rust-owned launch may substitute its sampled RSS watchdog;
            # a request field cannot weaken this startup requirement.
            if os.environ.get("EXTALIA_SKILLSPECTOR_PARENT_MEMORY_WATCHDOG") != "1":
                return 2
        else:
            limits.append((resource.RLIMIT_AS, 2 * 1024**3))
        for limit, bound in limits:
            _soft, hard = resource.getrlimit(limit)
            value = bound if hard == resource.RLIM_INFINITY else min(bound, hard)
            resource.setrlimit(limit, (value, value))
        request = read_request()
    except Exception:
        return 2
    # Provider credentials and tracing destinations cannot be passed through by
    # accident, even if a future launcher expands its environment allow-list.
    keep = {"HOME", "USERPROFILE", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG", "LC_ALL", "TZ"}
    for key in list(os.environ):
        if key.upper() not in keep:
            del os.environ[key]
    print(json.dumps(scan(request), separators=(",", ":"), allow_nan=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
