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

## Cloudflare Workers

The site runs on Cloudflare Workers through OpenNext (`@opennextjs/cloudflare`).
`wrangler.jsonc` defines the dev Worker (`stella-website-dev`) and the
`production` env (`stella-website-prod`); `worker.mjs` wraps the generated
OpenNext worker. `bun run cf:preview` runs the built Worker locally.

Stella's own deploys: `bun run deploy:dev` / `bun run deploy:production`
(`scripts/deploy-stella.sh`, see `DEPLOY.md`). Any other deployment sets its
`NEXT_PUBLIC_*` values and runs `bun run cf:build && bun run cf:deploy`
(`SELF_HOSTING.md` 1.9).

Vercel (Root Directory `packages/website`) serves stella.sh until the cutover in
`DEPLOY.md`.
