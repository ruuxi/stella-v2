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
- `chat`, `nav`, `settings`, and `apps` encode repeatable Stella journeys (`chat ready|send|state`, `nav home|files|browser`, `settings open|tab|search|state|close`, `apps open|state|ask`).
- `inspect` captures semantic state, components, ARIA, screenshots, and an explicit unsafe eval escape hatch.
- `drive` performs accessible clicks, fills, key chords, scrolling, waits, and settle detection.
- `performance` captures metrics, traces, and CPU profiles.
- `diagnostics` captures owned logs and bounded redacted console/network events.
- `cleanup` previews and applies exact helper-owned teardown.

Use `capabilities` rather than parsing help when an agent needs discovery; it lists each command's `usage`, accepted `flags`, boolean `switches`, and whether a `positional` value is allowed. `<group> <command> --help` prints the same for one command. Unknown options and unexpected positional arguments are rejected with `USAGE` before anything runs.

Every command except `help` and `<command> --help` writes exactly one JSON envelope: `{ok: true, command, data, meta: {schemaVersion, runId, elapsedMs}}` on stdout, or `{ok: false, command, error: {code, message, recovery, retryable}}` on stderr with a non-zero exit. `ok: true` means the command ran, not that the product passed: `session doctor` and `chat ready` return their verdict in `data` (`data.ok`, `data.ready`) and exit 2 when it is negative, and `chat send` exits 2 on `no-new-evidence`. `inspect eval` returns `data.value`. Argument errors carry `code: USAGE` and point to the command's `--help`. Potentially destructive cleanup supports `--dry-run` and also has a dedicated `cleanup plan` command.

Numeric ranges: `chat send --timeout` 500-120000 ms (default 10000); `drive settle --quiet` 100-5000 and `--timeout` up to 13000; `drive wait --timeout` default 10000; `performance trace|profile --duration` 250-10000; `diagnostics console|network-* --duration` 100-10000. `drive scroll [--selector <CSS>] [--x <px>] [--y <px>]` scrolls the document, or the element matched by `--selector`, by that offset and reports `moved` and `scrollable`; target the actual scroll container (Settings content scrolls in `.settings-panel`, not the tabpanel).

## Desktop launch and doctor

From the repository root, with Bun 1.4.x and dependencies installed, and an X display (`DISPLAY`; on Linux a real Hyprland/Wayland session works through XWayland, otherwise run under Xvfb). The window opens on the visible desktop and the compositor may tile or resize it; read geometry from a fresh observation rather than assuming a size:

```bash
node .agents/skills/verify-stella/control-stella.mjs session launch
node .agents/skills/verify-stella/control-stella.mjs session doctor
```

Pass `--replace` only after inspecting `cleanup plan` when a stale verifier run is recorded.

Launch is anonymous by default. Pass `--account signed-in`, `--account go`, or `--account pro` to boot with a signed-in test account on that plan (minted per run at `agent-<runId>@test.stella.local` through the dev backend's admin API; targets `STELLA_BACKEND_URL` (default: the dev cloud-builder worker) and needs `STELLA_ADMIN_API_SECRET`, read from the gitignored `workers/cloud-builder/.dev.vars` when not exported). The run record and `session info` report `account.mode`, `account.ownerId`, and `account.email`; the bearer is handed to Electron only through its environment and never written to disk.

Every launch is a fresh profile, so an anonymous launch signs up a new anonymous user on the dev deployment each time; five of those from one IP in a day trip the sybil counters. Pass `--reuse` to boot from one anonymous session kept per machine at `.agents/skills/verify-stella/.run/anonymous-session.json` (owner-readable, dev only): the harness verifies the saved bearer against `STELLA_BACKEND_URL` and mints a replacement when it is missing, stale, or for another backend. The run record reports `account.reused` and `account.userId`. Omit `--reuse` when the run needs a never-seen user, for example onboarding or first-sign-in checks; a reused anonymous user carries its cloud conversation over between runs, so start a new chat when a clean transcript matters. `--reuse` is rejected with a test-account mode.

Launch creates an isolated run under `.agents/skills/verify-stella/.run/<runId>/`, an isolated durable Stella data directory, and a temporary Chromium user-data directory. It seeds onboarding complete, allocates an ephemeral CDP port, and launches Electron from source (`electron <repo> --dev`) with `STELLA_DEV_HARNESS=1` and an allow-listed environment; there is no Vite or other dev server, and main/preload rebuild themselves when stale. Electron output goes to the owned `electron.log`. It preserves protected-storage behavior with a run-scoped key rather than using the developer's keyring. A launch takes a few seconds; the active conversation id can appear a moment after `session doctor` first passes, so retry `chat ready` once before treating `ready: false` as a failure.

The temporary Chromium profile and the runtime IPC directory (`STELLA_RUNTIME_IPC_DIR`) live under `<tmp>/stella-verify-<runId>/`. On macOS, `<tmp>` is `/tmp/sv` and Electron's `TMPDIR` is shortened to it too: the per-user `/var/folders/.../T` path pushes the runtime and CLI-bridge Unix sockets (`<ipc>/stella-<uid>/<hash>/r.sock`, `<ipc>/stella-<uid>/<hash>/<nonce>/b.sock`) and Chromium's singleton socket past the 104-byte `sun_path` limit. Other platforms use the system temp directory.

### What the run shares with the host

Isolated per run: the Stella data directory (`~/.stella` equivalent: conversations, preferences, ChatGPT and API-key credentials, connectors), Electron user data and Chromium profile, protected storage (a run-scoped key, not the OS keyring), the runtime IPC sockets, the browser bridge (unless `--browser-bridge shared`), and the Claude Code and Codex CLI configs (`CLAUDE_CONFIG_DIR` and `CODEX_HOME` point at `.run/<runId>/provider-homes/`, so a fresh run shows "Claude Code on this computer isn't signed in"). Electron gets only an allow-listed environment, so host API keys and tokens in the shell do not reach it.

Shared with the host: the user account and its home directory (`HOME` is not overridden, so agent shell commands and file tools run against the real home, and onboarding discovery would read host browser, shell, and project history if onboarding ran), the CLIs on `PATH` (the `claude`/`codex` binaries, git and its global config), the display and `XDG_RUNTIME_DIR`, and the network. On macOS, a CLI that keys the keychain by config directory stays isolated; anything that reads a fixed keychain item does not. Some copy is hard-coded for macOS ("this Mac" in Cloud Home import and Locked computer use) and appears on Linux too; it is not leaked state. Runs before this change saw the host's default Claude Code login.

The harness runs an isolated browser bridge by default, so the Browser section shows "Extension isn't connected" and the user's Chrome extension cannot reach it. `--browser-bridge shared` sets `STELLA_BROWSER_BRIDGE=shared`, which claims the per-user shared bridge (fixed extension port and native-messaging host) from any running Stella, including the user's installed app. Use it only when an extension-backed browser claim needs proof and taking over the bridge on that machine is acceptable; relaunching the installed app reclaims it.

During the native runtime migration, `--runtime-binary packages/runtime-rust/target/debug/stella-runtime`
selects an explicitly built Rust executable. The helper forwards its absolute path
through the restricted launch environment and isolates its IPC directory. The
optional `--model-gateway <origin>` overrides gateway discovery for a specific
deployment; omit it to verify discovery from the signed-in catalog. The native
process remains an incomplete replacement until the runtime migration is finished.

Doctor exits successfully only when the recorded Electron process is alive, CDP has Stella's full-window page target (`index.html?window=full`; the run also exposes `overlay.html?window=overlay` and, when enabled, the two companion targets), the full-window top bar `.shell-topbar-full` exists, Electron device identity is available, and the runtime host answers its health check. A painted shell alone is not healthy.

Never attach by process name or window title. The pointer under `.run/current.json` is the ownership boundary.

## Desktop journeys

Examples of the intended high-level interface:

```bash
node .agents/skills/verify-stella/control-stella.mjs chat ready
node .agents/skills/verify-stella/control-stella.mjs chat send --text "list open tasks"
node .agents/skills/verify-stella/control-stella.mjs nav home
node .agents/skills/verify-stella/control-stella.mjs nav files
node .agents/skills/verify-stella/control-stella.mjs settings open
node .agents/skills/verify-stella/control-stella.mjs settings tab --name "Shortcuts"
node .agents/skills/verify-stella/control-stella.mjs settings search --query language
node .agents/skills/verify-stella/control-stella.mjs apps open
node .agents/skills/verify-stella/control-stella.mjs apps state
```

Use lower-level commands when a feature has no named journey:

```bash
node .agents/skills/verify-stella/control-stella.mjs inspect components
node .agents/skills/verify-stella/control-stella.mjs drive click --role button --name "Open panel"
node .agents/skills/verify-stella/control-stella.mjs drive click --role button --name "New tab"
node .agents/skills/verify-stella/control-stella.mjs drive fill --placeholder "Do anything" --value "draft"
node .agents/skills/verify-stella/control-stella.mjs drive press --key Shift+Enter
node .agents/skills/verify-stella/control-stella.mjs drive press --key Control+KeyT
node .agents/skills/verify-stella/control-stella.mjs drive settle
```

The desktop is a single-chat product: the full-window top bar carries only the centred Activity mark, the account button (`Account, <plan> plan`; signed out it is a sign-in button plus a `Settings` gear), and `Open panel`. There is no conversation history, conversation tabs, or New chat control; the active conversation comes from the root route (`?c=`). A fresh `session launch` is the way to get an empty conversation. The workspace panel (Open panel, or right-click in chat) has a tab strip (`Sidebar` tablist), `New tab`, `Close panel`, a launcher with Files, Apps, Browser and Updates, and `Run on <target>` / `Models` controls at its foot.

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

Cleanup targets only the recorded Electron PID (its process group), verifier pointer, and temporary Chromium profile. It preserves the isolated durable data and proof artifacts. Do not kill by process name; the developer's own Stella window shares the `stella-v2` window class. The detached Bun runtime worker (`--listen unix:///…/stella-verify-<runId>/…/r.sock`) and Chromium's crashpad handler outlive the Electron PID by up to about a minute and a half, then exit on their own once their parent and socket are gone.


## Observation and interaction results

`inspect observe --path <directory> [--since <observation.json>]` writes uniquely named JSON, PNG, and Chromium accessibility-tree text artifacts. It returns state, controls, accessibility, paths, and capture timestamps. The samples are sequential; use timing tools for animation or races. Comparisons require the same run and report changed state fields, added/removed controls (including geometry changes), and whether the accessibility tree changed. Controls use light-DOM discovery; the screenshot and accessibility tree can reveal additional surfaces. The older `inspect aria` command remains a DOM-derived outline.

`drive click` and `drive fill` require a unique visible match. On ambiguity they return `AMBIGUOUS_TARGET`, the total match count, and up to 20 candidates with labels and geometry. Narrow the target with `--within <CSS scope>` or `--selector`; inspection and targeting share name/role handling. `drive wait` checks existence and permits multiple matches.

`nav home` checks the automatic Home overlay and fails with `APP_NOT_READY` when it is not showing; it never creates a conversation.

`drive settle` waits for a quiet DOM interval. Mutations inside `svg[aria-hidden="true"]` are ignored because the top-bar Stella mark and working indicator animate continuously; pass `--ignore <CSS>` to exclude another known-decorative region. The result reports how many mutations it ignored.

`apps open`, `nav files`, and `nav browser` open the panel if needed, then use New tab and the launcher, so each call adds a tab. A transient menu or dialog left open (account menu, model picker) hides the launcher and makes these time out; press Escape first.

`chat send` uses the Home composer while the chat layer is obscured and observes new messages after the overlay closes. It reports `action: enter-dispatched`, plus `observation: new-user-message`, `new-notice`, or `no-new-evidence`. It compares message IDs and notices in the active conversation against the pre-send state. Timeout returns observations with exit code 2. A new notice is not classified as a provider error; a visible user message does not prove backend acceptance or assistant completion. `responseCompletion` is explicitly `not-assessed`.

`settings open|tab|state|close` return the shell state (`settingsOpen`, `selectedTabs`, composer), not the dialog's contents; `settings search` also returns the result text. Read dialog contents with `inspect observe`, `inspect components`, or a screenshot. Settings has no Stella plan field: the plan is on the top-bar account button (`Account, Pro plan`) and under that menu's **Plan & usage** ("CURRENT PLAN"). Clicking a Settings search result switches to its tab but does not scroll to the section; scroll `.settings-panel`.

`apps open` and `apps state` return bounded surface text with `classification: not-assessed`; the previous inferred `state` field is removed. `chat send` no longer returns the broad page-text `providerErrorVisible` guess. `ok` means the command ran, not that the feature passed. Text redaction is best-effort and screenshots are unredacted; review artifacts before sharing.
