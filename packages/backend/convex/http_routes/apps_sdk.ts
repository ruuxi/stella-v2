import { makeFunctionReference, type HttpRouter } from "convex/server";
import { httpAction } from "../_generated/server";
import { ConvexError } from "convex/values";
import { getCorsHeaders } from "../http_shared/cors";
import {
  getUserIdentityOrNullAction,
  isAnonymousIdentity,
} from "../auth";
import { assertOwnerDataAccessActive } from "../owner_lifecycle";
import { constantTimeEqual, hashSha256Hex } from "../lib/crypto_utils";
import {
  APP_FETCH_CAPABILITY_TTL_MS,
  APP_SESSION_TTL_MS,
  hashAppViewerNamespace,
  mintAnonymousViewerToken,
  signAppFetchCapability,
  signAppSessionToken,
  verifyAnonymousViewerToken,
  verifyAppSessionToken,
  type AppSessionToken,
} from "../lib/app_session_tokens";

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

const verifyToken = async (request: Request): Promise<AppSessionToken> => {
  const raw = request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!raw) throw new ConvexError("Missing app session.");
  return verifyAppSessionToken({
    token: raw,
    origin: request.headers.get("origin"),
    now: Date.now(),
  });
};

const serviceAuthorized = (request: Request): boolean => {
  const expected = process.env.BUILDER_SERVICE_SECRET?.trim() ?? "";
  const provided =
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "").trim() ??
    "";
  return Boolean(expected && provided && constantTimeEqual(provided, expected));
};

const requireExactOrigin = (value: unknown): string => {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new ConvexError("App origin is required.");
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new ConvexError("App origin is invalid.");
  }
  const localHttp =
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1");
  if (
    (parsed.protocol !== "https:" && !localHttp) ||
    parsed.origin !== value ||
    parsed.username ||
    parsed.password
  ) {
    throw new ConvexError("App origin is invalid.");
  }
  return value;
};

const canonicalFetchRequest = (input: unknown, init: unknown) => {
  if (typeof input !== "string" || input.length < 1 || input.length > 2_048) {
    throw new ConvexError("A bounded target URL is required.");
  }
  let target: URL;
  try {
    target = new URL(input);
  } catch {
    throw new ConvexError("A valid target URL is required.");
  }
  if (
    target.protocol !== "https:" ||
    target.username ||
    target.password
  ) {
    throw new ConvexError("Only public HTTPS targets are allowed.");
  }
  target.hash = "";
  const options =
    init && typeof init === "object" && !Array.isArray(init)
      ? (init as Record<string, unknown>)
      : {};
  const method =
    typeof options.method === "string" && options.method.trim()
      ? options.method.trim().toUpperCase()
      : "GET";
  if (!new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]).has(method)) {
    throw new ConvexError("That HTTP method is not allowed.");
  }
  const headers = new Headers(
    options.headers === undefined ? undefined : (options.headers as HeadersInit),
  );
  const allowedHeaders: Record<string, string> = {};
  for (const name of [
    "accept",
    "content-type",
    "if-none-match",
    "if-modified-since",
  ]) {
    const value = headers.get(name);
    if (value) allowedHeaders[name] = value;
  }
  const body = typeof options.body === "string" ? options.body : null;
  return {
    input: target.toString(),
    method,
    targetOrigin: target.origin,
    requestDocument: JSON.stringify({
      input: target.toString(),
      method,
      headers: allowedHeaders,
      body,
    }),
  };
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
    "/api/apps/fetch-capability",
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
      if (!identity) {
        throw new ConvexError(
          "Anonymous app sessions must start through the Apps host.",
        );
      }
      const userId = identity.tokenIdentifier;
      const anonymous = isAnonymousIdentity(identity);
      const username =
        typeof identity.name === "string" && identity.name.trim()
          ? identity.name.trim().slice(0, 256)
          : "Stella user";
      const { generation: ownerGeneration } = await assertOwnerDataAccessActive(
        ctx,
        app.ownerId,
      );
      const now = Date.now();
      const viewerNamespace = await hashAppViewerNamespace({
        appId: app.appId,
        viewerIdentity: `account:${userId}`,
      });
      const payload: Omit<
        AppSessionToken,
        "version" | "audience" | "issuer" | "tokenId"
      > = {
        appId: app.appId,
        ownerId: app.ownerId,
        ownerGeneration,
        viewerNamespace,
        role: anonymous
          ? "anonymous"
          : userId === app.ownerId
            ? "owner"
            : "viewer",
        userId,
        username,
        anonymous,
        origin,
        issuedAt: now,
        exp: now + APP_SESSION_TTL_MS,
      };
      return {
        token: await signAppSessionToken(payload),
        viewerNamespace,
        user: { userId: anonymous ? null : viewerNamespace, username, anonymous },
        expiresAt: payload.exp,
      };
    }),
  });

  http.route({
    path: "/api/apps/session/anonymous",
    method: "POST",
    handler: handle(async (ctx, request) => {
      if (!serviceAuthorized(request)) {
        throw new ConvexError("App session service authorization failed.");
      }
      const body = (await request.json()) as {
        appId?: string;
        origin?: string;
        viewerToken?: string;
      };
      if (!body.appId) throw new ConvexError("appId is required.");
      const origin = requireExactOrigin(body.origin);
      const app = await ctx.runQuery(getAppRef, { appId: body.appId });
      if (!app || app.status !== "active") {
        throw new ConvexError("App is unavailable.");
      }
      const now = Date.now();
      let viewer: { viewerId: string; exp: number } | null = null;
      if (typeof body.viewerToken === "string" && body.viewerToken) {
        viewer = await verifyAnonymousViewerToken({
          token: body.viewerToken,
          origin,
          now,
        });
      }
      const mintedViewer =
        !viewer || viewer.exp <= now + 7 * 24 * 60 * 60_000
          ? await mintAnonymousViewerToken({
              origin,
              now,
              ...(viewer ? { viewerId: viewer.viewerId } : {}),
            })
          : null;
      const viewerId = viewer?.viewerId ?? mintedViewer!.viewerId;
      const viewerNamespace = await hashAppViewerNamespace({
        appId: app.appId,
        viewerIdentity: `anonymous:${viewerId}`,
      });
      const { generation: ownerGeneration } = await assertOwnerDataAccessActive(
        ctx,
        app.ownerId,
      );
      const session = {
        appId: app.appId,
        ownerId: app.ownerId,
        ownerGeneration,
        viewerNamespace,
        role: "anonymous",
        userId: `anonymous:${viewerNamespace}`,
        username: "Guest",
        anonymous: true,
        origin,
        issuedAt: now,
        exp: now + APP_SESSION_TTL_MS,
      } satisfies Omit<
        AppSessionToken,
        "version" | "audience" | "issuer" | "tokenId"
      >;
      return {
        token: await signAppSessionToken(session),
        viewerNamespace,
        user: { userId: null, username: "Guest", anonymous: true },
        expiresAt: session.exp,
        viewerToken: mintedViewer?.token ?? body.viewerToken,
        viewerTokenExpiresAt: mintedViewer?.exp ?? viewer!.exp,
      };
    }),
  });

  http.route({
    path: "/api/apps/fetch-capability",
    method: "POST",
    handler: handle(async (_ctx, request) => {
      const session = await verifyToken(request);
      const body = (await request.json()) as {
        input?: unknown;
        init?: unknown;
      };
      const canonical = canonicalFetchRequest(body.input, body.init);
      const now = Date.now();
      const capability = await signAppFetchCapability({
        appId: session.appId,
        viewerNamespace: session.viewerNamespace,
        origin: session.origin,
        method: canonical.method,
        targetOrigin: canonical.targetOrigin,
        targetUrl: canonical.input,
        requestHash: await hashSha256Hex(canonical.requestDocument),
        issuedAt: now,
        exp: now + APP_FETCH_CAPABILITY_TTL_MS,
      });
      return {
        capability: capability.token,
        expiresAt: capability.expiresAt,
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
        viewerNamespace: token.viewerNamespace,
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
        viewerNamespace: token.viewerNamespace,
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
        viewerNamespace: token.viewerNamespace,
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
      if (token.role !== "owner") {
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
      if (token.role !== "owner") {
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
      if (token.role !== "owner") {
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
        viewerNamespace: token.viewerNamespace,
        key,
      });
      return { ok: true };
    }),
  });
}
