---
name: create-stella-app
description: Scaffold a standalone Vite React app in Stella's writable workspace. Use when the user asks Stella to build them an app, then work only inside that app project.
---

# Creating a Stella app

A Stella app is an ordinary Vite React TypeScript project stored outside the
Stella installation. Its default location is:

```text
~/.stella/workspace/apps/<slug>/
```

When `STELLA_DATA_DIR` is set, the root is instead
`$STELLA_DATA_DIR/workspace/apps/<slug>`. This keeps development and packaged
app data isolated. Never write a user app into Stella's source tree or install
its dependencies in Stella's root package.

## Scaffold

Run the scaffold script beside this skill's `SKILL.md`:

```sh
bun <this-skill-directory>/scripts/program.ts <slug> <name words...>
```

`<slug>` must be lowercase `[a-z][a-z0-9-]*` and at most 32 characters.
The script refuses to overwrite an existing app and publishes the project only
after every template file has been written successfully.

It creates:

```text
stella.app.json
package.json
index.html
vite.config.ts
tsconfig.json
.gitignore
src/App.tsx
src/main.tsx
src/app.css
src/vite-env.d.ts
```

`stella.app.json` is the library metadata contract:

```json
{
  "schemaVersion": 1,
  "slug": "focus-timer",
  "name": "Focus Timer",
  "createdAt": "2026-01-01T00:00:00.000Z"
}
```

The directory name and manifest slug must remain identical.

## Build the app

After scaffolding, change into that app directory and install there:

```sh
cd "$STELLA_DATA_DIR/workspace/apps/<slug>" # or ~/.stella/workspace/apps/<slug>
bun install
bun run check
bun run build
```

Add packages from the app directory only:

```sh
bun add <package>
```

Stella's managed app runtime launches the project's local Vite installation on
loopback and embeds its URL in the Apps sidebar. Stella discovers the app from
`stella.app.json`; do not add it to a renderer registry. Source changes use
Vite HMR; the built `dist/` directory is validation output, not the live
discovery protocol. Do not start a second manual dev server unless you are
explicitly debugging the project outside Stella.

### Apps with multiple processes

The metadata-only manifest remains the default and is fully backward
compatible. When an app needs its own API, worker, or other cooperating local
service, declare the complete process set in the optional `runtime` block:

```json
{
  "schemaVersion": 1,
  "slug": "local-dashboard",
  "name": "Local Dashboard",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "runtime": {
    "frontend": "web",
    "processes": [
      {
        "id": "api",
        "command": "bun",
        "args": ["run", "api"],
        "port": "auto",
        "readiness": { "type": "http", "path": "/health" }
      },
      {
        "id": "web",
        "command": "bun",
        "args": [
          "x",
          "vite",
          "--host",
          "127.0.0.1",
          "--port",
          "${PORT}",
          "--strictPort"
        ],
        "port": "auto",
        "readiness": { "type": "http", "path": "/" }
      }
    ]
  }
}
```

Processes start and become ready in declaration order. Stella opens only the
declared frontend after every process is ready. A failed launch rolls back all
processes, and app stop or Stella shutdown terminates every process tree.
Repeated start and stop requests are idempotent.

Commands are spawned directly without a shell. `"bun"` selects Stella's
bundled Bun. A process with `"port": "auto"` receives `PORT` and
`STELLA_APP_PORT`; arguments can reference `${PORT}`. Every process also
receives stable sibling values such as `STELLA_APP_PORT_API` and
`STELLA_APP_URL_API`. Process ids are lowercase slugs and become uppercase
with hyphens changed to underscores in those environment names. Use HTTP
readiness for a health endpoint, TCP readiness for a listening socket, or
process readiness only for workers that have no port.

A process that needs more than one socket can add named TCP or UDP ports, for
example `"ports": [{ "id": "rtc-udp", "protocol": "udp" }]`. The process
receives `STELLA_APP_PORT_RTC_UDP`, and siblings receive the fully qualified
`STELLA_APP_PORT_<PROCESS>_RTC_UDP` name.

## Project boundaries

- Work only inside the generated app directory.
- Do not edit Stella's renderer, routes, registries, package.json, or lockfile.
- Do not assume access to Electron, Stella renderer imports, or host globals.
- Keep `vite.config.ts` base set to `"./"` and use the provided scripts.
- Store app-owned source and assets in the project. Do not reach back into the
  Stella installation with relative paths.

## Visual style

The app fills an embedded panel that can range from narrow sidebar width to a
large content surface. Build a complete responsive page, not a tiny widget in
the middle of empty space.

- Size against the app's own viewport or a local CSS container.
- Define app-local colors and type choices; host CSS variables and fonts do not
  cross the iframe boundary.
- Support light and dark mode with `prefers-color-scheme` until a host theme
  bridge is explicitly available.
- Cover keyboard focus, empty/loading/error states, narrow layouts, reduced
  motion, and long content where relevant.
- Avoid filler cards, decorative badges, gratuitous gradients, and controls
  that do not serve the app.
