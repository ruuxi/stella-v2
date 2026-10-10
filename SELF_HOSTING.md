# Self-hosting Stella

This guide sets up your own Stella deployment on your own Cloudflare account,
then runs the desktop app (and optionally the mobile app) against it. It is
written so you can hand it to a coding agent: every step is a command or an
exact edit.

Stella's own deployment is described in `DEPLOY.md`. Everything below uses the
same commands; you only change the values that belong to an account.

Part 1 gets a working Stella: chat, cloud agents, the browser, apps, drive and
self-modification. Part 2 lists the optional providers and what each one turns
on. Anything in Part 2 can be left out; the feature then answers "not set up"
and nothing else breaks.

## Part 1: a working Stella

### 1.1 What you need

- **A Cloudflare account on the Workers Paid plan.** Stella uses Workers,
  Durable Objects (SQLite), D1, R2, KV, Queues, Cron Triggers, rate-limit
  bindings, **Containers** (cloud agent sandboxes), **Dynamic Workers** (the
  `worker_loaders` binding, for code mode), **Artifacts** (open beta; holds the
  app's source), **Browser Run** (the cloud browser) and **Pipelines** (one
  stream, for telemetry).
- **An OpenRouter API key.** The default models for every agent run on
  OpenRouter. It is the only third-party key Stella needs.
- **Tools:** git, [Bun](https://bun.sh) 1.4.0, Docker (cloud-builder builds its
  sandbox image on deploy), and `openssl`. Wrangler comes from the repo
  (`bunx wrangler`).

```bash
git clone <your fork> stella && cd stella
bun install --frozen-lockfile
cd workers/cloud-builder && bunx wrangler login && cd ../..
```

If `CLOUDFLARE_API_TOKEN` is set in your shell, prefix wrangler commands with
`env -u CLOUDFLARE_API_TOKEN`, as `DEPLOY.md` does: a narrow token cannot push
containers.

### 1.2 Names, identities and the values to change

Each worker's `wrangler.jsonc` is its configuration. The top-level block is the
**dev** environment (`--env=""`); `env.production` is prod and repeats every
binding and var (they don't inherit). Start with dev. Ignore the `bn118` blocks
(Stella's acceptance environment).

Worker, bucket, database, queue and namespace names are scoped to your
account, so the `stella-v2-*` names can stay. What has to change is what points
at Stella's account:

| Where | Key | Set it to |
|---|---|---|
| all `workers/*/wrangler.jsonc` | every `*.fromyou.workers.dev` URL | your workers.dev subdomain (Dashboard → Workers → Subdomain). `sed -i '' 's/fromyou\.workers\.dev/YOURSUB.workers.dev/g' workers/*/wrangler.jsonc` (drop `''` on Linux) |
| `workers/cloud-builder/wrangler.jsonc` | `vars.R2_S3_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| 〃 | `vars.STELLA_TEST_ACCOUNTS`, `vars.ENABLE_DEV_ACCEPTANCE_PROBES` | delete both unless you want test accounts / acceptance probes on dev |
| 〃 | `d1_databases[0].database_id` | from `wrangler d1 create` (1.3) |
| 〃 | `kv_namespaces` ids (`APP_ROUTES`, `ASN_POLICY`) | from `wrangler kv namespace create` (1.3) |
| 〃 | `artifacts[0].namespace` | any name; `stella-app-dev` is fine |
| `workers/model-gateway/wrangler.jsonc` | `vars.CAPABILITY_JWKS` | your public key (1.4) |
| 〃 | `kv_namespaces` ids (`CONFIG_SNAPSHOT`, `OWNER_ENFORCEMENT`, `ASN_POLICY`) | your ids; `ASN_POLICY` is the same namespace cloud-builder uses |
| `workers/telemetry/wrangler.jsonc` | `pipelines[0].stream` | your stream id (1.3) |

The URLs in the vars follow the worker names: `https://<worker name>.<sub>.workers.dev`.
In prod the model gateway is `stella-v2-model-gateway` and telemetry is
`stella-v2-telemetry` (no `-prod`). `TRUSTED_APPS_HOST_BASE_URL` only has to be
an https origin different from `APPS_HOST_BASE_URL`; the `apps-auth` name is
fine as is.

After editing a worker's `wrangler.jsonc`, `bun run types:generate` in that
worker refreshes its generated types (only typechecks need them).

#### Deployment identities

These are the names a user sees or a store/OS trusts: domains, buckets, signing
teams, app ids. Each one is set in exactly one place per surface, and every
place defaults to Stella's value, so leaving a row alone keeps Stella's. A row
you don't use (no website, no mobile app) can be skipped.

| Identity | Surface | Where it's set | Stella's default | Set it to |
|---|---|---|---|---|
| **Backend** | desktop | `VITE_STELLA_BACKEND_URL` in `packages/desktop-ui/.env` (a launcher passes its own, 1.8) | `stella-v2-cloud-builder-dev.fromyou.workers.dev` | your cloud-builder URL |
| | launchers | `STELLA_BACKEND_URL` at build (1.8) | `stella-v2-cloud-builder-prod.fromyou.workers.dev` | your prod cloud-builder URL |
| | website | `NEXT_PUBLIC_STELLA_BACKEND_URL` | (none) | your prod cloud-builder URL |
| | mobile | `EXPO_PUBLIC_STELLA_BACKEND_URL` per profile in `packages/mobile/eas.json` | Stella's dev / prod | yours |
| **Website** (`stella.sh`) | cloud-builder | `vars.STELLA_WEBSITE_URL` (add it, both envs) | `https://stella.sh` | your website origin |
| | desktop | `VITE_STELLA_WEB_URL` in `packages/desktop-ui/.env`; main and the runtime read it as `STELLA_WEB_URL` (a `STELLA_WEB_URL` in the process environment wins) | `https://stella.sh` | your website origin |
| | web chat build | `VITE_STELLA_WEB_URL`, else `NEXT_PUBLIC_STELLA_SITE_URL` | `https://stella.sh` | your website origin |
| | website | `NEXT_PUBLIC_STELLA_SITE_URL` | `https://stella.sh` | the site's own origin |
| | mobile | `EXPO_PUBLIC_STELLA_SITE_URL` per profile in `eas.json` | `https://stella.sh` | your website origin |
| **Auth domain** (`auth.stella.sh`) | cloud-builder | `routes` and `vars.STELLA_AUTH_URL` (dev `auth-dev.stella.sh`) | `auth.stella.sh` / `auth-dev.stella.sh` | a domain on a zone you own, or delete both (auth then runs on `CLOUD_BUILDER_PUBLIC_URL`) |
| | mobile | `EXPO_PUBLIC_STELLA_AUTH_URL` per profile in `eas.json` | (unset: only Stella's two auth domains) | the same value as `STELLA_AUTH_URL`, if you set one |
| **Canvas share** (`stellashare.app`) | canvas-share | `routes` in `workers/canvas-share/wrangler.jsonc` | `stellashare.app` | your domain, or delete it and set `"workers_dev": true` |
| | cloud-builder | `vars.CANVAS_SHARE_BASE_URL` | `https://stellashare.app` | your canvas-share URL |
| | desktop | `VITE_CANVAS_SHARE_BASE_URL` in `packages/desktop-ui/.env` | `https://stellashare.app` | your canvas-share URL |
| **Releases bucket** (public R2) | launchers | `STELLA_RELEASES_URL` at build (1.8). The launcher also hands it to the app, so native helpers and the Stella browser download from it | `https://pub-a319aaada8144dc9be5a83625033769c.r2.dev` | your releases bucket's public base |
| | release workflows | repository variable `STELLA_RELEASES_URL` | 〃 | 〃 |
| | website | `NEXT_PUBLIC_STELLA_RELEASES_URL` | 〃 | 〃 |
| | source runs | `STELLA_RELEASES_URL` for `bun run native:download` / `stella-browser:download` (or one manifest with `STELLA_NATIVE_HELPERS_MANIFEST_URL` / `STELLA_BROWSER_MANIFEST_URL`) | 〃 | 〃 |
| **Apple team** (desktop) | macOS launcher, `build-electron-identity.yml`, `build-launchers.yml` | `STELLA_APPLE_TEAM_ID` (build env / repository variable); notarization uses the `APPLE_TEAM_ID` secret | `7UVYHQ763X` | your Developer ID team |
| **Windows signer** | Windows launcher, `build-launchers.yml` | `STELLA_UPDATE_SIGNER` (build env / repository variable) | `FromYou, LLC` | your Authenticode certificate's subject name |
| **Native OAuth clients** (desktop connectors) | desktop | `STELLA_NATIVE_OAUTH_<ID>_CLIENT_ID` lines in `packages/desktop-ui/.env`, `<ID>` the upper-cased provider id; Google Workspace (and YouTube) use `WORKSPACE_CLIENT_ID`. Main adopts these into the runtime's environment | Stella's apps, in `packages/runtime/kernel/connectors/native-oauth-provider-config.ts` | your OAuth app's client id (see below) |
| | cloud-builder | secret `NATIVE_OAUTH_CLIENTS_JSON` (Part 2) | (unset) | the same client ids with their secrets |
| **Mobile app** | mobile | env read by `packages/mobile/app.config.ts` (see 1.10): `STELLA_MOBILE_OWNER`, `STELLA_MOBILE_SLUG`, `STELLA_MOBILE_EAS_PROJECT_ID` (also sets `updates.url`), `STELLA_MOBILE_APPLE_TEAM_ID`, `STELLA_MOBILE_IOS_BUNDLE_ID` (also the app group and the Live Activities target), `STELLA_MOBILE_ANDROID_PACKAGE`, `EXPO_PUBLIC_STELLA_MOBILE_SCHEME` | `stella-ai`, `stella-mobile`, `892d4162-…`, `7UVYHQ763X`, `com.stella.mobile`, `com.fromyou.stella`, `stella-mobile` | yours |
| | mobile | `eas.json`: `EXPO_PUBLIC_PLAY_INTEGRITY_PROJECT_NUMBER` per profile, `submit.*.ios.ascAppId` | `450329171803`, `6761148311` | your Google Cloud project number and App Store Connect app id, or delete them |
| | cloud-builder | `STELLA_MOBILE_SCHEME`, `APPLE_APP_BUNDLE_IDENTIFIER`, `APPLE_APP_ATTEST_TEAM_ID` | `stella-mobile`, (unset), (unset) | your scheme, bundle id and team |

Native OAuth: the desktop connectors in
`native-oauth-provider-config.ts` that carry a Stella client id are `github`,
`linear`, `youtube`, `todoist`, `ticktick`, `asana`, `airtable`, `figma`,
`notion`, `miro`, `wakatime`, `pushbullet`, `sentry`, `calendly`, `cal`,
`capsule_crm`, `attio`, `eventbrite`, `harvest`, `gumroad`, `freshbooks`,
`freeagent`, `splitwise`, `stack_exchange`, `zoom`, `pipedrive`, `crowdin`,
`dart`, `supabase`, `stripe`, `typeform`, `monday`, `zeplin`, plus `atlassian`
(Jira and Confluence) and Google Workspace. Register your own app with each
provider you want, with the redirect URI `http://127.0.0.1:48743/callback`,
then set its client id as above, for example
`STELLA_NATIVE_OAUTH_NOTION_CLIENT_ID=...`. Providers that exchange the code on
the server also need the client in `NATIVE_OAUTH_CLIENTS_JSON`. The https-only
providers (Zeplin and the ones whose entry has `callbackMode: "external"`)
redirect to `<website>/oauth/<id>/callback`; `packages/website` doesn't serve
that route, so on a self-hosted deployment those connectors stay unavailable
until you host it. A provider you don't register keeps Stella's client, which
will refuse your redirect, so either register it or leave that connector
unused.

What stays Stella's on purpose: the `HTTP-Referer: https://stella.sh` attribution
sent to OpenRouter, docs links (`/docs/media` in cloud-builder's media errors),
marketing and legal pages and their copy ("stella.sh" in translations), store
listing text in `packages/mobile/store.config.json`, podspec homepages, the
Stella browser extension's popup link, the `/du` URL in the Windows signature,
the `release@stella.sh` author of app-source publish commits, and the macOS
bundle ids `com.stella.app` / `com.stella.launcher` (Developer ID signing
doesn't register them, so they don't collide with Stella's). Stella's own
origins also stay in the cloud-builder CORS and trusted-origin lists next to
yours. Change any of these by editing the file if you want your own.

### 1.3 Create the resources

From `workers/cloud-builder` (dev names; repeat with the prod names for prod):

```bash
# D1 → database_id in cloud-builder
bunx wrangler d1 create stella-v2-dev

# KV → ids in cloud-builder and model-gateway
bunx wrangler kv namespace create stella-app-routes-dev        # APP_ROUTES
bunx wrangler kv namespace create stella-asn-policy-dev        # ASN_POLICY (both workers)
bunx wrangler kv namespace create stella-gateway-config-dev    # CONFIG_SNAPSHOT
bunx wrangler kv namespace create stella-owner-enforcement-dev # OWNER_ENFORCEMENT

# R2
for b in stella-v2-app-builds-dev stella-v2-agent-home-dev stella-v2-conversation-archive-dev \
         stella-v2-worlds-dev stella-v2-drive-dev stella-v2-media-dev stella-canvas-shares \
         stella-v2-browser-profiles-dev; do bunx wrangler r2 bucket create "$b"; done
# Read-aloud segments expire after a day
bunx wrangler r2 bucket lifecycle add stella-v2-media-dev tts-expiry tts/ --expire-days 1 --force

# Queues (model-gateway usage)
bunx wrangler queues create stella-v2-gateway-usage-dev
bunx wrangler queues create stella-v2-gateway-usage-dlq-dev

# Pipelines stream for telemetry → its id into telemetry's pipelines[0].stream
bunx wrangler pipelines streams create stella_telemetry_dev \
  --schema-file ../../infra/telemetry/schema/v1.json --http-enabled false
```

The stream alone is enough to deploy. Storing events (sink, R2 Data Catalog,
SQL pipeline) is optional and described in `infra/telemetry/README.md`.

Drive and media files are uploaded and read with presigned URLs, so the drive
and media buckets need CORS. Save this as `r2-cors.json` and apply it:

```json
{ "rules": [ { "allowed": { "origins": ["*"], "methods": ["GET", "PUT", "HEAD"], "headers": ["*"] },
               "exposeHeaders": ["ETag", "Content-Length", "Content-Type", "Content-Range"],
               "maxAgeSeconds": 3600 } ] }
```

```bash
bunx wrangler r2 bucket cors set stella-v2-drive-dev --file r2-cors.json --force
bunx wrangler r2 bucket cors set stella-v2-media-dev --file r2-cors.json --force
```

The presigned URLs also need an **R2 API token**: Dashboard → R2 → Manage API
tokens → create one with Object Read & Write on the drive and media buckets.
Its access key id and secret go into 1.4.

Artifacts needs nothing up front: the namespace is created when you first
publish the app source (1.7). Containers need nothing either: the first
cloud-builder deploy builds and pushes the image.

### 1.4 Secrets

**The quick way:** `bun scripts/self-host-setup.mjs` shows what it would do;
`bun scripts/self-host-setup.mjs --apply` (add `--env production` for prod)
generates every internal secret below, sets them on their workers, creates the
capability key pair, writes `CAPABILITY_JWKS` and `CAPABILITY_SIGNING_KID` into
the wrangler configs, and saves `STELLA_ADMIN_API_SECRET` to
`workers/cloud-builder/.dev.vars` (dev) or
`~/.config/stella/admin-api-secret.production` (prod). It never replaces a
secret a worker already has, and lists what is still yours to set (the R2 API
token, `OPENROUTER_API_KEY`). Commit the wrangler.jsonc changes afterwards. The
rest of this section is what it does, by hand.

Every secret is set with `printf %s "$VALUE" | bunx wrangler secret put NAME --env=""`
from the worker's directory (`--env production` for prod). Never commit them.

**cloud-builder** (deploy refuses to run without these):

| Secret | Value |
|---|---|
| `BUILDER_SERVICE_SECRET` | `openssl rand -hex 32` |
| `BETTER_AUTH_SECRET` | `openssl rand -hex 32` (signs sessions; changing it signs everyone out) |
| `CAPABILITY_SIGNING_KEY` | the private key below |
| `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` | the R2 API token from 1.3 |

The capability key signs cloud turns; the model gateway checks them with its
public half:

```bash
cd workers/cloud-builder
bun ../../scripts/generate-capability-keys.mjs builder-1 > /tmp/cap.txt
sed -n '/BEGIN PRIVATE KEY/,/END PRIVATE KEY/p' /tmp/cap.txt | bunx wrangler secret put CAPABILITY_SIGNING_KEY --env=""
tail -1 /tmp/cap.txt   # the public entry
rm /tmp/cap.txt
```

Put the public entry in model-gateway's `vars.CAPABILITY_JWKS` as
`{"keys":[<entry>]}` (JSON-escaped inside the string, like the existing value),
and keep cloud-builder's `vars.CAPABILITY_SIGNING_KID` equal to the kid
(`builder-1`). Use a different kid for prod (`builder-prod-1`).

**model-gateway:** `OPENROUTER_API_KEY`.

**browser-gateway:** `BROWSER_PROFILE_KEK_V1` = 32 random bytes, base64url:
`openssl rand -base64 32 | tr '+/' '-_' | tr -d '='`.

**telemetry:** `TELEMETRY_PSEUDONYM_KEY` and `TELEMETRY_SERVER_SECRET`, each
`openssl rand -hex 32`.

That is the whole required set. Billing is off when none of its secrets are set
(see Part 2): every account is Pro with unlimited usage. **Anyone who can reach
your backend can sign in (anonymously, at least) and spend your OpenRouter
credit**, so keep the URLs to yourself or set the billing limits in Part 2.

### 1.5 Migrations and deploy order

```bash
cd workers/cloud-builder
bunx wrangler d1 migrations apply stella-v2-dev --remote
```

Workers bind to each other, and a deploy fails when a bound worker does not
exist yet. cloud-builder and model-gateway bind to each other, so the very
first deploy needs one extra step:

```bash
cd workers/telemetry       && bun run deploy:dev
cd ../browser-gateway      && bun run deploy:dev
# First time only: comment out the BILLING entry in model-gateway's "services",
# deploy, then restore it.
cd ../model-gateway        && bun run deploy:dev
cd ../cloud-builder        && bun run deploy:dev     # Docker must be running
cd ../model-gateway        && bun run deploy:dev     # BILLING restored
cd ../apps-host            && bun run deploy:dev
```

After that, use the order in `DEPLOY.md`: D1 migrations → cloud-builder →
model-gateway → the rest. A deploy kills cloud turns in flight.

Check it: `curl -s https://stella-v2-cloud-builder-dev.<sub>.workers.dev/healthz`
answers `{"ok":true,...}`. Model prices sync from models.dev on the first
request and then daily.

For prod, repeat 1.3–1.5 with the prod names, `--env production`, and the
`deploy:production` scripts.

### 1.6 Auth

Anonymous sign-in works with no setup, so no sign-in method is required: an
anonymous user can chat on Claude Code, ChatGPT or their own API keys, and,
with billing off, on your managed models. To keep anonymous users off your
managed models, set `STELLA_TIER_CEILING_ANON_HOURLY_USD` and
`STELLA_TIER_CEILING_ANON_DAILY_USD` to `0`. Sign-in is only needed for
accounts: sync across computers, the mobile app and, once you set billing
limits, Stella's managed models. Add these as you need them; each is
optional (Part 2):

- **Email (magic links):** Cloudflare Email Service. Enable sending for a domain
  on a zone in your account (`bunx wrangler email sending enable example.com`;
  it publishes SPF, DKIM and a `p=reject` DMARC record) and set cloud-builder's
  `vars.STELLA_EMAIL_FROM` to a sender on it, e.g. `"Stella <noreply@example.com>"`.
  The `EMAIL` binding is already in `wrangler.jsonc`. Resend works instead or as
  a fallback with `RESEND_API_KEY` and `RESEND_FROM`.
- **Google:** an OAuth client with redirect URI
  `<STELLA_AUTH_URL or CLOUD_BUILDER_PUBLIC_URL>/api/auth/callback/google`, then
  `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.
- **Apple:** a Services ID with return URL `<auth origin>/api/auth/callback/apple`,
  then `APPLE_CLIENT_ID`, `APPLE_TEAM_ID`, `APPLE_KEY_ID`, `APPLE_PRIVATE_KEY`
  (and `APPLE_APP_BUNDLE_IDENTIFIER` for the iOS app).

After a browser sign-in the backend sends the browser to
`<STELLA_WEBSITE_URL>/auth/callback?done=true`; set `STELLA_WEBSITE_URL` if you
host the website.

**Canvas sharing (optional):** deploy `workers/canvas-share` (`bun run deploy`)
with its own route or workers.dev, and set the canvas-share rows of the
identities table (1.2) to it.

### 1.7 Publish the app source

The desktop app runs from source that lives in your Artifacts namespace; each
user gets a fork of its `upstream` repo, and Stella's self-modification works
on that fork. Publish whenever desktop or runtime code changes:

```bash
env -u CLOUDFLARE_API_TOKEN bun run app-source:publish -- --namespace stella-app-dev
```

The first publish creates the namespace and the `upstream` repo. An unchanged
tree publishes nothing.

### 1.8 Run the desktop app against your backend

The desktop's identities live in `packages/desktop-ui/.env`. It is tracked and
published with the app source (1.7), so editing it is what every install of
your fork gets. `.env.local` overrides it on one machine and is never published.

```bash
# packages/desktop-ui/.env
VITE_STELLA_BACKEND_URL=https://stella-v2-cloud-builder-dev.<sub>.workers.dev
VITE_TURNSTILE_SITE_KEY=
VITE_CANVAS_SHARE_BASE_URL=<your canvas-share URL, or leave Stella's>
VITE_STELLA_WEB_URL=<your website origin, if you host one>
STELLA_NATIVE_OAUTH_NOTION_CLIENT_ID=<one line per connector you registered>
```

The renderer reads the `VITE_*` keys. At startup Electron main adopts
`VITE_STELLA_WEB_URL` as `STELLA_WEB_URL` and the `STELLA_NATIVE_OAUTH_*_CLIENT_ID`
/ `WORKSPACE_CLIENT_ID` lines into its environment, which the runtime worker
inherits; nothing else in the file leaves the renderer. A value already in the
process environment wins.

**From source** (any platform): `bun run electron:dev` (see `TESTING.md`). A
backend named `<prefix>cloud-builder<suffix>` finds its Apps host by name
(`<prefix>apps-host<suffix>`); any other backend URL also needs
`VITE_STELLA_APPS_HOST` and `VITE_STELLA_APPS_AUTH_HOST`. Desktop telemetry is
off unless `STELLA_TELEMETRY_ENDPOINT` points at your telemetry worker
(`https://<telemetry worker>/v1/events`); a self-hosted backend's tokens are
never sent to Stella's. `bun install` (the Stella browser) and
`bun run native:download` (native helpers) download from `STELLA_RELEASES_URL`
(Stella's bucket when unset).

**With a launcher:** the launchers in `launcher/` install Stella from your
Artifacts source and keep it updated. An existing launcher can be pointed at
your backend with `STELLA_LAUNCHER_BACKEND_URL`; to ship your own, build them
with your values:

```bash
STELLA_BACKEND_URL=https://stella-v2-cloud-builder-prod.<sub>.workers.dev \
STELLA_RELEASES_URL=https://<your public releases bucket> \
STELLA_APPLE_TEAM_ID=<team>  launcher/macos/build.sh      # macOS
# launcher/windows/build.sh takes the first two and STELLA_UPDATE_SIGNER (Authenticode name)
# launcher/linux/build.sh takes the first two
```

Check a build took them: `strings launcher/linux/build/stella-launcher | grep -E 'workers.dev|https://'`.
The launcher passes its backend to the app (`VITE_STELLA_BACKEND_URL`) and its
bucket (`STELLA_RELEASES_URL`) to the install step, so native helpers and the
Stella browser come from your bucket too.

`STELLA_RELEASES_URL` is the public base of an R2 bucket holding
`launcher/stable/`, `electron-identity/`, `git-runtime/objects/`,
`native-helpers/` and `stella-browser/`. The release workflows
(`.github/workflows/build-*.yml`) read the same values from repository
variables (`STELLA_BACKEND_URL`, `STELLA_DEV_BACKEND_URL`, `STELLA_RELEASES_URL`,
`STELLA_APPLE_TEAM_ID`, `STELLA_UPDATE_SIGNER`) and upload with the `R2_*`
repository secrets; unset, they keep Stella's values. Signing needs your own
Apple Developer ID and Windows code-signing certificate. The git runtime
objects are content-addressed and pinned by sha256 in
`launcher/macos/Sources/StellaLauncher/Support.swift`; copy the two objects from
`https://pub-a319aaada8144dc9be5a83625033769c.r2.dev/git-runtime/objects/` into
your bucket. Run `build-native-helpers.yml` and `build-stella-browser.yml` once
to fill `native-helpers/` and `stella-browser/`.

### 1.9 The website (optional)

`packages/website` is a Next.js app that runs on Cloudflare Workers through
OpenNext (`@opennextjs/cloudflare`). It is not needed for chat. It serves
downloads and install scripts, the web chat, the interactive map behind the
`map` tool's cards, the sign-in landing page and the billing return page.

`NEXT_PUBLIC_*` values are inlined at build time, so export them in the shell
that builds:

| Var | Value |
|---|---|
| `NEXT_PUBLIC_STELLA_BACKEND_URL` | your backend |
| `NEXT_PUBLIC_STELLA_SITE_URL` | the site's own origin |
| `NEXT_PUBLIC_STELLA_RELEASES_URL` | your releases bucket's public base |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | optional (Part 2) |
| `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` | optional (Part 2) |
| `NEXT_PUBLIC_GOOGLE_ADS_ID`, `NEXT_PUBLIC_GOOGLE_ADS_DOWNLOAD_LABEL`, `NEXT_PUBLIC_GOOGLE_ADS_SIGNUP_LABEL` | optional: your Google Ads tag and conversion labels. Unset, no Google tag loads |

The web chat is built from `packages/desktop-ui` in the same step and prefers
`VITE_STELLA_BACKEND_URL` / `VITE_TURNSTILE_SITE_KEY` over the `NEXT_PUBLIC_*`
values; unset them, or set them to the same values.

```bash
cd packages/website
# Optional: the Maps server key for the legacy /api/maps/resolve route
bunx wrangler secret put GOOGLE_MAPS_SERVER_API_KEY --env=""
bun run cf:build
bun run cf:deploy
```

That deploys the top-level Worker in `wrangler.jsonc` (`stella-website-dev`) to
`https://stella-website-dev.<sub>.workers.dev`. For prod, use `--env production`
on the secret and `bun run cf:deploy -- --env production` (`stella-website-prod`),
and put your own domain in its `routes`. Don't run `deploy:dev` or
`deploy:production`: those scripts build with Stella's values.

Then set the other **Website** rows of the identities table (1.2) to the same
origin: cloud-builder's `STELLA_WEBSITE_URL`, the desktop's `VITE_STELLA_WEB_URL`
and mobile's `EXPO_PUBLIC_STELLA_SITE_URL`. cloud-builder trusts that origin
for browser sign-in and the web chat.

### 1.10 Your own mobile app (optional)

Needs an Expo account, an Apple Developer account (iOS) and a Google Play
developer account (Android). `packages/mobile/app.json` stays Stella's: it is an
OTA native input (`DEPLOY.md`, Mobile), so don't edit it. `app.config.ts` layers
the **Mobile app** rows of the identities table (1.2) over it from the
environment; with none of them set the resolved config is exactly `app.json`.

1. `bunx eas init` (from `packages/mobile`) creates your EAS project; note its id.
   Answer no if it offers to write the id into `app.json`.
2. In `eas.json`, put the identity env in every build profile's `env`, next to
   your backend:

   ```json
   "env": {
     "EXPO_PUBLIC_STELLA_BACKEND_URL": "https://stella-v2-cloud-builder-prod.<sub>.workers.dev",
     "EXPO_PUBLIC_STELLA_SITE_URL": "https://<your website>",
     "EXPO_PUBLIC_STELLA_AUTH_URL": "https://<your STELLA_AUTH_URL, if any>",
     "STELLA_MOBILE_OWNER": "<expo account>",
     "STELLA_MOBILE_SLUG": "<slug>",
     "STELLA_MOBILE_EAS_PROJECT_ID": "<project id>",
     "STELLA_MOBILE_APPLE_TEAM_ID": "<team>",
     "STELLA_MOBILE_IOS_BUNDLE_ID": "com.example.assistant",
     "STELLA_MOBILE_ANDROID_PACKAGE": "com.example.assistant",
     "EXPO_PUBLIC_STELLA_MOBILE_SCHEME": "example-assistant",
     "EXPO_PUBLIC_PLAY_INTEGRITY_PROJECT_NUMBER": "<your project number, or delete>"
   }
   ```

   Replace or delete `submit.*.ios.ascAppId`. Export the same `STELLA_MOBILE_*`
   and `EXPO_PUBLIC_*` values in your shell (or `.env.local`) for `eas update`,
   `expo` and `scripts/publish-ota.sh`, which read the config outside a build
   profile. `STELLA_MOBILE_ANDROID_PACKAGE` also tells `publish-ota.sh` which
   Play app to look up.
3. Check it: `bunx expo config --type public --json` shows your owner, slug,
   `updates.url`, bundle id, app group and package.
4. On cloud-builder set `STELLA_MOBILE_SCHEME` to your scheme, and for Apple
   sign-in and App Attest `APPLE_APP_BUNDLE_IDENTIFIER` and
   `APPLE_APP_ATTEST_TEAM_ID`.
5. Build with `bunx eas build --profile production`. Push notifications go
   through Expo's push service with the APNs and FCM credentials in your EAS
   project; the backend needs no key for them.

## Part 2: optional providers

Each row is off until its keys are set; the feature then says it is not set up.
Secrets go on **cloud-builder** unless noted.

| Feature | Keys | Provider | Without it |
|---|---|---|---|
| Billing (plans, limits, Stripe checkout) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (webhook URL `<backend>/api/stripe/webhook`), `STRIPE_PRICE_GO`, `STRIPE_PRICE_PRO`, `STELLA_INCLUDED_USAGE_UTILIZATION_RATE`, `STELLA_GO_PRICE_CENTS`, `STELLA_PRO_PRICE_CENTS`, `STELLA_FREE_{ROLLING,WEEKLY,MONTHLY}_LIMIT_USD`, `STELLA_FREE_ROLLING_WINDOW_HOURS`, `STELLA_ANON_LIFETIME_LIMIT_USD`, `STELLA_ANON_MAX_REQUESTS`; optional overrides in `workers/cloud-builder/src/billing/plans.ts` | Stripe | Billing is off: every account is Pro, unlimited; checkout says billing isn't set up. Setting any one of `STELLA_INCLUDED_USAGE_UTILIZATION_RATE`, `STRIPE_SECRET_KEY`, `STRIPE_PRICE_GO`, `STRIPE_PRICE_PRO` turns billing on, and then all the required ones must be set or turns are refused |
| Cloud containers by plan (cloud agents, cloud as a run destination, Claude Code in the cloud) | var or secret `STELLA_CLOUD_SANDBOX_PLANS`: comma list of `anonymous`, `free`, `go`, `pro` that may start a cloud container, e.g. `go,pro` to require a subscription. Read only when billing is on. Chat, chat storage and running on the user's own computer are never gated | none | Billing off: every account may use containers. Billing on and unset: every signed-in plan may (`free,go,pro`), anonymous may not. Refused callers get `subscription_required` (403), "Running in the cloud needs a Stella subscription." |
| Email sign-in (magic links) | var `STELLA_EMAIL_FROM` on a domain enabled for Email Sending (see 1.6); or, instead or as a fallback, `RESEND_API_KEY`, `RESEND_FROM`; optional `STELLA_EMAIL_LOGO_URL` | Cloudflare Email Service (Resend fallback) | Magic links answer 503 "Email sign-in isn't set up" |
| Google / Apple sign-in | see 1.6 | Google, Apple | The provider isn't offered |
| Opening private canvas links in a browser | `CANVAS_SHARE_VIEW_SECRET` (`openssl rand -hex 32`): the same value on **cloud-builder** (every env that writes to the share bucket) and on **canvas-share** | none | Canvases still get private links and show in the app, but a private link opens nowhere else (the share domain shows its "private" page) until it is made public |
| Web search tool | `PARALLEL_API_KEY` | Parallel | The tool reports it isn't configured |
| Image, video, music, speech, transcription and 3D generation (`stella-media`, `image_gen`) | `FAL_KEY` | fal.ai: the models in `packages/contracts/media-models.ts` (GPT Image 2.5 Flare, Seedance 2.5, Lyria 3.5, Gemini 3.8 Flash Lite TTS, ElevenLabs Scribe v2, Tripo P2) | 503 "Media generation is not configured yet" |
| Read-aloud (TTS) | `OPENROUTER_API_KEY` or `FAL_KEY`; OpenRouter with both (cheaper, one hop), unless `STELLA_MEDIA_PROVIDER` = `fal`.; the OpenAI read-aloud voice uses `OPENAI_API_KEY` | Gemini 3.8 Flash Lite TTS on OpenRouter or fal; OpenAI | 503 "read-aloud is not configured yet" |
| Realtime voice | `OPENAI_API_KEY` | OpenAI Realtime | Unavailable (users can still bring their own xAI / Inworld keys on desktop) |
| Dictation | Live streaming: `META_MODEL_API_KEY` (Meta Muse realtime). Record-then-transcribe: `OPENROUTER_API_KEY` (cloud-builder's own copy); optional var `STELLA_DICTATION_MODEL` (default `elevenlabs/scribe-v2`) | Meta Model API, OpenRouter | With only the OpenRouter key, signed-in users dictate record-then-transcribe (no live text). With neither, desktop users are asked for their own OpenRouter key on their first mic press; it stays on their computer |
| Image description in chat | `GOOGLE_AI_API_KEY` on **model-gateway** | Google AI Studio | That model call fails |
| Other managed models | `FIREWORKS_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `META_MODEL_API_KEY` on **model-gateway** | as named | Only models routed to that provider fail ("The model provider is not configured"); the defaults use OpenRouter |
| ChatGPT sign-in for agents | `OWNER_SECRETS_KEK` (`openssl rand -base64 32`), `OAUTH_STATE_SECRET` (`openssl rand -hex 32`) | OpenAI (the user's own ChatGPT plan) | "Engine connections aren't configured yet" |
| Integrations store | `COMPOSIO_API_KEY` (optional `COMPOSIO_TOOL_ROUTER_URL`); the catalog is loaded through the admin API (`STELLA_ADMIN_API_SECRET`) | Composio | No store integrations |
| X connector | `X_CLIENT_ID`, `X_CLIENT_SECRET`, `OAUTH_STATE_SECRET` | X | Unavailable |
| GitHub projects | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`, `OAUTH_STATE_SECRET` | GitHub App | Unavailable |
| Tag Stella in Slack | `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`, `OAUTH_STATE_SECRET`; create the Slack app from `workers/cloud-builder/slack/app-manifest.*.json` with your auth domain (see `workers/cloud-builder/slack/README.md`); workspaces install through `<auth>/api/slack/install` | Slack app (OAuth v2, Events API) | The `/api/slack/*` routes answer that Slack isn't set up |
| Desktop OAuth connectors that exchange tokens on the server (Google Workspace, Box, Microsoft, Atlassian, ...) | `NATIVE_OAUTH_CLIENTS_JSON` (`{"<provider>": {"clientId": "...", "clientSecret": "..."}}`); desktop client ids can be overridden with `STELLA_NATIVE_OAUTH_<ID>_CLIENT_ID`. Providers that only allow https redirects use `<STELLA_WEB_URL>/oauth/<provider>/callback`, which `packages/website` doesn't serve (1.2) | each provider | Those connectors aren't offered |
| Maps tool | `GOOGLE_MAPS_SERVER_API_KEY` (Places API (New) + Directions); the card's interactive view also needs `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` on the **website** | Google Maps Platform | The `map` tool says maps aren't set up |
| Captcha on anonymous web sign-in | `TURNSTILE_SECRET_KEY`; site key in `VITE_TURNSTILE_SITE_KEY` (desktop web build) and `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (website) | Cloudflare Turnstile | No captcha |
| Mobile app integrity | `APPLE_APP_ATTEST_TEAM_ID`, `GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON` (+ `EXPO_PUBLIC_PLAY_INTEGRITY_PROJECT_NUMBER`); `STELLA_APP_INTEGRITY_MODE` = `enforce` / `off` | Apple App Attest, Google Play Integrity | Off |
| Admin API (test accounts, integrations catalog, billing tools) | `STELLA_ADMIN_API_SECRET`; test accounts also need var `STELLA_TEST_ACCOUNTS=1` (dev only) | none | Admin routes answer 503 |
| Ops relay probe | `STELLA_RELAY_PROBE_SECRET` on **model-gateway** | none | No probe |
| Gateway alerts | `STELLA_ALERT_WEBHOOK_URL` on **model-gateway** | any webhook | No alerts |
| Telemetry lake | sink and pipeline per `infra/telemetry/README.md`; desktop `STELLA_TELEMETRY_ENDPOINT` | Cloudflare Pipelines, R2 Data Catalog | Events are accepted and not stored |
