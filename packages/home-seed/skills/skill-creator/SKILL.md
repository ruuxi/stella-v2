---
name: skill-creator
description: Create or update user-owned Stella skills under ~/.stella/skills. Use when the user asks to add, revise, port, validate, document, or design reusable agent skills, skill instructions, scripts, references, or assets.
---

# Skill Creator

Use this skill to create or update skills in the user's Stella home. The
installed application's bundled skills are read-only product resources; never
edit Stella's install, runtime, desktop UI, or source checkout as part of this
workflow.

## Skill Shape

Create user-owned skills under `~/.stella/skills/<skill-name>/`.

Required:

- `SKILL.md` with YAML frontmatter containing only `name` and `description`.
- A concise Markdown body with the instructions another Stella agent should
  follow.

Optional:

- `scripts/` for deterministic helpers.
- `references/` for larger docs the agent should load only when needed.
- `templates/` for reusable starting points.
- `assets/` for files used in final outputs.
- `input.schema.json` or `output.schema.json` when schemas make the skill easier
  to use correctly.

Do not add auxiliary docs such as `README.md`, `CHANGELOG.md`, or installation
guides unless the user explicitly asks for them.

## Principles

- Keep the skill small. Add only procedural knowledge, project-specific facts,
  helper commands, or references that a capable agent would not reliably infer.
- Put trigger conditions in the frontmatter `description`; the body is loaded
  only after the skill triggers.
- Prefer one-level references linked directly from `SKILL.md`.
- Use scripts when repeated code would otherwise be rewritten often or when
  correctness depends on a fragile sequence.
- Keep a user-created skill within the files and systems the user authorized.

## Creating a Skill

1. Clarify the real use cases with concrete examples when the request is vague.
2. Choose a lowercase hyphenated name under 64 characters.
3. Create `~/.stella/skills/<name>/SKILL.md`.
4. Add only the resource folders that are actually useful.
5. Validate frontmatter, naming, and representative script behavior.

The bundled helper can scaffold directly into the user's skill root:

```bash
python3 ~/.stella/skills/skill-creator/scripts/init_skill.py <skill-name> --path ~/.stella/skills
```

The upstream helper also creates `agents/openai.yaml`. Stella does not require
that file for skill discovery; remove it unless the user explicitly needs that
metadata.

## Updating a Skill

1. Read the existing `SKILL.md` and any referenced resources.
2. Preserve useful instructions and delete stale or duplicative content.
3. Keep frontmatter to exactly:

```yaml
---
name: skill-name
description: Clear trigger and capability description.
---
```

4. Keep detailed reference material in `references/` instead of expanding
   `SKILL.md` indefinitely.
5. Validate scripts by running representative commands when they are changed.

## Validation

Run the bundled validator for basic frontmatter and naming checks:

```bash
python3 ~/.stella/skills/skill-creator/scripts/quick_validate.py ~/.stella/skills/<skill-name>
```

## Bundled References

- `references/openai_yaml.md` documents OpenAI UI metadata. Read it only if the
  user explicitly needs OpenAI-style skill metadata.
- `scripts/init_skill.py`, `scripts/quick_validate.py`, and
  `scripts/generate_openai_yaml.py` are upstream helpers; inspect and adapt
  their generated output when a task has stricter requirements.
