import { makeFunctionReference, type HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { ConvexError } from "convex/values";
import { getCorsHeaders } from "../http_shared/cors";
import { getUserIdentityOrNullAction } from "../auth";
import { assertOwnerDataAccessActive } from "../owner_lifecycle";

type AppToken = {
  appId: string;
  ownerId: string;
  ownerGeneration: string;
  userId: string;
  username: string;
  anonymous: boolean;
  origin: string;
  exp: number;
};

const getAppRef = makeFunctionReference<"query", { appId: string }, any>(
  "cloud_apps:getAppInternal",
);
const getStorageRef = makeFunctionReference<"query", any, any>(
  "cloud_apps:getStorageInternal",
);
const listStorageRef = makeFunctionReference<"query", any, any>(
  "cloud_apps:listStorageInternal",
);
const setStorageRef = makeFunctionReference<"mutation", any, any>(
  "cloud_apps:setStorageInternal",
);
const deleteStorageRef = makeFunctionReference<"mutation", any, any>(
  "cloud_apps:deleteStorageInternal",
);
const upsertOpsManifestRef = makeFunctionReference<"mutation", any, any>(
  "cloud_apps:upsertOperationsManifestInternal",
);
const claimOpInvocationsRef = makeFunctionReference<"mutation", any, any>(
  "cloud_apps:claimOpInvocationsInternal",
);
const completeOpInvocationRef = makeFunctionReference<"mutation", any, any>(
  "cloud_apps:completeOpInvocationInternal",
);

const encoder = new TextEncoder();
const base64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
const fromBase64url = (value: string): Uint8Array =>
  Uint8Array.from(
    atob(value.replaceAll("-", "+").replaceAll("_", "/")),
    (char) => char.charCodeAt(0),
  );

const signingKey = async (): Promise<CryptoKey> => {
  const secret = process.env.APP_TOKEN_SIGNING_KEY?.trim();
  if (!secret) throw new Error("App token signing is not configured.");
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
};

const signToken = async (payload: AppToken): Promise<string> => {
  const body = base64url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign(
    "HMAC",
    await signingKey(),
    encoder.encode(body),
  );
  return `${body}.${base64url(new Uint8Array(signature))}`;
};

const verifyToken = async (request: Request): Promise<AppToken> => {
  const raw = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!raw) throw new ConvexError("Missing app session.");
  const [body, signature] = raw.split(".");
  if (!body || !signature) throw new ConvexError("Invalid app session.");
  const valid = await crypto.subtle.verify(
    "HMAC",
    await signingKey(),
    fromBase64url(signature) as unknown as BufferSource,
    encoder.encode(body),
  );
  if (!valid) throw new ConvexError("Invalid app session.");
  const payload = JSON.parse(
    new TextDecoder().decode(fromBase64url(body)),
  ) as AppToken;
  if (
    !payload ||
    typeof payload.appId !== "string" ||
    typeof payload.ownerId !== "string" ||
    typeof payload.ownerGeneration !== "string" ||
    !payload.ownerGeneration.trim() ||
    typeof payload.userId !== "string" ||
    typeof payload.origin !== "string" ||
    typeof payload.exp !== "number"
  ) {
    throw new ConvexError("Invalid app session.");
  }
  if (payload.exp < Date.now())
    throw new ConvexError("App session expired. Reload the app.");
  if (request.headers.get("origin") !== payload.origin) {
    throw new ConvexError("App origin does not match the session.");
  }
  return payload;
};

const response = (request: Request, body: unknown, status = 200) => {
  const headers = new Headers({
    "content-type": "application/json",
    "cache-control": "no-store",
    ...getCorsHeaders(request.headers.get("origin")),
  });
  return new Response(JSON.stringify(body), { status, headers });
};

const handle = (fn: (ctx: any, request: Request) => Promise<unknown>) =>
  httpAction(async (ctx, request) => {
    try {
      return response(request, await fn(ctx, request));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return response(request, { error: message }, 400);
    }
  });

export function registerAppsSdkRoutes(http: HttpRouter) {
  const paths = [
    "/api/apps/session",
    "/api/apps/storage/get",
    "/api/apps/storage/list",
    "/api/apps/storage/set",
    "/api/apps/storage/delete",
    "/api/apps/operations/describe",
    "/api/apps/operations/poll",
    "/api/apps/operations/result",
  ] as const;
  for (const path of paths) {
    http.route({
      path,
      method: "OPTIONS",
      handler: httpAction(
        async (_ctx, request) =>
          new Response(null, {
            status: 204,
            headers: getCorsHeaders(request.headers.get("origin")),
          }),
      ),
    });
  }

  http.route({
    path: "/api/apps/session",
    method: "POST",
    handler: handle(async (ctx, request) => {
      const origin = request.headers.get("origin");
      if (!origin) throw new ConvexError("App origin is required.");
      const body = (await request.json()) as { appId?: string };
      if (!body.appId) throw new ConvexError("appId is required.");
      const app = await ctx.runQuery(getAppRef, { appId: body.appId });
      if (!app || app.status !== "active")
        throw new ConvexError("App is unavailable.");
      const identity = await getUserIdentityOrNullAction(ctx);
      const anonymous = !identity;
      const userId =
        identity?.tokenIdentifier ?? `anonymous:${crypto.randomUUID()}`;
      const username = identity?.name ?? "Guest";
      const { generation: ownerGeneration } = await assertOwnerDataAccessActive(
        ctx,
        app.ownerId,
      );
      const payload: AppToken = {
        appId: app.appId,
        ownerId: app.ownerId,
        ownerGeneration,
        userId,
        username,
        anonymous,
        origin,
        exp: Date.now() + 15 * 60_000,
      };
      return {
        token: await signToken(payload),
        user: { userId: anonymous ? null : userId, username, anonymous },
        expiresAt: payload.exp,
      };
    }),
  });

  http.route({
    path: "/api/apps/storage/get",
    method: "POST",
    handler: handle(async (ctx, request) => {
      const token = await verifyToken(request);
      const { key } = (await request.json()) as { key: string };
      const row = await ctx.runQuery(getStorageRef, {
        appId: token.appId,
        ownerId: token.ownerId,
        ownerGeneration: token.ownerGeneration,
        userId: token.userId,
        key,
      });
      return { value: row ? JSON.parse(row.valueJson) : null };
    }),
  });
  http.route({
    path: "/api/apps/storage/list",
    method: "POST",
    handler: handle(async (ctx, request) => {
      const token = await verifyToken(request);
      const rows = await ctx.runQuery(listStorageRef, {
        appId: token.appId,
        ownerId: token.ownerId,
        ownerGeneration: token.ownerGeneration,
        userId: token.userId,
      });
      return {
        entries: rows.slice(0, 100).map((row: any) => ({
          key: row.key,
          value: JSON.parse(row.valueJson),
        })),
      };
    }),
  });
  http.route({
    path: "/api/apps/storage/set",
    method: "POST",
    handler: handle(async (ctx, request) => {
      const token = await verifyToken(request);
      const { key, value } = (await request.json()) as {
        key: string;
        value: unknown;
      };
      const valueJson = JSON.stringify(value);
      await ctx.runMutation(setStorageRef, {
        appId: token.appId,
        ownerId: token.ownerId,
        ownerGeneration: token.ownerGeneration,
        userId: token.userId,
        key,
        valueJson,
        sizeBytes: encoder.encode(valueJson).byteLength,
        now: Date.now(),
      });
      return { ok: true };
    }),
  });
  // Operations layer: manifests are accepted only from owner sessions, and
  // only owner sessions may claim or complete invocations. Anonymous app
  // sessions receive an eligibility flag so the SDK never polls for them.
  http.route({
    path: "/api/apps/operations/describe",
    method: "POST",
    handler: handle(async (ctx, request) => {
      const token = await verifyToken(request);
      if (token.anonymous || token.userId !== token.ownerId) {
        return { ok: false, eligible: false };
      }
      const { operations } = (await request.json()) as { operations: unknown };
      const result = await ctx.runMutation(upsertOpsManifestRef, {
        appId: token.appId,
        ownerId: token.ownerId,
        ownerGeneration: token.ownerGeneration,
        userId: token.userId,
        manifestJson: JSON.stringify(operations ?? []),
        now: Date.now(),
      });
      return { ok: true, eligible: true, ...result };
    }),
  });
  http.route({
    path: "/api/apps/operations/poll",
    method: "POST",
    handler: handle(async (ctx, request) => {
      const token = await verifyToken(request);
      if (token.anonymous || token.userId !== token.ownerId) {
        return { eligible: false, invocations: [] };
      }
      const invocations = await ctx.runMutation(claimOpInvocationsRef, {
        appId: token.appId,
        ownerId: token.ownerId,
        ownerGeneration: token.ownerGeneration,
        userId: token.userId,
      });
      return { eligible: true, invocations };
    }),
  });
  http.route({
    path: "/api/apps/operations/result",
    method: "POST",
    handler: handle(async (ctx, request) => {
      const token = await verifyToken(request);
      if (token.anonymous || token.userId !== token.ownerId) {
        throw new ConvexError("Only the app owner can report results.");
      }
      const body = (await request.json()) as {
        invocationId: string;
        ok: boolean;
        resultJson?: string;
        errorMessage?: string;
      };
      await ctx.runMutation(completeOpInvocationRef, {
        appId: token.appId,
        ownerId: token.ownerId,
        ownerGeneration: token.ownerGeneration,
        invocationId: body.invocationId,
        userId: token.userId,
        ok: body.ok === true,
        resultJson: body.resultJson,
        errorMessage: body.errorMessage,
      });
      return { ok: true };
    }),
  });

  http.route({
    path: "/api/apps/storage/delete",
    method: "POST",
    handler: handle(async (ctx, request) => {
      const token = await verifyToken(request);
      const { key } = (await request.json()) as { key: string };
      await ctx.runMutation(deleteStorageRef, {
        appId: token.appId,
        ownerId: token.ownerId,
        ownerGeneration: token.ownerGeneration,
        userId: token.userId,
        key,
      });
      return { ok: true };
    }),
  });
}
