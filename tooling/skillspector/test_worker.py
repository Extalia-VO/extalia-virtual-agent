"""Contract regressions; run explicitly with the bundled CPython, no extra packages."""

import copy
import importlib.util
import json
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("extalia_scanner", Path(__file__).with_name("worker.py"))
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def report():
    return {
        "metadata": {"skillspector_version": worker.SCANNER_VERSION, "llm_requested": False, "meta_analysis_applied": False},
        "risk_assessment": {"severity": "LOW", "max_issue_severity": "NONE"},
        "issues": [], "suppressed_count": 0, "suppressed": [], "execution_successful": True,
        "analysis_completeness": {
            "total_components": 1, "scanned_components": 1, "coverage_percent": 100.0,
            "is_complete": True, "status": "complete", "execution_successful": True,
            "fully_inspected_files": 1, "partially_inspected_files": 0, "entirely_uninspected_files": 0,
            "ledger_exceptions": [], "scope_exclusions": [], "limitations": [],
            "analyzer_statuses": [{"analyzer_id": "static_yara", "status": "completed", "planned_work": 1, "completed": 1, "partial": 0, "skipped": 0, "failed": 0, "unaccounted": 0}],
        },
    }


class NormalizerTests(unittest.TestCase):
    def test_actual_no_finding_weighted_low_is_none(self):
        self.assertEqual(worker.normalize(report()), ("completed", "none", "complete", 0))

    def test_high_finding_cannot_be_hidden_by_weighted_low(self):
        value = report()
        value["risk_assessment"]["max_issue_severity"] = "HIGH"
        value["issues"] = [{"severity": "HIGH"}]
        self.assertEqual(worker.normalize(value), ("completed", "high", "complete", 1))

    def test_inconsistent_high_weighted_no_findings_is_refused(self):
        value = report(); value["risk_assessment"]["severity"] = "HIGH"
        with self.assertRaises(ValueError): worker.normalize(value)

    def test_missing_evidence_is_not_clean(self):
        for key in ("metadata", "analysis_completeness", "risk_assessment", "issues"):
            value = report(); del value[key]
            with self.subTest(key=key), self.assertRaises(ValueError): worker.normalize(value)

    def test_suppression_or_inference_cannot_pass(self):
        for key, field, replacement in (("metadata", "llm_requested", True), ("metadata", "meta_analysis_applied", True), ("metadata", "skillspector_version", "unknown")):
            value = report(); value[key][field] = replacement
            with self.subTest(field=field), self.assertRaises(ValueError): worker.normalize(value)
        value = report(); value["suppressed_count"] = 1
        with self.assertRaises(ValueError): worker.normalize(value)

    def test_incomplete_coverage_remains_incomplete(self):
        for key, replacement in (("is_complete", False), ("coverage_percent", 99.9), ("ledger_exceptions", [{"reason": "size_limit"}]), ("scope_exclusions", [{"reason": "unsupported"}]), ("limitations", ["offline dependencies"]), ("entirely_uninspected_files", 1), ("scanned_components", 0)):
            value = report(); value["analysis_completeness"][key] = replacement
            with self.subTest(key=key): self.assertEqual(worker.normalize(value)[0], "incomplete")

    def test_contradictory_analyzer_ledger_cannot_pass(self):
        for key, replacement in (("status", "failed"), ("failed", 1), ("partial", 1), ("skipped", 1), ("unaccounted", 1), ("completed", 0)):
            value = report(); value["analysis_completeness"]["analyzer_statuses"][0][key] = replacement
            with self.subTest(key=key): self.assertEqual(worker.normalize(value)[0], "incomplete")

    def test_only_explicit_semantic_disable_is_complete_static_scan(self):
        value = report(); item = value["analysis_completeness"]["analyzer_statuses"][0]
        item.update(status="disabled", planned_work=0, completed=0, reason_code="disabled_by_configuration")
        self.assertEqual(worker.normalize(value)[0], "incomplete")
        item["analyzer_id"] = "semantic_security_discovery"
        self.assertEqual(worker.normalize(value)[0], "completed")
        item["analyzer_id"] = "meta_analyzer"
        self.assertEqual(worker.normalize(value)[0], "completed")
        item["analyzer_id"] = "semantic_unknown"
        self.assertEqual(worker.normalize(value)[0], "incomplete")

    def test_duplicate_or_boolean_analyzer_counts_are_refused(self):
        value = report(); value["analysis_completeness"]["analyzer_statuses"] *= 2
        with self.assertRaises(ValueError): worker.normalize(value)
        value = report(); value["analysis_completeness"]["total_components"] = True
        with self.assertRaises(ValueError): worker.normalize(value)

    def test_json_duplicates_and_nonfinite_numbers_are_refused(self):
        for raw in ('{"x":1,"x":2}', '{"x":NaN}', '{"x":Infinity}', '{"x":-Infinity}'):
            with self.subTest(raw=raw), self.assertRaises(ValueError):
                json.loads(raw, object_pairs_hook=worker.no_duplicate_keys, parse_constant=worker.reject_constant)

    def test_no_mutation_of_scanner_report(self):
        value = report(); before = copy.deepcopy(value); worker.normalize(value)
        self.assertEqual(value, before)


if __name__ == "__main__":
    unittest.main()
