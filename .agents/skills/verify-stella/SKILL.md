---
name: verify-stella
description: Drive Stella's desktop Electron app locally or its iOS app through the configured stella-mac SSH host and iOS Simulator. Use when proving desktop or iOS UI behavior from the Stella repository.
---

# Verify Stella

Use this skill to prove Stella through its real user surfaces. Start with the [Feature Map](features/README.md), choose the feature touched by the change, and follow every applicable user entry point in that file.

- **Desktop** uses the isolated Electron harness and the agent-friendly `control-stella.mjs` CLI.
- **iOS** uses the existing `stella-mac` SSH alias and `scripts/control-stella-ios.sh`. Read [iOS verification infrastructure](features/ios.md) first.

Do not drive a developer-owned Electron window, the shared `~/.stella` data, a plain Vite tab, or the developer's Mac checkout. Android and backend-only behavior are outside this verifier.

## Desktop control utility

The canonical `/control-app` equivalent is:

```bash
node .agents/skills/verify-stella/control-stella.mjs help
node .agents/skills/verify-stella/control-stella.mjs capabilities
```

The `scripts/control-stella.mjs` file is a compatibility wrapper only. New map entries and agent workflows must use the root entry point.

The CLI uses grouped subcommands with machine-readable JSON. Named product journeys are preferred over raw selectors:

- `session` launches, checks, and describes the isolated app.
- `chat`, `nav`, `settings`, and `apps` encode repeatable Stella journeys.
- `inspect` captures semantic state, components, ARIA, screenshots, and an explicit unsafe eval escape hatch.
- `drive` performs accessible clicks, fills, key chords, scrolling, waits, and settle detection.
- `performance` captures metrics, traces, and CPU profiles.
- `diagnostics` captures owned logs and bounded redacted console/network events.
- `cleanup` previews and applies exact helper-owned teardown.

Use `capabilities` rather than parsing help when an agent needs discovery. Errors are JSON and include a recovery action where possible. Potentially destructive cleanup supports `--dry-run` and also has a dedicated `cleanup plan` command.

## Desktop launch and doctor

From the repository root, with Bun 1.4.x and dependencies installed:

```bash
node .agents/skills/verify-stella/control-stella.mjs session launch
node .agents/skills/verify-stella/control-stella.mjs session doctor
```

Pass `--replace` only after inspecting `cleanup plan` when a stale verifier run is recorded.

Launch is anonymous by default. Pass `--account signed-in`, `--account go`, or `--account pro` to boot with a signed-in test account on that plan (minted per run at `agent-<runId>@test.stella.local` through the dev deployment's admin API; needs `CONVEX_SITE_URL` and `STELLA_ADMIN_API_SECRET`, the latter read via `bunx convex env get` when not exported). The run record and `session describe` report `account.mode`, `account.ownerId`, and `account.email`; the bearer is handed to Electron only through its environment and never written to disk.

Launch creates an isolated run under `.agents/skills/verify-stella/.run/<runId>/`, an isolated durable Stella data directory, and a temporary Chromium user-data directory. It seeds onboarding complete, builds the Electron development main/preload bundle, allocates ephemeral Vite and CDP ports, launches Electron with the verifier harness environment, and writes owned Vite/Electron logs. It preserves protected-storage behavior with a run-scoped key rather than using the developer's keyring.

Doctor exits successfully only when the recorded Vite and Electron processes are alive, Vite answers, CDP has Stella's page target, the conversation top bar exists, Electron device identity is available, and the runtime host answers its health check. A painted shell alone is not healthy.

Never attach by process name or window title. The pointer under `.run/current.json` is the ownership boundary.

## Desktop journeys

Examples of the intended high-level interface:

```bash
node .agents/skills/verify-stella/control-stella.mjs chat ready
node .agents/skills/verify-stella/control-stella.mjs chat new
node .agents/skills/verify-stella/control-stella.mjs chat send --text "list open tasks"
node .agents/skills/verify-stella/control-stella.mjs nav home
node .agents/skills/verify-stella/control-stella.mjs nav history
node .agents/skills/verify-stella/control-stella.mjs settings open
node .agents/skills/verify-stella/control-stella.mjs settings tab --name "Shortcuts"
node .agents/skills/verify-stella/control-stella.mjs settings search --query language
node .agents/skills/verify-stella/control-stella.mjs apps open
node .agents/skills/verify-stella/control-stella.mjs apps state
```

Use lower-level commands when a feature has no named journey:

```bash
node .agents/skills/verify-stella/control-stella.mjs inspect components
node .agents/skills/verify-stella/control-stella.mjs drive click --role button --name "New tab"
node .agents/skills/verify-stella/control-stella.mjs drive fill --placeholder "Do anything" --value "draft"
node .agents/skills/verify-stella/control-stella.mjs drive press --key Shift+Enter
node .agents/skills/verify-stella/control-stella.mjs drive press --key Meta+KeyN
node .agents/skills/verify-stella/control-stella.mjs drive settle
```

Prefer roles, accessible names, placeholders, and named journeys. Use `drive click-xy` only after a fresh `inspect components` identifies the viewport geometry. Use `inspect eval --js` only when the CLI and feature map lack a safe observable. Never use eval to mutate product state as a substitute for a user path.

## Desktop evidence and diagnosis

Store proof under `.agents/skills/verify-stella/artifacts/<feature>/`. Cleanup preserves this directory.

```bash
node .agents/skills/verify-stella/control-stella.mjs inspect aria --path .agents/skills/verify-stella/artifacts/settings/open.aria.txt
node .agents/skills/verify-stella/control-stella.mjs inspect screenshot --path .agents/skills/verify-stella/artifacts/settings/open.png
node .agents/skills/verify-stella/control-stella.mjs diagnostics logs --tail 300
node .agents/skills/verify-stella/control-stella.mjs diagnostics console --duration 2000
node .agents/skills/verify-stella/control-stella.mjs diagnostics network-summary --duration 2000
node .agents/skills/verify-stella/control-stella.mjs performance metrics
node .agents/skills/verify-stella/control-stella.mjs performance trace --duration 3000 --path .agents/skills/verify-stella/artifacts/perf/trace.json
node .agents/skills/verify-stella/control-stella.mjs performance profile --duration 3000 --path .agents/skills/verify-stella/artifacts/perf/profile.json
```

Proof must show the action and resulting state in the Electron window. A screenshot of an idle shell, a successful build, or direct internal state manipulation is not UI proof. For a mutation, read the value back through another visible state or the isolated persisted data. A missing model provider may yield a visible send error; do not hang waiting for output.

Keep diagnostics bounded. Console and network capture redact obvious secret material and avoid response bodies, but artifacts still require review before sharing.

## Desktop cleanup

```bash
node .agents/skills/verify-stella/control-stella.mjs cleanup plan
node .agents/skills/verify-stella/control-stella.mjs cleanup apply --dry-run
node .agents/skills/verify-stella/control-stella.mjs cleanup apply
```

Cleanup targets only the recorded Electron and Vite PIDs, verifier pointer, and temporary Chromium profile. It preserves the isolated durable data and proof artifacts. Do not kill by process name.

## Feature Map maintenance

The Feature Map is a checked contract, not optional prose. Every sibling Markdown file under `features/` must be indexed once and contain the required four sections in order. Validate it and the registered CLI commands with:

```bash
node .agents/skills/verify-stella/scripts/check-feature-map.mjs
```

When product navigation or user-visible behavior changes, update the matching feature file and add or deepen a named CLI journey when agents would otherwise repeat brittle low-level steps. Use `$maintain-verification-skill` for a full source and live audit.

## iOS helper

`scripts/control-stella-ios.sh` runs on Linux and reaches the user's Mac only through `stella-mac`. The project-scoped `.codex/config.toml` starts XcodeBuildMCP through the same SSH boundary for accessibility snapshots and semantic simulator input. The helper can check both layers, stage a disposable snapshot of the Linux working tree, list or boot simulators, launch Stella, open supported deep links, capture the simulator framebuffer or whole Mac screen, retain coordinate input as a fallback, read recent logs, and clean only helper-owned simulator/source state.

Follow [iOS verification infrastructure](features/ios.md) for setup and cleanup, then use the relevant mobile feature map. Do not add cloud/Tailcat instructions. This path is intentionally local over SSH.
