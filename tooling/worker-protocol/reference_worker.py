"""Test-only one-probe NDJSON reference. Not a production worker or scanner.

Uses only stdlib; -I -S -B isolates developer interoperability runs. No files,
environment credentials, network, commands, user profiles or lifecycle are used.
"""
import json
import math
import re
import sys

MAX_FRAME_BYTES = 65536
VERSION = "0.0.0-reference"
UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}")


def emit(value):
    data = (json.dumps(value, separators=(",", ":"), ensure_ascii=True) + "\n").encode("utf-8")
    if len(data) > MAX_FRAME_BYTES:
        raise ValueError("oversize")
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def reject_constant(_value):
    raise ValueError("invalid number")


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if len(key) > 32 or key in result or len(result) == 6:
            raise ValueError("invalid object")
        result[key] = value
    return result


def probe_shape(value, depth=0):
    if isinstance(value, str):
        return len(value) <= 128 and value.isascii()
    if isinstance(value, (dict, list)):
        if depth == 2:
            return False
        if isinstance(value, dict):
            return all(probe_shape(key, depth + 1) and probe_shape(item, depth + 1) for key, item in value.items())
        return all(probe_shape(item, depth + 1) for item in value)
    return True


def main():
    emit({"schema_version": 1, "kind": "hello", "worker_version": VERSION, "operations": ["health"]})
    line = sys.stdin.buffer.readline(MAX_FRAME_BYTES + 1)
    if not line:
        return 0
    if len(line) > MAX_FRAME_BYTES or not line.endswith(b"\n"):
        return 2
    try:
        value = json.loads(line.decode("utf-8"), parse_constant=reject_constant, object_pairs_hook=unique_object)
        if not probe_shape(value):
            return 2
        if not isinstance(value, dict) or set(value) != {"schema_version", "kind", "request_id", "operation", "deadline_ms", "payload"}:
            return 2
        schema = value["schema_version"]
        deadline = value["deadline_ms"]
        if type(schema) not in (int, float) or schema != 1:
            return 2
        if value["kind"] != "request" or value["operation"] != "health" or value["payload"] != {}:
            return 2
        if not isinstance(value["request_id"], str) or not UUID.fullmatch(value["request_id"]):
            return 2
        if type(deadline) not in (int, float) or not math.isfinite(deadline) or deadline % 1 or not 1 <= deadline <= 300000:
            return 2
        emit({"schema_version": 1, "kind": "response", "request_id": value["request_id"], "result": {"status": "ok", "worker_version": VERSION}})
        return 0
    except (ValueError, TypeError, UnicodeError, OverflowError, RecursionError):
        return 2


if __name__ == "__main__":
    sys.exit(main())
