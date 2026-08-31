# Stella website

The Stella product website is a Next.js application in the Stella monorepo. It
contains the public marketing pages as well as the account, billing, and Store
surfaces backed by the shared Convex deployment.

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

Set `NEXT_PUBLIC_CONVEX_URL` in `packages/website/.env.local` to enable sign-in,
billing, and Store features. `NEXT_PUBLIC_CONVEX_SITE_URL` is optional when the
site URL can be derived from the Convex deployment URL.

## Vercel

The Vercel project's Root Directory must be `packages/website`. The root
workspace postinstall automatically skips Electron and native helper setup in
Vercel, while Next.js resolves dependencies from the monorepo lockfile.
