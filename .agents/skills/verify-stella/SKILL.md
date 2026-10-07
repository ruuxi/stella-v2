---
name: verify-stella
description: Prove a change to Stella itself works in the real product before calling it done. Use after changing Stella's desktop app, runtime, mobile app, or backend, or when asked to check, reproduce, or screenshot Stella behavior. Drives an isolated desktop Electron instance or the iOS Simulator app, each signed into a dev test account, and diagnoses cloud turns. Needs a stella-v2 checkout; iOS needs the Mac. Not for verifying the user's other apps or websites.
---

# Verify Stella

Run every command from the root of a stella-v2 checkout; paths below are relative to it. When this skill was loaded from `~/.stella/skills/verify-stella`, that folder links into the checkout it came from: `cd "$(dirname "$(realpath ~/.stella/skills/verify-stella/SKILL.md)")/../../.."`. To verify a draft or worktree instead, run the same paths from that tree.

Establish whether the requested behavior works in the real product. Use your judgment to choose interactions, coverage, and evidence based on the change and what you observe. The feature map is product context and a collection of examples, not a required test suite.

## What to prove

Start from the user's claim or the regression being fixed. Choose a realistic situation that would distinguish correct behavior from the suspected failure. The diff, nearby source, and live app can help identify affected states; consult the relevant [feature notes](features/README.md) when they add useful context. Adapt dated recipes to the current product.

Coverage should follow the mechanism and risk. A search change may need a result-to-destination interaction; a saved preference may need reopening or relaunching; a startup race may need a fresh launch. Exercise additional entry points when they have distinct behavior or could expose the same failure. A small visual edit does not imply a tour of every feature.

Match evidence to the claim. Show the real user action and its result. Read back mutations where persistence or downstream effects matter. Use screenshots for appearance, semantic state for control behavior, and traces or profiles for responsiveness. A still screenshot cannot establish smooth animation. Store useful evidence under `.agents/skills/verify-stella/artifacts/<feature>/`.

A helper succeeding proves only what it actually observed. A healthy shell is not a working feature; a submitted message is not a completed agent task; a visible provider error demonstrates an error path, not a successful response. Report what passed, what failed, and what remains unverified, with enough evidence to support those distinctions. Missing prerequisites should identify the affected claim and the concrete blocker.

## Available capabilities

The desktop CLI owns an isolated Electron instance and exposes inspection, interaction, diagnostics, and optional journey shortcuts:

```bash
node .agents/skills/verify-stella/control-stella.mjs help
node .agents/skills/verify-stella/control-stella.mjs capabilities
node .agents/skills/verify-stella/control-stella.mjs session launch --account pro
```

Electron needs a display (`DISPLAY`: a real session or Xvfb). The desktop is one conversation with no history or New chat control; launch a fresh run (`--replace`) when the claim needs an empty conversation. The harness runs an isolated browser bridge; read the desktop reference before using `--browser-bridge shared`.

Choose the account and initial state needed for the claim. `--account pro` uses a dev test account; anonymous, other plans, and reuse options are documented in the [desktop reference](references/desktop.md). Launch seeds onboarding complete, so its default state cannot prove first-run onboarding.

`inspect observe --path <directory>` captures semantic state, controls, Chromium accessibility, and a screenshot together; `--since <observation.json>` reports changes from a capture in the same run. Capture is sequential, not atomic. `inspect state`, `inspect components`, `inspect aria`, and `inspect screenshot` also expose individual views. `drive` provides clicks, fills, keys, scrolling, and waits. `chat`, `nav`, `settings`, and `apps` offer convenience macros. Choose whichever gives an understandable interaction with the current UI; there is no requirement to use a named journey first. If a macro's assumptions no longer fit, inspect the app and use the underlying controls. `<group> <command> --help` (or `capabilities`) lists a command's options and ranges; unknown options are rejected. Every command prints one JSON envelope (`ok`, `command`, `data` or `error`, `meta`); `ok` means the command ran, not that the product passed. `settings` macros report shell state, not dialog contents.

`session doctor` distinguishes shell, device identity, and runtime readiness. `diagnostics` and `performance` help explain failures and timing. DOM quietness from `drive settle` does not establish completion of network or agent work; it ignores animated decorative SVGs such as the top-bar mark, and `--ignore <CSS>` skips other known-decorative regions. `apps state` returns surface text without a readiness verdict. `chat send` distinguishes a new visible user message, a new notice, and a timeout; none establishes completion of an assistant response. Ambiguous click/fill targets return candidates; narrow them with `--within <CSS scope>` or a specific selector.

For iOS, read the [infrastructure reference](features/ios.md). `scripts/control-stella-ios.sh` runs directly on the Mac, or from Linux over the `stella-mac` SSH alias; it stages disposable source, boots a simulator, builds the dev app against the dev backend (`build`), and signs it into a dev test account (`sign-in --plan pro`), then captures framebuffer proof. Semantic input comes from XcodeBuildMCP, either as project-scoped MCP tools or through its CLI when your harness has no such tools. A reused simulator keeps the previous run's installed app, data, and session, so a cold build is not a clean baseline, and the reference's cleanup list covers the installed app, Xcode DerivedData, the MCP daemon, and the minted test account. Mobile feature notes describe product-specific context.

For cloud-side behavior, [cloud verification](references/cloud.md) describes `cloud-turn.mjs` and executor diagnostics. Headless execution can prove a cloud claim; it cannot establish the desktop dispatch or browser handoff that it bypasses.

## Isolation and evidence boundaries

Drive only the helper-owned Electron run recorded in `.run/current.json`, with isolated data and Chromium profiles. The run also isolates protected storage and the Claude Code and Codex CLI configs, but shares the host home directory, the CLIs on `PATH`, the display, and the network; the desktop reference lists exactly what is shared. The developer's window, shared `~/.stella`, and Mac checkout are not verification fixtures. Keep cleanup limited to recorded owned resources; `cleanup plan` and `cleanup apply --dry-run` expose the targets. Preserve evidence and durable run data.

Use observed controls and current geometry for input. Read-only eval can fill an observability gap, but internal setters or direct database mutations cannot substitute for the user path being tested. Fixture setup should be distinguishable from the action under verification. Do not expose credentials in diagnostics or shared artifacts.

## Maintaining this skill

Keep feature notes focused on product behavior, entry points, non-obvious dependencies, and useful source pointers. Examples can illustrate a tricky interaction without prescribing a complete run. Use whatever document structure communicates that information clearly.

Improve the harness when a recurring mechanical problem needs deterministic handling. Prefer richer observations and general interaction capabilities; add a journey macro when it saves repetitive navigation without hiding evidence needed to judge the result.

`node .agents/skills/verify-stella/scripts/check-feature-map.mjs` checks feature links and registered command references. It does not judge verification coverage or enforce a prose template.

This folder is the only copy. Stella agents see it through `~/.stella/skills/verify-stella`, a real folder whose entries are symlinks into the checkout (Stella's skill catalog skips a symlinked skill folder, and a real folder keeps `.run/` and `artifacts/` out of `~/.stella`). After adding a top-level file or folder here, rerun `.agents/skills/verify-stella/scripts/install-stella-skill.sh` on each machine.
