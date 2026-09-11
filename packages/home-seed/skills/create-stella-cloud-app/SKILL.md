---
name: create-stella-cloud-app
description: Create and update apps during cloud execution. Write app files in the cloud workspace; Stella builds, hosts, and displays them in Apps on desktop, web, and mobile. Use for cloud app requests instead of the local create-stella-app skill.
---

# Create a Stella cloud app

Use ordinary Write/Edit/apply_patch tools. No special app tool, shell, sandbox,
manual server, or deployment command is needed. Work in
`/workspace/world/apps/<slug>/`, where slug is lowercase `[a-z][a-z0-9-]{0,31}`.

Write the app files first, then write `stella.app.json` LAST:

```json
{ "schemaVersion": 1, "slug": "counter", "name": "Counter", "revision": "1" }
```

Each revision's files live in `revisions/<revision>/`. Use a NEW revision for
every update, copy the complete app into it, and change the manifest last.
Never modify a published revision. Stella snapshots and bundles that revision,
retains the last working build if the new one fails, and discovers the app in
Apps automatically. Read `build-status.json` in the app folder after publishing;
fix reported errors with a new revision. Do not claim success before it is ready.

## Files

- `revisions/1/public/index.html`: required frontend. Use relative asset URLs.
- `revisions/1/public/styles.css`: optional app styles and other static assets.
- `revisions/1/src/server.ts`: optional backend exporting `class App extends DurableObject`.
- `revisions/1/src/client.tsx`: optional bundled React/TypeScript frontend. Reference
  `./client.js` from index.html. Package imports are resolved from package.json.
- `revisions/1/package.json`: optional dependencies with exact versions.

A plain HTML/CSS/JavaScript frontend is fine. For React use React and react-dom
in package.json, `createRoot`, and `src/client.tsx`. No Vite config or npm install.

Backend example:

```ts
import { DurableObject } from "cloudflare:workers";
export class App extends DurableObject {
  async fetch(request: Request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/count") {
      let count = (await this.ctx.storage.get<number>("count")) ?? 0;
      if (request.method === "POST")
        await this.ctx.storage.put("count", ++count);
      return Response.json({ count });
    }
    return new Response("Not found", { status: 404 });
  }
}
```

Call it from the frontend with `fetch('./api/count')`. Backend storage is private
to this app and persists across code revisions and restarts. The runtime supplies
no Stella credentials or bindings and backend outbound networking is disabled.
Use only Workers-compatible code; do not create Express servers or start processes.
Keep app data in backend storage, not localStorage (the embedded app has an isolated
browser origin). Static apps need no server.ts.
Do not use window.alert(), window.confirm(), window.prompt(), window.open(),
or browser storage APIs. Use an in-page confirmation panel or HTML <dialog>
for destructive actions; native browser dialogs are blocked in the isolated frame.

Build a complete responsive interface suitable for a narrow sidebar, browser,
and mobile screen. Include loading, empty, and error states, accessible controls,
and light/dark colors. Test the actual UI and persistence when browser access is
available. The app is private to the user; do not describe its address as public.
