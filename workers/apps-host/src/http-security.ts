import type { AppsHostConfig } from "./config";

export const MAX_PROXY_ENVELOPE_BYTES = 1_100_000;
export const MAX_PROXY_BODY_BYTES = 1_000_000;
export const MAX_PROXY_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_PROXY_TARGET_LENGTH = 2_048;
export const MAX_ASSET_PATH_LENGTH = 1_024;
export const MAX_APP_ASSET_BYTES = 25 * 1024 * 1024;
export const MAX_INTERIOR_ASSET_BYTES = 100 * 1024 * 1024;

const MAX_PROXY_REDIRECTS = 3;
const PROXY_TIMEOUT_MS = 15_000;
const ALLOWED_PROXY_METHODS = new Set([
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const FORWARDED_REQUEST_HEADERS = [
  "accept",
  "content-type",
  "if-none-match",
  "if-modified-since",
] as const;
const FORWARDED_RESPONSE_HEADERS = [
  "content-type",
  "etag",
  "last-modified",
  "cache-control",
] as const;

const parseIpv4 = (hostname: string): number[] | null => {
  const match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  return octets.every((part) => Number.isInteger(part) && part <= 255)
    ? octets
    : null;
};

const isNonPublicIpv4 = (octets: number[]): boolean => {
  const [a, b, c] = octets;
  return (
    a === 0 ||
    a === 10 ||
    (a === 100 && b >= 64 && b <= 127) ||
    a === 127 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
};

const parseIpv6 = (hostname: string): number[] | null => {
  let input = hostname.toLowerCase();
  if (input.startsWith("[") && input.endsWith("]")) {
    input = input.slice(1, -1);
  }
  const zoneIndex = input.indexOf("%");
  if (zoneIndex >= 0) input = input.slice(0, zoneIndex);
  if (!input.includes(":")) return null;

  const embeddedIpv4 = input.match(/(?:^|:)(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (embeddedIpv4) {
    const octets = parseIpv4(embeddedIpv4);
    if (!octets) return null;
    const high = ((octets[0] << 8) | octets[1]).toString(16);
    const low = ((octets[2] << 8) | octets[3]).toString(16);
    input = `${input.slice(0, -embeddedIpv4.length)}${high}:${low}`;
  }

  if ((input.match(/::/g) ?? []).length > 1) return null;
  const [leftRaw, rightRaw] = input.split("::");
  const left = leftRaw ? leftRaw.split(":") : [];
  const right = rightRaw ? rightRaw.split(":") : [];
  if (input.includes("::")) {
    const missing = 8 - left.length - right.length;
    if (missing < 1) return null;
    left.push(...Array.from({ length: missing }, () => "0"));
  }
  const words = [...left, ...right];
  if (
    words.length !== 8 ||
    words.some((word) => !/^[0-9a-f]{1,4}$/.test(word))
  ) {
    return null;
  }
  return words.map((word) => Number.parseInt(word, 16));
};

const isNonPublicIpv6 = (words: number[]): boolean => {
  const first = words[0];
  const unspecified = words.every((word) => word === 0);
  const loopback =
    words.slice(0, 7).every((word) => word === 0) && words[7] === 1;
  const mappedIpv4 =
    words.slice(0, 5).every((word) => word === 0) && words[5] === 0xffff;
  if (mappedIpv4) {
    return isNonPublicIpv4([
      words[6] >> 8,
      words[6] & 0xff,
      words[7] >> 8,
      words[7] & 0xff,
    ]);
  }
  return (
    unspecified ||
    loopback ||
    (first & 0xfe00) === 0xfc00 ||
    (first & 0xffc0) === 0xfe80 ||
    (first & 0xff00) === 0xff00 ||
    (first === 0x2001 && words[1] === 0x0db8)
  );
};

export const isBlockedTargetHostname = (hostname: string): boolean => {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/, "");
  if (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".home.arpa") ||
    normalized.endsWith(".test") ||
    normalized.endsWith(".invalid") ||
    normalized.endsWith(".example")
  ) {
    return true;
  }
  const ipv4 = parseIpv4(normalized);
  if (ipv4) return isNonPublicIpv4(ipv4);
  const ipv6 = parseIpv6(normalized);
  return ipv6 ? isNonPublicIpv6(ipv6) : false;
};

const isAllowedProxyCorsOrigin = (
  request: Request,
  origin: string | null,
  config: AppsHostConfig,
): origin is string => {
  if (!origin) return false;
  // Sandboxed generated-app iframes intentionally have opaque origins. This is
  // a CORS transport allowance only; the POST still requires a one-shot
  // app/viewer/request-bound capability.
  if (origin === "null") return true;
  if (
    origin === config.appsHostOrigin ||
    origin === "http://localhost:57315" ||
    origin === "http://127.0.0.1:57315"
  ) {
    return true;
  }
  try {
    return origin === new URL(request.url).origin;
  } catch {
    return false;
  }
};

const proxyCorsHeaders = (origin: string): Headers => {
  const headers = new Headers({
    "access-control-allow-origin": origin,
    "access-control-allow-headers": "authorization, content-type",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-max-age": "600",
  });
  headers.append("vary", "Origin");
  headers.append("vary", "Access-Control-Request-Method");
  headers.append("vary", "Access-Control-Request-Headers");
  return headers;
};

const withProxyCors = (response: Response, origin: string): Response => {
  const headers = new Headers(response.headers);
  for (const [name, value] of proxyCorsHeaders(origin)) {
    if (name === "vary") headers.append(name, value);
    else headers.set(name, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
};

const proxyJson = (
  origin: string,
  body: Record<string, unknown>,
  status: number,
): Response =>
  withProxyCors(
    Response.json(body, {
      status,
      headers: { "cache-control": "no-store" },
    }),
    origin,
  );

export const handleProxyPreflight = (
  request: Request,
  config: AppsHostConfig,
): Response => {
  const origin = request.headers.get("origin");
  if (!isAllowedProxyCorsOrigin(request, origin, config)) {
    return Response.json(
      { error: "Stella fetch is unavailable from this origin." },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }
  const requestedMethod = request.headers
    .get("access-control-request-method")
    ?.trim()
    .toUpperCase();
  if (requestedMethod && requestedMethod !== "POST") {
    return proxyJson(
      origin,
      { error: "That HTTP method is not allowed." },
      405,
    );
  }
  const requestedHeaders = (
    request.headers.get("access-control-request-headers") ?? ""
  )
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  if (
    requestedHeaders.some(
      (header) => header !== "content-type" && header !== "authorization",
    )
  ) {
    return proxyJson(
      origin,
      { error: "That request header is not allowed." },
      400,
    );
  }
  return withProxyCors(new Response(null, { status: 204 }), origin);
};

const contentLengthExceeds = (headers: Headers, limit: number): boolean => {
  const value = headers.get("content-length");
  if (!value) return false;
  return !/^\d+$/.test(value) || Number(value) > limit;
};

export const readBoundedBytes = async (
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> => {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel("body limit exceeded").catch(() => undefined);
        throw new RangeError("Body exceeds the allowed size.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
};

type ProxyEnvelope = {
  input: string;
  init?: {
    method?: string;
    headers?: HeadersInit;
    body?: string;
  };
};

const readProxyEnvelope = async (
  request: Request,
  origin: string,
): Promise<ProxyEnvelope | Response> => {
  if (contentLengthExceeds(request.headers, MAX_PROXY_ENVELOPE_BYTES)) {
    return proxyJson(
      origin,
      { error: "The Stella fetch request is too large." },
      413,
    );
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedBytes(request.body, MAX_PROXY_ENVELOPE_BYTES);
  } catch {
    return proxyJson(
      origin,
      { error: "The Stella fetch request is too large." },
      413,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    return proxyJson(
      origin,
      { error: "A valid JSON request body is required." },
      400,
    );
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return proxyJson(origin, { error: "A JSON object is required." }, 400);
  }
  const candidate = parsed as Record<string, unknown>;
  if (
    typeof candidate.input !== "string" ||
    !candidate.input.trim() ||
    candidate.input.length > MAX_PROXY_TARGET_LENGTH
  ) {
    return proxyJson(
      origin,
      { error: "A bounded target URL is required." },
      400,
    );
  }
  if (
    candidate.init !== undefined &&
    (!candidate.init ||
      typeof candidate.init !== "object" ||
      Array.isArray(candidate.init))
  ) {
    return proxyJson(origin, { error: "The fetch options are invalid." }, 400);
  }
  const init = candidate.init as Record<string, unknown> | undefined;
  if (init?.method !== undefined && typeof init.method !== "string") {
    return proxyJson(origin, { error: "The HTTP method is invalid." }, 400);
  }
  if (init?.body !== undefined && typeof init.body !== "string") {
    return proxyJson(origin, { error: "The request body must be text." }, 400);
  }
  if (
    typeof init?.body === "string" &&
    new TextEncoder().encode(init.body).byteLength > MAX_PROXY_BODY_BYTES
  ) {
    return proxyJson(
      origin,
      { error: "The upstream request body is too large." },
      413,
    );
  }
  try {
    if (init?.headers !== undefined) new Headers(init.headers as HeadersInit);
  } catch {
    return proxyJson(
      origin,
      { error: "The request headers are invalid." },
      400,
    );
  }
  return {
    input: candidate.input,
    ...(init
      ? {
          init: {
            ...(typeof init.method === "string" ? { method: init.method } : {}),
            ...(init.headers !== undefined
              ? { headers: init.headers as HeadersInit }
              : {}),
            ...(typeof init.body === "string" ? { body: init.body } : {}),
          },
        }
      : {}),
  };
};

const readPublicHttpsTarget = (input: string): URL | null => {
  let target: URL;
  try {
    target = new URL(input);
  } catch {
    return null;
  }
  if (
    target.protocol !== "https:" ||
    target.username !== "" ||
    target.password !== "" ||
    isBlockedTargetHostname(target.hostname)
  ) {
    return null;
  }
  target.hash = "";
  return target;
};

export const proxyFetch = async (
  request: Request,
  config: AppsHostConfig,
): Promise<Response> => {
  const origin = request.headers.get("origin");
  if (!isAllowedProxyCorsOrigin(request, origin, config)) {
    return Response.json(
      { error: "Stella fetch is unavailable from this origin." },
      { status: 403, headers: { "cache-control": "no-store" } },
    );
  }
  const capability = request.headers
    .get("authorization")
    ?.replace(/^Bearer\s+/i, "")
    .trim();
  if (!capability || !config.appAuth || !config.appFetchGate) {
    return proxyJson(
      origin,
      { error: "A fetch capability is required." },
      401,
    );
  }
  const envelope = await readProxyEnvelope(request, origin);
  if (envelope instanceof Response) return envelope;
  let currentTarget = readPublicHttpsTarget(envelope.input);
  if (!currentTarget) {
    return proxyJson(
      origin,
      { error: "Only public HTTPS targets are allowed." },
      400,
    );
  }

  let method = (envelope.init?.method ?? "GET").toUpperCase();
  if (!ALLOWED_PROXY_METHODS.has(method)) {
    return proxyJson(
      origin,
      { error: "That HTTP method is not allowed." },
      400,
    );
  }
  let requestBody = envelope.init?.body;
  if ((method === "GET" || method === "HEAD") && requestBody !== undefined) {
    return proxyJson(
      origin,
      { error: `${method} requests cannot include a body.` },
      400,
    );
  }
  const requestedHeaders = new Headers(envelope.init?.headers);
  let upstreamHeaders = new Headers();
  const canonicalHeaders: Record<string, string> = {};
  for (const name of FORWARDED_REQUEST_HEADERS) {
    const value = requestedHeaders.get(name);
    if (value) {
      upstreamHeaders.set(name, value);
      canonicalHeaders[name] = value;
    }
  }

  const requestDocument = JSON.stringify({
    input: currentTarget.toString(),
    method,
    headers: canonicalHeaders,
    body: requestBody ?? null,
  });
  const requestHash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        new TextEncoder().encode(requestDocument),
      ),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  const authorization = await config.appAuth.verifyFetchCapability({
    capability,
    origin,
    method,
    targetOrigin: currentTarget.origin,
    targetUrl: currentTarget.toString(),
    requestHash,
    now: Date.now(),
  });
  if (
    !authorization.ok ||
    !authorization.tokenId ||
    !authorization.appId ||
    !authorization.viewerNamespace ||
    !authorization.expiresAt
  ) {
    return proxyJson(
      origin,
      { error: "The fetch capability is invalid or expired." },
      401,
    );
  }
  const gate = config.appFetchGate.getByName(
    `${authorization.appId}:${authorization.viewerNamespace}`,
  );
  const consumed = await gate.consume({
    tokenId: authorization.tokenId,
    expiresAt: authorization.expiresAt,
    now: Date.now(),
  });
  if (!consumed.ok) {
    return proxyJson(
      origin,
      {
        error:
          consumed.reason === "rate_limited"
            ? "This app has made too many network requests. Try again shortly."
            : "This fetch capability has already been used.",
      },
      consumed.reason === "rate_limited" ? 429 : 409,
    );
  }
  const authorizedTargetOrigin = currentTarget.origin;

  let upstream: Response | undefined;
  try {
    for (let redirects = 0; redirects <= MAX_PROXY_REDIRECTS; redirects += 1) {
      upstream = await fetch(currentTarget, {
        method,
        headers: upstreamHeaders,
        body: method === "GET" || method === "HEAD" ? undefined : requestBody,
        redirect: "manual",
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      });
      const location = upstream.headers.get("location");
      if (!location || !REDIRECT_STATUSES.has(upstream.status)) break;
      if (redirects === MAX_PROXY_REDIRECTS) {
        await upstream.body?.cancel().catch(() => undefined);
        return proxyJson(
          origin,
          { error: "The upstream redirected too many times." },
          502,
        );
      }
      const next = readPublicHttpsTarget(
        new URL(location, currentTarget).toString(),
      );
      if (!next) {
        await upstream.body?.cancel().catch(() => undefined);
        return proxyJson(
          origin,
          { error: "The upstream redirect was blocked." },
          400,
        );
      }
      if (next.origin !== authorizedTargetOrigin) {
        await upstream.body?.cancel().catch(() => undefined);
        return proxyJson(
          origin,
          { error: "The upstream redirect left the authorized target." },
          400,
        );
      }
      if (
        upstream.status === 303 ||
        ((upstream.status === 301 || upstream.status === 302) &&
          method === "POST")
      ) {
        method = "GET";
        requestBody = undefined;
        upstreamHeaders = new Headers(upstreamHeaders);
        upstreamHeaders.delete("content-type");
      }
      await upstream.body?.cancel().catch(() => undefined);
      currentTarget = next;
    }
  } catch {
    return proxyJson(
      origin,
      { error: "The upstream service could not be reached. Try again." },
      502,
    );
  }

  if (!upstream) {
    return proxyJson(
      origin,
      { error: "The upstream service did not respond." },
      502,
    );
  }
  if (contentLengthExceeds(upstream.headers, MAX_PROXY_RESPONSE_BYTES)) {
    await upstream.body?.cancel().catch(() => undefined);
    return proxyJson(
      origin,
      { error: "The upstream response is too large." },
      502,
    );
  }

  let responseBody: Uint8Array | null = null;
  if (method !== "HEAD" && upstream.status !== 204 && upstream.status !== 304) {
    try {
      responseBody = await readBoundedBytes(
        upstream.body,
        MAX_PROXY_RESPONSE_BYTES,
      );
    } catch {
      return proxyJson(
        origin,
        { error: "The upstream response is too large." },
        502,
      );
    }
  }
  const responseHeaders = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  if (responseBody) {
    responseHeaders.set("content-length", String(responseBody.byteLength));
  }
  responseHeaders.set("x-stella-proxy", "bounded-v1");
  return withProxyCors(
    new Response(responseBody, {
      status: upstream.status,
      statusText: upstream.statusText,
      headers: responseHeaders,
    }),
    origin,
  );
};

export const hostedContentSecurityHeaders = (
  config: AppsHostConfig,
): Record<string, string> => ({
  "content-security-policy": [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "font-src 'self'",
    "media-src 'self' data: blob:",
    `connect-src 'self' ${config.convexSiteOrigin} ${config.convexCloudOrigin} ${config.convexCloudOrigin.replace("https://", "wss://")} ${config.cloudBuilderOrigin} ${config.cloudBuilderWebSocketOrigin}`,
    "frame-src 'self'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'self' file: http://localhost:* http://127.0.0.1:* https://stella.sh",
    "form-action 'self'",
  ].join("; "),
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "cross-origin",
  "permissions-policy":
    "camera=(), microphone=(), geolocation=(), display-capture=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
});

export const authHandoffSecurityHeaders = (
  config: AppsHostConfig,
): Record<string, string> => ({
  "content-security-policy": "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  "cross-origin-opener-policy": "same-origin",
  "cross-origin-resource-policy": "same-origin",
  "permissions-policy":
    "camera=(), microphone=(), geolocation=(), display-capture=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "cache-control": "no-store",
  pragma: "no-cache",
});

export const parseAssetPath = (rawPath: string | undefined): string | null => {
  if ((rawPath?.length ?? 0) > MAX_ASSET_PATH_LENGTH * 3) return null;
  let assetPath: string;
  try {
    assetPath = decodeURIComponent(rawPath ?? "").replace(/^\/+/, "");
  } catch {
    return null;
  }
  if (!assetPath || assetPath.endsWith("/")) assetPath += "index.html";
  if (
    assetPath.length > MAX_ASSET_PATH_LENGTH ||
    assetPath.includes("\\") ||
    assetPath.includes("\0") ||
    assetPath
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return assetPath;
};

export const pathHasExtension = (assetPath: string): boolean => {
  const name = assetPath.slice(assetPath.lastIndexOf("/") + 1);
  return name.includes(".");
};

export const isSafeArtifactPrefix = (prefix: string): boolean =>
  prefix.length > 0 &&
  prefix.length <= 512 &&
  !prefix.includes("\\") &&
  !prefix.includes("\0") &&
  prefix
    .split("/")
    .every(
      (segment) =>
        Boolean(segment) &&
        segment !== "." &&
        segment !== ".." &&
        /^[A-Za-z0-9._-]+$/.test(segment),
    );
