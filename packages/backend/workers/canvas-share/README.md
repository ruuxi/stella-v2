# canvas-share Worker

Serves published canvas documents from the `stella-canvas-shares` R2 bucket at
`GET /c/:slug`. The Convex backend (`convex/data/canvas_shares_actions.ts`)
writes and deletes the objects; this Worker is the read-only public serving
layer.

## Behavior

- `GET /c/<slug>` → fetches `shares/<slug>.html` from R2.
  - Missing object → `404`.
  - `expires-at` custom metadata in the past → `404` (object is lazily deleted).
  - Otherwise → the HTML with:
    - `Content-Type: text/html; charset=utf-8`
    - `X-Content-Type-Options: nosniff`
    - `X-Robots-Tag: noindex, nofollow`
    - `Referrer-Policy: no-referrer`
    - `Cache-Control: public, max-age=60`
    - `Content-Security-Policy: sandbox allow-scripts allow-popups allow-forms allow-downloads;`
- `SHARES_DISABLED` var truthy (`1`/`true`/`yes`) → `503` for every share (kill-switch).

### CSP note (important)

The sandbox CSP includes `allow-scripts` (canvases run JS: Chart.js/D3/etc.) but
deliberately **omits `allow-same-origin`**. That combination is the classic
sandbox escape; omitting it gives every share an opaque origin so shares can't
read cookies/localStorage or touch each other. Do not add `allow-same-origin`.

## Go-live checklist (not done here — no deploy)

1. Provision the `stella-canvas-shares` R2 bucket (in progress).
2. Confirm the `stellashare.app` custom domain in `wrangler.jsonc` is active.
3. Set the backend `CANVAS_SHARE_BASE_URL` env to the same origin (e.g.
   `https://share.example.com`) so returned URLs match what this Worker serves.
4. `bun install` here, run the verification commands below, then deliberately
   run `bun run deploy`.

## Local dev

This Worker is part of the repository's root Bun workspace. A root
`bun install --frozen-lockfile` installs its pinned toolchain, and the
`cloud_workers` CI matrix runs its type-generation check, typecheck, unit test,
real-Workerd test, and production bundle dry-run.

```sh
bun install
bun run types
bun run typecheck
bun run test
bun run test:workerd
bun run build:dry-run
bun run dev -- --local # requires Wrangler login for non-local resources
```
