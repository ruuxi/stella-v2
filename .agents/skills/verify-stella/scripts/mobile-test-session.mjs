#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_ACCOUNT_SUFFIX = "@test.stella.local";
const DEV_BACKEND_URL = "https://stella-v2-cloud-builder-dev.lolruuxi.workers.dev";
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

const fail = (message) => {
  process.stderr.write(`${message}\n`);
  process.exit(2);
};

const readDevVar = (name) => {
  const envPath = path.join(repoRoot, "workers/cloud-builder/.dev.vars");
  if (!existsSync(envPath)) return "";
  const line = readFileSync(envPath, "utf8")
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(`${name}=`));
  return line ? line.slice(name.length + 1).split(" #")[0].trim().replace(/^"(.*)"$/, "$1") : "";
};

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const plan = (option("--plan") ?? "pro").toLowerCase();
if (!["free", "go", "pro"].includes(plan)) fail("--plan must be free, go, or pro.");
const email = (option("--email") ?? process.env.STELLA_VERIFY_ACCOUNT_EMAIL ?? "").trim().toLowerCase();
if (email && !email.endsWith(TEST_ACCOUNT_SUFFIX)) fail(`--email must end with ${TEST_ACCOUNT_SUFFIX}.`);

const backendUrl = (process.env.STELLA_BACKEND_URL?.trim() || DEV_BACKEND_URL).replace(/\/+$/, "");
const secret = process.env.STELLA_ADMIN_API_SECRET?.trim() || readDevVar("STELLA_ADMIN_API_SECRET");
if (!secret) {
  fail("STELLA_ADMIN_API_SECRET is unavailable. Export it or set it in workers/cloud-builder/.dev.vars.");
}

const body = { plan, ...(plan === "free" ? {} : { usageMode: "unlimited" }), ...(email ? { email } : {}) };
let response;
try {
  response = await fetch(`${backendUrl}/api/admin/test-accounts/session`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
} catch (error) {
  fail(`Test account request failed: ${error instanceof Error ? error.message : String(error)}`);
}
const text = await response.text();
let payload = null;
try {
  payload = JSON.parse(text);
} catch {
  payload = null;
}
if (!response.ok) {
  fail(
    response.status === 404
      ? `HTTP 404 from ${backendUrl}: test accounts are disabled there (only the dev backend sets STELLA_TEST_ACCOUNTS=1).`
      : `Test account mint returned HTTP ${response.status}: ${payload?.error ?? text.slice(0, 200)}`,
  );
}
if (typeof payload?.oneTimeToken !== "string" || !payload.oneTimeToken) {
  fail(`The backend at ${backendUrl} returned no oneTimeToken; deploy the current cloud-builder to it.`);
}

process.stdout.write(
  `${JSON.stringify({
    email: payload.email,
    ownerId: payload.ownerId,
    plan: payload.plan,
    url: `stella-mobile://dev-test-session?ott=${encodeURIComponent(payload.oneTimeToken)}`,
  })}\n`,
);
