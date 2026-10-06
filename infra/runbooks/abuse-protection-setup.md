# Abuse protection: external setup runbook

This is a self-contained checklist for configuring everything the abuse-protection code in this repo needs outside the codebase: Cloudflare resources and secrets, cloud-builder Worker settings, Turnstile, Apple App Attest, Google Play Integrity, and client build variables. It assumes no prior context.

The original setup was done on Convex; the settings moved to the cloud-builder Worker in phase 10.

Design background lives in the maintainer's `~/Documents/stella-abuse-protection-proposal.md` (not in the repo). This runbook is enough on its own to do the setup.

## 0. Inventory of environments

| Thing | Dev | Production |
| --- | --- | --- |
| Backend (cloud-builder Worker, `workers/cloud-builder/wrangler.jsonc`; auth and integrity routes under `/api/auth/*`) | `https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev` (default env); a second dev env `bn118` = `stella-v2-cloud-builder-basic-nightingale-118` | `https://stella-v2-cloud-builder-prod.lolruuxi.workers.dev` (`--env production`) |
| Model gateway Worker (`workers/model-gateway/wrangler.jsonc`) | `stella-v2-model-gateway-dev` (default env) | `stella-v2-model-gateway` (`--env production`) |
| iOS app | bundle id `com.stella.mobile` (Expo 57, `packages/mobile/app.json`) | same |
| Android app | package `com.fromyou.stella` | same |
| Website (Next) | `packages/website`, deployed at the Stella site (default `https://stella.sh`) | same |

Tools: `bunx wrangler` (Cloudflare), `eas`/Xcode for the mobile app.

To see what is currently set: `bunx wrangler secret list` and `bunx wrangler secret list --env production` inside each worker directory. Plain (non-secret) settings are `vars` in each worker's `wrangler.jsonc`.

## 1. Cloudflare: KV namespaces

The KV ids are already filled in both configs; this section only matters for a new environment.

- `workers/model-gateway/wrangler.jsonc`: `OWNER_ENFORCEMENT` and `ASN_POLICY`.
- `workers/cloud-builder/wrangler.jsonc`: `ASN_POLICY` (default, `bn118`, `production`).

Create a namespace with `bunx wrangler kv namespace create <BINDING> [--env <env>]` in the worker directory and paste the returned id.

What they hold: `OWNER_ENFORCEMENT` mirrors the suspend/throttle status that each owner's `OwnerGate` pushes to the gateway (`ModelGatewayControl.applyOwnerEnforcement`); you never write it by hand. `ASN_POLICY` is an optional override map, key = decimal ASN number, value = one of `hosting | vpn | residential | mobile | edu | unknown`; leave it empty unless the built-in classifier misclassifies a network.

The gateway also uses Workers rate-limit namespaces `41011` (dev) and `41012` (prod) for `ANON_IP_LIMITER`.

## 2. Model gateway settings

Run in `workers/model-gateway`, once without `--env` and once with `--env production`:

| Setting | Kind | Value |
| --- | --- | --- |
| `STELLA_RELAY_PROBE_SECRET`, provider API keys (`OPENROUTER_API_KEY`, `FIREWORKS_API_KEY`, `DEEPSEEK_API_KEY`, `XAI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_AI_API_KEY`, `META_MODEL_API_KEY`) | secret | already set |
| `STELLA_ALERT_WEBHOOK_URL` | secret, optional | A Slack-compatible incoming-webhook URL (the body is `{ "text": ... }`). Owner enforcement status changes post here. Skip to disable. |
| `CAPABILITY_JWKS` | var | Public ES256 keys of cloud-builder's `CAPABILITY_SIGNING_KID` for that environment. Already set in `wrangler.jsonc`. |

```sh
bunx wrangler secret put STELLA_ALERT_WEBHOOK_URL
bunx wrangler secret put STELLA_ALERT_WEBHOOK_URL --env production
```

A new signing key pair comes from `bun scripts/generate-capability-keys.mjs <kid>` (prints the PKCS8 private PEM for cloud-builder's `CAPABILITY_SIGNING_KEY` secret and the JWK entry for `CAPABILITY_JWKS`).

## 3. Cloudflare Turnstile (web and desktop)

Turnstile protects anonymous sign-in and magic link for the website, the embedded `/chat` app, and the Electron desktop app. Mobile does NOT use it (see section 6).

1. Cloudflare dashboard → Turnstile → Add widget. Mode: **Managed**. Hostnames: the website host (e.g. `stella.sh`) and any preview hosts. The Electron app loads the hosted page `https://<website>/challenge`, so the website host covers desktop too.
2. Copy the **site key** (public) and **secret key**.
3. Cloud builder (each env): `bunx wrangler secret put TURNSTILE_SECRET_KEY [--env production]`. When unset, Turnstile verification is OFF and a warning is logged once.
4. Client builds (public site key):
   - Website: `NEXT_PUBLIC_TURNSTILE_SITE_KEY` in the website build's env (`packages/website/scripts/deploy-stella.sh` for Stella). The website build also forwards it to the embedded chat app as `VITE_TURNSTILE_SITE_KEY`.
   - Desktop: `VITE_TURNSTILE_SITE_KEY` in `packages/desktop-ui/.env` (or the CI env) for both the renderer bundle and the Electron main build (`packages/desktop/scripts/dev-electron-build.mjs` bakes it in). Optionally `STELLA_WEB_URL` / `VITE_STELLA_WEB_URL` if the hosted challenge page is not at the default `https://stella.sh`.
   When a client has no site key it sends no token and the server refuses account creation in production (fail closed), so set the key everywhere Turnstile is on.

## 4. Cloud builder settings

Run in `workers/cloud-builder`: `bunx wrangler secret put NAME` (dev) and `bunx wrangler secret put NAME --env production`. Non-sensitive values may instead go in the env's `vars` in `wrangler.jsonc`. USD values are plain numbers.

### 4.1 Required (`workers/cloud-builder/src/billing/plans.ts` throws on first use without them)

| Variable | Purpose |
| --- | --- |
| `STELLA_ANON_LIFETIME_LIMIT_USD` | Total managed-model spend an anonymous owner may ever have (suggested `0.10`) |
| `STELLA_ANON_MAX_REQUESTS` | Lifetime request count per anonymous owner (suggested `25`) |
| `STELLA_FREE_ROLLING_LIMIT_USD`, `STELLA_FREE_ROLLING_WINDOW_HOURS`, `STELLA_FREE_WEEKLY_LIMIT_USD`, `STELLA_FREE_MONTHLY_LIMIT_USD` | Free plan windows |
| `STELLA_ADMIN_API_SECRET` | Bearer for the `/api/admin/*` routes |

The rest of the plan catalog (paid prices, Stripe ids) is listed in the header of `billing/plans.ts`. `BUILDER_SERVICE_SECRET`, `CAPABILITY_SIGNING_KEY` and `CAPABILITY_SIGNING_KID` are wiring the Worker already requires.

### 4.2 Optional with defaults

| Variable | Default | Meaning |
| --- | --- | --- |
| `STELLA_ANON_ROLLING_LIMIT_USD`, `STELLA_ANON_WEEKLY_LIMIT_USD`, `STELLA_ANON_MONTHLY_LIMIT_USD` | = lifetime value | Anonymous windows |
| `STELLA_ANON_ROLLING_WINDOW_HOURS` | `5` | Anonymous rolling window |
| `STELLA_ANON_MAX_REQUESTS_PER_IP` | 10 × per-owner | Anonymous requests per network bucket |
| `STELLA_TIER_CEILING_ANON_HOURLY_USD` / `STELLA_TIER_CEILING_ANON_DAILY_USD` | `20` / `200` | Global anonymous spend breakers (`billing/control.ts`) |
| `STELLA_TIER_CEILING_FREE_HOURLY_USD` / `STELLA_TIER_CEILING_FREE_DAILY_USD` | `100` / `1000` | Global Free spend breakers |
| `STELLA_FREE_EMAIL_ALLOWANCE_SHARE` | `0.4` | Share of the Free allowance for email-only (magic link) accounts; Google/Apple accounts get 1.0 |
| `STELLA_TEST_ACCOUNTS` | unset = disabled | `1` (a dev `var`) enables admin-minted `@test.stella.local` sessions; never set it on production |
| `TURNSTILE_SECRET_KEY` | unset = OFF | See section 3 |
| `STELLA_APP_INTEGRITY_MODE` | `enforce` if any platform setting is present, else `off` | See section 6; set `off` on dev |
| `STELLA_APP_ATTEST_ALLOW_DEVELOPMENT` | unset | `1` accepts App Attest's development environment (debug builds on real iPhones); dev only |
| `STELLA_PLAY_INTEGRITY_ALLOW_UNRECOGNIZED` | unset | `1` accepts Play verdict `UNRECOGNIZED_VERSION` (builds not installed from Play); dev only |
| `APPLE_APP_ATTEST_TEAM_ID` | unset | Section 6 |
| `APPLE_APP_BUNDLE_IDENTIFIER` | `com.stella.mobile` | Section 6 |
| `GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON` | unset | Section 6 |

### 4.3 Recommended per deployment

Dev: `STELLA_APP_INTEGRITY_MODE=off`; leave `TURNSTILE_SECRET_KEY` unset unless testing Turnstile (with it unset, step-up challenges are skipped too, since nothing could answer them; suspension and sign-in requirements still apply); set the required values in 4.1.

Production: set `TURNSTILE_SECRET_KEY`, `APPLE_APP_ATTEST_TEAM_ID`, `GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON` together. With only one of Turnstile or app integrity configured, the server refuses account creation from the other platform's clients (a web request must carry a Turnstile token, a mobile request must carry an integrity proof, and there is no third option in enforce mode).

## 5. Deploy order

1. Cloud builder: settings (section 4), then `bun run deploy:dev` / `bun run deploy:production` in `workers/cloud-builder`. The integrity tables (`integrity_nonces`, `app_attest_keys`) live in D1 (`migrations/0005_auth.sql`).
2. Model gateway: settings (section 2), then `bunx wrangler deploy` (and `--env production`).
3. Website with `NEXT_PUBLIC_TURNSTILE_SITE_KEY`.
4. Desktop build with `VITE_TURNSTILE_SITE_KEY`.
5. Mobile build (section 6).

## 6. Mobile app integrity (Apple App Attest, Google Play Integrity)

The mobile app never uses Turnstile. It proves it is Stella's unmodified app on a real device on anonymous ("guest") sign-in and magic link. Server code: `workers/cloud-builder/src/auth/integrity.ts`. Client: `packages/mobile/src/lib/app-integrity.ts` using `@expo/app-integrity` 57.0.1.

### 6.1 Apple

1. Apple Developer portal → Certificates, Identifiers & Profiles → Identifiers → App ID `com.stella.mobile` → enable the **App Attest** capability. Regenerate provisioning profiles if they are managed manually (EAS managed credentials regenerate on the next build).
2. The entitlement `com.apple.developer.devicecheck.appattest-environment = production` is already in `packages/mobile/app.json` under `ios.entitlements`.
3. Cloud builder (prod, and dev if you test on real devices): `APPLE_APP_ATTEST_TEAM_ID=<10-character Team ID>`. Find it in the developer portal membership page.
4. Dev only: `STELLA_APP_ATTEST_ALLOW_DEVELOPMENT=1` so debug builds on real iPhones (which attest in Apple's development environment) are accepted.
5. Nothing else is needed on Apple's side; App Attest has no server API. The backend verifies the attestation certificate chain against Apple's root and tracks the assertion counter itself.

### 6.2 Google

1. Google Play Console → the app `com.fromyou.stella` → **App integrity** → Play Integrity API → **Link a Google Cloud project** (create one if needed). Note the numeric **project number**.
2. Google Cloud console, that project → APIs & Services → enable **Google Play Integrity API**.
3. IAM → **Create a service account** (any name, no roles are required for decoding tokens; the linked project is what authorizes it). Create a **JSON key** and download it.
4. Cloud builder (prod, and dev if testing on real Android devices): `GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON=<the entire JSON key file contents>` (single line is fine; `\n` inside `private_key` is handled).
5. Mobile build env: `EXPO_PUBLIC_PLAY_INTEGRITY_PROJECT_NUMBER=<project number>` (see `packages/mobile/.env.example`). Without it the Android client sends no proof.
6. Only builds installed through Google Play (internal testing track is enough) get the `PLAY_RECOGNIZED` verdict. For sideloaded dev builds set `STELLA_PLAY_INTEGRITY_ALLOW_UNRECOGNIZED=1` on the dev deployment.

### 6.3 Behaviour to expect

- iOS Simulator and Android emulators cannot produce proofs. On the dev deployment `STELLA_APP_INTEGRITY_MODE=off` accepts sign-ins without a proof (logged once). Production enforces, so simulators cannot create guest accounts against prod.
- First sign-in on a device attests a new App Attest key (stored server-side in `app_attest_keys`); later sign-ins send assertions with an increasing counter. If the server loses the key the client re-attests automatically (`integrity_key_unknown`).
- Nonces come from `POST {backend}/api/auth/integrity/challenge` (`{ "purpose": "anonymous-sign-in" | "magic-link" }`), last 5 minutes, and are single-use.

## 7. Cloudflare zone hardening (recommended, not code)

Both Workers are on `workers.dev`, so zone-level WAF, Bot Fight Mode, and rate-limiting rules currently protect nothing. Recommended: custom domains on the Stella zone for the two Workers (wrangler `routes` with `custom_domain: true`), then enable Bot Fight Mode and add a rate-limiting rule on `/api/auth/sign-in/anonymous`. This requires DNS changes and is the maintainer's call.

## 8. Verification after setup

With the cloud-builder URL as `$BACKEND` and the admin bearer as `$ADMIN`. Admin routes take an owner id (email lookup returns with auth):

```sh
# Admin lookup
curl -s -H "authorization: Bearer $ADMIN" "$BACKEND/api/admin/owners/lookup?ownerId=$OWNER"

# Suspend and clear an owner; the gateway KV entry appears within seconds
curl -s -X POST -H "authorization: Bearer $ADMIN" -H "content-type: application/json" \
  -d '{"ownerId":"'"$OWNER"'","status":"suspended","reason":"manual test"}' "$BACKEND/api/admin/owners/enforcement"
curl -s -X POST -H "authorization: Bearer $ADMIN" -H "content-type: application/json" \
  -d '{"ownerId":"'"$OWNER"'","status":"ok","reason":"cleared"}' "$BACKEND/api/admin/owners/enforcement"

# Highest risk scores (optional &status=challenged|throttled|suspended)
curl -s -H "authorization: Bearer $ADMIN" "$BACKEND/api/admin/owners/top?limit=20"

# App-integrity challenge issues a nonce
curl -s -X POST -H "content-type: application/json" -d '{"purpose":"anonymous-sign-in"}' "$BACKEND/api/auth/integrity/challenge"
```

Expected client behaviour once everything is set: website and desktop anonymous sign-in show a Turnstile widget (usually invisible); mobile guest sign-in on a real device succeeds with no visible step; a curl to `/api/auth/sign-in/anonymous` without a token or proof is refused with `integrity_required`.

## 9. Things intentionally not done in code

- Turnstile widget, Apple capability, Play Console linkage, and the service account are created outside the repo (sections 3 and 6).
- Zone-level hardening (section 7) is pending and needs DNS decisions.
