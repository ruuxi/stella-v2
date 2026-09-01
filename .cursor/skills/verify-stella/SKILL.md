---
name: verify-stella
description: Drive the Stella desktop Electron app (chat, settings, apps, history, home) the way a user does. Use when proving Stella UI behavior, launching an isolated electron:dev instance, or checking that a desktop-ui or Electron change still works from the shell.
---

# Verify Stella

Stella's user-facing product is the Electron desktop shell. The renderer is a Vite app at a loopback URL, but the composer, conversation store, and settings persistence go through `window.electronAPI`. A browser tab on the Vite URL is not the app: the composer stays disabled until Electron creates a conversation.

Do not drive a live `bun run electron:dev` session or `~/.stella`. Dev Electron strips inherited `STELLA_DATA_DIR`, honors only `STELLA_V2_DEV_DATA_DIR` for durable state, and single-instance-locks on its user-data directory. This skill starts its own isolated pair.

Secondary surfaces this skill does not cover: the iOS/Android app, Convex backend, and `bun packages/runtime/headless/cli.ts`. Those need credentials or a device. Note them if a change is backend-only.

## Launch

From the repo root, with bun 1.4.x and `STELLA_SKIP_BROWSER_HYDRATE=1 bun install` already done:

```bash
node .cursor/skills/verify-stella/scripts/control-stella.mjs launch
```

Pass `--replace` if a previous verification instance is still recorded.

What launch does:

1. Creates `.cursor/skills/verify-stella/.run/<runId>/data/` for sqlite and preferences. Chromium user-data cannot live in the repo: `STELLA_DEV_HARNESS=1` rejects a profile that overlaps the workspace. That profile goes under `os.tmpdir()/stella-verify-<runId>/electron-user-data`.
2. Seeds `data/ui-state.json` (`stella-onboarding-complete=true`) and `data/preferences.json` (`onboardingCompleted`). Onboarding must already be complete or the shell never reaches the ready selector below.
3. Runs `node packages/desktop/scripts/dev-electron-build.mjs --once`.
4. Starts Vite with bun as the runtime (`bun --bun node_modules/vite/bin/vite.js` from `packages/desktop-ui`). Node cannot load the TypeScript imports in `vite.config.ts`. Sets `STELLA_DEV_SERVER_URL=http://127.0.0.1:<ephemeral>` and `STELLA_DATA_DIR` to the isolated data dir. Vite's ui-state plugin reads `STELLA_DATA_DIR`, not `STELLA_V2_DEV_DATA_DIR`.
5. After Vite answers HTTP, starts Electron with `--dev` and `STELLA_DEV_HARNESS=1`, `STELLA_V2_DEV_USER_DATA_DIR` on the tmp profile, `STELLA_REMOTE_DEBUG_PORT`, `STELLA_V2_DEV_DATA_DIR` on the isolated data dir, and `--remote-allow-origins=*`. Passing only `--user-data-dir` is not enough: unpackaged Stella still moves userData to `Stella Development` unless the harness env is set, then single-instance-locks that shared profile. The Electron child receives only system launch variables (`PATH`, temp, locale, `DISPLAY`, `XDG_RUNTIME_DIR`) plus Stella's harness variables. Do not spread the editor's full environment into Electron; on this Linux session that let the renderer paint but wedged CDP before `/json/list` could answer. Each run gets a random AES-256-GCM key for its isolated protected-storage provider, which keeps the verifier out of the developer's real D-Bus keyring while preserving encrypted-at-rest behavior. The key is consumed at startup, lives only in the Electron process, and becomes unrecoverable when the process exits. Linux always gets `--no-sandbox` and `--disable-dev-shm-usage`. Software GL (`--disable-gpu`, `--in-process-gpu`, `--enable-unsafe-swiftshader`, `--ozone-platform=x11`, `LIBGL_ALWAYS_SOFTWARE=1`) is only for machines without `/dev/dri`, or when `STELLA_VERIFY_SOFTWARE_GL=1`.

Ready: `GET` on the Vite URL succeeds, CDP `/json/list` returns a page whose URL contains `index.html` or `window=full`, `[data-testid="conversation-topbar"]` is in the DOM, the Electron device-identity bridge returns a non-empty id, and the runtime host answers its health check. These last checks prevent a painted shell from reporting ready while protected storage or the detached runtime failed during startup. CDP probes have a 1.5 second request timeout so a wedged inspector cannot hang launch forever. Launch prints the run record as JSON. Logs are `vite.log` and `electron.log` under the run directory.

Linux cloud agents need `DISPLAY` (this environment uses `:1`). The software-GL flags are for that kind of container, not for a normal developer GPU.

Two verification instances can run together if each has its own Vite port, CDP port, data dir, and tmp user-data dir. They will not if they share Chromium user-data: `app.requestSingleInstanceLock()` quits the second process.

## Doctor

```bash
node .cursor/skills/verify-stella/scripts/control-stella.mjs doctor
```

Requires the pointer file `.cursor/skills/verify-stella/.run/current.json` from a launch this helper performed. Exit 0 only when all of these are true:

- Vite and Electron PIDs from that record are still alive
- The recorded Vite URL answers HTTP
- CDP on the recorded port has a page target
- `[data-testid="conversation-topbar"]` is present
- Electron can read or create its protected device identity and reach the runtime host

If the top bar is missing, onboarding is still up or the renderer failed. Do not click through the product onboarding during verification. Stop, fix the seed files, relaunch.

Never attach to some other Electron on the machine because its title is Stella.

## Drive

All drive commands talk to the launched instance over CDP. Prefer accessible names from English `packages/desktop-ui/src/shared/i18n/locales/en.json`. Keep the UI locale on English (the seeded profile does).

```bash
node .cursor/skills/verify-stella/scripts/control-stella.mjs doctor
node .cursor/skills/verify-stella/scripts/control-stella.mjs click --role button --name "Settings"
node .cursor/skills/verify-stella/scripts/control-stella.mjs click --role menuitem --name "Settings"
node .cursor/skills/verify-stella/scripts/control-stella.mjs wait --role tab --name "General"
node .cursor/skills/verify-stella/scripts/control-stella.mjs fill --placeholder "Do anything" --value "hello from verify"
node .cursor/skills/verify-stella/scripts/control-stella.mjs press --key Enter
node .cursor/skills/verify-stella/scripts/control-stella.mjs press --key Escape
```

Stable handles:

| Control         | Handle                                                                               |
| --------------- | ------------------------------------------------------------------------------------ |
| Shell ready     | `[data-testid="conversation-topbar"]`                                                |
| New chat        | `button` named `New chat`                                                            |
| Composer        | textbox with placeholder `Do anything` (`textarea.composer-input`)                   |
| Send            | `Enter` in the composer. The submit control is an unlabeled `button.composer-submit` |
| History         | `button` named `Conversation history`                                                |
| Home            | `button` named `Home`                                                                |
| Settings        | `button` named `Settings`, then a menu item named `Settings`                         |
| Settings dialog | `dialog` titled `Settings`, tablist named `Settings`                                 |
| Settings tabs   | `tab` named `General`, `Shortcuts`, `Account & Legal`, `Audio`                       |
| Close settings  | `Escape` (the X uses `[data-slot="dialog-close-button"]` with no accessible name)    |
| New sidebar tab | `button` named `New tab`                                                             |
| Apps launcher   | button whose name is `Apps`                                                          |

Read the matching file under `features/` before driving a feature. Drive every entry point that file lists, or report the skipped one as unverified.

## Evidence

Put proof under `.cursor/skills/verify-stella/artifacts/<feature>/`. That directory is gitignored. Cleanup must not delete it.

```bash
node .cursor/skills/verify-stella/scripts/control-stella.mjs snapshot --path .cursor/skills/verify-stella/artifacts/settings/open.aria.txt
node .cursor/skills/verify-stella/scripts/control-stella.mjs screenshot --path .cursor/skills/verify-stella/artifacts/settings/open.png
```

Proof standards:

- Exercise the Electron window, not Vite in an external browser and not `window.electronAPI` from a scratch script.
- Capture the action and the resulting state. A screenshot of the idle shell is not proof that Settings opened.
- For mutations, read the value back from a second user-facing view (reopen the chat, reopen the tab) or from `data/preferences.json` / `data/stella.sqlite` in the isolated data dir.
- A live model reply is not required. Sending without a connected provider is allowed to error. The user message appearing in the timeline, or the composer/submit state changing, is the proof.
- Record the feature id and the entry point in the artifact names.

## Cleanup

```bash
node .cursor/skills/verify-stella/scripts/control-stella.mjs stop
```

Stop kills only the Vite and Electron PIDs recorded in `.run/current.json`, then removes that pointer and the tmp Chromium profile. It does not kill by process name, does not delete `artifacts/`, and does not delete the run's `data/` directory (useful if you still need sqlite). After a failed launch or drive, run stop before trying again so the ephemeral ports are free.

Confirm artifacts remain:

```bash
ls .cursor/skills/verify-stella/artifacts
```

## Helpers

`scripts/control-stella.mjs` is executable via `node`. Commands: `launch`, `doctor`, `stop`, `info`, `eval --js`, `click`, `fill`, `press`, `wait`, `screenshot`, `snapshot`. `info` reprints the current run record. `eval` is an escape hatch; prefer named click/fill/wait so the feature map stays the source of handles.
