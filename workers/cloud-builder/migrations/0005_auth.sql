-- Identity (src/auth/). The first six tables are Better Auth's own schema,
-- generated with its migration compiler for the options in src/auth/auth.ts
-- (bearer, one-time token, anonymous, magic link, captcha, JWT, database rate
-- limiting, user.identityLevel). Regenerate them when a plugin or field
-- changes. The rest belong to the stellaHandoff plugin (src/auth/handoff.ts)
-- and app integrity (src/auth/integrity.ts). The Cron Trigger deletes expired
-- rows (src/cron.ts).

create table "user" ("id" text not null primary key, "name" text not null, "email" text not null unique, "emailVerified" integer not null, "image" text, "createdAt" date not null, "updatedAt" date not null, "isAnonymous" integer, "identityLevel" integer);

create table "session" ("id" text not null primary key, "expiresAt" date not null, "token" text not null unique, "createdAt" date not null, "updatedAt" date not null, "ipAddress" text, "userAgent" text, "userId" text not null references "user" ("id") on delete cascade);

create table "account" ("id" text not null primary key, "accountId" text not null, "providerId" text not null, "userId" text not null references "user" ("id") on delete cascade, "accessToken" text, "refreshToken" text, "idToken" text, "accessTokenExpiresAt" date, "refreshTokenExpiresAt" date, "scope" text, "password" text, "createdAt" date not null, "updatedAt" date not null);

create table "verification" ("id" text not null primary key, "identifier" text not null, "value" text not null, "expiresAt" date not null, "createdAt" date not null, "updatedAt" date not null);

create table "jwks" ("id" text not null primary key, "publicKey" text not null, "privateKey" text not null, "createdAt" date not null, "expiresAt" date);

create table "rateLimit" ("id" text not null primary key, "key" text not null unique, "count" integer not null, "lastRequest" bigint not null);

create index "session_userId_idx" on "session" ("userId");

create index "account_userId_idx" on "account" ("userId");

create index "verification_identifier_idx" on "verification" ("identifier");

-- The anonymous cleanup reads stale anonymous users; the TTL sweep reads
-- expired verification rows.
create index "user_isAnonymous_updatedAt_idx" on "user" ("isAnonymous", "updatedAt");

create index "verification_expiresAt_idx" on "verification" ("expiresAt");

-- A browser-to-app sign-in handoff (magic link, desktop social). The app sends
-- only SHA-256(claimSecret); the completed session token is stored encrypted
-- under BETTER_AUTH_SECRET and released once to whoever presents the secret.
-- `from_user_id` is the anonymous user a magic link or social sign-in
-- upgrades in place.
CREATE TABLE auth_link_requests (
  request_id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  status TEXT NOT NULL,
  from_user_id TEXT,
  claim_hash TEXT NOT NULL,
  token_enc TEXT,
  to_user_id TEXT,
  claim_attempts INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  completed_at INTEGER
);
CREATE INDEX auth_link_requests_expires ON auth_link_requests (expires_at);

-- A browser social sign-in's single-use return target. The provider callback
-- carries only the request id; the target is fixed here at start.
CREATE TABLE auth_browser_handoffs (
  request_id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  from_user_id TEXT NOT NULL,
  return_origin TEXT NOT NULL,
  return_to TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX auth_browser_handoffs_expires ON auth_browser_handoffs (expires_at);

-- One-time challenges for mobile app integrity proofs. Burned on first use.
CREATE TABLE integrity_nonces (
  nonce TEXT PRIMARY KEY,
  purpose TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE INDEX integrity_nonces_expires ON integrity_nonces (expires_at);

-- iOS App Attest keys registered by an attestation, with the assertion
-- counter that must only move forward.
CREATE TABLE app_attest_keys (
  key_id TEXT PRIMARY KEY,
  public_key TEXT NOT NULL,
  sign_count INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
