# Stella website

The Stella product website is a Next.js application in the Stella monorepo. It
contains the public marketing pages, the cloud-first Stella chat at `/chat`, and
the account and billing surfaces backed by the Stella backend worker.

## Development

Install dependencies once from the repository root, then start the website:

```bash
bun install
bun run website:dev
```

The local site is available at <http://localhost:3000>.

Build or lint it from the repository root with:

```bash
bun run website:build
bun run website:lint
```

The build falls back to the tracked public backend URLs from
`packages/desktop-ui/.env`. Set `NEXT_PUBLIC_STELLA_BACKEND_URL` in
`packages/website/.env.local` to point at a different backend worker. It is a
public client endpoint, not a secret.
`NEXT_PUBLIC_X_BOT_URL` is the X bot worker's origin (`workers/x-bot`); the
`/x/<handle>` pages read their runs from it and 404 when it is unset.

## Vercel

The Vercel project's Root Directory must be `packages/website`. The root
workspace postinstall automatically skips Electron and native helper setup in
Vercel, while Next.js resolves dependencies from the monorepo lockfile.
