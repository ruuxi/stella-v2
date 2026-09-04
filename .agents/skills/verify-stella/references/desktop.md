# Desktop harness reference

Consult this for launch options, account setup, diagnostic commands, and ownership mechanics. Command examples are a toolbox, not a required sequence. Choose evidence and coverage using SKILL.md.

## Desktop control utility

The canonical `/control-app` equivalent is:

```bash
node .agents/skills/verify-stella/control-stella.mjs help
node .agents/skills/verify-stella/control-stella.mjs capabilities
```

The `scripts/control-stella.mjs` file is a compatibility wrapper only. New map entries and agent workflows must use the root entry point.

The CLI uses grouped subcommands with machine-readable JSON. Named product journeys are optional convenience macros:

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

Launch is anonymous by default. Pass `--account signed-in`, `--account go`, or `--account pro` to boot with a signed-in test account on that plan (minted per run at `agent-<runId>@test.stella.local` through the dev deployment's admin API; needs `CONVEX_SITE_URL` and `STELLA_ADMIN_API_SECRET`, the latter read via `bunx convex env get` when not exported). The run record and `session info` report `account.mode`, `account.ownerId`, and `account.email`; the bearer is handed to Electron only through its environment and never written to disk.

Every launch is a fresh profile, so an anonymous launch signs up a new anonymous user on the dev deployment each time; five of those from one IP in a day trip the sybil counters. Pass `--reuse` to boot from one anonymous session kept per machine at `.agents/skills/verify-stella/.run/anonymous-session.json` (owner-readable, dev only): the harness verifies the saved bearer against `CONVEX_SITE_URL` and mints a replacement when it is missing, stale, or for another backend. The run record reports `account.reused` and `account.userId`. Omit `--reuse` when the run needs a never-seen user, for example onboarding or first-sign-in checks; a reused anonymous user carries its cloud conversation over between runs, so start a new chat when a clean transcript matters. `--reuse` is rejected with a test-account mode.

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

Use current observations to choose roles, accessible names, placeholders, or a suitable named journey. Use `drive click-xy` only after a fresh `inspect components` identifies the viewport geometry. Use `inspect eval --js` only when the CLI and feature map lack a safe observable. Never use eval to mutate product state as a substitute for a user path.

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


## Observation and interaction results

`inspect observe --path <directory> [--since <observation.json>]` writes uniquely named JSON, PNG, and Chromium accessibility-tree text artifacts. It returns state, controls, accessibility, paths, and capture timestamps. The samples are sequential; use timing tools for animation or races. Comparisons require the same run and report changed state fields, added/removed controls (including geometry changes), and whether the accessibility tree changed. Controls use light-DOM discovery; the screenshot and accessibility tree can reveal additional surfaces. The older `inspect aria` command remains a DOM-derived outline.

`drive click` and `drive fill` require a unique visible match. On ambiguity they return `AMBIGUOUS_TARGET`, the total match count, and up to 20 candidates with labels and geometry. Narrow the target with `--within <CSS scope>` or `--selector`; inspection and targeting share name/role handling. `drive wait` checks existence and permits multiple matches.

`chat send` reports `action: enter-dispatched`, plus `observation: new-user-message`, `new-notice`, or `no-new-evidence`. It compares message IDs and notices in the active conversation against the pre-send state. Timeout returns observations with exit code 2. A new notice is not classified as a provider error; a visible user message does not prove backend acceptance or assistant completion. `responseCompletion` is explicitly `not-assessed`.

`apps open` and `apps state` return bounded surface text with `classification: not-assessed`; the previous inferred `state` field is removed. `chat send` no longer returns the broad page-text `providerErrorVisible` guess. `ok` means the command ran, not that the feature passed. Text redaction is best-effort and screenshots are unredacted; review artifacts before sharing.
