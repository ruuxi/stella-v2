#!/usr/bin/env bun
/**
 * Generate and set every internal secret a self-hosted Stella needs, plus the
 * capability signing key pair and the model gateway's CAPABILITY_JWKS.
 *
 *   bun scripts/self-host-setup.mjs                    # dev, dry run: shows what it would set
 *   bun scripts/self-host-setup.mjs --apply            # dev: sets the secrets, edits wrangler.jsonc
 *   bun scripts/self-host-setup.mjs --env production --apply
 *
 * A secret the worker already has is never replaced: BETTER_AUTH_SECRET signs
 * every session, OWNER_SECRETS_KEK and BROWSER_PROFILE_KEK_V1 encrypt stored
 * data, and the capability key must match the gateway's JWKS. Delete a secret
 * by hand first if you really mean to rotate it.
 *
 * Third-party keys (OpenRouter, the R2 API token, providers in Part 2 of
 * SELF_HOSTING.md) are yours to supply; the script lists the required ones.
 * Values are never printed. STELLA_ADMIN_API_SECRET, which you need for the
 * admin API, is written to workers/cloud-builder/.dev.vars (dev) or
 * ~/.config/stella/admin-api-secret.production (prod), mode 600.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { generateCapabilityKeyPair } from "../packages/contracts/gateway/jwt.ts";

const ROOT = path.resolve(import.meta.dirname, "..");
const ISSUER = "stella-cloud-builder";

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
if (flag("help")) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
  process.exit(0);
}

const env = option("env", "dev");
if (env !== "dev" && env !== "production") {
  console.error("--env must be dev or production.");
  process.exit(2);
}
const apply = flag("apply");
const kid = option("kid", env === "production" ? "builder-prod-1" : "builder-1");
if (!/^builder[a-z0-9-]{0,57}$/.test(kid)) {
  console.error("--kid must start with `builder` and use a-z, 0-9 and -.");
  process.exit(2);
}
const envArgs = ["--env", env === "dev" ? "" : "production"];

const hex = () => randomBytes(32).toString("hex");
const base64 = () => randomBytes(32).toString("base64");
const base64url = () => randomBytes(32).toString("base64url");

/** Internal secrets, by worker. Each value is random and only this deployment knows it. */
const GENERATED = {
  "cloud-builder": {
    BUILDER_SERVICE_SECRET: hex,
    BETTER_AUTH_SECRET: hex,
    MEDIA_SIGNING_SECRET: hex,
    OWNER_SECRETS_KEK: base64,
    OAUTH_STATE_SECRET: hex,
    STELLA_ADMIN_API_SECRET: hex,
  },
  "browser-gateway": { BROWSER_PROFILE_KEK_V1: base64url },
  telemetry: { TELEMETRY_PSEUDONYM_KEY: hex, TELEMETRY_SERVER_SECRET: hex },
};

/** Secrets deploys refuse to run without that only you can supply. */
const EXTERNAL = {
  "cloud-builder": ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"],
  "model-gateway": ["OPENROUTER_API_KEY"],
};

const workerDir = (worker) => path.join(ROOT, "workers", worker);

const wrangler = (worker, wranglerArgs, input) =>
  spawnSync("bunx", ["wrangler", ...wranglerArgs], {
    cwd: workerDir(worker),
    encoding: "utf8",
    input,
    stdio: ["pipe", "pipe", "pipe"],
  });

const existingSecrets = (worker) => {
  const result = wrangler(worker, ["secret", "list", ...envArgs, "--format", "json"]);
  if (result.status !== 0) return new Set();
  try {
    const start = result.stdout.indexOf("[");
    return new Set(JSON.parse(result.stdout.slice(start)).map((entry) => entry.name));
  } catch {
    return new Set();
  }
};

/** Replace the first `"NAME": "..."` line inside this env's block of a wrangler.jsonc. */
const setJsoncVar = (file, name, value) => {
  const text = readFileSync(file, "utf8");
  const envBlock = text.indexOf('"env": {');
  const productionBlock = text.indexOf('"production": {', envBlock);
  const [from, to] =
    env === "dev" ? [0, envBlock < 0 ? text.length : envBlock] : [productionBlock, text.length];
  if (from < 0) throw new Error(`${path.relative(ROOT, file)} has no ${env} block.`);
  const pattern = new RegExp(`("${name}":\\s*)"(?:[^"\\\\]|\\\\.)*"`);
  const slice = text.slice(from, to);
  const match = pattern.exec(slice);
  if (!match) throw new Error(`${path.relative(ROOT, file)} has no ${name} in its ${env} vars.`);
  const replaced = slice.replace(pattern, `$1${JSON.stringify(value)}`);
  writeFileSync(file, text.slice(0, from) + replaced + text.slice(to));
};

const saveAdminSecret = (value) => {
  if (env === "dev") {
    const file = path.join(workerDir("cloud-builder"), ".dev.vars");
    const current = existsSync(file) ? readFileSync(file, "utf8") : "";
    if (/^STELLA_ADMIN_API_SECRET=/m.test(current)) return `${file} (kept its existing value)`;
    appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}STELLA_ADMIN_API_SECRET=${value}\n`);
    chmodSync(file, 0o600);
    return file;
  }
  const dir = path.join(homedir(), ".config", "stella");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, "admin-api-secret.production");
  writeFileSync(file, `${value}\n`, { mode: 0o600 });
  return file;
};

const bulkPut = (worker, values) => {
  const dir = mkdtempSync(path.join(tmpdir(), "stella-secrets-"));
  const file = path.join(dir, "secrets.json");
  try {
    writeFileSync(file, JSON.stringify(values), { mode: 0o600 });
    const result = wrangler(worker, ["secret", "bulk", file, ...envArgs]);
    if (result.status !== 0) {
      throw new Error(`wrangler secret bulk failed for ${worker}:\n${result.stderr || result.stdout}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

console.log(`Stella self-host setup — ${env}${apply ? "" : " (dry run; pass --apply to make changes)"}\n`);

const plan = {};
for (const worker of [...Object.keys(GENERATED), "model-gateway"]) {
  plan[worker] = { existing: existingSecrets(worker), set: {} };
}

for (const [worker, generators] of Object.entries(GENERATED)) {
  for (const [name, generate] of Object.entries(generators)) {
    if (!plan[worker].existing.has(name)) plan[worker].set[name] = generate();
  }
}

let capability = null;
if (!plan["cloud-builder"].existing.has("CAPABILITY_SIGNING_KEY")) {
  const pair = await generateCapabilityKeyPair();
  plan["cloud-builder"].set.CAPABILITY_SIGNING_KEY = pair.privateKeyPem;
  capability = { kid, jwks: JSON.stringify({ keys: [{ kid, issuer: ISSUER, jwk: pair.publicJwk }] }) };
}

for (const [worker, { existing, set }] of Object.entries(plan)) {
  const names = Object.keys(set);
  const kept = [...existing].filter((name) => !names.includes(name));
  console.log(`${worker}:`);
  console.log(`  set:  ${names.length ? names.join(", ") : "nothing"}`);
  if (kept.length) console.log(`  kept: ${kept.length} existing secret(s)`);
}
if (capability) {
  console.log(`\nworkers/model-gateway/wrangler.jsonc: CAPABILITY_JWKS = the new public key (kid ${kid})`);
  console.log(`workers/cloud-builder/wrangler.jsonc: CAPABILITY_SIGNING_KID = ${kid}`);
} else {
  console.log("\nCAPABILITY_SIGNING_KEY already set; CAPABILITY_JWKS left as is.");
}

const missing = Object.entries(EXTERNAL).flatMap(([worker, names]) =>
  names.filter((name) => !plan[worker]?.existing.has(name)).map((name) => `${worker}: ${name}`),
);
if (missing.length) {
  console.log(`\nStill needed from you (SELF_HOSTING.md 1.3–1.4):\n  ${missing.join("\n  ")}`);
}

if (!apply) process.exit(0);

if (capability) {
  setJsoncVar(path.join(workerDir("model-gateway"), "wrangler.jsonc"), "CAPABILITY_JWKS", capability.jwks);
  setJsoncVar(path.join(workerDir("cloud-builder"), "wrangler.jsonc"), "CAPABILITY_SIGNING_KID", capability.kid);
}
for (const [worker, { set }] of Object.entries(plan)) {
  if (Object.keys(set).length === 0) continue;
  bulkPut(worker, set);
  console.log(`✓ ${worker}: ${Object.keys(set).length} secret(s) set`);
}
const admin = plan["cloud-builder"].set.STELLA_ADMIN_API_SECRET;
if (admin) console.log(`✓ STELLA_ADMIN_API_SECRET saved to ${saveAdminSecret(admin)}`);
if (capability) {
  console.log("\nCommit the wrangler.jsonc changes, then deploy model-gateway and cloud-builder (SELF_HOSTING.md 1.5).");
}
