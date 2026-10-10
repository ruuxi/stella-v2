/**
 * Operator routes, authenticated with `STELLA_ADMIN_API_SECRET` as a bearer:
 *
 *   GET  /api/admin/owners/lookup?ownerId=      snapshot identity, enforcement, billing and risk row
 *   GET  /api/admin/owners/top?limit=&status=   D1 `owner_risk` by score
 *   GET  /api/admin/owners/storage?ownerId=     the owner's drive usage and world store usage
 *   POST /api/admin/owners/enforcement          {ownerId, status, reason, until?} via the gate's setOwnerEnforcement
 *   POST /api/admin/billing/plan                {ownerId, plan?, usageMode? | unlimited?, resetUsage?}
 *   POST /api/admin/delete                      {kind: "feedback", id} | {kind: "media_job", ownerId, id}
 *   POST /api/admin/test-accounts/session       {email?, plan?, usageMode?} → a signed-in test user (dev only)
 *
 * Owners are addressed by id only.
 */

import { OWNER_ENFORCEMENT_STATUSES, type OwnerEnforcementStatus } from "@stella/contracts/gateway/usage";
import { rpcErrorStatus, type RpcResponse } from "@stella/contracts/backend/protocol";
import { bearerCredential } from "../../../shared/bearer.js";
import { fail, json } from "../http/response.js";
import { fixedWorkSha256SecretEqual } from "../service-bearer.js";

type AdminEnv = Pick<Cloudflare.Env, "OWNER_GATES" | "DB" | "WORLDS">;

const OWNER_ID_MAX = 512;
const TOP_DEFAULT_LIMIT = 50;
const TOP_MAX_LIMIT = 200;

const failRpc = (response: Extract<RpcResponse, { ok: false }>): Response =>
  fail(rpcErrorStatus(response.error.code), response.error.message, {
    code: response.error.code,
    ...(response.error.reason ? { reason: response.error.reason } : {}),
  });

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const readBody = async (request: Request): Promise<Record<string, unknown> | null> => {
  const body = (await request.json().catch(() => null)) as unknown;
  return isRecord(body) ? body : null;
};

const ownerIdOf = (value: unknown): string | null => {
  const ownerId = typeof value === "string" ? value.trim() : "";
  return ownerId && ownerId.length <= OWNER_ID_MAX ? ownerId : null;
};

/** The bearer against the secret, with the same work whatever was sent. */
const authorized = async (request: Request, env: AdminEnv): Promise<Response | null> => {
  const raw = (env as unknown as Record<string, unknown>).STELLA_ADMIN_API_SECRET;
  const expected = typeof raw === "string" ? raw.trim() : "";
  if (!expected) return fail(503, "Admin API disabled.", { env: "STELLA_ADMIN_API_SECRET" });
  const provided = bearerCredential(request.headers.get("authorization")) ?? "";
  return (await fixedWorkSha256SecretEqual(provided, expected)) ? null : fail(401, "Invalid admin credentials.");
};

/**
 * The owner's object and its current snapshot. A snapshot that cannot be
 * read (an unknown or purged owner) answers 404 with why.
 */
const ownerGate = async (env: AdminEnv, ownerId: string) => {
  const gate = env.OWNER_GATES.getByName(ownerId);
  try {
    return { gate, snapshot: await gate.snapshot() };
  } catch (error) {
    return { response: fail(404, "Owner not found or unavailable.", { ownerId, detail: message(error) }) };
  }
};

const ownerInternal = async (
  env: AdminEnv,
  ownerId: string,
  name: string,
  args: unknown,
): Promise<Response | RpcResponse> => {
  const owner = await ownerGate(env, ownerId);
  if (owner.response) return owner.response;
  return await owner.gate.ownerInternal({ name, args, ownerGeneration: owner.snapshot.ownerGeneration });
};

const db = (env: AdminEnv): D1Database => {
  if (!env.DB) throw new Error("D1 is not bound.");
  return env.DB;
};

// ── Owners ───────────────────────────────────────────────────────────────

const lookup = async (url: URL, env: AdminEnv): Promise<Response> => {
  const ownerId = ownerIdOf(url.searchParams.get("ownerId"));
  if (!ownerId) return fail(400, "Missing ownerId.");
  const owner = await ownerGate(env, ownerId);
  if (owner.response) return owner.response;
  const { snapshot } = owner;
  const [billing, risk] = await Promise.all([
    owner.gate.billingAccess(),
    db(env)
      .prepare("SELECT score, status, updated_at AS updatedAt FROM owner_risk WHERE owner_id = ?")
      .bind(ownerId)
      .first(),
  ]);
  return json({
    ownerId,
    isAnonymous: snapshot.isAnonymous,
    identityLevel: snapshot.identityLevel,
    plan: billing.plan,
    enforcement: snapshot.enforcement ?? { status: "ok" },
    billing,
    risk: risk ?? null,
  });
};

/**
 * Where an owner's files are stored and against which quota: the drive (rows
 * and bytes in R2) and the world store, which never holds the drive and
 * reports anything it still lists under `drive/` separately.
 */
const storage = async (url: URL, env: AdminEnv): Promise<Response> => {
  const ownerId = ownerIdOf(url.searchParams.get("ownerId"));
  if (!ownerId) return fail(400, "Missing ownerId.");
  const drive = await ownerInternal(env, ownerId, "drive.usage", {});
  if (drive instanceof Response) return drive;
  if (!drive.ok) return failRpc(drive);
  const { worldName } = await import("../workspace.js");
  const world = await env.WORLDS.getByName(await worldName(ownerId)).usage();
  return json({ ownerId, drive: drive.value, world });
};

const top = async (url: URL, env: AdminEnv): Promise<Response> => {
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? TOP_DEFAULT_LIMIT : Number(rawLimit);
  if (!Number.isInteger(limit) || limit < 1 || limit > TOP_MAX_LIMIT) {
    return fail(400, `limit must be 1 to ${TOP_MAX_LIMIT}.`);
  }
  const status = url.searchParams.get("status")?.trim().toLowerCase() || null;
  if (status && !OWNER_ENFORCEMENT_STATUSES.includes(status as OwnerEnforcementStatus)) {
    return fail(400, "Invalid enforcement status.");
  }
  const query = status
    ? db(env)
        .prepare(
          `SELECT owner_id AS ownerId, score, status, updated_at AS updatedAt FROM owner_risk
           WHERE status = ? ORDER BY score DESC LIMIT ?`,
        )
        .bind(status, limit)
    : db(env)
        .prepare(
          `SELECT owner_id AS ownerId, score, status, updated_at AS updatedAt FROM owner_risk
           ORDER BY score DESC LIMIT ?`,
        )
        .bind(limit);
  const { results } = await query.all();
  return json({ owners: results });
};

const enforcement = async (request: Request, env: AdminEnv): Promise<Response> => {
  const body = await readBody(request);
  const ownerId = ownerIdOf(body?.ownerId);
  if (!ownerId) return fail(400, "Missing ownerId.");
  const status = typeof body?.status === "string" ? body.status.trim().toLowerCase() : "";
  if (!OWNER_ENFORCEMENT_STATUSES.includes(status as OwnerEnforcementStatus)) {
    return fail(400, "Invalid enforcement status.");
  }
  const reason = typeof body?.reason === "string" ? body.reason.trim() : "";
  if (!reason || reason.length > 1_000) return fail(400, "reason must be 1 to 1,000 characters.");
  const until = body?.until;
  if (until !== undefined && (typeof until !== "number" || !Number.isFinite(until))) {
    return fail(400, "until must be a timestamp.");
  }
  const state = await env.OWNER_GATES.getByName(ownerId).setOwnerEnforcement({
    status: status as OwnerEnforcementStatus,
    reason,
    actor: "admin",
    ...(typeof until === "number" ? { until } : {}),
  });
  console.log(JSON.stringify({ event: "admin_owner_enforcement", ownerId, status }));
  return json({ ownerId, enforcement: state });
};

// ── Billing ──────────────────────────────────────────────────────────────

const billingPlan = async (request: Request, env: AdminEnv): Promise<Response> => {
  const body = await readBody(request);
  const ownerId = ownerIdOf(body?.ownerId);
  if (!ownerId) return fail(400, "Missing ownerId.");
  const plan = typeof body?.plan === "string" ? body.plan.trim().toLowerCase() : "";
  if (plan && plan !== "free" && plan !== "go" && plan !== "pro") return fail(400, `Unsupported plan: ${plan}`);
  const rawUsageMode = typeof body?.usageMode === "string" ? body.usageMode.trim().toLowerCase() : "";
  const usageMode =
    typeof body?.unlimited === "boolean" ? (body.unlimited ? "unlimited" : "default") : rawUsageMode;
  if (usageMode && usageMode !== "default" && usageMode !== "unlimited") {
    return fail(400, `Unsupported usageMode: ${usageMode}`);
  }
  if (body?.resetUsage !== undefined && typeof body.resetUsage !== "boolean") {
    return fail(400, "resetUsage must be a boolean.");
  }
  const owner = await ownerGate(env, ownerId);
  if (owner.response) return owner.response;
  await owner.gate.setBillingPlan({
    ...(plan ? { plan: plan as "free" | "go" | "pro" } : {}),
    ...(usageMode ? { usageMode: usageMode as "default" | "unlimited" } : {}),
    ...(typeof body?.resetUsage === "boolean" ? { resetUsage: body.resetUsage } : {}),
  });
  console.log(JSON.stringify({ event: "admin_billing_plan", ownerId, plan: plan || null, usageMode: usageMode || null }));
  return json(await owner.gate.billingAccess());
};

// ── Deletes ──────────────────────────────────────────────────────────────

const remove = async (request: Request, env: AdminEnv): Promise<Response> => {
  const body = await readBody(request);
  const kind = typeof body?.kind === "string" ? body.kind.trim() : "";
  const id = typeof body?.id === "string" ? body.id.trim() : "";
  if (!kind || !id) return fail(400, "Missing kind or id.");
  switch (kind) {
    case "feedback": {
      const result = await db(env).prepare("DELETE FROM feedback WHERE id = ?").bind(id).run();
      return json({ deleted: (result.meta.changes ?? 0) > 0, kind, id });
    }
    case "media_job": {
      const ownerId = ownerIdOf(body?.ownerId);
      if (!ownerId) return fail(400, "media_job deletes need the job's ownerId.");
      const response = await ownerInternal(env, ownerId, "media.deleteJob", { jobId: id });
      if (response instanceof Response) return response;
      return response.ok ? json(response.value) : failRpc(response);
    }
    default:
      return fail(400, `Unsupported delete kind: ${kind}`);
  }
};

// ── Test accounts ────────────────────────────────────────────────────────

const TEST_ACCOUNT_SUFFIX = "@test.stella.local";

/**
 * A signed-in `@test.stella.local` user for agents and harnesses, through the
 * same magic-link verification a real sign-in takes. Dev deployments only
 * (`STELLA_TEST_ACCOUNTS=1`). The plan is set on the owner's object, which
 * this request places near the tester.
 */
const testAccountSession = async (request: Request, env: AdminEnv): Promise<Response> => {
  const { backendUrl, createAuth, testAccountsEnabled } = await import("../auth/auth.js");
  if (!testAccountsEnabled(env)) return fail(404, "Test accounts disabled.", { env: "STELLA_TEST_ACCOUNTS" });
  const body = await readBody(request);
  if (!body) return fail(400, "Body must be a JSON object.");
  if (body.email !== undefined && typeof body.email !== "string") return fail(400, "email must be a string.");
  const email =
    typeof body.email === "string"
      ? body.email.trim().toLowerCase()
      : `agent-${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}${TEST_ACCOUNT_SUFFIX}`;
  if (!email.endsWith(TEST_ACCOUNT_SUFFIX)) return fail(400, `email must end with ${TEST_ACCOUNT_SUFFIX}.`);
  const plan = typeof body.plan === "string" ? body.plan.trim().toLowerCase() : "";
  if (body.plan !== undefined && plan !== "free" && plan !== "go" && plan !== "pro") {
    return fail(400, "plan must be free, go, or pro.");
  }
  const usageMode = typeof body.usageMode === "string" ? body.usageMode.trim().toLowerCase() : "";
  if (body.usageMode !== undefined && usageMode !== "default" && usageMode !== "unlimited") {
    return fail(400, "usageMode must be default or unlimited.");
  }

  const fullEnv = env as unknown as Cloudflare.Env;
  const auth = createAuth(fullEnv);
  const context = await auth.$context;
  const token = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
    "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".charAt(byte % 52),
  ).join("");
  // Better Auth 1.7's magic-link record: a `magic-link:`-prefixed identifier
  // (tokens are stored plain) and a typed value.
  await context.internalAdapter.createVerificationValue({
    identifier: `magic-link:${token}`,
    value: JSON.stringify({ type: "magic-link", email, name: "" }),
    expiresAt: new Date(Date.now() + 5 * 60_000),
  });
  const verified = await auth.api.magicLinkVerify({ query: { token }, headers: new Headers(), returnHeaders: true });
  const sessionToken = verified.headers.get("set-auth-token")?.trim() ?? "";
  const userId = (verified.response as { user?: { id?: unknown } } | null)?.user?.id;
  if (!sessionToken || typeof userId !== "string" || !userId) {
    return fail(500, "Better Auth did not return a test account session.");
  }
  const sessionHeaders = new Headers({ authorization: `Bearer ${sessionToken}` });
  const minted = await auth.api.getToken({ headers: sessionHeaders });
  const oneTimeToken = await auth.api.generateOneTimeToken({ headers: sessionHeaders });

  const ownerId = userId;
  if (plan) {
    await env.OWNER_GATES.getByName(ownerId).setBillingPlan({
      plan: plan as "free" | "go" | "pro",
      ...(usageMode ? { usageMode: usageMode as "default" | "unlimited" } : {}),
    });
  }
  console.log(JSON.stringify({ event: "admin_test_account_session", ownerId, plan: plan || "free" }));
  return json({
    ownerId,
    userId,
    email,
    sessionToken,
    token: minted.token,
    oneTimeToken: oneTimeToken.token,
    plan: plan || "free",
    siteUrl: backendUrl(fullEnv),
  });
};

/**
 * Dev test accounts only: drive the cloud Claude Code login backup with a
 * FAKE login in a fixed probe account, to prove it survives a container
 * replacement. Never touches a real account's directory.
 */
const claudeLoginProbeRoute = async (request: Request, env: AdminEnv): Promise<Response> => {
  const { testAccountsEnabled } = await import("../auth/auth.js");
  if (!testAccountsEnabled(env)) return fail(404, "Test accounts disabled.", { env: "STELLA_TEST_ACCOUNTS" });
  const body = await readBody(request);
  const ownerId = ownerIdOf(body?.ownerId);
  const action = body?.action;
  if (
    !ownerId ||
    (action !== "plant" && action !== "inspect" && action !== "backup" && action !== "restore" && action !== "replace")
  ) {
    return fail(400, "Need ownerId and action plant|inspect|backup|restore|replace.");
  }
  const { claudeLoginProbe } = await import("../claude-cloud-login.js");
  return json(await claudeLoginProbe(env as unknown as Cloudflare.Env, ownerId, action));
};

// ── Routing ──────────────────────────────────────────────────────────────

const ROUTES: Record<string, { method: "GET" | "POST"; run: (request: Request, url: URL, env: AdminEnv) => Promise<Response> }> = {
  "/api/admin/owners/lookup": { method: "GET", run: (_request, url, env) => lookup(url, env) },
  "/api/admin/owners/top": { method: "GET", run: (_request, url, env) => top(url, env) },
  "/api/admin/owners/storage": { method: "GET", run: (_request, url, env) => storage(url, env) },
  "/api/admin/owners/enforcement": { method: "POST", run: (request, _url, env) => enforcement(request, env) },
  "/api/admin/billing/plan": { method: "POST", run: (request, _url, env) => billingPlan(request, env) },
  "/api/admin/delete": { method: "POST", run: (request, _url, env) => remove(request, env) },
  "/api/admin/test-accounts/session": { method: "POST", run: (request, _url, env) => testAccountSession(request, env) },
  "/api/admin/test-accounts/claude-login-probe": {
    method: "POST",
    run: (request, _url, env) => claudeLoginProbeRoute(request, env),
  },
};

/** Admin routes, or null when the request is not one. */
export const handleAdminRoute = async (request: Request, env: AdminEnv): Promise<Response | null> => {
  const url = new URL(request.url);
  const route = ROUTES[url.pathname];
  if (!route) return null;
  if (request.method !== route.method) return fail(405, "Method not allowed.");
  const denied = await authorized(request, env);
  if (denied) return denied;
  try {
    return await route.run(request, url, env);
  } catch (error) {
    console.error(JSON.stringify({ event: "admin_route_failed", path: url.pathname, message: message(error) }));
    return fail(500, "Admin request failed.", { detail: message(error) });
  }
};
