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

### 1.2 Names and the values to change

Each worker's `wrangler.jsonc` is its configuration. The top-level block is the
**dev** environment (`--env=""`); `env.production` is prod and repeats every
binding and var (they don't inherit). Start with dev. Ignore the `bn118` blocks
(Stella's acceptance environment).

Worker, bucket, database, queue and namespace names are scoped to your
account, so the `stella-v2-*` names can stay. What has to change is what points
at Stella's account:

| Where | Key | Set it to |
|---|---|---|
| all `workers/*/wrangler.jsonc` | every `*.lolruuxi.workers.dev` URL | your workers.dev subdomain (Dashboard → Workers → Subdomain). `sed -i '' 's/lolruuxi\.workers\.dev/YOURSUB.workers.dev/g' workers/*/wrangler.jsonc` (drop `''` on Linux) |
| `workers/cloud-builder/wrangler.jsonc` | `routes` (`auth-dev.stella.sh`, prod `auth.stella.sh`) | delete the `routes` line, or put a domain on a zone you own |
| 〃 | `vars.STELLA_AUTH_URL` | your auth domain, or delete it (then it is `CLOUD_BUILDER_PUBLIC_URL`) |
| 〃 | `vars.R2_S3_ENDPOINT` | `https://<ACCOUNT_ID>.r2.cloudflarestorage.com` |
| 〃 | `vars.CANVAS_SHARE_BASE_URL` | your canvas-share worker URL (see 1.6), or leave it if you skip canvas sharing |
| 〃 | `vars.STELLA_TEST_ACCOUNTS`, `vars.ENABLE_DEV_ACCEPTANCE_PROBES` | delete both unless you want test accounts / acceptance probes on dev |
| 〃 | `vars.STELLA_WEBSITE_URL` (add) | your website origin, if you host one (1.8). Unset means `https://stella.sh` |
| 〃 | `d1_databases[0].database_id` | from `wrangler d1 create` (1.3) |
| 〃 | `kv_namespaces` ids (`APP_ROUTES`, `ASN_POLICY`) | from `wrangler kv namespace create` (1.3) |
| 〃 | `artifacts[0].namespace` | any name; `stella-app-dev` is fine |
| `workers/model-gateway/wrangler.jsonc` | `vars.CAPABILITY_JWKS` | your public key (1.4) |
| 〃 | `kv_namespaces` ids (`CONFIG_SNAPSHOT`, `OWNER_ENFORCEMENT`, `ASN_POLICY`) | your ids; `ASN_POLICY` is the same namespace cloud-builder uses |
| `workers/telemetry/wrangler.jsonc` | `pipelines[0].stream` | your stream id (1.3) |
| `workers/canvas-share/wrangler.jsonc` | `routes` (`stellashare.app`) | delete (and set `"workers_dev": true`) or use your own domain |

The URLs in the vars follow the worker names: `https://<worker name>.<sub>.workers.dev`.
In prod the model gateway is `stella-v2-model-gateway` and telemetry is
`stella-v2-telemetry` (no `-prod`). `TRUSTED_APPS_HOST_BASE_URL` only has to be
an https origin different from `APPS_HOST_BASE_URL`; the `apps-auth` name is
fine as is.

After editing a worker's `wrangler.jsonc`, `bun run types:generate` in that
worker refreshes its generated types (only typechecks need them).

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

Anonymous sign-in works with no setup. Add these as you need them; each is
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
with its own route or workers.dev, and set cloud-builder's
`CANVAS_SHARE_BASE_URL` and the desktop's `VITE_CANVAS_SHARE_BASE_URL` to it.

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

**From source** (any platform): create `packages/desktop-ui/.env.local`:

```bash
VITE_STELLA_BACKEND_URL=https://stella-v2-cloud-builder-dev.<sub>.workers.dev
VITE_TURNSTILE_SITE_KEY=
VITE_CANVAS_SHARE_BASE_URL=<your canvas-share URL, or leave Stella's>
```

then `bun run electron:dev` (see `TESTING.md`). A backend named
`<prefix>cloud-builder<suffix>` finds its Apps host by name
(`<prefix>apps-host<suffix>`); any other backend URL also needs
`VITE_STELLA_APPS_HOST` and `VITE_STELLA_APPS_AUTH_HOST`. For a source run,
`STELLA_WEB_URL` names your website (default `https://stella.sh`), and
desktop telemetry is off unless `STELLA_TELEMETRY_ENDPOINT` points at your
telemetry worker (`https://<telemetry worker>/v1/events`); a self-hosted
backend's tokens are never sent to Stella's.

**With a launcher:** the launchers in `launcher/` install Stella from your
Artifacts source and keep it updated. An existing launcher can be pointed at
your backend with `STELLA_LAUNCHER_BACKEND_URL`; to ship your own, build them
with your values:

```bash
STELLA_BACKEND_URL=https://stella-v2-cloud-builder-prod.<sub>.workers.dev \
STELLA_RELEASES_URL=https://<your public releases bucket> \
STELLA_APPLE_TEAM_ID=<team>  launcher/macos/build.sh      # macOS
# launcher/windows/build.sh takes STELLA_UPDATE_SIGNER (Authenticode name)
# launcher/linux/build.sh takes the first two
```

`STELLA_RELEASES_URL` is the public base of an R2 bucket holding
`launcher/stable/`, `electron-identity/` and `git-runtime/objects/`. The
release workflows (`.github/workflows/build-*.yml`) read the same values from
repository variables (`STELLA_BACKEND_URL`, `STELLA_DEV_BACKEND_URL`,
`STELLA_RELEASES_URL`, `STELLA_APPLE_TEAM_ID`, `STELLA_UPDATE_SIGNER`) and
upload with the `R2_*` repository secrets; unset, they keep Stella's values.
Signing needs your own Apple Developer ID and Windows code-signing
certificate. The git runtime objects are content-addressed and pinned by
sha256 in `launcher/macos/Sources/StellaLauncher/Support.swift`; copy the two
objects from `https://pub-a319aaada8144dc9be5a83625033769c.r2.dev/git-runtime/objects/`
into your bucket. Native helpers and the Stella browser download from Stella's
public bucket unless `STELLA_NATIVE_HELPERS_MANIFEST_URL` /
`STELLA_BROWSER_MANIFEST_URL` say otherwise.

### 1.9 The website (optional)

`packages/website` is a Next.js app (Stella hosts it on Vercel). It is not
needed for chat. It serves downloads and install scripts, the web chat, the
interactive map behind the `map` tool's cards, the hosted OAuth callbacks for
connectors that only accept https redirects, the sign-in landing page and the
billing return page. Its env:

| Var | Value |
|---|---|
| `NEXT_PUBLIC_STELLA_BACKEND_URL` | your backend |
| `NEXT_PUBLIC_STELLA_SITE_URL` | the site's own origin |
| `NEXT_PUBLIC_STELLA_RELEASES_URL` | your releases bucket's public base |
| `NEXT_PUBLIC_TURNSTILE_SITE_KEY` | optional (Part 2) |
| `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` | optional (Part 2) |
| `NEXT_PUBLIC_GOOGLE_ADS_ID`, `NEXT_PUBLIC_GOOGLE_ADS_DOWNLOAD_LABEL`, `NEXT_PUBLIC_GOOGLE_ADS_SIGNUP_LABEL` | optional: your Google Ads tag and conversion labels. Unset, no Google tag loads |

Then set `STELLA_WEBSITE_URL` on cloud-builder, `STELLA_WEB_URL` for the
desktop, and `EXPO_PUBLIC_STELLA_SITE_URL` for mobile to the same origin.

### 1.10 Your own mobile app (optional)

Needs an Expo account, an Apple Developer account (iOS) and a Google Play
developer account (Android). In `packages/mobile`:

- `app.json` is Stella's app identity: `owner`, `slug`,
  `extra.eas.projectId` and `updates.url` (your EAS project), `ios.appleTeamId`,
  `ios.bundleIdentifier` (and the Live Activities target's), `android.package`,
  and `scheme`. Change them to yours (`bunx eas init` creates the project).
- `eas.json`: set `EXPO_PUBLIC_STELLA_BACKEND_URL` per profile (and
  `EXPO_PUBLIC_STELLA_SITE_URL` if you host the website); drop or replace
  `EXPO_PUBLIC_PLAY_INTEGRITY_PROJECT_NUMBER` and the `submit` ids.
- If you change `scheme`, set cloud-builder's `STELLA_MOBILE_SCHEME` and
  `EXPO_PUBLIC_STELLA_MOBILE_SCHEME` to it.
- Build with `bunx eas build --profile production`. Push notifications go
  through Expo's push service with the APNs and FCM credentials in your EAS
  project; the backend needs no key for them.

## Part 2: optional providers

Each row is off until its keys are set; the feature then says it is not set up.
Secrets go on **cloud-builder** unless noted.

| Feature | Keys | Provider | Without it |
|---|---|---|---|
| Billing (plans, limits, Stripe checkout) | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (webhook URL `<backend>/api/stripe/webhook`), `STRIPE_PRICE_GO`, `STRIPE_PRICE_PRO`, `STELLA_INCLUDED_USAGE_UTILIZATION_RATE`, `STELLA_GO_PRICE_CENTS`, `STELLA_PRO_PRICE_CENTS`, `STELLA_FREE_{ROLLING,WEEKLY,MONTHLY}_LIMIT_USD`, `STELLA_FREE_ROLLING_WINDOW_HOURS`, `STELLA_ANON_LIFETIME_LIMIT_USD`, `STELLA_ANON_MAX_REQUESTS`; optional overrides in `workers/cloud-builder/src/billing/plans.ts` | Stripe | Billing is off: every account is Pro, unlimited; checkout says billing isn't set up. Setting any one of `STELLA_INCLUDED_USAGE_UTILIZATION_RATE`, `STRIPE_SECRET_KEY`, `STRIPE_PRICE_GO`, `STRIPE_PRICE_PRO` turns billing on, and then all the required ones must be set or turns are refused |
| Email sign-in (magic links) | var `STELLA_EMAIL_FROM` on a domain enabled for Email Sending (see 1.6); or, instead or as a fallback, `RESEND_API_KEY`, `RESEND_FROM`; optional `STELLA_EMAIL_LOGO_URL` | Cloudflare Email Service (Resend fallback) | Magic links answer 503 "Email sign-in isn't set up" |
| Google / Apple sign-in | see 1.6 | Google, Apple | The provider isn't offered |
| Web search tool | `PARALLEL_API_KEY` | Parallel | The tool reports it isn't configured |
| Image, video, audio, 3D generation | `FAL_KEY`, `MEDIA_SIGNING_SECRET` (`openssl rand -hex 32`) | fal.ai | 503 "Media generation is not configured yet" |
| Music | `GOOGLE_AI_API_KEY` | Google AI Studio (Lyria) | Unavailable |
| Read-aloud (TTS) | `GOOGLE_AI_API_KEY` (Gemini TTS) or `OPENAI_API_KEY`; mobile streaming also `MEDIA_SIGNING_SECRET` | Google AI Studio / OpenAI | 503 "read-aloud is not configured yet" |
| Realtime voice | `OPENAI_API_KEY` | OpenAI Realtime | Unavailable (users can still bring their own xAI / Inworld keys on desktop) |
| Dictation | `OPENROUTER_API_KEY` (cloud-builder's own copy); optional var `STELLA_DICTATION_MODEL` (default `meta/muse-voice-transcribe-1.0`) | OpenRouter | Desktop users are asked for their own OpenRouter key on their first mic press; it stays on their computer. `META_MODEL_API_KEY` only serves the legacy realtime socket for older clients |
| Speech-to-text media capability | `OPENROUTER_API_KEY` (cloud-builder's own copy) | OpenRouter | Unavailable |
| Image description in chat | `GOOGLE_AI_API_KEY` on **model-gateway** | Google AI Studio | That model call fails |
| Other managed models | `FIREWORKS_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `META_MODEL_API_KEY` on **model-gateway** | as named | Only models routed to that provider fail ("The model provider is not configured"); the defaults use OpenRouter |
| ChatGPT sign-in for agents | `OWNER_SECRETS_KEK` (`openssl rand -base64 32`), `OAUTH_STATE_SECRET` (`openssl rand -hex 32`) | OpenAI (the user's own ChatGPT plan) | "Engine connections aren't configured yet" |
| Integrations store | `COMPOSIO_API_KEY` (optional `COMPOSIO_TOOL_ROUTER_URL`); the catalog is loaded through the admin API (`STELLA_ADMIN_API_SECRET`) | Composio | No store integrations |
| X connector | `X_CLIENT_ID`, `X_CLIENT_SECRET`, `OAUTH_STATE_SECRET` | X | Unavailable |
| GitHub projects | `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_WEBHOOK_SECRET`, `OAUTH_STATE_SECRET` | GitHub App | Unavailable |
| Desktop OAuth connectors that exchange tokens on the server (Google Workspace, Box, Microsoft, Atlassian, ...) | `NATIVE_OAUTH_CLIENTS_JSON` (`{"<provider>": {"clientId": "...", "clientSecret": "..."}}`); desktop client ids can be overridden with `STELLA_NATIVE_OAUTH_<ID>_CLIENT_ID`. Providers that only allow https redirects use `<STELLA_WEB_URL>/oauth/<provider>/callback`, so they need the website | each provider | Those connectors aren't offered |
| Maps tool | `GOOGLE_MAPS_SERVER_API_KEY` (Places API (New) + Directions); the card's interactive view also needs `NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY` on the **website** | Google Maps Platform | The `map` tool says maps aren't set up |
| Captcha on anonymous web sign-in | `TURNSTILE_SECRET_KEY`; site key in `VITE_TURNSTILE_SITE_KEY` (desktop web build) and `NEXT_PUBLIC_TURNSTILE_SITE_KEY` (website) | Cloudflare Turnstile | No captcha |
| Mobile app integrity | `APPLE_APP_ATTEST_TEAM_ID`, `GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON` (+ `EXPO_PUBLIC_PLAY_INTEGRITY_PROJECT_NUMBER`); `STELLA_APP_INTEGRITY_MODE` = `enforce` / `off` | Apple App Attest, Google Play Integrity | Off |
| Admin API (test accounts, integrations catalog, billing tools) | `STELLA_ADMIN_API_SECRET`; test accounts also need var `STELLA_TEST_ACCOUNTS=1` (dev only) | none | Admin routes answer 503 |
| Ops relay probe | `STELLA_RELAY_PROBE_SECRET` on **model-gateway** | none | No probe |
| Gateway alerts | `STELLA_ALERT_WEBHOOK_URL` on **model-gateway** | any webhook | No alerts |
| Telemetry lake | sink and pipeline per `infra/telemetry/README.md`; desktop `STELLA_TELEMETRY_ENDPOINT` | Cloudflare Pipelines, R2 Data Catalog | Events are accepted and not stored |
