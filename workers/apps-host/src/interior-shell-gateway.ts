import type { AppsHostConfig } from "./config";
import { verifyInteriorBootstrap } from "./app-auth-service";
import { readBoundedBytes } from "./http-security";
import {
  issueInteriorShellSession,
  parseInteriorShellSession,
  validateInteriorConvexClientMessage,
  type InteriorRouteBuildIdentity,
  type VerifiedInteriorShellSession,
} from "./interior-shell-policy";

const ACCOUNT_SESSION_COOKIE = "__Host-stella_account_session";
const IDENTITY_INTENT_COOKIE = "__Host-stella_identity_intent";
const BETTER_AUTH_SESSION = /^[A-Za-z0-9._~+/=-]{8,4096}$/;
const STABLE_ROUTE_ID =
  /^sr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INTERIOR_BUILD_ID = /^interior-[0-9a-f]{48}$/;
const OWNER_HASH = /^[0-9a-f]{64}$/;
const DEFAULT_INTERIOR_PREFIX = /^interior\/[A-Za-z0-9._-]{1,128}$/;
const CONVERSATION_ID = /^[A-Za-z0-9._~-]{1,128}$/;
const CONVEX_SYNC_PATH = /^\/api\/[0-9]+(?:\.[0-9]+){1,3}\/sync$/;
const MAX_JSON_BYTES = 256 * 1024;
const MAX_SYNC_MESSAGE_BYTES = 1024 * 1024;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

type DisplayUser = {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
  isAnonymous: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parseCookie = (request: Request, name: string): string | null => {
  for (const item of (request.headers.get("cookie") ?? "").split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0 || item.slice(0, separator).trim() !== name) continue;
    const value = item.slice(separator + 1).trim();
    return value.length > 0 && value.length <= 8_192 ? value : null;
  }
  return null;
};

const bearerFromRequest = (request: Request): string | null => {
  const value = request.headers.get("authorization") ?? "";
  const match = value.match(/^Bearer ([A-Za-z0-9._-]{32,16384})$/);
  return match?.[1] ?? null;
};

const appendAccountCookies = (
  headers: Headers,
  bearer: string,
  intent: "anonymous" | "connected",
): void => {
  headers.append(
    "set-cookie",
    `${ACCOUNT_SESSION_COOKIE}=${bearer}; Path=/; HttpOnly; Secure; SameSite=None`,
  );
  headers.append(
    "set-cookie",
    `${IDENTITY_INTENT_COOKIE}=${intent}; Path=/; HttpOnly; Secure; SameSite=None`,
  );
};

const readJsonResponse = async (
  response: Response,
  maximum = MAX_JSON_BYTES,
): Promise<unknown> => {
  const bytes = await readBoundedBytes(response.body, maximum);
  return JSON.parse(decoder.decode(bytes));
};

const activeRouteBuild = async (
  config: AppsHostConfig,
  stableRouteId: string,
  expected?: InteriorRouteBuildIdentity,
): Promise<InteriorRouteBuildIdentity> => {
  if (!STABLE_ROUTE_ID.test(stableRouteId) || !config.builderServiceSecret) {
    throw new Error("invalid route");
  }
  const url = new URL(
    "/api/cloud/interior-active-route",
    config.convexSiteOrigin,
  );
  url.searchParams.set("stableRouteId", stableRouteId);
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${config.builderServiceSecret}` },
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("route unavailable");
  }
  const route = await readJsonResponse(response, 16 * 1024);
  if (!isRecord(route)) throw new Error("invalid route");
  if (route.mode === "default") {
    if (
      expected?.mode !== "default" ||
      !DEFAULT_INTERIOR_PREFIX.test(expected.buildId)
    ) {
      throw new Error("invalid default route");
    }
    // The Convex route authority intentionally returns only `mode: default`;
    // the exact immutable default artifact was already signed into the
    // bootstrap by the private service-binding call. Raw asset resolution is
    // live, so an old bootstrap cannot select an old object after promotion.
    return expected;
  }
  const ownerHash = typeof route.ownerHash === "string" ? route.ownerHash : "";
  const buildId = typeof route.buildId === "string" ? route.buildId : "";
  if (
    route.mode !== "custom" ||
    !OWNER_HASH.test(ownerHash) ||
    !INTERIOR_BUILD_ID.test(buildId) ||
    route.artifactPrefix !== `interiors/${ownerHash}/${buildId}`
  ) {
    throw new Error("invalid custom route");
  }
  return { mode: "custom", buildId };
};

const sameBuild = (
  left: InteriorRouteBuildIdentity,
  right: InteriorRouteBuildIdentity,
): boolean => left.mode === right.mode && left.buildId === right.buildId;

const convexQuery = async (
  config: AppsHostConfig,
  convexToken: string,
  path: string,
  args: Record<string, unknown>,
): Promise<unknown> => {
  const response = await fetch(
    new URL("/api/query", config.convexCloudOrigin),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${convexToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ path, args, format: "json" }),
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    },
  );
  const payload = await readJsonResponse(response);
  if (
    !response.ok ||
    !isRecord(payload) ||
    payload.status !== "success" ||
    !("value" in payload)
  ) {
    throw new Error("Convex query rejected");
  }
  return payload.value;
};

const assertCurrentSession = async (
  config: AppsHostConfig,
  session: VerifiedInteriorShellSession,
): Promise<void> => {
  const [routeBuild, identity] = await Promise.all([
    activeRouteBuild(
      config,
      session.claims.stableRouteId,
      session.claims.routeBuild,
    ),
    convexQuery(
      config,
      session.convexToken,
      "cloud_apps:getMyCloudConversationIdentity",
      {},
    ),
  ]);
  if (
    !sameBuild(routeBuild, session.claims.routeBuild) ||
    !isRecord(identity) ||
    identity.ownerId !== session.claims.viewerId ||
    identity.ownerGeneration !== session.claims.viewerOwnerGeneration
  ) {
    throw new Error("stale interior session");
  }
};

const parseScopedSession = async (
  config: AppsHostConfig,
  token: string,
): Promise<VerifiedInteriorShellSession> => {
  if (!config.appTokenSigningKey) throw new Error("signing unavailable");
  const session = await parseInteriorShellSession({
    token,
    appTokenSigningKey: config.appTokenSigningKey,
    expected: {
      issuer: config.deploymentIdentity,
      trustedGatewayOrigin: config.trustedAppsHostOrigin,
    },
  });
  await assertCurrentSession(config, session);
  return session;
};

const betterAuthRequest = async (
  config: AppsHostConfig,
  path: string,
  bearer: string | null,
  method: "GET" | "POST" = "GET",
): Promise<Response> =>
  fetch(new URL(path, config.convexSiteOrigin), {
    method,
    headers: {
      origin: config.trustedAppsHostOrigin,
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(method === "POST" ? { "content-type": "application/json" } : {}),
    },
    ...(method === "POST" ? { body: "{}" } : {}),
    redirect: "manual",
    signal: AbortSignal.timeout(10_000),
  });

const createAnonymousBearer = async (
  config: AppsHostConfig,
): Promise<string> => {
  const response = await betterAuthRequest(
    config,
    "/api/auth/sign-in/anonymous",
    null,
    "POST",
  );
  const bearer = (response.headers.get("set-auth-token") ?? "").trim();
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok || !BETTER_AUTH_SESSION.test(bearer)) {
    throw new Error("anonymous sign-in failed");
  }
  return bearer;
};

const readDisplaySession = async (
  config: AppsHostConfig,
  bearer: string,
): Promise<{ user: DisplayUser; rotatedBearer: string | null }> => {
  const response = await betterAuthRequest(
    config,
    "/api/auth/get-session",
    bearer,
  );
  const rotated = (response.headers.get("set-auth-token") ?? "").trim();
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error(
      response.status === 401 ? "session rejected" : "session stale",
    );
  }
  const payload = await readJsonResponse(response, 32 * 1024);
  if (!isRecord(payload) || !isRecord(payload.user)) {
    throw new Error("session rejected");
  }
  const user = payload.user;
  if (
    typeof user.id !== "string" ||
    user.id.length < 1 ||
    user.id.length > 256
  ) {
    throw new Error("invalid session");
  }
  const optional = (value: unknown, maximum: number): string | null =>
    typeof value === "string" && value.length <= maximum ? value : null;
  return {
    user: {
      id: user.id,
      email: optional(user.email, 320),
      name: optional(user.name, 512),
      image: optional(user.image, 2_048),
      isAnonymous: user.isAnonymous === true,
    },
    rotatedBearer: BETTER_AUTH_SESSION.test(rotated) ? rotated : null,
  };
};

const mintConvexToken = async (
  config: AppsHostConfig,
  bearer: string,
): Promise<{ convexToken: string; rotatedBearer: string | null }> => {
  const response = await betterAuthRequest(
    config,
    "/api/auth/convex/token",
    bearer,
  );
  const rotated = (response.headers.get("set-auth-token") ?? "").trim();
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("token rejected");
  }
  const payload = await readJsonResponse(response, 16 * 1024);
  const convexToken = isRecord(payload) ? payload.token : null;
  if (
    typeof convexToken !== "string" ||
    convexToken.length > 8_192 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(convexToken)
  ) {
    throw new Error("invalid Convex token");
  }
  return {
    convexToken,
    rotatedBearer: BETTER_AUTH_SESSION.test(rotated) ? rotated : null,
  };
};

const sessionCors = (config: AppsHostConfig): Headers =>
  new Headers({
    "access-control-allow-origin": config.appsHostOrigin,
    "access-control-allow-credentials": "true",
    vary: "Origin",
    "cache-control": "no-store",
  });

export const handleInteriorSession = async (
  request: Request,
  config: AppsHostConfig,
): Promise<Response> => {
  const headers = sessionCors(config);
  if (request.method === "OPTIONS") {
    if (request.headers.get("origin") !== config.appsHostOrigin) {
      return new Response(null, { status: 403 });
    }
    headers.set("access-control-allow-headers", "content-type");
    headers.set("access-control-allow-methods", "POST, OPTIONS");
    return new Response(null, { status: 204, headers });
  }
  if (
    request.method !== "POST" ||
    request.headers.get("origin") !== config.appsHostOrigin ||
    request.headers.get("sec-fetch-mode") !== "cors" ||
    !["same-site", "cross-site"].includes(
      request.headers.get("sec-fetch-site") ?? "",
    )
  ) {
    return Response.json({ error: "Forbidden" }, { status: 403, headers });
  }
  let bootstrapToken: string;
  try {
    const body = JSON.parse(
      decoder.decode(await readBoundedBytes(request.body, 16 * 1024)),
    );
    if (!isRecord(body) || typeof body.bootstrap !== "string")
      throw new Error();
    bootstrapToken = body.bootstrap;
  } catch {
    return Response.json(
      { error: "A valid interior bootstrap is required." },
      { status: 400, headers },
    );
  }
  let bootstrap: Awaited<ReturnType<typeof verifyInteriorBootstrap>>;
  try {
    bootstrap = await verifyInteriorBootstrap(config, {
      bootstrap: bootstrapToken,
      origin: config.appsHostOrigin,
    });
    const currentBuild = await activeRouteBuild(
      config,
      bootstrap.stableRouteId,
      bootstrap.routeBuild,
    );
    if (!sameBuild(currentBuild, bootstrap.routeBuild)) throw new Error();
  } catch {
    return Response.json(
      { error: "The interior bootstrap is invalid or stale." },
      { status: 401, headers },
    );
  }

  const persistedIntent = parseCookie(request, IDENTITY_INTENT_COOKIE);
  let intent: "anonymous" | "connected" =
    persistedIntent === "connected" ? "connected" : "anonymous";
  let bearer = parseCookie(request, ACCOUNT_SESSION_COOKIE);
  if (bearer && !BETTER_AUTH_SESSION.test(bearer)) bearer = null;
  try {
    if (!bearer) {
      if (persistedIntent === "connected") {
        return Response.json(
          { error: "Sign in again to continue." },
          { status: 401, headers },
        );
      }
      bearer = await createAnonymousBearer(config);
      intent = "anonymous";
    }
    let display: Awaited<ReturnType<typeof readDisplaySession>>;
    try {
      display = await readDisplaySession(config, bearer);
    } catch (error) {
      if (intent === "connected") throw error;
      bearer = await createAnonymousBearer(config);
      display = await readDisplaySession(config, bearer);
    }
    intent = display.user.isAnonymous ? "anonymous" : "connected";
    bearer = display.rotatedBearer ?? bearer;
    const mintedToken = await mintConvexToken(config, bearer);
    bearer = mintedToken.rotatedBearer ?? bearer;
    const identity = await convexQuery(
      config,
      mintedToken.convexToken,
      "cloud_apps:getMyCloudConversationIdentity",
      {},
    );
    if (
      !isRecord(identity) ||
      typeof identity.ownerId !== "string" ||
      typeof identity.ownerGeneration !== "string"
    ) {
      throw new Error("invalid identity");
    }
    const scoped = await issueInteriorShellSession({
      appTokenSigningKey: config.appTokenSigningKey!,
      issuer: config.deploymentIdentity,
      stableRouteId: bootstrap.stableRouteId,
      routeBuild: bootstrap.routeBuild,
      viewerId: identity.ownerId,
      viewerOwnerGeneration: identity.ownerGeneration,
      convexJwt: mintedToken.convexToken,
      trustedGatewayOrigin: config.trustedAppsHostOrigin,
    });
    headers.set("content-type", "application/json; charset=utf-8");
    appendAccountCookies(headers, bearer, intent);
    return new Response(JSON.stringify({ ...scoped, user: display.user }), {
      headers,
    });
  } catch {
    return Response.json(
      {
        error:
          intent === "connected"
            ? "Sign in again to continue."
            : "The interior session is unavailable.",
      },
      { status: intent === "connected" ? 401 : 503, headers },
    );
  }
};

const SERVICE_ROUTES = new Map<string, ReadonlySet<string>>([
  ["/api/stella/models", new Set(["GET"])],
  ["/api/stella/relay/chat/completions", new Set(["POST"])],
  ["/api/stella/openrouter/api/v1/chat/completions", new Set(["POST"])],
  ["/api/media/v1/generate", new Set(["POST"])],
  ["/api/dictation/transcribe", new Set(["POST"])],
  ["/api/voice/session", new Set(["POST"])],
  ["/api/voice/openai/sdp", new Set(["POST"])],
  ["/api/voice/inworld/sdp", new Set(["POST"])],
  ["/api/voice/tts", new Set(["POST"])],
  ["/api/voice/tts/stream", new Set(["POST"])],
  ["/api/voice/tts/stream/cancel", new Set(["POST"])],
  ["/api/voice/lease", new Set(["POST"])],
  ["/api/voice/usage", new Set(["POST"])],
]);

const interiorCors = (): Headers =>
  new Headers({
    "access-control-allow-origin": "null",
    vary: "Origin",
    "cache-control": "no-store",
  });

export const handleInteriorService = async (
  request: Request,
  config: AppsHostConfig,
): Promise<Response | null> => {
  const url = new URL(request.url);
  const methods = SERVICE_ROUTES.get(url.pathname);
  if (!methods) return null;
  const cors = interiorCors();
  if (request.method === "OPTIONS") {
    if (request.headers.get("origin") !== "null") {
      return new Response(null, { status: 403 });
    }
    cors.set(
      "access-control-allow-headers",
      "authorization, content-type, range, x-device-id, x-stella-agent-type, x-stella-owner-generation, x-stella-provider-dispatch-id, x-stella-provider-attempt-id, x-stella-voice-session-id",
    );
    cors.set(
      "access-control-allow-methods",
      `${[...methods].join(", ")}, OPTIONS`,
    );
    return new Response(null, { status: 204, headers: cors });
  }
  if (
    request.headers.get("origin") !== "null" ||
    !methods.has(request.method) ||
    url.search !== ""
  ) {
    return Response.json(
      { error: "Forbidden" },
      { status: 403, headers: cors },
    );
  }
  const token = bearerFromRequest(request);
  if (!token) {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: cors },
    );
  }
  let session: VerifiedInteriorShellSession;
  try {
    session = await parseScopedSession(config, token);
  } catch {
    return Response.json(
      { error: "Unauthorized" },
      { status: 401, headers: cors },
    );
  }
  const outgoingHeaders = new Headers();
  for (const name of [
    "accept",
    "content-type",
    "range",
    "x-device-id",
    "x-stella-agent-type",
    "x-stella-owner-generation",
    "x-stella-provider-dispatch-id",
    "x-stella-provider-attempt-id",
    "x-stella-voice-session-id",
  ]) {
    const value = request.headers.get(name);
    if (value && value.length <= 2_048) outgoingHeaders.set(name, value);
  }
  outgoingHeaders.set("authorization", `Bearer ${session.convexToken}`);
  let body: Uint8Array | undefined;
  if (request.method !== "GET" && request.body) {
    try {
      body = await readBoundedBytes(request.body, 8 * 1024 * 1024);
    } catch {
      return Response.json(
        { error: "Request too large" },
        { status: 413, headers: cors },
      );
    }
  }
  const upstream = await fetch(new URL(url.pathname, config.convexSiteOrigin), {
    method: request.method,
    headers: outgoingHeaders,
    ...(body ? { body } : {}),
    redirect: "manual",
    signal: AbortSignal.timeout(60_000),
  });
  const responseHeaders = new Headers(cors);
  for (const name of [
    "content-type",
    "content-length",
    "content-range",
    "accept-ranges",
    "etag",
  ]) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers: responseHeaders,
  });
};

const closeSocket = (socket: WebSocket, code: number, reason: string): void => {
  try {
    socket.close(code, reason.slice(0, 120));
  } catch {
    // The peer may already be gone.
  }
};

const relaySockets = (left: WebSocket, right: WebSocket): void => {
  left.addEventListener("message", (event) => {
    try {
      right.send(event.data);
    } catch {
      closeSocket(left, 1011, "Relay failed");
    }
  });
  right.addEventListener("message", (event) => {
    try {
      left.send(event.data);
    } catch {
      closeSocket(right, 1011, "Relay failed");
    }
  });
  left.addEventListener("close", (event) =>
    closeSocket(right, event.code, event.reason),
  );
  right.addEventListener("close", (event) =>
    closeSocket(left, event.code, event.reason),
  );
  left.addEventListener("error", () =>
    closeSocket(right, 1011, "Relay failed"),
  );
  right.addEventListener("error", () =>
    closeSocket(left, 1011, "Relay failed"),
  );
};

export const handleInteriorConvexSocket = async (
  request: Request,
  config: AppsHostConfig,
): Promise<Response | null> => {
  const url = new URL(request.url);
  if (!CONVEX_SYNC_PATH.test(url.pathname)) return null;
  if (
    request.method !== "GET" ||
    request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
    request.headers.get("origin") !== "null" ||
    url.search !== ""
  ) {
    return new Response("WebSocket required", { status: 426 });
  }
  const pair = new WebSocketPair();
  const browser = pair[0];
  const gateway = pair[1];
  gateway.accept();
  let upstream: WebSocket | null = null;
  let session: VerifiedInteriorShellSession | null = null;
  let scopedToken: string | null = null;
  let sawConnect = false;
  let chain = Promise.resolve();
  const pending: string[] = [];

  const openUpstream = async (): Promise<void> => {
    const headers = new Headers({ Upgrade: "websocket" });
    const response = await fetch(
      new URL(url.pathname, config.convexCloudOrigin),
      { headers },
    );
    if (response.status !== 101 || !response.webSocket) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("Convex socket unavailable");
    }
    upstream = response.webSocket;
    upstream.accept();
    upstream.addEventListener("message", (event) => {
      try {
        gateway.send(event.data);
      } catch {
        closeSocket(upstream!, 1011, "Relay failed");
      }
    });
    upstream.addEventListener("close", (event) =>
      closeSocket(gateway, event.code, event.reason),
    );
    upstream.addEventListener("error", () =>
      closeSocket(gateway, 1011, "Relay failed"),
    );
    for (const value of pending) upstream.send(value);
    pending.length = 0;
  };

  gateway.addEventListener("message", (event) => {
    chain = chain
      .then(async () => {
        if (
          typeof event.data !== "string" ||
          event.data.length > MAX_SYNC_MESSAGE_BYTES
        ) {
          throw new Error("invalid frame");
        }
        let message: unknown;
        try {
          message = JSON.parse(event.data);
        } catch {
          throw new Error("invalid frame");
        }
        if (!isRecord(message)) throw new Error("invalid frame");
        if (!session) {
          if (!sawConnect) {
            if (message.type !== "Connect") throw new Error("connect required");
            sawConnect = true;
            // Connect has no credential, but still run the exact grammar before
            // retaining it. No upstream connection exists yet.
            const checked = validateInteriorConvexClientMessage({
              message,
              // Connect carries no authority. The validator only dereferences a
              // session for Authenticate, which is deliberately rejected until
              // the next frame supplies a real scoped token.
              session: {} as VerifiedInteriorShellSession,
              scopedToken: "",
            });
            if (!checked.ok) throw new Error(checked.reason);
            pending.push(JSON.stringify(checked.upstreamMessage));
            return;
          }
          if (
            message.type !== "Authenticate" ||
            typeof message.value !== "string"
          ) {
            throw new Error("authentication required");
          }
          scopedToken = message.value;
          session = await parseScopedSession(config, scopedToken);
          const checked = validateInteriorConvexClientMessage({
            message,
            session,
            scopedToken,
          });
          if (!checked.ok) throw new Error(checked.reason);
          pending.push(JSON.stringify(checked.upstreamMessage));
          await openUpstream();
          return;
        }
        if (message.type === "Authenticate") {
          if (typeof message.value !== "string")
            throw new Error("invalid refresh");
          const refreshedToken = message.value;
          const refreshed = await parseInteriorShellSession({
            token: refreshedToken,
            appTokenSigningKey: config.appTokenSigningKey!,
            expected: {
              issuer: session.claims.issuer,
              trustedGatewayOrigin: session.claims.trustedGatewayOrigin,
              stableRouteId: session.claims.stableRouteId,
              routeBuild: session.claims.routeBuild,
              viewerId: session.claims.viewerId,
              viewerOwnerGeneration: session.claims.viewerOwnerGeneration,
            },
          });
          await assertCurrentSession(config, refreshed);
          const checked = validateInteriorConvexClientMessage({
            message,
            session: refreshed,
            scopedToken: refreshedToken,
          });
          if (!checked.ok) throw new Error(checked.reason);
          session = refreshed;
          scopedToken = refreshedToken;
          upstream!.send(JSON.stringify(checked.upstreamMessage));
          return;
        }
        const checked = validateInteriorConvexClientMessage({
          message,
          session,
          scopedToken: scopedToken!,
        });
        if (!checked.ok) throw new Error(checked.reason);
        upstream!.send(JSON.stringify(checked.upstreamMessage));
      })
      .catch((error) => {
        const reason = error instanceof Error ? error.message : "unknown";
        console.info(
          JSON.stringify({
            service: "stella-v2-apps-auth",
            event: "interior_convex_frame_denied",
            reason: reason.slice(0, 96).replace(/[^A-Za-z0-9_ .:-]/g, "?"),
          }),
        );
        closeSocket(gateway, 4403, "Interior capability denied");
      });
  });
  gateway.addEventListener("close", (event) => {
    if (upstream) closeSocket(upstream, event.code, event.reason);
  });
  return new Response(null, { status: 101, webSocket: browser });
};

const readConversationProtocols = (
  request: Request,
): { token: string } | null => {
  const protocols = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((value) => value.trim());
  if (protocols[0] !== "stella.v1" || protocols.length !== 2) return null;
  const prefix = "stella.token.";
  return protocols[1].startsWith(prefix)
    ? { token: protocols[1].slice(prefix.length) }
    : null;
};

export const handleInteriorConversationSocket = async (
  request: Request,
  config: AppsHostConfig,
): Promise<Response | null> => {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/conversations\/([^/]+)\/socket$/);
  if (!match) return null;
  if (
    request.method !== "GET" ||
    request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
    request.headers.get("origin") !== "null" ||
    !CONVERSATION_ID.test(match[1])
  ) {
    return new Response("WebSocket required", { status: 426 });
  }
  const allowedParams = new Set(["protocol", "since", "epoch"]);
  if ([...url.searchParams.keys()].some((key) => !allowedParams.has(key))) {
    return new Response("Forbidden", { status: 403 });
  }
  const protocol = url.searchParams.get("protocol");
  const since = url.searchParams.get("since");
  const epoch = url.searchParams.get("epoch");
  if (
    protocol !== "1" ||
    (since !== null && !/^-?\d{1,16}$/.test(since)) ||
    (epoch !== null && !/^[A-Za-z0-9._~-]{1,128}$/.test(epoch))
  ) {
    return new Response("Forbidden", { status: 403 });
  }
  const offered = readConversationProtocols(request);
  if (!offered) return new Response("Unauthorized", { status: 401 });
  let session: VerifiedInteriorShellSession;
  try {
    session = await parseScopedSession(config, offered.token);
    const conversation = await convexQuery(
      config,
      session.convexToken,
      "cloud_apps:getMyConversation",
      { conversationId: match[1] },
    );
    if (!isRecord(conversation) || conversation.conversationId !== match[1]) {
      throw new Error("conversation denied");
    }
  } catch {
    return new Response("Unauthorized", { status: 401 });
  }
  const upstreamHeaders = new Headers({
    Upgrade: "websocket",
    "Sec-WebSocket-Protocol": `stella.v1, stella.token.${session.convexToken}`,
  });
  const upstreamResponse = await fetch(
    new URL(`${url.pathname}${url.search}`, config.cloudBuilderOrigin),
    { headers: upstreamHeaders },
  );
  if (upstreamResponse.status !== 101 || !upstreamResponse.webSocket) {
    await upstreamResponse.body?.cancel().catch(() => undefined);
    return new Response("Conversation unavailable", { status: 502 });
  }
  const pair = new WebSocketPair();
  const browser = pair[0];
  const gateway = pair[1];
  gateway.accept();
  upstreamResponse.webSocket.accept();
  relaySockets(gateway, upstreamResponse.webSocket);
  return new Response(null, {
    status: 101,
    webSocket: browser,
    headers: { "sec-websocket-protocol": "stella.v1" },
  });
};
