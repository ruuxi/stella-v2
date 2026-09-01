---
name: maintain-verification-skill
description: Audit and repair a project-local verification skill, its feature map, and its owned harness. Use when explicitly asked to run $maintain-verification-skill, audit a verifier, or reconcile verification instructions with the current product.
---

# Maintain Verification Skill

A feature map starts drifting as soon as the product changes. This skill keeps a verifier honest by comparing every mapped feature with source and then exercising every feature through the real app. Treat the feature—not every sentence—as the unit of coverage.

## Outcomes

Finish with exactly one outcome:

- **clean** — every mapped feature received source and live coverage; no useful correction was found.
- **changed** — proven corrections were made to the verification skill, map, or owned harness.
- **blocked** — coverage could not finish or a correction could not be proven safely. Name the exact blocker and completed coverage.

Do not create a commit or pull request unless the user asks. A changed outcome leaves reviewed, validated changes in the working tree.

## Scope

Only edit the selected verification skill directory: its `SKILL.md`, feature map, metadata, and scripts it owns. Never edit product code during a maintenance pass. A mismatch is either verifier drift to correct or a product regression to report; do not disguise a regression by rewriting the map.

Locate project-local candidates under `.agents/skills/verify-*`. Select the only candidate with launch/drive guidance and a feature map. If several are plausible, ask which one. If none exists, stop and recommend `$create-verification-skill`.

Keep concise notes in a temporary directory, never in committed project files.

## Maintenance pass

1. **Index hygiene.** Read the feature-map index and enumerate its sibling feature files. Correct missing, extra, duplicate, or dead index entries.
2. **Source wave.** Launch one read-only subagent per feature file, concurrently within the available agent limit. Each subagent reads the feature file and relevant product source, never drives the app, and never edits files. Require this concise result: user-visible behavior, source entry points with file citations, likely drift or none, and one live-verification recipe.
3. **Reconcile.** Collect a result for every feature. Spot-check concrete drift claims. Search recent user-facing source churn for a missing surface, but add one only when a source path proves it exists. Merge overlapping recipes into as few app states as practical.
4. **Live pass.** The coordinator—not the source readers—owns all app driving. Follow the verifier's launch model: one long-lived isolated instance for desktop/server UIs, or fresh isolated sessions when the verifier requires them. Exercise every feature at least once.
5. **Triage.** Correct inaccurate user-facing descriptions and harness gaps within scope. Report broken product behavior without editing product code. Re-run any changed harness path live before calling it proven.
6. **Validate.** Re-read all changed verifier files, run the skill validator, run syntax or static checks for owned scripts, and confirm the feature index still covers every sibling feature file.
7. **Teardown and report.** Clean up only resources created by the pass. Confirm evidence still exists, remove temporary notes, and report the outcome plus covered, unreachable, and regressed features.

## Live-pass invariants

- Run the verifier's doctor before the first drive, after any surprising failure, and again after any harness correction that changes the running session.
- If process health cannot reveal a wedged UI state, restore a known state or relaunch; do not continue from uncertain state.
- Evidence captured so far must survive cleanup at the verifier's documented artifact path.
- Nothing started by a drive may outlive its usefulness. Clean failed-iteration residue even when the shared app instance remains alive.
- An unreachable feature needs the attempted route and a concrete prerequisite such as authentication, entitlement, operating system, or external state. Add an omitted prerequisite to the map as drift.
- After correcting verifier drift, retry the affected path once. If it still cannot be proven safely, use the blocked outcome rather than accumulating speculative fixes.
