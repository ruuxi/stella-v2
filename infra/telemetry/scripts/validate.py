#!/usr/bin/env python3
"""Dependency-free structural validation for telemetry IaC and schema."""

from __future__ import annotations

import json
import pathlib
import re
import sys


ROOT = pathlib.Path(__file__).resolve().parents[1]
SCHEMA_PATH = ROOT / "schema" / "v1.json"

ALLOWED_TYPES = {
    "bool",
    "binary",
    "float32",
    "float64",
    "int32",
    "int64",
    "json",
    "string",
    "timestamp",
}
REQUIRED_FIELDS = {
    "schema_version",
    "event_id",
    "occurred_at_ms",
    "ingested_at_ms",
    "project",
    "environment",
    "source",
    "owner_id_sha256",
    "principal_kind",
    "event_type",
}
INFERENCE_FIELDS = {
    "provider",
    "model",
    "duration_ms",
    "input_tokens",
    "output_tokens",
    "total_tokens",
    "cost_micro_cents",
}


def fail(message: str) -> None:
    print(f"telemetry validation failed: {message}", file=sys.stderr)
    raise SystemExit(1)


def validate_schema() -> dict[str, object]:
    try:
        schema = json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        fail(f"cannot read {SCHEMA_PATH}: {error}")

    if set(schema) != {"fields"} or not isinstance(schema["fields"], list):
        fail("schema/v1.json must contain exactly one fields array")

    names: list[str] = []
    for index, field in enumerate(schema["fields"]):
        if not isinstance(field, dict):
            fail(f"field {index} is not an object")
        if set(field) != {"name", "type", "required"}:
            fail(f"field {index} has unsupported keys")
        name = field["name"]
        if not isinstance(name, str) or not re.fullmatch(r"[a-z][a-z0-9_]*", name):
            fail(f"invalid field name at index {index}: {name!r}")
        if field["type"] not in ALLOWED_TYPES:
            fail(f"unsupported type for {name}: {field['type']!r}")
        if not isinstance(field["required"], bool):
            fail(f"required must be boolean for {name}")
        names.append(name)

    if len(names) != len(set(names)):
        fail("schema field names must be unique")
    missing = (REQUIRED_FIELDS | INFERENCE_FIELDS) - set(names)
    if missing:
        fail(f"schema is missing fields: {', '.join(sorted(missing))}")
    forbidden = {"message", "attributes", "metadata", "metrics", "prompt", "response"}
    present_forbidden = forbidden & set(names)
    if present_forbidden:
        fail(
            "privacy-unsafe escape-hatch fields are forbidden: "
            + ", ".join(sorted(present_forbidden))
        )

    required_names = {
        field["name"] for field in schema["fields"] if field["required"] is True
    }
    if required_names != REQUIRED_FIELDS:
        fail(
            "required schema fields changed; expected "
            + ", ".join(sorted(REQUIRED_FIELDS))
        )

    return schema


def validate_examples(schema: dict[str, object]) -> None:
    fields = schema["fields"]
    assert isinstance(fields, list)
    field_types = {field["name"]: field["type"] for field in fields}
    required = {field["name"] for field in fields if field["required"]}

    for path in sorted((ROOT / "schema" / "examples").glob("*.json")):
        event = json.loads(path.read_text(encoding="utf-8"))
        unknown = set(event) - set(field_types)
        missing = required - set(event)
        if unknown:
            fail(f"{path.name} has unknown fields: {', '.join(sorted(unknown))}")
        if missing:
            fail(f"{path.name} lacks required fields: {', '.join(sorted(missing))}")
        if event.get("schema_version") != 1:
            fail(f"{path.name} must use schema_version 1")


def validate_iac_shape() -> None:
    module = (ROOT / "modules" / "environment-v1" / "main.tf").read_text(
        encoding="utf-8"
    )
    required_resources = {
        "cloudflare_r2_bucket",
        "cloudflare_r2_data_catalog",
        "cloudflare_pipeline_stream",
        "cloudflare_pipeline_sink",
        "cloudflare_pipeline",
        "cloudflare_account_token",
    }
    for resource in required_resources:
        if f'resource "{resource}"' not in module:
            fail(f"module is missing {resource}")

    required_guards = (
        "enabled        = false",
        # Cloudflare canonicalizes authentication to false for a disabled HTTP
        # endpoint. The security boundary is the disabled endpoint itself.
        "authentication = false",
        "enabled = true",
        'type       = "r2_data_catalog"',
        'compression     = "zstd"',
        "prevent_destroy = true",
    )
    for guard in required_guards:
        if guard not in module:
            fail(f"module is missing safety setting: {guard}")

    for environment in ("development", "production"):
        stack = ROOT / "stacks" / environment / "main.tf"
        text = stack.read_text(encoding="utf-8")
        if 'source = "../../modules/environment-v1"' not in text:
            fail(f"{environment} stack does not use environment-v1 module")
        if not re.search(
            rf'environment\s*=\s*"{re.escape(environment)}"', text
        ):
            fail(f"{environment} stack has the wrong environment value")


def validate_worker_flattening(schema: dict[str, object]) -> None:
    worker_path = ROOT.parents[1] / "workers" / "telemetry" / "src" / "index.ts"
    if not worker_path.exists():
        return
    worker = worker_path.read_text(encoding="utf-8")
    start = worker.find("const flattenEvent =")
    end = worker.find("const ingestValidated =", start)
    if start < 0 or end < 0:
        fail("could not locate the telemetry Worker's flattenEvent function")
    common_start = worker.find("const common =", start, end)
    if common_start < 0:
        fail("could not locate the telemetry Worker's common flattened fields")
    flatten = worker[common_start:end]
    worker_fields = set(
        re.findall(r"(?:[{,]|^|\n)\s*([a-z][a-z0-9_]*)\s*:", flatten)
    )
    fields = schema["fields"]
    assert isinstance(fields, list)
    schema_fields = {field["name"] for field in fields}
    if worker_fields != schema_fields:
        missing = worker_fields - schema_fields
        extra = schema_fields - worker_fields
        detail = []
        if missing:
            detail.append("missing from Pipeline schema: " + ", ".join(sorted(missing)))
        if extra:
            detail.append("not emitted by Worker: " + ", ".join(sorted(extra)))
        fail("Worker/schema field drift: " + "; ".join(detail))


def validate_text_files() -> None:
    for path in ROOT.rglob("*"):
        if not path.is_file() or ".terraform" in path.parts:
            continue
        if path.suffix not in {".tf", ".json", ".md", ".sql", ".sh", ".py"}:
            continue
        text = path.read_text(encoding="utf-8")
        if "\r\n" in text:
            fail(f"{path.relative_to(ROOT)} uses CRLF line endings")
        if any(line.endswith((" ", "\t")) for line in text.splitlines()):
            fail(f"{path.relative_to(ROOT)} has trailing whitespace")


def main() -> None:
    schema = validate_schema()
    validate_examples(schema)
    validate_iac_shape()
    validate_worker_flattening(schema)
    validate_text_files()
    print("telemetry structural validation passed")


if __name__ == "__main__":
    main()
