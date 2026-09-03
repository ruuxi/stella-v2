# Abuse protection: external setup runbook

This is a self-contained checklist for configuring everything the abuse-protection code in this repo needs outside the codebase: Cloudflare resources and secrets, Convex environment variables, Turnstile, Apple App Attest, Google Play Integrity, and client build variables. It assumes no prior context.

**Current state (2026-09-02):** all code is on `master` (commits `16d58e536`, `89163cd88`, `9828326af`, `5960fe5b0`). None of the external resources or secrets below have been created or set yet. The Wrangler configs contain `REPLACE_ME_*` placeholder ids that must be replaced before deploying the Workers. Anything not explicitly marked "already existed" is new and unset.

Design background lives in the maintainer's `~/Documents/stella-abuse-protection-proposal.md` (not in the repo). This runbook is enough on its own to do the setup.

## 0. Inventory of environments

| Thing | Dev | Production |
| --- | --- | --- |
| Convex deployment (HTTP site URL) | `https://outgoing-bulldog-865.convex.site` | `https://intent-jackal-330.convex.site` |
| Model gateway Worker (`workers/model-gateway/wrangler.jsonc`) | `stella-v2-model-gateway-dev` (default env) | `stella-v2-model-gateway` (`--env production`) |
| Cloud builder Worker (`workers/cloud-builder/wrangler.jsonc`) | `stella-v2-cloud-builder-dev` (default env); a second dev env `bn118` = `stella-v2-cloud-builder-basic-nightingale-118` pointing at `basic-nightingale-118.convex.site` | `stella-v2-cloud-builder-prod` (`--env production`) |
| iOS app | bundle id `com.stella.mobile` (Expo 57, `packages/mobile/app.json`) | same |
| Android app | package `com.fromyou.stella` | same |
| Website (Next) | `packages/website`, deployed at the Stella site (default `https://stella.sh`) | same |

Tools: `bunx wrangler` (Cloudflare), `npx convex` (run from `packages/backend`; `--prod` targets production), `eas`/Xcode for the mobile app.

To see what is currently set: `cd packages/backend && npx convex env list` (dev) and `npx convex env list --prod`. For Workers: `bunx wrangler secret list` and `bunx wrangler secret list --env production` inside each worker directory.

## 1. Cloudflare: KV namespaces (required before any Worker deploy)

Both Workers now reference KV namespaces whose ids are placeholders. Create them and paste the returned ids into the configs.

```sh
cd workers/model-gateway
bunx wrangler kv namespace create OWNER_ENFORCEMENT
bunx wrangler kv namespace create OWNER_ENFORCEMENT --env production
bunx wrangler kv namespace create ASN_POLICY
bunx wrangler kv namespace create ASN_POLICY --env production

cd ../cloud-builder
bunx wrangler kv namespace create ASN_POLICY
bunx wrangler kv namespace create ASN_POLICY --env bn118
bunx wrangler kv namespace create ASN_POLICY --env production
```

Then edit:

- `workers/model-gateway/wrangler.jsonc`: replace `REPLACE_ME_DEV` and `REPLACE_ME_PROD` (binding `OWNER_ENFORCEMENT`) and `REPLACE_ME_ASN_POLICY_DEV` / `REPLACE_ME_ASN_POLICY_PROD` (binding `ASN_POLICY`).
- `workers/cloud-builder/wrangler.jsonc`: replace `REPLACE_ME_ASN_POLICY_DEV`, `REPLACE_ME_ASN_POLICY_BN118`, `REPLACE_ME_ASN_POLICY_PROD` (binding `ASN_POLICY`).

What they hold: `OWNER_ENFORCEMENT` is written by Convex (suspend/throttle status per owner) and read by the gateway; you never write it by hand. `ASN_POLICY` is an optional override map, key = decimal ASN number, value = one of `hosting | vpn | residential | mobile | edu | unknown`; leave it empty unless the built-in classifier misclassifies a network.

The gateway's Durable Object migration `v2` (classes `OwnerRelayGate`, `NetworkGate`, `TierBudget`) applies automatically on the next `wrangler deploy`. The gateway also uses Workers rate-limit namespaces `41011` (dev) and `41012` (prod) for `ANON_IP_LIMITER`; these already existed.

## 2. Cloudflare: Worker secrets

Model gateway (`cd workers/model-gateway`; run each once without `--env` and once with `--env production`):

| Secret | Status | Value |
| --- | --- | --- |
| `GATEWAY_SERVICE_SECRET` | already existed | Shared bearer between Convex and the gateway; must equal Convex `GATEWAY_SERVICE_SECRET`. |
| `STELLA_RELAY_PROBE_SECRET`, provider API keys (`OPENROUTER_API_KEY`, `FIREWORKS_API_KEY`, `DEEPSEEK_API_KEY`, `CROF_API_KEY`, `WAFER_API_KEY`, `XAI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GOOGLE_AI_API_KEY`, `META_MODEL_API_KEY`) | already existed | unchanged |
| `ALERT_WEBHOOK_URL` | new, optional | A Slack-compatible incoming-webhook URL (the body is `{ "text": ... }`). Tier-breaker trips post here. Skip to disable. |

```sh
bunx wrangler secret put ALERT_WEBHOOK_URL
bunx wrangler secret put ALERT_WEBHOOK_URL --env production
```

Cloud builder: no new secrets. `BUILDER_SERVICE_SECRET` (already existed) must equal Convex `BUILDER_SERVICE_SECRET`.

The gateway var `CAPABILITY_JWKS` (public ES256 keys of the two capability issuers) already existed. Production currently has `{"keys":[]}`, which fails closed; it must carry the production public keys for `CAPABILITY_SIGNING_KID` (Convex) and the builder's `CAPABILITY_SIGNING_KID`. Generate a pair with `bun scripts/generate-capability-keys.mjs <kid>` (prints the PKCS8 private PEM for the signer and the JWK entry for `CAPABILITY_JWKS`). This is part of the earlier gateway work, not the abuse stages, but the abuse controls sit behind it.

## 3. Cloudflare Turnstile (web and desktop)

Turnstile protects anonymous sign-in and magic link for the website, the embedded `/chat` app, and the Electron desktop app. Mobile does NOT use it (see section 6).

1. Cloudflare dashboard → Turnstile → Add widget. Mode: **Managed**. Hostnames: the website host (e.g. `stella.sh`) and any preview hosts. The Electron app loads the hosted page `https://<website>/challenge`, so the website host covers desktop too.
2. Copy the **site key** (public) and **secret key**.
3. Convex (both deployments): `TURNSTILE_SECRET_KEY=<secret>`. When unset, Turnstile verification is OFF and a warning is logged once.
4. Client builds (public site key):
   - Website: `NEXT_PUBLIC_TURNSTILE_SITE_KEY` in the website's env (Vercel or wherever it builds). The website build also forwards it to the embedded chat app as `VITE_TURNSTILE_SITE_KEY`.
   - Desktop: `VITE_TURNSTILE_SITE_KEY` in `packages/desktop-ui/.env` (or the CI env) for both the renderer bundle and the Electron main build (`packages/desktop/scripts/dev-electron-build.mjs` bakes it in). Optionally `STELLA_WEB_URL` / `VITE_STELLA_WEB_URL` if the hosted challenge page is not at the default `https://stella.sh`.
   When a client has no site key it sends no token and the server refuses account creation in production (fail closed), so set the key everywhere Turnstile is on.

## 4. Convex environment variables

Run from `packages/backend`: `npx convex env set NAME value` (dev) and `npx convex env set NAME value --prod`. USD values are plain numbers.

### 4.1 Required (the deployment throws on first use without them)

| Variable | Purpose | Suggested value |
| --- | --- | --- |
| `STELLA_ANON_LIFETIME_LIMIT_USD` | Total managed-model spend an anonymous owner may ever have | `0.10` |
| `STELLA_ANON_MAX_REQUESTS` | Lifetime anonymous request count per anonymous owner (already existed) | `25` |
| `ANON_DEVICE_ID_HASH_SALT` | Secret salt for anonymous counters (already existed) | random 32+ bytes |
| `STELLA_FREE_ROLLING_LIMIT_USD`, `STELLA_FREE_ROLLING_WINDOW_HOURS`, `STELLA_FREE_WEEKLY_LIMIT_USD`, `STELLA_FREE_MONTHLY_LIMIT_USD` | Free plan windows (already existed) | keep current values |
| `GATEWAY_SERVICE_SECRET`, `MODEL_GATEWAY_URL`, `CAPABILITY_SIGNING_KEY`, `CAPABILITY_SIGNING_KID`, `CLOUD_BUILDER_URL`, `BUILDER_SERVICE_SECRET`, `STELLA_ADMIN_API_SECRET` | Gateway/builder wiring and the admin bearer (already existed) | keep current values |

### 4.2 Optional with defaults

| Variable | Default | Meaning |
| --- | --- | --- |
| `STELLA_ANON_ROLLING_LIMIT_USD`, `STELLA_ANON_WEEKLY_LIMIT_USD`, `STELLA_ANON_MONTHLY_LIMIT_USD` | = lifetime value | Anonymous windows |
| `STELLA_ANON_ROLLING_WINDOW_HOURS` | `5` | Anonymous rolling window |
| `STELLA_ANON_MAX_REQUESTS_PER_IP` | 10 × per-owner | Anonymous requests per network bucket |
| `STELLA_TIER_CEILING_ANON_HOURLY_USD` / `STELLA_TIER_CEILING_ANON_DAILY_USD` | `20` / `200` | Global anonymous spend breakers; `-1` disables |
| `STELLA_TIER_CEILING_FREE_HOURLY_USD` / `STELLA_TIER_CEILING_FREE_DAILY_USD` | `100` / `1000` | Global Free spend breakers; `-1` disables |
| `STELLA_FREE_EMAIL_ALLOWANCE_SHARE` | `0.4` | Share of the Free allowance for email-only (magic link) accounts; Google/Apple accounts get 1.0 |
| `STELLA_TTS_DAILY_CHARS_FREE` / `_GO` / `_PRO` | `60000` / `300000` / `1000000` | Read-aloud characters per day |
| `STELLA_APP_ARTIFACT_QUOTA_MB_FREE` / `_GO` / `_PRO` | `200` / `1024` / `5120` | Hosted app artifact bytes per owner |
| `STELLA_EMAIL_DOMAIN_BLOCKLIST` | empty | Extra disposable-email domains, comma separated |
| `STELLA_RISK_WEIGHTS_JSON` | built-in weights | Risk-score weights override |
| `STELLA_ALERT_WEBHOOK_URL` | unset | Slack-compatible webhook for enforcement changes and gateway alerts forwarded through Convex |
| `STELLA_TEST_ACCOUNTS` | unset = disabled | Set to `1` on dev only to enable admin-minted `@test.stella.local` sessions; never set it on production |
| `TURNSTILE_SECRET_KEY` | unset = OFF | See section 3 |
| `STELLA_APP_INTEGRITY_MODE` | `enforce` if any platform env is set, else `off` | See section 6; set `off` on dev |
| `STELLA_APP_ATTEST_ALLOW_DEVELOPMENT` | unset | `1` accepts App Attest's development environment (debug builds on real iPhones); dev only |
| `STELLA_PLAY_INTEGRITY_ALLOW_UNRECOGNIZED` | unset | `1` accepts Play verdict `UNRECOGNIZED_VERSION` (builds not installed from Play); dev only |
| `APPLE_APP_ATTEST_TEAM_ID` | unset | Section 6 |
| `GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON` | unset | Section 6 |

### 4.3 Recommended per deployment

Dev: `STELLA_APP_INTEGRITY_MODE=off`; leave `TURNSTILE_SECRET_KEY` unset unless testing Turnstile (with it unset, sybil and risk-cron challenges at capability mint are skipped too, since nothing could answer them; suspension and sign-in requirements still apply); set `STELLA_ANON_LIFETIME_LIMIT_USD` (required).

Production: set `TURNSTILE_SECRET_KEY`, `APPLE_APP_ATTEST_TEAM_ID`, `GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON` together. With only one of Turnstile or app integrity configured, the server refuses account creation from the other platform's clients (a web request must carry a Turnstile token, a mobile request must carry an integrity proof, and there is no third option in enforce mode).

## 5. Deploy order

1. Convex env (section 4) on the target deployment, then `npx convex deploy` (or `npx convex dev` for dev). The schema adds tables `gateway_capability_grants`, `owner_enforcement`, `owner_origins`, `owner_daily_counters`, `owner_risk_signals`, `app_integrity_nonces`, `app_attest_keys`, and new crons; no migration steps.
2. Model gateway: KV ids (section 1), secrets (section 2), then `bunx wrangler deploy` (and `--env production`).
3. Cloud builder: KV ids, then `bunx wrangler deploy` (per env).
4. Website with `NEXT_PUBLIC_TURNSTILE_SITE_KEY`.
5. Desktop build with `VITE_TURNSTILE_SITE_KEY`.
6. Mobile build (section 6).

## 6. Mobile app integrity (Apple App Attest, Google Play Integrity)

The mobile app never uses Turnstile. It proves it is Stella's unmodified app on a real device on anonymous ("guest") sign-in and magic link. Server code: `packages/backend/convex/app_integrity*.ts`, `lib/app_integrity.ts`. Client: `packages/mobile/src/lib/app-integrity.ts` using `@expo/app-integrity` 57.0.1 (installed).

### 6.1 Apple

1. Apple Developer portal → Certificates, Identifiers & Profiles → Identifiers → App ID `com.stella.mobile` → enable the **App Attest** capability. Regenerate provisioning profiles if they are managed manually (EAS managed credentials regenerate on the next build).
2. The entitlement `com.apple.developer.devicecheck.appattest-environment = production` is already in `packages/mobile/app.json` under `ios.entitlements`.
3. Convex (prod, and dev if you test on real devices): `APPLE_APP_ATTEST_TEAM_ID=<10-character Team ID>`. Find it in the developer portal membership page.
4. Dev only: `STELLA_APP_ATTEST_ALLOW_DEVELOPMENT=1` so debug builds on real iPhones (which attest in Apple's development environment) are accepted.
5. Nothing else is needed on Apple's side; App Attest has no server API. Convex verifies the attestation certificate chain against Apple's root and tracks the assertion counter itself (via `node-app-attest`).

### 6.2 Google

1. Google Play Console → the app `com.fromyou.stella` → **App integrity** → Play Integrity API → **Link a Google Cloud project** (create one if needed). Note the numeric **project number**.
2. Google Cloud console, that project → APIs & Services → enable **Google Play Integrity API**.
3. IAM → **Create a service account** (any name, no roles are required for decoding tokens; the linked project is what authorizes it). Create a **JSON key** and download it.
4. Convex (prod, and dev if testing on real Android devices): `GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON=<the entire JSON key file contents>` (single line is fine; `\n` inside `private_key` is handled).
5. Mobile build env: `EXPO_PUBLIC_PLAY_INTEGRITY_PROJECT_NUMBER=<project number>` (see `packages/mobile/.env.example`). Without it the Android client sends no proof.
6. Only builds installed through Google Play (internal testing track is enough) get the `PLAY_RECOGNIZED` verdict. For sideloaded dev builds set `STELLA_PLAY_INTEGRITY_ALLOW_UNRECOGNIZED=1` on the dev deployment.

### 6.3 Behaviour to expect

- iOS Simulator and Android emulators cannot produce proofs. On the dev deployment `STELLA_APP_INTEGRITY_MODE=off` accepts sign-ins without a proof (logged once). Production enforces, so simulators cannot create guest accounts against prod.
- First sign-in on a device attests a new App Attest key (stored server-side in `app_attest_keys`); later sign-ins send assertions with an increasing counter. If the server loses the key the client re-attests automatically (`integrity_key_unknown`).
- Nonces come from `POST {convex site}/api/auth/integrity/challenge` (`{ "purpose": "anonymous-sign-in" | "magic-link" }`), last 5 minutes, and are single-use.

## 7. Cloudflare zone hardening (recommended, not code)

Both Workers are on `workers.dev` and Convex HTTP is on `convex.site`, so zone-level WAF, Bot Fight Mode, and rate-limiting rules currently protect nothing. Recommended: custom domains on the Stella zone for the two Workers (wrangler `routes` with `custom_domain: true`), a Convex custom domain for the HTTP router proxied through Cloudflare (the sync WebSocket stays on `.convex.cloud`), then enable Bot Fight Mode and add a rate-limiting rule on `/api/auth/sign-in/anonymous`. This requires DNS changes and is the maintainer's call.

## 8. Verification after setup

From `packages/backend` with the deployment's site URL as `$SITE` and the admin bearer as `$ADMIN`:

```sh
# Gateway config carries the tier ceilings (service secret from the gateway)
curl -s -H "authorization: Bearer $GATEWAY_SERVICE_SECRET" "$SITE/api/gateway/config" | head -c 600

# Admin lookup (email or ownerId)
curl -s -H "authorization: Bearer $ADMIN" "$SITE/api/admin/owners/lookup?email=you@example.com"

# Suspend and clear an owner; the gateway KV entry appears within seconds
curl -s -X POST -H "authorization: Bearer $ADMIN" -H "content-type: application/json" \
  -d '{"email":"you@example.com","status":"suspended","reason":"manual test"}' "$SITE/api/admin/owners/enforcement"
curl -s -X POST -H "authorization: Bearer $ADMIN" -H "content-type: application/json" \
  -d '{"email":"you@example.com","status":"ok","reason":"cleared"}' "$SITE/api/admin/owners/enforcement"

# Top spenders / risk
curl -s -H "authorization: Bearer $ADMIN" "$SITE/api/admin/owners/top?window=24h&by=spend"

# App-integrity challenge issues a nonce
curl -s -X POST -H "content-type: application/json" -d '{"purpose":"anonymous-sign-in"}' "$SITE/api/auth/integrity/challenge"
```

Expected client behaviour once everything is set: website and desktop anonymous sign-in show a Turnstile widget (usually invisible); mobile guest sign-in on a real device succeeds with no visible step; a curl to `/api/auth/sign-in/anonymous` without a token or proof is refused with `integrity_required`.

## 9. Things intentionally not done in code

- No Cloudflare KV ids, secrets, Turnstile widget, Apple capability, Play Console linkage, or service account were created; all of section 1 to 6 is pending.
- Zone-level hardening (section 7) is pending and needs DNS decisions.
- The mobile module is installed but no mobile build has been produced with the new entitlement or env yet.
