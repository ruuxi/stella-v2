#!/usr/bin/env python3
"""
Quick validation script for skills - minimal version
"""

import json
import re
import sys
from pathlib import Path

MAX_SKILL_NAME_LENGTH = 64


def parse_scalar(value):
    """Parse the simple scalar values supported by Stella skill frontmatter."""
    value = value.strip()
    if value.startswith('"'):
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError as exc:
            raise ValueError(f"invalid quoted value: {exc.msg}") from exc
        if not isinstance(parsed, str):
            raise ValueError("frontmatter values must be strings")
        return parsed
    if value.startswith("'"):
        if len(value) < 2 or not value.endswith("'"):
            raise ValueError("unterminated single-quoted value")
        return value[1:-1].replace("''", "'")
    if value in {"|", ">", "|-", ">-", "|+", ">+"}:
        raise ValueError("multiline YAML values are not supported")
    return value


def parse_frontmatter(frontmatter_text):
    """Parse Stella's flat name/description frontmatter without PyYAML."""
    frontmatter = {}
    for raw_line in frontmatter_text.splitlines():
        if not raw_line.strip() or raw_line.lstrip().startswith("#"):
            continue
        if raw_line[:1].isspace():
            raise ValueError("nested YAML is not supported")
        match = re.match(r"^([A-Za-z0-9_-]+):\s*(.*)$", raw_line)
        if not match:
            raise ValueError(f"invalid frontmatter line: {raw_line}")
        key, raw_value = match.groups()
        if key in frontmatter:
            raise ValueError(f"duplicate frontmatter key: {key}")
        frontmatter[key] = parse_scalar(raw_value)
    return frontmatter


def validate_skill(skill_path):
    """Basic validation of a skill"""
    skill_path = Path(skill_path)

    skill_md = skill_path / "SKILL.md"
    if not skill_md.exists():
        return False, "SKILL.md not found"

    content = skill_md.read_text()
    if not content.startswith("---"):
        return False, "No YAML frontmatter found"

    match = re.match(r"^---\n(.*?)\n---", content, re.DOTALL)
    if not match:
        return False, "Invalid frontmatter format"

    frontmatter_text = match.group(1)

    try:
        frontmatter = parse_frontmatter(frontmatter_text)
    except ValueError as e:
        return False, f"Invalid YAML in frontmatter: {e}"

    allowed_properties = {"name", "description"}

    unexpected_keys = set(frontmatter.keys()) - allowed_properties
    if unexpected_keys:
        allowed = ", ".join(sorted(allowed_properties))
        unexpected = ", ".join(sorted(unexpected_keys))
        return (
            False,
            f"Unexpected key(s) in SKILL.md frontmatter: {unexpected}. Allowed properties are: {allowed}",
        )

    if "name" not in frontmatter:
        return False, "Missing 'name' in frontmatter"
    if "description" not in frontmatter:
        return False, "Missing 'description' in frontmatter"

    name = frontmatter.get("name", "")
    if not isinstance(name, str):
        return False, f"Name must be a string, got {type(name).__name__}"
    name = name.strip()
    if not name:
        return False, "Name cannot be empty"
    if not re.match(r"^[a-z0-9-]+$", name):
        return (
            False,
            f"Name '{name}' should be hyphen-case (lowercase letters, digits, and hyphens only)",
        )
    if name.startswith("-") or name.endswith("-") or "--" in name:
        return (
            False,
            f"Name '{name}' cannot start/end with hyphen or contain consecutive hyphens",
        )
    if len(name) > MAX_SKILL_NAME_LENGTH:
        return (
            False,
            f"Name is too long ({len(name)} characters). "
            f"Maximum is {MAX_SKILL_NAME_LENGTH} characters.",
        )

    description = frontmatter.get("description", "")
    if not isinstance(description, str):
        return False, f"Description must be a string, got {type(description).__name__}"
    description = description.strip()
    if not description:
        return False, "Description cannot be empty"
    if "<" in description or ">" in description:
        return False, "Description cannot contain angle brackets (< or >)"
    if len(description) > 1024:
        return (
            False,
            f"Description is too long ({len(description)} characters). Maximum is 1024 characters.",
        )

    return True, "Skill is valid!"


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("Usage: python quick_validate.py <skill_directory>")
        sys.exit(1)

    valid, message = validate_skill(sys.argv[1])
    print(message)
    sys.exit(0 if valid else 1)
