# Stella website

The Stella product website is a Next.js application in the Stella monorepo. It
contains the public marketing pages, the cloud-first Stella chat at `/chat`, and
the account and billing surfaces backed by the shared Convex deployment.

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
`packages/desktop-ui/.env`. Set `NEXT_PUBLIC_CONVEX_URL` and, optionally,
`NEXT_PUBLIC_CONVEX_SITE_URL` in `packages/website/.env.local` to override them
for a different deployment. These are public client endpoints, not secrets.

## Vercel

The Vercel project's Root Directory must be `packages/website`. The root
workspace postinstall automatically skips Electron and native helper setup in
Vercel, while Next.js resolves dependencies from the monorepo lockfile.
